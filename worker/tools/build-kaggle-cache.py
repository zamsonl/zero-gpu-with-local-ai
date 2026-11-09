"""One-time CPU builder for exampleowner/heretic-qwen-cache (private).

Run as a private Kaggle Python script, Internet on, GPU/TPU off. Large files
stay in /kaggle/tmp; /kaggle/working contains only small metadata artifacts.
The notebook's native token uploads blobs; the owner commits cache-upload.json
with their existing API client after this script finishes, then verifies the
private dataset status. No permanent credentials belong in this script.

All model bytes are pinned by upstream revision and SHA256. The complete
official Ollama CPU/CUDA distribution is retained as an uncompressed tar.
No inference server is started, and the builder exits after upload.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from functools import partial
import hashlib
import http.client
import json
import logging
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request

HANDLE = "exampleowner/heretic-qwen-cache"
BASE = Path("/kaggle/tmp/heretic-cache-build")
STAGE = BASE / "upload"
SCRATCH = BASE / "scratch"
OUTPUT = Path("/kaggle/working")
USER_AGENT = "heretic-qwen-cache-builder/1"
MIN_FREE_BYTES = 55 * 1024**3
BLOCK = 8 * 1024**2
RANGE_CHUNK_BYTES = 128 * 1024**2
RANGE_WORKERS = 8  # Three concurrent files below bound the total to 24 workers.
PHASE = "initializing"

MODEL_REPO = "HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF"
MODEL_REVISION = "993a5971fda8f30dd1b7eb2654792ba4415c7460"
MODEL_NAME = "qwen3.8-hauhau"
MODEL_QUANT = "Q5_K_P"
IMAGE_REPO = "Comfy-Org/Qwen-Image-2.1"
IMAGE_REVISION = "0217efd1d9c9452e84f6448903d6e21bfa171ffd"
OLLAMA_VERSION = "0.40.11"
CLOUDFLARED_VERSION = "2026.10.3"
CACHE_ID = "qwen-cache-v1-993a5971fda8-0217efd1d9c9-ollama-0.40.11"
CONFIG_SHA = "9e9e667bedd54130e1be61444e0d404796e024e9ee93711cd40bcb7d373e0714"

# (role, upstream path, cached path, bytes, upstream LFS SHA256)
MODEL_FILES = [
    ("model", "Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q5_K_P.gguf", "chat-model.gguf",
     20218177664, "a21e22af885bd2f7c430a72b550a78f5445966e6a72d3143b0950baa0bd6d411"),
    ("projector", "mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf", "chat-projector.gguf",
     931146624, "5681b690bcb8eb10cd28d62d078cb4e01521a3ea4880a3fc7d54de72de2dd142"),
]
# These are the four files used by the deployed server, including its Turbo LoRA.
IMAGE_FILES = [
    ("diffusion_models", "diffusion_models/qwen_image_2.1_int8_convrot.safetensors",
     7256783064, "cb74113cb03faecd79611b01fd7fd642f0aa60d6f0b95086abee214d75eaa57d"),
    ("text_encoders", "text_encoders/qwen3vl_8b_int8_convrot.safetensors",
     9350798360, "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f"),
    ("vae", "vae/qwen_image_2.1_vae_bf16.safetensors",
     675509688, "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9"),
    ("loras", "loras/qwen_image_2.1_turbo_lora_avg_rank_178_bf16.safetensors",
     913314512, "208dd43250e1e01467ba190572ae2e7107a7870ec1ff026bc65f791fa1e80e95"),
]
OLLAMA_URL = "https://github.com/ollama/ollama/releases/download/v0.40.11/ollama-linux-amd64.tar.zst"
OLLAMA_SIZE = 1508659610
OLLAMA_SHA = "7bedab90dd122661be78798e9f0edf37fccf0cccf2699d2c58ea1a3afdc04b6d"
CLOUDFLARED_URL = "https://github.com/cloudflare/cloudflared/releases/download/2026.10.3/cloudflared-linux-amd64"
CLOUDFLARED_SIZE = 40227721
CLOUDFLARED_SHA = "053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0"

DESCRIPTION = (
    "Private cache of pinned upstream chat/vision and image model files, Ollama, and cloudflared. "
    "Each file retains its original license. See included licenses, model cards and cache.json "
    "for the original sources, versions and SHA256 hashes. No relicensing is asserted."
)


class CacheBuildError(RuntimeError):
    """Only locally authored messages, safe to include in the small result artifact."""


def log(event, **fields):
    print(json.dumps({"time": datetime.now(timezone.utc).isoformat(), "event": event, **fields}), flush=True)


def set_phase(value):
    global PHASE
    PHASE = value
    log(value)


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(BLOCK), b""):
            digest.update(block)
    return digest.hexdigest()


def descriptor(path, sha=None):
    return {"path": path.relative_to(STAGE).as_posix(), "size": path.stat().st_size,
            "sha256": sha or file_hash(path)}


def hf_url(repo, revision, name):
    return "https://huggingface.co/" + repo + "/resolve/" + revision + "/" + name


def _download_stream(url, destination, expected_size, expected_sha):
    """Resume a pinned file, then verify every byte before publishing its local name."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if destination.stat().st_size == expected_size and file_hash(destination) == expected_sha:
            log("reusing-verified-file", file=destination.name, bytes=expected_size)
            return destination
        raise CacheBuildError("Existing cached file failed verification: " + destination.name)
    temporary = destination.with_name(destination.name + ".part")
    log("download-start", file=destination.name, bytes=expected_size)
    for attempt in range(6):
        offset = temporary.stat().st_size if temporary.exists() else 0
        if offset > expected_size:
            raise CacheBuildError("Partial file is larger than its pinned size")
        if offset == expected_size:
            break
        headers = {"User-Agent": USER_AGENT, "Accept-Encoding": "identity"}
        if offset:
            headers["Range"] = "bytes=" + str(offset) + "-"
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=120) as response:
                if offset and response.status == 200:
                    offset = 0  # Origin ignored Range; restart rather than append duplicate bytes.
                elif offset and (response.status != 206 or not response.headers.get("Content-Range", "").startswith("bytes " + str(offset) + "-")):
                    raise CacheBuildError("Invalid resumed response: " + destination.name)
                written, last_log = offset, time.monotonic()
                with temporary.open("ab" if offset else "wb") as target:
                    for block in iter(lambda: response.read(BLOCK), b""):
                        written += len(block)
                        if written > expected_size:
                            raise CacheBuildError("Download exceeded its pinned size: " + destination.name)
                        target.write(block)
                        if time.monotonic() - last_log >= 30:
                            log("download-progress", file=destination.name, bytes=written, total=expected_size)
                            last_log = time.monotonic()
            if temporary.stat().st_size == expected_size:
                break
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
            if attempt == 5:
                raise CacheBuildError("Download failed after retries: " + destination.name) from error
            log("download-retry", file=destination.name, attempt=attempt + 1)
            time.sleep(min(30, 2 ** attempt))
    if not temporary.exists() or temporary.stat().st_size != expected_size:
        raise CacheBuildError("Downloaded size mismatch: " + destination.name)
    log("verifying", file=destination.name)
    if file_hash(temporary) != expected_sha:
        raise CacheBuildError("Downloaded SHA256 mismatch: " + destination.name)
    temporary.replace(destination)
    log("download-verified", file=destination.name, bytes=expected_size)
    return destination


