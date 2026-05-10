# Tutorial 14: CI/CD Setup

## Overview

This tutorial covers implementing CI/CD (Continuous Integration/Continuous Deployment) for Azure Synapse Analytics, including Git integration, Azure DevOps pipelines, and deployment automation for notebooks, pipelines, and SQL scripts.

## Prerequisites

- Completed [Tutorial 13: Monitoring and Diagnostics](13-monitoring.md)
- Azure DevOps or GitHub account
- Git fundamentals
- Understanding of deployment concepts

## Learning Objectives

By the end of this tutorial, you will be able to:

- Configure Git integration for Synapse
- Set up Azure DevOps pipelines
- Implement deployment strategies
- Automate testing and validation
- Manage environment promotions

---

## Section 1: Git Integration

### Connecting Synapse to Git

```
┌─────────────────────────────────────────────────────────────────┐
│                  Synapse Git Integration                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Development Workspace                                           │
│  └── Connected to: feature/xyz branch                           │
│      ├── notebooks/                                             │
│      ├── pipelines/                                             │
│      ├── dataflows/                                             │
│      ├── linkedServices/                                        │
│      └── sqlscripts/                                            │
│                                                                  │
│  ┌────────────────┐                                             │
│  │   Collaborate  │ ─── feature/xyz ───▶ Pull Request           │
│  └────────────────┘                      ▼                      │
│                                          main                    │
│                                          ▼                      │
│                                   ┌─────────────┐               │
│                                   │  Publish to │               │
│                                   │ Production  │               │
│                                   └─────────────┘               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Repository Structure

```
synapse-workspace/
├── .gitignore
├── workspace.json
├── publish_config.json
├── notebook/
│   ├── DataProcessing.json
│   ├── ETL_Pipeline.json
│   └── Reporting.json
├── pipeline/
│   ├── DailyIngestion.json
│   ├── WeeklyAggregation.json
│   └── DataQuality.json
├── dataflow/
│   ├── TransformSales.json
│   └── CleanseCustomer.json
├── linkedService/
│   ├── AzureDataLakeStorage.json
│   ├── AzureSQLDatabase.json
│   └── PowerBI.json
├── integrationRuntime/
│   └── SelfHostedIR.json
├── sqlscript/
│   ├── CreateTables.json
│   ├── StoredProcedures.json
│   └── Views.json
├── credential/
│   └── ManagedIdentity.json
└── trigger/
    ├── DailyTrigger.json
    └── EventTrigger.json
