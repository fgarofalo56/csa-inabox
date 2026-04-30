# Best Practices --- Jenkins to GitHub Actions Migration

**Audience:** DevOps Engineer, Platform Engineer, Engineering Manager
**Reading time:** 12 minutes
**Last updated:** 2026-04-30

---

## Overview

This guide consolidates best practices for migrating from Jenkins to GitHub Actions, covering the migration process itself, security hardening, performance optimization, and CSA-in-a-Box CI/CD patterns. Follow these practices to build production-grade GitHub Actions workflows that exceed the capabilities of your Jenkins infrastructure.

---

## 1. Incremental migration strategy

### Migrate pipeline-by-pipeline, not all at once

A big-bang migration from Jenkins to GitHub Actions carries high risk. Instead, migrate incrementally:

1. **Start with low-risk pipelines** --- Build-and-test pipelines with no deployment. These are the easiest to validate.
2. **Progress to non-production deployments** --- Dev and staging deployment pipelines. Validate OIDC, environments, and approval gates.
3. **Migrate production deployments** --- Only after dev/staging pipelines are proven stable.
4. **Migrate complex pipelines last** --- Scripted pipelines with shared libraries, heavy Groovy logic, or niche plugins.

### Pipeline classification matrix

| Tier | Pipeline type                                  | Migration effort                                   | Migration order |
| ---- | ---------------------------------------------- | -------------------------------------------------- | --------------- |
| 1    | Simple build + test (freestyle or declarative) | 1--2 hours                                         | First           |
| 2    | Build + deploy to dev/staging                  | 2--4 hours                                         | Second          |
| 3    | Multi-stage with Docker, parallel, and caching | 4--8 hours                                         | Third           |
| 4    | Production deployment with approvals           | 4--8 hours                                         | Fourth          |
| 5    | Shared library consumers                       | 8--16 hours (includes building reusable workflows) | Fifth           |
| 6    | Complex scripted pipelines                     | 8--24 hours                                        | Last            |

### Track migration progress

Use a migration tracker (spreadsheet or Archon tasks) to track each pipeline:

| Pipeline name  | Tier | Jenkins URL         | GH Actions workflow | Status      | Owner |
| -------------- | ---- | ------------------- | ------------------- | ----------- | ----- |
| api-build      | 1    | /job/api-build      | api-build.yml       | Migrated    | Alice |
| api-deploy-dev | 2    | /job/api-deploy-dev | api-deploy.yml      | In progress | Bob   |
| etl-pipeline   | 3    | /job/etl-pipeline   | etl.yml             | Not started | Carol |

---

## 2. Dual-running period

### Run Jenkins and GitHub Actions in parallel

For each migrated pipeline, run both Jenkins and GitHub Actions for a minimum of 2 weeks. This validates:

- Build artifacts match (same files, same checksums)
- Test results match (same pass/fail counts)
- Deployment outcomes match (same resources deployed)
- Notifications work correctly
- Build times are acceptable

### How to dual-run

**Option A: Trigger both from the same commit**

Configure Jenkins to continue polling the repository while GitHub Actions triggers on the same push events. Both run independently.

**Option B: GitHub Actions as secondary validation**

Run the GitHub Actions workflow on pull requests only (not on push to main). Jenkins continues to handle production deployments until you are confident in the GitHub Actions workflow.

```yaml
# During dual-run period: PR only
on:
  pull_request:
    branches: [main]

# After validation: Add push trigger
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
```

### Decommission checklist

Before disabling a Jenkins job:

- [ ] GitHub Actions workflow has run successfully for 2+ weeks
- [ ] All test results match Jenkins
- [ ] All deployments match Jenkins
- [ ] Team has been notified
- [ ] Runbooks updated to reference GitHub Actions
- [ ] Monitoring dashboards updated
- [ ] Jenkins job set to "disabled" (not deleted --- keep for audit trail)

---

## 3. Reusable workflow library

### Build a centralized workflow library

Instead of copying workflow YAML across repositories, create a reusable workflow library in a central repository (e.g., `.github` repository in your organization).

