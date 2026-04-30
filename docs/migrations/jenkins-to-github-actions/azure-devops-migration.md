# Azure DevOps Pipelines --- Alternative Migration Path

**Audience:** DevOps Engineer, Platform Engineer, Engineering Manager
**Reading time:** 12 minutes
**Last updated:** 2026-04-30

---

## Overview

While GitHub Actions is the recommended CI/CD platform for CSA-in-a-Box, Azure DevOps Pipelines is a strong alternative for organizations with existing Azure DevOps investment, source code on Azure Repos, or requirements for Azure DevOps Server in on-premises IL4/IL5 environments. This guide covers migrating Jenkins pipelines to Azure DevOps Pipelines, including YAML pipeline structure, service connections, variable groups, deployment environments, and release gates.

---

## 1. When to choose Azure DevOps over GitHub Actions

| Scenario                                         | Recommendation                             |
| ------------------------------------------------ | ------------------------------------------ |
| Source code on Azure Repos, no plans to move     | Azure DevOps                               |
| Heavy use of Azure Boards for project management | Azure DevOps (tighter integration)         |
| Azure DevOps Server on-premises for IL4/IL5      | Azure DevOps (only option for on-prem ADO) |
| Need Azure Test Plans integration                | Azure DevOps                               |
| Significant existing ADO pipeline investment     | Azure DevOps (incremental migration)       |
| Need release gates with business-hour windows    | Azure DevOps (more mature gates)           |
| Source code on GitHub                            | GitHub Actions (better integration)        |
| Want Copilot CI/CD integration                   | GitHub Actions                             |
| Want largest marketplace ecosystem               | GitHub Actions                             |
| Building CSA-in-a-Box reference implementation   | GitHub Actions (native alignment)          |

---

## 2. Jenkinsfile to Azure Pipelines YAML

### Basic pipeline structure

=== "Jenkins Declarative"

    ```groovy
    pipeline {
        agent any
        stages {
            stage('Build') {
                steps {
                    sh 'npm ci && npm run build'
                }
            }
            stage('Test') {
                steps {
                    sh 'npm test'
                }
            }
            stage('Deploy') {
                when { branch 'main' }
                steps {
                    sh 'az deployment group create ...'
                }
            }
        }
    }
    ```

=== "Azure Pipelines YAML"

    ```yaml
    trigger:
      branches:
        include:
          - main
          - develop

    pool:
      vmImage: ubuntu-latest

    stages:
      - stage: Build
        jobs:
          - job: BuildJob
            steps:
              - task: NodeTool@0
                inputs:
                  versionSpec: '20.x'
              - script: npm ci && npm run build
                displayName: Build

      - stage: Test
        dependsOn: Build
        jobs:
          - job: TestJob
            steps:
              - script: npm test
                displayName: Test

      - stage: Deploy
        dependsOn: Test
        condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'))
        jobs:
          - deployment: DeployJob
            environment: production
            strategy:
              runOnce:
                deploy:
                  steps:
                    - task: AzureCLI@2
                      inputs:
                        azureSubscription: 'my-azure-connection'
                        scriptType: bash
                        scriptLocation: inlineScript
                        inlineScript: |
                          az deployment group create \
                            --resource-group rg-csa-prod \
                            --template-file main.bicep
    ```

### Key syntax differences

| Concept               | Jenkins                                | Azure DevOps                                              |
| --------------------- | -------------------------------------- | --------------------------------------------------------- |
| Pipeline file         | `Jenkinsfile`                          | `azure-pipelines.yml`                                     |
| Triggers              | SCM polling or webhook                 | `trigger:` for CI, `pr:` for PR validation                |
| Build agent           | `agent any` or `agent { label '...' }` | `pool: vmImage: ubuntu-latest` or `pool: name: MyPool`    |
| Stages                | `stages { stage('Name') { } }`         | `stages: - stage: Name`                                   |
| Steps                 | `steps { sh '...' }`                   | `steps: - script: ...` or `- task: TaskName@version`      |
| Conditions            | `when { branch 'main' }`               | `condition: eq(variables['Build.SourceBranch'], ...)`     |
| Parallel              | `parallel { }`                         | Multiple jobs in same stage (parallel by default)         |
| Parameters            | `parameters { string(...) }`           | `parameters: - name: ... type: string`                    |
| Environment variables | `environment { VAR = 'val' }`          | `variables: VAR: val`                                     |
| Credentials           | `credentials('id')`                    | Service connections + variable groups                     |
| Post actions          | `post { always { } }`                  | `condition: always()` on step, or `always()` in condition |

