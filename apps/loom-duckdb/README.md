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

## Deploy

`platform/fiab/bicep/modules/data-plane/duckdb-aca.bicep` (standalone
entrypoint — `admin-plane/main.bicep` is at the ARM 256-parameter ceiling), then
set `LOOM_DUCKDB_URL` (and optionally `LOOM_FLIGHTSQL_URL`) on the console app.

## Tests

`tests/loom_duckdb/` covers the read-only guard, the Flight SQL protobuf codec,
and ticket verification — all pure-Python, no engine and no Azure required.
