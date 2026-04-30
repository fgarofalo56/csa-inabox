# Agent Migration --- Jenkins Agents to GitHub Runners

**Audience:** Platform Engineer, DevOps Engineer, Infrastructure Engineer
**Reading time:** 12 minutes
**Last updated:** 2026-04-30

---

## Overview

Jenkins build infrastructure consists of a controller (master) and one or more agents (slaves/nodes) that execute pipeline steps. Migrating to GitHub Actions means replacing this infrastructure with GitHub runners --- either GitHub-hosted (managed by GitHub) or self-hosted (managed by you). This guide covers the migration path for both options, including the Actions Runner Controller (ARC) for Kubernetes-native autoscaling.

---

## 1. Architecture comparison

### Jenkins agent architecture

```
Jenkins Controller (VM/container)
├── Permanent Agent 1 (VM, always-on, SSH/JNLP)
├── Permanent Agent 2 (VM, always-on, SSH/JNLP)
├── Cloud Agent (Docker, spun up per build)
├── Cloud Agent (Kubernetes pod, spun up per build)
└── Static Agent (bare metal, special hardware)
```

- The controller manages job scheduling, plugin execution, and web UI.
- Agents connect to the controller via SSH or JNLP (inbound/outbound).
- Agents are typically long-lived VMs that accumulate state over time.
- Scaling requires manual agent provisioning or cloud plugin configuration.

### GitHub runner architecture

```
GitHub.com / GitHub Enterprise
├── Hosted Runner Pool (managed by GitHub)
│   ├── ubuntu-latest (2-core, 7 GB RAM)
│   ├── ubuntu-latest (4/8/16/32/64-core)
│   ├── windows-latest (2-core, 7 GB RAM)
│   └── macos-latest (3-core M1)
├── Self-Hosted Runner (VM, registered to org/repo)
│   ├── Linux runner (any distribution)
│   ├── Windows runner
│   └── macOS runner
└── ARC Runner (Kubernetes pod, ephemeral)
    ├── Scale Set 1 (Linux, auto-scale 0-20)
    └── Scale Set 2 (Windows, auto-scale 0-10)
```

- Hosted runners are managed by GitHub --- no infrastructure to maintain.
- Self-hosted runners connect outbound to GitHub (no inbound ports needed).
- ARC runners are ephemeral Kubernetes pods that scale to zero.

---

## 2. Hosted runners --- zero infrastructure

### When to use hosted runners

- Standard build toolchains (Node.js, Python, .NET, Java, Go, Rust)
- No private network access required
- No specialized hardware requirements
- Acceptable build times with 2-core to 64-core machines
- Want zero infrastructure management

### Available runner images

| Runner label            | OS                  | vCPU   | RAM   | Storage    | Pre-installed tools                                                       |
| ----------------------- | ------------------- | ------ | ----- | ---------- | ------------------------------------------------------------------------- |
| `ubuntu-latest`         | Ubuntu 22.04        | 2      | 7 GB  | 14 GB SSD  | Docker, Node, Python, Java, .NET, Go, Azure CLI, kubectl, Terraform, Helm |
| `ubuntu-24.04`          | Ubuntu 24.04        | 2      | 7 GB  | 14 GB SSD  | Same as above, newer versions                                             |
| `windows-latest`        | Windows Server 2022 | 2      | 7 GB  | 14 GB SSD  | Visual Studio, .NET, Node, Python, Java, Azure CLI, PowerShell            |
| `macos-latest`          | macOS 14 (Sonoma)   | 3 (M1) | 7 GB  | 14 GB SSD  | Xcode, CocoaPods, Node, Python, Ruby                                      |
| `ubuntu-latest-4-core`  | Ubuntu 22.04        | 4      | 16 GB | 150 GB SSD | Same as ubuntu-latest                                                     |
| `ubuntu-latest-8-core`  | Ubuntu 22.04        | 8      | 32 GB | 300 GB SSD | Same as ubuntu-latest                                                     |
| `ubuntu-latest-16-core` | Ubuntu 22.04        | 16     | 64 GB | 600 GB SSD | Same as ubuntu-latest                                                     |

### Larger runners (GitHub Team and Enterprise)

Larger runners provide more CPU, RAM, and SSD for compute-intensive builds. Configure them in your organization settings under **Actions > Runners > New runner > GitHub-hosted**.

