"""
Builds notebooks/kaggle.ipynb and notebooks/colab.ipynb from server/server.py.

    python tools/build_notebooks.py            # write both notebooks
    python tools/build_notebooks.py --check    # only check: exit 1 if either is out of date
    python tools/build_notebooks.py --out DIR  # write them somewhere else

Run it again whenever server/server.py changes. The same server.py always gives the same bytes.

Each notebook has three cells: how to run it on that platform, the CONFIG settings (one entry per
key of server.py's DEFAULTS, with its default value), and server.py itself, unchanged.
"""

import argparse
import ast
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SERVER = ROOT / "server" / "server.py"
OUT = ROOT / "notebooks"
PLATFORMS = ("kaggle", "colab")

TITLE = "Hardware limits for local AI? Fixed."
COLAB_TITLE = '#@title The server (no need to change anything here) { display-mode: "form" }'

# One line per setting. A key server.py adds later and this list doesn't know yet gets the first
# sentence of its comment in server.py instead.
COMMENTS = {
    "MODEL": '"auto" is {auto_label}, in the size that fits this GPU. Other choices are listed below.',
    "LABEL": "The name the chat app shows for the model. Empty: worked out from MODEL.",
    "CONTEXT": 'Tokens of conversation the model keeps in mind. "auto": the most that fits on the GPU, or a number like 16384.',
    "IDLE_MINUTES": "Shut down after this many minutes without a message, to save GPU time. 0: run until the session ends.",
    "KEY": "The key the chat needs. Empty: your NO_GPU_KEY secret if you added one, else a new random key each run.",
    "APP_URL": "The chat app the ready link opens. Your own copy of web/index.html works too.",
}

MODEL_EXAMPLES = """\
# Other models to try. Any Ollama library name (ollama.com/library) or GGUF on Hugging Face
# ("hf.co/<user>/<repo>:<quant>") works. Roughly, the model plus a few GB for the conversation
# has to fit in GPU memory: up to about 13 GB of model on one T4 (Colab, 15 GB), and up to
# about 25 GB on two T4s (Kaggle, 30 GB). Bigger ones spill onto the CPU and get very slow.
#
#   "MODEL": "qwen3:14b",                            # 9.3 GB, fits one T4
#   "MODEL": "gemma3:12b",                           # 8.2 GB, fits one T4, reads pictures
#   "MODEL": "hf.co/unsloth/Qwen3-14B-GGUF:Q4_K_M",  # 9.0 GB, fits one T4
#   "MODEL": "qwen3:32b",                            # 20 GB, needs two T4s
#   "MODEL": "gemma3:27b",                           # 17 GB, needs two T4s, reads pictures
#   "MODEL": "hf.co/unsloth/Qwen3-32B-GGUF:Q4_K_M",  # 19.8 GB, needs two T4s
#
# 70B models are too big even for two T4s (llama3.3:70b is 43 GB).
"""

KAGGLE_INTRO = """\
# {title}

This notebook runs a large open model on Kaggle's free GPUs (two T4s, with 30 GB of memory between them) and prints a link for chatting with it from your browser or terminal. By default it runs {auto_label}, in the size that fits two T4s. You can pick a different model in the next cell.

**Before the first run**

1. Use a Kaggle account with a verified phone number (account Settings, then Phone verification). Kaggle only gives GPUs and internet access to verified accounts. Kaggle's phone verification often fails (no code arrives, or it says too many requests): don't keep retrying, submit a request on Kaggle's help form at https://www.kaggle.com/contact and ask them to verify your account.
2. In the notebook's **Settings** panel, set **Accelerator** to **GPU T4 x2** and turn **Internet** on.
3. Optional: to keep the same key from one session to the next, open **Add-ons → Secrets**, add a secret named `NO_GPU_KEY` with any long random value, and attach it to this notebook. Without it you get a new key every session.

**Run it** in one of two ways:

- Press **Run All** and watch the output here. Keep this tab open while you chat.
- Or use **Save Version**, choose **Save & Run All (Commit)** and save. It runs in the background, so you can close the tab. The link shows up in the run's log: open **View Active Events** (bottom left), then that run's log. Keep the notebook private, because the log contains your key.

**When it's ready**, after a few minutes (most of it is the model download), the output says READY. Click **Open the chat**, or copy the link under it. The link carries the server address and the key, so don't share it.

**Save your GPU hours.** Kaggle gives you 30 GPU hours a week and ends a session after 12 hours. When you're done, use **Shut the server down** in the chat's menu (top right), or {idle_timer}. If you used Run All, also stop the session with the power button at the top right, because Kaggle counts the hours until the session itself ends.
"""

