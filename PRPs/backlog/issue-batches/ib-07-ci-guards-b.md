---
name: ib-07-ci-guards-b
status: backlog
priority: P2
order: 107
depends_on: []
review: none
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
issues: [4800, 4836, 4928, 4802, 3961]
branch: fix/ib-07-ci-guards-b
---

# PRP: ib-07 CI guard strength, batch B (empty-claim guard, bootstrap pin guard, notifier ratchet)

## Goal
Close five open guard-strength issues in three guard families: the `check-empty-claim-read-evidence.mjs` guard (#4800, #4836, #4928), the `PROFILE_PINS` rule in `check-bootstrap-rg-subscription-scope.mjs` (#4802), and the Gov notifier ratchet tests (#3961, items 3 and 4 only). Done is a mutation run on a sandbox copy that goes RED per issue, with the baseline not rising.

## Why
Each issue describes an input the guard accepts that it should refuse. Read from the issue bodies and checked against main (`ea1a38d72` lineage, 2026-11-14): the guards exist, run clean (`node scripts/ci/check-empty-claim-read-evidence.mjs` rc 0; `node scripts/ci/check-bootstrap-rg-subscription-scope.mjs` rc 0; 191 of 191 node tests pass across the four test files owned here), so every gap below is a blind spot, not a failing check. The issues were grouped by title earlier; the grouping here is by the files the fixes actually touch.

## Scope / Non-goals
In scope:
- #4800: fix the early-return polarity read for `if (COND) return <EmptyState/>`, and give the three named claims real read evidence in `agent-quality-panel.tsx` (two claims) and `data-product-detail.tsx` (one claim) without raising the baseline.
- #4836: replace the cache-writer refuse-list in rule E6 with the positive rule from the issue (one `@tanstack/react-query` import, names only from `{useQuery, useMutation, useQueryClient}`, no `as` aliases; every `useQueryClient()` binding used only as `X.invalidateQueries(`).
- #4928: recognise the `if (!enabled) return <EmptyState/>` feature-gate shape (condition is the negation of the same component's own `enabled:` value) and stop demanding read-success evidence for it; shrink the two baseline entries to their true counts.
- #4802: widen the `set +e` suppression match in the `PROFILE_PINS` rule to cover `set +o errexit` and combined flags such as `set +eu`; detect or document the dead-branch pin (`if false; then ... fi`).
- #3961 items 3 and 4 only: make `gov-deploy-lanes.test.mjs` and `deploy-notify-failure.test.mjs` agree on one `--result` ratchet, and exercise `namedSteps` against a 4-space `steps:` list.
Non-goals: #3961 item 1 (a notifier chokepoint is a design change) and item 2 (needs a repo-secrets read CI does not have); `check-tid-boundary-chokepoint.mjs` (owned by `ib-06-ci-guards-a`); any `*.bicep`.
Cloud scope: CI scripts and two console components. No Commercial / GCC-High / IL5 behaviour differs; no boundary receipt applies. GCC is supported-in-code, never exercised, and nothing here changes that.

> ASSUMPTION: #3961 items 3 and 4 are the in-scope remainder; the issue labels item 3 "a routing request, not a defect" and the operator has not chosen which of the two test files is canonical. Default chosen here: consolidate into `.github/scripts/__tests__/deploy-notify-failure.test.mjs` (the round-1 reviewer preference).

## Acceptance criteria
Each names the input that turns it red.
- [ ] #4800 polarity: a new fixture in `scripts/ci/__tests__/_empty-claim-e6-acceptance.mjs` of shape `if (q.isError) return <EmptyState/>` with the claim on the errored side must read UNGUARDED; a guard that still marks it SAFE fails this item. The baseline entry counts for `agent-quality-panel.tsx` and `data-product-detail.tsx` in `scripts/ci/empty-claim-read-evidence-baseline.json` must not increase; an increase (the "move the three to the baseline, +3" outcome) fails it.
- [ ] #4800 sites: the three claims (the two in `agent-quality-panel.tsx`, the one in `data-product-detail.tsx`) render the empty state only when the feeding query is not errored; reverting one of the three component edits turns the guard's count for that file up by one.
- [ ] #4836: three fixtures must read UNGUARDED: `qc.setQueryDefaults(['p'], { initialData })`, an aliased `useQuery as useLite` on the same key, and a file containing `HydrationBoundary`; the six currently-SAFE real claims stay SAFE. A fixture that reads SAFE fails this item.
- [ ] #4928: both `sql-lab-editor.tsx` (`#unguarded: 1`) and `ducklake-catalog-editor.tsx` (`#unguarded: 3`) entries in the baseline shrink to their re-measured true counts; if a count does not move, the PR records why. A fixture with `queryFn` calling a reading helper inline plus `if (!enabled) return <EmptyState/>` must be skipped as a gate; the same fixture with a condition that is NOT the negation of `enabled` must stay judged (a guard that skips both fails).
- [ ] #4802: `set +o errexit` and `set +eu` placed before the `provision-scc-labels-sidecar.sh` pin each make `check-bootstrap-rg-subscription-scope.mjs` exit non-zero; they are added to the rule's must-flag embedded controls (the run prints a higher "profile-pin embedded control fixture(s)" count than today's 9). A pin inside `if false; then ... fi` is either flagged or disclosed in the guard header as a named known limit.
- [ ] #3961: `--result` presence is asserted in exactly one test file; deleting the assertion from that file turns the suite RED while the other file no longer duplicates it. A workflow fixture using a 4-space `steps:` indent makes `namedSteps` fail its per-file floor (RED), not return zero silently.
- [ ] No baseline file rises: `git diff` on `empty-claim-read-evidence-baseline.json` shows only decreases.

## Read first
- `scripts/ci/check-empty-claim-read-evidence.mjs` (symbols: the early-return walker, `hasRead`, rule E6, `callsHelper`/`readingHelpers`); `scripts/ci/__tests__/_empty-claim-e6-acceptance.mjs`; `scripts/ci/__tests__/empty-claim-read-evidence.test.mjs`
- `scripts/ci/check-bootstrap-rg-subscription-scope.mjs` (`PROFILE_PINS`, the `set +e` suppression match); `scripts/ci/__tests__/bootstrap-rg-subscription-scope.test.mjs`
- `.github/scripts/__tests__/gov-deploy-lanes.test.mjs` (`notifierCallSites`, `namedSteps`), `.github/scripts/__tests__/deploy-notify-failure.test.mjs`
- `apps/fiab-console/lib/components/admin/agent-quality-panel.tsx`, `apps/fiab-console/lib/editors/data-product-detail.tsx` (locate with `git grep -n EmptyState`)
- `.claude/rules/assertion-design.md`, `.claude/rules/ux-baseline.md` (G1 for the two components)

## Owns
- `scripts/ci/check-empty-claim-read-evidence.mjs`
- `scripts/ci/__tests__/_empty-claim-e6-acceptance.mjs`
- `scripts/ci/__tests__/empty-claim-read-evidence.test.mjs`
- `scripts/ci/empty-claim-read-evidence-baseline.json`
- `apps/fiab-console/lib/components/admin/agent-quality-panel.tsx`
- `apps/fiab-console/lib/editors/data-product-detail.tsx`
- `scripts/ci/check-bootstrap-rg-subscription-scope.mjs`
- `scripts/ci/__tests__/bootstrap-rg-subscription-scope.test.mjs`
- `.github/scripts/__tests__/gov-deploy-lanes.test.mjs`
- `.github/scripts/__tests__/deploy-notify-failure.test.mjs`

## Must NOT touch
- `scripts/ci/check-tid-boundary-chokepoint.mjs` and its selftest (owned by `ib-06-ci-guards-a`)
- `apps/fiab-console/lib/editors/sql-lab-editor.tsx`, `apps/fiab-console/lib/editors/ducklake-catalog-editor.tsx` (the guard change should clear their claims; if it cannot, stop and report)
- `.github/scripts/deploy-notify-failure.mjs` and every workflow file (item 1 of #3961 is out of scope)
- `scripts/ci/no-freeform-inputs-baseline.json`, `scripts/ci/check-no-freeform.mjs` (ib-03 / ib-04)

## Consumes
- The existing baseline policy: delete a baseline entry when its last claim is fixed.

## Provides
- A stricter empty-claim guard, a stricter bootstrap pin rule, one consolidated notifier `--result` ratchet.

## Steps
1. Make a sandbox copy for mutation runs (worktree `E:/Repos/_ib-07`, then a scratch copy under `temp/`). Never mutate the tracked tree and revert; prove it untouched with `git status --porcelain`.
2. #4802 first (smallest, one regex): widen the match, add the two forms to the must-flag controls, decide detect-or-document for the dead branch.
3. #4800, #4836, #4928 in that order against `check-empty-claim-read-evidence.mjs`: polarity fix, then the positive E6 rule, then the `enabled`-gate recognition. Add each fixture before the guard change and watch it fail on the old guard.
4. Edit the two console components for #4800 only after the guard fix, then re-run the guard to confirm the unguarded count did not rise.
5. Re-measure baseline counts and write only decreases.
6. #3961: consolidate the `--result` ratchet, add the 4-space `steps:` fixture.
7. Record per issue: the mutation, RC before and after.

## Validation
- `node --test scripts/ci/__tests__/empty-claim-read-evidence.test.mjs scripts/ci/__tests__/bootstrap-rg-subscription-scope.test.mjs .github/scripts/__tests__/gov-deploy-lanes.test.mjs .github/scripts/__tests__/deploy-notify-failure.test.mjs` (today 191 pass, 0 fail; read the executed count, it must rise, not stay at 191)
- `node scripts/ci/check-empty-claim-read-evidence.mjs` and `node scripts/ci/check-bootstrap-rg-subscription-scope.mjs` (both rc 0 on the final tree)
- `pnpm --dir apps/fiab-console vitest run lib/components/admin lib/editors` for the two touched components
- The repo-wide gate is `make validate` and runs in CI.
- Merged is not done: the two component edits are "merged, not deployed" until the console is rolled; G1 browser receipt (open the agent-quality panel and the data product detail page with the read forced to fail, show no empty-state claim) is owed after the roll. Guard-only changes need no roll.
- Clouds: none differ; Commercial receipt only for the two components, Gov inherits on its next roll.

## Rollback
Revert the PR. Guard changes are additive; the component edits are two small render conditions.

## Docs to update
The guard headers in `check-empty-claim-read-evidence.mjs` and `check-bootstrap-rg-subscription-scope.mjs` (named known limits), nothing under `docs/`.

## Wave / Blocked-by / Branch / Worktree
Wave: 1 (batch lane) · Blocked-by: none · Branch: fix/ib-07-ci-guards-b · Worktree: E:/Repos/_ib-07

## Hot files
None of the registry hot files. `touches_bicep: no`.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| #4802 | todo | | sonnet | | |
| #4800 | todo | | sonnet | | |
| #4836 | todo | | sonnet | | |
| #4928 | todo | | sonnet | | |
| #3961 | todo | | sonnet | | |

Deferred candidates: #4856 (`check-tid-boundary-chokepoint.mjs` is owned by `ib-06-ci-guards-a`); #4645 (a new line-citation guard needs a design decision on which citation shapes count); #3958 (spans `check-role-assignment-determinism.mjs`, `check-route-guards.mjs` and `check-guard-logical-lines`, too large for this batch); #3954 (a console UI test file family, not a CI guard); #4825 (route-inventory generator, separate file family).

## Kickoff prompt
Read PRPs/backlog/issue-batches/ib-07-ci-guards-b.md and .claude/rules/assertion-design.md. Work in a fresh worktree E:/Repos/_ib-07 on branch fix/ib-07-ci-guards-b. For each of #4802, #4800, #4836, #4928, #3961 write the failing fixture first and run it against the unfixed guard on a sandbox copy before changing the guard. Do not touch check-tid-boundary-chokepoint.mjs or any workflow file. Baselines may only decrease. Proof of done: the node --test command in the Validation section with a higher executed count than 191, both guard scripts rc 0, and the per-issue RED/GREEN table in the PR body. Do not close issues; the operator closes after the console roll is verified.
