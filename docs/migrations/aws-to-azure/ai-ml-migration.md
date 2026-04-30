# AI/ML Migration: SageMaker and Bedrock to Azure AI

**A deep-dive guide for ML engineers and AI developers migrating Amazon SageMaker and Bedrock workloads to Azure Machine Learning, Azure OpenAI, and AI Foundry.**

---

## Executive summary

AWS AI/ML is split across two primary services: SageMaker for custom model training, deployment, and MLOps, and Bedrock for managed foundation model access. Azure provides equivalent capabilities through Azure Machine Learning (custom ML), Azure OpenAI Service (foundation models), AI Foundry (unified AI development), and Databricks ML (Spark-native ML). The Azure AI ecosystem is broader, with deeper integration into the Microsoft productivity suite via Copilot and tighter governance through Purview and Entra ID.

This guide covers model training migration, endpoint deployment, pipeline orchestration, foundation model access (Bedrock to Azure OpenAI), agent architectures (Bedrock Agents to Azure AI Agents), and RAG pattern migration (Bedrock Knowledge Bases to Azure AI Search).

---

## Service mapping overview

| AWS AI/ML service | Azure equivalent | Migration complexity | Notes |
|---|---|---|---|
| SageMaker Studio | Azure ML Studio / AI Foundry | M | Notebook + experiment + deployment IDE |
| SageMaker Training | Azure ML Compute / Databricks ML | M | GPU and CPU cluster training |
| SageMaker Processing | Azure ML Pipeline steps / Databricks Jobs | M | Data processing for ML |
| SageMaker Endpoints (real-time) | Azure ML Managed Endpoints | M | Managed inference hosting |
| SageMaker Batch Transform | Azure ML Batch Endpoints | S | Batch inference |
| SageMaker Pipelines | Azure ML Pipelines / Prompt Flow | M | ML workflow orchestration |
| SageMaker Feature Store | Databricks Feature Store / Azure ML Feature Store | M | Online and offline feature serving |
| SageMaker Model Registry | Azure ML Model Registry / MLflow | S | Model versioning and lifecycle |
| SageMaker Experiments | Azure ML Experiments / MLflow | S | Experiment tracking |
| SageMaker Ground Truth | Azure ML Data Labeling | M | Human-in-the-loop labeling |
| SageMaker Clarify | Azure ML Responsible AI | M | Fairness, explainability |
| SageMaker Model Monitor | Azure ML Model Monitor | M | Drift detection, data quality |
| Bedrock | Azure OpenAI Service | S | Foundation model API access |
| Bedrock Agents | Azure AI Agents / Copilot Studio | M | Autonomous AI agents |
| Bedrock Knowledge Bases | Azure AI Search (RAG) | M | Retrieval-augmented generation |
| Bedrock Guardrails | Azure AI Content Safety | S | Content filtering and moderation |

---

## Part 1: SageMaker Studio to Azure ML Studio and AI Foundry

### Environment comparison

| SageMaker Studio feature | Azure ML Studio | AI Foundry |
|---|---|---|
| JupyterLab notebooks | Azure ML Notebooks (JupyterLab) | AI Foundry Notebooks |
| Kernel gateway | Compute instances (various VM sizes) | Serverless compute |
| Git integration | Native Git integration | Native Git integration |
| Experiment tracking | MLflow integration | Built-in experiment tracking |
| Model registry | Azure ML Model Registry | AI Foundry Model Catalog |
| Endpoint deployment | Managed Endpoints | Model-as-a-Service |
| Studio IDE | VS Code for the Web / JupyterLab | AI Foundry portal |

### Migration approach

**Step 1: Move notebooks and code**

```bash
# Export SageMaker notebooks
# SageMaker stores notebooks in the EFS volume or S3
aws s3 sync s3://sagemaker-us-gov-west-1-123456789012/notebooks/ ./sm_notebooks/

# Push to Git repository (Azure DevOps or GitHub)
cd sm_notebooks
git init
git add .
git commit -m "Import SageMaker notebooks"
git remote add origin https://github.com/agency/ml-notebooks.git
git push -u origin main
```

**Step 2: Adapt SageMaker SDK calls to Azure ML SDK**

