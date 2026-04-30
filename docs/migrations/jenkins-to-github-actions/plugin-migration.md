# Plugin Migration Reference --- Jenkins Plugins to GitHub Actions

**Audience:** DevOps Engineer, Jenkins Administrator
**Reading time:** 12 minutes
**Last updated:** 2026-04-30

---

## Overview

Jenkins' extensibility is built on plugins --- most Jenkins installations run 50--150 plugins. This reference maps the 30 most-used Jenkins plugins to their GitHub Actions equivalents: marketplace actions, built-in features, or recommended alternatives. Each mapping includes the action reference, configuration notes, and migration complexity.

---

## Top 30 Jenkins plugins mapped

### 1. Git Plugin

**Jenkins:** `git` --- SCM checkout for Git repositories.

**GitHub Actions:** `actions/checkout@v4` (built-in)

```yaml
- uses: actions/checkout@v4
  with:
      fetch-depth: 0 # Full history (default is shallow clone)
```

**Complexity:** XS --- Drop-in replacement. GitHub Actions always checks out from GitHub; no SCM URL configuration needed.

---

### 2. Pipeline Plugin (Workflow)

**Jenkins:** `workflow-aggregator` --- Enables Jenkinsfile-based pipelines.

**GitHub Actions:** Native workflow YAML (`.github/workflows/`)

**Complexity:** XS --- This is the core of GitHub Actions. No plugin equivalent needed.

---

### 3. Docker Pipeline Plugin

**Jenkins:** `docker-workflow` --- Build, run, and push Docker images in pipelines.

**GitHub Actions:** `docker/build-push-action@v6` + `docker/login-action@v3`

```yaml
- uses: docker/login-action@v3
  with:
      registry: ghcr.io
      username: ${{ github.actor }}
      password: ${{ secrets.GITHUB_TOKEN }}

- uses: docker/build-push-action@v6
  with:
      context: .
      push: true
      tags: ghcr.io/${{ github.repository }}:${{ github.sha }}
      cache-from: type=gha
      cache-to: type=gha,mode=max
```

**Complexity:** S --- Docker Buildx action provides more features (multi-platform builds, cache backends) than the Jenkins Docker Pipeline plugin.

---

### 4. Credentials Plugin

**Jenkins:** `credentials` --- Manages secrets, certificates, SSH keys.

**GitHub Actions:** GitHub Secrets (repository, environment, organization) + OIDC federation

```yaml
env:
    API_KEY: ${{ secrets.API_KEY }}
    DB_PASSWORD: ${{ secrets.DB_PASSWORD }}
```

**Complexity:** S --- See [Secret Migration Guide](secret-migration.md) for detailed credential-type mapping.

---

### 5. Credentials Binding Plugin

**Jenkins:** `credentials-binding` --- Binds credentials to environment variables in `withCredentials` blocks.

**GitHub Actions:** Direct secret reference in `env:` or action inputs.

```yaml
- name: Deploy
  env:
      AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
  run: az login --service-principal ...
```

**Complexity:** XS --- No wrapping block needed. Secrets are referenced directly.

---

### 6. SSH Agent Plugin

**Jenkins:** `ssh-agent` --- Provides SSH key authentication within pipeline steps.

**GitHub Actions:** `webfactory/ssh-agent@v0.9`

```yaml
- uses: webfactory/ssh-agent@v0.9
  with:
      ssh-private-key: ${{ secrets.SSH_PRIVATE_KEY }}
- run: ssh user@server 'deploy.sh'
```

**Complexity:** S --- Direct mapping.

---

### 7. Slack Notification Plugin

**Jenkins:** `slack` --- Sends build notifications to Slack channels.

**GitHub Actions:** `slackapi/slack-github-action@v1`

```yaml
- uses: slackapi/slack-github-action@v1
  with:
      channel-id: C0123456789
      slack-message: "Build ${{ job.status }}: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
  env:
      SLACK_BOT_TOKEN: ${{ secrets.SLACK_BOT_TOKEN }}
```

**Complexity:** S --- Supports both webhook and Bot Token methods.

---

### 8. JUnit Plugin

**Jenkins:** `junit` --- Publishes JUnit test results with trend graphs.

**GitHub Actions:** `mikepenz/action-junit-report@v4` or `dorny/test-reporter@v1`

```yaml
- uses: mikepenz/action-junit-report@v4
  if: always()
  with:
      report_paths: "**/test-results/*.xml"
      fail_on_failure: true
      include_passed: true
```

**Complexity:** S --- Test results appear as PR check annotations. No trend graphs natively, but GitHub's workflow run history provides similar visibility.

---

### 9. SonarQube Scanner Plugin

**Jenkins:** `sonar` --- Integrates SonarQube code quality analysis.

