"""The notebook's web route (src/kaggle-web.py): what it refuses, that it connects to the address it
checked, redirects, the size cap, and the authenticated /_web/fetch route on the real stream proxy.
Local servers only: names are resolved by a fake resolver to 127.0.0.1, never by DNS."""
import http.server
import json
import pathlib
import threading
import time
import unittest
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
ns = {"__name__": "kaggle_web_test"}
for name in ("kaggle-stream-proxy.py", "kaggle-jobs.py", "kaggle-web.py"):
    exec(compile((ROOT / "src" / name).read_text(encoding="utf-8"), name, "exec"), ns)
WebRefused, web_fetch = ns["WebRefused"], ns["web_fetch"]
KEY = "k" * 43


class Site(http.server.BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *args):
        pass

    def _answer(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        Site.seen.append({"method": self.command, "path": self.path, "host": self.headers["Host"], "body": body.decode(), "headers": dict(self.headers)})
        if self.path.startswith("/hop/"):
            left = int(self.path.split("/")[2])
            self.send_response(302)
            self.send_header("Location", "/page" if left == 0 else "/hop/%d" % (left - 1))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path == "/to-private":
            self.send_response(302)
            self.send_header("Location", "http://intranet.example/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path == "/slow":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", "20000")
            self.end_headers()
            self.wfile.write(b"<p>first part</p>")
            self.wfile.flush()
            time.sleep(3)
            return
        data = b"x" * 5000 if self.path == "/big" else b"<p>hello " + self.command.encode() + b"</p>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = _answer
    do_POST = _answer


class WebRouteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.site = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Site)
        threading.Thread(target=cls.site.serve_forever, daemon=True).start()
        cls.port = cls.site.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.site.shutdown()
        cls.site.server_close()

    def setUp(self):
        Site.seen.clear()

    def fetch(self, url, **options):
        # Names under .example resolve to the local site; intranet.example to a private address.
        def resolve(host, port):
            if host == "intranet.example":
                raise WebRefused(403, "it is not a public web address")
            return "127.0.0.1"
        target = ns["_web_target"]
        ns["_web_target"] = lambda url: (lambda parts: (parts[0], parts[1], self.port, parts[3]))(target(url.replace(":%d" % self.port, "")))
        try:
            return web_fetch(url, resolve=resolve, **options)
        finally:
            ns["_web_target"] = target

    def test_refuses_anything_but_a_public_web_address(self):
        for url, why in [("ftp://files.example/", "only http"), ("http://user:pw@site.example/", "only http"),
                         ("http://203.0.113.5/", "IP-address"), ("http://[::1]/", "IP-address"),
                         ("http://site.example:8080/", "standard web ports"), ("not a url", "only http")]:
            with self.assertRaises(WebRefused) as caught:
                web_fetch(url, resolve=lambda host, port: "127.0.0.1")
            self.assertIn(why, str(caught.exception), url)
        # Names that resolve to a loopback, private or link-local address are refused.
        for address in ("127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.1", "::1", "::ffff:127.0.0.1", "fc00::1"):
            resolver = lambda host, port, address=address: [(None, None, None, None, (address, port))]
            original = ns["_web_socket"].getaddrinfo
            ns["_web_socket"].getaddrinfo = lambda *args, address=address, **kwargs: resolver(*args[:2])
            try:
                with self.assertRaises(WebRefused) as caught:
                    ns["_web_public_address"]("sneaky.example", 80)
                self.assertEqual(caught.exception.status, 403, address)
            finally:
                ns["_web_socket"].getaddrinfo = original
        self.assertEqual(Site.seen, [])

    def test_get_and_post_go_to_the_checked_address_with_the_site_name(self):
        answer, data, truncated, final = self.fetch("http://news.example/a?q=1", accept="text/html")
        self.assertEqual((answer["status"], data, truncated), (200, b"<p>hello GET</p>", False))
        self.assertEqual(Site.seen[0]["host"], "news.example:%d" % self.port if Site.seen[0]["host"].count(":") else "news.example")
        self.assertEqual(Site.seen[0]["path"], "/a?q=1")
        self.assertNotIn("Cookie", Site.seen[0]["headers"])
        self.assertTrue(Site.seen[0]["headers"]["User-Agent"].startswith("Mozilla/5.0"))
        answer, data, _, _ = self.fetch("http://search.example/html/", method="POST", form="q=kuala+lumpur&kl=wt-wt")
        self.assertEqual(data, b"<p>hello POST</p>")
        self.assertEqual(Site.seen[1]["body"], "q=kuala+lumpur&kl=wt-wt")
        self.assertEqual(Site.seen[1]["headers"]["Content-Type"], "application/x-www-form-urlencoded")

    def test_redirects_are_returned_or_followed_within_the_limit_and_checked(self):
        answer, data, _, _ = self.fetch("http://news.example/hop/0")
        self.assertEqual((answer["status"], answer["location"], data), (302, "/page", b""))
        answer, data, _, final = self.fetch("http://news.example/hop/2", follow=True)
        self.assertEqual((answer["status"], data), (200, b"<p>hello GET</p>"))
        self.assertTrue(final.endswith("/page"))
        with self.assertRaises(WebRefused) as caught:
            self.fetch("http://news.example/hop/5", follow=True)
        self.assertIn("redirected more than 3 times", str(caught.exception))
        with self.assertRaises(WebRefused) as caught:
            self.fetch("http://news.example/to-private", follow=True)
        self.assertEqual(caught.exception.status, 403)

    def test_body_is_cut_at_the_limit(self):
        limit = ns["WEB_MAX_BYTES"]
        ns["WEB_MAX_BYTES"] = 1000
        try:
            answer, data, truncated, _ = self.fetch("http://news.example/big")
        finally:
            ns["WEB_MAX_BYTES"] = limit
        self.assertEqual((len(data), truncated), (1000, True))

    def test_a_slow_site_hands_back_what_arrived_by_the_deadline(self):
        deadline = ns["WEB_DEADLINE_S"]
        ns["WEB_DEADLINE_S"] = 1
        started = time.monotonic()
        try:
            answer, data, truncated, _ = self.fetch("http://slow.example/slow")
        finally:
            ns["WEB_DEADLINE_S"] = deadline
        self.assertLess(time.monotonic() - started, 2.5)
        self.assertEqual((answer["status"], data, truncated), (200, b"<p>first part</p>", True))

    def test_route_needs_the_key_and_answers_with_the_site_in_headers(self):
        calls = []

        def fake(url, method, form, accept, follow):
            calls.append((url, method, form, accept, follow))
            if "private" in url:
                raise WebRefused(403, "it is not a public web address")
            return {"status": 301, "location": "https://news.example/new path", "content_type": "text/html"}, b"moved", False, url

        server = ns["start_stream_proxy"]("http://127.0.0.1:9", port=0)
        ns["install_async_job_routes"](server)
        ns["install_web_routes"](server, KEY, fetch=fake)
        base = "http://127.0.0.1:%d" % server.server_address[1]

        def post(body, key=KEY, path="/_web/fetch"):
            request = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST",
                                             headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + key} if key else {})})
            try:
                with urllib.request.urlopen(request, timeout=5) as response:
                    return response.status, dict(response.headers), response.read()
            except urllib.error.HTTPError as error:
                with error:
                    return error.code, dict(error.headers), error.read()
        try:
            self.assertEqual(post({"url": "https://news.example/"}, key=None)[0], 401)
            self.assertEqual(post({"url": "https://news.example/"}, key="w" * 43)[0], 401)
            self.assertEqual(post({"url": "https://news.example/", "method": "DELETE"})[0], 400)
            self.assertEqual(post({"url": "https://news.example/", "form": "x" * 5000})[0], 400)
            self.assertEqual(post({"url": "https://news.example/", "accept": "a\r\nCookie: x"})[0], 400)
            status, headers, body = post({"url": "https://news.example/old", "method": "POST", "form": "q=1", "accept": "text/html", "follow": False})
            self.assertEqual((status, body), (200, b"moved"))
            self.assertEqual(headers["X-Web-Status"], "301")
            self.assertEqual(headers["X-Web-Location"], "https://news.example/new%20path")
            self.assertEqual(headers["X-Web-Content-Type"], "text/html")
            self.assertEqual(calls[-1], ("https://news.example/old", "POST", "q=1", "text/html", False))
            status, _, body = post({"url": "https://private.example/"})
            self.assertEqual(status, 403)
            self.assertIn("not a public web address", json.loads(body)["error"])
            # Other routes still reach the job routes and the model proxy.
            self.assertEqual(post({}, path="/_jobs/nope/stream")[0] in (401, 403, 404, 405), True)
            self.assertEqual(post({}, path="/nothing")[0], 404)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
