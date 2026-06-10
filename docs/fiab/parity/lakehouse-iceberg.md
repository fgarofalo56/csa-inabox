# lakehouse-iceberg — parity with Fabric OneLake "Use Iceberg tables with OneLake"

Source UI: Fabric Lakehouse → Delta↔Iceberg metadata virtualization
(https://learn.microsoft.com/fabric/onelake/onelake-iceberg-tables) and the
OneLake Iceberg REST Catalog endpoint
(https://learn.microsoft.com/fabric/onelake/table-apis/iceberg-table-apis-overview).

Loom surface: Lakehouse editor → **Iceberg** tab
(`lib/editors/components/lakehouse-iceberg-tab.tsx`), backed by
`/api/lakehouse/iceberg`.

## Azure/Fabric feature inventory (grounded in Learn)

| # | Fabric / OneLake capability | Notes |
|---|------------------------------|-------|
| 1 | Virtualize Delta Lake tables as Iceberg (Delta tables readable by Iceberg readers) | OneLake auto-generates virtual Iceberg V2 metadata next to the Delta log |
| 2 | Iceberg **V2** is the supported version | Spec version-2 row-level deletes |
| 3 | Per-table opt-in (table must be under the `Tables/` folder of the data item) | conversion only attempted for tables in `Tables/` |
| 4 | Show the ADLS/OneLake path to the table's `Tables/` root | needed to wire external readers (Snowflake `STORAGE_BASE_URL`, etc.) |
| 5 | Iceberg REST Catalog (IRC) endpoint for metadata reads | `https://onelake.table.fabric.microsoft.com/iceberg` |
| 6 | Per-table conversion status / `metadata/*.metadata.json` discovery | conversion log + latest `.metadata.json` version |
| 7 | Read the virtualized table from Snowflake (external volume snippet) | `CREATE EXTERNAL VOLUME … STORAGE_BASE_URL='azure://…/Tables/'` |
| 8 | Enable/disable the exposure | tenant/workspace setting to turn conversion on |

## Loom coverage

| # | Status | How |
|---|--------|-----|
| 1 | built ✅ | Delta UniForm (`delta.universalFormat.enabledFormats='iceberg'`) via a real `ALTER TABLE … SET TBLPROPERTIES` on a Databricks SQL Warehouse — Iceberg V2 metadata written alongside the Delta log on the same ADLS Gen2 files (no copy). Azure-native; no Fabric/OneLake dependency. |
| 2 | built ✅ | `delta.enableIcebergCompatV2='true'` + Iceberg V2 surfaced as `icebergVersion: 'v2'` in the UI badge. |
| 3 | built ✅ | Table selection list is sourced from `/api/lakehouse/tables` (real ADLS `Tables/` scan); ALTER targets `abfss://…/Tables/<t>`. |
| 4 | built ✅ | `adlsTablesRoot` (https) + `adlsAbfssRoot` shown with copy buttons. |
| 5 | built ✅ / honest-gate ⚠️ | Iceberg REST Catalog URL = Databricks Unity Catalog Iceberg endpoint (`https://<host>/api/2.1/unity-catalog/iceberg`) when `LOOM_DATABRICKS_HOSTNAME` is set; otherwise the UI tells readers to use the path-based `metadata/*.metadata.json` directly. |
| 6 | built ✅ | GET probes `Tables/<t>/metadata/*.metadata.json` on ADLS and renders a per-table conversion-status table + the latest metadata file path. |
| 7 | built ✅ | Snowflake external-volume snippet generated from the ADLS path (`azure://…/Tables/`), copy-able. |
| 8 | built ✅ | Master Switch persists `iceberg.enabled` to the `tenant-settings` Cosmos doc; disable runs `ALTER TABLE … UNSET TBLPROPERTIES`. |

Honest infra-gates (⚠️) — full UI still renders:
- Databricks not configured → MessageBar names `LOOM_DATABRICKS_HOSTNAME` /
  `LOOM_DATABRICKS_SQL_WAREHOUSE_ID`; selection still saves and applies on next save.
- No storage account → MessageBar names `LOOM_PRIMARY_STORAGE_ACCOUNT` /
  `LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL`.

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Load status / paths / catalog URL / per-table conversion | `GET /api/lakehouse/iceberg` → Cosmos `tenant-settings` read + ADLS Gen2 `listPaths` metadata probe (`adls-client`) |
| Delta table list | `GET /api/lakehouse/tables` → real `Tables/` ADLS scan (`synapse-catalog-client`) |
| Save / enable / disable | `POST /api/lakehouse/iceberg` → Cosmos upsert + real `ALTER TABLE … SET/UNSET TBLPROPERTIES` via Databricks SQL Warehouse (`databricks-client.executeStatement`) |
| ADLS path / abfss / catalog URL | derived from `adls-client.pathToHttpsUrl` + `getAccountName` (sovereign-cloud-correct DFS suffix) |

## No-Fabric-dependency check

Default path is fully Azure-native (ADLS Gen2 + Delta UniForm via Databricks).
No call to `onelake.*.fabric.microsoft.com` / `api.fabric.microsoft.com`. Works
with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