**GitHub Actions:** `SonarSource/sonarqube-scan-action@v3` or `SonarSource/sonarcloud-github-action@v3`

```yaml
- uses: SonarSource/sonarqube-scan-action@v3
  env:
      SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
      SONAR_HOST_URL: ${{ secrets.SONAR_HOST_URL }}
```

**Complexity:** S --- Direct mapping. SonarCloud (hosted) works out of the box; SonarQube (self-hosted) requires network access from the runner.

**Alternative:** GitHub CodeQL provides native code scanning without SonarQube dependency.

---

### 10. Artifactory Plugin

**Jenkins:** `artifactory` --- Integrates JFrog Artifactory for artifact management.

**GitHub Actions:** `jfrog/setup-jfrog-cli@v4`

```yaml
- uses: jfrog/setup-jfrog-cli@v4
  env:
      JF_URL: ${{ secrets.JF_URL }}
      JF_ACCESS_TOKEN: ${{ secrets.JF_ACCESS_TOKEN }}
- run: jf rt upload "build/*.jar" my-repo/
```

**Complexity:** S --- JFrog provides an official GitHub Action. OIDC federation is supported for Artifactory Cloud.

**Alternative:** GitHub Packages provides built-in package hosting for npm, Maven, NuGet, Docker, and RubyGems without an external artifact server.

---

### 11. OWASP Dependency-Check Plugin

**Jenkins:** `dependency-check-jenkins-plugin` --- Scans dependencies for known vulnerabilities.

**GitHub Actions:** Dependabot (native) + `github/codeql-action/analyze`

```yaml
# Dependabot configuration
# .github/dependabot.yml
version: 2
updates:
    - package-ecosystem: npm
      directory: /
      schedule:
          interval: daily
    - package-ecosystem: pip
      directory: /
      schedule:
          interval: daily
```

**Complexity:** XS --- Dependabot is built into GitHub and requires only a configuration file. It automatically creates PRs for vulnerable dependencies.

---

### 12. Blue Ocean Plugin

**Jenkins:** `blueocean` --- Modern pipeline visualization UI.

**GitHub Actions:** GitHub Actions tab (built-in)

**Complexity:** XS --- GitHub Actions provides native workflow visualization showing job graph, duration, status, and log streaming. No plugin needed.

---

### 13. Email Extension Plugin

**Jenkins:** `email-ext` --- Configurable email notifications.

**GitHub Actions:** `dawidd6/action-send-mail@v3`

```yaml
- uses: dawidd6/action-send-mail@v3
  with:
      server_address: smtp.example.com
      server_port: 587
      username: ${{ secrets.MAIL_USERNAME }}
      password: ${{ secrets.MAIL_PASSWORD }}
      subject: "Build ${{ job.status }} - ${{ github.repository }}"
      body: "See run at ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
      to: team@example.com
```

**Complexity:** S --- Direct mapping with SMTP configuration.

---

### 14. Pipeline Stage View Plugin

**Jenkins:** `pipeline-stage-view` --- Visualizes pipeline stages in Jenkins UI.

**GitHub Actions:** Built-in workflow visualization

**Complexity:** XS --- Native in GitHub Actions UI. No equivalent needed.

---

### 15. Timestamper Plugin

**Jenkins:** `timestamper` --- Adds timestamps to console output.

**GitHub Actions:** Built-in (all log lines are timestamped)

**Complexity:** XS --- Automatic; no configuration needed.

---

### 16. AnsiColor Plugin

**Jenkins:** `ansicolor` --- Renders ANSI escape codes in console output.

**GitHub Actions:** Built-in (ANSI colors rendered natively)

**Complexity:** XS --- Automatic; no configuration needed.

---

### 17. Workspace Cleanup Plugin

**Jenkins:** `ws-cleanup` --- Cleans workspace before or after build.

**GitHub Actions:** Not needed (hosted runners are ephemeral)

**Complexity:** XS --- Hosted runners provide a fresh workspace for every job. Self-hosted runners should use a cleanup step.

---

### 18. Matrix Authorization Strategy Plugin

**Jenkins:** `matrix-auth` --- Fine-grained permissions per user/group/job.

**GitHub Actions:** Repository permissions + organization roles + environment protection rules

**Complexity:** M --- Different model. GitHub uses repository-level access control with environment protection for deployment authorization.

---

### 19. NodeJS Plugin

**Jenkins:** `nodejs` --- Installs and manages Node.js versions.

**GitHub Actions:** `actions/setup-node@v4`

```yaml
- uses: actions/setup-node@v4
  with:
      node-version: 20
      cache: npm
      registry-url: https://npm.pkg.github.com
```

