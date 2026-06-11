# admin-scaling — parity with Azure "scale" surfaces (per-service SKU resize)

Source UI: the Azure portal **Scale** / **Scale up** / **Scale out** blades for
each backing service Loom orchestrates, plus the Databricks workspace SQL
warehouse / cluster edit dialogs and the Azure ML compute scale page:

- Fabric capacity resize — <https://learn.microsoft.com/fabric/enterprise/scale-capacity>, <https://learn.microsoft.com/fabric/enterprise/fabric-features>
- Synapse dedicated SQL pool scale — <https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/quickstart-scale-compute-portal>
- Azure Data Explorer scale up/out — <https://learn.microsoft.com/azure/data-explorer/manage-cluster-vertical-scaling>
- Databricks SQL warehouse / cluster sizing — <https://learn.microsoft.com/azure/databricks/sql/admin/sql-endpoints>, <https://learn.microsoft.com/azure/databricks/compute/configure>
- Azure AI Search scale (replicas/partitions/tier) — <https://learn.microsoft.com/azure/search/search-capacity-planning>
- API Management scale (units / tier) — <https://learn.microsoft.com/azure/api-management/upgrade-and-scale>
- Cosmos DB throughput (manual RU/s / autoscale) — <https://learn.microsoft.com/azure/cosmos-db/set-throughput>
- Container Apps workload profiles + scale rules — <https://learn.microsoft.com/azure/container-apps/scale-app>
- Azure ML compute (AmlCompute) sizing — <https://learn.microsoft.com/azure/machine-learning/how-to-create-attach-compute-cluster>

CSA Loom surface: `/admin/scaling` (page `app/admin/scaling/page.tsx`), BFF
routes `app/api/admin/scaling/{capacity,synapse-dwu,adx,databricks-warehouse,databricks-cluster,ai-search,apim,cosmos,container-apps,foundry-compute}/route.ts`
and `app/api/admin/mcp-servers/deploy/route.ts`. Shared UI primitives:
`ServiceCard`, `ScalePicker`, `CostPreview`, `LoomDataTable`.

## Azure feature inventory

The Azure "scale" experience for a backing service is a focused blade: pick a
target tier/size (and any unit/replica counts), see an estimated cost delta,
hit Apply (an ARM PATCH / data-plane edit), and observe the in-flight state.
Per service:

| # | Capability (Azure portal scale blade) |
|---|----------------------------------------|
| 1 | Read current SKU / tier / size + provisioning state |
| 2 | Choose a **target** SKU/tier from the service's enumerated set |
| 3 | Choose count dials where applicable (DWU, replicas, partitions, RU/s, workers, min/max replicas/nodes, APIM capacity) |
| 4 | Cost estimate / cost delta for the target |
| 5 | Apply → real ARM PATCH or data-plane edit; async services show "in progress" |
| 6 | Honest unavailable state (service not provisioned / not visible to identity / region-unsupported) |
| 7 | Multiple resources of the same kind in one view (many capacities, pools, warehouses, clusters, containers, apps, computes) |
| 8 | Non-resizable variants surfaced honestly (Cosmos serverless, non-AmlCompute) |

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Current SKU/tier/state | ✅ | Each card reads live state via the GET route; multi-resource cards show it in the `LoomDataTable` "resource" cell, single-resource cards in `ServiceCard.currentLabel`. |
| 2 | Target SKU picker | ✅ | `ScalePicker` (Fluent `Dropdown`) fed by enumerated constants (`FABRIC_SKUS`/`POWERBI_SKUS`/`DWU_SKUS`/`ADX_SKUS`/`WAREHOUSE_SIZES`/`SEARCH_SKUS`/`APIM_SKUS`/`ACA_PROFILES`) — typed picker, no free-form SKU text. |
| 3 | Count dials | ✅ | Numeric `Input`s for DWU implied by SKU, AI Search replicas/partitions, APIM capacity, Cosmos manual RU/s + autoscale max, Databricks num_workers, ACA min/max replicas, AML min/max nodes. |
| 4 | Cost estimate / delta | ✅ | `CostPreview` (list-price lookup) for fabric-capacity, synapse-dwu, adx, databricks-warehouse, ai-search, apim. Disclaimer banner: estimates exclude RI/region/SLA. |
| 5 | Apply (real backend) | ✅ | Every Apply is a Fluent **primary `Button`** that POSTs to the matching `/api/admin/scaling/*` route (real ARM PATCH / Databricks data-plane / Cosmos throughput / ACA update / AML PATCH). Async services note "Scaling to …". |
| 6 | Honest unavailable state | ⚠️ | When a GET returns `!ok` the card renders a Fluent `MessageBar intent="warning"` (via `ServiceCard.gateMessage`) carrying the route's `error` + `hint` (env var / role / resource to provision). Full card chrome still renders. |
| 7 | Multiple resources per view | ✅ | Capacity / DWU / warehouse / cluster / Cosmos / Container Apps / AML compute each render their list in a shared `LoomDataTable` (sortable resource column, sticky header, generous padding, empty-state). |
| 8 | Non-resizable variants | ✅ | Cosmos **serverless** containers render an italic "no RU/s dial" note + `—` apply cell; non-`AmlCompute` computes render the "cannot be PATCHed — delete + recreate" note + `—` apply cell. |

