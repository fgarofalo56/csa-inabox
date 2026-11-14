---
name: spark-id-W05-scoper-and-synapse-rbac
status: backlog
priority: P2
order: 4
depends_on: [spark-id-W00-spike, spark-id-W01-abfss-builder]
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
branch: feat/spark-id-w05-scoper
---
# W05: SparkLakeScoper (ABAC + ACL) and per-workspace Synapse RBAC

Program: [per-workspace-spark-identity](PRP.md) · Shared context: [REFERENCE.md](REFERENCE.md) · TRACKING ISSUE: #5297 (program tracker, created 2026-11-14; per-wave issues filed when each wave starts). W05 here also covers original W06.

## Goal
A `spark-lake` backend in `workspace-grants.ts` that writes path-scoped storage grants (ABAC or ACL behind one interface) and Synapse Compute Operator on each pool for `uami-ws-<id>`.

## Why
Without path scoping the per-workspace identity would hold the same account-scope access as today, achieving nothing. Merged original W5 + W6, both owned by `workspace-grants.ts`.

## Scope / Non-goals
`SparkLakeScoper` with ABAC and ACL implementations, Synapse RBAC per pool, deploy-time script loop for the Console RBAC-write authority (Q9=B). Non-goals: auto-bind hooks (W07), narrowing shared grants (W12).

## Acceptance criteria
Each names the value or output that would make it fail.
- Condition-generation tests: for roots `lakehouses/sales--a1` and legacy `lakehouses/sales`, the generated ABAC string matches `lakehouses/sales/` and `lakehouses/sales--a1/` and NOT `lakehouses/sales2`; includes rename (`blobs/move/action`) and `runAsSuperUser` clauses. Fails if the trailing `/` is dropped.
- Idempotent PUT: running `ensure` twice yields one assignment with the same deterministic GUID (test counts ARM calls = 1 write then 0 changes).
- ACL implementation puts traversal on the `loom-spark-traverse` group and rwx+default on the root; test asserts entry count per item < 28.
- Synapse RBAC: after `ensure`, the Synapse RBAC API lists Compute Operator for `uami-ws-<id>` on each of `loompool`, `loometl`, `loombatch` deployed in that boundary; fails if a deployed pool is missing.
- Per boundary the scoper kind chosen equals the W00 verdict; a boundary without ABAC confirmation selects ACL.

## Read first
- REFERENCE.md 2.5, 3, 4(b), 6
- W00 report verdicts
- `lib/azure/workspace-grants.ts` `WORKSPACE_GRANTS`, `ensureWorkspaceGrants`
- `platform/fiab/bicep/modules/landing-zone/storage-rbac-admin.bicep` `blobOnlyCondition`, `synapse.bicep` `consoleSparkSubmitRoleScript`

## Owns
- `apps/fiab-console/lib/azure/workspace-grants.ts`
- `apps/fiab-console/lib/azure/spark-lake-scoper.ts` (new) and tests
- `platform/fiab/bicep/modules/landing-zone/synapse.bicep` (RBAC-write script loop only)

## Must NOT touch
Any file outside Owns. Never edit `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`. No new Fabric/Power BI dependency (`no-fabric-dependency.md`). Do not re-decide Q1-Q10 (REFERENCE.md section 10). Account-scope grants in `synapse-storage-rbac.bicep` (W12). `workspace-bindings.ts` (W07).

## Consumes
W01 builder; W00 verdict; existing `queuedArmWrite` throttle.

## Provides
`SparkLakeScoper.ensure(workspaceId)`, `.verify`, `.rootSet`; Synapse RBAC ensure. W07/W10 consume.

## Steps
1. Define the `SparkLakeScoper` interface and the ABAC implementation (pure condition builder first, fully unit tested).
2. Add the ACL implementation (ASSUMPTION: recursive apply via the existing ADLS client).
3. Add the `spark-lake` backend to `WORKSPACE_GRANTS` and Synapse RBAC ensure.
4. Bicep: script loop for Synapse RBAC-write (Q9=B); claim the INTERLOCK slot.
5. Live scope probe in sandbox then each boundary: read/write inside root OK, outside root returns 403.

## Validation
Run from the repo root unless stated.
- cd apps/fiab-console && pnpm exec tsc --noEmit -p tsconfig.build.json
- `cd apps/fiab-console && pnpm exec vitest run lib/azure/__tests__/spark-lake-scoper lib/azure/__tests__/workspace-grants`
- `az bicep build -f platform/fiab/bicep/main.bicep` + what-if run link showing only the intended assignment changes
- Live scope probe receipt per boundary: inside-root write HTTP 2xx, outside-root HTTP 403 (name both statuses).
- Receipt rule: per-boundary status is one of `verified-live` / `not-exercised` / `blocked(owner)`. Commercial and GCC-High are exercised estates; IL5 has never produced a deploy receipt and GCC is supported-in-code, never exercised (`cloud-parity.md`). Gov receipts come from a GitHub Actions run, never a workstation `az`. A PR for this wave is reported "merged, not deployed" until the receipt exists.

## Rollback
Remove the per-workspace assignments (ARM delete by deterministic GUID) or leave ACL entries (harmless without an identity that uses them); shared grants are untouched, so no data access is lost. Allow hours for propagation.

## Docs to update
`docs/fiab/runbooks/workspace-identity-grants.md` (spark-lake backend section).

## Wave / Blocked-by / Branch / Worktree
Wave: 4 · Blocked-by: W00, W01 · Branch: feat/spark-id-w05-scoper · Worktree: E:/Repos/_spark-id-w05

## Hot files
`workspace-grants.ts` sole owner; `synapse.bicep`: ONE bicep PR in flight; touches_bicep: yes.

## Kickoff prompt
Read PRPs/backlog/per-workspace-spark-identity/PRP.md, spark-id-W05-scoper-and-synapse-rbac.md, REFERENCE.md 2.5/4(b), and the W00 report. Build SparkLakeScoper (ABAC+ACL) and the Synapse Compute Operator ensure in workspace-grants.ts. Done = tsc + the named vitest pass (trailing-slash test fails if the slash is removed) and an inside-OK/outside-403 probe receipt per deployed boundary.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W05 | todo | feat/spark-id-w05-scoper | sonnet | none (no issue yet) | 2026-11-14 |
