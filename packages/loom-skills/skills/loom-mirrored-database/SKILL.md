---
name: loom-mirrored-database
description: Azure-native mirrored database in CSA Loom — replicate sources with ADF CDC / Synapse Link into ADLS Bronze Delta, never Fabric Mirroring. Call adf-client.ts + mirror-engine.ts via /api/items and /api/adf. Triggers on mirrored database, mirroring, CDC, change data capture, replication, Synapse Link, bronze landing.
allowed-tools: Read, Grep, Glob, Bash
---

# loom-mirrored-database — ADF CDC → ADLS Bronze Delta (the Azure-native Mirroring)

A Loom **mirrored-database** continuously replicates an external source (Azure
SQL, Cosmos, etc.) into **ADLS Bronze Delta** using **ADF change-data-capture**
(or Synapse Link copy). It is NOT Fabric Mirroring.

## Clients

`apps/fiab-console/lib/azure/adf-client.ts` (CDC top-level resources + pipelines)
and `mirror-engine.ts` (the orchestration that wires source → CDC → Delta).

Key behaviour:

- `adf-client.ts` exposes the CDC + pipeline surface (`listPipelines()`,
  `upsertPipeline()`, `runPipeline()`, plus the CDC top-level resource methods)
  used to provision the replication.
- `mirror-engine.ts` resolves the source, lands snapshots as Delta in the
  `bronze` container, and converts landed `https` DFS URLs into the Spark
  `abfss://` form via `httpsToAbfss()` from `cloud-endpoints.ts` (sovereign-correct).

## Auth

UAMI-first chain. The UAMI needs **Data Factory Contributor** on the factory and
**Storage Blob Data Contributor** on the landing account (granted in bicep —
the mirror task explicitly added the Blob Data Contributor grant).

## BFF routes

`/api/items/mirrored-database/[id]/**` and `/api/adf/**`. The mirror-source
wizard posts the source spec; the route provisions the CDC pipeline and reports
real run status — `{ ok, data: { runId, tables: [...] } }`. No mock table list.

## Do / don't

- DO land replicated data as Delta in `bronze` and register it for Synapse query.
- DO use `httpsToAbfss()` for any Spark path — it handles the Gov DFS suffix.
- DON'T call the Fabric Mirroring REST API on the default path.
- DON'T leave the wizard in a stuck state — surface the real ADF run status.

## Cross-links

UI parity: `docs/fiab/parity/mirrored-database.md`, `adf-change-data-capture.md`.
Backend map row: mirrored-database in `.claude/rules/no-fabric-dependency.md`.
