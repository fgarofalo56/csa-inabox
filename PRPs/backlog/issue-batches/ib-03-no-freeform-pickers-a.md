---
name: ib-03-no-freeform-pickers-a
status: backlog
priority: P2
order: 103
depends_on: []
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
issues: [4389, 4444, 4816]
branch: fix/ib-03-no-freeform-pickers-a
---

# PRP: ib-03 No free-text config, pickers for three console surfaces (batch A)

## Goal
Replace the remaining baselined free-text infrastructure inputs on three console surfaces with pickers or platform-derived values: the KQL ingest wizard "Target table" (#4389), the Copilot agents admin config endpoints and ids (#4444), and the workspace settings drawer Power BI GUID and Git PAT (#4816). Each fix deletes its entry from `TOUCH_EXEMPT` and ratchets `no-freeform-inputs-baseline.json` down.

## Why
Free-text ARM ids, endpoints, GUIDs and pasted secrets are user-performed plumbing (`auto-bind-by-default.md`). Three files carry `TOUCH_EXEMPT` entries that exist only because earlier PRs could not clear the sites; the entries are a graveyard unless an owner deletes them. This batch is deliberately three, not five: #4444 needs a new Foundry-project enumeration route and #4816 changes how a secret reaches Key Vault.

Measured on main with `node scripts/ci/check-no-freeform.mjs --report`: `copilot-agents-config.tsx` sites at :362, :446, :454, :507; `workspace-settings-drawer.tsx` at :412 (guid) and :934 (password-field); `kql-database-editor.tsx` around line 1918 is a plain `<Input value={wizSource} placeholder="events">` (not in the report as a baselined site; the issue is that it is free text where `/api/adx/tables` is already fetched).

Already shipped on main, so excluded here (code-verified, not live-verified): #3511, #3526, #3540, #3541, #3543, #3742, #4201, #4740 (see Deferred).

## Scope / Non-goals
In scope: the three surfaces above, the new Foundry-project list route, and the guard files. Non-goals: #4854 and #3626 (ib-04, serial after this PRP because both edit `check-no-freeform.mjs` and the baseline); a Fabric workspace becoming required (`no-fabric-dependency.md`: the picker degrades to "no Fabric bound", never a gate).
Cloud scope: Commercial and GCC-High (Azure Government endpoints via the existing cloud resolver); GCC supported-in-code, never exercised. No hard-coded `*.azure.com` hosts; use the existing cloud-aware helpers. Named receipts required: Commercial live browser walk; GCC-High via GitHub Actions run, not local `az`.

## Acceptance criteria
- [ ] #4389: KQL ingest wizard "Target table" is a `Combobox freeform` over `/api/adx/tables` modelled on `lib/components/adx/ingestion-mapping-picker.tsx`; an undiscovered name can still be typed. Fails if the field renders a bare `<Input>` or if a table not in the list cannot be submitted.
- [ ] #4444: `:362` renders the derived AOAI endpoint read-only with an explicit Override control; a Foundry project list route exists under `app/api/foundry/projects/` and feeds `:446`, `:454` derives from the selection; `:507` is a Fabric workspace picker that renders "no Fabric workspace bound" without gating when none is. Fails if `node scripts/ci/check-no-freeform.mjs --report` still lists `copilot-agents-config.tsx` or if the file's `TOUCH_EXEMPT` entry remains.
- [ ] #4816: both `workspace-settings-drawer.tsx` sites are gone from `--report` and the file's baseline count is 0; the PAT is a Key Vault secret reference picked via `KeyVaultSecretPicker` (the browser never holds a raw token on the default path); the existing git routes under `app/api/admin/workspaces/[id]/git/` accept the reference. Fails if a test finds a `type="password"` input at the PAT site.
- [ ] `node scripts/ci/check-no-freeform.mjs` exits 0 with the three `TOUCH_EXEMPT` entries deleted, and the baseline JSON count for each file is lower than before.
- [ ] G1: a live in-browser receipt per surface (real data in the picker), plus a first-open pass showing no error banner on a fresh item.

## Read first
- `scripts/ci/check-no-freeform.mjs` (`TOUCH_EXEMPT`, `ACCEPTED`), `scripts/ci/no-freeform-inputs-baseline.json`, `scripts/ci/__tests__/no-freeform.test.mjs`
- `apps/fiab-console/lib/components/adx/ingestion-mapping-picker.tsx`, `lib/components/azure/keyvault-secret-picker.tsx`, `lib/components/azure/azure-backed-field.tsx`
- `apps/fiab-console/lib/editors/phase3/kql-database-editor.tsx` (ingest wizard, `wizSource`)
- `apps/fiab-console/lib/components/admin/copilot-agents-config.tsx`, `lib/components/workspace-settings-drawer.tsx`
- `apps/fiab-console/app/api/foundry/accounts/` (pattern for the new route), `app/api/admin/workspaces/[id]/git/route.ts`
- `docs/fiab/ux-standards.md` section 7, `.claude/rules/auto-bind-by-default.md`

## Owns
- `scripts/ci/check-no-freeform.mjs`
- `scripts/ci/no-freeform-inputs-baseline.json`
- `scripts/ci/__tests__/no-freeform.test.mjs`
- `apps/fiab-console/lib/editors/phase3/kql-database-editor.tsx`
- `apps/fiab-console/lib/components/admin/copilot-agents-config.tsx`
- `apps/fiab-console/lib/components/workspace-settings-drawer.tsx`
- `apps/fiab-console/app/api/foundry/projects/route.ts` (new)
- `apps/fiab-console/app/api/admin/workspaces/[id]/git/route.ts`
- `apps/fiab-console/lib/components/__tests__/workspace-settings-git-pat.test.tsx` (new)
- `apps/fiab-console/lib/components/admin/__tests__/copilot-agents-config.test.tsx` (new)
- `apps/fiab-console/app/api/foundry/projects/__tests__/route.test.ts` (new)

## Must NOT touch
- `apps/fiab-console/lib/editors/lakehouse/dialogs/shortcut-wizard-dialog.tsx`, `lib/components/onelake/shortcut-wizard.tsx`, `unified-sql-database-editor.tsx`, `lib/editors/components/mirror-source-wizard.tsx` (ib-04)
- `lib/components/azure/keyvault-secret-picker.tsx` and `azure-backed-field.tsx` (shared; widening a callback there is its own PR, per the note in `check-no-freeform.mjs`; if #4816 needs it, stop and ask)
- `apps/fiab-console/lib/gates/registry/**` (hot; one owner per wave). If a gate must be registered, record it as an integration step for the registry's owning PRP.

## Consumes
- `KeyVaultSecretPicker`, `/api/keyvault/secret-names`, `/api/adx/tables`, existing git routes. Cross-program order: if any LHDS or apigw PR also edits `no-freeform-inputs-baseline.json`, whoever merges second re-measures with `--report`.

## Provides
- A lower free-text baseline and three fewer `TOUCH_EXEMPT` entries, which `ib-04-no-freeform-pickers-b` builds on.

## Steps
1. `node scripts/ci/check-no-freeform.mjs --report > temp/ff-before.txt` (record before-state).
2. #4389 (smallest): swap the Input for the Combobox pattern; a vitest render spec.
3. #4444: derived-endpoint read-only with Override; add the `app/api/foundry/projects` list route (session check, structured `{ok,data,error}` JSON, real ARM call, honest MessageBar with Fix-it when no account); Fabric picker degrading cleanly.
4. #4816: Power BI workspace picker with a guided state (never a free GUID box); PAT becomes a secret reference; extend the git route to take `patSecretRef` while still handling the legacy body.
5. Delete the three `TOUCH_EXEMPT` entries, run the ratchet so the baseline lowers, re-run `--report` and diff against step 1.

## Validation
- `node scripts/ci/check-no-freeform.mjs` (exit 0) and `node --test scripts/ci/__tests__/no-freeform.test.mjs`
- `pnpm --dir apps/fiab-console vitest run lib/components lib/editors/phase3 app/api/foundry/projects`
- `make validate-typescript`
- Live: `pnpm --dir apps/fiab-console uat` walk of the three surfaces; screenshot dark and light.
- Merged is not done: report "merged, not deployed" until the console is rolled and the walk is repeated on the live estate. Receipts: Commercial live; GCC-High via Actions; GCC not exercised.

## Rollback
Revert the PR; the baseline and `TOUCH_EXEMPT` entries return with it. The git route keeps accepting the legacy PAT body, so no stored binding breaks.

## Docs to update
`docs/fiab/ux-standards.md` only if a new picker pattern is introduced; the parity doc for the workspace settings drawer if one exists under `docs/fiab/parity/`.

## Wave / Blocked-by / Branch / Worktree
Wave: 1 (batch lane) · Blocked-by: none · Branch: fix/ib-03-no-freeform-pickers-a · Worktree: E:/Repos/_ib-03

## Hot files
`scripts/ci/check-no-freeform.mjs` and `no-freeform-inputs-baseline.json` (serial with ib-04). `touches_bicep: no` (no new env vars planned; if the Foundry route needs one, add it as a separate bicep-queue PR: Bicep queue: see PRPs/reference/GLOBAL-SCHEDULE.md).

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| #4389 | todo | | sonnet | | |
| #4444 | todo | | sonnet | | |
| #4816 | todo | | sonnet | | |

Deferred candidates: #3511, #3526, #3540, #3541, #3543, #3742, #4201, #4740 (code on main appears to implement each: `mirrored-database.ts` auto-discovery comment, `AzureBackedField kind="eventgrid-topic-endpoint"` and `databricks-access-connector`, Dropdown/Combobox for Model deployment, #4915 "already fixed" for #4740; they need a live in-browser receipt and operator closure, no code PR, and Service Bus and managed-identity-id halves of #3526/#3540 were not checked); #4854, #3626, #4039 are in `ib-04-no-freeform-pickers-b`.

## Kickoff prompt
Read PRPs/backlog/issue-batches/ib-03-no-freeform-pickers-a.md, scripts/ci/check-no-freeform.mjs (TOUCH_EXEMPT) and .claude/rules/auto-bind-by-default.md. Worktree E:/Repos/_ib-03, branch fix/ib-03-no-freeform-pickers-a. Save `node scripts/ci/check-no-freeform.mjs --report` to temp/ first. Do #4389, then #4444, then #4816; each must delete its TOUCH_EXEMPT entry and lower the baseline. Never edit keyvault-secret-picker.tsx or the gate registry; ask if you need to. Proof of done: check-no-freeform.mjs exits 0, the vitest command in section 11 is green, and a live browser walk per surface is attached. Open the PR with review required.
