"""CSA Loom — DuckDB serving tier Container App (N2b + N3).

The FAST PATH BELOW SPARK. Interactive SQL over Delta / Iceberg / Parquet on the
customer's own ADLS Gen2 with sub-second cold start, served two ways from ONE
embedded engine:

  * HTTP  (`POST /query`)  — JSON for small grids, or the raw **Arrow IPC
    stream** when the caller sends `Accept: application/vnd.apache.arrow.stream`.
    This is what the Loom BFF proxies, so Loom's own large-result grids get the
    identical zero-serialization Arrow batches the engine produced.
  * Flight SQL (gRPC, port 8815) — the ADBC / JDBC serving wire for EXTERNAL
    engines. Same DuckDB process, same Arrow batches, no re-serialization.

Auth to the lake is the container's USER-ASSIGNED MANAGED IDENTITY. There are no
storage keys and no secrets in app settings. Internal ingress only: the console
BFF is the sole door for HTTP, and Flight requires a short-lived, Entra-scoped
ticket the BFF mints and audits.

Endpoints
---------
  GET  /health        liveness/readiness
  GET  /capabilities  engine version, loaded extensions, lake account, caps
  POST /query         { sql, maxRows? } → JSON or Arrow IPC stream
  POST /explain       { sql } → the real DuckDB physical plan (no execution)

No Microsoft Fabric / OneLake / Power BI is contacted from any path.
"""
from __future__ import annotations

import logging
import os
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from .engine import ENGINE, arrow_ipc_bytes, env_enabled
from .sqlguard import SqlNotAllowedError

logging.basicConfig(level=os.environ.get("LOOM_DUCKDB_LOG_LEVEL", "INFO"))
log = logging.getLogger("loom-duckdb")

ARROW_STREAM_MIME = "application/vnd.apache.arrow.stream"

#: Env flag names, named once so `/capabilities` and the starter cannot drift.
FLIGHT_ENABLED_FLAG = "LOOM_FLIGHT_ENABLED"
BARE_SQL_FLAG = "LOOM_FLIGHT_ALLOW_BARE_SQL"


class QueryRequest(BaseModel):
    # `extra='forbid'`: an unknown key is a 422, not a silent no-op. Pydantic's
    # default (`ignore`) meant a `max_rows` typo for `maxRows` returned 200 with
    # an UNBOUNDED result instead of a loud rejection (#2576). The BFF
    # (`apps/fiab-console/lib/azure/duckdb-client.ts`) posts exactly
    # `{sql, maxRows}` — `JSON.stringify` drops `maxRows` when it is undefined —
    # so nothing in Loom sends a key this rejects.
    model_config = ConfigDict(extra="forbid")

    sql: str
    # The BFF sends camelCase on the wire; the field name IS the contract.
    maxRows: int | None = None  # noqa: N815


class ExplainRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sql: str


@dataclass
class FlightState:
    """What the Flight wire is ACTUALLY doing, for `/capabilities` to report.

    `/capabilities` is the honest-gate surface the console reads, so it must
    report the thread's real liveness rather than re-deriving "enabled" from the
    env var the operator set. A `serve_forever` that raises inside the daemon
    thread used to leave `/capabilities` claiming the wire was up (#2578).
    """

    thread: threading.Thread | None = None
    #: Last startup / serve failure, verbatim. `None` once a start succeeds.
    error: str | None = None

    def running(self) -> bool:
        return self.thread is not None and self.thread.is_alive()


FLIGHT = FlightState()


