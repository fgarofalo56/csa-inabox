---
name: ib-12-lakehouse-routes
status: backlog
priority: P2
order: 112
depends_on: []
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
issues: [4620, 4862, 5079]
branch: fix/ib-12-lakehouse-routes
---

# PRP: ib-12 Lakehouse Files affordance and route-toolkit migration of baselined setup and landing-zone routes

## Goal
Three open console issues with non-sensitive scope: the lakehouse Files browser offers New folder and Delete on a container the open item is not bound to (#4620); the two landing-zone attach routes are not on the route-toolkit wrappers (#4862); and thirteen baselined route files still use the hand-rolled session prologue and uncounted ARM fetches (#5079). Done is: the controls are not offered where the server would refuse them, the 15 route files are on the toolkit with their authorization behaviour byte-compatible, and the ratchet baselines only shrink.

## Why
- #4620: `apps/fiab-console/lib/editors/lakehouse/lakehouse-editor-shell.tsx` (`onNewFolder` near line 553, `onDelete` near line 571, the container picker) offers the actions and the server answers 403. The file is 1170 lines against a ratchet-frozen cap of 1200 in `scripts/ci/check-file-size.mjs:193`, so the change must stay within 30 added lines or move the handlers into a sibling file.
- #4862: `app/api/landing-zones/[id]/attach/route.ts` and `.../attach/preflight/route.ts` are in `TOUCH_EXEMPT` in `scripts/ci/check-route-toolkit.mjs` because the codemod skips a `getSession()` prologue followed by `enforceCapability(session, 'admin.attach-service', 'Admin')` and `pdpCheck(...)`. `withCapability` already exists (`apps/fiab-console/lib/api/route-toolkit.ts`, line near 254), so no new wrapper is needed.
- #5079: PR #5074 routed ARM GETs through `armCountedRawFetch` / `armCountedFetch`; thirteen baselined routes were left uncounted and allowlisted in `scripts/ci/arm-counted-fetch-allowlist.json`. The guard fails on a stale entry, so each entry is deleted as its route is migrated.

## Scope / Non-goals
In scope: the three issues. For #4862 and #5079 the migration is mechanical: authorization behaviour and response envelopes stay identical.
Non-goals and exclusions:
- Excluded: handled privately: #3400, #3794, #4407, #4619, #4808, #4814, #4818, #4821, #4850, #4899. No detail about them appears in this PRP, and no file they would need is owned here.
- Deferred: #4857 (the refusal wording names a control that does not exist; the fix needs a choice between self-healing the binding on open and adding a repair control, and it edits shared lakehouse helper files).
- No change to any lakehouse storage-root resolution, container allow-list, query classifier or permission listing.
Cloud scope: console code only, identical in every boundary. Commercial receipt from a console roll plus the G1 browser walk; Gov inherits on its next roll (supported-in-code; GCC never exercised). The G1 walk is not done on Gov.

> ASSUMPTION: for #4620 the first option in the issue (disable or hide New folder and Delete, with a tooltip saying why, while the browsed container is not the one the open item resolves to) is chosen; the read-only cross-container mode is a larger change and is not built here.

> ASSUMPTION: a route whose prologue the codemod cannot transform, or whose migration would change who is allowed through, stays in `TOUCH_EXEMPT` with a one-line reason and is listed in the PR as not migrated, rather than being reshaped by hand. The baseline is never raised.

## Acceptance criteria
- [ ] #4620: with the Files browser on a container other than the item's own resolved container, New folder and Delete are disabled (or absent) and carry a tooltip stating the reason; on the item's own container they are enabled. A control that stays enabled on the other container fails this item. The 403 path is unchanged and still covered by its existing test. `scripts/ci/check-file-size.mjs` stays green (a file above 1200 lines fails it). A new vitest spec under `apps/fiab-console/lib/editors/lakehouse/__tests__/` asserts both states by label.
- [ ] #4862: both attach routes call through `withCapability` (or a documented hand-written equivalent), both are removed from `TOUCH_EXEMPT` in `scripts/ci/check-route-toolkit.mjs`, and a caller without `admin.attach-service` still receives the same status code and envelope as before (existing tests, plus one new assertion per route comparing the refusal body). A migration that returns a different status for an unauthenticated caller fails.
- [ ] #5079: for each of the thirteen routes (`admin/azure-resources`, `admin/security/purview/discover`, `azure/function-apps`, `azure/iothub/policies`, `landing-zones/discover`, `setup/config`, `setup/existing-aoai`, `setup/existing-storage`, `setup/landing-zones`, `setup/quota-preflight`, `setup/regions`, `setup/scan-purview`, `setup/scan`) the route is on the toolkit, its ARM GETs go through `armCountedRawFetch` or `armCountedFetch`, and its entry is gone from `scripts/ci/arm-counted-fetch-allowlist.json`. `node scripts/ci/check-arm-counted-fetch.mjs` fails if an entry remains for a migrated route (stale entry) or a route still holds a raw fetch without one.
- [ ] No ratchet rises: `git diff scripts/ci/route-toolkit-baseline.json scripts/ci/arm-counted-fetch-allowlist.json` shows only deletions; a baseline count above the base ref fails.
- [ ] No-auth-change receipt: for every migrated route the PR table lists the wrapper chosen and shows the unauthenticated, wrong-role and allowed status codes before and after, from the route's vitest spec. A route lacking a spec gets one for the refusal case.

## Read first
- `apps/fiab-console/lib/api/route-toolkit.ts` (`withSession`, `withTenantAdmin`, `withCapability`), `apps/fiab-console/lib/api/__tests__/route-toolkit.test.ts`
- `scripts/codemods/migrate-route-toolkit.mjs`, `scripts/ci/check-route-toolkit.mjs` (`TOUCH_EXEMPT`, `--update-baseline`), `scripts/ci/check-arm-counted-fetch.mjs`, `apps/fiab-console/lib/azure/arm-counted-fetch.ts`, `apps/fiab-console/lib/util/arm-counted-raw-fetch.ts`
- `apps/fiab-console/app/api/landing-zones/[id]/attach/route.ts` and `.../attach/preflight/route.ts`
- `apps/fiab-console/lib/editors/lakehouse/lakehouse-editor-shell.tsx` (`onNewFolder`, `onDelete`, container picker), `apps/fiab-console/lib/azure/lakehouse-abfss.ts` (`resolveLakehouseAbfss`, read only)
- `.claude/rules/ux-baseline.md` (G1), `.claude/rules/deploy-integrity.md`

## Owns
- `apps/fiab-console/lib/editors/lakehouse/lakehouse-editor-shell.tsx`
- `apps/fiab-console/lib/editors/lakehouse/__tests__/files-container-affordance.test.tsx` (new)
- `apps/fiab-console/app/api/landing-zones/[id]/attach/route.ts`
- `apps/fiab-console/app/api/landing-zones/[id]/attach/preflight/route.ts`
- `apps/fiab-console/app/api/landing-zones/discover/route.ts`
- `apps/fiab-console/app/api/admin/azure-resources/route.ts`
- `apps/fiab-console/app/api/admin/security/purview/discover/route.ts`
- `apps/fiab-console/app/api/azure/function-apps/route.ts`
- `apps/fiab-console/app/api/azure/iothub/policies/route.ts`
- `apps/fiab-console/app/api/setup/config/route.ts`
- `apps/fiab-console/app/api/setup/existing-aoai/route.ts`
- `apps/fiab-console/app/api/setup/existing-storage/route.ts`
- `apps/fiab-console/app/api/setup/landing-zones/route.ts`
- `apps/fiab-console/app/api/setup/quota-preflight/route.ts`
- `apps/fiab-console/app/api/setup/regions/route.ts`
- `apps/fiab-console/app/api/setup/scan-purview/route.ts`
- `apps/fiab-console/app/api/setup/scan/route.ts`
- `scripts/ci/check-route-toolkit.mjs` (only `TOUCH_EXEMPT` entries for the two attach routes)
- `scripts/ci/route-toolkit-baseline.json` (deletions only)
- `scripts/ci/arm-counted-fetch-allowlist.json` (deletions only)

## Must NOT touch
- `apps/fiab-console/app/api/lakehouse/**`, `apps/fiab-console/app/api/onelake/**`, `apps/fiab-console/app/api/items/lakehouse/**`, `apps/fiab-console/lib/azure/lakehouse-abfss.ts`, `apps/fiab-console/lib/azure/adls-client.ts` (storage-root and container resolution stay as they are)
- `apps/fiab-console/lib/api/route-toolkit.ts` (no new wrapper)
- `apps/fiab-console/lib/editors/lakehouse/dialogs/shortcut-wizard-dialog.tsx` and `apps/fiab-console/app/api/lakehouse/shortcuts/credentials/route.ts` (`ib-04-no-freeform-pickers-b`)
- `scripts/ci/check-no-freeform.mjs`, `scripts/ci/no-freeform-inputs-baseline.json` (ib-03 / ib-04), `scripts/ci/check-route-guards.mjs` (ib-03 / ib-04)
- `scripts/ci/check-file-size.mjs` (the cap is not raised)

## Consumes
Nothing from other PRPs. `ib-03` and `ib-04` edit other files in `apps/fiab-console/lib/editors/lakehouse/`; this PRP edits only `lakehouse-editor-shell.tsx` there.

## Provides
Fifteen route files on the toolkit with counted ARM reads, shrunk ratchets, and an affordance that matches what the server allows.

## Steps
1. Worktree `E:/Repos/_ib-12`. Read the base counts: `node scripts/ci/check-route-toolkit.mjs` and `node scripts/ci/check-arm-counted-fetch.mjs`.
2. #4620: write the vitest spec first (both container states), then the smallest edit in the shell or an extracted helper; re-check the line cap.
3. #5079: run the codemod per route (`node scripts/codemods/migrate-route-toolkit.mjs --apply --family=<area>` per the guard header), then switch each ARM fetch, delete its allowlist entry, run both guards after each route. Record routes the codemod skipped.
4. #4862: hand-migrate the two attach routes onto `withCapability`; remove the two `TOUCH_EXEMPT` entries.
5. Regenerate the baseline with `node scripts/ci/check-route-toolkit.mjs --update-baseline` and confirm the diff is deletions only.
6. G1: after merge and roll, the browser walk (below) is owed; do not mark #4620 done on the PR alone.

## Validation
- `pnpm --dir apps/fiab-console vitest run lib/editors/lakehouse lib/api app/api/setup app/api/landing-zones app/api/azure app/api/admin` (read the executed count)
- `node scripts/ci/check-route-toolkit.mjs`, `node scripts/ci/check-arm-counted-fetch.mjs`, `node scripts/ci/check-file-size.mjs` (all rc 0)
- `make validate-typescript` (tsc only; it is not vitest or eslint)
- Merged is not done: "merged, not deployed" until the console is rolled. The #4620 receipt is a live browser walk per ux-baseline G1: open a lakehouse, switch the Files browser to a container the item is not bound to, screenshot New folder and Delete disabled with the tooltip, then switch back and show them enabled (dark and light). Narrow-width pass for the toolbar. #4862 and #5079 receipts: the attach preflight and one setup route return the same status as before when called as an unauthenticated user and as an allowed admin, read from the estate.
- Clouds: Commercial walk only; Gov unwalked and named as such.

## Rollback
Revert the PR. Baselines return to their old counts; the toolbar returns to always-enabled. No data is touched.

## Docs to update
`docs/fiab/route-inventory.md` is generated by `scripts/ci/generate-route-inventory.mjs`; regenerate it if the guard demands (check `git diff` after running the generator). No parity doc change (no new surface).

## Wave / Blocked-by / Branch / Worktree
Wave: 1 (batch lane) · Blocked-by: none · Branch: fix/ib-12-lakehouse-routes · Worktree: E:/Repos/_ib-12

## Hot files
None of the registry hot files. `touches_bicep: no`. `lakehouse-editor-shell.tsx` is frozen at a 1200-line cap.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| #4620 | todo | | sonnet | | |
| #4862 | todo | | sonnet | | |
| #5079 | todo | | sonnet | | |

Deferred candidates: #4857. Excluded: handled privately: #3400 #3794 #4407 #4619 #4808 #4814 #4818 #4821 #4850 #4899.

## Kickoff prompt
Read PRPs/backlog/issue-batches/ib-12-lakehouse-routes.md, .claude/rules/ux-baseline.md and .claude/rules/deploy-integrity.md. Work in a fresh worktree E:/Repos/_ib-12 on branch fix/ib-12-lakehouse-routes. Do #4620 (spec first, stay under the 1200-line cap), then #4862, then #5079 route by route, running check-route-toolkit.mjs and check-arm-counted-fetch.mjs after each. Authorization behaviour and response envelopes must not change; if the codemod cannot do a route safely, leave it exempt with a reason. Do not touch app/api/lakehouse, app/api/onelake, lib/azure/lakehouse-abfss.ts or any file outside the Owns list. Proof of done: the vitest and guard commands in the Validation section, baselines with deletions only, and after a roll the G1 browser walk. One reviewer pass; do not close issues.
