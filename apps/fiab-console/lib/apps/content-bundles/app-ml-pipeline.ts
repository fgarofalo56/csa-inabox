/**
 * ML Pipeline (MLOps) — app-install content bundle.
 *
 * Source: docs/learn/08-solutions/ml-pipeline/README.md — "ML Pipeline
 * Solution: End-to-end MLOps pipeline with Databricks and Azure ML".
 *
 * Reproduces the documented customer-churn MLOps loop 1:1:
 *   Data Lake / Feature Store
 *     -> bronze.transactions / bronze.customers (raw)
 *     -> ml.features.customer_churn_features (Feature Engineering, Step 1)
 *     -> ml.labels.churn_labels + ml.validation.holdout_churn
 *   Development / Training
 *     -> MLflow experiment /Experiments/customer-churn
 *     -> XGBoost training with feature-store create_training_set (Step 2)
 *   Validation
 *     -> accuracy>0.80 / f1>0.75 / auc_roc>0.85 gate -> Staging (Step 3)
 *   Deployment
 *     -> serving endpoint customer-churn-model-endpoint + Production (Step 4)
 *   Operations
 *     -> Lakehouse-Monitoring quality monitor on inference table,
 *        drift Databricks-SQL alert + Activator rule (Step 5)
 *
 * Every item maps to a real Phase-2 provisioner:
 *   lakehouse        -> lakehouseProvisioner      (delta tables + seeded rows)
 *   notebook (x5)    -> notebookProvisioner       (real Fabric .ipynb items)
 *   warehouse        -> warehouseProvisioner       (inference-log + drift DDL + rows)
 *   data-pipeline    -> dataPipelineProvisioner    (Test->Train->Validate->Deploy)
 *   activator        -> activatorProvisioner       (drift alert rule)
 *   ml-model         -> mlModelProvisioner         (imports trainingCode as a
 *                        Databricks notebook and submits a real runs/submit
 *                        that trains + registers customer_churn_model in the
 *                        MLflow / Unity Catalog registry)
 *
 * Provisioning is async-safe: long-running operations (Lakehouse Load Table,
 * the pipeline run, and the Databricks training run) are SUBMITTED via real
 * REST and handed off with their live operation / run id — install does not
 * block to terminal, so the full 10-item install finishes inside Azure Front
 * Door's ~30s origin-response window (the prior synchronous poll-to-terminal
 * blew that ceiling and 504'd). Each editor + /api/databricks/jobs observe the
 * work completing server-side; re-running install reconciles anything still in
 * flight. Backends that aren't wired surface honest remediation gates.
 *
 * Every Databricks/MLflow detail is grounded in the doc + Microsoft Learn:
 *   - FeatureEngineeringClient.create_table / create_training_set / log_model
 *     and FeatureLookup  (learn.microsoft.com/azure/databricks/machine-learning/
 *       feature-store/train-with-declarative-features + /concepts).
 *   - mlflow.set_registry_uri("databricks-uc") for Unity-Catalog model
 *     registration (learn.microsoft.com/azure/databricks/machine-learning/
 *       feature-store/on-demand-features#log-the-model).
 *   - WorkspaceClient.serving_endpoints + quality_monitors inference-log
 *     monitoring (learn.microsoft.com/azure/databricks/machine-learning/
 *       model-serving/monitor-diagnose-endpoints).
 */

import type { AppBundle } from './types';

// ════════════════════════════════════════════════════════════════════════
//  NOTEBOOK CELLS — Step 1: Feature Engineering Pipeline
// ════════════════════════════════════════════════════════════════════════

const NB_FEATURES_CELLS = [
  {
    id: 'feat-md-intro',
    type: 'markdown' as const,
    source:
      '# Step 1 — Feature Engineering Pipeline\n\n' +
      'Builds the **`ml.features.customer_churn_features`** feature table from the ' +
      'bronze customer + transaction tables, using the Databricks **Feature ' +
      'Engineering in Unity Catalog** client.\n\n' +
      '| Output | Description |\n' +
      '| --- | --- |\n' +
      '| `ml.features.customer_churn_features` | One row per `customer_id` with spend / recency / volatility features |\n\n' +
      'Scheduled daily at 06:00 UTC via `dbutils.jobs.submit_run`. Mirrors ' +
      '`docs/learn/08-solutions/ml-pipeline` Step 1.',
  },
  {
    id: 'feat-code-imports',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'from databricks.feature_engineering import FeatureEngineeringClient\n' +
      'from pyspark.sql.functions import (\n' +
      '    count, sum as _sum, avg, max as _max, countDistinct, stddev,\n' +
      '    col, current_date, datediff,\n' +
      ')\n\n' +
      'fe = FeatureEngineeringClient()',
  },
  {
    id: 'feat-code-build',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'def create_customer_features():\n' +
      '    """Create customer features for churn prediction."""\n\n' +
      '    # Load raw data from the bronze lakehouse tables\n' +
      '    transactions = spark.table("bronze.transactions")\n' +
      '    customers = spark.table("bronze.customers")\n\n' +
      '    # Compute behavioural + recency features per customer\n' +
      '    customer_features = (\n' +
      '        transactions.groupBy("customer_id").agg(\n' +
      '            count("*").alias("total_transactions"),\n' +
      '            _sum("amount").alias("total_spend"),\n' +
      '            avg("amount").alias("avg_transaction_amount"),\n' +
      '            _max("transaction_date").alias("last_transaction_date"),\n' +
      '            countDistinct("product_category").alias("unique_categories"),\n' +
      '            stddev("amount").alias("spend_volatility"),\n' +
      '        )\n' +
      '        .join(\n' +
      '            customers.select("customer_id", "signup_date", "region"),\n' +
      '            "customer_id",\n' +
      '        )\n' +
      '        .withColumn(\n' +
      '            "days_since_signup",\n' +
      '            datediff(current_date(), col("signup_date")),\n' +
      '        )\n' +
      '        .withColumn(\n' +
      '            "days_since_last_transaction",\n' +
      '            datediff(current_date(), col("last_transaction_date")),\n' +
      '        )\n' +
      '    )\n\n' +
      '    # Create / overwrite the Unity-Catalog feature table\n' +
      '    fe.create_table(\n' +
      '        name="ml.features.customer_churn_features",\n' +
      '        primary_keys=["customer_id"],\n' +
      '        df=customer_features,\n' +
      '        description="Customer features for churn prediction model",\n' +
      '        tags={"team": "data-science", "domain": "customer"},\n' +
      '    )\n\n' +
      '    return customer_features\n\n\n' +
      'features_df = create_customer_features()\n' +
      'display(features_df)',
  },
  {
    id: 'feat-code-schedule',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      '# Schedule a daily 06:00 UTC feature refresh.\n' +
      'dbutils.jobs.submit_run(\n' +
      '    run_name="refresh_customer_features",\n' +
      '    notebook_task={\n' +
      '        "notebook_path": "/Repos/ml/features/customer_features",\n' +
      '    },\n' +
      '    schedule={\n' +
      '        "quartz_cron_expression": "0 0 6 * * ?",\n' +
      '        "timezone_id": "UTC",\n' +
      '    },\n' +
      ')',
  },
];

