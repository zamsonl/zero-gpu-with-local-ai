"""Reconnectable Ollama jobs for the loopback stream proxy.

This module is bundled after kaggle-stream-proxy.py in the notebook namespace.
Call install_async_job_routes(server) to extend that proxy explicitly.

POST /_jobs {"target":"/api/chat", "body":{...}} -> 202 {id, token, cursor:0}.
Optional client-generated `job_id` (24+ URL-safe characters) and `token` (43+
URL-safe characters) make start retries idempotent during retention. Generate
both cryptographically; the same identity/token must carry the same request.
GET /_jobs/{id}/events?cursor=0&wait=20 -> bounded JSON with events, nextCursor,
done, status, upstreamStatus and error. Each event preserves the Ollama JSON in
its `record` field. Cursor is the next event index and is safe to repeat. `done`
means both the job and this cursor's backlog have finished; `jobDone` reports
the job state independently, so a completed multi-page result is fully drained.
DELETE /_jobs/{id} cancels the origin socket. Read/cancel require
Authorization: Bearer <token>; tokens never belong in a query string.
GET /_jobs/{id}/stream?cursor=0&max_seconds=120 -> bounded NDJSON leg with
{cursor,record}, {cursor,heartbeat:true}, and terminal {cursor,done:true,...}.
Record and heartbeat envelopes include upstreamStatus when headers are known.
Record cursor is its event index; resume from record.cursor+1. Heartbeat and
terminal cursors are already the next event index. EOF without done reconnects.

Polling connections do not own/cancel the generation. Stop must call DELETE.
Completed jobs are retained for up to five minutes, but the oldest completed,
fully closed jobs can be evicted earlier when another job needs capacity.
A failed server-generated start-response write cancels that job. Client-chosen
identities remain retryable/cancellable even if the start reply is lost.
"""

import hmac as _job_hmac
import hashlib as _job_hashlib
import http.client as _job_http
import json as _job_json
import math as _job_math
import secrets as _job_secrets
import threading as _job_threading
import time as _job_time
import urllib.parse as _job_url


class _JobAPIError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message
        super().__init__(message)


def _job_encode(value, sort_keys=False):
    return _job_json.dumps(value, ensure_ascii=False, sort_keys=sort_keys, separators=(",", ":")).encode("utf-8")


def _job_member_bytes(raw, member):
    """Extract a top-level JSON value's original UTF-8 lexical span.

    The already-validated wrapper may contain nested objects, escaped quotes and
    Unicode. JSONDecoder identifies boundaries; no inner value is reserialized.
    Match json.loads' last-value behavior for duplicate wrapper keys.
    """
    text, decoder = raw.decode("utf-8"), _job_json.JSONDecoder()

    def whitespace(index):
        while index < len(text) and text[index] in " \t\r\n":
            index += 1
        return index

    index, result = whitespace(0), None
    if text[index:index + 1] != "{":
        raise ValueError("Expected a job object")
    index = whitespace(index + 1)
    while text[index:index + 1] != "}":
        key, index = decoder.raw_decode(text, index)
        index = whitespace(index)
        if text[index:index + 1] != ":":
            raise ValueError("Expected a job member")
        start = whitespace(index + 1)
        _, end = decoder.raw_decode(text, start)
        if key == member:
            result = text[start:end].encode("utf-8")
        index = whitespace(end)
        if text[index:index + 1] == ",":
            index = whitespace(index + 1)
        elif text[index:index + 1] != "}":
            raise ValueError("Expected a job object boundary")
    if result is None:
        raise ValueError("Missing job member")
    return result


