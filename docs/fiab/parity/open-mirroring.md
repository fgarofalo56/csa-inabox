# open-mirroring — parity with Fabric open mirroring (push Parquet → managed Delta)

Source UI: https://learn.microsoft.com/fabric/mirroring/open-mirroring
            https://learn.microsoft.com/fabric/mirroring/open-mirroring-landing-zone-format
Editor: `apps/fiab-console/lib/editors/mirrored-database-editor.tsx` → `OpenMirrorConfig`
Component: `apps/fiab-console/lib/editors/components/open-mirror-config.tsx`
Engine: `apps/fiab-console/lib/azure/mirror-engine.ts` (`runOpenMirrorMerge`, `openMirror*` helpers)
Route: `apps/fiab-console/app/api/items/mirrored-database/[id]/open-mirror/route.ts`
Bicep: `platform/fiab/bicep/modules/landing-zone/storage.bicep` (`landing` container + `landingContainerUrl`)

> Fabric "open mirroring" is a **push** model: an external producer drops Parquet
> (+ an optional `_metadata.json` declaring key columns) into a per-mirror landing
> zone, and Fabric folds it into a managed Delta table the consumer queries. The
> **Azure-native default** (per `no-fabric-dependency.md`) reproduces this with
> **NO Microsoft Fabric / OneLake**:
>
> - **Landing zone** = ADLS Gen2 `landing` container, path `<mirrorId>/<table>/*.parquet`
> - **Managed Delta** = ADLS Gen2 `bronze` container, path `mirrors/<workspaceId>/<mirrorId>/Tables/<table>`
> - **Merge engine** = a **Synapse Spark Livy batch** that reads new Parquet and
>   `MERGE`s (upsert+delete via `__rowMarker__` + key columns) or appends into Delta
> - **Query surface** = Synapse Serverless `OPENROWSET(... FORMAT='DELTA')`
>
> The surface renders fully with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — there is
> no Fabric workspace gate; the only non-functional state is an honest Azure infra
> MessageBar (LOOM_LANDING_URL / LOOM_BRONZE_URL / LOOM_SYNAPSE_WORKSPACE).

## Source-UI feature inventory (grounded in Learn)

| # | Fabric open-mirroring capability | Fabric behavior in the real UI |
| --- | --- | --- |
| 1 | Landing zone URL | The producer is given the per-mirror landing-zone path to push Parquet to |
| 2 | Producer credentials | The producer authenticates to the landing zone (managed identity / SAS / RBAC) |
| 3 | `_metadata.json` key columns | Declares the table's key columns to drive UPSERT/DELETE semantics |
| 4 | `__rowMarker__` row ops | Parquet rows carry an op marker (0 insert, 1 update, 2 delete, 4 upsert) |
| 5 | Replication / merge schedule | How often new landing-zone Parquet is folded into the managed table |
| 6 | Managed Delta table | Merged data becomes a queryable Delta table |
| 7 | Replication status | Last run state + row/file counts surfaced to the operator |
| 8 | Query the mirrored table | The consumer queries the managed Delta table (SQL endpoint) |

## Loom coverage

| # | Capability | State | Loom surface |
| --- | --- | --- | --- |
| 1 | Landing zone URL | built ✅ | "Landing zone" card shows the resolved `abfss://landing@…/<mirrorId>` + per-table drop path + Copy |
| 2 | Producer credentials | built ✅ / honest-gate ⚠️ | "Producer credentials" card: **RBAC tab** (copyable Storage Blob Data Contributor scope + `az` command) and **SAS tab** (honest gate naming the Storage Blob Delegator role) |
| 3 | `_metadata.json` key columns | built ✅ | "Key columns" input drives the Delta `MERGE` join condition |
| 4 | `__rowMarker__` row ops | built ✅ | Merge script filters `__rowMarker__` ∈ {0,1,4} → upsert, =2 → delete |
| 5 | Merge schedule | built ✅ | Fixed-allowlist Dropdown (`on-demand / 15min / 1h / 4h / daily`), persisted to Cosmos |
| 6 | Managed Delta table | built ✅ | Synapse Spark Livy batch writes Delta under `bronze/mirrors/<ws>/<id>/Tables/<table>` |
| 7 | Replication status | built ✅ | "Merge status" card: status badge + job id + last run; "Refresh status" polls `getSparkBatchJob` |
| 8 | Query the mirrored table | built ✅ | `OPENROWSET(... FORMAT='DELTA')` SELECT COUNT(*) with Copy SQL |

