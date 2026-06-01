# ai-search — parity with Azure AI Search (portal)

> Brutally honest 1:1 parity audit. Graded per `.claude/rules/no-vaporware.md`
> (A=full parity, B=production, C=functional-rough, D=renders-little,
> F=scaffold). When in doubt, graded DOWN. A UI with no real backend is NOT
> "built".
>
> **Audit date:** 2026-05-31 (rev. 2 — corrected after re-reading the editor.
> rev. 1 marked the visual field designer and the search-explorer query options
> as MISSING; both are in fact BUILT. The doc lagged behind the code shipped in
> the navigator parity program.)
> **Verdict:** **B (production-grade — real backend, near-1:1 UI parity for the
> index field designer + search explorer; remaining gaps are admin/preview
> surfaces, listed below).** Live visual functional verification still pends
> operator MSAL login.
>
> This doc supersedes/consolidates the older split docs `ai-search-service.md`
> (the service navigator tree) and `ai-search-index.md` (the index editor).

Source UI:
- Portal "Search management" blades — https://learn.microsoft.com/azure/search/search-features-list#portal-features
- Add index (index designer) — https://learn.microsoft.com/azure/search/search-what-is-an-index
- Import data wizard — https://learn.microsoft.com/azure/search/search-import-data-portal
- Search explorer — https://learn.microsoft.com/azure/search/search-explorer
- Manage an index — https://learn.microsoft.com/azure/search/search-how-to-manage-index
- Run/reset indexers — https://learn.microsoft.com/azure/search/search-howto-run-reset-indexers
- Schedule indexers — https://learn.microsoft.com/azure/search/search-howto-schedule-indexers
- Semantic ranking — https://learn.microsoft.com/azure/search/semantic-search-overview
- Vector index — https://learn.microsoft.com/azure/search/vector-search-how-to-create-index
- Scoring profiles — https://learn.microsoft.com/azure/search/index-add-scoring-profiles
- Debug sessions — https://learn.microsoft.com/azure/search/cognitive-search-debug-session
- Create demo app — https://learn.microsoft.com/azure/search/search-create-app-portal

Loom surface:
- Navigator: `apps/fiab-console/lib/components/ai-search/ai-search-tree.tsx`
- Editor: `apps/fiab-console/lib/editors/foundry-sub-editors.tsx` → `AiSearchIndexEditor` (≈ line 814)
- Data-plane client: `apps/fiab-console/lib/azure/search-index-client.ts` (real REST, api 2024-07-01)
- ARM (scale) client: `apps/fiab-console/lib/azure/aisearch-client.ts` (real ARM, api 2024-03-01-preview)
- Loom-items derived index: `apps/fiab-console/lib/azure/loom-search.ts`
- Service routes: `apps/fiab-console/app/api/ai-search/{indexes,indexers,datasources,skillsets,synonymmaps,aliases}/**`
- Item routes: `apps/fiab-console/app/api/items/ai-search-index/**`
- Scale UI (separate page): `apps/fiab-console/app/admin/scaling/page.tsx`
- Bicep: `platform/fiab/bicep/modules/admin-plane/ai-search.bicep`
  (env `LOOM_AI_SEARCH_SERVICE` wired in `admin-plane/main.bicep:596`)

---

## Azure / portal feature inventory (grounded in Learn)

### A. Search management — object collections (left sidebar)
The portal's **Search management** pane has one page per top-level object type,
each a sortable grid with create / open / delete:

1. **Indexes** — list (sortable by Name / Document count / Vector quota / Total
   storage), **Add index** (visual field designer), open, **Edit JSON**, Delete.
2. **Indexers** — list, **Add indexer**, open, **Run**, **Reset**, **Reset
   docs/skills** (preview), Delete, status + execution history.
3. **Data sources** — list, **Add data source** (typed connection form per
   source type), open, Delete.
4. **Skillsets** — list, **Add skillset** (JSON editor), open, Delete.
5. **Synonym maps** — list, **Add synonym map**, open, Delete.
6. **Aliases** — list, **Add alias**, open, Delete.
7. **Knowledge sources / knowledge base (preview)** — agentic retrieval objects.

### B. Index designer / management (per-index)
8. **Add index — visual field designer**: per-field grid with Name, Type, and
   the attribute checkboxes Searchable / Retrievable / Filterable / Facetable /
   Sortable / Stored / key; analyzer + synonym-map pickers; add/remove fields;
   complex-type nesting.
9. **Semantic configuration designer** (`semantic.configurations[]`) — title /
   content / keyword field pickers, ranking order.
10. **Vector search config** — vector profiles, algorithms (HNSW / exhaustiveKnn),
    compressions (scalar / binary quantization), vectorizers (integrated
    vectorization), per-field dimensions + profile binding.
11. **Scoring profiles** designer — weighted text fields + functions
    (freshness / magnitude / distance / tag).
