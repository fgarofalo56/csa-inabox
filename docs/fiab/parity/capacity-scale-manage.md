# capacity-scale-manage — parity with Azure portal "Scale" / "Size" blades

Source UI: Azure portal scale blades per service — ADX cluster *Scale up/out*
(`Microsoft.Kusto/clusters` → Settings → Scale up), Synapse dedicated SQL pool
*Scale* (`…/sqlPools` → Scale / Pause / Resume), Databricks *Edit* (compute +
SQL warehouse), VMSS *Scaling*, Container Apps *Scale and replicas*, AKS
*Node pools* (`managedClusters/agentPools`), AI Search *Scale*, API Management
*Scale*, Cosmos DB *Scale (RU/s)*. Grounded in Microsoft Learn ARM references for
each provider.

Surface: `apps/fiab-console/app/admin/capacity` → click any inventory row →
`ScaleManageDrawer` (`apps/fiab-console/lib/panes/scale-manage.tsx`).

## Azure feature inventory → Loom coverage → backend per control

| Azure service (portal blade) | Capability | Loom coverage | Backend (real REST) |
|---|---|---|---|
| ADX cluster (Scale up) | Change cluster SKU | ✅ SKU dropdown | `POST /api/admin/scaling/adx` → `kusto-arm-client.updateKustoClusterSku` (ARM PATCH `Microsoft.Kusto/clusters`) |
| ADX cluster (Scale out) | Instance count | ✅ Capacity SpinButton | same PATCH, `sku.capacity` |
| ADX cluster | Live state | ✅ Badge + 2s poll | `GET /api/admin/scaling/adx` → `cluster.state` |
| Synapse dedicated pool | Change DWU | ✅ Pool + DWU dropdown | `POST /api/admin/scaling/synapse-dwu` (ARM PATCH `…/sqlPools`) |
| Synapse dedicated pool | Pause / Resume | ✅ buttons | `POST /api/admin/scaling/compute {kind:'synapse-pool'}` → `synapse-pool-arm.pausePool/resumePool` |
| Synapse dedicated pool | Live status | ✅ Badge + poll | `GET /api/admin/scaling/synapse-dwu` → `pools[].status` |
| Databricks compute | Resize cluster (node type + workers) | ✅ select + SpinButton | `POST /api/admin/scaling/databricks-cluster` → `databricks-client.editCluster` (REST `/clusters/edit`) |
| Databricks SQL warehouse | Resize (cluster size) | ✅ select + dropdown | `POST /api/admin/scaling/databricks-warehouse` → `editWarehouse` (REST `/sql/warehouses/{id}/edit`) |
| VMSS (self-hosted IR) | Scale 0↔N | ✅ Start (4) / Stop (0) | `POST /api/admin/scaling/compute {kind:'shir-vmss'}` → `vmss-client.scaleVmss` (ARM PATCH `sku.capacity`) |
| Container Apps | Min / max replicas | ✅ SpinButtons | `POST /api/admin/scaling/container-apps` → `container-apps-arm-client.updateContainerAppScale` |
| AKS node pool | Node count (autoscaler off) | ✅ pool select + count SpinButton | `POST /api/admin/scaling/aks` → `aks-arm-client.scaleAksAgentPool` (ARM PUT `…/agentPools/{name}`) |
| AI Search | Replicas / partitions | ✅ SpinButtons | `POST /api/admin/scaling/ai-search` → `aisearch-client.updateSearchService` |
| API Management | SKU + units | ✅ dropdown + SpinButton | `POST /api/admin/scaling/apim` → `apim-client.updateApimSku` |
| Cosmos DB | Container RU/s | ✅ container select + RU SpinButton | `POST /api/admin/scaling/cosmos` → `cosmos-client.updateContainerThroughput` |
| All | Confirm-before-mutate | ✅ `ConfirmScaleDialog` gates every POST | — |
| All | Live provisioning-state poll | ✅ `usePoll` 2s until Succeeded/Online/Running (≤90s) | the GET route for each type |
| Unsupported types | Honest message + Azure portal deep-link | ⚠️ MessageBar | row's `Azure portal` link |

Zero ❌ rows: every Azure scale capability the inventory can surface has a wired
control. Sub-resource scaling (Synapse pools, Databricks compute) is fetched via
its data/management-plane route because ARM RG enumeration only lists the parent
(workspace) resource.

## Honest-gate behavior (no-vaporware)

Each section renders a Fluent `MessageBar intent="warning"` — never a blank pane
or fake data — when the GET/POST route returns 403/503:

- **ADX SKU PATCH** needs **Azure Kusto Contributor** (`833127c3-…`) on the
  cluster — granted in `adx-cluster.bicep` (`consoleKustoContributor`). Monitoring
  Contributor alone returns 403; the drawer shows the gate.
- **AKS** needs **AKS Cluster Admin** (`0ab0b1a8-…`) on the cluster — granted in
  `container-platform.bicep` (`consoleAksAdmin`, AKS path only). On Commercial /
  GCC `LOOM_AKS_CLUSTER_NAME` is unset (those run Container Apps) so the AKS
  section honest-gates with a 503.
- Synapse / VMSS / Container Apps / AI Search / APIM / Cosmos reuse the existing
  Contributor / VM Contributor grants from their bicep modules.

## Per-cloud

| Concern | Commercial | GCC | GCC-High / IL5 |
|---|---|---|---|
| ARM host | management.azure.com | management.azure.com | management.usgovcloudapi.net (via `armBase()`) |
| Container platform | Container Apps | Container Apps | AKS |
| AKS scaling | 503 gate | 503 gate | live |
| ACA scaling | live | live | 503 gate |

All clients use `armBase()` / `armScope()` from `cloud-endpoints.ts`, so the UI
carries no per-cloud branching — a 503 simply renders the gate MessageBar.

## Verification

- Unit: `lib/azure/__tests__/scaling-clients.test.ts` — `aks-arm-client` PUT body
  (count + `enableAutoScaling:false`, immutable fields preserved, not-configured
  + range guards), plus the existing ADX/Synapse/Databricks/APIM/AI-Search cases.
- Live (operator): scale a real ADX cluster / pause a real Synapse pool and watch
  the provisioning-state Badge update on poll; confirm a UAMI without the role
  surfaces the gate MessageBar rather than erroring.