class _AsyncOllamaJob:
    def __init__(self, manager, target, body, job_id=None, token=None):
        self.manager, self.target, self.body = manager, target, body
        self.id = job_id or _job_secrets.token_urlsafe(18)
        self.token = token or _job_secrets.token_urlsafe(32)
        self.client_identity = job_id is not None
        self.request_hash = _job_hashlib.sha256(target.encode("ascii") + b"\0" + body).digest()
        self.condition = _job_threading.Condition()
        self.request = _StreamRequest()
        self.events = []
        self.encoded_events = []
        self.event_sizes = []
        self.output_bytes = 0
        self.created = self.last_poll = _job_time.monotonic()
        self.finished_at = None
        self.status, self.done, self.error = "running", False, None
        self.upstream_status = None
        self.thread = _job_threading.Thread(target=self.run, name="ollama-async-job", daemon=True)

    def authenticated(self, token):
        return (isinstance(token, str) and len(token) <= 128
                and _job_hmac.compare_digest(token.encode("utf-8"), self.token.encode("ascii")))

    def finish(self, status, error=None):
        with self.condition:
            if self.done:
                return False
            self.done, self.status, self.error = True, status, error
            self.finished_at = _job_time.monotonic()
            self.condition.notify_all()
            return True

    def fail(self, code, message):
        self.finish("failed", {"code": code, "message": message})

    def cancel(self, code="cancelled", message="The model job was cancelled."):
        if self.finish("cancelled", {"code": code, "message": message}):
            self.request.cancel()
            return True
        return False

    def append(self, value, terminal=True, field="record", raw_record=None):
        with self.condition:
            if self.done or self.request.cancelled.is_set():
                return False
            event = {"cursor": len(self.events)}
            if self.upstream_status is not None:
                event["upstreamStatus"] = self.upstream_status
            event[field] = value
            if raw_record is not None and field == "record":
                metadata = {name: part for name, part in event.items() if name != "record"}
                encoded = _job_encode(metadata)[:-1] + b',"record":' + raw_record.strip() + b"}"
            else:
                encoded = _job_encode(event)
            size = len(encoded)
            if (size + 1 > self.manager.max_poll_bytes - 4096
                    or self.output_bytes + size > self.manager.max_output_bytes
                    or len(self.events) >= self.manager.max_output_events):
                self.fail("output_limit", "The model job exceeded its output limit.")
                return False
            self.events.append(event)
            self.encoded_events.append(encoded)
            self.event_sizes.append(size)
            self.output_bytes += size
            self.condition.notify_all()
            if terminal and isinstance(value, dict):
                if "error" in value:
                    self.fail("upstream_error", "Ollama returned an error record.")
                    return False
                if value.get("done") is True:
                    self.finish("completed")
                    return False
            return True

    def record(self, raw):
        if not raw.strip():
            return True
        if len(raw) > self.manager.max_record_bytes:
            self.fail("record_limit", "Ollama returned an oversized JSON record.")
            return False
        try:
            value = _job_json.loads(raw)
            return self.append(value, raw_record=raw)
        except (ValueError, UnicodeError, RecursionError):
            self.fail("upstream_invalid_json", "Ollama returned an invalid JSON record.")
            return False

    def run(self):
        connection, response = None, None
        try:
            connection = _job_http.HTTPConnection(self.manager.server.upstream_host,
                                                   self.manager.server.upstream_port, timeout=10)
            if not self.request.set_connection(connection):
                return
            connection.connect()
            if not self.request.set_socket(connection.sock):
                return
            connection.sock.settimeout(None)
            if self.request.cancelled.is_set():
                return
            connection.request("POST", self.target, body=self.body, headers={
                "Content-Type": "application/json", "Accept-Encoding": "identity", "Connection": "close",
            })
            response = connection.getresponse()
            with self.condition:
                self.upstream_status = response.status
                self.condition.notify_all()
            if not 200 <= response.status < 300:
                error_body = bytearray()
                while not self.request.cancelled.is_set():
                    chunk = response.read1(min(65536, self.manager.max_record_bytes + 1 - len(error_body)))
                    if not chunk:
                        break
                    error_body.extend(chunk)
                    if len(error_body) > self.manager.max_record_bytes:
                        self.fail("record_limit", "Ollama returned an oversized error response.")
                        return
                if self.request.cancelled.is_set():
                    return
                try:
                    value = _job_json.loads(error_body)
                    raw = bytes(error_body).strip()
                    self.append(value, terminal=False, raw_record=raw if b"\n" not in raw and b"\r" not in raw else None)
                except (ValueError, UnicodeError, RecursionError):
                    self.append({"status": response.status, "body": bytes(error_body).decode("utf-8", "replace")},
                                terminal=False, field="upstreamError")
                self.fail("upstream_http_error", "Ollama returned HTTP %s." % response.status)
                return
            pending = bytearray()
            while not self.request.cancelled.is_set():
                chunk = response.read1(65536)
                if not chunk:
                    break
                pending.extend(chunk)
                while True:
                    newline = pending.find(b"\n")
                    if newline < 0:
                        break
                    record = bytes(pending[:newline + 1])
                    del pending[:newline + 1]
                    if not self.record(record):
                        return
                if len(pending) > self.manager.max_record_bytes:
                    self.fail("record_limit", "Ollama returned an oversized JSON record.")
                    return
            if self.request.cancelled.is_set():
                return
            if pending and not self.record(bytes(pending)):
                return
            self.fail("upstream_eof", "The model stream ended before completion. Please retry.")
        except Exception as error:
            if not self.request.cancelled.is_set():
                self.fail("upstream_connection", "Ollama connection failed (%s)." % type(error).__name__)
        finally:
            # Own the connection until the worker actually exits. HTTP response
            # and poll lifetimes never control this socket.
            try:
                self.request.cancel()
            finally:
                try:
                    if response is not None:
                        try:
                            response.close()
                        except OSError:
                            pass
                finally:
                    try:
                        if connection is not None:
                            try:
                                connection.close()
                            except OSError:
                                pass
                    finally:
                        self.body = b""  # Release prompt data after the job finishes.
                        self.request.finished.set()

    def poll(self, cursor, wait):
        with self.condition:
            self.last_poll = _job_time.monotonic()
            if cursor > len(self.events):
                raise _JobAPIError(409, "invalid_cursor", "The cursor is ahead of this job's events.")
            deadline = _job_time.monotonic() + wait
            while cursor == len(self.events) and not self.done:
                remaining = deadline - _job_time.monotonic()
                if remaining <= 0:
                    break
                self.condition.wait(remaining)
            events, size, next_cursor = [], 4096, cursor
            while next_cursor < len(self.events) and len(events) < self.manager.max_poll_events:
                event_size = self.event_sizes[next_cursor] + 1
                if size + event_size > self.manager.max_poll_bytes:
                    break
                events.append(self.events[next_cursor])
                size += event_size
                next_cursor += 1
            return {
                "id": self.id, "events": events, "nextCursor": next_cursor,
                "done": self.done and next_cursor == len(self.events), "jobDone": self.done,
                "status": self.status, "upstreamStatus": self.upstream_status,
                "error": self.error, "hasMore": next_cursor < len(self.events),
            }


