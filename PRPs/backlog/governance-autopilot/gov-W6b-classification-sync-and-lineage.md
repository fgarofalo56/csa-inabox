---
name: gov-W6b-classification-sync-and-lineage
status: backlog
priority: P2
order: 23
depends_on: [gov-W2-ges-core, gov-W4-scan-orchestration]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/gov-w6b-classification-lineage
---
# W6b - Classification and tag sync from scan results, plus missing lineage emitters (notebook, semantic model, report)

> Part of the Governance Autopilot program. Hub: `PRP.md`. Reference design: `DESIGN.md` (section numbers below point there). Do not restate it here.

## 1. Goal
Scan classifications are mirrored onto Loom items as tags/classifications, and lineage is emitted for the item types that currently emit none.

## 2. Why
Classification and lineage are what Copilot and the catalog read back. W0 found the lineage emitters missing for notebook, semantic-model, report. DESIGN s5.7.

## 3. Scope / Non-goals
In: additive changes to `lib/azure/purview-classification-sync.ts`, `lib/lineage/**` emitters. Non-goals: label policy (W6a), UI.
Clouds: Commercial and GCC-High carry receipts (GCC-High via a GitHub Actions run only, never local az; this workstation az is Commercial). IL5 and DoD: supported-in-code (params + native-scanner path), never exercised. GCC: supported-in-code, never exercised, no receipt claimed (`cloud-parity.md`).

## 4. Acceptance criteria
- [ ] A scan result with 3 classifications produces 3 tags on the item; 0 tags from a non-empty result fails.
- [ ] Notebook, semantic-model and report each emit at least one lineage edge in a fixture; a type with no emitter fails the coverage test.
- [ ] Re-running sync is idempotent: second run writes 0 changes.

## 5. Read first
- `apps/fiab-console/lib/azure/purview-classification-sync.ts`
- `apps/fiab-console/lib/lineage/**`
- W0-RECEIPT.md s2h/s2i (unverified items)
- DESIGN.md s5.7

## 6. Owns
- `apps/fiab-console/lib/azure/purview-classification-sync.ts` (additive)
- `apps/fiab-console/lib/lineage/**`
- tests

## 7. Must NOT touch
- `purview-client.ts`
- `label-policy/**`
- `item-crud.ts`

## 8. Consumes
- gov-W4 scan read-back
- gov-W2 bindings

## 9. Provides
- classification tags on items read by W7a and W8b

## 10. Steps
1. Map scan results to item tags (additive).
2. Add the three lineage emitters.
3. Idempotency test; sandbox mutation.

## 11. Validation
```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/hooks/run-tests.ps1 -Fast
pnpm --dir apps/fiab-console exec tsc --noEmit
pnpm --dir apps/fiab-console exec vitest run lib/lineage lib/azure/__tests__
```
Per-cloud receipts: Commercial live; GCC-High via a GitHub Actions run id (never local az). Report each wave as "merged, not deployed" until the estate build marker (`/build-marker.txt`) carries the merge and the live behaviour is observed (`deploy-integrity.md` R2). Every assertion names the value that would make it fail (`assertion-design.md`); mutation checks run on a sandbox copy with the tracked tree proven untouched.

## 12. Rollback
Revert the PR; tags written remain and are harmless.

## 13. Docs to update
DESIGN.md s5.7.

## 14. Wave / Blocked-by / Branch / Worktree
Wave: 3 · Blocked-by: gov-W2-ges-core, gov-W4-scan-orchestration · Branch: feat/gov-w6b-classification-lineage · Worktree: E:/Repos/_gov-w6b

## 15. Hot files
none. touches_bicep: no

## 16. Kickoff prompt
```
Read PRPs/backlog/governance-autopilot/PRP.md, DESIGN.md s5.7, then extend purview-classification-sync.ts additively and add the three lineage emitters. Proof: vitest on lib/lineage plus the idempotency test.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W6b-1 classification to tag sync | todo | | sonnet | | |
| W6b-2 notebook lineage emitter | todo | | sonnet | | |
| W6b-3 semantic-model + report emitters | todo | | sonnet | | |
| W6b-4 idempotency + mutation receipt | todo | | sonnet | | |