---

## 3. Service connections --- Replacing Jenkins credentials

Azure DevOps uses service connections to authenticate to external services. This is the equivalent of Jenkins credentials but with a more structured approach.

### Azure Resource Manager service connection

```yaml
# Reference in pipeline
- task: AzureCLI@2
  inputs:
      azureSubscription: "csa-inabox-production" # Service connection name
      scriptType: bash
      scriptLocation: inlineScript
      inlineScript: |
          az deployment group create ...
```

**Setup:**

1. Go to **Project Settings > Service connections > New service connection**
2. Select **Azure Resource Manager**
3. Choose **Workload Identity Federation (automatic)** for OIDC (recommended)
4. Or choose **Service principal (manual)** for traditional SP authentication
5. Scope to a specific subscription and resource group

### Workload Identity Federation (OIDC for Azure DevOps)

Azure DevOps supports OIDC federation similar to GitHub Actions, eliminating stored service principal secrets.

```yaml
# Workload Identity Federation service connection
- task: AzureCLI@2
  inputs:
      azureSubscription: "csa-oidc-connection" # WIF-based connection
      scriptType: bash
      scriptLocation: inlineScript
      inlineScript: az account show
```

### Other service connection types

| Jenkins credential          | Azure DevOps service connection    |
| --------------------------- | ---------------------------------- |
| Docker registry credentials | Docker Registry service connection |
| SSH key                     | SSH service connection             |
| Generic secret              | Generic service connection         |
| Kubernetes config           | Kubernetes service connection      |
| GitHub token                | GitHub service connection          |
| SonarQube token             | SonarQube service connection       |

---

## 4. Variable groups --- Centralized secret management

Variable groups in Azure DevOps provide reusable sets of variables across pipelines, similar to Jenkins folder-scoped credentials.

### Creating a variable group

```yaml
# Reference in pipeline
variables:
    - group: csa-inabox-secrets # Variable group name
    - name: ENVIRONMENT
      value: production
```

### Linking to Azure Key Vault

Variable groups can pull secrets directly from Azure Key Vault at pipeline runtime:

1. **Create variable group** linked to Key Vault
2. **Select secrets** to expose as pipeline variables
3. **Reference in pipeline** --- secrets are injected as variables

```yaml
variables:
    - group: csa-keyvault-secrets # Linked to Azure Key Vault

steps:
    - script: echo "DB connection available"
      env:
          DB_CONN: $(db-connection-string) # From Key Vault
```

This eliminates stored secrets in Azure DevOps entirely --- secrets remain in Key Vault and are fetched at runtime.

---

## 5. Deployment environments

Azure DevOps environments provide deployment tracking, approval gates, and resource targeting.

### Environment configuration

```yaml
stages:
    - stage: DeployStaging
      jobs:
          - deployment: DeployToStaging
            environment: staging
            strategy:
                runOnce:
                    deploy:
                        steps:
                            - script: echo "Deploying to staging"

    - stage: DeployProduction
      dependsOn: DeployStaging
      jobs:
          - deployment: DeployToProduction
            environment: production # Requires approval
            strategy:
                runOnce:
                    deploy:
                        steps:
                            - script: echo "Deploying to production"
```

### Approval gates

Configure approvals in **Pipelines > Environments > production > Approvals and checks**:

