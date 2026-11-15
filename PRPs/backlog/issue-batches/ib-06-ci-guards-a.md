---
name: ib-06-ci-guards-a
status: backlog
priority: P2
order: 106
depends_on: []
review: none
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
issues: [4614, 4624, 4580, 4581, 4359, 4358]
branch: fix/ib-06-ci-guards-a
---

# PRP: ib-06 CI and hook guard strength (batch A)

## Goal
Strengthen four guards that currently report green over inputs they should fail on, in four file-disjoint groups: the Cargo Dependabot coverage guard (#4614, #4624), the measurement-guard hook's `rc-after-pipe` rule (#4580, #4581), the honest-gate coverage ratchet (#4359), and a stale-figures docblock in the tid-boundary guard (#4358).

## Why
Each issue is the repo's dominant defect class: a control that watches nothing. Measured in the issue bodies and confirmed present on main: `check-cargo-dependabot-coverage.mjs:166` still has `if (rel !== '') found.push(rel);` (a root `Cargo.toml` can never be known, so a correct `directory: "/"` entry is flagged as a ghost with a false message); `check-honest-gate-coverage.mjs` ends `scanSource` with `bareGates: honestGate > 0 ? [] : bareGates` (one `<HonestGate>` masks a whole file); `measurement-guard.mjs` rule `rc-after-pipe` is keyed to a bare `\w+=\$\?` after quote-masking. `assertion-design.md` applies throughout: every fix names the input that turns its test red.

Group choice: the four groups share no file, so they cannot conflict with each other. Deferred candidates are listed at the end with reasons.

## Scope / Non-goals
In scope: the six issues. Non-goals: promoting `node:test suites (node 20)` to a required context (branch protection, operator-held; this PRP only states in the guard header that it is advisory, which is the issue's alternative); #4597's nine-guard comment-scanner conversion, #4108's class-level redesign, #4101's route guard idiom (touches an authorization route and `check-route-guards.mjs`; needs `review: required`), #4282 (required lane, overlaps the security-graph artifact owned by `ib-02-brain-detectors-b`).
Cloud scope: repo tooling only, cloud-neutral; no boundary receipt applies.

## Acceptance criteria
- [ ] #4614: `normaliseDir('/')` root handling is decided and pinned both ways. With a fixture workspace `Cargo.toml` at the repo root and Dependabot entry `directory: "/"`, the guard reports clean; with the root manifest absent and the entry present it reports a ghost whose message is true. Fails if dropping the `rel !== ''` condition (or inverting it) leaves the suite green (the issue measured 29 tests, 0 killers). Rule 1's workspace-shape assumption is resolved or disclosed in the header.
- [ ] #4624: three separate tests. (1) a double-quoted scalar with an escaped quote followed by a tab, accepted by PyYAML 6.0.2, is `clean`; removing the escape branch at `structuralRegion` (`:234` at the issue's head) turns it RED (it over-fires `FLAGGED`). (2) the literal-BOM fixture is built from `\uFEFF` in code, not a literal BOM byte in source. (3) the `#`-in-key limitation is either handled or disclosed in the guard header with a failing-input example. Do not collapse them into one fix.
- [ ] #4580: `node scripts/measure/measurement-guard.test.mjs` includes a case where `node x.mjs | tail -5; echo "rc=$?"` is denied by `rc-after-pipe`. Fails if that command is allowed. The survey states a measured count per shape (`printf 'rc=%s\n' "$?"`, `MSG="failed rc=$?"`, `[ "$?" -ne 0 ]`, heredoc), not just the reported one, and the existing jq false-positive case (`--jq '.x[] | select(...)'`) stays allowed.
- [ ] #4581: under `set -o pipefail` earlier in the same script, `R=$(az ... | tr -d '\r')` followed by `RC=$?` is allowed; without pipefail it stays denied. Fails if the pipefail case is denied, or if the no-pipefail case is allowed. The three sweep hits named in the issue (`deploy-fiab-commercial.yml:1753`, the `deploy-fiab-il5.yml` twin, `scripts/ci/check-vanity-edge-health.sh:136`) are re-classified with a stated reason each.
- [ ] #4359: a file with one `<HonestGate gateId=...>` and two other bare G2 bars reports the two bare bars; `check-honest-gate-coverage.mjs --selftest` gains a case that goes RED against the old short-circuit. Fails if `foundry-sub-editors.tsx` (3676 lines, eight editors) still reports an empty bare list. The baseline JSON is updated for the newly unmasked count, and the PR body names each added entry (the ratchet working, not a regression).
- [ ] #4358: the `check-tid-boundary-chokepoint.mjs` population paragraph either carries the sha it was measured at or is re-run (the issue measured `files=6138 annotated=8497 unannotated=3202 total=11699`); the header states the node:test context is advisory. Fails if a figure remains stated as "measured" with no sha or date and no re-run.

## Read first
- `scripts/ci/check-cargo-dependabot-coverage.mjs` (`findCargoManifestDirs`, `normaliseDir`, `structuralRegion`), `scripts/ci/__tests__/cargo-dependabot-coverage.test.mjs`
- `.claude/hooks/measurement-guard.mjs` (rule `rc-after-pipe`, `maskQuoted`), `scripts/measure/measurement-guard.test.mjs` (note: tests live under `scripts/measure/` on purpose, see its header)
- `scripts/ci/check-honest-gate-coverage.mjs` (`scanSource`, `compare`, `--selftest`), `scripts/ci/honest-gate-coverage.baseline.json`
- `scripts/ci/check-tid-boundary-chokepoint.mjs`, `scripts/ci/check-tid-boundary-chokepoint.selftest.mjs`
- `.claude/rules/assertion-design.md`, `.claude/rules/deploy-integrity.md` (R7)

## Owns
- `scripts/ci/check-cargo-dependabot-coverage.mjs`
- `scripts/ci/__tests__/cargo-dependabot-coverage.test.mjs`
- `.claude/hooks/measurement-guard.mjs`
- `scripts/measure/measurement-guard.test.mjs`
- `scripts/ci/check-honest-gate-coverage.mjs`
- `scripts/ci/honest-gate-coverage.baseline.json`
- `scripts/ci/check-tid-boundary-chokepoint.mjs`
- `.claude/hooks/README.md`

## Must NOT touch
- `.github/workflows/**` (incl. `loom-guardrails.yml` and `fiab-console-ci.yml`; any workflow edit is an integration step for whichever PRP owns that workflow)
- `scripts/ci/check-route-guards.mjs`, `scripts/ci/check-no-freeform.mjs`, `scripts/ci/no-freeform-inputs-baseline.json` (ib-03 and ib-04)
- `apps/fiab-console/lib/editors/foundry-sub-editors.tsx` (read-only here; a baseline entry may rise but the file is not edited)
- `.claude/settings.json`

## Consumes
- Nothing from other PRPs. If the unmasked honest-gate count for another editor changes because a different PRP edits it, re-measure with `node scripts/ci/check-honest-gate-coverage.mjs` before committing the baseline.

## Provides
- Guards whose tests each name a failing input; a documented pipefail rule for `measurement-guard`.

## Steps
1. For each group, write the failing test first, run it on the current code to prove RED, then fix.
2. Each mutation arm runs on a sandbox copy (copy the file under `temp/`, mutate there); prove the tracked tree untouched with `git status --porcelain` and `git hash-object` before and after.
3. #4614 then #4624 (same file, serial). #4580 then #4581 (same file, serial; design the pipefail detection first because it interacts with the quote-masking fix).
4. #4359: change `scanSource` to return per-gate masking scoped by gate id where the source allows it, or report all bare bars and let the baseline absorb them; state which in the PR.
5. #4358: re-run the named population script and replace the figures with a sha-qualified line.

## Validation
- `node --test scripts/ci/__tests__/cargo-dependabot-coverage.test.mjs`
- `node scripts/ci/check-cargo-dependabot-coverage.mjs`
- `node --test scripts/measure/measurement-guard.test.mjs`
- `node scripts/ci/check-honest-gate-coverage.mjs --selftest` and `node scripts/ci/check-honest-gate-coverage.mjs`
- `node scripts/ci/check-tid-boundary-chokepoint.mjs` and `node scripts/ci/check-tid-boundary-chokepoint.selftest.mjs`
- `node scripts/ci/check-node-test-suites.mjs` (every new test file is discovered; a file under `.claude/` would not be)
- Merged is not done: tooling only, so "done" is the guard going RED on its named input in CI on the merge commit; no estate deploy is involved. State that the `measurement-guard` hook takes effect for local sessions only after the repo sync.

## Rollback
Revert the PR. For #4359, also revert the baseline JSON in the same commit so the ratchet is consistent.

## Docs to update
`.claude/hooks/README.md` for the pipefail rule (#4581).

## Wave / Blocked-by / Branch / Worktree
Wave: 1 (batch lane) · Blocked-by: none · Branch: fix/ib-06-ci-guards-a · Worktree: E:/Repos/_ib-06

## Hot files
None of the registry hot files. `touches_bicep: no`.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| #4614 | todo | | sonnet | | |
| #4624 | todo | | sonnet | | |
| #4580 | todo | | sonnet | | |
| #4581 | todo | | sonnet | | |
| #4359 | todo | | sonnet | | |
| #4358 | todo | | sonnet | | |

Deferred candidates: #4101 (authorization-scope idiom; touches `app/api/items/mirrored-database/route.ts` and `check-route-guards.mjs`, security path, needs `review: required`), #4108 (class-level "assert the outcome" redesign across four PRs, not a bounded change), #4282 (required lane vs the security-graph artifact; coupled to `ib-02-brain-detectors-b` and deferred #4557), #4597 (nine guards plus six `blankComments` copies, too large and needs a scanner design decision).

## Kickoff prompt
Read PRPs/backlog/issue-batches/ib-06-ci-guards-a.md and .claude/rules/assertion-design.md. Worktree E:/Repos/_ib-06, branch fix/ib-06-ci-guards-a. For every issue write the failing test first and prove RED on the current code, then fix and prove green; run mutation arms only on a sandbox copy under temp/. Do not edit any workflow or settings file. Proof of done: the validation commands in section 11 all exit 0, and the PR body lists, per issue, the input that turns the test red.
