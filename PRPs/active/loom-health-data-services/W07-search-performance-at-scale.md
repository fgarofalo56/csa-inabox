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

## W0 pass bars carried into W7 (W0-7 decision, 2026-10-24)

The operator ruled on Q2 to decide W0 on DEV evidence, with no class-S run.
Every throughput and latency bar that the DEV run could not establish is
therefore owed by this wave's class-M receipts (`W0-RECEIPT.md` s8). DEV values
are quoted only for orientation. None of them is a bar result.

1. **ADR-001: search p95 at most 1 s** on the ADR-008 pattern set, 1 M
   patients, class M, HAPI. DEV worst p95 was 59.6 ms at 92 k resources.
   Feeds W7-1 and W7-2.
2. **ADR-001: bytes per resource at 1 M patients** (HAPI). DEV gave 9,952.7 B,
   which already crosses the 6 KB bar, and the reversal was not taken (ADR-001).
   W7-1 measures the class-M figure and re-bases `CAPACITY-MODEL.md` s1.3 and
   the FHIR-store sizes derived from it.
3. **ADR-002: STOW p95 at most 300 ms** per 512 KiB instance at 100 concurrent
   senders, class M. DEV gave 1,041 ms on a shared node. Two things come first:
   - triage the DEV QIDO JDBC-pool saturation between 100 and 150 senders;
   - triage the about 2,000 duplicate-key errors under concurrent STOW.

   Log the achieved concurrency server-side.
4. **ADR-004: Blob 503 onset and request rate** at class M, with the achieved
   concurrency measured. On DEV, 7,750 of 7,750 PUTs returned 201, up to 400
   *requested* senders.
5. **ADR-003, all unverified on DEV:**
   - read-replica routing of searches and exports;
   - HAPI partition mode at 1 M patients;
   - `$reindex` duration;
   - restore time against the 20 TB working-set cap.
6. **`CAPACITY-MODEL.md` s11, items 2, 3 and 6:**
   - L1 mix req/s and p95 per engine pod at 1 M patients;
   - single-path `$export` res/s (DEV HAPI gave 2,629.76 res/s);
   - Synthea throughput in the pool, and the largest cohort reachable in 48 h.
     W7-6 needs this.
7. **W0-4: the 24 h no-calls-home capture** per engine image on the class-M
   sandbox. DEV covered about 31 minutes of idle only.

Owned outside W7 and listed here so none is lost:
- ADR-001's Inferno US Core run and CVE-process review go to W2.
- Two items are W3 entry gates:
  - ADR-002/004's Blob descriptor against a Gov endpoint, through a GitHub
    Actions run;
  - ADR-002's bearer-token refresher, proven across two or more token expiries
    under STOW load. If that fails, Fallback B is taken.

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
