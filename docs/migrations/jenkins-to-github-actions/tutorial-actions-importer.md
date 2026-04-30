# Tutorial --- GitHub Actions Importer CLI

**Audience:** DevOps Engineer, Jenkins Administrator
**Reading time:** 20 minutes (hands-on: 2--4 hours)
**Last updated:** 2026-04-30

---

## Overview

The GitHub Actions Importer is an official CLI tool that automates the conversion of Jenkins pipelines to GitHub Actions workflows. It connects to your Jenkins instance, audits all jobs, generates a migration forecast, performs dry-run conversions, and produces ready-to-use GitHub Actions workflow YAML. This tutorial walks through every step.

---

## Prerequisites

- A Jenkins instance with admin credentials (or API token with read access to all jobs)
- `gh` CLI installed (version 2.40+)
- Docker Desktop installed (the Actions Importer runs as a Docker container)
- A GitHub organization or repository where you will create workflows
- Network connectivity between your workstation and the Jenkins controller

---

## Step 1: Install the GitHub Actions Importer extension

```bash
# Install the gh extension
gh extension install github/gh-actions-importer

# Verify installation
gh actions-importer version
```

The Actions Importer runs as a Docker container. The first run will pull the container image automatically.

### Update to the latest version

```bash
gh actions-importer update
```

---

## Step 2: Configure credentials

The Actions Importer needs credentials for both Jenkins and GitHub.

```bash
# Interactive configuration
gh actions-importer configure

# You will be prompted for:
# 1. CI provider: Jenkins
# 2. Jenkins URL: https://jenkins.example.com
# 3. Jenkins username: admin
# 4. Jenkins API token: <your-api-token>
# 5. GitHub PAT: <your-github-pat>
```

### Generate a Jenkins API token

1. Log in to Jenkins as an admin user
2. Click your username (top right) > **Configure**
3. Under **API Token**, click **Add new Token**
4. Give it a name (e.g., "actions-importer") and click **Generate**
5. Copy the token immediately (it will not be shown again)

### Generate a GitHub Personal Access Token

Create a PAT with the following scopes:

- `repo` (full control of private repositories)
- `workflow` (update GitHub Actions workflows)
- `admin:org` (read organization data, if migrating at org level)

```bash
# Or set environment variables instead of interactive configure
export GITHUB_ACCESS_TOKEN="ghp_..."
export JENKINS_ACCESS_TOKEN="your-jenkins-api-token"
export JENKINS_USERNAME="admin"
export JENKINS_INSTANCE_URL="https://jenkins.example.com"
```

---

## Step 3: Audit your Jenkins instance

The audit command scans your entire Jenkins instance and generates a comprehensive migration readiness report.

```bash
# Run the audit
gh actions-importer audit jenkins \
  --output-dir audit-results

# For a specific folder in Jenkins
gh actions-importer audit jenkins \
  --output-dir audit-results \
  --source-url https://jenkins.example.com/job/my-folder
```

### Understanding the audit report

The audit generates several files in the output directory:

```
audit-results/
├── audit_summary.md          # Executive summary
├── pipeline_summary.md       # Per-pipeline migration readiness
├── manifest.json             # Machine-readable audit data
└── pipelines/
    ├── job-name-1/
    │   ├── source.xml         # Jenkins job configuration
    │   └── source.groovy      # Jenkinsfile (if pipeline job)
    ├── job-name-2/
    │   ├── source.xml
    │   └── source.groovy
    └── ...
```

**audit_summary.md** contains:

- Total number of pipelines discovered
- Breakdown by pipeline type (freestyle, declarative, scripted, multibranch)
- Plugin usage inventory
- Migration readiness scores (fully convertible, partially convertible, manual conversion required)
- Estimated migration effort

Example audit summary output:

```markdown
## Audit Summary

### Pipelines

- Total: 47
- Fully convertible: 31 (66%)
- Partially convertible: 12 (25%)
- Manual conversion required: 4 (9%)

### Pipeline Types

- Freestyle: 8
- Declarative Pipeline: 27
- Scripted Pipeline: 9
- Multibranch Pipeline: 3

### Plugin Usage

- git: 47 pipelines
- docker-workflow: 23 pipelines
- credentials-binding: 41 pipelines
- junit: 18 pipelines
- slack: 15 pipelines
- sonar: 8 pipelines
- artifactory: 5 pipelines
- custom-plugin-xyz: 3 pipelines (no equivalent)
```

---

## Step 4: Forecast migration scope

