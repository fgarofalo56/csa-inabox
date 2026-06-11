# connections / thread / data-products — collection-surface view toggles

Source UIs:
- Microsoft Purview Unified Catalog "Data products" — list you scroll, sort,
  filter, search: https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage#view-data-products
- Purview governance domains "Business concepts" render as selectable **cards**:
  https://learn.microsoft.com/purview/unified-catalog-governance-domains-create-manage
- Purview observability "Data Product Lineage" view (maps to Loom Thread):
  https://learn.microsoft.com/purview/unified-catalog-observability-views
- Fabric OneLake catalog / workspace collection surfaces offer a tile/list
  toggle, already matched by Loom's `/browse`, `/workspaces`, `/onelake`,
  `/governance`, `/workload-hub` pages.

This change brings the same **Tile | List** collection pattern (the shared
`ViewToggle` + `ItemTile`/`TileGrid` + `LoomDataTable` primitives) to the three
remaining collection surfaces that lacked it.

## Loom coverage

| Capability | /connections | /thread (Lineage) | /data-products |
|---|---|---|---|
| List view (sortable/filterable/resizable `LoomDataTable`) | ✅ (already) | ✅ (already) | ✅ (migrated from raw Fluent `<Table>`) |
| Tile/card view (`ItemTile` + `TileGrid`) | ✅ new | ✅ new (one card per Weave edge) | ✅ new |
| `Tile | List` `ViewToggle` (gated on rows > 0) | ✅ new | ✅ new | ✅ new |
| View choice persisted to `localStorage` | ✅ `loom.connections.viewMode.v1` | ✅ `loom.thread.viewMode.v1` | ✅ `loom.dataProducts.viewMode.v1` |
| Per-control real backend | ✅ unchanged | ✅ unchanged | ✅ unchanged |
| Enumerable (no free-form) filters | ✅ | ✅ | ✅ Type/Status/Governance/Purview are `filterType:'select'`; Type options sourced from the real `CatalogModelDataProductTypeEnum` |
| Item visuals reuse the registry | ✅ `CONN_TILE_TYPE` maps connection types → existing slugs | ✅ `THREAD_TILE_TYPE` maps `powerbi-model`→`semantic-model`, `data-api-builder`→`graphql-api` | ✅ `data-product` slug (deep-violet Cube) |
| Inline actions in tiles | ✅ Delete via `overflowMenu` (Fluent `Menu`) | ✅ tile `onClick` deep-links to target editor / opens external target | ✅ tile `onClick` → detail page |

Zero ❌, zero stub banners.

## Backend per control

All three surfaces are presentation-only over data they already fetch — no new
client, BFF route, env var, role, Cosmos container, or bicep:

- `/connections` → `GET /api/connections` (Key Vault-backed connection store)
- `/thread` → `GET /api/thread/edges` (Cosmos `thread-edges`)
- `/data-products` → `GET /api/data-products` (Cosmos data-products)

## no-fabric-dependency

Nothing here reads `fabricWorkspaceId` or calls `api.fabric.microsoft.com` /
`api.powerbi.com`. Azure-native defaults are unchanged; the pages render
identically with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Bicep / bootstrap sync

No-op — purely additive front-end over existing endpoints. No infra delta.

## Tests

Vitest (jsdom) page specs assert, per page: the `ViewToggle` renders only when
rows > 0, toggling to List swaps the `TileGrid` for the `LoomDataTable` (a
list-only column header appears), and the view choice persists to the
documented `localStorage` key.
- `app/connections/__tests__/page.test.tsx`
- `app/thread/__tests__/page.test.tsx`
- `app/data-products/__tests__/page.test.tsx`
