---
name: ib-11-bicep-autobind-env
status: backlog
priority: P2
order: 111
depends_on: []
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
issues: [3372, 4900, 4387]
branch: fix/ib-11-bicep-autobind-env
---

# PRP: ib-11 Bicep env wiring that the console reads but no template sets (auto-bind section 5)

## Goal
Wire three env-var and comment defects in the Loom bicep so the platform produces the value instead of asking the operator: `LOOM_COPYJOB_CONTROL_SQL_SERVER` is declared but never passed by the orchestrator (#3372); `LOOM_CONSOLE_PRINCIPAL_ID` is read by the console but never set by bicep (#4900); and two shipped bicep comments contradict each other on whether ARM rejects a duplicate role assignment tuple (#4387). Done is a from-scratch what-if or deploy showing the env var present on the console Container App, then a live read, not a merge.

## Why
Measured on main while writing this PRP (2026-11-14), because the issue bodies predate several fixes:
- #3372 has two halves. `LOOM_PGVECTOR_HOST` is now emitted (`platform/fiab/bicep/modules/admin-plane/main.bicep` near line 4683, `weavePgLocalActive ? ... : ...`); that half is done and gets verified, not rebuilt. `LOOM_COPYJOB_CONTROL_SQL_SERVER` is still unwired: `param loomCopyJobControlSqlServer string = ''` (admin-plane main, near line 2875), the `copyJobControl` module is gated on `!empty(...)`, and `platform/fiab/bicep/main.bicep` does not reference it (`git grep` returns no hit). The in-code note `NOT WIRED BY ANY TEMPLATE TODAY` remains at `apps/fiab-console/lib/admin/env-checks/builders.ts:108`.
- #4900: `LOOM_CONSOLE_PRINCIPAL_ID` appears in `platform/fiab/bicep/params/dlz-attach.bicepparam:66` as an input read from the deploy environment, and the console reads it in `app/api/setup/deploy/route.ts` and `app/api/setup/deploy-preflight/route.ts`, but no console env list in `admin-plane/main.bicep` sets it. The console UAMI principal id is available as `identity.outputs.uamiConsolePrincipalId`, and `LOOM_UAMI_CLIENT_ID` is already set from the same module (near line 6248).
- #4387: the two contradicting comments are in `platform/fiab/bicep/modules/data-plane/transform-runner-lake-rbac.bicep` and `platform/fiab/bicep/modules/data-plane/dlz-lake-grant-pass.bicep` (plus the note above `transformRunnerLakeRbac` in admin-plane main). The issue states the repo has three receipts for "ARM rejects a second assignment for the same tuple under a different name".

## Scope / Non-goals
In scope: the three issues above, and nothing wired by other batches.
Non-goals and deferrals:
- #3370: `LOOM_ONELAKE_URL`, `LOOM_BROKER_URL`, `LOOM_BROKER_REDIS` remain `''` in admin-plane main (`LOOM_DIRECTLAKE_URL` is now wired, #3291). The in-file note says the images for onelake and the broker have no CI producer and `hband-shared.bicep` has zero invocations, so the fix is image producers plus module wiring, feature-sized, not env plumbing.
- #3744: the `LOOM_EH_SCHEMA_GROUP` half is wired for single-DLZ and dlz-attach by #4774 (`main.bicep` `eventsConfig.loomEhSchemaGroup`); the Databricks warehouse id is only passed when adopted (`existingDatabricksSqlWarehouseId`). A greenfield default warehouse needs a decision on how it is created.
- #4947: needs an operator decision on which DLZ is canonical when several provision their own Event Hubs namespace.
- #4828 (needs a live `az containerapp job show` comparison against the running job), #4546 (a CI guard, not env wiring), #3965 (`cost-export.bicep` routing decision, allowlisted in `scripts/ci/check-bicep-sync.mjs`).
Cloud scope: bicep applies to every boundary through shared modules. The env var in #4900 is boundary-neutral. #3372 uses the plan-backing SQL server value, which is a parameter, so a boundary that does not set it keeps the honest gate. Receipts: Commercial from a deploy run; GCC-High and IL5 supported-in-code and inherit on their next deploy (IL5 has no recorded run; GCC supported-in-code, never exercised). Any Gov receipt comes from a GitHub Actions run, never local `az`.

> ASSUMPTION: for #3372 the issue's own proposal is used: default `loomCopyJobControlSqlServer` to the plan-backing SQL server (`loomPlanBackingSqlServer`, `main.bicep` line 1135) when that is set, else leave it empty and keep the existing honest gate. If no plan-backing server is deployed by the platform on a given boundary, this item reduces to documenting that boundary as gated, and the PR says so.

## Acceptance criteria
- [ ] #3372: `az bicep build --file platform/fiab/bicep/main.bicep` succeeds, and with `loomPlanBackingSqlServer` set to a non-empty value the compiled console env list contains `LOOM_COPYJOB_CONTROL_SQL_SERVER` equal to it; with it empty the value is empty (positive control). A compile where the value is empty despite a set plan-backing server fails this item. The stale `NOT WIRED BY ANY TEMPLATE TODAY` text in `builders.ts` is removed or rewritten to say what is true (a test asserts the string `NOT WIRED BY ANY TEMPLATE TODAY` no longer appears for this var).
- [ ] #3372 verify half: the compiled console env list still contains `LOOM_PGVECTOR_HOST`; recorded in the PR as already done, with the grep.
- [ ] #4900: the compiled console Container App env contains `LOOM_CONSOLE_PRINCIPAL_ID` equal to `identity.outputs.uamiConsolePrincipalId`; the value is not the client id (that is `LOOM_UAMI_CLIENT_ID`). A env entry whose value is the client id fails this item. After a deploy, `az containerapp show` env (read via an Actions step or the operator) lists the variable.
- [ ] #4387: after the edit the three comment sites agree, and the wrong claim ("collapses onto an equivalent grant already made for this pair elsewhere rather than erroring") is gone. `git grep -n "rather than erroring on a duplicate" -- platform/fiab/bicep` returns no hit. The edit changes no resource, so `az deployment sub what-if` shows no diff attributable to it.
- [ ] ARM size: the compiled `main.json` size is measured at the base ref and at the PR head with `git cat-file -s` on the generated artefact or `az bicep build --stdout | wc -c`, and both numbers are in the PR body. The change adds under 2 KB; a larger delta fails this item.

## Read first
- `platform/fiab/bicep/modules/admin-plane/main.bicep` (symbols: `loomCopyJobControlSqlServer`, `copyJobControl` module, the console `env` list around `LOOM_UAMI_CLIENT_ID`, `LOOM_COPYJOB_CONTROL_SQL_SERVER`)
- `platform/fiab/bicep/main.bicep` (symbols: `loomPlanBackingSqlServer`, the `adminPlane` module parameter block)
- `platform/fiab/bicep/modules/admin-plane/identity.bicep` (`uamiConsolePrincipalId`)
- `platform/fiab/bicep/modules/data-plane/transform-runner-lake-rbac.bicep`, `platform/fiab/bicep/modules/data-plane/dlz-lake-grant-pass.bicep`
- `platform/fiab/bicep/tests/test_bicep_modules.py` (line near 515 already names `LOOM_CONSOLE_PRINCIPAL_ID`; read what it asserts)
- `scripts/ci/check-bicep-sync.mjs`
- `apps/fiab-console/lib/admin/env-checks/builders.ts` (line near 107)
- `.claude/rules/auto-bind-by-default.md` (section 5), `.claude/rules/deploy-integrity.md`, `.claude/rules/cloud-parity.md`

## Owns
- `platform/fiab/bicep/main.bicep`
- `platform/fiab/bicep/modules/admin-plane/main.bicep`
- `platform/fiab/bicep/modules/data-plane/transform-runner-lake-rbac.bicep`
- `platform/fiab/bicep/modules/data-plane/dlz-lake-grant-pass.bicep`
- `platform/fiab/bicep/tests/test_bicep_modules.py`
- `apps/fiab-console/lib/admin/env-checks/builders.ts`

## Must NOT touch
- `platform/fiab/bicep/params/*.bicepparam` (no param-file edits; the default is derived in bicep)
- `platform/fiab/bicep/modules/compute/*` (onelake, broker, hband-shared: #3370 deferred)
- `platform/fiab/bicep/modules/admin-plane/cost-export.bicep`, `gh-runner-job.bicep`, `apim.bicep`, anything under `modules/health/**` and `health.bicep` (other programs)
- `scripts/ci/check-bicep-sync.mjs` unless a new env var needs a registered exemption; if so say why in the PR

## Consumes
Nothing from other PRPs. This batch edits two hot bicep files, so it takes the single bicep slot.

## Provides
Two env vars produced by the deploy instead of requested from the operator, and one corrected comment set.

## Steps
1. Take the bicep slot: check `gh pr list --state open --search "bicep"` and `PRPs/reference/GLOBAL-SCHEDULE.md` before starting; if another bicep PR is in flight, wait.
2. Worktree `E:/Repos/_ib-11`. Measure the compiled size at the base ref first.
3. #4900: add the env entry next to `LOOM_UAMI_CLIENT_ID` using `identity.outputs.uamiConsolePrincipalId`; add a `test_bicep_modules.py` assertion that the entry exists and is not the client id.
4. #3372: pass `loomCopyJobControlSqlServer` from `main.bicep` into the admin-plane module (default from `loomPlanBackingSqlServer`); rewrite the stale note in `builders.ts`; add the assertion.
5. #4387: fix the wrong comment (the one claiming duplicates collapse) to match the receipted behaviour; comment-only.
6. Build the template for every boundary parameter file (`commercial-full`, `gcc-high`, `il5`, `dod`, `gcc`) to confirm each still compiles.
7. Verify by what-if on the Commercial subscription through the existing deploy workflow, not a local `az` against Gov.

## Validation
- `az bicep build --file platform/fiab/bicep/main.bicep --stdout > /dev/null` (rc 0), and for each of `commercial-full`, `gcc-high`, `il5`, `dod`, `gcc`: `az bicep build-params --file platform/fiab/bicep/params/<name>.bicepparam --stdout > /dev/null`
- `python -m pytest platform/fiab/bicep/tests/test_bicep_modules.py -q` (read the executed count)
- `node scripts/ci/check-bicep-sync.mjs` (rc 0)
- `make validate-bicep`
- `pnpm --dir apps/fiab-console vitest run lib/admin/env-checks` for the `builders.ts` edit
- Merged is not done: report "merged, not deployed" until a Commercial deploy has run and the console env shows both variables (read from the estate by an Actions step or the operator). Per `auto-bind-by-default.md` the receipt is the capability reading ready without an operator step, not the template compiling. Per `deploy-integrity.md` R4 name which of greenfield and brownfield was exercised; if only what-if ran, say untested.
- Clouds: Commercial verified by deploy; GCC-High and IL5 supported-in-code, inherit on next deploy; GCC supported-in-code, never exercised.

## Rollback
Revert the PR. Both env vars are additive; removing them restores the previous honest gate. Do not hand-edit the live app to compensate.

## Docs to update
`docs/fiab/v3-tenant-bootstrap.md` if it lists `LOOM_COPYJOB_CONTROL_SQL_SERVER` or `LOOM_CONSOLE_PRINCIPAL_ID` as operator-set (`git grep -n "LOOM_COPYJOB_CONTROL_SQL_SERVER\|LOOM_CONSOLE_PRINCIPAL_ID" docs`); the deploy-prerequisites page referenced by #3348 if it exists.

## Wave / Blocked-by / Branch / Worktree
Wave: 1 (batch lane) · Blocked-by: none · Branch: fix/ib-11-bicep-autobind-env · Worktree: E:/Repos/_ib-11

## Hot files
`platform/fiab/bicep/main.bicep`, `platform/fiab/bicep/modules/admin-plane/main.bicep`. `touches_bicep: yes`.
Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| #4900 | todo | | sonnet | | |
| #3372 | todo | | sonnet | pgvector half already on main | |
| #4387 | todo | | sonnet | | |

Deferred candidates: #3370 (image producers needed), #3744 (EH half done by #4774; Databricks warehouse needs a creation decision), #4947 (needs operator decision on canonical DLZ), #4828, #4546, #3965.

## Kickoff prompt
Read PRPs/backlog/issue-batches/ib-11-bicep-autobind-env.md, .claude/rules/auto-bind-by-default.md and .claude/rules/deploy-integrity.md. First take the single bicep slot (check open bicep PRs). Work in a fresh worktree E:/Repos/_ib-11 on branch fix/ib-11-bicep-autobind-env. Measure the compiled template size at the base ref, then do #4900, #3372, #4387 in that order, each with a failing test or compile assertion first. Do not edit any bicepparam, compute modules, cost-export, health or apim files. Proof of done: az bicep build for main.bicep and all five boundary params, the pytest and check-bicep-sync runs, and the before/after size. Report "merged, not deployed" until the console env shows both variables on the estate. One reviewer pass; do not close issues.
