---
name: brain-gov-parity
status: backlog
priority: P2
order: 2
depends_on: [brain-scan-restore]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
issues: [3937, 4051]
branch: feat/brain-gov-3937
---
# Brain in Azure Government - W11 parity (Gov graph, cost export, ownership, in-boundary nightly scan)

> Part of the Loom Brain program. Hub: `PRP.md` (DoD baseline). Reference design: `DESIGN.md`. Do not restate it here.

## 1. Goal
The Brain runs in GCC-High with the same capabilities as Commercial, proven by an Actions run URL: a Gov graph with node and edge counts, a Gov detector finding or a named clean population, cost export behaviour stated, and a nightly in-boundary scan.

## 2. Why
`cloud-parity.md`: Commercial-only is incomplete. #3937 acceptance; #4051 records that Gov has no nightly scan because no in-boundary runner can reach the Gov Cosmos private endpoint (needs an owner and a date).

## 3. Scope / Non-goals
In: Gov ARG/ARM endpoint resolution check (different hostnames), Gov cost export verification or documented fallback, ownership in Gov, in-boundary runner for the nightly scan (may need bicep), Gov receipt via Actions. Non-goals: GCC (supported-in-code, never exercised), IL5/DoD. > ASSUMPTION: a runner/bicep change is required for #4051; if an existing runner can reach the Cosmos PE, the bicep item is descoped.
Clouds: Commercial is the receipt boundary; Gov (GCC-High) receipts come from a GitHub Actions run only, never local az (workstation az is a different tenant). GCC is supported-in-code, never exercised. IL5/DoD: not claimed.

## 4. Acceptance criteria
- [ ] A Gov Actions run reports node and edge counts > 0; zero nodes fails (blind population, not "clean").
- [ ] At least one Gov detector fires on a real finding OR the report names the population it examined and says clean for that detector.
- [ ] Cost export in Gov is verified present or the fallback is stated plainly; a derived number is never labelled billed.
- [ ] Receipt is an Actions run URL; a local-az paste fails. Commercial-only capabilities are named in `docs/fiab/brain/`.

## 5. Read first
- issue #3937 and #4051 (full text)
- `.github/workflows/loom-brain-scan.yml` Gov job and CLOUD PARITY header comment
- `apps/fiab-console/lib/brain/run/azure/{scan-credential,arm-probe,http}.ts`
- `docs/fiab/brain/scheduler.md`
- memory: Gov lane mechanics (approval-held runs look idle; `GOV_CONSOLE_BUILDER`)

## 6. Owns
- `.github/workflows/loom-brain-scan.yml` (Gov job; after brain-scan-restore merges)
- `apps/fiab-console/lib/brain/run/azure/**` (cloud endpoint resolution)
- `docs/fiab/brain/cloud-parity.md` (new; per-cloud status table; ASSUMPTION: exact filename)
- a single bicep module for the in-boundary runner if needed (serialized: one bicep PR in flight)

## 7. Must NOT touch
- `app/admin/brain/**`, `lib/brain-actions/**` (brain-ownership)
- other bicep modules
- any Commercial behaviour change

## 8. Consumes
- brain-scan-restore merged (same workflow file)
- Gov credentials via the operator-held GitHub secrets (never read here)
- bicep interlock slot if the runner needs infra

## 9. Provides
- Gov Brain receipt that closes cloud-parity for the Brain

## 10. Steps
1. Read the Gov job and audit hard-coded Commercial hosts.
2. Decide runner approach (record in the PR).
3. Gov dispatch via Actions; capture counts.
4. Cost export check in Gov.
5. Docs state per-cloud status.

## 11. Validation
```bash
make validate-typescript
pnpm --dir apps/fiab-console vitest run lib/brain
pnpm --dir apps/fiab-console exec tsc --noEmit
pnpm --dir apps/fiab-console exec vitest run lib/brain/run
gh run view <gov-run-id> --json conclusion,jobs  (counts in the report artifact)
az bicep build if a module changed
```
Report each result as "merged, not deployed" until the estate build marker carries the merge and the behaviour is observed live (`deploy-integrity.md` R2). Every assertion names the value that would make it fail (`assertion-design.md`); mutations run on a sandbox copy with the tracked tree proven untouched.

## 12. Rollback
Revert; Gov returns to no nightly scan (current state, documented in #4051).

## 13. Docs to update
`docs/fiab/brain/` per-cloud status table.

## 14. Wave / Blocked-by / Branch / Worktree
Wave: 2 · Blocked-by: brain-scan-restore · Branch: feat/brain-gov-3937 · Worktree: E:/Repos/_brain-gov

## 15. Hot files
`loom-brain-scan.yml` (after brain-scan-restore); bicep only if a runner module is needed (touches_bicep: yes; serialized). touches_bicep: yes
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## 16. Kickoff prompt
```
Read PRPs/backlog/loom-brain/PRP.md, issues #3937 and #4051, and the Gov job in loom-brain-scan.yml; confirm brain-scan-restore is merged and no other bicep PR is open. Audit endpoints, pick the runner approach, dispatch via Actions. Proof: Actions run URL with Gov node and edge counts.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| G1 Gov endpoint audit + resolver fix | todo | | sonnet | | |
| G2 Gov cost export verification or fallback | todo | | sonnet | | |
| G3 in-boundary runner for nightly scan (#4051) | todo | | sonnet | | |
| G4 Gov Actions receipt with counts | todo | | sonnet | | |
| G5 docs per-cloud status | todo | | sonnet | | |
