---
name: ib-04-no-freeform-pickers-b
status: backlog
priority: P2
order: 104
depends_on: [ib-03-no-freeform-pickers-a]
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
issues: [4854, 3626, 4039]
branch: fix/ib-04-no-freeform-pickers-b
---

# PRP: ib-04 No free-text config, secrets and run pickers, plus mirror route harness (batch B)

## Goal
Remove the typed Key Vault secret-name fields from the lakehouse shortcut wizard by adding a Delta Sharing "Save to Key Vault" path (#4854), replace the last free-text site in the unified SQL database editor (an ADF run id) with a run picker (#3626), and give mirrored-database route guards a shared route-handler test harness so three unwitnessed guards go RED under mutation (#4039).

## Why
`shortcut-wizard-dialog.tsx` still asks for a secret name at the `[name:secret-ref]` sites (report lines :179 and :242); `shortcut-secret-resolver.ts` accepts only credentials Loom saved, so a typed name for a secret made elsewhere is refused (a user dead end). `unified-sql-database-editor.tsx:2205` is the last site behind its `TOUCH_EXEMPT` entry; its named acceptance is a factory-scoped runs route that does not exist yet. #4039's three guards (R4 `submit()` early return, R7 PATCH effective-pair, R8 sources POST stored connection) are correct but a mutation that breaks each stays green.

This PRP is serial after `ib-03-no-freeform-pickers-a` because both edit `scripts/ci/check-no-freeform.mjs` and `no-freeform-inputs-baseline.json`. #4039 is off the pickers theme (test-only plus a harness); it is here because it shares no file with any other batch and has no home PRP.

## Scope / Non-goals
In scope: the three issues. Non-goals: the Event Grid, Databricks, Foundry pickers (shipped or in ib-03); Snowflake or Oracle mirror source wizards beyond the three guards.
Cloud scope: shortcut credentials use the cloud-aware Key Vault DNS suffix (`vault.azure.net` vs `vault.usgovcloudapi.net`) from the existing resolver; no hard-coded host. Commercial live receipt; GCC-High via Actions; GCC supported-in-code, never exercised.

## Acceptance criteria
- [ ] #4854: a Delta Sharing shortcut and an external ADLS SAS shortcut are both created from the wizard without typing a Key Vault secret name. `ExternalCredsForm` gains `delta_sharing` (paste or upload credential JSON, validated for `shareCredentialsVersion`, `endpoint`, `bearerToken`) and stores via `POST /api/lakehouse/shortcuts/credentials`. `node scripts/ci/check-no-freeform.mjs --report` no longer lists the two `secret-ref` sites. Fails if a JSON without `bearerToken` is accepted, or if a typed name is still the only path.
- [ ] #3626: the `Run ID` field at `unified-sql-database-editor.tsx` is a Dropdown fed by a new factory-scoped runs route; the file leaves the baseline and its `TOUCH_EXEMPT` entry is deleted. Fails if `--report` still lists the file, or if the route returns runs for a factory the item is not bound to (a cross-item read must 403/404; test with a foreign factory id).
- [ ] #4039 R4: deleting `|| connMismatch` from `submit()` in `mirror-source-wizard.tsx` turns a test RED (render test removes `disabled` before clicking, or a direct submit call).
- [ ] #4039 R7/R8: reading `body?.sourceType` only (dropping `?? state.sourceType`) in `app/api/items/mirrored-database/[id]/route.ts`, and likewise `connectionId` in `.../sources/route.ts`, each turns a harness test RED; the fixture edits only the source type while the stored connection stays, which is the contradiction the guard exists to catch.
- [ ] Each mutation above is run on a sandbox copy, RED then green, tracked tree proven untouched.

## Read first
- `apps/fiab-console/lib/editors/lakehouse/dialogs/shortcut-wizard-dialog.tsx`, `lib/components/onelake/shortcut-wizard.tsx` (`ExternalCredsForm`, `CredSourceType`), `lib/azure/shortcut-secret-resolver.ts`, `app/api/lakehouse/shortcuts/credentials/`
- `apps/fiab-console/lib/editors/unified-sql-database-editor.tsx` (receipt run id), `app/api/items/adf-pipeline/[id]/runs/route.ts` (pattern; it resolves from an item binding)
- `apps/fiab-console/lib/editors/components/mirror-source-wizard.tsx`, `app/api/items/mirrored-database/[id]/route.ts`, `.../sources/route.ts`, `lib/azure/__tests__/mirror-route-mismatch-guard.test.ts`, `lib/editors/components/__tests__/mirror-source-mismatch.test.tsx`
- `.claude/rules/assertion-design.md`

## Owns
- `apps/fiab-console/lib/editors/lakehouse/dialogs/shortcut-wizard-dialog.tsx`
- `apps/fiab-console/lib/components/onelake/shortcut-wizard.tsx`
- `apps/fiab-console/app/api/lakehouse/shortcuts/credentials/route.ts`
- `apps/fiab-console/lib/azure/shortcut-secret-resolver.ts`
- `apps/fiab-console/lib/editors/unified-sql-database-editor.tsx`
- `apps/fiab-console/app/api/items/azure-sql-database/[id]/adf-runs/route.ts` (new)
- `apps/fiab-console/app/api/items/azure-sql-database/[id]/adf-runs/__tests__/route.test.ts` (new)
- `apps/fiab-console/lib/editors/components/mirror-source-wizard.tsx`
- `apps/fiab-console/app/api/items/mirrored-database/[id]/route.ts`
- `apps/fiab-console/app/api/items/mirrored-database/[id]/sources/route.ts`
- `apps/fiab-console/app/api/items/mirrored-database/__tests__/route-harness.ts` (new)
- `apps/fiab-console/app/api/items/mirrored-database/__tests__/route-guards.test.ts` (new)
- `apps/fiab-console/lib/editors/components/__tests__/mirror-source-mismatch.test.tsx`
- `scripts/ci/check-no-freeform.mjs` and `scripts/ci/no-freeform-inputs-baseline.json` (serial after ib-03; listed because the dependency is declared)

## Must NOT touch
- `kql-database-editor.tsx`, `copilot-agents-config.tsx`, `workspace-settings-drawer.tsx`, `app/api/foundry/projects/**` (ib-03)
- `lib/azure/mirror-sources.ts` internals beyond what a guard test needs (review the diff against `lib/azure/__tests__/mirror-sources.test.ts`)
- `lib/gates/registry/**` (hot; integration step to the owning PRP if a gate id is needed)

## Consumes
- `ib-03-no-freeform-pickers-a` (merged first, baseline and `TOUCH_EXEMPT` state). Rebase and re-run `--report` before step 1.

## Provides
- A reusable route-handler harness (mocked session plus `itemsContainer`) for future route guards.

## Steps
1. After ib-03 merges: rebase, `node scripts/ci/check-no-freeform.mjs --report > temp/ff-before.txt`.
2. #4039 first (it is test-only and de-risks the route edits): build the harness, write the three guard tests, run each mutation on a sandbox copy, record RC table.
3. #4854: add `delta_sharing` to `ExternalCredsForm`, drop the typed name field at both wizard sites, keep the `loom-sc-` ownership check intact; test that a name not saved by Loom is still refused.
4. #3626: add the factory-scoped runs route (resolves the factory from the item binding and verifies ownership like the adf-pipeline precedent), swap the field for a Dropdown, delete the `TOUCH_EXEMPT` entry and ratchet the baseline.
5. Confirm `--report` diff shows exactly the removed sites.

## Validation
- `node scripts/ci/check-no-freeform.mjs` (exit 0) and `node --test scripts/ci/__tests__/no-freeform.test.mjs`
- `pnpm --dir apps/fiab-console vitest run app/api/items/mirrored-database app/api/items/azure-sql-database lib/editors/components lib/azure`
- `make validate-typescript`
- Live walk (G1): create a Delta Sharing shortcut and an ADLS-SAS shortcut with no typed secret name; pick an ADF run in the SQL editor. Merged is not done: "merged, not deployed" until the live walk is repeated after the console roll.
- Credentials never appear in the PR, tests or logs (use clearly fake bearer tokens; the secret scanner must stay green).

## Rollback
Revert the PR. Secrets already saved by the new path remain valid for the old typed-name path because the resolver contract is unchanged.

## Docs to update
`docs/fiab/parity/` page for the lakehouse shortcut wizard if present; mirroring doc only if guard behaviour changes (it should not).

## Wave / Blocked-by / Branch / Worktree
Wave: 2 · Blocked-by: ib-03-no-freeform-pickers-a · Branch: fix/ib-04-no-freeform-pickers-b · Worktree: E:/Repos/_ib-04

## Hot files
`check-no-freeform.mjs`, `no-freeform-inputs-baseline.json` (serial). `touches_bicep: no`.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| #4854 | todo | | sonnet | | |
| #3626 | todo | | sonnet | | |
| #4039 | todo | | sonnet | | |

Deferred candidates: none beyond those listed in `ib-03-no-freeform-pickers-a` (#3511, #3526, #3540, #3541, #3543, #3742, #4201, #4740: appear shipped on main, need live verification and operator closure).

## Kickoff prompt
Read PRPs/backlog/issue-batches/ib-04-no-freeform-pickers-b.md and .claude/rules/assertion-design.md. Confirm ib-03-no-freeform-pickers-a is merged (rebase if so; stop and say so if not). Worktree E:/Repos/_ib-04, branch fix/ib-04-no-freeform-pickers-b. Do #4039 first with sandbox-copy mutations, then #4854, then #3626. Never put a real credential in code, tests or logs. Proof of done: check-no-freeform.mjs exits 0, the section 11 vitest command is green, and each mutation shows RED then green. Open the PR with review required.
