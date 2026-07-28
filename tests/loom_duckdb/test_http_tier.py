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
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pyarrow as pa
import pytest
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
        self, client: TestClient, app_module: Any
    ) -> None:
        body = client.get("/capabilities").json()
        assert body["ok"] is True
        assert body["engine"] == "duckdb"
        assert body["version"] == app_module.ENGINE.capabilities()["version"]
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

    def test_the_wire_contract_is_camel_case_max_rows(self, client: TestClient) -> None:
        # The BFF sends `maxRows`; a snake_case body is NOT the contract and
        # must not silently bound the response to some other number.
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

    def test_explain_plans_without_executing_the_query(self, client: TestClient) -> None:
        # The plan text must describe the query, never carry its result rows.
        body = client.post("/explain", json={"sql": "SELECT 424242 AS sentinel"}).json()
        flattened = str(body["plan"]["rows"])
        assert "PROJECTION" in flattened.upper()
        assert body["plan"]["columns"][0]["name"] == "explain_key"

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
        self, app_module: Any, monkeypatch: pytest.MonkeyPatch, value: str
    ) -> None:
        called = threading.Event()
        monkeypatch.setenv("LOOM_FLIGHT_ENABLED", value)
        monkeypatch.setattr(load("flightsql"), "serve_forever", called.set)
        app_module._start_flight()
        time.sleep(0.05)
        assert not called.is_set()

    # The dying thread's traceback is the POINT of this test; pytest would
    # otherwise re-raise it as an unhandled-thread-exception warning.
    @pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
    def test_a_flight_thread_that_dies_does_not_take_the_http_tier_with_it(
        self, app_module: Any, monkeypatch: pytest.MonkeyPatch, client: TestClient
    ) -> None:
        def boom() -> None:
            raise RuntimeError("no port available")

        monkeypatch.setenv("LOOM_FLIGHT_ENABLED", "1")
        monkeypatch.setattr(load("flightsql"), "serve_forever", boom)
        app_module._start_flight()
        time.sleep(0.05)
        assert client.get("/health").status_code == 200
