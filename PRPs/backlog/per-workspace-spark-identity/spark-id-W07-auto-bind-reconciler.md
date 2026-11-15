---
name: spark-id-W07-auto-bind-reconciler
status: backlog
priority: P2
order: 5
depends_on: [spark-id-W05-scoper-and-synapse-rbac, spark-id-W03-lakehouse-roots]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/spark-id-w07-autobind
---
# W07: Auto-bind hooks and reconciler (incl. brownfield backfill)

Program: [per-workspace-spark-identity](PRP.md) · Shared context: [REFERENCE.md](REFERENCE.md) · TRACKING ISSUE: #5297 (program tracker, created 2026-11-14; per-wave issues filed when each wave starts).

## Goal
Workspace create and lakehouse create/delete/adopt bind the spark-lake scope automatically; a reconciler repairs drift; existing workspaces are backfilled.

## Why
`auto-bind-by-default.md`: no user-performed plumbing. A binding the admin must create is a defect. Phase 1 of the migration (backfill, original section 7) is folded in here (ASSUMPTION: no separate wave).

## Scope / Non-goals
Hooks in the workspace-create flow and `lakehouse-abfss.ts` root lifecycle, fingerprinted binding in `workspace-bindings.ts`, reconciler on admin env-check + schedule + first submit, backfill in batches under the 80/20s UAMI-create limit. Non-goals: UI (W11), enforcement.

## Acceptance criteria
Each names the value or output that would make it fail.
- E2E: a new workspace plus a new lakehouse reach a bound state (`spark-lake` binding with fingerprint) with no admin action; fails if the binding row is absent after create.
- Drift injection: delete the assignment out-of-band; the next reconcile recreates it and the fingerprint matches (test asserts fingerprint before != during, == after).
- In `enforce`, an unhealable binding returns status `spark-identity-binding-pending` and does NOT fall back to the shared identity (Q4=A); fails if the shared credential is used.
- Backfill of N workspaces issues <= 80 UAMI creates per 20 s per subscription per region (test with a fake clock).

## Read first
- REFERENCE.md 6
- `lib/azure/workspace-bindings.ts`
- `lib/azure/lakehouse-abfss.ts` `createOwnedLakehouseRoot`, `mayAdoptRoot`
- workspace create route/flow (grep `ensureWorkspaceGrants`)

## Owns
- `apps/fiab-console/lib/azure/workspace-bindings.ts`
- `apps/fiab-console/lib/azure/lakehouse-abfss.ts` (hooks only, after W01/W03 merged)
- the workspace create flow file(s) found via grep `ensureWorkspaceGrants`
- new reconciler module `lib/azure/spark-lake-reconciler.ts` and tests

## Must NOT touch
Any file outside Owns. Never edit `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`. No new Fabric/Power BI dependency (`no-fabric-dependency.md`). Do not re-decide Q1-Q10 (REFERENCE.md section 10). Panel UI (W11), `workspace-grants.ts` internals (W05).

## Consumes
W05 scoper; W03 root resolution.

## Provides
Binding state + fingerprint, reconciler entry points for W10/W11.

## Steps
1. Hook `ensureWorkspaceGrants(ws, ["spark-lake"])` into workspace create.
2. Recompute the root set on lakehouse create/delete/adopt and ensure.
3. Reconciler: compare fingerprint to actual; repair; lazy repair on first submit.
4. Backfill job with throttle.

## Validation
Run from the repo root unless stated.
- cd apps/fiab-console && pnpm exec tsc --noEmit -p tsconfig.build.json
- `cd apps/fiab-console && pnpm exec vitest run lib/azure/__tests__/workspace-bindings lib/azure/__tests__/spark-lake-reconciler`
- Sandbox mutation: make the fingerprint constant; the drift test must go RED.
- Live clean-create walk per boundary (G1): create workspace -> create lakehouse -> binding visible, no admin step; receipt cites run/PR.
- Receipt rule: per-boundary status is one of `verified-live` / `not-exercised` / `blocked(owner)`. Commercial and GCC-High are exercised estates; IL5 has never produced a deploy receipt and GCC is supported-in-code, never exercised (`cloud-parity.md`). Gov receipts come from a GitHub Actions run, never a workstation `az`. A PR for this wave is reported "merged, not deployed" until the receipt exists.

## Rollback
Set `LOOM_SPARK_IDENTITY_MODE=off`: hooks no-op and the reconciler idles. Backfilled assignments are additive and harmless; delete by deterministic GUID if required.

## Docs to update
`docs/fiab/runbooks/workspace-identity-grants.md`, `workspace-identity-migration.md` (backfill).

## Wave / Blocked-by / Branch / Worktree
Wave: 5 · Blocked-by: spark-id-W05-scoper-and-synapse-rbac, spark-id-W03-lakehouse-roots · Branch: feat/spark-id-w07-autobind · Worktree: E:/Repos/_spark-id-w07
Cross-program order: after `apigw-W04a-cost-centers-pricing` (both edit `apps/fiab-console/lib/azure/workspace-bindings.ts`; rebase on it).

## Hot files
`lakehouse-abfss.ts` (after W01), `workspace-bindings.ts`; touches_bicep: no.

## Kickoff prompt
Read PRPs/backlog/per-workspace-spark-identity/PRP.md, spark-id-W07-auto-bind-reconciler.md, REFERENCE.md 6. Wire auto-bind into workspace/lakehouse lifecycle with a fingerprint reconciler. Done = tsc + named vitest pass, drift test is RED under the constant-fingerprint mutation, and a clean-create walk shows the binding with no admin step.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W07 | todo | feat/spark-id-w07-autobind | sonnet | none (no issue yet) | 2026-11-14 |
