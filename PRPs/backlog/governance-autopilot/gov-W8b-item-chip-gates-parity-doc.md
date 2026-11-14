---
name: gov-W8b-item-chip-gates-parity-doc
status: backlog
priority: P2
order: 27
depends_on: [gov-W8a-enrollment-admin-api-and-page, gov-W6b-classification-sync-and-lineage]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/gov-w8b-chip-gates
---
# W8b - Per-item governance chip/tab, gate registry entries with Fix-it, env checks, parity doc

> Part of the Governance Autopilot program. Hub: `PRP.md`. Reference design: `DESIGN.md` (section numbers below point there). Do not restate it here.

## 1. Goal
Every item editor shows its enrollment/classification/label state; unavoidable gates carry Fix-it wizards registered in the gate registry; the `svc-purview-uc` text is fixed; a parity doc shows zero missing rows.

## 2. Why
ux-baseline G2: no bare remediation MessageBar. DESIGN s5.10.

## 3. Scope / Non-goals
In: shared editor-chrome chip, `lib/gates/registry/catalog-governance.ts`, `lib/admin/env-checks/catalog-governance.ts`, `docs/fiab/parity/governance-enrollment.md`. Non-goals: admin page (W8a).
Clouds: Commercial and GCC-High carry receipts (GCC-High via a GitHub Actions run only, never local az; this workstation az is Commercial). IL5 and DoD: supported-in-code (params + native-scanner path), never exercised. GCC: supported-in-code, never exercised, no receipt claimed (`cloud-parity.md`).

## 4. Acceptance criteria
- [ ] A fresh item shows a chip with a state (enrolling / enrolled / skipped:paused); an unconfigured state shown as red fails G2/first-open.
- [ ] Each gate has a Fix-it action and appears on the Admin gate-registry page; a gate without Fix-it fails.
- [ ] Parity doc has zero rows marked missing.

## 5. Read first
- `apps/fiab-console/lib/gates/registry/catalog-governance.ts`
- `lib/admin/env-checks/catalog-governance.ts`
- shared editor chrome component
- DESIGN.md s5.10

## 6. Owns
- shared editor-chrome chip component (new file)
- `apps/fiab-console/lib/gates/registry/catalog-governance.ts`
- `apps/fiab-console/lib/admin/env-checks/catalog-governance.ts`
- `docs/fiab/parity/governance-enrollment.md` (new)

## 7. Must NOT touch
- other gates registry files (hot file; this wave is the only owner)
- W8a files

## 8. Consumes
- gov-W8a admin API
- gov-W6b tags for the chip

## 9. Provides
- per-item surface; gate entries Copilot can discover

## 10. Steps
1. Chip component and per-editor mount via shared chrome.
2. Gate registry entries + Fix-it.
3. env-check text fix.
4. Parity doc; browser walk.

## 11. Validation
```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/hooks/run-tests.ps1 -Fast
pnpm --dir apps/fiab-console exec tsc --noEmit
pnpm --dir apps/fiab-console exec vitest run lib/gates lib/admin
Browser walk (G1) with screenshots
```
Per-cloud receipts: Commercial live; GCC-High via a GitHub Actions run id (never local az). Report each wave as "merged, not deployed" until the estate build marker (`/build-marker.txt`) carries the merge and the live behaviour is observed (`deploy-integrity.md` R2). Every assertion names the value that would make it fail (`assertion-design.md`); mutation checks run on a sandbox copy with the tracked tree proven untouched.

## 12. Rollback
Revert; chip is read-only so nothing to unwind.

## 13. Docs to update
the parity doc is this wave's deliverable.

## 14. Wave / Blocked-by / Branch / Worktree
Wave: 4 · Blocked-by: gov-W8a-enrollment-admin-api-and-page, gov-W6b-classification-sync-and-lineage · Branch: feat/gov-w8b-chip-gates · Worktree: E:/Repos/_gov-w8b

## 15. Hot files
`gates/registry/*.ts` (sole owner this wave), shared editor chrome. touches_bicep: no

## 16. Kickoff prompt
```
Read PRPs/backlog/governance-autopilot/PRP.md, DESIGN.md s5.10, and lib/gates/registry/catalog-governance.ts. Add the chip, gate Fix-it entries and parity doc. Proof: vitest on lib/gates, parity doc with zero missing rows, browser walk screenshots.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W8b-1 item chip component + mount | todo | | sonnet | | |
| W8b-2 gate registry + Fix-it | todo | | sonnet | | |
| W8b-3 env-check text fix | todo | | sonnet | | |
| W8b-4 parity doc + browser walk | todo | | sonnet | | |
