# mirrored-database-monitor — parity with Fabric Mirrored Database "Monitor replication" + lifecycle

**Surface:** the **Monitor** tab + **Replication** ribbon group (Stop / Start /
Restart) of the CSA Loom Mirrored Database editor
(`apps/fiab-console/lib/editors/mirrored-database-editor.tsx`).

This is the Loom analogue of Fabric's **Mirrored database → Monitor replication**
page and the **Stop / Start replication** lifecycle controls — built on the
Azure-native backend (ADF CDC / Synapse Link copy → ADLS Bronze), with **no
Microsoft Fabric or Power BI dependency** on the default path.

**Source UI (grounded in Microsoft Learn):**
- Monitor Fabric mirrored database replication (per-table status, **rows replicated**, **Last completed** timestamp, errors) — https://learn.microsoft.com/fabric/mirroring/monitor
- Mirrored database operation logs (`MirroredDatabaseTableExecution`, `ReplicatorBatchLatency`) — https://learn.microsoft.com/fabric/mirroring/monitor-logs
- Stop / Start replication (lifecycle) — https://learn.microsoft.com/fabric/mirroring/manage-mirrored-database
- Mirrored database REST (`startMirroring`, `stopMirroring`, `getMirroringStatus`, `getTablesMirroringStatus`) — https://learn.microsoft.com/fabric/mirroring/mirrored-database-rest-api
- ADF pipeline-run monitoring (`queryPipelineRuns`) for the Azure-native copy — https://learn.microsoft.com/azure/data-factory/monitor-programmatically

## Fabric/Azure feature inventory

| # | Fabric "Monitor replication" / lifecycle capability | Notes |
|---|------------------------------------------------------|-------|
| 1 | Overall mirroring status (Running / Stopped / …) | Header status pill |
| 2 | Per-table grid: table name | One row per replicated table |
| 3 | Per-table **status** (Replicated / Replicating / Error) | Status badge per table |
| 4 | Per-table **rows replicated** (true count) | Numeric, from replication telemetry |
| 5 | Per-table **last sync / Last completed** timestamp | Real timestamp, not "—" |
| 6 | Per-table **error** surfaced inline | Error string when a table fails |
| 7 | Snapshot vs incremental (change-tracking) indicator | Mode badge |
| 8 | **Stop** replication | Pauses the CDC job |
| 9 | **Start** replication | Resumes / runs the sync |
| 10 | **Restart** / re-seed replication | Full re-snapshot from scratch |
| 11 | Confirm prompt for destructive lifecycle actions | Stop / Restart confirm |
| 12 | Auto-refreshing monitor view | Live updates |
| 13 | Underlying copy/pipeline run telemetry (run state, duration) | ADF run state on the Azure path |

## Loom coverage

| # | Capability | Coverage | Backend per control |
|---|------------|----------|---------------------|
| 1 | Overall status pill | ✅ built | `state.mirroringStatus` (Cosmos) via `GET …/monitor` |
| 2 | Per-table name | ✅ built | `state.tablesStatus[]` (Cosmos), written by `runMirrorSnapshot` |
| 3 | Per-table status badge | ✅ built | `tablesStatus[].status` → `getMirrorStatus()` projection |
| 4 | Rows replicated (true count) | ✅ built | `tablesStatus[].rows` — real `SELECT`/`CHANGETABLE` row counts from the engine |
| 5 | Last sync timestamp | ✅ built | `tablesStatus[].lastSync` — real ISO stamp per run |
| 6 | Per-table error inline | ✅ built | `tablesStatus[].error` |
| 7 | Snapshot/incremental badge | ✅ built | `tablesStatus[].mode` + CT watermark `syncVersion` |
| 8 | **Stop** | ✅ built | `POST …/lifecycle {action:'stop'}` → marks `Stopped` in Cosmos; CDC/change feed no longer consumed → source changes stop replicating |
| 9 | **Start** | ✅ built | `POST …/lifecycle {action:'start'}` → `runMirrorSnapshot()` (incremental when CT watermarks exist) |
| 10 | **Restart** | ✅ built | `POST …/lifecycle {action:'restart'}` → `restartMirrorSnapshot()` clears all watermarks → full re-snapshot |
| 11 | Confirm dialog (Stop / Restart) | ✅ built | Fluent `Dialog` before the destructive call |
| 12 | Auto-refresh (30 s) | ✅ built | `setInterval` re-calls `GET …/monitor` while the tab is open |
| 13 | Copy/pipeline run telemetry | ✅ built | ADF `queryPipelineRuns` for the provisioner-backed `<name>_to_bronze` pipeline → `adfLastRun` (run state + duration). Honest-skip when `LOOM_ADF_NAME` unset |
| — | Live ADLS commit probe (extra) | ✅ built | `listPaths('bronze', mirrors/<ws>/<id>/<schema>.<table>)` → landing file/byte counts (a `_delta_log`-style probe of what is actually committed) |