// ════════════════════════════════════════════════════════════════════════
//  NOTEBOOK CELLS — Step 2: Model Training Pipeline
// ════════════════════════════════════════════════════════════════════════

const NB_TRAIN_CELLS = [
  {
    id: 'train-md-intro',
    type: 'markdown' as const,
    source:
      '# Step 2 — Model Training Pipeline\n\n' +
      'Trains an **XGBoost** churn classifier inside an MLflow run, pulling ' +
      'features point-in-time-correctly from the feature store via ' +
      '`FeatureLookup` + `create_training_set`, then registers the model to ' +
      'Unity Catalog as **`customer_churn_model`**.\n\n' +
      'Logged metrics: `accuracy`, `f1`, `auc_roc`. Experiment: ' +
      '`/Experiments/customer-churn`.',
  },
  {
    id: 'train-code-imports',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'import mlflow\n' +
      'from mlflow.tracking import MlflowClient\n' +
      'from databricks.feature_engineering import FeatureEngineeringClient, FeatureLookup\n' +
      'from sklearn.model_selection import train_test_split\n' +
      'from sklearn.metrics import accuracy_score, f1_score, roc_auc_score\n' +
      'import xgboost as xgb\n\n' +
      '# Register models to Unity Catalog (3-level names).\n' +
      'mlflow.set_registry_uri("databricks-uc")\n' +
      'mlflow.set_experiment("/Experiments/customer-churn")\n\n' +
      'fe = FeatureEngineeringClient()',
  },
  {
    id: 'train-code-train',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'def train_churn_model(data_version: str = "latest"):\n' +
      '    """Train customer churn prediction model."""\n\n' +
      '    with mlflow.start_run(run_name=f"training-{data_version}") as run:\n' +
      '        # Labels live in ml.labels.churn_labels (customer_id, churned)\n' +
      '        labels = spark.table("ml.labels.churn_labels")\n\n' +
      '        # Point-in-time-correct join against the feature table\n' +
      '        training_set = fe.create_training_set(\n' +
      '            df=labels,\n' +
      '            feature_lookups=[\n' +
      '                FeatureLookup(\n' +
      '                    table_name="ml.features.customer_churn_features",\n' +
      '                    lookup_key="customer_id",\n' +
      '                )\n' +
      '            ],\n' +
      '            label="churned",\n' +
      '        )\n\n' +
      '        df = training_set.load_df().toPandas()\n' +
      '        X = df.drop(["customer_id", "churned"], axis=1)\n' +
      '        y = df["churned"]\n\n' +
      '        X_train, X_test, y_train, y_test = train_test_split(\n' +
      '            X, y, test_size=0.2, random_state=42\n' +
      '        )\n\n' +
      '        # Train\n' +
      '        params = {\n' +
      '            "n_estimators": 100,\n' +
      '            "max_depth": 6,\n' +
      '            "learning_rate": 0.1,\n' +
      '            "objective": "binary:logistic",\n' +
      '        }\n' +
      '        model = xgb.XGBClassifier(**params)\n' +
      '        model.fit(X_train, y_train)\n\n' +
      '        # Evaluate\n' +
      '        y_pred = model.predict(X_test)\n' +
      '        y_prob = model.predict_proba(X_test)[:, 1]\n' +
      '        metrics = {\n' +
      '            "accuracy": accuracy_score(y_test, y_pred),\n' +
      '            "f1": f1_score(y_test, y_pred),\n' +
      '            "auc_roc": roc_auc_score(y_test, y_prob),\n' +
      '        }\n\n' +
      '        # Log to MLflow\n' +
      '        mlflow.log_params(params)\n' +
      '        mlflow.log_metrics(metrics)\n\n' +
      '        # Log + register with feature-store lineage\n' +
      '        fe.log_model(\n' +
      '            model=model,\n' +
      '            artifact_path="model",\n' +
      '            flavor=mlflow.sklearn,\n' +
      '            training_set=training_set,\n' +
      '            registered_model_name="customer_churn_model",\n' +
      '        )\n\n' +
      '        return run.info.run_id, metrics\n\n\n' +
      'run_id, metrics = train_churn_model()\n' +
      'print(run_id, metrics)',
  },
];