The forecast command provides a high-level estimate of migration complexity without generating any workflow files.

```bash
gh actions-importer forecast jenkins \
  --output-dir forecast-results
```

The forecast report includes:

- **Job count by complexity tier** --- How many jobs are simple, medium, complex
- **Estimated conversion coverage** --- Percentage of pipeline steps that can be automatically converted
- **Plugin mapping coverage** --- How many of your plugins have known Actions equivalents
- **Manual migration items** --- Steps that require human intervention
- **Estimated timeline** --- Rough time estimate based on pipeline count and complexity

---

## Step 5: Dry-run a single pipeline

The dry-run command converts a single Jenkins pipeline to GitHub Actions YAML without creating any files in your repository. Use this to preview the conversion quality.

```bash
# Dry-run a specific pipeline
gh actions-importer dry-run jenkins \
  --source-url https://jenkins.example.com/job/my-pipeline \
  --output-dir dry-run-results
```

### Reviewing the dry-run output

```
dry-run-results/
└── my-pipeline/
    ├── .github/workflows/my-pipeline.yml   # Generated workflow
    └── migration-report.md                  # Conversion details
```

The **migration-report.md** includes:

- Successfully converted steps
- Partially converted steps (with `# TODO` comments in the generated YAML)
- Unsupported steps that require manual conversion
- Plugin mappings used
- Warnings about behavioral differences

### Example dry-run output

```yaml
# Generated by GitHub Actions Importer
# Source: https://jenkins.example.com/job/my-pipeline

name: my-pipeline

on:
    push:
        branches:
            - main
    # TODO: The following trigger was not fully converted
    # Original: pollSCM('H/5 * * * *')
    # schedule:
    #   - cron: '*/5 * * * *'

jobs:
    build:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4

            - name: Build
              run: npm ci && npm run build

            - name: Test
              run: npm test

            # TODO: The following step was not fully converted
            # Original: publishHTML(target: [reportDir: 'coverage', ...])
            - uses: actions/upload-artifact@v4
              with:
                  name: coverage-report
                  path: coverage/

            - name: Deploy
              if: github.ref == 'refs/heads/main'
              run: |
                  # TODO: Verify Azure CLI authentication
                  az deployment group create \
                    --resource-group my-rg \
                    --template-file main.bicep
```

**Review each `# TODO` comment** --- these mark areas where the automatic conversion needs human adjustment.

---

## Step 6: Batch dry-run all pipelines

```bash
# Dry-run all pipelines
gh actions-importer dry-run jenkins \
  --output-dir dry-run-all

# Dry-run pipelines in a specific folder
gh actions-importer dry-run jenkins \
  --source-url https://jenkins.example.com/job/data-team \
  --output-dir dry-run-data-team
```

Review each generated workflow file, focusing on `# TODO` comments and the migration reports.

---

## Step 7: Migrate --- Create pull requests

The migrate command creates actual pull requests in your GitHub repository with the generated workflow files.

```bash
# Migrate a single pipeline
gh actions-importer migrate jenkins \
  --source-url https://jenkins.example.com/job/my-pipeline \
  --target-url https://github.com/my-org/my-repo

# Migrate with a custom branch name
gh actions-importer migrate jenkins \
  --source-url https://jenkins.example.com/job/my-pipeline \
  --target-url https://github.com/my-org/my-repo \
  --github-instance-url https://github.com
```

The migrate command:

1. Creates a new branch (`actions-importer/my-pipeline`)
2. Adds the generated workflow file to `.github/workflows/`
3. Opens a pull request with the migration report as the PR description
4. Includes `# TODO` comments for items that need manual review

### Reviewing the pull request

The PR description includes:

- **Conversion summary** --- What was converted successfully
- **Manual steps required** --- What needs human attention
- **Behavioral differences** --- Where the GitHub Actions workflow behaves differently from Jenkins
- **Testing instructions** --- How to validate the migrated workflow

---

## Step 8: Refine and validate

After reviewing the pull request, refine the generated workflow:

### Common refinements

**1. Add OIDC authentication (replace stored credentials)**

```yaml
# Replace:
- run: az login --service-principal -u $AZURE_CLIENT_ID -p $AZURE_CLIENT_SECRET ...

# With:
permissions:
  id-token: write
  contents: read

steps:
  - uses: azure/login@v2
    with:
      client-id: ${{ secrets.AZURE_CLIENT_ID }}
      tenant-id: ${{ secrets.AZURE_TENANT_ID }}
      subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
```

