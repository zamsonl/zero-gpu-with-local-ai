"""Both downloads must match their current source, with the right entry points."""
from pathlib import Path
import sys
import unittest
import zipfile
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import build_download
class DownloadZips(unittest.TestCase):
    def check_zip(self,name,folder,files):
        with zipfile.ZipFile(ROOT/name)as z:
            self.assertIsNone(z.testzip())
            self.assertEqual(sorted(z.namelist()),sorted(folder+name for _,name in files))
            for source,name in files:self.assertEqual(z.read(folder+name),(ROOT/source).read_bytes(),name)
    def test_beginner_download(self):
        self.check_zip('Quick Start.zip','zero-gpu-quick-start/',build_download.QUICK_FILES)
        self.assertLess((ROOT/'Quick Start.zip').stat().st_size,1024*1024)
        with zipfile.ZipFile(ROOT/'Quick Start.zip')as z:
            self.assertIn('zero-gpu-quick-start/START HERE.html',z.namelist())
            self.assertFalse(any('/worker/'in name or '/client/agent/'in name for name in z.namelist()))
            guide=z.read('zero-gpu-quick-start/START HERE.md').decode('utf-8')
            self.assertIn('no compaction',guide);self.assertIn('Advanced Setup',guide)
    def test_advanced_download(self):
        self.check_zip('DOWNLOAD ME.zip','zero-gpu-with-local-ai/',build_download.source_files())
        with zipfile.ZipFile(ROOT/'DOWNLOAD ME.zip')as z:
            for name in ['worker/src/personal-cache.js','worker/src/opencode.js','client/agent/setup.mjs','notebooks/advanced/kaggle.ipynb','notebooks/advanced/colab.ipynb']:
                self.assertIn('zero-gpu-with-local-ai/'+name,z.namelist())
if __name__=='__main__':unittest.main()
