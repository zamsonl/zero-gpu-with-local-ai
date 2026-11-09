# Heretic Qwen server for Kaggle (GPU T4 x2).
#
# The website's Start button pushes this script as a new version of a private Kaggle script and runs
# it in the background. It reuses a pinned private dataset for Ollama, the tunnel and model files,
# falling back to installation/downloads if needed. It loads the model with the largest context
# that stays fully on the two GPUs, checks whether
# it can see pictures, and registers the tunnel with the relay. Then it serves until the website asks
# it to stop, nobody has used it for the idle time set in Settings, another server replaces it, or
# Kaggle's 12-hour limit nears. Each step is reported to the website, which shows it while it starts.
#
# It can also make pictures with Qwen-Image 2.1 (ComfyUI, the official int8 files). The chat model and
# the image model can't share the GPUs, so the website switches the server between the two; while it
# chats, ComfyUI and the image files are prepared in the background so the first switch is quick.
# Picture jobs are pulled from the relay and the results pushed back: ComfyUI only listens locally.
#
# The relay calls carry a launch token the Worker made for this run (it only lets this script
# register, report progress, poll for commands and sign off, and expires after 13 hours), so the
# relay key itself never leaves Cloudflare.

import base64
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

RELAY = __RELAY__
LAUNCH_TOKEN = __LAUNCH_TOKEN__
QUANT = __QUANT__
CACHE_ID = __CACHE_ID__
BATCH_SIZE = __BATCH_SIZE__
PROFILE_ID = __PROFILE_ID__
FALLBACK_QUANT = "IQ3_M"
REPO = "HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF"
MODEL = "qwen3.8-hauhau"
OLLAMA = "http://127.0.0.1:11434"
STREAM_PROXY = "http://127.0.0.1:11435"
USER_AGENT = "heretic-qwen-kaggle/1"
OLLAMA_LOG = "/tmp/ollama.log"
OLLAMA_BIN = "ollama"
CLOUDFLARED_BIN = "cloudflared"
OPLOG = None

STARTED = time.time()
# Kaggle ends sessions at 12 hours; sign off cleanly a little before, so the page knows at once.
MAX_RUNTIME_S = 11 * 3600 + 45 * 60
# Tried largest first: the first that stays 100% on the GPUs wins (a bigger one spills to the CPU).
# The Worker starts the list at the size that fit last time, so later starts skip the trial loads.
CONTEXTS = __CONTEXTS__
# True once a run has seen this build answer about a picture: later runs skip the minute-long check.
KNOWN_VISION = __VISION__
AGENT_ONLY = False  # Personal coding sessions skip image setup and keep the exact model profile.
RUNTIME_HOST = "kaggle"
RELAY_HEADER = "x-launch-token"
STRICT_PROFILE = False  # Colab parity opts in: never lower precision/context or spill to CPU.
# GPU use above this (percent, either GPU) counts as the model working on a reply.
BUSY_GPU_PERCENT = 20
DOWNLOAD_WORKERS = 16
CHUNK_BYTES = 128 * 1024 * 1024
# Polling: often enough that a switch to pictures starts within seconds, and quickly in image mode.
CHAT_POLL_S = 10
IMAGE_POLL_S = 2
TUNNEL_CHECK_S = 30

IMAGE_REPO = "abenzerps/Qwen-Image-2.1-Uncensored-Quantized"
IMAGE_FILES = [
    ("diffusion_models", "qwen-image-2.1-UC-int8_convrot.safetensors"),
    ("text_encoders", "text_encoders/qwen3vl_8b_int8_convrot.safetensors"),
    ("vae", "vae/qwen_image_2.1_vae_bf16.safetensors"),
    ("loras", "qwen-image-2.1-uncensored-lora.safetensors"),
]
COMFY_PORT = 8188
COMFY_LOG = "/tmp/comfyui.log"
IMAGE_JOB_TIMEOUT_S = 30 * 60


def log(message):
    print(time.strftime("%H:%M:%S"), message, flush=True)
    if OPLOG is not None:
        OPLOG.log(str(message).replace(REPO, "the model repository").replace(REPO.split("/")[0], "the model author"))


def public(text):
    """Error text for the website: the model's repository owner is never shown there."""
    return str(text).replace(REPO, "the model repository").replace(REPO.split("/")[0], "the model author")[:180]


def http(method, url, body=None, headers=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"content-type": "application/json", "user-agent": USER_AGENT, **(headers or {})},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    return json.loads(raw) if raw else None


def relay(method, path, body=None):
    return http(method, RELAY + path, body, {RELAY_HEADER: LAUNCH_TOKEN}, timeout=30)


