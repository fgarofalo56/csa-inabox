<!-- parity-doc-meta
Reviewed-on: 2026-07-28
Validated-against:
  - apps/fiab-console/lib/finops/focus-mart.ts
  - apps/fiab-console/lib/finops/query-run.ts
  - apps/fiab-console/lib/azure/cost-attribution.ts
  - apps/fiab-console/app/api/admin/finops/focus/route.ts
  - apps/fiab-console/lib/components/finops/focus-cost-panel.tsx
-->

# finops-focus-cost — parity with the FinOps Open Cost and Usage Specification (FOCUS) 1.1 + Azure Cost Management

**B-N19e — cost-per-query / per-dashboard attribution.**

Source spec / UI:

- FOCUS 1.x specification — <https://focus.finops.org/focus-specification/>
- Microsoft's Cost-Management→FOCUS mapping —
  <https://learn.microsoft.com/cloud-computing/finops/focus/convert>
- FOCUS column notes (exclusive end dates, SubAccount = subscription, `x_`
  extension prefix) — <https://learn.microsoft.com/cloud-computing/finops/focus/what-is-focus>
- Azure portal: Cost Management → Cost analysis / Exports (Cost and usage
  details **(FOCUS)** dataset) —
  <https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-improved-exports>

**Azure-native default. No Fabric / Power BI dependency:** every priced engine
maps to an Azure ARM resource type (ADX, Synapse, Container Apps, AKS,
Databricks, Analysis Services). The Power BI DAX tile path is the opt-in
Fabric-family alternative and is deliberately NOT priced against a Loom Azure
resource type (its spend sits on the Power BI capacity) — stated in the route
and in the panel copy rather than silently attributed.

## Why this exists

Azure Cost Management stops at the RESOURCE. It can tell you the ADX cluster
cost $412 last month; it cannot tell you that one Sales dashboard drove 38% of
it. Fabric's Capacity Metrics app answers this only for Fabric capacity units;
Databricks answers it via system tables for its own SQL warehouses. Loom answers
it for EVERY engine it runs, and emits the answer in FOCUS column names so it
lands in whatever FinOps tool the customer already owns.

## FOCUS 1.1 column inventory → Loom coverage

| FOCUS 1.1 column | Loom coverage | Source |
|---|---|---|
| `BillingAccountId` / `BillingAccountName` | ✅ | `LOOM_BILLING_SCOPE` when set, else the Loom cost scope label |
| `BillingCurrency` | ✅ | Cost Management summary currency |
| `BillingPeriodStart` / `BillingPeriodEnd` (exclusive) | ✅ | the requested window |
| `ChargePeriodStart` / `ChargePeriodEnd` (exclusive) | ✅ | run start + measured wall-clock |
| `ChargeCategory` | ✅ `Usage` | every row is metered consumption |
| `ChargeClass` | ✅ `null` | Loom emits no corrections/restatements |
| `ChargeDescription` | ✅ | service + SKU meter + engine |
| `ChargeFrequency` | ✅ `Usage-Based` | |
| `BilledCost` / `EffectiveCost` | ✅ | LCU-weighted share of the engine resource type's REAL metered spend |
| `ListCost` / `ContractedCost` | ✅ (= EffectiveCost) | Loom has no per-run list/contracted price signal; never inflated above metered |
| `ProviderName` / `PublisherName` / `InvoiceIssuerName` | ✅ `Microsoft` | per Microsoft's own mapping |
| `ServiceName` / `ServiceCategory` / `ServiceSubcategory` | ✅ | `FOCUS_ENGINE_METERS` per engine |
| `ResourceId` / `ResourceName` / `ResourceType` | ✅ | run's target (ARM id → last segment, per Microsoft's ResourceName transform) |
| `RegionId` / `RegionName` | ⚠️ `null` | Cost Management's `byResourceType` rollup carries no region dimension; a per-run region would be invented. Emitted as null (spec-legal) rather than guessed. |
| `SubAccountId` / `SubAccountName` | ✅ | subscription parsed from the ARM resource id + the resolved display name |
| `SkuId` / `SkuPriceId` | ⚠️ `null` | not resolvable per-run from the resource-type rollup; null rather than fabricated |
| `SkuMeter` (1.1) | ✅ | per-engine billable meter label |
| `PricingCategory` | ✅ `Standard` | |
| `PricingQuantity` / `PricingUnit` | ✅ | `query-second` (or `query` for ADX) |
| `ConsumedQuantity` / `ConsumedUnit` | ✅ | same measured basis |
| `CommitmentDiscountId` | ✅ `null` | commitment attribution stays at the Cost Management layer |
| `Tags` | ✅ | `loom-domain` + `loom-workspace` (the same tags chargeback groups on) |
| `x_*` extension columns | ✅ | query id, statement hash, engine, item, item type, workspace, dashboard, tile, domain, user, LCU, duration, rows, cost source, LCU estimate, % of resource type |

Zero ❌. The two ⚠️ rows are honest nulls (spec-legal) where Loom has no real
signal — never a guessed value.

