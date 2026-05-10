---
title: "CI/CD for Analytics Pipelines Lab"
description: "**Master continuous integration and deployment for analytics pipelines."
tags:
  - tutorials
  - code-labs
---
# 🚀 CI/CD for Analytics Pipelines Lab

![Lab](https://img.shields.io/badge/Lab-CI/CD_Analytics-purple)
![Duration](https://img.shields.io/badge/Duration-4--5_hours-orange)
![Level](https://img.shields.io/badge/Level-Advanced-red)
![Tech](https://img.shields.io/badge/Tech-Azure_DevOps_|_GitHub_Actions-blue)

**Master continuous integration and deployment for analytics pipelines. Build automated deployment workflows for Synapse notebooks, SQL scripts, and data pipelines with comprehensive testing and validation.**

## 🎯 Learning Objectives

By completing this lab, you will be able to:

- ✅ **Design CI/CD pipelines** for analytics workloads and data platforms
- ✅ **Implement automated testing** for notebooks, SQL scripts, and pipelines
- ✅ **Manage version control** for Synapse artifacts using Git integration
- ✅ **Deploy infrastructure and code** using Infrastructure as Code principles
- ✅ **Monitor deployment health** and implement automated rollback strategies
- ✅ **Apply GitOps principles** to analytics workflows and data operations

## ⏱️ Time Estimate: 4-5 hours

- **Setup & Configuration**: 45 minutes
- **Version Control Integration**: 60 minutes
- **CI Pipeline Development**: 90 minutes
- **CD Pipeline Implementation**: 60 minutes
- **Testing & Validation**: 45 minutes

## 📋 Prerequisites

**Required Knowledge:**

- Git version control fundamentals
- Azure DevOps or GitHub Actions experience
- Understanding of Synapse workspace architecture
- Basic PowerShell or Azure CLI knowledge
- Completed [Bicep Deployment Lab](bicep-deployment.md)

**Azure Resources:**

- Azure Synapse workspace (development and production)
- Azure DevOps organization or GitHub repository
- Azure Key Vault for secrets management
- Service principal with appropriate permissions

## 🧪 Lab Environment Setup

### **Azure DevOps Configuration**

```bash
# Install Azure DevOps CLI extension
az extension add --name azure-devops

# Set default organization
az devops configure --defaults organization=https://dev.azure.com/your-org project=AnalyticsPlatform

# Create service connection for Azure
az devops service-endpoint azurerm create \
  --azure-rm-service-principal-id $SP_APP_ID \
  --azure-rm-subscription-id $SUBSCRIPTION_ID \
  --azure-rm-subscription-name "Analytics Subscription" \
  --azure-rm-tenant-id $TENANT_ID \
  --name "Synapse-ServiceConnection"
```

### **GitHub Actions Configuration**

```bash
# Configure GitHub secrets
gh secret set AZURE_CREDENTIALS --body '{
  "clientId": "YOUR_CLIENT_ID",
  "clientSecret": "YOUR_CLIENT_SECRET",
  "subscriptionId": "YOUR_SUBSCRIPTION_ID",
  "tenantId": "YOUR_TENANT_ID"
}'

gh secret set SYNAPSE_WORKSPACE_NAME --body "synapse-analytics-prod"
gh secret set RESOURCE_GROUP_NAME --body "rg-analytics-prod"
```

### **Synapse Git Integration**

```python
# Configure Synapse workspace Git integration via Azure Portal or ARM template
{
  "type": "Microsoft.Synapse/workspaces",
  "properties": {
    "workspaceRepositoryConfiguration": {
      "type": "GitHub",
      "accountName": "your-github-org",
      "repositoryName": "synapse-analytics",
      "collaborationBranch": "main",
      "rootFolder": "/synapse",
      "tenantId": "YOUR_TENANT_ID"
    }
  }
}
```

## 📦 Module 1: Version Control Strategy (60 minutes)

### **Exercise 1.1: Repository Structure**

```bash
# Recommended repository structure for analytics projects
synapse-analytics/
├── .github/
│   └── workflows/
│       ├── ci-pipeline.yml
│       ├── cd-dev.yml
│       ├── cd-prod.yml
│       └── data-quality-tests.yml
├── infrastructure/
│   ├── bicep/
│   │   ├── main.bicep
│   │   ├── synapse.bicep
│   │   └── monitoring.bicep
│   └── scripts/
│       ├── deploy-infra.ps1
│       └── deploy-artifacts.ps1
├── synapse/
│   ├── notebook/
│   │   ├── ingestion/
│   │   ├── transformation/
│   │   └── analytics/
│   ├── pipeline/
│   │   ├── master-pipelines/
│   │   └── sub-pipelines/
│   ├── sqlscript/
│   │   ├── views/
│   │   ├── stored-procedures/
│   │   └── schema/
│   └── dataset/
├── tests/
│   ├── unit/
│   ├── integration/
│   └── data-quality/
├── .gitignore
└── README.md
```

### **Exercise 1.2: Branching Strategy**

```bash
# Implement Git Flow for analytics projects

# Feature development
git checkout -b feature/customer-segmentation-pipeline

# Work on feature, commit changes
git add synapse/pipeline/customer-segmentation.json
git commit -m "feat: add customer segmentation pipeline with ML integration"

# Create pull request
git push origin feature/customer-segmentation-pipeline

# After PR approval and merge to develop
git checkout develop
git pull origin develop

# Release preparation
git checkout -b release/v1.2.0
# Update version numbers, finalize documentation
git commit -m "chore: prepare release v1.2.0"

# Merge to main and tag
git checkout main
git merge release/v1.2.0
git tag -a v1.2.0 -m "Release version 1.2.0 - Customer Segmentation"
git push origin main --tags

# Hotfix for production issue
git checkout -b hotfix/fix-data-quality-check main
# Fix the issue
git commit -m "fix: correct data quality validation logic"
# Merge to both main and develop
```

### **🎯 Challenge 1: Synapse Artifact Versioning**

```powershell
# Create a PowerShell script to export Synapse artifacts for version control

<#
.SYNOPSIS
    Export Synapse artifacts to Git repository
.DESCRIPTION
    Exports notebooks, pipelines, SQL scripts from Synapse to local Git repo
#>

param(
    [string]$WorkspaceName,
    [string]$ResourceGroup,
    [string]$OutputPath
)

# YOUR IMPLEMENTATION:
# 1. Connect to Synapse workspace
# 2. Export all notebooks
# 3. Export all pipelines
# 4. Export SQL scripts
# 5. Format JSON files consistently
# 6. Generate manifest file with checksums
```

## 🔧 Module 2: Continuous Integration Pipeline (90 minutes)

### **Exercise 2.1: GitHub Actions CI Pipeline**

```yaml
# .github/workflows/ci-pipeline.yml
name: Analytics CI Pipeline

on:
  pull_request:
    branches: [ develop, main ]
    paths:
      - 'synapse/**'
      - 'tests/**'
      - 'infrastructure/**'
  push:
    branches: [ develop ]

env:
  PYTHON_VERSION: '3.9'
  SPARK_VERSION: '3.2'

jobs:
  # Job 1: Code Quality Checks
  code-quality:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: ${{ env.PYTHON_VERSION }}

      - name: Install dependencies
        run: |
          pip install flake8 black pylint
          pip install pyspark==${{ env.SPARK_VERSION }}

      - name: Lint Python code
        run: |
          flake8 synapse/notebook --count --select=E9,F63,F7,F82 --show-source --statistics
          black --check synapse/notebook

      - name: Validate JSON artifacts
        run: |
          find synapse -name "*.json" | xargs -I {} python -m json.tool {} > /dev/null

  # Job 2: Unit Tests
  unit-tests:
    runs-on: ubuntu-latest
    needs: code-quality
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: ${{ env.PYTHON_VERSION }}

      - name: Install test dependencies
        run: |
          pip install pytest pytest-cov pytest-spark
          pip install pyspark==${{ env.SPARK_VERSION }}

      - name: Run unit tests
        run: |
          pytest tests/unit -v --cov=synapse --cov-report=xml

      - name: Upload coverage reports
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage.xml
          flags: unittests

  # Job 3: Integration Tests
  integration-tests:
    runs-on: ubuntu-latest
    needs: unit-tests
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Azure Login
        uses: azure/login@v1
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}

      - name: Run integration tests
        env:
          SYNAPSE_WORKSPACE: ${{ secrets.SYNAPSE_DEV_WORKSPACE }}
          RESOURCE_GROUP: ${{ secrets.DEV_RESOURCE_GROUP }}
        run: |
          pytest tests/integration -v --workspace=$SYNAPSE_WORKSPACE

  # Job 4: Data Quality Tests
  data-quality-tests:
    runs-on: ubuntu-latest
    needs: unit-tests
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: ${{ env.PYTHON_VERSION }}

      - name: Install Great Expectations
        run: pip install great-expectations

      - name: Run data quality validations
        run: |
          great_expectations checkpoint run data_quality_checkpoint

      - name: Upload validation results
        if: failure()
        uses: actions/upload-artifact@v3
        with:
          name: data-quality-results
          path: great_expectations/uncommitted/validations/

  # Job 5: Security Scanning
  security-scan:
    runs-on: ubuntu-latest
    needs: code-quality
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: 'fs'
          scan-ref: '.'
          format: 'sarif'
          output: 'trivy-results.sarif'

      - name: Upload Trivy results to GitHub Security
        uses: github/codeql-action/upload-sarif@v2
        with:
          sarif_file: 'trivy-results.sarif'

  # Job 6: Build Status Summary
  ci-status:
    runs-on: ubuntu-latest
    needs: [code-quality, unit-tests, integration-tests, data-quality-tests, security-scan]
    if: always()
    steps:
      - name: Check all jobs status
        run: |
          echo "CI Pipeline Status:"
          echo "Code Quality: ${{ needs.code-quality.result }}"
          echo "Unit Tests: ${{ needs.unit-tests.result }}"
          echo "Integration Tests: ${{ needs.integration-tests.result }}"
          echo "Data Quality: ${{ needs.data-quality-tests.result }}"
          echo "Security Scan: ${{ needs.security-scan.result }}"
```

### **Exercise 2.2: Azure DevOps CI Pipeline**

```yaml
# azure-pipelines-ci.yml
trigger:
  branches:
    include:
      - develop
      - main
  paths:
    include:
      - synapse/*
      - tests/*
      - infrastructure/*

pool:
  vmImage: 'ubuntu-latest'

variables:
  pythonVersion: '3.9'
  sparkVersion: '3.2'

stages:
- stage: Build
  displayName: 'Build and Test'
  jobs:
  - job: CodeQuality
    displayName: 'Code Quality Checks'
    steps:
    - task: UsePythonVersion@0
      inputs:
        versionSpec: '$(pythonVersion)'

    - script: |
        pip install flake8 black pylint
        flake8 synapse/notebook --count --statistics
        black --check synapse/notebook
      displayName: 'Lint Python Code'

    - script: |
        find synapse -name "*.json" -exec python -m json.tool {} \; > /dev/null
      displayName: 'Validate JSON Files'

  - job: UnitTests
    displayName: 'Run Unit Tests'
    dependsOn: CodeQuality
    steps:
    - task: UsePythonVersion@0
      inputs:
        versionSpec: '$(pythonVersion)'

    - script: |
        pip install pytest pytest-cov pyspark==$(sparkVersion)
        pytest tests/unit -v --cov --cov-report=html --cov-report=xml
      displayName: 'Execute Unit Tests'

    - task: PublishCodeCoverageResults@1
      inputs:
        codeCoverageTool: 'Cobertura'
        summaryFileLocation: '$(System.DefaultWorkingDirectory)/coverage.xml'

  - job: IntegrationTests
    displayName: 'Integration Tests'
    dependsOn: UnitTests
    steps:
    - task: AzureCLI@2
      inputs:
        azureSubscription: 'Synapse-ServiceConnection'
        scriptType: 'bash'
        scriptLocation: 'inlineScript'
        inlineScript: |
          pytest tests/integration -v \
            --workspace=$(SYNAPSE_DEV_WORKSPACE) \
            --resource-group=$(DEV_RESOURCE_GROUP)

  - job: DataQuality
    displayName: 'Data Quality Validation'
    dependsOn: UnitTests
    steps:
    - script: |
        pip install great-expectations
        great_expectations checkpoint run data_quality_checkpoint
      displayName: 'Run Great Expectations'

    - task: PublishTestResults@2
      condition: always()
      inputs:
        testResultsFormat: 'JUnit'
        testResultsFiles: 'great_expectations/uncommitted/validations/**/*.xml'

- stage: PublishArtifacts
  displayName: 'Publish Build Artifacts'
  dependsOn: Build
  condition: succeeded()
  jobs:
  - job: Package
    displayName: 'Package Artifacts'
    steps:
    - task: CopyFiles@2
      inputs:
        SourceFolder: 'synapse'
        Contents: '**'
        TargetFolder: '$(Build.ArtifactStagingDirectory)/synapse'

    - task: CopyFiles@2
      inputs:
        SourceFolder: 'infrastructure'
        Contents: '**'
        TargetFolder: '$(Build.ArtifactStagingDirectory)/infrastructure'

    - task: PublishBuildArtifacts@1
      inputs:
        PathtoPublish: '$(Build.ArtifactStagingDirectory)'
        ArtifactName: 'analytics-artifacts'
```

### **Exercise 2.3: Notebook Testing Framework**

```python
# tests/unit/test_notebook_functions.py
"""Unit tests for Synapse notebook functions"""

import pytest
from pyspark.sql import SparkSession
from pyspark.sql.types import StructType, StructField, StringType, IntegerType, DoubleType

@pytest.fixture(scope="session")
def spark():
    """Create Spark session for testing"""
    return SparkSession.builder \
        .appName("NotebookUnitTests") \
        .master("local[2]") \
        .getOrCreate()

@pytest.fixture
def sample_data(spark):
    """Create sample test data"""
    schema = StructType([
        StructField("customer_id", StringType(), True),
        StructField("transaction_amount", DoubleType(), True),
        StructField("category", StringType(), True)
    ])

    data = [
        ("CUST001", 100.50, "Electronics"),
        ("CUST002", 50.25, "Clothing"),
        ("CUST003", 200.00, "Electronics"),
    ]

    return spark.createDataFrame(data, schema)

def test_data_transformation(spark, sample_data):
    """Test data transformation logic"""
    from synapse.notebook.transformation import apply_business_rules

    result = apply_business_rules(sample_data)

    assert result.count() == 3
    assert "discount_applied" in result.columns
    assert result.filter("discount_applied = true").count() > 0

def test_aggregation_logic(spark, sample_data):
    """Test aggregation calculations"""
    from synapse.notebook.analytics import calculate_customer_metrics

    metrics = calculate_customer_metrics(sample_data)

    assert metrics.count() == 3
    assert "total_spend" in metrics.columns

    electronics_spend = metrics.filter("category = 'Electronics'") \
        .agg({"total_spend": "sum"}).collect()[0][0]

    assert electronics_spend == 300.50

def test_data_quality_checks(spark, sample_data):
    """Test data quality validation"""
    from synapse.notebook.validation import validate_data_quality

    validation_result = validate_data_quality(sample_data)

    assert validation_result["is_valid"] == True
    assert validation_result["null_count"] == 0
    assert validation_result["duplicate_count"] == 0
```

## 🚢 Module 3: Continuous Deployment Pipeline (60 minutes)

### **Exercise 3.1: Multi-Environment Deployment**

```yaml
# .github/workflows/cd-pipeline.yml
name: Analytics CD Pipeline

on:
  push:
    branches: [ main ]
    tags:
      - 'v*'
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        required: true
        type: choice
        options:
          - development
          - staging
          - production

jobs:
  deploy-dev:
    name: Deploy to Development
    if: github.ref == 'refs/heads/develop'
    runs-on: ubuntu-latest
    environment:
      name: development
      url: https://synapse-dev.azuresynapse.net
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Azure Login
        uses: azure/login@v1
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS_DEV }}

      - name: Deploy Infrastructure
        uses: azure/arm-deploy@v1
        with:
          resourceGroupName: ${{ secrets.DEV_RESOURCE_GROUP }}
          template: ./infrastructure/bicep/main.bicep
          parameters: environment=dev

      - name: Deploy Synapse Artifacts
        run: |
          chmod +x infrastructure/scripts/deploy-artifacts.ps1
          pwsh infrastructure/scripts/deploy-artifacts.ps1 \
            -WorkspaceName ${{ secrets.SYNAPSE_DEV_WORKSPACE }} \
            -ResourceGroup ${{ secrets.DEV_RESOURCE_GROUP }} \
            -ArtifactsPath ./synapse

  deploy-staging:
    name: Deploy to Staging
    needs: deploy-dev
    if: github.event_name == 'workflow_dispatch' && github.event.inputs.environment == 'staging'
    runs-on: ubuntu-latest
    environment:
      name: staging
      url: https://synapse-staging.azuresynapse.net
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Azure Login
        uses: azure/login@v1
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS_STAGING }}

      - name: Run smoke tests
        run: pytest tests/smoke -v --environment=staging

      - name: Deploy with approval
        uses: azure/arm-deploy@v1
        with:
          resourceGroupName: ${{ secrets.STAGING_RESOURCE_GROUP }}
          template: ./infrastructure/bicep/main.bicep
          parameters: environment=staging

  deploy-production:
    name: Deploy to Production
    needs: deploy-staging
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://synapse-prod.azuresynapse.net
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Create deployment snapshot
        run: |
          mkdir deployment-snapshot
          cp -r synapse deployment-snapshot/
          tar -czf deployment-${{ github.ref_name }}.tar.gz deployment-snapshot/

      - name: Upload snapshot to storage
        uses: azure/CLI@v1
        with:
          inlineScript: |
            az storage blob upload \
              --account-name ${{ secrets.STORAGE_ACCOUNT }} \
              --container deployment-snapshots \
              --name deployment-${{ github.ref_name }}.tar.gz \
              --file deployment-${{ github.ref_name }}.tar.gz

      - name: Azure Login
        uses: azure/login@v1
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS_PROD }}

      - name: Deploy to Production
        uses: azure/arm-deploy@v1
        with:
          resourceGroupName: ${{ secrets.PROD_RESOURCE_GROUP }}
          template: ./infrastructure/bicep/main.bicep
          parameters: environment=prod

      - name: Run post-deployment tests
        run: pytest tests/smoke -v --environment=production

      - name: Send deployment notification
        uses: 8398a7/action-slack@v3
        with:
          status: ${{ job.status }}
          text: 'Production deployment ${{ github.ref_name }} completed'
          webhook_url: ${{ secrets.SLACK_WEBHOOK }}
```

### **Exercise 3.2: Synapse Artifact Deployment Script**

```powershell
# infrastructure/scripts/deploy-artifacts.ps1
<#
.SYNOPSIS
    Deploy Synapse artifacts to workspace
.DESCRIPTION
    Deploys notebooks, pipelines, datasets, and SQL scripts to Synapse workspace
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$WorkspaceName,

    [Parameter(Mandatory=$true)]
    [string]$ResourceGroup,

    [Parameter(Mandatory=$true)]
    [string]$ArtifactsPath,

    [Parameter(Mandatory=$false)]
    [bool]$ValidateOnly = $false
)

# Import Synapse module
Import-Module Az.Synapse

# Connect to Azure
Write-Host "Connecting to Azure..."
Connect-AzAccount -Identity

# Set context
Set-AzContext -SubscriptionId $env:AZURE_SUBSCRIPTION_ID

Write-Host "Deploying to workspace: $WorkspaceName"

# Deploy Notebooks
Write-Host "Deploying Notebooks..."
$notebooks = Get-ChildItem -Path "$ArtifactsPath/notebook" -Filter "*.json" -Recurse

foreach ($notebook in $notebooks) {
    Write-Host "  - Deploying $($notebook.Name)..."

    if (-not $ValidateOnly) {
        Set-AzSynapseNotebook `
            -WorkspaceName $WorkspaceName `
            -Name $notebook.BaseName `
            -DefinitionFile $notebook.FullName `
            -Force
    }
}

# Deploy Pipelines
Write-Host "Deploying Pipelines..."
$pipelines = Get-ChildItem -Path "$ArtifactsPath/pipeline" -Filter "*.json" -Recurse

foreach ($pipeline in $pipelines) {
    Write-Host "  - Deploying $($pipeline.Name)..."

    if (-not $ValidateOnly) {
        Set-AzSynapsePipeline `
            -WorkspaceName $WorkspaceName `
            -Name $pipeline.BaseName `
            -DefinitionFile $pipeline.FullName `
            -Force
    }
}

# Deploy SQL Scripts
Write-Host "Deploying SQL Scripts..."
$sqlScripts = Get-ChildItem -Path "$ArtifactsPath/sqlscript" -Filter "*.sql" -Recurse

foreach ($script in $sqlScripts) {
    Write-Host "  - Deploying $($script.Name)..."

    if (-not $ValidateOnly) {
        Set-AzSynapseSqlScript `
            -WorkspaceName $WorkspaceName `
            -Name $script.BaseName `
            -DefinitionFile $script.FullName `
            -Force
    }
}

# Deploy Datasets
Write-Host "Deploying Datasets..."
$datasets = Get-ChildItem -Path "$ArtifactsPath/dataset" -Filter "*.json" -Recurse

foreach ($dataset in $datasets) {
    Write-Host "  - Deploying $($dataset.Name)..."

    if (-not $ValidateOnly) {
        Set-AzSynapseDataset `
            -WorkspaceName $WorkspaceName `
            -Name $dataset.BaseName `
            -DefinitionFile $dataset.FullName `
            -Force
    }
}

Write-Host "✅ Deployment completed successfully!"
```

## 🧪 Module 4: Testing & Validation (45 minutes)

### **Exercise 4.1: Data Quality Testing with Great Expectations**

```python
# tests/data-quality/test_data_quality.py
"""Data quality tests using Great Expectations"""

import great_expectations as gx
from great_expectations.data_context import DataContext

def test_transaction_data_quality():
    """Validate transaction data quality"""

    # Initialize Great Expectations
    context = DataContext("./great_expectations")

    # Create expectation suite
    suite = context.create_expectation_suite(
        "transaction_quality_suite",
        overwrite_existing=True
    )

    # Add expectations
    batch = context.get_batch({
        "path": "abfss://data@storage.dfs.core.windows.net/transactions/",
        "reader_method": "read_delta"
    }, suite)

    # Expected column presence
    batch.expect_table_columns_to_match_ordered_list([
        "transaction_id", "customer_id", "product_id",
        "amount", "quantity", "transaction_date"
    ])

    # No null values in key columns
    batch.expect_column_values_to_not_be_null("transaction_id")
    batch.expect_column_values_to_not_be_null("customer_id")
    batch.expect_column_values_to_not_be_null("amount")

    # Value constraints
    batch.expect_column_values_to_be_between("amount", min_value=0, max_value=100000)
    batch.expect_column_values_to_be_between("quantity", min_value=1, max_value=1000)

    # Format validation
    batch.expect_column_values_to_match_regex(
        "transaction_id",
        regex="^TXN-[0-9]{6}$"
    )

    # Uniqueness check
    batch.expect_column_values_to_be_unique("transaction_id")

    # Save suite
    batch.save_expectation_suite()

    # Run validation
    results = context.run_checkpoint(
        checkpoint_name="data_quality_checkpoint",
        batch_request={
            "datasource_name": "synapse_datasource",
            "data_connector_name": "default_runtime_data_connector",
            "data_asset_name": "transactions"
        }
    )

    assert results["success"], "Data quality validation failed"

def test_customer_data_completeness():
    """Validate customer data completeness and accuracy"""

    context = DataContext("./great_expectations")

    batch = context.get_batch({
        "path": "abfss://data@storage.dfs.core.windows.net/customers/",
        "reader_method": "read_delta"
    })

    # Email format validation
    batch.expect_column_values_to_match_regex(
        "email",
        regex="^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$"
    )

    # Phone number validation
    batch.expect_column_values_to_match_regex(
        "phone",
        regex="^\\+?[1-9]\\d{1,14}$"
    )

    # Age constraints
    batch.expect_column_values_to_be_between("age", min_value=18, max_value=120)

    results = batch.validate()
    assert results["success"], "Customer data validation failed"
```

### **Exercise 4.2: Integration Test Suite**

```python
# tests/integration/test_pipeline_integration.py
"""Integration tests for Synapse pipelines"""

import pytest
from azure.identity import DefaultAzureCredential
from azure.synapse.artifacts import ArtifactsClient
from azure.synapse.artifacts.models import PipelineRunResponse
import time

@pytest.fixture
def synapse_client():
    """Create Synapse artifacts client"""
    credential = DefaultAzureCredential()
    endpoint = f"https://{os.getenv('SYNAPSE_WORKSPACE')}.dev.azuresynapse.net"
    return ArtifactsClient(credential, endpoint)

def test_ingestion_pipeline_execution(synapse_client):
    """Test data ingestion pipeline end-to-end"""

    # Trigger pipeline
    pipeline_name = "DataIngestionPipeline"
    run_response = synapse_client.pipeline_run.run_pipeline(
        pipeline_name,
        parameters={
            "sourcePath": "abfss://source@storage.dfs.core.windows.net/test-data/",
            "targetPath": "abfss://target@storage.dfs.core.windows.net/ingested/"
        }
    )

    run_id = run_response.run_id
    print(f"Pipeline run started: {run_id}")

    # Wait for completion (with timeout)
    timeout = 600  # 10 minutes
    start_time = time.time()

    while True:
        status = synapse_client.pipeline_run.get_pipeline_run(run_id)

        if status.status in ['Succeeded', 'Failed', 'Cancelled']:
            break

        if time.time() - start_time > timeout:
            pytest.fail("Pipeline execution timeout")

        time.sleep(30)

    # Assert success
    assert status.status == 'Succeeded', f"Pipeline failed: {status.message}"

    # Validate output data exists
    from azure.storage.filedatalake import DataLakeServiceClient

    credential = DefaultAzureCredential()
    service_client = DataLakeServiceClient(
        account_url="https://storage.dfs.core.windows.net",
        credential=credential
    )

    file_system = service_client.get_file_system_client("target")
    paths = file_system.get_paths(path="ingested/")

    assert any(paths), "No output files found"

def test_transformation_pipeline_data_quality(synapse_client):
    """Test transformation pipeline produces quality data"""

    pipeline_name = "DataTransformationPipeline"
    run_response = synapse_client.pipeline_run.run_pipeline(pipeline_name)

    # Wait for completion
    run_id = run_response.run_id
    status = wait_for_pipeline_completion(synapse_client, run_id)

    assert status.status == 'Succeeded'

    # Validate transformed data quality
    from pyspark.sql import SparkSession

    spark = SparkSession.builder.getOrCreate()
    transformed_df = spark.read.format("delta").load(
        "abfss://target@storage.dfs.core.windows.net/transformed/"
    )

    # Check row count
    assert transformed_df.count() > 0, "No transformed data found"

    # Check for null values in key columns
    null_counts = transformed_df.select([
        sum(col(c).isNull().cast("int")).alias(c)
        for c in transformed_df.columns
    ]).collect()[0]

    assert all(count == 0 for count in null_counts), "Null values found in output"

def wait_for_pipeline_completion(client, run_id, timeout=600):
    """Helper function to wait for pipeline completion"""
    start_time = time.time()

    while True:
        status = client.pipeline_run.get_pipeline_run(run_id)

        if status.status in ['Succeeded', 'Failed', 'Cancelled']:
            return status

        if time.time() - start_time > timeout:
            raise TimeoutError("Pipeline execution timeout")

        time.sleep(30)
```

## 🔄 Module 5: Monitoring & Rollback (30 minutes)

### **Exercise 5.1: Deployment Monitoring**

```python
# monitoring/deployment-monitor.py
"""Monitor deployment health and trigger rollback if needed"""

from azure.monitor.query import LogsQueryClient, MetricsQueryClient
from azure.identity import DefaultAzureCredential
from datetime import datetime, timedelta

def monitor_deployment_health(workspace_name, resource_group):
    """Monitor Synapse workspace health after deployment"""

    credential = DefaultAzureCredential()
    logs_client = LogsQueryClient(credential)

    # Query for errors in last 15 minutes
    query = f"""
    SynapseIntegrationPipelineRuns
    | where TimeGenerated > ago(15m)
    | where Status == "Failed"
    | summarize FailureCount = count() by PipelineName
    | where FailureCount > 3
    """

    end_time = datetime.now()
    start_time = end_time - timedelta(minutes=15)

    response = logs_client.query_workspace(
        workspace_id=os.getenv("LOG_ANALYTICS_WORKSPACE_ID"),
        query=query,
        timespan=(start_time, end_time)
    )

    failures = []
    for table in response.tables:
        for row in table.rows:
            failures.append({
                "pipeline": row[0],
                "failure_count": row[1]
            })

    if failures:
        print("⚠️ Deployment health check FAILED")
        print(f"Failed pipelines: {failures}")
        return False
    else:
        print("✅ Deployment health check PASSED")
        return True

def rollback_deployment(workspace_name, snapshot_name):
    """Rollback to previous deployment snapshot"""

    print(f"🔄 Rolling back to snapshot: {snapshot_name}")

    # Download snapshot from storage
    from azure.storage.blob import BlobServiceClient

    credential = DefaultAzureCredential()
    blob_service = BlobServiceClient(
        account_url="https://storage.blob.core.windows.net",
        credential=credential
    )

    container_client = blob_service.get_container_client("deployment-snapshots")
    blob_client = container_client.get_blob_client(f"{snapshot_name}.tar.gz")

    # Download and extract snapshot
    with open("rollback-snapshot.tar.gz", "wb") as f:
        f.write(blob_client.download_blob().readall())

    # Extract and deploy
    import tarfile
    with tarfile.open("rollback-snapshot.tar.gz", "r:gz") as tar:
        tar.extractall("./rollback")

    # Deploy snapshot artifacts
    import subprocess
    subprocess.run([
        "pwsh", "infrastructure/scripts/deploy-artifacts.ps1",
        "-WorkspaceName", workspace_name,
        "-ResourceGroup", os.getenv("RESOURCE_GROUP"),
        "-ArtifactsPath", "./rollback/synapse"
    ])

    print("✅ Rollback completed")

# Monitor deployment
if __name__ == "__main__":
    workspace = os.getenv("SYNAPSE_WORKSPACE")
    resource_group = os.getenv("RESOURCE_GROUP")

    is_healthy = monitor_deployment_health(workspace, resource_group)

    if not is_healthy:
        latest_snapshot = os.getenv("LAST_KNOWN_GOOD_SNAPSHOT")
        rollback_deployment(workspace, latest_snapshot)
```

## ✅ Lab Validation

```python
def validate_cicd_implementation():
    """Validate CI/CD implementation"""

    checklist = {
        "Version Control": False,
        "CI Pipeline": False,
        "Automated Tests": False,
        "CD Pipeline": False,
        "Monitoring": False
    }

    # Check Git repository
    if os.path.exists(".git"):
        checklist["Version Control"] = True

    # Check CI/CD pipeline files
    if os.path.exists(".github/workflows/ci-pipeline.yml"):
        checklist["CI Pipeline"] = True

    if os.path.exists(".github/workflows/cd-pipeline.yml"):
        checklist["CD Pipeline"] = True

    # Check test directory
    if os.path.exists("tests/unit") and os.path.exists("tests/integration"):
        checklist["Automated Tests"] = True

    # Check monitoring setup
    if os.path.exists("monitoring/deployment-monitor.py"):
        checklist["Monitoring"] = True

    print("CI/CD Implementation Checklist:")
    for item, status in checklist.items():
        print(f"{'✅' if status else '❌'} {item}")

    return all(checklist.values())

# Run validation
validate_cicd_implementation()
```

## 🎯 Final Project: Production CI/CD Pipeline

Implement a complete CI/CD solution with:

1. **Multi-stage pipeline** (dev → staging → production)
2. **Comprehensive testing** (unit, integration, data quality)
3. **Automated deployments** with approval gates
4. **Health monitoring** with automated rollback
5. **Audit logging** and compliance reporting

## 📚 Additional Resources

- [Azure Synapse CI/CD Best Practices](../../10-devops/pipeline-ci-cd.md)
- [GitHub Actions for Azure](https://docs.microsoft.com/azure/developer/github/github-actions)
- [Azure DevOps for Data Platforms](https://docs.microsoft.com/azure/devops/)
- [Great Expectations Documentation](https://docs.greatexpectations.io/)

---

**Lab Completed Successfully!**

*You now have production-ready CI/CD skills for analytics platforms.*

---

*Lab Version: 1.0*
*Last Updated: January 2025*
*Estimated Completion Time: 4-5 hours*