def upload(path, data, content_type):
    """Posts raw bytes to the relay (a finished picture)."""
    request = urllib.request.Request(
        RELAY + path, data=data, method="POST",
        headers={"content-type": content_type, "user-agent": USER_AGENT, RELAY_HEADER: LAUNCH_TOKEN},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        raw = response.read()
    return json.loads(raw) if raw else None


def report(stage, detail=None, percent=None):
    if OPLOG is not None:
        OPLOG.log(" · ".join(str(value) for value in (stage, detail, f"{percent}%" if percent is not None else None) if value is not None))
    try:
        relay("POST", "/_relay/progress", {"host": RUNTIME_HOST, "stage": stage, "detail": detail, "percent": percent})
    except Exception as err:  # the page just won't show this step
        log(f"progress report failed: {err}")


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
        except BaseException as err:  # handed to whoever waits for the result
            self.error = err

    def result(self):
        self.thread.join()
        if self.error:
            raise self.error
        return self.value


def sh(command):
    subprocess.run(command, shell=True, check=True)


def tail(path, lines=3):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return " | ".join(f.read().strip().splitlines()[-lines:])
    except OSError:
        return ""


# ---------------------------------------------------------------------------------------- set-up


def install(cache=None, runtime_root="/tmp/heretic-runtime"):
    global OLLAMA_BIN, CLOUDFLARED_BIN, PROFILE_ID, KNOWN_VISION
    if cache:
        try:
            report("installing", "Preparing the saved runtime")
            runtime = install_cached_runtime(cache, runtime_root)
            subprocess.run([runtime["ollama"], "--version"], check=True, capture_output=True, timeout=30)
            subprocess.run([runtime["cloudflared"], "--version"], check=True, capture_output=True, timeout=30)
            OLLAMA_BIN, CLOUDFLARED_BIN = runtime["ollama"], runtime["cloudflared"]
            log("Runtime cache hit: Ollama and cloudflared; no runtime downloads")
            return
        except Exception as err:
            log(f"Runtime cache unavailable ({public(err)}); installing normally")
    # A downloaded runtime is not the measured immutable profile. Re-probe its fit and vision.
    PROFILE_ID = ""
    KNOWN_VISION = None
    report("installing", "Installing Ollama and the tunnel")
    if not shutil.which("ollama"):
        log("Installing Ollama...")
        try:
            sh("(command -v zstd >/dev/null || (apt-get -qq update && apt-get -qq install -y zstd)) >/tmp/apt.log 2>&1")
            sh("curl -fsSL https://ollama.com/install.sh | sh >/tmp/ollama-install.log 2>&1")
        except subprocess.CalledProcessError:
            raise RuntimeError("Installing Ollama failed: " + tail("/tmp/ollama-install.log"))
    if not os.path.exists("/usr/local/bin/cloudflared"):
        log("Installing cloudflared...")
        sh(
            "curl -fsSL -o /usr/local/bin/cloudflared "
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
            " && chmod +x /usr/local/bin/cloudflared"
        )


def models_dir():
    """Ollama's store on the disk with the most room (never /kaggle/working, which Kaggle saves)."""
    roots = [d for d in ("/kaggle/tmp", "/tmp") if os.path.isdir(d)]
    root = max(roots, key=lambda d: shutil.disk_usage(d).free)
    path = os.path.join(root, "ollama-models")
    os.makedirs(os.path.join(path, "blobs"), exist_ok=True)
    return path, shutil.disk_usage(root).free


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
        # A cold read of the mounted 27B weights can pause longer than Ollama's default 5m.
        # Keep stall detection bounded without treating slow storage as a smaller GPU fit.
        "OLLAMA_LOAD_TIMEOUT": "2h" if AGENT_ONLY else "10m",
        # Files are written into the store while the server runs; don't let it tidy them away.
        "OLLAMA_NOPRUNE": "1",
    }
    subprocess.Popen([OLLAMA_BIN, "serve"], env=env, stdout=open(OLLAMA_LOG, "a"), stderr=subprocess.STDOUT)
    for _ in range(60):
        try:
            http("GET", OLLAMA + "/api/version", timeout=5)
            return
        except Exception:
            time.sleep(1)
    raise RuntimeError("Ollama didn't start: " + tail(OLLAMA_LOG))


# ------------------------------------------------------------------------------------ the model


def model_files(quant):
    """The quantization's GGUF and the vision projector: (name, sha256, size) from the repo listing."""
    tree = http("GET", f"https://huggingface.co/api/models/{REPO}/tree/main")
    files = [f for f in tree if f.get("type") == "file" and f.get("lfs")]
    model = next(f for f in files if f["path"].endswith(f"-{quant}.gguf"))
    projector = next(f for f in files if f["path"].startswith("mmproj-") and f["path"].endswith(".gguf"))
    return [(f["path"], f["lfs"]["oid"], f["lfs"]["size"]) for f in (model, projector)]


