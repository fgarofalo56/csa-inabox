---
name: W07-search-performance-at-scale
status: backlog
priority: P1
order: 23
depends_on: [W02b-fhir-core-ops, W03b-dicom-core-b]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-10-22
---
# W7 — Search, indexing, bulk operations, quotas and subscriptions (code items + small-scale functional run)

Shared rules: `PRP.md` section 5. Class-M characterisation moved out to `W13-class-m-characterisation.md` (operator decision 2026-11-14: not approved).

## Goal
Finalise a measured-pattern index set (ADR-008 v2, provisional), reindex and selectable-parameter migrations, `$bulk-delete` / `$bulk-update`, per-tenant quotas with a noisy-neighbour functional test, topic-based subscriptions (D27), and a SMALL-SCALE functional test run on one class-S stamp under the existing $4k cap.

## Why
The code must exist and be proven to function before anyone pays for full-scale characterisation. The $25k Class-M run is a separate decision, last in order.

## Scope / Non-goals
In: W7-1 .. W7-5. Out: any claim about 1 M or 10 M patient behaviour, any p95 pass-bar verdict, and Class-M spend (all W13). Small-scale numbers are quoted as orientation and are never bar results.
> ASSUMPTION: "small scale" = one class-S stamp in Commercial, a cohort no larger than what W0 already loaded on DEV (about 92 k resources, `W0-RECEIPT.md`) up to 100 k patients, stamp deleted at the end with the deletion in the receipt, total Azure spend for this wave under the $4k cap of `OPERATOR-DECISIONS-2026-10-22.md` Q2. The orchestrator confirms the cap is not already spent by W0 before W7-1 starts.

## Acceptance criteria
- [ ] W7-1: a receipt (`W7-RECEIPT.md`) lists the stamp class, cohort size, request counts, windows and p95 per pattern, labelled "functional, small scale, not a pass-bar result". Fails if any row claims a bar verdict or a patient count the run did not load.
- [ ] W7-2: every retained search parameter has a pattern in the measured set that uses it (EXPLAIN shows the index used); a parameter with no using pattern is removed. Fails if an index is kept whose pattern was not run.
- [ ] W7-3: `$bulk-delete` with `_hardDelete` is refused without the confirm token and every delete is audited (event count equals deleted count); reindex duration on the small cohort is recorded.
- [ ] W7-4: with tenant A at 5x quota, tenant B returns correct results with no 429 and its p95 is recorded against its own baseline; tenant A receives 429. Fails if A is never throttled.
- [ ] W7-5: N matching writes produce N notifications and non-matching writes produce none.

## Read first
`adr/ADR-008-search-and-indexing.md`, `CAPACITY-MODEL.md` sections 4 and 10, `TEST-STRATEGY.md` section 5 (L1, L6, L7 definitions), `scripts/measure/health/fhir-engine-load.sh`, `fhir-engine-query.sh`, `sandbox.sh`, `synthea-generate.sh`, `apps/loom-health-fhir/plugin/src/` (outbox), `W0-RECEIPT.md`.

## Owns
`tests/health/load/**`, `W7-RECEIPT.md`, `adr/ADR-008-search-and-indexing.md` (v2 section), `apps/loom-health-fhir/config/search-params.json`, `apps/loom-health-fhir/plugin/src/search/**` (index migrations, search-params only; ASSUMPTION: the search plugin path set by W02a/W02b, use theirs if it differs), `apps/loom-health-cp/src/jobs/reindex-*.ts`, `bulk-delete-*.ts`, `bulk-update-*.ts`, `apps/loom-health-cp/src/routing/quotas.ts`, `apps/loom-health-fhir/plugin/src/subscriptions/**`, the rate-limit rules in `platform/fiab/bicep/modules/health/ingress.bicep` (one small bicep PR), the gate entry wording for reindex.

## Must NOT touch
`CAPACITY-MODEL.md` section 10 (W13 owns it), export/de-id/sink files (W06 PRPs), `engines.bicep`, `stamp.bicep`.

## Consumes
W02b (HAPI config, outbox), W03b (stamp for the shared stamp run), the job runner (`apps/loom-health-cp/src/jobs/runner.ts`), the existing measurement scripts, the bicep ledger.

