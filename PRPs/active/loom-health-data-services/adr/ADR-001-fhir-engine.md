# ADR-001 — FHIR protocol engine: HAPI FHIR JPA (primary), Medplum (fallback)

Status: **Proposed** (fixed by the W0 receipt; the operator may override via D1).
Date: 2026-10-22. Evidence: `../research/oss-engine-evaluation.md` (retrieved 2026-10-22).

## Context
Loom owns the platform (auth, tenancy, storage, scale, ops, UI); the FHIR
engine is proven OSS we run, extend and contribute to. Constraints: permissive
licence, PostgreSQL on Azure Government, AKS, no calls home, published scale
evidence, horizontal scalability and a sharding/partitioning story, US Core /
SMART / Bulk Data conformance, maintenance health.

## Options
| Option | Licence | DB | Conformance | Scale evidence | Health | Verdict |
|---|---|---|---|---|---|---|
| HAPI FHIR JPA (jpaserver-starter) | Apache-2.0 | PostgreSQL (also others) | Inferno reference server is HAPI; US Core, SMART (with an external authorizer), Bulk Data | Independent benchmark (health-samurai, 2026-06): 3,058 CRUD RPS, 2,214 res/s import, 1,005 search RPS on 8 vCPU + PG18; ~22.6 GB per ~2 M resources (3x Medplum) | v8.8.2 (2026-09-25), chart 0.25.0, 756 commits/90 d | **Primary** |
| Medplum | Apache-2.0 | PostgreSQL only | ONC-certified g(10) (CHPL, 2025-12-31), built-in SMART 2.0 | 1,420 CRUD RPS / 764 res/s (same benchmark) | active; three High CVEs in 2026 (fixed >= 5.1.14) | **Fallback** |
| Microsoft fhir-server | MIT | SQL Server / Cosmos (Cosmos provider ends 2026-09-30); **no PostgreSQL** | AHDS lineage | slowest in the benchmark (440 RPS) | active | Rejected: no PostgreSQL; would force Azure SQL into the stamp and a .NET/SQL ops stack |
| Blaze | EPL (verify) | RocksDB / Kafka+Cassandra | strong search; no SMART | 2 M patients / 400 M resources per instance (MII sites) | active | Rejected: storage model and no SMART/Helm |
| LinuxForHealth FHIR | Apache-2.0 | PostgreSQL | good | — | 0 commits/90 d | Rejected: unmaintained |
| Smile CDR, Aidbox, Firely | commercial | — | — | — | — | Comparison only (excluded by mandate) |

## Decision
HAPI FHIR JPA is the engine. Loom supplies: the authorization server (SMART v2
over Entra, ADR-010), the PDP interceptor (ADR-011), per-tenant databases and
partition mode from day one (ADR-003), the trimmed search-parameter set
(ADR-008), the outbox relay (ADR-007), audit interceptors, the log scrubber,
Helm values and the AKS Deployment in bicep, and the parallel export workers
(W6). Medplum is kept buildable as the fallback: W0 loads the same Synthea
cohort into both and records the numbers; if HAPI misses the W0 pass bar
(section "W0 pass bar" below) Medplum becomes primary without re-planning
because the Loom-owned layers above are engine-agnostic by construction (the
FHIR REST contract is the seam).

## W0 pass bar (what would reverse this decision)
Any of: disk bytes per resource > 6 KB at 1 M patients (capacity model
assumption 4.5 KB); search p95 on the ADR-008 pattern set > 1 s at 1 M
patients on a class-M database; a CVE process that leaves a Critical open > 30
days in the last 12 months; a failed Inferno US Core run that cannot be fixed
by configuration.

## Consequences
- Java/Spring operational surface (JVM tuning, transitive CVE churn); mitigated
  by the image pool rebuilds and Trivy gate.
- Index bloat (`HFJ_SPIDX_*`): the search-parameter set is curated (ADR-008)
  and reindex is a planned migration.
- Cross-database sharding is Loom's to build (the MegaScale feature is
  commercial): the stamp model (one DB per tenant, stamps per region) is that
  build, and HAPI's partition mode handles intra-tenant partitioning.
- No built-in auth is a feature here: Loom's authorization server is the single
  identity path across FHIR and DICOM.

## Reversal cost
Medium: data is portable via `$export` / `$import` (ndjson); the Loom layers
are engine-agnostic; a swap on a populated stamp is an evacuation-shaped
migration (`OPERATIONS-AND-BCDR.md` section 6), ~days per class-M stamp.
