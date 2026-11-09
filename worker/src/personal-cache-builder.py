# The preceding shared builder supplies pinned downloads, native upload and runtime verification.
_base_log = log
_cache_control = PERSONAL_CACHE_CONTROL
_cache_spec = PERSONAL_CACHE_SPEC
HANDLE = _cache_control['owner'] + '/heretic-agent-' + _cache_spec['cache_id'].split('-')[-1]
CACHE_ID = _cache_spec['cache_id']
IMAGE_FILES = []
MIN_FREE_BYTES = 45 * 1024**3
DESCRIPTION = 'Private model/runtime cache. Original upstream licenses apply; no relicensing. ' + CACHE_ID
_cache_started = time.monotonic()
_cache_stop = threading.Event()


def cache_control(method, route, body=None):
    data = None if body is None else json.dumps(body).encode('utf-8')
    req = urllib.request.Request(_cache_control['relay'] + route, data=data, method=method,
        headers={'x-cache-token': _cache_control['token'], 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as response:
        raw = response.read(65537)
    if len(raw) > 65536:
        raise CacheBuildError('Cache control response exceeded its limit')
    return json.loads(raw)


def cache_report(state, phase, detail, **extra):
    value = {'state': state, 'phase': phase, 'detail': detail, 'cache_id': CACHE_ID,
             'build_id': _cache_control['build_id'], **extra}
    for attempt in range(4):
        try:
            cache_control('POST', '/report', value)
            return
        except Exception:
            if attempt == 3:
                raise CacheBuildError('The private cache controller could not be reached') from None
            time.sleep(2**attempt)


def cache_cancel_watch():
    failures = 0
    while not _cache_stop.wait(20):
        try:
            command = cache_control('GET', '/command')
            failures = 0
            if command.get('cancel') or time.monotonic() - _cache_started > 2*3600:
                try:
                    cache_report('cancelled', 'cancelled', 'Private CPU cache build cancelled. No GPU was started.')
                finally:
                    os._exit(0)
        except Exception:
            failures += 1
            if failures >= 30:
                os._exit(1)  # Ten-minute unreachable-controller backstop; CPU only.


def log(event, **fields):
    _base_log(event, **fields)
    phase = PHASE
    if event in ('download-progress', 'download-start', 'download-verified', 'verifying'):
        text = str(fields.get('file', 'Model file'))[:180]
        if event == 'download-progress':
            text += ': %.1f / %.1f GB' % (fields.get('bytes', 0)/1e9, fields.get('total', 1)/1e9)
        cache_report('building', phase, text)


def set_phase(value):
    global PHASE
    PHASE = value
    cache_report('building', value, {
        'installing-upload-tools':'Preparing the CPU cache builder',
        'checking-native-upload':'Checking private Kaggle storage access',
        'downloading-pinned-files':'Downloading and verifying model files once',
        'building-runtime-and-manifests':'Saving the verified runtime',
        'uploading-cache':'Uploading your private persistent cache',
    }.get(value, 'Preparing your private cache'))


def personal_cache_main():
    if sys.platform != 'linux':
        raise CacheBuildError('The cache builder requires a Kaggle Linux CPU notebook')
    if cache_control('GET', '/command').get('cancel'):
        cache_report('cancelled', 'cancelled', 'Cache build cancelled before downloading. No GPU was started.')
        return
    threading.Thread(target=cache_cancel_watch, daemon=True).start()
    for directory in (BASE, STAGE, SCRATCH, OUTPUT):
        if directory.is_symlink():
            raise CacheBuildError('Cache output directories cannot be links')
        directory.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(BASE).free < MIN_FREE_BYTES:
        raise CacheBuildError('The CPU notebook needs at least 45 GiB of temporary disk for this cache')
    set_phase('installing-upload-tools')
    install_upload_tools()
    set_phase('checking-native-upload')
    preflight=SCRATCH/'personal-upload-preflight'
    preflight.mkdir(parents=True, exist_ok=True)
    (preflight/'README.md').write_text('Private CPU cache upload preflight.\n', encoding='utf-8')
    upload_directory(preflight)  # Discard temporary upload capabilities; never write them to notebook output.
    selected = _cache_spec.get('model')
    entries = []
    set_phase('downloading-pinned-files')
    if selected:
        items = [('model', selected['file'], 'chat-model.gguf', selected['bytes'], selected['sha256'])]
        repo, revision = selected['repo'], selected['revision']
    else:
        items, repo, revision = MODEL_FILES, MODEL_REPO, MODEL_REVISION
    for role, source_path, local_path, size, digest in items:
        download(hf_url(repo, revision, source_path), STAGE/local_path, size, digest)
        entries.append({'role':role, 'path':local_path, 'size':size, 'sha256':digest, 'source_path':source_path})
    set_phase('building-runtime-and-manifests')
    runtime = build_runtime()
    if selected:
        model = {'repo':repo, 'revision':revision, 'quant':selected['quant'], 'name':MODEL_NAME,
                 'files':entries, 'source_url':selected['url'], 'profile_id':selected['profile_id']}
    else:
        model = build_model(entries)
    notices = [
        (hf_url(repo, revision, 'README.md'), 'model-card.md'),
        ('https://raw.githubusercontent.com/ollama/ollama/v0.40.11/LICENSE', 'ollama-LICENSE.txt'),
        ('https://raw.githubusercontent.com/cloudflare/cloudflared/2026.10.3/LICENSE', 'cloudflared-LICENSE.txt'),
    ]
    if not selected:
        notices.append((hf_url('Qwen/Qwen3.8-27B', '1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0', 'LICENSE'), 'model-base-LICENSE.txt'))
    licenses=[]
    for url, name in notices:
        try:
            licenses.append(download_notice(url, name))
        except urllib.error.HTTPError as error:
            if error.code != 404 or name != 'model-card.md':
                raise
    index = {'schema':_cache_spec['schema'], 'cache_id':CACHE_ID, 'model':model, 'runtime':runtime,
             'licenses':licenses,
             'images':{'files':[]}, 'license_policy':'Original upstream licenses apply; no relicensing.'}
    write_json(STAGE/'cache.json', index)
    (STAGE/'README.md').write_text('# Private coding-agent cache\n\n'+DESCRIPTION+'\n\nSource: '+hf_url(repo, revision, '')+'\n', encoding='utf-8')
    set_phase('uploading-cache')
    uploaded = upload_directory(STAGE)
    # Blob capabilities go only to the authenticated controller, never logs or notebook output.
    cache_report('uploaded', 'uploaded', 'Files verified and uploaded. Creating the private Dataset.',
                 upload={'files':uploaded['files'], 'directories':uploaded['directories']},
                 manifest_sha256=file_hash(STAGE/'cache.json'))
    write_json(OUTPUT/'cache-build-result.json', {'ok':True, 'cache_id':CACHE_ID, 'used_gpu':False})


try:
    personal_cache_main()
except Exception as error:
    # Native upload/network errors can contain signed URLs and credentials.
    detail = str(error) if isinstance(error, CacheBuildError) else 'The CPU cache build failed ('+type(error).__name__+'). Check account storage and notebook logs.'
    try:
        cache_report('failed', PHASE, detail[:400])
    except Exception:
        pass
    _base_log('cache-failed', error_type=type(error).__name__)
    sys.exit(1)
finally:
    _cache_stop.set()
