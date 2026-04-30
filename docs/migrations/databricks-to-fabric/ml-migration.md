# ML Migration — Databricks to Fabric + Azure ML

**Status:** Authored 2026-04-30
**Audience:** Data scientists, ML engineers, and platform teams migrating machine learning workloads from Databricks to Fabric and Azure ML.
**Scope:** MLflow experiments, Model Serving, Feature Store, AutoML, Vector Search, and the recommended hybrid pattern for ML-heavy organizations.

---

## 1. Overview

Machine learning is the area where Databricks has the strongest advantage over Fabric. This guide is honest about that: **for heavy ML/DL training, Databricks is the better platform today.** However, several ML-adjacent workloads (AutoML, feature engineering, experiment tracking for simple models) can be migrated.

### Migration decision matrix

| ML workload | Recommended target | Rationale |
| --- | --- | --- |
| MLflow experiment tracking | Fabric ML experiments | MLflow API compatible; works for most use cases |
| Simple model training (sklearn, XGBoost) | Fabric notebooks | PySpark + Python libraries; no GPU needed |
| Deep learning training (PyTorch, TensorFlow) | **Stay on Databricks** or Azure ML | GPU clusters not available in Fabric Spark |
| Model Serving (real-time inference) | Azure ML managed endpoints | No native Fabric model serving |
| Feature Store | Fabric feature engineering (preview) | Evolving; evaluate maturity |
| AutoML | Fabric AutoML | Good parity for tabular data |
| Vector Search (RAG/embeddings) | Azure AI Search | No native Fabric vector search |
| MLflow Model Registry | Fabric ML model registry | Basic registry; less mature than UC-integrated |
| Databricks Apps (hosted ML apps) | Azure Container Apps | No Fabric equivalent; deploy separately |

---

## 2. MLflow experiment tracking

### 2.1 Databricks MLflow

Databricks provides a fully managed MLflow implementation:

```python
# Databricks notebook
import mlflow
import mlflow.sklearn
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score

mlflow.set_experiment("/Users/user@company.com/customer-churn")

with mlflow.start_run(run_name="rf-baseline"):
    # Train model
    model = RandomForestClassifier(n_estimators=100, max_depth=10)
    model.fit(X_train, y_train)
    predictions = model.predict(X_test)

    # Log parameters, metrics, model
    mlflow.log_param("n_estimators", 100)
    mlflow.log_param("max_depth", 10)
    mlflow.log_metric("accuracy", accuracy_score(y_test, predictions))
    mlflow.log_metric("f1_score", f1_score(y_test, predictions))
    mlflow.sklearn.log_model(model, "model")

    # Register model in Unity Catalog
    mlflow.register_model("runs:/{run_id}/model", "catalog.schema.churn_model")
```

### 2.2 Fabric ML experiments

Fabric supports MLflow API for experiment tracking:

```python
# Fabric notebook
import mlflow
import mlflow.sklearn
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score

# Fabric automatically configures the MLflow tracking URI
# No need to set_tracking_uri or set_experiment manually

mlflow.set_experiment("customer-churn")

with mlflow.start_run(run_name="rf-baseline"):
    # Train model -- same code as Databricks
    model = RandomForestClassifier(n_estimators=100, max_depth=10)
    model.fit(X_train, y_train)
    predictions = model.predict(X_test)

    # Log parameters, metrics, model -- same API
    mlflow.log_param("n_estimators", 100)
    mlflow.log_param("max_depth", 10)
    mlflow.log_metric("accuracy", accuracy_score(y_test, predictions))
    mlflow.log_metric("f1_score", f1_score(y_test, predictions))
    mlflow.sklearn.log_model(model, "model")

    # Save model to Fabric ML model registry
    mlflow.register_model("runs:/{run_id}/model", "churn_model")
```

### 2.3 Key differences

| Feature | Databricks MLflow | Fabric ML experiments |
| --- | --- | --- |
| MLflow API compatibility | Full (native) | Full (MLflow API) |
| Experiment UI | Databricks experiment viewer | Fabric ML experiment viewer |
| Artifact storage | DBFS / Unity Catalog volumes | OneLake |
| Model registry | Unity Catalog model registry | Fabric ML model registry |
| Model lineage | UC lineage (table -> model -> serving) | Basic (experiment -> model) |
| Auto-logging | `mlflow.autolog()` for all frameworks | `mlflow.autolog()` supported |
| Spark MLlib integration | Deep (Databricks Runtime) | Standard (Fabric Spark) |
| GPU training | Yes (GPU clusters) | No (CPU only in Fabric Spark) |

