"""#3717 — the credential-safe opener in scripts/csa-loom/loom-unity-migrate-catalog.py.

THE VECTOR. ``UnityClient._request`` sends ``Authorization: Bearer <the
operator's Unity token>`` to two base URLs supplied on the COMMAND LINE. It used
to call ``urllib.request.urlopen``, i.e. the DEFAULT GLOBAL OPENER, and:

* ``HTTPRedirectHandler.redirect_request`` rebuilds the Request copying EVERY
  header except content-length/content-type — urllib does NOT strip
  ``Authorization`` across a host change the way ``requests`` does;
* ``http_error_302`` permits a ``Location:`` whose scheme is in
  ``('http','https','ftp','')``, and the default handler set installs
  ``FTPHandler`` / ``FileHandler`` / ``DataHandler`` with NO proxy variable set.

The ``__init__`` scheme allow-list covers the URL the script BUILDS. It says
nothing about where the SERVER redirects to, and the plain cross-host ``http:``
variant needs no proxy variable and no unusual scheme.

Every assertion below is on one of two things: what the ATTACKER received (an
empty log is the only proof nothing was sent), or what the STDLIB would have
done with the same inputs (the counterfactual — without it, "the guard refuses
something" does not establish that the something was a leak).
"""

from __future__ import annotations

import http.server
import io
import threading
import urllib.error
import urllib.request
from http.client import HTTPMessage
from pathlib import Path

import pytest

from tests.conftest import load_script_module

_SCRIPT_PATH = (
    Path(__file__).resolve().parents[2] / "scripts" / "csa-loom" / "loom-unity-migrate-catalog.py"
)
_mod = load_script_module("loom_unity_migrate_catalog", _SCRIPT_PATH)


