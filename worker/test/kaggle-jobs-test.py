"""Local-only tests of the reconnectable Ollama job transport.

Run from worker/: python test/kaggle-jobs-test.py
No external network, tunnel, model, GPU or production source changes are used.
"""

import http.client
import http.server
import json
from pathlib import Path
import select
import secrets
import socket
import threading
import time
import unittest


class _Origin(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def aborted(self):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            try:
                readable, _, _ = select.select([self.connection], [], [], 0.03)
                if readable and self.connection.recv(1, socket.MSG_PEEK) == b"":
                    self.server.aborted.set()
                    return
            except OSError:
                self.server.aborted.set()
                return

    def do_GET(self):
        self.reply(201, b'{"fixture":"passthrough"}')

    def do_POST(self):
        raw_body = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.request_bodies.append(raw_body)
        payload = json.loads(raw_body)
        self.server.requests.append((self.path, payload))
        self.server.received.set()
        case = payload.get("case", "normal")
        if case == "cancel":
            self.aborted()
        elif case in ("cancel_body", "overflow"):
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write((b'{"response":"' + b"x" * 300 + b'"}\n') * (10 if case == "overflow" else 1))
            self.wfile.flush()
            self.aborted()
        elif case == "delayed":
            self.server.release.wait(3)
            self.reply(200, self.server.records)
        elif case == "trickle":
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Connection", "close")
            self.end_headers()
            for number in range(20):
                self.wfile.write((json.dumps({"message": {"thinking": str(number)}}) + "\n").encode())
                self.wfile.flush()
                time.sleep(0.015)
            self.server.release.wait(2)
            self.wfile.write(b'{"done":true}\n')
            self.wfile.flush()
        elif case == "error":
            self.reply(422, b'{"error":"fixture model missing","detail":{"expected":"fixture"}}')
        elif case == "text_error":
            self.reply(503, b"fixture unavailable")
        elif case == "empty":
            self.reply(200, b"")
        elif case == "partial":
            self.reply(200, b'{"response":"partial"}\n')
        elif case == "invalid":
            self.reply(200, b'{"response":')
        elif case == "large_record":
            self.reply(200, b'{"response":"' + b"x" * 5000 + b'"}\n')
        elif case == "many":
            self.reply(200, b"".join(json.dumps({"response": str(number)}).encode() + b"\n" for number in range(8)) + b'{"done":true,"eval_count":8}\n')
        elif case == "raw_numbers":
            self.reply(200, b'{"response":"fixture","seed":9223372036854775807,"timing":1.2300e+04}\n{"done":true}\n')
        else:
            self.reply(200, self.server.records)
        self.close_connection = True


class _OriginServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass


class AsyncProposalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source_dir = Path(__file__).resolve().parents[1] / "src"
        cls.namespace = {"__name__": "kaggle_jobs_under_test"}
        for source in (source_dir / "kaggle-stream-proxy.py", source_dir / "kaggle-jobs.py"):
            exec(compile(source.read_text(encoding="utf-8"), str(source), "exec"), cls.namespace)
        cls.namespace["http"] = lambda *args, **kwargs: None

    def setUp(self):
        self.origin = _OriginServer(("127.0.0.1", 0), _Origin)
        self.origin.received, self.origin.release, self.origin.aborted = threading.Event(), threading.Event(), threading.Event()
        self.origin.requests = []
        self.origin.request_bodies = []
        self.origin.records = b'{"message":{"content":"fixture answer"},"done":false}\n{"done":true,"prompt_eval_count":87000,"eval_count":2}\n'
        self.origin_thread = threading.Thread(target=self.origin.serve_forever, daemon=True)
        self.origin_thread.start()
        self.server = self.namespace["start_stream_proxy"](
            upstream="http://127.0.0.1:%s" % self.origin.server_port, port=0, heartbeat_seconds=0.1,
        )
        self.manager = self.namespace["install_async_job_routes"](
            self.server, retention_seconds=3, idle_seconds=3, max_job_seconds=5,
            max_output_bytes=65536, max_output_events=32, max_record_bytes=4096,
            max_poll_bytes=12288, max_poll_events=2, reaper_seconds=0.02,
            stream_heartbeat_seconds=0.04, control_token="c" * 64,
        )

    def test_personal_control_wait_is_authenticated_bounded_and_wakes_on_idle(self):
        for token in (None, "d" * 64):
            self.assertEqual(self.request("GET", "/_jobs/control?max_seconds=0.3", token=token)[0], 403)
        for query in ("max_seconds=0", "max_seconds=301", "max_seconds=nan", "max_seconds=1&extra=1"):
            self.assertEqual(self.request("GET", "/_jobs/control?" + query, token="c" * 64)[0], 400)
        owner = "12345678-1234-1234-1234-123456789abc"
        job, _ = self.manager.start("/api/chat", b'{"case":"delayed"}', owner + "-main", "a" * 64)
        self.assertTrue(self.origin.received.wait(1))
        self.assertEqual(self.manager.active_generations(), [owner])
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        connection.request("GET", "/_jobs/control?max_seconds=1", headers={"Authorization": "Bearer " + "c" * 64})
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Cache-Control"), "no-store, no-transform")
        self.assertTrue(json.loads(response.readline())["busy"])
        self.origin.release.set()
        records = [json.loads(line) for line in response.read().splitlines() if line.strip()]
        self.assertFalse(records[-1]["busy"])
        self.assertTrue(all(set(record) == {"busy"} for record in records))
        connection.close()
        self.assertTrue(job.request.finished.wait(1))
        self.assertEqual(self.manager.active_generations(), [])

    def test_scoped_generation_cancel_never_cancels_another_owner(self):
        owner = "12345678-1234-1234-1234-123456789abc"
        job, _ = self.manager.start("/api/chat", b'{"case":"cancel"}', owner + "-finish", "a" * 64)
        self.assertTrue(self.origin.received.wait(1))
        self.manager.cancel_generations(["22345678-1234-1234-1234-123456789abc"])
        self.assertFalse(job.done)
        self.manager.cancel_generations([owner])
        self.assertTrue(job.request.finished.wait(1))
        self.assertEqual(job.status, "cancelled")

    def tearDown(self):
        self.origin.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.origin.shutdown()
        self.origin.server_close()

    def request(self, method, path, payload=None, token=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        connection.request(method, path, body=None if payload is None else json.dumps(payload), headers=headers)
        response = connection.getresponse()
        body = response.read()
        status, result_headers = response.status, response.headers
        connection.close()
        self.assertEqual(result_headers.get("Cache-Control"), "no-store")
        return status, json.loads(body), len(body)

    def start(self, case="normal", target="/api/chat"):
        status, result, _ = self.request("POST", "/_jobs", {"target": target, "body": {"case": case, "messages": [], "options": {"num_ctx": 98304}}})
        self.assertEqual(status, 202, result)
        self.assertGreaterEqual(len(result["token"]), 40)
        return result

    def poll(self, job, cursor=0, wait=0):
        return self.request("GET", "/_jobs/%s/events?cursor=%s&wait=%s" % (job["id"], cursor, wait), token=job["token"])

    def drain(self, job):
        cursor, events, final = 0, [], None
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            status, final, size = self.poll(job, cursor, 0.1)
            self.assertEqual(status, 200, final)
            self.assertLessEqual(size, self.manager.max_poll_bytes)
            events.extend(final["events"])
            cursor = final["nextCursor"]
            if final["done"]:
                return events, final
        self.fail("Job did not finish")

    def stream(self, job, cursor=0, seconds=0.3):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        connection.request("GET", "/_jobs/%s/stream?cursor=%s&max_seconds=%s" % (job["id"], cursor, seconds),
                           headers={"Authorization": "Bearer " + job["token"]})
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "application/x-ndjson")
        self.assertEqual(response.getheader("Cache-Control"), "no-store, no-transform")
        return connection, response

    def read_leg(self, job, cursor=0, seconds=0.3):
        connection, response = self.stream(job, cursor, seconds)
        try:
            return [json.loads(line) for line in response.read().splitlines() if line.strip()]
        finally:
            response.close()
            connection.close()

    def test_delayed_origin_survives_many_separate_poll_responses(self):
        started = time.monotonic()
        job = self.start("delayed")
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertTrue(self.origin.received.wait(1))
        for _ in range(6):
            status, result, _ = self.poll(job, wait=0.04)
            self.assertEqual(status, 200)
            self.assertEqual(result["events"], [])
            self.assertFalse(result["done"])
        self.assertEqual(len(self.origin.requests), 1)
        self.origin.release.set()
        events, result = self.drain(job)
        self.assertEqual([event["record"] for event in events], [json.loads(line) for line in self.origin.records.splitlines()])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["upstreamStatus"], 200)

    def test_bounded_stream_legs_reconnect_during_delayed_prefill(self):
        job = self.start("delayed")
        self.assertTrue(self.origin.received.wait(1))
        for _ in range(3):
            started = time.monotonic()
            envelopes = self.read_leg(job, seconds=0.11)
            self.assertLess(time.monotonic() - started, 0.5)
            self.assertGreaterEqual(len(envelopes), 2)
            self.assertTrue(all(event.get("heartbeat") and event["cursor"] == 0 for event in envelopes))
            self.assertFalse(self.manager.jobs[job["id"]].done)
        self.assertEqual(len(self.origin.requests), 1)
        self.origin.release.set()
        envelopes = self.read_leg(job)
        self.assertEqual([event["record"] for event in envelopes if "record" in event], [json.loads(line) for line in self.origin.records.splitlines()])
        self.assertTrue(envelopes[-1]["done"])
        self.assertEqual(envelopes[-1]["cursor"], 2)

    def test_padding_cadence_is_not_starved_by_continuous_small_model_records(self):
        # A tunnel may buffer small records until enough bytes or EOF. Padding
        # must arrive DURING continuous token output, not only after it goes quiet.
        job = self.start("trickle")
        connection, response = self.stream(job, seconds=0.65)
        try:
            envelopes = [json.loads(line) for line in response.read().splitlines() if line.strip()]
        finally:
            response.close()
            connection.close()
            self.origin.release.set()
        records = [event for event in envelopes if "record" in event]
        self.assertEqual(len(records), 20)
        during_output = [event for event in envelopes if event.get("heartbeat") and 0 < event["cursor"] < 20]
        self.assertGreaterEqual(len(during_output), 2, "Token traffic must not postpone the tunnel flush heartbeat")

    def test_stream_reader_disconnect_and_cursor_resume_preserve_job(self):
        job = self.start("many")
        connection, response = self.stream(job)
        first = json.loads(response.readline())
        if first.get("heartbeat"):
            first = json.loads(response.readline())
        self.assertEqual(first["cursor"], 0)
        response.close()
        connection.close()
        envelopes = self.read_leg(job, cursor=1)
        records = [first] + [event for event in envelopes if "record" in event]
        self.assertEqual([event["cursor"] for event in records], list(range(9)))
        self.assertTrue(envelopes[-1]["done"])
        self.assertEqual(envelopes[-1]["cursor"], 9)

    def test_client_identity_makes_start_idempotent_and_cancelable_after_lost_ack(self):
        identity, token = secrets.token_urlsafe(18), secrets.token_urlsafe(32)
        payload = {"job_id": identity, "token": token, "target": "/api/chat", "body": {"case": "cancel", "options": {"num_ctx": 98304}}}
        status, first, _ = self.request("POST", "/_jobs", payload)
        self.assertEqual(status, 202)
        self.assertEqual((first["id"], first["token"]), (identity, token))
        status, replay, _ = self.request("POST", "/_jobs", payload)
        self.assertEqual(status, 202)
        self.assertEqual(first, replay)
        self.assertTrue(self.origin.received.wait(1))
        self.assertEqual(len(self.origin.requests), 1)
        # Collision validation covers the original body bytes, including order.
        payload["body"] = {"options": {"num_ctx": 98304}, "case": "cancel"}
        self.assertEqual(self.request("POST", "/_jobs", payload)[0], 409)
        payload["body"]["case"] = "changed"
        self.assertEqual(self.request("POST", "/_jobs", payload)[0], 409)
        payload["token"] = secrets.token_urlsafe(32)
        self.assertEqual(self.request("POST", "/_jobs", payload)[0], 403)
        self.assertEqual(self.request("DELETE", "/_jobs/" + identity, token=token)[0], 200)
        self.assertTrue(self.origin.aborted.wait(1))

    def test_stream_terminal_envelope_preserves_upstream_http_error(self):
        job = self.start("error")
        self.assertTrue(self.manager.jobs[job["id"]].request.finished.wait(1))
        envelopes = self.read_leg(job)
        self.assertIn("record", envelopes[0])
        self.assertEqual(envelopes[0]["upstreamStatus"], 422)
        records = [event["record"] for event in envelopes if "record" in event]
        self.assertEqual(records[0]["detail"], {"expected": "fixture"})
        self.assertTrue(envelopes[-1]["done"])
        self.assertEqual(envelopes[-1]["upstreamStatus"], 422)
        self.assertEqual(envelopes[-1]["error"]["code"], "upstream_http_error")

    def test_stream_pending_heartbeat_includes_known_upstream_status(self):
        job = self.start("cancel_body")
        stored = self.manager.jobs[job["id"]]
        deadline = time.monotonic() + 1
        while stored.upstream_status is None and time.monotonic() < deadline:
            time.sleep(0.01)
        connection, response = self.stream(job)
        heartbeat = json.loads(response.readline())
        response.close()
        connection.close()
        self.assertTrue(heartbeat["heartbeat"])
        self.assertEqual(heartbeat["upstreamStatus"], 200)
        self.request("DELETE", "/_jobs/" + job["id"], token=job["token"])

    def test_read_and_cancel_require_token_without_refreshing_idle_ttl(self):
        job = self.start("cancel")
        stored = self.manager.jobs[job["id"]]
        last_poll = stored.last_poll
        for token in (None, "wrong", "é"):
            for method, suffix in (("GET", "/events?wait=0"), ("DELETE", "")):
                status, result, _ = self.request(method, "/_jobs/" + job["id"] + suffix, token=token)
                self.assertEqual(status, 403, result)
        self.assertEqual(stored.last_poll, last_poll)
        self.assertFalse(stored.done)

    def test_cancel_interrupts_origin_before_headers_and_during_body(self):
        for case in ("cancel", "cancel_body"):
            with self.subTest(case=case):
                self.origin.received.clear()
                self.origin.aborted.clear()
                job = self.start(case)
                self.assertTrue(self.origin.received.wait(1))
                stored = self.manager.jobs[job["id"]]
                status, result, _ = self.request("DELETE", "/_jobs/" + job["id"], token=job["token"])
                self.assertEqual(status, 200)
                self.assertTrue(result["cancelled"])
                self.assertTrue(self.origin.aborted.wait(1))
                self.assertTrue(stored.request.finished.wait(1))
                _, result, _ = self.poll(job)
                self.assertEqual(result["status"], "cancelled")

    def test_poll_disconnect_does_not_cancel_generation(self):
        job = self.start("delayed")
        sock = socket.create_connection(("127.0.0.1", self.server.server_port), timeout=1)
        sock.sendall(("GET /_jobs/%s/events?wait=0.3 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\n\r\n" % (job["id"], job["token"])).encode())
        sock.close()
        self.assertFalse(self.manager.jobs[job["id"]].done)
        self.origin.release.set()
        _, result = self.drain(job)
        self.assertEqual(result["status"], "completed")

    def test_pagination_and_cursor_retries_preserve_all_metadata(self):
        job = self.start("many", "/api/generate")
        self.assertTrue(self.manager.jobs[job["id"]].request.finished.wait(1))
        _, first, _ = self.poll(job, 0)
        _, retry, _ = self.poll(job, 0)
        self.assertEqual(first, retry)
        self.assertFalse(first["done"])
        self.assertTrue(first["jobDone"])
        self.assertTrue(first["hasMore"])
        events, final = self.drain(job)
        self.assertEqual(len(events), 9)
        self.assertEqual([event["cursor"] for event in events], list(range(9)))
        self.assertEqual(events[-1]["record"], {"done": True, "eval_count": 8})
        self.assertEqual(final["nextCursor"], 9)
        self.assertEqual(self.poll(job, 10)[0], 409)
        self.assertEqual(self.origin.requests[0][0], "/api/generate")
        self.assertIsNot(self.origin.requests[0][1].get("stream"), False)

    def test_request_and_record_json_lexical_bytes_survive_both_routes(self):
        body = b'{ "case":"raw_numbers", "stream":null, "seed":9223372036854775807, "value":1.2300e+04, "prompt":"escaped \\\"body\\\" \xe2\x9c\x93" }'
        wrapper = b'{"target":"/api/chat","body":' + body + b"}"
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=1)
        connection.request("POST", "/_jobs", body=wrapper, headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        self.assertEqual(response.status, 202)
        job = json.loads(response.read())
        connection.close()
        self.assertTrue(self.manager.jobs[job["id"]].request.finished.wait(1))
        self.assertEqual(self.origin.request_bodies[0], body)
        expected = b'"record":{"response":"fixture","seed":9223372036854775807,"timing":1.2300e+04}'
        connection, response = self.stream(job)
        self.assertIn(expected, response.read())
        response.close()
        connection.close()
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=1)
        connection.request("GET", "/_jobs/%s/events?wait=0" % job["id"], headers={"Authorization": "Bearer " + job["token"]})
        response = connection.getresponse()
        self.assertIn(expected, response.read())
        connection.close()

    def test_event_at_poll_size_boundary_cannot_stall_cursor(self):
        self.manager.max_poll_bytes = 8192
        job_type, encode = self.namespace["_AsyncOllamaJob"], self.namespace["_job_encode"]
        job = job_type(self.manager, "/api/chat", b"{}")
        base_size = len(encode({"cursor": 0, "record": {"response": ""}}))
        record = {"response": "x" * (4096 - base_size)}
        self.assertEqual(len(encode({"cursor": 0, "record": record})), 4096)
        self.assertFalse(job.append(record))
        self.assertEqual(job.error["code"], "output_limit")
        self.assertTrue(job.poll(0, 0)["done"])

    def test_upstream_errors_preserve_status_and_original_json(self):
        job = self.start("error")
        events, result = self.drain(job)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["upstreamStatus"], 422)
        self.assertEqual(result["error"]["code"], "upstream_http_error")
        self.assertEqual(events[0]["record"], {"error": "fixture model missing", "detail": {"expected": "fixture"}})

    def test_non_json_upstream_error_is_preserved(self):
        job = self.start("text_error")
        events, result = self.drain(job)
        self.assertEqual(result["upstreamStatus"], 503)
        self.assertEqual(events[0]["upstreamError"], {"status": 503, "body": "fixture unavailable"})

    def test_empty_partial_and_invalid_streams_have_explicit_errors(self):
        for case, code, count in (("empty", "upstream_eof", 0), ("partial", "upstream_eof", 1), ("invalid", "upstream_invalid_json", 0)):
            with self.subTest(case=case):
                job = self.start(case)
                events, result = self.drain(job)
                self.assertEqual(len(events), count)
                self.assertEqual(result["error"]["code"], code)
                self.assertTrue(self.manager.jobs[job["id"]].request.finished.wait(1))

    def test_output_and_record_limits_close_upstream(self):
        self.manager.max_output_bytes = 500
        job = self.start("overflow")
        events, result = self.drain(job)
        self.assertEqual(result["error"]["code"], "output_limit")
        self.assertTrue(self.origin.aborted.wait(1))
        self.assertTrue(self.manager.jobs[job["id"]].request.finished.wait(1))
        job = self.start("large_record")
        _, result = self.drain(job)
        self.assertEqual(result["error"]["code"], "record_limit")

    def test_idle_timeout_cancels_gpu_job_and_retention_expires(self):
        self.manager.idle_seconds = 0.12
        self.manager.retention_seconds = 0.15
        job = self.start("cancel")
        stored = self.manager.jobs[job["id"]]
        self.assertTrue(self.origin.aborted.wait(1))
        self.assertEqual(stored.error["code"], "idle_timeout")
        self.assertTrue(stored.request.finished.wait(1))
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            if self.poll(job)[0] == 404:
                break
            time.sleep(0.02)
        else:
            self.fail("Completed job did not expire")

    def test_runtime_limit_cancels_even_with_active_polling(self):
        self.manager.max_job_seconds = 0.12
        job = self.start("cancel")
        _, result = self.drain(job)
        self.assertEqual(result["error"]["code"], "job_timeout")
        self.assertTrue(self.origin.aborted.wait(1))

    def test_concurrency_and_retention_capacity_are_bounded(self):
        job = self.start("cancel")
        status, result, _ = self.request("POST", "/_jobs", {"target": "/api/chat", "body": {}})
        self.assertEqual(status, 429)
        self.assertEqual(result["error"]["code"], "busy")
        self.request("DELETE", "/_jobs/" + job["id"], token=job["token"])
        self.assertTrue(self.manager.jobs[job["id"]].request.finished.wait(1))
        self.manager.max_retained_jobs = 1
        status, result, _ = self.request("POST", "/_jobs", {"target": "/api/chat", "body": {}})
        self.assertEqual(status, 202)
        self.assertEqual(self.poll(job)[0], 404)
        self.assertEqual(len(self.manager.jobs), 1)

    def test_fast_conversation_evicts_oldest_completed_jobs_without_blocking(self):
        self.manager.max_retained_jobs = 3
        jobs = []
        for _ in range(10):
            job = self.start()
            jobs.append(job)
            self.assertTrue(self.manager.jobs[job["id"]].request.finished.wait(1))
            self.assertLessEqual(len(self.manager.jobs), 3)
        self.assertEqual(list(self.manager.jobs), [job["id"] for job in jobs[-3:]])
        self.assertEqual(self.poll(jobs[0])[0], 404)
        self.assertEqual(self.poll(jobs[-1])[0], 200)

    def test_shutdown_cancels_active_job(self):
        job = self.start("cancel")
        self.assertTrue(self.origin.received.wait(1))
        self.server.shutdown()
        self.assertTrue(self.origin.aborted.wait(1))
        self.assertTrue(self.manager.jobs[job["id"]].request.finished.wait(1))

    def test_invalid_start_targets_and_poll_parameters_are_rejected(self):
        for target, body in (("http://example.invalid/api/chat", {}), ("/api/tags", {}), ("/api/chat", {"stream": False}), ("/api/chat", []), ("/api/chat", {"prompt": "\ud800"})):
            status, _, _ = self.request("POST", "/_jobs", {"target": target, "body": body})
            self.assertEqual(status, 400)
        job = self.start("delayed")
        for query in ("wait=21", "wait=nan", "cursor=-1", "cursor=0&cursor=1", "token=private"):
            status, _, _ = self.request("GET", "/_jobs/%s/events?%s" % (job["id"], query), token=job["token"])
            self.assertEqual(status, 400, query)
        for query in ("max_seconds=121", "max_seconds=0", "max_seconds=nan", "cursor=-1"):
            status, _, _ = self.request("GET", "/_jobs/%s/stream?%s" % (job["id"], query), token=job["token"])
            self.assertEqual(status, 400, query)
        for identity, token in (("short", secrets.token_urlsafe(32)), (secrets.token_urlsafe(18), "short"), ("é" * 24, secrets.token_urlsafe(32))):
            status, _, _ = self.request("POST", "/_jobs", {"target": "/api/chat", "body": {}, "job_id": identity, "token": token})
            self.assertEqual(status, 400)

    def test_personal_server_can_opt_into_five_minute_legs_and_two_hour_jobs(self):
        personal = self.namespace["start_stream_proxy"](
            upstream="http://127.0.0.1:%s" % self.origin.server_port, port=0, heartbeat_seconds=0.1,
        )
        manager = self.namespace["install_async_job_routes"](
            personal, max_job_seconds=7200, max_stream_seconds=300,
        )
        original = self.server
        self.server = personal
        try:
            self.assertEqual(manager.max_job_seconds, 7200)
            job = self.start()
            records = self.read_leg(job, seconds=300)
            self.assertTrue(any(record.get("done") for record in records))
            status, result, _ = self.request("GET", "/_jobs/%s/stream?max_seconds=301" % job["id"], token=job["token"])
            self.assertEqual(status, 400)
            self.assertEqual(result["error"]["code"], "invalid_poll")
        finally:
            self.server = original
            manager.close()
            personal.shutdown()
            personal.server_close()

    def test_stream_leg_configuration_remains_finite_and_bounded(self):
        for value in (0, -1, 301, True, float("nan"), float("inf")):
            server = self.namespace["start_stream_proxy"](
                upstream="http://127.0.0.1:%s" % self.origin.server_port, port=0,
            )
            try:
                with self.assertRaises(ValueError):
                    self.namespace["install_async_job_routes"](server, max_stream_seconds=value)
            finally:
                server.shutdown()
                server.server_close()

    def test_original_api_routes_are_inherited_unchanged(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=1)
        connection.request("GET", "/api/tags")
        response = connection.getresponse()
        self.assertEqual(response.status, 201)
        self.assertEqual(json.loads(response.read()), {"fixture": "passthrough"})
        connection.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