Zero ❌, zero stub banners. The recurring (15min/1h/4h/daily) schedules are an
honest disclosure: they run by wiring an ADF / Synapse scheduled trigger (or Logic
App timer) to POST the same route — "Merge now" runs that merge immediately.

## Backend per control

| Control | Backend |
| --- | --- |
| Landing zone path | `openMirrorLandingAbfss` → `resolveAbfssRoot('landing', …)` (sovereign-cloud suffix from `LOOM_LANDING_URL`) |
| RBAC scope / SAS gate | static ARM scope string / `GET ?action=sas` honest gate |
| Merge schedule + key columns | `POST open-mirror` → Cosmos `itemsContainer().replace` (state.openMirror) |
| Merge now | `POST open-mirror` → `runOpenMirrorMerge` → `listPaths('landing')` + `uploadFile('bronze', scripts/open-mirror-merge.py)` + `submitSparkBatchJob` (Synapse Livy) |
| Refresh status | `GET ?action=status` → `getSparkBatchJob` (Synapse Livy) |
| Query managed Delta | `openMirrorOpenrowset` → Synapse Serverless `OPENROWSET(FORMAT='DELTA')` |

## Cloud boundary (sovereign correctness)

| Cloud | DFS suffix | Synapse Livy dev host | Notes |
| --- | --- | --- | --- |
| Commercial / GCC | `dfs.core.windows.net` | `dev.azuresynapse.net` | full path |
| GCC-High / IL5 / DoD | `dfs.core.usgovcloudapi.net` | `dev.azuresynapse.usgovcloudapi.net` (via `AZURE_SYNAPSE_DEV_HOST_SUFFIX` / `LOOM_SYNAPSE_DEV_SUFFIX`) | identical flow |

All abfss URIs are derived from the configured `LOOM_{LANDING,BRONZE}_URL` via
`resolveAbfssRoot` — no hard-coded `.dfs.core.windows.net`, so the suffix is
correct per cloud automatically.

## Acceptance receipt (Parquet drop → merge job id → SELECT COUNT(*))

1. **Drop Parquet** into the landing zone:
   `az storage blob upload --account-name <acct> --container-name landing --name "<mirrorId>/default/0001.parquet" --file ./test.parquet --auth-mode login`
2. **Trigger merge**: `POST /api/items/mirrored-database/<mirrorId>/open-mirror?workspaceId=<ws>` body `{ "tableName": "default" }`
   → `{ ok: true, status: "Submitted", jobId: 42, filesFound: 1, openrowset: "SELECT COUNT(*) … FORMAT='DELTA' …" }`
3. **Poll**: `GET …/open-mirror?workspaceId=<ws>&action=status` → `{ ok: true, jobId: 42, status: "Succeeded" }`
4. **Query**: run the returned `OPENROWSET(... FORMAT='DELTA')` SELECT COUNT(*) in
   Synapse Serverless → row count matches the dropped Parquet.

## Verification

- `tsc --noEmit` clean for all touched files.
- `lib/azure/__tests__/open-mirror.test.ts` covers the pure abfss/openrowset/allowlist
  helpers (Commercial + USGov suffixes). The fiab-console vitest harness is currently
  unable to run in an isolated worktree (missing `@adobe/css-tools` / `@azure/abort-controller`
  in the shared pnpm store — affects every existing test); the test runs in CI where
  the store is intact.
