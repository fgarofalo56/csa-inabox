"""HTTP serving tier (N2b) — the surface the Loom BFF proxies.

Runs the REAL FastAPI app against the REAL embedded DuckDB through Starlette's
TestClient: no route is stubbed and no engine is mocked. Arrow responses are
re-read with `pyarrow.ipc`, which is the interop assertion #2543 asked for —
it is what a duckdb-wasm / ADBC client actually does with the body.

The Flight thread is disabled by env in most tests so nothing binds a port;
the startup wiring itself is tested separately with `serve_forever` replaced.
"""
from __future__ import annotations

import importlib.util
import sys
import threading
import warnings
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

# `duckdb` / `pyarrow` / `fastapi` come from the `serving` extra. Skip rather
# than ERROR at collection when they are absent (see test_engine.py).
pytest.importorskip("duckdb", reason="tests/loom_duckdb needs the `serving` extra")
pytest.importorskip("pyarrow", reason="tests/loom_duckdb needs the `serving` extra")
pytest.importorskip("fastapi", reason="tests/loom_duckdb needs the `serving` extra")

import duckdb
import pyarrow as pa
from fastapi.testclient import TestClient

from .conftest import PACKAGE, load

ARROW = "application/vnd.apache.arrow.stream"


@pytest.fixture
def app_module(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Any:
    monkeypatch.setenv("LOOM_FLIGHT_ENABLED", "0")
    monkeypatch.setenv("LOOM_DUCKDB_EXT_DIR", str(tmp_path))
    return load("main")


@pytest.fixture
def client(app_module: Any) -> Iterator[TestClient]:
    with TestClient(app_module.app) as test_client:
        yield test_client


class _ThreadingShim:
    """`threading` with only `Thread` swapped, for `app/main.py` ONLY.

    Patching `threading.Thread` itself would mutate the module every other
    consumer in the interpreter sees. Binding this shim to `main.threading`
    scopes the swap to the module under test.
    """

    def __init__(self, real: ModuleType, thread_factory: Any) -> None:
        self._real = real
        self.Thread = thread_factory

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


@pytest.fixture
def flight_threads(app_module: Any, monkeypatch: pytest.MonkeyPatch) -> list[threading.Thread]:
    """Every thread `_start_flight()` constructs, captured synchronously.

    This replaces the previous `time.sleep(0.05); assert not called.is_set()`
    pattern. A negative assertion over a 50 ms window false-passes on a loaded
    CI runner — it cannot distinguish "the thread was never started" from "the
    thread was started but has not been scheduled yet". Whether a thread is
    CONSTRUCTED is decided synchronously inside `_start_flight()`, so this
    assertion has no timing component at all.
    """
    created: list[threading.Thread] = []
    real_threading = app_module.threading
    real_thread_cls = real_threading.Thread

    def factory(*args: Any, **kwargs: Any) -> threading.Thread:
        thread: threading.Thread = real_thread_cls(*args, **kwargs)
        created.append(thread)
        return thread

    monkeypatch.setattr(app_module, "threading", _ThreadingShim(real_threading, factory))
    return created


def arrow_table(body: bytes) -> pa.Table:
    """Read the response body exactly the way an ADBC / duckdb-wasm client does."""
    return pa.ipc.open_stream(pa.py_buffer(body)).read_all()


# ── liveness + capabilities ──────────────────────────────────────────────────
class TestHealthAndCapabilities:
    def test_health_is_a_plain_liveness_answer(self, client: TestClient) -> None:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"ok": True}

    def test_capabilities_reports_the_real_engine_version_and_caps(
        self, client: TestClient
    ) -> None:
        body = client.get("/capabilities").json()
        assert body["ok"] is True
        assert body["engine"] == "duckdb"
        # Compared against the INSTALLED duckdb wheel, not against
        # `app_module.ENGINE.capabilities()['version']` — that was the route's
        # output compared with the very call the route makes, a tautology that
        # would still pass if `capabilities()` returned a hard-coded string.
        # This is also the assertion that makes a duckdb bump a real signal.
        assert body["version"] == duckdb.__version__
        assert body["maxRows"] > 0
        # Honest gate, not a fabricated lake binding.
        assert body["authMode"] == "none"
        assert "LOOM_LAKE_ACCOUNT" in body["setupNote"]

    def test_capabilities_reports_the_flight_wire_honestly_when_disabled(
        self, client: TestClient
    ) -> None:
        flight = client.get("/capabilities").json()["flight"]
        assert flight["enabled"] is False
        assert flight["ticketRequired"] is True

    def test_capabilities_reflects_the_configured_flight_port_and_signing_state(
        self, monkeypatch: pytest.MonkeyPatch, client: TestClient
    ) -> None:
        monkeypatch.setenv("LOOM_FLIGHT_PORT", "9999")
        monkeypatch.setenv("LOOM_FLIGHT_TICKET_SECRET", "s3cret")
        flight = client.get("/capabilities").json()["flight"]
        assert flight["port"] == 9999
        assert flight["ticketSigned"] is True

    def test_an_unsigned_deployment_says_so_instead_of_claiming_signed(
        self, monkeypatch: pytest.MonkeyPatch, client: TestClient
    ) -> None:
        monkeypatch.delenv("LOOM_FLIGHT_TICKET_SECRET", raising=False)
        assert client.get("/capabilities").json()["flight"]["ticketSigned"] is False