```

### Branch Strategy

```yaml
# Branch naming convention
main:           # Production-ready code
  └── release/*   # Release branches for staging
      └── develop   # Integration branch
          └── feature/*  # Feature development
          └── bugfix/*   # Bug fixes
          └── hotfix/*   # Production hotfixes
```

---

## Section 2: Azure DevOps Pipeline Setup

### Service Connections

```powershell
# Create service principal for deployment
az ad sp create-for-rbac \
    --name "synapse-cicd-sp" \
    --role "Synapse Administrator" \
    --scopes "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Synapse/workspaces/<workspace>"

# Grant additional permissions
az role assignment create \
    --assignee <sp-client-id> \
    --role "Storage Blob Data Contributor" \
    --scope "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<account>"
```

### CI Pipeline (azure-pipelines-ci.yml)

```yaml
# CI Pipeline - Validate and Build
trigger:
  branches:
    include:
      - develop
      - feature/*
  paths:
    include:
      - synapse-workspace/*

pool:
  vmImage: 'ubuntu-latest'

variables:
  workspaceName: 'synapse-dev'
  resourceGroup: 'rg-synapse-dev'
  subscriptionId: '$(AZURE_SUBSCRIPTION_ID)'

stages:
  - stage: Validate
    displayName: 'Validate Synapse Artifacts'
    jobs:
      - job: ValidateArtifacts
        displayName: 'Validate Workspace Artifacts'
        steps:
          - checkout: self

          - task: AzureCLI@2
            displayName: 'Install Synapse CLI Extension'
            inputs:
              azureSubscription: 'synapse-service-connection'
              scriptType: 'bash'
              scriptLocation: 'inlineScript'
              inlineScript: |
                az extension add --name synapse --yes

          - task: AzureCLI@2
            displayName: 'Validate Workspace'
            inputs:
              azureSubscription: 'synapse-service-connection'
              scriptType: 'bash'
              scriptLocation: 'inlineScript'
              inlineScript: |
                cd synapse-workspace

                # Validate JSON syntax
                for file in $(find . -name "*.json"); do
                  echo "Validating: $file"
                  python -m json.tool "$file" > /dev/null
                done

                # Validate pipeline definitions
                for pipeline in pipeline/*.json; do
                  echo "Checking pipeline: $pipeline"
                  jq '.properties.activities | length' "$pipeline"
                done

  - stage: Test
    displayName: 'Run Tests'
    dependsOn: Validate
    jobs:
      - job: UnitTests
        displayName: 'Run Unit Tests'
        steps:
          - task: UsePythonVersion@0
            inputs:
              versionSpec: '3.9'

          - script: |
              pip install pytest pytest-cov pyspark
              pytest tests/ -v --junitxml=test-results.xml
            displayName: 'Run Python Tests'

          - task: PublishTestResults@2
            inputs:
              testResultsFiles: '**/test-results.xml'
              testRunTitle: 'Synapse Unit Tests'

  - stage: Build
    displayName: 'Build Artifacts'
    dependsOn: Test
    jobs:
      - job: BuildArtifacts
        displayName: 'Package Artifacts'
        steps:
          - task: CopyFiles@2
            displayName: 'Copy Synapse Artifacts'
            inputs:
              SourceFolder: 'synapse-workspace'
              Contents: '**'
              TargetFolder: '$(Build.ArtifactStagingDirectory)/synapse'

          - task: CopyFiles@2
            displayName: 'Copy Deployment Scripts'
            inputs:
              SourceFolder: 'deployment'
              Contents: '**'
              TargetFolder: '$(Build.ArtifactStagingDirectory)/deployment'

          - task: PublishBuildArtifacts@1
            displayName: 'Publish Artifacts'
            inputs:
              PathtoPublish: '$(Build.ArtifactStagingDirectory)'
              ArtifactName: 'synapse-artifacts'
```

### CD Pipeline (azure-pipelines-cd.yml)

```yaml
# CD Pipeline - Deploy to Environments
trigger: none

resources:
  pipelines:
    - pipeline: ci-pipeline
      source: 'Synapse-CI'
      trigger:
        branches:
          include:
            - develop
            - main

pool:
  vmImage: 'ubuntu-latest'

variables:
  - group: synapse-variables

stages:
  - stage: DeployDev
    displayName: 'Deploy to Development'
    condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/develop'))
    variables:
      environment: 'dev'
      workspaceName: 'synapse-dev'
      resourceGroup: 'rg-synapse-dev'
    jobs:
      - deployment: DeployToDevWorkspace
        displayName: 'Deploy to Dev Workspace'
        environment: 'synapse-dev'
        strategy:
          runOnce:
            deploy:
              steps:
                - template: templates/deploy-synapse.yml
                  parameters:
                    workspaceName: $(workspaceName)
                    resourceGroup: $(resourceGroup)
                    environment: $(environment)

  - stage: DeployStaging
    displayName: 'Deploy to Staging'
    dependsOn: DeployDev
    condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/develop'))
    variables:
      environment: 'staging'
      workspaceName: 'synapse-staging'
      resourceGroup: 'rg-synapse-staging'
    jobs:
      - deployment: DeployToStagingWorkspace
        displayName: 'Deploy to Staging Workspace'
        environment: 'synapse-staging'
        strategy:
          runOnce:
            deploy:
              steps:
                - template: templates/deploy-synapse.yml
                  parameters:
                    workspaceName: $(workspaceName)
                    resourceGroup: $(resourceGroup)
                    environment: $(environment)

  - stage: DeployProd
    displayName: 'Deploy to Production'
    dependsOn: DeployStaging
    condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'))
    variables:
      environment: 'prod'
      workspaceName: 'synapse-prod'
      resourceGroup: 'rg-synapse-prod'
    jobs:
      - deployment: DeployToProdWorkspace
        displayName: 'Deploy to Production Workspace'
        environment: 'synapse-prod'
        strategy:
          runOnce:
            deploy:
              steps:
                - template: templates/deploy-synapse.yml
                  parameters:
                    workspaceName: $(workspaceName)
                    resourceGroup: $(resourceGroup)
                    environment: $(environment)
