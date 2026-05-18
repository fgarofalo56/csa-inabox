---
title: Maintainer Succession & Bus-Factor Plan
description: How to add a second maintainer, how to harden branch protection once a second human is active, what the on-ramp looks like, and what topics need explicit knowledge transfer.
last_updated: 2026-05-17
---

# Maintainer Succession & Bus-Factor Plan

## Why this document exists

The repo currently has one human maintainer. The 90-day commit graph runs at roughly 180 commits from a single author plus 56 from Dependabot and 21 from GitHub Actions. Branch protection on `main` requires 11 status checks but zero PR reviewers — because there is no second human to review. That is a deliberate trade-off for a solo project; it is also the largest risk in the repo.

This document is the plan for closing that gap. It covers:

1. The criteria for naming a second maintainer
2. The on-ramp / probation flow
3. Which protections to harden the moment a second human is active
4. The explicit list of topics that need knowledge transfer
5. The commands to flip the branch-protection toggles when the time comes

---

## 1. Criteria for naming a second maintainer

A second maintainer should satisfy at least four of the following five before being added:

| Criterion | Why it matters |
|---|---|
| **Recurring contributor** — ≥ 10 merged PRs over ≥ 60 days | Demonstrates sustained engagement, not a one-off |
| **Crosses subsystems** — has merged PRs touching at least two of `docs/`, `csa_platform/`, `examples/`, `.github/workflows/`, `deploy/` | Reduces specialization risk |
| **Reviews PRs effectively** — has left substantive review comments on at least 3 PRs | Confirms code-review capability, not just write capability |
| **Operates the runbooks** — has executed at least one of the [runbooks](runbooks/) end-to-end (e.g. DR drill, key rotation) | Confirms operational competence, not just code competence |
| **Aligned on architectural direction** — has authored or co-authored at least one ADR | Confirms judgment alignment on big calls |

When a candidate satisfies four of five, open an ADR proposing the addition. Use the existing `docs/adr/` template. The ADR captures the agreement publicly and is the audit trail.

---

## 2. On-ramp / probation flow

Once the ADR is merged:

| Phase | Duration | Permissions | Reviewer role |
|---|---|---|---|
| **Phase 1 — Triage** | 4 weeks | `triage` role on the repo | Can label, close issues, request changes on PRs, but cannot merge |
| **Phase 2 — Write** | 4 weeks | `write` role | Can merge non-`main` PRs and approve `main` PRs (but only `fgarofalo56` merges to `main` during this phase) |
| **Phase 3 — Maintain** | Ongoing | `maintain` role + listed in `CODEOWNERS` | Can merge to `main` once required-review gate is set to 1 |

Phase transitions happen by explicit decision in a PR comment thread — not by time alone. If a candidate stalls, they remain at the current phase until the bar is met.

---

## 3. Protections to harden the moment a second human reaches Phase 3

Today's `main` protection (audited 2026-05-17):

```text
required_status_checks:        11 contexts
required_pull_request_reviews: 0
enforce_admins:                true
dismiss_stale:                 true
```

Once the second maintainer reaches Phase 3, run the commands in §5 to set:

```text
required_pull_request_reviews:           1
require_code_owner_reviews:              true (for /docs/adr/, /.github/, /deploy/)
required_conversation_resolution:        true
```

`enforce_admins: true` should stay on regardless of who is added.

---

## 4. Topics that need explicit knowledge transfer

These are the "tribal knowledge" topics the primary maintainer should write down before — or as part of — onboarding a second maintainer. Each one is a follow-on commit, not a blocker.

