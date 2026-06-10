# warehouse-pane — parity with the Fabric/Synapse Warehouse query surface (`/warehouse` route)

Source UI: Microsoft Fabric Warehouse SQL query editor + SQL Server Management
Studio "Display Estimated Execution Plan" + Fabric Warehouse "Query insights".
The `/warehouse` route is the standalone, shared (non-item) warehouse query
pane. The full item-level authoring surface (schema explorer, Model view,
Monitoring, Copilot, CTAS, statistics) is covered separately by
`docs/fiab/parity/warehouse.md` (the `WarehouseEditor`).

Backend: **Synapse Dedicated SQL pool** over TDS (`synapse-sql-client`). NO
Microsoft Fabric / Power BI dependency — works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
unset. Azure-native default per `no-fabric-dependency.md`.

## Source feature inventory (the SQL query surface)

| Capability | Source UI |
|---|---|
| T-SQL editor with syntax colorization + IntelliSense | Fabric Warehouse query editor (Monaco) |
| Run query → tabular results grid (sortable, resizable) | Fabric Warehouse "Results" grid |
| Estimated execution plan | SSMS / Fabric "Explain"/estimated plan |
| Query history / recent runs | Fabric "Query insights"; `sys.dm_pdw_exec_requests` |
| Errors surfaced inline (not hidden) | Fabric error pane |

## Loom coverage

| Row | Status | Notes |
|---|---|---|
| T-SQL editor (Monaco, `language="tsql"`, IntelliSense) | built ✅ | `MonacoTextarea` replaces the old `<textarea>` stub |
| Results grid (sortable / resizable / filterable) | built ✅ | `LoomDataTable` replaces the old raw `<table>` |
| Run query → real rows | built ✅ | `POST /api/warehouse/query` → `executeQuery` (real TDS) |
| Explain plan tab | built ✅ | `POST /api/warehouse/explain` → `explainQuery` (`EXPLAIN WITH_RECOMMENDATIONS`) |
| History tab | built ✅ | `GET /api/warehouse/history` → `executeQuery(synapseRecentRequestsSql)` on `sys.dm_pdw_exec_requests` |
| Errors as MessageBar | built ✅ | Fluent `MessageBar intent="error"` for query + explain + history failures |
| Honest config gate | gate ⚠️ | 503 with exact env vars (`LOOM_SYNAPSE_WORKSPACE` / `LOOM_SYNAPSE_DEDICATED_POOL`) when Synapse unset; 409 when pool not Online |
| Copilot (persona) | built ✅ | `setCopilotContext({ persona:'warehouse', tableNames, currentSqlSnippet })` feeds the global Copilot pane |

Zero ❌. The controlled `TabList` (Results / Explain plan / History) gates real
content per tab — no dead/empty tabs remain.

## Backend per control

| Control | Backend |
|---|---|
| Run query | `POST /api/warehouse/query` → `synapse-sql-client.executeQuery` (TDS, dedicated pool) |
| Explain plan | `POST /api/warehouse/explain` → `synapse-sql-client.explainQuery` (`EXPLAIN WITH_RECOMMENDATIONS`) |
| History (lazy + Refresh) | `GET /api/warehouse/history` → `executeQuery(synapseRecentRequestsSql(3600))` on `sys.dm_pdw_exec_requests` |
| Pool-online check | `synapse-pool-arm.getPoolState` (ARM) — 409 when Paused |

## Per-cloud

| Aspect | Commercial / GCC | GCC-High (L4) / IL5 (L5) |
|---|---|---|
| TDS endpoint | `{ws}.sql.azuresynapse.net` | `{ws}.sql.azuresynapse.usgovcloudapi.net` (`synapseSqlSuffix()`) |
| AAD token scope | `database.windows.net/.default` | `database.usgovcloudapi.net/.default` (`LOOM_SYNAPSE_SQL_TOKEN_SCOPE`) |
| EXPLAIN support | Dedicated pool ✅ | Dedicated pool ✅ |
| Fabric required | No | No (no Fabric in Gov anyway) |

Env vars are already stamped onto the console Container App by
`platform/fiab/bicep/admin-plane/main.bicep` (`LOOM_SYNAPSE_WORKSPACE`,
`LOOM_SYNAPSE_DEDICATED_POOL`, `LOOM_SYNAPSE_SQL_TOKEN_SCOPE`,
`LOOM_SYNAPSE_HOST_SUFFIX`, `LOOM_WAREHOUSE_BACKEND`). No new Bicep or env vars
were required for this surface.
