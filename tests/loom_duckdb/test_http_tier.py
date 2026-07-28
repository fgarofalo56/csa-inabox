"""HTTP serving tier (N2b) — the surface the Loom BFF proxies.

Runs the REAL FastAPI app against the REAL embedded DuckDB through Starlette's
TestClient: no route is stubbed and no engine is mocked. Arrow responses are
re-read with `pyarrow.ipc`, which is the interop assertion #2543 asked for —
it is what a duckdb-wasm / ADBC client actually does with the body.

The Flight thread is disabled by env in most tests so nothing binds a port;
the startup wiring itself is tested separately with `serve_forever` replaced.
"""
from __future__ import annotations

import threading
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

from .conftest import load

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

    def test_a_snake_case_max_rows_is_ignored_rather_than_bounding_the_page(
        self, client: TestClient
    ) -> None:
        # `maxRows` is the wire contract (`QueryRequest.maxRows`); the BFF sends
        # camelCase. Pydantic's default `extra='ignore'` means a client that
        # sends `max_rows` instead gets an UNBOUNDED query rather than a 422.
        # That is pinned here so a change to it is VISIBLE — it is not an
        # endorsement. Making the model `extra='forbid'` is a wire behaviour
        # change tracked in #2576.
        body = client.post(
            "/query", json={"sql": "SELECT * FROM range(30) t(i)", "max_rows": 5}
        ).json()
        assert body["rowCount"] == 30
        assert body["truncated"] is False


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

    # The dying thread's traceback is the POINT of this test; pytest would
    # otherwise re-raise it as an unhandled-thread-exception warning.
    @pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
    def test_a_crashing_serve_forever_is_isolated_on_its_own_thread(
        self,
        app_module: Any,
        monkeypatch: pytest.MonkeyPatch,
        flight_threads: list[threading.Thread],
        client: TestClient,
    ) -> None:
        # What this establishes (the earlier version of this test did NOT):
        # `_start_flight()` hands `serve_forever` to a separate thread, that
        # thread really runs and really dies, and the HTTP tier keeps serving
        # afterwards. Inline the call (`serve_forever()` instead of
        # `Thread(target=serve_forever).start()`) and no `flight-sql` thread is
        # constructed -> RED. Drop `thread.start()` and the crash never happens
        # -> RED.
        #
        # What it does NOT establish, and no test here does: `/capabilities`
        # still reports `flight.enabled: true` after this thread has died.
        # That is a real defect, tracked in #2578.
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
