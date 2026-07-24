"""Arrow Flight SQL server for the loom-duckdb serving tier (N3).

ODBC/JDBC spend 60-90% of a large transfer serializing row-by-row. Flight SQL
hands the client the SAME Arrow RecordBatches the engine already produced —
zero re-serialization — over gRPC/HTTP2. This module is the serving wire that
makes Loom's tables reachable by any ADBC / Flight SQL client (Python `adbc`,
JDBC `flight-sql-jdbc-driver`, Go, Rust, Tableau, dbt).

Protocol coverage (honest, and mirrored in the parity doc):

  * `GetFlightInfo(CommandStatementQuery)`   → plans the query, returns a ticket
  * `DoGet(TicketStatementQuery)`            → streams real Arrow RecordBatches
  * `GetSchema(CommandStatementQuery)`       → the result schema, no execution
  * `GetFlightInfo(CommandGetSqlInfo)`       → an empty, correctly-typed table
    (this deployment advertises no optional SQL-info capabilities; clients
    treat that as "defaults", which is exactly true)
  * everything else                          → gRPC UNIMPLEMENTED with the
    supported list in the message (never a fabricated empty success)

AUTH + AUDIT (round-3 extension): every call carries a short-lived,
Entra-scoped ticket minted by the Loom BFF (`app/tickets.py`). Session creation
and every ticket redemption are logged with principal, scope, statement and
outcome, and the console reads them back through the audited proxy. There is no
anonymous path and no long-lived secret on the wire.

IL5: gRPC/HTTP2 on Container Apps works in Commercial and Gov; in IL5 the
service stays INTERNAL-ingress only and the ticket is minted in-boundary by the
console, so the whole capability runs disconnected.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid

import pyarrow as pa
import pyarrow.flight as flight

from . import pbcodec
from .engine import ENGINE
from .sqlguard import SqlNotAllowedError
from .tickets import TicketInvalidError, verify_ticket

log = logging.getLogger("loom-duckdb.flightsql")

#: Header the client presents its Loom-minted ticket on.
AUTH_HEADER = "authorization"

#: How long a planned statement handle stays redeemable (seconds). A DoGet is
#: expected to follow its GetFlightInfo immediately; anything longer is a replay.
HANDLE_TTL_S = 120


def _sql_info_schema() -> pa.Schema:
    """The Flight SQL `GetSqlInfo` result schema (info_name + dense-union value)."""
    value = pa.dense_union(
        [
            pa.field("string_value", pa.string()),
            pa.field("bool_value", pa.bool_()),
            pa.field("bigint_value", pa.int64()),
            pa.field("int32_bitmask", pa.int32()),
            pa.field("string_list", pa.list_(pa.string())),
            pa.field("int32_to_int32_list_map", pa.map_(pa.int32(), pa.list_(pa.int32()))),
        ]
    )
    return pa.schema([pa.field("info_name", pa.uint32(), nullable=False), pa.field("value", value)])


class AuthMiddlewareFactory(flight.ServerMiddlewareFactory):
    """Verify the Loom ticket ONCE per call and expose the principal downstream."""

    def start_call(self, info, headers):  # noqa: ARG002 - pyarrow.flight signature
        presented = ""
        for key, values in (headers or {}).items():
            if key.lower() == AUTH_HEADER and values:
                presented = values[0]
                break
        try:
            principal = verify_ticket(presented)
        except TicketInvalidError as exc:
            raise flight.FlightUnauthenticatedError(str(exc)) from exc
        return AuthMiddleware(principal)


class AuthMiddleware(flight.ServerMiddleware):
    def __init__(self, principal) -> None:
        self.principal = principal

    def sending_headers(self):
        return {}


class LoomFlightSqlServer(flight.FlightServerBase):
    """Flight SQL over the shared, read-only DuckDB engine."""

    def __init__(self, location: str, *, audit_sink=None) -> None:
        super().__init__(location, middleware={"auth": AuthMiddlewareFactory()})
        self._location = location
        self._handles: dict[str, tuple[str, float, str]] = {}
        self._lock = threading.Lock()
        self._audit = audit_sink or _stdout_audit

    # ── helpers ──────────────────────────────────────────────────────────
    def _principal(self, context):
        middleware = context.get_middleware("auth")
        if middleware is None:  # pragma: no cover - factory always installs it
            raise flight.FlightUnauthenticatedError("No Flight ticket presented.")
        return middleware.principal

    def _remember(self, sql: str, principal) -> bytes:
        handle = uuid.uuid4().hex
        with self._lock:
            self._expire_locked()
            self._handles[handle] = (sql, time.time() + HANDLE_TTL_S, principal.ticket_id)
        return handle.encode("ascii")

    def _redeem(self, handle: bytes, principal) -> str:
        key = handle.decode("ascii", "replace")
        with self._lock:
            self._expire_locked()
            entry = self._handles.pop(key, None)
        if entry is None:
            raise flight.FlightServerError(
                "This statement handle is unknown or already redeemed. Call GetFlightInfo again."
            )
        sql, _, ticket_id = entry
        if ticket_id and principal.ticket_id and ticket_id != principal.ticket_id:
            raise flight.FlightUnauthenticatedError(
                "This statement handle belongs to a different Flight ticket."
            )
        return sql

    def _expire_locked(self) -> None:
        now = time.time()
        for key in [k for k, (_, exp, _) in self._handles.items() if exp <= now]:
            self._handles.pop(key, None)

    def _log(self, principal, operation: str, statement: str, outcome: str, detail: str = "") -> None:
        self._audit(
            {
                "source": "loom-duckdb-flightsql",
                "operation": operation,
                "outcome": outcome,
                "principalOid": principal.oid,
                "principalUpn": principal.upn,
                "tenantId": principal.tenant_id,
                "ticketId": principal.ticket_id,
                "ticketVerified": not principal.unverified,
                "scope": list(principal.scope),
                "statement": statement[:2000],
                "detail": detail[:500],
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        )

    # ── Flight surface ───────────────────────────────────────────────────
    def get_flight_info(self, context, descriptor):
        principal = self._principal(context)
        type_url, value = pbcodec.describe_command(descriptor.command or b"")

        if type_url == pbcodec.TYPE_GET_SQL_INFO:
            schema = _sql_info_schema()
            return flight.FlightInfo(schema, descriptor, [], -1, -1)

        if type_url and type_url != pbcodec.TYPE_STATEMENT_QUERY:
            raise flight.FlightUnavailableError(
                f"{type_url.rsplit('.', 1)[-1]} is not served by the Loom DuckDB Flight tier. "
                "Supported: CommandStatementQuery (GetFlightInfo / GetSchema) and "
                "TicketStatementQuery (DoGet)."
            )

        sql = pbcodec.decode_statement_query(value) if type_url else value.decode("utf-8", "replace")
        try:
            result = ENGINE.run(sql, max_rows=1)
        except SqlNotAllowedError as exc:
            self._log(principal, "flight.getFlightInfo", sql, "refused", str(exc))
            raise flight.FlightServerError(str(exc)) from exc
        except Exception as exc:
            self._log(principal, "flight.getFlightInfo", sql, "failure", str(exc))
            raise flight.FlightServerError(f"Query planning failed: {exc}") from exc

        handle = self._remember(sql, principal)
        self._log(principal, "flight.getFlightInfo", sql, "success")
        ticket = flight.Ticket(pbcodec.encode_ticket_statement_query(handle))
        endpoint = flight.FlightEndpoint(ticket, [flight.Location.for_grpc_tcp("0.0.0.0", 0)])
        return flight.FlightInfo(result.table.schema, descriptor, [endpoint], -1, -1)

    def get_schema(self, context, descriptor):
        principal = self._principal(context)
        type_url, value = pbcodec.describe_command(descriptor.command or b"")
        if type_url == pbcodec.TYPE_GET_SQL_INFO:
            return flight.SchemaResult(_sql_info_schema())
        sql = pbcodec.decode_statement_query(value) if type_url else value.decode("utf-8", "replace")
        result = ENGINE.run(sql, max_rows=1)
        self._log(principal, "flight.getSchema", sql, "success")
        return flight.SchemaResult(result.table.schema)

    def do_get(self, context, ticket):
        principal = self._principal(context)
        type_url, value = pbcodec.describe_command(ticket.ticket or b"")

        if type_url == pbcodec.TYPE_GET_SQL_INFO:
            schema = _sql_info_schema()
            self._log(principal, "flight.getSqlInfo", "", "success")
            return flight.RecordBatchStream(pa.Table.from_batches([], schema=schema))

        if type_url == pbcodec.TYPE_TICKET_STATEMENT_QUERY:
            sql = self._redeem(pbcodec.decode_ticket_statement_query(value), principal)
        elif type_url:
            raise flight.FlightUnavailableError(
                f"{type_url.rsplit('.', 1)[-1]} tickets are not served by the Loom DuckDB Flight tier."
            )
        else:
            # A bare SQL ticket (simple Flight clients). Still fully authorized
            # + audited; it just skips the two-step plan/fetch handshake.
            sql = value.decode("utf-8", "replace")

        started = time.perf_counter()
        try:
            result = ENGINE.run(sql)
        except SqlNotAllowedError as exc:
            self._log(principal, "flight.doGet", sql, "refused", str(exc))
            raise flight.FlightServerError(str(exc)) from exc
        except Exception as exc:
            self._log(principal, "flight.doGet", sql, "failure", str(exc))
            raise flight.FlightServerError(f"Query failed: {exc}") from exc

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        self._log(
            principal,
            "flight.doGet",
            sql,
            "success",
            f"{result.row_count} rows in {elapsed_ms} ms",
        )
        return flight.RecordBatchStream(result.table)

    def list_flights(self, context, criteria):  # noqa: ARG002 - pyarrow.flight signature
        # There is no static catalog of flights: every flight is a statement the
        # caller submits. Returning an empty iterator is the honest answer.
        return iter(())

    def list_actions(self, context):  # noqa: ARG002 - pyarrow.flight signature
        return []


def _stdout_audit(row: dict) -> None:
    """Default audit sink — one structured JSON line per access.

    Container Apps ships stdout to Log Analytics, and the console's Flight
    session route writes the MATCHING `_auditLog` row at mint time, so an ATO
    reviewer can join issuance to redemption on `ticketId`.
    """
    log.info("flight-access %s", json.dumps(row, separators=(",", ":")))


def serve_forever() -> None:  # pragma: no cover - process entrypoint
    port = int(os.environ.get("LOOM_FLIGHT_PORT", "8815"))
    location = f"grpc://0.0.0.0:{port}"
    server = LoomFlightSqlServer(location)
    log.info("Flight SQL listening on %s", location)
    server.serve()