def signed_url(name, repo=REPO):
    """Where the file actually downloads from (the CDN URL behind Hugging Face's redirect)."""
    request = urllib.request.Request(
        f"https://huggingface.co/{repo}/resolve/main/{name}",
        headers={"range": "bytes=0-0", "user-agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.geturl()


def boot_progress(finished, total):
    report("downloading", f"{finished / 1e9:.1f} of {total / 1e9:.1f} GB", int(finished * 100 / total))


def download(files, dest_for, repo=REPO, on_progress=boot_progress, workers=DOWNLOAD_WORKERS):
    """
    Downloads each file to dest_for(name, sha) in parallel byte ranges (far faster than one
    stream), calling on_progress(finished, total) every 10 seconds.
    """
    total = sum(size for _, _, size in files)
    finished = 0
    lock = threading.Lock()
    done = threading.Event()

    def reporter():
        while not done.wait(10):
            with lock:
                now = finished
            on_progress(now, total)

    threading.Thread(target=reporter, daemon=True).start()
    try:
        for name, sha, size in files:
            dest = dest_for(name, sha)
            if os.path.exists(dest) and os.path.getsize(dest) == size:
                finished += size
                continue
            log(f"Downloading {name.replace(REPO.split('/')[0], '').strip('-')} ({size / 1e9:.1f} GB)...")
            partial = dest + "-partial"
            with open(partial, "wb") as f:
                f.truncate(size)
            url = [signed_url(name, repo)]
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
                            log(f"range {start}-{end} attempt {attempt + 1} failed: {err}")
                            if isinstance(err, urllib.error.HTTPError) and err.code in (401, 403):
                                url[0] = signed_url(name, repo)  # the signed link expired
                            time.sleep(2 * (attempt + 1))
                    else:
                        with lock:
                            errors.append(f"part of the model wouldn't download ({start}-{end})")
                        return

            threads = [threading.Thread(target=worker) for _ in range(workers)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            if errors:
                raise RuntimeError(errors[0])
            os.replace(partial, dest)
    finally:
        done.set()


def install_manifest(models, files, quant):
    """
    Registers the downloaded files with Ollama as MODEL, exactly the way `ollama pull` of the same
    repository stores them (model + vision projector layers, Hugging Face's config), so the model
    behaves the same as the Colab server's.
    """
    (_, model_sha, model_size), (_, projector_sha, projector_size) = files
    try:
        manifest = http(
            "GET",
            f"https://huggingface.co/v2/{REPO}/manifests/{FALLBACK_QUANT}",
            headers={"accept": "application/vnd.docker.distribution.manifest.v2+json"},
        )
        config = http("GET", f"https://huggingface.co/v2/{REPO}/blobs/{manifest['config']['digest']}")
    except Exception as err:
        log(f"using a built-in model config ({err})")
        config = {"model_format": "gguf", "model_family": "qwen35", "model_families": ["qwen35"], "architecture": "amd64", "os": "linux"}
    config["file_type"] = quant
    config["rootfs"] = {"type": "layers", "diff_ids": [f"sha256:{model_sha}", f"sha256:{projector_sha}"]}
    raw = json.dumps(config, separators=(",", ":")).encode()
    config_sha = hashlib.sha256(raw).hexdigest()
    with open(os.path.join(models, "blobs", f"sha256-{config_sha}"), "wb") as f:
        f.write(raw)
    manifest = {
        "schemaVersion": 2,
        "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
        "config": {"mediaType": "application/vnd.docker.container.image.v1+json", "digest": f"sha256:{config_sha}", "size": len(raw)},
        "layers": [
            {"mediaType": "application/vnd.ollama.image.model", "digest": f"sha256:{model_sha}", "size": model_size},
            {"mediaType": "application/vnd.ollama.image.projector", "digest": f"sha256:{projector_sha}", "size": projector_size},
        ],
    }
    path = os.path.join(models, "manifests", "registry.ollama.ai", "library", MODEL)
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, "latest"), "w") as f:
        json.dump(manifest, f)
    http("POST", OLLAMA + "/api/show", {"model": MODEL}, timeout=120)  # fails if Ollama can't read it


def pull_fallback():
    """The smaller build through `ollama pull`, the way the Colab server gets it."""
    source = f"hf.co/{REPO}:{FALLBACK_QUANT}"
    request = urllib.request.Request(
        OLLAMA + "/api/pull",
        data=json.dumps({"model": source, "stream": True}).encode(),
        headers={"content-type": "application/json"},
    )
    last = 0
    with urllib.request.urlopen(request, timeout=3600) as response:
        for line in response:
            event = json.loads(line or b"{}")
            if event.get("error"):
                raise RuntimeError(public(event["error"]))
            if event.get("total") and time.time() - last > 10:
                last = time.time()
                report("downloading", f"Smaller build: {event.get('completed', 0) / 1e9:.1f} of {event['total'] / 1e9:.1f} GB", int(event.get("completed", 0) * 100 / event["total"]))
    http("POST", OLLAMA + "/api/copy", {"source": source, "destination": MODEL})


def fetch_model(models, free_bytes):
    """Downloads the chosen build into Ollama's store (needs nothing installed, so it runs first)."""
    files = model_files(QUANT)
    needed = sum(size for _, _, size in files) + (1 << 30)
    if free_bytes < needed:
        raise RuntimeError(f"only {free_bytes / 1e9:.0f} GB of disk free, {needed / 1e9:.0f} GB needed")
    blobs = os.path.join(models, "blobs")
    download(files, lambda name, sha: os.path.join(blobs, "sha256-" + sha))
    return files


def get_model(models, fetched):
    """Registers the downloaded build with Ollama; the smaller one if anything about it failed."""
    try:
        install_manifest(models, fetched.result(), QUANT)
        return QUANT
    except Exception as err:
        if CACHE_ID or AGENT_ONLY or STRICT_PROFILE:
            raise RuntimeError(f"The configured {QUANT} model is unavailable ({public(err)}). Try starting again.") from err
        log(f"{QUANT} unavailable ({public(err)}); using {FALLBACK_QUANT}")
        report("downloading", f"Using the smaller build instead ({public(err)})", 0)
        pull_fallback()
        return FALLBACK_QUANT


def load(context):
    """Loads the model at `context`; True when all of it is on the GPUs."""
    mark = os.path.getsize(OLLAMA_LOG) if os.path.exists(OLLAMA_LOG) else 0
    # Match website chat/compaction: changing context-shift later reloads Ollama's runner.
    try:
        http("POST", OLLAMA + "/api/generate", {"model": MODEL, "prompt": "", "stream": False, "keep_alive": -1, "shift": False, "options": {"num_ctx": context, "num_batch": BATCH_SIZE}}, timeout=7200 if AGENT_ONLY else 1800)
    except urllib.error.HTTPError as err:
        # Only this local, empty-prompt load's bounded JSON error is useful here.
        # Do not dump an arbitrary response body, request, environment or tunnel URL.
        detail = ""
        try:
            payload = json.loads(err.read(4096).decode("utf-8", "replace"))
            if isinstance(payload, dict) and isinstance(payload.get("error"), str):
                detail = payload["error"].replace(LAUNCH_TOKEN, "[redacted]")
                detail = re.sub(r"https?://\S+", "[URL hidden]", detail)
                detail = public(re.sub(r"[\r\n\t]+", " ", detail))
        except (ValueError, OSError):
            pass
        finally:
            err.close()
        suffix = f": {detail}" if detail else ""
        raise RuntimeError(f"Ollama model load failed (HTTP {err.code}){suffix}") from None
    loaded = http("GET", OLLAMA + "/api/ps").get("models", [])
    model = next((m for m in loaded if m.get("name", "").split(":")[0] == MODEL), None)
    if not model:
        return False
    # How Ollama split the model's layers, from its own log (for the record: what spilled over).
    try:
        with open(OLLAMA_LOG, "rb") as f:
            f.seek(mark)
            layers = re.findall(r"offloaded (\d+)/(\d+) layers to GPU", f.read().decode("utf-8", "replace"))
    except OSError:
        layers = []
    split = f", {layers[-1][0]}/{layers[-1][1]} layers on the GPUs" if layers else ""
    log(f"{context} context: {model.get('size_vram', 0) / 1e9:.1f} of {model.get('size', 0) / 1e9:.1f} GB on the GPUs{split}")
    return model.get("size_vram", 0) >= model.get("size", 1)


def load_best():
    global PROFILE_ID
    for context in CONTEXTS:
        report("loading", f"Trying {context // 1024}K tokens of memory")
        try:
            if load(context):
                return context
        except Exception as err:
            # A timeout or runner failure is not a measurement of the maximum GPU fit.
            # The actual lower context still registers, but must not teach this profile's cap.
            PROFILE_ID = ""
            log(f"{context} context failed to load: {err}")
    if AGENT_ONLY or STRICT_PROFILE:
        raise RuntimeError("The selected Q5_K_P / 98,304-token profile did not fit entirely on the available GPUs. No smaller model or context was substituted.")
    # Nothing fits entirely: the smallest still works, partly on the CPU.
    load(CONTEXTS[-1])
    return CONTEXTS[-1]


def red_square_png(size=32):
    row = b"\x00" + b"\xff\x00\x00" * size
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(row * size))
        + chunk(b"IEND", b"")
    )


