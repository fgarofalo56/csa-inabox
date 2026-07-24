"""DuckDB engine wiring for the loom-duckdb serving tier (N2b).

The fast path BELOW Spark. A single embedded DuckDB process with the `azure`,
`httpfs`, `delta` and `iceberg` extensions reads the customer's OWN ADLS Gen2
directly:

    SELECT * FROM delta_scan('abfss://gold@<acct>.dfs.core.windows.net/sales')

Identity: the container's USER-ASSIGNED MANAGED IDENTITY (AZURE_CLIENT_ID is
injected by bicep) through DuckDB's `CREDENTIAL_CHAIN` Azure secret provider.
There are NO storage keys, NO SAS tokens and NO connection strings anywhere in
this service — the same posture as every other Loom data-plane container.

SOVEREIGN MOAT / IL5: DuckDB is a single embedded OSS binary and the four
extensions are baked into the image at build time (`duckdb_extensions.py` runs
INSTALL during `docker build`), so a disconnected IL5 enclave never reaches an
extension repository at runtime. `autoinstall_known_extensions` is turned OFF
after setup precisely so a missing extension fails loudly instead of silently
attempting egress.

No Microsoft Fabric / OneLake / Power BI host is contacted from any path here
(.claude/rules/no-fabric-dependency.md).
"""
from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import duckdb
import pyarrow as pa

from .sqlguard import assert_read_only

log = logging.getLogger("loom-duckdb.engine")

#: Extensions the image carries. Order matters: `azure` depends on `httpfs`.
BUNDLED_EXTENSIONS = ("httpfs", "azure", "delta", "iceberg")

#: Hard ceiling on rows returned in one response. Beyond this a caller pages
#: with LIMIT/OFFSET or streams over Flight. Never silently truncated: the
#: response carries `truncated: true` and the applied cap.
DEFAULT_MAX_ROWS = int(os.environ.get("LOOM_DUCKDB_MAX_ROWS", "200000") or 200000)

#: Wall-clock budget for one statement (seconds).
QUERY_TIMEOUT_S = float(os.environ.get("LOOM_DUCKDB_QUERY_TIMEOUT_S", "120") or 120)


@dataclass
class QueryResult:
    """One executed statement: the real Arrow table plus honest timings."""

    table: pa.Table
    elapsed_ms: int
    row_count: int
    truncated: bool
    max_rows: int
    sql: str
    #: Extensions actually loaded when the statement ran (receipt material).
    extensions: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        """A JSON-safe projection for callers that did not ask for Arrow IPC."""
        columns = [
            {"name": f.name, "type": str(f.type)} for f in self.table.schema
        ]
        rows = [list(r.values()) for r in self.table.to_pylist()]
        return {
            "columns": columns,
            "rows": rows,
            "rowCount": self.row_count,
            "elapsedMs": self.elapsed_ms,
            "truncated": self.truncated,
            "maxRows": self.max_rows,
            "engine": "duckdb",
            "extensions": self.extensions,
        }


def arrow_ipc_bytes(table: pa.Table) -> bytes:
    """Serialize an Arrow table to an Arrow IPC **stream** (the Flight wire format).

    This is the same encoding `loom-directlake` emits, so the console's Arrow
    reader, duckdb-wasm's `insertArrowFromIPCStream`, and any ADBC client all
    consume one format.
    """
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    return sink.getvalue().to_pybytes()


