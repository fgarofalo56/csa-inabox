---
name: brain-scan-restore
status: backlog
priority: P1
order: 3
depends_on: []
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
issues: [4721]
branch: fix/brain-scan-restore-4721
---
# Brain scan restore - the scheduled Brain scan has failed every run since 2026-09-14/16

> Part of the Loom Brain program. Hub: `PRP.md` (DoD baseline). Reference design: `DESIGN.md`. Do not restate it here.

## 1. Goal
`loom-brain-scan.yml` runs green on its schedule in Commercial and either produces a graph with node/edge counts or fails with a true, classified reason, so every later Brain receipt has a fresh graph behind it.

## 2. Why
`deploy-integrity.md` R1: a scheduled path that is silently broken is broken. #4721 measured 10/10 scheduled failures after 2026-09-16 (16 of 19 green before); the 3 most recent runs (2026-11-12, 13, 14) are also `failure` (measured via `gh run list`, 2026-11-14). A Brain nobody can run finds nothing.

## 3. Scope / Non-goals
In: diagnose the failing step from the latest run log, fix at the cause, and make the failure self-classifying (R6/R7). Non-goals: Gov scan (brain-gov-parity), detectors, UI. > ASSUMPTION: #4721 says a second, identical-looking cause is queued behind the first; treat as two defects until the log proves one.
Clouds: Commercial is the receipt boundary; Gov (GCC-High) receipts come from a GitHub Actions run only, never local az (workstation az is a different tenant). GCC is supported-in-code, never exercised. IL5/DoD: not claimed.

## 4. Acceptance criteria
- [ ] Latest scheduled `loom-brain-scan` run conclusion is `success` with a report whose node and edge counts are > 0; a green run with 0 nodes fails (blind population).
- [ ] A paused estate yields a classified `skipped: estate paused` reason, not a red run and not a green one with 0 examined.
- [ ] The failing step's message names what was actually established (R7): "could not reach X" is not reported as "X missing".

## 5. Read first
- `.github/workflows/loom-brain-scan.yml` (comments document the paused-estate design)
- issue #4721 body and comments (break date 2026-09-16; diff that boundary)
- `apps/fiab-console/lib/brain/run/cli.ts`, `run/azure/scan-credential.ts`, `run/azure/arg-graph-source.ts`
- `docs/fiab/brain/scheduler.md`

## 6. Owns
- `.github/workflows/loom-brain-scan.yml`
- `apps/fiab-console/lib/brain/run/**`
- `docs/fiab/brain/scheduler.md`

## 7. Must NOT touch
- `app/admin/brain/**` and `lib/brain-actions/**` (brain-ownership)
- any bicep
- Gov job design (brain-gov-parity owns the Gov job after this PRP merges)

## 8. Consumes
- `gh run view --log-failed` for the latest failing run
- runner identity grants (`uami-loom-ci`) as documented in the workflow header

## 9. Provides
- a green, fresh graph/history capture that brain-ownership and brain-gov-parity receipts depend on

## 10. Steps
1. Read the last failing run log; diff main at 2026-09-14..16 for the change.
2. Fix the cause; add a regression test that names the failing input.
3. Dispatch the workflow; confirm the report counts.

## 11. Validation
```bash
make validate-typescript
pnpm --dir apps/fiab-console vitest run lib/brain
pnpm --dir apps/fiab-console exec tsc --noEmit
pnpm --dir apps/fiab-console exec vitest run lib/brain/run
gh run list --workflow loom-brain-scan.yml -L 3 --json conclusion  (after dispatch)
Report merged vs deployed: the lane runs from main, so merge = live for CI-only changes; say so.
```
Report each result as "merged, not deployed" until the estate build marker carries the merge and the behaviour is observed live (`deploy-integrity.md` R2). Every assertion names the value that would make it fail (`assertion-design.md`); mutations run on a sandbox copy with the tracked tree proven untouched.

## 12. Rollback
Revert the workflow/code change; the lane returns to its failing state (known).

## 13. Docs to update
`docs/fiab/brain/scheduler.md` if the failure classification changes.

## 14. Wave / Blocked-by / Branch / Worktree
Wave: 1 · Blocked-by: none · Branch: fix/brain-scan-restore-4721 · Worktree: E:/Repos/_brain-scan

## 15. Hot files
`loom-brain-scan.yml` (one owner; brain-gov-parity is sequenced after this). touches_bicep: no

## 16. Kickoff prompt
```
Read PRPs/backlog/loom-brain/PRP.md, issue #4721 and the header of .github/workflows/loom-brain-scan.yml. Run gh run view --log-failed on the latest failed run, find the cause, fix it. Proof: a dispatched run whose report shows node and edge counts above zero.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| S1 diagnose from latest failed log | todo | | sonnet | | |
| S2 fix cause + regression test | todo | | sonnet | | |
| S3 paused-estate classification + R7 message | todo | | sonnet | | |
| S4 dispatch receipt with counts | todo | | sonnet | | |
