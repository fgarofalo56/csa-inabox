---
name: ib-08-release-eval-gate
status: backlog
priority: P2
order: 108
depends_on: []
review: none
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
issues: [3846, 3857, 4376, 4277, 4386, 4637]
branch: fix/ib-08-release-eval-gate
---

# PRP: ib-08 Eval gate honesty and changelog-guard remediation (batch)

## Goal
Make the Copilot quality-eval gate, its python regression gate and the changelog parse guard say only what they established. Six open issues: the eval floors file marks unmeasured floors `provisional: false` (#3846); the PR-attached eval check fails a diff it disclaims (#3857); the delta baseline pointer can wedge (#4376); the half-fixed baseline fetch needs its mutation arm confirmed (#4277); the python latency gate divides by a 0.0 baseline (#4386); and the dropped-commit remediation names targets that cannot exist (#4637). Done is a RED-under-mutation receipt per issue.

## Why
Measured on main while writing this PRP (2026-11-14):
- #4277: PR #4351 merged 2026-09-08. The step "Fetch the previous run artifact (delta baseline)" in `.github/workflows/copilot-quality-evals.yml` now carries a `#4277` comment and `exit 1` on an unlistable or undownloadable baseline. The issue is open, so the remaining work is to prove the mutation arm from its body goes RED and close it.
- #4376: the same step still `exit 1`s when the single newest successful `main` run has no usable artifact, so the pointer cannot advance. Not fixed.
- #3846: `content/evals/eval-floors.json` still has 10 entries with `"provisional": false`.
- #3857: the corpus-provenance step already names an `EDGE-BLOCKED` HTTP 403 case; whether the raw first 200 bytes are printed on a `jq` parse failure, and whether a PR check can still report `failure` on an unresolved provenance, is not yet confirmed.
- #4386: `apps/copilot/evals/regression.py` is the gate the issue names; the baseline `apps/copilot/evals/baselines/baseline_v0.1.0.json` carries `latency_p95: 0.0`.
- #4637: the remediation text lives in `scripts/ci/check-commit-message-parses.mjs` / its test.

## Scope / Non-goals
In scope: the six items above in the owned files below.
Non-goals: #4346 (the eval-probe answers 403; fixing it needs the console eval-probe route and the evaluator to report a corpus commit, which is an auth-adjacent route change, deferred); #4038 and #4718 (release-please drift control and type registry, both in `release-please.yml`); #3462 (needs approval of held `action_required` runs by a token the agent does not hold, operator-held); #4566 and #4569 (touch `full-app-deploy-commercial.yml` and `copilot-evaluator-client.ts`); lowering any floor, adding `continue-on-error`, or removing the check (explicitly refused in #3846).
Cloud scope: CI-only; no estate involvement and no boundary receipt. The Copilot evaluator it measures runs on Commercial; nothing here changes Gov.

> ASSUMPTION: #3846 option 2 (set `provisional: true` on `passRate` and `groundingAvg` for all ten surfaces, leave `retrievalHitRate` as measured on 2026-08-06) is the chosen disposition. Option 1 needs the #2992 predicate-mixing fix, which is not in this batch.

## Acceptance criteria
- [ ] #3846: in `content/evals/eval-floors.json` every `passRate` and `groundingAvg` entry reads `"provisional": true`; `retrievalHitRate` entries keep their current value. No numeric floor changes. A `git diff` that changes any floor number, or leaves one of the 10 `false` entries on `passRate`/`groundingAvg`, fails this item. `node scripts/csa-loom/ratchet-eval-floors.mjs` (read its usage first) still accepts the file.
- [ ] #3857: feeding the provenance step a non-JSON body (an HTML page) prints the first 200 bytes of that body in the log, and on a `pull_request` with provenance not equal to `match` the check conclusion is not `failure`. A run that prints no body bytes, or still concludes `failure`, fails this item. If the existing step already satisfies both, record that and add the fixture arm to `scripts/ci/__tests__/eval-baseline-fetch-shape.test.mjs` or its provenance sibling.
- [ ] #4376: with the newest successful `main` run carrying no `copilot-quality-eval-run` artifact and an older one carrying it, the step picks the older run (`delta_status=evaluated`). With all N listed runs established artifact-less it exits 0 with `delta_status=unavailable` and an `::error` annotation. With any listing API call failing it still exits 1. `describeDeltaStatus()` in `scripts/csa-loom/check-eval-regression.mjs` renders "Delta: NOT evaluated" for `unavailable`. A shape test that stays green after reverting the multi-run loop to `--limit 1` fails this item.
- [ ] #4277: pointing the baseline fetch at a nonexistent artifact name while a prior successful run exists makes the job fail; the test in `eval-baseline-fetch-shape.test.mjs` for that arm goes RED when the `exit 1` is replaced by `exit 0` on a sandbox copy. If it stays green the arm is blind and gets fixed here.
- [ ] #4386: with `baseline.latency_p95 == 0.0` and current `0.1`, `python -m apps.copilot.evals gate` does not report a regression; with baseline `2.0` and current `2.5` (+25%) it still does. A gate that treats both as regressions, or neither, fails this item. Tests in `apps/copilot/evals/tests/test_regression.py`.
- [ ] #4637: for a dropped commit contained by no tag, the failure message says it is contained by no tag and names the topmost release section of `CHANGELOG.md` as the target; for a tagged commit the existing wording is unchanged. The message never names an `Unreleased` section unless `CHANGELOG.md` has one. A message that still says "version that first contains it" for an untagged sha fails this item.

## Read first
- `.github/workflows/copilot-quality-evals.yml` (steps: "Fetch the previous run artifact (delta baseline)", "Corpus provenance", the gate step "Gate - check-eval-regression")
- `scripts/csa-loom/check-eval-regression.mjs` (`DELTA_STATUS`, `describeDeltaStatus`), `scripts/csa-loom/eval-regression-lib.mjs`, `scripts/csa-loom/ratchet-eval-floors.mjs`
- `scripts/ci/__tests__/eval-baseline-fetch-shape.test.mjs`, `apps/fiab-console/__tests__/eval-regression-gate.test.ts`
- `content/evals/eval-floors.json`
- `apps/copilot/evals/regression.py`, `apps/copilot/evals/cli.py`, `apps/copilot/evals/tests/test_regression.py`, `apps/copilot/evals/baselines/baseline_v0.1.0.json`
- `scripts/ci/check-commit-message-parses.mjs`, `scripts/ci/__tests__/commit-message-parses.test.mjs`
- `.claude/rules/assertion-design.md`, `.claude/rules/deploy-integrity.md` (R7)

## Owns
- `.github/workflows/copilot-quality-evals.yml`
- `scripts/csa-loom/check-eval-regression.mjs`
- `scripts/csa-loom/eval-regression-lib.mjs`
- `scripts/ci/__tests__/eval-baseline-fetch-shape.test.mjs`
- `apps/fiab-console/__tests__/eval-regression-gate.test.ts`
- `content/evals/eval-floors.json`
- `apps/copilot/evals/regression.py`
- `apps/copilot/evals/tests/test_regression.py`
- `scripts/ci/check-commit-message-parses.mjs`
- `scripts/ci/__tests__/commit-message-parses.test.mjs`

## Must NOT touch
- `.github/workflows/release-please.yml`, `.release-please-config.json`, `CHANGELOG.md` (release-please owns it; hand edits are refused)
- `.github/workflows/full-app-deploy-commercial.yml`, `apps/fiab-console/lib/azure/copilot-evaluator-client.ts` (#4566, #4569, deferred)
- the console eval-probe route (#4346, deferred)
- `.github/workflows/commit-message-parses.yml` (only the script and its test are in scope)

## Consumes
Nothing from other PRPs.

## Provides
A truthful `delta_status` vocabulary (`evaluated`, `absent`, `unavailable`) and honest floor provenance.

## Steps
1. Sandbox copy for mutations (worktree `E:/Repos/_ib-08`, then a scratch copy in `temp/`). Never mutate the tracked tree and revert.
2. #4277 first: run its mutation arm; record RED or GREEN. Fix only if GREEN.
3. #4376: add `unavailable`, rework the baseline step to walk up to 5 runs with `gh api .../actions/runs/<id>/artifacts`, rework the coupled shape-test arms.
4. #3857: confirm or add the 200-byte raw-body print and the non-failure PR conclusion; add the fixture arm.
5. #3846: edit the ten flags; run the ratchet script in check mode.
6. #4386 and #4637: failing test first, then fix.
7. Do not dispatch the workflow from the agent; the gate is verified from a PR run and a `workflow_dispatch` the operator can read.

## Validation
- `node --test scripts/ci/__tests__/eval-baseline-fetch-shape.test.mjs scripts/ci/__tests__/commit-message-parses.test.mjs` (read the executed count)
- `pnpm --dir apps/fiab-console vitest run __tests__/eval-regression-gate.test.ts`
- `python -m pytest apps/copilot/evals/tests/test_regression.py -q`
- `python -m apps.copilot.evals gate --current apps/copilot/evals/tests/fixtures/sample_baseline.json --baseline apps/copilot/evals/baselines/baseline_v0.1.0.json --max-score-regression 0.02 --max-latency-p95-regression-pct 10` (confirm flags with `--help` first; expect rc 0 on identical input)
- `make validate-python` for the python change.
- Merged is not done: workflow changes are "merged, not deployed" until a `copilot-quality-evals` run on `main` shows the new `delta_status` line in its summary. Do not close #3846 or #4376 on the merge alone.
- Clouds: none differ; the workflow measures the Commercial evaluator only.

## Rollback
Revert the PR. The gate stays advisory (it is not a required context), so a bad revision cannot block merges.

## Docs to update
`apps/copilot/evals/README.md` for the latency rule; the workflow header comment for the `delta_status` vocabulary.

## Wave / Blocked-by / Branch / Worktree
Wave: 1 (batch lane) · Blocked-by: none · Branch: fix/ib-08-release-eval-gate · Worktree: E:/Repos/_ib-08

## Hot files
None of the registry hot files. `touches_bicep: no`.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| #4277 | todo | | sonnet | PR #4351 merged 2026-09-08, arm unverified | |
| #4376 | todo | | sonnet | | |
| #3857 | todo | | sonnet | | |
| #3846 | todo | | sonnet | | |
| #4386 | todo | | sonnet | | |
| #4637 | todo | | sonnet | | |

Deferred candidates: #4346 (eval-probe 403, needs console route and evaluator change); #4038, #4718 (`release-please.yml`); #4566, #4569 (`full-app-deploy-commercial.yml`, `copilot-evaluator-client.ts`). Operator-held exclusion: #3462 (approving held release-PR runs).

## Kickoff prompt
Read PRPs/backlog/issue-batches/ib-08-release-eval-gate.md and .claude/rules/assertion-design.md. Work in a fresh worktree E:/Repos/_ib-08 on branch fix/ib-08-release-eval-gate. Start with #4277: run the nonexistent-artifact mutation on a sandbox copy and record RED or GREEN. Then #4376, #3857, #3846, #4386, #4637, writing the failing test before each fix. Never edit release-please.yml, CHANGELOG.md or full-app-deploy-commercial.yml, and never dispatch a workflow. Proof of done: the node --test, vitest and pytest commands in the Validation section with their executed counts, plus the per-issue RED/GREEN table in the PR body. Do not close issues; the operator closes after a main-branch eval run shows the new delta_status.