def sees_pictures(context):
    report("loading", "Checking whether the model can see pictures")
    try:
        reply = http(
            "POST",
            OLLAMA + "/api/chat",
            {
                "model": MODEL,
                "stream": False,
                "think": False,
                "keep_alive": -1,
                "shift": False,
                "messages": [{"role": "user", "content": "What colour fills this picture? Answer with one word.", "images": [base64.b64encode(red_square_png()).decode()]}],
                "options": {"num_ctx": context, "num_batch": BATCH_SIZE, "num_predict": 16, "temperature": 0},
            },
            timeout=600,
        )
        answer = reply.get("message", {}).get("content", "")
        log(f"picture check answered: {answer!r}")
        return "red" in answer.lower()
    except Exception as err:
        log(f"picture check failed: {err}")
        return False


# ------------------------------------------------------------------------------- pictures


class Pictures:
    """
    ComfyUI with Qwen-Image 2.1. prepare() installs it and fetches the files in the background while
    the server chats; start() and stop() hand it the GPUs and take them back; make() runs one job.
    """

    def __init__(self, models_root, cache=None):
        self.dir = os.path.join(models_root, "ComfyUI")
        self.cache = cache
        self.status = "waiting"  # what prepare() is doing, for the page
        self.percent = 0
        self.ready = threading.Event()
        self.error = None
        self.process = None
        self.prep = None

    def prepare(self):
        """Starts the background preparation once; safe to call again."""
        if not self.prep:
            self.prep = Background(self._prepare)

    def _prepare(self):
        try:
            free = shutil.disk_usage(os.path.dirname(self.dir)).free
            cached_images = None
            if self.cache:
                try:
                    cached_images = validate_image_cache(self.cache, repo=IMAGE_REPO)
                    if {(f["folder"], f["source_path"]) for f in cached_images["files"]} != set(IMAGE_FILES):
                        raise CacheError("cached picture files do not match this server")
                    stage_cached_images(self.cache, os.path.join(self.dir, "models"), repo=IMAGE_REPO)
                    log("Picture model cache hit: all four files; no image-model downloads")
                except Exception as err:
                    cached_images = None
                    log(f"Picture cache unavailable ({public(err)}); downloading normally")
            files = [] if cached_images else image_files()
            needed = sum(size for _, _, size, _ in files) + (3 << 30)
            if free < needed:
                raise RuntimeError(f"only {free / 1e9:.0f} GB of disk free for pictures, {needed / 1e9:.0f} GB needed")
            self.status = "Installing the picture tools"
            if not os.path.isdir(os.path.join(self.dir, "comfy")):
                # Cache links may already occupy models/, so clone into a sibling then merge.
                source = self.dir + "-source"
                sh(f"git clone -q --depth 1 https://github.com/comfyanonymous/ComfyUI {source} >/tmp/comfy-install.log 2>&1")
                shutil.copytree(source, self.dir, dirs_exist_ok=True)
                shutil.rmtree(source)
            # Kaggle's own torch stays: ComfyUI's pins would download gigabytes for nothing.
            with open(os.path.join(self.dir, "requirements.txt")) as f:
                wanted = [line.strip() for line in f if line.strip() and not line.startswith("#") and not re.match(r"torch(vision|audio)?\b", line.strip())]
            with open("/tmp/comfy-requirements.txt", "w") as f:
                f.write("\n".join(wanted) + "\n")
            sh("pip install -q -r /tmp/comfy-requirements.txt >>/tmp/comfy-install.log 2>&1")

            def progress(finished, total):
                self.status = f"Downloading the picture model: {finished / 1e9:.1f} of {total / 1e9:.1f} GB"
                self.percent = int(finished * 100 / total)

            dest = {name: os.path.join(self.dir, "models", folder, os.path.basename(name)) for folder, name, _, _ in files}
            for path in dest.values():
                os.makedirs(os.path.dirname(path), exist_ok=True)
            if files:
                download([(name, sha, size) for _, name, size, sha in files], lambda name, sha: dest[name], IMAGE_REPO, progress, workers=8)
            self.status = "Ready"
            self.percent = 100
        except Exception as err:
            self.error = f"{type(err).__name__}: {err}" if not isinstance(err, RuntimeError) else str(err)
            log(f"preparing pictures failed: {self.error} | {tail('/tmp/comfy-install.log')}")
        finally:
            self.ready.set()

    def start(self):
        """Starts ComfyUI (the chat model must be unloaded first) and waits until it answers."""
        if self.process and self.process.poll() is None:
            return
        out = os.path.join(os.path.dirname(self.dir), "comfy-output")
        os.makedirs(out, exist_ok=True)
        self.process = subprocess.Popen(
            [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", str(COMFY_PORT), "--disable-auto-launch", "--output-directory", out],
            cwd=self.dir, stdout=open(COMFY_LOG, "a"), stderr=subprocess.STDOUT,
        )
        for _ in range(240):
            if self.process.poll() is not None:
                raise RuntimeError("ComfyUI stopped while starting: " + tail(COMFY_LOG, 4))
            try:
                http("GET", f"http://127.0.0.1:{COMFY_PORT}/system_stats", timeout=5)
                return
            except Exception:
                time.sleep(1)
        raise RuntimeError("ComfyUI didn't start: " + tail(COMFY_LOG, 4))

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.process = None

    def make(self, job, keep_going):
        """
        Runs one job and uploads the result. keep_going(step) reports a step and answers False when
        the page deleted the picture, which stops ComfyUI.
        """
        comfy = f"http://127.0.0.1:{COMFY_PORT}"
        mark = os.path.getsize(COMFY_LOG) if os.path.exists(COMFY_LOG) else 0
        try:
            queued = http("POST", comfy + "/prompt", {"prompt": workflow(job), "client_id": "heretic-qwen"}, timeout=60)
        except urllib.error.HTTPError as err:
            raise RuntimeError("ComfyUI refused the job: " + err.read().decode("utf-8", "replace")[:300])
        prompt_id = queued["prompt_id"]
        started = time.time()
        step = -1
        while time.time() - started < IMAGE_JOB_TIMEOUT_S:
            time.sleep(1.5)
            history = http("GET", f"{comfy}/history/{prompt_id}", timeout=30).get(prompt_id)
            if history:
                status = history.get("status") or {}
                if status.get("status_str") == "error":
                    messages = [m[1].get("exception_message", "") for m in status.get("messages", []) if m and m[0] == "execution_error"]
                    raise RuntimeError("ComfyUI failed: " + (messages[0] if messages else "unknown error")[:300])
                images = [img for out in history.get("outputs", {}).values() for img in out.get("images", [])]
                if images:
                    return self._deliver(comfy, job, images[0])
            now = sampling_step(mark)
            if now != step:
                step = now
                if not keep_going(max(step, 0)):
                    http("POST", comfy + "/interrupt", {}, timeout=10)
                    http("POST", comfy + "/queue", {"delete": [prompt_id]}, timeout=10)
                    log(f"picture {job['id']} was deleted on the page; stopped it")
                    return
        http("POST", comfy + "/interrupt", {}, timeout=10)
        raise RuntimeError("The picture took more than 30 minutes")

    def _deliver(self, comfy, job, image):
        query = urllib.parse.urlencode({"filename": image["filename"], "subfolder": image.get("subfolder", ""), "type": image.get("type", "output")})
        with urllib.request.urlopen(f"{comfy}/view?{query}", timeout=120) as response:
            png = response.read()
        from io import BytesIO
        from PIL import Image

        picture = Image.open(BytesIO(png))
        low, high = zip(*picture.convert("RGB").getextrema())
        if max(h - l for l, h in zip(low, high)) < 4:
            raise RuntimeError("The picture came out blank (one flat colour)")
        preview = picture.convert("RGB")
        preview.thumbnail((640, 640))
        buffer = BytesIO()
        preview.save(buffer, "WEBP", quality=82)
        upload(f"/_relay/image-result?id={job['id']}&kind=thumb", buffer.getvalue(), "image/webp")
        upload(f"/_relay/image-result?id={job['id']}&kind=full", png, "image/png")
        try:
            os.remove(os.path.join(os.path.dirname(self.dir), "comfy-output", image.get("subfolder", ""), image["filename"]))
        except OSError:
            pass


def image_files():
    """(folder, name, size, sha256) for each picture file, from the repo listing."""
    tree = http("GET", f"https://huggingface.co/api/models/{IMAGE_REPO}/tree/main?recursive=1")
    by_path = {f["path"]: f for f in tree if f.get("type") == "file" and f.get("lfs")}
    return [(folder, name, by_path[name]["lfs"]["size"], by_path[name]["lfs"]["oid"]) for folder, name in IMAGE_FILES]


def workflow(job):
    """The ComfyUI API graph for one text-to-image job (Turbo LoRA for "fast")."""
    graph = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": os.path.basename(IMAGE_FILES[0][1]), "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": os.path.basename(IMAGE_FILES[1][1]), "type": "qwen_image", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": os.path.basename(IMAGE_FILES[2][1])}},
        "4": {"class_type": "TextEncodeQwenImage21", "inputs": {"clip": ["2", 0], "prompt": job["prompt"], "negative_prompt": job.get("negative") or "", "resolution": 1024}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": job["width"], "height": job["height"], "batch_size": 1}},
        "6": {"class_type": "KSampler", "inputs": {
            "model": ["9", 0] if job["speed"] == "fast" else ["1", 0],
            "positive": ["4", 0], "negative": ["4", 1], "latent_image": ["5", 0],
            "seed": job["seed"], "steps": job["steps"], "cfg": job["cfg"],
            "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0,
        }},
        "7": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["3", 0]}},
        "8": {"class_type": "SaveImage", "inputs": {"images": ["7", 0], "filename_prefix": job["id"]}},
    }
    if job["speed"] == "fast":
        graph["9"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": os.path.basename(IMAGE_FILES[3][1]), "strength_model": 1.0}}
    return graph


def sampling_step(mark):
    """The latest sampling step ComfyUI's progress bar printed since `mark` (a log offset), or -1."""
    try:
        with open(COMFY_LOG, "rb") as f:
            f.seek(mark)
            found = re.findall(r"(\d+)/(\d+) \[", f.read().decode("utf-8", "replace"))
    except OSError:
        return -1
    return int(found[-1][0]) if found else -1


def report_mode(target, mode, state, detail=None, percent=None):
    try:
        relay("POST", "/_relay/mode", {"target": target, "mode": mode, "state": state, "detail": detail, "percent": percent})
    except Exception as err:
        log(f"mode report failed: {err}")


def unload_chat_model():
    http("POST", OLLAMA + "/api/generate", {"model": MODEL, "keep_alive": 0}, timeout=120)
    for _ in range(60):
        if not http("GET", OLLAMA + "/api/ps").get("models"):
            return
        time.sleep(1)


def switch_to_pictures(pictures, url, context):
    """Hands the GPUs to ComfyUI; on failure gives them back to the chat model. True when it worked."""
    try:
        report_mode(url, "images", "switching", "Unloading the chat model", 5)
        pictures.prepare()
        while not pictures.ready.wait(5):
            report_mode(url, "images", "switching", pictures.status, max(10, min(85, pictures.percent)))
        if pictures.error:
            raise RuntimeError(pictures.error)
        unload_chat_model()
        report_mode(url, "images", "switching", "Starting the picture model", 90)
        pictures.start()
        report_mode(url, "images", "ready", "Ready for pictures", 100)
        log("pictures have the GPUs")
        return True
    except Exception as err:
        message = public(f"{type(err).__name__}: {err}" if not isinstance(err, RuntimeError) else err)
        log(f"switching to pictures failed: {message}")
        pictures.stop()
        report_mode(url, "images", "failed", message)
        load(context)
        return False


def switch_to_chat(pictures, url, context):
    report_mode(url, "chat", "switching", "Freeing the GPUs", 20)
    pictures.stop()
    report_mode(url, "chat", "switching", "Loading the chat model", 50)
    load(context)
    report_mode(url, "chat", "ready", "Ready to chat", 100)
    log("the chat model has the GPUs again")


def run_job(job):
    """Makes one picture, reporting each step; failures are reported to the page."""
    def keep_going(step):
        try:
            return not relay("POST", "/_relay/image-progress", {"id": job["id"], "step": step}).get("cancel")
        except Exception:
            return True

    log(f"picture {job['id']}: {job['width']}x{job['height']}, {job['steps']} steps")
    started = time.time()
    try:
        PICTURES.make(job, keep_going)
        log(f"picture {job['id']} done in {time.time() - started:.0f} s")
    except Exception as err:
        message = public(err)
        log(f"picture {job['id']} failed: {message} | {tail(COMFY_LOG, 3)}")
        try:
            upload(f"/_relay/image-result?id={job['id']}&kind=error", json.dumps({"error": message}).encode(), "application/json")
        except Exception:
            pass


# ----------------------------------------------------------------------------------- serving


def start_tunnel():
    subprocess.run(["pkill", "-x", "cloudflared"], check=False)
    time.sleep(1)
    subprocess.Popen(
        [CLOUDFLARED_BIN, "tunnel", "--no-autoupdate", "--url", STREAM_PROXY, "--http-host-header", "localhost:11435"],
        stdout=open("/tmp/cloudflared.log", "w"),
        stderr=subprocess.STDOUT,
    )
    url = None
    for _ in range(60):
        time.sleep(2)
        found = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", tail("/tmp/cloudflared.log", 200))
        if found:
            url = found.group(0)
            break
    if not url:
        raise RuntimeError("The Cloudflare tunnel didn't start: " + tail("/tmp/cloudflared.log"))
    for _ in range(45):  # the new hostname takes a few seconds to resolve everywhere
        if reachable(url):
            return url
        time.sleep(2)
    return url


def reachable(url):
    try:
        http("GET", url + "/api/version", timeout=15)
        return True
    except Exception:
        return False


def gpu_busy():
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=20,
        ).stdout
        return any(int(v) > BUSY_GPU_PERCENT for v in out.split() if v.strip().isdigit())
    except Exception:
        return False


