"""Loopback Ollama proxy that keeps an NDJSON response alive during prefill.

This file is also concatenated before kaggle-server.py in a single namespace.
Keep imports and implementation names private to avoid that script's globals.
"""

import http.client as _stream_http
import http.server as _stream_server
import json as _stream_json
import math as _stream_math
import queue as _stream_queue
import select as _stream_select
import socket as _stream_socket
import threading as _stream_threading
import time as _stream_time
import urllib.parse as _stream_url


_STREAM_HOP_HEADERS = frozenset((
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
))


def _stream_error_bytes(message, code=None):
    error = {"error": message}
    if code is not None:
        error["code"] = code
    return (_stream_json.dumps(error, ensure_ascii=False) + "\n").encode("utf-8")


def _stream_terminal_record(record):
    if not record.strip():
        return None
    try:
        value = _stream_json.loads(record)
    except (ValueError, UnicodeError):
        return False
    return isinstance(value, dict) and (value.get("done") is True or "error" in value)


def _stream_forward_headers(headers, request=False):
    omitted = set(_STREAM_HOP_HEADERS)
    for value in headers.get_all("Connection", []):
        omitted.update(name.strip().lower() for name in value.split(","))
    if request:
        omitted.update(("host", "content-length", "expect"))
    return [(name, value) for name, value in headers.items() if name.lower() not in omitted]


class _StreamRequest:
    def __init__(self):
        self.cancelled = _stream_threading.Event()
        self.finished = _stream_threading.Event()
        self.events = _stream_queue.Queue(maxsize=8)
        self.lock = _stream_threading.Lock()
        self.connection = None
        self.socket = None
        self.thread = None

    def put(self, kind, value=None):
        while not self.cancelled.is_set():
            try:
                self.events.put((kind, value), timeout=0.1)
                return True
            except _stream_queue.Full:
                pass
        return False

    def set_connection(self, connection):
        with self.lock:
            self.connection = connection
        if self.cancelled.is_set():
            connection.close()
            return False
        return True

    def set_socket(self, sock):
        # Retain this even when HTTPConnection detaches a Connection: close
        # response. Its HTTPResponse may still be blocked reading that socket.
        with self.lock:
            self.socket = sock
        if self.cancelled.is_set():
            self.cancel()
            return False
        return True

    def cancel(self):
        self.cancelled.set()
        with self.lock:
            sock, connection = self.socket, self.connection
        if sock is not None:
            try:
                sock.shutdown(_stream_socket.SHUT_RDWR)
            except OSError:
                pass
        if connection is not None:
            # shutdown first: close alone does not interrupt getresponse/read1
            # reliably when another thread owns the socket's buffered reader.
            try:
                connection.close()
            except OSError:
                pass


def _stream_upstream_error(body, status):
    try:
        parsed = _stream_json.loads(body)
        if isinstance(parsed, dict) and "error" in parsed:
            return body + (b"" if body.endswith(b"\n") else b"\n")
        message = parsed if isinstance(parsed, str) else _stream_json.dumps(parsed, ensure_ascii=False)
    except (ValueError, UnicodeError):
        message = body.decode("utf-8", "replace").strip()
    detail = (": " + message[:4096]) if message else ""
    return _stream_error_bytes("Ollama returned HTTP %s%s" % (status, detail))


