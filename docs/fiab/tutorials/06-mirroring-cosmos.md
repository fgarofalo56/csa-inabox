# Tutorial 06 — Mirroring from Cosmos DB

Create a Mirrored database item that snapshots a Cosmos DB container into
an ADLS Bronze layer, then explore it downstream with **Weave**.
**30 minutes.**

## Prerequisites

- Workspace from previous tutorials
- A Cosmos DB account + database + container (or the test container in
  `examples/fiab-quickstart/cosmos-seed/`)
- A connection (Key Vault-backed) to that Cosmos account — you can create
  one inline in the wizard

The Azure-native mirror engine copies to ADLS Bronze; no real Fabric
mirroring is required.

## How the Mirrored database editor works

You create a Mirrored database item with a guided wizard (source card →
Key-Vault connection → optional table subset → Start). The engine
snapshots source tables to ADLS Bronze CSV and exposes per-table metrics
plus ready-to-paste `OPENROWSET` SQL. Start/Stop is a single
`/state` call. There is no mirroring CLI and no per-workspace
"Mirroring pane".

## Steps

### 1. Create a Mirrored database

Left nav → **Workspaces** → open your workspace → **New item** → category
**Data Engineering** → **Mirrored database**. The Mirrored database editor
opens with its create wizard.

### 2. Choose the source

In the wizard, pick a source card. The available sources are **Azure SQL
Database, Azure SQL MI, Azure Database for PostgreSQL, Cosmos DB,
Snowflake, SQL Server 2025, SQL Server 2016-2022,** and **Open
mirroring**. Choose **Azure Cosmos DB**.

### 3. Workspace, name, connection

Pick the workspace (loaded from `GET /api/loom/workspaces`), enter a mirror
display name, and choose a connection. The connection picker uses the Loom
**ConnectionBuilder** — select an existing Key Vault-backed credential or
create one inline (it POSTs to `/api/loom/connections`).

### 4. (Optional) Pick a table/container subset

The wizard can list source tables/containers
(`GET /api/items/mirrored-database/new/tables?…`). Leave the selection
empty to mirror everything, or check specific containers.

### 5. Create

Review the summary and click **Create** (POSTs to
`/api/items/mirrored-database`). The item lands in the workspace tree.

### 6. Start the mirror

In the editor, click **Start** (POSTs `{ action: 'start' }` to
`/api/items/mirrored-database/<id>/state`). The engine snapshots the
source to ADLS Bronze CSV at
`LOOM_BRONZE_URL/mirrors/<wsId>/<mirrorId>/<schema>.<table>/snapshot.csv`.
For Cosmos DB it reads each container with a data-plane `SELECT * FROM c`
via the Cosmos SDK (SQL-family sources use TDS plus change-feed enablement).

### 7. Inspect the per-table metrics

The per-table grid refreshes from the run result: row count, bytes, last
sync, truncation flag, and a copyable `OPENROWSET` query. Click **Copy
SQL** for a table to get a Synapse Serverless query ready to paste into a
lakehouse SQL tab or a notebook:

```sql
SELECT TOP 100 *
FROM OPENROWSET(
  BULK 'abfss://.../mirrors/<wsId>/<mirrorId>/<schema>.<table>/snapshot.csv',
  FORMAT = 'CSV', PARSER_VERSION = '2.0', HEADER_ROW = TRUE
) AS rows
```

### 8. Explore downstream (Weave)

Use the item's **Weave** edges to go further:

- **Explore in Notebook** (`POST /api/thread/mirror-to-notebook`) opens a
  notebook prefilled with a Spark cell per table reading its `abfss` path.
- **Add to Lakehouse** (`POST /api/thread/mirror-to-lakehouse`) creates a
  file shortcut per table into a lakehouse you choose.

From there you can transform Bronze → Silver with the
[Tutorial 02 pattern](02-first-lakehouse.md).

### 9. Stop the mirror

Click **Stop** (POSTs `{ action: 'stop' }` to the `/state` endpoint).

## The honest gap

Today the engine does a **snapshot** copy. Ongoing Cosmos CDC, plus the
Azure-native copy runtime (ADF / Synapse Link) for **Snowflake** and **Open
mirroring**, are disclosed follow-ups: choosing those source cards shows an
honest gate on Submit rather than silently stubbing. See
[`mirrored-database`](../workloads/mirrored-database.md).

## What's next

- Transform Bronze → Silver via the [Tutorial 02 pattern](02-first-lakehouse.md)
- Wire Activator rules on the data per [Tutorial 04](04-activator-rules.md)
- [Mirroring parity workload](../workloads/mirroring-parity.md)
- [Mirroring Engine service docs](../services/mirroring-engine.md)

## Cleanup

- Editor: **Stop** the mirror, then delete the item from the workspace
  tree (right-click → Delete)
- The Bronze CSV in ADLS remains; remove it manually if desired

## Troubleshooting

- Empty table list: verify the connection has read permission on the
  Cosmos account
- Snapshot fails for Snowflake / Open mirroring: those are gated follow-ups
  — use a SQL-family or Cosmos source for now
- Schema differs from source: the snapshot reflects the source at copy
  time; re-run **Start** to refresh
