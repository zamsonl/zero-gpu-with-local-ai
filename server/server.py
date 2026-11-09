# No GPU? Run a big open model on a free Kaggle or Colab GPU and chat with it from anywhere.
#
# This script runs inside the notebook. It installs Ollama and a Cloudflare tunnel, downloads the
# model (while the install runs), loads it with the largest context that fits entirely on the
# GPU(s), and puts a small gatekeeper in front of it: every request needs your key, and browsers
# may call it from any page (CORS), so the chat app can live anywhere, even on your desktop.
# When it's ready it prints one link that opens the chat app already connected.
#
# Settings come from the CONFIG dict the notebook defines before running this (see the notebook's
# first cell); anything missing falls back to the defaults below.

import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULTS = {
    # Any of: an Ollama library model ("qwen3:30b", "gemma3:27b"), a Hugging Face GGUF
    # ("hf.co/<user>/<repo>:<quant>"), or "auto" for the uncensored Qwen 3.8 27B in the size that
    # suits the GPU (Q5_K_P on Kaggle's two T4s, IQ3_M on Colab's one).
    "MODEL": "auto",
    # What the chat app calls the model. Empty: worked out from MODEL.
    "LABEL": "",
    # Tokens of conversation the model keeps in mind. "auto": the most that stays on the GPU(s).
    "CONTEXT": "auto",
    # Shut down after this many minutes without a request (saves Kaggle's weekly GPU hours).
    # 0 keeps it running until the session ends.
    "IDLE_MINUTES": 45,
    # The key every request must carry. Empty: the secret NO_GPU_KEY if you added one (so the key
    # stays the same between sessions), else a new random key each session.
    "KEY": "",
    # The chat app the ready link opens. Your own copy works too (any URL, or leave it).
    "APP_URL": "https://zamsonl.github.io/zero-gpu-with-local-ai/web/",
}
AUTO_MODEL = "hf.co/HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF"
AUTO_LABEL = "Qwen 3.8 27B Uncensored"
# Context sizes worth trying for the auto model, measured on the real GPUs: Q5_K_P holds 80K
# entirely on Kaggle's two T4s (96K and up spill to the CPU).
AUTO_CONTEXTS = {"Q5_K_P": [81920, 65536, 49152, 32768], "IQ3_M": [32768, 24576, 16384, 8192]}

OLLAMA = "http://127.0.0.1:11434"
PORT = 8765
LOCAL_NAME = "local-model"
LOG_DIR = "/tmp/no-gpu"
OLLAMA_LOG = f"{LOG_DIR}/ollama.log"
TUNNEL_LOG = f"{LOG_DIR}/cloudflared.log"
USER_AGENT = "no-gpu-local-ai/1"
STARTED = time.time()
MAX_RUNTIME_S = 11 * 3600 + 45 * 60  # Kaggle ends sessions at 12 h; sign off a little before
DOWNLOAD_WORKERS = 16
CHUNK_BYTES = 128 * 1024 * 1024
# Context sizes tried, largest first, until the model fits entirely on the GPU(s).
CONTEXTS_BIG = [131072, 98304, 81920, 65536, 49152, 32768, 24576, 16384, 8192]
CONTEXTS_SMALL = [32768, 24576, 16384, 8192, 4096]
# Paths the gatekeeper passes through to Ollama. Nothing that pulls, deletes or changes models.
ALLOWED = {"/api/chat", "/api/generate", "/api/tags", "/api/show", "/api/ps", "/api/version"}
# Besides those: GET /info (what's running and for how long) and POST /shutdown.
BUSY_GPU_PERCENT = 20

config = {**DEFAULTS, **(globals().get("CONFIG") or {})}
STARTED_PROCS = []  # stopped on the way out, so the link dies with the session


def log(message):
    print(time.strftime("%H:%M:%S"), message, flush=True)


