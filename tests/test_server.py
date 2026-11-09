"""
Tests for server/server.py without a GPU: the gatekeeper against a mock Ollama, and the start-up
steps with timed stand-ins. Run from the repository root:  python -m unittest discover tests
"""

import contextlib
import io
import json
import os
import socket
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "server"))
sys.path.insert(0, HERE)

import mock_ollama  # noqa: E402
import server  # noqa: E402

KEY = "test-key-123"


def request(base, path, method="GET", body=None, key=KEY, headers=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method, headers={**({"authorization": f"Bearer {key}"} if key else {}), "content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return res.status, dict(res.headers), res.read()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), err.read()


class Gatekeeper(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mock, server.OLLAMA = mock_ollama.start()
        server.PORT = 0
        cls.gate = server.serve_gatekeeper()
        cls.base = f"http://127.0.0.1:{cls.gate.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.gate.shutdown()
        cls.mock.shutdown()

    def setUp(self):
        server.State.key = KEY
        server.State.info = {"app": "no-gpu-local-ai", "model": "local-model", "label": "Test model", "num_ctx": 32768, "vision": True, "thinking": True, "idle_minutes": 45}
        server.State.stop.clear()
        server.State.in_flight = 0
        server.State.last_request = time.time()
        mock_ollama.Mock.requests.clear()
        mock_ollama.Mock.delay = 0.002
        mock_ollama.Mock.disconnects = 0

    def test_every_request_needs_the_key(self):
        self.assertEqual(request(self.base, "/info", key=None)[0], 401)
        self.assertEqual(request(self.base, "/info", key="wrong")[0], 401)
        self.assertEqual(request(self.base, "/api/chat", "POST", {"messages": []}, key="wrong")[0], 401)
        status, _, raw = request(self.base, "/info")
        self.assertEqual(status, 200)
        info = json.loads(raw)
        self.assertEqual(info["model"], "local-model")
        self.assertEqual(info["num_ctx"], 32768)

    def test_the_front_door_says_how_to_knock(self):
        status, _, raw = request(self.base, "/", key=None)
        self.assertEqual(status, 200)
        self.assertIn("Bearer", json.loads(raw)["hint"])

    def test_browsers_may_call_it_from_any_page(self):
        status, headers, _ = request(self.base, "/api/chat", "OPTIONS", key=None, headers={"origin": "https://example.org", "access-control-request-headers": "authorization"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
        self.assertIn("authorization", headers["Access-Control-Allow-Headers"])
        _, headers, _ = request(self.base, "/info")
        self.assertEqual(headers["Access-Control-Allow-Origin"], "*")

    def test_nothing_that_changes_models_gets_through(self):
        for path in ("/api/pull", "/api/delete", "/api/create", "/api/copy", "/api/push", "/api/blobs/sha256:x"):
            self.assertEqual(request(self.base, path, "POST", {"model": "x"})[0], 404, path)

    def test_a_wrong_key_does_not_poison_the_next_request(self):
        # The 401 is sent before the body is read; the connection must not be reused with it unread.
        conn = socket.create_connection(("127.0.0.1", self.gate.server_address[1]))
        body = json.dumps({"messages": [{"role": "user", "content": "x" * 5000}]}).encode()
        conn.sendall(b"POST /api/chat HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer nope\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
        reply = conn.recv(4096).decode()
        self.assertIn("401", reply.splitlines()[0])
        self.assertIn("Connection: close", reply)
        conn.close()

    def test_unread_or_chunked_bodies_never_reach_the_next_request(self):
        # /info answers without reading a body: the connection must close, or the body's bytes would
        # be parsed as the next request on it.
        conn = socket.create_connection(("127.0.0.1", self.gate.server_address[1]))
        conn.sendall(b"GET /info HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + KEY.encode() + b"\r\nContent-Length: 5\r\n\r\nhello")
        reply = conn.recv(4096).decode()
        self.assertIn("200", reply.splitlines()[0])
        self.assertIn("Connection: close", reply)
        conn.close()
        conn = socket.create_connection(("127.0.0.1", self.gate.server_address[1]))
        conn.sendall(b"POST /api/chat HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + KEY.encode() + b"\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n")
        reply = conn.recv(4096).decode()
        self.assertIn("411", reply.splitlines()[0])
        self.assertIn("Connection: close", reply)
        conn.close()
        self.assertEqual(mock_ollama.Mock.requests, [], "nothing chunked reached Ollama")

    def test_chat_streams_and_stays_on_the_loaded_model(self):
        mock_ollama.Mock.delay = 0.01
        req = urllib.request.Request(self.base + "/api/chat", data=json.dumps({"model": "something-else", "messages": [{"role": "user", "content": "hi"}], "think": "medium", "options": {"num_ctx": 999, "temperature": 0.3}}).encode(), method="POST", headers={"authorization": f"Bearer {KEY}", "content-type": "application/json"})
        started = time.time()
        with urllib.request.urlopen(req, timeout=20) as res:
            first_line = res.readline()
            first_at = time.time() - started
            rest = res.read().decode().strip().splitlines()
        total = time.time() - started
        self.assertLess(first_at, total / 3, "the first piece should arrive long before the end")
        last = json.loads(rest[-1])
        self.assertTrue(last["done"])
        self.assertTrue(json.loads(first_line)["message"]["thinking"])
        sent = mock_ollama.Mock.requests[-1]
        self.assertEqual(sent["model"], "local-model")
        self.assertEqual(sent["options"]["num_ctx"], 32768)
        self.assertEqual(sent["options"]["temperature"], 0.3)
        self.assertEqual(sent["keep_alive"], -1)
        self.assertEqual(sent["think"], "medium")

    def test_leaving_mid_reply_stops_the_generation(self):
        mock_ollama.Mock.delay = 0.05
        conn = socket.create_connection(("127.0.0.1", self.gate.server_address[1]))
        body = json.dumps({"messages": [{"role": "user", "content": "hi"}], "stream": True}).encode()
        conn.sendall(b"POST /api/chat HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + KEY.encode() + b"\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
        self.assertIn(b"200", conn.recv(1024))
        time.sleep(0.2)
        conn.close()
        deadline = time.time() + 5
        while mock_ollama.Mock.disconnects == 0 and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(mock_ollama.Mock.disconnects, 1, "Ollama should see the client leave")
        deadline = time.time() + 3
        while server.State.in_flight and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(server.State.in_flight, 0)

    def test_requests_wait_while_the_model_loads(self):
        server.State.info = {}
        status, _, raw = request(self.base, "/api/chat", "POST", {"messages": []})
        self.assertEqual(status, 503)
        self.assertIn("loading", json.loads(raw)["error"])

    def test_shut_down_from_the_chat(self):
        self.assertEqual(request(self.base, "/shutdown", "POST", {})[0], 200)
        self.assertTrue(server.State.stop.is_set())

    def test_info_says_when_the_session_ends(self):
        info = json.loads(request(self.base, "/info")[2])
        self.assertAlmostEqual(info["ends_in_s"], 45 * 60, delta=5)
        self.assertFalse(info["busy"])
        server.State.info["idle_minutes"] = 0
        info = json.loads(request(self.base, "/info")[2])
        self.assertGreater(info["ends_in_s"], 11 * 3600)

    def test_checking_info_does_not_count_as_use(self):
        server.State.last_request = time.time() - 600
        request(self.base, "/info")
        self.assertLess(server.State.last_request, time.time() - 500)


class Choices(unittest.TestCase):
    def setUp(self):
        self.saved = dict(server.config)

    def tearDown(self):
        server.config.clear()
        server.config.update(self.saved)

    def test_auto_picks_the_build_for_the_gpus(self):
        server.config["MODEL"] = "auto"
        server.config["LABEL"] = ""
        model, label = server.resolve_model([("Tesla T4", 15360), ("Tesla T4", 15360)])
        self.assertTrue(model.endswith(":Q5_K_P"))
        self.assertIn("Q5_K_P", label)
        model, _ = server.resolve_model([("Tesla T4", 15360)])
        self.assertTrue(model.endswith(":IQ3_M"))

    def test_any_model_and_label(self):
        server.config["MODEL"] = "gemma3:27b"
        server.config["LABEL"] = ""
        self.assertEqual(server.resolve_model([("Tesla T4", 15360)]), ("gemma3:27b", "gemma3:27b"))
        server.config["LABEL"] = "My Gemma"
        self.assertEqual(server.resolve_model([("Tesla T4", 15360)])[1], "My Gemma")

    def test_reading_hugging_face_names(self):
        self.assertEqual(server.parse_hf("hf.co/user/repo:Q4_K_M"), ("user/repo", "Q4_K_M"))
        self.assertEqual(server.parse_hf("https://huggingface.co/user/repo:IQ3_M"), ("user/repo", "IQ3_M"))
        self.assertEqual(server.parse_hf("hf.co/user/repo"), ("user/repo", "latest"))
        self.assertIsNone(server.parse_hf("qwen3:32b"))

    def test_finding_the_quant_and_its_projector(self):
        tree = [
            {"type": "file", "path": "README.md"},
            {"type": "file", "path": "Model-Q4_K_M.gguf", "lfs": {"oid": "a" * 64, "size": 10}},
            {"type": "file", "path": "Model-Q5_K_P.gguf", "lfs": {"oid": "b" * 64, "size": 20}},
            {"type": "file", "path": "mmproj-Model-f16.gguf", "lfs": {"oid": "c" * 64, "size": 3}},
            {"type": "file", "path": "mmproj-Model-bf16.gguf", "lfs": {"oid": "d" * 64, "size": 3}},
        ]
        original = server.http
        server.http = lambda *a, **k: tree
        try:
            self.assertEqual(server.hf_files("u/r", "Q5_K_P"), [("Model-Q5_K_P.gguf", "b" * 64, 20), ("mmproj-Model-f16.gguf", "c" * 64, 3)])
            with self.assertRaises(RuntimeError):
                server.hf_files("u/r", "Q8_0")
        finally:
            server.http = original

    def test_context_search_for_the_auto_model_starts_where_it_fits(self):
        tried = []
        original = server.load
        server.load = lambda name, ctx: tried.append(ctx) or ctx <= 65536
        server.config["CONTEXT"] = "auto"
        try:
            model = f"{server.AUTO_MODEL}:Q5_K_P"
            self.assertEqual(server.load_best("local-model", model, [("T4", 15360)] * 2, 262144), 65536)
            self.assertEqual(tried, [81920, 65536])
            tried.clear()
            self.assertEqual(server.load_best("m", "qwen3:8b", [("T4", 15360)] * 2, 40960), 32768)
            self.assertEqual(tried, [32768], "never past what the model was trained on")
            tried.clear()
            server.config["CONTEXT"] = 12288
            self.assertEqual(server.load_best("m", "qwen3:8b", [("T4", 15360)], None), 12288)
        finally:
            server.load = original


class StartUp(unittest.TestCase):
    """main() with every outside step replaced by a timed stand-in."""

    def test_slow_steps_overlap(self):
        t0 = time.time()
        events = []
        lock = threading.Lock()

        def mark(name):
            with lock:
                events.append((time.time() - t0, name))

        def step(name, seconds, value=None):
            def run(*args, **kwargs):
                mark(name + " start")
                time.sleep(seconds)
                mark(name + " end")
                return value
            return run

        saved = {name: getattr(server, name) for name in ("gpus", "platform", "models_dir", "fetch_direct", "install", "start_ollama", "ready_model", "describe", "load_best", "serve_gatekeeper", "start_tunnel", "announce", "watch", "stop_processes", "release", "log")}
        announced = {}
        try:
            server.gpus = lambda: [("Tesla T4", 15360), ("Tesla T4", 15360)]
            server.platform = lambda: "kaggle"
            server.models_dir = lambda: "/tmp/x"
            server.fetch_direct = step("download", 1.0, ("repo", [], "Q5_K_P"))
            server.install = step("install", 0.5)
            server.start_ollama = step("ollama", 0.1)
            server.ready_model = lambda model, models, fetched: (fetched.result(), mark("model ready"), "local-model")[2]
            server.describe = lambda name: ({"completion", "vision", "thinking"}, 262144)
            server.load_best = step("load", 1.0, 81920)
            server.serve_gatekeeper = lambda: None
            server.start_tunnel = step("tunnel", 0.3, "https://x.trycloudflare.com")
            server.announce = lambda url: announced.update(url=url, info=dict(server.State.info))
            server.watch = lambda url: mark("watch")
            server.stop_processes = lambda: mark("stopped")
            server.release = lambda where: mark("released")
            server.log = lambda message: None
            server.config["KEY"] = "fixed"
            server.main()
        finally:
            for name, fn in saved.items():
                setattr(server, name, fn)
            server.config["KEY"] = ""
        starts = {n[:-6]: t for t, n in events if n.endswith(" start")}
        ends = {n[:-4]: t for t, n in events if n.endswith(" end")}
        self.assertLess(abs(starts["download"] - starts["install"]), 0.1, "the download runs during the install")
        self.assertLess(starts["tunnel"], ends["load"], "the tunnel opens while the model loads")
        self.assertEqual(announced["url"], "https://x.trycloudflare.com")
        self.assertEqual(announced["info"]["num_ctx"], 81920)
        self.assertTrue(announced["info"]["vision"] and announced["info"]["thinking"])
        self.assertEqual(server.State.key, "fixed")
        self.assertEqual([n for _, n in events][-3:], ["watch", "stopped", "released"])
        self.assertLess(time.time() - t0, 2.9, "about download + load, not the sum of every step")

    def test_the_ready_link_carries_server_and_key(self):
        server.State.key = "k/ey+1"
        server.State.info = {"label": "Test", "num_ctx": 32768, "vision": False}
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            server.announce("https://abc.trycloudflare.com")
        text = out.getvalue()
        self.assertIn("#server=https%3A%2F%2Fabc.trycloudflare.com&key=k%2Fey%2B1", text)
        self.assertIn("node chat.mjs --server https://abc.trycloudflare.com --key k/ey+1", text)


if __name__ == "__main__":
    unittest.main()
