# semantic-model-direct-lake — parity with Fabric Direct Lake (DirectQuery fallback)

Source UI: Power BI / Fabric Direct Lake storage mode + DirectQuery fallback
- https://learn.microsoft.com/fabric/fundamentals/direct-lake-overview
- https://learn.microsoft.com/power-bi/enterprise/directlake-overview (fallback behaviour)
- Azure-native backend grounding: https://learn.microsoft.com/azure/synapse-analytics/sql/query-delta-lake-format

## What Direct Lake fallback is in Fabric

Direct Lake loads a semantic model's columns straight from Delta/Parquet files in
OneLake into the VertiPaq in-memory engine on demand. When a query cannot be
served from that warm cache — guardrails exceeded, a SQL view is touched, or the
model has not been framed/loaded — the engine *transparently falls back to
DirectQuery* against the Lakehouse SQL analytics endpoint, reading the same Delta
files. The user gets correct rows either way; only the serving path changes.

## Loom Azure-native realization (no Fabric capacity required)

| Fabric concept                | Loom Azure-native default                                                                 |
|-------------------------------|-------------------------------------------------------------------------------------------|
| Warm VertiPaq cache           | Power BI Import/Premium model in-memory cache (opt-in; only when a workspace is bound)     |
| "cache fresh?" check          | last **Completed** dataset refresh within `LOOM_DL_CACHE_TTL_SECONDS` (default 3600, 0=always Serverless) |
| DirectQuery fallback          | **Synapse Serverless `OPENROWSET(BULK '<gold>/Tables/<t>', FORMAT='DELTA')`** over the same Gold Delta files on ADLS Gen2 |
| Lakehouse SQL analytics endpt | `{LOOM_SYNAPSE_WORKSPACE}-ondemand.<sql-suffix>` (sovereign-aware via `cloud-endpoints`)   |

The **default** path is 100% Azure-native: with no Power BI workspace bound (or
the cache stale), every query is served from Synapse Serverless over the Gold
Delta files. The warm-cache path is strictly opt-in (Power BI workspace + a
recent refresh).

## Feature inventory → Loom coverage

| Capability                                                  | Status | Backend per control |
|-------------------------------------------------------------|--------|---------------------|
| Pick a table and run a Direct Lake query                    | built ✅ | `POST /api/items/semantic-model/[id]/direct-lake` |
| Serve from warm cache when fresh                            | built ✅ | Power BI `executeQueries` REST (`EVALUATE TOPN`) — opt-in |
| Transparent fallback to Serverless when stale/unbuilt       | built ✅ | `executeQuery(serverlessTarget, OPENROWSET DELTA)` |
| "Serving from: warm cache \| fallback (Serverless)" badge   | built ✅ | `dlResult.servingFrom` (derived from real runtime path) |
| Show endpoint + Delta path + last-refresh + TTL             | built ✅ | response fields surfaced as `Caption1` |
| Result grid (columns + rows, truncation badge, ms)          | built ✅ | `QueryResult` from the TDS client |
| Max-rows control (1–5000, capped)                           | built ✅ | `maxRows` clamped client + server |
| Raw-SQL passthrough (always Serverless)                     | built ✅ | `{ sql }` body branch |
| Honest gate when Synapse unconfigured                       | gate ⚠️ | 503 naming `LOOM_SYNAPSE_WORKSPACE` |
| Honest gate when Gold container unconfigured                | gate ⚠️ | 503 naming `LOOM_GOLD_URL` |
| Cold-start 504 with retry guidance                          | built ✅ | timeout branch in the route |

Zero ❌, zero stub banners.

## Acceptance (no-Fabric, no-vaporware)

With `LOOM_DEFAULT_FABRIC_WORKSPACE` unset and no Power BI workspace bound,
`POST {table:'fact_sales', maxRows:10}` returns real Gold Delta rows via Synapse
Serverless and `servingFrom:'serverless-fallback'`; the editor badge reads
**"Serving from: fallback (Serverless)"**. Invalidating / ageing-out the warm
cache (or setting `LOOM_DL_CACHE_TTL_SECONDS=0`) forces the Serverless path while
still returning correct rows — the definition of transparent fallback.

Bicep: `LOOM_DL_CACHE_TTL_SECONDS` wired in `platform/fiab/bicep/modules/admin-plane/main.bicep`.
RBAC: reuses the existing Console-UAMI Storage Blob Data Reader grant on the Gold
container (same identity `adls-client` already uses) — no new role assignment.