class TestTheOpenerHasNoNonHttpTransport:
    def test_ftp_file_and_data_routes_are_absent(self) -> None:
        # `build_opener(HTTPHandler, HTTPSHandler, HTTPRedirectHandler)` does NOT
        # produce this — its arguments only DE-DUPLICATE the default handler set,
        # and ftp/file/data stay installed. Measured; that is why the handler
        # list is built explicitly rather than with build_opener.
        routes = set(_mod._OPENER.handle_open)
        assert "ftp" not in routes
        assert "file" not in routes
        assert "data" not in routes

    def test_the_routes_we_actually_need_are_present(self) -> None:
        # Without this the assertion above is satisfied by an opener that can
        # open nothing at all, which would be a broken migration, not a fix.
        routes = set(_mod._OPENER.handle_open)
        assert "http" in routes
        assert "https" in routes

    def test_an_ftp_proxy_env_var_cannot_re_register_the_ftp_route(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # `ProxyHandler.__init__` does `setattr(self, '%s_open' % type, …)` for
        # EVERY key in the proxies dict, and the default `ProxyHandler()` reads
        # `getproxies()`. One `ftp_proxy` therefore puts the ftp route straight
        # back on an otherwise-locked-down opener — and it fails OPEN, because
        # `proxy_open` re-dispatches to the proxy over HTTP with the headers
        # intact. Scoping the dict to http/https is what stops that.
        monkeypatch.setenv("ftp_proxy", "http://127.0.0.1:9")
        assert "ftp" not in set(_mod._http_only_opener().handle_open)

    def test_scoping_the_proxy_dict_does_not_break_no_proxy(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The reasonable worry about filtering `getproxies()`: it returns
        # `no_proxy` as a `'no'` key that the comprehension drops. It does not
        # matter — `ProxyHandler.proxy_open` calls the module-level
        # `proxy_bypass()`, which re-reads the environment itself.
        monkeypatch.setenv("no_proxy", "127.0.0.1")
        assert urllib.request.proxy_bypass("127.0.0.1")
        _mod._http_only_opener()

    def test_an_http_proxy_is_still_honoured(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # This script's documented invocation is "from inside the VNet", which is
        # exactly where a proxy is configured. Scoping must not disable it.
        monkeypatch.setenv("http_proxy", "http://proxy.internal:8080")
        assert "http" in set(_mod._http_only_opener().handle_open)


class TestTheRedirectGuard:
    def test_a_cross_host_redirect_is_refused(self) -> None:
        handler = _mod._SameOriginRedirectHandler()
        req = urllib.request.Request(
            "https://loom-unity.internal/api/2.1/unity-catalog/catalogs",
            headers={"Authorization": "Bearer UNITY_SECRET"},
        )
        with pytest.raises(urllib.error.HTTPError) as excinfo:
            handler.redirect_request(
                req, io.BytesIO(b""), 302, "Found", HTTPMessage(), "https://attacker.invalid/loot"
            )
        assert "refusing cross-origin redirect" in str(excinfo.value)

    def test_a_scheme_downgrade_is_refused(self) -> None:
        handler = _mod._SameOriginRedirectHandler()
        req = urllib.request.Request("https://loom-unity.internal/api/2.1/unity-catalog/catalogs")
        with pytest.raises(urllib.error.HTTPError, match="refusing cross-origin redirect"):
            handler.redirect_request(
                req, io.BytesIO(b""), 302, "Found", HTTPMessage(),
                "http://loom-unity.internal/api/2.1/unity-catalog/catalogs",
            )

    def test_a_port_change_is_refused(self) -> None:
        handler = _mod._SameOriginRedirectHandler()
        req = urllib.request.Request("https://loom-unity.internal/api/2.1/unity-catalog/catalogs")
        with pytest.raises(urllib.error.HTTPError, match="refusing cross-origin redirect"):
            handler.redirect_request(
                req, io.BytesIO(b""), 302, "Found", HTTPMessage(),
                "https://loom-unity.internal:8443/api/2.1/unity-catalog/catalogs",
            )

    def test_a_same_origin_redirect_is_still_followed(self) -> None:
        # Without this the guard is indistinguishable from a client that cannot
        # follow redirects at all.
        handler = _mod._SameOriginRedirectHandler()
        req = urllib.request.Request("https://loom-unity.internal/api/2.1/unity-catalog/catalogs")
        redirected = handler.redirect_request(
            req, io.BytesIO(b""), 302, "Found", HTTPMessage(),
            "https://loom-unity.internal/api/2.1/unity-catalog/catalogs/",
        )
        assert redirected is not None
        assert redirected.full_url.endswith("/catalogs/")

    def test_the_host_comparison_is_case_insensitive(self) -> None:
        # DNS is case-insensitive; a guard that treated `LOOM-UNITY.INTERNAL` as
        # a different origin would refuse a legitimate redirect and get relaxed.
        handler = _mod._SameOriginRedirectHandler()
        req = urllib.request.Request("https://loom-unity.internal/api/2.1/unity-catalog/catalogs")
        redirected = handler.redirect_request(
            req, io.BytesIO(b""), 302, "Found", HTTPMessage(),
            "https://LOOM-UNITY.INTERNAL/api/2.1/unity-catalog/catalogs/",
        )
        assert redirected is not None

    def test_the_stdlib_handler_would_have_leaked_the_token(self) -> None:
        # THE COUNTERFACTUAL. This runs the STDLIB handler over the same inputs
        # and reads the rebuilt Request's headers — establishing that what the
        # guard refuses was in fact a credential leak, not merely a redirect.
        req = urllib.request.Request(
            "https://loom-unity.internal/api/2.1/unity-catalog/catalogs",
            headers={"Authorization": "Bearer UNITY_SECRET"},
        )
        # A real HTTPMessage, not `{}` — see the twin in
        # tests/scripts/test_semantic_link_redirect.py. The stdlib signature
        # wants one, and an empty dict is not the shape urllib passes in
        # production, so the counterfactual would have exercised something the
        # real path never sees.
        leaked = urllib.request.HTTPRedirectHandler().redirect_request(
            req, io.BytesIO(b""), 302, "Found", HTTPMessage(), "https://attacker.invalid/loot"
        )
        assert leaked is not None
        assert leaked.full_url.startswith("https://attacker.invalid/")
        assert leaked.get_header("Authorization") == "Bearer UNITY_SECRET"


class TestEndToEndOverRealSockets:
    def test_a_cross_host_redirect_never_reaches_the_attacker(self) -> None:
        """Two local servers; the assertion is on the ATTACKER's log.

        An exception could be raised for any reason. The empty log is the only
        thing that proves the token was never sent.
        """
        received: list[str | None] = []

        class Attacker(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                received.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *_args: object) -> None:
                pass

        attacker = http.server.HTTPServer(("127.0.0.1", 0), Attacker)
        attacker_port = attacker.server_address[1]

        class Origin(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{attacker_port}/loot")
                self.end_headers()

            def log_message(self, *_args: object) -> None:
                pass

        origin = http.server.HTTPServer(("127.0.0.1", 0), Origin)
        for srv in (attacker, origin):
            threading.Thread(target=srv.serve_forever, daemon=True).start()
        # THE OUTCOME IS CAPTURED, NOT ASSERTED INLINE. With `pytest.raises(…)`
        # around the call, a regression that re-followed the redirect fails on
        # "DID NOT RAISE" and the attacker-log assertion below never runs — red
        # for the weaker reason, with the real evidence unread.
        outcome: object = None
        try:
            client = _mod.UnityClient(
                f"http://127.0.0.1:{origin.server_address[1]}", "UNITY_SECRET", "source"
            )
            try:
                outcome = client._request("GET", "/catalogs")
            except urllib.error.HTTPError as exc:
                outcome = exc
        finally:
            for srv in (attacker, origin):
                srv.shutdown()
                srv.server_close()

        assert received == [], f"the Unity token reached the attacker: {received!r}"
        assert isinstance(outcome, urllib.error.HTTPError), f"the redirect was followed: {outcome!r}"
        assert "refusing cross-origin redirect" in str(outcome)

    def test_a_same_origin_redirect_still_completes_the_request(self) -> None:
        # THE CONTROL for the spec above. Without it, "no request reached the
        # attacker" is equally satisfied by a client that can no longer follow
        # any redirect, and the migration would be broken rather than fixed.
        class Server(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                if self.path.endswith("/catalogs"):
                    self.send_response(302)
                    self.send_header("Location", f"{self.path}/")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"catalogs": [{"name": "main"}]}')

            def log_message(self, *_args: object) -> None:
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), Server)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            client = _mod.UnityClient(f"http://127.0.0.1:{srv.server_address[1]}", "UNITY_SECRET", "source")
            payload = client._request("GET", "/catalogs")
        finally:
            srv.shutdown()
            srv.server_close()
        assert payload == {"catalogs": [{"name": "main"}]}


class TestTheSchemeAllowListStillHolds:
    def test_a_file_base_url_is_refused_at_construction(self) -> None:
        with pytest.raises(ValueError, match="refusing base URL with scheme"):
            _mod.UnityClient("file:///etc/passwd", None, "source")

    def test_a_base_url_with_no_host_is_refused(self) -> None:
        with pytest.raises(ValueError, match="has no host"):
            _mod.UnityClient("https://", None, "source")
