"""Build separate beginner and advanced downloads. No model weights or local credentials."""
from pathlib import Path
import json
import subprocess
import sys
import tomllib
import zipfile
ROOT=Path(__file__).resolve().parents[1]
STAMP=(2026,11,9,0,0,0)
QUICK_FILES=[('START QUICK CHAT.html','START HERE.html'),('docs/QUICKSTART.md','docs/QUICKSTART.md'),('docs/QUICKSTART.md','START HERE.md'),('notebooks/kaggle.ipynb','notebooks/kaggle.ipynb'),('notebooks/colab.ipynb','notebooks/colab.ipynb'),('web/index.html','web/index.html'),('LICENSE','LICENSE')]
SOURCE_PATHS=['.gitattributes','.gitignore','README.md','LICENSE','CONTRIBUTING.md','SECURITY.md','THIRD_PARTY.md','CONTRACT.md','START HERE.md','docs','notebooks','tools','web','START QUICK CHAT.html','server','cli','tests','client/agent','worker/src','worker/public','worker/test','worker/tools','worker/migrations','worker/package.json','worker/package-lock.json','worker/wrangler.toml','worker/.dev.vars.example','worker/CONTEXT_UPGRADE.md','worker/KAGGLE_CACHE.md','worker/ROBUST_COMPACTION.md']
def source_files():
    files=set()
    for item in SOURCE_PATHS:
        source=ROOT/item
        if not source.exists():continue
        for path in ([source] if source.is_file() else source.rglob('*')):
            if not path.is_file() or path.is_symlink():continue
            relative=path.relative_to(ROOT)
            if any(part in ('node_modules','.git','.wrangler','.test-state','__pycache__')for part in relative.parts):continue
            if path.name in ('.dev.vars','.env','deployment.local.json','kaggle.json','access_token') or path.name.endswith(('.dpapi.json','.log','.pyc')):continue
            files.add(relative.as_posix())
    return [(name,name)for name in sorted(files)]
def archive(out,folder,files):
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED)as z:
        for source,name in sorted(files,key=lambda pair:pair[1]):
            entry=zipfile.ZipInfo(folder+name,date_time=STAMP);entry.compress_type=zipfile.ZIP_DEFLATED
            z.writestr(entry,(ROOT/source).read_bytes())
    return out
def build_quick(out=None):return archive(out or ROOT/'Quick Start.zip','zero-gpu-quick-start/',QUICK_FILES)
def build_advanced(out=None):
    cfg=tomllib.loads((ROOT/'worker/wrangler.toml').read_text(encoding='utf-8'))
    if any(db.get('database_id')!='00000000-0000-0000-0000-000000000000'for db in cfg.get('d1_databases',[]))or cfg.get('vars',{}).get('KAGGLE_CACHE_DATASET'):raise SystemExit('Advanced source release needs unconfigured wrangler.toml.')
    if json.loads((ROOT/'client/agent/deployment.json').read_text(encoding='utf-8')).get('relay_origin'):raise SystemExit('Advanced source release needs blank deployment.json.')
    return archive(out or ROOT/'DOWNLOAD ME.zip','zero-gpu-with-local-ai/',source_files())
def main():
    for tool in ['tools/build_notebooks.py','worker/tools/build-local-agent.py','tools/build_advanced_notebooks.py']:
        subprocess.run([sys.executable,str(ROOT/tool),*(['--public']if 'build-local-agent'in tool else [])],check=True)
    for out in (build_quick(),build_advanced()):print(out.name+': '+str(out.stat().st_size)+' bytes')
if __name__=='__main__':main()
