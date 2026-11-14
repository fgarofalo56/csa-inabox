---
name: W13-class-m-characterisation
status: blocked
priority: P3
order: 99
depends_on: [W12-compliance-evidence-pack, W07-search-performance-at-scale]
blocked_by: operator approval of full-scale spend, requested only after all other work is done and verified; NOT approved 2026-11-14
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
---
# W13 — Class-M characterisation at 1 M and 10 M patients (blocked: spend not approved)

Moved out of the old W07 (items W7-1 full-scale, W7-6, and the "W0 pass bars carried into W7" section). Shared rules: `PRP.md` section 5.

## Goal
Measure a class-M stamp at the 1 M-patient cohort (L1, L6, L7), characterise 10 M, settle the W0 pass bars that DEV could not, and replace the unmeasured rows of `CAPACITY-MODEL.md` section 10 with receipts.

## Why
`CAPACITY-MODEL.md` class-M numbers are estimates until measured (`OPERATOR-DECISIONS-2026-10-22.md` Q2). The run costs about $25k per month for about 3 weeks, so it is a separate, last decision.

## Scope / Non-goals
In: W13-1 .. W13-5, all gated on approval. Non-goals: any default spend; any rerun of W07 code items. Before approval this file changes nothing in Azure.

## Acceptance criteria
- [ ] Approval exists as a dated operator statement linked in this file's `blocked_by` replacement. Fails (the wave must not start) if the statement is absent or pre-dates the completion of W01b..W12.
- [ ] W13-1: class-M receipt with cohort size, request counts, windows and p95 per pattern at 1 M patients. Fails if any figure is extrapolated without the label "extrapolated".
- [ ] W13-2: each carried bar below is marked met / not met with its value, or "not measured: why".
- [ ] W13-3: `CAPACITY-MODEL.md` section 10 rows cite the receipt; a row without a receipt stays marked estimate.
- [ ] The stamp is deleted and the deletion is in the receipt.

## Read first
`W07-search-performance-at-scale.md` and `W7-RECEIPT.md`, `W0-RECEIPT.md` section 8, `CAPACITY-MODEL.md` sections 7, 10, 11, `TEST-STRATEGY.md` section 5, `scripts/measure/health/*`.

## Owns
`W13-RECEIPT.md`, `tests/health/load/**` (class-M parameters only), `CAPACITY-MODEL.md` section 10 and 11 rows, `platform/fiab/bicep/health-params/*class-m*.bicepparam` (new), `adr/ADR-001`..`ADR-004` status lines if a bar moves them.

## Must NOT touch
Product code in `apps/**`; any file owned by an unfinished wave.

## Consumes
Everything: W12 complete, W07 load harness and provisional ADR-008 v2, a fresh operator approval.

## Provides
Measured class-M figures for sizing; the ADR pass-bar verdicts.

## Steps
1. Request approval from the operator (owner: orchestrator; only after every other wave is done and verified). 2. If granted, record the cap and dates here, then W13-1 .. W13-5. 3. Delete the stamp. 4. If refused, leave status blocked.

Carried W0 pass bars (DEV values are orientation only; none is a bar result):
1. ADR-001: search p95 at most 1 s on the ADR-008 pattern set, 1 M patients, class M, HAPI. DEV worst p95 was 59.6 ms at 92 k resources.
2. ADR-001: bytes per resource at 1 M patients (DEV gave 9,952.7 B, which already crosses the 6 KB bar; reversal not taken). Re-base `CAPACITY-MODEL.md` s1.3 and derived store sizes.
3. ADR-002: STOW p95 at most 300 ms per 512 KiB instance at 100 concurrent senders (DEV 1,041 ms on a shared node). First triage the DEV QIDO JDBC-pool saturation between 100 and 150 senders and the about 2,000 duplicate-key errors under concurrent STOW; log achieved concurrency server-side.
4. ADR-004: Blob 503 onset and request rate at class M with achieved concurrency measured (DEV: 7,750 of 7,750 PUTs 201 up to 400 requested senders).
5. ADR-003 (unverified on DEV): read-replica routing of searches and exports; HAPI partition mode at 1 M; `$reindex` duration; restore time against the 20 TB working-set cap.
6. `CAPACITY-MODEL.md` s11 items 2, 3, 6: L1 mix req/s and p95 per engine pod at 1 M; single-path `$export` res/s (DEV 2,629.76); Synthea throughput and the largest cohort reachable in 48 h.
7. W0-4: the 24 h no-calls-home capture per engine image on the class-M sandbox (DEV covered about 31 minutes idle).