```

### Deployment Template (templates/deploy-synapse.yml)

```yaml
parameters:
  - name: workspaceName
    type: string
  - name: resourceGroup
    type: string
  - name: environment
    type: string

steps:
  - download: ci-pipeline
    artifact: synapse-artifacts

  - task: AzureCLI@2
    displayName: 'Install Dependencies'
    inputs:
      azureSubscription: 'synapse-service-connection'
      scriptType: 'bash'
      scriptLocation: 'inlineScript'
      inlineScript: |
        az extension add --name synapse --yes
        pip install azure-synapse-artifacts

  - task: AzureCLI@2
    displayName: 'Stop Triggers'
    inputs:
      azureSubscription: 'synapse-service-connection'
      scriptType: 'bash'
      scriptLocation: 'inlineScript'
      inlineScript: |
        # Stop all triggers before deployment
        triggers=$(az synapse trigger list \
          --workspace-name ${{ parameters.workspaceName }} \
          --query "[?properties.runtimeState=='Started'].name" -o tsv)

        for trigger in $triggers; do
          echo "Stopping trigger: $trigger"
          az synapse trigger stop \
            --workspace-name ${{ parameters.workspaceName }} \
            --name "$trigger"
        done

  - task: AzureCLI@2
    displayName: 'Deploy Linked Services'
    inputs:
      azureSubscription: 'synapse-service-connection'
      scriptType: 'bash'
      scriptLocation: 'inlineScript'
      inlineScript: |
        cd $(Pipeline.Workspace)/ci-pipeline/synapse-artifacts/synapse/linkedService

        for file in *.json; do
          name="${file%.json}"
          echo "Deploying linked service: $name"

          # Apply environment-specific overrides
          cat "$file" | envsubst > "${file}.temp"

          az synapse linked-service create \
            --workspace-name ${{ parameters.workspaceName }} \
            --name "$name" \
            --file "@${file}.temp"
        done

  - task: AzureCLI@2
    displayName: 'Deploy Datasets'
    inputs:
      azureSubscription: 'synapse-service-connection'
      scriptType: 'bash'
      scriptLocation: 'inlineScript'
      inlineScript: |
        cd $(Pipeline.Workspace)/ci-pipeline/synapse-artifacts/synapse/dataset

        for file in *.json; do
          name="${file%.json}"
          echo "Deploying dataset: $name"

          az synapse dataset create \
            --workspace-name ${{ parameters.workspaceName }} \
            --name "$name" \
            --file "@$file"
        done

  - task: AzureCLI@2
    displayName: 'Deploy Notebooks'
    inputs:
      azureSubscription: 'synapse-service-connection'
      scriptType: 'bash'
      scriptLocation: 'inlineScript'
      inlineScript: |
        cd $(Pipeline.Workspace)/ci-pipeline/synapse-artifacts/synapse/notebook

        for file in *.json; do
          name="${file%.json}"
          echo "Deploying notebook: $name"

          az synapse notebook import \
            --workspace-name ${{ parameters.workspaceName }} \
            --name "$name" \
            --file "@$file"
        done

  - task: AzureCLI@2
    displayName: 'Deploy Pipelines'
    inputs:
      azureSubscription: 'synapse-service-connection'
      scriptType: 'bash'
      scriptLocation: 'inlineScript'
      inlineScript: |
        cd $(Pipeline.Workspace)/ci-pipeline/synapse-artifacts/synapse/pipeline

        for file in *.json; do
          name="${file%.json}"
          echo "Deploying pipeline: $name"

          az synapse pipeline create \
            --workspace-name ${{ parameters.workspaceName }} \
            --name "$name" \
            --file "@$file"
        done

  - task: AzureCLI@2
    displayName: 'Deploy SQL Scripts'
    inputs:
      azureSubscription: 'synapse-service-connection'
      scriptType: 'bash'
      scriptLocation: 'inlineScript'
      inlineScript: |
        cd $(Pipeline.Workspace)/ci-pipeline/synapse-artifacts/synapse/sqlscript

        for file in *.json; do
          name="${file%.json}"
          echo "Deploying SQL script: $name"

          az synapse sql-script import \
            --workspace-name ${{ parameters.workspaceName }} \
            --name "$name" \
            --file "@$file"
        done

  - task: AzureCLI@2
    displayName: 'Deploy Triggers'
    inputs:
      azureSubscription: 'synapse-service-connection'
      scriptType: 'bash'
      scriptLocation: 'inlineScript'
      inlineScript: |
        cd $(Pipeline.Workspace)/ci-pipeline/synapse-artifacts/synapse/trigger

        for file in *.json; do
          name="${file%.json}"
          echo "Deploying trigger: $name"

          az synapse trigger create \
            --workspace-name ${{ parameters.workspaceName }} \
            --name "$name" \
            --file "@$file"
        done

  - task: AzureCLI@2
    displayName: 'Start Triggers'
    inputs:
      azureSubscription: 'synapse-service-connection'
      scriptType: 'bash'
      scriptLocation: 'inlineScript'
      inlineScript: |
        # Start triggers after deployment
        triggers=$(az synapse trigger list \
          --workspace-name ${{ parameters.workspaceName }} \
          --query "[?properties.runtimeState=='Stopped'].name" -o tsv)

        for trigger in $triggers; do
          echo "Starting trigger: $trigger"
          az synapse trigger start \
            --workspace-name ${{ parameters.workspaceName }} \
            --name "$trigger"
        done
