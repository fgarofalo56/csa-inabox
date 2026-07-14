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

## Analyze with DAX — detail

From a Loom-native `semantic-model` item (including a warehouse-backed model),
generate + execute a DAX query without typing DAX:

1. **Table picker** — `/api/thread/model-tables` lists the model's tables (read
   from `state.content.tables`, owner-scoped). **Query kind** is a dropdown
   (preview rows / top 100 / row count).
2. **Execute** — `POST /api/thread/analyze-with-dax`: synthesizes a DAX
   `EVALUATE` from the picks (`daxQueryTemplate`) and runs it through **the same
   executor the model's DAX query view + the report designer use** —
   `evalDax` (Synapse serverless SQL by default via DAX→SQL translate; AAS XMLA
   only when opted in). Returns the real result rows as a receipt and deep-links
   the model's DAX query view.
3. **Lineage** — a `thread-edges` row `semantic-model → dax-query` records the
   analysis (the pseudo-endpoint deep-links back to the DAX view — an ad-hoc DAX
   read has no second Loom item, so this avoids a self-loop while keeping the
   graph truthful).

**no-fabric-dependency note:** the DEFAULT tabular backend is Synapse serverless
SQL. No `api.powerbi.com` / `api.fabric.microsoft.com` is called; a `TabularError`
(e.g. unsupported DAX pattern, missing backing table) surfaces verbatim.

## Materialize to KQL (ADX) — detail

From a `lakehouse`, bind one of its ADLS Delta tables to an Azure Data Explorer
external table so it's queryable with KQL — the Azure-native "lakehouse → KQL"
bridge (no Fabric RTI Eventhouse):

1. **Table picker** — `/api/thread/lakehouse-delta-tables` scans the lakehouse's
   own `Tables/` root (`scanLakehouseTables` + `_delta_log` read) and lists the
   Delta tables. **KQL database** is a `loom-item` picker (`kql-database` /
   `eventhouse`); **query acceleration** is a toggle.
2. **Execute** — `POST /api/thread/materialize-to-kql`: resolves the lakehouse's
   abfss root (`resolveLakehouseAbfss`), builds the Delta table's abfss folder,
   and runs the real ADX mgmt command `createExternalDeltaTable`
   (`.create-or-alter external table … kind=delta`, storage auth via the
   cluster's system-assigned MI). When acceleration is on it also runs
   `setQueryAccelerationPolicy` (best-effort; a failure is reported but the
   external table still works).
3. **Lineage** — a `thread-edges` row `lakehouse → kql-database`.

**Honest gates:** `LOOM_KUSTO_CLUSTER_URI` unset → 503 naming it; a `KustoError`
401/403 names the exact grant (Console UAMI `AllDatabasesAdmin`; cluster MI
`Storage Blob Data Reader` on the ADLS account).

## Promote (medallion) — detail

From a `lakehouse`, promote a bronze/silver Delta table to the next layer — the
medallion spine:

1. **Pickers** — Delta table (`/api/thread/lakehouse-delta-tables`), target
   layer (silver/gold), transform (clean + de-dup / aggregate), and a target
   lakehouse (`loom-item`, `+ Create new`).
2. **Execute** — `POST /api/thread/promote-medallion`: resolves the source +
   target abfss Delta paths and scaffolds a **real Synapse Spark notebook**
   (read source Delta → apply the transform → write the promoted Delta table to
   the target lakehouse's `Tables/`) with both lakehouses attached, exactly like
   the shipped "Analyze in a Notebook" / "Explore mirrored data" edges. The
   promotion runs on real Synapse Spark (Livy) when the user hits **Run** (the
   proven `%%pyspark` path).
3. **Lineage** — `thread-edges` rows `lakehouse → lakehouse` (the promotion) and
   `lakehouse → notebook` (the scaffolder).

**no-vaporware note:** the notebook + generated PySpark are 100% real; the
promotion executes on the notebook's real Spark backend at Run. No mock.

### Deferred (next Thread PRs)

- lakehouse / KQL / azure-sql-database → Power BI model + API (needs the
  per-backend schema adapter — lands with the columns adapter).
- query → UDF REST endpoint (PR3 remainder); React-Flow node-link mesh viewer.
