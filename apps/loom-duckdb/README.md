# loom-duckdb — the DuckDB serving tier (N2b) + Arrow Flight SQL wire (N3)

An internal-ingress Azure Container App that puts an **embedded DuckDB** between
"a grid in the browser" and "spin up a Spark session". It reads Delta, Iceberg
and Parquet **in place** on the deployment's own ADLS Gen2 through the
container's user-assigned managed identity.

```
SELECT product, sum(amount) AS revenue
FROM delta_scan('abfss://gold@<account>.dfs.core.windows.net/sales')
GROUP BY 1 ORDER BY 2 DESC
```

No Microsoft Fabric, no OneLake, no Power BI, no SaaS query service is in any
code path (`.claude/rules/no-fabric-dependency.md`).

## Why it exists

| Tier | Cold start | Good for |
| --- | --- | --- |
| duckdb-wasm (in the browser, N2a) | ~0 ms after the first fetch | slice / filter / aggregate an already-fetched Arrow result — zero server cost, zero network |
| **loom-duckdb (this service)** | sub-second | interactive SQL over lake tables up to ~100 GB scanned |
| Synapse Spark | 1–5 min | large joins, writes, ML, anything that must scale out |

The console's SQL Lab picks the tier; when `LOOM_DUCKDB_URL` is unset the
surface still renders and falls back to **Synapse Serverless** (honest gate +
Fix-it), so this service is an accelerator, never a dependency.

## Surfaces

| Wire | Port | Contract |
| --- | --- | --- |
| HTTP | 8080 | `GET /health`, `GET /capabilities`, `POST /query`, `POST /explain` |
| Flight SQL (gRPC) | 8815 | `GetFlightInfo` / `GetSchema` (`CommandStatementQuery`), `DoGet` (`TicketStatementQuery`), `CommandGetSqlInfo` |

`POST /query` returns JSON by default and the **raw Arrow IPC stream** when the
caller sends `Accept: application/vnd.apache.arrow.stream`. Row count, elapsed
ms, truncation and byte size travel in `x-loom-*` response headers so the body
stays a pure Arrow stream that duckdb-wasm and every ADBC reader consume
unmodified.

## Security posture

* **Read-only by construction.** The identity holds *Storage Blob Data Reader*
  on the lake, and `app/sqlguard.py` admits only `SELECT` / `WITH` / `DESCRIBE` /
  `SHOW` / `EXPLAIN` / `SUMMARIZE` / introspection `PRAGMA`s — default-deny, so
  an unrecognized verb is refused with the reason.
* **No keys, no secrets.** The lake secret is `PROVIDER CREDENTIAL_CHAIN` over
  the managed identity. Nothing else is configured.
* **Locked configuration.** After setup the engine sets
  `autoinstall_known_extensions=false`, `autoload_known_extensions=false` and
  `lock_configuration=true`, so a submitted statement cannot re-enable egress.
* **Internal ingress only.** HTTP is reached exclusively by the Loom BFF, which
  authenticates the user, audits the access and proxies the Arrow stream.
* **Flight tickets are short-lived and Entra-scoped.** The BFF mints them from a
  verified session (`lib/azure/flight-sql-client.ts`), audits issuance, and this
  service verifies the HMAC signature, audience and expiry before executing —
  then logs one structured access line per redemption, joinable to the console's
  audit row on `ticketId`.

## Environment

| Variable | Purpose |
| --- | --- |
| `LOOM_LAKE_ACCOUNT` | ADLS Gen2 account the `abfss://` sources resolve against |
| `AZURE_CLIENT_ID` | the user-assigned managed identity (injected by bicep) |
| `LOOM_DUCKDB_EXT_DIR` | where the baked-in extensions live (`/opt/duckdb-extensions`) |
| `LOOM_DUCKDB_MAX_ROWS` | hard row cap per response (default 200000) |
| `LOOM_DUCKDB_THREADS` / `LOOM_DUCKDB_MEMORY_LIMIT` | engine sizing |
| `LOOM_FLIGHT_ENABLED` | `0` disables the Flight wire (HTTP tier keeps working) |
| `LOOM_FLIGHT_PORT` | Flight gRPC port (default 8815) |
| `LOOM_FLIGHT_TICKET_SECRET` | Key-Vault-injected HMAC key for ticket verification |
| `LOOM_FLIGHT_ALLOW_BARE_SQL` | default **on**. `0` serves ONLY the `GetFlightInfo` → handle → `DoGet` handshake, which makes the statement-handle lifecycle a real replay boundary (see below). Conformant Flight SQL / ADBC / JDBC clients are unaffected either way |

