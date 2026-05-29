# Loom Mirrored Database Editor — Fabric-parity spec

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


> Captured 2026-05-26 by catalog agent. Source: Fabric Mirroring docs (`learn.microsoft.com/fabric/mirroring/**`) + live `MirroredDatabaseEditor` in `apps/fiab-console/lib/editors/mirrored-database-editor.tsx`.

## Overview
Fabric Mirroring continuously replicates an external operational database (Azure SQL DB, Azure SQL MI, Azure DB for PostgreSQL / MySQL, Snowflake, Cosmos DB, Azure Databricks Unity Catalog, Oracle, SQL Server 2025) into OneLake as Delta Parquet, with near-real-time CDC and a SQL Analytics endpoint for read-only T-SQL. Zero-ETL, zero capacity charge for the replication compute itself. Fits the "land + serve" leg of the medallion flow: source → mirrored Delta → downstream Lakehouse/Warehouse/PBI consumers.

## UI components

### Create wizard ("New mirrored <source>")
- **Source picker** (Create hub): one card per source type — `Mirrored Azure SQL Database`, `Mirrored Azure SQL MI`, `Mirrored Azure Database for PostgreSQL`, `Mirrored Azure Database for MySQL`, `Mirrored Snowflake`, `Mirrored Cosmos DB`, `Mirrored Azure Databricks catalog`, `Mirrored Oracle`, `Mirrored SQL Server 2025`, `Open mirroring` (generic)
- **Connection pane**:
  - "New connection" vs "Existing connection" toggle
  - Server / endpoint URL · Database / Catalog · Warehouse (Snowflake only)
  - Connection name (auto-filled, editable)
  - **Data gateway** dropdown (None / on-prem gateway / VNet gateway)
  - Authentication kind picker per source (Basic, OAuth, Service Principal, Snowflake, Org account)
  - Username + Password / KV reference
  - "Use encrypted connection" checkbox
  - **Connect** button → tests + saves connection
- **Choose data screen** (post-connect):
  - **Auto mode** ("Mirror all data") — replicate every table + auto-pick-up new tables created later
  - **Manual** — multi-select tree: Catalog → Schemas → Tables (Databricks adds Catalog level; Snowflake adds DB → Schema → Table; SQL adds Schema → Table). Up to 1,000 tables per mirror.
  - For Databricks: "Automatically sync future catalog changes for the selected schema" toggle (default on)
  - Inclusion/exclusion list editor
- **Review and create** — final name + summary; **Create mirrored database** button kicks off provisioning

### Monitor replication page (post-create main view)
- **Database-level status badge** in header — one of: `Running` · `Running with warning` · `Initializing` · `Stopping` · `Stopped` · `Paused` · `Failed`
- **Tables table** with columns:
  - **Name** — `[schema].[table]`
  - **Status** — Running / Running with warning / Stopped / Failed / NotSupported (with info icon explaining the unsupported data type)
  - **Rows replicated** — cumulative inserts + updates + deletes applied to target
  - **Last completed** — last successful refresh timestamp from source (empty if never)
- **Refresh** button on the SQL Analytics endpoint sub-tab to force metadata sync
- **Latency / batch metrics** — surfaced through workspace monitoring (`MirroredDatabaseTableExecution` KQL table, `ReplicatorBatchLatency` column)

### Top toolbar / ribbon
- **Stop replication** / **Start replication** buttons (state-aware)
- **Monitor replication** link (jumps to status page)
- **Configure mirroring** / **Edit table selection** — re-opens the Manual table picker for adds/removes
- **SQL analytics endpoint** tab — opens the read-only T-SQL query editor against the mirrored Delta
- **Settings** — workspace context, retention, replication mode (continuous vs scheduled batch where supported)
- **Refresh** schema cache button
- **Share** / **Lineage** / **Properties** (right-hand panel toggles)

### Lakehouse / Notebook integration
- "Explore with notebooks" — creates a Lakehouse shortcut to the mirrored Delta path so Spark notebooks can query it
- Cross-workspace shortcut consumption from any Lakehouse or Warehouse

### CI/CD pipeline integration
- Mirrored DB participates in Fabric deployment pipelines (dev → test → prod)
- Per-stage **Data source rules** to swap the source connection ID between environments
- After deploy, replication must be **manually started** on the target stage

## What Loom has today
- **`MirroredDatabaseEditor`** wired to **live Fabric REST** at `/api/loom/workspaces` + `/api/items/mirrored-database/**`
- **Workspace picker** populated from real `GET workspaces`
- **List pane (left tree)** — real `GET workspaces/{ws}/mirroredDatabases` results
- **Create dialog** — minimal wizard with: displayName · source-type card grid (Azure SQL DB, MI, PG, Cosmos, Snowflake, SQL2025, MSSQL, Open mirroring) · server · database fields. Posts inline-base64 `mirroring.json` per the Fabric REST spec.
- **Status badge** — pulls live `status.status` (Running, Initializing, Stopped, etc.) with color mapping
- **Tables replication table** — pulls live `tables.data[]` (sourceSchemaName, sourceTableName, status, metrics.processedRows, metrics.processedBytes, metrics.lastSyncDateTime)
- **Start / Stop** buttons → `POST /state` action
- **Delete** mirror via `DELETE /api/items/mirrored-database/{id}`
- Ribbon shell (Home > Replication: Start/Stop/Status · Item: New/Delete)
- Auth gate: requires Console UAMI SP authorized in Fabric tenant + added to workspace; 401/403 surface verbatim
- This is already a **B-grade** editor — no mocks, real Fabric REST round-trip, real Delta replication when granted

