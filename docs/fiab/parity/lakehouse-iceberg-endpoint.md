# lakehouse-iceberg-endpoint — parity with OneLake "Use Iceberg tables with OneLake" (Delta→Iceberg virtualization)

Source UI: Microsoft Fabric / OneLake → Lakehouse → table → table-format
virtualization. Grounded in Microsoft Learn:
- https://learn.microsoft.com/fabric/onelake/onelake-iceberg-tables
- https://learn.microsoft.com/fabric/onelake/table-apis/iceberg-table-apis-overview

In OneLake, a Delta Lake table automatically generates **virtual Apache Iceberg
V2 metadata** so Iceberg readers (Snowflake, Trino, Spark, BigQuery, …) can read
the same data with no copy. OneLake also exposes an Iceberg REST Catalog (IRC)
endpoint at `https://onelake.table.fabric.microsoft.com/iceberg`.

## Azure / Fabric feature inventory

| # | Capability (OneLake / Fabric) | Backing API / mechanism |
|---|-------------------------------|--------------------------|
| 1 | Enable Delta→Iceberg V2 metadata generation for a table | tenant/workspace setting → OneLake writes virtual Iceberg `metadata/*.metadata.json` |
| 2 | Iceberg readers consume the same Delta data with no copy | `metadata/` folder beside the Delta log |
| 3 | Per-table scope (schema-enabled: `dbo/<table>`; non-schema: `Tables/<table>`) | table directory under `Tables/` |
| 4 | Surface the table's ADLS/OneLake path + latest `.metadata.json` for readers | Properties view of the metadata file |
| 5 | Iceberg REST Catalog (IRC) endpoint for catalog-based discovery | `https://onelake.table.fabric.microsoft.com/iceberg` |
| 6 | Disable / revert the virtualization | remove the setting |

## Loom coverage (Azure-native default — NO Fabric, NO OneLake)

The Azure-native 1:1 is **Delta UniForm** on Databricks (the same OSS Delta Lake
feature OneLake uses under the hood). Loom runs a real
`ALTER TABLE delta.\`abfss://…\` SET TBLPROPERTIES (...)` against the Delta table
in ADLS Gen2 via a Databricks SQL Warehouse. Databricks then writes the Iceberg
V2 `metadata/` folder beside the `_delta_log`, making the table readable by
Iceberg readers — exactly OneLake's behavior, with zero Fabric/OneLake/Power BI
dependency.

| # | Capability | State | Backend per control |
|---|------------|-------|---------------------|
| 1 | Toggle "Expose table as Iceberg" | ✅ built / ⚠️ honest-gate | `PUT /api/lakehouse/settings` → `ALTER TABLE … SET TBLPROPERTIES ('delta.columnMapping.mode'='name','delta.enableIcebergCompatV2'='true','delta.universalFormat.enabledFormats'='iceberg')` on a Databricks SQL Warehouse. Honest MessageBar when `LOOM_DATABRICKS_HOSTNAME` / a warehouse is missing; selection is persisted in Cosmos either way. |
| 2 | Iceberg readers read same data, no copy | ✅ built | Delta UniForm writes Iceberg metadata in place; no data movement. |
| 3 | Per-table scope incl. schema-enabled | ✅ built | abfss path = `Tables/<schema>/<table>` when schemas enabled, else `Tables/<table>`. Schema picker bound to the lakehouse's real schemas. |
| 4 | Show ADLS path + Iceberg metadata path | ✅ built | Response returns `icebergAdlsPath` (`https://<acct>.dfs.core.windows.net/<container>/Tables/<table>`) and `icebergMetadataPath` (`…/metadata`) shown in an info MessageBar. |
| 5 | Iceberg REST Catalog (IRC) endpoint | ✅ built | Unity Catalog IRC: `https://<LOOM_DATABRICKS_HOSTNAME>/api/2.1/unity-catalog/iceberg` surfaced for catalog-based readers. |
| 6 | Disable / revert | ✅ built | Toggle off → `ALTER TABLE … UNSET TBLPROPERTIES ('delta.universalFormat.enabledFormats','delta.enableIcebergCompatV2')`. |

Zero ❌. The full surface renders with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset; the
only non-functional state is the honest Databricks infra gate.

## Verification

- Unit: `app/api/lakehouse/__tests__/settings-iceberg.test.ts` (6 cases: enable
  SET, disable UNSET, schema path, gate-no-databricks, gate-no-warehouse,
  no-op when absent).
- UI: Lakehouse editor → Settings (gear) → **Iceberg V2 endpoint** section.

## Bicep sync

No new resources or env vars. Reuses the existing Databricks SQL Warehouse path
(`LOOM_DATABRICKS_HOSTNAME`, optional `LOOM_DATABRICKS_SQL_WAREHOUSE_ID`) already
wired in `platform/fiab/bicep/modules/admin-plane/main.bicep` (also used by
liquid clustering, table history preview, and load-to-table).
