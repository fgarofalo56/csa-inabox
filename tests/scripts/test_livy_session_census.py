"""Tests for scripts/csa-loom/livy-session-census.py — the walk's completeness rule.

The census exists because the probes it replaced reported a jammed pool as an
empty one (#3568 / #1796). Every assertion here is about the same thing: the
script must claim `complete` ONLY when completeness was actually established,
and must never let a number the server sent talk it into a confident partial.
"""

from __future__ import annotations

import io
import threading
import urllib.error
import urllib.request
from http.client import HTTPMessage
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest

from tests.conftest import load_script_module

_SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "csa-loom" / "livy-session-census.py"
_mod = load_script_module("livy_session_census", _SCRIPT_PATH)

census = _mod.census
PAGE_SIZE = _mod.PAGE_SIZE
_get = _mod._get
_OPENER = _mod._OPENER


class _PageServer:
    """A Livy sessions endpoint that serves `from`/`size` windows over a pool.

    `total_mode` picks which of the two documented meanings of `total` the
    backend uses:

      "pool"  Apache Livy's server — `sessionManager.size()`, the whole pool.
      "page"  the Azure REST spec that generates every Synapse Spark SDK —
              `SparkBatchJobCollection.total` is "Number of sessions fetched",
              i.e. the length of the page in your hand.
      "none"  the field is absent entirely.

    Which one the live service actually does is NOT settled by these tests and
    cannot be settled from source; that needs a real request against a pool
    holding more than one page. Pinning the behaviour under BOTH readings is
    what makes the answer not matter.
    """

    def __init__(self, size: int, total_mode: str = "pool", broken_after: int | None = None) -> None:
        self.sessions = [{"id": i, "state": "idle"} for i in range(size)]
        self.total_mode = total_mode
        self.broken_after = broken_after
        self.urls: list[str] = []

    def __call__(self, url: str, token: str) -> dict[str, Any]:
        self.urls.append(url)
        if self.broken_after is not None and len(self.urls) > self.broken_after:
            return {"total": 0}  # a 200 that answered nothing
        frm = int(url.split("from=")[1].split("&")[0])
        size = int(url.split("size=")[1].split("&")[0])
        page = self.sessions[frm:frm + size]
        if self.total_mode == "none":
            return {"sessions": page}
        total = len(self.sessions) if self.total_mode == "pool" else len(page)
        return {"total": total, "sessions": page}