# ── POST /query — JSON ───────────────────────────────────────────────────────
class TestQueryJson:
    def test_a_select_returns_typed_columns_and_real_rows(self, client: TestClient) -> None:
        body = client.post("/query", json={"sql": "SELECT 42 AS answer, 'x' AS label"}).json()
        assert body["ok"] is True
        assert body["columns"] == [
            {"name": "answer", "type": "int32"},
            {"name": "label", "type": "string"},
        ]
        assert body["rows"] == [[42, "x"]]
        assert body["rowCount"] == 1
        assert body["truncated"] is False

    def test_json_is_the_default_representation(self, client: TestClient) -> None:
        response = client.post("/query", json={"sql": "SELECT 1"})
        assert response.headers["content-type"].startswith("application/json")

    def test_max_rows_bounds_the_response_and_flags_truncation(
        self, client: TestClient
    ) -> None:
        body = client.post(
            "/query", json={"sql": "SELECT * FROM range(500) t(i)", "maxRows": 25}
        ).json()
        assert body["rowCount"] == 25
        assert len(body["rows"]) == 25
        assert body["truncated"] is True
        assert body["maxRows"] == 25

    def test_a_snake_case_max_rows_is_rejected_rather_than_silently_unbounding(
        self, client: TestClient
    ) -> None:
        # BUG CAUGHT (#2576): `maxRows` is the wire contract; the BFF sends
        # camelCase. Under Pydantic's default `extra='ignore'` a client that
        # typed `max_rows` got 200 with an UNBOUNDED result (bounded only by
        # DEFAULT_MAX_ROWS = 200000) instead of a loud rejection — a typo
        # silently became a full-table scan against the serving tier. Drop
        # `model_config = ConfigDict(extra='forbid')` from `QueryRequest` and
        # this returns 200 with rowCount 30 again.
        response = client.post(
            "/query", json={"sql": "SELECT * FROM range(30) t(i)", "max_rows": 5}
        )
        assert response.status_code == 422
        detail = response.json()["detail"]
        # The 422 must NAME the offending key, or the caller cannot fix the typo.
        assert any("max_rows" in str(item.get("loc", "")) for item in detail), detail

    def test_the_camel_case_contract_the_bff_actually_sends_still_works(
        self, client: TestClient
    ) -> None:
        # The complement of the test above: `extra='forbid'` must reject the
        # typo WITHOUT rejecting the real contract. This is the exact body
        # `apps/fiab-console/lib/azure/duckdb-client.ts` posts.
        body = client.post(
            "/query", json={"sql": "SELECT * FROM range(30) t(i)", "maxRows": 5}
        ).json()
        assert body["ok"] is True
        assert body["rowCount"] == 5
        assert body["truncated"] is True

    def test_an_unknown_key_on_explain_is_rejected_too(self, client: TestClient) -> None:
        # `ExplainRequest` carries the same guarantee; without `extra='forbid'`
        # on it a caller could pass `maxRows` to /explain and believe it applied.
        response = client.post("/explain", json={"sql": "SELECT 1", "maxRows": 5})
        assert response.status_code == 422


