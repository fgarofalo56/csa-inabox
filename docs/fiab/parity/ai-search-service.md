# ai-search-service — parity with Azure AI Search (service navigator / portal left blade)

Source UI: Azure portal → a `Microsoft.Search/searchServices` resource → the
**Search management** blade group (Indexes / Indexers / Data sources / Skillsets
/ Synonym maps / Aliases / Debug sessions) plus the **Import data** wizards.
Grounded in Microsoft Learn:
- AI Search REST reference (top-level objects: indexes, documents, indexers, data sources, skillsets, synonym maps): https://learn.microsoft.com/rest/api/searchservice/
- Data-plane REST operation groups: https://learn.microsoft.com/rest/api/searchservice/operation-groups
- Create Indexer (dataSourceName + targetIndexName + optional skillsetName; create also runs it): https://learn.microsoft.com/rest/api/searchservice/create-indexer
- Create Skillset (≥1 skill, attached to an indexer): https://learn.microsoft.com/azure/search/cognitive-search-defining-skillset
- Create a data source (typed connection used by an indexer): https://learn.microsoft.com/rest/api/searchservice/data-sources/create
- Run / reset / status indexers: https://learn.microsoft.com/azure/search/search-howto-run-reset-indexers
- Index aliases (stable name → one index): https://learn.microsoft.com/azure/search/search-how-to-alias
- Synonym maps (solr-format rules): https://learn.microsoft.com/azure/search/search-synonyms

Data-plane REST api-version used throughout: **2024-07-01**
(`SEARCH_DATA_API` in `lib/azure/search-index-client.ts`). AAD bearer token,
scope `https://search.azure.com/.default`, via the Loom UAMI →
DefaultAzureCredential chain. Service pinned by `LOOM_AI_SEARCH_SERVICE`.

## Azure / AI Search feature inventory

The portal exposes a typed navigator over the service's top-level objects. For
each type: a collapsible group with a **live count**, **＋ Add** per group, a
**filter by name** box, and per-item **open / delete / (lifecycle)** actions.

| # | Group | Capabilities in the Azure portal |
|---|-------|----------------------------------|
| 1 | **Indexes** | list + count, Add index (fields builder / JSON), open (edit schema, search explorer), delete; semantic config + vector profiles authored within the index |
| 2 | **Indexers** | list + count, Add indexer (data source + target index + optional skillset), open, **Run**, **Reset**, **status** (last result), delete |
| 3 | **Data sources** | list + count, Add (typed connection: blob / ADLS Gen2 / table / SQL / Cosmos / OneLake), open, delete |
| 4 | **Skillsets** | list + count, Add (built-in + custom skills, knowledge store / projections), open (JSON), delete |
| 5 | **Synonym maps** | list + count, Add (solr-format rules), open, delete |
| 6 | **Aliases** | list + count, Add (maps a stable name to one index), open, delete |
| — | **Debug sessions** | visual skillset enrichment debugger |
| — | **Import data** / **Import and vectorize data** | wizard that creates datasource+index+skillset+indexer in one flow |
| — | Top toolbar | **Add** menu, **filter by name**, refresh |

## Loom coverage

Navigator: `lib/components/ai-search/ai-search-tree.tsx` (`AiSearchServiceTree`),
hosted as the `leftPanel` of `AiSearchIndexEditor`
(`lib/editors/foundry-sub-editors.tsx`). Selecting an index opens it by real
name (schema / search / statistics / indexers) — parity with clicking an index
in the portal.