```python
# SageMaker training job
import sagemaker
from sagemaker.pytorch import PyTorch

estimator = PyTorch(
    entry_point='train.py',
    role='arn:aws:iam::123456789012:role/SageMakerRole',
    instance_count=2,
    instance_type='ml.p3.8xlarge',
    framework_version='2.1',
    py_version='py310',
    hyperparameters={'epochs': 10, 'batch_size': 64}
)
estimator.fit({'training': 's3://bucket/train/', 'validation': 's3://bucket/val/'})
```

```python
# Azure ML equivalent
from azure.ai.ml import MLClient, command, Input
from azure.identity import DefaultAzureCredential

ml_client = MLClient(
    DefaultAzureCredential(),
    subscription_id="<sub-id>",
    resource_group_name="<rg>",
    workspace_name="<ws>"
)

command_job = command(
    code="./src",
    command="python train.py --epochs 10 --batch_size 64",
    environment="pytorch-2.1-gpu:latest",
    compute="gpu-cluster",  # Pre-created compute cluster
    inputs={
        "training": Input(type="uri_folder", path="azureml://datastores/training/paths/train/"),
        "validation": Input(type="uri_folder", path="azureml://datastores/training/paths/val/")
    },
    instance_count=2
)

returned_job = ml_client.jobs.create_or_update(command_job)
```

**Step 3: Adapt the training script**

The training script (`train.py`) typically requires minimal changes. The main adaptation is data path resolution:

```python
# SageMaker: data paths come from environment variables
import os
train_dir = os.environ.get('SM_CHANNEL_TRAINING', '/opt/ml/input/data/training')
model_dir = os.environ.get('SM_MODEL_DIR', '/opt/ml/model')

# Azure ML: data paths come from command-line arguments or mounted paths
import argparse
parser = argparse.ArgumentParser()
parser.add_argument('--training', type=str)
parser.add_argument('--model_output', type=str, default='./outputs/model')
args = parser.parse_args()
train_dir = args.training
model_dir = args.model_output
```

---

## Part 2: SageMaker Endpoints to Azure ML Managed Endpoints

### Endpoint comparison

| SageMaker endpoint type | Azure ML equivalent | Notes |
|---|---|---|
| Real-time endpoint | Managed Online Endpoint | Auto-scaling, blue/green deployment |
| Serverless endpoint | Serverless Online Endpoint | Scale to zero; pay per invocation |
| Multi-model endpoint | Multiple deployments under one endpoint | Traffic splitting for A/B testing |
| Batch Transform | Batch Endpoint | Async batch inference |
| Inference Recommender | Azure ML profiling | Right-size compute for inference |

### Deployment example

**SageMaker endpoint:**

```python
from sagemaker.pytorch import PyTorchModel

model = PyTorchModel(
    model_data='s3://bucket/model/model.tar.gz',
    role='arn:aws:iam::123456789012:role/SageMakerRole',
    framework_version='2.1',
    py_version='py310',
    entry_point='inference.py'
)

predictor = model.deploy(
    initial_instance_count=2,
    instance_type='ml.g4dn.xlarge',
    endpoint_name='sales-forecast-prod'
)
```

**Azure ML managed endpoint:**

```python
from azure.ai.ml.entities import (
    ManagedOnlineEndpoint,
    ManagedOnlineDeployment,
    Model,
    Environment,
    CodeConfiguration
)

# Create endpoint
endpoint = ManagedOnlineEndpoint(
    name="sales-forecast-prod",
    auth_mode="key"
)
ml_client.online_endpoints.begin_create_or_update(endpoint).result()

# Create deployment
model = Model(path="./model/", type="custom_model")
env = Environment(
    image="mcr.microsoft.com/azureml/pytorch-2.1-cuda11.8-cudnn8-runtime:latest",
    conda_file="./environment/conda.yml"
)

deployment = ManagedOnlineDeployment(
    name="blue",
    endpoint_name="sales-forecast-prod",
    model=model,
    environment=env,
    code_configuration=CodeConfiguration(
        code="./src",
        scoring_script="inference.py"
    ),
    instance_type="Standard_NC4as_T4_v3",
    instance_count=2
)
ml_client.online_deployments.begin_create_or_update(deployment).result()

# Route 100% traffic to the deployment
endpoint.traffic = {"blue": 100}
ml_client.online_endpoints.begin_create_or_update(endpoint).result()
```