## Provides
Provisional ADR-008 v2, bulk-op and reindex jobs, quota enforcement and subscriptions for later waves; the load harness and the measured-pattern list that W13 reuses at full scale.

## Steps
1. W7-1 harness and the small-scale run (sandbox via `scripts/measure/health/sandbox.sh`, record, delete). 2. W7-2 from the EXPLAIN evidence (Opus design pass). 3. W7-3 and W7-5 in parallel. 4. W7-4 (bicep PR queued behind the ledger). 5. Close the wave by stating in the receipt which W0 pass bars remain owed (all go to W13).

| ID | Title | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|
| W7-1 | Small-scale functional run: harness for L1, L6 (50 patterns) and L7 at class S; bytes/resource and index sizes recorded as orientation | W2, W3 | Sonnet | none | `W7-RECEIPT.md` tables |
| W7-2 | ADR-008 v2 (provisional) from measured patterns; composite/partial/BRIN/trigram set | W7-1 | Opus design | required | Before/after p95 table at small scale |
| W7-3 | Reindex / selectable-parameter migrations; `$bulk-delete`, `$bulk-update` | W7-2 | Sonnet | required (destructive) | Confirm-token and audit tests |
| W7-4 | Quotas, priority classes, connection-pool partitions, rate-limit rules | W7-1 | Sonnet | none | Noisy-neighbour functional test |
| W7-5 | Topic-based subscriptions on the outbox | W2-4 | Sonnet | none | N-for-N notification test |

## Validation
```
cd apps/loom-health-cp && npx vitest run src/jobs src/routing && npx tsc --noEmit -p tsconfig.test.json
bash scripts/measure/health/fhir-engine-query.sh   # args per its header; the L6 pattern run
make lint-bicep
```
Receipts: Commercial run id for the small-scale run; GCC-High: a functional smoke only via an Actions run (no Gov scale run is planned or claimed). Mutation receipt on a sandbox copy: remove the `_hardDelete` confirm check and the refusal test goes red. "Merged, not deployed" until a run id exists. IL5, DoD and GCC are supported-in-code only.

## Rollback
Index migrations are versioned and reversible; the sandbox stamp is deleted at the end of the run; quotas and subscriptions are flag-gated.

## Docs to update
`adr/ADR-008-search-and-indexing.md`, `TEST-STRATEGY.md` section 9 (W7 row: small-scale functional, bars deferred to W13), `OPERATIONS-AND-BCDR.md` section 3 (quota values, measured at small scale and labelled so).

## Wave / Blocked-by / Branch / Worktree
`Wave: 5 · Blocked-by: W02b-fhir-core-ops, W03b-dicom-core-b · Branch: feat/lhds-w07-search-performance · Worktree: E:/Repos/_lhds-w07`

## Hot files
`platform/fiab/bicep/modules/health/ingress.bicep` (one PR, ledger), `apps/loom-health-fhir/config/search-params.json`. `touches_bicep: yes`.
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## Kickoff prompt
```
Wave W07 (LHDS search, bulk ops, quotas, subscriptions; SMALL-SCALE ONLY). Repo E:/Repos/GitHub/csa-inabox, worktree E:/Repos/_lhds-w07, branch feat/lhds-w07-search-performance.
Read first: PRP.md (sections 5 and 7), this file, adr/ADR-008, scripts/measure/health/sandbox.sh.
Spend cap: under $4k total, one class-S stamp, delete it after the run. NO class-M, NO 1M/10M claims: that is W13 and is not approved.
Do W7-1, W7-2, then W7-3/W7-5 in parallel, then W7-4 (bicep via INTERLOCK.md).
Proof: cd apps/loom-health-cp && npx vitest run src/jobs src/routing ; W7-RECEIPT.md labelled "functional, small scale".
Report merged-but-not-deployed in those words.
```

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W7-1 | todo | | sonnet | | 2026-11-14 |
| W7-2 | todo | | opus | | 2026-11-14 |
| W7-3 | todo | | sonnet | | 2026-11-14 |
| W7-4 | todo | | sonnet | | 2026-11-14 |
| W7-5 | todo | | sonnet | | 2026-11-14 |
