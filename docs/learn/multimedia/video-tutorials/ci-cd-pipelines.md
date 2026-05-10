# Video Script: CI/CD Pipelines for Azure Synapse

![Duration: 35 minutes](https://img.shields.io/badge/Duration-35%20minutes-blue)
![Level: Advanced](https://img.shields.io/badge/Level-Advanced-red)
![Version: 1.0](https://img.shields.io/badge/Version-1.0-blue)

## Video Metadata

- **Title**: CI/CD Pipelines for Azure Synapse Analytics
- **Duration**: 35:00
- **Target Audience**: DevOps engineers, data engineers
- **Skill Level**: Advanced
- **Prerequisites**:
  - Azure Synapse workspace
  - Azure DevOps or GitHub account
  - Understanding of Git workflows
  - Basic PowerShell/Azure CLI knowledge
- **Tools Required**:
  - Azure DevOps or GitHub
  - VS Code with Synapse extension
  - Azure CLI
  - PowerShell 7+

## Learning Objectives

1. Set up Git integration for Synapse workspaces
2. Create automated deployment pipelines
3. Implement environment-specific configurations
4. Configure approval gates and quality checks
5. Manage secrets and credentials securely
6. Implement rollback strategies

## Video Script

### Opening (0:00 - 1:30)

**NARRATOR**:
"Manual deployments are error-prone and don't scale. In this tutorial, you'll learn how to implement enterprise-grade CI/CD pipelines for Azure Synapse Analytics, enabling automated, reliable, and repeatable deployments across multiple environments."

**[VISUAL: Deployment pipeline animation]**

### Section 1: Git Integration Setup (1:30 - 8:00)

#### Configuring Git Repository (1:30 - 4:00)

```yaml
# Repository structure
synapse-repo/
├── workspace/
│   ├── pipeline/
│   ├── notebook/
│   ├── sqlscript/
│   ├── dataflow/
│   └── linkedService/
├── scripts/
│   ├── deploy.ps1
│   ├── validate.py
│   └── test-connections.ps1
├── config/
│   ├── dev.json
│   ├── uat.json
│   └── prod.json
└── azure-pipelines.yml
```

#### Branch Strategy (4:00 - 6:00)

**[VISUAL: Git branching diagram]**

```
main (protected)
├── develop
│   ├── feature/data-pipeline
│   └── feature/ml-notebook
├── release/v1.0
└── hotfix/critical-bug
```

#### Collaboration Workflow (6:00 - 8:00)

```bash
# Developer workflow
git checkout -b feature/new-pipeline
# Make changes in Synapse Studio
git add .
git commit -m "feat: add customer data pipeline"
git push origin feature/new-pipeline
# Create pull request in Azure DevOps/GitHub
```

### Section 2: Azure DevOps Pipeline (8:00 - 18:00)

#### Build Pipeline (8:00 - 12:00)

```yaml
# azure-pipelines-build.yml
trigger:
  branches:
    include:
      - develop
      - main
  paths:
    include:
      - workspace/**
      - scripts/**

pool:
  vmImage: 'ubuntu-latest'

variables:
  - group: synapse-build-vars

stages:
  - stage: Validate
    displayName: 'Validate Synapse Artifacts'
    jobs:
      - job: ValidateJSON
        steps:
          - task: UsePythonVersion@0
            inputs:
              versionSpec: '3.9'

          - script: |
              pip install jsonschema pyyaml
              python scripts/validate-artifacts.py
            displayName: 'Validate JSON schemas'

      - job: SecurityScan
        steps:
          - task: CredScan@3
            displayName: 'Run credential scanner'

          - task: SonarCloudPrepare@1
            inputs:
              SonarCloud: 'SonarCloud'
              organization: 'myorg'
              scannerMode: 'CLI'

  - stage: Build
    displayName: 'Build Deployment Package'
    dependsOn: Validate
    jobs:
      - job: CreateArtifact
        steps:
          - task: CopyFiles@2
            inputs:
              SourceFolder: '$(Build.SourcesDirectory)/workspace'
              Contents: '**'
              TargetFolder: '$(Build.ArtifactStagingDirectory)/synapse'

          - task: PublishBuildArtifacts@1
            inputs:
              PathtoPublish: '$(Build.ArtifactStagingDirectory)'
              ArtifactName: 'synapse-artifacts'
```

#### Release Pipeline (12:00 - 18:00)

```yaml
# azure-pipelines-release.yml
trigger: none

resources:
  pipelines:
    - pipeline: build
      source: synapse-build
      trigger:
        branches:
          include:
            - main

variables:
  - group: synapse-dev
  - group: synapse-prod

stages:
  - stage: DeployDev
    displayName: 'Deploy to Development'
    variables:
      - group: synapse-dev
    jobs:
      - deployment: DeployArtifacts
        environment: 'synapse-dev'
        strategy:
          runOnce:
            deploy:
              steps:
                - template: templates/deploy-synapse.yml
                  parameters:
                    workspaceName: '$(devWorkspaceName)'
                    resourceGroup: '$(devResourceGroup)'
                    environment: 'dev'

  - stage: DeployUAT
    displayName: 'Deploy to UAT'
    dependsOn: DeployDev
    condition: succeeded()
    variables:
      - group: synapse-uat
    jobs:
      - deployment: DeployArtifacts
        environment: 'synapse-uat'
        strategy:
          runOnce:
            preDeploy:
              steps:
                - task: ManualValidation@0
                  inputs:
                    notifyUsers: 'dev-team@company.com'
                    instructions: 'Review deployment to UAT'
            deploy:
              steps:
                - template: templates/deploy-synapse.yml
                  parameters:
                    workspaceName: '$(uatWorkspaceName)'
                    resourceGroup: '$(uatResourceGroup)'
                    environment: 'uat'

  - stage: DeployProd
    displayName: 'Deploy to Production'
    dependsOn: DeployUAT
    condition: succeeded()
    variables:
      - group: synapse-prod
    jobs:
      - deployment: DeployArtifacts
        environment: 'synapse-prod'
        strategy:
          runOnce:
            preDeploy:
              steps:
                - task: ManualValidation@0
                  inputs:
                    notifyUsers: 'approvers@company.com'
                    instructions: 'Approve production deployment'

                - task: AzureCLI@2
                  displayName: 'Create backup'
                  inputs:
                    azureSubscription: '$(azureSubscription)'
                    scriptType: 'pscore'
                    scriptLocation: 'scriptPath'
                    scriptPath: 'scripts/backup-workspace.ps1'

            deploy:
              steps:
                - template: templates/deploy-synapse.yml
                  parameters:
                    workspaceName: '$(prodWorkspaceName)'
                    resourceGroup: '$(prodResourceGroup)'
                    environment: 'prod'

            on:
              failure:
                steps:
                  - task: AzureCLI@2
                    displayName: 'Rollback on failure'
                    inputs:
                      azureSubscription: '$(azureSubscription)'
                      scriptType: 'pscore'
                      scriptLocation: 'scriptPath'
                      scriptPath: 'scripts/rollback.ps1'
```

### Section 3: Deployment Scripts (18:00 - 25:00)

#### Main Deployment Script (18:00 - 21:00)

```powershell
# deploy-synapse.ps1
param(
    [Parameter(Mandatory=$true)]
    [string]$WorkspaceName,

    [Parameter(Mandatory=$true)]
    [string]$ResourceGroup,

    [Parameter(Mandatory=$true)]
    [string]$Environment,

    [Parameter(Mandatory=$false)]
    [string]$ArtifactPath = "./synapse"
)

# Import configuration
$config = Get-Content "config/$Environment.json" | ConvertFrom-Json

# Connect to Azure
Write-Host "Connecting to Azure..."
Connect-AzAccount -Identity

# Set context
Set-AzContext -SubscriptionId $config.subscriptionId

# Function to deploy pipelines
function Deploy-Pipelines {
    param([string]$Path)

    $pipelines = Get-ChildItem -Path "$Path/pipeline" -Filter "*.json"

    foreach ($pipeline in $pipelines) {
        $pipelineName = $pipeline.BaseName
        $definition = Get-Content $pipeline.FullName -Raw

        # Replace environment-specific values
        $definition = $definition -replace '__ENVIRONMENT__', $Environment
        $definition = $definition -replace '__STORAGE_ACCOUNT__', $config.storageAccount

        # Save updated definition
        $tempFile = [System.IO.Path]::GetTempFileName()
        $definition | Out-File -FilePath $tempFile

        try {
            Write-Host "Deploying pipeline: $pipelineName"
            Set-AzSynapsePipeline `
                -WorkspaceName $WorkspaceName `
                -Name $pipelineName `
                -DefinitionFile $tempFile `
                -ErrorAction Stop

            Write-Host "✓ Successfully deployed: $pipelineName" -ForegroundColor Green
        }
        catch {
            Write-Host "✗ Failed to deploy: $pipelineName" -ForegroundColor Red
            Write-Host $_.Exception.Message
            throw
        }
        finally {
            Remove-Item $tempFile -ErrorAction SilentlyContinue
        }
    }
}

# Function to deploy notebooks
function Deploy-Notebooks {
    param([string]$Path)

    $notebooks = Get-ChildItem -Path "$Path/notebook" -Filter "*.json"

    foreach ($notebook in $notebooks) {
        $notebookName = $notebook.BaseName

        try {
            Write-Host "Deploying notebook: $notebookName"
            Set-AzSynapseNotebook `
                -WorkspaceName $WorkspaceName `
                -Name $notebookName `
                -DefinitionFile $notebook.FullName `
                -ErrorAction Stop

            Write-Host "✓ Successfully deployed: $notebookName" -ForegroundColor Green
        }
        catch {
            Write-Host "✗ Failed to deploy: $notebookName" -ForegroundColor Red
            Write-Host $_.Exception.Message
            throw
        }
    }
}

# Execute deployment
try {
    Write-Host "Starting deployment to $WorkspaceName ($Environment)"

    Deploy-Pipelines -Path $ArtifactPath
    Deploy-Notebooks -Path $ArtifactPath

    Write-Host "Deployment completed successfully!" -ForegroundColor Green
}
catch {
    Write-Host "Deployment failed!" -ForegroundColor Red
    exit 1
}
```

#### Rollback Script (21:00 - 23:00)

```powershell
# rollback.ps1
param(
    [Parameter(Mandatory=$true)]
    [string]$WorkspaceName,

    [Parameter(Mandatory=$true)]
    [string]$BackupPath
)

Write-Host "Starting rollback for $WorkspaceName"

# Restore from backup
$artifacts = Get-ChildItem -Path $BackupPath -Recurse -Filter "*.json"

foreach ($artifact in $artifacts) {
    $relativePath = $artifact.FullName.Substring($BackupPath.Length)
    $artifactType = Split-Path (Split-Path $relativePath) -Leaf

    switch ($artifactType) {
        "pipeline" {
            Set-AzSynapsePipeline `
                -WorkspaceName $WorkspaceName `
                -Name $artifact.BaseName `
                -DefinitionFile $artifact.FullName
        }
        "notebook" {
            Set-AzSynapseNotebook `
                -WorkspaceName $WorkspaceName `
                -Name $artifact.BaseName `
                -DefinitionFile $artifact.FullName
        }
    }
}

Write-Host "Rollback completed"
```

#### Testing Script (23:00 - 25:00)

```powershell
# test-deployment.ps1
param(
    [Parameter(Mandatory=$true)]
    [string]$WorkspaceName
)

# Test linked services
$linkedServices = Get-AzSynapseLinkedService -WorkspaceName $WorkspaceName

foreach ($ls in $linkedServices) {
    Write-Host "Testing linked service: $($ls.Name)"
    Test-AzSynapseLinkedService `
        -WorkspaceName $WorkspaceName `
        -Name $ls.Name
}

# Test pipelines exist
$expectedPipelines = @("IngestPipeline", "ProcessPipeline", "ArchivePipeline")

foreach ($pipeline in $expectedPipelines) {
    $exists = Get-AzSynapsePipeline -WorkspaceName $WorkspaceName -Name $pipeline
    if ($exists) {
        Write-Host "✓ Pipeline exists: $pipeline" -ForegroundColor Green
    }
    else {
        Write-Host "✗ Pipeline missing: $pipeline" -ForegroundColor Red
        exit 1
    }
}

Write-Host "All tests passed!" -ForegroundColor Green
```

### Section 4: Secrets Management (25:00 - 29:00)

#### Azure Key Vault Integration (25:00 - 27:00)

```json
// linkedService/KeyVault.json
{
  "name": "KeyVaultLink",
  "properties": {
    "type": "AzureKeyVault",
    "typeProperties": {
      "baseUrl": "https://mykeyvault.vault.azure.net/"
    }
  }
}
```

```json
// linkedService/StorageWithKeyVault.json
{
  "name": "SecureStorageLink",
  "properties": {
    "type": "AzureBlobFS",
    "typeProperties": {
      "url": "https://mystorage.dfs.core.windows.net/",
      "accountKey": {
        "type": "AzureKeyVaultSecret",
        "store": {
          "referenceName": "KeyVaultLink",
          "type": "LinkedServiceReference"
        },
        "secretName": "storage-account-key"
      }
    }
  }
}
```

#### Pipeline Variable Management (27:00 - 29:00)

```yaml
# Variable groups in Azure DevOps
variables:
  - group: synapse-shared  # Shared across all environments
  - group: synapse-${{ parameters.environment }}  # Environment-specific

  - name: workspaceName
    value: $[variables.environmentWorkspaceName]

  - name: sqlPoolName
    ${{ if eq(parameters.environment, 'prod') }}:
      value: 'ProductionSQLPool'
    ${{ else }}:
      value: 'DevSQLPool'
```

### Section 5: Best Practices (29:00 - 33:00)

**Key Practices**:

1. **Version Control Everything**:
   - All Synapse artifacts in Git
   - Scripts and configurations tracked
   - Environment configs separated

2. **Environment Parity**:
   - Use same deployment process for all environments
   - Parameterize environment-specific values
   - Test in lower environments first

3. **Security**:
   - Never store secrets in code
   - Use managed identities where possible
   - Rotate credentials regularly
   - Enable audit logging

4. **Testing**:
   - Validate JSON schemas
   - Test linked service connections
   - Verify pipeline deployments
   - Run smoke tests post-deployment

5. **Rollback Strategy**:
   - Always create backups before deployment
   - Test rollback procedures
   - Document rollback steps
   - Keep previous versions accessible

### Conclusion (33:00 - 35:00)

**NARRATOR**:
"You now have a complete CI/CD pipeline for Azure Synapse Analytics. This foundation enables rapid, reliable deployments while maintaining quality and security standards."

**Next Steps**:
- Implement these patterns in your organization
- Customize scripts for your requirements
- Add automated testing
- Set up monitoring and alerting

## Related Resources

- [Advanced Features](advanced-features.md)
- [Disaster Recovery](disaster-recovery.md)
- [Performance Tuning](performance-tuning.md)

---

*Last Updated: January 2025*