def _fresh_range_url(origin, expected_size):
    # Request the stable source again so an expired CDN signature is replaced.
    # A unique query prevents a cached redirect from returning the expired URL.
    fresh = origin + ("&" if "?" in origin else "?") + "cachebust=" + str(time.time_ns())
    request = urllib.request.Request(fresh, headers={
        "User-Agent": USER_AGENT, "Accept-Encoding": "identity",
        "Range": "bytes=0-0", "Cache-Control": "no-cache",
    })
    with urllib.request.urlopen(request, timeout=120) as response:
        if response.status != 206 or response.headers.get("Content-Range") != "bytes 0-0/" + str(expected_size):
            raise CacheBuildError("Pinned file source did not honor byte ranges")
        if len(response.read(2)) != 1:
            raise CacheBuildError("Invalid byte-range probe body")
        return response.geturl()


def _download_ranges(origin, temporary, expected_size, expected_sha):
    """Write disjoint ranges into one file; checkpoint only fully received chunks."""
    checkpoint = temporary.with_name(temporary.name + ".ranges.json")
    count = (expected_size + RANGE_CHUNK_BYTES - 1) // RANGE_CHUNK_BYTES
    identity = {"sha256": expected_sha, "size": expected_size, "chunk_size": RANGE_CHUNK_BYTES}
    completed = set()
    if checkpoint.exists() and temporary.exists():
        state = json.loads(checkpoint.read_text(encoding="utf-8"))
        if any(state.get(key) != value for key, value in identity.items()) or temporary.stat().st_size != expected_size:
            raise CacheBuildError("Range checkpoint does not match the pinned file")
        saved = state.get("completed")
        if not isinstance(saved, list) or any(type(index) is not int or not 0 <= index < count for index in saved):
            raise CacheBuildError("Invalid range checkpoint")
        completed = set(saved)
    else:
        # An old sequential .part has no trustworthy range map. Start a fresh map.
        with temporary.open("wb") as output:
            output.truncate(expected_size)
        write_json(checkpoint, {**identity, "completed": []})
    pending = [index for index in range(count) if index not in completed]
    if not pending:
        return checkpoint
    signed_url = [_fresh_range_url(origin, expected_size)]
    lock, refresh_lock, cancelled = threading.Lock(), threading.Lock(), threading.Event()
    finished = sum(min(RANGE_CHUNK_BYTES, expected_size - index * RANGE_CHUNK_BYTES) for index in completed)
    last_log = time.monotonic()
    log("range-download-start", file=temporary.name, workers=min(RANGE_WORKERS, len(pending)),
        resumed_bytes=finished, total=expected_size)

    def worker(index):
        nonlocal finished, last_log
        start = index * RANGE_CHUNK_BYTES
        end = min(start + RANGE_CHUNK_BYTES, expected_size) - 1
        length = end - start + 1
        for attempt in range(6):
            if cancelled.is_set():
                return
            current_url = signed_url[0]
            try:
                request = urllib.request.Request(current_url, headers={
                    "User-Agent": USER_AGENT, "Accept-Encoding": "identity", "Range": f"bytes={start}-{end}",
                })
                with urllib.request.urlopen(request, timeout=120) as response:
                    if response.status != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{expected_size}":
                        raise CacheBuildError("Incorrect byte-range response")
                    content_length = response.headers.get("Content-Length")
                    if content_length is not None and int(content_length) != length:
                        raise CacheBuildError("Incorrect byte-range length")
                    with temporary.open("r+b") as output:
                        output.seek(start)
                        remaining = length
                        while remaining:
                            block = response.read(min(BLOCK, remaining))
                            if not block:
                                raise CacheBuildError("Incomplete byte range")
                            output.write(block)
                            remaining -= len(block)
                        if response.read(1):
                            raise CacheBuildError("Byte range exceeded requested length")
                        output.flush()
                        os.fsync(output.fileno())
                with lock:
                    completed.add(index)
                    finished += length
                    write_json(checkpoint, {**identity, "completed": sorted(completed)})
                    if time.monotonic() - last_log >= 30:
                        log("download-progress", file=temporary.name, bytes=finished, total=expected_size)
                        last_log = time.monotonic()
                return
            except (CacheBuildError, urllib.error.URLError, http.client.HTTPException,
                    TimeoutError, ConnectionError, OSError, ValueError) as error:
                if attempt == 5:
                    cancelled.set()
                    raise CacheBuildError("Byte range failed after retries: " + temporary.name + f" [{start}-{end}]") from error
                if isinstance(error, urllib.error.HTTPError) and error.code in (401, 403):
                    with refresh_lock:
                        if signed_url[0] == current_url:
                            try:
                                signed_url[0] = _fresh_range_url(origin, expected_size)
                            except (CacheBuildError, urllib.error.URLError, http.client.HTTPException,
                                    TimeoutError, ConnectionError, OSError):
                                pass  # Retry the refresh on the next expired-link response.
                log("range-retry", file=temporary.name, chunk=index, attempt=attempt + 1)
                cancelled.wait(min(30, 2 ** attempt))

    with ThreadPoolExecutor(max_workers=min(RANGE_WORKERS, len(pending))) as executor:
        futures = [executor.submit(worker, index) for index in pending]
        try:
            for future in futures:
                future.result()
        except Exception:
            cancelled.set()
            for future in futures:
                future.cancel()
            raise
    if len(completed) != count:
        raise CacheBuildError("One or more byte ranges are missing")
    return checkpoint


