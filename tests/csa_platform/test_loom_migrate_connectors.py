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

import ast
import http.server
import importlib.util
import io
import subprocess
import sys
import textwrap
import threading
import urllib.error
import urllib.request
from http.client import HTTPMessage
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
                req, io.BytesIO(b""), 302, "Found", HTTPMessage(), "https://attacker.invalid/loot"
            )

    def test_a_scheme_downgrade_and_a_port_change_are_refused(self) -> None:
        handler = _mod._SameOriginRedirectHandler()
        base = urllib.request.Request("https://adb-123.azuredatabricks.net/api/2.1/x")
        for target in (
            "http://adb-123.azuredatabricks.net/api/2.1/x",
            "https://adb-123.azuredatabricks.net:8443/api/2.1/x",
        ):
            with pytest.raises(urllib.error.HTTPError, match="refusing cross-origin redirect"):
                handler.redirect_request(base, io.BytesIO(b""), 302, "Found", HTTPMessage(), target)

    def test_a_same_origin_redirect_is_still_followed(self) -> None:
        handler = _mod._SameOriginRedirectHandler()
        req = urllib.request.Request("https://adb-123.azuredatabricks.net/api/2.1/x")
        redirected = handler.redirect_request(
            req, io.BytesIO(b""), 302, "Found", HTTPMessage(), "https://adb-123.azuredatabricks.net/api/2.1/x/"
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
            req, io.BytesIO(b""), 302, "Found", HTTPMessage(), "https://attacker.invalid/loot"
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


# ---------------------------------------------------------------------------
# #4184 — EVERY `HTTPRedirectHandler` subclass in the repo carries typeshed's
# signature, not just this one.
# ---------------------------------------------------------------------------
#
# WHY THIS IS A REPO-WIDE POPULATION SCAN AND NOT SIX HARD-CODED PATHS. The
# defect #4184 records is not "these six files are untyped" — it is that the
# credential-safe opener introduced by #3717 was COPY-PASTED into every
# deployable that could not import a shared one (the SDK, the CLI, the migrate
# app, the Content Safety function, two operator scripts, the notebook
# preamble), and the untyped override travelled with each copy. A list of six
# paths would go green the moment somebody pastes a seventh. So the population
# is DISCOVERED — every tracked `.py`, every class whose bases name
# `HTTPRedirectHandler` — and the count is asserted so a discovery that finds
# nothing cannot pass vacuously.
#
# WHAT AN UNTYPED OVERRIDE ACTUALLY COSTS, since "add annotations" reads
# cosmetic: an untyped def is `Any` in both directions under mypy, so a drifted
# signature — wrong arity, `code`/`msg` swapped, a `str` where urllib passes an
# `HTTPMessage` — type-checks clean and raises `TypeError` only when a real 3xx
# arrives. That is the exact path the guard exists for and the one a unit test
# reaching the handler directly does not exercise, so the failure would land in
# production, on a redirect, in the code that is supposed to stop a credential
# leaving the origin.

_HTTPMESSAGE_HANDLER_BASE = "HTTPRedirectHandler"

#: typeshed's signature for `HTTPRedirectHandler.redirect_request`, which is
#: what every override must repeat. Checked by NAME so this stays readable when
#: a site spells it `urllib.request.Request` vs a bare `Request`.
#:
#: An ORDERED list of (name, type) pairs, not a dict, and the order is
#: load-bearing. The first cut compared a dict, and dict equality is
#: order-insensitive: swapping the `code: int` and `msg: str` lines — each
#: still annotated correctly, just in the wrong positions — left this guard
#: green. `urllib.request.HTTPRedirectHandler.http_error_302` calls
#: `redirect_request` POSITIONALLY, so that swap is a real `TypeError` on the
#: exact 3xx path this guard exists to cover, and the one drift shape #4184
#: names by name was the shape it could not see.
_EXPECTED_ARG_ORDER = [
    ("req", "urllib.request.Request"),
    ("fp", "IO[bytes]"),
    ("code", "int"),
    ("msg", "str"),
    ("headers", "HTTPMessage"),
    ("newurl", "str"),
]
_EXPECTED_RETURN = "urllib.request.Request | None"

#: Sites known at the time #4184 was fixed. Asserted as a FLOOR, not an exact
#: set — a seventh copy of the opener must make this test stricter, never
#: silently weaker.
_KNOWN_REDIRECT_HANDLER_SITES = 7


def _repo_root() -> Path:
    """The tree CONTAINING THIS FILE — not whatever tree pytest was launched in.

    This was `git rev-parse --show-toplevel` with no `cwd=`, so the population
    came from the process's working directory. MEASURED 2026-09-07: running
    this exact file with a different checkout as cwd reported six offenders
    that do not exist in the tree containing it (untyped overrides + three
    type-ignores, all from the OTHER checkout). CI happens to run from the repo
    root so it was green there, but the failure mode is symmetric and the other
    direction is a FALSE GREEN — a worktree whose overrides had regressed would
    be measured against a clean sibling checkout and pass.

    `parents[2]` because this file is `<root>/tests/csa_platform/<this>.py`.
    Derived from `__file__` rather than a subprocess so it cannot depend on the
    ambient cwd at all.
    """
    root = Path(__file__).resolve().parents[2]
    assert (root / "tests" / "csa_platform").is_dir(), (
        f"the derived repo root {root} does not contain tests/csa_platform, so "
        "this file moved and the parents[2] hop is wrong — fail rather than "
        "scan the wrong tree"
    )
    return root


def _tracked_python_files(root: Path) -> list[str]:
    # `git ls-files`, NOT `os.walk`: the walk over this repo takes ~10s because
    # of the console's dependency trees, and every exclusion list I would have
    # to maintain is another way for a file to fall out of the population
    # unnoticed. If git is not available this raises — an unmeasurable
    # population must fail, never skip.
    out = subprocess.run(
        ["git", "ls-files", "-z", "--", "*.py"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return [f for f in out.split("\0") if f]


def _redirect_request_overrides(root: Path) -> list[tuple[str, ast.FunctionDef]]:
    """Every `redirect_request` defined on an `HTTPRedirectHandler` subclass."""
    found: list[tuple[str, ast.FunctionDef]] = []
    for rel in _tracked_python_files(root):
        path = root / rel
        try:
            raw = path.read_bytes()
        except OSError:  # pragma: no cover - a tracked file that is not present
            continue
        if _HTTPMESSAGE_HANDLER_BASE.encode() not in raw:
            continue
        # `type_comments=True` because the notebook preamble
        # (`loom-semantic-link.py`) is embedded verbatim into a Spark session
        # and annotates with type comments so the signature can never become an
        # import-time failure on an interpreter we do not control. Parsing
        # without this flag would read that file as untyped and the guard would
        # report a defect that is not there.
        tree = ast.parse(raw.decode("utf-8"), filename=rel, type_comments=True)
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            bases = [ast.unparse(b) for b in node.bases]
            if not any(b.split(".")[-1] == _HTTPMESSAGE_HANDLER_BASE for b in bases):
                continue
            for child in node.body:
                if isinstance(child, ast.FunctionDef) and child.name == "redirect_request":
                    found.append((rel, child))
    return found


def _arg_type(arg: ast.arg) -> str | None:
    if arg.annotation is not None:
        rendered = ast.unparse(arg.annotation)
        # A quoted forward reference is still an annotation; strip the quotes so
        # `"IO[bytes]"` and `IO[bytes]` compare equal.
        if rendered[:1] in ("'", '"') and rendered[-1:] == rendered[:1]:
            rendered = rendered[1:-1]
        return rendered
    return arg.type_comment


def _arg_signature(fn: ast.FunctionDef) -> list[tuple[str, str | None]]:
    """The override's ordered (name, type) pairs, `self` dropped.

    Ordered, because `HTTPRedirectHandler.http_error_302` calls
    `redirect_request` POSITIONALLY — so two correctly-annotated parameters in
    the wrong positions is a runtime `TypeError` on the 3xx path, not a
    cosmetic difference.
    """
    return [(a.arg, _arg_type(a)) for a in fn.args.args if a.arg != "self"]


def _return_type(fn: ast.FunctionDef) -> str | None:
    if fn.returns is not None:
        rendered = ast.unparse(fn.returns)
        if rendered[:1] in ("'", '"') and rendered[-1:] == rendered[:1]:
            rendered = rendered[1:-1]
        return rendered
    if fn.type_comment and "->" in fn.type_comment:
        return fn.type_comment.split("->", 1)[1].strip()
    return None


class TestEveryRedirectHandlerOverrideIsTyped:
    def test_the_population_is_the_one_this_guard_was_written_over(self) -> None:
        # POPULATION ACCOUNTING FIRST. Every assertion below is a loop, and a
        # loop over an empty list is green. If the discovery breaks — git
        # missing, a rename, a base class spelled some new way — this is the
        # test that says so instead of the suite quietly measuring nothing.
        overrides = _redirect_request_overrides(_repo_root())
        assert len(overrides) >= _KNOWN_REDIRECT_HANDLER_SITES, (
            f"found only {len(overrides)} redirect_request overrides "
            f"({[rel for rel, _ in overrides]}); #4184 fixed "
            f"{_KNOWN_REDIRECT_HANDLER_SITES}, so the scan is broken, not the code"
        )

    def test_every_override_repeats_typeshed_argument_types(self) -> None:
        # ORDER-SENSITIVE, deliberately: see _EXPECTED_ARG_ORDER. Comparing an
        # ordered list of (name, type) pairs is what makes a positional swap
        # visible; a dict comparison here was green on it. The case below is
        # this assertion's positive control.
        offenders = []
        for rel, fn in _redirect_request_overrides(_repo_root()):
            actual = _arg_signature(fn)
            if actual != _EXPECTED_ARG_ORDER:
                offenders.append((rel, actual))
        assert not offenders, (
            "redirect_request overrides that do not repeat typeshed's argument "
            f"names and types IN ORDER {_EXPECTED_ARG_ORDER}: {offenders}"
        )

    def test_the_argument_check_is_red_on_a_positional_swap(self) -> None:
        # POSITIVE CONTROL for the assertion above, on the ONE drift shape #4184
        # names by name: "a swapped `code`/`msg`".
        #
        # MEASURED, 2026-09-07, on the real tree: swapping the `code: int` and
        # `msg: str` LINES in `apps/loom-migrate/app/connectors.py` — both
        # annotations untouched, only their order — left the dict comparison
        # this replaced at `pytest -k Typed` RC=0 while
        # `mypy apps/loom-migrate/app/connectors.py` was RC=1 with two
        # `[override]` errors. mypy over these seven copies is invoked by
        # nothing in CI (`pyproject.toml`'s `[tool.mypy] files` is
        # `csa_platform/governance` + `tests`; `copilot-evals.yml` scopes to
        # `apps/copilot/**` and is `continue-on-error`), so that swap would have
        # merged green everywhere. This case pins the guard itself rather than
        # its subject, so a future simplification back to an order-insensitive
        # comparison goes red HERE instead of silently re-opening the hole.
        good = textwrap.dedent(
            """
            class H(urllib.request.HTTPRedirectHandler):
                def redirect_request(
                    self,
                    req: urllib.request.Request,
                    fp: IO[bytes],
                    code: int,
                    msg: str,
                    headers: HTTPMessage,
                    newurl: str,
                ) -> urllib.request.Request | None: ...
            """
        )
        swapped = good.replace(
            "        code: int,\n        msg: str,\n",
            "        msg: str,\n        code: int,\n",
        )
        assert swapped != good, "the mutation must actually change the source"

        def signature_of(src: str) -> list[tuple[str, str | None]]:
            fn = next(
                n
                for n in ast.walk(ast.parse(src))
                if isinstance(n, ast.FunctionDef) and n.name == "redirect_request"
            )
            return _arg_signature(fn)

        assert signature_of(good) == _EXPECTED_ARG_ORDER, (
            "precondition: the unmutated signature must be accepted, or this "
            "control proves nothing"
        )
        assert signature_of(swapped) != _EXPECTED_ARG_ORDER, (
            "a positional code/msg swap must be REJECTED — http_error_302 calls "
            "redirect_request positionally, so it is a 302-time TypeError"
        )
        # And name the failure mode precisely: the swap is invisible to a
        # name-keyed dict, which is exactly why the comparison is a list.
        assert dict(signature_of(swapped)) == dict(signature_of(good)), (
            "the swap is by construction invisible to an order-insensitive "
            "comparison; if this ever fails the mutation stopped being the one "
            "the guard was hardened against"
        )

    def test_every_override_declares_its_return_type(self) -> None:
        offenders = [
            (rel, _return_type(fn))
            for rel, fn in _redirect_request_overrides(_repo_root())
            if _return_type(fn) != _EXPECTED_RETURN
        ]
        assert not offenders, (
            f"redirect_request overrides not returning {_EXPECTED_RETURN!r}: {offenders}"
        )

    def test_no_override_suppresses_the_report_instead_of_answering_it(self) -> None:
        # The shape this issue replaced: `# type: ignore[no-untyped-def]` on the
        # def line. A suppression moves the error, it does not answer it — and
        # under this repo's `warn_unused_ignores = true` a stale one is itself a
        # failure, so re-adding it is never the smaller change.
        root = _repo_root()
        offenders = []
        for rel, fn in _redirect_request_overrides(root):
            lines = (root / rel).read_text(encoding="utf-8").splitlines()
            # The SIGNATURE lines only, not "everything before the first
            # statement". The first cut sliced to `fn.body[0].lineno` and went
            # red on the prose in this very repo that NAMES the suppression it
            # replaced — a guard that cannot tell a `# type: ignore` from the
            # word "type: ignore" in a comment reports its own documentation as
            # the defect.
            sig_end = max(
                [fn.lineno]
                + [a.end_lineno or fn.lineno for a in fn.args.args]
                + ([fn.returns.end_lineno or fn.lineno] if fn.returns else [])
            )
            header = "".join(lines[fn.lineno - 1 : sig_end + 1])
            if "type: ignore" in header:
                offenders.append(rel)
        assert not offenders, (
            f"redirect_request overrides still carrying a type-ignore: {offenders}"
        )
