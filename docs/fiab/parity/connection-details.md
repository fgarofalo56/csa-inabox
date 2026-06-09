# connection-details — parity with Azure SQL / Databricks "Connection details"

Source UI:
- Azure portal → Synapse / SQL pool → **Connection strings** blade
  (https://learn.microsoft.com/azure/synapse-analytics/sql/connection-strings)
- Databricks workspace → SQL Warehouse → **Connection details** tab
  (https://learn.microsoft.com/azure/databricks/integrations/jdbc-odbc-bi,
   https://learn.microsoft.com/azure/databricks/integrations/jdbc-oss/configure)

The Loom `ConnectionDetailsPanel` surfaces the real connection coordinates an
external BI tool / CLI client uses to reach each SQL engine, with per-field copy
buttons — Azure-native by default, no Microsoft Fabric / Power BI dependency.

## Azure / Databricks feature inventory

| # | Capability (real UI) | Notes |
|---|----------------------|-------|
| 1 | Server / hostname (FQDN) | Databricks: `odbc_params.hostname`; Synapse: `<ws>[-ondemand].sql.azuresynapse.*` |
| 2 | HTTP path (Databricks) | `odbc_params.path` = `/sql/1.0/warehouses/<id>` |
| 3 | Database name (Synapse) | Dedicated pool name / Serverless database |
| 4 | Port | Databricks 443, Synapse 1433 |
| 5 | JDBC URL | ready-to-paste driver URL |
| 6 | CLI snippet | `databricks sql` / `sqlcmd` |
| 7 | Auth mode disclosure | AAD (Entra) — no passwords surfaced or stored |
| 8 | Copy-to-clipboard per field | one button per row |
| 9 | Sovereign-cloud correct host | Gov suffix `*.usgovcloudapi.net` in GCC-High / IL5 / DoD |

## Loom coverage

| # | Coverage | Backend per control |
|---|----------|---------------------|
| 1 | built ✅ | `GET /api/items/<engine>/[id]/connection` → `databricks-client.getWarehouse().odbc_params` / `synapse-sql-client.dedicatedTarget()` / `serverlessTarget()` |
| 2 | built ✅ | `odbc_params.path` (Databricks only) |
| 3 | built ✅ | `SynapseTarget.database` |
| 4 | built ✅ | constant per engine (443 / 1433) |
| 5 | built ✅ | `jdbc:databricks://host:443;httpPath=…` / `jdbc:sqlserver://server:1433;…;authentication=ActiveDirectoryIntegrated;hostNameInCertificate=<cloud cert>` |
| 6 | built ✅ | `databricks sql query …` / `sqlcmd -S … --authentication-method ActiveDirectoryIntegrated -C` |
| 7 | built ✅ | static disclosure from BFF `authMode` + "No passwords stored" badge |
| 8 | built ✅ | `navigator.clipboard.writeText` per field |
| 9 | built ✅ | `cloud-endpoints.synapseSqlSuffix()` / `synapseSqlJdbcHostCert()` — verified by `cloud-matrix.test.ts` (Commercial + Gov + DoD) |

Honest gates (⚠️) — full panel still renders the MessageBar, never an empty tab:
- Databricks engine unconfigured → 503 `not_configured` (`LOOM_DATABRICKS_HOSTNAME`)
- No warehouse id and no `LOOM_DATABRICKS_SQL_WAREHOUSE_ID` → 400 `not_configured`
- Warehouse returned no `odbc_params` (not yet started) → 422 `odbc_params_unavailable` + Retry
- Synapse unconfigured → 503 `not_configured` (`LOOM_SYNAPSE_WORKSPACE` / `LOOM_SYNAPSE_DEDICATED_POOL`)

Zero ❌, zero stub banners.

## Wiring

| Engine | Editor | Entry point |
|--------|--------|-------------|
| `databricks-sql-warehouse` | `DatabricksSqlWarehouseEditor` | ribbon → Warehouse → **Connection details** (Dialog) |
| `synapse-dedicated-sql-pool` | `SynapseDedicatedSqlPoolEditor` | ribbon → Connect → **Connection details** (Dialog) |
| `synapse-serverless-sql-pool` | `SynapseServerlessSqlEditor` | ribbon → Connect → **Connection details** (Dialog) |

## Bicep sync

No new infra. All env vars already wired in
`platform/fiab/bicep/modules/admin-plane/main.bicep`:
`LOOM_DATABRICKS_HOSTNAME`, `LOOM_DATABRICKS_SQL_WAREHOUSE_ID`,
`LOOM_SYNAPSE_WORKSPACE`, `LOOM_SYNAPSE_DEDICATED_POOL`, `LOOM_SYNAPSE_HOST_SUFFIX`.

## Verification

- `cloud-matrix.test.ts` — 21 green (Synapse suffix + JDBC cert wildcard for
  Commercial, GCC-High/IL5, DoD).
- `tsc --noEmit` — 0 errors. `next build` — exit 0.
- Real-data E2E: minted-session probe of
  `GET /api/items/databricks-sql-warehouse/<id>/connection?warehouseId=<wid>`
  returns the live warehouse `odbc_params` JDBC URL; the copied URL connects
  from DBeaver (Databricks JDBC OSS driver). Gov path shows
  `hostNameInCertificate=*.sql.azuresynapse.usgovcloudapi.net`.
