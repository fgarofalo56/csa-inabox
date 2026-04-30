# Complete Feature Mapping --- Jenkins to GitHub Actions

**Audience:** CTO, Platform Architect, DevOps Engineer
**Reading time:** 20 minutes
**Last updated:** 2026-04-30

---

## Overview

This reference maps 60+ Jenkins concepts, features, and capabilities to their GitHub Actions equivalents. Each mapping includes a migration complexity rating, notes on behavioral differences, and links to relevant documentation. Use this as a lookup table during pipeline migration.

### Complexity ratings

| Rating | Meaning                                             |
| ------ | --------------------------------------------------- |
| **XS** | Drop-in replacement; minimal effort                 |
| **S**  | Straightforward mapping; minor syntax changes       |
| **M**  | Requires restructuring; different paradigm          |
| **L**  | Significant rework; may need custom actions         |
| **XL** | No direct equivalent; requires architectural change |

---

## 1. Pipeline definition and structure

| #   | Jenkins concept                        | GitHub Actions equivalent                                  | Complexity | Notes                                                                                                                                                                                            |
| --- | -------------------------------------- | ---------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Jenkinsfile** (declarative pipeline) | `.github/workflows/*.yml`                                  | S          | YAML replaces Groovy DSL. One workflow file per pipeline, or multiple workflows triggered by different events.                                                                                   |
| 2   | **Jenkinsfile** (scripted pipeline)    | Workflow YAML with `if:` expressions and composite actions | M          | Scripted pipelines with complex Groovy logic require decomposition into discrete steps and conditional expressions. Arbitrary Groovy loops become matrix strategies or shell scripts.            |
| 3   | **Multibranch Pipeline**               | Event triggers (`on: push`, `on: pull_request`)            | S          | GitHub Actions natively triggers on any branch push or PR. No need for a separate "multibranch" construct --- every workflow is inherently multibranch.                                          |
| 4   | **Organization Folder**                | Organization-level reusable workflows                      | M          | Jenkins Organization Folder auto-discovers repos. GitHub Actions requires explicit workflow files in each repo, but reusable workflows can be shared from a central `.github` repository.        |
| 5   | **Freestyle project**                  | Workflow YAML                                              | S          | Freestyle jobs are the simplest to convert --- each build step becomes a workflow step.                                                                                                          |
| 6   | **Pipeline libraries** (`@Library`)    | Reusable workflows (`workflow_call`) + composite actions   | M          | Shared libraries in Groovy must be re-implemented as reusable workflows (for complete job sequences) or composite actions (for step sequences). See [Pipeline Migration](pipeline-migration.md). |
| 7   | **Folder** (Jenkins folders)           | Repository or workflow organization                        | XS         | Jenkins folders for organizing jobs map to either separate repositories or workflow file naming conventions (e.g., `deploy-staging.yml`, `deploy-production.yml`).                               |
| 8   | **Pipeline parameters**                | `workflow_dispatch: inputs:`                               | S          | Parameters become inputs on `workflow_dispatch` events. Types: `string`, `boolean`, `choice`, `environment`.                                                                                     |
| 9   | **Build triggers** (SCM polling)       | `on: push`, `on: pull_request`, `on: schedule`             | XS         | GitHub webhooks replace SCM polling. No polling interval needed --- pushes trigger immediately.                                                                                                  |
| 10  | **Cron trigger**                       | `on: schedule: - cron:`                                    | XS         | Same cron syntax. GitHub Actions cron runs on UTC only.                                                                                                                                          |

---

## 2. Stages, jobs, and steps