// ════════════════════════════════════════════════════════════════════════
//  NOTEBOOK CELLS — Step 3: Model Validation Pipeline
// ════════════════════════════════════════════════════════════════════════

const NB_VALIDATE_CELLS = [
  {
    id: 'val-md-intro',
    type: 'markdown' as const,
    source:
      '# Step 3 — Model Validation Pipeline\n\n' +
      'Re-scores a candidate model version against the held-out validation set ' +
      '`ml.validation.holdout_churn` and promotes it to **Staging** only when ' +
      'all three gates pass.\n\n' +
      '| Gate | Threshold |\n' +
      '| --- | --- |\n' +
      '| `val_accuracy` | `> 0.80` |\n' +
      '| `val_f1` | `> 0.75` |\n' +
      '| `val_auc_roc` | `> 0.85` |',
  },
  {
    id: 'val-code',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'import mlflow\n' +
      'from mlflow.tracking import MlflowClient\n' +
      'from sklearn.metrics import accuracy_score, f1_score, roc_auc_score\n\n' +
      'mlflow.set_registry_uri("databricks-uc")\n\n\n' +
      'def validate_model(model_name: str, version: int):\n' +
      '    """Validate model before promotion."""\n\n' +
      '    client = MlflowClient()\n' +
      '    model_uri = f"models:/{model_name}/{version}"\n' +
      '    model = mlflow.sklearn.load_model(model_uri)\n\n' +
      '    validation_df = spark.table("ml.validation.holdout_churn").toPandas()\n' +
      '    X_val = validation_df.drop(["customer_id", "churned"], axis=1)\n' +
      '    y_val = validation_df["churned"]\n\n' +
      '    y_pred = model.predict(X_val)\n' +
      '    y_prob = model.predict_proba(X_val)[:, 1]\n\n' +
      '    validation_metrics = {\n' +
      '        "val_accuracy": accuracy_score(y_val, y_pred),\n' +
      '        "val_f1": f1_score(y_val, y_pred),\n' +
      '        "val_auc_roc": roc_auc_score(y_val, y_prob),\n' +
      '    }\n\n' +
      '    passed = all([\n' +
      '        validation_metrics["val_accuracy"] > 0.80,\n' +
      '        validation_metrics["val_f1"] > 0.75,\n' +
      '        validation_metrics["val_auc_roc"] > 0.85,\n' +
      '    ])\n\n' +
      '    if passed:\n' +
      '        client.transition_model_version_stage(\n' +
      '            name=model_name, version=version, stage="Staging"\n' +
      '        )\n' +
      '        return {"status": "promoted", "metrics": validation_metrics}\n' +
      '    return {"status": "failed", "metrics": validation_metrics}\n\n\n' +
      'result = validate_model("customer_churn_model", version=1)\n' +
      'print(result)',
  },
];

// ════════════════════════════════════════════════════════════════════════
//  NOTEBOOK CELLS — Step 4: Model Deployment
// ════════════════════════════════════════════════════════════════════════

const NB_DEPLOY_CELLS = [
  {
    id: 'deploy-md-intro',
    type: 'markdown' as const,
    source:
      '# Step 4 — Model Deployment\n\n' +
      'Promotes the current **Staging** version to a Model Serving endpoint ' +
      '`customer-churn-model-endpoint`, enables inference auto-capture into ' +
      '`ml.inference_logs.*`, and transitions the registry stage to ' +
      '**Production** (archiving prior Production versions).',
  },
  {
    id: 'deploy-code',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'from databricks.sdk import WorkspaceClient\n' +
      'from mlflow.tracking import MlflowClient\n\n\n' +
      'def deploy_to_production(model_name: str):\n' +
      '    """Deploy model to production serving endpoint."""\n\n' +
      '    w = WorkspaceClient()\n' +
      '    client = MlflowClient()\n\n' +
      '    staging_versions = client.get_latest_versions(\n' +
      '        model_name, stages=["Staging"]\n' +
      '    )\n' +
      '    if not staging_versions:\n' +
      '        raise ValueError("No staging model found")\n' +
      '    version = staging_versions[0].version\n\n' +
      '    endpoint_name = f"{model_name.replace(\'_\', \'-\')}-endpoint"\n\n' +
      '    config = {\n' +
      '        "served_entities": [{\n' +
      '            "entity_name": model_name,\n' +
      '            "entity_version": str(version),\n' +
      '            "workload_size": "Small",\n' +
      '            "scale_to_zero_enabled": False,\n' +
      '        }],\n' +
      '        "auto_capture_config": {\n' +
      '            "catalog_name": "ml",\n' +
      '            "schema_name": "inference_logs",\n' +
      '            "table_name_prefix": model_name,\n' +
      '        },\n' +
      '    }\n\n' +
      '    try:\n' +
      '        w.serving_endpoints.update_config_and_wait(\n' +
      '            name=endpoint_name,\n' +
      '            served_entities=config["served_entities"],\n' +
      '        )\n' +
      '    except Exception:\n' +
      '        w.serving_endpoints.create_and_wait(\n' +
      '            name=endpoint_name, config=config\n' +
      '        )\n\n' +
      '    client.transition_model_version_stage(\n' +
      '        name=model_name,\n' +
      '        version=version,\n' +
      '        stage="Production",\n' +
      '        archive_existing_versions=True,\n' +
      '    )\n\n' +
      '    return {"endpoint": endpoint_name, "version": version}\n\n\n' +
      'print(deploy_to_production("customer_churn_model"))',
  },
];