def download(url, destination, expected_size, expected_sha):
    """Use bounded parallel ranges for large files; verify the complete SHA256."""
    if expected_size < RANGE_CHUNK_BYTES:
        return _download_stream(url, destination, expected_size, expected_sha)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if destination.stat().st_size == expected_size and file_hash(destination) == expected_sha:
            log("reusing-verified-file", file=destination.name, bytes=expected_size)
            return destination
        raise CacheBuildError("Existing cached file failed verification: " + destination.name)
    temporary = destination.with_name(destination.name + ".part")
    checkpoint = _download_ranges(url, temporary, expected_size, expected_sha)
    log("verifying", file=destination.name)
    if temporary.stat().st_size != expected_size or file_hash(temporary) != expected_sha:
        raise CacheBuildError("Downloaded SHA256/size mismatch: " + destination.name)
    temporary.replace(destination)
    checkpoint.unlink(missing_ok=True)
    log("download-verified", file=destination.name, bytes=expected_size)
    return destination


def download_notice(url, name):
    """Preserve original license/model-card bytes from a pinned revision or release tag."""
    path = STAGE / "licenses" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        raw = response.read(2 * 1024**2 + 1)
    if not raw or len(raw) > 2 * 1024**2:
        raise CacheBuildError("Upstream license/card is empty or unexpectedly large")
    path.write_bytes(raw)
    return {**descriptor(path, hashlib.sha256(raw).hexdigest()), "source_url": url}


