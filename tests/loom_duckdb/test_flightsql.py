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
        # HANDLE only, not the ticket — see the bare-SQL note on
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
        # DOCUMENTED, NOT ENDORSED. This path (flightsql.py:216-219) executes
        # the ticket bytes as raw SQL when they do not decode as a known Flight
        # SQL command, entirely skipping the GetFlightInfo -> handle handshake.
        # It exists to serve simple ADBC/JDBC clients, and it means the handle
        # lifecycle asserted above (single-use / ticket-bound / TTL) is a
        # RESOURCE-HYGIENE control, not a replay-authorization boundary: a
        # leaked handle is worthless after one fetch, but a leaked ticket buys
        # arbitrary read SQL for the rest of its TTL. Tracked in #2577.
        # What still holds on this path, and is asserted here and below: the
        # read-only guard and the audit log.
        table = wire.fetch(flight.Ticket(b"SELECT 5 AS n"))
        assert table.to_pylist() == [{"n": 5}]
        assert wire.audit[-1]["operation"] == "flight.doGet"
        assert wire.audit[-1]["outcome"] == "success"

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

    def test_a_failing_query_reports_failure_and_is_audited(self, wire: Wire) -> None:
        with pytest.raises(flight.FlightServerError) as err:
            wire.fetch(flight.Ticket(b"SELECT * FROM no_such_table"))
        assert "Query failed" in str(err.value)
        assert wire.audit[-1]["outcome"] == "failure"

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
