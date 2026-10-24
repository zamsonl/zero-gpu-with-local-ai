"""
Tests for notebooks/kaggle.ipynb and notebooks/colab.ipynb: valid nbformat 4 JSON, server/server.py
carried over unchanged, a CONFIG cell that runs and matches server.py's DEFAULTS, and exactly what
tools/build_notebooks.py makes from the current server.py, so a stale notebook fails here.
Run from the repository root:  python -m unittest discover tests
"""

import ast
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SERVER = ROOT / "server" / "server.py"
NOTEBOOKS = ROOT / "notebooks"
BUILD = ROOT / "tools" / "build_notebooks.py"
NAMES = ("kaggle.ipynb", "colab.ipynb")
TITLE = "# Hardware limits for local AI? Fixed."
COLAB_TITLE = '#@title The server (no need to change anything here) { display-mode: "form" }'
CELL_ID = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
REBUILD = "run: python tools/build_notebooks.py"


def server_text(path=SERVER):
    return pathlib.Path(path).read_bytes().decode("utf-8")


def defaults(text):
    """server.py's DEFAULTS, read without importing it."""
    for node in ast.parse(text).body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "DEFAULTS" for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError("no DEFAULTS in server.py")


def load(path):
    return json.loads(pathlib.Path(path).read_bytes().decode("utf-8"))


def source(cell):
    return "".join(cell["source"])


def build(*args):
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    return subprocess.run([sys.executable, str(BUILD), *args], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)


def run_config_cell(cell):
    namespace = {"__name__": "config_cell"}
    exec(compile(source(cell), "<config cell>", "exec"), namespace)
    return namespace["CONFIG"]


class Notebooks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = [name for name in NAMES if not (NOTEBOOKS / name).exists()]
        if missing:
            raise AssertionError(f"missing {', '.join(missing)}; {REBUILD}")
        cls.raw = {name: (NOTEBOOKS / name).read_bytes() for name in NAMES}
        cls.nb = {name: json.loads(raw.decode("utf-8")) for name, raw in cls.raw.items()}
        cls.server = server_text()
        cls.defaults = defaults(cls.server)

    def test_both_are_nbformat_4_notebooks(self):
        for name, nb in self.nb.items():
            with self.subTest(name):
                self.assertEqual(set(nb), {"cells", "metadata", "nbformat", "nbformat_minor"})
                self.assertEqual(nb["nbformat"], 4)
                self.assertGreaterEqual(nb["nbformat_minor"], 5)  # cell ids need 4.5
                self.assertEqual(nb["metadata"]["kernelspec"]["name"], "python3")
                self.assertEqual(nb["metadata"]["language_info"]["name"], "python")
                self.assertEqual([c["cell_type"] for c in nb["cells"]], ["markdown", "code", "code"])
                ids = [c["id"] for c in nb["cells"]]
                self.assertEqual(len(set(ids)), len(ids))
                for cell in nb["cells"]:
                    self.assertRegex(cell["id"], CELL_ID)
                    self.assertIsInstance(cell["metadata"], dict)
                    self.assertTrue(cell["source"] and all(isinstance(line, str) for line in cell["source"]))
                    # Jupyter's line form: every line but the last ends in a newline.
                    self.assertTrue(all(line.endswith("\n") for line in cell["source"][:-1]))
                    if cell["cell_type"] == "code":
                        self.assertIsNone(cell["execution_count"])
                        self.assertEqual(cell["outputs"], [])
                        compile(source(cell), name, "exec")
                    else:
                        self.assertNotIn("outputs", cell)
                        self.assertNotIn("execution_count", cell)

    def test_files_are_utf8_with_lf_newlines(self):
        for name, raw in self.raw.items():
            with self.subTest(name):
                self.assertNotIn(b"\r", raw)
                self.assertTrue(raw.endswith(b"}\n"))
                raw.decode("utf-8")

    def test_the_server_cell_is_server_py_unchanged(self):
        kaggle = self.nb["kaggle.ipynb"]["cells"][2]
        self.assertEqual(source(kaggle), self.server, f"kaggle.ipynb's server cell differs from server/server.py; {REBUILD}")
        self.assertIs(kaggle["metadata"]["jupyter"]["source_hidden"], True)

        colab = self.nb["colab.ipynb"]["cells"][2]
        title, _, rest = source(colab).partition("\n")
        self.assertEqual(title, COLAB_TITLE)
        self.assertEqual(rest, self.server, f"colab.ipynb's server cell differs from server/server.py; {REBUILD}")
        self.assertEqual(colab["metadata"].get("cellView"), "form")

    def test_the_config_cell_runs_and_matches_the_defaults(self):
        for name, nb in self.nb.items():
            with self.subTest(name):
                cell = nb["cells"][1]
                config = run_config_cell(cell)
                self.assertEqual(list(config), list(self.defaults), f"CONFIG keys differ from DEFAULTS; {REBUILD}")
                self.assertEqual(config, self.defaults)
                lines = source(cell).split("\n")
                for key in self.defaults:
                    row = next(i for i, line in enumerate(lines) if line.startswith(f'    "{key}":'))
                    self.assertTrue(lines[row - 1].startswith("    # "), f"{key} has no comment line")
                text = source(cell)
                self.assertRegex(text, r'"MODEL": "(qwen3|gemma3):\d+b"')
                self.assertRegex(text, r'"MODEL": "hf\.co/[^/"]+/[^:"]+:\w+"')
                self.assertIn("one T4", text)
                self.assertIn("two T4s", text)

    def test_run_in_order_the_server_cell_picks_up_config(self):
        # As in the notebook, both cells share one namespace. Not "__main__", so main() never runs.
        for name, nb in self.nb.items():
            with self.subTest(name):
                namespace = {"__name__": "notebook_cells"}
                exec(compile(source(nb["cells"][1]), "<config cell>", "exec"), namespace)
                namespace["CONFIG"]["MODEL"] = "gemma3:27b"
                namespace["CONFIG"]["IDLE_MINUTES"] = 5
                exec(compile(source(nb["cells"][2]), "<server cell>", "exec"), namespace)
                self.assertEqual(namespace["config"]["MODEL"], "gemma3:27b")
                self.assertEqual(namespace["config"]["IDLE_MINUTES"], 5)
                self.assertEqual(set(namespace["config"]), set(self.defaults))

    def test_the_first_cell_explains_that_platform(self):
        kaggle = source(self.nb["kaggle.ipynb"]["cells"][0])
        colab = source(self.nb["colab.ipynb"]["cells"][0])
        for text in (kaggle, colab):
            self.assertTrue(text.startswith(TITLE + "\n"))
            self.assertIn("NO_GPU_KEY", text)
            self.assertIn("READY", text)
            self.assertIn("Open the chat", text)
        for words in ("phone", "GPU T4 x2", "Internet", "Add-ons → Secrets", "Run All", "Save Version", "Save & Run All (Commit)", "30 GPU hours"):
            self.assertIn(words, kaggle)
        for words in ("Runtime → Change runtime type", "T4 GPU", "Notebook access", "Runtime → Run all", "Keep this tab open", "FAQ", "Kaggle is the recommended", "own risk"):
            self.assertIn(words, colab)

    def test_platform_metadata(self):
        kaggle = self.nb["kaggle.ipynb"]["metadata"]
        self.assertEqual(
            kaggle["kaggle"],
            {"accelerator": "nvidiaTeslaT4", "dataSources": [], "isGpuEnabled": True, "isInternetEnabled": True, "language": "python", "sourceType": "notebook"},
        )
        colab = self.nb["colab.ipynb"]["metadata"]
        self.assertEqual(colab["accelerator"], "GPU")
        self.assertEqual(colab["colab"]["gpuType"], "T4")
        self.assertEqual(colab["colab"]["provenance"], [])
        self.assertTrue(colab["colab"]["name"])
        self.assertNotIn("kaggle", colab)
        self.assertNotIn("colab", kaggle)