```yaml
jobs:
    build:
        runs-on: ubuntu-latest-16-core # 16 vCPU, 64 GB RAM
        steps:
            - uses: actions/checkout@v4
            - run: make build # Faster parallel compilation
```

---

## 3. Self-hosted runners --- full control

### When to use self-hosted runners

- **Private network access** --- Deploying to Azure resources behind a VNet or private endpoint
- **Compliance boundaries** --- Build compute must reside in specific Azure Government regions
- **Specialized hardware** --- GPU for ML model training, FPGA, ARM architecture
- **Custom software** --- Licensed tools (e.g., Oracle client, SAP drivers) that cannot be installed dynamically
- **Cost optimization** --- High-volume builds where per-minute pricing exceeds fixed infrastructure cost

### Setting up a self-hosted runner on Linux

**Step 1: Create the runner VM**

```bash
# Azure CLI --- create a runner VM
az vm create \
  --resource-group rg-runners \
  --name runner-linux-01 \
  --image Ubuntu2204 \
  --size Standard_D4s_v5 \
  --admin-username runner \
  --generate-ssh-keys \
  --nsg-rule NONE  # No inbound ports needed
```

**Step 2: Install the runner software**

```bash
# Download and configure (replace with actual token from GitHub)
mkdir actions-runner && cd actions-runner
curl -o actions-runner-linux-x64-2.321.0.tar.gz -L \
  https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-x64-2.321.0.tar.gz
tar xzf actions-runner-linux-x64-2.321.0.tar.gz

# Configure
./config.sh \
  --url https://github.com/YOUR-ORG \
  --token YOUR_REGISTRATION_TOKEN \
  --labels linux,azure,d4sv5 \
  --runnergroup default

# Install and start as service
sudo ./svc.sh install
sudo ./svc.sh start
```

**Step 3: Use in workflows**

```yaml
jobs:
    deploy:
        runs-on: [self-hosted, linux, azure]
        steps:
            - uses: actions/checkout@v4
            - run: az deployment group create ...
```

### Setting up a self-hosted runner on Windows

```powershell
# Download runner package
mkdir C:\actions-runner ; cd C:\actions-runner
Invoke-WebRequest -Uri https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-win-x64-2.321.0.zip -OutFile actions-runner-win-x64.zip
Expand-Archive -Path actions-runner-win-x64.zip -DestinationPath .

# Configure
.\config.cmd --url https://github.com/YOUR-ORG --token YOUR_TOKEN --labels windows,dotnet

# Install as Windows service
.\svc.cmd install
.\svc.cmd start
```

### Runner labels

Labels allow workflows to target specific runners based on capabilities.

```yaml
# Target a runner with GPU
runs-on: [self-hosted, linux, gpu]

# Target a runner in Azure Government
runs-on: [self-hosted, linux, azure-gov, eastus]

# Target a Windows runner with .NET 8
runs-on: [self-hosted, windows, dotnet8]
```

**Recommended labeling strategy:**

| Label category | Examples                         | Purpose                         |
| -------------- | -------------------------------- | ------------------------------- |
| OS             | `linux`, `windows`, `macos`      | OS targeting                    |
| Cloud region   | `azure-gov`, `eastus`, `westus2` | Geographic/compliance targeting |
| Capabilities   | `gpu`, `docker`, `dotnet8`       | Hardware/software targeting     |
| Size           | `small`, `medium`, `large`       | Resource tier targeting         |
| Team           | `platform`, `data-eng`, `ml`     | Team isolation                  |

### Runner groups

Runner groups (organization level) control which repositories can use which runners. This is critical for multi-tenant organizations.

```
Organization: my-org
├── Runner Group: platform-runners
│   ├── Repos: infra-repo, platform-repo
│   └── Runners: runner-01, runner-02
├── Runner Group: data-eng-runners
│   ├── Repos: dbt-repo, adf-repo
│   └── Runners: runner-03, runner-04
└── Runner Group: ml-runners
    ├── Repos: ml-repo
    └── Runners: gpu-runner-01
```

---

## 4. Actions Runner Controller (ARC) --- Kubernetes-native autoscaling

ARC is the recommended approach for organizations that need self-hosted runners at scale. It deploys runners as ephemeral Kubernetes pods that scale based on workflow demand.

### Why ARC over static self-hosted runners

