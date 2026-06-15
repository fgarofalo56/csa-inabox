# deploy-planner-cost-estimate — parity with the Azure Pricing Calculator / cost estimation

**Surface:** Deployment planner → **Estimate cost** (button + report dialog) in
`apps/fiab-console/lib/components/deploy-planner/deploy-planner-view.tsx`.
**Route:** `app/api/admin/deploy-plan/cost-estimate/route.ts`.
**Source UI:** Azure Pricing Calculator (<https://azure.microsoft.com/pricing/calculator/>)
and the public Azure Retail Prices API
(<https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices>).

The deployment planner already lets an operator lay out subscriptions → domains →
Azure services and export a `.bicepparam`. **Estimate cost** adds a forward-looking
monthly cost figure for the planned graph — the one verb the planner was missing —
computed from real public retail prices, with an honest in-app breakdown and an
export + deep-link to the calculator.

## Azure feature inventory (cost estimation)

| Capability (Azure Pricing Calculator / retail-prices) | Notes |
|---|---|
| Pick services + regions, get a per-resource monthly estimate | calculator core |
| Aggregate to a grand total | calculator core |
| Per-region pricing (`armRegionName`) | retail-prices filter |
| List price for a chosen SKU/meter | retail-prices `retailPrice` |
| Currency (billing currency) | retail-prices `currencyCode` (USD) |
| Export / share the estimate | calculator "Export" (xlsx) / save |
| Deep-link into the calculator | calculator URL |
| Per-service pricing details pages | azure.microsoft.com/pricing/details/<svc> |

## Loom coverage

| Capability | State | Backend per control |
|---|---|---|
| Per-resource monthly estimate from the planned graph | built ✅ | `POST /api/admin/deploy-plan/cost-estimate` → `prices.azure.com/api/retail/prices` (real, no auth) per `service-catalog.retail` meter |
| Per-domain subtotal + grand total | built ✅ | pure `summarizePlan()` over the priced rows |
| Region-correct pricing | built ✅ | region from the **report's region picker** (`cost-options.COMMERCIAL_REGIONS`), else `subscription.region` / `BOUNDARY_DEFAULT_REGION`; `armRegionName` filter |
| List price + unit-of-measure shown per row, monthly-normalized | built ✅ | `normalizeToMonthly()` (Hour×730, /Month passthrough, /Day×30) |
| Currency | built ✅ | **report currency picker** (`cost-options.RETAIL_CURRENCIES`) → `currencyCode='XXX'` query param; default USD |
| Export the breakdown (CSV + JSON download) | built ✅ | `breakdownToCsv/Json` + `downloadText` (client Blob) |
| Open Azure Pricing Calculator (deep-link) | built ✅ (honest) | `pricingCalculatorUrl()` — opens the tool; does NOT auto-fill (no public pre-populate API) |
| Per-service pricing-details link per row | built ✅ | `ServiceDef.pricingDetailsUrl` |
| Services that cannot be flat-priced shown as "not estimated" + reason | built ✅ (honest) | `summarizePlan()` unestimated list (plan-only / core / usage-metered) |
| Azure Government pricing | honest-gate ⚠️ | retail-prices has no public Gov endpoint → GCC-High/IL5 priced against a Commercial reference region + `govDisclaimer` MessageBar |
| Live-API-down resilience | built ✅ (honest) | per-meter fallback to `FALLBACK_MONTHLY_USD` (same Azure list prices as admin-scaling CostPreview), labelled `fallback-list-price` |

Zero ❌, zero stub banners. The only non-functional state is the honest Gov
disclaimer (an inherent Azure limitation, not a Loom gap) and the explicit
"the calculator deep-link does not auto-fill" note.

## Per-cloud matrix

| Boundary | Retail-prices availability | Loom behavior |
|---|---|---|
| Commercial | Live (`prices.azure.com`, region = planned region) | Live per-resource estimate |
| GCC | Runs on Commercial Azure | Live, priced as Commercial |
| GCC-High / IL5 (DoD) | **No public Gov retail-prices endpoint** | Directional: priced against a Commercial reference region (user-selectable in the region picker; default `eastus2`) + `govDisclaimer` warning MessageBar naming the exact `priceRegion` used ("Gov pricing differs — use the Gov pricing pages / EA price sheet") |
| China (21Vianet) | Separate endpoint (`prices.azure.cn`, CSV model) | Not wired (out of scope); falls through to the Gov-style honest disclaimer if a China boundary is added |

## Representative meters (validated live against `prices.azure.com`, eastus2, 2026-06)

`appService` B1 ($12/mo) · `vm` D2s_v5 Linux ($70) · `redis` C0 ($16) ·
`postgres`/`mysql` B1ms ($12) · `sql` S0 ($11) · `aiSearch` Standard S1 ($245) ·
`apim` Developer ($48) · `adx` Standard engine markup ($80, markup only) ·
`appGateway` Standard_v2 fixed ($146) · `vpnGateway` VpnGw1 ($139) ·
`firewall` Standard deployment ($913). Each row carries an `unitNote` disclosing
the representative SKU + what is excluded.

Plan-only / tenant-gated services (`fabricCapacity`, `sqlMi`, `privateEndpoints`,
…) and abstract core services (`vnet`, `managedIdentity`, …) are reported as
**not estimated** with an honest reason — never a fabricated number.

## Honesty caveats (surfaced in the dialog)

- Best-effort **list price** for a single **representative SKU** — not an exact bill.
- Excludes reserved-instance / savings-plan discounts, regional differential,
  egress, storage, and SLA surcharges (wording reused from admin-scaling CostPreview).
- The Azure Pricing Calculator deep-link **opens the tool; it does not auto-fill**
  (no public pre-populate API) — the CSV/JSON export is the machine-readable artifact.

## Bicep sync

No new Azure resource / role / Cosmos container — the route only calls an
unauthenticated public endpoint. The prices host is overridable for
sovereign / air-gapped mirrors via `LOOM_RETAIL_PRICES_BASE` (added to the
Console app env in `platform/fiab/bicep/modules/admin-plane/app-deployments.bicep`;
empty default → `prices.azure.com`).

## Verification

- `lib/components/deploy-planner/__tests__/cost-estimate.test.ts` — vitest cases
  (normalize, pickMeterRow, summarizePlan totals + unestimated reasons + `priceRegion`
  threading, CSV/JSON, deep-link, plan-only never priced, **currency/region option
  validators** in `cost-options`). GREEN.
- Live E2E receipt: every representative meter resolves a real row + sensible
  monthly figure against `prices.azure.com` (see PR body).
