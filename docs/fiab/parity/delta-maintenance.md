# delta-maintenance — parity with the Fabric Lakehouse "Maintenance" dialog (Delta OPTIMIZE / VACUUM / ZORDER BY)

Source UI: **Microsoft Fabric → Lakehouse → table context menu → Maintenance**
(`Run maintenance commands` flyout) and the equivalent Spark SQL surface in
**Azure Synapse / Databricks notebooks**. The Fabric Maintenance dialog runs
three Delta Lake commands against a single table:

- **Run OPTIMIZE** (with an optional **V-Order** checkbox; Fabric's V-Order is a
  Microsoft-proprietary write optimization, the open equivalent is plain
  bin-pack compaction).
- **ZORDER BY** a chosen set of columns (multi-select from the table schema).
- **Run VACUUM** with a **retention threshold** (Fabric exposes "Apply
  retention" + a default of 7 days / 168 hours).

Loom's Azure-native equivalent
(`apps/fiab-console/lib/editors/components/delta-maintenance-dialog.tsx`, opened
from `lib/editors/lakehouse-editor.tsx`) submits the **same three Spark SQL
commands** to a **Synapse Spark** Livy interactive session via
`/api/lakehouse/maintenance`. No Fabric capacity, OneLake API, or Power BI
workspace is involved — the table lives in the DLZ ADLS Gen2 account and compute
is Synapse Spark. The job is tracked in **Monitor → Maintenance**.

Grounded in Microsoft Learn:

- OPTIMIZE (bin-packing + ZORDER BY):
  https://learn.microsoft.com/azure/databricks/sql/language-manual/delta-optimize
- VACUUM (retention threshold, `retentionDurationCheck`):
  https://learn.microsoft.com/azure/databricks/sql/language-manual/delta-vacuum
- Fabric Lakehouse table maintenance:
  https://learn.microsoft.com/fabric/data-engineering/lakehouse-table-maintenance
- Synapse Spark Livy interactive sessions:
  https://learn.microsoft.com/rest/api/synapse/data-plane/spark-session

Data-plane: **`https://<workspace>.dev.azuresynapse.net/livyApi/...`** (Commercial)
/ **`...dev.azuresynapse.usgovcloudapi.net`** (Gov). Compaction reads + rewrites
Parquet files and the `_delta_log` in ADLS as the **Synapse workspace MSI**
(Storage Blob Data Contributor on the DLZ account, granted in
`platform/fiab/bicep/modules/landing-zone/synapse-storage-rbac.bicep`).

## Azure/Fabric feature inventory

| # | Capability in Fabric/Azure | Notes |
|---|----------------------------|-------|
| 1 | Open a per-table Maintenance dialog from the table context menu | One table at a time |
| 2 | "Run OPTIMIZE" toggle (compaction) | Bin-packs small files into ~1 GB files |
| 3 | ZORDER BY column multi-select (from table schema) | Only when OPTIMIZE is on; high-cardinality filter columns |
| 4 | "Run VACUUM" toggle | Removes tombstoned files |
| 5 | VACUUM retention threshold (default 7 days) | Fabric shows days; Delta SQL uses hours |
| 6 | Submit the job to Spark compute | Fabric uses the workspace capacity; Azure-native uses a Spark pool |
| 7 | Track the job + see its result/status | Fabric Monitoring hub |
| 8 | Pick the compute the job runs on | Implicit in Fabric; explicit Spark-pool picker in Synapse/Databricks |

## Loom coverage

| # | Capability | Status | Where |
|---|-----------|--------|-------|
| 1 | Per-table Maintain dialog | ✅ built | `DeltaMaintenanceDialog`, opened from each Tables-tab row + ribbon Manage → "Maintain…" |
| 2 | Compaction (OPTIMIZE) toggle | ✅ built | `Switch` "compaction"; emits `OPTIMIZE delta.\`<uri>\`` |
| 3 | ZORDER BY column picker | ✅ built | `Dropdown multiselect` restricted to the table's columns (from live schema or the bundle DDL via `parseDdlColumns`); appends `ZORDER BY (...)` |
| 4 | VACUUM toggle | ✅ built | `Switch` "vacuum"; emits `VACUUM delta.\`<uri>\` RETAIN n HOURS` |
| 5 | Retention threshold | ✅ built | Fixed `Select` allowlist (48 / 168 / 336 / 720 / 1440 h) — no free-form number, per loom-no-freeform-config; retention check relaxed server-side so sub-168h is honored exactly |
| 6 | Submit to Spark | ✅ built | `createLivySessionAsync` → lazy `submitLivyStatement` once the session is idle |
| 7 | Track job + result | ✅ built | Cosmos `maintenance-jobs` doc; **Monitor → Maintenance** tab lists + lazily polls Livy; success toast deep-links to `/monitor?tab=maintenance` |
| 8 | Compute (Spark pool) picker | ✅ built | `useComputes(['synapse-spark'])` — real ARM `listSparkPools()`, never a text field |
| — | V-Order (Fabric-proprietary) | n/a | Not an open Delta feature; plain compaction is the Azure-native equivalent. Documented, not a gap. |

Zero ❌, zero stub banners. The only non-functional state is an **honest infra
gate**: if no `LOOM_{BRONZE,SILVER,GOLD,LANDING}_URL` is set, POST returns a
`adls_unconfigured` 503 naming the exact env vars; if the Console UAMI lacks
Synapse Administrator, POST returns `livy_access_denied` naming the role.

## Backend per control

| Control | Backend call |
|---------|--------------|
| Spark-pool picker | `GET /api/loom/compute-targets` → ARM `bigDataPools` list (filtered to `synapse-spark`) |
| Run maintenance | `POST /api/lakehouse/maintenance` → `createLivySessionAsync(pool,'pyspark')` on `…/livyApi/.../sparkPools/<pool>/sessions` |
| Statement execution | `submitLivyStatement(pool, sessionId, { code, kind:'pyspark' })` — runs `spark.sql('OPTIMIZE …')` / `spark.sql('VACUUM … RETAIN n HOURS')` |
| Job list + status | `GET /api/lakehouse/maintenance` → Cosmos `maintenance-jobs` query (PK `/tenantId`) + lazy `getLivySession` / `getLivyStatement` poll |
| Storage writes | Synapse workspace MSI, Storage Blob Data Contributor on the DLZ ADLS account |

## Per-cloud

- **Commercial** — default hosts (`management.azure.com`,
  `<ws>.dev.azuresynapse.net`). OPTIMIZE/VACUUM/ZORDER supported on Synapse Spark
  2.4+/3.x.
- **GCC / GCC-High / IL5** — set `AZURE_ARM_HOST=management.usgovcloudapi.net`
  and `AZURE_SYNAPSE_DEV_HOST_SUFFIX=dev.azuresynapse.usgovcloudapi.net`
  (parameterized in `synapse-dev-client.ts`). Livy API version + paths are
  identical across clouds; token audiences follow the host automatically via
  `DefaultAzureCredential`. IL5: CMK on ADLS (`storageRequireCmk=true`) covers
  the rewritten Parquet + `_delta_log` — no maintenance-specific compliance gate.

## Verification

- `npx vitest run lib/azure/__tests__/delta-maintenance.test.ts` — 19 green
  (validation allowlists, SQL-injection rejection, abfss + pyspark codegen, DDL
  column parsing).
- Live (operator): open a lakehouse → Tables tab → **Maintain** on a real table
  → pick a Spark pool → Run. Confirm the job appears in **Monitor → Maintenance**
  and reaches **Succeeded**, then re-list files in the table folder (Tables/<t>)
  and confirm the Parquet **file count drops** after OPTIMIZE. With
  `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET — Azure-native path is the only path.
