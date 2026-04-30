# Total Cost of Ownership --- Jenkins vs GitHub Actions vs Azure DevOps

**Audience:** CFO, CIO, Procurement, DevOps Director
**Reading time:** 15 minutes
**Last updated:** 2026-04-30

---

## Executive summary

Jenkins appears "free" because it is open-source software. In practice, Jenkins is one of the most expensive CI/CD platforms to operate at scale when you account for infrastructure, administration, plugin management, security patching, and developer productivity losses. This analysis compares the true 5-year TCO of Jenkins self-hosted infrastructure against GitHub Actions (hosted and self-hosted runners) and Azure DevOps Pipelines across three organization sizes: small (10 developers, 5 pipelines), medium (50 developers, 30 pipelines), and large (200 developers, 150 pipelines).

**Key finding:** GitHub Actions reduces 5-year CI/CD TCO by 40--65% compared to self-hosted Jenkins, with the largest savings coming from eliminated infrastructure and administration costs. The break-even point where self-hosted runners become more cost-effective than hosted runners is approximately 8,000 build-minutes per month per repository.

---

## 1. Cost model comparison

### Jenkins cost components

Jenkins has no licensing fee, but the total cost of ownership includes significant hidden costs that organizations routinely underestimate.

| Cost category                   | Description                                                                                                               | Typical annual range  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Controller infrastructure**   | VM/container for Jenkins controller; HA requires 2+ controllers with shared storage                                       | $2,400--$24,000       |
| **Agent infrastructure**        | VMs/containers for build agents; sized per concurrent build capacity                                                      | $6,000--$120,000      |
| **OS licensing**                | Windows Server licenses for Windows build agents                                                                          | $0--$18,000           |
| **Storage**                     | Build artifacts, workspace storage, log retention                                                                         | $1,200--$12,000       |
| **Networking**                  | Load balancers, VPN/private endpoints, egress                                                                             | $600--$6,000          |
| **Administration FTE**          | Jenkins admin: plugin management, upgrades, security patches, user management, troubleshooting                            | $40,000--$160,000     |
| **Plugin maintenance**          | Testing plugin compatibility after upgrades, resolving conflicts, security patches                                        | Included in admin FTE |
| **Security remediation**        | Patching vulnerable plugins, rotating leaked credentials, incident response                                               | $5,000--$50,000       |
| **Developer productivity loss** | Waiting for builds due to agent contention, debugging plugin issues, context-switching between Jenkins UI and code review | $10,000--$200,000     |
| **Backup and DR**               | Backing up Jenkins home directory, configuration-as-code export, tested restoration                                       | $1,200--$6,000        |

### GitHub Actions cost components

| Cost category                | Description                                                                                 | Typical annual range |
| ---------------------------- | ------------------------------------------------------------------------------------------- | -------------------- |
| **GitHub plan**              | Free (public repos), Team ($4/user/month), Enterprise ($21/user/month)                      | $0--$50,400          |
| **Hosted runner minutes**    | Ubuntu: $0.008/min; Windows: $0.016/min; macOS: $0.08/min; larger runners: up to $0.064/min | $0--$60,000          |
| **Self-hosted runner infra** | VMs/AKS for self-hosted runners (only if needed for private network, GPU, or compliance)    | $0--$48,000          |
| **GitHub Actions storage**   | Artifacts and caching: 500 MB--50 GB included; overage at $0.25/GB/month                    | $0--$1,200           |
| **GitHub Packages**          | Container registry and package hosting: 500 MB--50 GB included                              | $0--$2,400           |
| **Administration**           | Minimal --- no server management, no plugin updates, no OS patching                         | $0--$10,000          |

### Azure DevOps cost components

| Cost category               | Description                                                                           | Typical annual range |
| --------------------------- | ------------------------------------------------------------------------------------- | -------------------- |
| **Azure DevOps plan**       | Free (5 users), Basic ($6/user/month), Basic + Test Plans ($52/user/month)            | $0--$124,800         |
| **Microsoft-hosted agents** | First parallel job free; additional at $40/month/parallel job                         | $0--$9,600           |
| **Self-hosted agents**      | First parallel job free; additional at $15/month/parallel job + infrastructure        | $0--$48,000          |
| **Azure Artifacts**         | 2 GB free; additional at $2/GB/month                                                  | $0--$2,400           |
| **Administration**          | Lower than Jenkins; higher than GitHub Actions (service connections, variable groups) | $5,000--$40,000      |

---

## 2. Five-year TCO by organization size

### Small organization (10 developers, 5 pipelines, ~2,000 build-minutes/month)

