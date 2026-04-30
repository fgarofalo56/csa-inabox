# Migrating from Jenkins to GitHub Actions (and Azure DevOps)

**Status:** Authored 2026-04-30
**Audience:** Federal DevOps leads, platform engineers, CI/CD administrators, and engineering managers running Jenkins infrastructure who are evaluating or executing a migration to GitHub Actions or Azure DevOps Pipelines.
**Scope:** Jenkins CI/CD pipelines, plugins, agents, credentials, and automation --- migrating to GitHub Actions (primary) or Azure DevOps Pipelines (alternative) for cloud-native CI/CD.

---

!!! tip "Expanded Migration Center Available"
This playbook is the concise migration reference. For the complete Jenkins migration package --- including white papers, deep-dive guides, tutorials, benchmarks, and federal-specific guidance --- visit the **[Jenkins to GitHub Actions Migration Center](jenkins-to-github-actions/index.md)**.

    **Quick links:**

    - [Why GitHub Actions (Executive Brief)](jenkins-to-github-actions/why-github-actions.md)
    - [Total Cost of Ownership Analysis](jenkins-to-github-actions/tco-analysis.md)
    - [Complete Feature Mapping (50+ concepts)](jenkins-to-github-actions/feature-mapping-complete.md)
    - [Pipeline Migration Guide](jenkins-to-github-actions/pipeline-migration.md)
    - [Plugin Migration Reference](jenkins-to-github-actions/plugin-migration.md)
    - [Agent to Runner Migration](jenkins-to-github-actions/agent-migration.md)
    - [Secrets and Credentials Migration](jenkins-to-github-actions/secret-migration.md)
    - [Azure DevOps Alternative](jenkins-to-github-actions/azure-devops-migration.md)
    - [Federal Migration Guide](jenkins-to-github-actions/federal-migration-guide.md)
    - [Tutorials](jenkins-to-github-actions/index.md#tutorials)
    - [Benchmarks](jenkins-to-github-actions/benchmarks.md)
    - [Best Practices](jenkins-to-github-actions/best-practices.md)

---

## 1. Executive summary

Jenkins remains the most widely deployed CI/CD platform, commanding roughly half of the global CI/CD market. It is battle-tested, extensible through 1,800+ plugins, and runs everywhere --- on-premises, in containers, on VMs, and in the cloud. For many federal agencies and enterprises, Jenkins is the CI/CD platform that "just works."

The reasons to move are rarely about Jenkins being broken. They are forcing functions: the operational burden of maintaining Jenkins controllers and agents at scale, the security surface created by hundreds of community plugins with inconsistent maintenance, the cost of dedicated Jenkins administrators, the lack of native integration with modern developer workflows (pull requests, code scanning, Copilot), and the convergence of source control and CI/CD onto a single platform that GitHub Actions and Azure DevOps represent.

**CSA-in-a-Box uses GitHub Actions** for its CI/CD pipeline --- Bicep infrastructure-as-code deployments, dbt model testing, data pipeline validation, and compliance checks all run as GitHub Actions workflows. Migrating from Jenkins to GitHub Actions aligns your CI/CD with the CSA-in-a-Box reference implementation.

### Why migrate now

| Driver               | Jenkins today                                                                  | GitHub Actions / Azure DevOps                                                |
| -------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Operational overhead | Self-hosted controller + agents; OS patching, JVM upgrades, plugin conflicts   | Fully managed runners; zero infrastructure for hosted option                 |
| Security posture     | Plugin supply-chain risk; credential sprawl across freestyle and pipeline jobs | Dependabot, secret scanning, code scanning, OIDC federation, SLSA provenance |
| Developer experience | Separate UI; context-switching between SCM and CI                              | Native in-repo workflows; PR checks; Copilot code suggestions in workflows   |
| Cost model           | Infrastructure + FTE admin cost; hard to attribute per-team                    | Per-minute billing; free tier for public repos; clear cost attribution       |
| AI integration       | Limited; third-party plugins                                                   | GitHub Copilot for workflow authoring; Copilot Autofix for security findings |
| Federal compliance   | Customer-managed FedRAMP evidence                                              | GitHub Enterprise Cloud with data residency; Azure DevOps FedRAMP High       |

---

## 2. Decision matrix --- GitHub Actions vs Azure DevOps vs Hybrid

Before migrating, choose your target platform.

| Factor                     | GitHub Actions                     | Azure DevOps Pipelines                | Hybrid (both)                   |
| -------------------------- | ---------------------------------- | ------------------------------------- | ------------------------------- |
| Source code on GitHub      | Best fit                           | Viable (mirror repos)                 | Common during transition        |
| Source code on Azure Repos | Possible (mirror)                  | Best fit                              | Depends on direction            |
| Copilot integration        | Native                             | Limited (via extensions)              | GitHub for dev, ADO for release |
| Marketplace ecosystem      | 20,000+ actions                    | ~1,200 extensions                     | Use both                        |
| Self-hosted runners        | Yes (ARC for K8s)                  | Yes (scale-set agents)                | Shared pool possible            |
| YAML pipeline syntax       | GitHub Actions YAML                | Azure Pipelines YAML                  | Two syntaxes                    |
| Deployment environments    | Environments with protection rules | Environments with approvals and gates | Separate                        |
| Artifact management        | GitHub Packages, Artifacts         | Azure Artifacts                       | Choose one                      |
| Federal (FedRAMP)          | GHEC with data residency           | Azure DevOps FedRAMP High             | Both covered                    |
| IL4/IL5 workloads          | Self-hosted runners in Gov         | Azure DevOps Server (on-prem)         | ADO Server for IL5              |
| CSA-in-a-Box alignment     | Direct (repo uses GH Actions)      | Supported                             | GH Actions primary              |

**Recommendation for CSA-in-a-Box adopters:** GitHub Actions as the primary CI/CD platform, with Azure DevOps as an option for organizations with existing ADO investment or strict IL4/IL5 on-premises requirements.

---

## 3. Migration phases

### Phase 1: Assess (Weeks 1--2)

1. **Inventory Jenkins** --- Count controllers, agents, jobs, pipelines, plugins, credentials.
2. **Run GitHub Actions Importer audit** --- `gh actions-importer audit jenkins` generates a migration readiness report.
3. **Identify pipeline tiers** --- Classify pipelines by complexity (simple freestyle, declarative pipeline, scripted pipeline with shared libraries).
4. **Map credentials** --- Document every Jenkins credential (username/password, SSH key, secret text, certificate) and its target (Azure, AWS, Docker Hub, SonarQube).
5. **Assess plugin usage** --- Export installed plugins; cross-reference against the [Plugin Migration Reference](jenkins-to-github-actions/plugin-migration.md).

### Phase 2: Pilot (Weeks 3--4)

1. **Pick 3--5 representative pipelines** --- One simple build, one multi-stage deployment, one with Docker, one with parallel stages.
2. **Convert with Actions Importer** --- `gh actions-importer dry-run jenkins` to generate initial workflow YAML.
3. **Refine manually** --- Add OIDC auth, matrix strategy, caching, and Copilot-suggested improvements.
4. **Dual-run** --- Both Jenkins and GitHub Actions run in parallel; compare results.
5. **Validate** --- Confirm build artifacts, test results, deployment outcomes match.

### Phase 3: Migrate (Weeks 5--10)

1. **Migrate pipeline-by-pipeline** --- Start with lowest-risk pipelines; progress to critical deployments.
2. **Migrate credentials** --- Move Jenkins credentials to GitHub Secrets (repo, environment, organization level) or configure OIDC federation.
3. **Migrate agents to runners** --- Replace Jenkins agents with self-hosted runners where hosted runners are insufficient.
4. **Decommission Jenkins jobs** --- Disable migrated Jenkins jobs; keep read-only for audit trail.
5. **Update documentation** --- Point runbooks and onboarding guides to GitHub Actions.

### Phase 4: Optimize (Weeks 11--12)

1. **Build reusable workflow library** --- Extract common patterns into `.github/workflows/` reusable workflows.
2. **Implement security hardening** --- Pin action versions to SHA, enable Dependabot for actions, configure branch protection rules.
3. **Configure monitoring** --- GitHub Actions usage reports; workflow duration dashboards.
4. **Decommission Jenkins infrastructure** --- Shut down controllers and agents after 30-day parallel-run validation.

---

## 4. Quick-reference --- Jenkinsfile to GitHub Actions

| Jenkins concept                        | GitHub Actions equivalent                               |
| -------------------------------------- | ------------------------------------------------------- |
| `Jenkinsfile`                          | `.github/workflows/*.yml`                               |
| `pipeline { }`                         | Top-level workflow YAML                                 |
| `agent any`                            | `runs-on: ubuntu-latest`                                |
| `agent { docker { image 'node:18' } }` | `container: node:18` in job                             |
| `stages { stage('Build') { } }`        | `jobs:` with named jobs                                 |
| `steps { sh 'make' }`                  | `steps:` with `run: make`                               |
| `parallel { }`                         | Matrix strategy or multiple jobs                        |
| `post { always { } }`                  | `if: always()` on step                                  |
| `post { failure { } }`                 | `if: failure()` on step                                 |
| `environment { VAR = 'val' }`          | `env:` block at workflow/job/step level                 |
| `parameters { string(...) }`           | `workflow_dispatch: inputs:`                            |
| `when { branch 'main' }`               | `on: push: branches: [main]` or `if:` expression        |
| `credentials('my-secret')`             | `${{ secrets.MY_SECRET }}`                              |
| `stash/unstash`                        | `actions/upload-artifact` / `actions/download-artifact` |
| `@Library('shared')`                   | Reusable workflows / composite actions                  |
| Multibranch Pipeline                   | Event triggers (`push`, `pull_request`)                 |
| Blue Ocean UI                          | GitHub Actions tab in repository                        |
| Jenkins Nodes                          | Self-hosted runners                                     |
| Build parameters                       | `workflow_dispatch` inputs                              |
| Cron trigger                           | `schedule:` with cron syntax                            |

---

## 5. CSA-in-a-Box CI/CD patterns on GitHub Actions

CSA-in-a-Box ships reference GitHub Actions workflows for:

| Workflow                     | Purpose                                          | Key actions                                                    |
| ---------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| **Bicep What-If**            | Preview infrastructure changes before deployment | `azure/login`, `azure/arm-deploy` with `--what-if`             |
| **Bicep Deploy**             | Deploy Azure infrastructure via Bicep            | OIDC auth, environment approvals, `az deployment group create` |
| **dbt Test**                 | Validate data models on pull request             | `dbt test`, `dbt build --select state:modified+`               |
| **Data Pipeline Validation** | End-to-end data pipeline smoke tests             | ADF trigger, row-count assertions, schema validation           |
| **Compliance Check**         | NIST/FedRAMP control evidence                    | Checkov, `az policy compliance`, Purview classification audit  |
| **MkDocs Deploy**            | Publish documentation to GitHub Pages            | `mkdocs build`, `actions/deploy-pages`                         |

---

## 6. Common pitfalls

1. **Attempting a big-bang migration** --- Migrate pipeline-by-pipeline, not all at once.
2. **Ignoring shared libraries** --- Jenkins shared libraries need deliberate re-architecture into reusable workflows or composite actions.
3. **Storing secrets in workflow files** --- Use GitHub Secrets and OIDC; never hardcode credentials.
4. **Not pinning action versions** --- Use SHA-pinned references (`actions/checkout@a5ac7e...`) instead of tags to prevent supply-chain attacks.
5. **Over-using self-hosted runners** --- Start with GitHub-hosted runners; only self-host when you need private network access, GPU, or specific compliance boundaries.
6. **Skipping the dual-run period** --- Run Jenkins and GitHub Actions in parallel for at least two weeks to validate parity.

---

## 7. Resources

| Resource                      | Link                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| Migration Center (all guides) | [Jenkins to GitHub Actions Migration Center](jenkins-to-github-actions/index.md)           |
| GitHub Actions Importer CLI   | [Tutorial: Actions Importer](jenkins-to-github-actions/tutorial-actions-importer.md)       |
| Pipeline Conversion Tutorial  | [Tutorial: Pipeline Conversion](jenkins-to-github-actions/tutorial-pipeline-conversion.md) |
| Federal Migration Guide       | [Federal Guide](jenkins-to-github-actions/federal-migration-guide.md)                      |
| Azure DevOps Alternative      | [Azure DevOps Migration](jenkins-to-github-actions/azure-devops-migration.md)              |
| Plugin Mapping                | [Plugin Migration Reference](jenkins-to-github-actions/plugin-migration.md)                |
| Benchmarks                    | [Performance Benchmarks](jenkins-to-github-actions/benchmarks.md)                          |
| Best Practices                | [Best Practices](jenkins-to-github-actions/best-practices.md)                              |

---

## 8. Next steps

1. **Read the executive brief** --- [Why GitHub Actions](jenkins-to-github-actions/why-github-actions.md) for stakeholder alignment.
2. **Run the audit** --- Follow the [Actions Importer tutorial](jenkins-to-github-actions/tutorial-actions-importer.md) to assess your Jenkins estate.
3. **Estimate costs** --- Use the [TCO Analysis](jenkins-to-github-actions/tco-analysis.md) to build the business case.
4. **Start the pilot** --- Convert your first pipeline with the [Pipeline Conversion tutorial](jenkins-to-github-actions/tutorial-pipeline-conversion.md).
5. **Adopt CSA-in-a-Box patterns** --- Align your workflows with the [Best Practices](jenkins-to-github-actions/best-practices.md) and reference CI/CD patterns.
