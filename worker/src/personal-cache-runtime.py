def configure_personal_cache(spec):
    original_discover, original_stage = discover_cache, stage_cached_model
    if not spec.get('model'):
        def discover_verified(*args, **kwargs):
            cache=original_discover(*args, **kwargs)
            if cache and _cache_hash(os.path.join(cache['root'], 'cache.json')) != spec['manifest_sha256']:
                return None
            return cache
        globals()['discover_cache']=discover_verified
        return
    selected = spec['model']

    def discover_personal(input_root='/kaggle/input', **kwargs):
        for directory, children, files in os.walk(input_root, followlinks=False):
            depth = os.path.relpath(directory, input_root).count(os.sep)
            if depth >= 2:
                children[:] = []
            if 'cache.json' not in files:
                continue
            try:
                metadata = os.path.join(directory, 'cache.json')
                if os.path.getsize(metadata) > 1024*1024:
                    continue
                if _cache_hash(metadata) != spec['manifest_sha256']:
                    continue
                with open(metadata, encoding='utf-8') as source:
                    manifest = json.load(source)
                model = manifest.get('model', {})
                entry = model.get('files', [{}])[0]
                if (manifest.get('schema') != 2 or manifest.get('cache_id') != spec['cache_id'] or
                    model.get('repo') != selected['repo'] or model.get('revision') != selected['revision'] or
                    model.get('quant') != selected['quant'] or model.get('profile_id') != selected['profile_id'] or
                    entry.get('sha256') != selected['sha256'] or entry.get('size') != selected['bytes']):
                    continue
                cache={'root':os.path.realpath(directory), 'manifest':manifest}
                _cache_file(cache, entry)
                return cache
            except (OSError, ValueError, KeyError, TypeError, IndexError):
                continue
        return None

    def stage_personal(cache, models):
        if cache['manifest'].get('schema') != 2:
            return original_stage(cache, models)
        entry=cache['manifest']['model']['files'][0]
        source=_cache_file(cache, entry)
        target=os.path.join(models, 'blobs', 'sha256-'+selected['sha256'])
        if os.path.lexists(target):
            raise CacheError('Custom cache cannot replace an existing model file')
        os.symlink(source, target)
        # main intentionally keeps cached_model false for raw custom GGUFs. Its
        # fetch reuses this blob, then custom_get_model checks SHA/tools/context.
    globals().update(discover_cache=discover_personal, stage_cached_model=stage_personal)

configure_personal_cache(PERSONAL_CACHE_SPEC)
