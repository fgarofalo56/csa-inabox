# Loom AI Search Index Editor — Fabric-parity build spec

> Reference: Microsoft Learn — *Search indexes in Azure AI Search* (`/azure/search/search-what-is-an-index`), *Create a vector index in Azure AI Search* (`/azure/search/vector-search-how-to-create-index`), *Add scoring profiles to boost search scores* (`/azure/search/index-add-scoring-profiles`), *Use scoring profiles with semantic ranker* (`/azure/search/semantic-how-to-enable-scoring-profiles`), *Analyzers for text processing* (`/azure/search/search-analyzers`), REST API `/rest/api/searchservice/indexes/create-or-update` (api-version `2026-04-01`). Documented 2026-05-26 by catalog agent.

## Overview

An Azure AI Search **index** is the schema + physical store that holds `documents` — JSON records broken into typed `fields`, each with per-attribute switches that decide how the field participates in queries. The index sits behind a search service (`https://{svc}.search.windows.net`), is loaded by either pushing JSON or pulling via an **indexer + data source + skillset**, and is queried via Lucene full text, vector similarity (HNSW / KNN), hybrid (RRF-fused), and semantic L2 reranking. The index ships alongside `analyzers` (linguistic tokenizers), `scoringProfiles` (boost rules), `suggesters` (autocomplete prefix structures), `corsOptions` (browser callers), `semantic` (L2 reranker config), `vectorSearch` (algorithms + compressions + profiles), and an optional `encryptionKey` (CMK double-encryption).

In the Azure portal the index opens under the AI Search resource → **Indexes** → click an index name. The page is a tabbed surface with the schema on the left and a query playground / inspector on the right.

## AI Search Index UX inventory

### Page chrome
- Page title shows the index name · doc count · storage size · field count
- Top action bar: **Edit JSON**, **Search explorer**, **Delete index**, **Rebuild** (deletes + recreates from JSON), **Refresh**
- Status chips: `Service tier` (basic/S1/S2/S3/L1/L2), `Replicas`/`Partitions` from parent service, `API version` selector

### Tab — Fields
DataGrid (one row per field) with these per-column controls:
| Column | Type | Notes |
|---|---|---|
| **Name** | text | Up to 128 chars; first char letter; sub-fields via dot notation for `Collection(Edm.ComplexType)` |
| **Type** | dropdown | `Edm.String`, `Edm.Int32`, `Edm.Int64`, `Edm.Double`, `Edm.Boolean`, `Edm.DateTimeOffset`, `Edm.GeographyPoint`, `Edm.ComplexType`, `Collection(...)` of any of the above, `Collection(Edm.Single)` for vector |
| **Key** | checkbox | Exactly one per index. Must be `Edm.String`. |
| **Retrievable** | checkbox | Returned in `select` |
| **Searchable** | checkbox | Indexed for full-text. Strings only. Triggers analyzer chain. |
| **Filterable** | checkbox | Enables `$filter` |
| **Sortable** | checkbox | Enables `$orderby`. Not allowed on collections. |
| **Facetable** | checkbox | Enables `$facet` aggregation |
| **Analyzer** | dropdown | Per-field analyzer — `standard.lucene`, `keyword`, `whitespace`, 50+ language analyzers (`en.microsoft`, `en.lucene`, `de.microsoft`, …), or a custom analyzer name |
| **Search/Index analyzer split** | dropdown | Different analyzer at query time vs index time |
| **Normalizer** | dropdown | For filterable/sortable/facetable strings — lowercases / asciifolding without tokenizing |
| **Synonym maps** | multi-select | Names of synonym maps attached to the field |
| **Dimensions** | number | Vector fields only — embedding vector length |
| **Vector profile** | dropdown | Vector fields only — links to `vectorSearch.profiles[].name` |
| **Stored** | checkbox | Vector fields — set false to drop the raw vector from storage after indexing (saves space) |

Add row, delete row, drag-to-reorder. JSON-view toggle for raw editing. Field-level validation banner ("Vector fields can't be filterable/sortable/facetable").

### Tab — Scoring profiles
- List of profiles. Per profile:
  - **Name** input
  - **Text weights** DataGrid (field → weight number)
  - **Functions** repeater — type dropdown (`magnitude`, `freshness`, `distance`, `tag`), field name, boost number, interpolation (`linear`, `constant`, `quadratic`, `logarithmic`), function-specific params (boostingRangeStart/End, boostingDuration, referencePointParameter, tagsParameter)
  - **functionAggregation** dropdown (`sum`, `average`, `minimum`, `maximum`, `firstMatching`)
