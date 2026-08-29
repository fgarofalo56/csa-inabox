"""Tests for the APIClient HTTP wrapper.

#3717 — THE PATCH TARGET MOVED, AND THAT IS THE POINT. Every mock below used to
patch `urllib.request.urlopen`, which is the DEFAULT GLOBAL OPENER: it installs
`FTPHandler` / `FileHandler` / `DataHandler` with no proxy variable set, and its
redirect handler copies `Authorization` across a host change. The client now
goes through a module-scoped `_OPENER` with an http/https-only handler list and
a same-origin redirect guard, so the mocks follow it there. A test still
patching `urllib.request.urlopen` would pass while measuring a code path the
client no longer takes.
"""

from __future__ import annotations

import http.server
import json
import threading
import urllib.error
import urllib.request
from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest

import cli.client as _client
from cli.client import APIClient, APIError

# ── Helpers ────────────────────────────────────────────────────────────────────


def _make_http_error(code: int, body: str) -> urllib.error.HTTPError:
    """Build a realistic urllib HTTPError for testing."""
    return urllib.error.HTTPError(
        url="http://test/",
        code=code,
        msg="Test error",
        hdrs=None,  # type: ignore[arg-type]
        fp=BytesIO(body.encode()),
    )


def _make_url_error(reason: str) -> urllib.error.URLError:
    return urllib.error.URLError(reason=reason)


# ── URL building ───────────────────────────────────────────────────────────────


class TestURLBuilding:
    def test_base_url_trailing_slash_stripped(self):
        client = APIClient("http://localhost:8000/api/v1/")
        url = client._url("/sources")
        assert url == "http://localhost:8000/api/v1/sources"

    def test_params_appended(self):
        client = APIClient("http://localhost:8000/api/v1")
        url = client._url("/sources", params={"domain": "hr", "limit": "50"})
        assert "domain=hr" in url
        assert "limit=50" in url

    def test_none_params_excluded(self):
        client = APIClient("http://localhost:8000/api/v1")
        url = client._url("/sources", params={"domain": None, "limit": "50"})
        assert "domain" not in url
        assert "limit=50" in url

    def test_no_params(self):
        client = APIClient("http://localhost:8000/api/v1")
        url = client._url("/sources")
        assert url == "http://localhost:8000/api/v1/sources"
        assert "?" not in url


# ── Headers ────────────────────────────────────────────────────────────────────


class TestHeaders:
    def test_default_headers_no_token(self):
        client = APIClient("http://localhost:8000/api/v1")
        headers = client._headers()
        assert headers["Accept"] == "application/json"
        assert "Authorization" not in headers

    def test_bearer_token_added(self):
        client = APIClient("http://localhost:8000/api/v1", token="my-secret-token")
        headers = client._headers()
        assert headers["Authorization"] == "Bearer my-secret-token"


# ── Error handling ─────────────────────────────────────────────────────────────


class TestErrorHandling:
    def test_http_error_raises_api_error(self):
        client = APIClient("http://localhost:8000/api/v1")
        error = _make_http_error(404, json.dumps({"detail": "Not found"}))
        with patch("cli.client._OPENER.open", side_effect=error), pytest.raises(APIError) as exc_info:
            client.get("/sources/missing")
        assert exc_info.value.status == 404
        assert "Not found" in exc_info.value.detail

    def test_url_error_raises_api_error_with_status_zero(self):
        client = APIClient("http://localhost:8000/api/v1")
        error = _make_url_error("[Errno 111] Connection refused")
        with patch("cli.client._OPENER.open", side_effect=error), pytest.raises(APIError) as exc_info:
            client.get("/sources")
        assert exc_info.value.status == 0
        assert "Connection error" in exc_info.value.detail

    def test_http_error_non_json_body(self):
        client = APIClient("http://localhost:8000/api/v1")
        error = _make_http_error(502, "Bad Gateway — non-JSON")
        with patch("cli.client._OPENER.open", side_effect=error), pytest.raises(APIError) as exc_info:
            client.get("/sources")
        assert exc_info.value.status == 502
        assert "Bad Gateway" in exc_info.value.detail

    def test_api_error_str(self):
        exc = APIError(404, "Not found")
        assert "404" in str(exc)
        assert "Not found" in str(exc)


# ── Successful requests ────────────────────────────────────────────────────────


