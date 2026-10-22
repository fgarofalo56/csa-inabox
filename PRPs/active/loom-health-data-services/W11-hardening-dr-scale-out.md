---
name: W11-hardening-dr-scale-out
status: backlog
priority: P1
order: 12
depends_on: [W09-viewer-editors-copilot]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W11 — Hardening, DR, stamp evacuation, scale-out to N stamps, measured SLOs

**Goal**: chaos and DR drills, stamp evacuation, region failover with the
alternate-region stamp, scale-out from 1 to 3 stamps with linearity measured,
MPI across stamps, blue/green engine upgrade rehearsal, measured SLO table
replacing the TARGET table, runbooks, cost attribution views.

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W11-1 | Chaos suite (Chaos Mesh): pod kills, PostgreSQL HA failover during writes, Blob 503 injection, PDP outage; receipts | `tests/health/chaos/**`, `.github/workflows/health-chaos.yml` | W9 | Sonnet | none | Zero committed writes lost; fail-closed proven; duplicates = 0 |
| W11-2 | Backup/restore drills: tenant PITR to scratch, full-stamp restore; measured RPO/RTO | `apps/loom-health-cp/src/jobs/restore-drill.ts`, `OPERATIONS-AND-BCDR.md` (section 4 measured values) | W9 | Sonnet | **required** (restore tooling touches production backups) | Row counts + hashes equal; durations recorded |
| W11-3 | Stamp evacuation job (drain, copy via logical replication / Blob copy, outbox replay, cutover, verification, read-only retention, crypto-shred) and the quarterly drill | `apps/loom-health-cp/src/jobs/evacuate-*.ts`, `OPERATIONS-AND-BCDR.md` section 6 (measured) | W11-2 | **Opus** (design pass) | **required** | Counts and hashes equal across stamps; write freeze <= 60 s measured |
| W11-4 | Alternate-region stamp + region failover drill (replica promotion, Blob object replication, routing flip) in Commercial; Gov via Actions where a second Gov region is funded (Q1/Q2) | `platform/fiab/bicep/modules/health/stamp.bicep` (replication/alternate params — bicep lane), `apps/loom-health-cp/src/jobs/failover-*.ts` | W11-3 | Sonnet | **required** (bicep) | RPO/RTO measured; the per-cloud table states which clouds were drilled |
| W11-5 | Scale-out 1 -> 3 stamps with 10 synthetic tenants; MPI `$match` and bounded cross-stamp `$everything`; L8 linearity; evaluation of matching (D11) with precision/recall on synthetic data | `apps/loom-health-cp/src/mpi/**`, `tests/health/load/scale-out-*.js`, `W11-RECEIPT.md` | W11-3 | Sonnet | none | Aggregate QPS within 10 % of linear; MPI pointers correct for every synthetic patient |
| W11-6 | Blue/green engine upgrade rehearsal (HAPI minor, dcm4chee patch) with canary tenants; upstream watch job | `apps/loom-health-cp/src/jobs/upgrade-*.ts`, `.github/workflows/health-upstream-watch.yml` | W9 | Sonnet | none | Promotion gated on SLO + conformance smoke; rollback flip measured |
| W11-7 | SLO table measured (replaces TARGET), runbooks, cost attribution views (tags, program budget), admin page updated | `OPERATIONS-AND-BCDR.md` (sections 1, 4-6), `docs/fiab/health/runbooks/**`, `apps/fiab-console/app/admin/health-services/**` (cost + drills) | W11-1..W11-6 | Sonnet | none | Every TARGET replaced by a measured value with its receipt or marked "not measured: why" |

Lanes: L1 = W11-1 -> W11-6; L2 = W11-2 -> W11-3 -> W11-4 (bicep queued);
L3 = W11-5; L4 = W11-7 last.

## Done receipt
Commercial: all drills with receipts; GCC-High: chaos + restore drill via
Actions; failover drill in Gov only if a second Gov region exists (stated).

## Rollback
Drills run on synthetic tenants; nothing destructive on real tenants.

## Cost / credit estimate
~14 Sonnet sessions, 1 Opus pass; Azure: 3 class-S stamps for ~3 weeks
(~$25 k) plus an alternate-region stamp.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W11-1 | todo | | sonnet | | 2026-10-22 |
| W11-2 | todo | | sonnet | | 2026-10-22 |
| W11-3 | todo | | opus | | 2026-10-22 |
| W11-4 | todo | | sonnet | | 2026-10-22 |
| W11-5 | todo | | sonnet | | 2026-10-22 |
| W11-6 | todo | | sonnet | | 2026-10-22 |
| W11-7 | todo | | sonnet | | 2026-10-22 |