- **Default scoring profile** dropdown at index level
- Up to 100 profiles per index

### Tab — Suggesters
- One suggester per index (current limit). Inputs:
  - **Name** input
  - **Source fields** multi-select of `Edm.String` searchable fields
  - **searchMode** = `analyzingInfixMatching` (only supported mode currently)
- Backs the `/docs/suggest` and `/docs/autocomplete` endpoints

### Tab — CORS
- **Allowed origins** repeater of strings (`https://*.contoso.com` or `*`)
- **Max age** number (seconds)
- MessageBar: "CORS is only relevant for browser-direct queries; server-side callers ignore it."

### Tab — Semantic configurations
- Repeater of named configs. Per config:
  - **Name** input
  - **Title field** dropdown (single `Edm.String`)
  - **Content fields** ordered list (priority-ranked)
  - **Keyword fields** ordered list
  - **rankingOrder** dropdown — `boostedRerankerScore` (default) / `reRankerScore`
- MessageBar gating availability behind a Standard tier service in a supported region

### Tab — Vector configuration
- **Algorithms** repeater — per-algorithm:
  - **Name** input
  - **Kind** dropdown — `hnsw` or `exhaustiveKnn`
  - HNSW params: `m`, `efConstruction`, `efSearch`, `metric` (`cosine`/`dotProduct`/`euclidean`/`hamming`)
- **Compressions** repeater — per-compression:
  - **Name** input
  - **Kind** dropdown — `scalarQuantization` / `binaryQuantization`
  - **rescoringOptions** — `enableRescoring` toggle, `defaultOversampling` number, `rescoreStorageMethod`
  - **truncationDimension** number (optional)
- **Profiles** repeater — name + algorithm ref + compression ref + vectorizer ref
- **Vectorizers** repeater — query-time embedding model. Kind = `azureOpenAI` / `aml` / `customWebApi` / `aiServicesVision`. Per-kind: endpoint, deployment id, model name, auth (apiKey / managedIdentity)

### Tab — JSON editor
Monaco editor over the full index definition. Useful for advanced edits not exposed in the structured forms; PUT-saves via `Create or Update Index` REST.

### Tab — Search explorer (right pane on detail view)
- Query input (Lucene syntax + queryType dropdown `simple` / `full` / `semantic`)
- API version dropdown
- `$select`, `$filter`, `$orderby`, `$top`, `$skip` inputs
- Vector query JSON editor (kind `vector` + value or vectorizable text)
- **Run** button → JSON result viewer

### Encryption (separate panel)
- **encryptionKey** form — Key Vault URI, key name, key version, identity (system-assigned MI / user-assigned MI / app registration). Used for CMK double-encryption beyond MS-managed keys.

---

## What Loom has today

Loom's `AiSearchIndexEditor` (`apps/fiab-console/lib/editors/foundry-sub-editors.tsx` line 488) is **A-grade** for read-only inspection + ad-hoc search:

- List view at `/api/items/ai-search-index` enumerates real indexes via the Azure AI Search REST `GET /indexes`
- Detail view dumps the live index JSON definition in a read-only `<pre>` block
- Toolbar has a single **Query** input and **Search** button that POSTs to `.../[id]/search` and renders raw JSON hits
- Backend persists the Loom item shell in Cosmos and routes the live calls to the AI Search service via the existing `cognitive-services` route helper

Critically present: **real backend wiring, real REST calls, no mocks** — the editor already passes the no-vaporware bar. Critically missing: **no edit affordances at all**. Users cannot add fields, change attributes, define a scoring profile, configure semantic, or set up vector search from the Loom UI. Everything past inspection requires the Azure portal or a `Create or Update Index` REST call.

## Gaps for parity

