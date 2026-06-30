# graph-model — parity with graph schema model materialized to Azure Data Explorer (make-graph)

Source UI: Microsoft Fabric **graph model editor** (Fabric IQ / Graph) —
<https://learn.microsoft.com/fabric/graph/design-graph-schema>,
<https://learn.microsoft.com/fabric/graph/tutorial-model-nodes>,
<https://learn.microsoft.com/fabric/graph/tutorial-model-edges>,
<https://learn.microsoft.com/fabric/graph/tutorial-query-builder>,
<https://learn.microsoft.com/fabric/graph/gql-graph-types>,
<https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/graph-model-definition>

Azure-native backend (DEFAULT, no Fabric): a property-graph **schema** designed
in Loom, materialized to **Azure Data Explorer (ADX/Kusto)** node + edge tables,
loaded from source tables via `.set-or-append` / `.ingest`, and queried with the
Kusto graph operators `make-graph` + `graph-match` (+ `graph-shortest-paths`,
`graph-to-table`). GQL/openCypher author via the existing `cypherToKql`
translator and the `kql-database` / `gql-graph` query routes. Fabric Graph REST
is opt-in only (`LOOM_GRAPH_MODEL_BACKEND=fabric` + a bound workspace).

## Real feature inventory

### A. Modeling — node types
1. **Add node type** dialog: node **label** (name), **source table** picker, a
   **key** column that uniquely identifies each node, **properties** multi-select
   mapping source columns → node properties.
2. **Compound / composite keys** — a node key may be multiple columns.
3. **Property typing** — GQL value types: `INT/INT64`, `UINT/UINT64`, `STRING`,
   `BOOL/BOOLEAN`, `DOUBLE/FLOAT64`, `ZONED DATETIME`, `LIST<T>`, `T NOT NULL`.
4. **Edit node** (double-click on canvas) → add/remove properties, toggle key
   columns, rename.
5. **Multiple labels / node subtyping (inheritance)** — `ABSTRACT (:Message)`,
   `(:Post => :Message)`.
6. **Per-type source-row filters** — `SingleFilter` / `GroupFilter` (operator,
   column, value; AND/OR groups) scope which rows become nodes/edges.

### B. Modeling — edge types
7. **Add edge** dialog: edge **label**, **source table**, **origin node** +
   **origin key**, **target node** + **target key**; compound-key columns when
   endpoints use compound keys.
8. **Edge properties** — map relationship columns onto the edge.
9. **Edge type families** — multiple edge types sharing one label but differing
   in endpoints (`(:City)-[:isPartOf]->(:Country)`,
   `(:Country)-[:isPartOf]->(:Continent)`); families via node subtyping.
10. **Directionality** — edges are directed origin→target.

### C. Table / source mapping
11. **Table mappings** — every node/edge type binds to a source table; editor
    lists available tables + column schema.
12. **Property→column mapping** (`propertyName`/`sourceColumn`) with rename.

### D. Schema canvas / visualization
13. **Schema graph canvas** — node types as vertices, edge types as labeled
    directed arrows, drawn as you build.
14. **Interact** — drag to reposition, select to inspect, double-click to edit.

### E. Load / materialize / validate
15. **Save** — verifies the model, **loads data** from source tables,
    **constructs** the queryable graph, shows *Data load completed*. Reload
    required after structural changes (no schema evolution).
16. **Validation** — type consistency (same property name → same value type),
    valid endpoints, well-formed edges.

### F. Query (Modes → Query)
17. **Query Builder** — visual, no-code: pick nodes/relationships, expand a node
    to see neighbors, view properties, drag, **filter**, **select** return
    properties.
18. **Result views** — **Diagram** (default), **Card**, **Table**.
19. **Code editor** — write **GQL** (ISO 39075); **Run query**.
20. **Queryset** — save a read-only, shareable queryset of results.

### G. Item lifecycle
21. **GQL graph-type definition** export/import (`CREATE GRAPH TYPE`; REST
    `getDefinition`/`updateDefinition`).
22. **Sample datasets** (social network, Adventure Works) as a starter model.

## Loom coverage

