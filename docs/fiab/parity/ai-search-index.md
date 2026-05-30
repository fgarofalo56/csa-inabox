# ai-search-index — parity with Azure AI Search index (Search management)

Source UI: Azure portal → Search service → **Search management** → Indexes / Indexers / Data sources / Skillsets, plus the per-index **Search explorer**, **Fields**, and **Index statistics** panes.
Grounded in Microsoft Learn — Data plane REST operations (api-version `2024-07-01`):
- https://learn.microsoft.com/azure/search/search-how-to-manage-index
- https://learn.microsoft.com/rest/api/searchservice/indexes/get-statistics
- https://learn.microsoft.com/azure/search/search-howto-run-reset-indexers

Backend service: `LOOM_AI_SEARCH_SERVICE` → `https://<service>.search.windows.net`, AAD bearer (scope `https://search.azure.com/.default`) via the Loom UAMI (`ChainedTokenCredential`). UAMI roles: **Search Index Data Contributor** + **Search Service Contributor** (writes), **Search Index Data Reader** (reads/query).

## The bug this fixes

The Loom AI Search item is a **Cosmos GUID**. The old `[id]` route passed that
GUID straight to the data-plane as the **index name** → `GET /indexes/<guid>`
returned `404 {"ok":false,"error":"not found"}` and the editor died on load
("Error not found. Can't manage or do anything with a search index."). Same
class of bug as pipeline #476. Fixed with a **resource-binding model**: the Loom
item binds to a real AI Search index (persisted in `state.indexName`); every
route resolves the bound name via `resolveSearchBinding()` instead of the route
id. Unbound → `412 {code:'unbound'}` → the editor renders its **bind picker**
(the full editor surface still renders — never a 404 crash).

## Azure AI Search feature inventory → Loom coverage

| Azure portal capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| List all indexes on the service | ✅ built — catalog list mode + bind-picker dropdown | `GET /indexes?$select=name,fields,vectorSearch` |
| Bind item to an existing index | ✅ built — bind picker (Dropdown + Bind) | `POST /api/items/ai-search-index/[id]/bind` → `persistSearchBinding` (Cosmos) |
| Create a new index | ✅ built — "Create + bind" + POST from schema editor | `POST /indexes` `{name, fields, ...}` |
| View index definition / **Fields** (name, type, key, searchable, filterable, sortable, facetable, retrievable, analyzer, dims) | ✅ built — Schema tab field grid | `GET /indexes/{name}` |
| Vector config (profiles, algorithms) | ✅ built — Schema tab vector summary line + JSON editor | `GET /indexes/{name}` `.vectorSearch` |
| Semantic config | ✅ built — `semantic` badge + full JSON in editor | `GET /indexes/{name}` `.semantic` |
| Edit index definition + save | ✅ built — Schema tab Monaco JSON editor → Save definition | `PUT /indexes/{name}` (createOrUpdate) |
| Delete index | ✅ built — `DELETE /api/items/ai-search-index/[id]` (bound) | `DELETE /indexes/{name}` |
| **Search explorer** — query text, filter, top, select, count, facets | ✅ built — Search tab (search/filter/select/top, count + facet summary, results grid w/ score) | `POST /indexes/{name}/docs/search` |
| Vector / hybrid query (k-NN) | ✅ built — `vectorQueries` passthrough on the search route | `POST /docs/search` `{vectorQueries}` |
| **Analyze** text (token preview) | ✅ built — Search tab Analyze box (text + analyzer → tokens) | `POST /indexes/{name}/analyze` |
| **Index statistics** (document count, storage, vector index size) | ✅ built — Statistics tab | `GET /indexes/{name}/stats` |
| **Indexers** list (target index, data source, skillset) | ✅ built — Indexers tab grid; rows targeting this index pinned + badged | `GET /indexers` |
| Run indexer (on-demand) | ✅ built — Indexers tab Run button | `POST /indexers/{name}/run` |
| Reset indexer (clear high-water mark) | ✅ built — Indexers tab Reset button | `POST /indexers/{name}/reset` |
| Indexer status / last run | ✅ built — `action:'status'` on the indexers route | `GET /indexers/{name}/status` |
| **Data sources** list | ✅ built — Indexers tab summary | `GET /datasources` |
| **Skillsets** list | ✅ built — Indexers tab summary | `GET /skillsets` |
| Open in Azure portal | ✅ built — ribbon deep-link (resource blade when ARM id present) | n/a |
| Infra-gate when AI Search not provisioned | ⚠️ honest-gate — bind picker shows a `intent="warning"` MessageBar naming `LOOM_AI_SEARCH_SERVICE` + the two UAMI roles + the bicep module; **full UI still renders** | n/a |

Zero ❌. Zero stub banners. The only non-functional state is the documented
infra-gate (AI Search not deployed → `LOOM_AI_SEARCH_SERVICE` unset).

## Backend per control

- **Binding** read/list/create: `/api/items/ai-search-index/[id]/bind`
  (GET → current binding + real `GET /indexes` for the picker, honest-gates when
  unset; POST → bind existing or `POST /indexes` create + bind).
- **Definition** GET/PUT/DELETE: `/api/items/ai-search-index/[id]` → `resolveSearchBinding`
  → `search-index-client.{getIndex,updateIndex,deleteIndex}` (+ best-effort `getIndexStats`).
- **Search**: `/api/items/ai-search-index/[id]/search` → `searchDocuments(boundName, {...})`.
- **Analyze**: `/api/items/ai-search-index/[id]/analyze` → `analyzeText`.
- **Stats**: `/api/items/ai-search-index/[id]/stats` → `getIndexStats`.
- **Indexers / data sources / skillsets / run / reset / status**:
  `/api/items/ai-search-index/[id]/indexers` → `listIndexers/listDataSources/listSkillsets/runIndexer/resetIndexer/getIndexerStatus`.
- **Collection** list/create: `/api/items/ai-search-index` → `listIndexes` / `createIndex`.

Every route 412s with `{ok:false, code:'unbound'}` when the item has no
`state.indexName` (editor shows the bind picker), 503s with `notDeployed:true`
+ the exact env/role/bicep hint when `LOOM_AI_SEARCH_SERVICE` is unset, and
returns precise data-plane status codes otherwise. Every `await r.json()` —
both client-side (`postJson` / inline content-type checks) and in the
`search-index-client` (`readJsonGuarded`) — is content-type guarded so an HTML
error page (proxy 502) never throws an opaque "Unexpected token <".

## Bicep sync

New env var `LOOM_AI_SEARCH_SERVICE` (already referenced by `loom-search.ts`
for the `loom-items` index) is the only required infra binding. When a dedicated
AI Search service is provisioned for a deployment, add it + the two UAMI role
assignments to `platform/fiab/bicep/modules/admin-plane/ai-search.bicep` and
wire the env var into the `apps[]` list in `admin-plane/main.bicep`.

## Verification

- `pnpm build` clean (all 7 `ai-search-index` routes compile).
- Backend Vitest contract tests:
  `lib/azure/__tests__/search-binding.test.ts` (10) +
  `lib/azure/__tests__/search-index-client.test.ts` (19) — 29 green. They lock
  the binding model (state.indexName, not route id), the gate, every REST
  URL/method/payload, and the content-type guard.
- Live probe (`GET /api/items/ai-search-index/<guid>`) unavailable in the
  worktree (no minted session / no deployed AI Search). Run against a deployment
  with `LOOM_AI_SEARCH_SERVICE` set + a bound index to capture the real-data
  receipt.