# ── POST /query — Arrow IPC ──────────────────────────────────────────────────
class TestQueryArrowStream:
    def test_an_arrow_accept_header_returns_a_readable_ipc_stream(
        self, client: TestClient
    ) -> None:
        response = client.post(
            "/query",
            json={"sql": "SELECT i, i * 2 AS doubled FROM range(300) t(i)"},
            headers={"accept": ARROW},
        )
        assert response.status_code == 200
        assert response.headers["content-type"] == ARROW
        table = arrow_table(response.content)
        assert table.num_rows == 300
        assert table.schema.names == ["i", "doubled"]
        assert table.to_pylist()[9] == {"i": 9, "doubled": 18}

    def test_stats_travel_in_headers_so_the_body_stays_pure_arrow(
        self, client: TestClient
    ) -> None:
        response = client.post(
            "/query",
            json={"sql": "SELECT * FROM range(500) t(i)", "maxRows": 40},
            headers={"accept": ARROW},
        )
        assert response.headers["x-loom-row-count"] == "40"
        assert response.headers["x-loom-truncated"] == "true"
        assert response.headers["x-loom-max-rows"] == "40"
        assert response.headers["x-loom-engine"] == "duckdb"
        assert int(response.headers["x-loom-bytes"]) == len(response.content)
        assert int(response.headers["x-loom-elapsed-ms"]) >= 0
        # The body must still parse as a bare Arrow stream, headers and all.
        assert arrow_table(response.content).num_rows == 40

    def test_an_untruncated_arrow_response_says_so(self, client: TestClient) -> None:
        response = client.post(
            "/query", json={"sql": "SELECT 1 AS n"}, headers={"accept": ARROW}
        )
        assert response.headers["x-loom-truncated"] == "false"

    def test_a_negotiated_accept_list_still_selects_arrow(self, client: TestClient) -> None:
        response = client.post(
            "/query",
            json={"sql": "SELECT 1 AS n"},
            headers={"accept": f"{ARROW}, application/json;q=0.9"},
        )
        assert response.headers["content-type"] == ARROW

    def test_an_empty_result_still_returns_a_schema_bearing_stream(
        self, client: TestClient
    ) -> None:
        response = client.post(
            "/query", json={"sql": "SELECT 1 AS a WHERE false"}, headers={"accept": ARROW}
        )
        table = arrow_table(response.content)
        assert table.num_rows == 0
        assert table.schema.names == ["a"]


# ── error paths ──────────────────────────────────────────────────────────────
class TestQueryErrors:
    def test_a_write_is_refused_with_a_typed_read_only_error(
        self, client: TestClient
    ) -> None:
        response = client.post("/query", json={"sql": "DROP TABLE sales"})
        assert response.status_code == 400
        body = response.json()
        assert body["ok"] is False
        assert body["code"] == "read_only"
        assert "read-only" in body["error"]

    def test_a_write_is_refused_even_when_arrow_was_requested(
        self, client: TestClient
    ) -> None:
        # The refusal must be JSON, not a half-written Arrow stream.
        response = client.post(
            "/query", json={"sql": "INSERT INTO t VALUES (1)"}, headers={"accept": ARROW}
        )
        assert response.status_code == 400
        assert response.json()["code"] == "read_only"

    def test_a_broken_query_reports_the_real_duckdb_message(
        self, client: TestClient
    ) -> None:
        response = client.post("/query", json={"sql": "SELECT * FROM no_such_table"})
        assert response.status_code == 400
        body = response.json()
        assert body["code"] == "query_failed"
        assert "no_such_table" in body["error"]

    def test_an_empty_statement_is_refused_with_guidance(self, client: TestClient) -> None:
        body = client.post("/query", json={"sql": "   "}).json()
        assert body["code"] == "read_only"
        assert "empty" in body["error"].lower()

    def test_a_body_without_sql_fails_the_schema_not_the_engine(
        self, client: TestClient
    ) -> None:
        assert client.post("/query", json={}).status_code == 422

    def test_a_write_hidden_after_a_read_refuses_the_whole_script(
        self, client: TestClient
    ) -> None:
        body = client.post("/query", json={"sql": "SELECT 1; DELETE FROM sales"}).json()
        assert body["code"] == "read_only"
        assert "DELETE" in body["error"]