def requests_served():
    """How many chat and generate requests Ollama has finished (its access log lines)."""
    try:
        with open(OLLAMA_LOG, encoding="utf-8", errors="replace") as f:
            return len(re.findall(r'POST\s+"/api/(?:chat|generate)"', f.read()))
    except OSError:
        return 0


def serve(context, vision, quant, url):
    mode = "chat"

    def register(url):
        relay("POST", "/_relay/register", {"target": url, "host": RUNTIME_HOST, "num_ctx": context, "num_batch": BATCH_SIZE, **({"profile_id": PROFILE_ID} if PROFILE_ID else {}), **({"job_max_leg_seconds": 300, "job_control": True} if AGENT_ONLY else {}), "inference_transport": "jobs-v1", "vision": vision, "quant": quant, "control": True, "mode": mode})
        log(f"READY at {url}: {context // 1024}K context, pictures {'on' if vision else 'off'}, {quant}")

    report("connecting", "Connecting to this page")
    register(url)

    if not AGENT_ONLY:
        PICTURES.prepare()  # in the background, so the first switch to pictures is quick
    served = requests_served()
    last_used = time.time()
    last_tunnel_check = time.time()
    tunnel_failures = 0
    reason = "the 12-hour limit is near"
    while time.time() - STARTED < MAX_RUNTIME_S:
        time.sleep(IMAGE_POLL_S if mode == "images" else CHAT_POLL_S)
        now_served = requests_served()
        if now_served != served or gpu_busy():
            served = now_served
            last_used = time.time()

        # Personal sessions retain a local quota backstop even if the relay is unreachable
        # or its temporary credentials expire. Owner notebook idle behavior stays unchanged.
        if AGENT_ONLY and time.time() - last_used >= 120 * 60:
            reason = "personal coding session had no local client or model activity for 2 hours"
            break

        try:
            idle_s = int(time.time() - last_used)
            jobs = globals().get("PERSONAL_JOBS") if AGENT_ONLY else None
            active = "".join("&active_generation=" + owner for owner in jobs.active_generations()) if jobs else ""
            command = relay("GET", f"/_relay/command?target={urllib.parse.quote(url, safe='')}&idle={idle_s}{active}")
            if jobs and isinstance(command, dict):
                jobs.cancel_generations(command.get("stop_generations", []))
        except Exception as err:
            log(f"couldn't reach the relay: {err}")
            command = None
        if command:
            if command.get("shutdown"):
                reason = "another server took over" if command.get("reason") == "replaced" else "the website asked it to stop"
                break
            if AGENT_ONLY and command.get("client_active") is True:
                client_idle = command.get("client_idle_seconds")
                if isinstance(client_idle, (int, float)) and not isinstance(client_idle, bool) and 0 <= client_idle <= 120:
                    last_used = max(last_used, time.time() - client_idle)
            if not command.get("registered"):
                register(url)
            wanted = command.get("mode") or "chat"
            if wanted == "images" and mode == "chat":
                if switch_to_pictures(PICTURES, url, context):
                    mode = "images"
                last_used = time.time()
            elif wanted == "chat" and mode == "images":
                switch_to_chat(PICTURES, url, context)
                mode = "chat"
                last_used = time.time()
            elif command.get("job") and mode == "images":
                run_job(command["job"])
                last_used = time.time()
            idle = command.get("idle_minutes") or 0
            if idle and time.time() - last_used > idle * 60:
                reason = f"nobody used it for {idle} minutes"
                break

        if time.time() - last_tunnel_check < TUNNEL_CHECK_S:
            continue
        last_tunnel_check = time.time()
        if reachable(url):
            tunnel_failures = 0
        else:
            tunnel_failures += 1
            if tunnel_failures >= 2:
                log("The tunnel dropped; opening a new one")
                url = start_tunnel()
                register(url)
                tunnel_failures = 0

    PICTURES.stop()
    log(f"Shutting down: {reason}.")
    try:
        relay("POST", "/_relay/unregister", {"target": url})
    except Exception as err:
        log(f"sign-off failed: {err}")