| Cost item                  | Jenkins (5-year)  | GitHub Actions (5-year) | Azure DevOps (5-year)   |
| -------------------------- | ----------------- | ----------------------- | ----------------------- |
| Platform licensing         | $0                | $2,400 (Team)           | $3,600 (Basic)          |
| Infrastructure             | $42,000           | $0 (hosted runners)     | $0 (Microsoft-hosted)   |
| Compute (build minutes)    | Included in infra | $960                    | $2,400 (1 parallel job) |
| Storage                    | $6,000            | $0 (within free tier)   | $0 (within free tier)   |
| Administration (0.1 FTE)   | $60,000           | $5,000                  | $15,000                 |
| Security/remediation       | $10,000           | $0 (native scanning)    | $2,500                  |
| Developer productivity     | $25,000           | $0                      | $5,000                  |
| **Total 5-year TCO**       | **$143,000**      | **$8,360**              | **$28,500**             |
| **Per developer per year** | **$2,860**        | **$167**                | **$570**                |

### Medium organization (50 developers, 30 pipelines, ~15,000 build-minutes/month)

| Cost item                  | Jenkins (5-year)  | GitHub Actions (5-year)    | Azure DevOps (5-year)    |
| -------------------------- | ----------------- | -------------------------- | ------------------------ |
| Platform licensing         | $0                | $12,000 (Team)             | $18,000 (Basic)          |
| Infrastructure             | $180,000          | $12,000 (some self-hosted) | $6,000 (2 parallel jobs) |
| Compute (build minutes)    | Included in infra | $7,200                     | $4,800                   |
| Storage                    | $18,000           | $3,000                     | $3,000                   |
| Administration (0.5 FTE)   | $400,000          | $25,000                    | $60,000                  |
| Security/remediation       | $50,000           | $0                         | $10,000                  |
| Developer productivity     | $100,000          | $0                         | $25,000                  |
| **Total 5-year TCO**       | **$748,000**      | **$59,200**                | **$126,800**             |
| **Per developer per year** | **$2,992**        | **$237**                   | **$507**                 |

### Large organization (200 developers, 150 pipelines, ~80,000 build-minutes/month)

| Cost item                  | Jenkins (5-year)  | GitHub Actions (5-year)               | Azure DevOps (5-year)     |
| -------------------------- | ----------------- | ------------------------------------- | ------------------------- |
| Platform licensing         | $0                | $252,000 (Enterprise)                 | $144,000 (Basic)          |
| Infrastructure             | $600,000          | $120,000 (self-hosted ARC)            | $72,000 (8 parallel jobs) |
| Compute (build minutes)    | Included in infra | $28,800 (mix of hosted + self-hosted) | $19,200                   |
| Storage                    | $60,000           | $12,000                               | $12,000                   |
| Administration (1.5 FTE)   | $1,200,000        | $75,000                               | $200,000                  |
| Security/remediation       | $250,000          | $0                                    | $50,000                   |
| Developer productivity     | $500,000          | $0                                    | $75,000                   |
| **Total 5-year TCO**       | **$2,610,000**    | **$487,800**                          | **$572,200**              |
| **Per developer per year** | **$2,610**        | **$488**                              | **$572**                  |

---

## 3. Hidden costs of Jenkins --- detailed analysis

### 3.1 Plugin maintenance tax

A typical Jenkins instance runs 50--150 plugins. Each plugin has its own release cycle, dependency chain, and security posture. The "plugin maintenance tax" includes:

- **Compatibility testing:** Every Jenkins core upgrade requires testing all installed plugins for compatibility. A major Jenkins version upgrade (e.g., Jenkins 2.x LTS) can break 10--30% of installed plugins.
- **Security patching cadence:** Jenkins publishes security advisories approximately monthly. Each advisory may affect 3--10 plugins, requiring immediate updates on production controllers.
- **Dependency conflicts:** Plugins share a single Java classpath on the controller. Version conflicts between plugins are common and can cause controller instability. Diagnosing and resolving conflicts requires Jenkins expertise.
- **Orphaned plugins:** Plugins whose maintainers have moved on receive no security updates. Organizations must either fork the plugin, find an alternative, or accept the risk.

**Estimated annual cost:** 200--800 hours of admin time ($20,000--$80,000 at $100/hour fully loaded).

### 3.2 Infrastructure sprawl

Jenkins infrastructure tends to grow organically:

- Teams request dedicated agents for specific tool versions (JDK 8, JDK 11, JDK 17, JDK 21)
- Docker-in-Docker agents for container builds
- Windows agents for .NET builds
- macOS agents for iOS builds (typically Mac Minis in a closet)
- GPU agents for ML model training
- "Snowflake" agents configured manually with undocumented dependencies

Over 3--5 years, a medium organization accumulates 15--30 agent types with inconsistent configurations. Rebuilding an agent from scratch is often impossible because the configuration was never documented.

**GitHub Actions eliminates this entirely** with hosted runners that provide clean, pre-configured environments for every job.