// ════════════════════════════════════════════════════════════════════════
//  NOTEBOOK CELLS — Step 5: Model Monitoring + Drift Alert
// ════════════════════════════════════════════════════════════════════════

const NB_MONITOR_CELLS = [
  {
    id: 'mon-md-intro',
    type: 'markdown' as const,
    source:
      '# Step 5 — Model Monitoring\n\n' +
      'Creates a **Lakehouse Monitoring** inference-log quality monitor over ' +
      'the prediction table and a Databricks-SQL **drift alert**. The same ' +
      'drift condition is mirrored as an Activator rule in this workspace so ' +
      'the team gets a Teams/email page when `drift_score` crosses the ' +
      'threshold.',
  },
  {
    id: 'mon-code-monitor',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'from databricks.sdk import WorkspaceClient\n' +
      'from databricks.sdk.service.catalog import MonitorCronSchedule\n\n\n' +
      'def setup_model_monitoring(model_name: str):\n' +
      '    """Set up monitoring for deployed model."""\n\n' +
      '    w = WorkspaceClient()\n' +
      '    monitor = w.quality_monitors.create(\n' +
      '        table_name=f"ml.inference_logs.{model_name}_predictions",\n' +
      '        assets_dir=f"/ml/monitoring/{model_name}",\n' +
      '        output_schema_name="ml.monitoring",\n' +
      '        schedule=MonitorCronSchedule(\n' +
      '            quartz_cron_expression="0 0 * * * ?",\n' +
      '            timezone_id="UTC",\n' +
      '        ),\n' +
      '        inference_log={\n' +
      '            "granularities": ["1 day"],\n' +
      '            "model_id_col": "model_version",\n' +
      '            "prediction_col": "prediction",\n' +
      '            "timestamp_col": "timestamp",\n' +
      '            "problem_type": "PROBLEM_TYPE_CLASSIFICATION",\n' +
      '            "label_col": "actual_label",\n' +
      '        },\n' +
      '    )\n' +
      '    return monitor\n\n\n' +
      'setup_model_monitoring("customer_churn_model")',
  },
  {
    id: 'mon-code-alert',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'from databricks.sdk import WorkspaceClient\n\n' +
      'w = WorkspaceClient()\n\n\n' +
      'def create_drift_alert(model_name: str, threshold: float = 0.1):\n' +
      '    """Create a Databricks SQL alert for model drift."""\n\n' +
      '    alert_query = f"""\n' +
      '    SELECT\n' +
      '        date,\n' +
      '        drift_score,\n' +
      '        CASE WHEN drift_score > {threshold} THEN \'DRIFT_DETECTED\'\n' +
      '             ELSE \'NORMAL\' END AS status\n' +
      '    FROM ml.monitoring.{model_name}_drift_metrics\n' +
      '    WHERE date = current_date()\n' +
      '    """\n\n' +
      '    w.alerts.create(\n' +
      '        name=f"{model_name}_drift_alert",\n' +
      '        query_id="drift_query_id",\n' +
      '        options={\n' +
      '            "column": "status",\n' +
      '            "op": "==",\n' +
      '            "value": "DRIFT_DETECTED",\n' +
      '            "custom_body": f"Model drift detected for {model_name}",\n' +
      '        },\n' +
      '    )\n\n\n' +
      'create_drift_alert("customer_churn_model", threshold=0.1)',
  },
];

// ════════════════════════════════════════════════════════════════════════
//  WAREHOUSE DDL — inference-log + drift-metric tables (seeded)
// ════════════════════════════════════════════════════════════════════════

// NOTE: target is a Fabric/Synapse Warehouse (T-SQL), which does NOT support
// `CREATE TABLE IF NOT EXISTS` — it raises "Incorrect syntax near IF". The
// Microsoft-documented idempotent idiom is a pre-existence OBJECT_ID guard
// (https://learn.microsoft.com/azure/synapse-analytics/sql-data-warehouse/
//  sql-data-warehouse-tables-overview#commands-for-creating-tables). The
// warehouse provisioner's splitBatches() splits on ";\n", so each guarded
// CREATE stays one batch.
const WAREHOUSE_DDL = [
  '-- Inference log: one row per scored prediction served from the endpoint.',
  "IF OBJECT_ID(N'customer_churn_model_predictions', N'U') IS NULL",
  'CREATE TABLE customer_churn_model_predictions (',
  '    request_id        VARCHAR(64)   NOT NULL,',
  '    model_version     VARCHAR(16)   NOT NULL,',
  '    customer_id       VARCHAR(32)   NOT NULL,',
  '    prediction        SMALLINT      NOT NULL,',
  '    prediction_proba  FLOAT         NOT NULL,',
  '    actual_label      SMALLINT      NULL,',
  '    [timestamp]       DATETIME2(3)  NOT NULL',
  ');',
  '',
  '-- Daily drift metrics produced by Lakehouse Monitoring.',
  "IF OBJECT_ID(N'customer_churn_model_drift_metrics', N'U') IS NULL",
  'CREATE TABLE customer_churn_model_drift_metrics (',
  '    [date]            DATE          NOT NULL,',
  '    model_version     VARCHAR(16)   NOT NULL,',
  '    drift_score       FLOAT         NOT NULL,',
  '    feature_count     INT           NOT NULL,',
  '    drifted_features  INT           NOT NULL,',
  '    status            VARCHAR(16)   NOT NULL',
  ');',
].join('\n');

// ════════════════════════════════════════════════════════════════════════
//  BUNDLE
// ════════════════════════════════════════════════════════════════════════

