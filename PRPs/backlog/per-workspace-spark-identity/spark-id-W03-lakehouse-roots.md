---
name: spark-id-W03-lakehouse-roots
status: backlog
priority: P2
order: 4
depends_on: [spark-id-W01-abfss-builder, spark-id-W02-client-credential]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/spark-id-w03-roots
---
# W03: Route-level root resolution for class W routes

Program: [per-workspace-spark-identity](PRP.md) · Shared context: [REFERENCE.md](REFERENCE.md) · TRACKING ISSUE: #5297 (program tracker, created 2026-11-14; per-wave issues filed when each wave starts).

## Goal
Each lakehouse Spark route resolves its workspace and root from the item id so each submit carries a workspace context.

## Why
The enforcement and shadow evaluator need the workspace id and the root set per submit; today the routes derive the abfss path ad hoc (REFERENCE.md 2.3, 2.4).

## Scope / Non-goals
`lakehouse/{transform-preview,table-stats,load-to-table,maintenance,schemas,interop}`. Non-goals: identity change; batch conversion of load-to-table (W09).

## Acceptance criteria
Each names the value or output that would make it fail.
- A route test asserts `item -> workspaceId` binding: a request for item X of workspace A passes workspace A to the client; it fails if workspace B or the shared default is passed.
- A legacy root (`lakehouses/<name>`) and a new root (`lakehouses/<name>--<itemId>`) both resolve; a test asserts `lakehouses/sales` does not match `lakehouses/sales2` or `lakehouses/sales--abc`.
- Responses for existing inputs are unchanged (golden JSON).

## Read first
- REFERENCE.md 2.4
- `lib/azure/lakehouse-abfss.ts` `resolveLakehouseAbfss`, `listLakehouseRootFacts`, `readLakehouseRootOwner`
- the six route files

## Owns
- `apps/fiab-console/app/api/lakehouse/{transform-preview,table-stats,load-to-table,maintenance,schemas,interop}/route.ts` and their tests

## Must NOT touch
Any file outside Owns. Never edit `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`. No new Fabric/Power BI dependency (`no-fabric-dependency.md`). Do not re-decide Q1-Q10 (REFERENCE.md section 10). `lakehouse/settings`, `lakehouse/upload` (W01), the client layer (W02).

## Consumes
W01 builder; W02 client signature.

## Provides
A workspace id + root set per class W submit for W05/W07/W10.

## Steps
1. Add a shared `resolveWorkspaceRoot(itemId)` helper in the owned route dir.
2. Use it in the six routes and pass the tag from W02.
3. Add item->workspace binding tests and legacy/new root tests.

## Validation
Run from the repo root unless stated.
- cd apps/fiab-console && pnpm exec tsc --noEmit -p tsconfig.build.json
- `cd apps/fiab-console && pnpm exec vitest run app/api/lakehouse`
- Sandbox mutation: make the helper return the shared workspace; the binding test must go RED.
- Receipt rule: per-boundary status is one of `verified-live` / `not-exercised` / `blocked(owner)`. Commercial and GCC-High are exercised estates; IL5 has never produced a deploy receipt and GCC is supported-in-code, never exercised (`cloud-parity.md`). Gov receipts come from a GitHub Actions run, never a workstation `az`. A PR for this wave is reported "merged, not deployed" until the receipt exists. No live receipt (mode off); state that.

## Rollback
Revert the PR; routes return to ad hoc resolution. No flag.

## Docs to update
None until W11.

## Wave / Blocked-by / Branch / Worktree
Wave: 4 · Blocked-by: W01, W02 · Branch: feat/spark-id-w03-roots · Worktree: E:/Repos/_spark-id-w03

## Hot files
`apps/fiab-console/app/api/lakehouse/*` (sole owner this wave; W01 must be merged first); touches_bicep: no.

## Kickoff prompt
Read PRPs/backlog/per-workspace-spark-identity/PRP.md, spark-id-W03-lakehouse-roots.md, REFERENCE.md 2.4. Make the six class W lakehouse routes resolve workspace+root from the item id and pass the W02 tag. Done = tsc and `pnpm exec vitest run app/api/lakehouse` pass; binding and legacy-root tests named in the PRP fail under the stated mutations.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W03 | todo | feat/spark-id-w03-roots | sonnet | none (no issue yet) | 2026-11-14 |
