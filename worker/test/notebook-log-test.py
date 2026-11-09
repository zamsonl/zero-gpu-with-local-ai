"""Offline transport, redaction and bounded-queue checks for notebook operational logs."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

NS = {"__name__": "notebook_log_under_test"}
exec(compile((Path(__file__).resolve().parent.parent / "src/notebook-log.py").read_text(encoding="utf-8"), "notebook-log.py", "exec"), NS)


class Response:
    status = 200
    def __enter__(self): return self
    def __exit__(self, *args): return False


class NotebookLogTests(unittest.TestCase):
    def logger(self):
        with patch.object(NS["_nl_threading"].Thread, "start"):
            return NS["NotebookLogReporter"]("https://relay.invalid", "colab", headers={"x-relay-key": "private-test-key"})

    def test_log_is_nonblocking_and_redacts_before_queueing(self):
        logger = self.logger()
        with patch.object(NS["_nl_request"], "urlopen", side_effect=AssertionError("log() attempted HTTP")):
            logger.log("Loading private-test-key https://example.trycloudflare.com Bearer secret-value KGAT_testtoken")
        text = logger._queue[0]
        for private in ("private-test-key", "example.trycloudflare.com", "secret-value", "KGAT_testtoken"):
            self.assertNotIn(private, text)

    def test_failed_batch_retry_has_same_sequence_and_body(self):
        logger = self.logger()
        logger.log("Preparing saved runtime")
        sent = []
        def post(request, **kwargs):
            sent.append(json.loads(request.data))
            if len(sent) == 1: raise OSError("offline")
            return Response()
        with patch.object(NS["_nl_request"], "urlopen", side_effect=post):
            with self.assertRaises(OSError): logger._flush_once()
            logger.log("Runtime ready")
            logger._flush_once()
            logger._flush_once()
        self.assertEqual(sent[0], sent[1])
        self.assertEqual([batch["seq"] for batch in sent], [0, 0, 1])
        self.assertEqual(sent[0]["host"], "colab")
        self.assertEqual(sent[0]["run_id"], sent[2]["run_id"])

    def test_queue_and_batch_are_bounded(self):
        logger = self.logger()
        for number in range(300): logger.log(str(number) + "x" * 2500)
        self.assertEqual(len(logger._queue), 200)
        self.assertTrue(all(len(line) <= 2000 for line in logger._queue))
        sent = []
        with patch.object(NS["_nl_request"], "urlopen", side_effect=lambda request, **kwargs: sent.append(json.loads(request.data)) or Response()):
            logger._flush_once()
        self.assertGreater(len(sent[0]["lines"]), 0)
        self.assertLessEqual(len(sent[0]["lines"]), 40)
        self.assertIn("100xxx", sent[0]["lines"][0])

    def test_stale_run_stops_uploads_and_discards_queued_lines(self):
        logger = self.logger()
        logger.log("Old session")
        with patch.object(NS["_nl_request"], "urlopen", side_effect=HTTPError("https://relay.invalid", 409, "stale run", {}, None)) as post:
            with self.assertRaises(HTTPError): logger._flush_once()
            logger.log("Should not upload")
            logger._flush_once()
        self.assertEqual(post.call_count, 1)
        self.assertEqual(len(logger._queue), 0)

    def test_unicode_lines_and_request_bytes_fit_worker_limits(self):
        logger = self.logger()
        for _ in range(80): logger.log("路径😀" * 1500)
        self.assertTrue(all(len(line.encode("utf-16-le")) <= 4000 for line in logger._queue))
        sizes = []
        with patch.object(NS["_nl_request"], "urlopen", side_effect=lambda request, **kwargs: sizes.append(len(request.data)) or Response()):
            while logger._queue: logger._flush_once()
        self.assertTrue(all(size < 80 * 1024 for size in sizes))
        self.assertGreater(len(sizes), 2)

    def test_finish_flushes_final_status_after_pending_running_batch(self):
        logger = self.logger()
        logger.log("Loading")
        with patch.object(NS["_nl_request"], "urlopen", side_effect=OSError("offline")):
            with self.assertRaises(OSError): logger._flush_once()
        logger.finish("ERROR")
        sent = []
        with patch.object(NS["_nl_request"], "urlopen", side_effect=lambda request, **kwargs: sent.append(json.loads(request.data)) or Response()):
            logger._flush_once()
            logger._flush_once()
        self.assertEqual([batch["status"] for batch in sent], ["RUNNING", "ERROR"])
        self.assertTrue(logger._stopped)

    def test_finish_can_wait_for_one_bounded_shutdown_attempt(self):
        logger = self.logger()
        with patch.object(logger._thread, "join") as join:
            logger.finish("COMPLETE", wait=6)
        join.assert_called_once_with(timeout=6)


if __name__ == "__main__": unittest.main()