def main():
    """
    Starts everything that doesn't wait on something else at once: the download with the install,
    the tunnel with the model's load. Then serves.
    """
    global OPLOG
    OPLOG = NotebookLogReporter(RELAY, RUNTIME_HOST, headers={RELAY_HEADER: LAUNCH_TOKEN}, secrets=(LAUNCH_TOKEN,))
    started = time.time()
    log("Heretic Qwen server starting on " + ("Colab" if RUNTIME_HOST == "colab" else "Kaggle"))
    if AGENT_ONLY:
        # The helper may have been closed while this notebook was still queued. Stop before
        # installing/downloading/loading anything if its isolated session requested shutdown.
        try:
            if relay("GET", "/_relay/command").get("shutdown"):
                log("Personal coding session was cancelled before startup; stopping now")
                return
        except Exception:
            raise RuntimeError("Could not confirm the personal coding session. Stopping without loading a model.") from None
    models, free_bytes = models_dir()
    global PICTURES, PROFILE_ID, KNOWN_VISION
    cache = discover_cache(repo=REPO, quant=QUANT, model_name=MODEL, cache_id=CACHE_ID or None)
    cached_model = False
    if cache:
        try:
            stage_cached_model(cache, models)
            cached_model = cache['manifest'].get('schema') != 2
            log(f"Text model cache hit: {cache['manifest']['cache_id']}; no text-model downloads")
        except Exception as err:
            log(f"Text model cache unavailable ({public(err)}); downloading normally")
    else:
        log("No matching model cache mounted; downloading normally")
    if not cached_model:
        PROFILE_ID = ""
        KNOWN_VISION = None
    PICTURES = Pictures(os.path.dirname(models), cache)
    fetched = None if cached_model else Background(lambda: fetch_model(models, free_bytes))
    install(cache, os.path.join(os.path.dirname(models), "heretic-runtime"))
    start_ollama(models)
    log(f"runtime ready in {time.time() - started:.0f} s")
    if cached_model:
        try:
            http("POST", OLLAMA + "/api/show", {"model": MODEL}, timeout=120)
            quant = QUANT
        except Exception as err:
            log(f"Ollama could not read the cached model ({public(err)}); downloading normally")
            PROFILE_ID = ""
            KNOWN_VISION = None
            # Remove only this cache's links; fallback must never write through the read-only mount.
            for entry in cache["manifest"]["model"]["files"]:
                path = os.path.join(models, "blobs", "sha256-" + entry["sha256"])
                if os.path.islink(path) and os.path.realpath(path) == _cache_inside(cache["root"], entry["path"]):
                    os.unlink(path)
            fetched = Background(lambda: fetch_model(models, shutil.disk_usage(models).free))
            quant = get_model(models, fetched)
    else:
        quant = get_model(models, fetched)
    log(f"model ready to load at {time.time() - started:.0f} s")
    # Job envelopes add a small identity/path wrapper around the original 4 MiB payload.
    proxy = start_stream_proxy(OLLAMA, port=11435, max_request_bytes=4 * 1024 * 1024 + 1024)
    try:
        global PERSONAL_JOBS
        PERSONAL_JOBS = install_async_job_routes(proxy, max_job_seconds=7200, max_stream_seconds=300, control_token=LAUNCH_TOKEN) if AGENT_ONLY else None
        if not AGENT_ONLY:
            install_async_job_routes(proxy)
        tunnel = Background(start_tunnel)
        report("loading", "Loading the model onto the GPUs")
        context = load_best()
        vision = False if AGENT_ONLY else (True if KNOWN_VISION else sees_pictures(context))
        url = tunnel.result()
        log(f"up in {time.time() - started:.0f} s")
        serve(context, vision, quant, url)
    finally:
        proxy.shutdown()
        proxy.server_close()


if __name__ == "__main__":
    final_status = "COMPLETE"
    try:
        main()
    except Exception as err:
        final_status = "ERROR"
        report("failed", public(f"{type(err).__name__}: {err}" if not isinstance(err, RuntimeError) else err))
        raise
    finally:
        if OPLOG is not None:
            OPLOG.finish(final_status, wait=6)
    sys.exit(0)