class TestSuccessfulRequests:
    def _mock_response(self, data) -> MagicMock:
        body = json.dumps(data).encode()
        mock_resp = MagicMock()
        mock_resp.read.return_value = body
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        return mock_resp

    def test_get_returns_parsed_json(self):
        client = APIClient("http://localhost:8000/api/v1")
        mock_resp = self._mock_response([{"id": "src-001"}])
        with patch("cli.client._OPENER.open", return_value=mock_resp):
            result = client.get("/sources")
        assert result == [{"id": "src-001"}]

    def test_post_sends_json_body(self):
        client = APIClient("http://localhost:8000/api/v1")
        mock_resp = self._mock_response({"id": "src-new"})
        captured_req = {}

        def capture(req, **_):
            captured_req["data"] = req.data
            return mock_resp

        with patch("cli.client._OPENER.open", side_effect=capture):
            result = client.post("/sources", body={"name": "Test"})

        assert result == {"id": "src-new"}
        assert captured_req["data"] is not None
        payload = json.loads(captured_req["data"])
        assert payload["name"] == "Test"

    def test_post_no_body_sends_none(self):
        client = APIClient("http://localhost:8000/api/v1")
        mock_resp = self._mock_response({"status": "ok"})
        captured_req = {}

        def capture(req, **_):
            captured_req["data"] = req.data
            return mock_resp

        with patch("cli.client._OPENER.open", side_effect=capture):
            client.post("/sources/src-001/decommission")

        assert captured_req["data"] is None


# ── Domain-specific methods ────────────────────────────────────────────────────


class TestDomainMethods:
    """Smoke-test that domain methods call the right paths."""

    def setup_method(self):
        self.client = APIClient("http://localhost:8000/api/v1")
        self._captured = {}

    def _make_patcher(self, response_data):
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(response_data).encode()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)

        def capture(req, **_):
            self._captured["url"] = req.full_url
            self._captured["method"] = req.get_method()
            return mock_resp

        return patch("cli.client._OPENER.open", side_effect=capture)

    def test_list_sources_calls_sources_path(self):
        with self._make_patcher([]):
            self.client.list_sources()
        assert "/sources" in self._captured["url"]

    def test_get_source_calls_correct_path(self):
        with self._make_patcher({}):
            self.client.get_source("src-001")
        assert "/sources/src-001" in self._captured["url"]

    def test_decommission_source_is_post(self):
        with self._make_patcher({}):
            self.client.decommission_source("src-001")
        assert self._captured["method"] == "POST"
        assert "decommission" in self._captured["url"]

    def test_trigger_pipeline_is_post(self):
        with self._make_patcher({}):
            self.client.trigger_pipeline("pl-001")
        assert self._captured["method"] == "POST"
        assert "trigger" in self._captured["url"]

    def test_list_products_calls_marketplace_path(self):
        with self._make_patcher([]):
            self.client.list_products()
        assert "marketplace/products" in self._captured["url"]

    def test_platform_stats_calls_stats_path(self):
        with self._make_patcher({}):
            self.client.platform_stats()
        assert "/stats" in self._captured["url"]

    def test_all_domains_calls_domains_path(self):
        with self._make_patcher([]):
            self.client.all_domains()
        assert "/domains" in self._captured["url"]


# ── #3717 — the credential-safe opener ────────────────────────────────────────


