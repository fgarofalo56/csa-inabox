# eventhouse-capacity — parity with Azure Data Explorer cluster Capacity / throttling

Source UI: Azure portal → Azure Data Explorer cluster → **Settings → Capacity** + the
cluster **Metrics** blade (throttle counters). Fabric equivalent: Eventhouse →
**Manage → Capacity / consumption** (F/P-capacity billing).
Grounded in Microsoft Learn:
- Capacity policy object: https://learn.microsoft.com/kusto/management/capacity-policy
- `.show cluster policy capacity`: https://learn.microsoft.com/kusto/management/show-cluster-capacity-policy-command
- `.show capacity`: https://learn.microsoft.com/kusto/management/show-capacity-command
- `.alter-merge cluster policy capacity`: https://learn.microsoft.com/kusto/management/alter-merge-capacity-policy-command
- ADX supported metrics (throttle counters): https://learn.microsoft.com/azure/data-explorer/using-metrics

Azure-native default: the shared **Azure Data Explorer cluster IS the eventhouse
capacity backend** — no Microsoft Fabric / OneLake / Power BI dependency. Works
with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET (per `.claude/rules/no-fabric-dependency.md`).

## Azure/ADX feature inventory

| # | Capability (real ADX/Fabric UI) | Backend |
|---|---------------------------------|---------|
| 1 | Throttle state (is the cluster currently throttling ingestions/exports?) | `.show capacity` remaining==0 + Monitor `TotalNumberOfThrottledQueries/Commands` |
| 2 | Live capacity slots per operation type (ingestions, extents-merge, data-export, extents-partition, materialized-view, stored-query-results) — Total / Consumed / Remaining / Origin | `.show capacity` |
| 3 | Live utilization gauges: ingestion utilization %, cache utilization %, CPU %, concurrent queries | Azure Monitor metrics |
| 4 | View ingestion capacity policy (ClusterMaximumConcurrentOperations, CoreUtilizationCoefficient) | `.show cluster policy capacity` |
| 5 | Edit ingestion capacity policy | `.alter-merge cluster policy capacity` |
| 6 | View export capacity policy | `.show cluster policy capacity` |
| 7 | Per-database CU% usage | Fabric F/P capacity only — N/A on ADX |
| 8 | Mission-critical exempt toggle | Fabric workspace F/P capacity setting — N/A on ADX |

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Throttle state badge | ✅ built | `Healthy` / `Throttled` derived from live slots + throttle metrics |
| 2 | Capacity slots table w/ per-row utilization bars | ✅ built | `.show capacity` |
| 3 | Live gauge cards (ingestion/cache/CPU/concurrent/throttled queries+commands) | ✅ built / ⚠️ infra-gate | Azure Monitor; `metricsGate` MessageBar names `LOOM_ARM_ENDPOINT` (sovereign) / Monitoring Reader role when ARM unreachable. Kusto data still renders. |
| 4 | Ingestion capacity policy display | ✅ built | `.show cluster policy capacity` |
| 5 | Edit + apply ingestion capacity policy | ✅ built | guided number Fields → `.alter-merge cluster policy capacity` (allow-listed components, numeric-validated) |
| 6 | Export capacity display | ✅ built | read-only |
| 7 | Per-database CU% | ⚠️ honest-gate | `intent="info"` MessageBar: Fabric F/P-only concept; ADX pools capacity at cluster scope |
| 8 | Mission-critical exempt | ⚠️ honest-gate | disabled Switch + `intent="warning"` MessageBar: Fabric workspace F/P setting, no ADX equivalent |

Zero ❌, zero stub banners.

## Backend per control

- GET `/api/items/eventhouse/[id]/capacity` → `showClusterCapacityPolicy()` (`.show cluster policy capacity`), `showCapacitySlots()` (`.show capacity`), `fetchMetrics()` (Azure Monitor, grouped by aggregation).
- POST `/api/items/eventhouse/[id]/capacity` → `alterMergeCapacityPolicy(patch)` (`.alter-merge cluster policy capacity ```{...}```), components allow-listed to IngestionCapacity / ExportCapacity / ExtentsMergeCapacity / ExtentsPartitionCapacity / MaterializedViewsCapacity.

## Verification

With `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET, against `adx-csa-loom-shared`:
1. Open Eventhouse editor → **Capacity** tab → capacity policy + live slot rows render from the real cluster.
2. Throttle gauges show real Azure Monitor values (0 at rest is real, not mocked).
3. Edit `ClusterMaximumConcurrentOperations` → **Apply ingestion policy** → green receipt MessageBar with the executed `.alter-merge` command + new effective policy; re-load reflects the new value.
