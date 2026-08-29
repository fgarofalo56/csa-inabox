"""#3717 — the credential-safe opener in apps/loom-migrate/app/connectors.py.

THE VECTOR. ``_get_json`` and ``_post_json`` send
``Authorization: Bearer <the operator's source-estate token>`` — a Databricks
PAT, a Snowflake token, a Fabric/Power BI token — to a host the OPERATOR
supplied. Both used to call ``urllib.request.urlopen``, i.e. the DEFAULT GLOBAL
OPENER, and:

* ``HTTPRedirectHandler.redirect_request`` rebuilds the Request copying EVERY
  header except content-length/content-type; urllib does NOT strip
  ``Authorization`` across a host change the way ``requests`` does;
* ``http_error_302`` permits a ``Location:`` whose scheme is in
  ``('http','https','ftp','')``, and the default handler set installs
  ``FTPHandler`` / ``FileHandler`` / ``DataHandler`` with NO proxy variable set.

So a hostile or compromised migration source answering
``302 -> http://attacker/loot`` receives the operator's credential for their
production estate — and the call SUCCEEDS, so nothing raises and nothing is
logged.

BOTH HELPERS ARE EXERCISED. The issue names two sites in this file
(``connectors.py:95`` and ``:117``), and a fix asserted only on the GET half
would leave the POST half unproven — which is how #3891 shipped with three of
its four verbs uncovered.
"""

from __future__ import annotations

import http.server
import importlib.util
import io
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

_MODULE_PATH = (
    Path(__file__).resolve().parents[2] / "apps" / "loom-migrate" / "app" / "connectors.py"
)


def _load_connectors():
    """Load `apps/loom-migrate/app/connectors.py` as a standalone module.

    NOT `tests.conftest.load_script_module`, and the difference is not stylistic:
    that helper does not register the module in `sys.modules`, and
    `connectors.py` declares `@dataclass` classes. `dataclasses._is_type` looks
    the owning module up by name (`sys.modules.get(cls.__module__).__dict__`) and
    dies with `AttributeError: 'NoneType' object has no attribute '__dict__'`
    when it is absent — measured, not assumed. Registering before `exec_module`
    is the fix; the helper is left alone because it is shared with other suites.
    """
    spec = importlib.util.spec_from_file_location("loom_migrate_connectors", _MODULE_PATH)
    assert spec is not None
    assert spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


_mod = _load_connectors()


class _RecordingPair:
    """An origin that 302s to an attacker that records what it receives."""

    def __init__(self) -> None:
        self.received: list[str | None] = []
        received = self.received

        class Attacker(http.server.BaseHTTPRequestHandler):
            def _record(self) -> None:
                received.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")

            do_GET = _record  # noqa: N815
            do_POST = _record  # noqa: N815

            def log_message(self, *_args: object) -> None:
                pass

        self.attacker = http.server.HTTPServer(("127.0.0.1", 0), Attacker)
        attacker_port = self.attacker.server_address[1]

        class Origin(http.server.BaseHTTPRequestHandler):
            def _bounce(self) -> None:
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{attacker_port}/loot")
                self.end_headers()

            do_GET = _bounce  # noqa: N815
            do_POST = _bounce  # noqa: N815

            def log_message(self, *_args: object) -> None:
                pass

        self.origin = http.server.HTTPServer(("127.0.0.1", 0), Origin)

    def __enter__(self) -> _RecordingPair:
        for srv in (self.attacker, self.origin):
            threading.Thread(target=srv.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *_exc: object) -> None:
        for srv in (self.attacker, self.origin):
            srv.shutdown()
            srv.server_close()

    @property
    def origin_url(self) -> str:
        return f"http://127.0.0.1:{self.origin.server_address[1]}/api/2.1/unity-catalog/catalogs"


