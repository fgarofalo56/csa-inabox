# Mirrored Database — workload reference

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


> **Family:** Data Engineering
> **Loom slug:** `mirrored-database`
> **Editor file:** `apps/fiab-console/lib/editors/mirrored-database-editor.tsx`
> **BFF routes:** `app/api/items/mirrored-database/**`
> **Parity spec:** [`fiab/mirrored-database-parity-spec.md`](../mirrored-database-parity-spec.md)

## Purpose

Loom's parity for Fabric Mirrored Database — replicate an external relational
source into ADLS Bronze using **Azure-native services, no Microsoft Fabric**
(per `.claude/rules/no-fabric-dependency.md`). The editor captures source type +
Key-Vault-backed connection + (optionally) selected tables; **Start** runs the
real mirror engine; per-table metrics come back from the actual run.

## How Start works (Azure-native engine)

`lib/azure/mirror-engine.ts` snapshots three source families to ADLS Bronze CSV:

| Source family | Read path | Change feed (ongoing CDC) |
|---|---|---|
| **SQL** — Azure SQL DB / MI, SQL Server 2016-2025 | TDS `SELECT` (`executeParameterized`) | `sys.sp_change_feed_enable_db` (enabled on Start) |
| **PostgreSQL** — Azure DB for PostgreSQL | `pg` wire + Entra token (`executePostgresQuery`); tables from `information_schema` | logical replication — disclosed follow-up |
| **Cosmos DB** — SQL API | data-plane `SELECT * FROM c` (`queryItems`); containers from `listContainers` | native change feed — disclosed follow-up |

Each Start: (1) enables the change feed where supported, (2) enumerates the
tables/containers (or uses the explicit subset), (3) lands each as **CSV in ADLS
Bronze** under `mirrors/<workspaceId>/<mirrorId>/<schema>.<table>/snapshot.csv`,
and (4) returns each one's abfss path + a ready-to-run Synapse Serverless
`OPENROWSET` query so the data is immediately usable from SQL, a notebook, or a
lakehouse shortcut. Cosmos docs are flattened to their top-level keys (nested
objects → JSON string), mirroring how Fabric lands Cosmos.

Snapshots are capped at `LOOM_MIRROR_MAX_ROWS` rows / `LOOM_MIRROR_MAX_TABLES`
tables per run (disclosed in the grid as `(capped)`). Other sources (Snowflake /
open mirroring) return an **honest gate** — their Azure-native copy runtime
(ADF / Synapse Link) is a disclosed follow-up, not a silent stub.

### Incremental change-feed delta (SQL family)

The **first** Start of a SQL-family mirror is a full snapshot. On a **subsequent**
Start, the engine reads only the rows changed since the last run and appends them
as a `delta-<timestamp>.csv` beside `snapshot.csv` — no re-snapshot. Synapse
Serverless' `OPENROWSET` BULK path already targets the whole folder, so the
snapshot and every delta are queried together as one logical table.

This uses **SQL Server Change Tracking** (`CHANGETABLE` /
`CHANGE_TRACKING_CURRENT_VERSION`) — an independent mechanism from
`sp_change_feed_enable_db` (both can be active at once). The engine enables CT at
the database (`CHANGE_RETENTION = 7 DAYS`) and table level on first contact, then
persists a per-table **`syncVersion`** watermark in `state.tablesStatus`. Each
table's grid row shows a **Snapshot** or **Incremental** badge (watermark in the
tooltip).

| Run | Read path | Lands as | Watermark |
|---|---|---|---|
| SQL — first Start | full `SELECT` | `snapshot.csv` | captures `CHANGE_TRACKING_CURRENT_VERSION` |
| SQL — subsequent Start (CT enabled, PK present, watermark valid) | `CHANGETABLE(CHANGES …, <syncVersion>)` joined to the table on its PK | `delta-<timestamp>.csv` | advances to the new current version |
| PostgreSQL / Cosmos | always full snapshot | `snapshot.csv` | n/a |

**Honest fallbacks** (full re-snapshot with a disclosed `note` in the grid):

- **CT not enabled and could not be enabled** — e.g. the console identity lacks
  `db_owner`; the note names the grant needed. CT is turned on so the *next* run
  goes incremental.
- **No primary key** — `CHANGETABLE` requires a PK join; the table re-snapshots.
- **Watermark expired** — the saved version aged out of the 7-day retention
  window (or the table was `TRUNCATE`d, which resets CT); a full re-snapshot
  re-baselines the watermark.

## Editor capabilities

| Capability | Loom state |
|---|---|
| New mirror wizard (source cards + connection + verify) | Shipped |
| **Edit** an existing mirror's config (source / connection / tables) | Shipped (`PATCH /api/items/mirrored-database/[id]`) |
| **Test connection** on an existing mirror | Shipped (`POST …/verify`) |
| **Start** — real change feed + Bronze snapshot | Shipped (`POST …/[id]/state`) |
| **Incremental delta** (SQL family, subsequent Starts via Change Tracking) | Shipped — `delta-*.csv` + per-table `syncVersion` watermark |
| **Stop** | Shipped (landed data + change feed remain) |
| Per-table metrics (rows, bytes, last sync, truncation) | Shipped — from the real run |
| Snapshot vs Incremental badge per table | Shipped — from the real run |
| **Copy SQL** (OPENROWSET) per table | Shipped |
| Honest gate when source/Bronze unconfigured | Shipped |

## Use the mirror (Weave)

The **Weave** menu on a mirrored database exposes downstream edges:

- **Explore mirrored data in a Notebook** → a Loom Notebook with a Spark cell
  per replicated table reading its abfss path (`/api/thread/mirror-to-notebook`).
- **Add mirrored tables to a Lakehouse** → a file shortcut per table into a
  chosen lakehouse (`/api/thread/mirror-to-lakehouse`).
- **Query in SQL** → use the per-table **Copy SQL** button (Synapse Serverless
  `OPENROWSET` over the Bronze CSV).

## Real backend it calls

- Cosmos `items` — mirror config + persisted per-table run metrics.
- `azure-sql-client` (`executeParameterized`, `enableMirroring`) — source reads +
  change-feed DDL.
- `adls-client` (`uploadFile`) — CSV landing in Bronze.
- `lakehouse-shortcuts` (`createShortcut`) — the lakehouse Weave edge.

## Bicep + env vars

| Env | Purpose | Bicep module |
|---|---|---|
| `LOOM_BRONZE_URL` | ADLS Bronze landing zone (CSV sink) | DLZ `landing-zone/storage.bicep` |
| `LOOM_MIRROR_MAX_ROWS` | Snapshot row cap per table (default 50000) | console env (optional) |
| `LOOM_MIRROR_MAX_TABLES` | Table cap per run (default 50) | console env (optional) |
| `LOOM_UAMI_CLIENT_ID` | Console UAMI | `identity.bicep` |