```
my-org/.github/
├── .github/workflows/
│   ├── reusable-bicep-deploy.yml       # Bicep what-if + deploy
│   ├── reusable-dbt-test.yml           # dbt deps + test
│   ├── reusable-docker-build.yml       # Docker build + push with OIDC
│   ├── reusable-node-ci.yml            # Node.js install + build + test
│   ├── reusable-python-ci.yml          # Python install + pytest + coverage
│   ├── reusable-compliance-check.yml   # Checkov + policy + SBOM
│   └── reusable-docs-deploy.yml        # MkDocs build + deploy
├── actions/
│   ├── azure-oidc-login/action.yml     # Composite: OIDC login
│   ├── dbt-setup/action.yml            # Composite: install dbt + deps
│   └── notification/action.yml         # Composite: Slack notification
└── CODEOWNERS
```

### Example reusable workflow

```yaml
# .github/workflows/reusable-bicep-deploy.yml
name: Bicep Deploy
on:
    workflow_call:
        inputs:
            environment:
                required: true
                type: string
            resource-group:
                required: true
                type: string
            template-file:
                required: false
                type: string
                default: infra/main.bicep
            what-if-only:
                required: false
                type: boolean
                default: false
        secrets:
            AZURE_CLIENT_ID:
                required: true
            AZURE_TENANT_ID:
                required: true
            AZURE_SUBSCRIPTION_ID:
                required: true

permissions:
    id-token: write
    contents: read

jobs:
    what-if:
        runs-on: ubuntu-latest
        environment: ${{ inputs.environment }}
        steps:
            - uses: actions/checkout@v4
            - uses: azure/login@v2
              with:
                  client-id: ${{ secrets.AZURE_CLIENT_ID }}
                  tenant-id: ${{ secrets.AZURE_TENANT_ID }}
                  subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
            - name: Bicep What-If
              run: |
                  az deployment group what-if \
                    --resource-group ${{ inputs.resource-group }} \
                    --template-file ${{ inputs.template-file }}

    deploy:
        if: inputs.what-if-only == false
        runs-on: ubuntu-latest
        needs: what-if
        environment: ${{ inputs.environment }}
        steps:
            - uses: actions/checkout@v4
            - uses: azure/login@v2
              with:
                  client-id: ${{ secrets.AZURE_CLIENT_ID }}
                  tenant-id: ${{ secrets.AZURE_TENANT_ID }}
                  subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
            - name: Bicep Deploy
              run: |
                  az deployment group create \
                    --resource-group ${{ inputs.resource-group }} \
                    --template-file ${{ inputs.template-file }}
```

### Consuming reusable workflows

```yaml
# In any repository:
name: Deploy Infrastructure
on:
    push:
        branches: [main]

jobs:
    deploy:
        uses: my-org/.github/.github/workflows/reusable-bicep-deploy.yml@main
        with:
            environment: production
            resource-group: rg-csa-prod
            template-file: infra/main.bicep
            what-if-only: false
        secrets:
            AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
            AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
            AZURE_SUBSCRIPTION_ID: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
```

---

## 4. Security hardening

### 4.1 OIDC for all cloud authentication

Never store cloud provider credentials as GitHub Secrets. Use OIDC federation for Azure, AWS, and GCP. See [Secret Migration Guide](secret-migration.md).

```yaml
# Always include these permissions when using OIDC
permissions:
    id-token: write
    contents: read
```

### 4.2 Pin actions to SHA

Reference actions by their full SHA hash instead of tags to prevent supply-chain attacks via tag mutation.

```yaml
# Instead of:
- uses: actions/checkout@v4

# Use:
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
```

### 4.3 Enable Dependabot for actions

Dependabot will automatically open PRs when actions you reference release new versions or have vulnerabilities.

```yaml
# .github/dependabot.yml
version: 2
updates:
    - package-ecosystem: github-actions
      directory: /
      schedule:
          interval: weekly
      reviewers:
          - platform-team
```

### 4.4 Minimum permissions

Always declare the minimum permissions your workflow needs.