COLAB_INTRO = """\
# {title}

This notebook runs a large open model on Colab's free T4 GPU (15 GB of memory) and prints a link for chatting with it from your browser or terminal. By default it runs {auto_label}, in the smaller size that fits one T4. You can pick a different model in the next cell.

**Please read this first.** Colab's free tier doesn't allow every use. Its FAQ lists using a web UI instead of the notebook, and offering web services, among the things free sessions are not for. This setup does both, so Colab may end the session early or limit your account. Kaggle is the recommended way to run this (`kaggle.ipynb` in the same folder, which also gets two GPUs). If you use Colab anyway, it's at your own risk.

**Steps**

1. **Runtime → Change runtime type**, pick **T4 GPU** and save. Free T4s aren't always available. If Colab can't give you one, try again later.
2. Optional: to keep the same key from one session to the next, click the key icon in the left sidebar (Secrets), add a secret named `NO_GPU_KEY` with any long random value, and turn on **Notebook access**. Without it you get a new key every session.
3. **Runtime → Run all**. If Colab warns that the notebook wasn't written by Google, choose **Run anyway**. Keep this tab open while you chat.

**When it's ready**, after a few minutes (most of it is the model download), the output says READY. Click **Open the chat**, or copy the link under it. The link carries the server address and the key, so don't share it.

**When you're done**, use **Shut the server down** in the chat's menu (top right), or {idle_timer}. Either way the notebook gives the GPU back to Colab.
"""

KAGGLE_METADATA = {
    "kaggle": {
        "accelerator": "nvidiaTeslaT4",
        "dataSources": [],
        "isGpuEnabled": True,
        "isInternetEnabled": True,
        "language": "python",
        "sourceType": "notebook",
    },
    "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
    "language_info": {
        "codemirror_mode": {"name": "ipython", "version": 3},
        "file_extension": ".py",
        "mimetype": "text/x-python",
        "name": "python",
        "nbconvert_exporter": "python",
        "pygments_lexer": "ipython3",
    },
}

COLAB_METADATA = {
    "accelerator": "GPU",
    "colab": {"gpuType": "T4", "name": "no-gpu-local-ai.ipynb", "provenance": []},
    "kernelspec": {"display_name": "Python 3", "name": "python3"},
    "language_info": {"name": "python"},
}


# ---------------------------------------------------------------------------------- reading server.py


def read_server(path):
    """server.py as text with LF newlines (the notebooks run on Linux)."""
    text = pathlib.Path(path).read_bytes().decode("utf-8").replace("\r\n", "\n")
    try:  # a broken server.py should fail here, not in someone's notebook
        compile(text, str(path), "exec")
    except SyntaxError as err:
        raise SystemExit(f"{path} doesn't compile (line {err.lineno}): {err.msg}")
    return text


def _assignment(tree, name):
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return node.value
    return None


def read_defaults(text):
    """[(key, default, first sentence of its comment in server.py)] in DEFAULTS order."""
    tree = ast.parse(text)
    node = _assignment(tree, "DEFAULTS")
    if not isinstance(node, ast.Dict):
        raise SystemExit("server.py has no DEFAULTS = {...} dict to build CONFIG from")
    lines = text.split("\n")
    defaults = []
    for key_node, value_node in zip(node.keys, node.values):
        if key_node is None:
            raise SystemExit("server.py's DEFAULTS must list its keys one by one (no **spread)")
        key = ast.literal_eval(key_node)
        value = ast.literal_eval(value_node)
        # The comment lines right above the key, as server.py writes them.
        comment = []
        row = key_node.lineno - 2
        while row >= 0 and lines[row].strip().startswith("#"):
            comment.insert(0, lines[row].strip().lstrip("#").strip())
            row -= 1
        sentence = " ".join(comment).split(". ")[0].rstrip(".")
        defaults.append((key, value, sentence + "." if sentence else ""))
    return defaults