def _stream_run_upstream(server, state, method, path, headers, body, streaming):
    response = None
    connection = _stream_http.HTTPConnection(server.upstream_host, server.upstream_port, timeout=10)
    try:
        if not state.set_connection(connection):
            return
        connection.connect()
        if not state.set_socket(connection.sock):
            return
        # Long prompt evaluation has no read deadline; the downstream handler
        # remains responsive and cancels this socket when the downstream fails.
        connection.sock.settimeout(None)
        if state.cancelled.is_set():
            return
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        if state.cancelled.is_set():
            return
        if streaming and not 200 <= response.status < 300:
            error_body = bytearray()
            while not state.cancelled.is_set():
                chunk = response.read1(min(65536, server.max_request_bytes + 1 - len(error_body)))
                if not chunk:
                    break
                error_body.extend(chunk)
                if len(error_body) > server.max_request_bytes:
                    state.put("data", _stream_error_bytes("Ollama returned an oversized error response."))
                    return
            state.put("data", _stream_upstream_error(bytes(error_body), response.status))
            return
        if not streaming:
            if not state.put("headers", (response.status, _stream_forward_headers(response.headers))):
                return
        if method != "HEAD":
            pending = bytearray()
            terminal = False
            while not state.cancelled.is_set():
                # read(65536) can wait for the entire buffer. read1 emits the
                # currently available bytes, preserving each model flush.
                chunk = response.read1(65536)
                if not chunk:
                    break
                if not streaming:
                    if not state.put("data", chunk):
                        return
                    continue
                # A TCP read can end halfway through a JSON record. Emit only
                # complete lines so a heartbeat never splits a JSON string.
                pending.extend(chunk)
                while True:
                    newline = pending.find(b"\n")
                    if newline < 0:
                        break
                    if newline + 1 > server.max_request_bytes:
                        state.put("data", _stream_error_bytes("Ollama returned an oversized NDJSON record."))
                        return
                    record = bytes(pending[:newline + 1])
                    del pending[:newline + 1]
                    if not state.put("data", record):
                        return
                    record_terminal = _stream_terminal_record(record)
                    if record_terminal is not None:
                        terminal = record_terminal
                if len(pending) > server.max_request_bytes:
                    state.put("data", _stream_error_bytes("Ollama returned an oversized NDJSON record."))
                    return
            if streaming and pending:
                record = bytes(pending) + b"\n"
                if not state.put("data", record):
                    return
                record_terminal = _stream_terminal_record(record)
                if record_terminal is not None:
                    terminal = record_terminal
            if streaming and not terminal and not state.cancelled.is_set():
                state.put("data", _stream_error_bytes(
                    "The model stream ended before completion. Please retry.", "upstream_eof"))
    except Exception as error:
        if not state.cancelled.is_set():
            # Exception messages can include URLs/request data. Only report the
            # exception type, and never log request/response content here.
            state.put("error", _stream_error_bytes("Ollama connection failed (%s)." % type(error).__name__))
    finally:
        try:
            if response is not None:
                response.close()
        finally:
            connection.close()
            state.put("done")
            state.finished.set()


class _StreamProxyServer(_stream_server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, upstream, heartbeat_seconds, heartbeat_padding_bytes, max_request_bytes):
        self.upstream_host = upstream.hostname
        self.upstream_port = upstream.port or 80
        self.heartbeat_seconds = heartbeat_seconds
        self.heartbeat = b" " * max(0, heartbeat_padding_bytes - 1) + b"\n"
        self.max_request_bytes = max_request_bytes
        self.active_requests = set()
        self.active_lock = _stream_threading.Lock()
        super().__init__(address, _StreamProxyHandler)

    def cancel_active(self):
        with self.active_lock:
            active = tuple(self.active_requests)
        for request in active:
            request.cancel()

    def shutdown(self):
        self.cancel_active()
        super().shutdown()

    def server_close(self):
        self.cancel_active()
        super().server_close()

    def handle_error(self, request, client_address):
        # BaseHTTPRequestHandler already handles client errors below. Keep the
        # notebook log free of request targets and model text on all paths.
        pass


class _StreamBodyError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message
        super().__init__(message)