---

## Part 3: SageMaker Pipelines to Azure ML Pipelines

### Pipeline comparison

| SageMaker Pipeline step | Azure ML Pipeline equivalent | Notes |
|---|---|---|
| ProcessingStep | Command component | Data processing |
| TrainingStep | Command component (with GPU) | Model training |
| TransformStep | Batch endpoint invocation | Batch inference |
| RegisterModel | Model registration component | Register in registry |
| ConditionStep | Conditional pipeline step | Branching logic |
| FailStep | Pipeline error handling | Error paths |
| TuningStep | Sweep job | Hyperparameter tuning |
| CallbackStep | Custom component | External service integration |

### Pipeline migration example

**SageMaker Pipeline:**

```python
from sagemaker.workflow.pipeline import Pipeline
from sagemaker.workflow.steps import ProcessingStep, TrainingStep

pipeline = Pipeline(
    name="sales-forecast-pipeline",
    steps=[preprocess_step, train_step, evaluate_step, register_step],
    parameters=[input_data, model_approval_status]
)
pipeline.upsert(role_arn=role)
pipeline.start()
```

**Azure ML Pipeline:**

```python
from azure.ai.ml import dsl, Input, Output
from azure.ai.ml.entities import Pipeline

@dsl.pipeline(
    description="Sales forecast training pipeline",
    compute="cpu-cluster"
)
def sales_forecast_pipeline(input_data: Input, model_approval: str = "pending"):
    preprocess = preprocess_component(raw_data=input_data)
    train = train_component(
        training_data=preprocess.outputs.processed_data,
        compute="gpu-cluster"
    )
    evaluate = evaluate_component(
        model=train.outputs.model,
        test_data=preprocess.outputs.test_data
    )
    register = register_component(
        model=train.outputs.model,
        metrics=evaluate.outputs.metrics,
        approval_status=model_approval
    )
    return {"model": register.outputs.registered_model}

pipeline_job = sales_forecast_pipeline(
    input_data=Input(type="uri_folder", path="azureml://datastores/training/paths/sales/")
)
returned_pipeline = ml_client.jobs.create_or_update(pipeline_job)
```

---

## Part 4: Bedrock to Azure OpenAI Service

### Model availability comparison

| Bedrock model | Azure OpenAI equivalent | Notes |
|---|---|---|
| Anthropic Claude 3.5 Sonnet | Claude 3.5 Sonnet (via Azure AI Foundry) | Available as model-as-a-service |
| Amazon Titan Text | No direct equivalent | Use GPT-4o or open-source models |
| Amazon Titan Embeddings | text-embedding-3-large | OpenAI embedding model |
| Meta Llama 3 | Llama 3 (via Azure AI Foundry) | Model-as-a-service deployment |
| Mistral Large | Mistral Large (via Azure AI Foundry) | Model-as-a-service deployment |
| Cohere Command R+ | Cohere Command R+ (via Azure AI Foundry) | Model-as-a-service deployment |
| AI21 Jurassic | No direct equivalent | Use GPT-4o |
| Stability AI SDXL | DALL-E 3 (Azure OpenAI) | Image generation |
| **GPT-4o** | **GPT-4o (Azure OpenAI)** | Azure-exclusive model family |
| **GPT-4.1** | **GPT-4.1 (Azure OpenAI)** | Latest generation |
| **o3 / o4-mini** | **o3 / o4-mini (Azure OpenAI)** | Reasoning models |

### API migration

**Bedrock API (Python/boto3):**

```python
import boto3
import json

bedrock = boto3.client('bedrock-runtime', region_name='us-gov-west-1')

response = bedrock.invoke_model(
    modelId='anthropic.claude-3-5-sonnet-20241022-v2:0',
    body=json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 1024,
        "messages": [
            {"role": "user", "content": "Summarize federal procurement regulations"}
        ]
    })
)
result = json.loads(response['body'].read())
answer = result['content'][0]['text']
```