# ── POST /explain ────────────────────────────────────────────────────────────
class TestExplain:
    def test_explain_returns_the_real_duckdb_physical_plan(self, client: TestClient) -> None:
        body = client.post("/explain", json={"sql": "SELECT 1 AS n"}).json()
        assert body["ok"] is True
        assert body["plan"]["columns"] == [
            {"name": "explain_key", "type": "string"},
            {"name": "explain_value", "type": "string"},
        ]
        assert body["plan"]["rowCount"] >= 1

    def test_explain_plans_the_query_without_ever_executing_it(
        self, client: TestClient, app_module: Any
    ) -> None:
        # The previous version of this test asserted only that 'PROJECTION'
        # appeared in the plan text — which says nothing about execution, since
        # the sentinel literal appears in EXPLAIN's own plan text either way.
        #
        # Non-execution is only provable by making execution OBSERVABLE. A
        # DuckDB scalar UDF counts its own invocations: /explain must plan the
        # call and never make it, while /query on the IDENTICAL statement must
        # make it. Change `explain()` to run `body.sql` instead of
        # `EXPLAIN {body.sql}` and the first assertion goes red.
        calls: list[int] = []

        def probe() -> int:
            calls.append(1)
            return 1

        connection = app_module.ENGINE.connection()
        connection.create_function(
            "loom_explain_probe", probe, [], "BIGINT", side_effects=True
        )
        try:
            planned = client.post(
                "/explain", json={"sql": "SELECT loom_explain_probe() AS sentinel"}
            )
            assert planned.status_code == 200
            assert calls == []  # planned, never executed
            assert "PROJECTION" in str(planned.json()["plan"]["rows"]).upper()

            # The control: the SAME statement through /query DOES execute it,
            # so the counter is proven capable of moving.
            executed = client.post(
                "/query", json={"sql": "SELECT loom_explain_probe() AS sentinel"}
            )
            assert executed.status_code == 200
            assert executed.json()["rows"] == [[1]]
            assert calls == [1]
        finally:
            connection.remove_function("loom_explain_probe")

    def test_a_write_smuggled_into_the_script_is_refused(self, client: TestClient) -> None:
        response = client.post("/explain", json={"sql": "SELECT 1; DROP TABLE sales"})
        assert response.status_code == 400
        assert response.json()["code"] == "read_only"

    def test_an_unplannable_query_reports_explain_failed(self, client: TestClient) -> None:
        response = client.post("/explain", json={"sql": "SELECT * FROM no_such_table"})
        assert response.status_code == 400
        assert response.json()["code"] == "explain_failed"