1. **Fields DataGrid** — replace the JSON `<pre>` with a typed, sortable DataGrid. Add row / delete row / drag-to-reorder. Per-row checkboxes for key/retrievable/searchable/filterable/sortable/facetable + analyzer dropdown + normalizer dropdown + synonym map multi-select. Type-dependent column disabling (vector fields lock out filterable/sortable/facetable).
2. **Vector-field affordances** — dimensions input, vector-profile dropdown, `stored` toggle. Validate dimensions against the bound embedding model.
3. **Scoring profiles tab** — full CRUD repeater with text weights + functions (magnitude/freshness/distance/tag) and interpolation/aggregation pickers. Save back via `PUT /indexes/{name}`.
4. **Suggesters tab** — single-suggester form (name + source fields multi-select).
5. **CORS tab** — origins repeater + maxAge input.
6. **Semantic configurations tab** — repeater with title/content/keyword field pickers + rankingOrder dropdown. Tier/region gate via MessageBar.
7. **Vector configuration tab** — algorithms (HNSW params), compressions (scalar / binary quant + rescoring), profiles (algo+compression+vectorizer link), vectorizers (Azure OpenAI / AML / Custom Web API / Vision).
8. **JSON editor mode toggle** — Monaco fallback for users who want raw control.
9. **Search explorer enhancements** — queryType dropdown (simple/full/semantic), `$select`/`$filter`/`$orderby`/`$top` inputs, vector query JSON editor, API version picker, score breakdown rendering (`@search.score`, `@search.rerankerScore`, `@search.rerankerBoostedScore`).
10. **Encryption panel** — Key Vault key picker + identity selector for CMK.
11. **Doc count + storage size badges** in the page chrome (read from `GET /indexes/{name}/stats`).
12. **Rebuild button** — confirms destructive action, calls `DELETE /indexes/{name}` then `POST /indexes` with the edited body. Required for breaking-schema changes Azure rejects on update.
13. **Indexer/datasource cross-link** — surface "this index is loaded by indexer X using datasource Y, skillset Z" with deep-links to those Loom items. Today the index page has no awareness of its loaders.

## Backend mapping

| AI Search concept | Loom backend |
|---|---|
| List indexes | ✅ `GET /api/items/ai-search-index` → AI Search `GET /indexes?api-version=2026-04-01` |
| Get index definition | ✅ `GET /api/items/ai-search-index/[id]` → `GET /indexes/{name}` |
| Search documents | ✅ `POST /api/items/ai-search-index/[id]/search` → `POST /indexes/{name}/docs/search` |
| Create / update index | **NEW** `PUT /api/items/ai-search-index/[id]` → `PUT /indexes/{name}?allowIndexDowntime=true&api-version=2026-04-01`. Validate body server-side. Return Azure's 400 with field-pointer when schema breaks. |
| Delete index | **NEW** `DELETE /api/items/ai-search-index/[id]` → `DELETE /indexes/{name}` |
| Get stats (doc count, storage) | **NEW** `GET /api/items/ai-search-index/[id]/stats` → `GET /indexes/{name}/stats` |
| List analyzers (built-in catalog) | **NEW** static enum in Loom (~70 values) — no REST equivalent; populate dropdown from a versioned constant. |
| List synonym maps | **NEW** `GET /api/items/ai-search-synonym-map` → `GET /synonymmaps` |
| Suggest / autocomplete (explorer) | **NEW** `POST .../[id]/suggest` / `.../[id]/autocomplete` → corresponding REST verbs |
| Auth | Existing — Loom's `cognitive-services` helper mints either a search admin key (from KV) or AAD token against `https://search.azure.com/.default` via the deployment SP / managed identity |

## Required Azure resources

- ✅ **Azure AI Search service** (already in bicep — `platform/fiab/bicep/modules/ai-search.bicep`). Tier must be Standard or above for semantic ranker; Free/Basic blocks the semantic tab with a MessageBar.
- ✅ **Search admin key in Key Vault** or **Search Index Data Contributor** + **Search Service Contributor** role assignments to Loom's MI (already wired by the bootstrap workflow)
- **Optional**: Azure OpenAI account (for `azureOpenAI` vectorizer) — already deployable via the foundry-hub bicep
- **Optional**: User-assigned Managed Identity for Search → KV CMK + AOAI access (already part of the keyless-by-default bicep stance)

## Estimated effort

**2 focused sessions.**

- **Session 1 (~3h):** Backend — `PUT /api/items/ai-search-index/[id]` with schema validator, `DELETE`, `/stats`, synonym-map list. Wire the existing AI Search auth helper. Add Cosmos shadow that records the last-saved schema for diffing (read-only audit; the live schema is the source of truth).
- **Session 2 (~3h):** Frontend — Fields DataGrid · Scoring profiles tab · Semantic config tab · Vector configuration tab · Suggesters · CORS · Encryption · enhanced Search explorer · Rebuild button with confirm dialog · Indexer cross-link callout. JSON editor stays available behind a toggle.

Drops Loom AI Search Index from **A (read-only, real)** to **A+ (full CRUD on schema, semantic + vector configurable, scoring profile editor, no portal trips needed)**.