### 2.4 Migration steps for experiments

1. **Export experiment runs** from Databricks using MLflow API:
   ```python
   # On Databricks: export runs
   import mlflow
   runs = mlflow.search_runs(experiment_ids=["123"])
   runs.to_csv("/dbfs/tmp/experiment_export.csv")
   ```

2. **Recreate experiment** in Fabric:
   ```python
   # On Fabric: create experiment and replay key runs
   mlflow.set_experiment("customer-churn")
   # Note: Full run migration (with artifacts) requires manual artifact copy
   ```

3. **Copy model artifacts** from DBFS/UC to OneLake:
   ```python
   # Copy model files to OneLake for Fabric ML model registry
   mssparkutils.fs.cp(
       "abfss://container@account.dfs.core.windows.net/models/churn/",
       "Files/models/churn/",
       recurse=True
   )
   ```

> **Practical note:** Most teams do not migrate historical experiment runs. Instead, they start fresh on Fabric and keep historical runs accessible in Databricks (read-only) during transition.

---

## 3. Model Serving

### 3.1 Databricks Model Serving

Databricks provides managed model serving with:
- Automatic scaling (including scale-to-zero for serverless)
- GPU-backed endpoints for large models
- A/B testing and traffic splitting
- Foundation model APIs (Databricks-hosted LLMs)
- Feature serving (serve features alongside predictions)

```python
# Databricks: Deploy model to serving endpoint
from databricks.sdk import WorkspaceClient

w = WorkspaceClient()
w.serving_endpoints.create(
    name="churn-predictor",
    config={
        "served_models": [{
            "model_name": "churn_model",
            "model_version": "3",
            "workload_size": "Small",
            "scale_to_zero_enabled": True,
        }]
    }
)
```

### 3.2 Fabric alternative: Azure ML managed endpoints

Fabric does not have native model serving. Use Azure ML managed online endpoints:

```python
# Azure ML: Deploy model from Fabric ML registry
from azure.ai.ml import MLClient
from azure.ai.ml.entities import (
    ManagedOnlineEndpoint,
    ManagedOnlineDeployment,
    Model,
    Environment,
)
from azure.identity import DefaultAzureCredential

ml_client = MLClient(
    DefaultAzureCredential(),
    subscription_id="<sub-id>",
    resource_group_name="<rg>",
    workspace_name="<aml-workspace>"
)

# Register model (or reference from Fabric OneLake)
model = Model(
    path="azureml://datastores/onelake/paths/models/churn/model.pkl",
    name="churn-model",
    type="custom_model"
)
ml_client.models.create_or_update(model)

# Create endpoint
endpoint = ManagedOnlineEndpoint(name="churn-predictor", auth_mode="key")
ml_client.online_endpoints.begin_create_or_update(endpoint).result()

# Create deployment
deployment = ManagedOnlineDeployment(
    name="v1",
    endpoint_name="churn-predictor",
    model="churn-model:1",
    instance_type="Standard_DS3_v2",
    instance_count=1,
)
ml_client.online_deployments.begin_create_or_update(deployment).result()
```

### 3.3 Serving comparison

| Feature | Databricks Model Serving | Azure ML Managed Endpoints |
| --- | --- | --- |
| Deployment model | Databricks-managed | Azure ML-managed |
| Scale to zero | Yes (serverless) | Yes (with autoscale rules) |
| GPU inference | Yes | Yes (GPU VM SKUs) |
| A/B testing | Yes (traffic splitting) | Yes (traffic mirroring) |
| Foundation model hosting | Yes (DBRX, Llama, etc.) | Yes (via Azure OpenAI or custom) |
| Monitoring | MLflow + Databricks UI | Azure Monitor + Application Insights |
| Authentication | Databricks token | Azure AD / API key |
| Pricing | DBU-based | VM-based (pay per endpoint) |

---

## 4. Feature Store

### 4.1 Databricks Feature Store

```python
# Databricks: Create and publish features
from databricks.feature_engineering import FeatureEngineeringClient

fe = FeatureEngineeringClient()

# Create feature table
fe.create_table(
    name="production.features.customer_features",
    primary_keys=["customer_id"],
    timestamp_keys=["feature_timestamp"],
    df=customer_features_df,
    description="Customer behavioral features for churn prediction"
)

# Use features for training
training_set = fe.create_training_set(
    df=labels_df,
    feature_lookups=[
        FeatureLookup(
            table_name="production.features.customer_features",
            lookup_key="customer_id"
        )
    ],
    label="churned"
)
training_df = training_set.load_df()
```