| #   | Jenkins concept               | GitHub Actions equivalent                                                        | Complexity | Notes                                                                                                                           |
| --- | ----------------------------- | -------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 11  | **stage('Build')**            | `jobs: build:`                                                                   | S          | Each Jenkins stage typically maps to a GitHub Actions job. Jobs run on separate runners and can have dependencies via `needs:`. |
| 12  | **steps { sh '...' }**        | `steps: - run: ...`                                                              | XS         | Direct mapping. `sh` becomes `run:` for shell commands.                                                                         |
| 13  | **steps { bat '...' }**       | `steps: - run: ...` with `shell: cmd` or `shell: pwsh`                           | XS         | Specify the shell explicitly for Windows commands.                                                                              |
| 14  | **parallel { }**              | Multiple jobs without `needs:`, or `strategy.matrix`                             | S          | Independent jobs run in parallel by default. For parallel variants of the same task, use matrix strategy.                       |
| 15  | **sequential stages**         | Jobs with `needs: [previous-job]`                                                | S          | Use `needs:` to express stage ordering.                                                                                         |
| 16  | **stage options (timeout)**   | `timeout-minutes:` on job                                                        | XS         | Direct mapping.                                                                                                                 |
| 17  | **stage options (retry)**     | `continue-on-error: true` + custom retry logic, or `nick-fields/retry@v3` action | M          | No native retry at step level. Use a retry action or shell loop.                                                                |
| 18  | **input (manual approval)**   | Environment protection rules with required reviewers                             | S          | Configure environments in repository settings with required reviewers. Jobs targeting that environment wait for approval.       |
| 19  | **milestone**                 | No direct equivalent                                                             | XL         | Jenkins milestones cancel older builds. Use `concurrency:` groups with `cancel-in-progress: true` for similar behavior.         |
| 20  | **lock (Lockable Resources)** | `concurrency:` groups                                                            | S          | Concurrency groups ensure only one workflow run executes in a group at a time.                                                  |

---

## 3. Agents, runners, and execution environments

| #   | Jenkins concept                      | GitHub Actions equivalent                                        | Complexity | Notes                                                                                                           |
| --- | ------------------------------------ | ---------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| 21  | **agent any**                        | `runs-on: ubuntu-latest`                                         | XS         | Default to GitHub-hosted Ubuntu runner.                                                                         |
| 22  | **agent none**                       | No `runs-on:` at workflow level; set per job                     | XS         | Each GitHub Actions job specifies its own runner.                                                               |
| 23  | **agent { label 'linux' }**          | `runs-on: [self-hosted, linux]`                                  | S          | Use runner labels for self-hosted runner targeting.                                                             |
| 24  | **agent { docker { image '...' } }** | `container:` at job level, or `uses: docker://...` at step level | S          | Container jobs run the entire job in a Docker container.                                                        |
| 25  | **agent { dockerfile true }**        | Build custom image in prior job, then use as container           | M          | No direct equivalent. Build the image in a preceding job and reference it.                                      |
| 26  | **agent { kubernetes { } }**         | ARC (Actions Runner Controller) on Kubernetes                    | M          | ARC provides Kubernetes-native autoscaling of self-hosted runners. See [Agent Migration](agent-migration.md).   |
| 27  | **node('label') { }** (scripted)     | `runs-on: [label]`                                               | S          | Same concept, different syntax.                                                                                 |
| 28  | **tool 'Maven 3.9'**                 | `actions/setup-java@v4` + `run: mvn ...`, or pre-installed tools | S          | Tool installations are explicit steps, not declarative tool selectors.                                          |
| 29  | **Custom tool installer**            | `setup-*` actions or shell installation steps                    | S          | Most tools have official setup actions: `setup-node`, `setup-python`, `setup-java`, `setup-go`, `setup-dotnet`. |

---

## 4. Environment variables and credentials

| #   | Jenkins concept                   | GitHub Actions equivalent                              | Complexity | Notes                                                                                |
| --- | --------------------------------- | ------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------ |
| 30  | **environment { VAR = 'value' }** | `env:` at workflow, job, or step level                 | XS         | Direct mapping. Environment variables cascade from workflow to job to step.          |
| 31  | **credentials('id')**             | `${{ secrets.NAME }}`                                  | S          | Jenkins credentials become GitHub Secrets. Secrets are masked in logs automatically. |
| 32  | **withCredentials([...]) { }**    | `env:` block referencing secrets, or action inputs     | S          | No wrapping block needed. Reference secrets directly where needed.                   |
| 33  | **Username/Password credential**  | Two separate secrets (USERNAME + PASSWORD), or OIDC    | S          | Split into separate secrets, or eliminate with OIDC for cloud providers.             |
| 34  | **SSH private key credential**    | Secret containing the key + `ssh-agent` action         | S          | Use `webfactory/ssh-agent@v0.9` to load SSH keys.                                    |
| 35  | **Secret text credential**        | GitHub Secret                                          | XS         | Direct mapping.                                                                      |
| 36  | **Secret file credential**        | Secret containing base64-encoded file content          | S          | Base64-encode the file, store as secret, decode in workflow step.                    |
| 37  | **Certificate credential**        | Secret containing base64-encoded PFX + password secret | S          | Same approach as secret file.                                                        |
| 38  | **Global credentials**            | Organization-level secrets                             | S          | Organization secrets are available to all repos (or selected repos).                 |
| 39  | **Folder-scoped credentials**     | Repository-level secrets                               | XS         | Direct mapping.                                                                      |
| 40  | **Credential domains**            | Environment-level secrets                              | S          | Use environments (dev, staging, prod) to scope secrets to deployment targets.        |

