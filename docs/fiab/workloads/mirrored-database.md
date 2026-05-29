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

Loom's parity for Fabric Mirrored Database — replicate an external
relational source (Azure SQL, Snowflake, Cosmos, Postgres, MSSQL,
SqlServer2025) into a lakehouse-native Delta target via incremental
change feed. The editor captures source type + connection + selected
tables; the BFF wires the connector (open mirroring or
provider-specific) and surfaces per-table replication metrics.

## Fabric-parity gap

| Fabric feature | Loom state |
|---|---|
| New mirror wizard (source picker + tables) | Shipped |
| Replication status (Running / Stopped / Failed) | Shipped |
| Per-table metrics (rows replicated, lag) | Shipped — surfaced from connector logs |
| Stop / Start | Shipped |
| Schema drift handling | Gated — surfaced as `MessageBar warning` per row |

## Real backend it calls

- Cosmos `items` for the mirror config.
- Provider-specific connector (Debezium for Postgres, native SqlServer
  CDC, Snowflake streams, Cosmos change feed) — see
  `lib/azure/*-client.ts` per source.

## Sample usage

1. Open `/items/mirrored-database/new?workspaceId=…`.
2. Click **New mirror**, pick source type.
3. Fill server / database / auth.
4. Pick tables to mirror.
5. **Start** → replication begins; metrics populate within ~30s.

## Bicep + env vars

| Env | Purpose | Bicep module |
|---|---|---|
| `LOOM_STORAGE_ACCOUNT` | Delta sink | `landing-zone/storage.bicep` |
| `LOOM_MIRROR_RG` | Connector workloads (optional) | DLZ |
| `LOOM_UAMI_CLIENT_ID` | Console UAMI | `identity.bicep` |
