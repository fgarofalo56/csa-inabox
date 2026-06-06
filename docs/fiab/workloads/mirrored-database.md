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

`lib/azure/mirror-engine.ts` — for the **SQL family** (Azure SQL DB / MI / SQL
Server 2016-2025):

1. **Change feed** — enables the source database change feed via the real
   `sys.sp_change_feed_enable_db` primitive (the same CDC engine Fabric mirroring
   consumes, but it is an Azure SQL feature). DDL runs as a deliberate action.
2. **Snapshot** — reads each selected table (or enumerates them) with a real
   read-only `SELECT` and lands it as **CSV in ADLS Bronze** under
   `mirrors/<workspaceId>/<mirrorId>/<schema>.<table>/snapshot.csv`.
3. **Queryable output** — each table returns its abfss path + a ready-to-run
   Synapse Serverless `OPENROWSET` query, so the landed data is immediately
   usable from SQL, a notebook, or a lakehouse shortcut.

Snapshots are capped at `LOOM_MIRROR_MAX_ROWS` rows / `LOOM_MIRROR_MAX_TABLES`
tables per run (disclosed in the grid as `(capped)`). Non-SQL sources
(Postgres / Cosmos / Snowflake / open mirroring) return an **honest gate** —
their Azure-native copy runtime (ADF / Synapse Link) is a disclosed follow-up,
not a silent stub.

## Editor capabilities

| Capability | Loom state |
|---|---|
| New mirror wizard (source cards + connection + verify) | Shipped |
| **Edit** an existing mirror's config (source / connection / tables) | Shipped (`PATCH /api/items/mirrored-database/[id]`) |
| **Test connection** on an existing mirror | Shipped (`POST …/verify`) |
| **Start** — real change feed + Bronze snapshot | Shipped (`POST …/[id]/state`) |
| **Stop** | Shipped (landed data + change feed remain) |
| Per-table metrics (rows, bytes, last sync, truncation) | Shipped — from the real run |
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
