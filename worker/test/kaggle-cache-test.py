"""Offline cache tests: python work/test-cache-helpers.py. No GPU or credentials."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("cache_helpers", Path(__file__).resolve().parent.parent / "src" / "kaggle-cache.py")
C = importlib.util.module_from_spec(spec)
spec.loader.exec_module(C)


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="qwen-cache-test-", dir=Path(__file__).parent)
        self.base = Path(self.temp.name)
        self.root = self.base / "inputs" / "dataset"
        self.root.mkdir(parents=True)
        self.identity = dict(repo="owner/model", quant="Q5_K_P", model_name="qwen-test", cache_id="test-build")
        self.meta = self.fixture()

    def tearDown(self):
        for directory, _, files in os.walk(self.base):
            os.chmod(directory, stat.S_IRWXU)
            for name in files:
                path = Path(directory) / name
                if not path.is_symlink():
                    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        self.temp.cleanup()

    def file(self, path, data, **extra):
        dest = self.root / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        return dict(path=path, sha256=hashlib.sha256(data).hexdigest(), size=len(data), **extra)

    def archive(self, files=None, links=()):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:") as tar:
            for name, data in (files or {"bin/ollama": b"fake executable", "lib/ollama/cuda_v12/library.so.1": b"fake library"}).items():
                item = tarfile.TarInfo(name)
                item.size, item.mode = len(data), 0o644
                tar.addfile(item, io.BytesIO(data))
            for name, target, kind in links:
                item = tarfile.TarInfo(name)
                item.type, item.linkname = kind, target
                tar.addfile(item)
        return buf.getvalue()

    def fixture(self):
        model = self.file("chat-model.gguf", b"model stand-in", role="model")
        projector = self.file("nested/projector.gguf", b"projector stand-in", role="projector")
        config = self.file("chat-config.json", b'{"model_format":"gguf"}', role="config")
        manifest = {
            "schemaVersion": 2,
            "config": {"digest": "sha256:" + config["sha256"], "size": config["size"]},
            "layers": [{"mediaType": "application/vnd.ollama.image." + f["role"], "digest": "sha256:" + f["sha256"], "size": f["size"]} for f in (model, projector)],
        }
        mf = self.file("chat-manifest.json", json.dumps(manifest).encode())
        runtime = self.file("runtime.tar", self.archive(), version="1.2.3", executable="bin/ollama")
        cloudflared = self.file("cloudflared", b"fake tunnel", version="4.5.6")
        image = self.file("images/image.safetensors", b"image stand-in", source_path="upstream/image.safetensors", folder="diffusion_models")
        data = {
            "schema": 1, "cache_id": "test-build",
            "model": {"repo": "owner/model", "revision": "a" * 40, "quant": "Q5_K_P", "name": "qwen-test", "manifest": mf["path"], "manifest_sha256": mf["sha256"], "files": [model, projector, config]},
            "runtime": {"platform": "linux-amd64", "ollama": runtime, "cloudflared": cloudflared},
            "images": {"repo": "owner/images", "revision": "b" * 40, "files": [image]},
        }
        self.save(data)
        return data

    def save(self, data=None):
        (self.root / "cache.json").write_text(json.dumps(data or self.meta), encoding="utf-8")

    def cache(self):
        return C.validate_cache(self.root, **self.identity)

    def require_symlinks(self):
        source, target = self.base / "probe-source", self.base / "probe-link"
        source.write_bytes(b"x")
        try:
            os.symlink(source, target)
        except OSError as err:
            self.skipTest("OS symlink privilege unavailable: " + str(err))
        finally:
            if target.is_symlink():
                target.unlink()
            source.unlink()

    def readonly(self):
        for path in self.root.rglob("*"):
            os.chmod(path, 0o555 if path.is_dir() else 0o444)
        os.chmod(self.root, 0o555)

    def snapshot(self):
        return {str(p.relative_to(self.root)): (p.read_bytes(), p.stat().st_mode) for p in self.root.rglob("*") if p.is_file()}

    def test_discovery_matches_identity_and_caps_search_depth(self):
        self.assertEqual(C.discover_cache(self.base / "inputs", **self.identity)["root"], str(self.root.resolve()))
        for key, value in (("repo", "different/repo"), ("quant", "IQ3_M"), ("model_name", "other-model"), ("cache_id", "different-build")):
            self.assertIsNone(C.discover_cache(self.base / "inputs", **{**self.identity, key: value}))
        self.assertIsNone(C.discover_cache(self.base / "inputs", max_depth=0, **self.identity))
        moved = self.base / "deep" / "a" / "b" / "c" / "d"
        moved.parent.mkdir(parents=True)
        self.root.rename(moved)
        self.assertIsNone(C.discover_cache(self.base / "deep", **self.identity))
        self.assertIsNone(C.discover_cache(self.base / "missing", **self.identity))

    def test_truncated_model_is_a_cache_miss(self):
        (self.root / "chat-model.gguf").write_bytes(b"short")
        with self.assertRaises(C.CacheError):
            self.cache()
        self.assertIsNone(C.discover_cache(self.base / "inputs", **self.identity))

    def test_bad_schema_or_json_is_a_cache_miss(self):
        self.save({**self.meta, "schema": 99})
        self.assertIsNone(C.discover_cache(self.base / "inputs", **self.identity))
        (self.root / "cache.json").write_text("{broken")
        self.assertIsNone(C.discover_cache(self.base / "inputs", **self.identity))

    def test_small_config_hash_checked_at_equal_size(self):
        entry = self.meta["model"]["files"][2]
        (self.root / entry["path"]).write_bytes(b"X" * entry["size"])
        with self.assertRaisesRegex(C.CacheError, "digest mismatch"):
            self.cache()

    def test_manifest_must_reference_declared_blobs(self):
        path = self.root / "chat-manifest.json"
        manifest = json.loads(path.read_text())
        manifest["layers"][0]["digest"] = "sha256:" + "0" * 64
        path.write_text(json.dumps(manifest))
        self.meta["model"]["manifest_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.save()
        with self.assertRaisesRegex(C.CacheError, "layer does not match"):
            self.cache()

    def test_descriptor_traversal_is_rejected(self):
        for path in ("../escape", "/absolute", "C:/absolute", "nested\\file", "nested/../escape"):
            with self.subTest(path=path):
                metadata = copy.deepcopy(self.meta)
                metadata["model"]["files"][0]["path"] = path
                self.save(metadata)
                with self.assertRaises(C.CacheError):
                    self.cache()

    def test_descriptor_symlink_escape_is_rejected(self):
        self.require_symlinks()
        payload, outside = self.root / "chat-model.gguf", self.base / "external-model"
        payload.rename(outside)
        os.symlink(outside, payload)
        with self.assertRaisesRegex(C.CacheError, "escapes"):
            self.cache()

    def test_readonly_models_use_writable_overlay_without_network(self):
        self.require_symlinks()
        self.readonly()
        before, destination = self.snapshot(), self.base / "writable-models"
        with patch("urllib.request.urlopen", side_effect=AssertionError("unexpected network")):
            cache = self.cache()
            manifest = Path(C.stage_cached_model(cache, destination))
            C.stage_cached_model(cache, destination)
        for entry in self.meta["model"]["files"]:
            path = destination / "blobs" / ("sha256-" + entry["sha256"])
            self.assertEqual(path.is_symlink(), entry["role"] != "config")
            self.assertEqual(path.read_bytes(), (self.root / entry["path"]).read_bytes())
        self.assertFalse(manifest.is_symlink())
        self.assertEqual(manifest.read_bytes(), (self.root / "chat-manifest.json").read_bytes())
        (destination / "blobs" / "downloaded-new-blob").write_bytes(b"fallback remains writable")
        self.assertEqual(before, self.snapshot())

    def test_cache_cannot_be_used_as_staging_destination(self):
        cache = self.cache()
        for function in (C.stage_cached_model, C.install_cached_runtime, C.stage_cached_images):
            with self.assertRaises(C.CacheError):
                function(cache, self.root / "output")

    def test_failed_staging_rolls_back_links_and_preserves_existing_file(self):
        self.require_symlinks()
        destination = self.base / "writable-models"
        (destination / "blobs").mkdir(parents=True)
        model, projector = self.meta["model"]["files"][:2]
        occupied = destination / "blobs" / ("sha256-" + projector["sha256"])
        occupied.write_bytes(b"existing file")
        with self.assertRaises(C.CacheError):
            C.stage_cached_model(self.cache(), destination)
        self.assertEqual(occupied.read_bytes(), b"existing file")
        self.assertFalse(os.path.lexists(destination / "blobs" / ("sha256-" + model["sha256"])))

    def test_runtime_extracts_full_tree_and_checks_version(self):
        self.readonly()
        cache, before = self.cache(), self.snapshot()
        paths = C.install_cached_runtime(cache, self.base / "runtime-output", ollama_version="1.2.3", cloudflared_version="4.5.6")
        self.assertEqual(set(paths), {"ollama", "cloudflared"})
        self.assertTrue(all(os.path.isabs(p) and os.path.isfile(p) for p in paths.values()))
        root = Path(paths["ollama"]).parent.parent
        self.assertEqual((root / "lib/ollama/cuda_v12/library.so.1").read_bytes(), b"fake library")
        if os.name != "nt":
            self.assertTrue(all(os.access(p, os.X_OK) for p in paths.values()))
        self.assertEqual(before, self.snapshot())
        with self.assertRaisesRegex(C.CacheError, "version mismatch"):
            C.install_cached_runtime(cache, self.base / "other-runtime", ollama_version="new-version")

    def test_runtime_archive_valid_internal_symlink_and_hardlink(self):
        self.require_symlinks()
        runtime = self.meta["runtime"]["ollama"]
        runtime.update(self.file(runtime["path"], self.archive(links=[
            ("lib/ollama/cuda_v12/library.so", "library.so.1", tarfile.SYMTYPE),
            ("bin/ollama-copy", "bin/ollama", tarfile.LNKTYPE),
        ])))
        self.save()
        paths = C.install_cached_runtime(self.cache(), self.base / "runtime-output")
        root = Path(paths["ollama"]).parent.parent
        link = root / "lib/ollama/cuda_v12/library.so"
        self.assertTrue(link.is_symlink())
        self.assertEqual(link.read_bytes(), b"fake library")
        self.assertTrue(os.path.samefile(root / "bin/ollama-copy", paths["ollama"]))

    def test_runtime_archive_valid_hardlink(self):
        runtime = self.meta["runtime"]["ollama"]
        runtime.update(self.file(runtime["path"], self.archive(links=[("bin/ollama-copy", "bin/ollama", tarfile.LNKTYPE)])))
        self.save()
        paths = C.install_cached_runtime(self.cache(), self.base / "runtime-output")
        root = Path(paths["ollama"]).parent.parent
        self.assertEqual((root / "bin/ollama-copy").read_bytes(), Path(paths["ollama"]).read_bytes())
        if os.name != "nt":
            self.assertTrue(os.path.samefile(root / "bin/ollama-copy", paths["ollama"]))

    def test_truncated_image_and_runtime_are_independent_of_chat(self):
        image, runtime = self.root / "images/image.safetensors", self.root / "runtime.tar"
        image.write_bytes(b"x")
        runtime.write_bytes(b"x")
        cache = self.cache()
        with self.assertRaisesRegex(C.CacheError, "truncated"):
            C.validate_image_cache(cache)
        with self.assertRaisesRegex(C.CacheError, "truncated"):
            C.install_cached_runtime(cache, self.base / "runtime-output")
        self.assertIsNotNone(C.discover_cache(self.base / "inputs", **self.identity))

    def test_runtime_traversal_and_external_links_are_rejected(self):
        bad_archives = [
            self.archive({"../escaped": b"bad"}),
            self.archive(links=[("escape", "../../outside", tarfile.SYMTYPE)]),
            self.archive(links=[("escape", "../outside", tarfile.LNKTYPE)]),
        ]
        for i, payload in enumerate(bad_archives):
            with self.subTest(case=i):
                runtime = self.meta["runtime"]["ollama"]
                runtime.update(self.file(runtime["path"], payload))
                self.save()
                output = self.base / ("runtime-output-" + str(i))
                with self.assertRaises((C.CacheError, tarfile.TarError)):
                    C.install_cached_runtime(self.cache(), output)
                self.assertEqual(list(output.iterdir()), [])
                self.assertFalse((self.base / "outside").exists())

    def test_readonly_images_stage_and_missing_images_do_not_reject_chat(self):
        self.require_symlinks()
        self.readonly()
        cache, before = self.cache(), self.snapshot()
        staged = C.stage_cached_images(cache, self.base / "ComfyUI/models", repo="owner/images", revision="b" * 40)
        path = Path(staged["upstream/image.safetensors"])
        self.assertTrue(path.is_symlink())
        self.assertEqual(path.parent.name, "diffusion_models")
        self.assertEqual(before, self.snapshot())
        with self.assertRaisesRegex(C.CacheError, "identity mismatch"):
            C.stage_cached_images(cache, self.base / "wrong-images", repo="different/images")
        broken = copy.deepcopy(cache)
        broken["manifest"]["images"]["files"][0]["size"] += 1
        with self.assertRaisesRegex(C.CacheError, "truncated"):
            C.stage_cached_images(broken, self.base / "broken-images")
        self.assertIsNotNone(C.discover_cache(self.base / "inputs", **self.identity))

    def test_missing_runtime_does_not_reject_chat(self):
        cache = self.cache()
        cache["manifest"]["runtime"]["ollama"]["path"] = "missing.tar"
        with self.assertRaises(C.CacheError):
            C.install_cached_runtime(cache, self.base / "runtime-output")
        self.assertIsNotNone(C.discover_cache(self.base / "inputs", **self.identity))


if __name__ == "__main__":
    unittest.main(verbosity=2)
