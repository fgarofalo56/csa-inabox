# copy-job — parity with Microsoft Fabric Copy job

Source UI:
- https://learn.microsoft.com/fabric/data-factory/what-is-copy-job
- https://learn.microsoft.com/fabric/data-factory/create-copy-job
- Incremental pattern grounded in https://learn.microsoft.com/azure/data-factory/tutorial-incremental-copy-portal

Loom item: `copy-job` · Editor: `lib/editors/copy-job-editor.tsx` ·
Wizard: `lib/components/pipeline/copy-job/wizard.tsx`

Azure-native backend (no-fabric-dependency.md): **Azure Data Factory** pipeline +
**Azure SQL** watermark control table. No Microsoft Fabric capacity / workspace
is required.

## Fabric Copy job feature inventory

| # | Fabric capability | Notes |
|---|---|---|
| 1 | Guided wizard: choose **source** connector + dataset | Connectors → ADF Linked Services |
| 2 | Choose **destination** connector + table/path | |
| 3 | **Copy mode**: Full vs Incremental | Incremental tracks a watermark column |
| 4 | **Incremental column** selection | The monotonically-increasing watermark |
| 5 | **Update method**: Append / Overwrite / Merge (upsert) | Merge needs key column(s) |
| 6 | **Column mapping** source → destination | Optional; default copy-by-name |
| 7 | **Review + create**, then run | |
| 8 | First run **full-loads**, later runs copy only the **delta** | Watermark advances each run |
| 9 | **Run history** with status/duration | |
| 10 | Persisted **watermark** visible | Control table row |

## Loom coverage

| # | Coverage | Backend per control |
|---|---|---|
| 1 | ✅ Wizard Step 1 "Source" — Linked Service dropdown (`/api/adf/linked-services`) + type + source table + query override | ADF `listLinkedServices` |
| 2 | ✅ Wizard Step 2 "Destination" — Linked Service + type + table/path | ADF |
| 3 | ✅ Wizard Step 3 "Mode" — Full / Incremental cards | — |
| 4 | ✅ Step 3 watermark column + control-table key (incremental) | — |
| 5 | ✅ Wizard Step 4 "Update" — Append / Overwrite / Merge cards + merge keys | ADF sink `preCopyScript` (Overwrite) / `writeBehavior:upsert` (Merge) |
| 6 | ✅ Wizard Step 5 "Mapping" — `KeyValueGrid` (no raw JSON) | ADF `TabularTranslator` |
| 7 | ✅ Wizard Step 6 "Review" — summary table + Save & apply | `PUT /api/items/copy-job/[id]` → Cosmos |
| 8 | ✅ Run now — Full = 1 Copy activity; Incremental = Lookup→Lookup→Copy→StoredProcedure | `POST .../run` → `upsertDataset`/`upsertPipeline`/`runPipeline` (adf-client) |
| 9 | ✅ Runs tab — real ADF pipeline runs | `GET .../runs` → `listPipelineRuns` (adf-client) |
| 10 | ✅ Watermark panel — reads `dbo.copy_watermark` | `GET .../watermark` → `executeParameterized` (azure-sql-client) |

Honest infra gate (no-vaporware.md): when `LOOM_COPYJOB_CONTROL_SQL_SERVER` is
unset the Watermark panel shows a `MessageBar intent="warning"` naming the env
var + `platform/fiab/bicep/modules/admin-plane/copy-job-control.bicep`, and incremental
**Run now** returns a precise 503. **Full copy works without the control DB.**

Zero ❌, zero stub banners.

## Backend wiring

- **Pipeline (incremental)** — the canonical ADF pattern:
  `LookupOldWatermark` (Script on `dbo.copy_watermark`) →
  `LookupNewWatermark` (Script `MAX(<col>)` on the source) →
  `IncrementalCopyActivity` (Copy, `WHERE <col> > old AND <= new`) →
  `UpdateWatermark` (`SqlServerStoredProcedure` → `dbo.usp_write_watermark`).
- **Control table** — `dbo.copy_watermark` (PK `source,table_name`) +
  `dbo.usp_write_watermark`. Created by `admin-plane/copy-job-control.bicep` **and**
  self-healed by the console on first incremental run (`ensureControlTable` via
  TDS+AAD). The ADF factory MI is granted `db_datareader/db_datawriter/EXECUTE`.
- **Env** — `LOOM_COPYJOB_CONTROL_SQL_SERVER` + `LOOM_COPYJOB_CONTROL_SQL_DB`
  added to `admin-plane/main.bicep` console app env.

## Verification

1. Configure incremental copy on a real SQL source table via the wizard.
2. **Run now** → first run full-loads; a `dbo.copy_watermark` row is written.
3. Insert new source rows.
4. **Run now** again → only the delta is copied; `last_value` advances.
5. Watermark panel + Runs tab reflect real Azure responses (no mock).