**Complexity:** XS --- Drop-in replacement with built-in caching support.

---

### 20. Maven Integration Plugin

**Jenkins:** `maven-plugin` --- Maven build integration.

**GitHub Actions:** `actions/setup-java@v4` + `run: mvn`

```yaml
- uses: actions/setup-java@v4
  with:
      java-version: 17
      distribution: temurin
      cache: maven
- run: mvn -B verify
```

**Complexity:** XS --- Setup Java action handles JDK installation and Maven caching.

---

### 21. Azure CLI Plugin

**Jenkins:** `azure-cli` --- Runs Azure CLI commands with Azure credentials.

**GitHub Actions:** `azure/login@v2` + `run: az ...`

```yaml
- uses: azure/login@v2
  with:
      client-id: ${{ secrets.AZURE_CLIENT_ID }}
      tenant-id: ${{ secrets.AZURE_TENANT_ID }}
      subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
- run: az group list
```

**Complexity:** S --- OIDC federation eliminates stored credentials.

---

### 22. Azure Credentials Plugin

**Jenkins:** `azure-credentials` --- Manages Azure service principal credentials.

**GitHub Actions:** OIDC federation (no stored credentials)

**Complexity:** S --- OIDC eliminates credential storage entirely. See [Secret Migration Guide](secret-migration.md).

---

### 23. Terraform Plugin

**Jenkins:** `terraform` --- Terraform plan/apply integration.

**GitHub Actions:** `hashicorp/setup-terraform@v3`

```yaml
- uses: hashicorp/setup-terraform@v3
  with:
      terraform_version: 1.7.0
- run: terraform init
- run: terraform plan -out=tfplan
- run: terraform apply tfplan
```

**Complexity:** S --- Direct mapping. Terraform Cloud integration also available.

---

### 24. GitHub Branch Source Plugin

**Jenkins:** `github-branch-source` --- Enables multibranch pipeline discovery from GitHub.

**GitHub Actions:** Not needed (native GitHub integration)

**Complexity:** XS --- GitHub Actions runs directly in the repository; no external discovery needed.

---

### 25. Pipeline Utility Steps Plugin

**Jenkins:** `pipeline-utility-steps` --- Utility steps (readJSON, readYAML, zip, unzip).

**GitHub Actions:** Shell commands or dedicated actions

```yaml
# Read JSON
- id: read-json
  run: echo "version=$(jq -r '.version' package.json)" >> $GITHUB_OUTPUT

# Zip
- run: zip -r artifact.zip dist/

# Unzip
- run: unzip artifact.zip -d output/
```

**Complexity:** S --- Shell commands replace utility steps. `jq`, `yq`, `zip`, `unzip` are pre-installed on hosted runners.

---

### 26. Publish Over SSH Plugin

**Jenkins:** `publish-over-ssh` --- Deploys artifacts via SSH/SCP.

**GitHub Actions:** `appleboy/scp-action@v0.1` + `appleboy/ssh-action@v1`

```yaml
- uses: appleboy/scp-action@v0.1
  with:
      host: ${{ secrets.SSH_HOST }}
      username: ${{ secrets.SSH_USER }}
      key: ${{ secrets.SSH_KEY }}
      source: dist/*
      target: /var/www/app/

- uses: appleboy/ssh-action@v1
  with:
      host: ${{ secrets.SSH_HOST }}
      username: ${{ secrets.SSH_USER }}
      key: ${{ secrets.SSH_KEY }}
      script: sudo systemctl restart app
```

**Complexity:** S --- Direct mapping with separate actions for file transfer and command execution.

---

### 27. Docker Compose Build Step Plugin

**Jenkins:** `docker-compose-build-step` --- Runs Docker Compose in pipeline.

**GitHub Actions:** `run: docker compose up` (Docker Compose is pre-installed)

```yaml
- run: docker compose -f docker-compose.test.yml up --abort-on-container-exit
- run: docker compose -f docker-compose.test.yml down
```

**Complexity:** XS --- Docker Compose V2 is pre-installed on GitHub-hosted runners.

---

### 28. Cobertura Plugin

**Jenkins:** `cobertura` --- Code coverage reporting.

**GitHub Actions:** `irongut/CodeCoverageSummary@v1` or `codecov/codecov-action@v4`

```yaml
- uses: codecov/codecov-action@v4
  with:
      files: coverage/cobertura.xml
      token: ${{ secrets.CODECOV_TOKEN }}
```

**Complexity:** S --- Codecov, Coveralls, or custom summary actions replace Cobertura.

---

### 29. Build Timeout Plugin

**Jenkins:** `build-timeout` --- Sets maximum build duration.

**GitHub Actions:** `timeout-minutes:` on job (built-in)