## Capability inventory → Loom coverage

| Capability (Cost Management / Fabric Capacity Metrics / Databricks system tables) | Loom coverage | Backend |
|---|---|---|
| Cost by resource | ✅ pre-existing | `cost-client.byResource` / `byResourceType` |
| Cost by department / domain tag | ✅ pre-existing | `/admin/chargeback` (`loom-domain` tag) |
| Cost by workspace | ✅ pre-existing (allocated, labeled) | `workspace-chargeback.ts` |
| **Cost per QUERY** | ✅ B-N19e | `/api/admin/finops/focus?groupBy=query` — grouped by statement fingerprint |
| **Cost per DASHBOARD** | ✅ B-N19e | `?groupBy=dashboard` — dashboard tile runs tagged at the tile-query edge |
| Cost per ITEM / USER / ENGINE | ✅ B-N19e | `?groupBy=item|user|engine` |
| Avg cost per run | ✅ | rollup `avgCostPerRun` |
| Compute time + rows per group | ✅ | measured wall-clock + row counts from the run |
| FOCUS-conformant export | ✅ | `?format=csv` → FOCUS 1.1 column header |
| Unattributed metered spend surfaced | ✅ | `unattributedCost` + a MessageBar naming each resource type |
| Honest gate without Cost Management | ✅ | `svc-cost-management` gate + inline **Fix it**; rows fall back to LCU-only with zero dollars |
| Kill-switch | ✅ | `n19e-focus-cost-attribution` runtime flag (default-ON, fail-open) |

## Instrumented execution edges (where runs are tagged)

| Edge | Engine | Metered ARM resource type |
|---|---|---|
| `POST /api/duckdb/query` (SQL Lab, JSON + Arrow) | `duckdb` / `synapse-serverless` (whichever answered) | `microsoft.app/containerapps` / `microsoft.synapse/workspaces` |
| `POST /api/sql/trino` | `trino` | `microsoft.containerservice/managedclusters` |
| `POST /api/warehouse/query` | `synapse-sql` | `microsoft.synapse/workspaces` |
| `POST /api/items/warehouse/[id]/query` | `synapse-sql` | `microsoft.synapse/workspaces` |
| `POST /api/items/synapse-serverless-sql-pool/[id]/query` | `synapse-serverless` | `microsoft.synapse/workspaces` |
| `POST /api/items/kql-database/[id]/query` | `adx` | `microsoft.kusto/clusters` |
| `POST /api/items/databricks-sql-warehouse/[id]/query` | `databricks-sql` | `microsoft.databricks/workspaces` |
| `POST /api/items/dashboard/[id]/tile-query` (ADX + AAS DAX) | `adx` / `aas-dax` | `microsoft.kusto/clusters` / `microsoft.analysisservices/servers` |

Every write is best-effort and can never fail a query.

## How a dollar figure is derived (the honesty contract)

1. Cost Management reports the REAL spend of, say, `microsoft.kusto/clusters`.
2. Every ADX run in the window carries recorded Loom Capacity Units (LCU).
3. Each run's cost = that real spend × (its LCU ÷ total LCU on that resource type).
4. The parts sum back to the metered whole — allocation never inflates
   (asserted in `lib/finops/__tests__/focus-mart.test.ts`).
5. If Cost Management is unreadable, or that resource type shows no spend, the
   row is `x_LoomCostSource:'unmetered'` with `BilledCost`/`EffectiveCost` = 0
   and only the transparent LCU estimate in `x_LoomEstimatedCost`. The UI shows
   "LCU only" and the honest gate. **Loom never presents an estimate as metered.**
6. Metered engine spend with no recorded runs goes to `unattributedCost` —
   surfaced, never spread across the runs that happen to exist.

## Privacy

The statement text is NEVER persisted. `statementFingerprint` strips comments,
string literals and numeric literals, normalizes whitespace/case, then SHA-256s
the result and keeps 16 hex chars. Two runs of the same query share a
fingerprint (so cost-per-query aggregates) while no literal — which could be a
customer identifier or a secret — reaches the ledger. Records inherit the
existing `cost-attribution` container's 90-day TTL.

## Storage

No new Cosmos container and no new env var: runs ride the existing
`cost-attribution` ledger (PK `/tenantId`, TTL 90d) and the mart is computed on
read, joined against the already-cached Cost Management summary
(`getLoomCostSummaryCached`, 20-min SWR). The FOCUS-conformant artifact is
materialized on demand as the CSV export rather than as a second persisted copy.

## Verification

- `lib/finops/__tests__/focus-mart.test.ts` — 23 fixture tests over the
  aggregation math, FOCUS column conformance, the honesty contract, the
  rollups, the CSV export, and statement fingerprinting.
- `app/api/warehouse/__tests__/query-route.test.ts` — asserts the run is tagged
  with the real caller + engine on the live query path.
- G1 browser receipt (`/admin/finops` + `/admin/chargeback` click-walk with a
  real query run) is required before this is graded A — pending the batch roll.
