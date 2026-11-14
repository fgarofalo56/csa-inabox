---
name: spark-id-W10-shadow-and-mode-flag
status: backlog
priority: P2
order: 6
depends_on: [spark-id-W03-lakehouse-roots, spark-id-W07-auto-bind-reconciler]
review: required
orchestrator_model: sonnet
implementer_model: sonnet
created: 2026-11-14
branch: feat/spark-id-w10-shadow
---
# W10: Shadow evaluator and LOOM_SPARK_IDENTITY_MODE

Program: [per-workspace-spark-identity](PRP.md) · Shared context: [REFERENCE.md](REFERENCE.md) · TRACKING ISSUE: to be created by orchestrator per wave.

## Goal
Introduce `LOOM_SPARK_IDENTITY_MODE` (off | shadow | enforce), the shadow evaluator that logs path/scope mismatches for every submit, and the enforce allowlist.

## Why
Enforcement needs 14 clean days of shadow data per boundary (Phase 2 exit gate). The flag does not exist today (grep 2026-11-14).

## Scope / Non-goals
Env var in `admin-plane/main.bicep`, evaluator in `workspace-identity-shadow.ts`, admin env-check row. ASSUMPTION: enforce allowlist is a second setting `LOOM_SPARK_IDENTITY_ENFORCE_WORKSPACES` (comma list); the original text says "allowlist" without naming it. Non-goals: UI beyond env-check.

## Acceptance criteria
Each names the value or output that would make it fail.
- Mode `off`: no evaluator call, no extra latency (unit test spies zero calls).
- Mode `shadow`: submits still use the shared identity; a submit whose resolved abfss path is outside the workspace root records a mismatch event (test feeds a path outside the root and asserts one event with the path).
- Mode `enforce` for an allowlisted workspace uses the workspace credential; a non-allowlisted workspace still uses the shared one (test asserts credential source per workspace).
- Env-check reports the mode per boundary; fails if the value is unset-but-reported-as-off without saying "unset".

## Read first
- REFERENCE.md 7 phase 2-3
- `lib/azure/workspace-identity-shadow.ts`
- `scripts/ci/check-workspace-credential-adoption.mjs`
- `platform/fiab/bicep/modules/admin-plane/main.bicep` (apps[] env list)

## Owns
- `apps/fiab-console/lib/azure/workspace-identity-shadow.ts`
- admin env-check module (grep `env-check`)
- `platform/fiab/bicep/modules/admin-plane/main.bicep` (one env var; ONE bicep PR)
- `platform/fiab/bicep/params/*.bicepparam` (set mode per boundary; default off)

## Must NOT touch
Any file outside Owns. Never edit `PRPs/INDEX.md`, `MASTER-INDEX.md`, `REGISTER.md`. No new Fabric/Power BI dependency (`no-fabric-dependency.md`). Do not re-decide Q1-Q10 (REFERENCE.md section 10).

## Consumes
W02 tag, W03 roots, W07 binding.

## Provides
Mode flag and shadow data; the Phase 2/3 operational gate used by W12.

## Steps
1. Add mode resolution + evaluator.
2. Add env var to bicep and per-boundary params (default off; set `shadow` after deploy by a separate operator-approved param change).
3. Env-check row.
4. After deploy, start the 14-day clock per boundary and record start date in the hub Execution state.

## Validation
Run from the repo root unless stated.
- cd apps/fiab-console && pnpm exec tsc --noEmit -p tsconfig.build.json
- `cd apps/fiab-console && pnpm exec vitest run lib/azure/__tests__/workspace-identity-shadow`
- `az bicep build -f platform/fiab/bicep/main.bicep`; what-if run link shows one env var change
- Operational exit gate (not a PR gate): 14 consecutive days of shadow with zero unexplained mismatches per boundary, cited as a query result with the date range.
- Receipt rule: per-boundary status is one of `verified-live` / `not-exercised` / `blocked(owner)`. Commercial and GCC-High are exercised estates; IL5 has never produced a deploy receipt and GCC is supported-in-code, never exercised (`cloud-parity.md`). Gov receipts come from a GitHub Actions run, never a workstation `az`. A PR for this wave is reported "merged, not deployed" until the receipt exists.

## Rollback
Set `LOOM_SPARK_IDENTITY_MODE=off` and roll the env var (revision). Enforce -> shadow -> off is immediate for new sessions (submitter change, not a grant); running sessions finish under their current identity.

## Docs to update
`docs/fiab/runbooks/workspace-identity-migration.md` (flag states).

## Wave / Blocked-by / Branch / Worktree
Wave: 6 · Blocked-by: W03, W07 · Branch: feat/spark-id-w10-shadow · Worktree: E:/Repos/_spark-id-w10

## Hot files
`admin-plane/main.bicep`, `params/*.bicepparam`: ONE bicep PR in flight; touches_bicep: yes.

## Kickoff prompt
Read PRPs/backlog/per-workspace-spark-identity/PRP.md, spark-id-W10-shadow-and-mode-flag.md. Add LOOM_SPARK_IDENTITY_MODE (off/shadow/enforce) + shadow evaluator + env-check row. Claim the bicep INTERLOCK slot first. Done = tsc + named vitest pass and az bicep build is clean; no default spend.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|---|---|---|---|---|---|
| W10 | todo | feat/spark-id-w10-shadow | sonnet | none (no issue yet) | 2026-11-14 |
