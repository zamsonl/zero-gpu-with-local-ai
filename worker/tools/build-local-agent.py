"""Package only the portable local helper. Never include user config, logs or credentials."""
from pathlib import Path
import zipfile
import hashlib
import sys

project = Path(__file__).resolve().parents[2]
source = project / 'client' / 'agent'
destination = project / 'worker' / 'public' / 'agent' / 'qwen-local-agent.zip'
files = ['start.mjs', 'kaggle-session.mjs', 'cloud.mjs', 'server.mjs', 'engine.mjs', 'workspace.mjs', 'browser.mjs', 'Start Qwen Agent.cmd', 'README.md', 'public/index.html', 'public/app.js', 'public/app.css', 'opencode.mjs', 'credential-store.mjs', 'opencode-config.mjs', 'OPENCODE.md', 'Start Qwen OpenCode.cmd']
files += ['setup.mjs', 'folder-picker.mjs', 'terminal-host.mjs', 'Start Qwen Setup.vbs', 'setup-public/index.html', 'setup-public/setup.js', 'setup-public/setup.css', 'setup-public/mark.png']
files += ['cache.mjs']
files += ['deployment.mjs', 'deployment.json']
destination.parent.mkdir(parents=True, exist_ok=True)
# The extracted folder shows one launcher; every working file sits in app/.
launcher = b'@echo off\r\ncall "%~dp0app\\Start Qwen OpenCode.cmd" %*\r\n'
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
    top = zipfile.ZipInfo('qwen-local-agent/Start Qwen OpenCode.cmd', date_time=(2026,11,5,0,0,0))
    top.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(top, launcher)
    for name in files:
        info = zipfile.ZipInfo('qwen-local-agent/app/' + name, date_time=(2026,11,5,0,0,0))
        info.compress_type = zipfile.ZIP_DEFLATED
        file = source / name
        if name == 'deployment.json' and '--public' not in sys.argv and (source / 'deployment.local.json').is_file():
            file = source / 'deployment.local.json'
        archive.writestr(info, b'{"relay_origin":""}\n' if name == 'deployment.json' and '--public' in sys.argv else file.read_bytes())
print(f'Packaged {len(files)} helper files, {destination.stat().st_size} bytes, SHA256 {hashlib.sha256(destination.read_bytes()).hexdigest()}')
