"""
report-accel — CSA Loom report / semantic-layer query accelerator.

The opt-in DuckDB-over-Delta fast path behind LOOM_REPORT_ACCEL_URL. It reads the
lakehouse Delta files DIRECTLY from ADLS Gen2 (via the DuckDB `delta` + `azure`
extensions) and answers aggregating report visuals at interactive speed — Loom's
Azure-native, no-Fabric equivalent of Fabric "Direct Lake" (import-mode speed on
Delta without a Fabric capacity). The Next.js console (report-accel-client.ts)
folds each visual's wells + filters into a compact `AccelSemanticQuery` and POSTs
it here; this service compiles that to DuckDB SQL over `delta_scan('<url>')`,
binds every value as a parameter (injection-safe), and returns columnar rows.

Auth to ADLS: the DuckDB `azure` extension uses a `credential_chain` secret, so
the Container App's user-assigned managed identity (granted "Storage Blob Data
Reader" on the lakehouse — see report-accel.bicep) is what reads the Delta. No
keys, no Fabric, no OneLake — plain ADLS Gen2 Delta.

Endpoints:
  GET  /health  → liveness/readiness probe ({"status":"ok"})
  POST /query   → run an AccelSemanticQuery, return {columns, rows, sql, deltaVersion, elapsedMs}

This is a NARROW compiler by design: single Delta table, GROUP BY + a fixed set
of aggregates + a safe filter subset (eq/ne/gt/ge/lt/le/in/contains/between). The
console only ever routes visuals it can express here; everything else stays on
Synapse Serverless. Nothing here is mocked — an unreadable Delta path returns a
real 5xx and the console falls back to Serverless.
"""

from __future__ import annotations

import os
import re
import time
from typing import List, Optional, Literal

import duckdb
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="csa-loom report-accel", version="1.0.0")

# ── DuckDB connection (single, extension-loaded, secret-configured) ───────────

_con: Optional[duckdb.DuckDBPyConnection] = None


def _connection() -> duckdb.DuckDBPyConnection:
    """Lazily create the DuckDB connection with delta + azure extensions and an
    ADLS credential-chain secret (managed identity). Reused across requests."""
    global _con
    if _con is not None:
        return _con
    con = duckdb.connect(database=":memory:")
    con.execute("INSTALL delta; LOAD delta;")
    con.execute("INSTALL azure; LOAD azure;")
    # Credential-chain secret → the Container App's managed identity reads ADLS.
    # An explicit account name (LOOM_ADLS_ACCOUNT) scopes the secret; otherwise a
    # global credential-chain secret covers every account the identity can read.
    account = os.environ.get("LOOM_ADLS_ACCOUNT", "").strip()
    try:
        if account:
            con.execute(
                "CREATE OR REPLACE SECRET loom_adls ("
                "  TYPE azure, PROVIDER credential_chain, "
                f"  ACCOUNT_NAME '{account}'"
                ")"
            )
        else:
            con.execute(
                "CREATE OR REPLACE SECRET loom_adls ("
                "  TYPE azure, PROVIDER credential_chain"
                ")"
            )
    except Exception:
        # Some duckdb/azure builds accept only the account-scoped form; a failure
        # here is non-fatal — delta_scan still tries the ambient credential and a
        # genuinely unreadable path surfaces as a real error on /query.
        pass
    _con = con
    return _con


# ── Request / response models (mirror report-accel-client.ts) ─────────────────

AggFn = Literal["sum", "avg", "min", "max", "count", "countDistinct"]
FilterOp = Literal["eq", "ne", "gt", "ge", "lt", "le", "in", "contains", "between"]


class Aggregate(BaseModel):
    col: Optional[str] = None
    fn: AggFn
    alias: str


class Filter(BaseModel):
    col: str
    op: FilterOp
    value: Optional[str] = None
    value2: Optional[str] = None
    values: Optional[List[str]] = None
    exclude: bool = False


class OrderBy(BaseModel):
    col: str
    dir: Literal["asc", "desc"] = "asc"


class SemanticQuery(BaseModel):
    deltaUrl: str
    groupBy: List[str] = Field(default_factory=list)
    aggregates: List[Aggregate] = Field(default_factory=list)
    filters: List[Filter] = Field(default_factory=list)
    orderBy: Optional[List[OrderBy]] = None
    limit: Optional[int] = None


# ── SQL compilation (DuckDB dialect, injection-safe) ──────────────────────────

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_ .\-]*$")
_AGG_SQL = {"sum": "SUM", "avg": "AVG", "min": "MIN", "max": "MAX", "count": "COUNT"}


