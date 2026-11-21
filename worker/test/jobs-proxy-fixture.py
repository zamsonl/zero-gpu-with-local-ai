"""Real Python jobs proxy for Worker route tests; stdin EOF cleans it up."""
import json
import os
import pathlib
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request

namespace = {"__name__": "jobs_route_fixture"}
root = pathlib.Path(__file__).resolve().parents[1]
for name in ("kaggle-stream-proxy.py", "kaggle-jobs.py"):
    exec(compile((root / "src" / name).read_text(encoding="utf-8"), name, "exec"), namespace)
server = namespace["start_stream_proxy"](sys.argv[1], port=0, heartbeat_seconds=0.05, heartbeat_padding_bytes=0)
personal = len(sys.argv) > 2
manager = namespace["install_async_job_routes"](server, reaper_seconds=0.025, stream_heartbeat_seconds=0.05, stream_padding_bytes=0,
    max_stream_seconds=300 if personal else 120, max_job_seconds=7200 if personal else 3600,
    control_token=sys.argv[2] if personal else None)
handler = server.RequestHandlerClass
stats = {"legs": 0}


class FixtureHandler(handler):
    def do_POST(self):
        if urllib.parse.urlsplit(self.path).path == "/__fixture/config":
            patch = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            manager.max_job_seconds = patch.get("max_job_seconds", 3600)
            return self._job_json_response(200, {"ok": True})
        return self._job_dispatch()

    def do_GET(self):
        target = urllib.parse.urlsplit(self.path)
        if target.path == "/__fixture/stats":
            return self._job_json_response(200, stats)
        if target.path.startswith("/_jobs/") and target.path.endswith("/stream"):
            # Force the real transport to reconnect several times quickly. Only
            # this local fixture shortens legs; production accepts up to120s.
            query = urllib.parse.parse_qs(target.query)
            query["max_seconds"] = ["0.25"]
            self.path = target.path + "?" + urllib.parse.urlencode(query, doseq=True)
            stats["legs"] += 1
        return self._job_dispatch()


server.RequestHandlerClass = FixtureHandler

# FIXTURE_WEB_KEY: also the notebook's web route (kaggle-web.py), as the owner's notebook installs
# it. The fake web is the mock on 127.0.0.1, so requests go there directly; the address rules of the
# real web_fetch are covered by kaggle-web-test.py.
web_key = os.environ.get("FIXTURE_WEB_KEY")
if web_key:
    exec(compile((root / "src" / "kaggle-web.py").read_text(encoding="utf-8"), "kaggle-web.py", "exec"), namespace)
    stats["web"] = 0

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    def local_fetch(url, method, form, accept, follow):
        if urllib.parse.urlsplit(url).hostname != "127.0.0.1":
            raise namespace["WebRefused"](403, "it is not a public web address")
        stats["web"] += 1
        headers = {"Accept": accept, "User-Agent": namespace["_WEB_USER_AGENT"]}
        if method == "POST":
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        request = urllib.request.Request(url, data=(form or "").encode() if method == "POST" else None, method=method, headers=headers)
        opener = urllib.request.build_opener() if follow else urllib.request.build_opener(_NoRedirect)
        try:
            response = opener.open(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        data = response.read()
        return {"status": response.code, "location": response.headers.get("Location"), "content_type": response.headers.get("Content-Type", "")}, data, False, url

    namespace["install_web_routes"](server, web_key, fetch=local_fetch)
proxy_url = "http://127.0.0.1:%s" % server.server_address[1]
closed = threading.Event()


def monitor():
    while not closed.wait(0.1):
        try:
            query = [("target", proxy_url)] + [("active_generation", owner) for owner in manager.active_generations()]
            request = urllib.request.Request(sys.argv[3] + "?" + urllib.parse.urlencode(query), headers={"x-launch-token": sys.argv[2]})
            with urllib.request.urlopen(request, timeout=2) as response:
                command = json.load(response)
            manager.cancel_generations(command.get("stop_generations"))
            if command.get("shutdown"):
                manager.close()
                return
        except Exception:
            pass


if personal and len(sys.argv) > 3:
    threading.Thread(target=monitor, daemon=True).start()
print(json.dumps({"url": proxy_url}), flush=True)
try:
    sys.stdin.readline()
finally:
    closed.set()
    manager.close()
    server.shutdown()
    server.server_close()