class TestCredentialSafeOpener:
    """The bearer token must not survive a redirect off the request's origin.

    THE VECTOR, restated so a future reader does not have to re-derive it.
    `urllib.request.HTTPRedirectHandler.redirect_request` rebuilds the Request
    copying EVERY header except content-length/content-type, and urllib does not
    strip `Authorization` across a host change the way `requests` does. So a
    hostile or compromised upstream answering `302 -> http://attacker/loot`
    receives `Authorization: Bearer <token>` — and the call SUCCEEDS, so nothing
    raises and nothing is logged.

    THE HTTP VARIANT IS THE ONE THAT MATTERS. An earlier fix elsewhere in this
    repo removed only the `ftp:` transport and declared the vector closed; the
    plain cross-host `http:` redirect needs no proxy variable, no unusual scheme,
    and is one character's difference.
    """

    def test_the_ftp_file_and_data_transports_are_absent(self):
        # `build_opener(HTTPHandler, HTTPSHandler, HTTPRedirectHandler)` does NOT
        # produce this — its arguments only DE-DUPLICATE the default set, and
        # ftp/file/data stay installed. Measured; that is why the handler list is
        # built explicitly.
        routes = set(_client._OPENER.handle_open)
        assert "ftp" not in routes
        assert "file" not in routes
        assert "data" not in routes
        assert "http" in routes  # …and the ones we DO need still work

    def test_an_ftp_proxy_env_var_cannot_re_register_the_ftp_route(self, monkeypatch):
        # `ProxyHandler.__init__` does `setattr(self, '%s_open' % type, …)` for
        # EVERY key in the proxies dict, and the default `ProxyHandler()` reads
        # `getproxies()`. One `ftp_proxy` therefore puts the ftp route back on an
        # otherwise-locked-down opener — and it fails OPEN: `proxy_open`
        # re-dispatches over HTTP to the proxy with the headers intact.
        monkeypatch.setenv("ftp_proxy", "http://127.0.0.1:9")
        rebuilt = _client._http_only_opener()
        assert "ftp" not in set(rebuilt.handle_open)

    def test_scoping_the_proxy_dict_does_not_break_no_proxy(self, monkeypatch):
        # The reasonable worry about filtering `getproxies()`: it returns
        # `no_proxy` as a `'no'` key, which the comprehension drops. It does not
        # matter — `ProxyHandler.proxy_open` calls the module-level
        # `proxy_bypass()`, which re-reads the environment itself.
        monkeypatch.setenv("no_proxy", "127.0.0.1")
        assert urllib.request.proxy_bypass("127.0.0.1")
        _client._http_only_opener()  # and the opener still builds

    def test_the_handler_refuses_a_cross_host_redirect(self):
        handler = _client._SameOriginRedirectHandler()
        req = urllib.request.Request(
            "http://loom.example/api/v1/sources",
            headers={"Authorization": "Bearer SUPER_SECRET"},
        )
        with pytest.raises(urllib.error.HTTPError) as excinfo:
            handler.redirect_request(req, BytesIO(b""), 302, "Found", {}, "http://attacker.invalid/loot")
        assert "refusing cross-origin redirect" in str(excinfo.value)

    def test_the_handler_refuses_a_scheme_downgrade_and_a_port_change(self):
        handler = _client._SameOriginRedirectHandler()
        base = urllib.request.Request("https://loom.example/api/v1/sources")
        for target in ("http://loom.example/api/v1/sources", "https://loom.example:8443/api/v1/sources"):
            with pytest.raises(urllib.error.HTTPError, match="refusing cross-origin redirect"):
                handler.redirect_request(base, BytesIO(b""), 302, "Found", {}, target)

    def test_a_same_origin_redirect_is_still_followed(self):
        # Without this the guard is indistinguishable from a client that cannot
        # follow redirects at all — trailing-slash normalisation is routine.
        # `newurl` is absolute here because `http_error_302` — the only real
        # caller — resolves the Location header before delegating. The guard's
        # own `urljoin` still handles the relative form; this asserts the
        # contract the stdlib actually invokes.
        handler = _client._SameOriginRedirectHandler()
        req = urllib.request.Request("http://loom.example/api/v1/sources")
        redirected = handler.redirect_request(
            req, BytesIO(b""), 302, "Found", {}, "http://loom.example/api/v1/sources/"
        )
        assert redirected is not None
        assert redirected.full_url == "http://loom.example/api/v1/sources/"

    def test_the_default_opener_would_have_leaked_the_token(self):
        # THE COUNTERFACTUAL. Without this the assertions above prove only that
        # the new handler refuses something; they do not establish that the thing
        # it refuses was ever a leak. This runs the STDLIB handler over the same
        # inputs and reads the rebuilt Request's headers.
        req = urllib.request.Request(
            "http://loom.example/api/v1/sources",
            headers={"Authorization": "Bearer SUPER_SECRET"},
        )
        leaked = urllib.request.HTTPRedirectHandler().redirect_request(
            req, BytesIO(b""), 302, "Found", {}, "http://attacker.invalid/loot"
        )
        assert leaked is not None
        assert leaked.full_url.startswith("http://attacker.invalid/")
        assert leaked.get_header("Authorization") == "Bearer SUPER_SECRET"

    def test_a_live_cross_host_redirect_never_reaches_the_attacker(self):
        """End-to-end over real sockets: the token must not arrive next door.

        Two local servers. The origin answers `302 -> http://127.0.0.1:<other>/loot`
        (a DIFFERENT port is a different origin). The attacker records any
        Authorization header it sees. The assertion is on the ATTACKER's log, not
        only on the client's exception — an exception could be raised for any
        reason; the empty log is what proves nothing was sent.
        """
        received: list[str | None] = []

        class Attacker(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                received.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *_args):
                pass

        attacker = http.server.HTTPServer(("127.0.0.1", 0), Attacker)
        attacker_port = attacker.server_address[1]

        class Origin(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{attacker_port}/loot")
                self.end_headers()

            def log_message(self, *_args):
                pass

        origin = http.server.HTTPServer(("127.0.0.1", 0), Origin)
        for srv in (attacker, origin):
            threading.Thread(target=srv.serve_forever, daemon=True).start()
        # THE OUTCOME IS CAPTURED, NOT ASSERTED INLINE, and that ordering is
        # load-bearing. With `with pytest.raises(...)` here, a regression that
        # re-followed the redirect failed on "DID NOT RAISE" and the attacker-log
        # assertion below never ran — the test went red for the weaker reason and
        # the actual evidence was never read. Measured while mutation-testing
        # this file, so it is fixed rather than noted.
        outcome: Exception | None = None
        try:
            client = APIClient(
                f"http://127.0.0.1:{origin.server_address[1]}/api/v1", token="SUPER_SECRET"
            )
            try:
                client.get("/sources")
            except APIError as exc:
                outcome = exc
        finally:
            for srv in (attacker, origin):
                srv.shutdown()
                srv.server_close()

        assert received == [], f"the bearer token reached the attacker: {received!r}"
        assert isinstance(outcome, APIError), "the redirect was followed rather than refused"
        assert "refusing cross-origin redirect" in outcome.detail

    def test_a_non_http_base_url_is_refused_at_the_call_site(self):
        client = APIClient("file:///etc", token="SUPER_SECRET")
        with pytest.raises(APIError) as excinfo:
            client.get("/passwd")
        assert "refusing non-http(s) request URL" in excinfo.value.detail
