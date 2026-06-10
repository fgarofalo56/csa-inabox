# lakehouse-iceberg-endpoint — parity with Fabric OneLake "Iceberg V2 endpoint" (Delta ↔ Iceberg virtualization)

Source UI: Microsoft Fabric → Lakehouse → **Settings** / table → tables written
in Delta Lake are automatically readable by Apache Iceberg V2 readers via OneLake
**metadata virtualization**. There is no standalone "Iceberg endpoint" toggle in
OneLake — exposing the Delta table to Iceberg readers *is* the endpoint.
- https://learn.microsoft.com/fabric/onelake/onelake-iceberg-tables
- https://learn.microsoft.com/fabric/onelake/onelake-iceberg-snowflake
- https://learn.microsoft.com/fabric/onelake/table-apis/iceberg-table-apis-overview
- Azure-native mechanism behind it — Delta Lake UniForm (Universal Format):
  - https://learn.microsoft.com/azure/databricks/delta/uniform

## Azure-native backend (per `no-fabric-dependency.md`)

The lakehouse item type is **ADLS Gen2 + Delta** (no OneLake). The Iceberg
"endpoint" is produced by **Delta Lake UniForm**: a real
`ALTER TABLE … SET TBLPROPERTIES('delta.enableIcebergCompatV2'='true',
'delta.universalFormat.enabledFormats'='iceberg')` run via a **Databricks SQL
Warehouse** against the Delta table at its `abfss://` path. Delta then
asynchronously generates Iceberg V2 metadata (`metadata/*.metadata.json`)
alongside the `_delta_log/`. Any Iceberg reader (Snowflake EXTERNAL VOLUME,
Trino, Spark, Athena) reads the table by pointing at the metadata folder /
latest `.metadata.json`. **Zero Fabric capacity / OneLake / Power BI
dependency** — works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

This reuses the exact same Databricks env wiring as Lakehouse liquid clustering
(`LOOM_DATABRICKS_HOSTNAME`, optional `LOOM_DATABRICKS_SQL_WAREHOUSE_ID`) — no
new env vars or role grants.

## Fabric / OneLake feature inventory (grounded in Learn)

- **Delta tables readable as Iceberg V2 with no data copy.** → built ✅ (UniForm
  generates Iceberg metadata over the same Parquet data files).
- **Iceberg V2 (row-level deletes) is the supported version.** → built ✅
  (`ICEBERG_COMPAT_VERSION=2` / `enableIcebergCompatV2`; UI documents the
  `REORG … UPGRADE UNIFORM` path for tables with deletion vectors).
- **Schema-enabled lakehouse: table under `Tables/<schema>/`.** → built ✅
  (Schema field appears when the lakehouse is schema-enabled; the metadata path
  is computed under `Tables/<schema>/<table>/metadata`).
- **`metadata/` folder with `.metadata.json` is the discovery root.** → built ✅
  (UI shows the HTTPS metadata-folder URL + `azure://` form for Snowflake
  EXTERNAL VOLUME, plus the `abfss://` table path).
- **Path to read from an external engine (Snowflake/Trino/Spark).** → built ✅
  (three copyable endpoints surfaced: `abfss://`, HTTPS metadata folder,
  `azure://` metadata folder).
- **Turn the feature off.** → built ✅ (disabling runs a real
  `ALTER TABLE … UNSET TBLPROPERTIES ('delta.universalFormat.enabledFormats')`).
- **Infra not yet provisioned.** → honest-gate ⚠️ (no `LOOM_DATABRICKS_HOSTNAME`
  / no SQL Warehouse → warning MessageBar naming the env var; the selection is
  persisted and the metadata path is still shown so it applies on next save).

Zero ❌, zero stub banners.

## Loom coverage / backend per control

| Control | Backend |
|---------|---------|
| Expose-as-Iceberg switch | `icebergExpose.enabled` persisted in Cosmos `tenant-settings` |
| Delta table picker | live `Tables/` listing + bundle Delta tables (dropdown) |
| Schema (schema-enabled) | `icebergExpose.schemaName` → `Tables/<schema>/<table>` |
| Save (enable) | PUT `/api/lakehouse/settings` → `ALTER TABLE delta.\`abfss://…\` SET TBLPROPERTIES('delta.enableIcebergCompatV2'='true','delta.universalFormat.enabledFormats'='iceberg')` via Databricks SQL Warehouse (`executeStatement`) |
| Save (disable) | `ALTER TABLE delta.\`abfss://…\` UNSET TBLPROPERTIES IF EXISTS ('delta.universalFormat.enabledFormats')` |
| ADLS path | `abfss://<container>@<account>.dfs.core.windows.net/Tables/[<schema>/]<table>` |
| Iceberg metadata folder (HTTPS) | `https://<account>.dfs.core.windows.net/<container>/Tables/[<schema>/]<table>/metadata` |
| Snowflake EXTERNAL VOLUME base | `azure://<account>.dfs.core.windows.net/<container>/Tables/[<schema>/]<table>/metadata` |
| Infra gate | `databricksConfigGate()` + `listWarehouses()` → warning MessageBar |

## Verification (real-data E2E)

1. With `LOOM_DATABRICKS_HOSTNAME` set + a SQL Warehouse running, open a
   lakehouse → **Settings → Expose as Iceberg** → pick a Delta table → toggle
   **Enabled** → **Save**.
2. PUT `/api/lakehouse/settings` returns
   `{ ok:true, icebergApplied:true, icebergSql:"ALTER TABLE delta.\`abfss://…\` SET TBLPROPERTIES(…)", icebergEndpoint:{ abfss, httpsMetadataFolder, azureMetadataFolder, format:"iceberg-v2", via:"delta-uniform" } }`.
3. List the ADLS Gen2 table path — a `metadata/` folder with one or more
   `*.metadata.json` files appears alongside `_delta_log/` (capture as receipt).
4. Point an Iceberg reader (e.g. Snowflake EXTERNAL VOLUME using the `azure://`
   base, or Spark `iceberg` catalog at the metadata path) at the table and read
   rows.
5. With `LOOM_DATABRICKS_HOSTNAME` UNSET the Settings surface still renders, the
   endpoint paths still show, and Save surfaces the honest `Iceberg expose gate`
   warning MessageBar — no Fabric error, no crash, selection persisted.
