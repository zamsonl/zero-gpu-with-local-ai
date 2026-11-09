"""Rebuild the credential-free Colab download from checked-in shared helpers and runner."""
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
PARTS = ("notebook-log.py", "kaggle-cache.py", "kaggle-stream-proxy.py", "kaggle-jobs.py", "kaggle-server.py")


def deployment_origin():
    if '--public' in sys.argv:
        return ''
    for name in ('deployment.local.json', 'deployment.json'):
        file = ROOT.parent / 'client' / 'agent' / name
        if file.exists():
            value = json.loads(file.read_text(encoding='utf-8')).get('relay_origin', '')
            if not value:
                return ''
            parsed=urlsplit(value)
            if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
                raise ValueError('Invalid configured relay origin')
            return parsed.scheme+'://'+parsed.netloc
    return ''


def shared_runtime_source():
    source = "\n\n".join((ROOT / "src" / name).read_text(encoding="utf-8") for name in PARTS)
    replacements = {"__RELAY__": repr(deployment_origin()), "__LAUNCH_TOKEN__": repr(""),
                    "__QUANT__": repr("Q6_K"), "__CACHE_ID__": repr(""), "__BATCH_SIZE__": "128",
                    "__PROFILE_ID__": repr("colab-9b-q6-kv8-b128-32k"), "__CONTEXTS__": "[32768, 24576, 16384, 8192]", "__VISION__": "None"}
    for marker, value in replacements.items():
        source = source.replace(marker, value)
    compile(source, "<shared-colab-runtime>", "exec")
    return source


def notebook():
    introduction = """# Heretic Qwen — Colab

This notebook uses the same checked-in runtime as Kaggle: **Qwen3.5 9B uncensored Q6_K, up to 32,768 context tokens by default, batch 128 and q8_0 KV**, plus image attachments, **Qwen-Image 2.1 Images mode**, live operational logs, chat/image switching and website shutdown controls. Thinking, saved chat history, automatic compaction, document reading and Answer now remain in your existing Cloudflare website.

1. Select a **GPU runtime with enough memory**. This smaller model targets a single 16GB T4. Model-file memory is checked before downloads. Context is tried at 32,768, then 24,576, 16,384 and 8,192 tokens, keeping the same 9B Q6_K model entirely on GPU. The website displays the context that actually loaded; available hardware is not guaranteed. Kaggle keeps its existing 27B profile.
2. In **Secrets** (the key icon), add **QWEN_RELAY_KEY** with your existing relay key and enable notebook access. Otherwise the server cell asks in a hidden input. Never put it in notebook source or share it.
3. Choose **Runtime → Run all** and keep the notebook connected. Return to the website for live startup logs, chat and Images mode. The notebook unloads chat before handing the GPU to the image model and restores chat when you switch back.

Model/runtime/image files already present in this Colab VM are reused. A fresh VM needs cloud-side downloads again and cannot mount your private Kaggle dataset. This notebook creates no paid cache and uses no external AI provider.

Colab determines hardware availability and runtime limits. Read [Colab's FAQ](https://research.google.com/colaboratory/faq.html) for service restrictions; a selected software profile cannot guarantee hardware or uptime. Stop the server cell and disconnect the Colab runtime when finished; stopping a reply alone does not disconnect its GPU runtime.
"""
    configuration = """# Colab uses the smaller Qwen 9B model. The notebook measures context fit on your GPU.
COLAB_CONFIG = {
    "RELAY": __DEPLOYMENT_ORIGIN__,  # Your own deployment; asked interactively if blank.
    "CONTEXT": 32768,
    "MODEL_DIR": "/content/ollama-models",  # Reused by reruns in this VM.
}
"""
    configuration = configuration.replace('__DEPLOYMENT_ORIGIN__', repr(deployment_origin()))
    runner = "#@title Start Qwen chat, vision and Images with the same runtime as Kaggle\nCOLAB_RUNTIME_SOURCE = " + repr(shared_runtime_source()) + "\n\n" + (ROOT / "src/colab-server.py").read_text(encoding="utf-8")
    def cell(kind, source):
        return {"cell_type": kind, "metadata": {}, "source": source.splitlines(keepends=True), **({"execution_count": None, "outputs": []} if kind == "code" else {})}
    return {
        "nbformat": 4, "nbformat_minor": 5,
        "metadata": {"colab": {"name": "Heretic Qwen Colab.ipynb", "provenance": []}, "accelerator": "GPU", "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}},
        "cells": [cell("markdown", introduction), cell("code", configuration), cell("code", runner)],
    }


if __name__ == "__main__":
    destination = ROOT / "public/notebooks/heretic-qwen-colab.ipynb"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(notebook(), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("Built", destination.name)