| Capability | Status | Notes |
|------------|--------|-------|
| Indexes — list + live count | ✅ | `GET /api/ai-search/indexes` → `listIndexes` (`GET /indexes`) |
| Indexes — ＋ New | ✅ | starter index (key `id` + searchable `content`) via `POST /indexes`; full field/analyzer/vector/semantic authoring in the Schema (JSON) tab |
| Indexes — open | ✅ | selecting opens schema + search-explorer + stats + indexers for that index |
| Indexes — delete | ✅ | `DELETE /api/ai-search/indexes?name=` → `deleteIndex` |
| Index — edit schema (fields, analyzers, vector, semantic) | ✅ | Schema tab **visual field designer** (editable grid: type picker, key/searchable/filterable/sortable/facetable/retrievable, analyzer, vector dims + profile) **+** advanced JSON tab → `PUT /api/ai-search/indexes/[name]` → `updateIndex` (`PUT /indexes/{name}`) |
| Index — search explorer (queryType simple/full/semantic, semantic config, search fields, filter/select/orderby/top/facets/count, **vector-query builder**, raw-JSON view) | ✅ | Search tab → `POST /api/ai-search/indexes/[name]/search` → `searchDocuments` (semantic + vectorQueries) |
| Index — analyze text | ✅ | `POST /api/ai-search/indexes/[name]/analyze` → `analyzeText` |
| Index — statistics (doc count, storage, vector size) | ✅ | `GET /api/ai-search/indexes/[name]` → `getIndexStats` |
| Indexers — list + count | ✅ | `GET /api/ai-search/indexers` → `listIndexers` |
| Indexers — ＋ New (datasource + index + skillset dropdowns) | ✅ | `POST /api/ai-search/indexers` → `createIndexer` (`PUT /indexers/{name}`) |
| Indexers — Run | ✅ | `POST {action:'run'}` → `runIndexer` (`POST /indexers/{name}/run`) |
| Indexers — Reset | ✅ | `POST {action:'reset'}` → `resetIndexer` (`POST /indexers/{name}/reset`) |
| Indexers — status badge | ✅ | `POST {action:'status'}` → `getIndexerStatus` (`GET /indexers/{name}/status`) |
| Indexers — delete | ✅ | `DELETE /api/ai-search/indexers?name=` → `deleteIndexer` |
| Data sources — list + count | ✅ | `GET /api/ai-search/datasources` → `listDataSources` |
| Data sources — ＋ New (type + conn string + container + query) | ✅ | `POST /api/ai-search/datasources` → `createDataSource` (`PUT /datasources/{name}`) |
| Data sources — delete | ✅ | `DELETE /api/ai-search/datasources?name=` → `deleteDataSource` |
| Skillsets — list + count | ✅ | `GET /api/ai-search/skillsets` → `listSkillsets` |
| Skillsets — ＋ New (full JSON definition) | ✅ | `POST /api/ai-search/skillsets` → `createSkillset` (`PUT /skillsets/{name}`) |
| Skillsets — delete | ✅ | `DELETE /api/ai-search/skillsets?name=` → `deleteSkillset` |
| Synonym maps — list + count | ✅ | `GET /api/ai-search/synonymmaps` → `listSynonymMaps` |
| Synonym maps — ＋ New (solr rules) | ✅ | `POST /api/ai-search/synonymmaps` → `createSynonymMap` (`PUT /synonymmaps/{name}`) |
| Synonym maps — delete | ✅ | `DELETE /api/ai-search/synonymmaps?name=` → `deleteSynonymMap` |
| Aliases — list + count | ✅ | `GET /api/ai-search/aliases` → `listAliases` |
| Aliases — ＋ New (→ one index) | ✅ | `POST /api/ai-search/aliases` → `createAlias` (`PUT /aliases/{name}`) |
| Aliases — delete | ✅ | `DELETE /api/ai-search/aliases?name=` → `deleteAlias` |
| Filter by name | ✅ | client-side filter box over all six groups |
| ＋ Add menu (top) + refresh | ✅ | menu opens the per-type create dialog; refresh re-lists everything |
| Service not provisioned | ⚠️ honest-gate | every route 503s `{code:'not_configured', missing:'LOOM_AI_SEARCH_SERVICE'}`; the whole tree shows one MessageBar naming the env var + roles + bicep module |
| Semantic configuration authoring + query | ✅ | per-field designer surfaces semantic config names; Search tab selects a semantic config + emits `queryType:'semantic'` + `semanticConfiguration` (+ optional answers/captions); a dedicated config-builder wizard (which fields feed the config) remains advanced-JSON for now |
| Vector profile authoring + query | ✅ | designer assigns dims + an existing `vectorSearchProfile` per vector field, and the Search tab's vector-query builder runs k-NN/hybrid against them; profile/algorithm *creation* remains advanced-JSON for now |
| Debug sessions | ⚠️ coming | `/debugSessions` visual enrichment debugger; "Not yet wired" row |
| Import data / Import-and-vectorize wizard | ⚠️ coming | build datasource → skillset → index → indexer individually; one-shot wizard is a "Not yet wired" row |

