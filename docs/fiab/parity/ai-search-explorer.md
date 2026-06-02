# ai-search-explorer — parity with the Azure AI Search Search Explorer

> Brutally-honest 1:1 parity audit (2026-06-01). Grading per
> `.claude/rules/no-vaporware.md` + `.claude/rules/ui-parity.md`. Graded
> conservatively; when in doubt, graded DOWN.
>
> Scope: the **Search Explorer** query surface (Query options — scoring profiles,
> facets, hit highlighting, semantic, vector) of the AI Search index editor. The
> service-level + index-CRUD audits live in `ai-search.md` / `ai-search-index.md`;
> this doc isolates the query/explore experience deepened in `AiSearchIndexEditor`.

**Source UI (grounded in Microsoft Learn, not memory):**
- Search Explorer (test queries, refine scoring profiles, Query options, JSON view): https://learn.microsoft.com/azure/search/search-explorer
- Search POST (the request all options map to): https://learn.microsoft.com/rest/api/searchservice/documents/search-post
- Hit highlighting (`highlight`, `highlightPreTag`/`highlightPostTag`, `-N` cap, `@search.highlights`): https://learn.microsoft.com/azure/search/search-pagination-page-layout#hit-highlighting
- Scoring profiles (one profile per query, `scoringParameters`): https://learn.microsoft.com/azure/search/index-add-scoring-profiles
- Faceted navigation (`facets` → `@search.facets`): https://learn.microsoft.com/azure/search/search-faceted-navigation
- Semantic ranking in Search Explorer (queryType=semantic, semanticConfiguration, captions/answers): https://learn.microsoft.com/azure/search/semantic-how-to-query-request
- Vector / hybrid query (`vectorQueries`, k, text-vectorization vs raw vector): https://learn.microsoft.com/azure/search/vector-search-how-to-query

**Loom surface:**
- UI: `apps/fiab-console/lib/editors/foundry-sub-editors.tsx` — `AiSearchIndexEditor`
  Search tab (query-options grid, facets, vector-query builder, request-JSON echo,
  results grid with score/reranker/highlights, Analyze-text panel). Field-shape
  helpers in `lib/azure/search-field-shapes.ts`; binding in `lib/azure/search-binding.ts`.
- Client (real REST, no mocks): `apps/fiab-console/lib/azure/search-index-client.ts`.
- BFF: `app/api/ai-search/indexes/[name]` (navigator) and
  `app/api/items/ai-search-index/[id]` (item) — search / analyze / stats / indexers.

**Backend reality check.** "Run query" POSTs to the real index
`POST /indexes/{name}/docs/search`; the editor echoes the exact request body it
sends. Analyze-text calls `POST /analyze`; statistics read the live index stats.
No `return []`, no `MOCK_`, no `useState(SAMPLE)`. Honest gate / `notDeployed`
MessageBar when the service/index isn't reachable.

---

## Azure feature inventory → Loom coverage → backend

Legend: built ✅ · partial ⚠️ · honest-gate ⚠️ · MISSING ❌

### A. Core query options

| # | Search Explorer capability | Loom | Where / backend |
|---|---|---|---|
| A1 | Search text (`search`, `*` = match all) | ✅ built | Search-text input → `search` |
| A2 | **queryType**: simple / full (Lucene) / semantic | ✅ built | queryType dropdown |
| A3 | searchMode: any (OR) / all (AND) | ✅ built | searchMode dropdown → `searchMode` |
| A4 | searchFields (restrict matched fields) | ✅ built | input → `searchFields` |
| A5 | filter (OData) | ✅ built | input → `filter` |
| A6 | select (returned fields) | ✅ built | input → `$select` |
| A7 | orderby | ✅ built | input → `$orderby` |
| A8 | top (page size) | ✅ built | number → `$top` |
| A9 | count (return total match count) | ✅ built | checkbox → `$count`; total shown in results header |
| A10 | **JSON view** (paste full request) | ⚠️ partial | request body is **echoed** (read-only); not an editable paste-JSON box |
| A11 | skip / paging next-page | ❌ MISSING | single page (top only) |
| A12 | minimumCoverage / sessionId / scoringStatistics | ❌ MISSING | not surfaced |

### B. Scoring profiles

