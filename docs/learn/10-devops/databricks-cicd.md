# Databricks CI/CD

> **[Home](../README.md)** | **[DevOps](../devops/README.md)** | **Databricks CI/CD**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Azure%20Databricks-orange?style=flat-square)

CI/CD pipelines for Azure Databricks deployments.

---

## Overview

This guide covers:

- Databricks Asset Bundles (DABs)
- Notebook and job deployment
- Unity Catalog migration
- MLflow model deployment
- Testing strategies

---

## Databricks Asset Bundles

### Bundle Configuration

```yaml
# databricks.yml
bundle:
  name: analytics-pipeline

include:
  - resources/*.yml

targets:
  dev:
    mode: development
    default: true
    workspace:
      host: https://adb-dev.azuredatabricks.net

  staging:
    mode: development
    workspace:
      host: https://adb-staging.azuredatabricks.net

  prod:
    mode: production
    workspace:
      host: https://adb-prod.azuredatabricks.net
    run_as:
      service_principal_name: sp-prod-deployer
```

### Job Definition

```yaml
# resources/jobs.yml
resources:
  jobs:
    etl_daily:
      name: "ETL Daily Pipeline"
      schedule:
        quartz_cron_expression: "0 0 6 * * ?"
        timezone_id: "UTC"

      tasks:
        - task_key: ingest
          notebook_task:
            notebook_path: ./notebooks/01_ingest.py
          new_cluster:
            spark_version: "13.3.x-scala2.12"
            node_type_id: "Standard_DS3_v2"
            num_workers: 2

        - task_key: transform
          depends_on:
            - task_key: ingest
          notebook_task:
            notebook_path: ./notebooks/02_transform.py
          existing_cluster_id: ${var.shared_cluster_id}

        - task_key: validate
          depends_on:
            - task_key: transform
          notebook_task:
            notebook_path: ./notebooks/03_validate.py

      email_notifications:
        on_failure:
          - data-team@company.com
```

---

## Azure DevOps Pipeline

### Build and Deploy

```yaml
# azure-pipelines.yml
trigger:
  branches:
    include:
      - main
      - develop
  paths:
    include:
      - databricks/**

pool:
  vmImage: 'ubuntu-latest'

variables:
  - group: databricks-secrets

stages:
  - stage: Validate
    jobs:
      - job: ValidateBundle
        steps:
          - task: UsePythonVersion@0
            inputs:
              versionSpec: '3.10'

          - script: |
              pip install databricks-cli databricks-sdk
            displayName: 'Install Databricks CLI'

          - script: |
              databricks bundle validate
            displayName: 'Validate Bundle'
            workingDirectory: databricks
            env:
              DATABRICKS_HOST: $(DATABRICKS_HOST_DEV)
              DATABRICKS_TOKEN: $(DATABRICKS_TOKEN_DEV)

  - stage: DeployDev
    dependsOn: Validate
    condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/develop'))
    jobs:
      - deployment: DeployToDev
        environment: 'databricks-dev'
        strategy:
          runOnce:
            deploy:
              steps:
                - script: |
                    databricks bundle deploy --target dev
                  workingDirectory: databricks
                  env:
                    DATABRICKS_HOST: $(DATABRICKS_HOST_DEV)
                    DATABRICKS_TOKEN: $(DATABRICKS_TOKEN_DEV)

  - stage: DeployProd
    dependsOn: Validate
    condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'))
    jobs:
      - deployment: DeployToProd
        environment: 'databricks-prod'
        strategy:
          runOnce:
            deploy:
              steps:
                - script: |
                    databricks bundle deploy --target prod
                  workingDirectory: databricks
                  env:
                    DATABRICKS_HOST: $(DATABRICKS_HOST_PROD)
                    DATABRICKS_TOKEN: $(DATABRICKS_TOKEN_PROD)
```

---

## GitHub Actions

### Workflow Configuration

```yaml
# .github/workflows/databricks-deploy.yml
name: Databricks Deployment

on:
  push:
    branches: [main, develop]
    paths: ['databricks/**']
  pull_request:
    branches: [main]
    paths: ['databricks/**']

env:
  PYTHON_VERSION: '3.10'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - uses: actions/setup-python@v4
        with:
          python-version: ${{ env.PYTHON_VERSION }}

      - name: Install Dependencies
        run: pip install databricks-cli databricks-sdk pytest

      - name: Validate Bundle
        working-directory: databricks
        run: databricks bundle validate
        env:
          DATABRICKS_HOST: ${{ secrets.DATABRICKS_HOST_DEV }}
          DATABRICKS_TOKEN: ${{ secrets.DATABRICKS_TOKEN_DEV }}

  test:
    needs: validate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Run Unit Tests
        run: pytest tests/unit -v

  deploy-dev:
    needs: test
    if: github.ref == 'refs/heads/develop'
    runs-on: ubuntu-latest
    environment: development
    steps:
      - uses: actions/checkout@v3

      - name: Deploy to Dev
        working-directory: databricks
        run: databricks bundle deploy --target dev
        env:
          DATABRICKS_HOST: ${{ secrets.DATABRICKS_HOST_DEV }}
          DATABRICKS_TOKEN: ${{ secrets.DATABRICKS_TOKEN_DEV }}

  deploy-prod:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v3

      - name: Deploy to Prod
        working-directory: databricks
        run: databricks bundle deploy --target prod
        env:
          DATABRICKS_HOST: ${{ secrets.DATABRICKS_HOST_PROD }}
          DATABRICKS_TOKEN: ${{ secrets.DATABRICKS_TOKEN_PROD }}
```