```

---

## Section 3: SQL Pool Deployment

### Database Project Structure

```
sql-database/
├── dbo/
│   ├── Tables/
│   │   ├── fact.Sales.sql
│   │   ├── dim.Product.sql
│   │   └── dim.Customer.sql
│   ├── Views/
│   │   ├── reporting.vw_SalesSummary.sql
│   │   └── reporting.vw_CustomerAnalytics.sql
│   ├── StoredProcedures/
│   │   ├── etl.usp_LoadDailySales.sql
│   │   └── etl.usp_RefreshMaterializedViews.sql
│   └── Functions/
│       └── security.fn_RegionFilter.sql
├── Security/
│   ├── Roles/
│   │   ├── DataAnalyst.sql
│   │   └── DataEngineer.sql
│   └── Users/
│       └── ServiceAccounts.sql
├── Migrations/
│   ├── V001__InitialSchema.sql
│   ├── V002__AddIndexes.sql
│   └── V003__AddPartitioning.sql
└── deploy.ps1
```

### Migration Script Example

```sql
-- Migrations/V001__InitialSchema.sql
-- Migration: Initial Schema
-- Version: 001
-- Author: DataTeam
-- Date: 2024-01-15

-- Check if migration already applied
IF NOT EXISTS (
    SELECT 1 FROM sys.tables WHERE name = '__SchemaVersion'
)
BEGIN
    CREATE TABLE dbo.__SchemaVersion (
        VersionId INT NOT NULL,
        ScriptName VARCHAR(200) NOT NULL,
        AppliedOn DATETIME NOT NULL DEFAULT GETDATE(),
        AppliedBy VARCHAR(100) NOT NULL DEFAULT SYSTEM_USER
    )
    WITH (DISTRIBUTION = REPLICATE);
END
GO