| Dimension        | Static self-hosted               | ARC (Kubernetes)                 |
| ---------------- | -------------------------------- | -------------------------------- |
| Scaling          | Manual (add/remove VMs)          | Automatic (pod autoscaling)      |
| Idle cost        | Full VM cost even when idle      | Scale to zero when no jobs       |
| State management | State accumulates between builds | Ephemeral pods (clean every run) |
| OS patching      | Manual for each VM               | Update container image           |
| Infrastructure   | VMs or bare metal                | Kubernetes cluster (AKS)         |
| Setup complexity | Low per runner                   | Medium (one-time K8s setup)      |

### Installing ARC on AKS

**Prerequisites:**

- An AKS cluster (1.25+)
- Helm 3.x
- A GitHub App or Personal Access Token with `admin:org` scope

**Step 1: Install the ARC controller**

```bash
# Add the Helm repository
helm repo add actions-runner-controller \
  https://actions-runner-controller.github.io/actions-runner-controller
helm repo update

# Install the controller
helm install arc \
  --namespace arc-system \
  --create-namespace \
  actions-runner-controller/gha-runner-scale-set-controller
```

**Step 2: Create a runner scale set**

```bash
# Create a GitHub App and note the App ID, Installation ID, and private key

# Install a runner scale set
helm install arc-runner-set \
  --namespace arc-runners \
  --create-namespace \
  actions-runner-controller/gha-runner-scale-set \
  --set githubConfigUrl="https://github.com/YOUR-ORG" \
  --set githubConfigSecret.github_app_id="12345" \
  --set githubConfigSecret.github_app_installation_id="67890" \
  --set githubConfigSecret.github_app_private_key="$(cat private-key.pem)" \
  --set minRunners=0 \
  --set maxRunners=20 \
  --set containerMode.type="dind"
```

**Step 3: Use ARC runners in workflows**

```yaml
jobs:
    build:
        runs-on: arc-runner-set # Matches the Helm release name
        steps:
            - uses: actions/checkout@v4
            - run: make build
```

### ARC runner images

ARC runners use container images. The default image is `ghcr.io/actions/actions-runner`, but you can create custom images with your tool requirements.

```dockerfile
FROM ghcr.io/actions/actions-runner:latest

# Install additional tools
RUN sudo apt-get update && sudo apt-get install -y \
    azure-cli \
    python3-pip \
    && pip3 install dbt-databricks

# Install Bicep
RUN az bicep install
```

### ARC with Docker-in-Docker (DinD)

For workflows that build Docker images, ARC supports Docker-in-Docker mode:

```yaml
# In Helm values
containerMode:
    type: dind

template:
    spec:
        containers:
            - name: runner
              image: ghcr.io/actions/actions-runner:latest
              resources:
                  requests:
                      cpu: "2"
                      memory: "4Gi"
                  limits:
                      cpu: "4"
                      memory: "8Gi"
```

---

## 5. Ephemeral runners --- security best practice

Ephemeral runners are the default for hosted runners and the recommended configuration for self-hosted runners. An ephemeral runner picks up a single job, executes it, and then unregisters itself.

### Benefits

- **No state leakage** --- Secrets, environment variables, and filesystem state from one job cannot be accessed by the next.
- **No credential persistence** --- Even if a job is compromised, the runner is destroyed after the job completes.
- **Clean environment** --- No accumulated state from previous builds (no "works on my runner" debugging).

### Configuring ephemeral mode

```bash
# Register runner as ephemeral
./config.sh \
  --url https://github.com/YOUR-ORG \
  --token YOUR_TOKEN \
  --ephemeral
```

With ARC, all runners are ephemeral by default (pods are deleted after job completion).

---

## 6. Jenkins agent to runner migration mapping

| Jenkins agent type                          | GitHub runner equivalent                        | Migration approach                                                      |
| ------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| **Permanent SSH agent** (Linux VM)          | Self-hosted runner on Linux VM                  | Install runner software on existing VM; re-label                        |
| **Permanent JNLP agent** (Windows VM)       | Self-hosted runner on Windows VM                | Install runner software; configure as service                           |
| **Docker cloud agent** (ephemeral)          | ARC runner (Kubernetes pod) or hosted runner    | Deploy ARC on AKS for ephemeral runners                                 |
| **Kubernetes cloud agent**                  | ARC runner (direct mapping)                     | Migrate pod templates to ARC runner scale sets                          |
| **macOS agent** (Mac Mini)                  | Self-hosted macOS runner or hosted macOS runner | Hosted macOS runners may suffice; self-host for specific Xcode versions |
| **EC2 cloud agent** (AWS plugin)            | ARC on AKS, or hosted runners                   | Replace AWS-based autoscaling with ARC or GitHub-hosted                 |
| **Azure VM agent** (Azure VM Agents plugin) | ARC on AKS, or self-hosted on Azure VM          | ARC preferred; existing VMs can be converted to self-hosted runners     |
| **Bare metal agent** (GPU, FPGA)            | Self-hosted runner on same hardware             | Install runner software alongside existing tools                        |

