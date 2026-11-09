import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.request

ROOT=Path(__file__).resolve().parent.parent
PAYLOAD=b'fixture-model-bytes'
SHA=hashlib.sha256(PAYLOAD).hexdigest()
SPEC={'repo':'fixture/model-GGUF','revision':'b'*40,'file':'model-Q4_K_M.gguf','sha256':SHA,'bytes':len(PAYLOAD),'quant':'Q4_K_M','context':32768,'profile_id':'hfgguf:'+SHA[:24]}

class CustomModelTests(unittest.TestCase):
    def fixture(self,caps=None,limit=32768):
        import os
        calls=[]
        def http(method,url,body,**kwargs):
            calls.append((url,body))
            return {'capabilities':['completion','tools','thinking'] if caps is None else caps,'model_info':{'qwen35.context_length':limit}}
        scope={'CUSTOM_MODEL_SPEC':SPEC,'download':Mock(),'relay':Mock(return_value={}), 'http':http,'MODEL':'qwen3.8-hauhau','OLLAMA':'http://127.0.0.1:11434','USER_AGENT':'fixture','urllib':__import__('urllib'),'hashlib':hashlib,'os':os,'report':Mock(),'log':Mock(),'public':str,'load':Mock(return_value=True)}
        scope['_relay_observer']=scope['relay']
        exec(compile((ROOT/'src/custom-model.py').read_text(encoding='utf-8'),'<custom-runtime>','exec'),scope)
        return scope,calls
    def import_model(self,scope,payload=PAYLOAD):
        with tempfile.TemporaryDirectory() as folder:
            blobs=Path(folder)/'blobs';blobs.mkdir();(blobs/('sha256-'+SHA)).write_bytes(payload)
            future=Mock();future.result.return_value=[(SPEC['file'],SHA,len(PAYLOAD))]
            return scope['get_model'](folder,future)
    def test_import_uses_selected_digest_alias_tools_and_actual_training_context(self):
        scope,calls=self.fixture(limit=16384)
        self.assertEqual(self.import_model(scope),'Q4_K_M')
        self.assertEqual(calls[0][1]['files'],{SPEC['file']:'sha256:'+SHA})
        self.assertEqual(calls[0][1]['model'],'qwen3.8-hauhau')
        self.assertEqual(scope['CONTEXTS'],[16384,8192])
        scope['relay']('POST','/_relay/register',{'target':'fixture'})
        self.assertEqual(scope['PROFILE_ID'],SPEC['profile_id'])
        registration=scope['_relay_observer'].call_args.args[2]
        self.assertEqual(registration['profile_id'],SPEC['profile_id'])
        self.assertTrue(registration['thinking'])
    def test_wrong_checksum_or_missing_tools_never_loads_another_model(self):
        scope,calls=self.fixture()
        with self.assertRaisesRegex(RuntimeError,'checksum'):self.import_model(scope,b'bad')
        self.assertEqual(calls,[])
        scope,calls=self.fixture(caps=['completion'])
        with self.assertRaisesRegex(RuntimeError,'tool calling'):self.import_model(scope)
        self.assertEqual(len(calls),2)
    def test_gpu_context_fit_stops_at_first_success_and_never_uses_cpu_fallback(self):
        scope,_=self.fixture();scope['load'].side_effect=[False,True]
        self.assertEqual(scope['load_best'](),24576)
        self.assertEqual([call.args[0] for call in scope['load'].call_args_list],[32768,24576])
        scope['load']=Mock(return_value=False)
        with self.assertRaisesRegex(RuntimeError,'No model was substituted'):scope['load_best']()
        self.assertEqual(scope['load'].call_count,4)
    def test_download_uses_pinned_hugging_face_repo_and_never_kaggle_default(self):
        scope,_=self.fixture();response=Mock();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False);response.geturl.return_value='https://cdn.fixture/model'
        with patch.object(urllib.request,'urlopen',return_value=response) as fetch:
            scope['signed_url'](SPEC['file'])
        self.assertEqual(fetch.call_args.args[0].full_url,'https://huggingface.co/'+SPEC['repo']+'/resolve/'+SPEC['revision']+'/'+SPEC['file'])
        with self.assertRaisesRegex(RuntimeError,'Unexpected'):scope['signed_url'](SPEC['file'],'other/repo')

if __name__=='__main__':unittest.main(verbosity=2)