class Generator(unittest.TestCase):
    def test_it_reproduces_the_committed_notebooks_byte_for_byte(self):
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            for out in (first, second):
                result = build("--out", out)
                self.assertEqual(result.returncode, 0, result.stderr)
            for name in NAMES:
                built = (pathlib.Path(first) / name).read_bytes()
                self.assertEqual(built, (pathlib.Path(second) / name).read_bytes(), f"{name}: two runs differ")
                committed = (NOTEBOOKS / name).read_bytes() if (NOTEBOOKS / name).exists() else b""
                self.assertEqual(built, committed, f"notebooks/{name} is out of date; {REBUILD}")

    def test_check_mode_flags_a_stale_notebook_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as out:
            self.assertEqual(build("--out", out).returncode, 0)
            self.assertEqual(build("--check", "--out", out).returncode, 0)
            stale = pathlib.Path(out) / "colab.ipynb"
            stale.write_bytes(stale.read_bytes().replace(b"T4", b"K80", 1))
            before = stale.read_bytes()
            result = build("--check", "--out", out)
            self.assertEqual(result.returncode, 1)
            self.assertIn("colab.ipynb", result.stdout)
            self.assertEqual(stale.read_bytes(), before)
            (pathlib.Path(out) / "kaggle.ipynb").unlink()
            self.assertEqual(build("--check", "--out", out).returncode, 1)

    def test_a_changed_server_py_flows_into_both_notebooks(self):
        original = server_text()
        self.assertIn("DEFAULTS = {\n", original)
        changed = original.replace("DEFAULTS = {\n", 'DEFAULTS = {\n    # Seconds to wait first. More detail on a second line.\n    "NEW_SETTING": 7,\n', 1)
        changed += "\n# a later edit\n"
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "server.py"
            path.write_bytes(changed.encode("utf-8"))
            out = pathlib.Path(tmp) / "out"
            result = build("--server", str(path), "--out", str(out))
            self.assertEqual(result.returncode, 0, result.stderr)
            for name in NAMES:
                with self.subTest(name):
                    nb = load(out / name)
                    server_cell = source(nb["cells"][2])
                    if name == "colab.ipynb":
                        server_cell = server_cell.partition("\n")[2]
                    self.assertEqual(server_cell, changed)
                    config = run_config_cell(nb["cells"][1])
                    self.assertEqual(list(config), list(defaults(changed)))
                    self.assertEqual(config["NEW_SETTING"], 7)
                    self.assertIn("    # Seconds to wait first.\n", source(nb["cells"][1]))

    def test_a_broken_server_py_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "server.py"
            path.write_text("DEFAULTS = {\n", encoding="utf-8")
            result = build("--server", str(path), "--out", str(pathlib.Path(tmp) / "out"))
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((pathlib.Path(tmp) / "out").exists())


if __name__ == "__main__":
    unittest.main()