class TestTheOpenerHasNoNonHttpTransport:
    def test_ftp_file_and_data_routes_are_absent(self) -> None:
        routes = set(_mod._OPENER.handle_open)
        assert "ftp" not in routes
        assert "file" not in routes
        assert "data" not in routes

    def test_the_routes_the_connectors_need_are_present(self) -> None:
        # Otherwise the assertion above is satisfied by an opener that can open
        # nothing, which is a broken connector rather than a fixed one.
        routes = set(_mod._OPENER.handle_open)
        assert "http" in routes
        assert "https" in routes

    def test_an_ftp_proxy_env_var_cannot_re_register_the_ftp_route(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # loom-migrate runs in a container that may well sit behind a proxy, and
        # an unscoped `ProxyHandler()` fails OPEN there: `proxy_open`
        # re-dispatches to the proxy over HTTP with the headers intact.
        monkeypatch.setenv("ftp_proxy", "http://127.0.0.1:9")
        assert "ftp" not in set(_mod._http_only_opener().handle_open)

    def test_an_http_proxy_is_still_honoured(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("http_proxy", "http://proxy.internal:8080")
        assert "http" in set(_mod._http_only_opener().handle_open)


class TestTheRedirectGuard:
    def test_a_cross_host_redirect_is_refused(self) -> None:
        handler = _mod._SameOriginRedirectHandler()
        req = urllib.request.Request(
            "https://adb-123.azuredatabricks.net/api/2.1/unity-catalog/catalogs",
            headers={"Authorization": "Bearer DATABRICKS_PAT"},
        )
        with pytest.raises(urllib.error.HTTPError, match="refusing cross-origin redirect"):
            handler.redirect_request(
                req, io.BytesIO(b""), 302, "Found", {}, "https://attacker.invalid/loot"
            )

    def test_a_scheme_downgrade_and_a_port_change_are_refused(self) -> None:
        handler = _mod._SameOriginRedirectHandler()
        base = urllib.request.Request("https://adb-123.azuredatabricks.net/api/2.1/x")
        for target in (
            "http://adb-123.azuredatabricks.net/api/2.1/x",
            "https://adb-123.azuredatabricks.net:8443/api/2.1/x",
        ):
            with pytest.raises(urllib.error.HTTPError, match="refusing cross-origin redirect"):
                handler.redirect_request(base, io.BytesIO(b""), 302, "Found", {}, target)

    def test_a_same_origin_redirect_is_still_followed(self) -> None:
        handler = _mod._SameOriginRedirectHandler()
        req = urllib.request.Request("https://adb-123.azuredatabricks.net/api/2.1/x")
        redirected = handler.redirect_request(
            req, io.BytesIO(b""), 302, "Found", {}, "https://adb-123.azuredatabricks.net/api/2.1/x/"
        )
        assert redirected is not None

    def test_the_stdlib_handler_would_have_leaked_the_token(self) -> None:
        # THE COUNTERFACTUAL — without it the refusals above do not establish
        # that what is being refused was ever a credential leak.
        req = urllib.request.Request(
            "https://adb-123.azuredatabricks.net/api/2.1/unity-catalog/catalogs",
            headers={"Authorization": "Bearer DATABRICKS_PAT"},
        )
        leaked = urllib.request.HTTPRedirectHandler().redirect_request(
            req, io.BytesIO(b""), 302, "Found", {}, "https://attacker.invalid/loot"
        )
        assert leaked is not None
        assert leaked.get_header("Authorization") == "Bearer DATABRICKS_PAT"


class TestEndToEndOverRealSockets:
    # THE OUTCOME IS CAPTURED, NOT ASSERTED INLINE, in both specs below. With
    # `pytest.raises(…)` wrapping the call, a regression that re-followed the
    # redirect fails on "DID NOT RAISE" and the attacker-log assertion never runs
    # — red for the weaker reason, with the real evidence unread. Measured while
    # mutation-testing this file, so it is fixed rather than noted.

    def test_get_json_never_hands_the_token_to_the_redirect_target(self) -> None:
        outcome: object = None
        with _RecordingPair() as pair:
            try:
                outcome = _mod._get_json(pair.origin_url, "DATABRICKS_PAT", timeout=5)
            except _mod.ConnectorError as exc:
                outcome = exc
        assert pair.received == [], f"the token reached the attacker: {pair.received!r}"
        # The connector maps the refusal onto its own error type, so the BFF gets
        # a real reason rather than an opaque traceback.
        assert isinstance(outcome, _mod.ConnectorError), f"the redirect was followed: {outcome!r}"
        assert "302" in str(outcome)

    def test_post_json_never_hands_the_token_to_the_redirect_target(self) -> None:
        # THE SECOND SITE (connectors.py:117). Asserting only the GET half would
        # leave this one unproven, and it is the half that carries a body.
        outcome: object = None
        with _RecordingPair() as pair:
            try:
                outcome = _mod._post_json(
                    pair.origin_url, "SNOWFLAKE_TOKEN", {"q": "SHOW TABLES"}, timeout=5
                )
            except _mod.ConnectorError as exc:
                outcome = exc
        assert pair.received == [], f"the token reached the attacker: {pair.received!r}"
        assert isinstance(outcome, _mod.ConnectorError), f"the redirect was followed: {outcome!r}"

    def test_a_same_origin_redirect_still_completes(self) -> None:
        # THE CONTROL. Without it, both specs above are equally satisfied by a
        # connector that can no longer follow any redirect at all — which would
        # be a broken migration reported as a fixed one.
        class Server(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                if not self.path.endswith("/"):
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
            got = _mod._get_json(
                f"http://127.0.0.1:{srv.server_address[1]}/api/2.1/unity-catalog/catalogs",
                "DATABRICKS_PAT",
                timeout=5,
            )
        finally:
            srv.shutdown()
            srv.server_close()
        assert got == {"catalogs": [{"name": "main"}]}


class TestTheSchemeGuardAtTheCallSite:
    def test_a_file_url_is_refused_by_get_json(self) -> None:
        with pytest.raises(_mod.ConnectorError, match="refusing non-http"):
            _mod._get_json("file:///etc/passwd", "TOKEN")

    def test_a_file_url_is_refused_by_post_json(self) -> None:
        with pytest.raises(_mod.ConnectorError, match="refusing non-http"):
            _mod._post_json("file:///etc/passwd", "TOKEN", {})

    def test_the_refusal_is_a_400_not_a_502(self) -> None:
        # R7 — the status must state what was established. A non-http source URL
        # is a bad REQUEST, not an unreachable source; reporting it as 502 would
        # send the operator to check network reachability for a typo.
        with pytest.raises(_mod.ConnectorError) as excinfo:
            _mod._get_json("ftp://source.invalid/inventory", "TOKEN")
        assert excinfo.value.status == 400
