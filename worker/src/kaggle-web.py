"""Web egress for the Worker's web tools (web_search, open_page).

Search engines and many sites refuse requests from Cloudflare Workers (DuckDuckGo answers most of
them with a bot check, AccuWeather and The Star with 403), so while a notebook serves, the Worker
asks it to make those requests from its own network. The Worker keeps every rule about what may
be fetched and turns pages into text; this route only carries the request, and refuses anything
but a public web address.

POST /_web/fetch   Authorization: Bearer <web_key the notebook sent in /_relay/register>
  {"url": "https://...", "method": "GET" | "POST", "form": "<urlencoded body>" | null,
   "accept": "...", "follow": true | false}
-> 200 with the site's own body (at most 2 MB, cut there) and its answer in headers:
   X-Web-Status, X-Web-Location (redirect target, when not followed), X-Web-Content-Type,
   X-Web-Url (the address finally read), X-Web-Truncated ("1" when cut).
   Refusals: 401 wrong key, 400 bad request, 403 not a public web address, 502 unreachable.

Rules here: http(s) only, ports 80 and 443 only, the host must resolve to public addresses only
and the connection goes to the address that was checked (no DNS rebinding), at most 3 redirects
when `follow` (each checked the same way), 9 s for the whole request, no cookies and only the headers the
Worker names. This module is bundled after kaggle-jobs.py in the notebook namespace.
"""

import hmac as _web_hmac
import http.client as _web_http
import ipaddress as _web_ip
import json as _web_json
import socket as _web_socket
import ssl as _web_ssl
import time as _web_time
import urllib.parse as _web_url

WEB_MAX_BYTES = 2 * 1024 * 1024
WEB_TIMEOUT_S = 10
# The whole request, redirects and body included. The Worker gives a page 10 s, so a slow site
# hands back what arrived by then (cut) instead of holding the notebook for long.
WEB_DEADLINE_S = 9
WEB_MAX_REDIRECTS = 3
_WEB_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"


