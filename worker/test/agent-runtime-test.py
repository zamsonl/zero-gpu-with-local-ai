"""Synthetic personal-notebook lifecycle checks. No GPU, install, process or network use."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('runtime_fixture', Path(__file__).with_name('kaggle-runtime-test.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class PersonalRuntimeTests(unittest.TestCase):
    def test_queued_shutdown_exits_before_model_or_runtime_preparation(self):
        ns = fixture.runtime_namespace()
        ns.update(AGENT_ONLY=True, NotebookLogReporter=Mock(), log=Mock(),
                  relay=Mock(return_value={'shutdown': True}),
                  models_dir=Mock(side_effect=AssertionError('Cancelled session prepared weights')))
        ns['main']()
        ns['models_dir'].assert_not_called()
        ns['relay'].assert_called_once_with('GET', '/_relay/command')

    def test_cannot_confirm_session_stops_before_downloading(self):
        ns = fixture.runtime_namespace()
        ns.update(AGENT_ONLY=True, NotebookLogReporter=Mock(), log=Mock(),
                  relay=Mock(side_effect=OSError('Synthetic outage')),
                  models_dir=Mock(side_effect=AssertionError('Unconfirmed session prepared weights')))
        with self.assertRaisesRegex(RuntimeError, 'Stopping without loading'):
            ns['main']()
        ns['models_dir'].assert_not_called()

    def test_profile_failure_never_falls_back_to_a_smaller_context(self):
        ns = fixture.runtime_namespace()
        ns.update(AGENT_ONLY=True, CONTEXTS=[98304], load=Mock(return_value=False), report=Mock(), log=Mock())
        with self.assertRaisesRegex(RuntimeError, 'No smaller model'):
            ns['load_best']()
        ns['load'].assert_called_once_with(98304)

    def test_local_idle_backstop_ends_personal_gpu_even_without_relay_control(self):
        ns = fixture.runtime_namespace()
        clock = [0]
        ns['time'] = Mock(time=lambda: clock[0], sleep=lambda seconds: clock.__setitem__(0, clock[0] + 601))
        ns.update(AGENT_ONLY=True, STARTED=0, MAX_RUNTIME_S=99999, report=Mock(), log=Mock(),
                  PICTURES=Mock(), relay=Mock(return_value={}), requests_served=Mock(return_value=0),
                  gpu_busy=Mock(return_value=False))
        ns['serve'](98304, False, 'Q5_K_P', 'https://synthetic.trycloudflare.com')
        self.assertEqual(clock[0], 601)
        ns['PICTURES'].prepare.assert_not_called()
        ns['PICTURES'].stop.assert_called_once()
        self.assertFalse(any(call.args[:2] == ('GET', '/_relay/command') for call in ns['relay'].call_args_list))


if __name__ == '__main__':
    unittest.main()
