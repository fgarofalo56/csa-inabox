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
| 9 | **Delta-synced auto-indexing** from a lakehouse/UC Delta table (incremental, no manual re-population) | Databricks Vector Search "Delta Sync Index" · AI Search indexer/OneLake |
| 10 | **Reranking on query** (hybrid retrieval → precision rerank) | Databricks `query(... rerank)` · AI Search L2 semantic reranker |
| 11 | Search by text (auto-embed the query) | Databricks `query_text=` |

## Loom coverage
| # | State | Notes |
|---|-------|-------|
| 1 | ✅ built | left panel: index name, key+content+vector fields built by `buildVectorIndexDefinition` (now with a `loom-semantic` semantic config) |
| 2 | ✅ built | dimensions + metric pickers → HNSW profile |
| 3 | ✅ built | backend dropdown; **ai-search fully wired**, others persist spec + honest gate |
| 4 | ✅ built | Schema tab → GET live index fields table (real `getIndex`) |
| 5 | ✅ built | Documents tab → PUT mergeOrUpload (`uploadDocuments`) |
| 6 | ✅ built | Search tab → POST k-NN (`vectorSearch`), sortable result table |
| 7 | ✅ built | optional hybrid text box on the Search tab |
| 8 | ✅ built | Save spec → POST/PATCH Cosmos item |
| 9 | ✅ built | **Delta sync tab** → bind a source Delta table (URI + key + content columns) → `POST …/sync` reads via Synapse Serverless, diffs by key+content-hash (WS-G manifest pattern), embeds only new/changed rows (AOAI), upserts to the index, deletes removed rows. Status panel shows bound source + rows indexed + last-sync time. Incremental — no manual re-population. |
| 10 | ✅ built | Search tab **Rerank** switch → wider candidate retrieval + fusion reranker (`vector-rerank.ts`: normalized retrieval ⊕ query-text lexical overlap, trim to k). **Semantic (AI Search L2)** switch → `queryType=semantic` reranker score consumed by the fusion stage. Timing shown in the status line. |
| 11 | ✅ built | Search tab Query-text box with no vector → route embeds it via `aoaiEmbed` to form the k-NN query. |

## Backend per control
- Create index → `POST /api/items/vector-store/[id]/index` → `upsertIndex` (PUT `/indexes/{name}?api-version=2024-07-01`), now includes a `semantic` config.
- Schema → `GET …/index?name=` → `getIndex`.
- Add docs → `PUT …/index` → `uploadDocuments` (`/docs/index` mergeOrUpload).
- **Delta sync** → `POST /api/items/vector-store/[id]/sync` → `syncDeltaToVectorIndex` (`vector-delta-sync.ts`): Synapse Serverless `OPENROWSET(FORMAT='DELTA')` read → `diffRows` → `aoaiEmbed` → `uploadDocuments` (upsert) + `deleteDocuments` (removed) → manifest persisted in the `vector-sync-manifests` Cosmos container. `GET …/sync?name=` → `getSyncStatus`.
- **Search** → `POST …/search` → `vectorSearch` (`/docs/search` vectorQueries kind=vector, optional `queryType=semantic`) → optional `rerankByFusion`. Text-only query embedded via `aoaiEmbed`.
- **Honest-gate**: every AI Search call throws `NotDeployedError` → 503 naming `LOOM_AI_SEARCH_SERVICE` (+ Search Index Data Contributor); the Delta sync additionally names `LOOM_SYNAPSE_WORKSPACE` (Serverless reader) and `LOOM_AOAI_EMBED_DEPLOYMENT` (embeddings) when unset. Full UI still renders. Non-ai-search backends show a config-only warning naming the resource to provision.

## No-Fabric-dependency (WS-2.2)
The Delta auto-sync uses **plain ADLS Gen2 Delta** as the source (read via **Synapse
Serverless**), **Azure OpenAI** embeddings, and an **Azure AI Search** index — all
function with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. No `api.fabric.microsoft.com`
/ OneLake host is on the sync path. This is the Azure-native 1:1 of Databricks
Vector Search's Delta Sync Index (which mirrors a source Delta table into a
managed vector index and reranks on query).

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