---

## 5. Post-build actions and notifications

| #   | Jenkins concept                | GitHub Actions equivalent                                                   | Complexity | Notes                                                                           |
| --- | ------------------------------ | --------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------- |
| 41  | **post { always { } }**        | Step with `if: always()`                                                    | XS         | Direct mapping.                                                                 |
| 42  | **post { success { } }**       | Step with `if: success()` (default)                                         | XS         | Steps run on success by default.                                                |
| 43  | **post { failure { } }**       | Step with `if: failure()`                                                   | XS         | Direct mapping.                                                                 |
| 44  | **post { unstable { } }**      | `if: steps.<id>.outcome == 'failure' && steps.<id>.conclusion == 'success'` | M          | No native "unstable" concept. Use `continue-on-error: true` and check outcomes. |
| 45  | **post { changed { } }**       | No direct equivalent                                                        | L          | Requires custom logic comparing current result to previous run via API.         |
| 46  | **post { cleanup { } }**       | Step with `if: always()` at end of job                                      | XS         | Cleanup logic goes in an always-run step at the end.                            |
| 47  | **emailext (Email Extension)** | Custom action or `dawidd6/action-send-mail@v3`                              | S          | Email notification via SMTP action.                                             |
| 48  | **slackSend**                  | `slackapi/slack-github-action@v1`                                           | S          | Direct mapping. Slack webhook or Bot token.                                     |
| 49  | **archiveArtifacts**           | `actions/upload-artifact@v4`                                                | S          | Upload artifacts with path patterns. Retention configurable (1--90 days).       |
| 50  | **junit (test results)**       | `dorny/test-reporter@v1` or `mikepenz/action-junit-report@v4`               | S          | Parse JUnit XML and display results as PR check annotations.                    |

---

## 6. Source control and triggers

| #   | Jenkins concept              | GitHub Actions equivalent                            | Complexity | Notes                                                                                                                        |
| --- | ---------------------------- | ---------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 51  | **checkout scm**             | `actions/checkout@v4`                                | XS         | Direct mapping. Checks out the repository at the triggering ref.                                                             |
| 52  | **Git SCM (polling)**        | `on: push` / `on: pull_request` (webhook-driven)     | XS         | No polling needed. GitHub sends webhooks on every push.                                                                      |
| 53  | **Branch filtering**         | `on: push: branches: [main, develop]`                | XS         | Direct mapping in trigger configuration.                                                                                     |
| 54  | **Path filtering**           | `on: push: paths: ['src/**']`                        | XS         | Direct mapping. Changes outside specified paths do not trigger the workflow.                                                 |
| 55  | **Tag triggers**             | `on: push: tags: ['v*']`                             | XS         | Direct mapping.                                                                                                              |
| 56  | **PR triggers**              | `on: pull_request: types: [opened, synchronize]`     | XS         | More granular than Jenkins --- specify exactly which PR events trigger the workflow.                                         |
| 57  | **Webhook trigger**          | `on: repository_dispatch`                            | S          | Use `repository_dispatch` with a custom `event_type` for external webhook triggers.                                          |
| 58  | **Upstream/downstream jobs** | `workflow_run` trigger or `needs:` within a workflow | S          | `workflow_run` triggers a workflow when another workflow completes.                                                          |
| 59  | **Quiet period**             | No direct equivalent                                 | M          | GitHub Actions triggers immediately. Use `concurrency:` with `cancel-in-progress: true` to avoid running superseded commits. |

---

## 7. Artifacts, caching, and workspaces