# ── startup wiring for the Flight thread ─────────────────────────────────────
class TestFlightStartupWiring:
    def test_the_flight_server_starts_on_its_own_daemon_thread(
        self, app_module: Any, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        started = threading.Event()
        seen: dict[str, Any] = {}

        def record() -> None:
            current = threading.current_thread()
            seen["name"] = current.name
            seen["daemon"] = current.daemon
            started.set()

        monkeypatch.setenv("LOOM_FLIGHT_ENABLED", "1")
        monkeypatch.setattr(load("flightsql"), "serve_forever", record)
        app_module._start_flight()
        assert started.wait(timeout=5)
        # Daemon: the Flight wire must never keep a terminating container alive.
        assert seen == {"name": "flight-sql", "daemon": True}

    @pytest.mark.parametrize("value", ["0", "false", "no", "FALSE"])
    def test_the_flight_wire_can_be_opted_out_of(
        self,
        app_module: Any,
        monkeypatch: pytest.MonkeyPatch,
        flight_threads: list[threading.Thread],
        value: str,
    ) -> None:
        called = threading.Event()
        monkeypatch.setenv("LOOM_FLIGHT_ENABLED", value)
        monkeypatch.setattr(load("flightsql"), "serve_forever", called.set)
        app_module._start_flight()
        # Deterministic: no thread was CONSTRUCTED, decided synchronously
        # inside `_start_flight()`. (The old `sleep(0.05)` + `not is_set()`
        # could not tell "never started" from "not scheduled yet".)
        assert flight_threads == []
        assert not called.is_set()

    # The dying thread's traceback used to be the POINT of this test. It is now
    # CAUGHT by the supervisor in `_start_flight` (#2578), so pytest no longer
    # sees an unhandled thread exception — the mark is kept only so the test
    # still passes if a future refactor lets one escape again.
    @pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
    def test_a_crashing_serve_forever_is_isolated_on_its_own_thread(
        self,
        app_module: Any,
        monkeypatch: pytest.MonkeyPatch,
        flight_threads: list[threading.Thread],
        client: TestClient,
    ) -> None:
        # What this establishes: `_start_flight()` hands `serve_forever` to a
        # separate thread, that thread really runs and really dies, and the HTTP
        # tier keeps serving afterwards. Inline the call (`serve_forever()`
        # instead of `Thread(target=...).start()`) and no `flight-sql` thread is
        # constructed -> RED. Drop `thread.start()` and the crash never happens
        # -> RED.
        entered = threading.Event()

        def boom() -> None:
            entered.set()
            raise RuntimeError("no port available")

        monkeypatch.setenv("LOOM_FLIGHT_ENABLED", "1")
        monkeypatch.setattr(load("flightsql"), "serve_forever", boom)

        app_module._start_flight()  # must not raise

        assert [t.name for t in flight_threads] == ["flight-sql"]
        assert entered.wait(timeout=5), "serve_forever was never actually invoked"
        flight_threads[0].join(timeout=5)  # deterministic — no sleep
        assert not flight_threads[0].is_alive()
        assert client.get("/health").status_code == 200


# ── /capabilities must tell the truth about the Flight thread (#2578) ────────
class TestCapabilitiesTracksFlightLiveness:
    def test_capabilities_reports_the_wire_as_up_while_the_thread_is_alive(
        self, app_module: Any, monkeypatch: pytest.MonkeyPatch, client: TestClient
    ) -> None:
        # The live half of the pair below. Without it the crashed-case assertion
        # could be satisfied by hard-coding `enabled: false`, which would be a
        # different lie.
        entered = threading.Event()
        release = threading.Event()

        def block_until_released() -> None:
            entered.set()
            release.wait(timeout=30)

        monkeypatch.setenv("LOOM_FLIGHT_ENABLED", "1")
        monkeypatch.setattr(load("flightsql"), "serve_forever", block_until_released)
        try:
            app_module._start_flight()
            assert entered.wait(timeout=5)
            flight = client.get("/capabilities").json()["flight"]
            assert flight["enabled"] is True
            assert flight["configured"] is True
            assert flight["running"] is True
            assert flight["error"] is None
        finally:
            release.set()

    @pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
    def test_capabilities_stops_claiming_the_wire_is_up_once_the_thread_dies(
        self,
        app_module: Any,
        monkeypatch: pytest.MonkeyPatch,
        flight_threads: list[threading.Thread],
        client: TestClient,
    ) -> None:
        # BUG CAUGHT (#2578): `_start_flight()` used to wrap only the import and
        # `thread.start()`, so an exception raised INSIDE `serve_forever` died
        # unhandled in the daemon thread while `/capabilities` kept computing
        # `flight.enabled` from `LOOM_FLIGHT_ENABLED` alone — it went on
        # claiming the wire was up. `/capabilities` is the honest-gate surface
        # the console reads, so that is a `no-vaporware` lie, not just noise.
        #
        # Revert `enabled` to the bare env read and this goes RED on the first
        # assertion; drop the `_supervised` wrapper and it goes RED on `error`.
        monkeypatch.setenv("LOOM_FLIGHT_ENABLED", "1")

        def boom() -> None:
            raise RuntimeError("Address already in use: 8815")

        monkeypatch.setattr(load("flightsql"), "serve_forever", boom)
        app_module._start_flight()
        assert [t.name for t in flight_threads] == ["flight-sql"]
        flight_threads[0].join(timeout=5)
        assert not flight_threads[0].is_alive()

        flight = client.get("/capabilities").json()["flight"]
        assert flight["enabled"] is False, "capabilities still claims a dead wire is up"
        assert flight["running"] is False
        # `configured` stays true — the deployment DID ask for the wire. The
        # degraded state is reported, not hidden.
        assert flight["configured"] is True
        # A capability endpoint that reports a degraded state must say WHY.
        assert "Address already in use" in flight["error"]

    def test_a_wire_that_could_not_be_imported_is_reported_not_claimed_up(
        self, app_module: Any, monkeypatch: pytest.MonkeyPatch, client: TestClient
    ) -> None:
        # The honest-gate case for a deployment whose image is missing
        # `pyarrow.flight`: the import inside `_start_flight()` fails, no thread
        # is ever constructed, and `/capabilities` has to say so with the reason
        # rather than reporting the wire as up (#2578).
        monkeypatch.setenv("LOOM_FLIGHT_ENABLED", "1")
        monkeypatch.delattr(load("flightsql"), "serve_forever")

        app_module._start_flight()  # must not raise

        flight = client.get("/capabilities").json()["flight"]
        assert flight["enabled"] is False
        assert flight["running"] is False
        assert flight["configured"] is True
        assert "serve_forever" in flight["error"]

    def test_a_thread_that_will_not_start_is_reported_not_claimed_up(
        self, app_module: Any, monkeypatch: pytest.MonkeyPatch, client: TestClient
    ) -> None:
        # A host out of threads: `thread.start()` itself raises. The handle must
        # NOT be left on the state (a never-started Thread reports
        # `is_alive() == False`, but keeping it would mean `error` and `thread`
        # disagree about what happened).
        class _WontStart:
            name = "flight-sql"

            def __init__(self, *args: Any, **kwargs: Any) -> None:
                pass

            def start(self) -> None:
                raise RuntimeError("can't start new thread")

        monkeypatch.setenv("LOOM_FLIGHT_ENABLED", "1")
        monkeypatch.setattr(load("flightsql"), "serve_forever", lambda: None)
        monkeypatch.setattr(
            app_module, "threading", _ThreadingShim(app_module.threading, _WontStart),
        )

        app_module._start_flight()  # must not raise

        assert app_module.FLIGHT.thread is None
        flight = client.get("/capabilities").json()["flight"]
        assert flight["enabled"] is False
        assert "can't start new thread" in flight["error"]

    def test_a_disabled_wire_reports_no_error_rather_than_a_fabricated_one(
        self, client: TestClient
    ) -> None:
        # The `client` fixture starts the app with LOOM_FLIGHT_ENABLED=0.
        # "Turned off" and "crashed" must not look the same to the console.
        flight = client.get("/capabilities").json()["flight"]
        assert flight == {
            "enabled": False,
            "configured": False,
            "running": False,
            "error": None,
            "port": 8815,
            "ticketRequired": True,
            "ticketSigned": False,
            "bareSqlTickets": True,
        }

    def test_capabilities_reports_the_bare_sql_ticket_posture(
        self, monkeypatch: pytest.MonkeyPatch, client: TestClient
    ) -> None:
        # #2577: the bare-SQL DoGet path is ON by default and switched off with
        # LOOM_FLIGHT_ALLOW_BARE_SQL=0. Whichever posture is live has to be
        # DISCOVERABLE from /capabilities rather than implied by the docstring.
        assert client.get("/capabilities").json()["flight"]["bareSqlTickets"] is True
        monkeypatch.setenv("LOOM_FLIGHT_ALLOW_BARE_SQL", "0")
        assert client.get("/capabilities").json()["flight"]["bareSqlTickets"] is False


# ── lifespan migration (#2579) ───────────────────────────────────────────────
class TestLifespanWiring:
    def test_the_app_module_constructs_with_no_deprecated_startup_hook(
        self, app_module: Any
    ) -> None:
        # BUG CAUGHT (#2579): `app/main.py` used `@app.on_event("startup")`,
        # deprecated since FastAPI 0.93 and removed in starlette 1.x. Under
        # `-W error::DeprecationWarning` the decorator RAISES, so re-executing
        # the real source file with warnings-as-errors is a direct test: restore
        # `@app.on_event("startup")` and this goes RED with
        # `DeprecationWarning: on_event is deprecated`.
        #
        # A FRESH module object is used (not `load("main")`, which is cached
        # session-wide) so the warning is emitted here rather than at first
        # import. The relative imports still resolve through the synthetic
        # package, so `ENGINE` stays the one process-wide singleton.
        source = Path(app_module.__file__)
        key = f"{PACKAGE}.main_deprecation_probe"
        spec = importlib.util.spec_from_file_location(key, source)
        assert spec is not None
        assert spec.loader is not None
        probe = importlib.util.module_from_spec(spec)
        # `@dataclass` resolves its own module out of `sys.modules`, so the
        # probe has to be registered before it executes — and removed after, so
        # this scratch copy is not left visible to the rest of the session.
        sys.modules[key] = probe
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", DeprecationWarning)
                spec.loader.exec_module(probe)
        finally:
            sys.modules.pop(key, None)
        assert probe.app.title == "loom-duckdb"

    def test_the_lifespan_handler_is_what_starts_the_flight_thread(
        self, app_module: Any, monkeypatch: pytest.MonkeyPatch,
        flight_threads: list[threading.Thread],
    ) -> None:
        # The migration is only done if startup is still WIRED. This drives the
        # real ASGI lifespan through TestClient rather than calling
        # `_start_flight()` by hand: drop `lifespan=lifespan` from the
        # `FastAPI(...)` call and no thread is ever constructed -> RED.
        entered = threading.Event()
        monkeypatch.setenv("LOOM_FLIGHT_ENABLED", "1")
        monkeypatch.setattr(load("flightsql"), "serve_forever", entered.set)
        with TestClient(app_module.app) as started:
            assert started.get("/health").status_code == 200
            assert [t.name for t in flight_threads] == ["flight-sql"]
            assert entered.wait(timeout=5)
