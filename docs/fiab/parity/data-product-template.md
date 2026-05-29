# data-product-template / data-product-instance — parity with Fabric/Purview data product templates

Source: CSA-curated push-button data-product patterns (Loom-native), modeled on
Purview data products + Fabric workspace item bundles.

## Feature inventory

| # | Capability | Source surface |
|---|------------|----------------|
| 1 | Template gallery (curated patterns + components + est. cost) | template library |
| 2 | Template detail (component list, item types) | template detail |
| 3 | Instantiate into a workspace (spawn N child items + a parent instance) | instantiate wizard |
| 4 | Instance components table | instance detail |
| 5 | Component health (per child item freshness/missing) | instance health |
| 6 | Open each component | component link |

## Loom coverage — template

| # | Status | Notes |
|---|--------|-------|
| 1 | built ✅ | grid from GET `/api/items/data-product-template` |
| 2 | built ✅ | detail with component table + est. cost |
| 3 | built ✅ | POST `/api/items/data-product-template/[slug]/instantiate` (workspace picker + name) |
| (Browse) | built ✅ | the disabled "Browse" ribbon button is REPLACED by a searchable filter over the curated catalog (no cross-catalog stub) |

## Loom coverage — instance

| # | Status | Notes |
|---|--------|-------|
| 4 | built ✅ | components table from GET `/api/items/data-product-instance/[id]` |
| 5 | built ✅ | Health column → peeks each child `/api/cosmos-items/<slug>/<id>` updatedAt |
| 6 | built ✅ | component deep-links |

## Backend per control

- Templates list / instantiate → existing `/api/items/data-product-template/*`
- Instance / health → `/api/items/data-product-instance/[id]` + `/api/cosmos-items/*`
- All real Cosmos-backed; no mocks.