| #   | Jenkins concept                 | GitHub Actions equivalent                               | Complexity | Notes                                                                                                                              |
| --- | ------------------------------- | ------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 60  | **stash / unstash**             | `actions/upload-artifact` + `actions/download-artifact` | S          | Stash/unstash between stages becomes upload/download between jobs. Artifacts persist for configurable retention (default 90 days). |
| 61  | **archiveArtifacts**            | `actions/upload-artifact@v4`                            | S          | Same as stash, but for permanent build outputs.                                                                                    |
| 62  | **workspace** (persistent)      | Each job gets a fresh workspace                         | M          | GitHub Actions does not persist workspace between jobs. Use artifacts or caching for shared state.                                 |
| 63  | **ws('custom-dir')**            | `working-directory:` on step                            | XS         | Specify working directory per step.                                                                                                |
| 64  | **Workspace cleanup**           | Automatic (hosted runners) or `pre:` step (self-hosted) | XS         | Hosted runners are ephemeral --- clean by default. Self-hosted runners should use cleanup steps.                                   |
| 65  | **Dependency caching** (manual) | `actions/cache@v4`                                      | XS         | Built-in caching with key-based invalidation. 10 GB per repository.                                                                |

---

## 8. Docker and container support

| #   | Jenkins concept                 | GitHub Actions equivalent                                    | Complexity | Notes                                                                     |
| --- | ------------------------------- | ------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------- |
| 66  | **Docker Pipeline plugin**      | `docker/build-push-action@v6`                                | S          | Build and push images in a single action.                                 |
| 67  | **docker.build()**              | `docker build` in `run:` step, or `docker/build-push-action` | XS         | Either shell command or dedicated action.                                 |
| 68  | **docker.image().inside { }**   | `container:` at job level                                    | S          | Run the entire job inside a container image.                              |
| 69  | **Docker agent**                | `container:` at job level                                    | S          | Direct mapping.                                                           |
| 70  | **sidecar containers**          | `services:` at job level                                     | S          | Define service containers (databases, caches) that run alongside the job. |
| 71  | **Docker registry credentials** | `docker/login-action@v3`                                     | S          | Authenticate to Docker Hub, GHCR, ACR, ECR.                               |

---

## 9. Security and compliance

| #   | Jenkins concept              | GitHub Actions equivalent                                          | Complexity | Notes                                                                                                                        |
| --- | ---------------------------- | ------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 72  | **Role-Based Authorization** | Repository/organization permissions + environment protection rules | M          | GitHub's permission model is different --- repo-level access, not job-level. Environments provide deployment-level controls. |
| 73  | **Matrix Authorization**     | Organization roles + custom repository roles (Enterprise)          | M          | Enterprise plan supports custom roles with granular permissions.                                                             |
| 74  | **LDAP/AD integration**      | SAML SSO / OIDC via identity provider                              | S          | GitHub Enterprise supports SAML SSO with Entra ID, Okta, Ping Identity.                                                      |
| 75  | **Audit log**                | GitHub audit log (organization) + workflow run logs                | S          | Comprehensive audit logging at organization level.                                                                           |
| 76  | **Script approval**          | `permissions:` block + CODEOWNERS for workflow files               | S          | Restrict who can modify workflows. Permissions block limits token scope.                                                     |
| 77  | **OWASP Dependency-Check**   | `github/codeql-action` + Dependabot                                | S          | Native dependency scanning with automated PR creation for fixes.                                                             |
| 78  | **SonarQube integration**    | `SonarSource/sonarqube-scan-action` or CodeQL                      | S          | Both SonarQube action and native CodeQL available.                                                                           |

---

## 10. Advanced pipeline features

| #   | Jenkins concept                               | GitHub Actions equivalent                         | Complexity | Notes                                                                                                      |
| --- | --------------------------------------------- | ------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| 79  | **Matrix builds** (axes)                      | `strategy: matrix:`                               | S          | Native matrix strategy with include/exclude. More concise than Jenkins matrix axis plugin.                 |
| 80  | **Declarative options (skipDefaultCheckout)** | Omit `actions/checkout` step                      | XS         | No checkout happens unless you explicitly add the checkout step.                                           |
| 81  | **timestamps**                                | Automatic in workflow logs                        | XS         | Every log line is timestamped by default.                                                                  |
| 82  | **ansiColor**                                 | Automatic in workflow logs                        | XS         | GitHub Actions renders ANSI colors in logs natively.                                                       |
| 83  | **buildDiscarder**                            | Artifact retention policies + log retention       | S          | Configure retention on `upload-artifact` (1--90 days). Workflow run logs retained per organization policy. |
| 84  | **disableConcurrentBuilds**                   | `concurrency:` group without `cancel-in-progress` | XS         | Direct mapping.                                                                                            |
| 85  | **catchError**                                | `continue-on-error: true` on step                 | XS         | Direct mapping. Step failure does not fail the job.                                                        |
| 86  | **warnError**                                 | `continue-on-error: true` + outcome check         | S          | No native "warn" status. Use `continue-on-error` and add a warning annotation with `echo "::warning::"`.   |
| 87  | **Blue Ocean (pipeline visualization)**       | GitHub Actions workflow visualization             | XS         | GitHub Actions tab shows job graph, duration, and status natively.                                         |
| 88  | **Pipeline Graph View**                       | Workflow run visualization                        | XS         | Native in GitHub UI.                                                                                       |