Owned elsewhere and not lost: ADR-001's Inferno US Core run and CVE review (W02a/W02b); the Blob descriptor against a Gov endpoint through an Actions run, and the bearer-token refresher across two or more expiries under STOW load, are W03 entry gates (if the refresher fails, Fallback B).

| ID | Title | Depends on | Model | Review | Verify |
|---|---|---|---|---|---|
| W13-1 | Class-M sandbox, 1 M cohort load, L1/L6/L7 | approval | Sonnet | required | `W13-RECEIPT.md` tables |
| W13-2 | Bars 1-7 verdicts | W13-1 | Sonnet | required | Each bar met / not met / not measured |
| W13-3 | 10 M characterisation (or labelled extrapolation) and first bottleneck | W13-1 | Sonnet | none | Section 10 rows cite receipt |
| W13-4 | `CAPACITY-MODEL.md` s1.3, s10, s11 updates | W13-2, W13-3 | Sonnet | none | Rows cite receipts |
| W13-5 | 24 h no-calls-home capture per engine image | W13-1 | Sonnet | none | Egress report per image |

## Validation
```
python -S -E ~/.claude/kits/orchestrated-prp/prp_index.py check --root .
bash scripts/measure/health/fhir-engine-load.sh   # args per its header, class-M env overrides
bash scripts/measure/health/egress-report.sh
```
Receipt per cloud: Commercial run id; GCC-High at 100 k via an Actions run only if a Gov class-M stamp is separately funded (not assumed). IL5, DoD, GCC are supported-in-code, never exercised.

## Rollback
Delete the sandbox stamp (deletion in the receipt); revert any param file; no product code is touched.

## Docs to update
`CAPACITY-MODEL.md`, `adr/ADR-001`..`ADR-004`, `TEST-STRATEGY.md` section 9, `README.md` status line.

## Wave / Blocked-by / Branch / Worktree
`Wave: 10 · Blocked-by: operator approval of full-scale spend (NOT approved 2026-11-14) and W12 · Branch: feat/lhds-w13-class-m · Worktree: E:/Repos/_lhds-w13`

## Hot files
`platform/fiab/bicep/health-params/*.bicepparam` (new class-M file only). `touches_bicep: yes` (params only).

## Kickoff prompt
```
Wave W13 (LHDS class-M characterisation). BLOCKED: do not start unless the operator has approved the spend in writing and every other wave is done and verified.
If approved: repo E:/Repos/GitHub/csa-inabox, worktree E:/Repos/_lhds-w13, branch feat/lhds-w13-class-m.
Read first: this file, W07-search-performance-at-scale.md, W7-RECEIPT.md, W0-RECEIPT.md section 8.
Record the approved cap and dates in this file before provisioning. Delete the stamp at the end.
Proof: W13-RECEIPT.md has a verdict per carried bar and CAPACITY-MODEL.md section 10 rows cite it.
```

## Execution state

| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W13-1 | blocked | | sonnet | spend not approved 2026-11-14 | 2026-11-14 |
| W13-2 | blocked | | sonnet | | 2026-11-14 |
| W13-3 | blocked | | sonnet | | 2026-11-14 |
| W13-4 | blocked | | sonnet | | 2026-11-14 |
| W13-5 | blocked | | sonnet | | 2026-11-14 |
