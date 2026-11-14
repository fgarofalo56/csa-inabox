---
name: spark-id-W09-batch-conversion
status: backlog
priority: P2
order: 6
depends_on: [spark-id-W02-client-credential, spark-id-W03-lakehouse-roots, spark-id-W08-session-pool-keying]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/spark-id-w09-batch
---
# W09: Batch conversion to per-workspace sessions

Program: [per-workspace-spark-identity](PRP.md) · Shared context: [REFERENCE.md](REFERENCE.md) · TRACKING ISSUE: #5297 (program tracker, created 2026-11-14; per-wave issues filed when each wave starts).

## Goal
Convert class U/W batch submits (rows 10-12, 15, 22) to per-workspace sessions; platform fixed-code batches stay on the Synapse MSI (Q3=C).

## Why
Batches run as the Synapse workspace MSI (account-scope Contributor), so they bypass any per-workspace identity (REFERENCE.md 3).

## Scope / Non-goals
Routes `spark-job-definition/[id]/submit`, `synapse-spark-pool/[id]/submit`, `synapse/sparkjobdefinitions/[name]/run`, `lakehouse/load-to-table`, `lib/migrate/copy-engine.ts`; dispatch in `run-adapters.ts` and `launch-item.ts`. Non-goals: class P batches.

## Acceptance criteria
Each names the value or output that would make it fail.
- Parity test: the same input yields equivalent output via batch (old) and session (new) for load-to-table (row count and schema equal). Fails if row counts differ.
- Class P batch still submits via `submitLivyBatch` (spy asserts call).
- Run history shape (run id, status polling) is unchanged for existing UI; fails if a status enum value disappears.

## Read first
- REFERENCE.md 2.1 rows 10-12, 15, 20-22
- `lib/scheduler/run-adapters.ts`
- `lib/taskflow/launch-item.ts`
- `lib/migrate/copy-engine.ts`

## Owns
- `apps/fiab-console/app/api/items/spark-job-definition/[id]/submit/route.ts`
- `apps/fiab-console/app/api/items/synapse-spark-pool/[id]/submit/route.ts`
- `apps/fiab-console/app/api/synapse/sparkjobdefinitions/[name]/run/route.ts`
- `apps/fiab-console/app/api/lakehouse/load-to-table/route.ts`
- `apps/fiab-console/lib/migrate/copy-engine.ts`
- `apps/fiab-console/lib/scheduler/run-adapters.ts`
- `apps/fiab-console/lib/taskflow/launch-item.ts`

## Must NOT touch
Any file outside Owns. Never edit `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`. No new Fabric/Power BI dependency (`no-fabric-dependency.md`). Do not re-decide Q1-Q10 (REFERENCE.md section 10). Client layer (W02), pool (W08).

## Consumes
W02, W03, W08.

## Provides
Batches that carry user code no longer run as the Synapse MSI.

## Steps
1. Introduce a batch-as-session adapter behind the mode flag.
2. Convert each listed site.
3. Parity and spy tests.

## Validation
Run from the repo root unless stated.
- cd apps/fiab-console && pnpm exec tsc --noEmit -p tsconfig.build.json
- `cd apps/fiab-console && pnpm exec vitest run app/api/items/spark-job-definition app/api/synapse lib/scheduler lib/taskflow lib/migrate`
- Sandbox mutation: route a class P batch through the session adapter; the spy test must go RED.
- Receipt rule: per-boundary status is one of `verified-live` / `not-exercised` / `blocked(owner)`. Commercial and GCC-High are exercised estates; IL5 has never produced a deploy receipt and GCC is supported-in-code, never exercised (`cloud-parity.md`). Gov receipts come from a GitHub Actions run, never a workstation `az`. A PR for this wave is reported "merged, not deployed" until the receipt exists. Live parity receipt per exercised boundary.

## Rollback
Set `LOOM_SPARK_IDENTITY_MODE` to `off` or `shadow`: the adapter keeps submitting batches as before. Revert the PR if the adapter itself is faulty.

## Docs to update
`docs/fiab/runbooks/workspace-identity-migration.md`.

## Wave / Blocked-by / Branch / Worktree
Wave: 6 · Blocked-by: W02, W03, W08 · Branch: feat/spark-id-w09-batch · Worktree: E:/Repos/_spark-id-w09

## Hot files
`run-adapters.ts`, `launch-item.ts`, `copy-engine.ts` (sole owner); touches_bicep: no.

## Kickoff prompt
Read PRPs/backlog/per-workspace-spark-identity/PRP.md, spark-id-W09-batch-conversion.md, REFERENCE.md 2.1. Convert the batch call sites for classes U/W to per-workspace sessions behind the mode flag. Done = tsc + named vitest pass; class P batches still use submitLivyBatch; load-to-table parity row counts equal.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W09 | todo | feat/spark-id-w09-batch | sonnet | none (no issue yet) | 2026-11-14 |
