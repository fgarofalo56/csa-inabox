# copy-job — parity with Microsoft Fabric Copy job

Source UI:
- https://learn.microsoft.com/fabric/data-factory/what-is-copy-job
- https://learn.microsoft.com/fabric/data-factory/create-copy-job
- CDC mode grounded in https://learn.microsoft.com/fabric/data-factory/cdc-copy-job
  and https://learn.microsoft.com/fabric/data-factory/cdc-copy-job-azure-sql-database
- Native SQL CDC connector behaviour: https://learn.microsoft.com/azure/data-factory/connector-sql-server#native-change-data-capture
- Incremental pattern grounded in https://learn.microsoft.com/azure/data-factory/tutorial-incremental-copy-portal

Loom item: `copy-job` · Editor: `lib/editors/copy-job-editor.tsx` ·
Wizard: `lib/components/pipeline/copy-job/wizard.tsx`

Azure-native backend (no-fabric-dependency.md): **Azure Data Factory** pipeline +
**Azure SQL** watermark / CDC LSN checkpoint control table. No Microsoft Fabric
capacity / workspace is required.

## Fabric Copy job feature inventory

| # | Fabric capability | Notes |
|---|---|---|
| 1 | Guided wizard: choose **source** connector + dataset | Connectors → ADF Linked Services |
| 2 | Choose **destination** connector + table/path | |
| 3 | **Copy mode**: Full vs Incremental vs **CDC** | Incremental tracks a watermark column; CDC reads native SQL change tracking |
| 4 | **Incremental column** selection | The monotonically-increasing watermark |
| 5 | **Update method**: Append / Overwrite / Merge (upsert) | Merge needs key column(s) |
| 6 | **Column mapping** source → destination | Optional; default copy-by-name |
| 7 | **Review + create**, then run | |
| 8 | First run **full-loads**, later runs copy only the **delta** | Watermark / LSN advances each run |
| 9 | **Run history** with status/duration | |
| 10 | Persisted **watermark / checkpoint** visible | Control table row |
| 11 | **CDC read method** (native change tracking: inserts/updates/deletes) | SQL Server / Azure SQL / MI; `cdc.fn_cdc_get_net_changes_*` |
| 12 | CDC applies net changes via **Merge** (SCD Type 1) | Upsert keyed by PK; deletes applied |

## Loom coverage

| # | Coverage | Backend per control |
|---|---|---|
| 1 | ✅ Wizard Step 1 "Source" — Linked Service dropdown (`/api/adf/linked-services`) + type + source table + query override | ADF `listLinkedServices` |
| 2 | ✅ Wizard Step 2 "Destination" — Linked Service + type + table/path | ADF |
| 3 | ✅ Wizard Step 3 "Mode" — Full / Incremental / **CDC** cards (CDC SQL-source gated) | — |
| 4 | ✅ Step 3 watermark column + control-table key (incremental); capture instance + LSN checkpoint key (CDC) | — |
| 5 | ✅ Wizard Step 4 "Update" — Append / Overwrite / Merge cards + merge keys (CDC pins Merge) | ADF sink `preCopyScript` (Overwrite) / `writeBehavior:upsert` (Merge) |
| 6 | ✅ Wizard Step 5 "Mapping" — `KeyValueGrid` (no raw JSON) | ADF `TabularTranslator` |
| 7 | ✅ Wizard Step 6 "Review" — summary table + Save & apply | `PUT /api/items/copy-job/[id]` → Cosmos |
| 8 | ✅ Run now — Full = 1 Copy activity; Incremental / CDC = Lookup→Lookup→Copy→StoredProcedure | `POST .../run` → `upsertDataset`/`upsertPipeline`/`runPipeline` (adf-client) |
| 9 | ✅ Runs tab — real ADF pipeline runs | `GET .../runs` → `listPipelineRuns` (adf-client) |
| 10 | ✅ Watermark / CDC checkpoint panel — reads `dbo.copy_watermark` | `GET .../watermark` → `executeParameterized` (azure-sql-client) |
| 11 | ✅ CDC read method — `cdc.fn_cdc_get_net_changes_<instance>(from,to,'all')`, from = next LSN after checkpoint, to = `sys.fn_cdc_get_max_lsn()` | `POST .../run` (`cdcPipeline`) |
| 12 | ✅ CDC Merge / SCD Type 1 — net rows upserted into the destination by key | ADF sink `writeBehavior:upsert` |

Honest infra gate (no-vaporware.md): when `LOOM_COPYJOB_CONTROL_SQL_SERVER` is
unset the Watermark / CDC checkpoint panel shows a `MessageBar intent="warning"`
naming the env var + `platform/fiab/bicep/modules/admin-plane/copy-job-control.bicep`,
and incremental / CDC **Run now** returns a precise 503. **Full copy works
without the control DB.**

Zero ❌, zero stub banners.

## Backend wiring

- **Pipeline (incremental)** — the canonical ADF pattern:
  `LookupOldWatermark` (Script on `dbo.copy_watermark`) →
  `LookupNewWatermark` (Script `MAX(<col>)` on the source) →
  `IncrementalCopyActivity` (Copy, `WHERE <col> > old AND <= new`) →
  `UpdateWatermark` (`SqlServerStoredProcedure` → `dbo.usp_write_watermark`).
- **Pipeline (CDC)** — native SQL change tracking:
  `LookupOldLsn` (Script on `dbo.copy_watermark` — last LSN as `0x…` hex) →
  `LookupMaxLsn` (Script `sys.fn_cdc_get_max_lsn()` on the source) →
  `CdcCopyActivity` (Copy from `cdc.fn_cdc_get_net_changes_<instance>(@from,@to,'all')`,
  `@from = sys.fn_cdc_increment_lsn(last)` or `sys.fn_cdc_get_min_lsn()` on first run) →
  `UpdateWatermark` (`SqlServerStoredProcedure` persists the new max LSN). Net rows
  are upserted (Merge / SCD Type 1). Capture instance defaults to `<schema>_<table>`.
- **Control table** — `dbo.copy_watermark` (PK `source,table_name`) +
  `dbo.usp_write_watermark`. The single `last_value` column holds the incremental
  high-water mark OR the CDC last-LSN hex string — **no schema change for CDC**.
  Created by `admin-plane/copy-job-control.bicep` **and** self-healed by the console
  on first incremental/CDC run (`ensureControlTable` via TDS+AAD). The ADF factory
  MI is granted `db_datareader/db_datawriter/EXECUTE`.
- **Env** — `LOOM_COPYJOB_CONTROL_SQL_SERVER` + `LOOM_COPYJOB_CONTROL_SQL_DB`
  added to `admin-plane/main.bicep` console app env (shared by both modes).

## Verification

1. Configure incremental copy on a real SQL source table via the wizard.
2. **Run now** → first run full-loads; a `dbo.copy_watermark` row is written.
3. Insert new source rows.
4. **Run now** again → only the delta is copied; `last_value` advances.
5. Watermark panel + Runs tab reflect real Azure responses (no mock).

### CDC mode

1. Enable native CDC on the source DB + table (`sys.sp_cdc_enable_db`,
   `sys.sp_cdc_enable_table @supports_net_changes = 1`).
2. Configure CDC copy in the wizard (SQL source, Merge + merge keys).
3. **Run now** → first run reads from the table's min CDC LSN; `last_value` is the
   max LSN as a `0x…` hex string.
4. Insert/update/delete source rows.
5. **Run now** again → only net changes are upserted; `last_value` advances.
