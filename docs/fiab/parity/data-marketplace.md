# data-marketplace — parity with Microsoft Purview / Fabric data-product marketplace + OneLake data hub

Source UI:
- Microsoft Purview data catalog / data products — https://learn.microsoft.com/purview/concept-data-products
- Fabric "OneLake data hub" discovery + domain browsing — https://learn.microsoft.com/fabric/governance/domains

CSA Loom realizes this as the **Data marketplace** item type (`data-marketplace`),
a consumer-discovery hub backed by a dedicated Azure AI Search index
(`loom-data-products`). **Azure-native by default — no Microsoft Fabric or
Power BI dependency.** The index mirrors every `data-product` WorkspaceItem; the
consumer query is always filtered to `publishStatus eq 'Published'` and the
caller's tenant.

## Azure / Fabric feature inventory

| # | Capability (real source UI) | Notes |
|---|------------------------------|-------|
| 1 | Keyword search across catalog assets | Purview/Fabric search box |
| 2 | Exact-phrase search (quoted) | AI Search simple-syntax phrase match |
| 3 | Faceted left filter panel | domain, type, owner, glossary terms, classifications/CDEs |
| 4 | Active-filter chips (dismissible) | shows + clears applied facets |
| 5 | Result list with hover detail | description, owner, SLA on hover |
| 6 | Browse by governance domain (card grid) | live product counts per domain |
| 7 | Request access to an asset | permission picker + durable request |
| 8 | Track my access requests | status list per requester |
| 9 | Publish / curate a data product | producer registers + sets Published |
| 10 | Draft vs Published visibility gate | only Published is consumer-visible |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | built ✅ | Discover tab `Input` + `POST /api/data-products/search` |
| 2 | built ✅ | raw `q` passed verbatim, `queryType:'simple'`; quote hint in UI |
| 3 | built ✅ | facet panel, `Checkbox` per bucket; `buildFacetFilter` → OData (`any()` for collections) |
| 4 | built ✅ | dismissible `Tag` chips + Clear all |
| 5 | built ✅ | `Card` + `Tooltip` per hit |
| 6 | built ✅ | Domains tab grid from `@search.facets.domainName` counts |
| 7 | built ✅ | `RequestAccessButton` → `POST /api/catalog/request-access` |
| 8 | built ✅ | My data access tab → `GET /api/data-products/my-access-requests` (audit-log) |
| 9 | built ✅ | Publish tab create dialog → `POST /api/data-products`; publish/unpublish → `PATCH /api/data-products/[id]` |
| 10 | built ✅ | consumer search injects `publishStatus eq 'Published'`; producer toggles status |

Honest infra-gate ⚠️ : when `LOOM_AI_SEARCH_SERVICE` is unset the Discover /
Domains tabs render a Fluent `MessageBar` (intent="warning") naming the env var
and the bicep module — the rest of the surface still renders. Zero ❌, zero
stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Search / facets / domain counts | `searchDataProducts()` → AI Search data-plane `POST /indexes/loom-data-products/docs/search` |
| Cosmos→index mirror (create/patch/delete) | `item-crud.ts` → `upsertDataProductDoc` / `deleteDataProductDoc` |
| Index provisioning | `ensureDataProductsIndex()` (lazy on first write/query + `POST /api/admin/bootstrap-catalogs`) |
| Create / list / patch / delete product | `/api/data-products` + `/api/data-products/[id]` → Cosmos `items` via shared `item-crud` |
| Request access | `POST /api/catalog/request-access` → Cosmos `audit-log` + `notifications` |
| My access requests | `GET /api/data-products/my-access-requests` → Cosmos `audit-log` query |
| Domains for publish form | `GET /api/admin/domains` (Cosmos tenant-settings) |

## Verification (acceptance)

- Search returns only Published Cosmos items from the live index — `searchDataProducts` always ANDs `publishStatus eq 'Published'`.
- A product set to Draft disappears from results — covered by the producer Unpublish action + the consumer filter.
- A double-quoted phrase does exact match — raw query passthrough, `queryType:'simple'`.
- Facet filter for `type` returns the correct subset — `buildFacetFilter` unit-tested.
- Domain card counts match facet aggregates — cards render straight from `@search.facets.domainName`.
- Receipt shows the search POST response — "Show search response (receipt)" panel renders `searchResponse`.
- Honest gate when `LOOM_AI_SEARCH_SERVICE` unset — 503 `{code:'not_configured', missing}` → MessageBar.

Unit tests: `lib/azure/__tests__/loom-data-products-search.test.ts` (10 tests — `docForDataProduct` Draft default + normalization, `buildFacetFilter` OData shaping + injection escaping).
