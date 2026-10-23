---
name: W07-search-performance-at-scale
status: backlog
priority: P1
order: 8
depends_on: [W06-bulk-export-deid-lakehouse-sink]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W7 — Search and performance at scale (class M, 1 M and 10 M patients)

**Goal**: prove a class-M stamp at the 1 M-patient cohort (L1 within targets)
and characterise 10 M; finalise the ADR-008 index set from measured patterns;
reindex and custom-search-parameter migrations with measured cost; bulk
delete/update jobs; subscriptions (D27); noisy-neighbour quotas proven (L7).

## Items

| ID | Title | Owns | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|---|
| W7-1 | Class-M sandbox stamp in Commercial; load the 1 M cohort (W0-5 manifests); run L1, L6 (50 patterns) and record bytes/resource, index sizes, replica lag | `tests/health/load/**`, `W7-RECEIPT.md` | W6 | Sonnet | none | Receipt tables with request counts and windows; p95 per pattern |
| W7-2 | Index design pass: measured pattern ranking -> ADR-008 v2 (composite/partial/BRIN/trigram set), partition-by-patient evaluation | `adr/ADR-008-search-and-indexing.md` (v2 section), `apps/loom-health-fhir/config/search-params.json`, migrations | W7-1 | **Opus** (design pass) | **required** | Before/after p95 table; every retained parameter has a pattern that uses it |
| W7-3 | Reindex / selectable-parameter migrations with measured duration and the Fix-it gate wording; `$bulk-delete`, `$bulk-update` jobs (AHDS parameter shapes) | `apps/loom-health-cp/src/jobs/{reindex,bulk-delete,bulk-update}-*.ts`, gate entry | W7-2 | Sonnet | **required** (destructive bulk ops) | A bulk delete with `_hardDelete` requires confirm and is audited; reindex duration on 1 M recorded |
| W7-4 | Quotas and priority classes: per-tenant gateway quotas, connection-pool partitions, Kubernetes PriorityClasses; L7 noisy-neighbour test | `apps/loom-health-cp/src/routing/quotas.ts`, `platform/fiab/bicep/modules/health/ingress.bicep` (rate-limit rules), Helm values | W7-1 | Sonnet | none | Tenant B p95 within 10 % while A is at 5x quota |
| W7-5 | Subscriptions (topic-based R4 backport) on the outbox | `apps/loom-health-fhir/plugin/src/subscriptions/**` | W2-4 | Sonnet | none | Subscription receives N notifications for N matching writes; none for non-matching |
| W7-6 | 10 M characterisation: load what W0-5 reached (or extrapolate, disclosed), record the first bottleneck and update `CAPACITY-MODEL.md` section 10 with measured values | `W7-RECEIPT.md`, `CAPACITY-MODEL.md` (section 10 rows) | W7-1..W7-4 | Sonnet | none | Section 10 rows cite the receipt |

Lanes: L1 = W7-1 -> W7-2 -> W7-3 -> W7-6; L2 = W7-4; L3 = W7-5. Bicep: the
ingress rate-limit change is one small bicep PR.

## Done receipt
Commercial class M at 1 M: L1/L6/L7 receipts; GCC-High: L1 at 100 k on the
Gov stamp via Actions (class M in Gov is a cost decision, Q2).

## Rollback
Index migrations are versioned and reversible; sandbox stamp deleted.

## Cost / credit estimate
~10 Sonnet sessions, 1 Opus pass; Azure: class-M stamp ~$25 k/mo for ~3 weeks.

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W7-1 | todo | | sonnet | | 2026-10-22 |
| W7-2 | todo | | opus | | 2026-10-22 |
| W7-3 | todo | | sonnet | | 2026-10-22 |
| W7-4 | todo | | sonnet | | 2026-10-22 |
| W7-5 | todo | | sonnet | | 2026-10-22 |
| W7-6 | todo | | sonnet | | 2026-10-22 |
