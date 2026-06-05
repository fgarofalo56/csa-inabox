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

### Deferred (next Thread PRs)

- lakehouse / KQL / azure-sql-database → Power BI model (needs the per-backend
  schema adapter — lands with the columns adapter in PR4).
- Report build from the model + embedded report in Loom (PR5 deepening).
- data-agent **semantic-model (DAX)** execution via `executeQueries` (PR5
  deepening — unblocks grounding on a Power BI model's measures).
- table/query → API endpoint (PR3); medallion promotion + mesh viewer (PR4).