def _start_flight() -> None:
    """Start the Flight SQL server alongside the HTTP API (same process, same engine)."""
    FLIGHT.thread = None
    FLIGHT.error = None
    if not env_enabled(FLIGHT_ENABLED_FLAG):
        log.info("Flight SQL disabled by %s", FLIGHT_ENABLED_FLAG)
        return
    try:
        from .flightsql import serve_forever
    except Exception as exc:
        FLIGHT.error = f"{type(exc).__name__}: {exc}"
        log.warning("Flight SQL server did not start: %s", exc)
        return

    def _supervised() -> None:
        """Run the wire and RECORD its death instead of dying unhandled.

        Without this the exception vanished into the daemon thread and only the
        thread's liveness (invisible to `/capabilities`) changed.
        """
        try:
            serve_forever()
        except BaseException as exc:  # the thread boundary IS the handler
            FLIGHT.error = f"{type(exc).__name__}: {exc}"
            log.warning("Flight SQL server stopped: %s", exc)

    thread = threading.Thread(target=_supervised, name="flight-sql", daemon=True)
    FLIGHT.thread = thread
    try:
        thread.start()
    except Exception as exc:
        FLIGHT.thread = None
        FLIGHT.error = f"{type(exc).__name__}: {exc}"
        log.warning("Flight SQL server did not start: %s", exc)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Startup/shutdown. Replaces the deprecated `@app.on_event` (#2579).

    The shared Python CI env also installs the apps that pin `fastapi==0.115.x`
    (platform/runners/script-runner, apps/fiab-dbt-runner, apps/loom-migrate,
    apps/fiab-wrangler-host, apps/loom-transform-runner, examples/ai-agents).
    fastapi 0.115.x and this app's fastapi 0.140.13 are mutually exclusive —
    0.115.x requires `starlette<0.42`, 0.140.13 requires `starlette>=0.46` — so
    the install ORDER decides which stack the tests measure. `.github/workflows/
    test.yml` therefore installs THIS requirements.txt LAST and asserts every
    resolved version against it (#2615); before that fix the loop downgraded
    fastapi and tests/loom_duckdb passed against a FastAPI the image never runs.

    The Flight thread is a daemon and is torn down with the process, so there is
    nothing to unwind after the yield.
    """
    _start_flight()
    yield


app = FastAPI(title="loom-duckdb", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/capabilities")
def capabilities() -> dict[str, object]:
    caps = ENGINE.capabilities()
    configured = env_enabled(FLIGHT_ENABLED_FLAG)
    running = FLIGHT.running()
    caps["flight"] = {
        # The TRUTH, not the intent: a configured wire whose thread has died
        # reports `enabled: false` with the reason in `error` (#2578).
        "enabled": configured and running,
        #: What the deployment asked for.
        "configured": configured,
        #: Whether the serving thread is alive right now.
        "running": running,
        #: Last startup / serve failure, or null.
        "error": FLIGHT.error,
        "port": int(os.environ.get("LOOM_FLIGHT_PORT", "8815")),
        "ticketRequired": True,
        "ticketSigned": bool((os.environ.get("LOOM_FLIGHT_TICKET_SECRET") or "").strip()),
        # Whether `DoGet(Ticket(b"SELECT ..."))` is served without the
        # plan->handle handshake. Reported so the posture is discoverable
        # instead of implied (#2577).
        "bareSqlTickets": env_enabled(BARE_SQL_FLAG),
    }
    return {"ok": True, **caps}


@app.post("/query")
async def query(body: QueryRequest, request: Request) -> Response:
    accept = (request.headers.get("accept") or "").lower()
    try:
        result = ENGINE.run(body.sql, max_rows=body.maxRows)
    except SqlNotAllowedError as exc:
        return JSONResponse({"ok": False, "error": str(exc), "code": "read_only"}, status_code=400)
    except Exception as exc:
        return JSONResponse({"ok": False, "error": str(exc), "code": "query_failed"}, status_code=400)

    if ARROW_STREAM_MIME in accept:
        payload = arrow_ipc_bytes(result.table)
        return Response(
            content=payload,
            media_type=ARROW_STREAM_MIME,
            headers={
                # Stats travel in headers so the body stays a pure Arrow stream
                # any ADBC/duckdb-wasm reader can consume unmodified.
                "x-loom-row-count": str(result.row_count),
                "x-loom-elapsed-ms": str(result.elapsed_ms),
                "x-loom-truncated": "true" if result.truncated else "false",
                "x-loom-max-rows": str(result.max_rows),
                "x-loom-engine": "duckdb",
                "x-loom-bytes": str(len(payload)),
            },
        )

    return JSONResponse({"ok": True, **result.to_json()})


@app.post("/explain")
def explain(body: ExplainRequest) -> Response:
    try:
        result = ENGINE.run(f"EXPLAIN {body.sql}")
    except SqlNotAllowedError as exc:
        return JSONResponse({"ok": False, "error": str(exc), "code": "read_only"}, status_code=400)
    except Exception as exc:
        return JSONResponse({"ok": False, "error": str(exc), "code": "explain_failed"}, status_code=400)
    return JSONResponse({"ok": True, "plan": result.to_json()})
