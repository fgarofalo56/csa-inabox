# Loom Graph Model Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent. Fabric Graph (preview) = labeled property graph (LPG) over OneLake tables. Node types + edge types + GQL/openCypher query surface. Built on the same engine as Azure Data Explorer graph models. RDF is explicitly **not** supported.

## UI components

### Top ribbon
- **Add node** — opens Add node dialog (creates a node type, not an instance)
- **Add edge** — opens Add edge dialog (creates an edge type)
- **Save** — verifies the model, loads data from OneLake, builds the graph (mandatory after any schema change; schema evolution is **not** supported — changes require a new graph item + reload)
- **Refresh data** — re-ingests from source tables without changing schema
- **Settings** / **Query** / **Visualize** mode toggles

### Graph model editor canvas
- Visual node-and-edge designer
- Nodes rendered as labeled circles with property count
- Edges rendered as directed arrows with label
- Double-click a node → **Edit node schema** dialog (10 properties auto-derived from mapping-table columns; per-property delete)
- Double-click an edge → **Edit edge schema** dialog (no auto properties; explicitly add columns from the mapping table)
- Canvas auto-arranges; supports zoom + pan

### Add node dialog
- **Label** (the node-type name, e.g. `Customer`)
- **Mapping table** (lakehouse table picker via OneLake catalog)
- **ID of mapping column** (key column — single or compound)
- **Confirm** / **Cancel**

### Add edge dialog
- **Label** (verb-phrase, e.g. `purchases`)
- **Mapping table** (the table providing the source→target join — can be the same as a node-mapping table for embedded-entity patterns)
- **Source node** + **Mapping column to be linked to source node key**
- **Target node** + **Mapping column to be linked to target node key**
- Compound-key support — multiple column pickers when sources have compound IDs

### Edit node / edit edge schema dialogs
- Property list with type, source column, delete affordance
- **Add property** action (edges only — nodes auto-populate)
- Key-column display (read-only after save)

### Query editor (GQL / openCypher)
- **GQL** is the primary surface (ISO/IEC 39075)
- **openCypher** (preview) available via three `#crp` client-request-property directives:
  - `#crp query_language=opencypher`
  - `#crp query_graph_reference=G_doc()`
  - `#crp query_graph_label_name=lbl`
- Syntax highlighting, autocomplete on labels + properties
- Result grid + visual graph preview of returned nodes/edges
- Save query → KQL queryset item

### Visualize / explore canvas
- Force-directed layout of returned subgraph
- Node sizing/coloring by property
- Click-through to neighbor traversal
- Export to JSON / KQL queryset

### Tabular-to-graph design patterns (designer affordances)
- One-to-many (parent → child FK)
- Many-to-many (junction table → edge)
- Embedded entity (column promoted to its own node type, e.g. `Country` extracted from `Employee.Country`)
- Hierarchy (chained parent/child)

### Limitations callouts (rendered in UI)
- **No schema evolution** — structural change requires a new graph + full reload (the editor displays this as a Save-time warning)
- **No undirected edges** — direction is mandatory
- **No RDF** — LPG only

## What Loom has

- `GraphModelEditor` in `apps/fiab-console/lib/editors/phase4-editors.tsx` (lines 685-765)
- Cosmos persistence of `{ nodes: GraphDecl[], edges: GraphDecl[], database }` where each declaration is `{ name, properties: [{name, type}] }`
- Two side-by-side JSON textareas (nodes / edges) — no visual canvas
- **Materialize to ADX** action that calls `POST /api/items/graph-model/{id}/materialize` — real Azure Data Explorer call that creates node/edge tables in the configured `loomdb-default` ADX database
- Per-item success / error rendering with per-table create status
- Last-materialized timestamp persisted
- Grade: **C (Functional but rough)** — materialize is real; canvas and query editor are absent

## Gaps for parity

1. **No visual canvas** — JSON textareas instead of node/edge cards
2. **No Add node / Add edge dialogs** — schema edits happen via raw JSON
3. **No OneLake mapping-table picker** — `database` field is freeform; no lakehouse-table catalog
4. **No GQL query editor** — cannot author or run queries against the materialized graph
5. **No openCypher support** — no `#crp` directive plumbing
6. **No graph visualization** — query results have no force-directed view
7. **No schema-evolution warning UI** — Loom silently allows JSON edits that would break a Fabric Graph
8. **No edge mapping-table semantics** — current model lets edges exist independent of a mapping table; Fabric requires both endpoints joinable via a real table
9. **No managed Graph integration with Ontology item** — Fabric auto-pairs ontology + graph; Loom does not
10. **No queryset save** — query results can't be persisted as a Fabric-style queryset

## Backend mapping

- **Today**: Loom materializes node/edge **tables** into ADX (via `/api/items/graph-model/{id}/materialize`). This is honest infra but it isn't a Fabric Graph item — it's a parallel implementation.
- **Parity path A (recommended)**: keep ADX as the engine; layer KQL `graph-model` + `make-graph` operators on top. Both `graph-model-overview` and openCypher land in ADX/Fabric on the same engine. The materialize call already creates tables; add a follow-up step that issues `.create graph_model` + `.alter graph_model` against the same DB.
- **Parity path B (full Fabric)**: call **Fabric REST** `POST /v1/workspaces/{ws}/items` with `type: "Graph"`, then drive its schema via the (preview) Fabric Graph admin API once Microsoft publishes one. As of 2026-Q2 this REST surface is partially documented; Loom should ship Path A as MVP.
- **Query execution**: route GQL/openCypher through the existing `/api/eventhouse/query` endpoint (ADX speaks both via Kusto client request properties).
- **Cosmos persistence**: keep `state.nodes` / `state.edges` as the authoritative schema; treat ADX/Graph as derived.

## Required Azure resources

- **Azure Data Explorer / Eventhouse** with a writable database (already wired — `loomdb-default`)
- **OneLake** for source tables (FiaB Lakehouse)
- Fabric capacity with **Graph (preview)** tenant setting enabled (only if going down Parity Path B)
- ADX role: **Database User** on the target DB for the Loom managed identity

## Estimated effort

**4-6 sessions.** Visual canvas is the heaviest piece (1-2 sessions with a force-directed layout lib like `reactflow` or `cytoscape`). Add node / Add edge dialogs + OneLake table picker is 1 session. GQL editor + result grid is 1 session (reuse the existing KQL editor from `eventhouse-parity-spec.md`). Path-A KQL `.create graph_model` plumbing is 1 session. Path-B full Fabric REST integration is deferred until Microsoft publishes the Graph REST surface. **Preview honesty**: Graph item is in public preview, openCypher is in public preview — both rendered behind a "this Fabric surface is preview; Loom mirrors the documented behavior" MessageBar.
