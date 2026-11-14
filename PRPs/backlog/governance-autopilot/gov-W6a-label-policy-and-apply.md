---
name: gov-W6a-label-policy-and-apply
status: backlog
priority: P2
order: 22
depends_on: [gov-W2-ges-core, gov-W4-scan-orchestration]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/gov-w6a-label-policy
---
# W6a - Label policy engine and shared label-apply function (never downgrade a human label)

> Part of the Governance Autopilot program. Hub: `PRP.md`. Reference design: `DESIGN.md` (section numbers below point there). Do not restate it here.

## 1. Goal
A label-policy engine that maps classifications to a sensitivity label (auto-apply up to Confidential, suggest above, D2) and a shared label-apply function extracted from the sensitivity-label route, with a Loom-native path when Data Map labeling is unavailable.

## 2. Why
Classification without labeling leaves the operator ask half-done; labels touch data classification so review is required. DESIGN s5.7, D2/D5.

## 3. Scope / Non-goals
In: `lib/governance/label-policy/**` (new), extract the apply function from `app/api/items/[type]/[id]/sensitivity-label/route.ts` (route calls it). Non-goals: classification sync and lineage (W6b), UI (W8).
Clouds: Commercial and GCC-High carry receipts (GCC-High via a GitHub Actions run only, never local az; this workstation az is Commercial). IL5 and DoD: supported-in-code (params + native-scanner path), never exercised. GCC: supported-in-code, never exercised, no receipt claimed (`cloud-parity.md`).

## 4. Acceptance criteria
- [ ] A human-set label is never downgraded by policy; a fixture where policy lowers it fails.
- [ ] Highly Confidential is suggested, not auto-applied; auto-apply of it fails.
- [ ] Editing the policy changes the outcome for the same input (two policies, two labels).
- [ ] Gov-simulated run with Data Map labeling unavailable still labels via the Loom-native path.

## 5. Read first
- `apps/fiab-console/app/api/items/[type]/[id]/sensitivity-label/route.ts`
- `apps/fiab-console/lib/governance/label-policy-library.ts`, `label-propagation.ts`
- DESIGN.md s5.7, s11 D2/D5

## 6. Owns
- `apps/fiab-console/lib/governance/label-policy/**` (new)
- `apps/fiab-console/app/api/items/[type]/[id]/sensitivity-label/route.ts` (call the extracted function only)
- tests

## 7. Must NOT touch
- `purview-classification-sync.ts`, `lib/lineage/**` (W6b)
- `item-crud.ts`

## 8. Consumes
- gov-W2 binding store
- gov-W4 scan results (classification input)

## 9. Provides
- `applyLabelPolicy(binding, classifications)` used by W5a sweep follow-ups and W7b `governance_apply_labels`

## 10. Steps
1. Extract apply function with route behaviour unchanged (existing route tests stay green).
2. Policy engine + policy store (Cosmos via existing policy-store pattern).
3. Native-label fallback.
4. Mutation run in sandbox copy.

## 11. Validation
```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/hooks/run-tests.ps1 -Fast
pnpm --dir apps/fiab-console exec tsc --noEmit
pnpm --dir apps/fiab-console exec vitest run app/api/items/[type]/[id]/sensitivity-label lib/governance
Mutation (sandbox copy): drop the never-downgrade guard; its test must go RED.
```
Per-cloud receipts: Commercial live; GCC-High via a GitHub Actions run id (never local az). Report each wave as "merged, not deployed" until the estate build marker (`/build-marker.txt`) carries the merge and the live behaviour is observed (`deploy-integrity.md` R2). Every assertion names the value that would make it fail (`assertion-design.md`); mutation checks run on a sandbox copy with the tracked tree proven untouched.

## 12. Rollback
Revert the PR; policies default to suggest-only via env `LOOM_LABEL_AUTOAPPLY=off` (ASSUMPTION: name to be fixed at implementation).

## 13. Docs to update
DESIGN.md s5.7.

## 14. Wave / Blocked-by / Branch / Worktree
Wave: 3 · Blocked-by: gov-W2-ges-core, gov-W4-scan-orchestration · Branch: feat/gov-w6a-label-policy · Worktree: E:/Repos/_gov-w6a

## 15. Hot files
none of the program hot files; `sensitivity-label/route.ts` is owned here only. touches_bicep: no

## 16. Kickoff prompt
```
Read PRPs/backlog/governance-autopilot/PRP.md, DESIGN.md s5.7 and the sensitivity-label route. Extract the apply function first (route tests unchanged), then the policy engine. Proof: vitest on the route and lib/governance, never-downgrade mutation RED in a sandbox copy.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W6a-1 extract shared apply function | todo | | sonnet | | |
| W6a-2 policy engine + store | todo | | sonnet | | |
| W6a-3 native-label fallback | todo | | sonnet | | |
| W6a-4 mutation receipt | todo | | sonnet | | |
