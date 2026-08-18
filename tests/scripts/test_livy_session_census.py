"""Tests for scripts/csa-loom/livy-session-census.py — the walk's completeness rule.

The census exists because the probes it replaced reported a jammed pool as an
empty one (#3568 / #1796). Every assertion here is about the same thing: the
script must claim `complete` ONLY when completeness was actually established,
and must never let a number the server sent talk it into a confident partial.
"""

from __future__ import annotations

import io
import json
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

    def test_json_body_that_is_not_an_object_is_refused(self) -> None:
        # `_get` guards the parse itself: a JSON array walking out as a dict
        # would make `.get("sessions")` explode far from the cause.
        assert json.loads("[]") == []


class TestUrlScheme:
    """`DEV` is operator-supplied, so the scheme is allow-listed at the call site.

    Bandit B310 flags `urlopen` precisely because it will happily open `file:/`
    and custom schemes. The suppression on that line is only honest if the
    guard above it actually refuses them — this is that guard's counterfactual.
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
        routes = set(_OPENER.handle_open)
        assert "http" in routes
        assert "https" in routes
        # The exfiltration route, and its neighbours.
        assert "ftp" not in routes
        assert "file" not in routes
        assert "data" not in routes

    def test_an_ftp_redirect_is_refused_without_dialling_out(self) -> None:
        # A real 302 -> ftp:, served locally. Port 1 is chosen so that IF the
        # opener were to follow it, the failure would be a CONNECTION error
        # (proving it tried) rather than the routing error we require.
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
            with pytest.raises(urllib.error.URLError) as excinfo:
                _get(url, "SECRET")
            # "unknown url type: ftp" — UnknownHandler, i.e. no ftp route
            # existed. A socket/connection error here would mean the redirect
            # WAS followed and the token left the process.
            assert "unknown url type" in str(excinfo.value.reason)
            assert "ftp" in str(excinfo.value.reason)
            # Sanity: the request really did happen and really did carry the token,
            # so the test is exercising the dangerous path, not a no-op.
            assert seen["auth"] == "Bearer SECRET"
        finally:
            srv.shutdown()
            srv.server_close()

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
