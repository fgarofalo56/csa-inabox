[Home](../README.md) > **GitHub Automation**

# GitHub Automation (`.github/`)

This directory holds repo-wide GitHub metadata: issue and PR templates,
CODEOWNERS, Dependabot config, security policy, and the CI/CD workflows
under `workflows/`.

## Workflows

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| [`bicep-whatif.yml`](workflows/bicep-whatif.yml) | PR touching `infra/**` | What-if analysis on Bicep templates before deploy. |
| [`codeql.yml`](workflows/codeql.yml) | Push/PR + weekly cron | CodeQL static analysis for supported languages. |
| [`dbt-ci.yml`](workflows/dbt-ci.yml) | PR + push to `main`/`audit/**` touching any `**/dbt/**`, `**/dbt_project.yml`, `**/schema.yml`, `**/*.sql` | Runs `dbt deps`+`parse`+`compile` across all 14 vertical dbt projects via an offline DuckDB stub profile; posts a sticky PR comment summarising results. |
| [`deploy-dbt.yml`](workflows/deploy-dbt.yml) | Push to `main` touching dbt projects; manual | Deploys dbt models per vertical to Databricks (dev/staging/prod). |
| [`deploy-gov.yml`](workflows/deploy-gov.yml) | Manual; release | Azure Government region deployment pipeline. |
| [`deploy-portal.yml`](workflows/deploy-portal.yml) | Push to `main` under `portal/**`; manual | Builds and deploys the React portal. |
| [`deploy.yml`](workflows/deploy.yml) | Manual; release | Primary platform deployment orchestrator. |
| [`dr-drill.yml`](workflows/dr-drill.yml) | Quarterly cron; manual | Disaster-recovery drill runner (see `docs/runbooks/dr-drill.md`). |
| [`load-tests.yml`](workflows/load-tests.yml) | Manual; nightly | k6/Locust load-test suite against staging. |
| [`release-please.yml`](workflows/release-please.yml) | Push to `main` | Release-please PR automation for semantic versioning. |
| [`rollback.yml`](workflows/rollback.yml) | Manual | Rollback helper for Bicep and dbt deployments. |
| [`test.yml`](workflows/test.yml) | PR + push | Unit and integration test suite (pytest, Jest, Vitest). |
| [`validate-contracts.yml`](workflows/validate-contracts.yml) | PR touching contracts | Validates data/API contracts. |
| [`validate-generators.yml`](workflows/validate-generators.yml) | PR | Verifies scaffolding generators produce buildable output. |
| [`validate.yml`](workflows/validate.yml) | PR + push | Lint/typecheck/policy gates. |

For operator guidance on a failing workflow, see the runbook index:
[`docs/runbooks/`](../docs/runbooks/).

## Other files

- `CODEOWNERS` — review routing for every path in the repo.
- `dependabot.yml` — dependency update schedule.
- `SECURITY.md` — vulnerability-disclosure policy.
- `PULL_REQUEST_TEMPLATE.md` — standard PR checklist.
- `ISSUE_TEMPLATE/` — bug, feature, and chore templates.