| Topic | Where to capture it |
|---|---|
| Why `release-please` is bypassed for some status checks | Already partly captured in [ADR-0023](adr/0023-release-please-status-bypass.md). Add the runbook entry. |
| How the Copilot Studio agent registration is rotated | Add a runbook: `docs/runbooks/copilot-agent-rotation.md` |
| Which Azure subscriptions the GitHub Actions service principal can reach | Capture in `docs/runbooks/azure-deployment-principal.md` (cross-link to MEMORY entry already documenting `limitlessdata_deploy` scope) |
| Bicep `apiVersion` ratchet policy | Add a section to `docs/best-practices/iac-cicd.md` |
| Per-vertical dbt warehouse selection rationale | Existing decision tree at `docs/decisions/lakehouse-vs-warehouse-vs-lake.md` — verify it covers per-vertical reasoning |
| How the `rewrite_example_links.py` hook decides shim vs standalone | Already captured in PR #243 commit message; promote to a comment block at the top of the hook |
| Test layout (per-package vs central) | Already captured in [ADR-0024](adr/0024-two-tier-test-layout.md) — keep current |

The pattern: every "you would have to ask me" topic gets converted to a doc, a runbook, or an ADR. Then the topic is no longer tribal.

---

## 5. Branch-protection commands (run when Phase 3 begins)

Replace `<HANDLE>` with the second maintainer's GitHub handle. Run from a machine with `gh` authenticated as a repo admin.

```bash
# Add to CODEOWNERS at the highest-blast-radius paths first
# (already structured for easy edit at the top of .github/CODEOWNERS)

# Set required review = 1 + require CODEOWNERS on protected paths
gh api -X PUT repos/fgarofalo56/csa-inabox/branches/main/protection \
  -F required_status_checks='{"strict":true,"contexts":[]}' \
  -F enforce_admins=true \
  -F required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true,"require_code_owner_reviews":true,"required_conversation_resolution":true}' \
  -F restrictions= \
  -F allow_force_pushes=false \
  -F allow_deletions=false

# Verify
gh api repos/fgarofalo56/csa-inabox/branches/main/protection \
  --jq '{required_status_checks: .required_status_checks.contexts | length, required_pr_reviews: .required_pull_request_reviews.required_approving_review_count, require_code_owner_reviews: .required_pull_request_reviews.require_code_owner_reviews, enforce_admins: .enforce_admins.enabled}'
```

The required-status-checks list is intentionally left empty in the command above — preserve whatever is currently active. To inspect them first:

```bash
gh api repos/fgarofalo56/csa-inabox/branches/main/protection \
  --jq '.required_status_checks.contexts'
```

---

## 6. What does NOT need to change

- `enforce_admins: true` — stays
- `dismiss_stale: true` — stays
- The 11 existing status checks — stay (the `required_status_checks` array preserves them)
- Dependabot auto-merge workflow — stays; will simply require the second-maintainer or auto-merger to approve

---

## 7. Open questions to resolve before the first add

These should be answered in the ADR proposing the second maintainer:

1. What is the agreed weekly time commitment for the second role (5 hr / 10 hr / on-call rotation)?
2. Is the second maintainer authorized to merge release PRs (`release-please` outputs)?
3. Is the second maintainer authorized to approve security-sensitive PRs (`.github/`, `deploy/`, secrets) or do those still require primary approval?
4. What is the off-boarding policy if the second maintainer becomes inactive (≥ 90 days no activity)?

---

## 8. Status

| Item | State |
|---|---|
| Document published | 2026-05-17 |
| Second maintainer identified | _Not yet_ |
| CODEOWNERS updated to dual ownership | Pending second-maintainer onboarding |
| Branch protection PR-review requirement enabled | Pending second-maintainer Phase 3 |

When the first three rows flip to "Done", update this section to record the timeline.

---

## Related material

- [`.github/CODEOWNERS`](https://github.com/fgarofalo56/csa-inabox/blob/main/.github/CODEOWNERS) — current ownership mapping
- [`CONTRIBUTING.md`](https://github.com/fgarofalo56/csa-inabox/blob/main/CONTRIBUTING.md) — contributor flow
- [ADR-0024 — Two-tier test layout](adr/0024-two-tier-test-layout.md) — example of a recent ADR shape
- [Runbooks](runbooks/) — operational competence checklist for §1 criterion
