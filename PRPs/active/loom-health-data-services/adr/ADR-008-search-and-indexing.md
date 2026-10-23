# ADR-008 — FHIR search backend and the curated index set

Status: Proposed (Opus design pass in W7). Date: 2026-10-22.

## Context
Elasticsearch/OpenSearch is not an Azure-native managed service in Azure
Government; Azure AI Search is not a FHIR search engine (no chained/reverse-
chained semantics, no `_include`). HAPI's search runs on PostgreSQL index
tables and its storage cost is ~3x the resource JSON (research benchmark), so
the index set must be curated to the measured query mix.

## Decision
- **PostgreSQL is the only search backend in v1.** HAPI search parameters are
  limited to a curated set (US Core required parameters + the pattern list in
  `../CAPACITY-MODEL.md` section 4); every other standard parameter is
  disabled per tenant unless enabled by a versioned migration with a measured
  reindex cost.
- Index tuning: composite search parameters for the top patterns
  (`patient+category+date`, `patient+code+date`), partial indexes per
  partition, `_lastUpdated` BRIN index for incremental scans, trigram index on
  `Patient.name` for the bounded demographic search, uniqueness indexes for
  conditional creates.
- Full-text search over clinical notes is **out of v1** (D20); the path is the
  lakehouse sink (AI Search index over de-identified text in Loom's existing
  pipeline) and, if a tenant needs in-store full text, a self-hosted OpenSearch
  (Apache-2.0) on the stamp's AKS as a secondary index fed from the outbox — an
  escape hatch with its own stateful tier, not the default.
- Pagination: cursor-based (engine-native), `_count` capped at 1,000 (AHDS
  cap, model), `_total=accurate` only for small result sets, otherwise
  `estimate`.
- Protection: `_include`/`_revinclude` depth and fan-out caps; `$everything` on
  a patient > 10 k resources switches to async (`Prefer: respond-async`).

## Options rejected
AI Search as primary (semantics), managed Elasticsearch (absent in Gov),
Cosmos DB (no engine).

## Consequences
Search features outside the curated set are honest gates per tenant ("enable
parameter X: reindex of N resources, ~T hours") with a Fix-it that runs the
migration — never a silent unsupported.

## Reversal cost
Low-medium (adding parameters is a reindex; adding OpenSearch is additive).
