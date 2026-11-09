import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[1]


class PersonalCacheRuntimeTests(unittest.TestCase):
    def fixture(self, directory):
        root=Path(directory)/'input'/'cache';root.mkdir(parents=True)
        data=b'verified tiny GGUF fixture'
        digest=hashlib.sha256(data).hexdigest()
        (root/'chat-model.gguf').write_bytes(data)
        selected={'repo':'fixture/model','revision':'a'*40,'quant':'Q4_K_M','profile_id':'fixture-profile','sha256':digest,'bytes':len(data)}
        manifest={'schema':2,'cache_id':'fixture-cache','model':{'repo':selected['repo'],'revision':selected['revision'],'quant':selected['quant'],'profile_id':selected['profile_id'],'files':[{'role':'model','path':'chat-model.gguf','size':len(data),'sha256':digest}]},'runtime':{}}
        raw=json.dumps(manifest).encode();(root/'cache.json').write_bytes(raw)
        spec={'model':selected,'cache_id':'fixture-cache','manifest_sha256':hashlib.sha256(raw).hexdigest()}
        namespace={};exec((ROOT/'src'/'kaggle-cache.py').read_text(encoding='utf8'),namespace)
        namespace.update(PERSONAL_CACHE_SPEC=spec,stage_cached_model=lambda *a:None)
        exec((ROOT/'src'/'personal-cache-runtime.py').read_text(encoding='utf8'),namespace)
        return root,namespace,spec

    def test_custom_blob_cache_is_verified_and_staged_without_importing_or_bypassing_model_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            root,ns,spec=self.fixture(directory)
            cache=ns['discover_cache'](str(root.parent),repo='fixture/model',quant='Q4_K_M',model_name='qwen3.8-hauhau')
            self.assertIsNotNone(cache)
            models=Path(directory)/'models';(models/'blobs').mkdir(parents=True)
            try:
                ns['stage_cached_model'](cache,str(models))
            except OSError as error:
                if getattr(error,'winerror',None)==1314:self.skipTest('Windows symlink privilege unavailable')
                raise
            blob=models/'blobs'/('sha256-'+spec['model']['sha256'])
            self.assertTrue(blob.is_symlink());self.assertEqual(blob.read_bytes(),(root/'chat-model.gguf').read_bytes())
            source=(ROOT/'src'/'kaggle-server.py').read_text(encoding='utf8')
            self.assertIn("cached_model = cache['manifest'].get('schema') != 2",source)
            self.assertFalse((models/'manifests').exists())  # custom_get_model still must import/check tools and context.

    def test_changed_manifest_or_source_identity_never_becomes_a_cache_hit(self):
        with tempfile.TemporaryDirectory() as directory:
            root,ns,spec=self.fixture(directory)
            (root/'cache.json').write_text('{}',encoding='utf8')
            self.assertIsNone(ns['discover_cache'](str(root.parent)))
        with tempfile.TemporaryDirectory() as directory:
            root,ns,spec=self.fixture(directory)
            spec['model']['revision']='b'*40
            self.assertIsNone(ns['discover_cache'](str(root.parent)))

    def test_matching_size_is_not_enough_for_the_manifest_and_missing_blob_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root,ns,spec=self.fixture(directory)
            (root/'chat-model.gguf').unlink()
            self.assertIsNone(ns['discover_cache'](str(root.parent)))

    def test_cancelled_cpu_builder_exits_before_installation_or_download(self):
        shared=(ROOT/'tools'/'build-kaggle-cache.py').read_text(encoding='utf8')
        source=(ROOT/'src'/'personal-cache-builder.py').read_text(encoding='utf8')
        ns={}
        exec(shared.split('\nif __name__ == "__main__":')[0],ns)
        ns.update(PERSONAL_CACHE_SPEC={'cache_id':'fixture-cache'},PERSONAL_CACHE_CONTROL={'owner':'fixture','relay':'https://relay.example.invalid','token':'fixture','build_id':'fixture'})
        exec(source.split('\ntry:\n    personal_cache_main()')[0],ns)
        reports=[]
        ns.update(sys=SimpleNamespace(platform='linux'),cache_control=lambda *a,**k:{'cancel':True},cache_report=lambda *a,**k:reports.append(a),install_upload_tools=lambda:self.fail('Cancelled builder attempted installation'),download=lambda *a:self.fail('Cancelled builder attempted a download'))
        ns['personal_cache_main']()
        self.assertEqual(reports[0][0],'cancelled')


if __name__=='__main__':unittest.main()
