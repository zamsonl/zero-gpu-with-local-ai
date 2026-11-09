"""Read an immutable Kaggle cache; stage writable Ollama/ComfyUI stores locally.

Large payload hashes are checked by the cache builder, not on every startup.
Discovery returns {"root": absolute_path, "manifest": parsed_cache_json}, or None.
Model, runtime and image staging fail independently with CacheError; callers retain
their normal download/install fallback. Nothing writes to the mounted cache.
"""

import hashlib
import json
import os
import re
import shutil
import stat
import tarfile
import tempfile


class CacheError(ValueError):
    pass


def _cache_relative(value):
    if not isinstance(value, str) or not value or "\\" in value:
        raise CacheError("cache path must be a relative POSIX path")
    if value.startswith("/") or re.match(r"^[A-Za-z]:", value):
        raise CacheError("absolute cache path")
    if any(part in ("", ".", "..") for part in value.split("/")):
        raise CacheError("unsafe cache path")
    return value


def _cache_inside(root, relative):
    root = os.path.realpath(root)
    path = os.path.realpath(os.path.join(root, _cache_relative(relative)))
    try:
        contained = os.path.commonpath((root, path)) == root
    except ValueError:
        contained = False
    if not contained:
        raise CacheError("cache path escapes its root")
    return path