class WebRefused(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _web_public_address(host, port):
    """The first address of `host`, when every address it resolves to is public."""
    try:
        infos = _web_socket.getaddrinfo(host, port, type=_web_socket.SOCK_STREAM)
    except (OSError, UnicodeError):
        raise WebRefused(502, "the site's name could not be resolved")
    addresses = []
    for info in infos:
        address = _web_ip.ip_address(info[4][0].split("%", 1)[0])
        if getattr(address, "ipv4_mapped", None):
            address = address.ipv4_mapped
        if not address.is_global or address.is_multicast:
            raise WebRefused(403, "it is not a public web address")
        addresses.append(info[4][0])
    if not addresses:
        raise WebRefused(502, "the site's name could not be resolved")
    return addresses[0]


def _web_target(url):
    try:
        parts = _web_url.urlsplit(url)
        port = parts.port
    except ValueError:
        raise WebRefused(400, "the address is not valid")
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise WebRefused(403, "only http(s) web addresses are allowed")
    port = port or (443 if parts.scheme == "https" else 80)
    if port not in (80, 443):
        raise WebRefused(403, "only the standard web ports are allowed")
    try:
        _web_ip.ip_address(parts.hostname)
        raise WebRefused(403, "IP-address hosts are refused")
    except ValueError:
        pass
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    return parts.scheme, parts.hostname, port, path


class _WebHTTPConnection(_web_http.HTTPConnection):
    def __init__(self, host, address, port, timeout):
        super().__init__(host, port, timeout=timeout)
        self._web_address = address

    def connect(self):
        # Kept: http.client drops self.sock once the response owns the connection.
        self.sock = self._web_sock = _web_socket.create_connection((self._web_address, self.port), self.timeout)


class _WebHTTPSConnection(_web_http.HTTPSConnection):
    def __init__(self, host, address, port, timeout):
        super().__init__(host, port, timeout=timeout, context=_web_ssl.create_default_context())
        self._web_address = address

    def connect(self):
        sock = _web_socket.create_connection((self._web_address, self.port), self.timeout)
        self.sock = self._web_sock = self._context.wrap_socket(sock, server_hostname=self.host)


def web_fetch(url, method="GET", form=None, accept="*/*", follow=False, resolve=_web_public_address):
    """One web request as the notebook: (answer dict, body bytes, truncated, final url)."""
    deadline = _web_time.monotonic() + WEB_DEADLINE_S
    left = lambda: max(0.5, min(WEB_TIMEOUT_S, deadline - _web_time.monotonic()))
    for _ in range(WEB_MAX_REDIRECTS + 1):
        if _web_time.monotonic() >= deadline:
            raise WebRefused(502, f"it took longer than {WEB_DEADLINE_S} s")
        scheme, host, port, path = _web_target(url)
        address = resolve(host, port)
        connection = (_WebHTTPSConnection if scheme == "https" else _WebHTTPConnection)(host, address, port, left())
        headers = {"User-Agent": _WEB_USER_AGENT, "Accept": accept, "Accept-Language": "en-US,en;q=0.8", "Accept-Encoding": "identity"}
        body = None
        if method == "POST":
            body = (form or "").encode("utf-8")
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        try:
            connection.request(method, path, body=body, headers=headers)
            connection._web_sock.settimeout(left())
            response = connection.getresponse()
            location = response.getheader("Location")
            if follow and response.status in (301, 302, 303, 307, 308) and location:
                response.close()
                url = _web_url.urljoin(url, location)
                if response.status in (301, 302, 303):
                    method, form = "GET", None
                continue
            answer = {"status": response.status, "location": location, "content_type": response.getheader("Content-Type", "")}
            chunks, size, cut = [], 0, False
            while size <= WEB_MAX_BYTES and not response.isclosed():
                if _web_time.monotonic() >= deadline:
                    cut = True
                    break
                try:
                    connection._web_sock.settimeout(left())
                    # read1: what has arrived (up to the size), so a timeout loses nothing already read.
                    chunk = response.read1(min(65536, WEB_MAX_BYTES + 1 - size))
                except (OSError, _web_http.HTTPException):
                    # A slow or broken body: what arrived is still worth reading.
                    cut = True
                    break
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
            data = b"".join(chunks)
            return answer, data[:WEB_MAX_BYTES], cut or size > WEB_MAX_BYTES, url
        except WebRefused:
            raise
        except (OSError, _web_http.HTTPException) as error:
            if isinstance(error, (_web_socket.timeout, TimeoutError)):
                raise WebRefused(502, f"it took longer than {WEB_DEADLINE_S} s")
            raise WebRefused(502, "the site could not be reached")
        finally:
            connection.close()
    raise WebRefused(502, f"it redirected more than {WEB_MAX_REDIRECTS} times")


def install_web_routes(server, key, fetch=web_fetch):
    """Adds POST /_web/fetch to the stream proxy, for callers holding `key`."""
    base_handler = server.RequestHandlerClass
    expected = ("Bearer " + key).encode("utf-8")

    class _WebHandler(base_handler):
        def _web_reply(self, status, body, headers=()):
            self.send_response(status)
            for name, value in headers:
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
            self.close_connection = True

        def _web_error(self, status, message):
            self._web_reply(status, _web_json.dumps({"error": message}).encode("utf-8"), [("Content-Type", "application/json")])

        def _web_dispatch(self):
            if _web_url.urlsplit(self.path).path != "/_web/fetch":
                return getattr(base_handler, "do_" + self.command)(self)
            self.close_connection = True
            given = self.headers.get("Authorization", "").encode("utf-8")
            if not _web_hmac.compare_digest(given, expected):
                return self._web_error(401, "A valid web key is required.")
            if self.command != "POST":
                return self._web_error(405, "Use POST.")
            try:
                request = _web_json.loads(self._request_body())
                url, method = request["url"], request.get("method", "GET")
                form, accept, follow = request.get("form"), request.get("accept", "*/*"), request.get("follow", False)
                if (not isinstance(url, str) or len(url) > 2048 or method not in ("GET", "POST")
                        or not (form is None or (isinstance(form, str) and len(form) <= 4096))
                        or not isinstance(accept, str) or len(accept) > 256 or "\n" in accept or "\r" in accept
                        or not isinstance(follow, bool)):
                    raise ValueError()
            except Exception:
                return self._web_error(400, "Supply a url, a GET or POST method and a short form body.")
            try:
                answer, data, truncated, final = fetch(url, method, form, accept, follow)
            except WebRefused as refused:
                return self._web_error(refused.status, str(refused))
            headers = [("Content-Type", "application/octet-stream"), ("X-Web-Status", str(answer["status"])),
                       ("X-Web-Content-Type", (answer["content_type"] or "")[:256]), ("X-Web-Url", _web_url.quote(final, safe=":/?#[]@!$&'()*+,;=%")),
                       ("X-Web-Truncated", "1" if truncated else "0")]
            if answer["location"]:
                headers.append(("X-Web-Location", _web_url.quote(answer["location"], safe=":/?#[]@!$&'()*+,;=%")))
            self._web_reply(200, data, headers)

        do_POST = _web_dispatch
        do_GET = _web_dispatch

    server.RequestHandlerClass = _WebHandler
    return server