IF NOT EXISTS (
    SELECT 1 FROM dbo.__SchemaVersion WHERE VersionId = 1
)
BEGIN
    -- Create schemas
    IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'fact')
        EXEC('CREATE SCHEMA fact');
    IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'dim')
        EXEC('CREATE SCHEMA dim');
    IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'staging')
        EXEC('CREATE SCHEMA staging');
    IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'etl')
        EXEC('CREATE SCHEMA etl');
    IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'reporting')
        EXEC('CREATE SCHEMA reporting');

    -- Create dimension tables
    CREATE TABLE dim.Product (
        ProductKey INT NOT NULL,
        ProductID VARCHAR(20) NOT NULL,
        ProductName VARCHAR(100),
        Category VARCHAR(50),
        SubCategory VARCHAR(50)
    )
    WITH (
        DISTRIBUTION = REPLICATE,
        CLUSTERED COLUMNSTORE INDEX
    );

    CREATE TABLE dim.Customer (
        CustomerKey INT NOT NULL,
        CustomerID VARCHAR(20) NOT NULL,
        CustomerName VARCHAR(100),
        Segment VARCHAR(50),
        Region VARCHAR(50)
    )
    WITH (
        DISTRIBUTION = REPLICATE,
        CLUSTERED COLUMNSTORE INDEX
    );

    -- Create fact table
    CREATE TABLE fact.Sales (
        SaleID BIGINT NOT NULL,
        DateKey INT NOT NULL,
        ProductKey INT NOT NULL,
        CustomerKey INT NOT NULL,
        Quantity INT,
        Amount DECIMAL(12,2)
    )
    WITH (
        DISTRIBUTION = HASH(CustomerKey),
        CLUSTERED COLUMNSTORE INDEX,
        PARTITION (DateKey RANGE RIGHT FOR VALUES (20240101, 20240401, 20240701, 20241001))
    );

    -- Record migration
    INSERT INTO dbo.__SchemaVersion (VersionId, ScriptName)
    VALUES (1, 'V001__InitialSchema.sql');
END
GO
```

### SQL Deployment Script

```powershell
# deploy.ps1
param(
    [Parameter(Mandatory=$true)]
    [string]$ServerName,

    [Parameter(Mandatory=$true)]
    [string]$DatabaseName,

    [Parameter(Mandatory=$true)]
    [string]$Environment
)

# Get current version
$currentVersion = Invoke-Sqlcmd -ServerInstance $ServerName -Database $DatabaseName -Query @"
    SELECT ISNULL(MAX(VersionId), 0) AS CurrentVersion
    FROM dbo.__SchemaVersion
"@

Write-Host "Current schema version: $($currentVersion.CurrentVersion)"

# Get migration scripts
$migrationFiles = Get-ChildItem -Path "Migrations" -Filter "V*.sql" |
    Sort-Object Name |
    Where-Object {
        [int]($_.Name -replace 'V(\d+)__.*\.sql', '$1') -gt $currentVersion.CurrentVersion
    }

foreach ($file in $migrationFiles) {
    Write-Host "Applying migration: $($file.Name)"

    $script = Get-Content $file.FullName -Raw

    # Replace environment variables
    $script = $script -replace '\$\{ENVIRONMENT\}', $Environment

    try {
        Invoke-Sqlcmd -ServerInstance $ServerName -Database $DatabaseName -Query $script -ErrorAction Stop
        Write-Host "  Successfully applied: $($file.Name)" -ForegroundColor Green
    }
    catch {
        Write-Host "  Failed to apply: $($file.Name)" -ForegroundColor Red
        Write-Host "  Error: $_"
        exit 1
    }
}

Write-Host "Database deployment completed successfully!" -ForegroundColor Green
```

---

## Section 4: Testing Framework

### Pipeline Testing

```python
# tests/test_pipelines.py
import pytest
import json
import os
from pathlib import Path

WORKSPACE_PATH = Path("synapse-workspace")

