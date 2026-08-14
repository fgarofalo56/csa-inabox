[Home](../../README.md) > [Docs](../index.md) > [Runbooks](index.md) > **Release-Please Required Checks**

# Release-Please Required-Checks Runbook

!!! note
    **Quick Summary**: Day-2 reference for how a release PR gets its required
    status checks. The architectural history is in
    [ADR-0023](../adr/0023-release-please-status-bypass.md) — read its two
    **2026-08-14 amendments**, which reverse the original decision. The file
    name still says "bypass" for link stability; there is no longer a bypass.

!!! danger "Corrected 2026-08-14 — the previous version of this runbook was wrong"
    It described the bypass as "implemented via a `paths-ignore` or `if:` gate
    on each workflow" and listed eight checks bypassed that way. **No workflow
    in this repo gates on `release-please--` branches.** The only two files that
    match that string are `release-please.yml` itself and `hygiene-guard.yml`,
    where it excludes release branches from *stale-branch cleanup* — nothing to
    do with checks. The bypassed/never-bypassed tables also listed checks
    (Link Check, CodeQL, Trivy, SBOM, SLSA, Helm Lint, Load Tests) that are not
    in branch protection's required set. Everything below is measured.

## 📋 Table of Contents

- [1. The problem release-please has](#1-the-problem-release-please-has)
- [2. How a release PR actually gets its checks](#2-how-a-release-pr-actually-gets-its-checks)
- [3. The 14 required contexts and their producers](#3-the-14-required-contexts-and-their-producers)
- [4. What can never happen](#4-what-can-never-happen)
- [5. Daily operations](#5-daily-operations)
- [6. Troubleshooting](#6-troubleshooting)
- [7. Enforcement](#7-enforcement)

---

## 1. The problem release-please has

`release-please` proposes a release PR on every push to `main`. The PR contains
exclusively:

- generated `CHANGELOG.md` entries
- a bumped version in `pyproject.toml`
- a bumped version in `.release-please-manifest.json`
- a bumped version in `apps/fiab-console/package.json`

It opens that PR with `GITHUB_TOKEN`, and GitHub *intentionally* suppresses
downstream workflow triggers on `GITHUB_TOKEN`-caused events, to prevent
infinite loops. So the release PR lands with **zero checks running** and a
permanently `BLOCKED` merge state.

Note the mechanism precisely, because a previous fix got it wrong and shipped a
dead code path on the strength of it (#3387, corrected in #3393): the runs are
**never created**. They are not held. `action_required` is a different thing —
the approval hold for fork PRs from first-time contributors — so "find the held
runs and approve them" returned an empty set every time, by construction.

## 2. How a release PR actually gets its checks

`workflow_dispatch` is a documented exception to the `GITHUB_TOKEN` suppression
rule. `release-please.yml` therefore:

1. **Neutralizes closing keywords** in the PR body (see
   [§4](#4-what-can-never-happen)), then reads the live body back to confirm it.
2. **Refuses to proceed** if the PR touches anything outside the four
   version-metadata files above.
3. **Dispatches** each producing workflow against the release branch —
   idempotently, skipping any that already has a run on the current head SHA.
4. **Confirms** each dispatch produced a real run. A dispatch that creates
   nothing is a failure, not a pass.
5. **Waits** (budget 45 min, sized from the slowest observed producer run of
   2083s) for every producing run on that SHA to conclude.
6. **Bridges** each real result onto the head SHA as a commit status whose
   `target_url` points at the job that produced it.

Measured on release PR #3419 (head `1c80ca70`, 2026-08-14): 4 workflows
dispatched, 27 real check runs on the commit, all 14 required contexts
concluded `success`, **0 synthetic statuses**.

Why a commit status is still needed on top of the real check run: a
`workflow_dispatch` check suite does not appear in the PR's
`statusCheckRollup`, which is the surface branch protection evaluates
(measured 2026-08-13 on PR #3407). So the dispatched run supplies the *result*
and the workflow carries that result across.

## 3. The 14 required contexts and their producers

Read from live branch protection on 2026-08-14. The hand-maintained mirror in
`release-please.yml`'s `REQUIRED_CHECKS` array was verified exactly equal to it.

| Required context | Producing workflow |
|---|---|
| Python Lint | `validate.yml` |
| PowerShell Lint | `validate.yml` |
| Secret Scan | `validate.yml` |
| Repo Hygiene | `validate.yml` |
| Python Tests (3.10 / 3.11 / 3.12) | `test.yml` |
| dbt Compile (shared / finance / inventory / sales) | `test.yml` |
| next build (node 20) | `fiab-console-ci.yml` |
| vitest (node 20) | `fiab-console-ci.yml` |
| guardrails | `loom-guardrails.yml` |

Other protection settings, same reading: `strict: true`,
`required_approving_review_count: 1`, `required_linear_history: true`,
`enforce_admins: false`, `required_conversation_resolution: false`.

`enforce_admins: false` means a repo admin *can* merge a release PR that has
satisfied none of this. That is exactly what happened to #3419 — it merged with
zero commit statuses and zero approving reviews. The lane going red when it
grades nothing (see below) exists so that situation is visible rather than
inferred after the fact.

## 4. What can never happen

**A `success` status the workflow invented.** The synthetic auto-pass is
deleted. A status is posted `success` only for a context whose own check run,
on that exact commit, concluded `success`. A required context with no producing
workflow gets a `failure` status and stops the release.

**A green run that graded nothing.** If the producing runs have not concluded
inside the budget, or the head SHA moved out from under them, the job **fails**
and names which of the two happened. It used to warn and exit 0.

**A release merge closing an issue.** release-please renders every commit
footer reference as `, closes #N` whatever the author wrote — `Refs #3429`
became `closes [#3429](…)` and merging #3419 closed an open P0 two seconds
later. The workflow now rewrites those keywords to `refs` in the PR body first.
Per `deploy-integrity.md` R2, issues close on DEPLOYED-and-verified, never on a
merge, so a release merge closing nothing is correct — and nothing is lost,
because a constituent PR that genuinely claimed an issue already closed it when
that PR merged.

## 5. Daily operations

1. The PR opens automatically after a push to `main`. Title:
   `chore(main): release csa-inabox X.Y.Z`.
2. Review the `CHANGELOG.md` diff and the version-bump level.
3. Wait for the release-please run to report `bridged 14 real result(s)`.
4. **Approve the PR.** `GITHUB_TOKEN` cannot approve; this gate is permanent by
   design, not a defect.
5. Squash-merge. The tag and GitHub Release are created automatically.

To re-evaluate a PR whose head SHA drifted after a rebase:

```bash
gh workflow run release-please.yml --ref main
```

## 6. Troubleshooting

### The release-please run is RED with "real runs on <sha> had NOT concluded"

CI did not finish inside 45 minutes. Nothing was posted, which is correct.
Re-dispatch `release-please.yml` once they finish and the results are bridged.

### The release-please run is RED with "head SHA moved … WHILE this step was waiting"

Not slow CI — SHA churn. `strict: true` means release-please rebuilds the PR on
every push to `main`, discarding the runs being waited on. A release needs a
quiet window on `main` roughly one CI cycle long (~35 min). This is the
structural limit of the current design; the durable fix is a GitHub App token
(#3393 option 2), whose PRs trigger workflows natively.

### "ZERO check runs exist on `<sha>`. Nothing has run"

The commit has no graded checks at all. This is **not** a mapping problem and
**not** a red result — look at the dispatch, not at the context table:

```bash
gh api "repos/fgarofalo56/csa-inabox/actions/runs?head_sha=<sha>" \
  --jq '.workflow_runs[]|[.path,.event,.status,.conclusion]|@tsv'
```

Runs listed there with `conclusion: action_required` have been **created but
never executed** — GitHub's approval hold. They publish no check run and grade
nothing. That is exactly why the lane dispatches rather than relying on them,
and why the dispatch decision reads check runs, never the run list.

Measured on release PR #3447, head `3a21f6e0`: the run list returned 10 held
`pull_request` runs while `commits/3a21f6e0/check-runs` returned `total_count=0`.
A probe reading the first and a verdict reading the second can never agree; that
disagreement deadlocked the lane until both were pointed at the same source.

### "required context '<X>' has NO producing workflow"

Branch protection requires a context nothing in the repo publishes. Either add
the workflow and map it in `REQUIRED_CHECKS`, or remove the context from
protection. The workflow will not invent a pass for it.

### The PR is BLOCKED with all 14 green

Expected steady state: protection requires an approving review. The run says so
explicitly and distinguishes it from context drift.

### The release PR touches more than the four metadata files

Someone pushed to the release branch, or release-please changed behaviour. The
workflow aborts rather than driving the release path. Treat it as a regular PR.

```bash
gh pr diff <pr-num> --name-only
```

## 7. Enforcement

`scripts/ci/check-release-please-integrity.mjs` runs in the guardrails lane and
asserts every property in [§4](#4-what-can-never-happen) survives edits to the
workflow. `scripts/ci/check-required-lane-concurrency.mjs` asserts the four
producing lanes render a verdict for every commit rather than cancelling each
other. Both are keyed to the `REQUIRED_CHECKS` manifest in
`release-please.yml`, so a newly-added required context is covered
automatically with no allowlist to go stale.

---

## Related material

- [ADR-0023 — Release-Please Status Bypass](../adr/0023-release-please-status-bypass.md) — original decision plus the two 2026-08-14 amendments that reverse it
- [`docs/runbooks/dbt-ci.md`](dbt-ci.md) — dbt CI runbook (producer of 4 required contexts)
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — Required Status Checks section
- [`docs/SUCCESSION.md`](../SUCCESSION.md) — Tribal-knowledge transfer index