def install_upload_tools():
    # The source must be the short-lived notebook token, never config-file fallback.
    token_path = os.environ.get("KAGGLE_API_V1_TOKEN", "")
    if not (os.environ.get("KAGGLE_KERNEL_RUN_TYPE") and os.environ.get("KAGGLE_DATA_PROXY_URL")
            and token_path and Path(token_path).is_file()):
        raise CacheBuildError("Kaggle notebook-native authentication is unavailable")
    os.environ["TQDM_DISABLE"] = "1"
    os.environ["KAGGLEHUB_VERBOSITY"] = "error"
    with (SCRATCH / "pip-install.log").open("wb") as output:
        result = subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
                                 "kagglehub==1.0.3", "kagglesdk==0.1.38", "zstandard==0.25.0"],
                                stdout=output, stderr=subprocess.STDOUT, check=False)
    if result.returncode:
        raise CacheBuildError("Pinned cache-builder dependency installation failed")
    from kagglesdk.kaggle_env import get_access_token_from_env
    token, source = get_access_token_from_env()
    if not token or source != "KAGGLE_API_V1_TOKEN":
        raise CacheBuildError("SDK did not choose notebook-native authentication")
    del token
    import kagglehub.gcs_upload as uploads
    uploads.tqdm = partial(uploads.tqdm, disable=True)
    uploads.MAX_PARALLEL_UPLOADS = 3
    logging.getLogger("kagglehub").setLevel(logging.ERROR)


