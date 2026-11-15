---
name: spark-id-W11-admin-ui-runbook
status: backlog
priority: P2
order: 7
depends_on: [spark-id-W07-auto-bind-reconciler]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/spark-id-w11-ui
---
# W11: Admin UI and runbook

Program: [per-workspace-spark-identity](PRP.md) · Shared context: [REFERENCE.md](REFERENCE.md) · TRACKING ISSUE: #5297 (program tracker, created 2026-11-14; per-wave issues filed when each wave starts).

## Goal
The workspace identity panel shows the spark-lake binding, scoper kind, root count, last heal time and a Re-bind action; the runbook documents all three mode states.

## Why
`ux-baseline.md` G2: a gate or state needs an inline Fix-it; operators must see binding state without reading logs.

## Scope / Non-goals
Panel + admin identity route + runbook. Non-goals: new pages.

## Acceptance criteria
Each names the value or output that would make it fail.
- The panel renders the binding fields from a fixture and the Re-bind button POSTs to the real route (test asserts the request path and a 200 path updates last-heal time).
- First-open of a workspace with no binding shows a guided state, not a red error banner (ux-baseline item 6).
- Badge row uses wrap and truncation (a narrow-width Playwright pass shows no overlap).
- G1: a live in-browser walk of every control with real data in Commercial; screenshots dark+light attached to the PR.

## Read first
- `lib/panes/workspace-identity-panel.tsx`
- `app/api/admin/workspaces/[id]/identity/route.ts` (grep)
- `docs/fiab/ux-standards.md` section 7
- `docs/fiab/runbooks/workspace-identity-grants.md`

## Owns
- `apps/fiab-console/lib/panes/workspace-identity-panel.tsx` and tests
- `apps/fiab-console/app/api/admin/workspaces/[id]/identity/route.ts`
- `docs/fiab/runbooks/workspace-identity-grants.md`
- `docs/fiab/parity/spark-identity.md` (new, Loom-only surface note)

## Must NOT touch
Any file outside Owns. Never edit `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`. No new Fabric/Power BI dependency (`no-fabric-dependency.md`). Do not re-decide Q1-Q10 (REFERENCE.md section 10).

## Consumes
W07 binding state and reconciler.

## Provides
Operator-visible state and re-bind.

## Steps
1. Extend the identity route with spark-lake fields.
2. Extend the panel (use existing primitives, tokens only).
3. Runbook update.
4. G1 browser walk.

## Validation
Run from the repo root unless stated.
- cd apps/fiab-console && pnpm exec tsc --noEmit -p tsconfig.build.json
- `cd apps/fiab-console && pnpm exec vitest run lib/panes`
- Playwright/click-walk receipt per ux-baseline G1 (screenshots in PR).
- Receipt rule: per-boundary status is one of `verified-live` / `not-exercised` / `blocked(owner)`. Commercial and GCC-High are exercised estates; IL5 has never produced a deploy receipt and GCC is supported-in-code, never exercised (`cloud-parity.md`). Gov receipts come from a GitHub Actions run, never a workstation `az`. A PR for this wave is reported "merged, not deployed" until the receipt exists.

## Rollback
Revert the PR; the panel falls back to the prior fields. No data change.

## Docs to update
Runbook and parity doc are the deliverable.

## Wave / Blocked-by / Branch / Worktree
Wave: 7 · Blocked-by: spark-id-W07-auto-bind-reconciler · Branch: feat/spark-id-w11-ui · Worktree: E:/Repos/_spark-id-w11

## Hot files
`workspace-identity-panel.tsx` sole owner; touches_bicep: no.

## Kickoff prompt
Read PRPs/backlog/per-workspace-spark-identity/PRP.md, spark-id-W11-admin-ui-runbook.md, docs/fiab/ux-standards.md section 7. Extend workspace-identity-panel.tsx with the spark-lake binding state and Re-bind. Done = tsc + vitest for lib/panes pass and a G1 browser walk with dark/light screenshots.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W11 | todo | feat/spark-id-w11-ui | sonnet | none (no issue yet) | 2026-11-14 |