```yaml
# Restrict token permissions at workflow level
permissions:
    contents: read

jobs:
    deploy:
        permissions:
            id-token: write # Only this job needs OIDC
            contents: read
```

### 4.5 Protect workflow files with CODEOWNERS

```
# .github/CODEOWNERS
.github/workflows/ @platform-team
.github/actions/   @platform-team
```

### 4.6 Branch protection rules

Configure branch protection on `main`:

- Require pull request reviews before merging
- Require status checks to pass (CI workflow)
- Require linear history (no merge commits)
- Restrict who can push to matching branches
- Require signed commits (optional, for high-security)

### 4.7 Environment protection rules

For deployment workflows:

- **Required reviewers:** At least one approver for staging/prod
- **Wait timer:** Optional delay (e.g., 5 minutes for staging, 30 minutes for prod)
- **Branch restriction:** Only `main` can deploy to production
- **Deployment branch policy:** Prevent feature branches from deploying

---

## 5. Performance optimization

### 5.1 Dependency caching

Enable caching for all dependency managers:

```yaml
# Node.js
- uses: actions/setup-node@v4
  with:
      node-version: 20
      cache: npm

# Python
- uses: actions/setup-python@v5
  with:
      python-version: "3.11"
      cache: pip

# Java/Maven
- uses: actions/setup-java@v4
  with:
      java-version: 17
      distribution: temurin
      cache: maven

# .NET
- uses: actions/setup-dotnet@v4
  with:
      dotnet-version: 8.0
      cache: true
```

### 5.2 Concurrency with cancellation

Cancel in-progress runs when a new commit arrives:

```yaml
concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true
```

### 5.3 Path filtering

Skip CI for changes that do not affect the build:

```yaml
on:
    push:
        paths:
            - "src/**"
            - "tests/**"
            - "package.json"
            - ".github/workflows/ci.yml"
        paths-ignore:
            - "**.md"
            - "docs/**"
```

### 5.4 Conditional jobs

Skip expensive jobs on draft PRs:

```yaml
jobs:
    integration-test:
        if: github.event.pull_request.draft == false
```

### 5.5 Docker layer caching

```yaml
- uses: docker/build-push-action@v6
  with:
      cache-from: type=gha
      cache-to: type=gha,mode=max
```

### 5.6 Right-size runners

| Build type                      | Recommended runner                   |
| ------------------------------- | ------------------------------------ |
| Lint, format, type-check        | `ubuntu-latest` (2-core)             |
| Unit tests                      | `ubuntu-latest` (2-core)             |
| Build + integration tests       | `ubuntu-latest-4-core` (4-core)      |
| Docker image build              | `ubuntu-latest-4-core` or larger     |
| Large compilation (C/C++, Rust) | `ubuntu-latest-8-core` or larger     |
| dbt build (network-bound)       | `ubuntu-latest` (2-core, sufficient) |

---

## 6. CSA-in-a-Box CI/CD patterns

### 6.1 Bicep infrastructure deployment

```yaml
name: Infrastructure
on:
    push:
        branches: [main]
        paths: ["infra/**"]
    pull_request:
        paths: ["infra/**"]

permissions:
    id-token: write
    contents: read

jobs:
    validate:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            - run: az bicep build --file infra/main.bicep
            - uses: bridgecrewio/checkov-action@v12
              with:
                  directory: infra/
                  framework: bicep

    what-if:
        runs-on: ubuntu-latest
        needs: validate
        steps:
            - uses: actions/checkout@v4
            - uses: azure/login@v2
              with:
                  client-id: ${{ secrets.AZURE_CLIENT_ID }}
                  tenant-id: ${{ secrets.AZURE_TENANT_ID }}
                  subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
            - run: |
                  az deployment group what-if \
                    --resource-group rg-csa-dev \
                    --template-file infra/main.bicep

    deploy:
        if: github.ref == 'refs/heads/main'
        runs-on: ubuntu-latest
        needs: what-if
        environment: production
        steps:
            - uses: actions/checkout@v4
            - uses: azure/login@v2
              with:
                  client-id: ${{ secrets.AZURE_CLIENT_ID }}
                  tenant-id: ${{ secrets.AZURE_TENANT_ID }}
                  subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
            - run: |
                  az deployment group create \
                    --resource-group rg-csa-prod \
                    --template-file infra/main.bicep
```

