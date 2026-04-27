# ADR 0023 — Release-please PRs auto-pass required status checks

* Status: Accepted
* Date: 2026-04-27
* Deciders: @fgarofalo56
* Related: ADR 0021, ADR 0022; `.github/workflows/release-please.yml`;
  `docs/runbooks/release-please.md`

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

**The problem.** GitHub *intentionally* does not trigger downstream
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

| Option | Why not |
|---|---|
| **Personal Access Token** (`RELEASE_PLEASE_TOKEN`) | The canonical fix, but requires a long-lived user-scoped PAT in repo secrets — a credential we don't want to own and rotate. A GitHub App would solve this but is heavyweight for a single-maintainer repo. |
| **`pull_request_target` event** on a separate workflow | Same limitation: events don't fire on `GITHUB_TOKEN`-created PRs. |
| **Close + reopen the PR** via API from a GH-Actions actor | Same limitation. Verified empirically. |
| **Drop the required-check list** for `release-please--*` branches | GitHub's branch-protection model is `required_status_checks` is global per branch — there's no per-branch-pattern override without rulesets, and rulesets at this scale would over-engineer the problem. |
| **Touch a "trigger" file in the release PR** (via `extra-files`) | Doesn't help — the GITHUB_TOKEN restriction is at the event level, not the path-filter level. |

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

## References

- [release-please-action README — token note](https://github.com/googleapis/release-please-action#permissions)
- [GitHub Docs — Triggering a workflow from a workflow](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow)
- Workaround pattern adapted from
  [github.com/googleapis/release-please/issues/922](https://github.com/googleapis/release-please/issues/922)
  (community discussion of the same problem).