def http(method, url, body=None, headers=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json", "user-agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    return json.loads(raw) if raw else None


def sh(command, log_file):
    with open(log_file, "a") as out:
        subprocess.run(command, shell=True, check=True, stdout=out, stderr=subprocess.STDOUT)


def tail(path, lines=3):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return " | ".join(f.read().strip().splitlines()[-lines:])
    except OSError:
        return ""


class Background:
    """Runs fn in a thread; result() waits for it and returns its value or raises its error."""

    def __init__(self, fn):
        self.value = None
        self.error = None
        self.thread = threading.Thread(target=self._run, args=(fn,), daemon=True)
        self.thread.start()

    def _run(self, fn):
        try:
            self.value = fn()
        except BaseException as err:
            self.error = err

    def result(self):
        self.thread.join()
        if self.error:
            raise self.error
        return self.value


# ---------------------------------------------------------------------------------- the machine


def platform():
    if os.environ.get("KAGGLE_KERNEL_RUN_TYPE"):
        return "kaggle"
    if os.environ.get("COLAB_RELEASE_TAG") or "google.colab" in sys.modules:
        return "colab"
    return "other"


def gpus():
    """[(name, MiB)] of the GPUs, from nvidia-smi."""
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=30).stdout
        return [(name.strip(), int(mem)) for name, mem in (line.rsplit(",", 1) for line in out.strip().splitlines() if "," in line)]
    except Exception:
        return []


def secret(name):
    """A notebook secret, from Kaggle's Add-ons → Secrets or Colab's key icon; None if absent."""
    try:
        from kaggle_secrets import UserSecretsClient

        return UserSecretsClient().get_secret(name) or None
    except Exception:
        pass
    try:
        from google.colab import userdata

        return userdata.get(name) or None
    except Exception:
        return None


# ---------------------------------------------------------------------------------- install


def install():
    os.makedirs(LOG_DIR, exist_ok=True)
    if not shutil.which("ollama"):
        log("Installing Ollama…")
        try:
            sh("(command -v zstd >/dev/null || (apt-get -qq update && apt-get -qq install -y zstd))", f"{LOG_DIR}/apt.log")
            sh("curl -fsSL https://ollama.com/install.sh | sh", f"{LOG_DIR}/ollama-install.log")
        except subprocess.CalledProcessError:
            raise RuntimeError("Installing Ollama failed: " + tail(f"{LOG_DIR}/ollama-install.log"))
    if not os.path.exists("/usr/local/bin/cloudflared"):
        log("Installing cloudflared…")
        sh(
            "curl -fsSL -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
            " && chmod +x /usr/local/bin/cloudflared",
            f"{LOG_DIR}/cloudflared-install.log",
        )


def models_dir():
    """Ollama's store on the disk with the most room (never /kaggle/working, which Kaggle saves)."""
    roots = [d for d in ("/kaggle/tmp", "/tmp", "/content") if os.path.isdir(d)]
    root = max(roots, key=lambda d: shutil.disk_usage(d).free)
    path = os.path.join(root, "ollama-models")
    os.makedirs(os.path.join(path, "blobs"), exist_ok=True)
    return path


def start_ollama(models):
    env = {
        **os.environ,
        "OLLAMA_HOST": "127.0.0.1:11434",
        "OLLAMA_MODELS": models,
        "OLLAMA_FLASH_ATTENTION": "1",
        "OLLAMA_KV_CACHE_TYPE": "q8_0",
        "OLLAMA_KEEP_ALIVE": "-1",
        "OLLAMA_NUM_PARALLEL": "1",
        "OLLAMA_MAX_LOADED_MODELS": "1",
        "OLLAMA_NOPRUNE": "1",  # files are written into the store while it runs
    }
    STARTED_PROCS.append(subprocess.Popen(["ollama", "serve"], env=env, stdout=open(OLLAMA_LOG, "a"), stderr=subprocess.STDOUT))
    for _ in range(60):
        try:
            http("GET", OLLAMA + "/api/version", timeout=5)
            return
        except Exception:
            time.sleep(1)
    raise RuntimeError("Ollama didn't start: " + tail(OLLAMA_LOG))


# ---------------------------------------------------------------------------------- the model


def resolve_model(machine_gpus):
    """The model to run and its label, with "auto" picking the uncensored Qwen's size for the GPU."""
    model = (config["MODEL"] or "auto").strip()
    label = config["LABEL"].strip()
    if model == "auto":
        total = sum(mem for _, mem in machine_gpus)
        quant = "Q5_K_P" if total >= 28_000 else "IQ3_M"
        return f"{AUTO_MODEL}:{quant}", label or f"{AUTO_LABEL} ({quant})"
    return model, label or model.split("/")[-1]


