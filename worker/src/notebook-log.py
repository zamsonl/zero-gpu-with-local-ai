"""Bounded, best-effort operational logs shared by Kaggle and Colab notebooks.

Only explicit log() calls are uploaded. Never wrap arbitrary stdout, model output,
prompts, subprocess logs or environment variables. Logging never waits for HTTP.
"""

import collections as _nl_collections
import datetime as _nl_datetime
import json as _nl_json
import re as _nl_re
import threading as _nl_threading
import urllib.error as _nl_error
import urllib.request as _nl_request
import uuid as _nl_uuid


def notebook_log_redact(message, secrets=()):
    text = str(message)
    for secret in sorted((str(value) for value in secrets if value), key=len, reverse=True):
        text = text.replace(secret, "[redacted]")
    text = _nl_re.sub(r"https?://[a-z0-9-]+\.trycloudflare\.com(?:/[^\s]*)?", "[tunnel address hidden]", text, flags=_nl_re.I)
    text = _nl_re.sub(r"\bKGAT_[A-Za-z0-9_-]+", "[redacted]", text)
    text = _nl_re.sub(r"\bBearer\s+[^\s,;\"']+", "Bearer [redacted]", text, flags=_nl_re.I)
    text = _nl_re.sub(r"(?i)([\"']?(?:x-relay-key|x-launch-token|relay_key|launch_token|api[_-]?key|api[_-]?token|authorization|access_token)[\"']?\s*[:=]\s*)[\"']?[^\s,;\"']+", r"\1[redacted]", text)
    return _nl_re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", " ", text).encode("utf-8", "replace").decode("utf-8")


class NotebookLogReporter:
    """Upload up to forty lines every five seconds without blocking the model server.

    Failed batches retain the same sequence number, making retries idempotent.
    During an outage only the newest 200 queued lines are retained, plus one
    in-flight batch. Authentication/stale-run rejection stops the old reporter.
    """

    def __init__(self, relay, host, headers=None, secrets=(), run_id=None, interval=5, timeout=5):
        if host not in ("kaggle", "colab"):
            raise ValueError("unsupported notebook host")
        if not str(relay).startswith("https://"):
            raise ValueError("notebook logging needs an HTTPS relay")
        self.relay = str(relay).rstrip("/")
        self.host = host
        self.headers = dict(headers or {})
        self.secrets = tuple(secrets) + tuple(self.headers.values())
        self.run_id = run_id or _nl_uuid.uuid4().hex
        self.started_at = _nl_datetime.datetime.now(_nl_datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self.interval = max(1, float(interval))
        self.timeout = min(10, max(1, float(timeout)))
        self._queue = _nl_collections.deque(maxlen=200)
        self._lock = _nl_threading.Lock()
        self._wake = _nl_threading.Event()
        self._pending = None
        self._seq = 0
        self._status = "RUNNING"
        self._finishing = False
        self._stopped = False
        self._finish_failures = 0
        self._thread = _nl_threading.Thread(target=self._run, name="notebook-operational-log", daemon=True)
        self._thread.start()

    def log(self, message):
        """Queue an explicit operational message. No network or file I/O occurs here."""
        clean = notebook_log_redact(message, self.secrets)
        clock = _nl_datetime.datetime.now(_nl_datetime.timezone.utc).strftime("%H:%M:%S")
        with self._lock:
            if self._stopped or self._finishing:
                return
            for line in clean.splitlines()[:200]:
                if line.strip():
                    # The Worker counts JS UTF-16 units, including surrogate pairs.
                    bounded = (clock + " " + line).encode("utf-16-le")[:4000].decode("utf-16-le", "ignore")
                    self._queue.append(bounded)
            full = len(self._queue) >= 40
        if full:
            self._wake.set()

    def finish(self, status="COMPLETE", wait=0):
        """Request a final flush, optionally waiting a bounded number of seconds.

        The default is nonblocking. Notebook shutdown may pass wait=6 to give a
        final batch one HTTP attempt before its Python process exits.
        """
        if status not in ("COMPLETE", "ERROR"):
            raise ValueError("invalid notebook final status")
        with self._lock:
            if self._stopped or self._finishing:
                return
            self._status = status
            self._finishing = True
            clock = _nl_datetime.datetime.now(_nl_datetime.timezone.utc).strftime("%H:%M:%S")
            self._queue.append(clock + (" Notebook stopped with an error." if status == "ERROR" else " Notebook session ended."))
        self._wake.set()
        if wait and self._thread is not _nl_threading.current_thread():
            self._thread.join(timeout=min(10, max(0, float(wait))))

    def _flush_once(self):
        with self._lock:
            if self._stopped:
                return
            if self._pending is None and self._queue:
                lines = []
                encoded_size = 0
                while self._queue and len(lines) < 40:
                    size = len(_nl_json.dumps(self._queue[0], ensure_ascii=False).encode("utf-8")) + 1
                    if lines and encoded_size + size > 75 * 1024:
                        break
                    lines.append(self._queue.popleft())
                    encoded_size += size
                status = self._status if self._finishing and not self._queue else "RUNNING"
                self._pending = {"host": self.host, "run_id": self.run_id, "started_at": self.started_at, "seq": self._seq, "lines": lines, "status": status}
            payload = self._pending
        if payload is None:
            return
        request = _nl_request.Request(self.relay + "/_relay/log", data=_nl_json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), method="POST", headers={"content-type": "application/json", "user-agent": "heretic-notebook-log/1", **self.headers})
        try:
            with _nl_request.urlopen(request, timeout=self.timeout) as response:
                # No server response text is logged; errors may contain credentials.
                if response.status != 200:
                    raise OSError("log upload rejected")
        except _nl_error.HTTPError as error:
            if error.code in (401, 403, 409):
                with self._lock:
                    self._stopped = True
                    self._queue.clear()
                    self._pending = None
            raise
        with self._lock:
            self._pending = None
            self._seq += 1
            self._finish_failures = 0
            if self._finishing and not self._queue:
                self._stopped = True
            elif len(self._queue) >= 40 or self._finishing:
                self._wake.set()

    def _run(self):
        while True:
            self._wake.wait(self.interval)
            self._wake.clear()
            with self._lock:
                if self._stopped:
                    return
            try:
                self._flush_once()
            except Exception:
                # Logging is best effort. A network error never interrupts inference.
                self._wake.clear()
                with self._lock:
                    if self._finishing:
                        self._finish_failures += 1
                        if self._finish_failures >= 3:
                            self._stopped = True
