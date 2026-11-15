---
name: ib-10-deploy-workflows
status: backlog
priority: P2
order: 110
depends_on: []
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
issues: [4196, 4946, 5022, 5073, 5082]
branch: fix/ib-10-deploy-workflows
---

# PRP: ib-10 Image build and roll: stop reverting healthy rolls, stop deleting the pinned tag, stop leaking the build pool

## Goal
Fix five defects on the image build and data-plane roll path, which is a deploy path (deploy-integrity R1 applies): `loom-dataplane-roll` reverts a healthy, verified roll when it cannot read the registry digest (#4196); the Trivy-refusal untag deletes the estate-pinned `v0.1` tag (#5022); the ACR build pool can be zeroed under queued builds with no detection (#5073); the pool release can fail at Azure login and leak a billed pool, poll-mode failures lose their task log, and a directlake build failure has no log (#5082); and the "pin the verified digest" step must be confirmed as routed through `deploy-retry.mjs` (#4946). Done is a test per defect that fails on the old behaviour, then a verified-live receipt from a real workflow run.

## Why
Measured on main while writing this PRP (2026-11-14):
- #4946: the step "Pin the verified digest onto :v0.1 (deploy durability)" in `.github/workflows/loom-dataplane-roll.yml` now calls `node scripts/ci/deploy-retry.mjs ... --step "pin ${REPO}:v0.1"`. The issue's literal ask appears done; the item is to prove it with a guard arm and record it. Not independently re-run against a live failure.
- #4196: the rollback step's condition still includes `steps.digest.outcome == 'failure'`, and the digest-reassert step fails when the ACR firewall lease cannot be acquired. An unreadable registry therefore still reverts a roll that passed health and verify.
- #5022 and #5082: the untag step (`#4464`) and the pool jobs (`pool_acquire`, `pool_release` "Scale build pool to 0 (read back)") are in `.github/workflows/build-fiab-images-acr-tasks.yml`; `scripts/ci/acr-build-pool.mjs` already has `acquire` and `release` with bounded attempts, but the Azure login that precedes `release` has no retry.
- #5073: no step detects "pool at count 0 while an ACR run is Queued on it".
Merged is not done: until the workflows run and the estate is verified, each fix is "merged, not deployed".

## Scope / Non-goals
In scope: the five issues; the decision logic goes into new, unit-testable scripts so the workflow change is thin.
Non-goals and exclusions:
- Operator-held (need a Gov or IL5 credential, a live dispatch, or an operator decision): #3883 and #4391 (`deploy-fiab-il5.yml` has never run; its first run needs an IL5 dispatch), #3844 (`gov-console-roll.yml` notifier, Gov lane), #4285 (lease wait budget vs 36-minute builder hold is a decision, not a defect), #4298 (needs a cancelled-build roll chain observed live).
- Deferred, different file families: #3346 (three new automated roll lanes plus readiness surface, feature-sized), #3458 (36 `az role assignment create` sites across many scripts; one batch cannot own all of them).
- Full cause of the pool being zeroed in #5073 is not established by the issue ("who wrote count=0"); this PRP adds detection and refusal, not a root-cause claim.
Cloud scope: Commercial receipt from workflow runs. The build workflow also serves GCC-High and IL5 (boundary input); Gov inherits on its next run and any Gov receipt must come from a GitHub Actions run, never a local `az`. GCC is supported-in-code, never exercised; IL5 has no recorded run and is not claimed as exercised.

> ASSUMPTION: for #5022 the chosen direction is "push sha-only, scan, then retag `v0.1`" only if the issue's other option (restore `v0.1` to the previous digest on refusal) proves harder; the implementer picks the smaller change and records it. Either must keep #4464's guarantee that a flagged image is never served under `latest`.

## Acceptance criteria
Each names the input that turns it red.
- [ ] #4196: a new pure decision function in `scripts/ci/roll-rollback-decision.mjs` returns `rollback` for `{health: success, verify: success, digest: mismatch}` and `keep-and-flag` (job still fails, images stay) for `{health: success, verify: success, digest: unreadable}`; both outcomes are unit-tested. A function that returns `rollback` for `unreadable` fails. The workflow's revert condition uses it; the summary line reads `digest-reassert=UNKNOWN` for the unreadable case.
- [ ] #4946: `scripts/ci/__tests__/deploy-failure-handling.test.mjs` gains an arm asserting every `az acr import` in the pin step of `loom-dataplane-roll.yml` is invoked through `deploy-retry.mjs`; replacing the wrapped call with a bare `az acr import` on a sandbox copy turns it RED. If the assertion is already satisfied by an existing arm, the item records which arm and closes on that.
- [ ] #5022: after a simulated Trivy refusal, `${REPO}:v0.1` still resolves to the digest it had before this build (not NOT FOUND), the sha tag and `latest` are not served from the refused digest, and the next `deploy-fiab-commercial` image preflight finds `v0.1`. A step that deletes `v0.1` on refusal fails the new shape test `scripts/ci/__tests__/trivy-refusal-untag.test.mjs`.
- [ ] #5073: with a fixture of pool count 0 and one run `Queued` on that pool for longer than N minutes (N is a named constant, default 10, stated in the PR), the wait step re-scales the pool or fails with a message naming the pool and run id; scale-down refuses while any run is Queued or Running on that pool. A scale-down that proceeds in that fixture fails `scripts/ci/__tests__/acr-build-pool.test.mjs`.
- [ ] #5082 part 1: `release` is preceded by a login with bounded retry, and a release that cannot run fails loudly; the next `acquire` does not assume the pool is at 0 (it reads the count). A login failure fixture that exits 0 fails the test.
- [ ] #5082 part 2: on a failed poll-mode wait the job prints the tail of `az acr task logs --run-id` while the lease is still held; a failure fixture that prints "No deploy-failure.json" with no log tail fails.
- [ ] #5082 part 3 is a diagnosis item only: the captured task log for the failing directlake build is attached to the issue, with the cause stated or "not established"; no code claim is made without that log.

## Read first
- `.github/workflows/loom-dataplane-roll.yml` (steps `digest` / "digest re-assertion", "Pin the verified digest onto :v0.1", the rollback step and its `if:`)
- `.github/workflows/build-fiab-images-acr-tasks.yml` ("Delete the pushed tags the Trivy gate just refused (#4464)", `pool_acquire`, `pool_release`, "Diagnose a failed ACR build")
- `scripts/ci/acr-build-pool.mjs`, `scripts/ci/__tests__/acr-build-pool.test.mjs`, `scripts/ci/__tests__/acr-pool-release-diagnose.test.mjs`, `scripts/ci/reap-acr-agent-pools.mjs`
- `scripts/ci/deploy-retry.mjs`, `scripts/ci/check-deploy-failure-handling.mjs`, `scripts/ci/__tests__/deploy-failure-handling.test.mjs`, `scripts/ci/acr-login-retry.sh`, `scripts/ci/check-acr-login-retry-adoption.mjs`
- `scripts/csa-loom/acr-firewall-lease.sh` (read only)
- `scripts/ci/__tests__/roll-lease-budget.test.mjs` (couples workflow timeouts; must stay green)
- `.claude/rules/deploy-integrity.md` (R1, R6, R7), `.claude/rules/assertion-design.md`

## Owns
- `scripts/ci/roll-rollback-decision.mjs` (new)
- `scripts/ci/__tests__/roll-rollback-decision.test.mjs` (new)
- `scripts/ci/__tests__/trivy-refusal-untag.test.mjs` (new)
- `scripts/ci/acr-build-pool.mjs`
- `scripts/ci/__tests__/acr-build-pool.test.mjs`
- `scripts/ci/__tests__/acr-pool-release-diagnose.test.mjs`
- `scripts/ci/__tests__/deploy-failure-handling.test.mjs`

## Must NOT touch
- `scripts/csa-loom/acr-firewall-lease.sh` and its tests (#4285 deferred)
- `.github/workflows/deploy-fiab-il5.yml`, `.github/workflows/deploy-fiab-gcch.yml`, `.github/workflows/gov-console-roll.yml`
- `scripts/ci/deploy-retry.mjs`, `scripts/ci/redact-secrets.mjs` (shared primitives; read only)
- any `*.bicep`, any `platform/fiab/**`

## Consumes
- `build-fiab-images-acr-tasks.yml` matrix rows are owned by `W01b-close-deploy-receipts` (LHDS): this PRP does not edit the matrix.
- `loom-dataplane-roll.yml` gate-wiring lines are owned by `estate-power-C-pause-aware-consumers`: this PRP does not edit those lines.

## Provides
- A tested rollback decision, a tested pool-need/pool-stuck check, and a Trivy-refusal rule that cannot delete the pinned tag.

## Steps
1. Sandbox copy for mutation runs (worktree `E:/Repos/_ib-10`, then a scratch copy under `temp/`). Never mutate the tracked tree and revert.
2. Write the new scripts and their tests first; each test must fail against the old behaviour (state the input).
3. #4946 first (smallest): add the guard arm, run the mutation.
4. #4196, then #5022, then #5073 and #5082 in the owned scripts.

### Integration step (serialized): workflow edits
Cross-program order: the workflow edits below touch files whose other owners are `W01b-close-deploy-receipts` (LHDS, `build-fiab-images-acr-tasks.yml`, Gov gate and matrix rows) and `estate-power-C-pause-aware-consumers` (`loom-dataplane-roll.yml`, gate wiring lines). They are NOT listed under Owns. Make them as the last commit of this PR, after rebasing on whichever of those PRs merged first, touching only: the rollback `if:` and summary text, the pin/untag/pool/diagnose steps. If either owner has an open PR on the same lines, stop and sequence behind it; do not resolve a conflict by guessing.
5. Run `node scripts/ci/check-deploy-failure-handling.mjs` and `scripts/ci/__tests__/roll-lease-budget.test.mjs` after the workflow edit.
6. After merge, the operator dispatches `loom-dataplane-roll` and the build workflow (agent-run stale deploys are blocked by the classifier); the receipt is read from the run, not inferred.

## Validation
- `node --test scripts/ci/__tests__/roll-rollback-decision.test.mjs scripts/ci/__tests__/trivy-refusal-untag.test.mjs scripts/ci/__tests__/acr-build-pool.test.mjs scripts/ci/__tests__/acr-pool-release-diagnose.test.mjs scripts/ci/__tests__/deploy-failure-handling.test.mjs scripts/ci/__tests__/roll-lease-budget.test.mjs scripts/ci/__tests__/deploy-retry.test.mjs` (read the executed count)
- `node scripts/ci/check-deploy-failure-handling.mjs` and `node scripts/ci/check-acr-login-retry-adoption.mjs` (rc 0)
- `actionlint .github/workflows/loom-dataplane-roll.yml .github/workflows/build-fiab-images-acr-tasks.yml` if `actionlint` is installed (check with `which actionlint` first)
- Merged is not done. Report as "merged, not deployed" until: a `loom-dataplane-roll` run shows the unreadable-digest branch (or a unit receipt plus the live roll succeeding), a build run shows `v0.1` intact after a forced Trivy refusal on a non-estate test repo, and the pool reads count 0 after a run whose login was forced to fail. Do not force a refusal against an estate-pinned repo.
- Clouds: Commercial receipt required; GCC-High and IL5 inherit on their next run (supported-in-code; IL5 never run; GCC never exercised).

## Rollback
Revert the PR; the new scripts are additive. The `if:` change is one expression. If the pool refusal misfires, the reaper (`acr-agentpool-reaper.yml`) still scales idle pools down.

## Docs to update
The workflow header comments for the rollback decision and untag rule; `docs/` runbook only if one already names the old untag behaviour (`git grep -n "untag" docs`).

## Wave / Blocked-by / Branch / Worktree
Wave: 1 (batch lane; workflow edits serialized behind the two owners above) · Blocked-by: none (frontmatter) · Branch: fix/ib-10-deploy-workflows · Worktree: E:/Repos/_ib-10

## Hot files
`.github/workflows/build-fiab-images-acr-tasks.yml` (LHDS matrix owner W01b), `.github/workflows/loom-dataplane-roll.yml` (estate-power-C). `touches_bicep: no`.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| #4946 | todo | | sonnet | pin step already wrapped on main, arm owed | |
| #4196 | todo | | sonnet | | |
| #5022 | todo | | sonnet | | |
| #5073 | todo | | sonnet | | |
| #5082 | todo | | sonnet | | |

Deferred candidates: #3346, #3458, #4285, #4298. Operator-held exclusions: #3883, #4391 (IL5 first run), #3844 (Gov lane notifier).

## Kickoff prompt
Read PRPs/backlog/issue-batches/ib-10-deploy-workflows.md, .claude/rules/deploy-integrity.md and .claude/rules/assertion-design.md. Work in a fresh worktree E:/Repos/_ib-10 on branch fix/ib-10-deploy-workflows. Build the pure decision scripts and their failing tests first (new files only), then make the thin workflow edits as the last commit after checking open PRs on loom-dataplane-roll.yml and build-fiab-images-acr-tasks.yml. Never edit the matrix rows, acr-firewall-lease.sh, any IL5/GCC-High/Gov workflow, or bicep, and never dispatch a workflow. Proof of done: the node --test command in the Validation section with executed counts, then report "merged, not deployed" until the operator's dispatch receipts are read. One reviewer pass; do not close issues.