@contextmanager
def heartbeat(event):
    stop = threading.Event()
    started = time.monotonic()
    def tick():
        while not stop.wait(30):
            log(event, elapsed_seconds=int(time.monotonic() - started))
    thread = threading.Thread(target=tick, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join()


def upload_directory(path):
    from kagglehub.gcs_upload import upload_files_and_directories
    from kagglesdk.blobs.types.blob_api_service import ApiBlobType
    files = [item for item in path.rglob("*") if item.is_file()]
    if not files or len(files) > 50:
        raise CacheBuildError("Upload must contain 1-50 files to avoid an extra giant ZIP")
    with heartbeat("upload-active"):
        uploaded = upload_files_and_directories(str(path), item_type=ApiBlobType.DATASET,
                                                ignore_patterns=[], quiet=True).to_proto()
    def serialize(directory):
        return {"name": directory.name,
                "files": [{"token": item.token} for item in directory.files],
                "directories": [serialize(child) for child in directory.directories]}
    serialized = serialize(uploaded)
    def count(directory):
        return len(directory["files"]) + sum(count(child) for child in directory["directories"])
    if count(serialized) != len(files):
        raise CacheBuildError("Kaggle upload omitted one or more staged files")
    return serialized


def commit_metadata(uploaded, phase):
    owner, slug = HANDLE.split("/")
    common = {"files": uploaded["files"], "directories": uploaded["directories"]}
    return {
        "dataset": HANDLE, "phase": phase, "cache_id": CACHE_ID,
        "create_request": {"ownerSlug": owner, "slug": slug,
                           "title": "Heretic Qwen private runtime cache", "description": DESCRIPTION,
                           "licenseName": "other", "isPrivate": True, **common},
        "version_request": {"ownerSlug": owner, "datasetSlug": slug,
                            "body": {"versionNotes": "Pinned, SHA256-verified cache: " + CACHE_ID,
                                     "deleteOldVersions": False, "description": DESCRIPTION, **common}},
    }


def upload_preflight():
    directory = SCRATCH / "preflight"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "README.md").write_text(
        "# Heretic Qwen private cache\n\nCache build in progress. Original upstream licenses are retained.\n",
        encoding="utf-8")
    uploaded = upload_directory(directory)
    write_json(OUTPUT / "cache-upload-preflight.json", commit_metadata(uploaded, "preflight"))
    log("native-upload-preflight-passed")


def build_runtime():
    import zstandard
    compressed = download(OLLAMA_URL, SCRATCH / "ollama-linux-amd64.tar.zst", OLLAMA_SIZE, OLLAMA_SHA)
    # Use an opaque suffix rather than an archive extension during ingestion.
    # Contents remain an ordinary uncompressed tar; the loader uses tarfile r:.
    output = STAGE / "ollama-runtime.tar.bin"
    temporary = output.with_name(output.name + ".part")
    digest, size = hashlib.sha256(), 0
    log("unpacking-runtime")
    # Stream decompression avoids simultaneously storing an extracted multi-GB library tree.
    with compressed.open("rb") as source, temporary.open("wb") as target:
        with zstandard.ZstdDecompressor().stream_reader(source) as reader:
            for block in iter(lambda: reader.read(BLOCK), b""):
                size += len(block)
                if size > 12 * 1024**3:
                    raise CacheBuildError("Ollama runtime unexpectedly exceeds 12 GiB")
                target.write(block)
                digest.update(block)
    names = []
    with tarfile.open(temporary, "r:") as archive:
        for member in archive:
            name = member.name.removeprefix("./")
            parts = PurePosixPath(name).parts
            if name.startswith("/") or ".." in parts or "\\" in name:
                raise CacheBuildError("Ollama release contains an unsafe archive path")
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise CacheBuildError("Ollama release contains an unsupported archive entry")
            names.append(name)
    if "bin/ollama" not in names or not any(name.startswith("lib/ollama/") for name in names):
        raise CacheBuildError("Ollama release is missing its executable/library layout")
    if not any("cuda" in name.lower() or "cublas" in name.lower() for name in names):
        raise CacheBuildError("Ollama release is missing CUDA libraries")
    if not any("cpu" in name.lower() for name in names):
        raise CacheBuildError("Ollama release is missing CPU libraries")
    temporary.replace(output)
    cloudflared = download(CLOUDFLARED_URL, STAGE / "cloudflared-linux-amd64",
                          CLOUDFLARED_SIZE, CLOUDFLARED_SHA)
    return {"platform": "linux-amd64",
            "ollama": {**descriptor(output, digest.hexdigest()), "version": OLLAMA_VERSION,
                       "executable": "bin/ollama", "source_url": OLLAMA_URL,
                       "source_sha256": OLLAMA_SHA, "source_size": OLLAMA_SIZE},
            "cloudflared": {**descriptor(cloudflared, CLOUDFLARED_SHA), "version": CLOUDFLARED_VERSION,
                            "source_url": CLOUDFLARED_URL}}


