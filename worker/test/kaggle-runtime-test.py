"""Offline startup tests: python test/kaggle-runtime-test.py.

For Linux notebook execution, prepend RUNTIME_SOURCE containing helper + server
source. GPU/process/network boundaries are mocked; cache filesystem work is real.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError


def runtime_namespace():
    source = globals().get("RUNTIME_SOURCE")
    if source is None:
        src = Path(__file__).resolve().parent.parent / "src"
        source = "\n".join((src / name).read_text(encoding="utf-8") for name in ("notebook-log.py", "kaggle-cache.py", "kaggle-server.py"))
    for marker, value in {
        "__RELAY__": '"https://relay.invalid"', "__LAUNCH_TOKEN__": '"test-token"',
        "__QUANT__": '"Q5_K_P"', "__CONTEXTS__": "[81920]", "__VISION__": "True",
        "__CACHE_ID__": '"runtime-test-cache"',
        "__BATCH_SIZE__": "512", "__PROFILE_ID__": '"runtime-test-profile"',
    }.items():
        source = source.replace(marker, value)
    namespace = {"__name__": "runtime_under_test"}
    exec(compile(source, "<runtime-under-test>", "exec"), namespace)
    return namespace


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.runtime = runtime_namespace()
        self.temp = tempfile.TemporaryDirectory(prefix="qwen-runtime-test-", dir=Path.cwd())
        self.base = Path(self.temp.name)
        self.root = self.base / "input" / "cache"
        self.root.mkdir(parents=True)
        self.models = self.base / "working" / "ollama-models"
        (self.models / "blobs").mkdir(parents=True)
        self.metadata = self.fixture()
        self.cache = {"root": str(self.root), "manifest": self.metadata}
        discover = self.runtime["discover_cache"]
        self.runtime.update({
            "discover_cache": lambda **kwargs: discover(str(self.root.parent), **kwargs),
            "models_dir": lambda: (str(self.models), 100 << 30),
            "report": Mock(), "log": Mock(), "start_ollama": Mock(),
            "NotebookLogReporter": Mock(),
            "start_tunnel": Mock(return_value="https://example.trycloudflare.com"),
            "start_stream_proxy": Mock(),
            "install_async_job_routes": Mock(),
            "load_best": Mock(return_value=81920), "serve": Mock(),
            "sees_pictures": Mock(return_value=True),
            "http": Mock(return_value={"model_info": {}}),
            "fetch_model": Mock(side_effect=AssertionError("cache hit downloaded text weights")),
            "get_model": Mock(side_effect=AssertionError("cache hit fetched a model manifest")),
            "sh": Mock(side_effect=AssertionError("cache hit installed runtime from internet")),
        })

    def tearDown(self):
        for directory, _, files in os.walk(self.base):
            os.chmod(directory, stat.S_IRWXU)
            for name in files:
                path = Path(directory) / name
                if not path.is_symlink():
                    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
        self.temp.cleanup()

    def file(self, name, data, **metadata):
        destination = self.root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        return {"path": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), **metadata}

    def fixture(self):
        files = [self.file("model.gguf", b"cached-model", role="model"), self.file("projector.gguf", b"cached-projector", role="projector"), self.file("config.json", b'{"model_format":"gguf"}', role="config")]
        manifest = {
            "schemaVersion": 2,
            "config": {"digest": "sha256:" + files[2]["sha256"], "size": files[2]["size"]},
            "layers": [{"mediaType": "application/vnd.ollama.image." + f["role"], "digest": "sha256:" + f["sha256"], "size": f["size"]} for f in files[:2]],
        }
        manifest_file = self.file("manifest.json", json.dumps(manifest).encode())
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w:") as output:
            for name in ("bin/ollama", "lib/ollama/lib-test.so"):
                data = b"test runtime stand-in"
                item = tarfile.TarInfo(name)
                item.size = len(data)
                item.mode = 0o755
                output.addfile(item, io.BytesIO(data))
        metadata = {
            "schema": 1, "cache_id": "runtime-test-cache",
            "model": {"repo": self.runtime["REPO"], "name": self.runtime["MODEL"], "quant": self.runtime["QUANT"], "revision": "a" * 40, "manifest": manifest_file["path"], "manifest_sha256": manifest_file["sha256"], "files": files},
            "runtime": {"platform": "linux-amd64", "ollama": self.file("runtime.tar", archive.getvalue(), version="test", executable="bin/ollama"), "cloudflared": self.file("cloudflared", b"test tunnel stand-in", version="test")},
        }
        self.file("cache.json", json.dumps(metadata).encode())
        return metadata

    def require_symlinks(self):
        source, link = self.base / "probe", self.base / "probe-link"
        source.write_bytes(b"probe")
        try:
            os.symlink(source, link)
        except OSError as error:
            self.skipTest("OS symlink privilege unavailable: " + str(error))
        finally:
            if link.is_symlink():
                link.unlink()
            source.unlink()

    def readonly_snapshot(self):
        for path in self.root.rglob("*"):
            os.chmod(path, 0o555 if path.is_dir() else 0o444)
        os.chmod(self.root, 0o555)
        return self.snapshot()

    def snapshot(self):
        return {str(path.relative_to(self.root)): (path.read_bytes(), path.stat().st_mode) for path in self.root.rglob("*") if path.is_file()}

    def test_cache_hit_stages_readonly_weights_and_runtime_without_downloads(self):
        self.require_symlinks()
        before = self.readonly_snapshot()
        with patch("subprocess.run") as execute:
            self.runtime["main"]()
        self.runtime["fetch_model"].assert_not_called()
        self.runtime["get_model"].assert_not_called()
        self.runtime["sh"].assert_not_called()
        self.assertEqual(execute.call_count, 2)
        for call in execute.call_args_list:
            self.assertEqual(call.args[0][1:], ["--version"])
            self.assertTrue(Path(call.args[0][0]).is_file())
        self.runtime["http"].assert_called_once_with("POST", "http://127.0.0.1:11434/api/show", {"model": self.runtime["MODEL"]}, timeout=120)
        self.runtime["serve"].assert_called_once_with(81920, True, "Q5_K_P", "https://example.trycloudflare.com")

        self.runtime["install_async_job_routes"].assert_called_once_with(self.runtime["start_stream_proxy"].return_value, max_job_seconds=7200, max_stream_seconds=300)
        self.assertIs(self.runtime["OWNER_JOBS"], self.runtime["install_async_job_routes"].return_value)
        self.runtime["start_stream_proxy"].return_value.shutdown.assert_called_once()
        self.runtime["start_stream_proxy"].return_value.server_close.assert_called_once()
        self.assertEqual(self.runtime["PICTURES"].cache, self.cache)
        self.assertEqual(before, self.snapshot())
        for entry in self.metadata["model"]["files"]:
            path = self.models / "blobs" / ("sha256-" + entry["sha256"])
            self.assertEqual(path.is_symlink(), entry["role"] != "config")

    def test_absent_cache_uses_existing_download_and_install_flow(self):
        (self.root / "cache.json").unlink()
        fetched = ["downloaded-model", "downloaded-projector"]
        self.runtime["fetch_model"] = Mock(return_value=fetched)
        self.runtime["get_model"] = Mock(side_effect=lambda models, task: "Q5_K_P" if task.result() == fetched else "wrong")
        self.runtime["sh"] = Mock()
        actual_exists = os.path.exists
        with patch("shutil.which", return_value=None), patch("os.path.exists", side_effect=lambda path: False if path == "/usr/local/bin/cloudflared" else actual_exists(path)):
            self.runtime["main"]()
        self.runtime["fetch_model"].assert_called_once_with(str(self.models), 100 << 30)
        self.runtime["get_model"].assert_called_once()
        commands = "\n".join(call.args[0] for call in self.runtime["sh"].call_args_list)
        self.assertIn("https://ollama.com/install.sh", commands)
        self.assertIn("cloudflared/releases/latest", commands)
        self.assertIsNone(self.runtime["PICTURES"].cache)
        self.assertEqual(self.runtime["PROFILE_ID"], "")
        self.runtime["sees_pictures"].assert_called_once_with(81920)
        self.runtime["http"].assert_not_called()
        self.runtime["serve"].assert_called_once_with(81920, True, "Q5_K_P", "https://example.trycloudflare.com")
        self.runtime["install_async_job_routes"].assert_called_once_with(self.runtime["start_stream_proxy"].return_value, max_job_seconds=7200, max_stream_seconds=300)
        self.assertIs(self.runtime["OWNER_JOBS"], self.runtime["install_async_job_routes"].return_value)

    def test_unreadable_cached_model_unlinks_owned_links_before_downloading(self):
        self.require_symlinks()
        before = self.readonly_snapshot()
        unrelated_source = self.base / "unrelated-model"
        unrelated_source.write_bytes(b"unrelated")
        unrelated_link = self.models / "blobs" / "unrelated-link"
        os.symlink(unrelated_source, unrelated_link)
        regular = self.models / "blobs" / "keep-this-file"
        regular.write_bytes(b"keep")
        self.runtime["http"] = Mock(side_effect=RuntimeError("Ollama cannot read cached GGUF"))

        def download_to_writable_blobs(models, free_bytes):
            for entry in self.metadata["model"]["files"][:2]:
                path = Path(models) / "blobs" / ("sha256-" + entry["sha256"])
                self.assertFalse(os.path.lexists(path), "cache link must be removed before downloader writes")
                path.write_bytes(b"fresh downloaded bytes")
            return "downloaded"

        self.runtime["fetch_model"] = Mock(side_effect=download_to_writable_blobs)
        self.runtime["get_model"] = Mock(side_effect=lambda models, task: "Q5_K_P" if task.result() == "downloaded" else "wrong")
        with patch("subprocess.run"):
            self.runtime["main"]()
        self.runtime["fetch_model"].assert_called_once()
        self.runtime["get_model"].assert_called_once()
        self.assertTrue(unrelated_link.is_symlink())
        self.assertEqual(unrelated_source.read_bytes(), b"unrelated")
        self.assertEqual(regular.read_bytes(), b"keep")
        self.assertEqual(before, self.snapshot())
        self.runtime["serve"].assert_called_once_with(81920, True, "Q5_K_P", "https://example.trycloudflare.com")


    def test_pinned_profile_keeps_the_configured_model_precision_on_failure(self):
        runtime = runtime_namespace()
        runtime["install_manifest"] = Mock(side_effect=RuntimeError("synthetic source failure"))
        runtime["pull_fallback"] = Mock()
        runtime["log"] = Mock()
        runtime["report"] = Mock()
        fetched = Mock()
        fetched.result.return_value = []
        with self.assertRaisesRegex(RuntimeError, "configured Q5_K_P model is unavailable"):
            runtime["get_model"]("/unused", fetched)
        runtime["pull_fallback"].assert_not_called()
        runtime["CACHE_ID"] = ""
        self.assertEqual(runtime["get_model"]("/unused", fetched), "IQ3_M")
        runtime["pull_fallback"].assert_called_once()


class LoadStartupTests(unittest.TestCase):
    def setUp(self):
        self.runtime = runtime_namespace()
        self.runtime.update({"http": Mock(), "log": Mock(), "report": Mock()})

    def test_cold_load_has_bounded_stall_allowance_without_changing_precision(self):
        with tempfile.TemporaryDirectory(prefix="qwen-load-test-", dir=Path.cwd()) as directory:
            self.runtime["OLLAMA_LOG"] = str(Path(directory) / "ollama.log")
            with patch("subprocess.Popen") as process:
                self.runtime["start_ollama"]("/cached-models")
                launch = process.call_args
                launch.kwargs["stdout"].close()
        environment = launch.kwargs["env"]
        self.assertEqual(environment["OLLAMA_LOAD_TIMEOUT"], "10m")
        self.assertEqual(environment["OLLAMA_KV_CACHE_TYPE"], "q8_0")
        self.assertEqual(environment["OLLAMA_NUM_PARALLEL"], "1")
        self.assertEqual(environment["OLLAMA_MODELS"], "/cached-models")

    def test_warmup_and_vision_keep_the_website_runner_configuration(self):
        runtime = self.runtime
        runtime["BATCH_SIZE"] = 256
        original_profile = (runtime["MODEL"], runtime["QUANT"], runtime["PROFILE_ID"])
        runtime["http"].side_effect = [
            {},
            {"models": [{"name": runtime["MODEL"] + ":latest", "size_vram": 100, "size": 100}]},
            {"message": {"content": "red"}},
        ]
        with tempfile.TemporaryDirectory(prefix="qwen-load-test-", dir=Path.cwd()) as directory:
            runtime["OLLAMA_LOG"] = str(Path(directory) / "unused.log")
            self.assertTrue(runtime["load"](98304))
            self.assertTrue(runtime["sees_pictures"](98304))
        posts = [call for call in runtime["http"].call_args_list if call.args[0] == "POST"]
        self.assertEqual([call.args[1] for call in posts], ["http://127.0.0.1:11434/api/generate", "http://127.0.0.1:11434/api/chat"])
        for call in posts:
            request = call.args[2]
            self.assertIs(request["shift"], False)
            self.assertEqual(request["model"], original_profile[0])
            self.assertEqual(request["options"]["num_ctx"], 98304)
            self.assertEqual(request["options"]["num_batch"], 256)
        self.assertEqual((runtime["MODEL"], runtime["QUANT"], runtime["PROFILE_ID"]), original_profile)

    def test_personal_cold_load_and_warmup_allow_two_hours_without_changing_profile(self):
        runtime = self.runtime
        runtime["AGENT_ONLY"] = True
        runtime["BATCH_SIZE"] = 256
        with tempfile.TemporaryDirectory(prefix="qwen-agent-load-", dir=Path.cwd()) as directory:
            runtime["OLLAMA_LOG"] = str(Path(directory) / "ollama.log")
            with patch("subprocess.Popen") as process:
                runtime["start_ollama"]("/cached-models")
                launch = process.call_args
                launch.kwargs["stdout"].close()
            self.assertEqual(launch.kwargs["env"]["OLLAMA_LOAD_TIMEOUT"], "2h")
            runtime["http"].reset_mock()
            runtime["http"].return_value = {"models": [{"name": runtime["MODEL"], "size": 100, "size_vram": 100}]}
            self.assertTrue(runtime["load"](98304))
            loaded = next(call for call in runtime["http"].call_args_list if call.args[0] == "POST")
            self.assertEqual(loaded.kwargs["timeout"], 7200)
            self.assertEqual(loaded.args[2]["options"], {"num_ctx": 98304, "num_batch": 256})

    def test_personal_serve_reports_active_job_lease_and_applies_scoped_stop(self):
        from types import SimpleNamespace
        runtime = self.runtime
        owner = "12345678-1234-1234-1234-123456789abc"
        jobs = Mock()
        jobs.active_generations.return_value = [owner]
        relay = Mock(side_effect=lambda method, path, *args: {"registered": True, "client_active": True,
                         "client_idle_seconds": 0, "stop_generations": [owner]} if method == "GET" else {})
        runtime.update({"AGENT_ONLY": True, "PERSONAL_JOBS": jobs, "relay": relay,
                        "STARTED": 1000, "MAX_RUNTIME_S": 1000, "requests_served": lambda: 0,
                        "gpu_busy": lambda: False, "PICTURES": Mock(),
                        "time": SimpleNamespace(time=lambda: 1000, sleep=Mock(side_effect=[None, KeyboardInterrupt]))})
        with self.assertRaises(KeyboardInterrupt):
            runtime["serve"](98304, False, "Q5_K_P", "https://example.trycloudflare.com")
        registration = relay.call_args_list[0].args[2]
        self.assertTrue(registration["job_control"])
        self.assertEqual(registration["job_max_leg_seconds"], 300)
        command = next(call.args[1] for call in relay.call_args_list if call.args[0] == "GET")
        self.assertIn("&active_generation=" + owner, command)
        jobs.cancel_generations.assert_called_once_with([owner])

    def test_owner_active_job_prevents_idle_shutdown_during_two_hours_of_quiet_prefill(self):
        from types import SimpleNamespace
        runtime = self.runtime
        now = [1000]
        ticks = [0]

        def tick(_seconds):
            if ticks[0] == 2:
                raise KeyboardInterrupt
            ticks[0] += 1
            now[0] += 3600

        jobs = Mock()
        jobs.busy.return_value = True
        relay = Mock(side_effect=lambda method, path, *args: {"registered": True, "idle_minutes": 45} if method == "GET" else {})
        runtime.update({"AGENT_ONLY": False, "OWNER_JOBS": jobs, "relay": relay,
                        "STARTED": 1000, "MAX_RUNTIME_S": 3 * 3600, "requests_served": lambda: 0,
                        "gpu_busy": lambda: False, "PICTURES": Mock(), "reachable": lambda _url: True,
                        "time": SimpleNamespace(time=lambda: now[0], sleep=tick)})
        with self.assertRaises(KeyboardInterrupt):
            runtime["serve"](98304, True, "Q5_K_P", "https://example.trycloudflare.com")
        self.assertEqual(jobs.busy.call_count, 2)
        registration = relay.call_args_list[0].args[2]
        self.assertEqual(registration["job_max_leg_seconds"], 300)
        self.assertNotIn("job_control", registration)
        commands = [call.args[1] for call in relay.call_args_list if call.args[0] == "GET"]
        self.assertEqual(len(commands), 2)
        self.assertTrue(all("&idle=0" in command for command in commands))

    def test_local_load_error_keeps_bounded_reason_without_secrets_or_body_dump(self):
        runtime = self.runtime
        runtime["BATCH_SIZE"] = 256
        runtime["LAUNCH_TOKEN"] = "private-launch-token"
        runtime["RELAY"] = "https://relay.private.invalid"

        class TrackedBytes(io.BytesIO):
            def read(self, size=-1):
                self.read_size = size
                return super().read(size)

        body = TrackedBytes(json.dumps({
            "error": "timed out waiting for llama-server\nhttps://temporary.trycloudflare.com private-launch-token " + "x" * 500,
            "private": "unrelated-private-body-field",
        }).encode())
        runtime["http"].side_effect = HTTPError("http://127.0.0.1:11434/api/generate", 500, "Internal Server Error", {}, body)
        with patch("os.path.exists", return_value=False):
            with self.assertRaises(RuntimeError) as raised:
                runtime["load"](98304)
        message = str(raised.exception)
        self.assertIn("HTTP 500", message)
        self.assertIn("timed out waiting for llama-server", message)
        self.assertNotIn("trycloudflare", message)
        self.assertNotIn("private-launch-token", message)
        self.assertNotIn("unrelated-private-body-field", message)
        self.assertNotIn("\n", message)
        self.assertLessEqual(len(message), 230)
        self.assertEqual(body.read_size, 4096)
        self.assertTrue(body.closed)
        self.assertEqual(runtime["http"].call_args.kwargs["timeout"], 1800)
        self.assertEqual(runtime["http"].call_args.args[2]["options"], {"num_ctx": 98304, "num_batch": 256})

    def test_unrecognized_load_error_body_is_not_logged(self):
        for payload in (b"private unstructured failure", b'{"error":{"private":"value"}}', b'{"error":"' + b"x" * 5000 + b'"}'):
            with self.subTest(payload_length=len(payload)):
                body = io.BytesIO(payload)
                self.runtime["http"].side_effect = HTTPError("http://127.0.0.1:11434/api/generate", 500, "Internal Server Error", {}, body)
                with patch("os.path.exists", return_value=False):
                    with self.assertRaisesRegex(RuntimeError, r"^Ollama model load failed \(HTTP 500\)$"):
                        self.runtime["load"](98304)
                self.assertTrue(body.closed)

    def test_operational_failure_does_not_teach_a_lower_profile_limit(self):
        self.runtime["CONTEXTS"] = [98304, 81920]
        self.runtime["load"] = Mock(side_effect=[RuntimeError("synthetic load failure"), True])
        self.assertEqual(self.runtime["load_best"](), 81920)
        self.assertEqual(self.runtime["PROFILE_ID"], "")
        self.assertEqual([call.args[0] for call in self.runtime["load"].call_args_list], [98304, 81920])

    def test_partial_gpu_fit_still_teaches_the_measured_lower_limit(self):
        self.runtime["CONTEXTS"] = [98304, 81920]
        profile = self.runtime["PROFILE_ID"]
        self.runtime["load"] = Mock(side_effect=[False, True])
        self.assertEqual(self.runtime["load_best"](), 81920)
        self.assertEqual(self.runtime["PROFILE_ID"], profile)


if __name__ == "__main__":
    unittest.main(verbosity=2)
