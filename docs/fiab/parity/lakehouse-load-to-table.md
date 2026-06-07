# lakehouse-load-to-table — parity with Fabric Lakehouse "Load to Tables"

Source UI: Microsoft Fabric Lakehouse explorer → right-click a file in **Files/**
→ **Load to Tables** (and the equivalent in the Synapse Spark / notebook flow).
Learn: https://learn.microsoft.com/fabric/data-engineering/load-to-tables

Azure-native backend (no Fabric dependency): **Azure Synapse Spark** pool via
the Livy API on `dev.azuresynapse.net`. The job writes a managed **Delta** table
under `abfss://<container>@<account>.dfs.core.windows.net/Tables/<table>`.

## Fabric/Azure feature inventory

| # | Capability in Fabric "Load to Tables" | Notes |
|---|----------------------------------------|-------|
| 1 | Trigger from a file's right-click menu in Files/ | context menu + row menu |
| 2 | Keyboard affordance to start the load | Fabric uses contextual; Loom binds **F6** |
| 3 | Choose **New table** name (validated identifier) | lowercase identifier rules |
| 4 | Auto-detect source file format (CSV/Parquet/JSON) | header/infer for CSV |
| 5 | Choose **Load mode**: Overwrite vs Append | |
| 6 | Pick the Spark compute that runs the load | Fabric: capacity; Loom: Synapse Spark pool |
| 7 | Submit the load as a Spark job | real Livy submission |
| 8 | Table appears in the lakehouse **Tables** catalog | listed under Tables/ |
| 9 | Resulting table is queryable (SQL / notebook) | metastore registration via saveAsTable |
| 10 | Job is observable (run history / Monitor) | toast deep-links to Monitor; Livy job id in receipt |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | built ✅ | `lakehouse-editor.tsx` row menu + context menu "Load to Tables (Delta)" → `onLoadToTables` opens the wizard |
| 2 | built ✅ | `lakehouse-editor.tsx` F6 `keydown` handler on the selected file |
| 3 | built ✅ | `load-to-table-wizard.tsx` step 2 Table name `Input` + `validateLoadTableName` |
| 4 | built ✅ | `detectSparkFormat()` in step 1 + format `Dropdown` override in step 2 |
| 5 | built ✅ | step 3 Write mode `Dropdown` (overwrite/append) |
| 6 | built ✅ | step 2 Spark pool `Dropdown` populated from `GET /api/loom/compute-targets` (no freeform) |
| 7 | built ✅ | `POST /api/lakehouse/load-to-table` → `submitLivyBatch()` (real Synapse Livy) |
| 8 | built ✅ | wizard's `onJobSubmitted` refreshes the Tables tab; job writes to `Tables/<table>` |
| 9 | built ✅ | `saveAsTable(..., option('path', …))` registers the table in the Spark metastore |
| 10 | built ✅ | success Toast with **View in Monitor** link; receipt carries Livy job id + row count |

Honest gate ⚠️ (per no-vaporware): if `LOOM_SYNAPSE_WORKSPACE` is unset, the
route returns a 503 naming the env var + the `synapse.bicep deploySparkPool=true`
module. If no Spark pool is deployed, step 2 shows a `MessageBar` pointing at the
same module. If the ADLS account is unresolved, a 503 names the `LOOM_*_URL` vars.

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Format detection | `lib/azure/spark-format-detect.ts#detectSparkFormat` (client + server) |
| Spark pool list | `GET /api/loom/compute-targets` → `synapse-dev-client#listSparkPools` (ARM) |
| Code generation | `lib/azure/load-to-table-codegen.ts#buildLoadToTablePySpark` (pure, unit-tested) |
| Job submission | `POST /api/lakehouse/load-to-table` → `synapse-dev-client#submitLivyBatch` (Livy) |
| Row count receipt | `getLivyStatement` poll → `parseLoadRowCount` |
| Table catalog refresh | `GET /api/lakehouse/paths?prefix=Tables` |

## Bicep / RBAC

No new resources. Prerequisites already deployed:
- `platform/fiab/bicep/modules/landing-zone/synapse.bicep` — `deploySparkPool=true` (`loompool`).
- `platform/fiab/bicep/modules/landing-zone/synapse-storage-rbac.bicep` — Synapse
  workspace MSI → Storage Blob Data Contributor on the default ADLS (Hive
  metastore warehouse + the Tables/ write path).
- Console UAMI Synapse Administrator + ARM Contributor (in `synapse.bicep`) for
  the data-plane Livy submission.

## Verification

Sign in, open a Lakehouse, drop a CSV in Files/, press F6 (or right-click →
Load to Tables), pick the pool, Run. The Spark job submits via Livy; on
completion the Tables tab shows the new Delta table and it is queryable from a
notebook. Receipt JSON includes `job.id` (Livy session.statement) and
`job.rowCount`. Validated with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — fully
Azure-native.
