"""Arrow Flight SQL serving surface (N3) — end-to-end over a real gRPC wire.

Every test here starts the ACTUAL `LoomFlightSqlServer` on a loopback port and
talks to it with a real `pyarrow.flight` client, so the middleware, the
protobuf codec, the ticket verification, the handle lifecycle and the DuckDB
execution are all exercised together. Nothing is mocked except the audit sink,
which is captured so the access log can be asserted (it is a compliance
artifact, not a debug aid).

Covers the gap in #2543: before this file the Flight surface had zero tests, so
a pyarrow major bump (#2504) had no automated signal.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import sys
import threading
import time
from collections.abc import Iterator
from typing import Any

import pytest

# `pyarrow` (and `pyarrow.flight`) come from the `serving` extra. Skip rather
# than ERROR at collection when it is absent (see test_engine.py).
pytest.importorskip("duckdb", reason="tests/loom_duckdb needs the `serving` extra")
pytest.importorskip("pyarrow.flight", reason="tests/loom_duckdb needs the `serving` extra")

import pyarrow as pa
import pyarrow.flight as flight

from .conftest import load

flightsql = load("flightsql")
pbcodec = load("pbcodec")

SECRET = "flight-test-secret"


# ── helpers ──────────────────────────────────────────────────────────────────
def mint(secret: str | None = SECRET, **over: Any) -> str:
    """Mint the same v1.<payload>.<hmac> ticket the Loom BFF hands out."""
    payload: dict[str, Any] = {
        "aud": "loom-flightsql",
        "oid": "oid-analyst",
        "upn": "analyst@contoso.com",
        "tid": "tenant-1",
        "scope": ["abfss://gold@acct.dfs.core.windows.net/sales"],
        "jti": "ticket-1",
        "exp": int(time.time()) + 300,
    }
    payload.update(over)
    body = base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii").rstrip("=")
    signed = f"v1.{body}"
    mac = hmac.new(secret.encode("utf-8"), signed.encode("utf-8"), hashlib.sha256).digest() if secret else b""
    return f"{signed}.{base64.urlsafe_b64encode(mac).decode('ascii').rstrip('=')}"


def auth(token: str | None) -> flight.FlightCallOptions:
    headers = [(b"authorization", token.encode("utf-8"))] if token is not None else []
    return flight.FlightCallOptions(headers=headers)


def statement_descriptor(sql: str) -> flight.FlightDescriptor:
    """The Any-wrapped CommandStatementQuery an ADBC / JDBC client sends."""
    inner = pbcodec.write_bytes_field(1, sql.encode("utf-8"))
    return flight.FlightDescriptor.for_command(pbcodec.pack_any(pbcodec.TYPE_STATEMENT_QUERY, inner))


def command_descriptor(type_url: str) -> flight.FlightDescriptor:
    return flight.FlightDescriptor.for_command(pbcodec.pack_any(type_url, b""))


class Wire:
    """A live server + client pair with its audit log captured."""

    def __init__(self, server: Any, client: flight.FlightClient, audit: list[dict[str, Any]]) -> None:
        self.server = server
        self.client = client
        self.audit = audit

    def plan(self, sql: str, token: str | None = None) -> flight.FlightInfo:
        return self.client.get_flight_info(statement_descriptor(sql), auth(token or mint()))

    def fetch(self, ticket: flight.Ticket, token: str | None = None) -> pa.Table:
        return self.client.do_get(ticket, auth(token or mint())).read_all()


@pytest.fixture
def wire(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> Iterator[Wire]:
    monkeypatch.setenv("LOOM_FLIGHT_TICKET_SECRET", SECRET)
    monkeypatch.setenv("LOOM_DUCKDB_EXT_DIR", str(tmp_path))
    rows: list[dict[str, Any]] = []
    server = flightsql.LoomFlightSqlServer("grpc://127.0.0.1:0", audit_sink=rows.append)
    client = flight.connect(f"grpc://127.0.0.1:{server.port}")
    try:
        yield Wire(server, client, rows)
    finally:
        client.close()
        server.shutdown()


# ── auth middleware ──────────────────────────────────────────────────────────
class TestAuthMiddleware:
    def test_a_call_with_no_ticket_is_rejected_and_says_where_to_get_one(
        self, wire: Wire
    ) -> None:
        with pytest.raises(flight.FlightUnauthenticatedError) as err:
            wire.client.get_flight_info(statement_descriptor("SELECT 1"))
        assert "Connect tab" in str(err.value)

    def test_an_expired_ticket_is_rejected(self, wire: Wire) -> None:
        with pytest.raises(flight.FlightUnauthenticatedError) as err:
            wire.plan("SELECT 1", token=mint(exp=int(time.time()) - 1))
        assert "expired" in str(err.value)

    def test_a_ticket_signed_with_the_wrong_key_is_rejected(self, wire: Wire) -> None:
        with pytest.raises(flight.FlightUnauthenticatedError) as err:
            wire.plan("SELECT 1", token=mint(secret="not-the-server-key"))
        assert "signature" in str(err.value)

    def test_a_ticket_for_another_audience_is_rejected(self, wire: Wire) -> None:
        with pytest.raises(flight.FlightUnauthenticatedError) as err:
            wire.plan("SELECT 1", token=mint(aud="loom-something-else"))
        assert "audience" in str(err.value)

    def test_a_bearer_prefixed_ticket_is_accepted(self, wire: Wire) -> None:
        assert wire.plan("SELECT 1", token="Bearer " + mint()).schema.names == ["1"]

    def test_rejection_happens_before_any_sql_runs(self, wire: Wire) -> None:
        # The middleware is the first thing on the call path, so an
        # unauthenticated caller cannot even provoke a query — nothing is
        # audited, because nothing was authorized.
        with pytest.raises(flight.FlightUnauthenticatedError):
            wire.client.get_flight_info(statement_descriptor("SELECT 1"))
        assert wire.audit == []


# ── GetFlightInfo (planning) ─────────────────────────────────────────────────
class TestGetFlightInfo:
    def test_planning_returns_the_result_schema_and_a_redeemable_ticket(
        self, wire: Wire
    ) -> None:
        info = wire.plan("SELECT 42 AS answer, 'x' AS label")
        assert info.schema.names == ["answer", "label"]
        assert len(info.endpoints) == 1
        type_url, value = pbcodec.describe_command(info.endpoints[0].ticket.ticket)
        assert type_url == pbcodec.TYPE_TICKET_STATEMENT_QUERY
        assert pbcodec.decode_ticket_statement_query(value)  # a real handle

    def test_planning_is_bounded_to_one_row_and_doesnt_stream_the_result(
        self, wire: Wire, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Planning must NOT materialize the whole table: a client that only
        # calls GetFlightInfo would otherwise pay for the full scan.
        calls: list[Any] = []
        original = flightsql.ENGINE.run

        def spy(sql: str, max_rows: Any = None) -> Any:
            calls.append(max_rows)
            return original(sql, max_rows=max_rows)

        monkeypatch.setattr(flightsql.ENGINE, "run", spy)
        wire.plan("SELECT * FROM range(50000) t(i)")
        assert calls == [1]

    def test_a_bare_sql_descriptor_from_a_simple_client_is_accepted(
        self, wire: Wire
    ) -> None:
        descriptor = flight.FlightDescriptor.for_command(b"SELECT 7 AS n")
        info = wire.client.get_flight_info(descriptor, auth(mint()))
        assert info.schema.names == ["n"]

    def test_get_sql_info_answers_with_the_correctly_typed_empty_table(
        self, wire: Wire
    ) -> None:
        info = wire.client.get_flight_info(
            command_descriptor(pbcodec.TYPE_GET_SQL_INFO), auth(mint())
        )
        assert info.schema.names == ["info_name", "value"]
        assert info.schema.field("info_name").type == pa.uint32()
        assert info.endpoints == []

    def test_an_unserved_command_is_unimplemented_not_a_fabricated_empty_success(
        self, wire: Wire
    ) -> None:
        with pytest.raises(flight.FlightUnavailableError) as err:
            wire.client.get_flight_info(
                command_descriptor(pbcodec.TYPE_GET_TABLES), auth(mint())
            )
        assert "CommandGetTables" in str(err.value)
        assert "CommandStatementQuery" in str(err.value)

    def test_a_write_is_refused_with_the_read_only_reason_and_audited(
        self, wire: Wire
    ) -> None:
        with pytest.raises(flight.FlightServerError) as err:
            wire.plan("DROP TABLE sales")
        assert "read-only" in str(err.value)
        assert [(r["operation"], r["outcome"]) for r in wire.audit] == [
            ("flight.getFlightInfo", "refused")
        ]

    def test_a_broken_query_reports_planning_failure_and_is_audited(
        self, wire: Wire
    ) -> None:
        with pytest.raises(flight.FlightServerError) as err:
            wire.plan("SELECT * FROM no_such_table")
        assert "Query planning failed" in str(err.value)
        assert wire.audit[-1]["outcome"] == "failure"
        assert "no_such_table" in wire.audit[-1]["detail"]


# ── DoGet (streaming) ────────────────────────────────────────────────────────
class TestDoGet:
    def test_the_planned_handle_streams_the_real_arrow_result(self, wire: Wire) -> None:
        info = wire.plan("SELECT i, i * 2 AS doubled FROM range(50) t(i)")
        table = wire.fetch(info.endpoints[0].ticket)
        assert table.num_rows == 50
        assert table.schema.names == ["i", "doubled"]
        assert table.to_pylist()[7] == {"i": 7, "doubled": 14}

    def test_a_handle_is_single_use(self, wire: Wire) -> None:
        # A leaked handle is worthless after one fetch. NOTE this bounds the
        # HANDLE only, not the ticket, while the bare-SQL path is on — see
        # `test_a_bare_sql_ticket_executes_and_is_still_audited` (#2577).
        ticket = wire.plan("SELECT 1").endpoints[0].ticket
        wire.fetch(ticket)
        with pytest.raises(flight.FlightServerError) as err:
            wire.fetch(ticket)
        assert "already redeemed" in str(err.value)

    def test_a_handle_cannot_be_redeemed_by_a_different_ticket(self, wire: Wire) -> None:
        ticket = wire.plan("SELECT 1", token=mint(jti="ticket-A")).endpoints[0].ticket
        with pytest.raises(flight.FlightUnauthenticatedError) as err:
            wire.fetch(ticket, token=mint(jti="ticket-B"))
        assert "different Flight ticket" in str(err.value)

    def test_a_handle_expires_so_a_stale_one_cannot_be_replayed_later(
        self, wire: Wire, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(flightsql, "HANDLE_TTL_S", -1)
        ticket = wire.plan("SELECT 1").endpoints[0].ticket
        with pytest.raises(flight.FlightServerError) as err:
            wire.fetch(ticket)
        assert "unknown or already redeemed" in str(err.value)

    def test_an_unknown_handle_is_refused_rather_than_silently_empty(
        self, wire: Wire
    ) -> None:
        forged = flight.Ticket(pbcodec.encode_ticket_statement_query(b"deadbeef"))
        with pytest.raises(flight.FlightServerError):
            wire.fetch(forged)

    def test_a_bare_sql_ticket_executes_and_is_still_audited(self, wire: Wire) -> None:
        # SCOPED AND DECLARED (#2577), not silently allowed. This path
        # (flightsql.py `do_get`) executes the ticket bytes as raw SQL when they
        # do not decode as a known Flight SQL command, skipping the
        # GetFlightInfo -> handle handshake. It serves plain Arrow Flight
        # clients, so it stays ON by default (Loom's default-ON rule) — but it
        # is now switched off with LOOM_FLIGHT_ALLOW_BARE_SQL=0 (below),
        # reported on /capabilities as `flight.bareSqlTickets`, and logged under
        # its OWN audit operation so a reviewer can tell it from a redeemed
        # handle. The consequence it carries is documented on the module: the
        # handle lifecycle bounds a leaked HANDLE, not a leaked TICKET.
        table = wire.fetch(flight.Ticket(b"SELECT 5 AS n"))
        assert table.to_pylist() == [{"n": 5}]
        assert wire.audit[-1]["operation"] == flightsql.BARE_SQL_OPERATION
        assert wire.audit[-1]["outcome"] == "success"

    def test_the_bare_sql_path_is_distinguishable_from_a_redeemed_handle(
        self, wire: Wire
    ) -> None:
        # BUG CAUGHT (#2577, audit half): both paths used to log
        # `operation: "flight.doGet"` with an identical row shape, so the access
        # log — the ATO artifact — could not answer "did this caller go through
        # the plan/handle handshake, or present arbitrary SQL on a ticket?".
        # Collapse the two operation names back into one and this goes RED.
        info = wire.plan("SELECT 1 AS n")
        wire.fetch(info.endpoints[0].ticket)
        handshake = wire.audit[-1]["operation"]

        wire.fetch(flight.Ticket(b"SELECT 1 AS n"))
        bare = wire.audit[-1]["operation"]

        assert handshake == "flight.doGet"
        assert bare == flightsql.BARE_SQL_OPERATION
        assert handshake != bare

    def test_the_bare_sql_path_can_be_turned_off_so_the_handshake_is_the_boundary(
        self, wire: Wire, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # BUG CAUGHT (#2577, scoping half): before this there was NO way to make
        # the plan->handle handshake a real replay boundary — any holder of a
        # valid, unexpired ticket could DoGet arbitrary read SQL for the rest of
        # its TTL. With LOOM_FLIGHT_ALLOW_BARE_SQL=0 that path is refused, and
        # the refusal is audited like every other one. Delete the flag check in
        # `do_get` and this goes RED (the query executes and returns a table).
        monkeypatch.setenv("LOOM_FLIGHT_ALLOW_BARE_SQL", "0")
        with pytest.raises(flight.FlightUnauthorizedError) as err:
            wire.fetch(flight.Ticket(b"SELECT 5 AS n"))
        # The refusal has to tell the client what to do instead, or it is a
        # silent break of the simple-client contract.
        assert "GetFlightInfo" in str(err.value)
        assert "LOOM_FLIGHT_ALLOW_BARE_SQL=0" in str(err.value)
        assert wire.audit[-1]["operation"] == flightsql.BARE_SQL_OPERATION
        assert wire.audit[-1]["outcome"] == "refused"

    def test_turning_the_bare_sql_path_off_does_not_break_conformant_clients(
        self, wire: Wire, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The reason this is an opt-OUT and not a removal: a conformant Flight
        # SQL / ADBC / JDBC client always calls GetFlightInfo first, so the
        # hardened posture costs it nothing. If closing the bare path also broke
        # the handshake path, this goes RED.
        monkeypatch.setenv("LOOM_FLIGHT_ALLOW_BARE_SQL", "0")
        info = wire.plan("SELECT i FROM range(20) t(i)")
        assert wire.fetch(info.endpoints[0].ticket).num_rows == 20

    def test_do_get_streams_the_full_result_not_the_one_row_plan(
        self, wire: Wire
    ) -> None:
        # The complement of the planning-bound test: the plan fetches 1 row,
        # the fetch must return every row.
        info = wire.plan("SELECT * FROM range(1234) t(i)")
        assert wire.fetch(info.endpoints[0].ticket).num_rows == 1234

    def test_a_write_over_a_bare_ticket_is_refused_and_audited(self, wire: Wire) -> None:
        with pytest.raises(flight.FlightServerError) as err:
            wire.fetch(flight.Ticket(b"DELETE FROM sales"))
        assert "read-only" in str(err.value)
        assert wire.audit[-1]["outcome"] == "refused"
        assert wire.audit[-1]["operation"] == flightsql.BARE_SQL_OPERATION

    def test_a_failing_query_reports_failure_and_is_audited(self, wire: Wire) -> None:
        with pytest.raises(flight.FlightServerError) as err:
            wire.fetch(flight.Ticket(b"SELECT * FROM no_such_table"))
        assert "Query failed" in str(err.value)
        assert wire.audit[-1]["outcome"] == "failure"
        assert wire.audit[-1]["operation"] == flightsql.BARE_SQL_OPERATION

    def test_a_get_sql_info_ticket_yields_the_typed_empty_table(self, wire: Wire) -> None:
        table = wire.fetch(flight.Ticket(pbcodec.pack_any(pbcodec.TYPE_GET_SQL_INFO, b"")))
        assert table.num_rows == 0
        assert table.schema.names == ["info_name", "value"]

    def test_an_unserved_ticket_type_is_refused(self, wire: Wire) -> None:
        ticket = flight.Ticket(pbcodec.pack_any(pbcodec.TYPE_PREPARED_STATEMENT_QUERY, b""))
        with pytest.raises(flight.FlightUnavailableError) as err:
            wire.fetch(ticket)
        assert "CommandPreparedStatementQuery" in str(err.value)


# ── GetSchema + catalog surface ──────────────────────────────────────────────
class TestSchemaAndCatalog:
    def test_get_schema_returns_the_result_schema_without_a_handle(
        self, wire: Wire
    ) -> None:
        schema = wire.client.get_schema(
            statement_descriptor("SELECT 1 AS a, 2.5 AS b"), auth(mint())
        ).schema
        assert schema.names == ["a", "b"]
        assert wire.audit[-1]["operation"] == "flight.getSchema"

    def test_get_schema_for_sql_info_returns_the_dense_union_schema(
        self, wire: Wire
    ) -> None:
        schema = wire.client.get_schema(
            command_descriptor(pbcodec.TYPE_GET_SQL_INFO), auth(mint())
        ).schema
        assert schema.names == ["info_name", "value"]
        assert pa.types.is_union(schema.field("value").type)

    def test_there_is_no_static_flight_catalog_and_no_actions(self, wire: Wire) -> None:
        assert list(wire.client.list_flights(b"", auth(mint()))) == []
        assert list(wire.client.list_actions(auth(mint()))) == []


# ── audit log (the ATO artifact) ─────────────────────────────────────────────
class TestAuditLog:
    def test_every_redemption_records_the_principal_and_the_ticket_id(
        self, wire: Wire
    ) -> None:
        info = wire.plan("SELECT 1 AS n")
        wire.fetch(info.endpoints[0].ticket)
        row = wire.audit[-1]
        assert row["source"] == "loom-duckdb-flightsql"
        assert row["operation"] == "flight.doGet"
        assert row["principalOid"] == "oid-analyst"
        assert row["principalUpn"] == "analyst@contoso.com"
        assert row["tenantId"] == "tenant-1"
        # The join key back to the BFF's mint-time `_auditLog` row.
        assert row["ticketId"] == "ticket-1"
        assert row["ticketVerified"] is True
        assert row["scope"] == ["abfss://gold@acct.dfs.core.windows.net/sales"]
        assert "1 rows in" in row["detail"]
        assert row["at"].endswith("Z")

    def test_an_unsigned_deployment_is_logged_as_unverified_not_as_trusted(
        self, monkeypatch: pytest.MonkeyPatch, wire: Wire
    ) -> None:
        # In-VNet trust mode: the call still works, but the access log must not
        # claim the principal was cryptographically verified.
        monkeypatch.delenv("LOOM_FLIGHT_TICKET_SECRET", raising=False)
        wire.plan("SELECT 1", token=mint(secret=None))
        assert wire.audit[-1]["ticketVerified"] is False

    def test_a_long_statement_is_truncated_in_the_access_log(self, wire: Wire) -> None:
        # The log ships to Log Analytics; an unbounded statement field is how a
        # single pathological query blows the ingestion budget.
        sql = "SELECT '" + ("x" * 4000) + "' AS s"
        wire.plan(sql)
        assert len(wire.audit[-1]["statement"]) == 2000

    def test_the_default_audit_sink_writes_exactly_one_json_line_per_access(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        # Every test above injects its own sink, so the sink the CONTAINER
        # actually runs was never exercised. Container Apps ships stdout to Log
        # Analytics line-by-line: a row that spans two lines is two malformed
        # records, and the ATO join on `ticketId` silently loses half its rows.
        row = {
            "source": "loom-duckdb-flightsql",
            "operation": "flight.doGet",
            "ticketId": "ticket-1",
            "statement": "SELECT 1\n-- a statement with a newline in it",
        }
        with caplog.at_level(logging.INFO, logger="loom-duckdb.flightsql"):
            flightsql._stdout_audit(row)

        emitted = [r.getMessage() for r in caplog.records if r.name == "loom-duckdb.flightsql"]
        assert len(emitted) == 1
        payload = emitted[0].split("flight-access ", 1)[1]
        assert "\n" not in payload
        assert json.loads(payload) == row


# ── coverage instrumentation (#2580) ─────────────────────────────────────────
class TestTracingOnFlightThreads:
    """`sys.settrace` is per-thread; Flight's callbacks are not on our threads.

    coverage.py reaches a thread only by installing its tracer through
    `threading.settrace()`, which CPython applies to threads started via the
    `threading` module. `pyarrow.flight` dispatches every callback on gRPC's
    C++-managed threads, so `flightsql.py` executed in full while the instrument
    reported 26% of it — which is why the file used to be omitted from the gated
    coverage set entirely.

    `arm_tracer()` in `conftest.py` closes that: it hands the active trace
    function to `sys.settrace()` from inside the foreign thread, on entry to
    every Flight callback. This test is the guard on that mechanism — if a
    callback ever runs unarmed again, the coverage number for this file goes
    back to being fiction, and this goes RED instead of the number quietly
    dropping.
    """

    def test_a_flight_callback_runs_on_a_foreign_thread_with_the_tracer_armed(
        self, wire: Wire, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Stand in for coverage.py's own hook so this test means the same thing
        # with and without `--cov`. It DELEGATES to whatever is really installed,
        # so running under coverage still measures the Flight thread normally.
        real = threading.gettrace()

        def probe_trace(frame: Any, event: Any, arg: Any) -> Any:
            return real(frame, event, arg) if real is not None else None

        monkeypatch.setattr(threading, "gettrace", lambda: probe_trace)

        observed: list[tuple[int, Any]] = []
        sink = wire.server._audit

        def record(row: dict[str, Any]) -> None:
            # `_log` runs inside the production callback, on its own thread.
            observed.append((threading.get_ident(), sys.gettrace()))
            sink(row)

        monkeypatch.setattr(wire.server, "_audit", record)

        wire.plan("SELECT 1")

        assert observed, "the Flight callback never reached the audit sink"
        ident, trace_fn = observed[0]

        # CONTROL — holds with and without the fix. It is the premise of #2580:
        # the callback really does run off the main thread. If this ever fails,
        # Flight stopped using foreign threads and the arming is redundant.
        assert ident != threading.get_ident(), (
            "The Flight callback ran on the main thread — the premise of #2580 "
            "no longer holds and conftest.arm_tracer() can be reconsidered."
        )

        assert trace_fn is not None, (
            "A Flight callback ran on an UNTRACED thread: coverage.py cannot "
            "measure apps/loom-duckdb/app/flightsql.py, and any percentage "
            "reported for it is fiction. See arm_tracer() in "
            "tests/loom_duckdb/conftest.py (#2580)."
        )
