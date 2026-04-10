# GitHub Environment Protection Rules

The CSA-in-a-Box deployment workflows already reference GitHub
Environments in their job definitions
(`.github/workflows/deploy.yml` and `.github/workflows/rollback.yml`
both set `environment: ${{ inputs.environment }}` on every landing-zone
deploy job). GitHub Environments are the primary approval-gate mechanism
— but the protection rules themselves (required reviewers, branch
restrictions, wait timers) have to be configured in the GitHub UI,
because the GitHub API for environment creation is scoped to
repository admins and cannot be checked into the repo.

This document is the authoritative setup procedure for the environments.
**Run through every step before the first production deploy.**

---

## 1. Environments to create

Create three environments in
`Settings → Environments → New environment`:

| Environment | Purpose |
|---|---|
| `dev` | Development / integration testing. Minimal protection. |
| `test` | Pre-prod verification. Stricter than `dev`, looser than `prod`. |
| `prod` | Production. Two reviewers, branch restriction, wait timer. |

The workflow inputs in `deploy.yml` / `rollback.yml` enforce the value of
the `environment` input to be one of these three names, so any drift
will fail the workflow at the `environment:` job property.

---

## 2. Per-environment configuration

### `dev`

| Setting | Value |
|---|---|
| Required reviewers | *none* |
| Wait timer | 0 minutes |
| Deployment branches and tags | `Selected branches and tags` → `main`, `dev`, `feature/*` |
| Environment secrets | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_MGMT_SUBSCRIPTION_ID`, `AZURE_DMLZ_SUBSCRIPTION_ID`, `AZURE_DLZ_SUBSCRIPTION_ID` (dev values) |

### `test`

| Setting | Value |
|---|---|
| Required reviewers | 1 — members of the `platform-reviewers` GitHub team |
| Wait timer | 0 minutes |
| Deployment branches and tags | `Selected branches and tags` → `main`, `release/*` |
| Environment secrets | Same keys as `dev`, but pointing at the test subscriptions |

### `prod`

| Setting | Value |
|---|---|
| Required reviewers | **2 — both must approve before the job can run.** Members of the `platform-owners` team. Reviewers cannot approve their own PRs' deploys (GitHub enforces this automatically). |
| Wait timer | **5 minutes.** Gives the on-call engineer a cooling period to cancel an accidental trigger before the job starts executing. |
| Deployment branches and tags | `Selected branches and tags` → `main` only. No feature branches, no release branches. Prod deploys must always go through a PR-to-main. |
| Environment secrets | Production values for every `AZURE_*` secret. Audit secret rotation via the automation from Archon task `2bce6682`. |
| Environment variables | `AZURE_REGION` → the primary region from `docs/DR.md` §2 |

---

## 3. Repository-level branch protection on `main`

Environment rules are only half the story — the other half is making
sure bad code can't land on `main` in the first place. In
`Settings → Branches → Add rule` for `main`, require:

- ✅ **Require a pull request before merging** (1 approval).
- ✅ **Require status checks to pass before merging** — select:
  - `Test Suite / Python Tests`
  - `Test Suite / dbt Compile Check`
  - `Test Suite / Bicep Lint`
  - `Test Suite / Security Scan`
  - `Bicep What-If / bicep-build` (all three zones)
- ✅ **Require branches to be up to date before merging**
- ✅ **Require conversation resolution before merging**
- ✅ **Require signed commits** (optional but strongly recommended)
- ✅ **Do not allow bypassing the above settings** — even admins should
  go through the PR flow for production-affecting changes.

---

## 4. Verification checklist

After configuring the above, verify each gate works:

- [ ] Trigger `deploy.yml` manually targeting `dev`; confirm it runs
      immediately with no approval prompt.
- [ ] Trigger `deploy.yml` targeting `test`; confirm GitHub pauses the
      job on a "Waiting for approval from …" prompt.
- [ ] Trigger `deploy.yml` targeting `prod`; confirm:
  - both reviewer approvals are required,
  - the 5-minute wait timer kicks in after the second approval,
  - the deploy cannot be run from a feature branch (check by selecting
    a feature branch in the workflow dispatch UI — GitHub should reject
    the run).
- [ ] Open a PR that deliberately fails one of the required status
      checks; confirm the Merge button is disabled.
- [ ] Try to push directly to `main` (not via PR); confirm the push is
      rejected.
- [ ] Trigger `rollback.yml` targeting `prod`; confirm the same
      approval gates fire.

Capture each confirmation as a screenshot in the repo wiki or a shared
runbook folder so auditors have a record.

---

## 5. Why this lives in docs, not Bicep / YAML

GitHub Environments are a repo-level GitHub feature, not an Azure
resource. They cannot be managed from Bicep, and the GitHub Actions
workflow file syntax can only *reference* an environment by name — it
cannot *create* one or configure its rules. The GitHub REST API can
create environments (``PUT /repos/{owner}/{repo}/environments/{name}``)
but the authentication scope needed (repo admin) is not granted to the
OIDC federation the workflows use, so automating it from a workflow
would require a long-lived PAT — which is exactly the kind of
credential the project is trying to get rid of.

Until GitHub adds a Terraform-style declarative environment API, this
runbook is the authoritative source. When the environments drift (e.g.
a new reviewer team is added), update this document in the same PR.

---

## 6. Related

- `.github/workflows/deploy.yml` — deploy jobs reference
  `environment: ${{ inputs.environment }}`.
- `.github/workflows/rollback.yml` — rollback jobs reference the same
  environments.
- `docs/DR.md` — regional failover procedure, which also runs through
  the `prod` environment and inherits its approval rules.
- `docs/ROLLBACK.md` — deploy-failure runbook.
- Archon task `2bce6682` — secret rotation Function app, handles the
  credential side of environment secrets.
