"""DOWNLOAD ME.zip holds exactly the current files: a stale zip fails here."""

import os
import sys
import unittest
import zipfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "tools"))

import build_download  # noqa: E402


class DownloadZip(unittest.TestCase):
    def test_the_zip_matches_the_repo(self):
        path = os.path.join(ROOT, "DOWNLOAD ME.zip")
        self.assertTrue(os.path.exists(path), "run: python tools/build_download.py")
        with zipfile.ZipFile(path) as archive:
            names = sorted(archive.namelist())
            self.assertEqual(names, sorted(build_download.FOLDER + name for _, name in build_download.FILES))
            for source, name in build_download.FILES:
                with open(os.path.join(ROOT, source), "rb") as f:
                    self.assertEqual(archive.read(build_download.FOLDER + name), f.read(), f"{name} is stale: run python tools/build_download.py")

    def test_the_start_file_points_at_the_help_form_and_says_where_chats_live(self):
        with open(os.path.join(ROOT, "docs", "START-HERE.txt"), encoding="utf-8") as f:
            text = f.read()
        self.assertIn("https://www.kaggle.com/contact", text)
        self.assertIn("saves your chats in your browser", text)


if __name__ == "__main__":
    unittest.main()