---

## 7. Security considerations for self-hosted runners

### Network security

Self-hosted runners initiate outbound HTTPS connections to GitHub. No inbound ports are required.

Required outbound connectivity:

| Destination                               | Port | Purpose                    |
| ----------------------------------------- | ---- | -------------------------- |
| `github.com`                              | 443  | API communication          |
| `api.github.com`                          | 443  | REST API                   |
| `*.actions.githubusercontent.com`         | 443  | Action downloads           |
| `ghcr.io`                                 | 443  | Container image pulls      |
| `pipelines.actions.githubusercontent.com` | 443  | Workflow run communication |

### Runner hardening

1. **Use ephemeral runners** --- Prevent state leakage between jobs.
2. **Run as non-root** --- The runner process should not run as root.
3. **Use runner groups** --- Restrict which repositories can use which runners.
4. **Limit repository access** --- Do not register runners at the organization level unless necessary; prefer repository-level registration.
5. **Monitor runner activity** --- Audit logs show which jobs ran on which runners.
6. **Update regularly** --- The runner software auto-updates, but custom images need periodic rebuilds.

### Comparison with Jenkins agent security

| Security dimension   | Jenkins agents                                    | GitHub self-hosted runners                       |
| -------------------- | ------------------------------------------------- | ------------------------------------------------ |
| Connection direction | Inbound (SSH) or outbound (JNLP)                  | Outbound only (HTTPS)                            |
| Credential exposure  | Agent has access to all credentials on controller | Runner only receives secrets for the current job |
| State isolation      | Manual cleanup; state persists by default         | Ephemeral mode destroys state after each job     |
| Access control       | Agent-level permissions via plugins               | Runner groups restrict repository access         |
| Auto-update          | Manual (controller manages agent version)         | Automatic (runner software self-updates)         |

---

## 8. Cost comparison --- Jenkins agents vs GitHub runners

| Configuration                            | Monthly cost       | Build capacity          | Idle cost        |
| ---------------------------------------- | ------------------ | ----------------------- | ---------------- |
| **Jenkins:** 4 permanent agents (D4s_v5) | $560               | 4 concurrent builds     | $560 (always on) |
| **GitHub hosted:** Pay per minute        | ~$160 (20K min/mo) | Unlimited concurrent    | $0               |
| **GitHub self-hosted:** 4 VMs            | $560               | 4 concurrent builds     | $560 (always on) |
| **ARC on AKS:** 0--20 runners            | ~$80--$400         | 0--20 concurrent builds | ~$80 (AKS base)  |

ARC provides the best cost profile for variable workloads because runners scale to zero when idle and scale up within seconds when jobs are queued.

---

## 9. Migration steps

### Step 1: Inventory Jenkins agents

```bash
# List all Jenkins agents via API
curl -s https://jenkins.example.com/computer/api/json?pretty=true \
  -u admin:TOKEN | jq '.computer[] | {name: .displayName, offline: .offline, labels: .assignedLabels[].name}'
```

Document each agent's OS, labels, installed tools, and which pipelines use it.

### Step 2: Classify agents by migration target

For each agent, determine whether to use hosted runners, self-hosted runners, or ARC.

### Step 3: Set up runner infrastructure

Deploy self-hosted runners and/or ARC as needed. Register runners with appropriate labels.

### Step 4: Update workflow YAML

Replace Jenkins agent labels with GitHub runner labels in converted workflow files.

### Step 5: Validate and decommission

Run dual (Jenkins + GitHub Actions) for 2--4 weeks, then decommission Jenkins agents.

---

## Next steps

1. **Migrate credentials first** --- [Secret Migration Guide](secret-migration.md) covers OIDC setup, which affects runner configuration.
2. **Convert pipelines** --- [Pipeline Migration Guide](pipeline-migration.md) covers the Jenkinsfile-to-YAML conversion.
3. **Review benchmarks** --- [Benchmarks](benchmarks.md) compares build times across runner types.
4. **Apply security hardening** --- [Best Practices](best-practices.md) covers runner security.
