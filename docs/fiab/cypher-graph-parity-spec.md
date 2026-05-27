# Loom Cypher Graph Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent. Sources: Microsoft Learn — [Graph in Microsoft Fabric overview](https://learn.microsoft.com/fabric/graph/overview), [How graph in Microsoft Fabric works](https://learn.microsoft.com/fabric/graph/how-graph-works), [Graph visualization with Kusto Explorer](https://learn.microsoft.com/kusto/query/graph-visualization-kusto-explorer?view=microsoft-fabric), [Custom graph visualizations](https://learn.microsoft.com/kusto/query/graph-visualization-custom?view=microsoft-fabric), [make-graph operator](https://learn.microsoft.com/kusto/query/make-graph-operator?view=microsoft-fabric), [graph-match operator](https://learn.microsoft.com/kusto/query/graph-match-operator?view=microsoft-fabric). Cross-checked against current Loom editor at `apps/fiab-console/lib/editors/graph-editors.tsx::CypherGraphEditor` and BFF route `apps/fiab-console/app/api/items/kql-database/[id]/query/route.ts`.

## What it is

There is **no first-class Azure managed service that speaks Cypher natively**. Cosmos DB for Apache Gremlin speaks Gremlin only ([Gremlin FAQ](https://learn.microsoft.com/azure/cosmos-db/gremlin/faq) is explicit). Graph in Microsoft Fabric speaks **GQL** (the ISO standard, see `gql-graph-parity-spec.md`) — also not Cypher. The closest Azure-native execution surface for Cypher-shaped queries is **KQL graph semantics** in Azure Data Explorer / Eventhouse: `make-graph` materializes a transient graph from edge + node tabular sources, and `graph-match` matches Cypher-style ASCII-art patterns `(p1)-[:knows]->(p2)`. That is what Loom's editor labels "Cypher" — it is a Cypher *dialect* expressed as KQL graph operators, executed against an ADX cluster. This is also what Microsoft's own openCypher demos use under the hood when targeting ADX.

## UI components (Cypher-on-KQL surface)

### Page chrome
- Title bar: graph name + saved-state indicator
- Top toolbar: **Run**, **Save Query**, **Load Query**, **Save Results**, **Cancel**, **Explain Plan**

### Left pane — Graph schema explorer
- Tree of `ADX cluster → database → tables that participate in the graph` (one node-table + one edge-table is the minimum pattern)
- Per-table actions: **Preview rows**, **Show schema**, **Add to current graph**
- A **Saved graphs** branch listing persisted graph definitions (`.create-or-alter graph-model` in Fabric KQL, or transient `make-graph` patterns saved as named functions)

### Query editor (top main)
- Monaco-based KQL editor with Cypher dialect highlighting (`MATCH`, `WHERE`, `RETURN`, `->`, `<-`, `[:rel]`)
- Auto-complete for graph-match keywords + node/edge labels discovered from the schema explorer
- **Run** with cancel-mid-flight
- **Explain Plan** — surfaces ADX query plan + the synthesized `make-graph` + `graph-match` operators

### Results pane (bottom main) — three tabs
- **Graph** — interactive force-directed visualization (parity with Kusto Explorer's automatic graph rendering when a query ends with `make-graph` or `graph()`). Right-click node: **Expand 1/2/3/4 levels**, **Hide others**, **Hide edges & nodes**, **Zoom on me**
- **Table** — flattened columns for the projected `RETURN` clause
- **JSON** — raw response

### Graph Layers panel (right rail)
- Node labeling rules (by property)
- Node coloring rules (by label or property bucket)
- Edge labeling rules
- Search box (find node by name / id)
- Timeline controls — when nodes/edges have temporal properties, scrub through the graph's evolution (parity with Kusto Explorer Timeline view)

### Schema-definition surface (Fabric KQL native graph models)
- **Define graph model** dialog mapping `tables → nodes`, `tables → edges (src, dst, kind)`, with primary-key column choice
- Persists into ADX as a named graph (queryable later via `graph("name")` in KQL or via the `make-graph` + `with_node_id` pattern)

### Sample patterns (preloaded examples)
- `(p1:Person {name:'Alice'})-[:KNOWS]->(p2:Person) RETURN p2.name` — Cypher
- Equivalent KQL: `Edges | make-graph src --> dst with_node_id=name | graph-match (p1)-[k:knows]->(p2) where p1.name == "Alice" project p2`
- Side-by-side toggle so authors learn the translation

## What Loom has

The current `CypherGraphEditor` (`apps/fiab-console/lib/editors/graph-editors.tsx`, lines 147-186) is a thin shim:

- Plain `<textarea>` seeded with a comment-block sample showing Cypher intent → KQL `graph-match` implementation
- A `MessageBar intent="info"` titled **"openCypher on ADX"** that admits *"Real Cypher-to-KQL translation deferred to v3.x — write KQL directly for now"*
- **Run** button POSTing the textarea contents to the existing `/api/items/kql-database/[id]/query` endpoint (so an `id` belonging to a real Eventhouse-backed KQL DB makes execution work end-to-end)
- Results render as a `<pre>` JSON block
- Ribbon advertises a **Run** action; nothing else is wired
- Grade: **D (stubbed)** — runs KQL honestly, but every Cypher-specific surface (parser, translator, graph viz, schema explorer, layers panel) is missing

## Gaps for parity

1. **Cypher-to-KQL translator absent** — the editor admits this; users must hand-write the `make-graph` + `graph-match` pipeline. A real parser (open-source candidates: [openCypher antlr grammar](https://github.com/opencypher/openCypher)) would emit the KQL form.
2. **Side-by-side Cypher ↔ KQL toggle absent** — a useful learning surface for the dialect bridge; not present.
3. **Graph visualization tab absent** — the same gap as cosmos-gremlin and the largest UX gap. Kusto Explorer ships an interactive graph layers panel out of the box; the Loom web editor does not.
4. **Graph Layers panel absent** — no node/edge label rules, no coloring, no search box, no Timeline view.
5. **Schema explorer absent** — no `cluster → database → graph` tree, no edge/node table picker.
6. **Define graph model dialog absent** — Fabric KQL supports persistent graph models (`.create-or-alter graph-model`); Loom can't author one.
7. **Monaco + KQL/Cypher syntax highlighting absent** — plain textarea.
8. **Saved queries / saved graph models absent**.
9. **Explain Plan absent** — KQL exposes `.show queries` and per-query stats; not surfaced.
10. **Cancel mid-flight absent** — long graph-match queries can run for tens of seconds; no cancel UI.
11. **Vaporware risk** — the editor must keep its honest "deferred" MessageBar until the translator ships, OR the title must be relabeled "Cypher dialect on ADX (write KQL graph operators directly)" so it does not promise openCypher parity.

## Backend mapping

| Loom surface | Backing service | Notes |
|---|---|---|
| Query execution | **Azure Data Explorer cluster** or **Fabric Eventhouse** via existing `/api/items/kql-database/[id]/query` → `lib/azure/kusto-client.ts` | Already wired; route accepts `{ kql }` body |
| Graph visualization | Client-side vis-network / Cytoscape over the JSON result shape produced by `graph-match ... project` (rows of nodes + edges) | No backend |
| Cypher → KQL parser | New `lib/azure/cypher-to-kql.ts` using `openCypher` ANTLR grammar (or a pragmatic regex translator for the MVP subset: MATCH + WHERE + RETURN + LIMIT) | Pure JS / TS; runs in the BFF |
| Schema explorer | Existing KQL routes: `.show tables`, `.show database schema`, `.show graph_models` (Fabric KQL) — wrap via existing kusto-client | No new dependency |
| Graph model persistence (`.create-or-alter graph-model`) | Same KQL control-command endpoint | Permission: Database Admin or Database User with control-command rights |
| Saved Cypher queries | Cosmos `items` container, partition `cypher-graph` | Sibling pattern of cosmos-gremlin saved queries |
| Explain Plan | `.show queries` + the `query_plan` system function; or the implicit plan visible in `set query_take_max_records` diagnostics | KQL native |
| Timeline view | Client-side — relies on temporal properties (datetime columns) being present on the edges; degrades gracefully when absent | No backend |

## Required Azure resources

- **Azure Data Explorer cluster** OR **Fabric Eventhouse** (Loom already deploys an Eventhouse via `platform/fiab/bicep/modules/realtime-intelligence/`)
- **AAD role assignment**: `Database Viewer` minimum on the target database for read; `Database User` for `.create-or-alter graph-model`
- **At least one node-table and one edge-table** populated with sample data (the existing `eventstream` editor's ingestion path or a synthetic seed function)
- **No new env vars** required; reuses `LOOM_KUSTO_ENDPOINT` / `LOOM_EVENTHOUSE_ENDPOINT` already wired

## Estimated effort

- **Session N+1 (~3 hrs)** — Monaco editor with KQL highlighting + side-by-side Cypher↔KQL toggle (pretty-printed via the regex translator) + schema explorer tree
- **Session N+2 (~4 hrs)** — graph visualization tab with right-click expand and Graph Layers panel (label rules, coloring, search) — reuses the same visualizer component built for cosmos-gremlin
- **Session N+3 (~3 hrs)** — Cypher → KQL parser for the MATCH/WHERE/RETURN/LIMIT subset (sufficient for 80 % of real Cypher); larger subset deferred to v3.x with an honest MessageBar
- **Session N+4 (~2 hrs)** — Define graph model dialog wiring `.create-or-alter graph-model`; Explain Plan tab; Timeline view (datetime-driven scrub bar)
- **Session N+5 (~1 hr)** — saved queries, Cancel mid-flight, Vitest + Playwright

Total: **~13 hrs** across 5 sessions. Current grade: **D**. Target: **A** (A+ requires full openCypher parser which is out of scope; A+ achievable if the MVP parser subset is documented + Learn popup linked to the [openCypher grammar repo](https://github.com/opencypher/openCypher)).
