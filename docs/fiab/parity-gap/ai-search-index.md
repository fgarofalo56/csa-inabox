# ai-search-index — parity gap (validator v2, 2026-05-26)

**Loom URL**: `/items/ai-search-index/new`
**Fabric reference**: portal.azure.com → Cognitive Search → Indexes (Fields tab with attribute switches per field)
**Loom screenshot**: `temp/parity/ai-search-index-loom.png`

## Phase 4

| Route | Status | Notes |
|---|---|---|
| `GET /api/items/ai-search-index` | 200 | **5 real indexes** on `dlz-aisearch-dev-eastus2`: `loom-items` (9 fields), `research-knowledge-index` (6), `simplechat-group-index` (21), `simplechat-public-index` (20), `simplechat-user-index` (21) |
| `GET /api/items/ai-search-index/loom-items` | 200 | Real OData payload with full field schema, defaultScoringProfile, suggesters, analyzers, etc. |
| `POST /api/items/ai-search-index/<id>/search` | wired | — |

The "new" route renders a list table (Name · Fields) with the 5 real indexes. When an existing index is opened, the editor shows the index name, a Query input, and a `<pre>` block with full JSON of the index schema.

## Phase 3 — Fabric vs Loom

| Azure Portal AI Search Index element | Loom present? | Severity |
|---|---|---|
| **Fields DataGrid with attribute switches per field** (searchable · filterable · sortable · facetable · retrievable · key · analyzer) | **NO — Loom shows the entire schema as raw JSON in a `<pre>` block** | **BLOCKER** |
| **Add field / Edit field dialog** (type · attributes · analyzer dropdown · vector config) | NO | BLOCKER |
| **Vector configuration panel** (algorithm: HNSW/exhaustive, m, efConstruction, dimensions, profile) | NO | MAJOR |
| **Scoring profile editor** (term boost, function score, parameters) | NO | MAJOR |
| **Suggesters / Analyzers** | NO | MAJOR |
| Search Explorer UX (query · top · select · filter · orderby · facets · highlights) | partial — single Query input, no operator hints | MAJOR |
| Result table with JSON expand per row + facet panel | NO — Loom dumps JSON in a `<pre>` | MAJOR |
| Indexer wiring + skillset run history | **NO — there is no ai-search-skillset editor at all in registry** | BLOCKER (registry gap) |
| Stats: doc count, storage size, last index time | NO | MAJOR |

## Functional

- List of indexes renders real data (5 indexes)
- Detail page dumps schema as raw JSON
- Search button POSTs to BFF (route exists, not exercised live)

## Grade — **F**

Backing routes are excellent — list + detail + search all return real Azure data. But the editor is essentially a **JSON pretty-printer with a search box**. Zero of the per-field attribute switches that define the Portal's Index editor. No skillset editor exists at all (the prompt warned this; confirmed). **Grade F.**

> Note: this matches the "AI Search Index: fields DataGrid with attribute switches per field?" critical check. Answer: **no, JSON blob.**