### 3.3 Developer productivity drain

Context-switching between Jenkins and the code review workflow costs more than organizations realize.

| Activity                    | Jenkins                                                          | GitHub Actions                                                  |
| --------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| Check build status          | Switch to Jenkins UI, find job, check console output             | See checks on PR page; click "Details" for logs                 |
| Retry a failed build        | Navigate to Jenkins, find job, click "Rebuild"                   | Click "Re-run jobs" on PR checks                                |
| Debug a failure             | Copy log from Jenkins, paste into chat/issue                     | Click "Details" to see annotated logs inline with workflow YAML |
| Understand pipeline changes | Review Jenkinsfile diff in PR + mentally map to Jenkins behavior | Review workflow YAML diff in PR; changes are self-documenting   |
| Request a deployment        | Navigate to Jenkins, select parameterized build, fill inputs     | `workflow_dispatch` with input form in GitHub Actions tab       |

**Conservative estimate:** 15--30 minutes per developer per day of context-switching overhead, or 60--120 hours per developer per year.

### 3.4 Security incident cost

Jenkins credential leaks and plugin vulnerabilities are a persistent risk. The average cost of a CI/CD security incident includes:

- **Credential rotation:** Identifying all affected credentials, rotating them across all systems, updating all pipelines ($5,000--$25,000 per incident)
- **Forensic investigation:** Determining the blast radius of a compromised Jenkins controller ($10,000--$100,000)
- **Compliance reporting:** Notifying stakeholders, filing incident reports, updating risk registers ($5,000--$20,000)

OIDC federation on GitHub Actions eliminates stored cloud credentials entirely, removing this class of incident.

---

## 4. GitHub Actions pricing details

### Hosted runner per-minute pricing (included minutes exhausted)

| Runner type                | Per-minute rate | Equivalent hourly rate |
| -------------------------- | --------------- | ---------------------- |
| Linux (2-core)             | $0.008          | $0.48                  |
| Linux (4-core)             | $0.016          | $0.96                  |
| Linux (8-core)             | $0.032          | $1.92                  |
| Linux (16-core)            | $0.064          | $3.84                  |
| Linux (32-core)            | $0.128          | $7.68                  |
| Linux (64-core)            | $0.256          | $15.36                 |
| Windows (2-core)           | $0.016          | $0.96                  |
| Windows (4-core)           | $0.032          | $1.92                  |
| Windows (8-core)           | $0.064          | $3.84                  |
| macOS (3-core M1)          | $0.08           | $4.80                  |
| macOS (12-core M1 Pro/Max) | $0.12           | $7.20                  |
| GPU (Linux, 4-core + T4)   | $0.07           | $4.20                  |

### Included minutes by plan

| Plan              | Included minutes/month | Storage included |
| ----------------- | ---------------------- | ---------------- |
| GitHub Free       | 2,000 (Linux)          | 500 MB           |
| GitHub Team       | 3,000 (Linux)          | 2 GB             |
| GitHub Enterprise | 50,000 (Linux)         | 50 GB            |

**Note:** Self-hosted runner minutes are free --- you only pay for the infrastructure you provide.

### Break-even analysis --- Hosted vs self-hosted

The break-even point depends on utilization. A self-hosted Linux runner on a D4s_v5 VM in Azure costs approximately $140/month. At $0.008/minute for hosted runners, that equals 17,500 minutes/month. If your repository uses fewer than 17,500 minutes/month, hosted runners are cheaper. If more, self-hosted may be more cost-effective.

| Monthly minutes | Hosted cost | Self-hosted cost (D4s_v5) | Recommendation |
| --------------- | ----------- | ------------------------- | -------------- |
| 2,000           | $16         | $140                      | Hosted         |
| 5,000           | $40         | $140                      | Hosted         |
| 10,000          | $80         | $140                      | Hosted         |
| 17,500          | $140        | $140                      | Break-even     |
| 30,000          | $240        | $140                      | Self-hosted    |
| 50,000          | $400        | $140                      | Self-hosted    |
| 100,000         | $800        | $280 (2 VMs)              | Self-hosted    |

For organizations with bursty workloads (high during business hours, zero at night), ARC ephemeral runners that scale to zero provide the best cost profile --- you pay only for actual build time, not idle capacity.

---

## 5. Cost optimization strategies for GitHub Actions

### 5.1 Caching

The `actions/cache` action caches dependencies between workflow runs, reducing download time and build duration by 30--70%.

```yaml
- uses: actions/cache@v4
  with:
      path: ~/.npm
      key: ${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}
      restore-keys: |
          ${{ runner.os }}-npm-
```

**Cost impact:** A Node.js build that takes 5 minutes without caching takes 2 minutes with caching. At 100 builds/month, that saves 300 minutes/month ($2.40/month on Linux hosted).