def _cache_hash(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _cache_file(cache, entry, *, hash_small=False):
    if not isinstance(entry, dict):
        raise CacheError("invalid cache file descriptor")
    size, digest = entry.get("size"), entry.get("sha256")
    if type(size) is not int or size < 0 or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise CacheError("invalid cache file size or digest")
    path = _cache_inside(cache["root"], entry.get("path"))
    if not os.path.isfile(path) or os.path.getsize(path) != size:
        raise CacheError("cache file missing or truncated: " + entry["path"])
    if hash_small:
        if size > 1024 * 1024:
            raise CacheError("cache metadata exceeds 1 MiB")
        if _cache_hash(path) != digest:
            raise CacheError("cache metadata digest mismatch: " + entry["path"])
    return path


def _cache_model(cache):
    model = cache["manifest"].get("model")
    if not isinstance(model, dict):
        raise CacheError("model cache metadata missing")
    if not isinstance(model.get("name"), str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", model["name"]):
        raise CacheError("invalid model name")
    if not all(isinstance(model.get(key), str) and model[key] for key in ("repo", "revision", "quant")):
        raise CacheError("model identity is incomplete")
    files = model.get("files")
    if not isinstance(files, list) or len(files) != 3 or any(not isinstance(item, dict) for item in files):
        raise CacheError("model cache needs model, projector and config files")
    by_role = {item.get("role"): item for item in files}
    if set(by_role) != {"model", "projector", "config"}:
        raise CacheError("invalid model cache roles")
    paths = {role: _cache_file(cache, item, hash_small=role == "config") for role, item in by_role.items()}
    manifest_path = _cache_inside(cache["root"], model.get("manifest"))
    if not os.path.isfile(manifest_path) or os.path.getsize(manifest_path) > 1024 * 1024:
        raise CacheError("model manifest missing or too large")
    if _cache_hash(manifest_path) != model.get("manifest_sha256"):
        raise CacheError("model manifest digest mismatch")
    with open(manifest_path, encoding="utf-8") as source:
        manifest = json.load(source)
    if not isinstance(manifest, dict):
        raise CacheError("invalid Ollama manifest")
    expected_types = {
        "model": "application/vnd.ollama.image.model",
        "projector": "application/vnd.ollama.image.projector",
    }
    layers = manifest.get("layers")
    if manifest.get("schemaVersion") != 2 or not isinstance(layers, list) or len(layers) != 2:
        raise CacheError("unsupported Ollama manifest")
    for role, media_type in expected_types.items():
        entry = by_role[role]
        matches = [layer for layer in layers if isinstance(layer, dict) and layer.get("mediaType") == media_type]
        if len(matches) != 1 or matches[0].get("digest") != "sha256:" + entry["sha256"] or matches[0].get("size") != entry["size"]:
            raise CacheError("Ollama manifest layer does not match cache")
    config = manifest.get("config", {})
    if not isinstance(config, dict) or config.get("digest") != "sha256:" + by_role["config"]["sha256"] or config.get("size") != by_role["config"]["size"]:
        raise CacheError("Ollama manifest config does not match cache")
    return model, by_role, paths, manifest_path


def validate_cache(root, *, repo, quant, model_name, cache_id=None):
    root = os.path.realpath(root)
    metadata = _cache_inside(root, "cache.json")
    if os.path.getsize(metadata) > 1024 * 1024:
        raise CacheError("cache metadata exceeds 1 MiB")
    with open(metadata, encoding="utf-8") as source:
        manifest = json.load(source)
    if not isinstance(manifest, dict) or type(manifest.get("schema")) is not int or manifest["schema"] != 1:
        raise CacheError("unsupported cache schema")
    if not isinstance(manifest.get("cache_id"), str) or not manifest["cache_id"]:
        raise CacheError("cache identity missing")
    if cache_id is not None and manifest["cache_id"] != cache_id:
        raise CacheError("cache identity mismatch")
    cache = {"root": root, "manifest": manifest}
    model, _, _, _ = _cache_model(cache)
    if (model["repo"], model["quant"], model["name"]) != (repo, quant, model_name):
        raise CacheError("cached model identity mismatch")
    return cache


def discover_cache(input_root="/kaggle/input", *, repo, quant, model_name, cache_id=None, max_depth=3):
    """Find a matching cache.json no more than three directory levels below input_root."""
    if type(max_depth) is not int or not 0 <= max_depth <= 3:
        raise ValueError("cache search depth must be between zero and three")
    input_root = os.path.realpath(input_root)
    for directory, children, files in os.walk(input_root, followlinks=False):
        relative = os.path.relpath(directory, input_root)
        depth = 0 if relative == "." else len(relative.split(os.sep))
        children[:] = sorted(children) if depth < max_depth else []
        if "cache.json" not in files:
            continue
        try:
            return validate_cache(directory, repo=repo, quant=quant, model_name=model_name, cache_id=cache_id)
        except (CacheError, OSError, ValueError, TypeError):
            continue
    return None


def _cache_copy_atomic(source, destination):
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".cache-", dir=os.path.dirname(destination))
    os.close(handle)
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _cache_output_root(cache, path):
    path, source = os.path.realpath(path), os.path.realpath(cache["root"])
    try:
        common = os.path.commonpath((source, path))
        inside_source = common == source or common == path
    except ValueError:
        inside_source = False
    if inside_source:
        raise CacheError("writable staging must be outside the immutable cache")
    return path


def _cache_destination(root, relative):
    relative = _cache_relative(relative)
    parent, name = relative.rsplit("/", 1) if "/" in relative else (None, relative)
    directory = _cache_inside(root, parent) if parent else root
    return os.path.join(directory, name)


def _cache_link(source, destination, created):
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    if os.path.lexists(destination):
        if os.path.islink(destination) and os.path.realpath(destination) == os.path.realpath(source):
            return
        raise CacheError("cache staging would replace an existing file: " + destination)
    os.symlink(source, destination)
    created.append(destination)


def stage_cached_model(cache, writable_models):
    """Return the installed manifest path; only immutable large blobs are symlinked."""
    model, entries, sources, manifest = _cache_model(cache)
    writable_models = _cache_output_root(cache, writable_models)
    created = []
    try:
        for role in ("model", "projector"):
            target = _cache_destination(writable_models, "blobs/sha256-" + entries[role]["sha256"])
            _cache_link(sources[role], target, created)
        _cache_copy_atomic(sources["config"], _cache_destination(writable_models, "blobs/sha256-" + entries["config"]["sha256"]))
        target = _cache_destination(writable_models, "manifests/registry.ollama.ai/library/" + model["name"] + "/latest")
        _cache_copy_atomic(manifest, target)
        return target
    except Exception:
        for path in reversed(created):
            os.unlink(path)
        raise


def install_cached_runtime(cache, writable_runtime, *, ollama_version=None, cloudflared_version=None):
    """Extract the cached runtime locally and return absolute {ollama, cloudflared} paths."""
    runtime = cache["manifest"].get("runtime", {})
    if not isinstance(runtime, dict) or runtime.get("platform") != "linux-amd64":
        raise CacheError("unsupported cached runtime platform")
    components = {}
    for name, expected_version in (("ollama", ollama_version), ("cloudflared", cloudflared_version)):
        entry = runtime.get(name)
        if not isinstance(entry, dict) or not isinstance(entry.get("version"), str) or not entry["version"]:
            raise CacheError("cached runtime version missing")
        if expected_version is not None and entry["version"] != expected_version:
            raise CacheError("cached runtime version mismatch")
        components[name] = _cache_file(cache, entry)
    executable = _cache_relative(runtime["ollama"].get("executable"))
    writable_runtime = _cache_output_root(cache, writable_runtime)
    os.makedirs(writable_runtime, exist_ok=True)
    staged = tempfile.mkdtemp(prefix="cached-runtime-", dir=os.path.abspath(writable_runtime))
    try:
        with tarfile.open(components["ollama"], "r:") as archive:
            if not hasattr(tarfile, "data_filter"):
                raise CacheError("safe cached-runtime extraction requires tarfile.data_filter")
            archive.extractall(staged, filter="data")
        ollama = _cache_inside(staged, executable)
        if not os.path.isfile(ollama):
            raise CacheError("cached Ollama executable missing")
        cloudflared = os.path.join(staged, "cloudflared")
        _cache_copy_atomic(components["cloudflared"], cloudflared)
        for path in (ollama, cloudflared):
            os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        return {"ollama": ollama, "cloudflared": cloudflared}
    except Exception:
        shutil.rmtree(staged)
        raise


def validate_image_cache(cache, *, repo=None, revision=None):
    """Validate images separately, so an unusable image cache cannot reject chat."""
    images = cache["manifest"].get("images")
    if not isinstance(images, dict) or not all(isinstance(images.get(k), str) and images[k] for k in ("repo", "revision")):
        raise CacheError("image cache identity missing")
    if (repo is not None and images["repo"] != repo) or (revision is not None and images["revision"] != revision):
        raise CacheError("image cache identity mismatch")
    files = images.get("files")
    if not isinstance(files, list) or not files:
        raise CacheError("image cache files missing")
    targets = set()
    for entry in files:
        _cache_file(cache, entry)
        source_path = _cache_relative(entry.get("source_path"))
        folder = entry.get("folder")
        if not isinstance(folder, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", folder):
            raise CacheError("invalid ComfyUI model folder")
        target = (folder, source_path.rsplit("/", 1)[-1])
        if target in targets:
            raise CacheError("duplicate image cache destination")
        targets.add(target)
    return images


def stage_cached_images(cache, comfy_models, *, repo=None, revision=None):
    """Return {HuggingFace_source_path: local_path} for staged ComfyUI model files."""
    images = validate_image_cache(cache, repo=repo, revision=revision)
    comfy_models = _cache_output_root(cache, comfy_models)
    result, created = {}, []
    try:
        for entry in images["files"]:
            target = _cache_destination(comfy_models, entry["folder"] + "/" + entry["source_path"].rsplit("/", 1)[-1])
            _cache_link(_cache_file(cache, entry), target, created)
            result[entry["source_path"]] = target
        return result
    except Exception:
        for path in reversed(created):
            os.unlink(path)
        raise