def build_model(model_entries):
    config_url = "https://huggingface.co/v2/" + MODEL_REPO + "/blobs/sha256:" + CONFIG_SHA
    original = download(config_url, SCRATCH / "upstream-ollama-config.json", 481, CONFIG_SHA)
    config = json.loads(original.read_text(encoding="utf-8"))
    config["file_type"] = MODEL_QUANT
    config["rootfs"] = {"type": "layers", "diff_ids": ["sha256:" + item["sha256"] for item in model_entries]}
    config_path = STAGE / "chat-config.json"
    config_path.write_bytes(json.dumps(config, separators=(",", ":")).encode())
    config_entry = {"role": "config", **descriptor(config_path)}
    manifest = {
        "schemaVersion": 2, "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
        "config": {"mediaType": "application/vnd.docker.container.image.v1+json",
                   "digest": "sha256:" + config_entry["sha256"], "size": config_entry["size"]},
        "layers": [{"mediaType": "application/vnd.ollama.image." + entry["role"],
                    "digest": "sha256:" + entry["sha256"], "size": entry["size"]}
                   for entry in model_entries],
    }
    manifest_path = STAGE / "chat-manifest.json"
    write_json(manifest_path, manifest)
    return {"repo": MODEL_REPO, "revision": MODEL_REVISION, "quant": MODEL_QUANT, "name": MODEL_NAME,
            "manifest": manifest_path.name, "manifest_sha256": file_hash(manifest_path),
            "upstream_config_sha256": CONFIG_SHA, "files": model_entries + [config_entry]}


def preserve_licenses():
    sources = [
        (hf_url(MODEL_REPO, MODEL_REVISION, "README.md"), "chat-model-card.md"),
        (hf_url("Qwen/Qwen3.8-27B", "1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0", "LICENSE"), "chat-base-LICENSE.txt"),
        (hf_url(IMAGE_REPO, IMAGE_REVISION, "README.md"), "image-model-card.md"),
        (hf_url("Qwen/Qwen-Image-2.1", "d26bb61231c349cf6b7896fa83353113880e1ba3", "LICENSE"), "image-base-LICENSE.txt"),
        ("https://raw.githubusercontent.com/ollama/ollama/v0.40.11/LICENSE", "ollama-LICENSE.txt"),
        ("https://raw.githubusercontent.com/cloudflare/cloudflared/2026.10.3/LICENSE", "cloudflared-LICENSE.txt"),
    ]
    return [download_notice(url, name) for url, name in sources]


