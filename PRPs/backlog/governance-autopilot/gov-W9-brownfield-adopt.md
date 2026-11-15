---
name: gov-W9-brownfield-adopt
status: backlog
priority: P2
order: 28
depends_on: [gov-W2-ges-core, gov-W3-permissions-infra, gov-W5b-reconcile-job-and-native-scanner]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/gov-w9-brownfield
---
# W9 - Brownfield: discover existing Purview, offer adopt-or-new, validate, accept supplied values

> Part of the Governance Autopilot program. Hub: `PRP.md`. Reference design: `DESIGN.md` (section numbers below point there). Do not restate it here.

## 1. Goal
A brownfield deploy discovers existing Purview accounts and registered sources across subscriptions, offers adopt vs new per service, validates usability, and never silently duplicates or adopts.

## 2. Why
deploy-integrity.md R5: silently deploying a second Purview or failing because one exists is a violation. DESIGN s5.11.

## 3. Scope / Non-goals
In: `lib/governance/brownfield/**`, `scripts/csa-loom/discover-purview-adopt-plan.sh`, wizard Fix-it for supplied values, duplicate-account deploy preflight. Non-goals: other services' brownfield discovery (other programs).
Clouds: Commercial and GCC-High carry receipts (GCC-High via a GitHub Actions run only, never local az; this workstation az is Commercial). IL5 and DoD: supported-in-code (params + native-scanner path), never exercised. GCC: supported-in-code, never exercised, no receipt claimed (`cloud-parity.md`).

## 4. Acceptance criteria
- [ ] Discovery lists an existing Purview with what Loom would use it for and change; an empty list on an estate that has one fails.
- [ ] Preflight fails with a named remediation when a second Purview would be created without consent.
- [ ] Brownfield E2E (DESIGN s7.3) runs against an existing-estate fixture and adopts without duplicating (`purviewSourceAdopted:true`).

## 5. Read first
- DESIGN.md s5.11, s7.3
- `scripts/csa-loom/` existing discover scripts
- `deploy-integrity.md` R4/R5

## 6. Owns
- `apps/fiab-console/lib/governance/brownfield/**` (new)
- `scripts/csa-loom/discover-purview-adopt-plan.sh` (new)
- deploy preflight script + wizard Fix-it entry for Purview only

## 7. Must NOT touch
- `catalog.bicep` and other modules (if the preflight needs a bicep param it is a serialized change after W5b)
- engine files

## 8. Consumes
- gov-W2 binding adoption fields
- gov-W3 grants
- gov-W5b merged (bicep interlock)

## 9. Provides
- brownfield path W10 documents

## 10. Steps
1. Discovery + plan output.
2. Preflight check.
3. Wizard Fix-it for supplied values.
4. Brownfield E2E in Commercial; GCC-High via Actions.

## 11. Validation
```bash
make validate-typescript
pnpm --dir apps/fiab-console vitest run lib/governance
pnpm --dir apps/fiab-console exec tsc --noEmit
pnpm --dir apps/fiab-console exec vitest run lib/governance/brownfield
Brownfield E2E receipt, Commercial + GCC-High (Actions run id)
```
Per-cloud receipts: Commercial live; GCC-High via a GitHub Actions run id (never local az). Report each wave as "merged, not deployed" until the estate build marker (`/build-marker.txt`) carries the merge and the live behaviour is observed (`deploy-integrity.md` R2). Every assertion names the value that would make it fail (`assertion-design.md`); mutation checks run on a sandbox copy with the tracked tree proven untouched.

## 12. Rollback
Preflight is fail-closed with an explicit bypass param; revert the PR.

## 13. Docs to update
W10 brownfield walkthrough.

## 14. Wave / Blocked-by / Branch / Worktree
Wave: 5 · Blocked-by: gov-W2-ges-core, gov-W3-permissions-infra, gov-W5b-reconcile-job-and-native-scanner · Branch: feat/gov-w9-brownfield · Worktree: E:/Repos/_gov-w9

## 15. Hot files
deploy preflight (touches deploy path: touches_bicep yes if any param/module change). touches_bicep: yes
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## 16. Kickoff prompt
```
Read PRPs/backlog/governance-autopilot/PRP.md, DESIGN.md s5.11/s7.3 and deploy-integrity.md R5; confirm W3 and W5b are merged and no other bicep PR is open. Build discovery, preflight and Fix-it. Proof: vitest, the brownfield E2E on an existing-estate fixture, and the GCC-High Actions run id.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W9-1 discovery + adopt plan | todo | | sonnet | | |
| W9-2 duplicate-account preflight | todo | | sonnet | | |
| W9-3 supplied-values Fix-it | todo | | sonnet | | |
| W9-4 brownfield E2E receipts | todo | | sonnet | | |
