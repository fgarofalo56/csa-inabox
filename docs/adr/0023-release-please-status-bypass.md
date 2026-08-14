# ADR 0023 — Release-please PRs auto-pass required status checks

- Status: **Superseded** (by the "Amendment" section below, 2026-08-14)
- Date: 2026-04-27
- Deciders: @fgarofalo56
- Related: ADR 0021, ADR 0022; `.github/workflows/release-please.yml`;
  `docs/runbooks/release-please.md`; issues #3387, #3393

!!! danger "This decision has been reversed — read the Amendment first"
    The auto-pass described below **no longer exists**. Release PRs now get
    their required contexts from REAL dispatched workflow runs, and the
    workflow can no longer post a `success` status that no run produced. See
    [§ Amendment (2026-08-14)](#amendment-2026-08-14-the-auto-pass-is-gone).

## Context

We use [release-please](https://github.com/googleapis/release-please) to
automate semver tagging + GitHub Releases from Conventional Commits on
`main`. Release-please opens a PR titled `chore(main): release csa-inabox X.Y.Z`
that updates exactly three files:

1. `CHANGELOG.md`
2. `pyproject.toml` (version bump only)
3. `.release-please-manifest.json`

Branch protection on `main` requires 11 status checks to pass before merge:
`Python Lint`, `Python Tests (3.10/3.11/3.12)`, `PowerShell Lint`,
`Secret Scan`, `Repo Hygiene`, `dbt Compile (shared/finance/inventory/sales)`.

**The problem.** GitHub _intentionally_ does not trigger downstream
workflows on PRs created by `GITHUB_TOKEN` (loop-prevention). Release-please
uses `GITHUB_TOKEN`, so its PRs land with **zero status checks running** and
permanently `BLOCKED` merge state. The first time we hit this (PR #107 for
v0.3.0) we worked around it by closing the bot PR and shipping a manual
release via a shadow PR + docs touch. That worked but is toil-on-every-release.

## Decision

In the same `release-please` workflow run that creates/updates the PR, we
post a `success` commit status for each required-check context onto the PR
head SHA, with description:

> Auto-passed: release PR only modifies version metadata

To prevent abuse / accidental scope creep, the workflow **fails closed** if
the release PR ever touches a file outside the three allow-listed metadata
files — in that case we refuse to post the statuses and the PR stays
blocked, forcing manual review.

This makes future release PRs self-merge after a one-line approval, with no
secrets to manage.

## Alternatives considered

| Option                                                            | Why not                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Personal Access Token** (`RELEASE_PLEASE_TOKEN`)                | The canonical fix, but requires a long-lived user-scoped PAT in repo secrets — a credential we don't want to own and rotate. A GitHub App would solve this but is heavyweight for a single-maintainer repo. |
| **`pull_request_target` event** on a separate workflow            | Same limitation: events don't fire on `GITHUB_TOKEN`-created PRs.                                                                                                                                           |
| **Close + reopen the PR** via API from a GH-Actions actor         | Same limitation. Verified empirically.                                                                                                                                                                      |
| **Drop the required-check list** for `release-please--*` branches | GitHub's branch-protection model is `required_status_checks` is global per branch — there's no per-branch-pattern override without rulesets, and rulesets at this scale would over-engineer the problem.    |
| **Touch a "trigger" file in the release PR** (via `extra-files`)  | Doesn't help — the GITHUB_TOKEN restriction is at the event level, not the path-filter level.                                                                                                               |

## Consequences

**Good:**

- Release PRs auto-merge once approved → release cadence ~unblocked.
- No PAT/App credentials to manage or rotate.
- Allow-list is auditable (3 files) and the workflow refuses to bypass
  checks for any other diff.

**Bad / risks:**

- We are technically bypassing CI on these PRs. Mitigation: the diff is
  always a 3-file version bump that humans can validate in seconds, and the
  next push to `main` runs the full CI suite normally.
- If branch protection's required-check list changes, the
  `REQUIRED_CONTEXTS` array in `release-please.yml` must be kept in sync.
  Mitigation: a comment in the workflow points at
  `gh api repos/{owner}/{repo}/branches/main/protection` as the source of truth.

## Amendment (2026-08-14) — the auto-pass is gone

The decision above was accepted knowing it bypassed CI, on the reasoning that
the diff is "a 3-file version bump that humans can validate in seconds". Two
things measured since make that reasoning insufficient, and the auto-pass has
been removed.

### What replaced it

`workflow_dispatch` is a documented exception to the `GITHUB_TOKEN`
loop-prevention rule, so `release-please.yml` now **dispatches** each producing
workflow against the release branch and bridges each REAL result onto the head
SHA as a commit status whose `target_url` points at the job that produced it.
A context whose real check run did not conclude `success` gets a `failure`
status and fails the run.

Measured on release PR #3419 (head `1c80ca70`, 2026-08-14): four producing
workflows dispatched, **27 real check runs on the commit**, all 14 required
contexts green from real runs, **zero synthetic statuses**. The mechanism works.

### The two defects that remained, and how they are closed

**1. A run that verified nothing reported green.** The wait budget was 30
minutes; `fiab-console-ci.yml` concluded at 09:41:45, 78 seconds after the step
gave up at 09:40:27. It bridged nothing for any of the 14 contexts — and the
job still concluded `success`. #3419 then merged at 09:43:28 carrying **zero
commit statuses** and **zero approving reviews** against
`required_approving_review_count: 1`, i.e. on an admin bypass
(`enforce_admins: false`), not because any gate was satisfied.

So the residual risk was never the synthetic green — it was a gate that
produces nothing while looking healthy, and a human who then goes around it.
Fixed: the budget is sized from the slowest observed producer run (2083s) at
45 minutes, and an ungraded release PR now **fails** the lane.

**2. A producer-less context could still be auto-passed.** The synthetic branch
survived for contexts with no producing workflow, annotated with a
`::warning::`. A warning does not stop a merge. Live branch protection returns
exactly the 14 contexts the workflow maps, so that branch had a population of
zero — it has been deleted. A required context with no producer now posts a
`failure` status and stops the release. Fail closed, no allowlist to go stale.

### Answering the original "Alternatives considered"

The table below rejected a PAT because of the credential burden, and did not
consider `workflow_dispatch` at all. That was the gap: dispatch needs no new
credential and produces real results. A GitHub App token (option 2 in #3393)
remains the cleaner end state — its PRs trigger workflows natively and it can
approve, removing the permanent review gate too — but it is no longer required
to make the checks real.

### What is still true and still a gate

`required_approving_review_count: 1` means every release PR is BLOCKED until a
human approves. `GITHUB_TOKEN` cannot approve. That is a deliberate gate, not a
defect, and the workflow now distinguishes it from context drift rather than
guessing (`deploy-integrity.md` R7).

### Enforcement

`scripts/ci/check-release-please-integrity.mjs` (guardrails lane) asserts these
properties survive: every required context has a producer; exactly one
`success`-posting site and only downstream of a real `completed/success`
verdict; a not-green result posts an explicit `failure`; an ungraded release PR
fails the lane; and the closing-keyword neutralizer runs with its read-back.

## Amendment (2026-08-14) — a release merge must close NOTHING

release-please builds its PR body from the aggregated changelog, and
conventional-changelog renders every footer reference as `, closes #N`
regardless of the action word the author wrote. PR #3431 deliberately wrote
`Refs #3429`; the release PR body said `closes [#3429](…)`; merging release PR
#3419 closed **#3429, an open P0**, two seconds later. It was reopened by hand.

Across the whole committed `CHANGELOG.md`, **37 of 66** `closes` claims name an
issue the attributed commit never asked to close. `#1470` alone is "closed" by
seven separate entries.

`release-please.yml` now rewrites those keywords to `refs` in the PR body
before anything else runs, then reads the live body back to establish the edit
landed. Nothing is lost: a constituent PR that genuinely claimed an issue
already closed it when *it* merged — verified, #3428 carried `Closes #3426` and
#3426 closed at 04:46:38Z when that PR landed, long before the release PR
existed. And per `deploy-integrity.md` R2 and `.claude/rules/task-tracking.md`,
an issue closes on DEPLOYED-and-verified, never on a merge — so a release merge
closing nothing is the correct behaviour, not a trade-off.

## References

- [release-please-action README — token note](https://github.com/googleapis/release-please-action#permissions)
- [GitHub Docs — Triggering a workflow from a workflow](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow)
- Workaround pattern adapted from
  [github.com/googleapis/release-please/issues/922](https://github.com/googleapis/release-please/issues/922)
  (community discussion of the same problem).