class TestPipelineDefinitions:
    """Test Synapse pipeline definitions."""

    @pytest.fixture
    def pipeline_files(self):
        """Get all pipeline definition files."""
        pipeline_dir = WORKSPACE_PATH / "pipeline"
        return list(pipeline_dir.glob("*.json"))

    def test_pipeline_files_exist(self, pipeline_files):
        """Verify pipeline files exist."""
        assert len(pipeline_files) > 0, "No pipeline files found"

    def test_pipeline_json_valid(self, pipeline_files):
        """Verify all pipeline files have valid JSON."""
        for file in pipeline_files:
            with open(file) as f:
                try:
                    json.load(f)
                except json.JSONDecodeError as e:
                    pytest.fail(f"Invalid JSON in {file.name}: {e}")

    def test_pipeline_has_activities(self, pipeline_files):
        """Verify all pipelines have at least one activity."""
        for file in pipeline_files:
            with open(file) as f:
                pipeline = json.load(f)
                activities = pipeline.get("properties", {}).get("activities", [])
                assert len(activities) > 0, f"Pipeline {file.name} has no activities"

    def test_pipeline_activity_names_unique(self, pipeline_files):
        """Verify activity names are unique within each pipeline."""
        for file in pipeline_files:
            with open(file) as f:
                pipeline = json.load(f)
                activities = pipeline.get("properties", {}).get("activities", [])
                names = [a.get("name") for a in activities]
                assert len(names) == len(set(names)), f"Duplicate activity names in {file.name}"

class TestNotebookDefinitions:
    """Test Synapse notebook definitions."""

    @pytest.fixture
    def notebook_files(self):
        """Get all notebook definition files."""
        notebook_dir = WORKSPACE_PATH / "notebook"
        return list(notebook_dir.glob("*.json"))

    def test_notebook_has_cells(self, notebook_files):
        """Verify notebooks have cells."""
        for file in notebook_files:
            with open(file) as f:
                notebook = json.load(f)
                cells = notebook.get("properties", {}).get("cells", [])
                assert len(cells) > 0, f"Notebook {file.name} has no cells"

    def test_notebook_spark_pool_configured(self, notebook_files):
        """Verify notebooks have Spark pool configured."""
        for file in notebook_files:
            with open(file) as f:
                notebook = json.load(f)
                big_data_pool = notebook.get("properties", {}).get("bigDataPool", {})
                assert big_data_pool, f"Notebook {file.name} has no Spark pool configured"
```

### Integration Testing

```python
# tests/integration/test_data_pipelines.py
import pytest
from azure.identity import DefaultAzureCredential
from azure.synapse.artifacts import ArtifactsClient
import time

@pytest.fixture(scope="module")
def synapse_client():
    """Create Synapse client."""
    credential = DefaultAzureCredential()
    endpoint = "https://synapse-dev.dev.azuresynapse.net"
    return ArtifactsClient(credential, endpoint)

class TestPipelineExecution:
    """Integration tests for pipeline execution."""

    def test_daily_ingestion_pipeline(self, synapse_client):
        """Test daily ingestion pipeline runs successfully."""
        pipeline_name = "DailyIngestion"

        # Trigger pipeline run
        run_response = synapse_client.pipeline.create_pipeline_run(
            pipeline_name,
            parameters={"runDate": "2024-01-15"}
        )

        run_id = run_response.run_id

        # Wait for completion (timeout: 30 minutes)
        timeout = 1800
        start_time = time.time()

        while time.time() - start_time < timeout:
            run = synapse_client.pipeline_run.get_pipeline_run(run_id)

            if run.status in ["Succeeded"]:
                break
            elif run.status in ["Failed", "Cancelled"]:
                pytest.fail(f"Pipeline failed with status: {run.status}")

            time.sleep(30)
        else:
            pytest.fail("Pipeline execution timed out")

        assert run.status == "Succeeded"

    def test_data_quality_checks(self, synapse_client):
        """Test data quality pipeline."""
        pipeline_name = "DataQuality"

        run_response = synapse_client.pipeline.create_pipeline_run(pipeline_name)
        run_id = run_response.run_id

        # Wait for completion
        time.sleep(60)

        run = synapse_client.pipeline_run.get_pipeline_run(run_id)
        assert run.status == "Succeeded"