class _AsyncOllamaJobs:
    def __init__(self, server, max_running_jobs, max_retained_jobs, retention_seconds,
                 idle_seconds, max_job_seconds, max_output_bytes, max_output_events,
                 max_record_bytes, max_poll_bytes, max_poll_events, reaper_seconds):
        self.server = server
        self.max_running_jobs, self.max_retained_jobs = max_running_jobs, max_retained_jobs
        self.retention_seconds, self.idle_seconds, self.max_job_seconds = retention_seconds, idle_seconds, max_job_seconds
        self.max_output_bytes, self.max_output_events = max_output_bytes, max_output_events
        self.max_record_bytes, self.max_poll_bytes, self.max_poll_events = max_record_bytes, max_poll_bytes, max_poll_events
        self.reaper_seconds = reaper_seconds
        self.jobs, self.lock = {}, _job_threading.Lock()
        self.closed = _job_threading.Event()
        self.thread = _job_threading.Thread(target=self.reap, name="ollama-job-reaper", daemon=True)
        self.thread.start()

    def start(self, target, body, job_id=None, token=None):
        with self.lock:
            if self.closed.is_set():
                raise _JobAPIError(503, "shutting_down", "The job service is stopping.")
            existing = self.jobs.get(job_id) if job_id is not None else None
            if existing is not None:
                if not existing.authenticated(token):
                    raise _JobAPIError(403, "forbidden", "The job identity requires its original token.")
                request_hash = _job_hashlib.sha256(target.encode("ascii") + b"\0" + body).digest()
                if not _job_hmac.compare_digest(existing.request_hash, request_hash):
                    raise _JobAPIError(409, "job_conflict", "The job identity already belongs to another request.")
                return existing, False
            # Done is visible before its socket finishes closing. Release GPU
            # capacity only after the owning upstream worker has actually exited.
            running = sum(not job.request.finished.is_set() for job in self.jobs.values())
            if running >= self.max_running_jobs:
                raise _JobAPIError(429, "busy", "The model is already processing a job.")
            # A busy conversation must not hit a five-minute rate limit after
            # eight quick replies. Keep bounded replay history by evicting only
            # the oldest completed jobs whose origin workers have fully exited.
            if len(self.jobs) >= self.max_retained_jobs:
                completed = sorted(
                    (old for old in self.jobs.values() if old.done and old.request.finished.is_set()),
                    key=lambda old: old.finished_at if old.finished_at is not None else old.created,
                )
                for old in completed:
                    if len(self.jobs) < self.max_retained_jobs:
                        break
                    self.jobs.pop(old.id, None)
            if len(self.jobs) >= self.max_retained_jobs:
                raise _JobAPIError(429, "retention_limit", "The job service has reached its retention limit.")
            job = _AsyncOllamaJob(self, target, body, job_id, token)
            self.jobs[job.id] = job
            try:
                job.thread.start()
            except Exception:
                self.jobs.pop(job.id, None)
                job.cancel()
                job.request.finished.set()
                raise
            return job, True

    def authenticate(self, job_id, token):
        with self.lock:
            job = self.jobs.get(job_id)
        if job is None:
            raise _JobAPIError(404, "not_found", "The job was not found or has expired.")
        if not job.authenticated(token):
            raise _JobAPIError(403, "forbidden", "A valid job bearer token is required.")
        return job

    def reap(self):
        while not self.closed.wait(self.reaper_seconds):
            now = _job_time.monotonic()
            with self.lock:
                jobs = tuple(self.jobs.values())
            for job in jobs:
                cancel_request = False
                with job.condition:
                    if not job.done:
                        if now - job.created >= self.max_job_seconds:
                            cancel_request = job.finish("cancelled", {
                                "code": "job_timeout", "message": "The model job exceeded its runtime limit."})
                        elif now - job.last_poll >= self.idle_seconds:
                            cancel_request = job.finish("cancelled", {
                                "code": "idle_timeout", "message": "The model job expired without polling."})
                    expired = (job.done and job.finished_at is not None and job.request.finished.is_set()
                               and now - job.finished_at >= self.retention_seconds)
                if cancel_request:
                    job.request.cancel()
                if expired:
                    with self.lock:
                        if self.jobs.get(job.id) is job:
                            self.jobs.pop(job.id, None)

    def active_generations(self):
        """Only active OpenCode job IDs can renew a relay generation lease."""
        with self.lock:
            ids = [job.id for job in self.jobs.values() if not job.request.finished.is_set()]
        result = []
        for job_id in ids:
            owner, _, phase = job_id.rpartition("-")
            parts = owner.split("-")
            if (phase in ("main", "finish") and [len(part) for part in parts] == [8, 4, 4, 4, 12]
                    and all(char in "0123456789abcdef" for part in parts for char in part)):
                result.append(owner)
        return sorted(set(result))[:8]

    def cancel_generations(self, owners):
        if not isinstance(owners, list):
            return
        selected = set(owner for owner in owners[:8] if isinstance(owner, str))
        with self.lock:
            jobs = tuple(self.jobs.values())
        for job in jobs:
            if job.id.rpartition("-")[0] in selected:
                job.cancel()

    def busy(self):
        with self.lock:
            return any(not job.request.finished.is_set() for job in self.jobs.values())

    def close(self):
        self.closed.set()
        with self.lock:
            jobs = tuple(self.jobs.values())
        for job in jobs:
            job.cancel("server_stopped", "The job service stopped.")


