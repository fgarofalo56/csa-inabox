# vector-store — parity with Azure AI Search vector index UI (and Cosmos vector)

Source UI: Azure portal → AI Search → Indexes (vector profile) + Search explorer ·
https://learn.microsoft.com/azure/search/vector-search-overview ·
https://learn.microsoft.com/azure/search/vector-search-how-to-create-index

## Azure/Fabric feature inventory
| # | Capability | Source UI |
|---|------------|-----------|
| 1 | Index schema definition (fields, key, vector field) | Add index |
| 2 | Vector config: dimensions + algorithm/metric (HNSW cosine/euclidean/dot) | vectorSearch profile |
| 3 | Backend choice (AI Search / Cosmos NoSQL DiskANN / vCore / pgvector) | service selection |
| 4 | View live index schema | Index → Fields |
| 5 | Add / upload documents | Import data / push docs |
| 6 | Vector similarity (k-NN) search test | Search explorer (vectorQueries) |
| 7 | Hybrid (text + vector) search | Search explorer |
| 8 | Persist the spec | n/a (Loom item) |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | left panel: index name, key+content+vector fields built by `buildVectorIndexDefinition` |
| 2 | ✅ built | dimensions + metric pickers → HNSW profile |
| 3 | ✅ built | backend dropdown; **ai-search fully wired**, others persist spec + honest gate |
| 4 | ✅ built | Schema tab → GET live index fields table (real `getIndex`) |
| 5 | ✅ built | Documents tab → PUT mergeOrUpload (`uploadDocuments`) |
| 6 | ✅ built | Search tab → POST k-NN (`vectorSearch`), result JSON |
| 7 | ✅ built | optional hybrid text box on the Search tab |
| 8 | ✅ built | Save spec → POST/PATCH Cosmos item |

## Backend per control
- Create index → `POST /api/items/vector-store/[id]/index` → `upsertIndex` (PUT `/indexes/{name}?api-version=2024-07-01`).
- Schema → `GET …/index?name=` → `getIndex`.
- Add docs → `PUT …/index` → `uploadDocuments` (`/docs/index` mergeOrUpload).
- Search → `POST …/search` → `vectorSearch` (`/docs/search` vectorQueries kind=vector).
- **Honest-gate**: every AI Search call throws `NotDeployedError` → 503 naming `LOOM_AI_SEARCH_SERVICE` (+ Search Index Data Contributor) when not provisioned; full UI still renders. Non-ai-search backends show a config-only warning naming the resource to provision.

## Per-cloud matrix
| Cloud | AI Search default | Data-plane host | Notes |
|---|---|---|---|
| Commercial | on | `<name>.search.windows.net` | `searchEndpointBase(svc)` resolves this |
| GCC | on (Commercial Azure) | `<name>.search.windows.net` | `isGovCloud()` false |
| GCC-High (L4) | off by default | `<name>.search.usgovcloudapi.net` | `searchEndpointBase()` now resolves the Gov suffix; BYO via `existingAiSearchService` |
| IL5 | off by default | `<name>.search.usgovcloudapi.net` | same as GCC-High |

`SEARCH_AAD_SCOPE` (`https://search.azure.com/.default`) is cloud-invariant; only
the data-plane hostname differs and is resolved by `searchEndpointBase()`.

## Backend access (RBAC)
The Console UAMI is granted **Search Index Data Contributor**
(`8ebe5a00-799e-43f5-93ac-243d3dce84a7`) on the search service in
`ai-search.bicep` (threaded from `main.bicep` as `consolePrincipalId`). This is
required for the data-plane `PUT /indexes`, `POST /docs/index`, and
`POST /docs/search` operations behind the three editor tabs.

## Verification
- `app/api/items/vector-store/__tests__/vector-store-routes.test.ts` — 17 cases
  across the index GET/POST and search POST routes (401 / 400 / 503 honest-gate /
  happy path / 502 / FoundryError status pass-through).
- All AI Search data-plane URLs in `foundry-client.ts` now build from
  `searchEndpointBase(svc)` (no hard-coded `search.windows.net`), so a created
  index, an uploaded document, and a k-NN query all resolve the correct host in
  Commercial **and** Gov boundaries.