def main():
    if sys.platform != "linux":
        raise CacheBuildError("Run the builder inside a Kaggle Linux CPU notebook")
    for path in (BASE, STAGE, SCRATCH, OUTPUT):
        if path.is_symlink():
            raise CacheBuildError("Build/output directory must not be a symlink")
        path.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(BASE).free
    if free < MIN_FREE_BYTES:
        raise CacheBuildError("At least 55 GiB of free temporary disk is required")
    log("disk-space", free_gib=round(free / 1024**3, 1))
    set_phase("installing-upload-tools")
    install_upload_tools()
    set_phase("checking-native-upload")
    upload_preflight()
    set_phase("downloading-pinned-files")
    model_entries, image_entries, jobs = [], [], []
    for role, source_path, local_path, size, sha in MODEL_FILES:
        url = hf_url(MODEL_REPO, MODEL_REVISION, source_path)
        jobs.append((url, STAGE / local_path, size, sha))
        model_entries.append({"role": role, "path": local_path, "size": size, "sha256": sha, "source_path": source_path})
    for folder, source_path, size, sha in IMAGE_FILES:
        local_path = "image-" + source_path.rsplit("/", 1)[-1]
        jobs.append((hf_url(IMAGE_REPO, IMAGE_REVISION, source_path), STAGE / local_path, size, sha))
        image_entries.append({"folder": folder, "source_path": source_path, "path": local_path, "size": size, "sha256": sha})
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = [executor.submit(download, *job) for job in jobs]
        for future in futures:
            future.result()
    set_phase("building-runtime-and-manifests")
    runtime = build_runtime()
    model = build_model(model_entries)
    licenses = preserve_licenses()
    index = {"schema": 1, "cache_id": CACHE_ID, "created_at": datetime.now(timezone.utc).isoformat(),
             "model": model, "runtime": runtime,
             "images": {"repo": IMAGE_REPO, "revision": IMAGE_REVISION, "files": image_entries},
             "licenses": licenses, "license_policy": "Original upstream licenses apply; no relicensing.",
             "builder": {"kagglehub": "1.0.3", "kagglesdk": "0.1.38", "zstandard": "0.25.0"}}
    write_json(STAGE / "cache.json", index)
    (STAGE / "README.md").write_text(
        "# Heretic Qwen private runtime cache\n\n" + DESCRIPTION + "\n\n"
        "This cache contains the Q5_K_P chat model and vision projector, the four deployed "
        "Comfy-Org/Qwen-Image-2.1 files, the complete Ollama Linux AMD64 CPU/CUDA runtime, "
        "and cloudflared. All payloads were SHA256-verified before upload.\n\n"
        "Upstream revisions, release URLs, byte sizes and SHA256 hashes are in cache.json. "
        "Original model cards and license texts are in licenses/. The image model's Qwen "
        "Research license is retained. Ollama's bundled library tree is retained intact.\n\n"
        "The dataset is intended to remain private. No permanent credentials are included.\n",
        encoding="utf-8")
    # Keep immutable manifest available as a small notebook artifact for the owner to validate.
    write_json(OUTPUT / "cache.json", index)
    total_bytes = sum(path.stat().st_size for path in STAGE.rglob("*") if path.is_file())
    set_phase("uploading-cache")
    log("upload-start", bytes=total_bytes, files=sum(1 for path in STAGE.rglob("*") if path.is_file()))
    uploaded = upload_directory(STAGE)
    write_json(OUTPUT / "cache-upload.json", commit_metadata(uploaded, "complete"))
    result = {"ok": True, "status": "uploaded-awaiting-owner-commit", "dataset": HANDLE,
              "cache_id": CACHE_ID, "bytes": total_bytes, "metadata_file": "cache-upload.json",
              "manifest_file": "cache.json", "used_gpu": False}
    write_json(OUTPUT / "cache-build-result.json", result)
    log("completed", **result)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # SDK/network exceptions may contain signed URLs. Do not echo them or a traceback.
        result = {"ok": False, "phase": PHASE, "error_type": type(error).__name__,
                  "http_status": getattr(getattr(error, "response", None), "status_code", None)}
        if isinstance(error, CacheBuildError):
            result["message"] = str(error)
        if OUTPUT.is_dir():
            write_json(OUTPUT / "cache-build-result.json", result)
        log("failed", **result)
        sys.exit(1)
