"""Colab adapter for the same checked-in runtime as Kaggle, including Images."""
import getpass
import os
import shutil
import subprocess
import time
import types
import urllib.error
from urllib.parse import urlsplit

RELAY = ""
RELAY_KEY = ""
MODEL_CONTEXT = 32768
MODEL_QUANT = "Q6_K"
MODEL_REPO = "HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive"
MODEL_REVISION = "0a41c68809d375475f954be12ba7c40efa56c2a9"
BATCH_SIZE = 128
config = {"CONTEXT": MODEL_CONTEXT, "MODEL_DIR": "/content/ollama-models", **(globals().get("COLAB_CONFIG") or {})}


def configured_relay():
    value = config.get('RELAY') or RELAY or input('Your deployed relay URL (https://your-worker.example): ').strip()
    parsed = urlsplit(value)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise ValueError('Enter your own HTTPS deployment origin, without a path or credentials.')
    return parsed.scheme + '://' + parsed.netloc


def relay_key():
    """Read only this named Colab secret or a hidden prompt."""
    value = ""
    try:
        from google.colab import userdata
        value = userdata.get("QWEN_RELAY_KEY") or ""
    except Exception:
        pass
    if not value:
        value = getpass.getpass("Qwen relay key (hidden; add QWEN_RELAY_KEY in Colab Secrets to remember it): ")
    if not isinstance(value, str) or not 16 <= len(value.strip()) <= 4096:
        raise RuntimeError("Enter the relay key in the hidden input or the QWEN_RELAY_KEY Colab secret.")
    return value.strip()


def gpus():
    try:
        result = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.free", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=30, check=True)
        return [(name.strip(), int(memory.strip())) for name, memory in (line.rsplit(",", 1) for line in result.stdout.strip().splitlines() if "," in line)]
    except Exception:
        return []


def models_dir():
    selected = config.get("MODEL_DIR")
    if not isinstance(selected, str) or not os.path.isabs(selected):
        raise ValueError("Colab MODEL_DIR must be an absolute directory in this runtime.")
    selected = os.path.abspath(selected)
    os.makedirs(os.path.join(selected, "blobs"), exist_ok=True)
    return selected, shutil.disk_usage(selected).free


def configured_runtime(key):
    if config.get("CONTEXT") not in (8192, 16384, 24576, 32768, 65536):
        raise ValueError("Choose a Colab context of 8192, 16384, 24576, 32768 or 65536 tokens.")
    source = globals().get("COLAB_RUNTIME_SOURCE")
    if not isinstance(source, str) or "RUNTIME_HOST" not in source:
        raise RuntimeError("The shared runtime is missing. Download the current Colab notebook from your website.")
    runtime = {"__name__": "colab_shared_runtime"}
    exec(compile(source, "<qwen-shared-runtime>", "exec"), runtime)
    runtime.update({"RELAY": config.get('RELAY') or RELAY, "LAUNCH_TOKEN": key, "RUNTIME_HOST": "colab", "RELAY_HEADER": "x-relay-key",
                    "STRICT_PROFILE": True, "REPO": MODEL_REPO, "QUANT": MODEL_QUANT, "FALLBACK_QUANT": MODEL_QUANT,
                    "CONTEXTS": [n for n in (65536, 32768, 24576, 16384, 8192) if n <= config["CONTEXT"]], "BATCH_SIZE": BATCH_SIZE,
                    "AGENT_ONLY": False, "CACHE_ID": "", "KNOWN_VISION": None, "models_dir": models_dir,
                    "USER_AGENT": "heretic-qwen-colab/2", "STARTED": time.time()})
    runtime["discover_cache"] = lambda **kwargs: None
    # Bind Python defaults as well as globals: the shared downloader was defined for Kaggle's repo.
    download, signed = runtime["download"], runtime["signed_url"]
    runtime["download"] = lambda files, dest_for, repo=MODEL_REPO, **kwargs: download(files, dest_for, repo=repo, **kwargs)
    def signed_url(name, repo=MODEL_REPO):
        if repo != MODEL_REPO: return signed(name, repo)
        request = urllib.request.Request(f"https://huggingface.co/{repo}/resolve/{MODEL_REVISION}/{name}", headers={"range": "bytes=0-0", "user-agent": runtime["USER_AGENT"]})
        with urllib.request.urlopen(request, timeout=60) as response: return response.geturl()
    runtime["signed_url"] = signed_url
    def model_files(quant):
        if quant != MODEL_QUANT: raise ValueError("Unexpected Colab precision.")
        tree = runtime["http"]("GET", f"https://huggingface.co/api/models/{MODEL_REPO}/tree/{MODEL_REVISION}")
        names = [f"Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-{quant}.gguf", "mmproj-Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-BF16.gguf"]
        files = [next(item for item in tree if item.get("path") == name and item.get("lfs")) for name in names]
        return [(item["path"], item["lfs"]["oid"], item["lfs"]["size"]) for item in files]
    runtime["model_files"] = model_files
    def load_profile():
        for context in runtime["CONTEXTS"]:
            runtime["report"]("loading", f"Loading Qwen 9B Q6_K at {context:,} context tokens")
            try:
                if runtime["load"](context): return context
            except Exception as error: runtime["log"]("GPU fit check: " + runtime["public"](str(error)))
            runtime["log"](f"{context:,} tokens did not fit fully on GPU; trying a smaller context with the same 9B Q6_K model.")
        raise RuntimeError("Qwen 9B Q6_K could not fit entirely on this Colab GPU, even at 8,192 context tokens. Free GPU memory or reconnect a GPU runtime; no CPU fallback was used.")
    runtime["load_best"] = load_profile
    return runtime