### Flight statement handles — what they bound

A handle minted by `GetFlightInfo` is single-use, bound to the minting ticket
and expires after 120 s. While `LOOM_FLIGHT_ALLOW_BARE_SQL` is on (the default,
so plain Arrow Flight clients that never call `GetFlightInfo` keep working),
that is a **resource-hygiene** control rather than a replay/authorization
boundary: a leaked *handle* is worthless after one fetch, but a holder of a
valid, unexpired *ticket* can `DoGet(Ticket(b"SELECT ..."))` with arbitrary
**read** SQL for the rest of the ticket's TTL. The read-only guard and the audit
log apply on both paths — bare-SQL redemptions are logged under their own
`flight.doGet.bareSql` operation so they are distinguishable in the access log —
and `GET /capabilities` reports the live posture as `flight.bareSqlTickets`.
Set `LOOM_FLIGHT_ALLOW_BARE_SQL=0` for a deployment that needs the handshake to
BE the boundary.

`GET /capabilities` reports the Flight wire's REAL state, not the operator's
intent: `flight.configured` is what the env asked for, `flight.running` is
whether the serving thread is alive right now, `flight.enabled` is both, and
`flight.error` carries the last startup/serve failure verbatim.

## Deploy

`platform/fiab/bicep/modules/data-plane/duckdb-aca.bicep` (standalone
entrypoint — `admin-plane/main.bicep` is at the ARM 256-parameter ceiling), then
set `LOOM_DUCKDB_URL` (and optionally `LOOM_FLIGHTSQL_URL`) on the console app.

## Tests

`tests/loom_duckdb/` — run with `pytest tests/loom_duckdb`. Nothing here needs
Azure, a lake account or the network: every query reads DuckDB's own in-memory
`range()`/literals.

| File | What it exercises |
| --- | --- |
| `test_sqlguard.py` | read-only admission control (pure Python) |
| `test_flight_wire.py` | the Flight SQL protobuf codec + ticket verification (pure Python) |
| `test_engine.py` | a **real** embedded DuckDB — execution, row bounding, Arrow IPC round-trip, the managed-identity secret DDL, config locking |
| `test_flightsql.py` | the **real** Flight server over a loopback gRPC port with a real `pyarrow.flight` client — auth middleware, `GetFlightInfo`/`DoGet`/`GetSchema`, handle single-use + expiry, the access log |
| `test_http_tier.py` | the **real** FastAPI app via `TestClient` — `/query` JSON + Arrow IPC, `/explain`, `/capabilities`, every error path, Flight startup wiring |

The last three need `duckdb`, `pyarrow` and `fastapi`/`httpx`. They come from the
`serving` extra, which is now part of the Makefile's default `EXTRAS` and of
`make setup-all`, so `make setup && make test` and `make typecheck` cover them;
`pip install -e ".[dev,serving]"` is the manual equivalent. Without the extra the
three files **skip** (module-level `pytest.importorskip`) rather than erroring at
collection. CI installs the extra as a floor and then re-pins `duckdb`/`pyarrow`
from this app's own `requirements.txt` — with no `|| true` — so the exact runtime
versions are what get exercised.

They are deliberately NOT mocked: this app holds the repo's only DIRECT pin of
`duckdb`/`pyarrow` (`apps/loom-transform-runner/requirements.txt` constrains both
transitively via dbt-duckdb / sqlmesh, into the same CI environment), so these
tests are the signal a dependency bump gets (#2543).

### Coverage

`apps/loom-duckdb/app` is in `[tool.coverage.run] source`, so the numbers below are
an instrument reading, not a self-assessment:

| module | line+branch |
| --- | --- |
| `engine.py` | 99% |
| `main.py` | 97% |
| `sqlguard.py` | 95% |
| `tickets.py` | 91% |
| `pbcodec.py` | 84% |
| **gated total** | **93%** |

`flightsql.py` is deliberately in `[tool.coverage.run] omit`: pyarrow.flight
dispatches every server callback on gRPC's own native threads, which coverage.py
cannot trace (`sys.settrace` is per-thread). It reports 26% for code the tests
provably execute — see #2580. Its real signal is the 30 behavioural tests in
`test_flightsql.py`.