| # | Search Explorer capability | Loom | Where / backend |
|---|---|---|---|
| B1 | Pick a scoring profile (from the index's profiles) | ✅ built | dropdown seeded by `scoringProfileNames(idx)`; `(default ranking)` option |
| B2 | scoringParameters (name-values, one per line) | ✅ built | textarea → `scoringParameters[]` (only sent when a profile is chosen) |
| B3 | Honest note when index has no scoring profiles | ✅ built | "author one in Schema → Advanced JSON" caption |
| B4 | **Author / edit** a scoring profile (weights, functions, magnitude/freshness/distance/tag) | ⚠️ partial | edit via the Schema → Advanced-JSON editor; no visual scoring-profile designer |

### C. Faceting

| # | Search Explorer capability | Loom | Where / backend |
|---|---|---|---|
| C1 | Select facetable fields to bucket by | ✅ built | checkbox set from `facetableFieldNames(idx)` → `facets` |
| C2 | Render returned facets | ✅ built | `@search.facets` shown as `field [value:count, …]` |
| C3 | Facet **parameters** (count:N, sort, interval, values) | ❌ MISSING | bare field name only |
| C4 | Click-a-facet to drill (apply as filter) | ❌ MISSING | display only; no click-to-filter |

### D. Hit highlighting

| # | Search Explorer capability | Loom | Where / backend |
|---|---|---|---|
| D1 | highlight fields (comma-separated; `-N` cap) | ✅ built | input → `highlight`; only valid searchable string fields hinted |
| D2 | Custom highlightPreTag / highlightPostTag | ✅ built | tag inputs (only sent when non-default) |
| D3 | Render `@search.highlights` as bolded snippets | ✅ built | `renderHighlights` in the Highlights column |

### E. Semantic

| # | Search Explorer capability | Loom | Where / backend |
|---|---|---|---|
| E1 | semanticConfiguration picker (or name one) | ✅ built | dropdown from `semanticConfigNames(idx)` / free-text fallback |
| E2 | answers (extractive) toggle | ✅ built | checkbox → semantic answers; rendered with score |
| E3 | captions (extractive) toggle | ✅ built | checkbox → semantic captions |
| E4 | Reranker score column | ✅ built | `@search.rerankerScore` column when present |
| E5 | Author / edit a **semantic configuration** (title/content/keyword fields) | ⚠️ partial | via Schema → Advanced-JSON; no visual semantic-config designer |
| E6 | semanticQuery (distinct from search text) | ❌ MISSING | portal also omits this — parity-neutral |

### F. Vector / hybrid

| # | Search Explorer capability | Loom | Where / backend |
|---|---|---|---|
| F1 | Vector-query builder rows | ✅ built | add/remove `vectorQueries[]` |
| F2 | text (integrated vectorization) vs vector (raw embedding) | ✅ built | kind dropdown |
| F3 | Vector field picker (from the index's vector fields) | ✅ built | dropdown from `vectorFieldNames` |
| F4 | k (nearest neighbors) | ✅ built | number → `k` |
| F5 | Hybrid (vector + text in one query) | ✅ built | vector rows ride alongside `search` text |
| F6 | exhaustive / weight / oversampling / threshold per vector query | ❌ MISSING | kind/field/k only |

### G. Results & inspection

| # | Search Explorer capability | Loom | Where / backend |
|---|---|---|---|
| G1 | Results grid (score + retrievable fields) | ✅ built | first 6 retrievable fields + `@search.score` |
| G2 | Result/total count header | ✅ built | "Results (N of total)" |
| G3 | Echo the exact request body sent | ✅ built | request-JSON block under the form |
| G4 | **Analyze text** (tokens for an analyzer) | ✅ built | Analyze panel → `POST /analyze` |
| G5 | Full document JSON expand / copy a result | ⚠️ partial | cells truncate at 80 chars; no per-doc expand/copy |
| G6 | autocomplete / suggestions test | ❌ MISSING | not surfaced |

---

## Coverage tally

- **built ✅: 27**
- **partial ⚠️: 5**
- **honest-gate ⚠️: 0** (only the service/index `notDeployed` gate)
- **MISSING ❌: 9**

## Honest grade: **B+**

This is a genuinely **production-grade** Search Explorer and the deepest query
surface in the catalog: every Query-option category the portal exposes is present
and wired to a real `POST …/docs/search` — **queryType** (simple/full/semantic),
searchMode/searchFields/filter/select/orderby/top/count, **scoring profile +
scoringParameters**, **facets**, **hit highlighting with custom tags**, **semantic
config + answers/captions + reranker score**, and a full **vector/hybrid query
builder**. It even echoes the exact request body (the portal's JSON-view value) and
ships an Analyze-text tool. **No vaporware** — pickers are seeded from the live index
definition (real semantic configs, vector profiles, scoring profiles, facetable
fields). This is the surface verified live in the master scorecard.

Held to **B+** (not A) by `ui-parity.md`'s completeness bar: the JSON view is
**read-only** (echo, not an editable paste box), there's **no paging/skip**, facets
have **no parameters or click-to-drill**, vector queries lack **weight/threshold/
exhaustive**, results have **no per-doc JSON expand/copy**, and the **scoring-profile
and semantic-config *designers*** are JSON-only (authored in Schema → Advanced) — a
soft `ui-parity` "rich surface → JSON" pressure point, though the Search Explorer
itself in the portal also points you to JSON view for those.

## Highest-value gaps to build first

1. **Editable JSON view** (A10) — let the user paste/edit the full request, not just
   read the echo.
2. **Paging** (A11) — skip + next-page.
3. **Facet parameters + click-to-drill** (C3–C4).
4. **Per-doc JSON expand/copy** (G5).
5. **Visual scoring-profile + semantic-config designers** (B4 / E5).
6. **Vector weight/threshold/exhaustive** (F6).

## Backend per control

| Control | BFF route | Search endpoint |
|---|---|---|
| Run query | `…/docs/search` via `/api/ai-search/indexes/[name]` or `/api/items/ai-search-index/[id]` | `POST /indexes/{name}/docs/search` |
| Analyze text | same surface | `POST /indexes/{name}/analyze` |
| Statistics | item/navigator detail | index stats (`documentCount`, `storageSize`, `vectorIndexSize`) |
| Field designer + Save | `PUT /indexes/{name}` | index create-or-update |
| Indexers list/run | `…/indexers` | indexers REST |

## Bicep / env sync

- Env vars consumed: the AI Search service name/endpoint (per `ai-search.md`'s
  `LOOM_AI_SEARCH_*`). Auth keys-only in the live deployment (per the navigators-live
  note).
- Role: keys or `Search Index Data Reader/Contributor` on the service.
- No new Cosmos container.

## Verification

- Per `no-vaporware.md`: Run query / Analyze hit real Search REST; pickers seeded
  from the live index definition.
- Live `pnpm uat` / Playwright: the field designer + search explorer were verified
  **live** against the deployed console (real index fields) per the master scorecard.
  The MISSING/partial rows here were derived from code; confirm the remaining gaps
  against the live portal per the no-scaffold rule.
