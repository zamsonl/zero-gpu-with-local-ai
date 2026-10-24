"""
The real gatekeeper in front of a mock Ollama, on this computer: for trying the web app and the
terminal client without a GPU.

    python tests/dev_server.py                  # http://127.0.0.1:8765, key "dev-key"
    python tests/dev_server.py --port 9000 --key abc --no-vision --no-thinking --delay 0.05

It prints a link that opens web/index.html already connected. Ctrl+C stops it.
"""

import argparse
import os
import pathlib
import sys
import time
import urllib.parse

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))
sys.path.insert(0, str(HERE))

import mock_ollama  # noqa: E402
import server  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--key", default="dev-key")
    parser.add_argument("--delay", type=float, default=0.03, help="seconds between streamed pieces")
    parser.add_argument("--context", type=int, default=32768)
    parser.add_argument("--idle", type=int, default=45, help="idle minutes reported in /info")
    parser.add_argument("--no-vision", action="store_true")
    parser.add_argument("--no-thinking", action="store_true")
    parser.add_argument("--think-levels-rejected", action="store_true", help="answer 400 to think: \"low\"/\"medium\"")
    parser.add_argument("--reply-file", help="stream this file's text (UTF-8) as the reply instead of the built-in one")
    parser.add_argument("--log-requests", help="append each chat/generate body the mock receives to this file, one JSON line each")
    args = parser.parse_args()

    mock_ollama.Mock.delay = args.delay
    mock_ollama.Mock.reject_think_levels = args.think_levels_rejected
    if args.reply_file:
        mock_ollama.Mock.reply = pathlib.Path(args.reply_file).read_text(encoding="utf-8")
    if args.log_requests:
        mock_ollama.Mock.log_path = args.log_requests
    if args.no_vision:
        mock_ollama.Mock.capabilities = [c for c in mock_ollama.Mock.capabilities if c != "vision"]
    if args.no_thinking:
        mock_ollama.Mock.capabilities = [c for c in mock_ollama.Mock.capabilities if c != "thinking"]
    _, server.OLLAMA = mock_ollama.start()
    server.PORT = args.port
    server.State.key = args.key
    server.State.last_request = time.time()
    server.State.info = {
        "app": "no-gpu-local-ai",
        "model": "local-model",
        "label": "Qwen 3.8 27B Uncensored (Q5_K_P)",
        "source": f"{server.AUTO_MODEL}:Q5_K_P",
        "num_ctx": args.context,
        "vision": "vision" in mock_ollama.Mock.capabilities,
        "thinking": "thinking" in mock_ollama.Mock.capabilities,
        "platform": "kaggle",
        "gpus": ["Tesla T4", "Tesla T4"],
        "idle_minutes": args.idle,
    }
    gate = server.serve_gatekeeper()
    url = f"http://127.0.0.1:{gate.server_address[1]}"
    page = (HERE.parent / "web" / "index.html").as_uri()
    print(f"Mock server: {url}  key: {args.key}", flush=True)
    print(f"Open: {page}#server={urllib.parse.quote(url, safe='')}&key={urllib.parse.quote(args.key, safe='')}", flush=True)
    try:
        while not server.State.stop.wait(0.5):
            pass
        print("Shut down from the chat.", flush=True)
    except KeyboardInterrupt:
        pass
    os._exit(0)


if __name__ == "__main__":
    main()
