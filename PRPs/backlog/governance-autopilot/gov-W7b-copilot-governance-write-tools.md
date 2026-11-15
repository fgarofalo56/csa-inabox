---
name: gov-W7b-copilot-governance-write-tools
status: backlog
priority: P2
order: 25
depends_on: [gov-W7a-copilot-governance-read-tools, gov-W4-scan-orchestration, gov-W5a-triggers-and-reconcile-route, gov-W6a-label-policy-and-apply]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/gov-w7b-write-tools
---
# W7b - Copilot governance WRITE tools (reconcile, scan now, apply labels) with confirmation

> Part of the Governance Autopilot program. Hub: `PRP.md`. Reference design: `DESIGN.md` (section numbers below point there). Do not restate it here.

## 1. Goal
Copilot can trigger reconcile, scan-now and label application, with explicit confirmation required for `all` scope, tenant-admin authorization, and audit.

## 2. Why
Completes the operator ask: Copilot acts, not just reports. DESIGN s5.8, s7.1.

## 3. Scope / Non-goals
In: write tools in `governance-tools.ts`, registration lines in `copilot-orchestrator.ts`. Non-goals: new engines (consumes W4/W5a/W6a).
Clouds: Commercial and GCC-High carry receipts (GCC-High via a GitHub Actions run only, never local az; this workstation az is Commercial). IL5 and DoD: supported-in-code (params + native-scanner path), never exercised. GCC: supported-in-code, never exercised, no receipt claimed (`cloud-parity.md`).

## 4. Acceptance criteria
- [ ] `confirm` is required for scope `all`; a call without it executes nothing (0 Purview calls).
- [ ] A non-admin write on tenant scope is denied; audit row records `mutated:true` only when something changed.
- [ ] The DESIGN s7.1 operator-prompt acceptance test passes on a live Commercial session; a prompt that returns a plan but does nothing fails.

## 5. Read first
- gov-W7a files
- W4/W5a/W6a provided functions
- DESIGN.md s5.8, s7.1

## 6. Owns
- `apps/fiab-console/lib/copilot/governance-tools.ts`
- `apps/fiab-console/lib/azure/copilot-orchestrator.ts` (registration lines only)
- tests

## 7. Must NOT touch
- engines owned by W4/W5a/W6a
- bicep

## 8. Consumes
- gov-W7a
- gov-W4 `runScanForBinding`
- gov-W5a reconcile
- gov-W6a `applyLabelPolicy`

## 9. Provides
- the operator-prompt capability W10 tests end to end

## 10. Steps
1. Write tools wrapping existing engines.
2. Confirmation + audit.
3. Live walk of the operator prompt (G1).

## 11. Validation
```bash
make validate-typescript
pnpm --dir apps/fiab-console vitest run lib/governance
pnpm --dir apps/fiab-console exec tsc --noEmit
pnpm --dir apps/fiab-console exec vitest run lib/copilot
Live: operator prompt in browser with receipt
```
Per-cloud receipts: Commercial live; GCC-High via a GitHub Actions run id (never local az). Report each wave as "merged, not deployed" until the estate build marker (`/build-marker.txt`) carries the merge and the live behaviour is observed (`deploy-integrity.md` R2). Every assertion names the value that would make it fail (`assertion-design.md`); mutation checks run on a sandbox copy with the tracked tree proven untouched.

## 12. Rollback
Unregister the write tools; read tools stay.

## 13. Docs to update
DESIGN.md s5.8.

## 14. Wave / Blocked-by / Branch / Worktree
Wave: 4 · Blocked-by: gov-W7a-copilot-governance-read-tools, gov-W4-scan-orchestration, gov-W5a-triggers-and-reconcile-route, gov-W6a-label-policy-and-apply · Branch: feat/gov-w7b-write-tools · Worktree: E:/Repos/_gov-w7b

## 15. Hot files
`copilot-orchestrator.ts` (after W7a merged). touches_bicep: no

## 16. Kickoff prompt
```
Read PRPs/backlog/governance-autopilot/PRP.md and DESIGN.md s5.8/s7.1; confirm W7a, W4, W5a, W6a are merged. Add write tools wrapping the existing engines with confirm + audit. Proof: vitest on lib/copilot and the live operator-prompt walk.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W7b-1 reconcile + scan-now tools | todo | | sonnet | | |
| W7b-2 apply-labels tool | todo | | sonnet | | |
| W7b-3 confirmation + audit tests | todo | | sonnet | | |
| W7b-4 live operator-prompt receipt | todo | | sonnet | | |
