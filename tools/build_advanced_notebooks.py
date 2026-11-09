"""Regenerate source notebooks with blank relay configuration and empty outputs."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
DEST=Path(__file__).resolve().parents[1]
subprocess.run([sys.executable,str(DEST/'worker/tools/build-colab-notebook.py'),'--public'],check=True)
(DEST/'notebooks/advanced').mkdir(exist_ok=True)
shutil.copyfile(DEST/'worker/public/notebooks/heretic-qwen-colab.ipynb',DEST/'notebooks/advanced/colab.ipynb')
parts=('notebook-log.py','kaggle-cache.py','kaggle-stream-proxy.py','kaggle-jobs.py','kaggle-server.py')
runtime='\n\n'.join((DEST/'worker/src'/name).read_text(encoding='utf-8') for name in parts)
for marker,value in {'__RELAY__':repr(''),'__LAUNCH_TOKEN__':repr(''),'__QUANT__':repr('Q5_K_P'),'__CONTEXTS__':'[98304]','__VISION__':'None','__CACHE_ID__':repr(''),'__BATCH_SIZE__':'256','__PROFILE_ID__':repr('')}.items():runtime=runtime.replace(marker,value)
compile(runtime,'manual-kaggle-runtime','exec')
intro='# Qwen workspace on Kaggle\n\nUse your own deployed Worker, a private notebook, Internet access and enough GPU memory for Qwen 27B Q5_K_P. Select the required two-GPU profile. Provide your relay key through the named Kaggle secret or hidden prompt. Run as a committed background version when desired; confirm the GPU session stops when finished. No permanent Kaggle API token belongs in this notebook. The guided local-agent setup separately prepares per-user caches automatically.\n'
runner="""import getpass
from urllib.parse import urlsplit
RELAY_ORIGIN = input('Your deployed relay URL (https://your-worker.example): ').strip()
parsed = urlsplit(RELAY_ORIGIN)
if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
    raise ValueError('Use your own HTTPS origin without credentials or a path')
RELAY_ORIGIN = parsed.scheme + '://' + parsed.netloc
try:
    from kaggle_secrets import UserSecretsClient
    KEY = UserSecretsClient().get_secret('QWEN_RELAY_KEY')
except Exception:
    KEY = getpass.getpass('Your relay key (hidden): ')
if not isinstance(KEY, str) or len(KEY.strip()) < 16:
    raise ValueError('A private relay key of at least 16 characters is required')
runtime = {'__name__': 'manual_kaggle_runtime'}
exec(compile(RUNTIME_SOURCE, '<shared-runtime>', 'exec'), runtime)
runtime.update(RELAY=RELAY_ORIGIN, LAUNCH_TOKEN=KEY.strip(), RELAY_HEADER='x-relay-key', STRICT_PROFILE=True)
runtime['main']()
"""
cells=[{'cell_type':'markdown','metadata':{},'source':intro.splitlines(keepends=True)},{'cell_type':'code','metadata':{},'source':('RUNTIME_SOURCE = '+repr(runtime)+'\n\n'+runner).splitlines(keepends=True),'execution_count':None,'outputs':[]}]
(DEST/'notebooks/advanced/kaggle.ipynb').write_text(json.dumps({'nbformat':4,'nbformat_minor':5,'metadata':{'kernelspec':{'name':'python3','display_name':'Python 3','language':'python'}},'cells':cells},ensure_ascii=False,indent=1)+'\n',encoding='utf-8')
