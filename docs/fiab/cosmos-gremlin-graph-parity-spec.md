# Loom Cosmos Gremlin Graph Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent. Sources: Microsoft Learn — [What is Azure Cosmos DB for Apache Gremlin?](https://learn.microsoft.com/azure/cosmos-db/gremlin/overview), [Gremlin TinkerPop compatibility](https://learn.microsoft.com/azure/cosmos-db/gremlin/support), [Execute queries on graph data](https://learn.microsoft.com/azure/cosmos-db/gremlin/how-to-write-queries), [Graph data modeling](https://learn.microsoft.com/azure/cosmos-db/gremlin/modeling), [Gremlin limits](https://learn.microsoft.com/azure/cosmos-db/gremlin/limits), [Gremlin FAQ](https://learn.microsoft.com/azure/cosmos-db/gremlin/faq), [Quickstart console](https://learn.microsoft.com/azure/cosmos-db/gremlin/quickstart-console). Cross-checked against current Loom editor at `apps/fiab-console/lib/editors/graph-editors.tsx::CosmosGremlinGraphEditor` and BFF route `apps/fiab-console/app/api/items/cosmos-gremlin-graph/[id]/query/route.ts`.

## What it is

**Azure Cosmos DB for Apache Gremlin** is a managed property-graph database. It stores vertices and edges with arbitrary key/value properties, partitions horizontally across an Azure Cosmos account, and speaks the **Apache TinkerPop Gremlin** traversal language over a WebSocket endpoint shaped `wss://<account>.gremlin.cosmos.azure.com:443/`. There is **no native Microsoft "graph data explorer" portal blade equivalent to the SQL data explorer for the Gremlin API** — Microsoft documents partner tools (Linkurious, yWorks, Graphistry, Cambridge Intelligence, Hackolade) for visualization, plus the open-source `tinkerpop/gremlin-console` Docker image for ad-hoc traversal. Our Fabric-parity target is therefore the **portal Data Explorer surface** that Cosmos DB does ship for the Gremlin API (graph + database tree, query editor with results in graph/JSON/table tabs, and the `executionProfile()` viewer).

## UI components

### Page chrome
- Title bar: graph name + saved-state indicator
- Standard Cosmos account global bar (settings, notifications, help, account)
- Top toolbar: **New Vertex**, **New Edge**, **Execute Gremlin Query**, **Save Query**, **Load Query**, **Save Results**, **Settings**

### Left pane — Database tree
- Tree of `cosmosdb account → database → graph` hierarchy
- Per-graph actions: **New Graph Query**, **New Items** (vertex), **Settings** (throughput, partition key path, indexing policy)
- Per-database actions: **New Graph** (with `partition-key-path` + throughput input)
- Stored procedures / UDFs / triggers branches (Cosmos primitives; present in the Gremlin explorer because the underlying engine is shared with NoSQL)