def parse_hf(model):
    """("user/repo", "TAG") for "hf.co/user/repo:TAG", else None."""
    match = re.fullmatch(r"(?:https?://)?(?:hf\.co|huggingface\.co)/([^/:]+/[^/:]+)(?::([\w.-]+))?", model)
    return (match.group(1), match.group(2) or "latest") if match else None


def hf_files(repo, tag):
    """The GGUF for `tag` and the repo's vision projector (if any): (name, sha256, size) each."""
    tree = http("GET", f"https://huggingface.co/api/models/{repo}/tree/main?recursive=1")
    files = [f for f in tree if f.get("type") == "file" and f.get("lfs") and f["path"].lower().endswith(".gguf")]
    weights = [f for f in files if "mmproj" not in f["path"].lower()]
    pick = [f for f in weights if re.search(rf"[-_.]{re.escape(tag)}\.gguf$", f["path"], re.I)]
    if not pick:
        raise RuntimeError(f"no {tag} GGUF in {repo}")
    # The plain f16 projector when there's a choice (older GPUs like the T4 have no bf16).
    projectors = sorted((f for f in files if "mmproj" in f["path"].lower()), key=lambda f: (not re.search(r"(?<!b)f16", f["path"].lower()), f["path"]))
    chosen = [pick[0]] + projectors[:1]
    return [(f["path"], f["lfs"]["oid"], f["lfs"]["size"]) for f in chosen]