### 6.2 dbt CI on pull requests

```yaml
name: dbt CI
on:
    pull_request:
        paths: ["dbt/**", "models/**"]

jobs:
    dbt-test:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
              with:
                  fetch-depth: 0 # Full history for state comparison

            - uses: actions/setup-python@v5
              with:
                  python-version: "3.11"
                  cache: pip

            - run: pip install dbt-databricks

            - name: dbt deps
              run: dbt deps --profiles-dir profiles/

            - name: dbt build (modified models only)
              run: |
                  dbt build \
                    --profiles-dir profiles/ \
                    --target ci \
                    --select state:modified+ \
                    --defer \
                    --state dbt-artifacts/
              env:
                  DBT_PROFILES_DIR: profiles/
```

### 6.3 Data pipeline validation

```yaml
name: Data Pipeline Validation
on:
    workflow_run:
        workflows: ["Infrastructure"]
        types: [completed]

jobs:
    validate:
        if: github.event.workflow_run.conclusion == 'success'
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            - uses: azure/login@v2
              with:
                  client-id: ${{ secrets.AZURE_CLIENT_ID }}
                  tenant-id: ${{ secrets.AZURE_TENANT_ID }}
                  subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

            - name: Trigger ADF pipeline
              run: |
                  az datafactory pipeline create-run \
                    --factory-name adf-csa-prod \
                    --resource-group rg-csa-prod \
                    --name etl-bronze-to-silver

            - name: Wait for pipeline completion
              run: |
                  # Poll for completion (max 30 minutes)
                  for i in $(seq 1 60); do
                    STATUS=$(az datafactory pipeline-run show \
                      --factory-name adf-csa-prod \
                      --resource-group rg-csa-prod \
                      --run-id $RUN_ID --query status -o tsv)
                    if [ "$STATUS" == "Succeeded" ]; then exit 0; fi
                    if [ "$STATUS" == "Failed" ]; then exit 1; fi
                    sleep 30
                  done
                  exit 1

            - name: Validate row counts
              run: |
                  python scripts/validate_row_counts.py \
                    --expected-min 1000 \
                    --table silver.transactions
```

### 6.4 Compliance evidence generation

````yaml
name: Compliance Evidence
on:
  schedule:
    - cron: '0 6 * * 1'  # Weekly
  workflow_dispatch:

jobs:
  evidence:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: azure/login@v2
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

      - name: Azure Policy compliance
        run: az policy state summarize --output json > policy-compliance.json

      - name: Checkov IaC scan
        uses: bridgecrewio/checkov-action@v12
        with:
          directory: infra/
          output_format: json
          output_file_path: checkov-results.json

      - name: Generate SBOM
        uses: anchore/sbom-action@v0
        with:
          output-file: sbom.spdx.json

      - name: Build provenance
        uses: actions/attest-build-provenance@v1
        with:
          subject-path: policy-compliance.json

      - uses: actions/upload-artifact@v4
        with:
          name: compliance-evidence-${{ github.run_number }}
          path: |
            policy-compliance.json
            checkov-results.json
            sbom.spdx.json
          retention-days: 365

### 6.5 MkDocs documentation deployment

