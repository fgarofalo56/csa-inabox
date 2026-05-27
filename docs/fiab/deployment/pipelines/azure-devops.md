# Deploy CSA Loom from Azure DevOps Pipelines

Multi-stage YAML pipeline (Dev → Stage → Prod) using ADO workload-identity
federation for OIDC-style auth, with per-stage approvals.

For customers standardized on Azure DevOps (federal customers
frequently are — Azure DevOps Server / GCC-H Azure DevOps Services).

## Prerequisites

| Item | Notes |
|---|---|
| Azure DevOps project | Self-hosted or hosted |
| **Service connection** (Azure Resource Manager) with **workload-identity federation** | Avoid long-lived secrets |
| Variable group | Per environment: `LOOM_BOUNDARY`, `LOOM_LOCATION`, `LOOM_ADMIN_GROUP_OBJECT_ID` |
| Environments configured in ADO | `dev`, `stage`, `prod` — each with approval gates |
| `Bicep` task installed | (Azure DevOps task pack — already in ADO Cloud) |

## Pipeline

Save as `azure-pipelines/loom-deploy.yml`:

```yaml
trigger: none  # manual dispatch only

parameters:
  - name: boundary
    type: string
    default: commercial
    values: [commercial, gcc, gcc-high]
  - name: runMode
    type: string
    default: deploy
    values: [validate, deploy, teardown]

variables:
  - name: BicepFile
    value: platform/fiab/bicep/main.bicep
  - name: ParamFile
    value: platform/fiab/bicep/params/${{ parameters.boundary }}.bicepparam
  - name: DeploymentName
    value: loom-$(Build.BuildId)

stages:
  - stage: Validate
    jobs:
      - job: validate
        pool:
          vmImage: ubuntu-latest
        steps:
          - task: AzureCLI@2
            displayName: Validate Bicep
            inputs:
              azureSubscription: loom-deploy-dev
              scriptType: bash
              scriptLocation: inlineScript
              inlineScript: |
                az bicep build --file $(BicepFile)
                az deployment sub validate \
                  --location $(LOOM_LOCATION) \
                  --template-file $(BicepFile) \
                  --parameters $(ParamFile)

  - stage: DeployDev
    dependsOn: Validate
    condition: and(succeeded(), eq('${{ parameters.runMode }}', 'deploy'))
    jobs:
      - deployment: dev
        environment: loom-dev
        pool:
          vmImage: ubuntu-latest
        strategy:
          runOnce:
            deploy:
              steps:
                - checkout: self
                - task: AzureCLI@2
                  inputs:
                    azureSubscription: loom-deploy-dev
                    scriptType: bash
                    scriptLocation: inlineScript
                    inlineScript: |
                      az deployment sub create \
                        --name $(DeploymentName) \
                        --location $(LOOM_LOCATION) \
                        --template-file $(BicepFile) \
                        --parameters $(ParamFile) \
                        --parameters loomAdminGroupObjectId=$(LOOM_ADMIN_GROUP_OBJECT_ID)
                      bash scripts/csa-loom/bootstrap-all.sh \
                        --boundary ${{ parameters.boundary }} --environment dev

  - stage: DeployStage
    dependsOn: DeployDev
    condition: and(succeeded(), eq('${{ parameters.runMode }}', 'deploy'))
    jobs:
      - deployment: stage
        environment: loom-stage  # approval gate configured here
        pool:
          vmImage: ubuntu-latest
        strategy:
          runOnce:
            deploy:
              steps:
                - checkout: self
                - task: AzureCLI@2
                  inputs:
                    azureSubscription: loom-deploy-stage
                    scriptType: bash
                    scriptLocation: inlineScript
                    inlineScript: |
                      az deployment sub create \
                        --name $(DeploymentName) \
                        --location $(LOOM_LOCATION) \
                        --template-file $(BicepFile) \
                        --parameters $(ParamFile) \
                        --parameters loomAdminGroupObjectId=$(LOOM_ADMIN_GROUP_OBJECT_ID)

  - stage: DeployProd
    dependsOn: DeployStage
    condition: and(succeeded(), eq('${{ parameters.runMode }}', 'deploy'))
    jobs:
      - deployment: prod
        environment: loom-prod  # production approval gate
        pool:
          vmImage: ubuntu-latest
        strategy:
          runOnce:
            deploy:
              steps:
                - checkout: self
                - task: AzureCLI@2
                  inputs:
                    azureSubscription: loom-deploy-prod
                    scriptType: bash
                    scriptLocation: inlineScript
                    inlineScript: |
                      az deployment sub create \
                        --name $(DeploymentName) \
                        --location $(LOOM_LOCATION) \
                        --template-file $(BicepFile) \
                        --parameters $(ParamFile) \
                        --parameters loomAdminGroupObjectId=$(LOOM_ADMIN_GROUP_OBJECT_ID)
                      bash scripts/csa-loom/bootstrap-all.sh \
                        --boundary ${{ parameters.boundary }} --environment prod
```

## Approvals + post-deploy

Each `environment:` reference enforces ADO approval gates. Configure
under Pipelines → Environments → `loom-stage` / `loom-prod` → Approvals
+ checks.

Post-deploy bootstrap (Power BI tenant SP grant, Databricks SCIM,
Dataverse AppUser) runs as the last step of each deploy stage.

## GCC-High variant

For Azure Government, replace `azureSubscription:` values with a service
connection that targets `AzureUSGovernment` cloud, and set
`LOOM_LOCATION=usgovvirginia`.

## Related

- [GitHub Actions equivalent](github-actions.md)
- [Bicep CLI direct](bicep-cli.md)
- [Multi-sub / multi-tenant deployment](../multi-sub-multi-tenant.md)
