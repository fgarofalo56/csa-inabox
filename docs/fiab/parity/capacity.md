# capacity — parity with Fabric Capacity settings + Azure resource scale

Source UI: Fabric Admin → **Capacity settings**; Azure portal resource SKU blades
Reference: <https://learn.microsoft.com/fabric/admin/capacity-settings-overview>
Run date: 2026-06-09

Loom surfaces:

- Resource inventory: `/admin/capacity` → `app/admin/capacity/page.tsx`
- Inventory BFF: `app/api/admin/azure-resources/route.ts`
- Scale-by-SKU: `/admin/scaling` → `app/admin/scaling/page.tsx`
- Scale BFF (11 sub-routes): `app/api/admin/scaling/{adx,ai-search,apim,capacity,compute,container-apps,cosmos,databricks-cluster,databricks-warehouse,foundry-compute,synapse-dwu}/route.ts`
- Components: `lib/components/admin-scaling/{scale-picker,service-card,cost-preview}.tsx`

The Fabric F-SKU "capacity" concept maps **Azure-native** to the real Azure
compute resources that back each Loom item: ADX clusters, Synapse SQL pools,
Container Apps, Databricks, AI Search, APIM, Cosmos, AML compute. There is **no
dependency on real Microsoft Fabric** — the inventory and scale operations are
ARM calls against the deployment's own resources and work with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. List capacities / backing compute (name, SKU, region, state)
2. View capacity utilization + cost
3. Scale a capacity up/down (change SKU)
4. Pause / resume capacity
5. Deep-link to the Azure portal resource blade
6. Cost preview before applying a scale change

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Live ARM resource inventory (type, name, SKU, location, provisioning state) | ✅ Built | `GET /api/admin/azure-resources` → ARM `GET …/resources?api-version=2024-03-01` via `ChainedTokenCredential` UAMI |
| Provider grouping + filter dropdown | ✅ Built | Client group by `type.split('/')[0]` |
| Azure portal deep-link per resource | ✅ Built | `https://portal.azure.com/#@/resource${id}/overview` |
| 503 gate when `LOOM_SUBSCRIPTION_ID` unset | ✅ Built | Route returns `ok:false, hint:'Set LOOM_SUBSCRIPTION_ID'` |
| Cost + utilization | ⚠️ Honest gate | MessageBar names Cost Management + Azure Monitor wiring required; inventory still renders |
| Scale ADX cluster SKU | ✅ Built | `POST /api/admin/scaling/adx` → ARM PATCH `Microsoft.Kusto/clusters` (`getKustoClusterArm` / `updateKustoClusterSku`) |
| Scale Synapse DWU (DW100c–DW30000c) | ✅ Built | `POST /api/admin/scaling/synapse-dwu` → ARM PATCH `Microsoft.Synapse/workspaces/sqlPools` |
| Scale Container Apps (workload profile / replicas) | ✅ Built | `POST /api/admin/scaling/container-apps` → ARM PATCH `Microsoft.App/containerApps` (`updateContainerAppScale`) |
| Scale Databricks cluster | ✅ Built | `POST /api/admin/scaling/databricks-cluster` |
| Scale Databricks SQL Warehouse | ✅ Built | `POST /api/admin/scaling/databricks-warehouse` |
| Scale AI Search SKU | ✅ Built | `POST /api/admin/scaling/ai-search` |
| Scale APIM SKU | ✅ Built | `POST /api/admin/scaling/apim` |
| Scale Cosmos throughput / serverless | ✅ Built | `POST /api/admin/scaling/cosmos` |
| Scale AML Foundry compute | ✅ Built | `POST /api/admin/scaling/foundry-compute` |
| Generic compute / capacity scale | ✅ Built | `POST /api/admin/scaling/{compute,capacity}` |
| Cost preview before apply | ✅ Built | `CostPreview` — estimated delta from the current SKU |

Zero ❌ rows. The single ⚠️ gate (cost/utilization) keeps the inventory and
every scale control fully functional; only the cost overlay is gated, per
`no-vaporware.md`.

## Backend per control

- **Inventory** — `azure-resources/route.ts` calls ARM resource list with the
  console UAMI (`ChainedTokenCredential`), filtered to the deployment's
  resource groups; 503-style JSON when `LOOM_SUBSCRIPTION_ID` is unset.
- **Scale** — each `scaling/*` route reads the target resource via ARM GET,
  applies a PATCH with the new SKU/throughput/replica shape, and returns the new
  provisioning state. `ScalePicker` enumerates allowed SKUs per service;
  `ServiceCard` shows current state; `CostPreview` computes the estimated cost
  delta before the operator clicks apply.
- **Cost overlay** — gated: requires a Cost Management query role + Azure Monitor
  metrics; the MessageBar names the exact wiring.

## Per-cloud notes

| Cloud | Scale surface |
|---|---|
| Commercial | All 11 scale routes; Container Apps + Databricks Unity Catalog enabled |
| GCC | Same as Commercial |
| GCC-High | AKS path (`containerPlatform=aks`); Databricks SQL Warehouse + UC disabled — those scale cards honest-gate |
| IL5 | Same as GCC-High; ARM endpoint resolves to `management.usgovcloudapi.net` via `cloud-endpoints.ts` |

## Bicep sync

- No new resource: the inventory and scale routes operate on resources the
  platform bicep already deploys (`landing-zone` + `admin-plane` modules).
- Env vars `LOOM_SUBSCRIPTION_ID` (+ per-service resource ids) are already in the
  `apps[]` env list in `admin-plane/main.bicep`.
- The console UAMI needs **Contributor** (or the per-service scale role) on the
  target resource groups — already granted in the landing-zone RBAC module for
  the Scale-by-SKU feature.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — ARM only, no
  Fabric host.
- Live walk: open `/admin/capacity`, confirm the live ARM inventory lists real
  resources with SKU + state and portal deep-links; open `/admin/scaling`, pick
  a new SKU on the ADX or Synapse-DWU card, confirm `CostPreview` shows the delta,
  apply, and confirm the ARM PATCH returns the new provisioning state.

Grade: **A** — live ARM inventory + 11 real scale routes; only the cost overlay
is honest-gated.