def read_constant(text, name, fallback):
    node = _assignment(ast.parse(text), name)
    try:
        return ast.literal_eval(node) if node is not None else fallback
    except ValueError:
        return fallback


# ---------------------------------------------------------------------------------- the cells


def py_literal(value):
    """The value as Python source, with double-quoted strings like the rest of the project."""
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)  # JSON string escapes are valid Python too
    return repr(value)


def source_lines(text):
    """A cell's source in the list-of-lines form Jupyter uses; joining it gives `text` back exactly."""
    parts = text.split("\n")
    lines = [part + "\n" for part in parts[:-1]]
    if parts[-1]:
        lines.append(parts[-1])
    return lines


def config_source(defaults, auto_label):
    out = ["# Settings. The defaults work as they are; change something only if you want to, then run all cells.", "CONFIG = {"]
    for key, value, fallback in defaults:
        comment = COMMENTS[key].format(auto_label=auto_label) if key in COMMENTS else fallback
        if comment:
            out.append(f"    # {comment}")
        out.append(f"    {json.dumps(key)}: {py_literal(value)},")
    out.append("}")
    return "\n".join(out) + "\n\n" + MODEL_EXAMPLES.rstrip("\n")


def idle_timer(defaults):
    idle = next((value for key, value, _ in defaults if key == "IDLE_MINUTES"), None)
    if isinstance(idle, int) and not isinstance(idle, bool) and idle > 0:
        return f"let the idle timer stop it after {idle} minutes without a message (`IDLE_MINUTES` below)"
    return "set `IDLE_MINUTES` below so it stops by itself when nobody is using it"


def markdown_cell(cell_id, text):
    return {"cell_type": "markdown", "id": cell_id, "metadata": {}, "source": source_lines(text.rstrip("\n"))}


def code_cell(cell_id, text, metadata=None):
    return {"cell_type": "code", "execution_count": None, "id": cell_id, "metadata": metadata or {}, "outputs": [], "source": source_lines(text)}


def notebook(platform, server_text):
    defaults = read_defaults(server_text)
    auto_label = read_constant(server_text, "AUTO_LABEL", "the uncensored Qwen 3.8 27B")
    words = {"title": TITLE, "auto_label": auto_label, "idle_timer": idle_timer(defaults)}
    settings = code_cell("settings", config_source(defaults, auto_label))
    if platform == "kaggle":
        intro = markdown_cell("intro", KAGGLE_INTRO.format(**words))
        # Collapsed in the editor (source_hidden) and in Kaggle's viewer (_kg_hide-input).
        server = code_cell("server", server_text, {"_kg_hide-input": True, "jupyter": {"source_hidden": True}})
        metadata = KAGGLE_METADATA
    elif platform == "colab":
        intro = markdown_cell("intro", COLAB_INTRO.format(**words))
        # The #@title line plus cellView "form" shows the cell as its title, with the code folded away.
        server = code_cell("server", COLAB_TITLE + "\n" + server_text, {"cellView": "form"})
        metadata = COLAB_METADATA
    else:
        raise ValueError(platform)
    return {"cells": [intro, settings, server], "metadata": metadata, "nbformat": 4, "nbformat_minor": 5}


def render(nb):
    """Jupyter's own on-disk layout (indent 1, sorted keys), UTF-8, LF, one trailing newline."""
    return (json.dumps(nb, indent=1, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def build(server_path=SERVER):
    """{file name: bytes} for both notebooks."""
    text = read_server(server_path)
    return {f"{platform}.ipynb": render(notebook(platform, text)) for platform in PLATFORMS}


# ---------------------------------------------------------------------------------- main


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server", default=str(SERVER), help="the server.py to build from")
    parser.add_argument("--out", default=str(OUT), help="the folder the notebooks go in")
    parser.add_argument("--check", action="store_true", help="write nothing; exit 1 if a notebook is missing or out of date")
    args = parser.parse_args(argv)

    out = pathlib.Path(args.out)
    stale = []
    for name, data in build(args.server).items():
        path = out / name
        current = path.read_bytes() if path.exists() else None
        if current == data:
            print(f"{path}: up to date")
            continue
        stale.append(path)
        if args.check:
            print(f"{path}: out of date (run python tools/build_notebooks.py)")
            continue
        out.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        print(f"{path}: written")
    return 1 if args.check and stale else 0


if __name__ == "__main__":
    sys.exit(main())
