# Azure Machine Learning Integration with Azure Synapse Analytics

[Home](../../../README.md) > [Code Examples](../../README.md) > Integration > Azure ML Integration

This guide provides examples and best practices for integrating Azure Synapse Analytics with Azure Machine Learning (Azure ML).

## Prerequisites

- Azure Synapse Analytics workspace
- Azure Machine Learning workspace
- Appropriate permissions on both services
- Azure Storage account accessible by both services

## Linked Service Setup

First, create a linked service between Azure Synapse and Azure Machine Learning:

```python
# PySpark code to configure Azure ML integration in Synapse
from notebookutils import mssparkutils

# Set up Azure ML workspace connection
synapse_workspace_name = "your-synapse-workspace"
ml_workspace_name = "your-ml-workspace"
resource_group = "your-resource-group"
subscription_id = "your-subscription-id"

# Create linked service connection
linked_service_name = "AzureMLService"
mssparkutils.notebook.run("./setup_linked_service.py", 
                         {"workspace_name": ml_workspace_name,
                          "resource_group": resource_group,
                          "subscription_id": subscription_id})
```

## Training a Machine Learning Model with Synapse Data

Example of training an ML model using data from Synapse:

```python
# Import necessary libraries
from azureml.core import Workspace, Experiment, Dataset
from azureml.core.compute import ComputeTarget, SynapseCompute
from azureml.pipeline.core import Pipeline, PipelineData
from azureml.pipeline.steps import SynapseSparkStep, PythonScriptStep
from azureml.core.runconfig import RunConfiguration

# Connect to Azure ML workspace
ws = Workspace.get(name=ml_workspace_name,
                  subscription_id=subscription_id,
                  resource_group=resource_group)

# Set up Synapse as compute target in Azure ML
synapse_compute = SynapseCompute(ws, synapse_workspace_name)

# Create a Synapse Spark step to process data
processed_data = PipelineData("processed_data", datastore=ws.get_default_datastore())
data_prep_step = SynapseSparkStep(
    name="data_preparation",
    synapse_compute=synapse_compute,
    spark_pool_name="your-spark-pool",
    file_name="data_prep.py",
    inputs=[Dataset.get_by_name(ws, "raw_data")],
    outputs=[processed_data],
    arguments=["--output_path", processed_data]
)

# Create a training step using the processed data
model_training_step = PythonScriptStep(
    name="model_training",
    script_name="train.py",
    compute_target=ws.compute_targets["training-cluster"],
    inputs=[processed_data],
    arguments=["--data_path", processed_data,
               "--model_name", "customer_churn_model"]
)

# Create and run the pipeline
pipeline = Pipeline(workspace=ws, steps=[data_prep_step, model_training_step])
experiment = Experiment(ws, "synapse_ml_integration")
pipeline_run = experiment.submit(pipeline)
pipeline_run.wait_for_completion(show_output=True)
```

## Batch Inference with Trained Models

Example of performing batch scoring using a trained model:

```python
# Batch scoring using Azure ML and Synapse
from azureml.core import Model
from azureml.core.dataset import Dataset
from azureml.pipeline.core import PipelineEndpoint

# Get the deployed model endpoint
model = Model(ws, "customer_churn_model")
scoring_endpoint = PipelineEndpoint.get(workspace=ws, name="batch_scoring_pipeline")

# Prepare parameters for batch scoring
parameters = {
    "input_data": Dataset.get_by_name(ws, "new_customers"),
    "model_name": "customer_churn_model",
    "output_path": "abfs://container@account.dfs.core.windows.net/scores/"
}

# Submit batch scoring job
pipeline_run = scoring_endpoint.submit("Batch_scoring_run", parameters=parameters)
pipeline_run.wait_for_completion()
```

## MLOps with Azure Synapse and Azure ML

Example of implementing MLOps practices:

```yaml
# Example Azure DevOps pipeline for MLOps with Synapse and Azure ML
trigger:
- main

pool:
  vmImage: 'ubuntu-latest'

steps:
- task: UsePythonVersion@0
  inputs:
    versionSpec: '3.8'
    addToPath: true

- script: |
    python -m pip install --upgrade pip
    pip install -r requirements.txt
  displayName: 'Install dependencies'

- script: |
    python src/validate_data.py
  displayName: 'Validate data quality'

- task: AzureCLI@2
  inputs:
    azureSubscription: 'your-azure-connection'
    scriptType: 'bash'
    scriptLocation: 'inlineScript'
    inlineScript: |
      az ml run submit-pipeline --resource-group $(resourceGroup) \
                             --workspace-name $(workspaceName) \
                             --experiment-name $(experimentName) \
                             --pipeline-id $(pipelineId)
  displayName: 'Run ML pipeline'
```

## Real-time Model Deployment and Scoring

Example of deploying a model for real-time inference:

```python
# Deploy model to AKS for real-time scoring
from azureml.core.webservice import AksWebservice
from azureml.core.compute import AksCompute
from azureml.core.model import InferenceConfig, Model

# Get the registered model
model = Model(ws, "customer_churn_model")

# Define inference configuration
inference_config = InferenceConfig(
    environment=ws.environments["scoring_env"],
    source_directory="./scoring_scripts",
    entry_script="score.py"
)

# Get or create AKS cluster
try:
    aks_target = AksCompute(ws, "aks-cluster")
except:
    prov_config = AksCompute.provisioning_configuration(vm_size="Standard_D3_v2", 
                                                       agent_count=3)
    aks_target = ComputeTarget.create(ws, "aks-cluster", prov_config)
    aks_target.wait_for_completion(show_output=True)

# Deploy the model
deployment_config = AksWebservice.deploy_configuration(
    cpu_cores=1,
    memory_gb=1,
    enable_app_insights=True,
    auth_enabled=True
)

service = Model.deploy(ws,
                      name="churn-prediction-service",
                      models=[model],
                      inference_config=inference_config,
                      deployment_config=deployment_config,
                      deployment_target=aks_target)

service.wait_for_deployment(show_output=True)
print(service.get_logs())
```

## Best Practices for Synapse and Azure ML Integration

1. __Data Preparation__: Use Synapse Spark pools for data preparation and feature engineering tasks that require distributed computing.

2. __Model Training__: For complex model training, use Azure ML's dedicated compute clusters, which are optimized for machine learning workloads.

3. __Feature Stores__: Implement feature stores using Delta tables in Synapse to ensure consistent features across training and inference.

4. __Pipeline Orchestration__: Use Azure ML pipelines for end-to-end orchestration, with Synapse steps for data processing.

5. __Model Monitoring__: Implement model monitoring using Azure ML and integrate with Azure Monitor for comprehensive observability.

6. __Security Best Practices__:
   - Use managed identities when possible
   - Implement least privilege access
   - Encrypt data at rest and in transit
   - Use private endpoints for service connectivity

7. __Cost Optimization__:
   - Auto-scale compute resources based on workload
   - Schedule pipelines during off-peak hours
   - Use serverless SQL pools for ad-hoc data exploration
   - Monitor and optimize resource usage