## Gaps for parity
1. **Connection authoring** — Loom captures server + database only; needs full connection wizard (credentials, gateway dropdown, auth kind, encrypted toggle, test-connection)
2. **Auto vs Manual + table multi-select tree** — currently no pre-create table selection; mirrors are created against the whole DB. Needs Catalog → Schema → Table tree with 1,000-row multi-select and include/exclude lists.
3. **Databricks Unity Catalog source** — not in the card grid; needs catalog/schema/table tree + "auto-sync future catalog changes" toggle
4. **MySQL + Oracle sources** — not exposed in source picker
5. **Latency metrics surface** — current table shows rows + last sync but not batch latency; needs `ReplicatorBatchLatency` from workspace monitoring KQL
6. **Replication mode toggle** — start/stop only; no scheduled-batch vs continuous distinction
7. **SQL Analytics endpoint launcher** — needs a button/tab to open the read-only T-SQL editor (warehouse editor) against the mirrored DB
8. **Lakehouse shortcut helper** — "Create shortcut in Lakehouse X" action for downstream consumption
9. **Edit table selection post-create** — adding/removing tables after the mirror is live
10. **Deployment pipeline data-source rules** — not in scope today
11. **NotSupported per-table reason tooltip** — Fabric shows an info icon explaining the unsupported data type; Loom shows raw `status` only

## Backend mapping
Loom already uses the **real Fabric Mirroring REST API** for all CRUD, so this is rare among Loom editors: the backend gap is **not** "replace mocks with Azure"; it's "deepen the wizard + expand source coverage". Concretely:

- **Create**: `POST /v1/workspaces/{ws}/mirroredDatabases` with `definition.parts[0].path = mirroring.json` (inline-base64). Loom's `mirroringDef` JSON shape today is `{ properties: { source: { type, typeProperties: { server, database } }, target: { type: 'MountedRelationalDatabase', typeProperties: { format: 'Delta' } } } }` — extend `typeProperties` to include `connectionId`, `tables[]`, `mountedTables[]` for table-level selection.
- **Connections**: `POST /v1/connections` to create the source-side connection first; persist `connectionId` and pass into `mirroringDef.properties.source.typeProperties.connectionId`. Today Loom hard-passes server/db, which only works for very simple shapes.
- **List/Get**: `GET /v1/workspaces/{ws}/mirroredDatabases` + `GET /v1/workspaces/{ws}/mirroredDatabases/{id}` — wired
- **Status**: `GET /v1/workspaces/{ws}/mirroredDatabases/{id}/getMirroringStatus` — wired
- **Per-table status**: `GET /v1/workspaces/{ws}/mirroredDatabases/{id}/getTablesMirroringStatus` — wired
- **Start / Stop**: `POST .../startMirroring` and `POST .../stopMirroring` — wired
- **Latency telemetry**: when workspace monitoring is enabled, query the Monitoring KQL DB `MirroredDatabaseTableExecution` table for `ReplicatorBatchLatency` — needs a new BFF route, e.g. `GET /api/items/mirrored-database/{id}/latency?workspaceId=...&window=1h`
- **SQL Analytics endpoint discovery**: `GET /v1/workspaces/{ws}/mirroredDatabases/{id}` returns the SQL endpoint connection string under `properties.sqlEndpointProperties` — feed it into the existing warehouse editor for T-SQL

## Required Azure / Fabric resources
- Fabric Capacity (F/P SKU) on the target workspace
- Source database with mirroring prerequisites enabled — e.g. for Azure SQL DB: System Assigned Managed Identity + `ALTER DATABASE ... SET CHANGE_TRACKING = ON`; for MySQL: `log_bin=ON`, `binlog_row_image=FULL`, `binlog_format=ROW`; for Snowflake: streams + suitable warehouse
- Source connection credentials in Fabric Connections (or KV reference)
- VNet data gateway or on-prem data gateway if source is private
- **Loom UAMI SP** added as Member/Contributor in the Fabric workspace
- Workspace monitoring enabled (optional) for `ReplicatorBatchLatency` telemetry

## Estimated effort
2-3 sessions:
- **Session 1**: extend create wizard — add full connection authoring (auth kind, gateway, test connection), add Auto/Manual toggle + table-selection tree with 1,000-row multi-select, persist `connectionId` + `tables[]` into `mirroringDef`
- **Session 2**: add Databricks Unity Catalog source (catalog tree + auto-sync toggle), add MySQL + Oracle source cards, surface `NotSupported` reason tooltip on per-table rows
- **Session 3**: workspace-monitoring KQL latency feed (`/latency` BFF route + sparkline) + SQL Analytics endpoint launcher + Lakehouse-shortcut helper button

Already at B grade; this work pushes to A / A+ with workspace-monitoring backed latency charts and table-level selection.