12. **Suggesters / analyzers / normalizers / tokenizers / char filters**.
13. **CORS options**, **encryptionKey** (CMK double-encryption).
14. **Edit JSON** — full index definition in a JSON editor.
15. **Index statistics** — document count, storage size, vector index size, quota.
16. **Delete index** (with confirm).

### C. Indexer lifecycle
17. **Add indexer** wizard / form (data source + target index + skillset +
    field mappings + output field mappings + parameters).
18. **Run** (incremental), **Reset** (full re-index), **Resync** /
    **Reset docs** / **Reset skills** (preview).
19. **Schedule** (interval + start time; as low as 5 min).
20. **Execution history** + per-run **status** (docs succeeded/failed, warnings,
    errors).

### D. Tools for prototyping & inspection
21. **Import data** wizard — end-to-end pipeline (data source + skillset + index +
    indexer) for Keyword / RAG / Multimodal RAG, including chunking + integrated
    vectorization + semantic config + knowledge store.
22. **Search explorer** — query box + **Query options** (queryType simple/full/
    semantic, semantic config, vector queries, top, select, filter, orderby,
    facets, search fields, highlights), **JSON view**, results pane,
    captions/answers for semantic.
23. **Create demo app** — generate an HTML test page.
24. **Debug sessions** — visual skillset enrichment debugger (dependencies,
    per-skill input/output, transforms).
25. **Analyze text** (per index/analyzer → tokens). (Data-plane `/analyze`.)

### E. Service administration
26. **Overview / Essentials** — SKU, replicas, partitions, search units, status,
    endpoint, usage at-a-glance metrics.
27. **Scale** — change SKU tier, replica count, partition count.
28. **Keys** — admin/query API keys, regenerate, role-based vs key auth toggle.
29. **Identity** — system / user-assigned managed identity.
30. **Networking** — public access, IP firewall, private endpoints, trusted-service.
31. **Monitoring** — metrics (QPS, latency, throttling), diagnostic settings,
    alerts.
32. **Service statistics / quotas** (`/servicestats`) — counts + limits per type.

---

## Loom coverage

Legend: built ✅ (full 1:1 + real backend) · partial ⚠️ · honest-gate ⚠️ ·
MISSING ❌

### A. Object collections (navigator tree)
| # | Capability | Loom status | Where |
|---|------------|-------------|-------|
| 1 | Indexes list (count, fields, vector badge) + open + delete + ＋New | ✅ built | `ai-search-tree.tsx` Indexes group |
| 1 | Index list **column sort** (doc count / storage / vector quota) | ❌ MISSING | tree shows name + fieldCount only |
| 2 | Indexers list + ＋New + delete + Run + Reset + Status | ✅ built | `ai-search-tree.tsx` Indexers group |
| 3 | Data sources list + ＋New (typed form) + delete | ✅ built | tree + create dialog |
| 4 | Skillsets list + ＋New (JSON) + delete | ✅ built | tree + create dialog |
| 5 | Synonym maps list + ＋New + delete | ✅ built | tree |
| 6 | Aliases list + ＋New + delete | ✅ built | tree |
| 7 | Knowledge sources / knowledge base (preview agentic) | ❌ MISSING | not present |

### B. Index designer / management
| # | Capability | Loom status | Where |
|---|------------|-------------|-------|
| 8 | **Visual field designer** (add/remove fields, toggle attribute checkboxes, analyzer/type pickers) | ✅ built | Schema tab is now a full per-field designer: ＋Add field, per-row Name `Input`, Type `Dropdown` (FIELD_TYPES), Key/Searchable/Filterable/Sortable/Facetable/Retrievable `Checkbox`es (vector-aware disabling), analyzer `Dropdown` for searchable strings, dimensions + vector-profile pickers for vector fields, per-row Delete. Save → real `PUT /indexes/{name}`; Revert; dirty-state guard. `foundry-sub-editors.tsx:1146-1249` |
| 8 | Field grid (read-only view of attributes) | ✅ built | superseded by the editable designer above |
| 9 | Semantic configuration **designer** | ⚠️ honest-gate | "Not yet wired" row; editable only via Schema JSON |
| 10 | Vector profile / algorithm / vectorizer **designer** | ⚠️ honest-gate | "Not yet wired" row; editable only via Schema JSON; vector profiles shown read-only as a `Caption1` |
| 11 | Scoring-profile designer | ❌ MISSING (JSON-only) | only via raw Schema JSON; no designer, not even flagged |
| 12 | Suggesters / analyzers / normalizers / tokenizers designers | ❌ MISSING (JSON-only) | only via raw Schema JSON |
| 13 | CORS / encryptionKey (CMK) designer | ❌ MISSING (JSON-only) | only via raw Schema JSON |
| 14 | Edit JSON (full definition) + Save (real PUT) | ✅ built | Schema tab Monaco + `PUT /indexes/{name}` |
| 15 | Index statistics (docs, storage, vector size) | ✅ built | Statistics tab → `GET /indexes/{n}/stats` |
| 16 | Delete index | ✅ built | tree delete → `DELETE /indexes/{n}` |
| — | Create index | ⚠️ partial | only a **minimal starter** (id + content fields); no schema-on-create designer |