**Azure OpenAI API (Python/openai):**

```python
from openai import AzureOpenAI
from azure.identity import DefaultAzureCredential, get_bearer_token_provider

token_provider = get_bearer_token_provider(
    DefaultAzureCredential(),
    "https://cognitiveservices.azure.com/.default"
)

client = AzureOpenAI(
    azure_endpoint="https://acme-ai.openai.azure.us",
    azure_ad_token_provider=token_provider,
    api_version="2024-12-01-preview"
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[
        {"role": "system", "content": "You are a federal procurement expert."},
        {"role": "user", "content": "Summarize federal procurement regulations"}
    ],
    max_tokens=1024
)
answer = response.choices[0].message.content
```

**Key differences:**
- Bedrock uses boto3 with model-specific request/response formats. Azure OpenAI uses the standard OpenAI SDK with consistent request/response format across all models.
- Bedrock authentication is IAM-based. Azure OpenAI uses Entra ID (managed identity or token provider).
- Azure OpenAI is available in Azure Government regions for federal workloads.

---

## Part 5: Bedrock Agents to Azure AI Agents and Copilot Studio

### Agent architecture comparison

| Bedrock Agents concept | Azure equivalent | Notes |
|---|---|---|
| Agent | Azure AI Agent / Copilot Studio agent | Autonomous task execution |
| Action group | Tool / Function calling | Define callable tools |
| Knowledge base | Azure AI Search (RAG) | Document retrieval |
| Guardrails | Azure AI Content Safety | Input/output filtering |
| Agent executor | Azure AI Agent SDK / Semantic Kernel | Orchestration framework |
| Session management | Thread management (Agent SDK) | Conversation state |

### Code-first agent migration (Bedrock Agent to Azure AI Agent)

**Bedrock Agent invocation:**

```python
bedrock_agent = boto3.client('bedrock-agent-runtime')

response = bedrock_agent.invoke_agent(
    agentId='AGENT123',
    agentAliasId='ALIAS456',
    sessionId='session-789',
    inputText='Find all overdue invoices for Q1 2026'
)
```

**Azure AI Agent (using Azure AI Agent SDK):**

```python
from azure.ai.projects import AIProjectClient
from azure.identity import DefaultAzureCredential

project_client = AIProjectClient.from_connection_string(
    credential=DefaultAzureCredential(),
    conn_str="<project-connection-string>"
)

agent = project_client.agents.create_agent(
    model="gpt-4o",
    name="invoice-analyst",
    instructions="You are a federal financial analyst. Find and analyze invoices.",
    tools=[
        {
            "type": "function",
            "function": {
                "name": "query_invoices",
                "description": "Query the invoice database",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "status": {"type": "string", "enum": ["overdue", "paid", "pending"]},
                        "quarter": {"type": "string"}
                    }
                }
            }
        }
    ]
)

thread = project_client.agents.create_thread()
message = project_client.agents.create_message(
    thread_id=thread.id,
    role="user",
    content="Find all overdue invoices for Q1 2026"
)
run = project_client.agents.create_and_process_run(
    thread_id=thread.id,
    assistant_id=agent.id
)
```

### No-code agent migration (to Copilot Studio)

For agents that do not require custom code, Copilot Studio provides a visual agent builder that integrates with:
- Dataverse (structured data)
- SharePoint (documents)
- Azure AI Search (RAG)
- Power Automate (actions)
- Microsoft 365 (email, calendar, Teams)

---

## Part 6: Bedrock Knowledge Bases to Azure AI Search (RAG)

### RAG architecture comparison

| Bedrock Knowledge Bases | Azure AI Search RAG | Notes |
|---|---|---|
| S3 data source | ADLS Gen2 / Blob Storage | Document source |
| Document chunking | Azure AI Document Intelligence + chunking | Built-in or custom chunking |
| Embedding model (Titan) | text-embedding-3-large (OpenAI) | Higher-quality embeddings |
| Vector store (OpenSearch) | Azure AI Search (vector + hybrid) | Hybrid search (vector + keyword) |
| Retrieval API | AI Search REST API / SDK | More control over retrieval |
| Foundation model | Azure OpenAI (GPT-4o) | Generation step |

