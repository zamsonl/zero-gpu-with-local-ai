"""Build the unconfigured public source ZIP, excluding local state and credentials."""
from pathlib import Path
import json
import subprocess
import sys
import tomllib
import zipfile
ROOT=Path(__file__).resolve().parents[1]
config=tomllib.loads((ROOT/'worker/wrangler.toml').read_text())
if any(db.get('database_id') != '00000000-0000-0000-0000-000000000000' for db in config.get('d1_databases',[])) or config.get('vars',{}).get('KAGGLE_CACHE_DATASET'):
    raise SystemExit('Source releases require the unconfigured template wrangler.toml. Keep configured downloads on your own deployment.')
subprocess.run([sys.executable,str(ROOT/'worker/tools/build-local-agent.py'),'--public'],check=True)
subprocess.run([sys.executable,str(ROOT/'tools/build_notebooks.py')],check=True)
sources=['.gitattributes','.gitignore','README.md','LICENSE','CONTRIBUTING.md','SECURITY.md','THIRD_PARTY.md','CONTRACT.md','START HERE.md','docs','notebooks','tools','web','client/agent','worker/src','worker/public','worker/test','worker/tools','worker/migrations','worker/package.json','worker/package-lock.json','worker/wrangler.toml','worker/.dev.vars.example','worker/CONTEXT_UPGRADE.md','worker/KAGGLE_CACHE.md','worker/ROBUST_COMPACTION.md']
files=set()
for item in sources:
    source=ROOT/item
    if not source.exists():continue
    for path in ([source] if source.is_file() else source.rglob('*')):
        if not path.is_file() or path.is_symlink():continue
        relative=path.relative_to(ROOT)
        if any(part in ('node_modules','.git','.wrangler','.test-state','__pycache__') for part in relative.parts):continue
        if path.name in ('.dev.vars','.env','deployment.local.json','kaggle.json','access_token') or path.name.endswith(('.dpapi.json','.log','.pyc')):continue
        files.add(path)
if json.loads((ROOT/'client/agent/deployment.json').read_text()).get('relay_origin'):
    raise SystemExit('Source releases require blank client/agent/deployment.json.')
with zipfile.ZipFile(ROOT/'DOWNLOAD ME.zip','w',zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(files):
        entry=zipfile.ZipInfo('zero-gpu-with-local-ai/'+path.relative_to(ROOT).as_posix(),date_time=(2026,11,9,0,0,0))
        entry.compress_type=zipfile.ZIP_DEFLATED
        archive.writestr(entry,path.read_bytes())
print('Built DOWNLOAD ME.zip from',len(files),'reviewed source files.')