```

---

## Section 5: Environment Configuration

### Parameter Files

```json
// config/dev.parameters.json
{
  "environment": "dev",
  "synapse": {
    "workspaceName": "synapse-dev",
    "resourceGroup": "rg-synapse-dev",
    "sqlPoolName": "sqlpool-dev",
    "sparkPoolName": "sparkpool-dev"
  },
  "storage": {
    "accountName": "datalakedev",
    "containerName": "data"
  },
  "linkedServices": {
    "dataLakeUrl": "https://datalakedev.dfs.core.windows.net",
    "sqlServerUrl": "synapse-dev.sql.azuresynapse.net"
  }
}
```

```json
// config/prod.parameters.json
{
  "environment": "prod",
  "synapse": {
    "workspaceName": "synapse-prod",
    "resourceGroup": "rg-synapse-prod",
    "sqlPoolName": "sqlpool-prod",
    "sparkPoolName": "sparkpool-prod"
  },
  "storage": {
    "accountName": "datalakeprod",
    "containerName": "data"
  },
  "linkedServices": {
    "dataLakeUrl": "https://datalakeprod.dfs.core.windows.net",
    "sqlServerUrl": "synapse-prod.sql.azuresynapse.net"
  }
}
```

### Environment Variable Substitution

```python
# scripts/apply_parameters.py
import json
import os
import sys
from pathlib import Path
import re

def apply_parameters(artifact_path: str, params_file: str, output_path: str):
    """Apply environment parameters to Synapse artifacts."""

    # Load parameters
    with open(params_file) as f:
        params = json.load(f)

    # Flatten parameters for substitution
    def flatten_dict(d, parent_key='', sep='.'):
        items = []
        for k, v in d.items():
            new_key = f"{parent_key}{sep}{k}" if parent_key else k
            if isinstance(v, dict):
                items.extend(flatten_dict(v, new_key, sep=sep).items())
            else:
                items.append((new_key, v))
        return dict(items)

    flat_params = flatten_dict(params)

    # Process each artifact file
    artifact_dir = Path(artifact_path)
    output_dir = Path(output_path)
    output_dir.mkdir(parents=True, exist_ok=True)

    for file in artifact_dir.rglob("*.json"):
        with open(file) as f:
            content = f.read()

        # Replace placeholders
        for key, value in flat_params.items():
            placeholder = f"${{{key}}}"
            content = content.replace(placeholder, str(value))

        # Write to output
        relative_path = file.relative_to(artifact_dir)
        output_file = output_dir / relative_path
        output_file.parent.mkdir(parents=True, exist_ok=True)

        with open(output_file, 'w') as f:
            f.write(content)

        print(f"Processed: {relative_path}")

if __name__ == "__main__":
    apply_parameters(sys.argv[1], sys.argv[2], sys.argv[3])
```

---

## Exercises

### Exercise 1: Set Up CI/CD Pipeline
Create a complete CI/CD pipeline for your Synapse workspace.

### Exercise 2: Implement Database Migrations
Create a migration framework for your dedicated SQL pool.

### Exercise 3: Add Testing
Implement unit and integration tests for pipelines and notebooks.

---

## Best Practices Summary

| Area | Recommendation |
|------|----------------|
| Branching | Use GitFlow or trunk-based development |
| Testing | Automate validation and integration tests |
| Secrets | Use Key Vault, never commit secrets |
| Environments | Maintain parity between dev/staging/prod |
| Deployments | Use incremental deployments when possible |
| Rollback | Always have a rollback strategy |

---

## Summary

Congratulations! You have completed the Azure Synapse Analytics tutorial series. You now have the knowledge to:

- Set up and configure Synapse workspaces
- Build data pipelines and transformations
- Implement security and monitoring
- Deploy using CI/CD best practices

## Additional Resources

- [Azure Synapse Documentation](https://docs.microsoft.com/azure/synapse-analytics/)
- [Best Practices Guide](../../best-practices/index.md)
- [Troubleshooting Guide](../../troubleshooting/index.md)
- [Code Examples](../../code-examples/index.md)