@pytest.fixture
def patch_get(monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    def _patch(server: _PageServer) -> _PageServer:
        monkeypatch.setattr(_mod, "_get", server)
        return server

    return _patch


class TestPageLengthTotal:
    """A `total` that is really the PAGE LENGTH must not end the walk."""

    def test_enumerates_the_whole_pool_when_total_is_the_page_length(self, patch_get: Any) -> None:
        # 137 sessions, every page reporting `total: 20`. Pre-fix,
        # `len(sessions) >= total` was `20 >= 20` after page one: the walk broke
        # and printed `complete: True` holding 20 of 137 — the #1796 jam
        # reported as absent, which is the exact thing this script exists to
        # prevent.
        server = patch_get(_PageServer(137, total_mode="page"))

        sessions, total, complete = census("https://d", "livyApi", "tok")

        assert len(sessions) == 137
        assert complete is True
        assert total is None  # never invented — the server gave nothing navigable
        # The walk really did page: 7 pages of 20 plus the empty one that proves
        # the end. A single request here would mean the fixture, not the fix.
        assert len(server.urls) == 8

    @pytest.mark.parametrize("size", [21, 40, 137])
    def test_never_claims_complete_on_a_partial_walk(self, patch_get: Any, size: int) -> None:
        patch_get(_PageServer(size, total_mode="page"))

        sessions, _total, complete = census("https://d", "livyApi", "tok")

        # `complete` is the flag the caller prints and the reaper acts on.
        # "Partial, reported complete" is the state that must not exist.
        assert not (complete and len(sessions) < size)
        assert len(sessions) == size

    def test_still_uses_a_total_that_cannot_be_a_page_length(self, patch_get: Any) -> None:
        # `total: 137` beside a 20-row page is impossible under the page-length
        # reading, so it stays usable — and it saves the trailing empty request
        # that the ambiguous case has to pay for.
        server = patch_get(_PageServer(137, total_mode="pool"))

        sessions, total, complete = census("https://d", "livyApi", "tok")

        assert len(sessions) == 137
        assert total == 137
        assert complete is True
        assert len(server.urls) == 7  # ceil(137/20) — no confirming empty page

    def test_a_pool_inside_one_page_costs_one_extra_request_but_stays_exact(
        self, patch_get: Any
    ) -> None:
        # A 7-session pool reports `total: 7` beside 7 rows under BOTH readings,
        # so it cannot end the walk; the empty second page does. That extra
        # request is the whole cost of the fix.
        server = patch_get(_PageServer(7, total_mode="pool"))

        sessions, _total, complete = census("https://d", "livyApi", "tok")

        assert len(sessions) == 7
        assert complete is True
        assert len(server.urls) == 2


class TestBrokenResponses:
    """A 200 that did not answer must not read as an exhausted list."""

    def test_a_bodyless_page_raises_rather_than_completing(self, patch_get: Any) -> None:
        patch_get(_PageServer(137, total_mode="pool", broken_after=0))

        with pytest.raises(ValueError, match="cannot distinguish an exhausted list"):
            census("https://d", "livyApi", "tok")

    def test_a_bodyless_page_mid_walk_still_raises(self, patch_get: Any) -> None:
        patch_get(_PageServer(137, total_mode="page", broken_after=2))

        with pytest.raises(ValueError, match="cannot distinguish an exhausted list"):
            census("https://d", "livyApi", "tok")

    def test_an_empty_sessions_array_is_a_genuinely_complete_census(self, patch_get: Any) -> None:
        # The counterfactual: the rule must not degenerate into "every census
        # fails". `{"total":0,"sessions":[]}` DID answer the question.
        server = patch_get(_PageServer(0, total_mode="pool"))

        sessions, _total, complete = census("https://d", "livyApi", "tok")

        assert sessions == []
        assert complete is True
        assert len(server.urls) == 1


class TestTotallessBackend:
    """A backend that omits `total` cannot forge a complete census either."""

    def test_walks_to_the_end_without_a_total(self, patch_get: Any) -> None:
        patch_get(_PageServer(45, total_mode="none"))

        sessions, total, complete = census("https://d", "livyApi", "tok")

        assert len(sessions) == 45
        assert total is None
        assert complete is True


class TestRequestShape:
    """The documented per-request cap is not a tuning knob."""

    def test_never_requests_more_than_the_documented_maximum(self, patch_get: Any) -> None:
        server = patch_get(_PageServer(137, total_mode="page"))

        census("https://d", "livyApi", "tok")

        assert server.urls
        for url in server.urls:
            assert int(url.split("size=")[1].split("&")[0]) <= 20
        assert PAGE_SIZE == 20


class _StubResponse:
    """The minimum `_get` needs from `_OPENER.open`: a context manager + read()."""

    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def read(self) -> bytes:
        return self._payload

    def __enter__(self) -> _StubResponse:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


class _StubOpener:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def open(self, req: object, timeout: float | None = None) -> _StubResponse:
        return _StubResponse(self._payload)


class TestBodyGuards:
    """`_get`'s two body guards, asserted THROUGH `_get`.

    The previous version of this class asserted `json.loads("[]") == []` — a
    property of the standard library — and never called `_get` at all. Measured
    in review: replacing BOTH guards with `if False:` left the suite at 26
    passed. Two deletable guards with zero signal, protecting the exact failure
    mode this file exists to prevent (a broken read printing as an empty pool).
    """

    def test_an_empty_body_is_refused_rather_than_read_as_an_empty_pool(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(_mod, "_OPENER", _StubOpener(b""))
        with pytest.raises(ValueError, match="empty body"):
            _get("https://dev.example/livyApi/sessions", "tok")

    def test_a_whitespace_only_body_is_refused_too(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # `if not raw.strip()` is the guard; a body of spaces must not slip past
        # it into `json.loads` and raise something less legible.
        monkeypatch.setattr(_mod, "_OPENER", _StubOpener(b"   \n  "))
        with pytest.raises(ValueError, match="empty body"):
            _get("https://dev.example/livyApi/sessions", "tok")

    def test_a_json_array_is_refused_rather_than_walking_out_as_a_dict(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A list walking out of `_get` would make `page.get("sessions")` explode
        # in `census()`, far from the cause.
        monkeypatch.setattr(_mod, "_OPENER", _StubOpener(b"[]"))
        with pytest.raises(ValueError, match="expected a JSON object"):
            _get("https://dev.example/livyApi/sessions", "tok")

    @pytest.mark.parametrize("payload", [b'"a string"', b"42", b"null"])
    def test_any_non_object_json_is_refused(
        self, monkeypatch: pytest.MonkeyPatch, payload: bytes
    ) -> None:
        monkeypatch.setattr(_mod, "_OPENER", _StubOpener(payload))
        with pytest.raises(ValueError, match="expected a JSON object"):
            _get("https://dev.example/livyApi/sessions", "tok")

    def test_a_well_formed_object_still_comes_straight_back(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The counterfactual — without it, "always raise" would pass everything
        # above.
        monkeypatch.setattr(
            _mod, "_OPENER", _StubOpener(b'{"total": 1, "sessions": [{"id": 7}]}')
        )
        body = _get("https://dev.example/livyApi/sessions", "tok")
        assert body == {"total": 1, "sessions": [{"id": 7}]}


class TestUrlScheme:
    """`DEV` is operator-supplied, so the scheme is allow-listed at the call site.

    This is the first of three layers and the narrowest: it vets only the URL
    the script itself builds. Where the server tries to send us next is
    `_SameOriginRedirectHandler`'s job, and which transports exist at all is the
    opener's.

    (There is no `# nosec` to justify any more — `_get` no longer calls
    `urlopen`, so B310 does not fire and bandit reports
    `Total lines skipped (#nosec): 0`. The guard stands on its own.)
    """

    @pytest.mark.parametrize(
        "url",
        [
            "file:///etc/passwd",
            "ftp://example.invalid/x",
            "gopher://example.invalid/x",
        ],
    )
    def test_refuses_a_non_http_scheme_before_opening_it(self, url: str) -> None:
        # Must raise from the scheme check, NOT from a failed network call —
        # `urlopen` is never reached, so no I/O happens in this test.
        with pytest.raises(ValueError, match="refusing non-http"):
            _get(url, "tok")

    def test_the_error_names_the_url_it_refused(self) -> None:
        with pytest.raises(ValueError, match="refusing non-http") as excinfo:
            _get("file:///etc/passwd", "tok")
        assert "file:///etc/passwd" in str(excinfo.value)


class TestRedirectCannotLeaveHttp:
    """The scheme check vets OUR url; it says nothing about where the server sends us.

    `HTTPRedirectHandler.http_error_302` permits a `Location:` whose scheme is
    in ``('http', 'https', 'ftp', '')`` and `redirect_request` copies every
    header except content-length/content-type. So `file:`/`data:`/`gopher:`
    redirects are already refused by the stdlib, but an `ftp:` one is followed —
    carrying ``Authorization: Bearer $TOK`` to whatever host it names.
    """

    @pytest.fixture(autouse=True)
    def _no_ambient_proxy(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Start every test in this class from a KNOWN-EMPTY proxy environment.

        These tests talk to a local `HTTPServer`, so an ambient `http_proxy`
        (common on a corporate or self-hosted runner) would route 127.0.0.1
        through a proxy that cannot serve it and fail them for a reason that
        says nothing about the code. Tests that need a proxy set one themselves,
        which also makes each test's environment explicit rather than inherited.

        `_OPENER` is rebuilt afterwards because it is constructed at IMPORT time
        from whatever the environment was then.
        """
        for var in (
            "http_proxy", "https_proxy", "ftp_proxy", "all_proxy", "no_proxy",
            "HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "ALL_PROXY", "NO_PROXY",
        ):
            monkeypatch.delenv(var, raising=False)
        monkeypatch.setattr(_mod, "_OPENER", _mod._http_only_opener())

    def test_the_stdlib_really_would_carry_the_bearer_token_to_ftp(self) -> None:
        # The premise, asserted rather than assumed. If a future Python starts
        # stripping Authorization across a scheme change, THIS is the test that
        # says so, and the opener below can be reconsidered.
        req = urllib.request.Request(
            "http://example.invalid/sessions",
            headers={"Authorization": "Bearer SECRET"},
        )
        redirected = urllib.request.HTTPRedirectHandler().redirect_request(
            req, io.BytesIO(), 302, "Found", HTTPMessage(), "ftp://attacker.invalid/loot"
        )
        assert redirected is not None
        assert redirected.full_url.startswith("ftp://")
        assert redirected.get_header("Authorization") == "Bearer SECRET"

    def test_the_opener_can_reach_http_and_nothing_else(self) -> None:
        # Read through `_mod`, NOT the module-level `_OPENER` alias bound at
        # import: the autouse fixture rebuilds `_mod._OPENER`, and `setattr`
        # cannot rebind this file's own global. Harmless today because both
        # objects agree, but it would silently stop testing the rebuilt opener
        # the moment they diverged.
        routes = set(_mod._OPENER.handle_open)
        assert "http" in routes
        assert "https" in routes
        # The exfiltration route, and its neighbours.
        assert "ftp" not in routes
        assert "file" not in routes
        assert "data" not in routes

    @pytest.mark.parametrize("proxy_var", ["ftp_proxy", "FTP_PROXY", "all_proxy", "ALL_PROXY"])
    def test_a_proxy_env_var_cannot_smuggle_the_ftp_route_back(
        self, monkeypatch: pytest.MonkeyPatch, proxy_var: str
    ) -> None:
        """`ProxyHandler` installs one `<scheme>_open` per key in its proxies dict.

        The default `ProxyHandler()` reads `getproxies()` — env vars plus, on
        Windows, the registry — so a single `ftp_proxy` reopens the exact route
        the opener exists to close, and it fails OPEN: `proxy_open` re-dispatches
        the ftp request over HTTP to the proxy with `Authorization` intact.

        Measured before the fix: routes became
        ['ftp', 'http', 'https', 'unknown'] and a recording proxy received
        `GET ftp://attacker.invalid/loot` carrying `Bearer SECRET`.

        This is the environment the handler is kept FOR, which is what made it
        worth a spec: a proxied runner was the one place it failed open.
        """
        monkeypatch.setenv(proxy_var, "http://127.0.0.1:9/")
        routes = set(_mod._http_only_opener().handle_open)
        assert "ftp" not in routes
        assert "all" not in routes
        assert routes == {"http", "https", "unknown"}

    def test_an_http_proxy_is_still_honoured(self) -> None:
        """The scoping must not become "no proxy support" — that would be a
        silent connectivity regression on exactly the runners it protects."""
        received: list[str] = []

        class ProxyRecorder(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                received.append(self.requestline)
                body = b'{"total": 0, "sessions": []}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: object) -> None:
                pass

        srv = HTTPServer(("127.0.0.1", 0), ProxyRecorder)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            with pytest.MonkeyPatch.context() as mp:
                mp.setenv("http_proxy", f"http://127.0.0.1:{srv.server_address[1]}/")
                mp.setattr(_mod, "_OPENER", _mod._http_only_opener())
                body = _get("http://upstream.invalid/sessions", "tok")
            assert body == {"total": 0, "sessions": []}
            # Proof it went THROUGH the proxy: an absolute-form request line.
            assert received
            assert received[0].startswith("GET http://upstream.invalid/sessions")
        finally:
            srv.shutdown()
            srv.server_close()

    def test_an_ftp_redirect_is_refused_even_when_an_ftp_proxy_is_configured(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The end-to-end form of the case above — the one that went red.

        With `ftp_proxy` set and the unscoped handler, this test failed with the
        SAME `WinError 10061 ... actively refused` as the completely unfixed
        code, i.e. merging would have planted an environment-dependent CI
        failure that no repo guard watches for.
        """
        class Redirector(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.send_response(302)
                self.send_header("Location", "ftp://attacker.invalid/loot")
                self.end_headers()

            def log_message(self, *args: object) -> None:
                pass

        srv = HTTPServer(("127.0.0.1", 0), Redirector)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            monkeypatch.setenv("ftp_proxy", "http://127.0.0.1:9/")
            monkeypatch.setattr(_mod, "_OPENER", _mod._http_only_opener())
            url = f"http://127.0.0.1:{srv.server_address[1]}/sessions"
            # Refused by the REDIRECT guard, which fires before transport
            # selection. That layering is deliberate: the redirect guard is the
            # fix, the missing ftp route is defence in depth beneath it.
            with pytest.raises(urllib.error.HTTPError, match="refusing cross-origin redirect"):
                _get(url, "SECRET")
        finally:
            srv.shutdown()
            srv.server_close()

    def test_an_ftp_redirect_is_refused_without_dialling_out(self) -> None:
        # A real 302 -> ftp:, served locally. Port 1 is chosen so that IF the
        # redirect were followed, the failure would be a CONNECTION error
        # (proving it tried) rather than the refusal we require.
        seen: dict[str, object] = {}

        class Redirector(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                seen["auth"] = self.headers.get("Authorization")
                self.send_response(302)
                self.send_header("Location", "ftp://127.0.0.1:1/loot")
                self.end_headers()

            def log_message(self, *args: object) -> None:
                pass

        srv = HTTPServer(("127.0.0.1", 0), Redirector)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{srv.server_address[1]}/sessions"
            with pytest.raises(urllib.error.HTTPError) as excinfo:
                _get(url, "SECRET")
            # A socket/connection error here would mean the redirect WAS
            # followed and the token left the process.
            assert "refusing cross-origin redirect" in str(excinfo.value)
            # Sanity: the request really did happen and really did carry the token,
            # so the test is exercising the dangerous path, not a no-op.
            assert seen["auth"] == "Bearer SECRET"
        finally:
            srv.shutdown()
            srv.server_close()

    def test_the_ftp_transport_is_absent_independently_of_the_redirect_guard(self) -> None:
        """Defence in depth, tested on its own.

        Every ftp REDIRECT is now stopped one layer earlier, which would leave
        the opener's scheme scoping untested end-to-end. Opening an ftp URL
        directly bypasses the redirect handler entirely and proves the transport
        is genuinely absent rather than merely unreachable-in-practice.
        """
        req = urllib.request.Request("ftp://127.0.0.1:1/loot")
        with pytest.raises(urllib.error.URLError) as excinfo:
            _mod._OPENER.open(req, timeout=5)
        assert "unknown url type" in str(excinfo.value.reason)
        assert "ftp" in str(excinfo.value.reason)

    def test_an_ordinary_http_redirect_is_still_followed(self) -> None:
        # The counterfactual. Locking the opener down must not break normal
        # redirects — otherwise the "fix" is just a broken census.
        class Redirector(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                if self.path == "/sessions":
                    self.send_response(302)
                    self.send_header("Location", "/moved")
                    self.end_headers()
                    return
                body = b'{"total": 1, "sessions": [{"id": 1, "state": "idle"}]}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: object) -> None:
                pass

        srv = HTTPServer(("127.0.0.1", 0), Redirector)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{srv.server_address[1]}/sessions"
            body = _get(url, "tok")
            assert body["sessions"][0]["id"] == 1
        finally:
            srv.shutdown()
            srv.server_close()


class TestCrossOriginRedirect:
    """A redirect to ANOTHER ORIGIN hands the bearer token to that origin.

    This is the guard that actually closes the exfiltration vector. An earlier
    cut removed the `ftp:` transport and declared the redirect vector closed,
    but the `http:` variant needs no proxy variable and is one character's
    difference. Measured against that cut, with `302 -> http://<attacker>/loot`:

        census _get returned: {'total': 0, 'sessions': []}
        ATTACKER RECEIVED path : /loot
        ATTACKER RECEIVED auth : Bearer SUPER_SECRET_TOKEN

    The census SUCCEEDED — the operator would have read a healthy empty pool
    while the token sat in someone else's access log.
    """

    @pytest.fixture(autouse=True)
    def _no_ambient_proxy(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for var in (
            "http_proxy", "https_proxy", "ftp_proxy", "all_proxy", "no_proxy",
            "HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "ALL_PROXY", "NO_PROXY",
        ):
            monkeypatch.delenv(var, raising=False)
        monkeypatch.setattr(_mod, "_OPENER", _mod._http_only_opener())

    @staticmethod
    def _serve(handler: type[BaseHTTPRequestHandler]) -> HTTPServer:
        srv = HTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv

    def test_a_cross_host_http_redirect_never_reaches_the_attacker(self) -> None:
        """THE REGRESSION TEST for the reported exploit, end to end."""
        attacker_saw: list[tuple[str, str | None]] = []

        class Attacker(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                attacker_saw.append((self.path, self.headers.get("Authorization")))
                body = b'{"total": 0, "sessions": []}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: object) -> None:
                pass

        attacker = self._serve(Attacker)
        attacker_port = attacker.server_address[1]

        class Origin(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{attacker_port}/loot")
                self.end_headers()

            def log_message(self, *args: object) -> None:
                pass

        origin = self._serve(Origin)
        try:
            url = f"http://127.0.0.1:{origin.server_address[1]}/sessions"
            with pytest.raises(urllib.error.HTTPError, match="refusing cross-origin redirect"):
                _get(url, "SUPER_SECRET_TOKEN")
            # The assertion that matters. A raise with the token already sent
            # would be no fix at all.
            assert attacker_saw == []
        finally:
            origin.shutdown()
            origin.server_close()
            attacker.shutdown()
            attacker.server_close()

    def test_the_refusal_names_both_origins(self) -> None:
        class Origin(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.send_response(302)
                self.send_header("Location", "http://attacker.invalid/loot")
                self.end_headers()

            def log_message(self, *args: object) -> None:
                pass

        srv = self._serve(Origin)
        try:
            url = f"http://127.0.0.1:{srv.server_address[1]}/sessions"
            with pytest.raises(urllib.error.HTTPError) as excinfo:
                _get(url, "tok")
            text = str(excinfo.value)
            assert "attacker.invalid" in text
            assert "127.0.0.1" in text
            # R7: the message states the actual reason, not a guess.
            assert "Authorization" in text
        finally:
            srv.shutdown()
            srv.server_close()

    @pytest.mark.parametrize(
        "location",
        [
            "https://attacker.invalid/loot",   # scheme change to https
            "ftp://attacker.invalid/loot",     # the branch the opener also blocks
            "//attacker.invalid/loot",         # protocol-relative, inherits scheme
        ],
    )
    def test_every_off_origin_shape_is_refused(self, location: str) -> None:
        class Origin(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.send_response(302)
                self.send_header("Location", location)
                self.end_headers()

            def log_message(self, *args: object) -> None:
                pass

        srv = self._serve(Origin)
        try:
            url = f"http://127.0.0.1:{srv.server_address[1]}/sessions"
            with pytest.raises(urllib.error.HTTPError, match="refusing cross-origin redirect"):
                _get(url, "tok")
        finally:
            srv.shutdown()
            srv.server_close()

    def test_a_scheme_change_on_the_same_host_is_still_off_origin(self) -> None:
        # http -> https on the same host and port is a different origin by this
        # rule, and refused. Deliberate: the token's confidentiality depends on
        # the transport, and a downgrade/upgrade dance is not something a Livy
        # sessions list needs.
        assert _mod._origin("http://h:8080/x") != _mod._origin("https://h:8080/x")

    def test_default_ports_do_not_create_a_false_cross_origin(self) -> None:
        # `http://h/x` and `http://h:80/x` are ONE origin — otherwise a server
        # that normalises the port would be refused for no reason.
        assert _mod._origin("http://h/x") == _mod._origin("http://h:80/x")
        assert _mod._origin("https://h/x") == _mod._origin("https://h:443/x")
        assert _mod._origin("http://H/x") == _mod._origin("http://h/x")

    def test_a_same_origin_path_redirect_is_still_followed(self) -> None:
        # The counterfactual, restated at this layer: the guard must not turn
        # every redirect into a failure.
        class Redirector(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                if self.path == "/sessions":
                    self.send_response(302)
                    self.send_header("Location", "/sessions/")
                    self.end_headers()
                    return
                body = b'{"total": 2, "sessions": [{"id": 1}, {"id": 2}]}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: object) -> None:
                pass

        srv = self._serve(Redirector)
        try:
            url = f"http://127.0.0.1:{srv.server_address[1]}/sessions"
            body = _get(url, "tok")
            assert body["total"] == 2
        finally:
            srv.shutdown()
            srv.server_close()