class DuckDbEngine:
    """Process-wide DuckDB connection with the lake secret configured once.

    DuckDB connections are not thread-safe for concurrent execution, so each
    query takes a cursor off the shared connection under a lock for setup and
    executes on its own cursor. This mirrors DuckDB's documented pattern and
    keeps the extension/secret setup a one-time cost.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._con: duckdb.DuckDBPyConnection | None = None
        self._loaded: list[str] = []
        self._setup_error: str | None = None

    # ── setup ────────────────────────────────────────────────────────────
    def _account(self) -> str:
        return (os.environ.get("LOOM_LAKE_ACCOUNT") or "").strip()

    def _connect(self) -> duckdb.DuckDBPyConnection:
        con = duckdb.connect(
            database=":memory:",
            config={
                "threads": int(os.environ.get("LOOM_DUCKDB_THREADS", "4") or 4),
                "memory_limit": os.environ.get("LOOM_DUCKDB_MEMORY_LIMIT", "3GB"),
            },
        )
        ext_dir = (os.environ.get("LOOM_DUCKDB_EXT_DIR") or "").strip()
        if ext_dir:
            con.execute("SET extension_directory = ?", [ext_dir])
        for ext in BUNDLED_EXTENSIONS:
            try:
                con.execute(f"LOAD {ext}")
                self._loaded.append(ext)
            except Exception as exc:  # pragma: no cover - image-build invariant
                log.warning("extension %s could not be loaded: %s", ext, exc)

        account = self._account()
        if account:
            # CREDENTIAL_CHAIN → the container's managed identity (IMDS) first,
            # then the environment credential. No key, no SAS, no secret.
            con.execute(
                "CREATE OR REPLACE SECRET loom_lake ("
                "  TYPE AZURE,"
                "  PROVIDER CREDENTIAL_CHAIN,"
                "  CHAIN 'managed_identity;env',"
                f" ACCOUNT_NAME '{account}'"
                ")"
            )
        else:
            self._setup_error = (
                "LOOM_LAKE_ACCOUNT is unset, so abfss:// sources cannot be resolved. "
                "Local/`fixture` SQL still runs; set the var on the Container App to "
                "read the deployment's ADLS Gen2 lake."
            )

        # Lock the configuration AFTER setup so a submitted statement can never
        # re-enable auto-install (which would attempt egress) or swap the secret.
        con.execute("SET autoinstall_known_extensions = false")
        con.execute("SET autoload_known_extensions = false")
        con.execute("SET lock_configuration = true")
        return con

    def connection(self) -> duckdb.DuckDBPyConnection:
        with self._lock:
            if self._con is None:
                self._con = self._connect()
            return self._con

    # ── introspection ────────────────────────────────────────────────────
    def capabilities(self) -> dict[str, Any]:
        self.connection()
        return {
            "engine": "duckdb",
            "version": duckdb.__version__,
            "extensions": list(self._loaded),
            "lakeAccount": self._account(),
            "authMode": "managed-identity" if self._account() else "none",
            "maxRows": DEFAULT_MAX_ROWS,
            "queryTimeoutSeconds": QUERY_TIMEOUT_S,
            "setupNote": self._setup_error,
        }

    # ── execution ────────────────────────────────────────────────────────
    def run(self, sql: str, max_rows: int | None = None) -> QueryResult:
        """Execute a read-only statement and return the REAL Arrow result.

        Multi-statement scripts execute in order; the LAST statement's result
        is returned (DuckDB/SSMS semantics). Raises `SqlNotAllowedError` before any
        engine work when the script is not read-only.
        """
        statements = assert_read_only(sql)
        cap = max(1, min(int(max_rows or DEFAULT_MAX_ROWS), DEFAULT_MAX_ROWS))
        con = self.connection()
        cursor = con.cursor()
        started = time.perf_counter()
        try:
            table: pa.Table | None = None
            for statement in statements:
                # LIMIT is applied as an OUTER wrapper so a user LIMIT larger
                # than the cap is still capped, and a smaller one still wins.
                wrapped = f"SELECT * FROM ({statement}) AS loom_q LIMIT {cap + 1}"
                try:
                    table = cursor.execute(wrapped).fetch_arrow_table()
                except duckdb.Error:
                    # Statements that cannot be wrapped in a subquery (SHOW,
                    # DESCRIBE, PRAGMA, EXPLAIN) run directly.
                    table = cursor.execute(statement).fetch_arrow_table()
            assert table is not None
            truncated = table.num_rows > cap
            if truncated:
                table = table.slice(0, cap)
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            return QueryResult(
                table=table,
                elapsed_ms=elapsed_ms,
                row_count=table.num_rows,
                truncated=truncated,
                max_rows=cap,
                sql=sql,
                extensions=list(self._loaded),
            )
        finally:
            cursor.close()


#: Process-wide engine (FastAPI + the Flight server share one DuckDB).
ENGINE = DuckDbEngine()