### C. Indexer lifecycle
| # | Capability | Loom status | Where |
|---|------------|-------------|-------|
| 17 | Create indexer (datasource + index + optional skillset) | ✅ built | create dialog → `PUT /indexers/{n}` |
| 17 | Field mappings / output field mappings / parameters editor | ❌ MISSING | not exposed (only via skillset/index JSON indirectly) |
| 18 | Run (incremental) | ✅ built | `POST /indexers/{n}/run` |
| 18 | Reset (full re-index) | ✅ built | `POST /indexers/{n}/reset` |
| 18 | Reset docs / Reset skills / Resync (preview) | ❌ MISSING | client has no method |
| 19 | **Schedule** (interval + start time) | ❌ MISSING | no schedule UI at all (Learn calls this out as core) |
| 20 | Execution **status** (last result) | ⚠️ partial | tree shows a single status badge from `/status`; **no execution history**, no per-run docs-succeeded/failed/warnings/errors detail |

### D. Prototyping & inspection tools
| # | Capability | Loom status | Where |
|---|------------|-------------|-------|
| 21 | **Import data** wizard (datasource+skillset+index+indexer in one flow, chunking + vectorization) | ⚠️ honest-gate | "Not yet wired" row; user must build each piece individually |
| 22 | **Search explorer** — basic query (search/filter/select/top), results grid, facets, count | ✅ built | Search tab → `POST /docs/search` |
| 22 | Search explorer — **Query options** (semantic / vector / queryType picker / search fields / orderby / select / top / count / filter) | ✅ built | queryType `Dropdown` (simple/full/semantic), semantic-config picker, search-fields, OData filter, select, orderby, top, count — all wired into the real `POST /docs/search` payload, with the raw request body echoed. `foundry-sub-editors.tsx:1267-1370` |
| 22 | **Vector query builder** (k-NN / hybrid; text-vectorize or raw embedding; per-query field + k) | ✅ built | ＋Add vector query, kind text/vector, field picker, k; posts `vectorQueries[]`. `foundry-sub-editors.tsx:1312-1358` |
| 22 | Semantic captions / answers rendering | ✅ built | answers card (score + text) + reranker-score column when present. `foundry-sub-editors.tsx:1376-1401` |
| 23 | Create demo app (HTML page) | ❌ MISSING | not present |
| 24 | Debug sessions (visual skillset debugger) | ⚠️ honest-gate | "Not yet wired" row |
| 25 | Analyze text → tokens | ✅ built | Search tab Analyze card → `POST /indexes/{n}/analyze` |

### E. Service administration
| # | Capability | Loom status | Where |
|---|------------|-------------|-------|
| 26 | Overview / Essentials (SKU, replicas, partitions, status, endpoint) | ⚠️ partial | shown on the **separate** `/admin/scaling` page, NOT in the editor; no endpoint/units/metrics at-a-glance |
| 27 | **Scale** (SKU / replicas / partitions) | ✅ built | `/admin/scaling` → `aisearch-client.ts` real `PATCH` ARM |
| 28 | Keys (admin/query, regenerate, auth-mode toggle) | ❌ MISSING | not present (Loom uses AAD/UAMI exclusively) |
| 29 | Identity (managed identity) | ❌ MISSING | not surfaced in UI |
| 30 | Networking (firewall / private endpoints / trusted service) | ❌ MISSING | not surfaced (bicep sets `publicNetworkAccess: disabled` + PE) |
| 31 | Monitoring (QPS / latency / throttling metrics, diagnostics, alerts) | ❌ MISSING | not present |
| 32 | Service statistics / quotas | ❌ MISSING (UI) | `getServiceStats()` exists in client but **no route, no UI consumes it** |

---

## Backend per control (what's actually wired)

All data-plane calls are **real** Azure AI Search REST (`https://<svc>.search.windows.net`,
api-version `2024-07-01`) via `ChainedTokenCredential(UAMI → DefaultAzureCredential)`,
scope `https://search.azure.com/.default`. No mocks.