class _StreamProxyHandler(_stream_server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "OllamaStreamProxy/1"

    def log_message(self, *args):
        pass

    def _json_error(self, status, message):
        body = _stream_error_bytes(message)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        self.wfile.flush()
        self.close_connection = True

    def _chunk(self, body):
        self.wfile.write(("%x\r\n" % len(body)).encode("ascii"))
        self.wfile.write(body)
        self.wfile.write(b"\r\n")
        self.wfile.flush()

    def _disconnected(self):
        try:
            readable, _, _ = _stream_select.select([self.connection], [], [], 0)
            if readable:
                # A clean TCP FIN closes only the peer's request writer. A
                # tunnel can still be reading the response, so EOF alone must
                # not cancel Ollama. Resets fail recv; fully closed readers are
                # detected by the next response write/heartbeat instead.
                self.connection.recv(1, _stream_socket.MSG_PEEK)
            return False
        except (OSError, ValueError):
            return True

    def _request_body(self):
        lengths = self.headers.get_all("Content-Length", [])
        encodings = self.headers.get_all("Transfer-Encoding", [])
        if lengths and encodings:
            raise _StreamBodyError(400, "Content-Length and Transfer-Encoding cannot be combined.")
        if encodings:
            if len(encodings) != 1 or encodings[0].strip().lower() != "chunked":
                raise _StreamBodyError(501, "Only chunked request transfer encoding is supported.")
            body = bytearray()
            metadata_bytes = 0
            while True:
                line = self.rfile.readline(8193)
                metadata_bytes += len(line)
                if len(line) > 8192 or not line.endswith(b"\r\n") or metadata_bytes > 65536:
                    raise _StreamBodyError(400, "Invalid or oversized chunk framing.")
                size_text = line[:-2].split(b";", 1)[0]
                if not size_text or len(size_text) > 16 or any(character not in b"0123456789abcdefABCDEF" for character in size_text):
                    raise _StreamBodyError(400, "Invalid chunk size.")
                size = int(size_text, 16)
                if len(body) + size > self.server.max_request_bytes:
                    raise _StreamBodyError(413, "Request body exceeds the proxy size limit.")
                if size == 0:
                    while True:
                        trailer = self.rfile.readline(8193)
                        metadata_bytes += len(trailer)
                        if len(trailer) > 8192 or not trailer.endswith(b"\r\n") or metadata_bytes > 65536:
                            raise _StreamBodyError(400, "Invalid or oversized chunk trailers.")
                        if trailer == b"\r\n":
                            return bytes(body)
                        if (b":" not in trailer or trailer[:1] in (b" ", b"\t")
                                or trailer.split(b":", 1)[0].lower() in (b"content-length", b"transfer-encoding", b"host")):
                            raise _StreamBodyError(400, "Invalid chunk trailer.")
                chunk = self.rfile.read(size)
                if len(chunk) != size or self.rfile.read(2) != b"\r\n":
                    raise _StreamBodyError(400, "Incomplete chunked request body.")
                body.extend(chunk)
        if (len(lengths) > 1 or (lengths and (not lengths[0].strip().isascii()
                or not lengths[0].strip().isdigit()))):
            raise _StreamBodyError(400, "Invalid Content-Length.")
        if lengths and len(lengths[0].strip()) > 16:
            raise _StreamBodyError(413, "Request body exceeds the proxy size limit.")
        length = int(lengths[0]) if lengths else 0
        if length > self.server.max_request_bytes:
            raise _StreamBodyError(413, "Request body exceeds the proxy size limit.")
        body = self.rfile.read(length) if length else b""
        if len(body) != length:
            raise _StreamBodyError(400, "Incomplete request body.")
        return body

    def _dispatch(self):
        self.close_connection = True
        self.connection.settimeout(30)
        try:
            target = _stream_url.urlsplit(self.path)
        except ValueError:
            self._json_error(404, "Only local /api/* requests are supported.")
            return
        decoded_path = _stream_url.unquote(target.path)
        if (target.scheme or target.netloc or target.fragment or not target.path.startswith("/api/")
                or "\\" in decoded_path or any(part in (".", "..") for part in decoded_path.split("/"))
                or any(ord(character) < 32 or ord(character) == 127 for character in decoded_path)):
            self._json_error(404, "Only local /api/* requests are supported.")
            return
        try:
            body = self._request_body()
        except TimeoutError:
            self._json_error(408, "Timed out reading request body.")
            return
        except _StreamBodyError as error:
            self._json_error(error.status, error.message)
            return
        streaming = False
        if self.command == "POST" and target.path in ("/api/chat", "/api/generate"):
            try:
                payload = _stream_json.loads(body)
            except (ValueError, UnicodeError):
                self._json_error(400, "Chat and generate requests require a JSON object.")
                return
            if not isinstance(payload, dict):
                self._json_error(400, "Chat and generate requests require a JSON object.")
                return
            stream = payload.get("stream")
            if stream is not None and not isinstance(stream, bool):
                self._json_error(400, "The stream field must be true, false, or null.")
                return
            streaming = stream is not False
        headers = dict(_stream_forward_headers(self.headers, request=True))
        if body or self.command in ("POST", "PUT", "PATCH"):
            headers["Content-Length"] = str(len(body))
        if streaming:
            headers["Accept-Encoding"] = "identity"
        headers["Connection"] = "close"
        state = _StreamRequest()
        with self.server.active_lock:
            self.server.active_requests.add(state)
        response_started = False
        try:
            if streaming:
                # Headers and a padded blank line arrive before Ollama receives
                # the prompt. NDJSON parsers ignore these whitespace-only lines.
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Transfer-Encoding", "chunked")
                self.send_header("Cache-Control", "no-cache, no-transform")
                self.send_header("X-Accel-Buffering", "no")
                self.send_header("Connection", "close")
                self.end_headers()
                self._chunk(self.server.heartbeat)
                response_started = True
            state.thread = _stream_threading.Thread(
                target=_stream_run_upstream,
                args=(self.server, state, self.command, self.path, headers, body, streaming),
                name="ollama-proxy-upstream", daemon=True,
            )
            state.thread.start()
            next_heartbeat = _stream_time.monotonic() + self.server.heartbeat_seconds
            while not state.cancelled.is_set():
                if self._disconnected():
                    break
                wait = min(0.1, max(0, next_heartbeat - _stream_time.monotonic())) if streaming else 0.1
                try:
                    kind, value = state.events.get(timeout=wait)
                except _stream_queue.Empty:
                    if streaming and _stream_time.monotonic() >= next_heartbeat:
                        self._chunk(self.server.heartbeat)
                        next_heartbeat = _stream_time.monotonic() + self.server.heartbeat_seconds
                    continue
                if kind == "headers":
                    status, response_headers = value
                    self.send_response(status)
                    for name, content in response_headers:
                        self.send_header(name, content)
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.flush()
                    response_started = True
                elif kind == "data":
                    if streaming:
                        self._chunk(value)
                        next_heartbeat = _stream_time.monotonic() + self.server.heartbeat_seconds
                    else:
                        self.wfile.write(value)
                        self.wfile.flush()
                elif kind == "error":
                    if streaming:
                        self._chunk(value)
                    elif not response_started:
                        self._json_error(502, _stream_json.loads(value)["error"])
                    else:
                        break
                elif kind == "done":
                    if streaming:
                        self.wfile.write(b"0\r\n\r\n")
                        self.wfile.flush()
                    break
        except (OSError, ValueError):
            # Includes clients cancelling while headers/body are being flushed.
            pass
        finally:
            state.cancel()
            with self.server.active_lock:
                self.server.active_requests.discard(state)

    do_GET = _dispatch
    do_HEAD = _dispatch
    do_POST = _dispatch
    do_PUT = _dispatch
    do_PATCH = _dispatch
    do_DELETE = _dispatch
    do_OPTIONS = _dispatch


def start_stream_proxy(upstream="http://127.0.0.1:11434", port=11435, heartbeat_seconds=10,
                       heartbeat_padding_bytes=16384, max_request_bytes=4 * 1024 * 1024):
    """Start a daemon HTTP server on 127.0.0.1 and return the server object.

    Streamed chat/generate requests return HTTP 200 immediately. Upstream HTTP
    errors therefore appear as NDJSON {"error": ...} records. Other API requests
    preserve upstream status, headers and body. Padding is whitespace, not SSE.
    heartbeat_padding_bytes=0 selects a single newline heartbeat. Stop using
    server.shutdown() followed by server.server_close(); both cancel requests.
    TCP resets cancel immediately; fully closed readers are detected at the next
    response write/heartbeat because clean request-writer EOF is valid.
    """
    target = _stream_url.urlsplit(upstream)
    if (target.scheme != "http" or target.hostname not in ("127.0.0.1", "localhost", "::1")
            or target.username is not None or target.password is not None
            or target.path not in ("", "/") or target.query or target.fragment):
        raise ValueError("The streaming proxy requires a local HTTP upstream origin.")
    if not isinstance(heartbeat_seconds, (int, float)) or not _stream_math.isfinite(heartbeat_seconds) or heartbeat_seconds <= 0:
        raise ValueError("heartbeat_seconds must be positive and finite.")
    if not isinstance(heartbeat_padding_bytes, int) or not 0 <= heartbeat_padding_bytes <= 1024 * 1024:
        raise ValueError("heartbeat_padding_bytes must be between 0 and 1048576.")
    if not isinstance(max_request_bytes, int) or not 1 <= max_request_bytes <= 64 * 1024 * 1024:
        raise ValueError("max_request_bytes must be between 1 and 67108864.")
    server = _StreamProxyServer(("127.0.0.1", port), target, heartbeat_seconds, heartbeat_padding_bytes, max_request_bytes)
    server.thread = _stream_threading.Thread(target=server.serve_forever, name="ollama-stream-proxy", daemon=True)
    server.thread.start()
    return server