---

## Testing Strategy

### Unit Tests

```python
# tests/unit/test_transformations.py
import pytest
from pyspark.sql import SparkSession
from notebooks.transformations import clean_data, calculate_metrics

@pytest.fixture(scope="session")
def spark():
    return SparkSession.builder \
        .master("local[*]") \
        .appName("unit-tests") \
        .getOrCreate()

def test_clean_data(spark):
    # Arrange
    data = [(1, "Alice", None), (2, "Bob", "active")]
    df = spark.createDataFrame(data, ["id", "name", "status"])

    # Act
    result = clean_data(df)

    # Assert
    assert result.count() == 1
    assert result.filter("status IS NULL").count() == 0

def test_calculate_metrics(spark):
    data = [(1, 100), (1, 200), (2, 150)]
    df = spark.createDataFrame(data, ["customer_id", "amount"])

    result = calculate_metrics(df)

    assert result.count() == 2
    row = result.filter("customer_id = 1").first()
    assert row["total_amount"] == 300
```

### Integration Tests

```python
# tests/integration/test_pipeline.py
import pytest
from databricks.sdk import WorkspaceClient

@pytest.fixture
def workspace():
    return WorkspaceClient()

def test_job_exists(workspace):
    """Verify job was deployed correctly."""
    jobs = workspace.jobs.list(name="ETL Daily Pipeline")
    job_list = list(jobs)
    assert len(job_list) == 1

def test_cluster_config(workspace):
    """Verify cluster configuration."""
    jobs = workspace.jobs.list(name="ETL Daily Pipeline")
    job = list(jobs)[0]
    job_details = workspace.jobs.get(job.job_id)

    task = job_details.settings.tasks[0]
    cluster = task.new_cluster
    assert cluster.num_workers == 2
    assert "Standard_DS3_v2" in cluster.node_type_id
```

---

## MLflow Model Deployment

### Model Registry CI/CD

```python
# deploy_model.py
import mlflow
from mlflow.tracking import MlflowClient

def promote_model(model_name: str, version: int, stage: str):
    """Promote model to specified stage."""
    client = MlflowClient()

    # Transition model version
    client.transition_model_version_stage(
        name=model_name,
        version=version,
        stage=stage,
        archive_existing_versions=True
    )

    print(f"Model {model_name} v{version} promoted to {stage}")

def deploy_to_serving(model_name: str, endpoint_name: str):
    """Deploy model to serving endpoint."""
    from databricks.sdk import WorkspaceClient

    w = WorkspaceClient()

    # Get production model version
    client = MlflowClient()
    prod_version = client.get_latest_versions(model_name, stages=["Production"])[0]

    # Create or update endpoint
    config = {
        "served_entities": [{
            "entity_name": model_name,
            "entity_version": str(prod_version.version),
            "workload_size": "Small",
            "scale_to_zero_enabled": True
        }]
    }

    try:
        w.serving_endpoints.update_config_and_wait(endpoint_name, config)
    except:
        w.serving_endpoints.create_and_wait(name=endpoint_name, config=config)
```

---

## Best Practices

### Repository Structure

```
databricks/
├── databricks.yml           # Bundle configuration
├── resources/
│   ├── jobs.yml            # Job definitions
│   ├── clusters.yml        # Cluster configurations
│   └── pipelines.yml       # DLT pipeline definitions
├── notebooks/
│   ├── 01_ingest.py
│   ├── 02_transform.py
│   └── 03_validate.py
├── src/
│   └── transformations/    # Shared Python modules
├── tests/
│   ├── unit/
│   └── integration/
└── requirements.txt
```

### Security

1. Use service principals for deployments
2. Store secrets in Key Vault
3. Use Unity Catalog for data governance
4. Enable audit logging

---

## Related Documentation

- [Databricks Best Practices](../best-practices/databricks/README.md)
- [MLOps Guide](../best-practices/ml-operations/README.md)
- [DevOps Overview](../devops/README.md)

---

*Last Updated: January 2025*
