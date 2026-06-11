# admin-capacity-scale — parity with Azure compute scale controls (ADX / Synapse / VMSS)

Source UI:
- Azure Data Explorer — Scale up (vertical SKU): https://learn.microsoft.com/azure/data-explorer/manage-cluster-vertical-scaling
- Synapse dedicated SQL pool — Pause/Resume: https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/pause-and-resume-compute-portal
- VM Scale Sets — change instance count: https://learn.microsoft.com/azure/virtual-machine-scale-sets/virtual-machine-scale-sets-scale-horizontal

This surface is the **Azure-native default** for Capacity & Compute scaling.
No Microsoft Fabric / Power BI dependency: the compute route deliberately omits
Fabric F-SKU; Fabric/PBI capacity scaling lives only on the separate
`/admin/scaling` grid and is never on this panel's default path.

## Azure feature inventory (per resource the panel manages)

| Resource | Azure portal capability | Loom control |
|---|---|---|
| ADX cluster | Change compute SKU (vertical scale) | SKU `<Select>` (`ADX_SKUS`) + Apply SKU → POST `{kind:'adx',action:'scale',sku}` |
| ADX cluster | Live SKU / capacity / state read | GET probe → `sku`, `capacity`, `state` badge |
| Synapse dedicated SQL pool | Pause compute | Pause button → POST `{kind:'synapse-pool',action:'pause'}` |
| Synapse dedicated SQL pool | Resume compute | Resume button → POST `{kind:'synapse-pool',action:'resume'}` |
| Synapse dedicated SQL pool | Live state read (Online/Paused/Pausing/Resuming/Scaling) | GET probe → state badge |
| Self-hosted IR VMSS | Set instance count (0..8, scale-to-zero) | Node-count `<Select>` (0,1,2,3,4,6,8) + Set nodes / Stop → POST `{kind:'shir-vmss',action:'scale',capacity}` |
| Purview SHIR VMSS (shared admin zone) | Set instance count | Node-count `<Select>` + Set nodes → POST `{kind:'purview-shir-vmss',action:'scale',capacity}` |

## Loom coverage

| Capability | Status | Backend per control |
|---|---|---|
| ADX SKU change | built ✅ | `updateKustoClusterSku()` → ARM PATCH `Microsoft.Kusto/clusters` |
| Synapse pause | built ✅ | `pausePool()` → ARM POST `sqlPools/{n}/pause` (api 2021-06-01) |
| Synapse resume | built ✅ | `resumePool()` → ARM POST `sqlPools/{n}/resume` |
| SHIR node count (0..8) | built ✅ | `scaleVmss(cfg, capacity)` → ARM PATCH VMSS `sku.capacity` (api 2024-07-01) |
| Purview SHIR node count | built ✅ | `scaleVmss(purviewShirVmssConfig(), capacity)` |
| Live state read (all) | built ✅ | GET best-effort probes; unconfigured resources omitted (honest) |
| Honest gate when nothing provisioned | built ⚠️ | MessageBar "No Azure-native scalable compute…" / "Console UAMI needs Contributor on the ADX / Synapse / VMSS" |

Zero ❌. The full panel renders even when no compute is provisioned (honest gate),
and with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset (Azure-native is the only path here).

## Per-cloud notes

- **Vertical vs horizontal (ADX):** SKU change is vertical (1–3 min switchover, query-perf impact); the panel models this with a busy state + 1.5s post-action state refresh. Instance count (horizontal, Optimized Autoscale min≥2) remains on the standalone `/api/admin/scaling/adx` route's `autoscale` action.
- **Azure Government:** `vmss-client` / `synapse-pool-arm` / `kusto-arm-client` route through `armBase()` / `armScope()` (gov-aware). ADX SKU availability differs by region/cloud; unavailable SKUs surface as verbatim ARM errors (honest), never a blank cell.
- **No free-text config:** SKU and node-count choices are enum `<Select>`s (`ADX_SKUS`, 0..8 nodes); VMSS capacity is clamped 0..8 server-side in `scaleVmss`.

## RBAC / env contract (already wired in bicep)

- Env: `LOOM_KUSTO_CLUSTER_NAME` / `LOOM_KUSTO_CLUSTER_URI`, `LOOM_SYNAPSE_WORKSPACE` + `LOOM_SYNAPSE_DEDICATED_POOL`, `LOOM_SHIR_VMSS_NAME`, `LOOM_PURVIEW_SHIR_VMSS_NAME` — emitted to the `loom-console` container app in `platform/fiab/bicep/modules/admin-plane/main.bicep`.
- RBAC: Console UAMI needs Azure Kusto Contributor (ADX), Synapse Administrator (pool pause/resume), Virtual Machine Contributor (VMSS).

## Verification

- `npx vitest run lib/azure/__tests__/scaling-routes.test.ts` — 33/33 (includes the new `/compute` GET + POST adx/synapse/shir/401/400 cases).
- `apps/fiab-console/e2e/admin-scaling.uat.ts` — `/admin/capacity` "Scale & manage" renders a control or honest gate; `/api/admin/scaling/compute` GET returns `ok:true`.
