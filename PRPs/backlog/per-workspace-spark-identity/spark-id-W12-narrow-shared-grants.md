---
name: spark-id-W12-narrow-shared-grants
status: backlog
priority: P2
order: 8
depends_on: [spark-id-W09-batch-conversion, spark-id-W10-shadow-and-mode-flag, spark-id-W11-admin-ui-runbook]
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
branch: feat/spark-id-w12-narrow
---
# W12: Narrow shared grants (phase 4)

Program: [per-workspace-spark-identity](PRP.md) · Shared context: [REFERENCE.md](REFERENCE.md) · TRACKING ISSUE: #5297 (program tracker, created 2026-11-14; per-wave issues filed when each wave starts).

## Goal
Add `synapseMsiStorageScope` and `consoleSparkStorageScope` (`account` | `platform-paths`) and narrow the Synapse MSI and Console Spark-lane data roles to platform paths, per boundary, only after enforce is complete in that boundary.

## Why
Until the shared account-scope grants are narrowed, per-workspace scoping does not reduce what a compromised session or MSI can reach (G1 of the original goals).

## Scope / Non-goals
`synapse-storage-rbac.bicep`, `synapse.bicep`, param files. Precondition (operational, operator-run): enforce on for all workspaces in the boundary, 14 clean shadow days, W09 batches converted, platform paths from W00 measurement 3. Non-goals: Databricks.

## Acceptance criteria
Each names the value or output that would make it fail.
- What-if shows ONLY the intended assignment changes (list the assignment names changed); fails if any unrelated resource changes.
- After deploy, an inside-platform-path Spark probe passes and an access to another workspace root as the Synapse MSI returns 403 (name both statuses).
- A rollback redeploy with `account` was rehearsed in sandbox and restored the prior assignments (readback list).
- Default parameter value remains `account` in every param file until the operator flips it per boundary.

## Read first
- REFERENCE.md 2.5, 7 phase 4
- `landing-zone/synapse-storage-rbac.bicep`, `synapse.bicep`
- W00 measurement 3 (platform paths)

## Owns
- `platform/fiab/bicep/modules/landing-zone/synapse-storage-rbac.bicep`
- `platform/fiab/bicep/modules/landing-zone/synapse.bicep` (scope params only)
- `platform/fiab/bicep/params/*.bicepparam` (new param, default account)

## Must NOT touch
Any file outside Owns. Never edit `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`. No new Fabric/Power BI dependency (`no-fabric-dependency.md`). Do not re-decide Q1-Q10 (REFERENCE.md section 10).

## Consumes
Everything prior; operator approval per boundary (Commercial, GCC, GCC-High, IL5 order, Q8).

## Provides
Least-privilege end state.

## Steps
1. Add parameters (default `account`) and conditional assignments.
2. What-if per boundary via workflow; cite run links.
3. Operator flips one boundary at a time; probe; record receipt; advance.

## Validation
Run from the repo root unless stated.
- `az bicep build -f platform/fiab/bicep/main.bicep`
- what-if per boundary via the deploy workflow (run link); apply only on operator approval
- Probe receipt per boundary: platform path OK, cross-workspace 403.
- Receipt rule: per-boundary status is one of `verified-live` / `not-exercised` / `blocked(owner)`. Commercial and GCC-High are exercised estates; IL5 has never produced a deploy receipt and GCC is supported-in-code, never exercised (`cloud-parity.md`). Gov receipts come from a GitHub Actions run, never a workstation `az`. A PR for this wave is reported "merged, not deployed" until the receipt exists.

## Rollback
Redeploy with the scope parameter set back to `account`. Role-assignment propagation and MI token caches can take hours, so plan the rollback window in hours, not minutes.

## Docs to update
`docs/fiab/runbooks/workspace-identity-migration.md` (phase 4).

## Wave / Blocked-by / Branch / Worktree
Wave: 8 · Blocked-by: W09, W10, W11 · Branch: feat/spark-id-w12-narrow · Worktree: E:/Repos/_spark-id-w12

## Hot files
`synapse-storage-rbac.bicep`, `synapse.bicep`, `params/*.bicepparam`: ONE bicep PR in flight; touches_bicep: yes.

## Kickoff prompt
Read PRPs/backlog/per-workspace-spark-identity/PRP.md, spark-id-W12-narrow-shared-grants.md, REFERENCE.md 7 phase 4. Add the two scope params (default account) and narrow only on operator approval per boundary. Claim the bicep INTERLOCK slot first. Done = az bicep build clean, what-if run link shows only intended changes, probe receipt per boundary.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W12 | todo | feat/spark-id-w12-narrow | sonnet | none (no issue yet) | 2026-11-14 |
