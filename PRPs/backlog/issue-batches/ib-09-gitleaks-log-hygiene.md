---
name: ib-09-gitleaks-log-hygiene
status: backlog
priority: P2
order: 109
depends_on: []
review: required
orchestrator_model: opus
implementer_model: sonnet
created: 2026-11-14
issues: [4525, 4508, 4515, 4392, 4505]
branch: fix/ib-09-gitleaks-log-hygiene
---

# PRP: ib-09 Secret-scan allowlist breadth and publication-surface hygiene (batch)

## Goal
Narrow what the secret scanner is allowed to skip and make the log-redaction path safe and fully enumerated. Five open issues: 19 of 25 `allowlist.regexes` entries in `.gitleaks.toml` are unanchored (#4525); `allowlist.paths` exempts about 19 percent of tracked files (#4508); the JWT rule in `redact-secrets.mjs` backtracks quadratically (#4515); a CI classifier logs up to 300 characters of an authenticated HTTP response body in a public repo (#4392); and the publication-surface enumerator cannot see raw fd 1/2 writes (#4505). Done is a negative control per issue: a synthetic credential that the old config or code let through now is caught.

## Why
All five are detective or availability controls on the secret-handling path, and this repo is public, so Actions logs and committed files are publication surfaces. The issue bodies carry measurements from independent reviewers (2,634 of 13,596 tracked files exempted; 19 of 25 regexes unanchored; 32 KB costs 1.29 s and 128 KB costs 19.7 s in the JWT rule; five raw-fd shapes invisible to all four enumerators). None of them says a secret is present. `review: required` because the batch edits the secret-scan config and a redaction primitive that other deploy scripts import.

## Scope / Non-goals
In scope:
- #4525: anchor each of the 19 unanchored `allowlist.regexes` entries, one at a time, confirming each still suppresses the fixture it exists for; any entry that cannot be anchored is listed with the reason.
- #4508: measure the false-positive volume with the path exemptions removed, record the decision, and add a negative control (a synthetic credential inside a previously exempt path is flagged).
- #4515: make the JWT rule in `scripts/ci/redact-secrets.mjs` linear (bound the repetition, or pre-filter on `indexOf('eyJ')` plus a length ceiling), with no change to any caller's ordering.
- #4392: observe what the reindex endpoint returns on 401/403 (read-only, through the existing CI workflow logs, no new live calls), then sanitise in `firstLine()` / `summarize()` in `scripts/ci/classify-reindex-result.mjs` so every caller inherits it.
- #4505: add an `fdWrites(src)` enumerator to `scripts/ci/__tests__/_publication-surfaces.mjs` and fold it into `publication-surface-bypasses.test.mjs` as a declared set per subject.
Non-goals: #4509 (the `Secret Scan` job shape in `validate.yml` is a required check; the trade between full-history and per-PR scanning is an operator decision on branch protection, deferred); #4576 (a new workflow `run:`-block rule in `check-log-injection.mjs`, larger than this batch); runtime-built fixtures (the durable fix named in #4525, a separate design); any credential value in a file, command or PR body.
Cloud scope: CI scripts and a scanner config; no estate involvement, identical in Commercial and Gov, no boundary receipt applies.

> ASSUMPTION: for #4508 the issue prefers option 2 (a per-rule allowlist keeping provider-specific rules active), noting it needs a rule redefinition because the global allowlist in the pinned gitleaks 8.21.2 has no `matchCondition`. This PRP measures first and adopts option 3 (narrow the globs) only where the measured noise is zero; if option 2 proves intractable the decision is recorded and the item closes on the measurement plus the negative control. The operator confirms before any path entry covering more than 100 files is removed.

## Acceptance criteria
Each names the input that turns it red.
- [ ] #4525: a new test `scripts/ci/__tests__/gitleaks-allowlist-anchoring.test.mjs` parses `.gitleaks.toml` and fails if any `allowlist.regexes` entry lacks both `^` and `$` anchors, except entries named in an in-file reasoned exception list; with the 19 unanchored entries present it is RED, after anchoring it is GREEN. Positive control: the 6 already-anchored entries pass. The scan `gitleaks detect --no-git --source . --config .gitleaks.toml --redact --no-banner` reports no new finding (a count above the pre-change count fails the item).
- [ ] #4508: a measurement table (files exempted per path entry, findings with the entry removed) is in the PR body; a synthetic, runtime-built, low-entropy-seeded high-entropy token placed in a temp copy of a previously exempt path (for example under `apps/fiab-console/**/*.test.ts`) is reported by gitleaks, and the same token in an unexempt path is reported too (positive control). A run where the exempt-path token is not reported fails this item.
- [ ] #4515: `redactSecrets('eyJ' + 'A'.repeat(131072))` completes in under 1 s (today about 19.7 s per the issue) and `redactSecrets` still redacts a well-formed three-part JWT and a JWT straddling a truncation boundary. A fix that is fast but stops redacting the straddling case fails this item.
- [ ] #4392: a response body containing `Authorization: Bearer abc.def.ghi` and a bare JWT, passed through the classifier's 5xx and 4xx arms, appears in the log output as redacted; the diagnostic text around it is still present (positive control). Output that contains the bearer string fails the item. The fix lives in `firstLine()` or `summarize()`, not at call sites.
- [ ] #4505: each of `fs.writeSync(1, raw)`, `fs.writeSync(process.stdout.fd, raw)`, `fs.writeSync(2, raw)`, `appendFileSync("/dev/stdout")` and `createWriteStream({fd:1})` is counted by `fdWrites`; `appendFileSync` to an ordinary path and `process.stdout.write(raw)` are not counted by it (the second is already counted by `streamWrites`). The per-subject declared set is exact, not zero. An enumerator that counts the ordinary-path shape fails the item.

## Read first
- `.gitleaks.toml` (the `allowlist.paths` and `allowlist.regexes` blocks and the #4498/#4507 comments)
- `.github/workflows/validate.yml` (the "Run gitleaks" step; read only, not owned)
- `scripts/ci/redact-secrets.mjs`, `scripts/ci/__tests__/redact-secrets.test.mjs`
- `scripts/ci/classify-reindex-result.mjs` (`firstLine`, `summarize`), `scripts/ci/__tests__/classify-reindex-result.test.mjs`
- `scripts/ci/__tests__/_publication-surfaces.mjs` (`streamWrites`, `unboundedWrites`, `forbiddenPublishers`, `inheritedStreamSpawns`), `scripts/ci/__tests__/publication-surface-bypasses.test.mjs`
- `.claude/rules/assertion-design.md`; the global rule that no credential value enters a file, command or conversation

## Owns
- `.gitleaks.toml`
- `scripts/ci/__tests__/gitleaks-allowlist-anchoring.test.mjs` (new)
- `scripts/ci/redact-secrets.mjs`
- `scripts/ci/__tests__/redact-secrets.test.mjs`
- `scripts/ci/classify-reindex-result.mjs`
- `scripts/ci/__tests__/classify-reindex-result.test.mjs`
- `scripts/ci/__tests__/_publication-surfaces.mjs`
- `scripts/ci/__tests__/publication-surface-bypasses.test.mjs`

## Must NOT touch
- `.github/workflows/validate.yml` and branch protection (#4509 deferred)
- `scripts/ci/check-log-injection.mjs` (#4576 deferred)
- `scripts/ci/_azure-redact.mjs`, `scripts/ci/deploy-arm-errors.mjs`, `scripts/ci/deploy-retry.mjs`, `.github/scripts/deploy-notify-failure.mjs` (importers of the redaction primitive; their ordering stays as is; the notifier script is only read by `ib-07-ci-guards-b` tests)
- any file that would contain a real credential; fixtures are built at runtime from a low-entropy seed

## Consumes
- The pinned scanner version in `validate.yml` (`GITLEAKS_VERSION`): measurements name the version they ran on. A local `gitleaks` binary at a different version gets its version printed beside any count.

## Provides
- An anchoring test that makes a future unanchored allowlist entry a red check, and a linear redaction primitive.

## Steps
1. Sandbox copy for every mutation (worktree `E:/Repos/_ib-09`, then a scratch copy under `temp/`). Never mutate the tracked tree and revert.
2. #4525: write the anchoring test first and watch it go RED on the 19 entries; anchor one at a time, running the scan after each.
3. #4508: measure with each path entry removed in a scratch copy, record the table, add the negative control; remove only entries whose measured noise is zero.
4. #4515: add the 128 KB timing test (assert a generous ceiling so a slow runner does not flake, and a straddle case), then fix the rule.
5. #4392: read the existing CI logs for the 401/403 body shape and state what was seen (do not infer it); add redaction in the shared helpers.
6. #4505: add `fdWrites`, the per-subject declared sets, and both-direction controls. Do not pin line numbers; pin the shape.
7. Never paste a credential-shaped literal into a file, commit message or PR body; build fixtures with string concatenation at runtime.

## Validation
- `node --test scripts/ci/__tests__/gitleaks-allowlist-anchoring.test.mjs scripts/ci/__tests__/redact-secrets.test.mjs scripts/ci/__tests__/classify-reindex-result.test.mjs scripts/ci/__tests__/publication-surface-bypasses.test.mjs` (executed count higher than before, 0 fail)
- `gitleaks detect --no-git --source . --config .gitleaks.toml --redact --no-banner` (local binary version printed; compare the finding count before and after; CI runs `gitleaks detect --source . --config .gitleaks.toml --verbose --redact --no-banner` over history and is the real backstop)
- `make security` is bandit and does not cover this; the repo-wide gate is `make validate` in CI.
- Merged is not done for the config: the first `Secret Scan` run on a PR after merge, and one on `main`, must be green; read it, do not infer it.
- Clouds: not applicable; no estate behaviour changes.

## Rollback
Revert the PR. Anchoring can only narrow an exemption, so the failure mode of a bad anchor is a noisy red `Secret Scan`, not a missed secret; the revert restores the old allowlist.

## Docs to update
`SECURITY.md` or the `.gitleaks.toml` header comment: the recorded #4508 decision and the measured counts with the scanner version.

## Wave / Blocked-by / Branch / Worktree
Wave: 1 (batch lane) · Blocked-by: none · Branch: fix/ib-09-gitleaks-log-hygiene · Worktree: E:/Repos/_ib-09

## Hot files
None of the registry hot files. `touches_bicep: no`. `.gitleaks.toml` is per-branch and unanchored by history: a PR that edits it is scanned against its own copy, so run the CI scan before merge, not after.

## Execution state
| Item | Status | Branch | Model | Evidence | Updated |
|------|--------|--------|-------|----------|---------|
| #4525 | todo | | sonnet | | |
| #4508 | todo | | sonnet | | |
| #4515 | todo | | sonnet | | |
| #4392 | todo | | sonnet | | |
| #4505 | todo | | sonnet | | |

Deferred candidates: #4509 (required `Secret Scan` job shape in `validate.yml`; branch-protection decision); #4576 (new workflow-block rule in `check-log-injection.mjs`).

## Kickoff prompt
Read PRPs/backlog/issue-batches/ib-09-gitleaks-log-hygiene.md and .claude/rules/assertion-design.md. Work in a fresh worktree E:/Repos/_ib-09 on branch fix/ib-09-gitleaks-log-hygiene. Never put a credential-shaped literal in a file, command or PR body; build every fixture at runtime. Start with #4525: write the anchoring test, watch it go RED on the 19 entries, anchor them one at a time re-running gitleaks after each. Then #4508 (measure first), #4515, #4392, #4505. Do not touch validate.yml or check-log-injection.mjs. Proof of done: the node --test command and the before/after gitleaks finding counts with the binary version, plus the negative-control table in the PR body. Request one reviewer pass; do not close issues.
