# Loom Vector Store Editor — Fabric-parity spec

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


> Captured 2026-05-26 by catalog agent. Sources: Microsoft Learn — [Create a vector index in Azure AI Search](https://learn.microsoft.com/azure/search/vector-search-how-to-create-index), [Vector search in Azure Cosmos DB for NoSQL](https://learn.microsoft.com/azure/cosmos-db/vector-search), [Indexing policies — vector indexes](https://learn.microsoft.com/azure/cosmos-db/index-policy#vector-indexes), [Manage indexing policies — vector examples](https://learn.microsoft.com/azure/cosmos-db/how-to-manage-indexing-policy#vector-indexing-policy-examples), [Compress vectors with scalar/binary quantization](https://learn.microsoft.com/azure/search/vector-search-how-to-quantization), [Integrated vectorization](https://learn.microsoft.com/azure/search/search-how-to-integrated-vectorization), [Create a vector query](https://learn.microsoft.com/azure/search/vector-search-how-to-query), [.NET / JS / Java vector quickstarts](https://learn.microsoft.com/azure/cosmos-db/how-to-dotnet-vector-index-query). Cross-checked against current Loom editor at `apps/fiab-console/lib/editors/graph-editors.tsx::VectorStoreEditor`.

## What it is

A **vector store** holds float embeddings and serves approximate-nearest-neighbor (ANN) similarity queries. Loom supports three backends, each backed by a different Azure managed service:

1. **Azure AI Search vector profile** — `Collection(Edm.Single)` field on a search index with `vectorSearch.algorithms` (HNSW or exhaustiveKnn), `vectorSearch.compressions` (scalar or binary quantization), and `vectorSearch.profiles` linking the two. Provisioned via `PUT /indexes/{name}?api-version=2026-04-01`.
2. **Azure Cosmos DB for NoSQL vector index** — container-level **vector embedding policy** (path, datatype Float32, dimensions, distanceFunction Cosine|DotProduct|Euclidean) PLUS **vector indexing policy** (`vectorIndexes`: `flat` ≤505 dim, `quantizedFlat` ≤4096 dim, `diskANN` ≤4096 dim). Queried with `SELECT TOP N c.*, VectorDistance(c.vector, [...]) FROM c ORDER BY VectorDistance(...)`. Requires the **EnableNoSQLVectorSearch** capability.
3. **Azure SQL Database 2025 vector index** — Loom already has a dedicated `sql-server-2025-vector-index` editor; the generic `vector-store` editor lists it as a fourth backend option for completeness. Not detailed below (covered by its own spec).

Plus the Loom-original **pgvector** option (PostgreSQL `CREATE INDEX ... USING ivfflat (vec vector_cosine_ops)`) for non-Microsoft-stack symmetry — supported but not Fabric-parity-relevant.

## UI components

### Page chrome
- Title bar: vector-store name + saved-state indicator + backend Badge (AI Search / Cosmos vCore / Cosmos NoSQL / pgvector / SQL2025)
- Top toolbar: **Create index**, **Test similarity**, **Drop index**, **Refresh stats**, **Settings**

### Left pane — Configuration form
- **Backend** dropdown (ai-search / cosmos-nosql / cosmos-vcore / pgvector / sql-2025) — drives the rest of the form
- **Index name** (AI Search) / **Container name + path** (Cosmos NoSQL) / **Collection name** (Cosmos vCore) / **Table + column name** (pgvector / SQL 2025)
- **Dimensions** (numeric; 1536 default for text-embedding-ada-002, 3072 max for text-embedding-3-large)
- **Distance metric** dropdown (cosine / dotProduct / euclidean / hamming for AI Search binary)
- **Algorithm** dropdown — backend-dependent:
  - AI Search: `hnsw` (m, efConstruction, efSearch) or `exhaustiveKnn`
  - Cosmos NoSQL: `flat` (≤505 dim) or `quantizedFlat` (≤4096) or `diskANN` (≤4096, recommended >50 K vectors)
  - Cosmos vCore: `vector-ivf` or `vector-hnsw`
- **Compression** dropdown (AI Search only): none / scalarQuantization (int8) / binaryQuantization, plus oversampling factor + rescoring toggle
- **Integrated vectorization** toggle (AI Search only) — when on, attach an Azure OpenAI vectorizer or Azure Vision vectorizer with a model + deployment + auth method picker; result: query-time text → vector with no client-side embedding

### Main pane — three tabs

#### Tab 1: Schema preview
- Generated JSON for the chosen backend (PUT body for AI Search, container policy for Cosmos NoSQL, CREATE INDEX DDL for pgvector / SQL 2025)
- Side panel showing the documented limits inline: 505 / 4096 dim caps, 1000-vector minimum for quantizedFlat / diskANN accuracy, HNSW m default 4 (range 4-10), efConstruction default 400 (range 100-1000)
- Copy-to-clipboard button per language (REST, .NET, JavaScript, Python, Java) using the documented quickstart snippets

#### Tab 2: Insert / Test similarity
- **Insert vectors** — repeating row editor (`id`, `content`, `vector: number[]`) OR file-upload for batch JSONL
- **Test similarity** — query embedding input (paste JSON array OR — if integrated vectorization is on — paste text and let the vectorizer encode), top-K input (default 10), optional filter (`category eq 'X'` for AI Search; `WHERE c.category = 'X'` for Cosmos NoSQL)
- Result table: `id | content | similarity score | distance`
- Inline RU / latency / "did the search use the vector index or fall back to full-scan?" diagnostic (Cosmos NoSQL diagnostic header `x-ms-cosmos-query-vector-search-used-index`)

#### Tab 3: Stats / health
- Vector count, index size on disk, last refresh
- Average query latency p50/p95/p99
- Index build progress (AI Search shows indexer-status; Cosmos NoSQL shows "ANN warmup" progress)

## What Loom has

The current `VectorStoreEditor` (`apps/fiab-console/lib/editors/graph-editors.tsx`, lines 218-291) is config-only:

- Backend dropdown — three options (`ai-search`, `cosmos-vcore`, `pgvector`). **Cosmos NoSQL vector index is missing** (the documented Microsoft-recommended path for transactional + vector workloads is not in the picker)
- Index-name + dimensions + metric inputs
- A `MessageBar intent="info"` listing the three PUT/createIndex code snippets — explicitly says *"v3 persists the index spec. Live creation hits backend REST in v3.x."*
- **Persist index spec** button POSTing to `/api/items/vector-store` (generic createOwnedItem) — saves to Cosmos but does not provision a backend resource
- **Similarity test (v3.x)** button — disabled (honest)
- Ribbon advertises **Create** and **Test similarity** ribbon actions but they are placeholders
- Grade: **D (stubbed)** — config persists, no backend provisioning, no insert / query path

## Gaps for parity

1. **Cosmos NoSQL backend option missing** — Microsoft's documented first-class Cosmos vector path (with `flat` / `quantizedFlat` / `diskANN` index choices) is absent. Currently Loom only offers `cosmos-vcore` (Mongo API).
2. **Live index creation absent** — the **Persist index spec** button saves to Loom Cosmos but does not call the backend REST. The infobar admits this honestly.
3. **Algorithm tuning absent** — HNSW `m / efConstruction / efSearch` not exposed; Cosmos NoSQL `flat vs quantizedFlat vs diskANN` not exposed.
4. **Compression / quantization absent** — AI Search scalarQuantization / binaryQuantization with oversampling + rescoring is the documented production pattern; not in Loom.
5. **Integrated vectorization toggle absent** — Azure OpenAI vectorizer / Azure Vision vectorizer wiring is the documented end-to-end RAG pattern; the editor doesn't surface it.
6. **Insert vectors editor absent** — no row editor, no JSONL upload.
7. **Test similarity absent** — the button is disabled.
8. **Limits-aware lint absent** — 505 dim flat-index cap, 4096 dim cap for quantized/diskANN, 1000-vector minimum for accurate quantization — none surfaced as inline warnings when the form's dimension value would violate them.
9. **Filter pre-flight absent** — vector searches need a `TOP N` per Cosmos docs (otherwise RU blows up); pgvector similarly needs a `LIMIT`; not enforced.
10. **Stats tab absent** — no vector count, no p95 latency, no "used index" diagnostic.
11. **Drop-index path absent** — Cosmos vector policies are **immutable post-create** per the docs; Loom needs to surface a "create new container" workflow rather than pretending to edit.
12. **AAD auth path absent** — defaults to admin API key for AI Search and master key for Cosmos; the documented recommended "Search Service Contributor + Search Index Data Contributor" RBAC roles for keyless auth are not wired.
13. **Code-snippet copy buttons absent** — the editor shows three lines of pseudo-code; the documented .NET / JS / Java quickstart bodies aren't copy-able.

## Backend mapping

| Loom surface | Backing service | Notes |
|---|---|---|
| AI Search index create | `PUT https://{search}.search.windows.net/indexes/{name}?api-version=2026-04-01` with `vectorSearch.profiles + algorithms + compressions` | New BFF route `/api/items/vector-store/[id]/provision`; auth via UAMI with Search Service Contributor |
| Cosmos NoSQL vector container create | `Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers` ARM PUT with `vectorEmbeddingPolicy + indexingPolicy.vectorIndexes`; requires `EnableNoSQLVectorSearch` account capability | Use existing `lib/azure/cosmos-client.ts` ARM path |
| Cosmos vCore (Mongo) index create | Existing Mongo client `db.collection.createIndex({ vec: 'cosmosSearch', similarity: 'COS', dimensions: 1536 })` | Already partially modeled in the editor's MessageBar |
| pgvector index | `CREATE EXTENSION IF NOT EXISTS vector; CREATE INDEX ... USING ivfflat (vec vector_cosine_ops) WITH (lists = 100)` | Reuses existing `flexible-postgres-client.ts` if present, or new client |
| AI Search vectorizer attach | `vectorSearch.vectorizers` element with `kind: "azureOpenAI"` + endpoint + deployment + authIdentity | Same PUT call; requires Foundry hub AOAI deployment |
| Insert vectors (AI Search) | `POST /indexes/{name}/docs/index?api-version=...` with `@search.action: "upload"` body | Already supported by Loom's existing AI Search index editor |
| Insert vectors (Cosmos NoSQL) | Standard `container.items.upsert({id, content, vector: [...]})` | Reuses cosmos-client |
| Test similarity (AI Search) | `POST /indexes/{name}/docs/search` body `{ vectorQueries: [{ kind: "vector", vector: [...], fields: "contentVector", k: 10 }] }` OR with integrated vectorization: `{ vectorQueries: [{ kind: "text", text: "...", fields: "contentVector", k: 10 }] }` | Stable 2026-04-01 API |
| Test similarity (Cosmos NoSQL) | `SELECT TOP @k c.id, c.content, VectorDistance(c.vector, @query) AS s FROM c ORDER BY VectorDistance(c.vector, @query)` | Parameterized query; the `TOP N` is mandatory per the docs |
| Stats | AI Search `/indexes/{name}/stats`; Cosmos NoSQL via account metrics + per-query response headers | Both already plumbed via existing clients |
| Persistence of the index spec for audit | Cosmos `items` container, partition `vector-store` (already implemented) | Add `lastProvisionedAt`, `backendResourceId`, `dimensions`, `metric`, `algorithm` to the persisted state |

## Required Azure resources

- **Azure AI Search service** (Standard or higher; Basic supports vectors but rate-limited). Already in `platform/fiab/bicep/modules/ai-search/` if any RAG template has been instantiated.
- **Azure Cosmos DB account** with `EnableNoSQLVectorSearch` capability (`az cosmosdb update --capabilities EnableNoSQLVectorSearch`) — the existing Loom Cosmos account needs the flag added in bicep
- **Azure Cosmos DB for MongoDB vCore** cluster (for the vCore backend option) — separate resource type; deploy via `platform/fiab/bicep/modules/cosmos-vcore/`
- **Azure Database for PostgreSQL Flexible Server** with `azure.extensions = vector` server parameter (for pgvector) — already in bicep for the apim-product templates
- **AAD role assignments** for keyless auth:
  - AI Search: `Search Service Contributor` + `Search Index Data Contributor` on the search service for the Loom UAMI
  - Cosmos NoSQL: `Cosmos DB Built-in Data Contributor` data-plane role + `Cosmos DB Account Reader` control-plane
- **Azure OpenAI deployment** of an embedding model (`text-embedding-3-small` / `-large` / `ada-002`) on the Foundry hub (already deployed) — needed for integrated-vectorization wiring
- **No tenant-level admin step** beyond enabling the `EnableNoSQLVectorSearch` capability on the Cosmos account

## Estimated effort

- **Session N+1 (~2 hrs)** — add Cosmos NoSQL to the backend picker; replace the three-option dropdown with a typed `BackendKind` enum; render conditional field sets per backend
- **Session N+2 (~3 hrs)** — live provisioning for AI Search and Cosmos NoSQL backends (new BFF route + ARM/control-plane calls); honest MessageBar when the user lacks RBAC
- **Session N+3 (~3 hrs)** — Insert vectors editor (row + JSONL upload) + Test similarity execution + result table with similarity score + "used index" diagnostic
- **Session N+4 (~2 hrs)** — Algorithm tuning panel (HNSW m / ef params for AI Search; flat / quantizedFlat / diskANN for Cosmos), compression / quantization, integrated-vectorization wizard
- **Session N+5 (~2 hrs)** — Stats / health tab; limits-aware lint; immutability honesty message ("Cosmos vector policies are immutable — create new container to change algorithm"); AAD keyless auth path
- **Session N+6 (~1 hr)** — copy-able code snippets per .NET / JS / Java / Python from the documented quickstarts; Vitest + Playwright

Total: **~13 hrs** across 6 sessions. Current grade: **D**. Target: **A+** — vector-store is a high-leverage editor because it underpins the RAG template; getting it to A+ unlocks the documented end-to-end RAG pattern.