```yaml
name: Deploy Docs
on:
  push:
    branches: [main]
    paths: ['docs/**', 'mkdocs.yml']

permissions:
  pages: write
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
          cache: pip
      - run: pip install mkdocs-material mkdocs-minify-plugin mkdocs-include-markdown-plugin
      - run: mkdocs build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site/
      - id: deployment
        uses: actions/deploy-pages@v4
````

---

## 7. Monitoring and observability

### Workflow duration tracking

Use the GitHub API to track workflow durations over time:

```bash
# Get recent workflow runs with duration
gh run list --workflow=ci.yml --json databaseId,conclusion,createdAt,updatedAt --limit 20
```

### Alerting on workflow failures

Configure Slack or email notifications for workflow failures using the notification patterns in the reusable workflow library.

### Cost monitoring

Monitor GitHub Actions usage in **Settings > Billing > Actions**. Set spending limits to prevent unexpected costs.

---

## 8. Workflow organization conventions

### File naming

```
.github/workflows/
├── ci.yml                    # CI (build + test) on push/PR
├── cd-dev.yml                # Deploy to dev (auto on main push)
├── cd-staging.yml            # Deploy to staging (manual trigger)
├── cd-production.yml         # Deploy to production (manual with approval)
├── docs.yml                  # MkDocs deployment
├── compliance.yml            # Weekly compliance evidence
├── dependabot-auto-merge.yml # Auto-merge Dependabot PRs (patch only)
└── stale.yml                 # Close stale issues/PRs
```

### Workflow structure

```yaml
# Standard workflow structure:
name: Descriptive Name

on:
    # 1. Triggers
    push:
        branches: [main]
    pull_request:
        branches: [main]

# 2. Concurrency
concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true

# 3. Permissions (minimum required)
permissions:
    contents: read

# 4. Environment variables (workflow-wide)
env:
    NODE_VERSION: 20

# 5. Jobs (ordered by dependency)
jobs:
    build:
        # ...
    test:
        needs: build
        # ...
    deploy:
        needs: test
        # ...
```

---

## 9. Common anti-patterns to avoid

| Anti-pattern                                  | Why it is bad                            | What to do instead                                   |
| --------------------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| **Using `actions/checkout@main`**             | Tag could be moved; supply-chain risk    | Pin to SHA hash                                      |
| **Storing cloud credentials as secrets**      | Long-lived; must be rotated; leak risk   | Use OIDC federation                                  |
| **Running everything on self-hosted runners** | Maintenance overhead; security risk      | Start with hosted; self-host only when needed        |
| **One massive workflow file**                 | Hard to read, maintain, and reuse        | Split into focused workflows; use reusable workflows |
| **Not using caching**                         | Slow builds; wasted minutes (and money)  | Enable `actions/cache` or setup action caching       |
| **Not cancelling superseded runs**            | Wasted compute on outdated commits       | Use `concurrency:` with `cancel-in-progress: true`   |
| **Hardcoding values in workflows**            | Brittle; environment-specific            | Use inputs, secrets, and environment variables       |
| **Skipping the dual-run period**              | Risk of discovering issues in production | Run both Jenkins and Actions for 2+ weeks            |
| **Not using environments for deployments**    | No approval gates; no audit trail        | Configure environments with protection rules         |
| **Committing secrets to workflow files**      | Credential leak                          | Use GitHub Secrets; enable secret scanning           |

---

## 10. Migration completion checklist

- [ ] All Jenkins pipelines migrated to GitHub Actions workflows
- [ ] All Jenkins credentials migrated to GitHub Secrets or OIDC
- [ ] All Jenkins agents replaced by GitHub runners (hosted or self-hosted)
- [ ] Reusable workflow library created in central `.github` repository
- [ ] Dependabot configured for GitHub Actions updates
- [ ] CODEOWNERS configured for workflow files
- [ ] Branch protection rules enabled
- [ ] Environment protection rules configured for staging/production
- [ ] Action versions pinned to SHA hashes
- [ ] Monitoring and alerting configured
- [ ] Runbooks and documentation updated
- [ ] Team trained on GitHub Actions
- [ ] Jenkins jobs disabled (not deleted --- keep for audit)
- [ ] Jenkins infrastructure decommissioned (after 30-day grace period)

---

## Next steps

1. **Start the migration** --- Follow the [Migration Playbook](../jenkins-to-github-actions.md) for the phased approach.
2. **Use the automated importer** --- [Actions Importer Tutorial](tutorial-actions-importer.md) for initial conversion.
3. **Build your reusable library** --- Start with the CSA-in-a-Box patterns above.
4. **Review federal requirements** --- [Federal Migration Guide](federal-migration-guide.md) for compliance.
5. **Benchmark your builds** --- [Benchmarks](benchmarks.md) for performance validation.