### Query editor pane (top main)
- Monaco-based Gremlin editor with TinkerPop syntax highlighting
- Inline help link to the [supported Gremlin steps table](https://learn.microsoft.com/azure/cosmos-db/gremlin/support#gremlin-steps)
- **Execute Gremlin Query** button
- **Save Query** / **Load Query** (named queries persisted per account)
- Query parameterization (dictionary of bindings — required to prevent injection per Gremlin FAQ)
- Hard limits surfaced inline: script length 64 KB, operator depth 400, traversal timeout 30 s, repeat limit 32

### Results pane (bottom main) — three tabs
- **Graph** — interactive force-directed visualization of returned vertices + edges, with right-click expand (`out()` / `in()` / `both()`) on a selected vertex, hide/show by label, pin/unpin, zoom-on-node
- **JSON** — raw response (vertices, edges, paths, scalars)
- **Table** — flattened columns for projected properties (works when the traversal ends in `.values(...)`, `.valueMap()`, `.project(...).by(...)`)
- **Query Stats** — request-charge (RUs), round-trip latency, retrieved document count, server-side execution time

### Execution profile viewer
- Surfaces output of `.executionProfile()` (appended to a traversal)
- Step-by-step breakdown with `fanoutFactor`, working-set size, time per step
- Highlights blind fan-out patterns (high fanoutFactor without partition-key predicate)

### Vertex / edge form editor
- **New Vertex** dialog: label + partition-key value + repeating property rows (name/value/type)
- **New Edge** dialog: source vertex id, target vertex id, label, repeating property rows
- Triggers `g.addV(...)` / `g.addE(...)` traversals; closes on success

### Settings drawer (per graph)
- Throughput (RU/s; manual or autoscale)
- Partition key path (read-only post-create)
- Indexing policy editor (JSON; consistent vs none, included/excluded paths)
- Time-to-live (item TTL + default container TTL)
- Conflict resolution (last-writer-wins vs custom merge)
- Geo-replication add/remove regions

## What Loom has

The current `CosmosGremlinGraphEditor` (`apps/fiab-console/lib/editors/graph-editors.tsx`, lines 94-142) is partially functional:

- Endpoint input bound to `NEXT_PUBLIC_LOOM_COSMOS_GREMLIN_ENDPOINT`
- Plain `<textarea>` Gremlin editor seeded with `SAMPLE_GREMLIN` (4-line `g.V().hasLabel('person')...` example)
- **Run** button POSTing to `/api/items/cosmos-gremlin-graph/[id]/query` which calls `executeGremlin()` in `lib/azure/gremlin-client.ts`
- BFF returns 501 with `deferred=true` when `LOOM_COSMOS_GREMLIN_ENDPOINT` is unset or the `gremlin` npm package isn't installed; UI renders the deferred MessageBar honestly
- Results render as a `<pre>` JSON block (no graph / table / stats tabs)
- Ribbon advertises **Edges** / **Vertices** ribbon actions but they are not wired
- Cosmos persistence of the Gremlin script + endpoint via the generic item-state pattern
- Grade: **C (functional but rough)** — real traversal execution works end-to-end when env is set, but every visualization and authoring surface is missing

## Gaps for parity

1. **Graph visualization tab absent** — no force-directed canvas, no node expand, no label-based filter. Loom dumps JSON. The single largest parity gap.
2. **Table tab absent** — flattened-columns view for `valueMap()` / `project()` traversals is missing.
3. **Query Stats tab absent** — RU charge, retrieved-doc count, server-side time are not surfaced even though they're in every Cosmos response header.
4. **executionProfile() viewer absent** — no per-step breakdown, no fanoutFactor warning, no blind-fan-out flagging.
5. **Monaco editor + Gremlin syntax highlighting** — plain `<textarea>` with no IntelliSense, no `.V()/.E()/.out()/.in()/.has()` completion.
6. **Database tree navigator absent** — no `account → database → graph` tree, no per-graph **Settings**, no **New Graph** dialog.
7. **New Vertex / New Edge form editors absent** — every mutation must be typed as Gremlin in the textarea.
8. **Indexing-policy + throughput + TTL editors absent** — Cosmos primitives that the portal exposes but Loom doesn't.
9. **Saved queries absent** — no per-account query library; only the current textarea persists into item state.
10. **Parameterized queries absent** — Gremlin FAQ explicitly recommends parameter dictionaries to prevent injection; Loom takes a raw string.
11. **Limit surfacing absent** — the 64 KB / 400-operator / 30-s / repeat-32 limits aren't shown in the editor UI; long queries fail with opaque 429s.
12. **AAD auth path absent** — `gremlin-client.ts` defaults to account-key auth; Service Connector pattern for managed-identity-to-listKeys is documented but not wired.
13. **Ribbon advertises Edges / Vertices buttons that emit nothing** — vaporware-rule violation; either wire them to `g.V().limit(50)` / `g.E().limit(50)` shortcuts or remove the labels.
14. **No partition-key reminder in the editor** — graph modeling docs hammer "include partition key in V() predicate" as the #1 performance lever; Loom should surface a Caption1 hint inline.

## Backend mapping

| Loom surface | Backing service | Notes |
|---|---|---|
| Graph + database + indexing-policy persistence | **Azure Cosmos DB account** with `EnableGremlin` capability, deployed via existing `Microsoft.DocumentDB/databaseAccounts` bicep in `platform/fiab/bicep/modules/cosmos/` | Account already deployed for Loom's own `loomdb` items container |
| Traversal execution | Existing `/api/items/cosmos-gremlin-graph/[id]/query` → `lib/azure/gremlin-client.ts` over WebSocket to `wss://<acct>.gremlin.cosmos.azure.com:443/` | Already 501-honest when not configured |
| Saved queries | Cosmos `items` container, partition `cosmos-gremlin-graph` | Sibling docs under same parent item |
| Vertex / edge form editor | Generated Gremlin (`g.addV(label).property(...)` / `g.addE(label).from(g.V(id)).to(g.V(id)).property(...)`) sent to the same query route | No new backend |
| Graph visualization | Client-side render via [vis-network](https://visjs.github.io/vis-network/) or [Cytoscape.js](https://js.cytoscape.org/) | Both are MIT and already used in Microsoft samples |
| executionProfile() viewer | Same query route; parser of the JSON profile shape documented in [execution-profile reference](https://learn.microsoft.com/azure/cosmos-db/gremlin/reference-execution-profile) | Pure client-side |
| AAD auth path | `ChainedTokenCredential` → ARM `listKeys` per the Service Connector pattern; cache key in memory | Need new helper in `gremlin-client.ts` |
| Database-tree navigator | New BFF routes `GET /api/cosmos/accounts/{name}/databases` + `.../databases/{db}/graphs` calling `Microsoft.DocumentDB/databaseAccounts/gremlinDatabases` ARM list APIs | Pattern matches existing `synapse-pool-arm.ts` |

## Required Azure resources

- **Azure Cosmos DB account** with `--capabilities EnableGremlin` (already deployable via the existing Cosmos bicep module in `platform/fiab/bicep/modules/cosmos/`)
- **AAD role assignment**: `Cosmos DB Built-in Data Contributor` on the account scope for the Loom UAMI (for control-plane listKeys via ARM if account-key auth is required; the data-plane WebSocket itself accepts the master key returned by listKeys)
- **Optional private endpoint** for the Gremlin endpoint (the `.gremlin.cosmos.azure.com` FQDN supports private DNS zone `privatelink.gremlin.cosmos.azure.com`)
- **`gremlin` npm package** in `apps/fiab-console/package.json` (currently gated; runtime returns 501 if not installed)
- **Env vars**: `LOOM_COSMOS_GREMLIN_ENDPOINT` (already wired), plus a new `LOOM_COSMOS_GREMLIN_AAD_ENABLED=true` to flip the credential chain

## Estimated effort

- **Session N+1 (~3 hrs)** — Monaco editor with Gremlin keywords + database tree navigator (ARM list calls) + saved queries
- **Session N+2 (~4 hrs)** — graph visualization tab with vis-network or Cytoscape, right-click expand (`out()`/`in()`/`both()`), label filter, pin/unpin
- **Session N+3 (~2 hrs)** — table tab, Query Stats tab (RU + latency + retrieved-doc count from response headers), executionProfile() viewer
- **Session N+4 (~2 hrs)** — New Vertex / New Edge form editors, indexing-policy + throughput + TTL drawer, wire Edges/Vertices ribbon shortcuts, surface limits + partition-key hint
- **Session N+5 (~1 hr)** — AAD auth path via `ChainedTokenCredential` + ARM listKeys; Vitest + Playwright covering deferred + happy-path

Total: **~12 hrs** across 5 sessions. Current grade: **C**. Target: **A+** after session N+5 with bicep deploys the account + private endpoint + role assignments from scratch.
