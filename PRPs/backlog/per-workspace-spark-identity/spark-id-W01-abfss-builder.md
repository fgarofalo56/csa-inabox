---
name: spark-id-W01-abfss-builder
status: backlog
priority: P2
order: 2
depends_on: [spark-id-W00-spike]
review: none
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/spark-id-w01-abfss
---
# W01: abfss builder consolidation

Program: [per-workspace-spark-identity](PRP.md) · Shared context: [REFERENCE.md](REFERENCE.md) · TRACKING ISSUE: #5297 (program tracker, created 2026-11-14; per-wave issues filed when each wave starts).

## Goal
Route every DFS hostname through `lakehouse-abfss.ts` so Gov suffixes work and no file hard-codes `.dfs.core.windows.net`.

## Why
Six sites build Commercial DFS hostnames directly (REFERENCE.md 2.3), which is a latent cloud-parity defect independent of this program and a precondition for path-scoping (the scoper must see one canonical path).

## Scope / Non-goals
The six sites in REFERENCE.md 2.3 plus a CI ratchet. Non-goals: identity change, credential plumbing, behaviour change for Commercial.

## Acceptance criteria
Each names the value or output that would make it fail.
- `node scripts/ci/check-abfss-builder.mjs` exits 0 on the branch and exits non-zero when a file outside `lib/azure/lakehouse-abfss.ts` contains the literal `.dfs.core.windows.net`. Fails the day someone adds a literal outside the builder (prove with a sandbox copy containing one).
- A unit test builds the abfss URL with `dfsSuffix()` returning the Gov suffix (`.dfs.core.usgovcloudapi.net`) for transform-preview and table-stats roots. Fails if the Commercial suffix appears in the Gov output.
- Commercial output for the six sites is byte-identical to before (golden test). Fails on any suffix or path change.

## Read first
- `lib/azure/lakehouse-abfss.ts` `dfsSuffix`, `resolveLakehouseAbfss`
- REFERENCE.md 2.3
- `app/api/lakehouse/transform-preview/route.ts`, `table-stats/route.ts`
- `scripts/ci/check-workspace-credential-adoption.mjs` (ratchet style to copy)

## Owns
- `apps/fiab-console/lib/azure/lakehouse-abfss.ts`
- `apps/fiab-console/lib/azure/delta-maintenance.ts`
- `apps/fiab-console/app/api/lakehouse/{transform-preview,table-stats,settings,upload}/route.ts`
- `apps/fiab-console/app/api/items/spark-job-definition/[id]/files/route.ts`
- `scripts/ci/check-abfss-builder.mjs` (new) and its test
- the CI workflow entry that runs ratchets (one line)

## Must NOT touch
Any file outside Owns. Never edit `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`. No new Fabric/Power BI dependency (`no-fabric-dependency.md`). Do not re-decide Q1-Q10 (REFERENCE.md section 10). No `synapse-dev-client.ts` (W02), no other lakehouse routes (W03).

## Consumes
W00 report only for the go decision; no code dependency.

## Provides
`resolveLakehouseAbfss` as the only abfss/DFS builder; the ratchet. W03 and W05 consume it.

## Steps
1. Grep each of the six sites; replace literal suffix/regex with the builder.
2. Add the ratchet script plus a node test with a positive and a negative fixture.
3. Wire the ratchet into the existing ratchet runner.
4. Add Gov-suffix unit tests and Commercial golden tests.

## Validation
Run from the repo root unless stated.
- cd apps/fiab-console && pnpm exec tsc --noEmit -p tsconfig.build.json
- `cd apps/fiab-console && pnpm exec vitest run lib/azure/__tests__/lakehouse-abfss` (and the touched route tests)
- `node --test scripts/ci/__tests__/check-abfss-builder.test.mjs`
- `node scripts/ci/check-abfss-builder.mjs`
- Mutation (sandbox copy only): insert a literal suffix into a route copy; the ratchet must go RED; confirm the tracked tree is untouched with `git status`.
- Receipt rule: per-boundary status is one of `verified-live` / `not-exercised` / `blocked(owner)`. Commercial and GCC-High are exercised estates; IL5 has never produced a deploy receipt and GCC is supported-in-code, never exercised (`cloud-parity.md`). Gov receipts come from a GitHub Actions run, never a workstation `az`. A PR for this wave is reported "merged, not deployed" until the receipt exists. Gov-suffix correctness is unit-level only; no live Gov receipt is required for this refactor but must be stated as such.

## Rollback
Revert the PR. No flag; behaviour on Commercial is unchanged by construction (golden test).

## Docs to update
`docs/fiab/runbooks/workspace-identity-grants.md` cross-reference only if it names a literal suffix.

## Wave / Blocked-by / Branch / Worktree
Wave: 2 · Blocked-by: W00 · Branch: feat/spark-id-w01-abfss · Worktree: E:/Repos/_spark-id-w01

## Hot files
`apps/fiab-console/app/api/lakehouse/*` routes (sequence before W03); touches_bicep: no.

## Kickoff prompt
Read PRPs/backlog/per-workspace-spark-identity/PRP.md, spark-id-W01-abfss-builder.md, REFERENCE.md 2.3. Replace literal DFS suffixes in the six sites with resolveLakehouseAbfss/dfsSuffix and add scripts/ci/check-abfss-builder.mjs. Done = tsc + the named vitest + node --test + the ratchet exit 0, and the mutation run goes RED in a sandbox copy.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W01 | todo | feat/spark-id-w01-abfss | sonnet | none (no issue yet) | 2026-11-14 |