| Check type                     | Description                                    | Jenkins equivalent       |
| ------------------------------ | ---------------------------------------------- | ------------------------ |
| **Approvals**                  | Require specific users/groups to approve       | `input message: '...'`   |
| **Branch control**             | Only allow deployments from specific branches  | `when { branch 'main' }` |
| **Business hours**             | Only allow deployments during specified hours  | No direct equivalent     |
| **Template**                   | Require pipeline to extend a specific template | No direct equivalent     |
| **Invoke Azure function**      | Custom validation via serverless function      | Custom scripted stage    |
| **Query Azure Monitor alerts** | Block deployment if active alerts exist        | No direct equivalent     |
| **Required template**          | Enforce pipeline structure governance          | Shared library structure |

### Deployment strategies

```yaml
# Rolling deployment
strategy:
  rolling:
    maxParallel: 2
    deploy:
      steps:
        - script: deploy-to-node.sh

# Canary deployment
strategy:
  canary:
    increments: [10, 20, 50, 100]
    deploy:
      steps:
        - script: deploy-canary.sh
    on:
      success:
        steps:
          - script: promote-canary.sh
      failure:
        steps:
          - script: rollback-canary.sh
```

---

## 6. Templates --- Replacing Jenkins shared libraries

Azure DevOps templates serve the same purpose as Jenkins shared libraries --- reusable pipeline components.

### Step template

```yaml
# templates/bicep-deploy.yml
parameters:
    - name: environment
      type: string
    - name: resourceGroup
      type: string
    - name: serviceConnection
      type: string

steps:
    - task: AzureCLI@2
      inputs:
          azureSubscription: ${{ parameters.serviceConnection }}
          scriptType: bash
          scriptLocation: inlineScript
          inlineScript: |
              az deployment group create \
                --resource-group ${{ parameters.resourceGroup }} \
                --template-file infra/main.bicep \
                --parameters environment=${{ parameters.environment }}
```

### Using templates

```yaml
# azure-pipelines.yml
stages:
    - stage: DeployDev
      jobs:
          - job: Deploy
            steps:
                - template: templates/bicep-deploy.yml
                  parameters:
                      environment: dev
                      resourceGroup: rg-csa-dev
                      serviceConnection: csa-dev-connection

    - stage: DeployProd
      dependsOn: DeployDev
      jobs:
          - deployment: Deploy
            environment: production
            strategy:
                runOnce:
                    deploy:
                        steps:
                            - template: templates/bicep-deploy.yml
                              parameters:
                                  environment: prod
                                  resourceGroup: rg-csa-prod
                                  serviceConnection: csa-prod-connection
```

### Extends templates (governance)

```yaml
# templates/governed-pipeline.yml (in central repo)
parameters:
    - name: buildSteps
      type: stepList
      default: []

stages:
    - stage: SecurityScan
      jobs:
          - job: Scan
            steps:
                - task: CredScan@3 # Enforced security scan
                - task: SdtReport@2

    - stage: Build
      dependsOn: SecurityScan
      jobs:
          - job: Build
            steps: ${{ parameters.buildSteps }}
```

```yaml
# Team pipeline (must extend governed template)
extends:
    template: templates/governed-pipeline.yml@central-repo
    parameters:
        buildSteps:
            - script: npm ci && npm run build
            - script: npm test
```

---

## 7. Matrix builds

```yaml
strategy:
    matrix:
        linux_node18:
            vmImage: ubuntu-latest
            nodeVersion: 18
        linux_node20:
            vmImage: ubuntu-latest
            nodeVersion: 20
        windows_node20:
            vmImage: windows-latest
            nodeVersion: 20
    maxParallel: 3

pool:
    vmImage: $(vmImage)

steps:
    - task: NodeTool@0
      inputs:
          versionSpec: $(nodeVersion)
    - script: npm ci && npm test
```

---

## 8. Azure DevOps CLI and automation

```bash
# Create a pipeline
az pipelines create \
  --name "CSA-in-a-Box Deploy" \
  --repository csa-inabox \
  --branch main \
  --yml-path azure-pipelines.yml

# Run a pipeline
az pipelines run --name "CSA-in-a-Box Deploy"

# List pipeline runs
az pipelines runs list --pipeline-id 42 --top 10

# Create a variable group
az pipelines variable-group create \
  --name "csa-secrets" \
  --variables API_KEY=secret DB_HOST=server.database.windows.net
```

