# Scale-by-SKU admin page

> **Surface:** `/admin/scaling`
> **BFF:** `apps/fiab-console/app/api/admin/scaling/*/route.ts`
> **Bicep dependency:** every backing service module under `platform/fiab/bicep/modules/**`

The Scale-by-SKU admin page lets a Loom administrator change the
service tier of every backing Azure resource that powers CSA Loom —
without leaving the console and without opening the Azure portal.

Per [`.claude/rules/no-vaporware.md`](../../../.claude/rules/no-vaporware.md),
every dropdown on this page maps to a real Azure REST call. If a service
is not provisioned the card shows an honest `MessageBar` with the
precise env var + bicep module the admin needs to fix.

## Services covered

| Service | Scale axis | Backend |
|---|---|---|
| Power BI / Fabric Capacity | F-SKU (F2 → F2048) / P-SKU (P1/P2/P3) | ARM PATCH `Microsoft.Fabric/capacities/{n}` or `Microsoft.PowerBIDedicated/capacities/{n}` |
| Synapse Dedicated SQL Pool | DWU (DW100c → DW30000c) | ARM PATCH `bigDataPools/sqlPools/{n}` |
| ADX Cluster | vCore tier (Dev → E2/E4/E8/E16/E64) + capacity | ARM PATCH `Microsoft.Kusto/clusters/{n}` |
| Databricks SQL Warehouse | `cluster_size` (2X-Small → 4X-Large) | Databricks REST `POST /api/2.0/sql/warehouses/{id}/edit` |
| Databricks Cluster | `node_type_id` + `num_workers` + autoscale | Databricks REST `POST /api/2.0/clusters/edit` |
| AI Search | SKU + replica count + partition count | ARM PATCH `Microsoft.Search/searchServices/{n}` |
| APIM | SKU + capacity | ARM PATCH `Microsoft.ApiManagement/service/{n}` |
| Cosmos DB | RU/s per container OR autoscale max RU/s | `Container.readOffer` + `OfferDefinition.replace` (data plane) |
| Container Apps | Workload profile (Consumption / D-/E-series) + replicas | ARM PATCH `Microsoft.App/containerApps/{n}` |
| AI Foundry compute | `vmSize` + min/max nodes for AmlCompute targets | ARM PATCH `Microsoft.MachineLearningServices/workspaces/{n}/computes/{c}` |

## Authentication & RBAC

All cards run as the Console UAMI (`uami-loom-console-{region}`). The
UAMI needs:

* **Capacity Contributor** on each Fabric / Power BI Premium capacity
  (otherwise the GET returns 401/403 and the card shows the remediation
  text verbatim).
* **Synapse Administrator** on the Synapse workspace.
* **Azure Kusto Contributor** (or Contributor) on the ADX cluster.
* Databricks **Workspace Admin** entitlement (granted via SCIM bootstrap).
* **Search Service Contributor** on AI Search.
* **API Management Service Contributor** on APIM.
* **Cosmos DB Built-in Data Contributor** on the Cosmos account.
* **Container Apps Contributor** on the ACA RG.
* Contributor on the AI Foundry workspace.

## How the UI surfaces honest state

| Situation | What the card shows |
|---|---|
| Service provisioned + UAMI authorized | Current SKU + dropdown + cost preview + Apply button |
| Service not provisioned (env var missing) | `MessageBar intent="warning"` with the exact env var + bicep module path |
| UAMI not authorized | Verbatim 401/403 from the upstream API + hint with the role to grant |
| Async scale in progress | `provisioningState: Updating` returned to the UI |
| SKU transition blocked by Azure (e.g. Developer → Premium APIM) | Verbatim 400 from ARM surfaced in the card's error MessageBar |
| Cosmos serverless account | Card shows "Serverless — no RU/s dial (billed per request)" — no fake control |
| ComputeInstance scale change | Card shows 409 "delete + recreate to change vmSize" — no fake PATCH |

## Cost preview disclaimers

The cost-preview component (`lib/components/admin-scaling/cost-preview.tsx`)
uses a hardcoded lookup table of East US 2 list prices in USD. It
**excludes**:

* Reserved-instance and savings-plan discounts
* Regional differential (Gov pricing differs)
* SLA surcharges (Premium APIM, ADX Optimized AutoScale, etc.)
* Storage + bandwidth charges that go alongside compute

