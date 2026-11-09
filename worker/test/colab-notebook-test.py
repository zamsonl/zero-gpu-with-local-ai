"""Parity tests compile the actual shared runtime, with no GPU or cloud calls."""
import importlib.util
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('colab_builder', ROOT / 'tools/build-colab-notebook.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
KEY = 'fixture-private-relay-key-0123456789'


def namespace():
    result = {'__name__': 'colab_under_test', 'COLAB_RUNTIME_SOURCE': builder.shared_runtime_source(), 'COLAB_CONFIG': {'RELAY': 'https://relay.example.invalid'}}
    exec(compile((ROOT / 'src/colab-server.py').read_text(encoding='utf-8'), '<adapter>', 'exec'), result)
    return result


class ColabNotebookTests(unittest.TestCase):
    def setUp(self):
        self.adapter = namespace()
        self.runtime = self.adapter['configured_runtime'](KEY)

    def test_download_matches_builder_compiles_and_has_no_outputs_or_credentials(self):
        notebook = json.loads((ROOT / 'public/notebooks/heretic-qwen-colab.ipynb').read_text(encoding='utf-8'))
        self.assertEqual(notebook, builder.notebook())
        for cell in notebook['cells']:
            if cell['cell_type'] == 'code':
                self.assertEqual(cell['outputs'], [])
                self.assertIsNone(cell['execution_count'])
                compile(''.join(cell['source']), '<downloaded-cell>', 'exec')
        source = ''.join(notebook['cells'][-1]['source'])
        self.assertNotIn(KEY, source)
        self.assertIn('userdata.get("QWEN_RELAY_KEY")', source)
        self.assertIn('getpass.getpass(', source)
        self.assertIn('Images mode', ''.join(notebook['cells'][0]['source']))

    def test_exact_model_context_batch_kv_vision_images_and_private_auth_profile(self):
        runtime = self.runtime
        self.assertEqual(runtime['MODEL'], 'qwen3.8-hauhau')
        self.assertEqual(runtime['QUANT'], 'Q6_K')
        self.assertEqual(runtime['CONTEXTS'], [32768, 24576, 16384, 8192])
        self.assertEqual(runtime['BATCH_SIZE'], 128)
        self.assertTrue(runtime['STRICT_PROFILE'])
        self.assertFalse(runtime['AGENT_ONLY'])
        self.assertEqual(runtime['RUNTIME_HOST'], 'colab')
        self.assertEqual(runtime['RELAY_HEADER'], 'x-relay-key')
        self.assertIsNone(runtime['discover_cache']())
        self.assertIsNotNone(runtime['Pictures'])
        self.assertIn('OLLAMA_KV_CACHE_TYPE', builder.shared_runtime_source())
        self.assertIn('"q8_0"', builder.shared_runtime_source())

    def test_modified_context_cannot_silently_choose_a_smaller_profile(self):
        self.adapter['config']['CONTEXT'] = 12345
        with self.assertRaisesRegex(ValueError, 'Choose a Colab context'):
            self.adapter['configured_runtime'](KEY)

    def test_missing_or_insufficient_gpu_stops_before_install_or_download(self):
        runtime = self.runtime
        runtime['model_files'] = Mock(return_value=[('weights', 'sha', 18 * 1024**3)])
        self.adapter['gpus'] = lambda: []
        with self.assertRaisesRegex(RuntimeError, 'No GPU'):
            self.adapter['preflight'](runtime)
        runtime['model_files'].assert_not_called()
        self.adapter['gpus'] = lambda: [('T4 fixture', 15360)]
        with self.assertRaisesRegex(RuntimeError, '9B model was not downloaded'):
            self.adapter['preflight'](runtime)

    def test_memory_preflight_uses_actual_selected_files_and_caches_metadata(self):
        runtime = self.runtime
        files = [('weights', 'sha', 18 * 1024**3)]
        fetch = Mock(return_value=files)
        runtime.update({'model_files': fetch, 'log': Mock()})
        self.adapter['gpus'] = lambda: [('large GPU fixture', 40000)]
        self.assertEqual(self.adapter['preflight'](runtime)[0][1], 40000)
        self.assertEqual(runtime['model_files']('Q6_K'), files)
        fetch.assert_called_once_with('Q6_K')
        with self.assertRaises(ValueError): runtime['model_files']('IQ3_M')

    def test_exact_gpu_fit_failure_never_falls_back_to_cpu_context_or_precision(self):
        runtime = self.runtime
        runtime.update({'load': Mock(return_value=False), 'report': Mock(), 'log': Mock()})
        with self.assertRaisesRegex(RuntimeError, 'no CPU fallback'):
            runtime['load_best']()
        self.assertEqual([call.args[0] for call in runtime['load'].call_args_list], [32768, 24576, 16384, 8192])
        fallback = Mock()
        runtime.update({'pull_fallback': fallback})
        future = Mock()
        future.result.side_effect = OSError('unavailable')
        with self.assertRaises(RuntimeError): runtime['get_model']('/unused', future)
        fallback.assert_not_called()

    def test_registration_reports_colab_control_vision_exact_profile_and_shared_jobs(self):
        runtime = self.runtime
        runtime.update({'relay': Mock(return_value={}), 'report': Mock(), 'log': Mock(), 'PICTURES': Mock(),
                        'requests_served': Mock(return_value=0), 'MAX_RUNTIME_S': 0})
        runtime['serve'](32768, True, 'Q6_K', 'https://fixture.trycloudflare.com')
        registration = runtime['relay'].call_args_list[0].args[2]
        self.assertEqual(registration['host'], 'colab')
        self.assertEqual(registration['num_ctx'], 32768)
        self.assertEqual(registration['num_batch'], 128)
        self.assertTrue(registration['vision'])
        self.assertTrue(registration['control'])
        self.assertEqual(registration['inference_transport'], 'jobs-v1')
        runtime['PICTURES'].prepare.assert_called_once()
        runtime['PICTURES'].stop.assert_called_once()

    def test_chat_and_images_switch_the_same_gpu_with_original_context_restored(self):
        runtime = self.runtime
        pictures = Mock()
        pictures.error = None
        pictures.ready = threading.Event()
        pictures.ready.set()
        runtime.update({'report_mode': Mock(), 'unload_chat_model': Mock(), 'load': Mock(return_value=True), 'log': Mock()})
        self.assertTrue(runtime['switch_to_pictures'](pictures, 'target', 32768))
        runtime['unload_chat_model'].assert_called_once()
        pictures.start.assert_called_once()
        runtime['switch_to_chat'](pictures, 'target', 32768)
        pictures.stop.assert_called_once()
        runtime['load'].assert_called_once_with(32768)

    def test_finished_image_bytes_use_colab_key_in_header_not_url(self):
        runtime = self.runtime
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b'{}'
        with patch.object(runtime['urllib'].request, 'urlopen', return_value=response) as open_url:
            runtime['upload']('/_relay/image-result?id=fixture', b'png-data', 'image/png')
        request = open_url.call_args.args[0]
        self.assertEqual(request.get_header('X-relay-key'), KEY)
        self.assertIsNone(request.get_header('X-launch-token'))
        self.assertNotIn(KEY, request.full_url)
        self.assertEqual(request.data, b'png-data')

    def test_bad_key_stops_before_gpu_checks_install_or_download_and_finishes_logs(self):
        runtime = self.runtime
        reporter = Mock()
        runtime.update({'NotebookLogReporter': Mock(return_value=reporter), 'report': Mock(), 'log': Mock(), 'relay': Mock(side_effect=HTTPError('https://fixture', 401, 'unauthorized', {}, None))})
        self.adapter.update({'relay_key': lambda: KEY, 'configured_runtime': lambda key: runtime, 'preflight': Mock()})
        self.adapter['main']()
        self.adapter['preflight'].assert_not_called()
        self.assertIn('rejected the key', runtime['report'].call_args.args[1])
        reporter.finish.assert_called_once_with('ERROR', wait=6)

    def test_context_reduces_only_after_a_measured_gpu_fit_failure(self):
        runtime = self.runtime
        runtime.update({'load': Mock(side_effect=[False, True]), 'report': Mock(), 'log': Mock()})
        self.assertEqual(runtime['load_best'](), 24576)
        self.assertEqual([call.args[0] for call in runtime['load'].call_args_list], [32768, 24576])
        self.assertEqual(runtime['QUANT'], 'Q6_K')

    def test_smaller_repo_and_revision_are_bound_to_real_download_helpers(self):
        runtime = self.runtime
        self.assertEqual(runtime['download'].__defaults__, (self.adapter['MODEL_REPO'],))
        self.assertEqual(runtime['REPO'], self.adapter['MODEL_REPO'])
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.geturl.return_value = 'https://cdn.fixture/weights'
        with patch.object(self.adapter['urllib'].request, 'urlopen', return_value=response) as open_url:
            runtime['signed_url']('weights.gguf')
        self.assertIn('/'+self.adapter['MODEL_REVISION']+'/weights.gguf', open_url.call_args.args[0].full_url)
        self.assertNotIn('27B', open_url.call_args.args[0].full_url)

    def test_shared_image_repository_and_workflow_match_the_kaggle_runner(self):
        runtime = self.runtime
        source = (ROOT / 'src/kaggle-server.py').read_text(encoding='utf-8')
        self.assertIn(runtime['IMAGE_REPO'], source)
        self.assertIn('abenzerps/Qwen-Image-2.1-Uncensored-Quantized', runtime['IMAGE_REPO'])
        self.assertEqual(len(runtime['IMAGE_FILES']), 4)
        self.assertIn('switch_to_pictures', runtime)
        self.assertIn('run_job', runtime)
        self.assertIn('sees_pictures', runtime)

    def test_notebook_interrupt_unregisters_only_its_last_confirmed_target(self):
        runtime = self.runtime
        reporter = Mock()
        relay = Mock(return_value={})
        def run():
            runtime['relay']('POST', '/_relay/register', {'target': 'https://old.fixture'})
            runtime['relay']('POST', '/_relay/register', {'target': 'https://new.fixture'})
            raise KeyboardInterrupt()
        runtime.update({'NotebookLogReporter': Mock(return_value=reporter), 'report': Mock(), 'log': Mock(), 'relay': relay, 'main': run})
        self.adapter.update({'relay_key': lambda: KEY, 'configured_runtime': lambda key: runtime, 'preflight': Mock()})
        self.adapter['main']()
        relay.assert_any_call('POST', '/_relay/unregister', {'target': 'https://new.fixture'})
        self.assertFalse(any(call.args == ('POST', '/_relay/unregister', {'target': 'https://old.fixture'}) for call in relay.call_args_list))
        reporter.finish.assert_called_once()


if __name__ == '__main__': unittest.main(verbosity=2)