Zero ❌. Every inventory row is built ✅ or honest-gated ⚠️ with the exact REST
surface it would call disclosed in the navigator's "Not yet wired" tooltips.

## Backend per control

All data-plane calls run through `lib/azure/search-index-client.ts`
(AAD bearer, api-version 2024-07-01) behind session-guarded BFF routes under
`app/api/ai-search/*`. Service-level routes are env-pinned to
`LOOM_AI_SEARCH_SERVICE`; the index editor's by-name routes
(`/api/ai-search/indexes/[name]{,/search,/analyze}`) let the navigator open any
index without a Loom item binding, mirroring the portal.

| Route | Methods | Client fn → REST |
|-------|---------|------------------|
| `/api/ai-search/indexes` | GET / POST / DELETE | `listIndexes` `createIndex` `deleteIndex` → `/indexes` |
| `/api/ai-search/indexes/[name]` | GET / PUT | `getIndex`+`getIndexStats` / `updateIndex` → `/indexes/{name}`, `/stats` |
| `/api/ai-search/indexes/[name]/search` | POST | `searchDocuments` → `/indexes/{name}/docs/search` |
| `/api/ai-search/indexes/[name]/analyze` | POST | `analyzeText` → `/indexes/{name}/analyze` |
| `/api/ai-search/indexers` | GET / POST / DELETE | `listIndexers` `createIndexer` `runIndexer` `resetIndexer` `getIndexerStatus` `deleteIndexer` → `/indexers/*` |
| `/api/ai-search/datasources` | GET / POST / DELETE | `listDataSources` `createDataSource` `deleteDataSource` → `/datasources/*` |
| `/api/ai-search/skillsets` | GET / POST / DELETE | `listSkillsets` `createSkillset` `deleteSkillset` → `/skillsets/*` |
| `/api/ai-search/synonymmaps` | GET / POST / DELETE | `listSynonymMaps` `createSynonymMap` `deleteSynonymMap` → `/synonymmaps/*` |
| `/api/ai-search/aliases` | GET / POST / DELETE | `listAliases` `createAlias` `deleteAlias` → `/aliases/*` |

## Deferred (honest "coming" rows — not fakes)

1. **Semantic configuration designer** — editable via Schema JSON today.
2. **Vector profile authoring wizard** — editable via Schema JSON today.
3. **Debug sessions** — `/debugSessions` visual enrichment debugger.
4. **Import data / Import-and-vectorize wizard** — compose the pieces individually for now.

Each appears as a `Badge "coming"` row in the navigator with a tooltip naming
the underlying REST surface — never a fake list.

## Infra / bicep

- Env var: `LOOM_AI_SEARCH_SERVICE` (service name or `<svc>.search.windows.net`).
- Roles on the search service for the Loom UAMI: **Search Service Contributor**
  (object CRUD) + **Search Index Data Contributor** (document/query).
- Bicep module: `platform/fiab/bicep/modules/admin-plane/ai-search.bicep`.

## Verification

Build gate green (`pnpm build` exit 0; all 9 `/api/ai-search/*` routes compiled).
Functional E2E requires a deployed search service + minted session: with
`LOOM_AI_SEARCH_SERVICE` set, the six groups list/count from real REST and every
＋ New / delete / Run / Reset / status hits the data-plane. With it unset, every
route returns the documented 503 gate and the navigator shows the single honest
MessageBar. No mock arrays anywhere.