### 4.2 Fabric feature engineering

Fabric feature engineering (preview as of April 2026) provides:

```python
# Fabric: Feature engineering
from microsoft.fabric.ml.feature_store import (
    FeatureStoreClient,
    FeatureSet,
)

fs_client = FeatureStoreClient()

# Define feature set
feature_set = FeatureSet(
    name="customer_features",
    entities=[{"name": "customer_id", "key": True}],
    features=customer_features_df,
    description="Customer behavioral features"
)
fs_client.register_feature_set(feature_set)

# Retrieve features for training
training_df = fs_client.get_features(
    feature_set_name="customer_features",
    entity_df=labels_df
)
```

### 4.3 Feature Store comparison

| Feature | Databricks Feature Store | Fabric Feature Engineering |
| --- | --- | --- |
| GA status | GA | Preview |
| Unity Catalog integration | Yes (feature tables are UC tables) | OneLake-based |
| Online serving | Yes (publish to online store) | Not available |
| Point-in-time lookups | Yes | Limited |
| Feature freshness tracking | Yes | Basic |
| Lineage (feature -> model) | Yes (UC lineage) | Basic |

### 4.4 Migration recommendation

For teams with deep Feature Store adoption, consider:

1. **Keep Databricks Feature Store** for model training (hybrid pattern)
2. **Replicate features to OneLake** for Fabric-based analytics
3. **Evaluate Fabric feature engineering** as it matures toward GA

---

## 5. AutoML

### 5.1 Databricks AutoML

```python
# Databricks AutoML
from databricks import automl

summary = automl.classify(
    dataset=training_df,
    target_col="churned",
    primary_metric="f1",
    timeout_minutes=30,
    max_trials=50
)

# Best model is logged to MLflow
best_run = summary.best_trial
print(f"Best F1: {best_run.metrics['f1_score']}")
```

### 5.2 Fabric AutoML

```python
# Fabric AutoML
import flaml

automl_settings = {
    "task": "classification",
    "metric": "f1",
    "time_budget": 1800,  # 30 minutes
    "log_file_name": "automl.log",
}

automl_model = flaml.AutoML()
automl_model.fit(X_train, y_train, **automl_settings)

# Log to Fabric ML experiments
import mlflow
with mlflow.start_run():
    mlflow.log_params(automl_model.best_config)
    mlflow.log_metric("f1", automl_model.best_loss)
    mlflow.sklearn.log_model(automl_model.model, "model")
```

Fabric AutoML uses FLAML (Fast Lightweight AutoML) under the hood. For tabular classification and regression, parity is good.

### 5.3 AutoML comparison

| Feature | Databricks AutoML | Fabric AutoML (FLAML) |
| --- | --- | --- |
| Tabular classification | Yes | Yes |
| Tabular regression | Yes | Yes |
| Time series forecasting | Yes | Yes (FLAML supports) |
| Notebook generation | Yes (generates editable notebook) | Manual (use FLAML API) |
| MLflow integration | Automatic | Manual (log with MLflow API) |
| Data exploration | Auto-generated EDA notebook | Manual |
| Glass-box models | Yes (interpretable) | Via FLAML config |

---

## 6. Vector Search

### 6.1 Databricks Vector Search

```python
# Databricks: Create vector search index
from databricks.vector_search.client import VectorSearchClient

vsc = VectorSearchClient()

# Create endpoint
vsc.create_endpoint(name="vs-endpoint", endpoint_type="STANDARD")

# Create index on Delta table with embeddings
vsc.create_delta_sync_index(
    endpoint_name="vs-endpoint",
    index_name="catalog.schema.doc_embeddings_index",
    source_table_name="catalog.schema.documents",
    pipeline_type="TRIGGERED",
    primary_key="doc_id",
    embedding_source_column="content",
    embedding_model_endpoint_name="databricks-bge-large-en"
)

# Search
results = vsc.get_index("catalog.schema.doc_embeddings_index").similarity_search(
    query_text="How to reset password",
    columns=["doc_id", "title", "content"],
    num_results=5
)
```

### 6.2 Azure AI Search (Fabric alternative)

