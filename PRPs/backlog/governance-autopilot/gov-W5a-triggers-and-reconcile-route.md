---
name: gov-W5a-triggers-and-reconcile-route
status: backlog
priority: P2
order: 20
depends_on: [gov-W2-ges-core, gov-W4-scan-orchestration]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/gov-w5a-triggers
---
# W5a - Triggers: item create/update/delete hooks, delegate auto-onboard to GES, internal reconcile route, collection mirror

> Part of the Governance Autopilot program. Hub: `PRP.md`. Reference design: `DESIGN.md` (section numbers below point there). Do not restate it here.

## 1. Goal
Creating, updating or deleting an item enrolls, re-binds or retires its binding with no further call; workspace/domain create mirrors the Purview collection hierarchy; a service-identity internal route runs a resumable reconcile sweep over all workspaces.

## 2. Why
auto-bind-by-default.md: enrollment must be part of item creation, and self-heal (a deleted scan is recreated on the next sweep). DESIGN s5.2, s5.3.

## 3. Scope / Non-goals
In: hook lines in `item-crud.ts`, `purview-autoonboard.ts` delegates to GES, new `app/api/internal/governance/reconcile/route.ts`, collection hooks in `domain-sync.ts` and `domain-registry.ts`. Non-goals: the Container App Job and native scanner (W5b), labels (W6).
Clouds: Commercial and GCC-High carry receipts (GCC-High via a GitHub Actions run only, never local az; this workstation az is Commercial). IL5 and DoD: supported-in-code (params + native-scanner path), never exercised. GCC: supported-in-code, never exercised, no receipt claimed (`cloud-parity.md`).

## 4. Acceptance criteria
- [ ] Create an item: the binding exists with no further call (live receipt); a binding that appears only after a manual reconcile fails.
- [ ] Delete the Purview scan out-of-band, run reconcile: it is recreated with the SAME name; a different name fails.
- [ ] The internal route rejects a request without the service identity (401/403); a request with a user session cookie must fail; the sweep enumerates a workspace the invoking identity does not own.
- [ ] Delete item: assets kept, `loom.retired=true`, source deregistered only when no item references it after 30 days (D8); immediate deregistration fails.

## 5. Read first
- `apps/fiab-console/app/api/items/_lib/item-crud.ts` (`createOwnedItem`, `mirrorGovernanceDoc`, `autoOnboardToPurview` call sites)
- `apps/fiab-console/lib/azure/purview-autoonboard.ts`
- `apps/fiab-console/lib/azure/domain-sync.ts`, `domain-registry.ts`
- DESIGN.md s5.2, s5.3, s5.13 (security), s11 D3/D8/D11

## 6. Owns
- `apps/fiab-console/app/api/items/_lib/item-crud.ts` (hook lines only)
- `apps/fiab-console/lib/azure/purview-autoonboard.ts`
- `apps/fiab-console/app/api/internal/governance/reconcile/route.ts` (new)
- `apps/fiab-console/lib/azure/domain-sync.ts`, `domain-registry.ts`
- tests

## 7. Must NOT touch
- `purview-client.ts` (W4 owns)
- bicep and `apps/fiab-governance-scanner/**` (W5b)
- `copilot-orchestrator.ts`

## 8. Consumes
- gov-W2 `enroll`/`reconcile` core
- gov-W4 `runScanForBinding`

## 9. Provides
- hooks that make enrollment automatic
- `POST /api/internal/governance/reconcile` (contract used by W5b job and W8a "Reconcile now")

## 10. Steps
1. Add hooks next to existing governance mirror calls; failures never block item create (logged + queued for sweep).
2. Delegate `autoOnboardToPurview` to GES.
3. Build the internal route (service identity auth, bounded batches, resumable cursor).
4. Collection hooks for workspace/domain.
5. Security review of the internal route (review: required).

## 11. Validation
```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/hooks/run-tests.ps1 -Fast
pnpm --dir apps/fiab-console exec tsc --noEmit
pnpm --dir apps/fiab-console exec vitest run app/api/items lib/azure lib/governance
Live: clean create then out-of-band scan delete then reconcile (Commercial receipt; GCC-High via Actions)
```
Per-cloud receipts: Commercial live; GCC-High via a GitHub Actions run id (never local az). Report each wave as "merged, not deployed" until the estate build marker (`/build-marker.txt`) carries the merge and the live behaviour is observed (`deploy-integrity.md` R2). Every assertion names the value that would make it fail (`assertion-design.md`); mutation checks run on a sandbox copy with the tracked tree proven untouched.

## 12. Rollback
Feature-flag the hooks off via env (`LOOM_GOVERNANCE_ENROLL=off`; ASSUMPTION: name to be set at implementation); revert the PR.

## 13. Docs to update
DESIGN.md s5.2.

## 14. Wave / Blocked-by / Branch / Worktree
Wave: 3 · Blocked-by: gov-W2-ges-core, gov-W4-scan-orchestration · Branch: feat/gov-w5a-triggers · Worktree: E:/Repos/_gov-w5a

## 15. Hot files
`item-crud.ts` and `purview-autoonboard.ts` (this wave is the only editor; any other program touching `item-crud.ts` in the same wave must be serialized behind it). touches_bicep: no

## 16. Kickoff prompt
```
Read PRPs/backlog/governance-autopilot/PRP.md, DESIGN.md s5.2/5.3/5.13 and this file. Add hooks (lines only) to item-crud.ts, delegate autoOnboard to GES, add the internal reconcile route with service-identity auth. Proof: vitest on app/api/items + lib/governance, then the clean-create and delete-scan-out-of-band receipts.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W5a-1 item create/update/delete hooks | todo | | sonnet | | |
| W5a-2 autoonboard delegates to GES | todo | | sonnet | | |
| W5a-3 internal reconcile route | todo | | sonnet | | |
| W5a-4 collection mirror hooks | todo | | sonnet | | |
| W5a-5 security review + receipts | todo | | sonnet | | |
