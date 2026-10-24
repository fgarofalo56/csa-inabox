# ADR-003 — FHIR persistence, per-tenant databases, partitioning, versioning, conditional ops, referential integrity, reindex

Status: **Accepted: option 1, relational PostgreSQL with one database per
tenant** (function proof, DEV 2026-10-23; W0-7 decision 2026-10-24 on the
operator's Q2 ruling).
- Unmeasured, carried to W7: index-to-JSON disk ratio at 1 M patients, read
  replica routing, partition mode, and 20 TB restore time.
- The Gov region is corrected by W0-3.

Date: 2026-10-22 (decision 2026-10-24). Evidence: `../research/oss-engine-evaluation.md`,
`../research/azure-gov-availability.md`, `../research/scale-evidence-va-ihs-dicom-pricing.md`,
`../W0-RECEIPT.md` sections 1.3, 4.1, 4.1b and 8.

Measured values: W0 DEV on 1x D8s_v5 and PostgreSQL 16 D2ds_v5. Function
proof, not class-M pass-bar evidence.
- **One database per engine on one Flexible Server works** for HAPI, Medplum
  and dcm4chee (`hapi`, `medplum`, `dcm4chee`, `sslmode=require`, private
  access; Sandbox section and s1.3). Per-tenant roles and partition mode were
  **not** exercised. HAPI ran with default config.
- **HAPI disk per resource: 9,952.7 B net** (s1.3), including index tables.
  - The Consequences line assumed 3x, about 4.5 KB. The absolute figure is
    about 2.2x that.
  - The raw-JSON-to-disk ratio itself was not measured.
  - The 20 TB working-set cap now holds about 2 B resources per tenant
    database, not about 4.4 B (20 TB / 9.95 KB vs / 4.5 KB). That is derived,
    not measured.
- **Azure Flexible Server needs `azure.extensions` set for Medplum**
  (`btree_gin`, `pg_trgm`, `btree_gist`, `unaccent`; s1.3 obs 3). HAPI needed
  none. This is a W1 preflight item.
- **Gov, measured by W0-3** (s4.1, s4.1b):
  - usgovvirginia offers **0 SKUs** to this subscription (`OfferRestricted`).
  - usgovarizona offers 31 SKUs with zone-redundant HA, so the Gov primary is
    usgovarizona, paired with usgovtexas.
  - E-series is v3/v4 only, not v5.
  - No SSD v2 was seen, so plan on Premium SSD.
  - Geo-redundant backup outside Virginia was not measured.
- **Unmeasured, carried to W7**: read-replica routing of searches and exports
  ("verified in W0" in the Decision was not verified), partition mode at
  1 M patients, `$reindex` duration, and restore time against the 20 TB cap.

## Context
Need a FHIR store that scales to ~40 B resources across an estate, isolates
tenants provably, restores within RTO, and runs on services in Azure Government.

## Options
1. **Relational PostgreSQL (HAPI JPA schema: resource JSON/JSONB + index tables)**, one database per tenant, stamps per region. In Gov: PostgreSQL Flexible Server in all three US Gov regions (research); 32/64 TiB per server.
2. Distributed PostgreSQL (Citus): Azure Cosmos DB for PostgreSQL is explicitly not available in Azure Government and is on a retirement path; Elastic Clusters availability in Gov is UNVERIFIED (research). Rejected for v1; re-evaluated when Elastic Clusters show a Gov row.
3. Document store (Cosmos DB NoSQL): no OSS FHIR engine with a maintained Cosmos provider (Microsoft's ends 2026-09-30). Rejected.
4. Search-index hybrid (PostgreSQL + OpenSearch/Elasticsearch): no managed OpenSearch in Azure Government; self-hosted OpenSearch on AKS is possible but adds a stateful tier. Deferred to ADR-008 as the full-text escape hatch only.

## Decision
Option 1.
- **Tenant isolation**: one PostgreSQL database per tenant on the stamp's server; the engine runs with a per-tenant connection pool and a per-tenant DB role; no role can read another database.
- **Intra-tenant partitioning**: HAPI partition mode enabled at creation (it cannot be enabled later), partition key = facility/site (VA station, IHS facility); patient-id partitioning is evaluated in W7 against the measured search mix.
- **Working-set cap**: 20 TB per tenant database (restore-time driven, `../CAPACITY-MODEL.md` section 5); beyond it the tenant is split by facility group across tenants or the stamp is split.
- **Replicas**: 1-2 read replicas per server; searches and exports are pinned to replicas via the engine's read-only datasource routing (verified in W0; if HAPI cannot split reads, the export workers alone use replicas).
- **Versioning / history**: engine-native, history retained forever by default; a per-tenant retention policy can trim history of non-clinical types (`AuditEvent` is not stored in the FHIR history path — it has its own store).
- **Conditional operations**: `If-None-Exist`, conditional update/delete enabled with the engine's uniqueness guard (a unique index on the matching identifier search param); the concurrency test in `../TEST-STRATEGY.md` section 2 guards it.
- **Referential integrity**: enforced on writes (`enforce_referential_integrity_on_write = true`) and relaxed only for bulk `$import` with a post-import integrity report; deletes blocked when referenced (`enforce_referential_integrity_on_delete = true`) with a documented cascade for patient merge.
- **Idempotency**: client `X-Request-Id` + `Idempotency-Key` honoured for 24 h at the gateway for transaction bundles (duplicate submission returns the original response).
- **Reindex**: `$reindex` per partition, throttled by a concurrency setting, run against the primary during a window with the measured duration from a replica rehearsal; search parameter changes are versioned migrations.
- **Backups**: Flexible Server automated + geo-redundant where available (research: geo-redundant backup in US Gov Virginia only), weekly logical export of each tenant database to immutable Blob.

## Consequences
HAPI's index tables dominate disk (3x assumed, measured in W0); storage cost is
accepted for query predictability. Cross-tenant joins are impossible by
construction (a feature). Operations gain a per-tenant unit for restore,
export, evacuation and deletion (crypto-shred + `DROP DATABASE`).

## Reversal cost
High for the partition decision (must be set at creation), medium for the
rest (ndjson export/import).
