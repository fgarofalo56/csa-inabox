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

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .engine import ENGINE, arrow_ipc_bytes
from .sqlguard import SqlNotAllowedError

logging.basicConfig(level=os.environ.get("LOOM_DUCKDB_LOG_LEVEL", "INFO"))
log = logging.getLogger("loom-duckdb")

app = FastAPI(title="loom-duckdb", version="1.0.0")

ARROW_STREAM_MIME = "application/vnd.apache.arrow.stream"


class QueryRequest(BaseModel):
    sql: str
    # The BFF sends camelCase on the wire; the field name IS the contract.
    maxRows: int | None = None  # noqa: N815


class ExplainRequest(BaseModel):
    sql: str


@app.on_event("startup")
def _start_flight() -> None:
    """Start the Flight SQL server alongside the HTTP API (same process, same engine)."""
    if (os.environ.get("LOOM_FLIGHT_ENABLED", "1") or "1").strip().lower() in {"0", "false", "no"}:
        log.info("Flight SQL disabled by LOOM_FLIGHT_ENABLED")
        return
    try:
        from .flightsql import serve_forever

        thread = threading.Thread(target=serve_forever, name="flight-sql", daemon=True)
        thread.start()
    except Exception as exc:
        log.warning("Flight SQL server did not start: %s", exc)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/capabilities")
def capabilities() -> dict[str, object]:
    caps = ENGINE.capabilities()
    caps["flight"] = {
        "enabled": (os.environ.get("LOOM_FLIGHT_ENABLED", "1") or "1").strip().lower()
        not in {"0", "false", "no"},
        "port": int(os.environ.get("LOOM_FLIGHT_PORT", "8815")),
        "ticketRequired": True,
        "ticketSigned": bool((os.environ.get("LOOM_FLIGHT_TICKET_SECRET") or "").strip()),
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
