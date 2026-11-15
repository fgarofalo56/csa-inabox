---
name: brain-ownership
status: backlog
priority: P2
order: 1
depends_on: []
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
issues: [4255, 3922, 4241, 4242]
branch: feat/brain-ownership-4255
---
# Brain ownership and applicability - make the recommendations approvable (loom-estate-id) and selectable in the console

> Part of the Loom Brain program. Hub: `PRP.md` (DoD baseline). Reference design: `DESIGN.md`. Do not restate it here.

## 1. Goal
The operator can open /admin/brain, see which recommendations are Loom-owned vs merely observed, select several and execute them through the existing Perform path, with the approvable count measured live (the issue title says 0 of 17).

## 2. Why
Operator ask 2026-09-01 (#4255): make all recommendations applicable with selection and execute. Ownership is the gate (`guardOwnership` withholds every remediation without the tag). Built so far: tag stamping in bicep (#4274, merged) and manifest-derived backfill + owned/observed verdict (#4267, merged, `lib/brain-actions/ownership-backfill.ts`, `app/api/admin/brain/ownership-backfill/route.ts`). #4267 states it was never executed against live Azure.

## 3. Scope / Non-goals
In: confirm the stamp is live on the estate and close #3922 on evidence; run the backfill preview then apply against Commercial with operator approval; the owned/observed UI split (W4 in the issue); batch select + execute (W6 in the issue); G1 receipt covering #4241 readability and #4242 Perform. Non-goals: Gov (brain-gov-parity), scan restore (brain-scan-restore), new detectors. > ASSUMPTION: issue #4255 "W4/W6" refer to the UI split and batch select as listed in its comments; confirm against the issue at start.
Clouds: Commercial is the receipt boundary; Gov (GCC-High) receipts come from a GitHub Actions run only, never local az (workstation az is a different tenant). GCC is supported-in-code, never exercised. IL5/DoD: not claimed.

## 4. Acceptance criteria
- [ ] On the live estate the approvable count is reported as `N of M`; N = 0 after backfill fails this PRP (it would mean the tag still is not read). Name the Container App resources that carry `loom-estate-id`.
- [ ] Selecting 2 recommendations and Execute performs exactly those 2 (audit rows = 2); a third unselected executes nothing.
- [ ] A non-Loom resource (e.g. a `sentinel-*` service) is shown as observed and has NO Approve button; an Approve button on it fails.
- [ ] `/admin/brain?tab=recommendations` passes a narrow-width (~480px) and dark+light browser walk with no unreadable text (#4241); first-open has no red banner.

## 5. Read first
- `apps/fiab-console/app/admin/brain/recommendations.tsx` and `model.ts`
- `apps/fiab-console/lib/brain-actions/{guards,perform,ownership-backfill,estate-scope,registry}.ts`
- `apps/fiab-console/app/api/admin/brain/{perform,proposals,ownership-backfill}/route.ts`
- issues #4255, #3922, #4241, #4242 (comments hold the program status)
- `scripts/ci/check-estate-tag-coverage.mjs`

## 6. Owns
- `apps/fiab-console/app/admin/brain/**`
- `apps/fiab-console/lib/brain-actions/**`
- `apps/fiab-console/app/api/admin/brain/{perform,proposals,ownership-backfill}/**`

## 7. Must NOT touch
- `.github/workflows/loom-brain-scan.yml` (brain-scan-restore)
- `lib/brain/run/**`
- bicep (stamp already merged; if a resource class is unstamped, file an issue)

## 8. Consumes
- #4274 stamp deployed to the estate (verify via `az graph`/ARM tag read, Commercial)
- `LOOM_ESTATE_ID` env on the console (both halves per #4255 review), a fresh graph (brain-scan-restore for live receipts)

## 9. Provides
- approvable recommendations + batch execute surface
- owned/observed verdict in the UI

## 10. Steps
1. Measure: tag coverage on the live estate and the current approvable count; record N of M.
2. Operator-approved backfill preview, then apply (single-key tag merge, receipt records prior bag).
3. UI: owned/observed split + non-Loom rows without Approve.
4. Batch select + execute through the existing Perform guards.
5. G1 browser walk covering #4241/#4242; mutation: delete `guardOwnership`, the non-Loom test must go RED in a sandbox copy.

## 11. Validation
```bash
make validate-typescript
pnpm --dir apps/fiab-console vitest run lib/brain
pnpm --dir apps/fiab-console exec tsc --noEmit
pnpm --dir apps/fiab-console exec vitest run lib/brain-actions app/admin/brain
Live: GET /api/admin/brain/ownership-backfill preview (paste candidate count)
Browser walk with screenshots (dark/light, narrow)
```
Report each result as "merged, not deployed" until the estate build marker carries the merge and the behaviour is observed live (`deploy-integrity.md` R2). Every assertion names the value that would make it fail (`assertion-design.md`); mutations run on a sandbox copy with the tracked tree proven untouched.

## 12. Rollback
Backfill receipt holds the prior tag bag; restore by single-key tag delete per resource. UI change is a revert.

## 13. Docs to update
`docs/fiab/brain/` page for ownership and recommendations (add `ownership.md` if absent).

## 14. Wave / Blocked-by / Branch / Worktree
Wave: 1 · Blocked-by: none · Branch: feat/brain-ownership-4255 · Worktree: E:/Repos/_brain-ownership

## 15. Hot files
none of the program hot files; `recommendations.tsx` single owner. touches_bicep: no

## 16. Kickoff prompt
```
Read PRPs/backlog/loom-brain/PRP.md and issue #4255 comments. First measure the live approvable count and tag coverage (Commercial), record N of M, then build the owned/observed split and batch execute. Proof: vitest on lib/brain-actions + app/admin/brain, the live count, a browser walk with screenshots.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| O1 measure live tag coverage + approvable N of M | todo | | sonnet | | |
| O2 backfill preview then apply (operator approval) | todo | | sonnet | | |
| O3 owned/observed UI split | todo | | sonnet | | |
| O4 batch select + execute | todo | | sonnet | | |
| O5 G1 walk (#4241, #4242) + mutation receipt | todo | | sonnet | | |
