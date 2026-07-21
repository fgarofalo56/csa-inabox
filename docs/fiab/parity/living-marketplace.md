# living-marketplace — WS-10.4 Living Marketplace (BTB-11)

Source UX: Microsoft Purview / Fabric data-hub **OneLake catalog + data-product
marketplace** (publish → certify → request/subscribe), generalized from data
products to **all five Loom product kinds**. This is a Loom-native *unification*
surface — there is no single Fabric screen that publishes agents, MCP servers,
apps, and ontologies together; Loom's Catalog tab is the superset.

Surface: `/marketplace` → **Catalog** tab (`LivingMarketplace`), plus the unified
**Discover** tab which now federates the five kinds alongside APIs + Delta shares.

## Feature inventory (Fabric/Purview marketplace) → Loom coverage

| Capability | Loom coverage | Backend |
|---|---|---|
| One catalog listing many product kinds | ✅ unified `marketplace` Cosmos schema, one record shape, 5 `productKind`s | `lib/marketplace/product-types.ts`, `product-store.ts` |
| Publish a product | ✅ Publish dialog (kind picker, name, domain, access model, LCU) | `POST /api/marketplace/products` |
| Certification / endorsement badge | ✅ **auto-certification** — publish runs the platform gate registry; `certified` only when required gates pass (no fake cert) | `lib/marketplace/certification.ts` → `lib/gates/registry` |
| Honest "not certified" remediation | ✅ `failed` cert names the exact missing env var + **Re-certify** action | `POST /api/marketplace/products/[id]/certify` |
| Request/subscribe for access | ✅ Subscribe → real entitlement grant (`open`=active, `request`=eligible) | `lib/marketplace/subscribe.ts` → `recordAssignment` (access-governance ledger) |
| Metered/chargeable usage | ✅ subscribe meters `lcuPerSubscription` LCU to the subscriber tenant | `recordCostAttribution` engine `marketplace` → chargeback rollup |
| Search + kind + domain filter | ✅ search box + kind tag filters + domain badges | `LivingMarketplace` / `UnifiedDiscover` |
| Subscriber count / popularity | ✅ per-product subscriber counter | `incrementSubscriberCount` |
| Deprecate a product | ✅ `publishStatus: deprecated` blocks new subscriptions | `setPublishStatus` |

Loom coverage: **built ✅** on every inventory row; zero ❌. No Fabric/Power BI
dependency — Cosmos + access-governance + LCU only (Gov-safe,
`no-fabric-dependency.md`).

## Backend per control

- **List/Publish** — `app/api/marketplace/products/route.ts` (Cosmos `marketplace`, PK `/tenantId`).
- **Get/Subscribe/Re-certify** — `app/api/marketplace/products/[id]/{route,subscribe,certify}`.
- **Auto-cert** — `runCertification(kind)` → `gateStatus(id)` over `KIND_REQUIRED_GATES`.
- **Entitlement** — `subscribeToProduct` → `recordAssignment({ source: 'marketplace' })`.
- **Billing** — `recordCostAttribution({ engine: 'marketplace' })` → `cost-attribution` ledger → `getWorkspaceChargeback`.

## Verification

- `tsc -p tsconfig.build.json` clean; `vitest` green (product schema, auto-cert
  pass/fail, entitlement + LCU meter on subscribe).
- **Owed (Track-0): browser-E2E receipt** — publish an agent + an ontology as
  certified, subscribable products, showing the real grant + LCU meter.
