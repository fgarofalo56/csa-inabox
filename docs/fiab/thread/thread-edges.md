# Loom Thread — wired edges

The catalog of **Weave** edges that ship today (only WIRED edges appear in the
menu — no dead ends, per `.claude/rules/no-vaporware.md`). Each edge appears on
the editors of its source item types, opens a wizard whose every field is a
dropdown from a real discovery route (`loom-no-freeform-config`), and POSTs to a
BFF route that calls a real Azure / Power BI backend (or shows an honest gate).

| Edge | Group | From item types | Backend | BFF route |
|------|-------|-----------------|---------|-----------|
| Analyze in a Notebook | Explore | lakehouse, warehouse, kql-database, synapse pools, azure-sql-database | `createOwnedItem('notebook')` with the source attached + starter cell | `/api/thread/analyze-in-notebook` |
| Add as a Data Agent source | Analyze with AI | warehouse, lakehouse, kql-database, semantic-model, ai-search-index, synapse pools, azure-sql-database | `createOwnedItem`/`updateOwnedItem` (data-agent `state.sources`) | `/api/thread/add-data-agent-source` |
| Build a Power BI model | Visualize | warehouse, synapse-dedicated-sql-pool | Power BI **Push Datasets** REST (`createPushDataset` + `postPushRows`) over a real read-only SELECT on the Azure-native warehouse (Synapse dedicated SQL) | `/api/thread/build-powerbi-model` |
| Publish as an API | Publish | warehouse, synapse-dedicated-sql-pool | Creates a real `data-api-builder` item (REST + GraphQL) whose entity is built from the table's catalog schema; `dwsql` source = Azure-native Synapse dedicated pool | `/api/thread/publish-as-api` |

Warehouse table pickers share one discovery route: `GET /api/thread/warehouse-tables?fromType=&fromId=` (lists the Synapse dedicated pool's tables; honest gate if unconfigured).

## The edge graph + Lineage view (PR4 spine)

Every Weave records a row in the Cosmos `thread-edges` container (PK
`/tenantId`) via `recordThreadEdge` (`lib/thread/thread-edges.ts`). The write is
**best-effort** — it never blocks the edge action (the integration itself is the
real backend; the graph is an observability layer). Re-weaving the same
source→target/action **upserts** (no duplicates).

- **Read API:** `GET /api/thread/edges` → the caller's edges, newest first.
- **Lineage page:** `/thread` (left nav → **Lineage**) renders the graph as KPI
  cards (totals + per-action counts) + a sortable/filterable `LoomDataTable`
  (Source → Weave → Target, When, By). Loom targets deep-link to their editor;
  external targets (a Power BI model) open in the service. Empty graph = honest
  empty state.

A node-link (React Flow) rendering of the same graph is a follow-up; the data +
list view ship first.

## Build a Power BI model — detail

The headline of Thread **PR5**. It turns a gold warehouse table into a real
Power BI semantic model without leaving Loom and without typing a connection
string:

1. **Workspace picker** — `GET /api/powerbi/workspaces` (real `listWorkspaces`).
   Honest gate if the Console service principal isn't authorized for Power BI.
2. **Table picker** — `GET /api/thread/powerbi-model/tables?fromType=&fromId=`
   lists the warehouse's tables from the catalog (`sql-objects-client.listTables`
   over the Synapse dedicated pool). Honest gate if
   `LOOM_SYNAPSE_WORKSPACE` / `LOOM_SYNAPSE_DEDICATED_POOL` are unset.
3. **Execute** — `POST /api/thread/build-powerbi-model`:
   - reads the table's column schema (`listColumns`), maps SQL types → the six
     Power BI push column types (`lib/thread/sql-to-pushdataset.ts`),
   - `createPushDataset` with that typed table,
   - runs `SELECT TOP 500` (read-only, bracket-quoted catalog identifiers) and
     `postPushRows` so the model is immediately queryable,
   - returns a deep link to the model in the Power BI service.

**no-fabric-dependency note:** Power BI here is the *target the user explicitly
chose to publish to* (an opt-in Weave edge), not a hidden default dependency.
The source warehouse is the Azure-native Synapse dedicated pool. Loom items work
100% without Power BI; this edge only activates when a user picks it.

## Publish as an API — detail (PR3)

Turns a gold warehouse table into a REST + GraphQL API without leaving Loom:

1. **Table picker** — shared `/api/thread/warehouse-tables` discovery route.
2. **Execute** — `POST /api/thread/publish-as-api`: reads the table's columns +
   primary key (`listColumns`), builds a real `DabConfig` (`dwsql` source =
   Synapse dedicated pool; one `table` entity with REST `/`<table>` + GraphQL
   types), runs `dab validate` parity (blocks on hard errors), and creates a
   real `data-api-builder` Loom item (`createOwnedItem`, same path the DAB
   editor uses). Returns a deep link to the editor.
3. **Deploy** is the editor's existing explicit action (no hidden hosting
   claimed — the item ships a validate-passing config ready to publish).

Secure by default: the "Require authentication" toggle sets the entity
permission role to `authenticated` (vs `anonymous`). The host auth provider
(EntraId + jwt) is configured in the editor before deploy.

### Deferred (next Thread PRs)

- lakehouse / KQL / azure-sql-database → Power BI model + API (needs the
  per-backend schema adapter — lands with the columns adapter in PR4).
- Report build from the model + embedded report in Loom (PR5 deepening).
- data-agent **semantic-model (DAX)** execution via `executeQueries` (PR5
  deepening — unblocks grounding on a Power BI model's measures).
- query → UDF REST endpoint (PR3 remainder); medallion promotion + mesh
  viewer (PR4).