For exact billing, use the **Cost Management → Cost Analysis** blade
in the Azure portal. The admin page deliberately does **not** call the
Cost Management API today — that's tracked for v3.5.

## Utilization metrics deferred (honest gap)

The cards do not show current utilization (DBU, CPU, request rate, RU
consumption) because that requires Azure Monitor metrics integration —
a separate piece of work. Per the no-vaporware rule we surface this
gap in a `MessageBar` at the bottom of the page rather than show
AI-hallucinated numbers.

## Env vars consumed

| Env var | Used by | Default |
|---|---|---|
| `LOOM_SUBSCRIPTION_ID` | every card | — |
| `LOOM_DLZ_RG` | Synapse, Cosmos | — |
| `LOOM_ADMIN_RG` | APIM, AI Search, Foundry, Container Apps | `rg-csa-loom-admin-eastus2` |
| `LOOM_SYNAPSE_WORKSPACE` | Synapse DWU | — |
| `LOOM_KUSTO_CLUSTER_NAME` | ADX | — |
| `LOOM_DATABRICKS_HOSTNAME` | Databricks warehouse + cluster | — |
| `LOOM_AI_SEARCH_SERVICE` | AI Search | — |
| `LOOM_APIM_NAME` | APIM | `apim-csa-loom-eastus2` |
| `LOOM_COSMOS_ENDPOINT` | Cosmos | — |
| `LOOM_ACA_RG` | Container Apps | falls back to `LOOM_ADMIN_RG` |
| `LOOM_FOUNDRY_NAME` | AI Foundry compute | — |

## Async scale gotchas

Most scale operations are asynchronous:

* **Fabric capacity SKU change** — 30-90s for propagation; the workspace
  remains usable throughout but new artifact creation may briefly fail
  with "capacity is provisioning".
* **Synapse DWU change** — pool transitions to `Scaling`, then back to
  `Online` after ~2-5 minutes. The pool is paused-effectively during
  the transition.
* **ADX SKU change** — instances are added/removed in the background;
  the cluster remains queryable but ingestion may briefly stutter.
* **APIM SKU change** — Premium → Standard transition can take 15-45 min;
  the gateway stays up.
* **Container Apps profile change** — triggers a new revision deploy; the
  ingress stays up if `revisionsMode: multiple`.

The UI surfaces `provisioningState: Updating` so the admin knows it's
in flight; they need to refresh the card after a few minutes to see the
final state.

## Bicep sync requirement

Per the no-vaporware rule, every scale axis must be provisioned by
bicep before it can be exercised:

| Service | Bicep module |
|---|---|
| Fabric capacity | `platform/fiab/bicep/modules/fabric/capacity.bicep` |
| Synapse pools | `platform/fiab/bicep/modules/data-platform/synapse.bicep` |
| ADX | `platform/fiab/bicep/modules/real-time-intelligence/adx.bicep` |
| Databricks | `platform/fiab/bicep/modules/data-platform/databricks.bicep` |
| AI Search | `platform/fiab/bicep/modules/ai/ai-search.bicep` |
| APIM | `platform/fiab/bicep/modules/integration/apim.bicep` |
| Cosmos | `platform/fiab/bicep/modules/data-platform/cosmos.bicep` |
| Container Apps | `platform/fiab/bicep/modules/compute/container-apps.bicep` |
| AI Foundry | `platform/fiab/bicep/modules/ai/foundry.bicep` |

If a customer's deployment skipped a module, the scale card surfaces an
explicit MessageBar that points at the missing bicep — never a fake
"working" dropdown.

## Testing

* **Unit (Vitest):** `apps/fiab-console/lib/azure/__tests__/scaling-clients.test.ts`
  covers every new client method, and `scaling-routes.test.ts` covers the
  10 BFF routes (auth, validation, happy path).
* **E2E (Playwright UAT):** `apps/fiab-console/e2e/admin-scaling.uat.ts`
  walks `/admin/scaling`, asserts all 10 cards render, and verifies each
  BFF GET returns either `ok=true` or a `503 + hint` (no opaque 5xx).

Run locally:

```bash
cd apps/fiab-console
pnpm exec vitest run lib/azure/__tests__/scaling-clients.test.ts lib/azure/__tests__/scaling-routes.test.ts
SESSION_SECRET=<from-KV> pnpm exec playwright test e2e/admin-scaling.uat.ts --project=uat
```