### 5.2 Concurrency controls

Cancel in-progress workflows when a new push arrives on the same branch:

```yaml
concurrency:
    group: ${{ github.workflow }}-${{ github.ref }}
    cancel-in-progress: true
```

**Cost impact:** Eliminates wasted minutes on superseded commits. Typical savings: 10--20% of total minutes.

### 5.3 Path filtering

Only run workflows when relevant files change:

```yaml
on:
    push:
        paths:
            - "src/**"
            - "tests/**"
            - "package.json"
```

**Cost impact:** Documentation-only PRs skip CI entirely. Typical savings: 15--25% of total runs.

### 5.4 Job-level conditional execution

Skip expensive jobs (integration tests, deployment) on draft PRs:

```yaml
jobs:
    integration-test:
        if: github.event.pull_request.draft == false
        runs-on: ubuntu-latest
```

### 5.5 Right-size runners

Use 2-core runners for lint and unit tests; reserve larger runners for builds that benefit from parallelism. Most CI jobs are I/O-bound (downloading dependencies, writing artifacts), not CPU-bound.

---

## 6. Azure DevOps pricing comparison

Azure DevOps uses a different pricing model based on parallel jobs rather than per-minute billing.

| Component                     | Free tier                | Paid tier                |
| ----------------------------- | ------------------------ | ------------------------ |
| Basic plan                    | 5 users free             | $6/user/month            |
| Microsoft-hosted parallel job | 1 free (1,800 min/month) | $40/month per additional |
| Self-hosted parallel job      | 1 free                   | $15/month per additional |
| Azure Artifacts               | 2 GB free                | $2/GB/month              |
| Azure Test Plans              | Not included             | $52/user/month           |

**Advantage over Jenkins:** Azure DevOps eliminates infrastructure management for Microsoft-hosted agents, similar to GitHub Actions hosted runners.

**Advantage over GitHub Actions:** Predictable monthly cost (per parallel job) vs variable per-minute cost. Easier budgeting for organizations with consistent build volumes.

**Disadvantage vs GitHub Actions:** The parallel job model means you pay for capacity even when idle. A team with 4 parallel jobs pays $160/month whether they run 100 builds or 10,000. GitHub Actions charges only for actual usage.

---

## 7. Federal pricing considerations

### GitHub Enterprise Cloud with data residency

GHEC with data residency is required for federal workloads that need FedRAMP-authorized CI/CD. Pricing is available through Microsoft Enterprise Agreement or direct negotiation. Typical federal contract pricing includes:

- Enterprise licensing per seat
- Included runner minutes (50,000/month)
- Advanced security (CodeQL, secret scanning, Dependabot) included in Enterprise
- Support SLA aligned with federal requirements

### Azure DevOps for government

Azure DevOps is available in Azure Government regions at the same pricing as commercial Azure DevOps. For IL4/IL5 workloads requiring on-premises CI/CD, Azure DevOps Server licenses are available through Microsoft Enterprise Agreement.

### Jenkins in federal environments

Jenkins in federal environments incurs additional costs:

- FedRAMP-authorized infrastructure (Azure Government VMs are 20--30% premium over commercial)
- Continuous Authority to Operate (ATO) maintenance for Jenkins as a system component
- Dedicated Jenkins administrators with security clearance (salary premium)
- Compliance documentation and evidence generation (manual)

---

## 8. ROI summary

| Metric                       | Small (10 dev) | Medium (50 dev) | Large (200 dev) |
| ---------------------------- | -------------- | --------------- | --------------- |
| Jenkins 5-year TCO           | $143,000       | $748,000        | $2,610,000      |
| GitHub Actions 5-year TCO    | $8,360         | $59,200         | $487,800        |
| **5-year savings**           | **$134,640**   | **$688,800**    | **$2,122,200**  |
| **TCO reduction**            | **94%**        | **92%**         | **81%**         |
| Payback period               | Immediate      | Immediate       | 2--3 months     |
| Annual savings per developer | $2,693         | $2,755          | $2,122          |

The ROI is strongest for small and medium organizations where the fixed cost of Jenkins administration is spread across fewer developers. Large organizations see lower percentage savings because GitHub Enterprise licensing is a larger line item, but the absolute savings are substantial.

---

## Next steps

1. **Calculate your specific TCO** --- Use the tables above with your actual developer count, pipeline count, and build minutes to estimate savings.
2. **Factor in qualitative benefits** --- Developer productivity, security posture improvement, and Copilot integration are difficult to quantify but often more valuable than direct cost savings.
3. **Review the migration timeline** --- [Migration Playbook](../jenkins-to-github-actions.md) for phased approach.
4. **Start with a pilot** --- Migrate 3--5 pipelines first to validate cost assumptions with real data.