| # | Real capability | Loom status | Backend per control |
|---|---|---|---|
| 1 | Add node type w/ source table + key + property mapping | ⚠️ partial — name + freeform `name:type` props only; **no source-table picker, no key column** | Cosmos (item-crud); no table binding |
| 2 | Compound keys | ❌ MISSING | — |
| 3 | Property typing (GQL types + NOT NULL + LIST) | ⚠️ Kusto scalar dropdown only; no nullability/LIST | Kusto type at materialize |
| 4 | Edit node type (props grid) | ✅ `GraphTypeEditor` card w/ add/remove props + type dropdown | Cosmos |
| 5 | Multiple labels / inheritance | ❌ MISSING | — |
| 6 | Per-type source-row filters | ❌ MISSING | — |
| 7 | Add edge w/ origin/target node + key columns | ⚠️ partial — From/To stored as `srcType`/`dstType` props; **no key columns, no source table** | Cosmos |
| 8 | Edge properties | ✅ via props grid | Cosmos → Kusto cols |
| 9 | Edge type families | ❌ MISSING (names must be unique) | — |
| 10 | Directionality | ⚠️ implied by From/To; not enforced | — |
| 11 | Table mappings / source-table list | ❌ MISSING | — |
| 12 | Property→column mapping | ❌ MISSING (props abstract, not column-bound) | — |
| 13 | Schema graph canvas | ⚠️ read-only `ForceDirectedGraph`; edges fan to hub when src/dst absent | client-only |
| 14 | Canvas interact (drag/select/dbl-click) | ❌ MISSING | — |
| 15 | Save → load data → construct graph (+ banner) | ⚠️ Materialize creates **empty** ADX `Node_*`/`Edge_*` tables; **no data load** | `/materialize` → `executeMgmtCommand` (real ADX) |
| 16 | Model validation at save | ⚠️ minimal (name regex, dup name); no type-consistency / endpoint validation | client-only |
| 17 | Visual Query Builder | ❌ MISSING (no query surface in this editor) | — |
| 18 | Diagram / Card / Table result views | ❌ MISSING | — |
| 19 | GQL/openCypher code editor + Run | ❌ MISSING here (lives in separate `gql-graph` editor) | `cypherToKql` + `/api/items/kql-database/[id]/query` (reusable) |
| 20 | Save queryset | ❌ MISSING | — |
| 21 | GQL graph-type definition import/export | ❌ MISSING | — |
| 22 | Sample dataset starter | ❌ MISSING | — |

**Honest assessment:** the editor is a **thin two-column type designer**
(node/edge cards with name + abstract property rows) plus a non-interactive
force-directed schema picture and one **Materialize** button that creates
*empty* ADX tables. No source-table binding, no key columns, no data load, no
query experience, no canvas editing, and no validation beyond a name regex. It
is roughly **C- / D+** vs the real product: it persists state and creates real
ADX tables (real backend, not vaporware) but covers ~25% of the inventory and
never produces a *queryable graph with data in it*.

## Build plan

### P0
- **Source-table binding + key columns per type** (1,7,11,12). Add a "Source"
  section to each node/edge card: ADX **database** + **table** pickers (reuse
  `kusto-client` `.show databases` / `.show tables` / table-schema), **key
  column** multiselect (compound keys), and a **property→column** mapping grid
  (column dropdown from live schema, GQL type auto-detected, rename). Extend
  `/materialize` to `.create-merge` typed tables **and load data**
  (`.set-or-append Node_X <| <sourceTable> | project ...`) so the graph has rows.
- **Build & validate graph (real make-graph) + load receipt** (15,16). Replace
  empty-table Materialize with "Build graph": materialize tables, load data, run
  a verification `make-graph` over loaded tables, return per-type row counts + a
  *Data load completed* MessageBar. Backend: `executeMgmtCommand` +
  `executeQuery` (`make-graph` / `graph-match count`) in the materialize route.
- **In-editor Query tab (Diagram/Table/Card) with GQL + openCypher Run**
  (17,18,19). Add a "Query" tab (TabList) reusing `cypherToKql` + POST to
  `/api/items/kql-database/[id]/query`; render results as **Diagram**
  (`ForceDirectedGraph`/`extractGraph`), **Table** (Fluent `Table`), **Card**.
  No new infra — real ADX `make-graph`+`graph-match`.

### P1
- **Visual Query Builder (no-code)** (17). Guided panel: pick a start node type,
  add hops (edge → target), per-step property filters (operator + value rows),
  return-property multiselect; compile to GQL → `cypherToKql` → ADX. Fluent
  controls only, no freeform.
- **Interactive schema canvas** (13,14). Upgrade `GraphModelSchemaViz` to an
  editable canvas (reuse `canvas-node-kit` / `@xyflow/react`): drag, click to
  open a type's card, draw an edge between two nodes to create an edge type with
  origin/target pre-filled. Persists to Cosmos.
- **Cross-type validation + nullability/LIST types** (3,16). Validate at save:
  same property name → same type across types; resolvable origin/target; key
  column exists in source schema. Add `NOT NULL` toggle + `LIST<T>`. Errors in a
  styled MessageBar list.
- **GQL graph-type definition export/import** (21). "View as GQL" (read-only
  Monaco rendering `CREATE GRAPH TYPE { … }`) + **Import GQL** (parse pasted
  graph-type → nodes/edges). Cosmos persist; opt-in Fabric `updateDefinition`
  when `LOOM_GRAPH_MODEL_BACKEND=fabric`.

### P2
- **Edge type families + node subtyping/inheritance** (5,9). Non-unique edge
  labels distinguished by endpoints; node parent declaration (`=> :Parent`)
  inheriting properties; family → shared edge table with `kind` discriminator.
- **Per-type source-row filters** (6). Filter builder per type (operator +
  column + value rows, AND/OR groups) → `| where` appended to the load query.
  Fluent rows, no JSON.
- **Sample-dataset starter + Save queryset** (20,22). "Start from sample"
  (Adventure Works / social network) seeds types + loads inline sample data
  (`.set-or-append` from `datatable(...)`); "Save queryset" persists a named
  query + last result to Cosmos as a shareable read-only item.

## Verification

`pnpm uat` deep-functional spec + live side-by-side vs the Fabric graph model
editor. A-grade requires every inventory row ✅ built or ⚠️ honest-gate, the
default path materializing + loading + querying real ADX with
`LOOM_DEFAULT_FABRIC_WORKSPACE` **unset**, and physical click-through of every
control (DOM strings ≠ parity).