**2. Add caching**

```yaml
- uses: actions/cache@v4
  with:
      path: ~/.npm
      key: ${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}
```

**3. Add concurrency control**

```yaml
concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true
```

**4. Pin action versions to SHA**

```yaml
# Replace:
- uses: actions/checkout@v4

# With (for production):
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
```

**5. Add path filtering**

```yaml
on:
    push:
        paths:
            - "src/**"
            - "package.json"
            - ".github/workflows/build.yml"
```

---

## Step 9: Validate with dual-running

Run both Jenkins and GitHub Actions in parallel for 2--4 weeks to validate parity.

### Validation checklist

- [ ] Build artifacts match (same files, same checksums)
- [ ] Test results match (same pass/fail counts)
- [ ] Deployment outcomes match (same resources deployed)
- [ ] Build times are acceptable (within 20% of Jenkins)
- [ ] Notifications work (Slack, email, etc.)
- [ ] Manual approvals work (environment protection rules)
- [ ] Cron-triggered workflows fire on schedule
- [ ] Matrix builds produce correct combinations
- [ ] Artifacts are downloadable and usable
- [ ] Secrets are not exposed in logs

---

## Step 10: Custom transformers

The Actions Importer supports custom transformers for Jenkins plugins that are not automatically mapped.

### Creating a custom transformer

```ruby
# custom-transformers/my-plugin.rb
transform "MyCustomPlugin" do |step|
  # Map Jenkins plugin step to GitHub Actions
  {
    "name" => "Custom step (migrated from MyCustomPlugin)",
    "run" => step["arguments"]["command"]
  }
end
```

### Using custom transformers

```bash
gh actions-importer dry-run jenkins \
  --source-url https://jenkins.example.com/job/my-pipeline \
  --output-dir dry-run-results \
  --custom-transformers custom-transformers/
```

---

## Troubleshooting

### "Unable to connect to Jenkins"

- Verify the Jenkins URL is correct and accessible from your workstation
- Check that the API token has not expired
- Ensure Jenkins is not behind a VPN that Docker cannot access
- Try adding `--no-ssl-verify` if using self-signed certificates (not recommended for production)

### "Plugin not supported"

- Check the [Plugin Migration Reference](plugin-migration.md) for manual mapping
- Create a custom transformer for the unsupported plugin
- File an issue on the [GitHub Actions Importer repository](https://github.com/github/gh-actions-importer) to request support

### "Docker is not running"

- Start Docker Desktop
- Verify with `docker ps`
- On Linux, ensure your user is in the `docker` group

### "Generated workflow has many TODOs"

This is expected for complex scripted pipelines. The Actions Importer converts what it can and marks the rest for manual review. Focus on:

1. Authentication steps (replace with OIDC)
2. Plugin-specific steps (find marketplace action equivalents)
3. Complex Groovy logic (decompose into shell scripts or composite actions)

---

## Batch migration strategy

For large Jenkins instances (50+ pipelines), use a phased approach:

### Phase 1: Low-complexity pipelines (Week 1--2)

```bash
# Identify simple pipelines from audit
# Migrate freestyle and simple declarative pipelines first
gh actions-importer migrate jenkins \
  --source-url https://jenkins.example.com/job/simple-build-1 \
  --target-url https://github.com/my-org/repo-1

# Repeat for each simple pipeline
```

### Phase 2: Medium-complexity pipelines (Week 3--4)

```bash
# Migrate declarative pipelines with Docker, parallel stages, and parameters
gh actions-importer migrate jenkins \
  --source-url https://jenkins.example.com/job/docker-build \
  --target-url https://github.com/my-org/repo-2
```

### Phase 3: Complex pipelines (Week 5--8)

```bash
# Migrate scripted pipelines and shared library consumers
# These will require the most manual refinement
gh actions-importer migrate jenkins \
  --source-url https://jenkins.example.com/job/complex-deployment \
  --target-url https://github.com/my-org/repo-3 \
  --custom-transformers custom-transformers/
```

---

## Next steps

1. **Refine generated workflows** --- Address all `# TODO` comments in the generated YAML.
2. **Add OIDC authentication** --- Follow the [Secret Migration Guide](secret-migration.md).
3. **Walk through a manual conversion** --- Try the [Pipeline Conversion Tutorial](tutorial-pipeline-conversion.md) for hands-on practice.
4. **Apply best practices** --- Follow the [Best Practices](best-practices.md) for production-grade workflows.