Power BI **P-SKU** caveat (honest disclosure): the capacity card offers a P1/P2/P3
target for Power-BI-Premium capacities, but per
<https://learn.microsoft.com/fabric/enterprise/fabric-features> on-demand
resizing and ARM resize APIs are **F-SKU only** — P-SKUs are managed through the
Power BI admin / M365 licensing path. The POST still attempts the ARM update and
surfaces the backend's error verbatim if the platform rejects it (no fake
success). F-SKU Fabric capacities resize on-demand via ARM as the documented,
supported path.

Zero ❌, zero stub banners. Every Apply has a real handler; the only
non-functional states are the documented honest infra-gates (#6) and the
honestly-disabled non-resizable variants (#8).

## Backend per control

| Control | Backend |
|---------|---------|
| Fabric / Power BI capacity resize | `POST /api/admin/scaling/capacity` → ARM `Microsoft.Fabric/capacities` PATCH (F-SKU on-demand resize); Console UAMI needs `Microsoft.Fabric/capacities/write` |
| Synapse DWU | `POST /api/admin/scaling/synapse-dwu` → ARM PATCH `…/sqlPools/{n}` |
| ADX tier | `POST /api/admin/scaling/adx` → ARM PATCH `Microsoft.Kusto/clusters` SKU |
| Databricks SQL warehouse | `POST /api/admin/scaling/databricks-warehouse` → data-plane `/api/2.0/sql/warehouses/{id}/edit` |
| Databricks cluster | `POST /api/admin/scaling/databricks-cluster` → data-plane `/api/2.0/clusters/edit` |
| AI Search | `POST /api/admin/scaling/ai-search` → ARM PATCH `Microsoft.Search/searchServices` (sku/replicaCount/partitionCount) |
| APIM | `POST /api/admin/scaling/apim` → ARM PATCH `Microsoft.ApiManagement/service` (sku.name/capacity) |
| Cosmos throughput | `POST /api/admin/scaling/cosmos` → ARM throughput settings (manual RU/s or autoscale maxThroughput) |
| Container Apps | `POST /api/admin/scaling/container-apps` → ARM PATCH `Microsoft.App/containerApps` (workloadProfileName + min/maxReplicas) |
| AI Foundry / AML compute | `POST /api/admin/scaling/foundry-compute` → ARM PATCH `Microsoft.MachineLearningServices/workspaces/computes` (AmlCompute scaleSettings) |
| MCP persistence mount | `POST /api/admin/mcp-servers/deploy` → ARM Container Apps revision with an Azure Files volume mount |

All GETs read live state from the same ARM / data-plane APIs (no mock arrays;
per `no-vaporware.md`).

## No-Fabric-dependency

This page scales **Azure-native backings** (Synapse, ADX, Databricks, AI Search,
APIM, Cosmos, Container Apps, Azure ML) — none of which require a Fabric tenant.
The Fabric capacity card is the one Fabric-flavored surface, and a missing /
unavailable Fabric capacity is a non-blocking honest gate (e.g. Azure Government,
where `Microsoft.Fabric/capacities` is unavailable): the GET returns `!ok` and
the card shows a warning MessageBar while every other card stays fully
functional. No call to `api.fabric.microsoft.com` / `api.powerbi.com` is made on
the default load path, and the page works fully with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Bicep sync

UI-only refactor — no new Azure resource, env var, role, or Cosmos container, so
no bicep change is required. The scale targets map to existing modules:
`platform/fiab/bicep/modules/admin-plane/{apim.bicep,adx-cluster.bicep,ai-search.bicep,ai-foundry.bicep}`
and `platform/fiab/bicep/modules/landing-zone/{synapse.bicep,adx.bicep,databricks.bicep,cosmos.bicep}`.

## Verification

`npx tsc --noEmit` clean for this file. Each Apply POSTs to a real
`/api/admin/scaling/*` route (covered by the scaling-route tests); GETs return
live ARM/data-plane state or an honest `!ok` gate. UI: presentation-only change
— Fluent `ServiceCard` + `LoomDataTable` + primary `Button`s, zero raw `<button>`
styling and zero inline `style={{…}}` literals on the page.