```python
# Azure AI Search: Vector search
from azure.search.documents import SearchClient
from azure.search.documents.indexes import SearchIndexClient
from azure.search.documents.indexes.models import (
    SearchIndex,
    SearchField,
    VectorSearch,
    HnswAlgorithmConfiguration,
    VectorSearchProfile,
    SearchFieldDataType,
)
from azure.identity import DefaultAzureCredential

# Create index with vector field
index = SearchIndex(
    name="documents",
    fields=[
        SearchField(name="doc_id", type=SearchFieldDataType.String, key=True),
        SearchField(name="title", type=SearchFieldDataType.String, searchable=True),
        SearchField(name="content", type=SearchFieldDataType.String, searchable=True),
        SearchField(
            name="content_vector",
            type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
            vector_search_dimensions=1536,
            vector_search_profile_name="my-profile"
        ),
    ],
    vector_search=VectorSearch(
        algorithms=[HnswAlgorithmConfiguration(name="hnsw")],
        profiles=[VectorSearchProfile(name="my-profile", algorithm_configuration_name="hnsw")]
    )
)

# Search
from azure.search.documents.models import VectorizedQuery

search_client = SearchClient(endpoint, "documents", credential)
results = search_client.search(
    search_text="How to reset password",
    vector_queries=[VectorizedQuery(
        vector=embedding_vector,
        k_nearest_neighbors=5,
        fields="content_vector"
    )]
)
```

### 6.3 Vector Search comparison

| Feature | Databricks Vector Search | Azure AI Search |
| --- | --- | --- |
| Delta table sync | Yes (auto-sync from Delta) | Manual (push documents) |
| Embedding generation | Built-in (model endpoints) | Azure OpenAI or custom |
| Hybrid search (vector + keyword) | Yes | Yes |
| Filtering | Yes (UC permissions) | Yes (OData filters) |
| Scale | Databricks-managed | Azure-managed (multiple tiers) |
| Pricing | Included in DBU (endpoint cost) | Per-unit pricing |

---

## 7. Recommended hybrid pattern for ML-heavy teams

For organizations with significant ML workloads, the recommended pattern is:

```
┌─────────────────────────┐    ┌─────────────────────────┐
│     Databricks          │    │     Fabric              │
│                         │    │                         │
│  - ML training (GPU)    │    │  - Feature exploration  │
│  - MLflow experiments   │    │  - AutoML (simple)      │
│  - Model Serving        │    │  - Power BI Direct Lake │
│  - Feature Store        │    │  - Data Pipelines       │
│  - Vector Search        │    │  - Real-Time Analytics  │
│                         │    │                         │
└──────────┬──────────────┘    └──────────┬──────────────┘
           │                              │
           └──────────┬───────────────────┘
                      │
              ┌───────┴───────┐
              │  ADLS Gen2    │
              │  (shared)     │
              │  Delta tables │
              │  + OneLake    │
              │  shortcuts    │
              └───────────────┘
```

Both platforms read/write the same Delta tables. ML training stays on Databricks; BI and real-time move to Fabric. Feature tables and model artifacts are accessible to both via shared ADLS storage.

---

## 8. Migration checklist

- [ ] **Inventory ML workloads** -- experiments, models, serving endpoints, feature tables
- [ ] **Classify each workload** using the decision matrix (section 1)
- [ ] **Migrate simple experiments** to Fabric ML experiments (section 2)
- [ ] **Set up Azure ML** for model serving if moving from Databricks Model Serving (section 3)
- [ ] **Evaluate Feature Store migration** -- keep on Databricks or try Fabric preview (section 4)
- [ ] **Migrate AutoML workflows** to Fabric FLAML (section 5)
- [ ] **Set up Azure AI Search** if replacing Vector Search (section 6)
- [ ] **Configure hybrid pattern** -- shared ADLS, OneLake shortcuts (section 7)
- [ ] **Update CI/CD pipelines** -- model training triggers, deployment automation
- [ ] **Retrain models on Fabric** if migrating training; validate model performance

---

## Related

- [Feature Mapping](feature-mapping-complete.md) -- ML/AI section
- [Notebook Migration](notebook-migration.md) -- converting ML notebooks
- [Benchmarks](benchmarks.md) -- training performance comparisons
- [Best Practices](best-practices.md) -- hybrid ML strategy
- [Parent guide: 5-phase migration](../databricks-to-fabric.md)
- Azure ML documentation: <https://learn.microsoft.com/azure/machine-learning/>
- Fabric ML experiments: <https://learn.microsoft.com/fabric/data-science/machine-learning-experiment>

---

**Maintainers:** csa-inabox core team
**Source finding:** CSA-0083 (HIGH, XL) -- approved via AQ-0010 ballot B6
**Last updated:** 2026-04-30
