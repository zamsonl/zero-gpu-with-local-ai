# Applied only to an explicitly selected public Hugging Face GGUF personal session.
def configure_custom_gguf(spec):
    global REPO, QUANT, FALLBACK_QUANT, CONTEXTS, BATCH_SIZE, PROFILE_ID, STRICT_PROFILE
    REPO, QUANT, FALLBACK_QUANT = spec['repo'], spec['quant'], spec['quant']
    CONTEXTS, BATCH_SIZE, PROFILE_ID, STRICT_PROFILE = [32768, 24576, 16384, 8192], 128, spec['profile_id'], True
    original_download, original_relay = download, relay
    def custom_download(files, dest_for, repo=None, **kwargs):
        return original_download(files, dest_for, repo=repo or spec['repo'], **kwargs)
    def custom_signed_url(name, repo=None):
        if (repo or spec['repo']) != spec['repo']: raise RuntimeError('Unexpected custom model repository.')
        request = urllib.request.Request(f"https://huggingface.co/{spec['repo']}/resolve/{spec['revision']}/{name}", headers={'range':'bytes=0-0','user-agent':USER_AGENT})
        with urllib.request.urlopen(request, timeout=60) as response: return response.geturl()
    def custom_files(quant):
        if quant != spec['quant']: raise RuntimeError('Unexpected custom model precision.')
        return [(spec['file'], spec['sha256'], spec['bytes'])]
    capabilities = {'thinking': False}
    def custom_get_model(models, fetched):
        files = fetched.result()
        if files != custom_files(QUANT): raise RuntimeError('Custom model files changed unexpectedly.')
        report('loading', 'Checking the downloaded GGUF checksum')
        digest = hashlib.sha256()
        with open(os.path.join(models, 'blobs', 'sha256-'+spec['sha256']), 'rb') as stream:
            for chunk in iter(lambda: stream.read(8*1024*1024), b''): digest.update(chunk)
        if digest.hexdigest() != spec['sha256']: raise RuntimeError('The downloaded GGUF checksum failed. No model was loaded.')
        report('loading', 'Importing the selected Hugging Face GGUF and checking tool support')
        http('POST', OLLAMA+'/api/create', {'model':MODEL, 'files':{spec['file']:'sha256:'+spec['sha256']}, 'stream':False}, timeout=600)
        info = http('POST', OLLAMA+'/api/show', {'model':MODEL}, timeout=120)
        caps = info.get('capabilities') or []
        if 'tools' not in caps or 'completion' not in caps: raise RuntimeError('This GGUF does not advertise Ollama chat and tool calling. Choose a tool-capable GGUF for OpenCode; no other model was substituted.')
        capabilities['thinking'] = 'thinking' in caps
        limits = [n for k,n in (info.get('model_info') or {}).items() if k.endswith('.context_length') and isinstance(n,int) and not isinstance(n,bool)]
        if not limits: raise RuntimeError('This GGUF did not advertise a valid context length. Choose a compatible tool-capable GGUF.')
        limit = min(limits)
        global CONTEXTS
        CONTEXTS = [n for n in CONTEXTS if n <= limit]
        if not CONTEXTS: raise RuntimeError('The selected GGUF needs a context window of at least 8,192 tokens for the coding agent.')
        return QUANT
    def custom_load_best():
        for context in CONTEXTS:
            report('loading', f'Loading your GGUF at {context:,} context tokens')
            try:
                if load(context): return context
            except Exception as error: log('GPU fit check: '+public(str(error)))
        raise RuntimeError('The selected GGUF did not fit fully on the Kaggle GPUs at any supported context. Choose a smaller GGUF. No model was substituted.')
    def custom_relay(method, route, body=None):
        if method=='POST' and route=='/_relay/register': body={**body,'thinking':capabilities['thinking'],'profile_id':spec['profile_id']}
        return original_relay(method,route,body)
    globals().update(download=custom_download, signed_url=custom_signed_url, model_files=custom_files, get_model=custom_get_model, load_best=custom_load_best, relay=custom_relay)

configure_custom_gguf(CUSTOM_MODEL_SPEC)