```yaml
jobs:
    build:
        timeout-minutes: 30
        runs-on: ubuntu-latest
```

**Complexity:** XS --- Direct mapping. Also supported at step level.

---

### 30. Parameterized Trigger Plugin

**Jenkins:** `parameterized-trigger` --- Triggers downstream jobs with parameters.

**GitHub Actions:** `workflow_dispatch` API call or `workflow_run` trigger

```yaml
# Trigger another workflow via API
- run: |
      gh workflow run deploy.yml \
        --field environment=staging \
        --field version=${{ github.sha }}
  env:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Complexity:** S --- Use `gh` CLI or GitHub API to trigger workflows with inputs.

---

## Summary table

| #   | Jenkins plugin         | GitHub Actions equivalent                  | Complexity |
| --- | ---------------------- | ------------------------------------------ | ---------- |
| 1   | Git                    | `actions/checkout@v4`                      | XS         |
| 2   | Pipeline (Workflow)    | Native workflow YAML                       | XS         |
| 3   | Docker Pipeline        | `docker/build-push-action@v6`              | S          |
| 4   | Credentials            | GitHub Secrets + OIDC                      | S          |
| 5   | Credentials Binding    | Direct secret reference                    | XS         |
| 6   | SSH Agent              | `webfactory/ssh-agent@v0.9`                | S          |
| 7   | Slack                  | `slackapi/slack-github-action@v1`          | S          |
| 8   | JUnit                  | `mikepenz/action-junit-report@v4`          | S          |
| 9   | SonarQube              | `SonarSource/sonarqube-scan-action@v3`     | S          |
| 10  | Artifactory            | `jfrog/setup-jfrog-cli@v4`                 | S          |
| 11  | OWASP Dependency-Check | Dependabot (native)                        | XS         |
| 12  | Blue Ocean             | GitHub Actions UI (native)                 | XS         |
| 13  | Email Extension        | `dawidd6/action-send-mail@v3`              | S          |
| 14  | Pipeline Stage View    | GitHub Actions UI (native)                 | XS         |
| 15  | Timestamper            | Built-in                                   | XS         |
| 16  | AnsiColor              | Built-in                                   | XS         |
| 17  | Workspace Cleanup      | Not needed (ephemeral runners)             | XS         |
| 18  | Matrix Auth            | Org roles + environment rules              | M          |
| 19  | NodeJS                 | `actions/setup-node@v4`                    | XS         |
| 20  | Maven                  | `actions/setup-java@v4`                    | XS         |
| 21  | Azure CLI              | `azure/login@v2`                           | S          |
| 22  | Azure Credentials      | OIDC federation                            | S          |
| 23  | Terraform              | `hashicorp/setup-terraform@v3`             | S          |
| 24  | GitHub Branch Source   | Not needed (native)                        | XS         |
| 25  | Pipeline Utility Steps | Shell commands (`jq`, `yq`, `zip`)         | S          |
| 26  | Publish Over SSH       | `appleboy/scp-action` + `ssh-action`       | S          |
| 27  | Docker Compose         | `run: docker compose` (pre-installed)      | XS         |
| 28  | Cobertura              | `codecov/codecov-action@v4`                | S          |
| 29  | Build Timeout          | `timeout-minutes:` (built-in)              | XS         |
| 30  | Parameterized Trigger  | `gh workflow run` / `workflow_run` trigger | S          |

---

## Plugins with no direct equivalent

Some Jenkins plugins have no marketplace action equivalent and require alternative approaches:

| Jenkins plugin            | Alternative approach                        | Notes                                                    |
| ------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| **Lockable Resources**    | `concurrency:` groups                       | Limits concurrent runs but does not lock named resources |
| **Build Name Setter**     | No equivalent                               | Workflow runs are numbered, not named                    |
| **Rebuild**               | "Re-run jobs" in UI or `gh run rerun`       | Built into GitHub                                        |
| **Job DSL**               | Template repositories + GitHub API          | Programmatic workflow creation via API                   |
| **Configuration as Code** | Organization policies + repository rulesets | Different governance model                               |
| **Performance**           | Custom actions + GitHub Pages for reports   | No native performance trending                           |
| **Prometheus Metrics**    | Workflow run API + custom dashboards        | Export metrics via API                                   |

---

## Next steps

1. **Export your plugin list** --- In Jenkins, go to **Manage Jenkins > Plugins > Installed** and export the list.
2. **Cross-reference this table** --- Identify which plugins have XS/S mappings (migrate first) and which need custom solutions.
3. **Migrate credentials** --- Many plugins are authentication-related. See [Secret Migration Guide](secret-migration.md).
4. **Start converting pipelines** --- Follow the [Pipeline Migration Guide](pipeline-migration.md).
