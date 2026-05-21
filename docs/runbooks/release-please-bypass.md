[Home](../../README.md) > [Docs](../index.md) > [Runbooks](index.md) > **Release-Please Status Bypass**

# Release-Please Status Bypass Runbook

!!! note
    **Quick Summary**: Operational guide for the deliberate bypass of certain CI status checks on `release-please--*` branches. The full architectural rationale is in [ADR-0023](../adr/0023-release-please-status-bypass.md); this runbook is the day-2 reference — when the bypass is active, when it should fire, when it should NOT fire, and how to recover when release-please opens a PR that does not look like the others.

## 📋 Table of Contents

- [1. Why the bypass exists](#1-why-the-bypass-exists)
- [2. Which checks are bypassed](#2-which-checks-are-bypassed)
- [3. Which checks are NEVER bypassed](#3-which-checks-are-never-bypassed)
- [4. How the bypass is implemented](#4-how-the-bypass-is-implemented)
- [5. Daily operations](#5-daily-operations)
- [6. Troubleshooting](#6-troubleshooting)
- [7. When to disable the bypass](#7-when-to-disable-the-bypass)

---

## 1. Why the bypass exists

`release-please` is a GitHub Action that proposes a release PR every time a `main` push happens. The PR contains exclusively:

- Generated `CHANGELOG.md` entries
- A bumped version in `pyproject.toml` (and any sibling manifests)
- A bumped version in the `.release-please-manifest.json`

It touches **no source code, no Bicep, no dbt models, no IaC**. Running the full 11-check status battery against it costs ~30 minutes of CI for a PR that cannot break anything that the source-code checks did not already break upstream. So a subset of checks is bypassed on these branches.

ADR-0023 documents the decision and the trade-offs.

## 2. Which checks are bypassed

The bypass is implemented via a `paths-ignore` or `if:` gate on each workflow. The current bypassed set:

| Check | Bypassed because |
|---|---|
| dbt Compile (× 4 verticals) | release-please does not modify dbt |
| dbt Integration (× 4 verticals) | release-please does not modify dbt |
| Bicep Lint | release-please does not modify Bicep |
| Bicep What-If | no IaC changes |
| Validate Cookiecutter Template | no template changes |
| Vertical Conformance | no per-vertical changes |
| Helm Lint | no Helm changes |
| Load Tests | no perf-relevant changes |

## 3. Which checks are NEVER bypassed

Even on release-please PRs, the following always run:

| Check | Why |
|---|---|
| Python Lint | release-please bumps `pyproject.toml`; lint validates the file |
| Python Tests (3.10 / 3.11 / 3.12) | smoke-test that the new version installs |
| Secret Scan (gitleaks) | even auto-bot PRs can theoretically commit a secret |
| Repo Hygiene | catches trailing-whitespace / EOF accidents in generated files |
| Link Check | `CHANGELOG.md` could include broken links |
| CodeQL | always runs on `main` PRs |
| Trivy | container scan still applies |
| SBOM | every release artifact gets a fresh SBOM |
| SLSA Provenance | every release artifact gets a signed attestation |

If any of those fails on a release-please PR, **do not bypass it** — fix the underlying issue first.

## 4. How the bypass is implemented

Each workflow's job header has a guard. The pattern:

```yaml
jobs:
  bicep-lint:
    # Only run when actual Bicep changed; skip on release-please branches.
    if: |
      github.head_ref != null &&
      !startsWith(github.head_ref, 'release-please--') &&
      contains(github.event.pull_request.labels.*.name, 'bicep') == false
    runs-on: ubuntu-latest
    steps: ...
```

The alternative (and equivalent) form is `paths-ignore: ['CHANGELOG.md', 'pyproject.toml', '.release-please-manifest.json']` on the workflow trigger, used where the `if:` form would be clumsy.

### Where to find the guards

```bash
# All workflows that gate on release-please branches
grep -lrE "release-please--|paths-ignore" .github/workflows/
```

## 5. Daily operations

### When release-please opens a PR

1. The PR opens automatically after a push to `main`. Title format: `chore(main): release csa-inabox X.Y.Z`.
2. Review the `CHANGELOG.md` diff for accuracy.
3. Confirm the version bump in `pyproject.toml` is the expected level (patch / minor / major).
4. **Required checks** complete normally (~5 minutes).
5. **Bypassed checks** show as `skipping` in `gh pr checks <num>`.
6. Merge with squash. Tag is created automatically.
7. The `slsa-provenance` and `sbom` workflows fire on the tag push.

### When you want to test release-please locally

```bash
# Dry-run via the GitHub Action's reusable workflow
gh workflow run release-please.yml --ref main

# Read the run output to see what PR would be opened
gh run watch
```

## 6. Troubleshooting

### Symptom: release-please PR has a check that says `failed` instead of `skipping`

That check is not in the bypass list. Either:

- The check legitimately failed (most likely) — fix the underlying issue.
- The bypass guard has a typo — verify the `if:` expression matches `head_ref` not `ref`.
- A branch protection rule lists the check as required without honoring `skipping` — toggle "required" off for that specific check on `release-please--*` branches if the bypass is intentional.

### Symptom: required check is missing on a release-please PR

GitHub treats `skipping` as a non-success status. If branch protection requires that check, the merge will be blocked. Either:

- Mark the check as `required = false` on `release-please--*` branches in the branch-protection ruleset.
- Or — better — re-run the check explicitly on the release-please PR: `gh workflow run <name> --ref release-please--branches--main--components--csa-inabox`.

### Symptom: release-please opened a PR that touches more than CHANGELOG + manifest

The action might have changed behavior, or someone manually pushed to the release-please branch. Treat as a regular PR — run all required checks, do not bypass.

```bash
# Inspect what changed
gh pr diff <pr-num> --name-only
```

## 7. When to disable the bypass

The bypass is a deliberate cost optimization. Disable it (revert the `if:` gates) when any of the following becomes true:

- CI minutes are no longer a constraint
- The bypassed checks become cheap enough to run unconditionally (~30 sec each)
- A security review requires every PR to run the full battery
- A specific incident exposes a gap that the bypassed checks would have caught

Document the decision in a follow-up ADR (`ADR-00XX — Restore full CI battery on release-please PRs`).

---

## Related material

- [ADR-0023 — Release-Please Status Bypass](../adr/0023-release-please-status-bypass.md) — architectural rationale
- [`docs/runbooks/dbt-ci.md`](dbt-ci.md) — dbt CI runbook (one of the bypassed checks)
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — Required Status Checks section
- [`docs/SUCCESSION.md`](../SUCCESSION.md) — Tribal-knowledge transfer index (this runbook closes item #1 from §4)