const bundle: AppBundle = {
  appId: 'app-ml-pipeline',
  intro:
    '## ML Pipeline — End-to-end MLOps (Databricks + Azure ML)\n\n' +
    'A complete customer-churn MLOps loop, materialized as a Loom workspace:\n\n' +
    '1. **Feature Store** — `bronze.transactions` / `bronze.customers` raw ' +
    'tables feed the `ml.features.customer_churn_features` feature table.\n' +
    '2. **Training** — XGBoost trained inside an MLflow run with point-in-time ' +
    'feature lookups; registered to Unity Catalog as `customer_churn_model`.\n' +
    '3. **Validation** — accuracy / f1 / auc_roc gate before promotion to ' +
    '**Staging**.\n' +
    '4. **Deployment** — Model Serving endpoint `customer-churn-model-endpoint` ' +
    '+ promotion to **Production** with inference auto-capture.\n' +
    '5. **Operations** — Lakehouse-Monitoring quality monitor, drift metrics ' +
    'warehouse, and an Activator drift-alert rule.\n\n' +
    'Install provisions all ten items against real backends — the lakehouse + ' +
    'its Delta tables, the warehouse DDL + seed rows, the five Fabric ' +
    'notebooks, the orchestration pipeline, the Activator rule, and the ' +
    'registered model. Long-running operations (the Lakehouse Load Table ' +
    'conversions, the pipeline run, and the model-training Databricks run) are ' +
    'SUBMITTED with real REST and then handed off: install returns as soon as ' +
    'each operation is accepted rather than blocking on it, so the whole ' +
    '10-item install completes well inside the gateway timeout. Each item ' +
    'carries its live operation / run id, so the editors and ' +
    '`/api/databricks/jobs` show the work finishing server-side. Re-running ' +
    'install is idempotent and reconciles any operation still in flight. Where ' +
    'a backend is not wired for the deployment (no bound Fabric workspace, no ' +
    'Databricks cluster, a paused Synapse pool, …), that item surfaces an ' +
    'honest remediation gate naming the exact env var / role / action instead ' +
    'of a fake success.',
  sourceDocs: ['docs/learn/08-solutions/ml-pipeline'],
  items: [
    // ─── Lakehouse: raw bronze + features + labels + validation (seeded) ──
    {
      itemType: 'lakehouse',
      displayName: 'ML Churn Lakehouse',
      description:
        'OneLake lakehouse holding the raw bronze tables (transactions, ' +
        'customers), the engineered feature table, the churn labels, and the ' +
        'held-out validation set used across the MLOps loop. Install lands a ' +
        'seed CSV per table in OneLake and submits a real Lakehouse Load Table ' +
        'conversion for each, so the sample rows become queryable Delta tables ' +
        '(the conversions finish server-side; the editor\'s Tables browser ' +
        'shows them as they land) — the training notebook then runs end-to-end.',
      learnDoc: 'ml-pipeline',
      content: {
        kind: 'lakehouse',
        folders: [
          { path: 'Files/bronze', description: 'Raw landing zone (transactions, customers).' },
          { path: 'Tables/bronze', description: 'Bronze managed Delta tables.' },
          { path: 'Tables/ml_features', description: 'Engineered customer churn feature table.' },
          { path: 'Tables/ml_labels', description: 'Ground-truth churn labels.' },
          { path: 'Tables/ml_validation', description: 'Held-out validation set.' },
          { path: 'Files/ml/monitoring', description: 'Lakehouse Monitoring assets dir.' },
        ],
        deltaTables: [
          {
            name: 'bronze_transactions',
            ddl:
              'CREATE TABLE bronze.transactions (\n' +
              '  transaction_id    STRING,\n' +
              '  customer_id       STRING,\n' +
              '  transaction_date  DATE,\n' +
              '  amount            DOUBLE,\n' +
              '  product_category  STRING\n' +
              ') USING DELTA',
            sampleRows: [
              ['txn-100001', 'cust-0001', '2026-05-02', 42.50, 'electronics'],
              ['txn-100002', 'cust-0001', '2026-05-09', 18.99, 'grocery'],
              ['txn-100003', 'cust-0001', '2026-05-20', 7.25, 'grocery'],
              ['txn-100004', 'cust-0002', '2026-03-11', 220.00, 'electronics'],
              ['txn-100005', 'cust-0002', '2026-03-14', 15.49, 'books'],
              ['txn-100006', 'cust-0003', '2026-05-28', 305.75, 'home'],
              ['txn-100007', 'cust-0003', '2026-05-29', 99.00, 'home'],
              ['txn-100008', 'cust-0004', '2025-12-01', 12.00, 'grocery'],
              ['txn-100009', 'cust-0005', '2026-05-30', 540.10, 'electronics'],
              ['txn-100010', 'cust-0005', '2026-05-31', 33.40, 'books'],
            ],
          },
          {
            name: 'bronze_customers',
            ddl:
              'CREATE TABLE bronze.customers (\n' +
              '  customer_id   STRING,\n' +
              '  signup_date   DATE,\n' +
              '  region        STRING,\n' +
              '  email         STRING\n' +
              ') USING DELTA',
            sampleRows: [
              ['cust-0001', '2024-01-15', 'us-east', 'a@example.com'],
              ['cust-0002', '2023-06-20', 'us-west', 'b@example.com'],
              ['cust-0003', '2025-02-10', 'eu-west', 'c@example.com'],
              ['cust-0004', '2022-09-05', 'us-east', 'd@example.com'],
              ['cust-0005', '2025-11-30', 'apac', 'e@example.com'],
            ],
          },
          {
            name: 'customer_churn_features',
            ddl:
              'CREATE TABLE ml.features.customer_churn_features (\n' +
              '  customer_id                  STRING,\n' +
              '  total_transactions           BIGINT,\n' +
              '  total_spend                  DOUBLE,\n' +
              '  avg_transaction_amount       DOUBLE,\n' +
              '  last_transaction_date        DATE,\n' +
              '  unique_categories            BIGINT,\n' +
              '  spend_volatility             DOUBLE,\n' +
              '  region                       STRING,\n' +
              '  days_since_signup            INT,\n' +
              '  days_since_last_transaction  INT\n' +
              ') USING DELTA TBLPROPERTIES (primary_keys = "customer_id")',
            sampleRows: [
              ['cust-0001', 3, 68.74, 22.91, '2026-05-20', 2, 18.40, 'us-east', 837, 12],
              ['cust-0002', 2, 235.49, 117.75, '2026-03-14', 2, 144.61, 'us-west', 1077, 79],
              ['cust-0003', 2, 404.75, 202.38, '2026-05-29', 1, 146.19, 'eu-west', 476, 3],
              ['cust-0004', 1, 12.00, 12.00, '2025-12-01', 1, 0.0, 'us-east', 1365, 182],
              ['cust-0005', 2, 573.50, 286.75, '2026-05-31', 2, 358.30, 'apac', 183, 1],
            ],
          },
          {
            name: 'churn_labels',
            ddl:
              'CREATE TABLE ml.labels.churn_labels (\n' +
              '  customer_id  STRING,\n' +
              '  churned      INT\n' +
              ') USING DELTA',
            sampleRows: [
              ['cust-0001', 0],
              ['cust-0002', 1],
              ['cust-0003', 0],
              ['cust-0004', 1],
              ['cust-0005', 0],
            ],
          },
          {
            name: 'holdout_churn',
            ddl:
              'CREATE TABLE ml.validation.holdout_churn (\n' +
              '  customer_id                  STRING,\n' +
              '  total_transactions           BIGINT,\n' +
              '  total_spend                  DOUBLE,\n' +
              '  avg_transaction_amount       DOUBLE,\n' +
              '  unique_categories            BIGINT,\n' +
              '  spend_volatility             DOUBLE,\n' +
              '  days_since_signup            INT,\n' +
              '  days_since_last_transaction  INT,\n' +
              '  churned                      INT\n' +
              ') USING DELTA',
            sampleRows: [
              ['cust-9001', 5, 412.30, 82.46, 3, 41.20, 600, 9, 0],
              ['cust-9002', 1, 9.99, 9.99, 1, 0.0, 1200, 210, 1],
              ['cust-9003', 8, 1304.00, 163.00, 4, 88.10, 950, 2, 0],
              ['cust-9004', 2, 47.00, 23.50, 1, 12.00, 410, 140, 1],
            ],
          },
        ],
        shortcuts: [
          {
            name: 'feature_store_uc',
            target: 'abfss://unity-catalog@onelake/ml/features',
            description:
              'Shortcut to the Unity-Catalog feature store schema so feature ' +
              'tables are queryable from this lakehouse.',
          },
        ],
      },
    },

    // ─── Notebook 1: Feature Engineering (Step 1) ─────────────────────────
    {
      itemType: 'notebook',
      displayName: '01 — Feature Engineering',
      description:
        'Builds ml.features.customer_churn_features from the bronze tables ' +
        'with the Databricks Feature Engineering client and schedules a daily ' +
        '06:00 UTC refresh. (Step 1 of the doc.)',
      learnDoc: 'ml-pipeline',
      content: { kind: 'notebook', defaultLang: 'pyspark', cells: NB_FEATURES_CELLS },
    },

    // ─── Notebook 2: Model Training (Step 2) ──────────────────────────────
    {
      itemType: 'notebook',
      displayName: '02 — Model Training',
      description:
        'Trains an XGBoost churn model in an MLflow run with feature-store ' +
        'lookups and registers it to Unity Catalog as customer_churn_model. ' +
        '(Step 2 of the doc.)',
      learnDoc: 'ml-pipeline',
      content: { kind: 'notebook', defaultLang: 'pyspark', cells: NB_TRAIN_CELLS },
    },

    // ─── Notebook 3: Model Validation (Step 3) ────────────────────────────
    {
      itemType: 'notebook',
      displayName: '03 — Model Validation',
      description:
        'Re-scores a candidate version against ml.validation.holdout_churn and ' +
        'promotes to Staging only when accuracy>0.80 / f1>0.75 / auc_roc>0.85. ' +
        '(Step 3 of the doc.)',
      learnDoc: 'ml-pipeline',
      content: { kind: 'notebook', defaultLang: 'pyspark', cells: NB_VALIDATE_CELLS },
    },

    // ─── Notebook 4: Model Deployment (Step 4) ────────────────────────────
    {
      itemType: 'notebook',
      displayName: '04 — Model Deployment',
      description:
        'Promotes Staging to the customer-churn-model-endpoint serving ' +
        'endpoint with inference auto-capture and transitions the registry to ' +
        'Production. (Step 4 of the doc.)',
      learnDoc: 'ml-pipeline',
      content: { kind: 'notebook', defaultLang: 'pyspark', cells: NB_DEPLOY_CELLS },
    },

    // ─── Notebook 5: Model Monitoring (Step 5) ────────────────────────────
    {
      itemType: 'notebook',
      displayName: '05 — Model Monitoring',
      description:
        'Creates a Lakehouse-Monitoring inference-log quality monitor and a ' +
        'Databricks-SQL drift alert over ml.monitoring.*_drift_metrics. ' +
        '(Step 5 of the doc.)',
      learnDoc: 'ml-pipeline',
      content: { kind: 'notebook', defaultLang: 'pyspark', cells: NB_MONITOR_CELLS },
    },

    // ─── Registered model (ml-model) — real Phase-2 training run at install ──
    {
      itemType: 'ml-model',
      displayName: 'customer_churn_model',
      description:
        'Registered XGBoost churn classifier. The editor renders the algorithm, ' +
        'hyperparameters, feature schema, and training code. At install the ' +
        'ml-model provisioner imports this trainingCode as a Databricks notebook ' +
        'and submits a real one-time run (api/2.1/jobs/runs/submit) that trains ' +
        'the model and registers it to the MLflow / Unity Catalog registry via ' +
        'log_model(registered_model_name="customer_churn_model"). The run is ' +
        'submitted and tracked (not blocked on) so install stays under the ' +
        'gateway timeout; track it via /api/databricks/jobs by its run id, then ' +
        'bind this editor to the registered version. When Databricks is not ' +
        'wired (no hostname / no runnable cluster / UAMI lacks workspace access) ' +
        'the item surfaces an honest remediation gate naming the exact env var / ' +
        'role instead of a fake registration.',
      learnDoc: 'ml-pipeline',
      content: {
        kind: 'ml-model',
        algorithm: 'XGBClassifier',
        framework: 'xgboost',
        hyperparameters: {
          n_estimators: 100,
          max_depth: 6,
          learning_rate: 0.1,
          objective: 'binary:logistic',
        },
        target: 'churned',
        features: [
          { name: 'total_transactions', type: 'bigint' },
          { name: 'total_spend', type: 'double' },
          { name: 'avg_transaction_amount', type: 'double' },
          { name: 'unique_categories', type: 'bigint' },
          { name: 'spend_volatility', type: 'double' },
          { name: 'days_since_signup', type: 'int' },
          { name: 'days_since_last_transaction', type: 'int' },
          { name: 'region', type: 'string' },
        ],
        trainingCode:
          'import mlflow, xgboost as xgb\n' +
          'from databricks.feature_engineering import FeatureEngineeringClient, FeatureLookup\n' +
          'from sklearn.model_selection import train_test_split\n\n' +
          'mlflow.set_registry_uri("databricks-uc")\n' +
          'mlflow.set_experiment("/Experiments/customer-churn")\n' +
          'fe = FeatureEngineeringClient()\n\n' +
          'training_set = fe.create_training_set(\n' +
          '    df=spark.table("ml.labels.churn_labels"),\n' +
          '    feature_lookups=[FeatureLookup(\n' +
          '        table_name="ml.features.customer_churn_features",\n' +
          '        lookup_key="customer_id")],\n' +
          '    label="churned",\n' +
          ')\n' +
          'df = training_set.load_df().toPandas()\n' +
          'X, y = df.drop(["customer_id", "churned"], axis=1), df["churned"]\n' +
          'X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, random_state=42)\n' +
          'with mlflow.start_run(run_name="training-latest"):\n' +
          '    model = xgb.XGBClassifier(n_estimators=100, max_depth=6,\n' +
          '                              learning_rate=0.1, objective="binary:logistic")\n' +
          '    model.fit(X_tr, y_tr)\n' +
          '    fe.log_model(model=model, artifact_path="model", flavor=mlflow.sklearn,\n' +
          '                 training_set=training_set,\n' +
          '                 registered_model_name="customer_churn_model")',
      },
    },

    // ─── Warehouse: inference-log + drift-metric tables (seeded) ──────────
    {
      itemType: 'warehouse',
      displayName: 'ML Monitoring Warehouse',
      description:
        'Inference-log + drift-metrics warehouse backing the model monitoring ' +
        'step. The drift alert and Activator rule read ' +
        'customer_churn_model_drift_metrics. Seeded with sample drift rows so ' +
        'the alert can be tested immediately.',
      learnDoc: 'ml-pipeline',
      content: {
        kind: 'warehouse',
        ddl: WAREHOUSE_DDL,
        // Seed sample drift + prediction rows so the drift alert / Activator
        // rule and the starter queries return non-empty result sets the moment
        // the app opens. The warehouse provisioner's seedSampleRows() inserts
        // these over the same TDS target the DDL ran on (one multi-row INSERT
        // per table) and verifies the count. Column order matches the DDL.
        sampleRows: [
          {
            table: 'customer_churn_model_drift_metrics',
            columns: [
              'date',
              'model_version',
              'drift_score',
              'feature_count',
              'drifted_features',
              'status',
            ],
            rows: [
              ['2026-05-26', 'v1', 0.04, 8, 0, 'NORMAL'],
              ['2026-05-27', 'v1', 0.06, 8, 1, 'NORMAL'],
              ['2026-05-28', 'v1', 0.05, 8, 0, 'NORMAL'],
              ['2026-05-29', 'v1', 0.09, 8, 1, 'NORMAL'],
              ['2026-05-30', 'v1', 0.12, 8, 2, 'DRIFT_DETECTED'],
              ['2026-05-31', 'v1', 0.15, 8, 3, 'DRIFT_DETECTED'],
            ],
          },
          {
            table: 'customer_churn_model_predictions',
            columns: [
              'request_id',
              'model_version',
              'customer_id',
              'prediction',
              'prediction_proba',
              'actual_label',
              'timestamp',
            ],
            rows: [
              ['req-0001', 'v1', 'cust-0001', 0, 0.12, 0, '2026-05-31T08:00:00.000Z'],
              ['req-0002', 'v1', 'cust-0002', 1, 0.88, 1, '2026-05-31T08:01:00.000Z'],
              ['req-0003', 'v1', 'cust-0003', 0, 0.21, 0, '2026-05-31T08:02:00.000Z'],
              ['req-0004', 'v1', 'cust-0004', 1, 0.79, 1, '2026-05-31T08:03:00.000Z'],
              ['req-0005', 'v1', 'cust-0005', 0, 0.09, 0, '2026-05-31T08:04:00.000Z'],
              ['req-0006', 'v1', 'cust-0001', 1, 0.64, null, '2026-05-31T08:05:00.000Z'],
            ],
          },
        ],
        starterQueries: [
          {
            name: 'Today drift status',
            sql:
              'SELECT [date], model_version, drift_score, drifted_features, status\n' +
              'FROM customer_churn_model_drift_metrics\n' +
              "WHERE [date] = CAST(GETUTCDATE() AS DATE)\n" +
              'ORDER BY drift_score DESC;',
          },
          {
            name: 'Prediction class balance (last 1000)',
            sql:
              'SELECT prediction, COUNT(*) AS n, AVG(prediction_proba) AS avg_proba\n' +
              'FROM (SELECT TOP 1000 * FROM customer_churn_model_predictions\n' +
              '      ORDER BY [timestamp] DESC) t\n' +
              'GROUP BY prediction;',
          },
          {
            name: 'Rolling 7-day drift trend',
            sql:
              'SELECT [date], AVG(drift_score) AS avg_drift\n' +
              'FROM customer_churn_model_drift_metrics\n' +
              "WHERE [date] >= DATEADD(day, -7, CAST(GETUTCDATE() AS DATE))\n" +
              'GROUP BY [date] ORDER BY [date];',
          },
        ],
        dbtModels: [
          {
            layer: 'gold',
            name: 'gld_model_drift_daily',
            sql:
              'SELECT\n' +
              '  [date],\n' +
              '  model_version,\n' +
              '  MAX(drift_score)                                   AS max_drift_score,\n' +
              '  SUM(drifted_features)                              AS drifted_features,\n' +
              "  CASE WHEN MAX(drift_score) > 0.1 THEN 'DRIFT_DETECTED'\n" +
              "       ELSE 'NORMAL' END                             AS status\n" +
              'FROM customer_churn_model_drift_metrics\n' +
              'GROUP BY [date], model_version',
          },
        ],
      },
    },

    // ─── Data pipeline: MLOps orchestration (Test->Train->Validate->Deploy)
    {
      itemType: 'data-pipeline',
      displayName: 'MLOps Orchestration Pipeline',
      description:
        'Orchestrates the CI/CD stages from the doc: Test -> Train -> Validate ' +
        '-> Deploy, each invoking the corresponding training/validation/' +
        'deployment notebook. Mirrors azure-pipelines.yml.',
      learnDoc: 'ml-pipeline',
      content: {
        kind: 'adf-pipeline',
        parameters: {
          model_name: { type: 'string', defaultValue: 'customer_churn_model' },
          data_version: { type: 'string', defaultValue: 'latest' },
        },
        activities: [
          {
            name: 'UnitTests',
            type: 'DatabricksSparkPython',
            config: {
              pythonFile: 'dbfs:/Repos/ml/tests/run_unit_tests.py',
              description: 'pytest tests/unit/ — Test stage gate.',
            },
          },
          {
            name: 'TrainModel',
            type: 'DatabricksNotebook',
            dependsOn: ['UnitTests'],
            config: {
              notebookPath: '/Repos/ml/training/02_model_training',
              baseParameters: { data_version: '@pipeline().parameters.data_version' },
              description: 'Trains + registers customer_churn_model (Step 2).',
            },
          },
          {
            name: 'ValidateModel',
            type: 'DatabricksNotebook',
            dependsOn: ['TrainModel'],
            config: {
              notebookPath: '/Repos/ml/validation/03_model_validation',
              baseParameters: { model_name: '@pipeline().parameters.model_name' },
              description: 'Gates on accuracy/f1/auc_roc, promotes to Staging (Step 3).',
            },
          },
          {
            name: 'DeployModel',
            type: 'DatabricksNotebook',
            dependsOn: ['ValidateModel'],
            config: {
              notebookPath: '/Repos/ml/deployment/04_model_deployment',
              baseParameters: { model_name: '@pipeline().parameters.model_name' },
              description: 'Promotes Staging -> Production serving endpoint (Step 4).',
            },
          },
          {
            name: 'SetupMonitoring',
            type: 'DatabricksNotebook',
            dependsOn: ['DeployModel'],
            config: {
              notebookPath: '/Repos/ml/monitoring/05_model_monitoring',
              baseParameters: { model_name: '@pipeline().parameters.model_name' },
              description: 'Creates inference-log monitor + drift alert (Step 5).',
            },
          },
        ],
      },
    },

    // ─── Activator: drift alert rule ──────────────────────────────────────
    {
      itemType: 'activator',
      displayName: 'Model Drift Alert',
      description:
        'Fires when the daily drift_score for customer_churn_model crosses ' +
        '0.1, paging the data-science team via Teams. Mirrors the ' +
        'create_drift_alert Databricks-SQL alert in Step 5.',
      learnDoc: 'ml-pipeline',
      content: {
        kind: 'activator',
        rule: {
          name: 'customer_churn_model_drift_alert',
          condition: { metric: 'drift_score', op: '>', threshold: 0.1 },
          window: '1 day',
          action: {
            kind: 'teams',
            config: {
              channel: 'data-science-mlops',
              title: 'Model drift detected — customer_churn_model',
              body:
                'Daily drift_score exceeded 0.1 for customer_churn_model. ' +
                'Review ml.monitoring.customer_churn_model_drift_metrics and ' +
                'consider retraining (see notebook 02 — Model Training).',
            },
          },
        },
      },
    },
  ],
};

export default bundle;
