# Parity Gap — Graph + Vector Knowledge Stores (v2 validator, 2026-05-26)

> Editors: `cosmos-gremlin-graph` / `cypher-graph` / `gql-graph` / `vector-store`
> Source: `apps/fiab-console/lib/editors/graph-editors.tsx` (395 lines)
> Validator state: source-grade audit. Phase 4 live click blocked by MFA expiration. Cosmos Gremlin Vertices/Edges button wiring confirmed in source (v3.27 fix).

## Critical request checks

- **"Cosmos Gremlin: Vertices/Edges buttons WORK"** — Confirmed in source (lines 127-128, 159-160). Both `showVertices` and `showEdges` set the editor query AND call `runGremlin()`. Both have `onClick` handlers, both fire `fetch('/api/items/cosmos-gremlin-graph/[id]/query', ...)`. They no longer emit nothing.

## 1. `cosmos-gremlin-graph`

| Element | portal.azure.com Cosmos DB → Data Explorer (Gremlin) | Loom | Severity |
|---|---|---|---|
| Graph viz canvas (force-directed nodes/edges) | Yes — D3 / Cytoscape canvas | **absent — JSON `<pre>` dump only** | **BLOCKER** ❌ — the editor's own MessageBar admits "Graph visualization (force-directed layout) deferred to v3.x" |
| **Gremlin query editor** | Monaco with `gremlin` syntax | **`<textarea>`** (line 156) | **BLOCKER** ❌ |
| Endpoint input | Connection panel | `<Input>` for Gremlin endpoint | present |
| Run | Top button | `Play` icon + `Run` button | present |
| **Vertices quick query button** | n/a | Two locations (sidebar + main pad) — both `onClick={showVertices}` ✓ | **A-present** ✓ |
| **Edges quick query button** | n/a | Two locations — both `onClick={showEdges}` ✓ | **A-present** ✓ |
| Results | Table of vertices/edges with property inspector | `<pre>` JSON | **MAJOR** — no table render |
| Schema panel (vertex labels, edge labels, indexes) | Side rail | absent | MAJOR |
| Database / Collection picker | Top combo | absent (single endpoint via env) | MAJOR |
| Query throughput stats (RUs consumed) | Status bar | absent | MAJOR |
| Save / Open saved query | Toolbar | absent | MAJOR |

**Grade**: **C** — Run + Vertices + Edges all wire to real BFF and execute. `<textarea>` blocks A, no graph viz, no schema panel. The Vertices/Edges fix is real and validated in source.

## 2. `cypher-graph`

| Element | Neo4j Browser / ADX graph-match | Loom | Severity |
|---|---|---|---|
| **Cypher / KQL editor** | Monaco | **`<textarea>`** (line 204) | **BLOCKER** ❌ |
| Translation to KQL (preview) | Side panel | MessageBar "Real Cypher-to-KQL translation deferred — write KQL directly" | **D-present** — honest but no translator |
| Run | Top button | Play button | present |
| Backend selector (Cypher native vs KQL bridge) | n/a | none — KQL only | MINOR |
| Results visualization (graph or table) | Both | `<pre>` JSON | MAJOR |
| Function reference (graph-match operators) | Side panel | Caption1 one line | MINOR (less than geo-query) |

**Grade**: **D** — textarea + JSON dump + "write KQL directly" admission. Honest but very thin.

## 3. `gql-graph`

| Element | Fabric Graph (preview) / Neo4j GQL | Loom | Severity |
|---|---|---|---|
| **GQL editor** | Monaco with GQL grammar | **`<textarea>`** | **BLOCKER** ❌ |
| Backend selector (Fabric Graph / Cosmos translate / Persist-only) | n/a | native `<select>` 3 options | present (B-present) |
| Run dispatches to selected backend | Yes | Real switch with 3 routes; persist-only is honest no-op | **B-present** ✓ |
| Schema browser | Side panel | absent | MAJOR |
| Result table | Yes | `<pre>` JSON | MAJOR |
| Save | Toolbar | only on `persist-only` mode | partial |

**Grade**: **C** — the run dispatcher with 3-backend selector is honest and real. textarea blocks A. The "persist-only" mode is a vaporware mitigation — explicit honest no-op rather than fake dispatch. v3.27 F-fix confirmed.

## 4. `vector-store`

| Element | AI Search / Cosmos Vector / pgvector | Loom | Severity |
|---|---|---|---|
| Backend selector | Multi-backend not unified anywhere | native `<select>` 4 options (cosmos-nosql, cosmos-vcore, ai-search, pgvector) | present (B-present for new feature) |
| Index name / Dimensions / Metric | Inputs | 3 Fluent Inputs + `<select>` for metric | present |
| **Create index** | Live REST per backend | `Persist index spec` button — calls `/api/items/vector-store` POST but the route returns persistence-only (no real provisioning per backend type) | **D-present** — the docs say "Backend-specific provisioning is deferred. Persist the spec only." |
| **Test query embedding** | Real similarity test | `<Button disabled>Similarity test (v3.x)</Button>` | **D-present** — explicit disabled button |
| Index list (existing indexes) | Yes | absent | **BLOCKER** |
| Vector field mapping | Schema editor | absent | MAJOR |
| Embedding model picker (text-embedding-3-small / ada-002 / etc.) | Picker | absent | MAJOR |
| Cost estimator | n/a | absent | MINOR |

**Grade**: **D** — the backend selector is honest about deferred provisioning. Persist-spec works. Similarity test is explicitly disabled. No index list, no actual create. Per the csa-loom-parity-reality memory: was previously called D, remains D.

## Phase 4 (functional click-every-button)

Source-grade `onClick` audit:

| Button | Status |
|---|---|
| cosmos-gremlin Run | ✓ fires |
| cosmos-gremlin Vertices (×2) | ✓ fires |
| cosmos-gremlin Edges (×2) | ✓ fires |
| cosmos-gremlin ribbon "Edges" / "Vertices" / "Run" | dead — labels only |
| cypher Run | ✓ fires |
| cypher ribbon "Run" | dead |
| gql Run / Save query | ✓ fires |
| gql ribbon "Run" | dead |
| vector-store "Persist index spec" | ✓ fires |
| vector-store "Similarity test" | explicitly disabled with v3.x marker (this is honest — counts as gated, not broken) |
| vector-store ribbon "Create" / "Test similarity" | dead labels |

**4-5 dead ribbon labels** that would be clicked-and-do-nothing if a user finds them.

## Summary

| Editor | Grade | Reason |
|---|---|---|
| cosmos-gremlin-graph | **C** | Real Gremlin REST execution + Vertices/Edges fix wired ✓, but `<textarea>` + JSON dump + no graph viz |
| cypher-graph | **D** | `<textarea>` + JSON dump + "write KQL directly" — pure thin shim |
| gql-graph | **C** | Honest 3-backend selector + persist-only mode = no vaporware, but `<textarea>` + no schema browser |
| vector-store | **D** | 4-backend selector + persist-only honesty, but no real create per backend, similarity test disabled |
