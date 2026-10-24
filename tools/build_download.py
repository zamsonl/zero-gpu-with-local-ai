"""
Builds "DOWNLOAD ME.zip" at the top of the repo: everything someone needs to run it, in one
download, inside a no-gpu-local-ai/ folder. Run it after changing any file it contains:

    python tools/build_download.py

Entries are sorted and dated 2026-01-01, so a rebuild of unchanged files has the same contents.
tests/test_download.py fails when the zip and the files in the repo disagree.
"""

import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
ZIP = ROOT / "DOWNLOAD ME.zip"
FOLDER = "no-gpu-local-ai/"
# (file in the repo, name inside the zip)
FILES = [
    ("docs/START-HERE.txt", "START HERE.txt"),
    ("README.md", "README.md"),
    ("LICENSE", "LICENSE"),
    ("notebooks/kaggle.ipynb", "notebooks/kaggle.ipynb"),
    ("notebooks/colab.ipynb", "notebooks/colab.ipynb"),
    ("web/index.html", "web/index.html"),
    ("cli/chat.mjs", "cli/chat.mjs"),
]
STAMP = (2026, 1, 1, 0, 0, 0)


def build(out=ZIP):
    with zipfile.ZipFile(out, "w") as archive:
        for source, name in sorted(FILES, key=lambda pair: pair[1]):
            info = zipfile.ZipInfo(FOLDER + name, STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, (ROOT / source).read_bytes(), compresslevel=9)
    return out


if __name__ == "__main__":
    print(f"{build()}: written")
