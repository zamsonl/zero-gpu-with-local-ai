"""Local HTTP integration tests: python test/kaggle-stream-proxy-test.py.

No external network, model or GPU is used. These verify the proxy boundary;
the deployed Cloudflare tunnel still needs a real >125-second prefill test.
"""

import http.client
import http.server
import json
from pathlib import Path
import select
import socket
import threading
import time
import unittest


def proxy_namespace():
    source = globals().get("PROXY_SOURCE")
    if source is None:
        source = (Path(__file__).resolve().parent.parent / "src" / "kaggle-stream-proxy.py").read_text(encoding="utf-8")
    namespace = {"__name__": "proxy_under_test"}
    exec(compile(source, "<proxy-under-test>", "exec"), namespace)
    # The Kaggle runtime is concatenated in the same namespace and defines http.
    namespace["http"] = lambda *args, **kwargs: None
    return namespace


class OriginHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, status, body, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("X-Origin-Fixture", "preserved")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
            self.wfile.flush()
        self.close_connection = True

    def wait_for_abort(self):
        deadline = time.monotonic() + getattr(self.server, "abort_wait_seconds", 4)
        while time.monotonic() < deadline:
            try:
                readable, _, _ = select.select([self.connection], [], [], 0.05)
                if readable and self.connection.recv(1, socket.MSG_PEEK) == b"":
                    self.server.aborted.set()
                    return
            except OSError:
                self.server.aborted.set()
                return

    def do_GET(self):
        self.server.requests.append((self.command, self.path, None))
        self.reply(409, b"\x00origin body\n", "application/octet-stream")

    do_HEAD = do_GET

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        payload = json.loads(body)
        self.server.requests.append((self.command, self.path, body))
        self.server.received.set()
        case = payload.get("case")
        if payload.get("stream") is False:
            self.reply(201, b'{ "message": {"content": "complete"}, "done": true }')
        elif case == "delayed_headers":
            self.server.release.wait(3)
            self.reply(200, b'{"done":true}\n', "application/x-ndjson")
        elif case == "cancel_headers":
            self.wait_for_abort()
            self.close_connection = True
        elif case in ("flush", "cancel_body", "split_record"):
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(b'{"message":{"content":"split' if case == "split_record" else self.server.first_chunk)
            self.wfile.flush()
            self.server.first_sent.set()
            if case == "cancel_body":
                self.wait_for_abort()
            else:
                self.server.release.wait(3)
                self.wfile.write(b' record"}}\n{"done":true}\n' if case == "split_record" else self.server.last_chunk)
                self.wfile.flush()
            self.close_connection = True
        elif case == "error":
            self.reply(404, b'{"error":"fixture model missing","detail":"preserved"}')
        elif case == "text_error":
            self.reply(503, b"fixture origin unavailable", "text/plain")
        elif case == "oversized_error":
            self.reply(400, b'{"error":"' + b"x" * 2048 + b'"}')
        elif case == "oversized_record":
            self.reply(200, b'{"response":"' + b"x" * 2048 + b'"}\n', "application/x-ndjson")
        elif case == "unterminated_record":
            self.reply(200, b'{"done":true}', "application/x-ndjson")
        elif case == "empty_stream":
            self.reply(200, b"", "application/x-ndjson")
        elif case == "partial_stream":
            self.reply(200, self.server.first_chunk + b" \n\t", "application/x-ndjson")
        else:
            self.reply(200, b'{"done":true}\n', "application/x-ndjson")


class OriginServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # A disconnected fixture deliberately makes origin writes fail.
        pass


class StreamProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = proxy_namespace()

    def setUp(self):
        self.origin = OriginServer(("127.0.0.1", 0), OriginHandler)
        self.origin.received = threading.Event()
        self.origin.release = threading.Event()
        self.origin.aborted = threading.Event()
        self.origin.first_sent = threading.Event()
        self.origin.requests = []
        self.origin.first_chunk = b'{"message":{"content":"first"}}\n'
        self.origin.last_chunk = b'{"message":{"content":"second"}}\n{"done":true}\n'
        self.origin_thread = threading.Thread(target=self.origin.serve_forever, daemon=True)
        self.origin_thread.start()
        self.proxy = self.runtime["start_stream_proxy"](
            upstream="http://127.0.0.1:%s" % self.origin.server_port,
            port=0, heartbeat_seconds=0.15, heartbeat_padding_bytes=16384,
            max_request_bytes=1024,
        )
        self.clients = []

    def tearDown(self):
        self.origin.release.set()
        for connection in self.clients:
            connection.close()
        self.proxy.shutdown()
        self.proxy.server_close()
        self.origin.shutdown()
        self.origin.server_close()
        self.proxy.thread.join(2)
        self.origin_thread.join(2)

    def client(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=1)
        self.clients.append(connection)
        return connection

    def post(self, payload, path="/api/chat"):
        connection = self.client()
        connection.request("POST", path, body=json.dumps(payload), headers={"Content-Type": "application/json"})
        return connection, connection.getresponse()

    def model_line(self, response):
        for _ in range(30):
            line = response.readline()
            if not line or line.strip():
                return line
        self.fail("No model line after 30 heartbeats")

    def test_delayed_origin_headers_still_flush_proxy_headers_and_heartbeats(self):
        started = time.monotonic()
        _, response = self.post({"case": "delayed_headers"})
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "application/x-ndjson")
        self.assertEqual(response.getheader("Transfer-Encoding"), "chunked")
        self.assertEqual(response.getheader("Cache-Control"), "no-cache, no-transform")
        self.assertEqual(response.getheader("X-Accel-Buffering"), "no")
        self.assertTrue(self.origin.received.wait(1))
        for _ in range(3):
            heartbeat = response.readline()
            self.assertEqual(len(heartbeat), 16384)
            self.assertFalse(heartbeat.strip())
        self.assertLess(time.monotonic() - started, 0.9)
        self.assertFalse(self.origin.release.is_set())
        self.origin.release.set()
        self.assertEqual(self.model_line(response), b'{"done":true}\n')
        self.assertEqual(response.read(), b"")

    def test_model_chunks_are_unchanged_and_first_chunk_flushes_before_origin_finishes(self):
        _, response = self.post({"case": "flush"}, "/api/generate")
        self.assertTrue(self.origin.first_sent.wait(1))
        self.assertEqual(self.model_line(response), self.origin.first_chunk)
        self.assertFalse(self.origin.release.is_set())
        self.origin.release.set()
        rest = response.read()
        self.assertEqual(b"".join(line for line in rest.splitlines(keepends=True) if line.strip()), self.origin.last_chunk)

    def test_heartbeats_do_not_corrupt_a_partially_received_json_record(self):
        _, response = self.post({"case": "split_record"})
        self.assertTrue(self.origin.first_sent.wait(1))
        for _ in range(3):
            self.assertFalse(response.readline().strip())
        self.assertFalse(self.origin.release.is_set())
        self.origin.release.set()
        self.assertEqual(self.model_line(response), b'{"message":{"content":"split record"}}\n')
        self.assertEqual(self.model_line(response), b'{"done":true}\n')
        self.assertEqual(response.read(), b"")

    def test_final_unterminated_record_gets_a_safe_ndjson_delimiter(self):
        _, response = self.post({"case": "unterminated_record"})
        self.assertEqual(self.model_line(response), b'{"done":true}\n')
        self.assertEqual(response.read(), b"")

    def test_empty_successful_origin_stream_reports_upstream_eof(self):
        _, response = self.post({"case": "empty_stream"})
        self.assertEqual(response.status, 200)
        error = json.loads(self.model_line(response))
        self.assertEqual(error["code"], "upstream_eof")
        self.assertIn("model stream ended before completion", error["error"])
        self.assertIn("retry", error["error"])
        self.assertEqual(response.read(), b"")

    def test_partial_origin_stream_preserves_records_then_reports_upstream_eof(self):
        _, response = self.post({"case": "partial_stream"})
        self.assertEqual(self.model_line(response), self.origin.first_chunk)
        error = json.loads(self.model_line(response))
        self.assertEqual(error["code"], "upstream_eof")
        self.assertIn("model stream ended before completion", error["error"])
        self.assertEqual(response.read(), b"")

    def test_stream_omitted_null_and_true_use_streaming_protocol(self):
        for value in ("omitted", None, True):
            with self.subTest(stream=value):
                payload = {} if value == "omitted" else {"stream": value}
                _, response = self.post(payload)
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("Transfer-Encoding"), "chunked")
                self.assertEqual(self.model_line(response), b'{"done":true}\n')
                self.assertEqual(response.read(), b"")

    def test_upstream_json_error_is_an_ndjson_error_with_original_fields(self):
        _, response = self.post({"case": "error"})
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(self.model_line(response)), {"error": "fixture model missing", "detail": "preserved"})
        self.assertEqual(response.read(), b"")

    def test_non_json_upstream_error_becomes_json_error(self):
        _, response = self.post({"case": "text_error"})
        message = json.loads(self.model_line(response))["error"]
        self.assertIn("HTTP 503", message)
        self.assertIn("fixture origin unavailable", message)
        self.assertEqual(response.read(), b"")

    def test_oversized_upstream_errors_and_records_are_bounded_json_errors(self):
        for case, expected in (("oversized_error", "oversized error response"), ("oversized_record", "oversized NDJSON record")):
            with self.subTest(case=case):
                _, response = self.post({"case": case})
                self.assertIn(expected, json.loads(self.model_line(response))["error"])
                self.assertEqual(response.read(), b"")

    def test_nonstream_post_preserves_status_headers_and_body(self):
        _, response = self.post({"stream": False})
        self.assertEqual(response.status, 201)
        self.assertEqual(response.getheader("X-Origin-Fixture"), "preserved")
        self.assertIsNone(response.getheader("Transfer-Encoding"))
        self.assertEqual(response.read(), b'{ "message": {"content": "complete"}, "done": true }')

    def test_get_and_head_preserve_status_and_body(self):
        for method in ("GET", "HEAD"):
            with self.subTest(method=method):
                connection = self.client()
                connection.request(method, "/api/tags?fixture=1")
                response = connection.getresponse()
                self.assertEqual(response.status, 409)
                self.assertEqual(response.getheader("Content-Type"), "application/octet-stream")
                self.assertEqual(response.getheader("X-Origin-Fixture"), "preserved")
                self.assertEqual(response.read(), b"" if method == "HEAD" else b"\x00origin body\n")

    def assert_disconnect_cancels(self, case, read_model=False, timeout=1.5):
        connection, response = self.post({"case": case})
        self.assertTrue(self.origin.received.wait(1))
        response.readline()  # Initial padding was already flushed.
        if read_model:
            self.assertEqual(self.model_line(response), self.origin.first_chunk)
        with self.proxy.active_lock:
            requests = tuple(self.proxy.active_requests)
        self.assertEqual(len(requests), 1)
        # HTTPConnection detaches a Connection: close response, so close its
        # response file as well. This is a real downstream TCP disconnect.
        started = time.monotonic()
        response.close()
        connection.close()
        self.assertTrue(self.origin.aborted.wait(timeout), "Origin did not see proxy shutdown after client Stop")
        elapsed = time.monotonic() - started
        self.assertTrue(requests[0].finished.wait(1), "Blocked upstream thread did not exit")
        return elapsed

    def test_disconnect_cancels_blocked_getresponse(self):
        self.assert_disconnect_cancels("cancel_headers")

    def test_disconnect_cancels_blocked_read_after_origin_connection_close_header(self):
        self.assert_disconnect_cancels("cancel_body", read_model=True)

    def test_default_ten_second_heartbeat_cancels_a_fully_closed_reader(self):
        self.proxy.heartbeat_seconds = 10
        self.origin.abort_wait_seconds = 23
        self.assertLess(self.assert_disconnect_cancels("cancel_headers", timeout=21), 21)

    def test_server_shutdown_cancels_inflight_origin(self):
        _, response = self.post({"case": "cancel_headers"})
        response.readline()
        self.assertTrue(self.origin.received.wait(1))
        self.proxy.shutdown()
        self.assertTrue(self.origin.aborted.wait(1))
        response.close()

    def test_unsafe_paths_invalid_json_oversized_bodies_and_chunked_requests_are_rejected(self):
        cases = [
            ("/private", b"{}", {}, 404),
            ("/api/../private", b"{}", {}, 404),
            ("/api/%2e%2e/private", b"{}", {}, 404),
            ("http://example.invalid/api/chat", b"{}", {}, 404),
            ("/api/chat", b"not json", {}, 400),
            ("/api/chat", b"[]", {}, 400),
            ("/api/chat", b'{"stream":"true"}', {}, 400),
            ("/api/chat", b" " * 1025, {}, 413),
            ("/api/chat", b"0\r\n\r\n", {"Transfer-Encoding": "gzip, chunked"}, 501),
        ]
        for path, body, headers, expected in cases:
            with self.subTest(path=path, status=expected):
                connection = self.client()
                connection.request("POST", path, body=body, headers=headers)
                response = connection.getresponse()
                self.assertEqual(response.status, expected)
                self.assertIn("error", json.loads(response.read()))
        self.assertEqual(self.origin.requests, [])

    def chunked_request(self, chunks, trailers=b"", extra_headers=b""):
        sock = socket.create_connection(("127.0.0.1", self.proxy.server_port), timeout=1)
        self.addCleanup(sock.close)
        wire = b"POST /api/chat HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n" + extra_headers + b"\r\n"
        for chunk in chunks:
            wire += ("%x;fixture=yes\r\n" % len(chunk)).encode("ascii") + chunk + b"\r\n"
        wire += b"0\r\n" + trailers + b"\r\n"
        sock.sendall(wire)
        response = http.client.HTTPResponse(sock)
        response.begin()
        self.addCleanup(response.close)
        return response

    def test_chunked_json_request_and_trailers_are_decoded_without_changing_body(self):
        body = b'{ "stream": true, "prompt": "fixture text" }'
        response = self.chunked_request([body[:7], body[7:18], body[18:]], b"X-Fixture: accepted\r\n")
        self.assertEqual(response.status, 200)
        self.assertEqual(self.model_line(response), b'{"done":true}\n')
        self.assertEqual(response.read(), b"")
        self.assertEqual(self.origin.requests[0][2], body)

    def test_request_write_half_close_keeps_response_stream_open(self):
        for chunked in (False, True):
            with self.subTest(chunked=chunked):
                self.origin.release.clear()
                body = b'{"case":"delayed_headers"}'
                sock = socket.create_connection(("127.0.0.1", self.proxy.server_port), timeout=2)
                self.addCleanup(sock.close)
                if chunked:
                    framing = b"Transfer-Encoding: chunked\r\n"
                    request_body = ("%x\r\n" % len(body)).encode("ascii") + body + b"\r\n0\r\n\r\n"
                else:
                    framing = ("Content-Length: %s\r\n" % len(body)).encode("ascii")
                    request_body = body
                sock.sendall(b"POST /api/chat HTTP/1.1\r\nHost: localhost\r\n" + framing + b"\r\n" + request_body)
                # A request writer may finish its TCP half while the reader
                # remains open for the response. FIN is not response cancellation.
                sock.shutdown(socket.SHUT_WR)
                release = threading.Timer(0.6, self.origin.release.set)
                release.start()
                self.addCleanup(release.cancel)
                response = http.client.HTTPResponse(sock)
                self.addCleanup(response.close)
                response.begin()
                self.assertEqual(response.status, 200)
                self.assertEqual(self.model_line(response), b'{"done":true}\n')
                self.assertEqual(response.read(), b"")
                release.join(1)

    def test_chunked_bodies_reject_oversize_and_ambiguous_framing(self):
        for chunks, extra_headers, expected in (([b"x" * 1025], b"", 413), ([b"{}"], b"Content-Length: 2\r\n", 400)):
            with self.subTest(status=expected):
                response = self.chunked_request(chunks, extra_headers=extra_headers)
                self.assertEqual(response.status, expected)
                self.assertIn("error", json.loads(response.read()))
        self.assertEqual(self.origin.requests, [])

    def test_upstream_connection_failure_is_stream_error(self):
        self.origin.shutdown()
        self.origin.server_close()
        _, response = self.post({})
        self.assertIn("Ollama connection failed", json.loads(self.model_line(response))["error"])
        self.assertEqual(response.read(), b"")

    def test_padding_is_configurable_and_listener_is_loopback_daemon(self):
        self.assertEqual(self.proxy.server_address[0], "127.0.0.1")
        self.assertTrue(self.proxy.thread.daemon)
        alternate = self.runtime["start_stream_proxy"](
            upstream="http://127.0.0.1:%s" % self.origin.server_port,
            port=0, heartbeat_padding_bytes=0,
        )
        try:
            self.assertEqual(alternate.heartbeat, b"\n")
        finally:
            alternate.shutdown()
            alternate.server_close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