def preflight(runtime):
    machine = gpus()
    if not machine:
        raise RuntimeError("No GPU found. Select a GPU runtime in Colab. Qwen 9B requires enough free GPU memory.")
    files = runtime["model_files"](MODEL_QUANT)
    weights = sum(size for _name, _sha, size in files)
    available = sum(memory for _name, memory in machine) * 1024 * 1024
    if available < weights + 1024 * 1024 * 1024:
        raise RuntimeError(f"Qwen 9B Q6_K cannot fit: {available / 1e9:.1f} GB GPU memory is free, while selected model files alone need {weights / 1e9:.1f} GB before context and runtime overhead. Free GPU memory or select a GPU with more memory. The 9B model was not downloaded.")
    runtime["log"]("Colab profile: Qwen 9B Q6_K, up to 32,768 context by default, batch 128, q8_0 KV; chat, vision and Images mode.")
    runtime["log"]("Model-file memory preflight passed. Context is measured on this GPU and reduced only if needed; model precision stays Q6_K.")
    def exact_files(quant):
        if quant != MODEL_QUANT:
            raise ValueError("Unexpected precision.")
        return files
    runtime["model_files"] = exact_files
    return machine


def main():
    global RELAY_KEY, RELAY
    RELAY = configured_relay()
    RELAY_KEY = relay_key()
    runtime = configured_runtime(RELAY_KEY)
    reporter = runtime["NotebookLogReporter"](RELAY, "colab", headers={"x-relay-key": RELAY_KEY}, secrets=(RELAY_KEY,))
    runtime["OPLOG"] = reporter
    runtime["NotebookLogReporter"] = lambda *args, **kwargs: reporter
    registered_target = None
    original_relay = runtime["relay"]
    def tracked_relay(method, route, body=None, **kwargs):
        nonlocal registered_target
        if method == "POST" and route == "/_relay/register" and isinstance(body, dict): body = {**body, "model_size": "9B"}
        result = original_relay(method, route, body, **kwargs) if body is not None else original_relay(method, route, **kwargs)
        if method == "POST" and isinstance(body, dict):
            if route == "/_relay/register": registered_target = body.get("target")
            elif route == "/_relay/unregister" and body.get("target") == registered_target: registered_target = None
        return result
    runtime["relay"] = tracked_relay
    started = []
    original_popen = subprocess.Popen
    def tracked_popen(*args, **kwargs):
        child = original_popen(*args, **kwargs)
        started.append(child)
        return child
    runtime["subprocess"] = types.SimpleNamespace(**{name: getattr(subprocess, name) for name in dir(subprocess) if name != "Popen"}, Popen=tracked_popen)
    final_status = "COMPLETE"
    try:
        runtime["relay"]("GET", "/_relay/command")
        runtime["report"]("installing", "Checking GPU capacity for the Colab Qwen 9B profile")
        preflight(runtime)
        runtime["main"]()
    except KeyboardInterrupt:
        runtime["log"]("Colab was stopped from the notebook")
    except Exception as error:
        final_status = "ERROR"
        if isinstance(error, urllib.error.HTTPError) and error.code in (401, 403):
            message = "The relay rejected the key. Check the QWEN_RELAY_KEY Colab secret."
        else:
            message = runtime["notebook_log_redact"](str(error), (RELAY_KEY,))
        runtime["report"]("failed", runtime["public"](message))
        runtime["log"](message)
    finally:
        if registered_target:
            try: original_relay("POST", "/_relay/unregister", {"target": registered_target})
            except Exception: pass
        pictures = runtime.get("PICTURES")
        if pictures is not None:
            try: pictures.stop()
            except Exception: pass
        for child in reversed(started):
            try:
                if child.poll() is None:
                    child.terminate()
                    try: child.wait(timeout=10)
                    except subprocess.TimeoutExpired: child.kill()
            except Exception:
                pass
        reporter.finish(final_status, wait=6)


if __name__ == "__main__":
    main()