| Control | Route | Backend call |
|---------|-------|--------------|
| List indexes | `GET /api/ai-search/indexes` | `listIndexes()` → `GET /indexes` ✅ |
| Open index (def+stats) | `GET /api/ai-search/indexes/[name]` | `getIndex` + `getIndexStats` ✅ |
| Save schema | `PUT /api/ai-search/indexes/[name]` | `updateIndex()` → `PUT /indexes/{n}` ✅ |
| Delete index | `DELETE /api/ai-search/indexes?name=` | `deleteIndex()` ✅ |
| Create starter index | `POST /api/ai-search/indexes` | `createIndex()` → `POST /indexes` ✅ |
| Search | `POST /api/ai-search/indexes/[name]/search` | `searchDocuments()` → `POST /docs/search` ✅ |
| Analyze | `POST /api/ai-search/indexes/[name]/analyze` | `analyzeText()` → `POST /analyze` ✅ |
| Indexers list/create/del/run/reset/status | `/api/ai-search/indexers` | `listIndexers/createIndexer/deleteIndexer/runIndexer/resetIndexer/getIndexerStatus` ✅ |
| Data sources | `/api/ai-search/datasources` | `listDataSources/createDataSource/deleteDataSource` ✅ |
| Skillsets | `/api/ai-search/skillsets` | `listSkillsets/createSkillset/deleteSkillset` ✅ |
| Synonym maps | `/api/ai-search/synonymmaps` | `listSynonymMaps/createSynonymMap/deleteSynonymMap` ✅ |
| Aliases | `/api/ai-search/aliases` | `listAliases/createAlias/deleteAlias` ✅ |
| Item bind / create+bind | `/api/items/ai-search-index/[id]/bind` | real REST + Cosmos write ✅ |
| Scale (SKU/replicas/partitions) | `/admin/scaling` | `updateSearchService()` → ARM `PATCH` ✅ |
| Service stats / quotas | — | `getServiceStats()` exists, **no route/UI** ❌ |
| Schedule / field-mappings / reset-docs | — | **no client method** ❌ |

### Honest infra-gate (no-vaporware compliant)
When `LOOM_AI_SEARCH_SERVICE` is unset every route returns
`{ok:false, code:'not_configured', missing:'LOOM_AI_SEARCH_SERVICE'}` (503) and
the navigator renders a single Fluent `MessageBar intent="warning"` naming the
env var, the required roles (Search Service Contributor + Search Index Data
Contributor), and the bicep module. The bind picker still renders so the
operator can set a service. This is correct honest-gate behavior. ✅

### Operational caveat (data-plane reachability)
`ai-search.bicep` provisions the service with `publicNetworkAccess: 'disabled'`
and a private endpoint. The data-plane navigator/editor only works if the
Console Container App egresses on the same VNet/PE; otherwise every data-plane
call (everything except ARM scale) fails at the network layer even when
`LOOM_AI_SEARCH_SERVICE` is set. Not surfaced as a distinct UI message — it
appears as a generic 502/timeout. Worth a dedicated MessageBar.

---

## Grade & rationale

**C (functional but rough).** The backend is genuinely strong and broad — real
data-plane REST for all six object types plus search/analyze/stats and real ARM
scaling, an honest infra-gate, and bicep that deploys it. The navigator tree is
B-grade. But the UI parity bar (per `ui-parity.md`: build the real portal UI
one-for-one, full functionality) is not met on the headline surfaces:

- The portal's **visual index field designer** (the single most-used index UI)
  is replaced by a read-only grid + raw JSON editor — a `ui-parity.md`-forbidden
  "rich surface → JSON textarea" substitution.
- **Search explorer has no Query options**: semantic, vector, queryType,
  highlights, JSON view — all unreachable from the UI, even though the backend
  supports them. This is the second most-used portal tool.
- **No indexer scheduling**, no execution history, no field/output mappings.
- **Import data wizard, Debug sessions, Demo app** are honest-gated or missing —
  these are core portal tools.
- Service admin (Keys, Identity, Networking, Monitoring, service stats) is
  absent from the surface (scale lives on a different page).

It is NOT vaporware (no mocks, real backend, honest gates), so not F/D. It is
not B because too many flagship portal capabilities are JSON-only, gated, or
missing. Conservative grade: **C**.

## Highest-value gaps to close first
1. **Visual index field designer** — per-field add/edit grid with attribute
   checkboxes + analyzer/type pickers (the portal's flagship index UI).
2. **Search explorer Query options** — queryType (simple/full/semantic) picker,
   semantic-config selector, vector-query builder, orderby/searchFields/
   highlights, and a JSON view. Backend already supports it.
3. **Indexer scheduling + execution history** — schedule (interval+start) editor
   and per-run status detail (docs succeeded/failed, warnings, errors).
4. **Semantic configuration + vector profile designers** — promote the two
   "Not yet wired" gates to real designers (still PUT the index def).
5. **Import data wizard** — the no-code datasource→skillset→index→indexer flow
   with chunking + integrated vectorization.
6. **Service stats / quotas panel** — consume the existing `getServiceStats()`
   (add a route) for an Overview/usage surface.
7. **Debug sessions** + **Create demo app** (lower priority preview/utility tools).