def signed_url(repo, name):
    request = urllib.request.Request(f"https://huggingface.co/{repo}/resolve/main/{name}", headers={"range": "bytes=0-0", "user-agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.geturl()


def download(repo, files, blobs):
    """Each file into Ollama's store under its sha256 name, in parallel byte ranges (much faster)."""
    total = sum(size for _, _, size in files)
    finished = 0
    lock = threading.Lock()
    done = threading.Event()

    def reporter():
        while not done.wait(15):
            with lock:
                log(f"  downloaded {finished / 1e9:.1f} of {total / 1e9:.1f} GB")

    threading.Thread(target=reporter, daemon=True).start()
    try:
        for name, sha, size in files:
            dest = os.path.join(blobs, "sha256-" + sha)
            if os.path.exists(dest) and os.path.getsize(dest) == size:
                finished += size
                continue
            log(f"Downloading {name} ({size / 1e9:.1f} GB)…")
            partial = dest + "-partial"
            with open(partial, "wb") as f:
                f.truncate(size)
            url = [signed_url(repo, name)]
            ranges = [(start, min(start + CHUNK_BYTES, size) - 1) for start in range(0, size, CHUNK_BYTES)]
            errors = []

            def worker():
                nonlocal finished
                while True:
                    with lock:
                        if not ranges or errors:
                            return
                        start, end = ranges.pop()
                    for attempt in range(6):
                        try:
                            request = urllib.request.Request(url[0], headers={"range": f"bytes={start}-{end}", "user-agent": USER_AGENT})
                            with urllib.request.urlopen(request, timeout=120) as response, open(partial, "r+b") as f:
                                f.seek(start)
                                written = 0
                                while chunk := response.read(1 << 20):
                                    f.write(chunk)
                                    written += len(chunk)
                            if written != end - start + 1:
                                raise IOError(f"short read ({written} of {end - start + 1} bytes)")
                            with lock:
                                finished += written
                            break
                        except Exception as err:
                            if isinstance(err, urllib.error.HTTPError) and err.code in (401, 403):
                                url[0] = signed_url(repo, name)  # the signed link expired
                            time.sleep(2 * (attempt + 1))
                    else:
                        with lock:
                            errors.append(f"part of {name} wouldn't download")
                        return

            threads = [threading.Thread(target=worker) for _ in range(DOWNLOAD_WORKERS)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            if errors:
                raise RuntimeError(errors[0])
            os.replace(partial, dest)
    finally:
        done.set()


def hf_config(repo, tag):
    """
    The config `ollama pull` would store for the repo. Hugging Face only serves it for standard
    quantization names, so for others (like Q5_K_P) a sibling's config stands in: it's the same model.
    """
    for candidate in dict.fromkeys([tag, "Q4_K_M", "IQ3_M", "Q8_0", "latest"]):
        try:
            manifest = http("GET", f"https://huggingface.co/v2/{repo}/manifests/{candidate}", headers={"accept": "application/vnd.docker.distribution.manifest.v2+json"})
            cfg = http("GET", f"https://huggingface.co/v2/{repo}/blobs/{manifest['config']['digest']}")
            cfg["file_type"] = tag
            return cfg
        except Exception:
            continue
    log("  (no config from Hugging Face; using a plain one)")
    return {"model_format": "gguf", "file_type": tag, "architecture": "amd64", "os": "linux"}


def register_files(models, repo, files, tag):
    """
    Tells Ollama about the downloaded files the way `ollama pull` of the repo stores them (model and
    projector layers, Hugging Face's own config), so templates and capabilities come out the same.
    """
    cfg = hf_config(repo, tag)
    layers = [{"mediaType": "application/vnd.ollama.image.model", "digest": f"sha256:{files[0][1]}", "size": files[0][2]}]
    layers += [{"mediaType": "application/vnd.ollama.image.projector", "digest": f"sha256:{sha}", "size": size} for _, sha, size in files[1:]]
    cfg["rootfs"] = {"type": "layers", "diff_ids": [layer["digest"] for layer in layers]}
    raw = json.dumps(cfg, separators=(",", ":")).encode()
    cfg_sha = hashlib.sha256(raw).hexdigest()
    with open(os.path.join(models, "blobs", f"sha256-{cfg_sha}"), "wb") as f:
        f.write(raw)
    manifest = {
        "schemaVersion": 2,
        "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
        "config": {"mediaType": "application/vnd.docker.container.image.v1+json", "digest": f"sha256:{cfg_sha}", "size": len(raw)},
        "layers": layers,
    }
    path = os.path.join(models, "manifests", "registry.ollama.ai", "library", LOCAL_NAME)
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, "latest"), "w") as f:
        json.dump(manifest, f)
    http("POST", OLLAMA + "/api/show", {"model": LOCAL_NAME}, timeout=120)  # fails if Ollama can't read it


def pull(name):
    """`ollama pull`, with progress in the log."""
    log(f"Pulling {name} through Ollama…")
    request = urllib.request.Request(OLLAMA + "/api/pull", data=json.dumps({"model": name, "stream": True}).encode(), headers={"content-type": "application/json"})
    last = 0
    with urllib.request.urlopen(request, timeout=7200) as response:
        for line in response:
            event = json.loads(line or b"{}")
            if event.get("error"):
                raise RuntimeError(event["error"])
            if event.get("total") and time.time() - last > 15:
                last = time.time()
                log(f"  {event.get('completed', 0) / 1e9:.1f} of {event['total'] / 1e9:.1f} GB")
    return name


def fetch_direct(model, models):
    """For a Hugging Face GGUF: the parallel download, started before Ollama is even installed."""
    parsed = parse_hf(model)
    if not parsed or parsed[1] == "latest":
        return None
    repo, tag = parsed
    files = hf_files(repo, tag)
    needed = sum(size for _, _, size in files) + (1 << 30)
    free = shutil.disk_usage(models).free
    if free < needed:
        raise RuntimeError(f"only {free / 1e9:.0f} GB of disk free, {needed / 1e9:.0f} GB needed")
    download(repo, files, os.path.join(models, "blobs"))
    return repo, files, tag


def ready_model(model, models, fetched):
    """The Ollama name of the model, downloaded directly when possible, else through `ollama pull`."""
    try:
        direct = fetched.result()
        if direct:
            register_files(models, *direct)
            return LOCAL_NAME
    except Exception as err:
        log(f"Direct download didn't work ({err}); pulling through Ollama instead")
    return pull(model)


def describe(name):
    """(capabilities, trained context length or None) from Ollama's /api/show."""
    try:
        shown = http("POST", OLLAMA + "/api/show", {"model": name}, timeout=120)
    except Exception:
        return set(), None
    trained = next((v for k, v in (shown.get("model_info") or {}).items() if k.endswith(".context_length") and isinstance(v, int)), None)
    return set(shown.get("capabilities") or []), trained


def load(name, context):
    """Loads the model with `context`; True when all of it is on the GPU(s)."""
    http("POST", OLLAMA + "/api/generate", {"model": name, "prompt": "", "stream": False, "keep_alive": -1, "options": {"num_ctx": context}}, timeout=1800)
    loaded = http("GET", OLLAMA + "/api/ps").get("models", [])
    entry = next((m for m in loaded if m.get("name", "").split(":")[0] == name.split(":")[0] or m.get("model") == name), None)
    if not entry:
        return False
    log(f"  {context // 1024}K context: {entry.get('size_vram', 0) / 1e9:.1f} of {entry.get('size', 0) / 1e9:.1f} GB on the GPU")
    return entry.get("size_vram", 0) >= entry.get("size", 1)


def load_best(name, model, machine_gpus, trained):
    chosen = config["CONTEXT"]
    if str(chosen).isdigit():
        load(name, int(chosen))
        return int(chosen)
    known = next((sizes for quant, sizes in AUTO_CONTEXTS.items() if model == f"{AUTO_MODEL}:{quant}"), None)
    sizes = known or (CONTEXTS_BIG if sum(mem for _, mem in machine_gpus) >= 28_000 else CONTEXTS_SMALL)
    if trained:  # no point offering more than the model was trained on
        sizes = [s for s in sizes if s <= trained] or [trained]
    for context in sizes:
        try:
            if load(name, context):
                return context
        except Exception as err:
            log(f"  {context // 1024}K context didn't load: {err}")
    load(name, sizes[-1])  # nothing fits entirely: the smallest, partly on the CPU
    return sizes[-1]


# ---------------------------------------------------------------------------------- the gatekeeper


class State:
    key = ""
    info = {}
    last_request = time.time()
    in_flight = 0
    lock = threading.Lock()
    stop = threading.Event()  # set by POST /shutdown


class Gatekeeper(BaseHTTPRequestHandler):
    """Checks the key, answers CORS, and streams the allowed Ollama endpoints through."""

    protocol_version = "HTTP/1.1"
    server_version = "no-gpu-local-ai"
    # Seconds a connection may sit without sending its request (a reply streaming out is unaffected
    # unless the reader stops reading for this long).
    timeout = 120
    body_read = False

    def log_message(self, *args):  # quiet: the notebook log is for the user
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        if status >= 400 or self._unread_body():  # leftover body bytes would be read as the next request
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(raw)

    def _unread_body(self):
        """A request body this handler hasn't read, or can't (chunked uploads aren't supported)."""
        if self.body_read:
            return False
        return "Transfer-Encoding" in self.headers or self.headers.get("Content-Length", "0").strip() not in ("", "0")

    def _authorized(self):
        given = self.headers.get("Authorization", "")
        given = given[7:] if given.lower().startswith("bearer ") else given
        return hmac.compare_digest(given.encode(), State.key.encode())

    def do_OPTIONS(self):
        self.body_read = False
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        if self._unread_body():
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def _handle(self):
        self.body_read = False
        path = urllib.parse.urlsplit(self.path).path
        if path == "/" and self.command == "GET":
            return self._json(200, {"app": "no-gpu-local-ai", "hint": "Send your key as 'Authorization: Bearer <key>'."})
        if not self._authorized():
            return self._json(401, {"error": "Missing or wrong key."})
        if path == "/info":
            return self._json(200, {**State.info, **usage()})
        if path == "/shutdown" and self.command == "POST":
            State.stop.set()
            return self._json(200, {"ok": True, "detail": "Shutting down within a few seconds."})
        if path not in ALLOWED:
            return self._json(404, {"error": f"{path} isn't available here."})
        if not State.info:
            return self._json(503, {"error": "The model is still loading. Try again in a minute."})
        if "Transfer-Encoding" in self.headers:
            return self._json(411, {"error": "Send the body with a Content-Length."})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json(400, {"error": "Bad Content-Length."})
        body = self.rfile.read(length) if length > 0 else None
        self.body_read = True
        if body and path in ("/api/chat", "/api/generate"):
            body = self._pin(body)
        with State.lock:
            State.in_flight += 1
            State.last_request = time.time()
        upstream = None
        try:
            request = urllib.request.Request(OLLAMA + path, data=body, method=self.command, headers={"content-type": "application/json"})
            try:
                upstream = urllib.request.urlopen(request, timeout=3600)
                status = upstream.status
            except urllib.error.HTTPError as err:
                upstream, status = err, err.code
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", upstream.headers.get("Content-Type", "application/json"))
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            # Chunk by chunk, so a reply streams; a client that leaves closes Ollama's request too,
            # which stops the generation.
            while chunk := upstream.read1(65536) if hasattr(upstream, "read1") else upstream.read(65536):
                self.wfile.write(f"{len(chunk):X}\r\n".encode() + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            if upstream is not None:
                try:
                    upstream.close()
                except Exception:
                    pass
            with State.lock:
                State.in_flight -= 1
                State.last_request = time.time()

    def _pin(self, body):
        """Keeps every request on the loaded model and context, so Ollama never reloads it."""
        try:
            data = json.loads(body)
        except ValueError:
            return body
        data["model"] = State.info["model"]
        data["keep_alive"] = -1
        options = data.get("options") if isinstance(data.get("options"), dict) else {}
        options["num_ctx"] = State.info["num_ctx"]
        data["options"] = options
        return json.dumps(data).encode()


def usage():
    """Uptime and when the session ends by itself (idle shutdown or the 12-hour limit)."""
    now = time.time()
    ends = STARTED + MAX_RUNTIME_S
    idle = State.info.get("idle_minutes") or 0
    with State.lock:
        busy = State.in_flight > 0
    if idle and not busy:
        ends = min(ends, State.last_request + idle * 60)
    return {"uptime_s": int(now - STARTED), "ends_in_s": max(0, int(ends - now)), "busy": busy}


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        """A browser or the tunnel hanging up is normal; anything else is worth one line."""
        error = sys.exc_info()[1]
        if not isinstance(error, (ConnectionError, TimeoutError)):
            log(f"gatekeeper error: {type(error).__name__}: {error}")


def serve_gatekeeper():
    server = QuietServer(("127.0.0.1", PORT), Gatekeeper)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# ---------------------------------------------------------------------------------- the tunnel


def start_tunnel():
    for proc in [p for p in STARTED_PROCS if p.args[0] == "cloudflared"]:
        proc.kill()
        STARTED_PROCS.remove(proc)
    STARTED_PROCS.append(subprocess.Popen(["cloudflared", "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{PORT}"], stdout=open(TUNNEL_LOG, "w"), stderr=subprocess.STDOUT))
    for _ in range(60):
        time.sleep(2)
        found = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", tail(TUNNEL_LOG, 200))
        if found:
            url = found.group(0)
            for _ in range(45):  # the new hostname takes a few seconds to resolve everywhere
                if reachable(url):
                    return url
                time.sleep(2)
            return url
    raise RuntimeError("The Cloudflare tunnel didn't start: " + tail(TUNNEL_LOG))


def reachable(url):
    try:
        http("GET", url + "/info", headers={"authorization": f"Bearer {State.key}"}, timeout=15)
        return True
    except Exception:
        return False


def announce(url):
    """The ready message: one link that opens the chat app connected, and the details by hand."""
    app = (config["APP_URL"] or "").strip()
    link = f"{app}#server={urllib.parse.quote(url, safe='')}&key={urllib.parse.quote(State.key, safe='')}" if app else ""
    info = State.info
    line = "=" * 72
    print(f"\n{line}", flush=True)
    print(f" READY  ·  {info['label']}  ·  {info['num_ctx'] // 1024}K context  ·  pictures {'on' if info['vision'] else 'off'}", flush=True)
    if link:
        print(f"\n Open the chat (connects by itself):\n   {link}", flush=True)
    print(f"\n Server: {url}\n Key:    {State.key}", flush=True)
    print(f"\n Terminal:  node chat.mjs --server {url} --key {State.key}", flush=True)
    print(f"{line}\n", flush=True)
    try:  # in a notebook, also a clickable button
        from IPython.display import HTML, display

        if link:
            display(HTML(f'<a href="{link}" target="_blank" style="display:inline-block;padding:10px 16px;border-radius:18px;background:#111111;color:#fff;font:600 14px system-ui;text-decoration:none">Open the chat →</a>'))
    except Exception:
        pass


def gpu_busy():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=20).stdout
        return any(int(v) > BUSY_GPU_PERCENT for v in out.split() if v.strip().isdigit())
    except Exception:
        return False


def watch(url):
    """
    Keeps the tunnel up until someone presses Shut down, nobody has used it for the idle time, or
    the 12-hour limit nears.
    """
    idle_minutes = int(config["IDLE_MINUTES"] or 0)
    failures = 0
    while time.time() - STARTED < MAX_RUNTIME_S:
        if State.stop.wait(30):
            log("Shut down from the chat.")
            return
        with State.lock:
            busy = State.in_flight > 0
        if busy or gpu_busy():
            State.last_request = time.time()
        if idle_minutes and time.time() - State.last_request > idle_minutes * 60:
            log(f"Nobody used it for {idle_minutes} minutes: shutting down to save GPU time.")
            return
        if reachable(url):
            failures = 0
            continue
        failures += 1
        if failures >= 2:
            log("The tunnel dropped; opening a new one…")
            url = start_tunnel()
            announce(url)
            failures = 0
    log("Close to the 12-hour limit: shutting down.")


# ---------------------------------------------------------------------------------- main


def main():
    started = time.time()
    where = platform()
    machine_gpus = gpus()
    if not machine_gpus:
        raise RuntimeError("No GPU found. On Kaggle: Settings → Accelerator → GPU T4 x2. On Colab: Runtime → Change runtime type → T4 GPU.")
    State.key = (config["KEY"] or secret("NO_GPU_KEY") or secrets.token_urlsafe(18)).strip()
    model, label = resolve_model(machine_gpus)
    log(f"Starting on {where}: {', '.join(name for name, _ in machine_gpus)}; model {model}")
    models = models_dir()
    # The download needs nothing installed, so it runs while Ollama and the tunnel install.
    fetched = Background(lambda: fetch_direct(model, models))
    install()
    os.makedirs(LOG_DIR, exist_ok=True)
    start_ollama(models)
    name = ready_model(model, models, fetched)
    log(f"Model ready to load ({time.time() - started:.0f} s). Finding the largest context that fits…")
    serve_gatekeeper()
    tunnel = Background(start_tunnel)  # opens while the model loads
    caps, trained = describe(name)
    context = load_best(name, model, machine_gpus, trained)
    State.last_request = time.time()
    State.info = {
        "app": "no-gpu-local-ai",
        "model": name,
        "label": label,
        "source": model,
        "num_ctx": context,
        "vision": "vision" in caps,
        "thinking": "thinking" in caps,
        "platform": where,
        "gpus": [name_ for name_, _ in machine_gpus],
        "idle_minutes": int(config["IDLE_MINUTES"] or 0),
    }
    url = tunnel.result()
    log(f"Up in {time.time() - started:.0f} s.")
    announce(url)
    try:
        watch(url)
    except KeyboardInterrupt:  # stopped by hand: keep the runtime (and the download) for a rerun
        stop_processes()
        raise
    stop_processes()
    release(where)


def stop_processes():
    for proc in STARTED_PROCS:
        try:
            proc.kill()
        except Exception:
            pass
    log("Stopped. The link no longer works.")


def release(where):
    """Hands the GPU back: Colab's runtime is let go; a Kaggle background run simply ends here."""
    if where == "colab":
        try:
            from google.colab import runtime

            runtime.unassign()
        except Exception:
            pass
    elif where == "kaggle" and os.environ.get("KAGGLE_KERNEL_RUN_TYPE") == "Interactive":
        log("This is an interactive Kaggle session: stop it (Power button, top right) to save GPU hours.")


if __name__ == "__main__":
    main()
