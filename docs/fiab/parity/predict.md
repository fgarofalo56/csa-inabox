# predict — parity with Microsoft Fabric PREDICT (batch scoring)

Source UI: Fabric Data Science → registered ML model → **Generate PREDICT code /
Apply model wizard** (`https://learn.microsoft.com/fabric/data-science/model-scoring-predict`).
Azure-native 1:1: an **Azure ML registered MLflow model** scored on Spark via
`mlflow.pyfunc.spark_udf` (the same mechanism SynapseML's `MLFlowTransformer`
wraps), reading a Delta/lakehouse table and writing a scored Delta table. No
Fabric dependency — model lives in the AML registry (`models:/<name>/<version>`)
and compute is AML Serverless Spark or Synapse Spark.

Surface: ML-model editor → **Batch score** tab (+ ribbon Serve → "Batch score
(PREDICT)"). Lives on the bound model so Step 1 = pick the registered model's
version; the model itself is the item's binding.

## Fabric feature inventory

| # | Fabric PREDICT capability | Notes |
|---|---------------------------|-------|
| 1 | Pick a registered MLflow model + version | Model picker + version list |
| 2 | Read the model's input signature | Feature names/types from the MLmodel signature |
| 3 | Pick an input table (lakehouse) | Delta table as scoring input |
| 4 | Map input table columns → model input features | Column-to-feature mapping grid |
| 5 | Choose the output result type | e.g. string label vs numeric |
| 6 | Name the output/prediction column | Appended prediction column |
| 7 | Write a scored output table | New/overwritten Delta table |
| 8 | Run a real Spark batch-scoring job | `MLFlowTransformer` / `synapse.ml.predict` |
| 9 | Show job status + output | Progress + resulting scored table |

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Pick model + version | ✅ built | Step 1 — bound AML model; version from the real registry (`listModelVersions`) |
| 2 | Read model signature | ✅ built | `GET .../predict` seeds features from the version's stamped MLflow signature; falls back to the bundle definition, else manual |
| 3 | Pick input table | ✅ built | Step 2 — Delta path (abfss://) or registered table; real AML datastore roots offered as hints (`listDatastores`) |
| 4 | Column → feature mapping | ✅ built | Step 2 — editable mapping grid; column defaults to the feature name; aliased into the scoring struct |
| 5 | Result type | ✅ built | Step 3 — double/float/integer/long/string/boolean (Spark UDF `result_type`) |
| 6 | Prediction column | ✅ built | Step 3 — named, validated identifier |
| 7 | Scored output table | ✅ built | Step 3 — Delta path or `saveAsTable`; overwrite/append |
| 8 | Real Spark scoring job | ✅ built | Step 4 — `POST .../predict` builds `mlflow.pyfunc.spark_udf` PySpark, submits to AML Serverless Spark (`submitAmlSparkCell`) or Synapse Spark via Livy (default / Gov) |
| 9 | Status + output | ✅ built | Step 4 — `GET .../predict/status` polls the job; on success shows row count + scored-table location + link |
| — | Honest infra-gate | ⚠️ gate | If neither AML Serverless Spark nor a Synapse pool is configured, a Fluent MessageBar names `LOOM_SYNAPSE_SPARK_POOL` / `LOOM_AML_SPARK` + the role — the full wizard still renders |

Zero ❌ rows.

## Backend per control

| Control | Backend |
|---------|---------|
| Model + version list | AML ARM model registry — `foundry-client.getModel` / `listModelVersions` (via the ml-model item binding) |
| Feature seed (signature) | Model version metadata — `foundry-client.getModelVersion` (properties/tags signature) → bundle definition fallback |
| Input datastore hints | AML ARM datastores — `aml-client.listDatastores` (abfss:// roots) |
| Job submit (AML) | AML Serverless Spark standalone job — `aml-spark-client.submitAmlSparkCell` |
| Job submit (Synapse, default/Gov) | Synapse Spark via Livy — `synapse-livy-client` session/statement, pending state persisted on the item |
| MLflow registry resolution | `mlflow-client.mlflowConfig().base` → `azureml://` tracking URI baked into the job so `models:/` resolves on Synapse Spark |
| Status poll | AML: `getAmlSparkJob` + `readAmlSparkResult`; Synapse: `getLivySession` + `submitLivyStatement` + `getLivyStatement` |
| Codegen | `predict-codegen.buildPredictPySpark` (pure, unit-tested — `predict-codegen.test.ts`) |

## Generated scoring job (shape)

```python
import json
import mlflow
from pyspark.sql.functions import col, struct

mlflow.set_tracking_uri("azureml://…/workspaces/<ws>")   # injected server-side
mlflow.set_registry_uri("azureml://…/workspaces/<ws>")

MODEL_URI = "models:/<model>/<version>"
_df = spark.read.format("delta").load("abfss://…/Tables/customers")
_features = ["tenure", "monthly_charges"]
_work = _df.select(
    col("customer_id"),
    col("tenure_months").alias("tenure"),
    col("monthly_charges"),
)
_predict = mlflow.pyfunc.spark_udf(spark, model_uri=MODEL_URI, env_manager="local", result_type="double")
_scored = _work.withColumn("prediction", _predict(struct(*[col(f) for f in _features])))
(_scored.write.format("delta").mode("overwrite").save("abfss://…/Tables/customers_scored"))
_rows = _scored.count()
print("LOOM_PREDICT_RESULT " + json.dumps({"rows": _rows, "output": "…", "prediction_column": "prediction", "model": "<model>", "version": "<version>"}))
```

## Verification

- Unit: `apps/fiab-console/lib/azure/__tests__/predict-codegen.test.ts` (codegen +
  validation + receipt parsing).
- Live E2E (next roll / operator): with a registered MLflow model + a Spark pool
  (or `LOOM_AML_SPARK`), run the stepper end-to-end and confirm a scored Delta
  table is written with a `prediction` column and the row-count receipt returns.
