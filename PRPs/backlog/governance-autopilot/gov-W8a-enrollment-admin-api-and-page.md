---
name: gov-W8a-enrollment-admin-api-and-page
status: backlog
priority: P2
order: 26
depends_on: [gov-W2-ges-core]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/gov-w8a-admin-page
---
# W8a - Governance enrollment admin API and page

> Part of the Governance Autopilot program. Hub: `PRP.md`. Reference design: `DESIGN.md` (section numbers below point there). Do not restate it here.

## 1. Goal
`/admin/governance-enrollment` lists bindings with status, last scan, coverage and failures, with Reconcile now, Scan now and a per-binding detail inspector, at ux-baseline grade.

## 2. Why
Operators must see enrollment state without a Purview portal. Admin page is the visible surface of the program. DESIGN s5.10.

## 3. Scope / Non-goals
In: `app/admin/governance-enrollment/**`, `app/api/admin/governance-enrollment/**`, nav entry. Non-goals: per-item chip, gates, parity doc (W8b).
Clouds: Commercial and GCC-High carry receipts (GCC-High via a GitHub Actions run only, never local az; this workstation az is Commercial). IL5 and DoD: supported-in-code (params + native-scanner path), never exercised. GCC: supported-in-code, never exercised, no receipt claimed (`cloud-parity.md`).

## 4. Acceptance criteria
- [ ] Page renders real data from the API with the binding count equal to the store count; a mock array fails (no-vaporware).
- [ ] Narrow-width pass: no badge overlap (flexWrap + minWidth:0); first-open on a fresh tenant shows a guided EmptyState and no red banner.
- [ ] SplitPane with persisted `sizingKey` for the list/inspector (G3).
- [ ] Playwright walk with dark and light screenshots attached.

## 5. Read first
- `apps/fiab-console/app/admin/**` sibling pages (e.g. a polished one like Governance)
- `docs/fiab/ux-standards.md` s7
- DESIGN.md s5.10

## 6. Owns
- `apps/fiab-console/app/admin/governance-enrollment/**` (new)
- `apps/fiab-console/app/api/admin/governance-enrollment/**` (new)
- `apps/fiab-console/lib/nav/**` (one entry)

## 7. Must NOT touch
- `lib/gates/registry/**` (W8b)
- item editor chrome (W8b)
- engine files

## 8. Consumes
- gov-W2 store API
- gov-W4/W5a for live data (page works against an empty store before then)

## 9. Provides
- admin API contract used by W8b and W10 E2E

## 10. Steps
1. API routes with session validation and `{ok,data,error}` envelope.
2. Page using PageShell/AdminShell, TileGrid, EmptyState.
3. Playwright + screenshots (G1).

## 11. Validation
```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .claude/hooks/run-tests.ps1 -Fast
pnpm --dir apps/fiab-console exec tsc --noEmit
pnpm --dir apps/fiab-console exec vitest run app/admin/governance-enrollment app/api/admin/governance-enrollment
pnpm uat (deep-functional spec for the page)
```
Per-cloud receipts: Commercial live; GCC-High via a GitHub Actions run id (never local az). Report each wave as "merged, not deployed" until the estate build marker (`/build-marker.txt`) carries the merge and the live behaviour is observed (`deploy-integrity.md` R2). Every assertion names the value that would make it fail (`assertion-design.md`); mutation checks run on a sandbox copy with the tracked tree proven untouched.

## 12. Rollback
Remove nav entry; revert.

## 13. Docs to update
Parity doc is W8b.

## 14. Wave / Blocked-by / Branch / Worktree
Wave: 2 · Blocked-by: gov-W2-ges-core · Branch: feat/gov-w8a-admin-page · Worktree: E:/Repos/_gov-w8a

## 15. Hot files
nav registry (one line). touches_bicep: no

## 16. Kickoff prompt
```
Read PRPs/backlog/governance-autopilot/PRP.md, DESIGN.md s5.10, docs/fiab/ux-standards.md s7, and a polished sibling admin page. Build the API and page against the W2 store. Proof: vitest, pnpm uat, and a browser walk with dark/light screenshots and a narrow-width pass.
```

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| W8a-1 admin API routes | todo | | sonnet | | |
| W8a-2 list + inspector page | todo | | sonnet | | |
| W8a-3 Reconcile/Scan now actions | todo | | sonnet | | |
| W8a-4 G1 browser walk + screenshots | todo | | sonnet | | |