### RAG pipeline migration

```python
# Azure AI Search + Azure OpenAI RAG pattern
from azure.search.documents import SearchClient
from azure.identity import DefaultAzureCredential
from openai import AzureOpenAI

# 1. Search for relevant documents
search_client = SearchClient(
    endpoint="https://acme-search.search.windows.us",
    index_name="federal-docs",
    credential=DefaultAzureCredential()
)

results = search_client.search(
    search_text="federal procurement regulations",
    vector_queries=[{
        "kind": "text",
        "text": "federal procurement regulations",
        "fields": "content_vector",
        "k": 5
    }],
    select=["title", "content", "source_url"],
    top=5
)

# 2. Build context from search results
context = "\n\n".join([
    f"Source: {r['title']}\n{r['content']}"
    for r in results
])

# 3. Generate answer with Azure OpenAI
client = AzureOpenAI(
    azure_endpoint="https://acme-ai.openai.azure.us",
    azure_ad_token_provider=token_provider,
    api_version="2024-12-01-preview"
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[
        {"role": "system", "content": f"Answer using only this context:\n{context}"},
        {"role": "user", "content": "Summarize federal procurement regulations"}
    ]
)
```

Cross-reference: `csa_platform/ai_integration/` for AI Foundry and Azure OpenAI integration patterns.

---

## Model registry and lifecycle comparison

| SageMaker Model Registry | Azure ML Model Registry | MLflow (Databricks) |
|---|---|---|
| Model groups | Model names | Registered models |
| Model versions | Model versions | Model versions |
| Approval status (Pending/Approved/Rejected) | Model stages (None/Staging/Production/Archived) | Model stages |
| Model metrics | Model metrics + tags | Logged metrics + tags |
| Lineage (data → model → endpoint) | Lineage (data → experiment → model → endpoint) | MLflow lineage |
| Model cards | Responsible AI dashboard | MLflow model cards |

### Migration approach for model registry

```python
# Export SageMaker model registry
import boto3
sm = boto3.client('sagemaker')

# List all model packages
model_groups = sm.list_model_package_groups()
for group in model_groups['ModelPackageGroupSummaryList']:
    packages = sm.list_model_packages(ModelPackageGroupName=group['ModelPackageGroupName'])
    for pkg in packages['ModelPackageSummaryList']:
        details = sm.describe_model_package(ModelPackageName=pkg['ModelPackageArn'])
        # Export model artifact, metrics, and metadata

# Register in Azure ML
from azure.ai.ml.entities import Model
model = Model(
    name="sales-forecast",
    version="1",
    path="./exported_model/",
    type="custom_model",
    description="Sales forecast model migrated from SageMaker",
    tags={"source": "sagemaker", "original_arn": "arn:aws:sagemaker:..."}
)
ml_client.models.create_or_update(model)
```

---

## Migration sequence

| Phase | Duration | Activities |
|---|---|---|
| 1. Inventory | 1-2 weeks | Catalog all SageMaker models, endpoints, pipelines; list Bedrock usage |
| 2. Environment setup | 2-3 weeks | Create Azure ML workspace, AI Foundry project, Azure OpenAI deployment |
| 3. Training migration | 3-4 weeks | Adapt training scripts; replicate experiments on Azure ML |
| 4. Model deployment | 2-3 weeks | Deploy models to Azure ML managed endpoints; validate inference |
| 5. Pipeline migration | 3-4 weeks | Convert SageMaker Pipelines to Azure ML Pipelines |
| 6. LLM/RAG migration | 2-3 weeks | Switch Bedrock calls to Azure OpenAI; migrate Knowledge Bases to AI Search |
| 7. Agent migration | 2-4 weeks | Rebuild Bedrock Agents as Azure AI Agents or Copilot Studio |
| 8. Validation | 2-3 weeks | Dual-run inference; compare model outputs; validate RAG quality |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Migration Center](index.md) | [Compute Migration](compute-migration.md) | [Security Migration](security-migration.md) | [Migration Playbook](../aws-to-azure.md)
