"""
A stand-in for Ollama, for testing without a GPU: the endpoints the gatekeeper passes through, with
replies streamed a word at a time. It records each chat request so tests can see what arrived.
"""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPLY = """Here's a small script that does it.

```python
from pathlib import Path

def rename_by_date(folder):
    for path in sorted(Path(folder).iterdir()):
        stamp = path.stat().st_ctime
        print(path.name, stamp)  # check before renaming
```

| Step | What happens |
| --- | --- |
| 1 | List the files |
| 2 | Read each **creation time** |

- It never overwrites a file.
- Run it on a copy first.
"""


class Mock:
    requests = []  # bodies of /api/chat and /api/generate, newest last
    disconnects = 0  # streams the client left before the end
    delay = 0.01  # seconds between streamed pieces
    thinking = "The user wants a script. I'll keep it short and safe."
    reply = REPLY
    capabilities = ["completion", "thinking", "vision"]
    context_length = 262144
    reject_think_levels = False  # like a model that only takes think true/false
    log_path = None  # when set, each chat/generate body is also appended to this file as a JSON line


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _json(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/api/version":
            return self._json(200, {"version": "0.0.0-mock"})
        if self.path == "/api/tags":
            return self._json(200, {"models": [{"name": "local-model:latest"}]})
        if self.path == "/api/ps":
            return self._json(200, {"models": [{"name": "local-model:latest", "size": 100, "size_vram": 100}]})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path == "/api/show":
            return self._json(200, {"capabilities": Mock.capabilities, "model_info": {"qwen35.context_length": Mock.context_length}})
        if self.path not in ("/api/chat", "/api/generate"):
            return self._json(404, {"error": "not found"})
        Mock.requests.append(body)
        if Mock.log_path:
            with open(Mock.log_path, "a", encoding="utf-8") as log:
                log.write(json.dumps({"path": self.path, "body": body}) + "\n")
        think = body.get("think")
        if Mock.reject_think_levels and isinstance(think, str):
            return self._json(400, {"error": f"invalid think value: {think!r} (this model takes true or false)"})
        if body.get("stream") is False:
            return self._json(200, {"model": body.get("model"), "message": {"role": "assistant", "content": "ok"}, "done": True})
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        pieces = []
        if think:
            pieces += [{"message": {"role": "assistant", "content": "", "thinking": word}} for word in _words(Mock.thinking)]
        pieces += [{"message": {"role": "assistant", "content": word}} for word in _words(Mock.reply)]
        started = time.time()
        try:
            for piece in pieces:
                self._chunk(json.dumps({"model": body.get("model"), **piece, "done": False}) + "\n")
                time.sleep(Mock.delay)
            elapsed = time.time() - started
            self._chunk(json.dumps({"model": body.get("model"), "message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop",
                                    "eval_count": len(pieces), "eval_duration": int(max(elapsed, 0.001) * 1e9), "prompt_eval_count": 120 * len(body.get("messages", [])) + 40}) + "\n")
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            Mock.disconnects += 1

    def _chunk(self, text):
        data = text.encode()
        self.wfile.write(f"{len(data):X}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()


def _words(text):
    """Splits text into pieces the way a model streams it: words with their following space."""
    out, word = [], ""
    for ch in text:
        word += ch
        if ch in " \n":
            out.append(word)
            word = ""
    if word:
        out.append(word)
    return out


def start(port=0):
    """Starts the mock in a thread; returns (server, base_url)."""
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"