---

## 11. API and extensibility

| #   | Jenkins concept                   | GitHub Actions equivalent                                      | Complexity | Notes                                                                                                          |
| --- | --------------------------------- | -------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| 89  | **Jenkins REST API**              | GitHub REST API + GraphQL API                                  | S          | Comprehensive API for workflow management, run triggering, artifact download, and status queries.              |
| 90  | **Jenkins CLI**                   | `gh` CLI with `gh workflow`, `gh run` commands                 | S          | `gh run list`, `gh run view`, `gh workflow run` provide CLI access to all workflow operations.                 |
| 91  | **Job DSL plugin**                | GitHub API + workflow YAML generation                          | M          | Programmatic pipeline creation via API. Template repositories provide a starting point.                        |
| 92  | **Configuration as Code (JCasC)** | Repository settings + organization policies + `gh` CLI scripts | M          | GitHub organization policies and repository rulesets replace JCasC for governance.                             |
| 93  | **Groovy System Scripts**         | GitHub Actions API + custom actions                            | L          | Arbitrary system administration scripts have no direct equivalent. Custom actions or API scripts replace them. |

---

## 12. CSA-in-a-Box specific mappings

| Jenkins pattern                  | GitHub Actions equivalent (CSA-in-a-Box)                            | Complexity | Notes                                                        |
| -------------------------------- | ------------------------------------------------------------------- | ---------- | ------------------------------------------------------------ |
| **Bicep deployment pipeline**    | OIDC login + `azure/arm-deploy` with what-if + environment approval | M          | Reference: CSA-in-a-Box Bicep deploy workflow pattern        |
| **dbt test pipeline**            | `dbt test` + `dbt build --select state:modified+` in PR check       | S          | State-based selection ensures only changed models are tested |
| **ADF pipeline trigger**         | `az datafactory pipeline create-run` in workflow step               | S          | Trigger ADF pipelines and poll for completion                |
| **Purview classification audit** | `az purview` CLI commands in compliance workflow                    | S          | Verify data classifications match expected patterns          |
| **Checkov IaC scanning**         | `bridgecrewio/checkov-action@v12`                                   | XS         | Drop-in action for Bicep/ARM security scanning               |
| **MkDocs deployment**            | `actions/deploy-pages` with `mkdocs build`                          | XS         | Direct mapping for documentation CI/CD                       |

---

## Migration priority matrix

Use this matrix to prioritize which pipelines to migrate first based on complexity and value.

| Priority | Pipeline type                     | Complexity | Value of migration                          | Recommendation                      |
| -------- | --------------------------------- | ---------- | ------------------------------------------- | ----------------------------------- |
| 1        | Simple build + test               | XS--S      | High (quick win, builds confidence)         | Migrate first                       |
| 2        | Build + deploy to dev/staging     | S          | High (demonstrates OIDC, environments)      | Migrate second                      |
| 3        | Multi-stage with Docker           | S--M       | Medium (validates container patterns)       | Migrate third                       |
| 4        | Matrix/parallel builds            | S          | Medium (validates matrix strategy)          | Migrate with batch 2--3             |
| 5        | Production deployment             | M          | High (validates security, approvals)        | Migrate after dev/staging validated |
| 6        | Shared library consumers          | M          | Medium (requires reusable workflow library) | Migrate after library is built      |
| 7        | Complex scripted pipelines        | L          | Lower (requires significant rework)         | Migrate last                        |
| 8        | Highly customized (niche plugins) | L--XL      | Varies                                      | Evaluate case-by-case               |

---

## Next steps

1. **Identify your pipeline inventory** --- Classify each pipeline using the complexity ratings above.
2. **Start with Priority 1 pipelines** --- Follow the [Pipeline Migration Guide](pipeline-migration.md) for step-by-step conversion.
3. **Map your plugins** --- Use the [Plugin Migration Reference](plugin-migration.md) to find action equivalents.
4. **Plan credential migration** --- Follow the [Secret Migration Guide](secret-migration.md) for OIDC setup.