def install_async_job_routes(server, max_running_jobs=1, max_retained_jobs=8,
                             retention_seconds=300, idle_seconds=120, max_job_seconds=3600,
                             max_output_bytes=8 * 1024 * 1024, max_output_events=32768,
                             max_record_bytes=1024 * 1024, max_poll_bytes=2 * 1024 * 1024,
                             max_poll_events=256, reaper_seconds=1, stream_heartbeat_seconds=2,
                             stream_padding_bytes=16384, max_stream_seconds=120, control_token=None):
    """Explicitly extend an existing stream proxy; return its async job manager.

    Retention is measured from completion; polling does not extend that limit.
    Under capacity pressure the oldest completed/closed jobs can expire earlier.
    An unfinished job must be polled within idle_seconds or it is cancelled.
    All routes use no-store JSON responses and long polls are capped at 20s.
    Streaming legs default to 120s; a personal coding server may opt into 300s.
    Existing /api/* handling and its streaming behavior are inherited unchanged.
    """
    if hasattr(server, "_async_jobs"):
        raise ValueError("Async job routes are already installed.")
    for value in (max_running_jobs, max_retained_jobs, max_output_bytes, max_output_events,
                  max_record_bytes, max_poll_bytes, max_poll_events):
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise ValueError("Job capacities must be positive integers.")
    if max_running_jobs > max_retained_jobs or max_poll_bytes < 8192 or max_record_bytes + 4096 > max_poll_bytes:
        raise ValueError("Inconsistent job capacity or polling limits.")
    for value in (retention_seconds, idle_seconds, max_job_seconds, reaper_seconds, stream_heartbeat_seconds):
        if not isinstance(value, (int, float)) or not _job_math.isfinite(value) or value <= 0:
            raise ValueError("Job time limits must be positive and finite.")
    if not isinstance(stream_padding_bytes, int) or not 0 <= stream_padding_bytes <= 1024 * 1024:
        raise ValueError("Invalid stream heartbeat padding size.")
    if (not isinstance(max_stream_seconds, (int, float)) or isinstance(max_stream_seconds, bool)
            or not _job_math.isfinite(max_stream_seconds) or not 0 < max_stream_seconds <= 300):
        raise ValueError("Invalid maximum stream leg duration.")
    if control_token is not None and (not isinstance(control_token, str) or len(control_token) != 64
            or any(char not in "0123456789abcdef" for char in control_token)):
        raise ValueError("Invalid personal job-control credential.")
    manager = _AsyncOllamaJobs(server, max_running_jobs, max_retained_jobs, retention_seconds,
                              idle_seconds, max_job_seconds, max_output_bytes, max_output_events,
                              max_record_bytes, max_poll_bytes, max_poll_events, reaper_seconds)
    base_handler = server.RequestHandlerClass

    class _AsyncJobHandler(base_handler):
        def _job_json_response(self, status, payload, body=None):
            body = _job_encode(payload) if body is None else body
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            self.wfile.flush()
            self.close_connection = True

        def _job_token(self):
            value = self.headers.get("Authorization", "")
            return value[7:] if value.startswith("Bearer ") else ""

        def _job_stream(self, job, cursor, max_seconds):
            # Validate the cursor before committing HTTP 200 headers.
            initial = job.poll(cursor, 0)
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Cache-Control", "no-store, no-transform")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Connection", "close")
            self.end_headers()
            deadline = _job_time.monotonic() + max_seconds

            def send_record(record):
                remaining = deadline - _job_time.monotonic()
                if remaining <= 0:
                    return False
                self.connection.settimeout(min(30, remaining))
                self._chunk(record)
                return True

            def heartbeat():
                metadata = {"cursor": cursor, "heartbeat": True}
                with job.condition:
                    if job.upstream_status is not None:
                        metadata["upstreamStatus"] = job.upstream_status
                record = _job_encode(metadata)
                return send_record(record + b" " * max(0, stream_padding_bytes - len(record) - 1) + b"\n")

            # Known failures can now reach the Worker before its raw response
            # commits 200. Pending prefill still gets an immediate keepalive.
            if not initial["jobDone"]:
                heartbeat()
            next_heartbeat = _job_time.monotonic() + stream_heartbeat_seconds
            leg_ended = False
            while _job_time.monotonic() < deadline:
                wait = max(0, min(deadline, next_heartbeat) - _job_time.monotonic())
                result = job.poll(cursor, wait)
                for event in result["events"]:
                    if not send_record(job.encoded_events[event["cursor"]] + b"\n"):
                        leg_ended = True
                        break
                    cursor = event["cursor"] + 1
                    # Keep the padding cadence independent of token traffic. A
                    # buffering tunnel otherwise receives only tiny records for
                    # the whole leg and releases them together at its boundary.
                    if _job_time.monotonic() >= next_heartbeat:
                        if not heartbeat():
                            leg_ended = True
                            break
                        next_heartbeat = _job_time.monotonic() + stream_heartbeat_seconds
                if leg_ended:
                    break
                if result["done"]:
                    send_record(_job_encode({"cursor": cursor, "done": True, "status": result["status"],
                                             "upstreamStatus": result["upstreamStatus"], "error": result["error"]}) + b"\n")
                    break
                if _job_time.monotonic() >= next_heartbeat:
                    if not heartbeat():
                        break
                    next_heartbeat = _job_time.monotonic() + stream_heartbeat_seconds
            # A normal leg boundary intentionally has no done record. Reattach
            # with the next cursor; this does not cancel or replace the job.
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()

        def _job_wait_idle(self, seconds):
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Cache-Control", "no-store, no-transform")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Connection", "close")
            self.end_headers()
            deadline = _job_time.monotonic() + seconds
            next_heartbeat = 0
            while True:
                busy = manager.busy()
                stamp = _job_time.monotonic()
                if not busy or stamp >= next_heartbeat or stamp >= deadline:
                    raw = _job_encode({"busy": busy})
                    self.connection.settimeout(30)
                    self._chunk(raw + b" " * max(0, stream_padding_bytes - len(raw) - 1) + b"\n")
                    next_heartbeat = stamp + stream_heartbeat_seconds
                if not busy or stamp >= deadline:
                    break
                manager.closed.wait(min(0.05, max(0, deadline - stamp)))
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()

        def _job_dispatch(self):
            try:
                target = _job_url.urlsplit(self.path)
            except ValueError:
                return base_handler._dispatch(self)
            if not target.path.startswith("/_jobs"):
                return base_handler._dispatch(self)
            self.close_connection = True
            self.connection.settimeout(30)
            started_job = None
            try:
                if target.scheme or target.netloc or target.fragment:
                    raise _JobAPIError(404, "not_found", "The job route was not found.")
                if target.path == "/_jobs/control":
                    if control_token is None:
                        raise _JobAPIError(404, "not_found", "The control route is unavailable.")
                    supplied = self._job_token()
                    if (len(supplied) != 64 or any(char not in "0123456789abcdef" for char in supplied)
                            or not _job_hmac.compare_digest(supplied, control_token)):
                        raise _JobAPIError(403, "forbidden", "A valid personal control credential is required.")
                    query = _job_url.parse_qs(target.query, keep_blank_values=True)
                    try:
                        if self.command != "GET" or set(query) != {"max_seconds"} or len(query["max_seconds"]) != 1:
                            raise ValueError()
                        seconds = float(query["max_seconds"][0])
                        if not _job_math.isfinite(seconds) or not 0 < seconds <= max_stream_seconds:
                            raise ValueError()
                    except ValueError:
                        raise _JobAPIError(400, "invalid_poll", "Supply a bounded control wait.")
                    self._job_wait_idle(seconds)
                    return
                if target.path == "/_jobs" and self.command == "POST" and not target.query:
                    try:
                        raw_request = self._request_body()
                        payload = _job_json.loads(raw_request)
                    except _StreamBodyError as error:
                        raise _JobAPIError(error.status, "invalid_request", error.message)
                    except (ValueError, UnicodeError, RecursionError):
                        raise _JobAPIError(400, "invalid_request", "A JSON job request is required.")
                    if (not isinstance(payload, dict) or payload.get("target") not in ("/api/chat", "/api/generate")
                            or not isinstance(payload.get("body"), dict)):
                        raise _JobAPIError(400, "invalid_request", "Supply a chat/generate target and JSON body.")
                    body = dict(payload["body"])
                    if body.get("stream") is not None and body.get("stream") is not True:
                        raise _JobAPIError(400, "invalid_request", "Async model jobs require streaming output.")
                    job_id, token = payload.get("job_id"), payload.get("token")
                    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
                    if (job_id is not None or token is not None) and not (
                            isinstance(job_id, str) and 24 <= len(job_id) <= 128 and all(char in alphabet for char in job_id)
                            and isinstance(token, str) and 43 <= len(token) <= 128 and all(char in alphabet for char in token)):
                        raise _JobAPIError(400, "invalid_identity", "Supply cryptographically random URL-safe job_id and token together.")
                    try:
                        # Validate Unicode, but forward the lexical body span.
                        # In particular, int64 values and float spelling must
                        # survive without a parse/stringify transport round trip.
                        _job_encode(body)
                        encoded_body = _job_member_bytes(raw_request, "body")
                    except (ValueError, UnicodeError, RecursionError):
                        raise _JobAPIError(400, "invalid_request", "The model body must contain valid JSON text.")
                    job, created = manager.start(payload["target"], encoded_body, job_id, token)
                    started_job = job if created else None
                    self._job_json_response(202, {"id": job.id, "token": job.token,
                                                   "cursor": 0, "maxWaitSeconds": 20})
                    return
                parts = target.path.split("/")
                if len(parts) not in (3, 4) or parts[1] != "_jobs" or not parts[2]:
                    raise _JobAPIError(404, "not_found", "The job route was not found.")
                job = manager.authenticate(parts[2], self._job_token())
                if self.command == "GET" and len(parts) == 4 and parts[3] in ("events", "stream"):
                    query = _job_url.parse_qs(target.query, keep_blank_values=True)
                    streaming = parts[3] == "stream"
                    allowed = {"cursor", "max_seconds"} if streaming else {"cursor", "wait"}
                    if set(query) - allowed or any(len(values) != 1 for values in query.values()):
                        raise _JobAPIError(400, "invalid_poll", "Supply one cursor and wait value.")
                    cursor_text = query.get("cursor", ["0"])[0]
                    wait_text = query.get("max_seconds", ["120"])[0] if streaming else query.get("wait", ["15"])[0]
                    try:
                        if not cursor_text.isascii() or not cursor_text.isdigit() or len(cursor_text) > 12:
                            raise ValueError()
                        cursor, wait = int(cursor_text), float(wait_text)
                        if not _job_math.isfinite(wait) or not (0 < wait <= max_stream_seconds if streaming else 0 <= wait <= 20):
                            raise ValueError()
                    except ValueError:
                        raise _JobAPIError(400, "invalid_poll", "Cursor must be nonnegative and the requested wait within this route's limit.")
                    if streaming:
                        try:
                            self._job_stream(job, cursor, wait)
                        except OSError:
                            # A leg's writer/timeout owns only that response.
                            # Never turn its disconnect into job cancellation.
                            pass
                    else:
                        result = job.poll(cursor, wait)
                        metadata = dict(result)
                        events = metadata.pop("events")
                        encoded_events = [job.encoded_events[event["cursor"]] for event in events]
                        encoded = _job_encode(metadata)[:-1] + b',"events":[' + b",".join(encoded_events) + b"]}"
                        self._job_json_response(200, result, body=encoded)
                elif self.command == "DELETE" and len(parts) == 3 and not target.query:
                    cancelled = job.cancel()
                    self._job_json_response(200, {"id": job.id, "cancelled": cancelled, "done": job.done})
                else:
                    raise _JobAPIError(405, "method_not_allowed", "Use POST to start, GET to poll, or DELETE to cancel.")
            except _JobAPIError as error:
                self._job_json_response(error.status, {"error": {"code": error.code, "message": error.message}})
            except TimeoutError:
                self._job_json_response(408, {"error": {"code": "request_timeout", "message": "The job request timed out."}})
            except (OSError, UnicodeError):
                # Poll readers can disconnect without changing the job. A start
                # whose response cannot be delivered has no known owner.
                if started_job is not None and not started_job.client_identity:
                    started_job.cancel("start_disconnected", "The job start response could not be delivered.")

        do_GET = _job_dispatch
        do_HEAD = _job_dispatch
        do_POST = _job_dispatch
        do_PUT = _job_dispatch
        do_PATCH = _job_dispatch
        do_DELETE = _job_dispatch
        do_OPTIONS = _job_dispatch

    original_shutdown, original_close = server.shutdown, server.server_close

    def _job_shutdown():
        manager.close()
        return original_shutdown()

    def _job_close():
        manager.close()
        return original_close()

    server.RequestHandlerClass = _AsyncJobHandler
    server.shutdown, server.server_close, server._async_jobs = _job_shutdown, _job_close, manager
    return manager