---

## 9. Azure DevOps for CSA-in-a-Box

While CSA-in-a-Box natively uses GitHub Actions, the same CI/CD patterns translate to Azure DevOps Pipelines:

| CSA-in-a-Box pattern | Azure DevOps implementation                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| **Bicep What-If**    | `AzureCLI@2` task with `az deployment group what-if`                                            |
| **Bicep Deploy**     | `AzureResourceManagerTemplateDeployment@3` task                                                 |
| **dbt Test**         | Script tasks with `pip install dbt-databricks && dbt test`                                      |
| **Compliance Check** | `ms-devlabs.custom-terraform-tasks.custom-terraform-release-task.TerraformTaskV4@4` for Checkov |
| **MkDocs Deploy**    | Script task with `mkdocs build` + Azure Static Web Apps deployment                              |
| **OIDC Auth**        | Workload Identity Federation service connection                                                 |

### Example: CSA-in-a-Box on Azure DevOps

```yaml
trigger:
    branches:
        include: [main]

pr:
    branches:
        include: [main]

variables:
    - group: csa-inabox-config

stages:
    - stage: Validate
      jobs:
          - job: BicepWhatIf
            pool:
                vmImage: ubuntu-latest
            steps:
                - task: AzureCLI@2
                  inputs:
                      azureSubscription: csa-oidc
                      scriptType: bash
                      scriptLocation: inlineScript
                      inlineScript: |
                          az deployment group what-if \
                            --resource-group $(resourceGroup) \
                            --template-file infra/main.bicep

          - job: dbtTest
            pool:
                vmImage: ubuntu-latest
            steps:
                - task: UsePythonVersion@0
                  inputs:
                      versionSpec: "3.11"
                - script: |
                      pip install dbt-databricks
                      dbt deps && dbt test
                  displayName: dbt test

    - stage: Deploy
      dependsOn: Validate
      condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'))
      jobs:
          - deployment: BicepDeploy
            environment: production
            strategy:
                runOnce:
                    deploy:
                        steps:
                            - task: AzureResourceManagerTemplateDeployment@3
                              inputs:
                                  azureResourceManagerConnection: csa-oidc
                                  resourceGroupName: $(resourceGroup)
                                  location: eastus
                                  templateLocation: "Linked artifact"
                                  csmFile: infra/main.bicep
```

---

## 10. Comparison summary

| Dimension                 | Azure DevOps Pipelines                                | GitHub Actions                              |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| **Syntax readability**    | Verbose (tasks with inputs)                           | Concise (uses/run)                          |
| **Learning curve**        | Steeper (tasks, service connections, variable groups) | Gentler (YAML + marketplace)                |
| **Template governance**   | `extends` keyword (strong governance)                 | Reusable workflows (lighter governance)     |
| **Deployment strategies** | Rolling, canary, blue-green (native)                  | Environment protection rules (simpler)      |
| **Approval gates**        | Rich (business hours, Azure Monitor, functions)       | Environment required reviewers + wait timer |
| **Marketplace**           | ~1,200 extensions                                     | 20,000+ actions                             |
| **AI assistance**         | Limited                                               | Copilot (native)                            |
| **On-premises option**    | Azure DevOps Server                                   | GitHub Enterprise Server                    |
| **Federal coverage**      | FedRAMP High (Azure DevOps Service)                   | GHEC with data residency                    |

---

## Next steps

1. **Decide between GitHub Actions and Azure DevOps** --- Use the decision matrix in the [Migration Center](index.md).
2. **If choosing Azure DevOps** --- Set up a project, create service connections, and convert your first pipeline using this guide.
3. **If choosing GitHub Actions** --- Follow the [Pipeline Migration Guide](pipeline-migration.md).
4. **For federal requirements** --- See the [Federal Migration Guide](federal-migration-guide.md) for both platforms.