def _qi(name: str) -> str:
    """Double-quote a DuckDB identifier (rejects anything but a safe column name)."""
    if not name or not _IDENT_RE.match(name):
        raise HTTPException(status_code=400, detail=f"invalid identifier: {name!r}")
    return '"' + name.replace('"', '""') + '"'


def _agg_expr(a: Aggregate) -> str:
    if a.fn == "countDistinct":
        if not a.col:
            return f"COUNT(*) AS {_qi(a.alias)}"
        return f"COUNT(DISTINCT {_qi(a.col)}) AS {_qi(a.alias)}"
    if a.fn == "count" and not a.col:
        return f"COUNT(*) AS {_qi(a.alias)}"
    fn = _AGG_SQL.get(a.fn)
    if not fn or not a.col:
        raise HTTPException(status_code=400, detail=f"unsupported aggregate: {a.fn}")
    return f"{fn}({_qi(a.col)}) AS {_qi(a.alias)}"


def _predicate(f: Filter, params: list) -> str:
    col = _qi(f.col)
    if f.op in ("eq", "ne", "gt", "ge", "lt", "le"):
        op = {"eq": "=", "ne": "<>", "gt": ">", "ge": ">=", "lt": "<", "le": "<="}[f.op]
        params.append(f.value)
        pred = f"{col} {op} ?"
    elif f.op == "contains":
        params.append(f"%{f.value or ''}%")
        pred = f"CAST({col} AS VARCHAR) LIKE ?"
    elif f.op == "between":
        params.append(f.value)
        params.append(f.value2)
        pred = f"{col} BETWEEN ? AND ?"
    elif f.op == "in":
        vals = f.values or ([] if f.value is None else [f.value])
        if not vals:
            return "1=0"  # empty IN set matches nothing (honest, not an error)
        marks = ", ".join(["?"] * len(vals))
        params.extend(vals)
        pred = f"{col} IN ({marks})"
    else:
        raise HTTPException(status_code=400, detail=f"unsupported filter op: {f.op}")
    return f"NOT ({pred})" if f.exclude else pred


def _compile(q: SemanticQuery) -> tuple[str, list]:
    params: list = []
    select_parts: List[str] = [_qi(g) for g in q.groupBy]
    select_parts.extend(_agg_expr(a) for a in q.aggregates)
    if not select_parts:
        raise HTTPException(status_code=400, detail="query has no columns to project")

    # delta_scan reads the Delta table's current snapshot directly off ADLS.
    delta = q.deltaUrl.replace("'", "''")
    sql = f"SELECT {', '.join(select_parts)} FROM delta_scan('{delta}') AS src"

    if q.filters:
        wheres = [_predicate(f, params) for f in q.filters]
        sql += " WHERE " + " AND ".join(wheres)

    if q.groupBy and q.aggregates:
        sql += " GROUP BY " + ", ".join(_qi(g) for g in q.groupBy)

    if q.orderBy:
        sql += " ORDER BY " + ", ".join(
            f"{_qi(o.col)} {'DESC' if o.dir == 'desc' else 'ASC'}" for o in q.orderBy
        )

    limit = q.limit if (isinstance(q.limit, int) and 0 < q.limit <= 1_000_000) else 100_000
    sql += f" LIMIT {int(limit)}"
    return sql, params


def _delta_version(con: duckdb.DuckDBPyConnection, delta_url: str) -> Optional[int]:
    """Best-effort current Delta table version — a true cache-freshness token the
    console folds into its cache key. Returns None when unavailable (older delta
    ext); the console then falls back to its item-state freshness proxy."""
    try:
        d = delta_url.replace("'", "''")
        row = con.execute(
            f"SELECT max(version) FROM delta_scan_metadata('{d}')"
        ).fetchone()
        return int(row[0]) if row and row[0] is not None else None
    except Exception:
        return None


# ── Endpoints ─────────────────────────────────────────────────────────────────


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/query")
def query(q: SemanticQuery) -> dict:
    if not q.deltaUrl:
        raise HTTPException(status_code=400, detail="deltaUrl is required")
    con = _connection()
    sql, params = _compile(q)
    started = time.time()
    try:
        rel = con.execute(sql, params)
        columns = [d[0] for d in rel.description]
        rows = [list(r) for r in rel.fetchall()]
    except HTTPException:
        raise
    except Exception as e:  # a genuinely unreadable Delta / bad column, etc.
        raise HTTPException(status_code=502, detail=f"duckdb query failed: {e}") from e
    elapsed_ms = int((time.time() - started) * 1000)
    return {
        "columns": columns,
        "rows": rows,
        "sql": sql,
        "deltaVersion": _delta_version(con, q.deltaUrl),
        "elapsedMs": elapsed_ms,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
