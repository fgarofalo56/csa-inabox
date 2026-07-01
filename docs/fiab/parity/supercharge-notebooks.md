# supercharge-notebooks — parity with the Supercharge Microsoft Fabric notebooks

**Source UI / corpus:** [github.com/fgarofalo56/Suppercharge_Microsoft_Fabric](https://github.com/fgarofalo56/Suppercharge_Microsoft_Fabric)
(`notebooks/{bronze,silver,gold,ml,real-time,streaming,hitchhikers-guide,utils}`)

This doc records the 1:1 conversion of all 117 upstream Fabric notebooks into
Loom-native content bundles that run on Azure-native backends (Synapse Spark /
Databricks + ADLS Gen2 + ADX) with **zero hard Microsoft Fabric dependency**
(`.claude/rules/no-fabric-dependency.md`).

## Where it lives

| Artifact | Path |
| --- | --- |
| Converted notebooks (human-editable source / deliverable) | `examples/supercharge-fabric/notebooks/**` |
| Generated bundles (runtime data) | `apps/fiab-console/lib/apps/content-bundles/app-supercharge-*.ts` |
| Generator (deterministic, re-runnable) | `scripts/csa-loom/import-supercharge-notebooks.mjs` |
| Registry + catalog wiring | `content-bundles/index.ts`, `content-bundles/catalog-meta.ts` |
| Contract tests | `content-bundles/__tests__/supercharge-bundles.test.ts` |

Re-import after an upstream change:

```bash
# reset examples/supercharge-fabric/notebooks to pristine upstream, then:
node scripts/csa-loom/import-supercharge-notebooks.mjs
```

## Bundles (7 — one per medallion layer / category)

| appId | Notebooks | Layer |
| --- | --: | --- |
| `app-supercharge-bronze` | 28 | Raw ingestion → ADLS Gen2 Bronze Delta |
| `app-supercharge-silver` | 28 | Cleanse / conform |
| `app-supercharge-gold` | 34 | Business aggregates / dimensions |
| `app-supercharge-ml` | 8 | ML / MLOps (Azure ML / Databricks + ADLS + ADX) |
| `app-supercharge-streaming` | 9 | Streaming + CDC + real-time (8 streaming + 1 real-time) |
| `app-supercharge-utils` | 3 | Shared pipeline utilities (`%run`) |
| `app-supercharge-guide` | 7 | Hitchhiker's Guide platform recipes |
| **Total** | **117** | |

The upstream `real-time/02_kql_casino_floor.kql` is **converted + vendored**
(Fabric Eventhouse → Azure Data Explorer) but is not a notebook item — ADX KQL
querysets surface via the `kql-database` / `kql-dashboard` editors, not the
notebook editor.

## Fabric → Loom-native conversion (feature inventory + coverage)

| Upstream Fabric idiom | Azure-native replacement | Status |
| --- | --- | --- |
| OneLake ABFSS host `…@onelake.dfs.fabric.microsoft.com/…` | ADLS Gen2 `…@{{ADLS_ACCOUNT}}.dfs.core.windows.net/…` (`adls-client`; `LOOM_ADLS_ACCOUNT`) | ✅ built |
| Fabric runtime utils `notebookutils.*` (guides, direct calls) | `mssparkutils.*` (Synapse Spark native) | ✅ built |
| Fabric runtime utils `notebookutils.*` (medallion notebooks) | already shipped portable `try notebookutils / except mssparkutils / except env` — unchanged, runs on Synapse | ✅ built |
| Fabric Variable Library `spark.conf.get("spark.fabric.variable.X")` | Synapse Spark conf `spark.conf.get("spark.loom.variable.X")` (+ pipeline params) | ✅ built |
| OneLake shortcut (S3 / GCS) via Fabric REST `/shortcuts` | Spark direct read (`s3a://` / `gs://`) → ADLS Gen2 Bronze Delta | ✅ built |
| OneLake data-access-roles (RLS/CLS) via Fabric REST `/dataAccessRoles` | Synapse Serverless SQL Row-/Column-Level Security + ADLS RBAC/ACL | ✅ built |
| Fabric admin REST `api.fabric.microsoft.com/v1/workspaces` | Azure Resource Manager `management.azure.com/.../Microsoft.Synapse/workspaces` | ✅ built |
| Power BI dataset refresh `api.powerbi.com/.../refreshes` | Azure Analysis Services REST (or Loom Direct-Lake-Shim refresh) | ✅ built |
| Fabric token scope `api.fabric.microsoft.com/.default` | `management.azure.com/.default` (ARM) + `storage.azure.com/.default` (ADLS) | ✅ built |
| Fabric Eventhouse / RTI Real-Time Dashboard (`.kql`) | Azure Data Explorer (ADX) / Loom Real-Time Dashboard | ✅ built |

A generator guard fails the build if any of `api.fabric.microsoft.com`,
`api.powerbi.com`, or `onelake.dfs.fabric` survives in an emitted bundle; the
contract test re-asserts the same invariant per cell.

## Sample-data seeding + run-green fixes (task #83)

Making the notebooks actually run **green** on a fresh install required four
fixes beyond the Fabric→Azure conversion:

0. **Auto-create the Synapse default filesystem container** (the foundational
   blocker). On this deployment the Synapse Spark pool's `fs.defaultFS` and Hive
   warehouse point at an `abfss://synapse@<adls>…` container **that was never
   created** (the medallion `bronze`/`silver`/`gold`/`landing` containers exist;
   `synapse` did not). The result: every relative-path write (`Files/…`) 404'd
   with *"The specified filesystem does not exist"*, and every Hive catalog op
   (`SHOW DATABASES` / `CREATE DATABASE` / `saveAsTable` / `spark.table`) threw
   `HiveException: null path` because the warehouse dir resolved to a
   non-existent container. `createLivySessionAsync`
   (`lib/azure/synapse-dev-client.ts`) now sets
   `spark.hadoop.fs.azure.createRemoteFileSystemDuringInitialization=true` on
   every Livy session, so the ABFS driver creates the container on first access
   (idempotent). This single conf unblocks relative paths AND the managed-table
   catalog for every notebook run + the seed — verified live (relative parquet
   write, `SHOW DATABASES`, `saveAsTable default`, `CREATE DATABASE`+`saveAsTable`
   all went from `null path` → OK).

1. **`{{ADLS_ACCOUNT}}` substitution on the install + run paths.** The generator
   emits the deployment placeholder `{{ADLS_ACCOUNT}}` for the ADLS Gen2 account.
   It is now resolved to the real account (`LOOM_ADLS_ACCOUNT`) by
   `lib/apps/notebook-placeholders.ts`, called from both the app install route
   (persisted `state.cells`) and the notebook `/run` route (before the source is
   submitted to Livy). Left un-substituted the token yielded an invalid
   `abfss://…@{{ADLS_ACCOUNT}}.dfs.core.windows.net` host. Honest gate: when no
   account is resolvable the token is left intact so the cell fails with a clear
   invalid-host error rather than a silent wrong path.

2. **Two-part table names.** Upstream mixed a two-part WRITE
   (`saveAsTable("lh_bronze.bronze_x")`) with a three-part READ
   (`lh_bronze.dbo.bronze_x`). On Synapse Spark / Databricks the default
   `spark_catalog` has no `lh_bronze` **catalog**, so the three-part read failed
   ("Catalog not found") and Silver never saw Bronze's data. The generator now
   normalizes every `lh_<layer>.dbo.<table>` → `lh_<layer>.<table>` so reads and
   writes line up across the medallion (Azure SQL `dbo.<table>` refs untouched).

3. **Sample-data seeding at install time** (previously documented UNBUILT). The
   Bronze notebooks read raw sources from `Files/output/*.parquet`; on a fresh
   install those files don't exist. `lib/apps/supercharge-seed.ts` now
   pre-creates the `lh_bronze` / `lh_silver` / `lh_gold` Spark databases and
   lands deterministic **synthetic** Bronze SOURCE parquet (600 rows × 6 core
   casino sources — slot telemetry, player profile, financial txn, compliance,
   table games, security events) via one real Livy pyspark statement on the
   Synapse Spark pool. Wired as a real step in the app install worker
   (`app/api/apps/[id]/install/route.ts`, `phase: 'seeding'`, best-effort) and
   exposed as `POST /api/apps/supercharge/seed`. Real Spark-written parquet, no
   mocks. (Federal / streaming / ML sources beyond the casino core are not
   pre-seeded — their Bronze notebooks surface an honest empty-source read until
   their upstream feed is connected.)

Plus one genuine upstream bug fixed in source: `silver/01_silver_slot_cleansed.py`
deduplicated with a window ordered by `_silver_timestamp`, a column not added
until a later cell — an `AnalysisException` under Loom's cell-by-cell execution.
Now ordered by the real Bronze column `_bronze_ingested_at` (same "latest
ingestion wins" intent).

**Live green proof (task #83):** the slot-telemetry medallion chain — seed →
`01 — Bronze Slot Telemetry` → `01 — Silver Slot Cleansed` → `01 — Gold Slot
Performance` — runs cell-by-cell on Synapse Spark (`loompool`) in the
`supercharge-cell-validation` workspace with **every code cell Succeeded**:
seed 1/1, Bronze 11/11, Silver 17/17, Gold 14/14 (43/43). Real data flows
end-to-end — 600 seeded rows → `lh_bronze.bronze_slot_telemetry` (600) →
`lh_silver.silver_slot_cleansed` (600, post-dedup) → `lh_gold.gold_slot_performance`
(real KPIs: net_win, hold %, zone/performance breakdowns). The full 117-notebook
sweep runs the same way once the fix is deployed (every Livy session gets the
container-create conf); seed the workspace, then loop `temp/loom-nb.mjs run
<wsId> <nbId>` over every notebook id.

## Backend per surface (how they install + run)

- **Install** → `notebookProvisioner` (`lib/install/provisioners/notebook.ts`):
  Azure-native default is **Synapse** (`LOOM_SYNAPSE_WORKSPACE` → nbformat
  artifact) or **Databricks** (`LOOM_DATABRICKS_HOSTNAME` → SOURCE notebook at
  `/Shared/loom-installs/…`). Fabric is opt-in only
  (`LOOM_NOTEBOOK_BACKEND=fabric`). Works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
  **unset**.
- **Execute** → `/api/items/notebook/[id]/execute-spark`
  (`resolveSparkBackend`): AML Serverless Spark (`LOOM_AML_SPARK`, Commercial/GCC)
  or **Synapse Spark via Livy** (`LOOM_SYNAPSE_SPARK_POOL`). GCC-High / IL5 force
  Synapse Livy (AML Spark not offered in Gov). The converted cells avoid
  AML-only APIs so the same bundle runs on a Synapse Spark pool in every cloud.

## Bicep / bootstrap sync

**No new infrastructure.** These bundles reuse already-deployed Synapse Spark
pools, Databricks, ADLS Gen2, and ADX, and the env vars already wired in
`platform/fiab/bicep/modules/admin-plane/main.bicep`
(`LOOM_SYNAPSE_WORKSPACE`, `LOOM_SYNAPSE_SPARK_POOL`, `LOOM_AML_SPARK` —
blanked for GCC-High/IL5, `LOOM_DATABRICKS_HOSTNAME`, `LOOM_ADLS_ACCOUNT`).
No new Azure resource, env var, role assignment, Cosmos container, or tenant
config is introduced, so no bicep or bootstrap change is required.

## Verification

- `npx vitest run lib/apps/content-bundles/__tests__/supercharge-bundles.test.ts`
  — 6 tests green (registry + catalog wiring, 117-notebook count, every item is
  a runnable notebook, zero Fabric/OneLake/Power BI hosts, ADLS-not-OneLake
  routing, install-path resolution).
- `npx tsc --noEmit` — zero errors in the touched files.
- Generator guard — zero forbidden Fabric tokens in emitted bundles.