**Honest disclosure rows (⚠️):** none gate the default path. When `LOOM_ADF_NAME`
is unset the ADF run-state bar is simply absent (Azure-side optional telemetry);
the rest of the monitor still renders with real Cosmos + ADLS data. When
`LOOM_BRONZE_URL` is unset the landing probe is skipped (the engine already gates
Start with that env var).

**Zero ❌. Zero stub banners.** No Fabric/Power BI workspace is required — the
monitor and all three lifecycle actions operate entirely on the Azure-native
backend (Cosmos state + ADLS Bronze + ADF telemetry).

## Backend wiring

- **Editor:** `lib/editors/mirrored-database-editor.tsx` — Monitor tab (`view==='monitor'`), ribbon Replication group, `loadMonitor()` (30 s auto-refresh), `lifecycle()` with before/after receipt + confirm dialog.
- **Routes:**
  - `app/api/items/mirrored-database/[id]/monitor/route.ts` — `GET`, returns `getMirrorStatus()` payload.
  - `app/api/items/mirrored-database/[id]/lifecycle/route.ts` — `POST {action}`, stop/start/restart with `{before, after, adfLastRun}` receipt.
- **Engine:** `lib/azure/mirror-engine.ts` — `getMirrorStatus()` (Cosmos projection + ADLS probe + ADF telemetry), `restartMirrorSnapshot()` (watermark-clear re-snapshot).

## Backend / infra (already provisioned — no new bicep)

- ADF factory + `Data Factory Contributor` to the Console UAMI — `platform/fiab/bicep/modules/landing-zone/adf.bicep`; env `LOOM_ADF_NAME` / `LOOM_DLZ_RG` / `LOOM_SUBSCRIPTION_ID` wired in `admin-plane/main.bicep`.
- **Monitoring Reader** at subscription scope for ADF run telemetry — `platform/fiab/bicep/modules/admin-plane/monitoring-reader-rbac.bicep`.
- ADLS Bronze (`LOOM_BRONZE_URL`) — `platform/fiab/bicep/modules/landing-zone/storage.bicep`.
- Cosmos `items` container — already provisioned; routes read/write `item.state`.

No new Azure resource, env var, role assignment, or Cosmos container is introduced
by this feature.

## Per-cloud notes

ADF `queryPipelineRuns` and ADLS `listPaths` both route through the existing
`cloud-endpoints.ts` helpers (`armBase()` / `dfsSuffix()`), so Commercial, GCC,
GCC-High (`management.usgovcloudapi.net` / `dfs.core.usgovcloudapi.net`), and
DoD/IL5 are covered with no new sovereign-cloud literals. No Fabric dependency in
any cloud.

## Verification

- `tsc --noEmit` clean across the whole `fiab-console` project (0 errors).
- Unit test: `lib/azure/__tests__/mirror-engine-monitor.test.ts` covers the
  `getMirrorStatus()` projection (status mapping, defaults, ADF/ADLS honest-skip,
  derived pipeline name) and `restartMirrorSnapshot()` honest-gating. (The
  repo-wide vitest harness currently cannot run in an isolated worktree due to a
  pre-existing shared-store gap — `@adobe/css-tools` / `@azure/abort-controller`
  missing — which affects every test file identically, not this one.)
- Acceptance receipt (lifecycle route) carries `{before.mirroringStatus,
  after.mirroringStatus, adfLastRun}` for Stop/Start/Restart.
