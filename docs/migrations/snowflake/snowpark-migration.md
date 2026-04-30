# Snowpark Migration Guide

**Status:** Authored 2026-04-30
**Audience:** Data engineers, ML engineers, and developers maintaining Snowpark Python/Java/Scala code
**Scope:** Snowpark DataFrame API to PySpark/Fabric notebooks, UDFs to Azure Functions, stored procedures, Snowpark ML to MLflow

---

## 1. Snowpark overview and migration targets

Snowpark is Snowflake's developer framework for writing data pipelines and ML workflows in Python, Java, or Scala. It consists of:

| Snowpark component                | Azure target                                    | Rationale                                               |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| Snowpark Python DataFrame API     | PySpark DataFrame API                           | PySpark is the original; Snowpark modeled after it      |
| Snowpark Java/Scala DataFrame API | Spark Java/Scala API                            | Direct translation; Spark API predates Snowpark         |
| Snowpark Python UDFs              | Databricks SQL UDFs / PySpark UDFs              | SQL UDFs for simple functions; PySpark for complex      |
| Snowpark Java UDFs                | Spark Java UDFs                                 | Direct translation                                      |
| Snowpark stored procedures        | Databricks notebooks / SQL stored procedures    | Notebooks for complex logic; SQL SPs for simple         |
| Snowpark ML (model training)      | MLflow on Databricks                            | MLflow provides richer experiment tracking and registry |
| Snowpark ML (model deployment)    | Databricks Model Serving                        | Managed endpoints with auto-scaling                     |
| Snowpark Container Services       | Azure Container Apps + Databricks Model Serving | General containers: ACA; inference: Model Serving       |

---

## 2. DataFrame API translation

The core Snowpark-to-PySpark translation is straightforward because Snowpark's DataFrame API was inspired by PySpark.

### Import changes

```python
# Snowpark (before)
from snowflake.snowpark import Session
from snowflake.snowpark.functions import col, lit, when, sum as sum_, avg, count
from snowflake.snowpark.types import IntegerType, StringType, StructType, StructField

# PySpark (after)
from pyspark.sql import SparkSession
from pyspark.sql.functions import col, lit, when, sum as sum_, avg, count
from pyspark.sql.types import IntegerType, StringType, StructType, StructField
```

### Session creation

```python
# Snowpark (before)
connection_params = {
    "account": "ACMEGOV.us-gov-west-1.snowflake-gov",
    "user": "SVC_USER",
    "password": os.environ["SNOWFLAKE_PASSWORD"],
    "role": "DATA_ENGINEER",
    "warehouse": "ANALYTICS_WH",
    "database": "ANALYTICS_DB",
    "schema": "RAW"
}
session = Session.builder.configs(connection_params).create()

# PySpark / Databricks (after)
spark = SparkSession.builder \
    .appName("analytics-pipeline") \
    .config("spark.sql.catalog.analytics_prod", "com.databricks.sql.catalog.UnityCatalogProvider") \
    .getOrCreate()

# In Databricks notebooks, SparkSession is pre-configured:
# spark = SparkSession already available as `spark`
```

### Common DataFrame operations

```python
# ------ Reading data ------

# Snowpark
df = session.table("RAW.CUSTOMERS")

# PySpark
df = spark.table("analytics_prod.raw.customers")

# ------ Filtering ------

# Snowpark
filtered = df.filter(col("status") == "active")

# PySpark (identical)
filtered = df.filter(col("status") == "active")

# ------ Selecting and renaming ------

# Snowpark
result = df.select(
    col("CUSTOMER_ID").alias("customer_id"),
    col("FIRST_NAME").alias("first_name"),
    col("CREATED_AT").alias("created_at")
)

# PySpark (identical)
result = df.select(
    col("customer_id"),
    col("first_name"),
    col("created_at")
)
# Note: Snowflake uppercases column names by default; Databricks preserves case

# ------ Aggregation ------

# Snowpark
agg = df.group_by("region").agg(
    count("*").alias("customer_count"),
    sum_("revenue").alias("total_revenue")
)

# PySpark
agg = df.groupBy("region").agg(
    count("*").alias("customer_count"),
    sum_("revenue").alias("total_revenue")
)
# Note: group_by vs groupBy -- this is the most common syntax difference

# ------ Joins ------

# Snowpark
joined = orders.join(customers, orders["customer_id"] == customers["customer_id"], "left")

# PySpark (identical)
joined = orders.join(customers, orders["customer_id"] == customers["customer_id"], "left")

# ------ Writing data ------

# Snowpark
df.write.mode("overwrite").save_as_table("STAGING.CUSTOMERS_CLEAN")

# PySpark
df.write.mode("overwrite").saveAsTable("analytics_prod.staging.customers_clean")
# Note: save_as_table vs saveAsTable (snake_case vs camelCase)
```

### Method name differences (complete reference)

| Snowpark method         | PySpark method        | Notes                  |
| ----------------------- | --------------------- | ---------------------- |
| `group_by()`            | `groupBy()`           | Most common difference |
| `order_by()`            | `orderBy()`           |                        |
| `save_as_table()`       | `saveAsTable()`       |                        |
| `create_dataframe()`    | `createDataFrame()`   |                        |
| `with_column()`         | `withColumn()`        |                        |
| `with_column_renamed()` | `withColumnRenamed()` |                        |
| `drop_duplicates()`     | `dropDuplicates()`    |                        |
| `na.fill()`             | `na.fill()`           | Identical              |
| `na.drop()`             | `na.drop()`           | Identical              |
| `union_all()`           | `unionAll()`          |                        |
| `union_by_name()`       | `unionByName()`       |                        |
| `to_pandas()`           | `toPandas()`          |                        |
| `cross_join()`          | `crossJoin()`         |                        |

**Pattern:** Snowpark uses snake_case; PySpark uses camelCase. A regex replacement handles most cases:

```bash
# Bulk rename common methods (use with caution; review each change)
sed -i 's/\.group_by(/\.groupBy(/g' *.py
sed -i 's/\.order_by(/\.orderBy(/g' *.py
sed -i 's/\.save_as_table(/\.saveAsTable(/g' *.py
sed -i 's/\.with_column(/\.withColumn(/g' *.py
sed -i 's/\.with_column_renamed(/\.withColumnRenamed(/g' *.py
sed -i 's/\.drop_duplicates(/\.dropDuplicates(/g' *.py
sed -i 's/\.union_all(/\.unionAll(/g' *.py
sed -i 's/\.union_by_name(/\.unionByName(/g' *.py
sed -i 's/\.cross_join(/\.crossJoin(/g' *.py
sed -i 's/\.to_pandas(/\.toPandas(/g' *.py
sed -i 's/\.create_dataframe(/\.createDataFrame(/g' *.py
```

---

## 3. UDF migration

### SQL UDFs (simplest)

```sql
-- Snowflake SQL UDF
CREATE OR REPLACE FUNCTION classify_risk(score FLOAT)
RETURNS STRING
AS $$
    CASE
        WHEN score >= 0.8 THEN 'HIGH'
        WHEN score >= 0.5 THEN 'MEDIUM'
        ELSE 'LOW'
    END
$$;

-- Databricks SQL UDF (nearly identical)
CREATE OR REPLACE FUNCTION analytics_prod.utils.classify_risk(score DOUBLE)
RETURNS STRING
RETURN CASE
    WHEN score >= 0.8 THEN 'HIGH'
    WHEN score >= 0.5 THEN 'MEDIUM'
    ELSE 'LOW'
END;
```

### Python UDFs

```python
# Snowpark Python UDF (before)
from snowflake.snowpark.functions import udf
from snowflake.snowpark.types import StringType

@udf(name="parse_address", return_type=StringType(), input_types=[StringType()])
def parse_address(raw_address: str) -> str:
    # Parse address logic
    parts = raw_address.split(",")
    return parts[0].strip() if parts else raw_address

# PySpark Python UDF (after)
from pyspark.sql.functions import udf
from pyspark.sql.types import StringType

@udf(returnType=StringType())
def parse_address(raw_address: str) -> str:
    parts = raw_address.split(",")
    return parts[0].strip() if parts else raw_address

# Register for SQL use
spark.udf.register("parse_address", parse_address)
```

### pandas UDFs (vectorized)

```python
# Snowpark vectorized UDF (before)
from snowflake.snowpark.functions import pandas_udf
from snowflake.snowpark.types import FloatType
import pandas as pd

@pandas_udf(return_type=FloatType(), input_types=[FloatType()])
def normalize_score(scores: pd.Series) -> pd.Series:
    return (scores - scores.min()) / (scores.max() - scores.min())

# PySpark pandas UDF (after)
from pyspark.sql.functions import pandas_udf
from pyspark.sql.types import FloatType
import pandas as pd

@pandas_udf(FloatType())
def normalize_score(scores: pd.Series) -> pd.Series:
    return (scores - scores.min()) / (scores.max() - scores.min())
```

---

## 4. Stored procedure migration

### Simple SQL stored procedures

```sql
-- Snowflake stored procedure
CREATE OR REPLACE PROCEDURE refresh_marts()
RETURNS STRING
LANGUAGE SQL
AS
BEGIN
    TRUNCATE TABLE marts.fct_daily_summary;
    INSERT INTO marts.fct_daily_summary
    SELECT * FROM staging.v_daily_summary;
    RETURN 'Success: ' || CURRENT_TIMESTAMP()::STRING;
END;

-- Databricks SQL stored procedure (similar syntax)
CREATE OR REPLACE PROCEDURE analytics_prod.ops.refresh_marts()
LANGUAGE SQL
AS
BEGIN
    TRUNCATE TABLE analytics_prod.marts.fct_daily_summary;
    INSERT INTO analytics_prod.marts.fct_daily_summary
    SELECT * FROM analytics_prod.staging.v_daily_summary;
END;
```

### Complex stored procedures (JavaScript/Python)

Snowflake JavaScript stored procedures should be rewritten as Databricks notebooks:

```javascript
// Snowflake JavaScript stored procedure (before)
CREATE OR REPLACE PROCEDURE process_files(stage_name STRING)
RETURNS STRING
LANGUAGE JAVASCRIPT
AS $$
    var files = snowflake.execute({
        sqlText: `LIST @${STAGE_NAME}`
    });
    var count = 0;
    while (files.next()) {
        var fileName = files.getColumnValue(1);
        snowflake.execute({
            sqlText: `COPY INTO raw.events FROM @${STAGE_NAME}/${fileName}`
        });
        count++;
    }
    return `Processed ${count} files`;
$$;
```

```python
# Databricks notebook (after)
# This becomes a notebook that can be scheduled via Databricks Jobs or ADF

from pyspark.sql import SparkSession

spark = SparkSession.builder.getOrCreate()

# List files in storage
files = dbutils.fs.ls("/mnt/raw-data/events/")

count = 0
for file_info in files:
    if file_info.name.endswith(".parquet"):
        df = spark.read.parquet(file_info.path)
        df.write.mode("append").saveAsTable("analytics_prod.raw.events")
        count += 1

print(f"Processed {count} files")

# Or, more idiomatically, use Autoloader:
# (spark.readStream
#     .format("cloudFiles")
#     .option("cloudFiles.format", "parquet")
#     .load("/mnt/raw-data/events/")
#     .writeStream
#     .option("checkpointLocation", "/mnt/checkpoints/events")
#     .toTable("analytics_prod.raw.events"))
```

---

## 5. Snowpark ML to MLflow

### Model training

```python
# Snowpark ML (before)
from snowflake.ml.modeling.xgboost import XGBClassifier
from snowflake.ml.modeling.preprocessing import StandardScaler

scaler = StandardScaler(input_cols=["feature_a", "feature_b"], output_cols=["scaled_a", "scaled_b"])
train_scaled = scaler.fit(train_df).transform(train_df)

model = XGBClassifier(input_cols=["scaled_a", "scaled_b"], label_cols=["label"])
model.fit(train_scaled)

# MLflow on Databricks (after)
import mlflow
from xgboost import XGBClassifier
from sklearn.preprocessing import StandardScaler
import pandas as pd

mlflow.set_experiment("/experiments/risk-classification")

with mlflow.start_run():
    train_pd = train_df.toPandas()

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(train_pd[["feature_a", "feature_b"]])

    model = XGBClassifier()
    model.fit(X_scaled, train_pd["label"])

    mlflow.log_params(model.get_params())
    mlflow.sklearn.log_model(model, "model")
    mlflow.log_metric("accuracy", model.score(X_scaled, train_pd["label"]))
```

### Model registry

```python
# Snowpark ML model registry (before)
from snowflake.ml.registry import Registry

reg = Registry(session)
reg.log_model(model, model_name="risk_classifier", version_name="v1")

# MLflow model registry (after)
import mlflow

mlflow.register_model(
    model_uri="runs:/<run_id>/model",
    name="risk_classifier"
)

# Promote to production
from mlflow.tracking import MlflowClient
client = MlflowClient()
client.transition_model_version_stage(
    name="risk_classifier",
    version=1,
    stage="Production"
)
```

### Model serving

```python
# Snowpark Container Services model inference (before)
# Model served as a Snowflake function
SELECT risk_classifier_predict(feature_a, feature_b)
FROM staging.new_applications;

# Databricks Model Serving (after)
# Model served as a REST endpoint
import requests

endpoint_url = "https://adb-workspace.databricks.azure.us/serving-endpoints/risk-classifier/invocations"
response = requests.post(
    endpoint_url,
    headers={"Authorization": f"Bearer {token}"},
    json={"dataframe_records": [{"feature_a": 0.5, "feature_b": 0.3}]}
)

# Or call from SQL via ai_query()
# SELECT ai_query('risk-classifier', feature_a, feature_b) FROM staging.new_applications;
```

---

## 6. Snowpark Container Services migration

Snowpark Container Services provides managed container hosting within Snowflake. The Azure replacement depends on the workload type:

### Inference workloads

| Snowpark Container Services | Databricks Model Serving                          |
| --------------------------- | ------------------------------------------------- |
| Deploy container with model | Register model in MLflow; create serving endpoint |
| GPU support via Snowflake   | GPU support via Databricks (V100, A10G, A100)     |
| Auto-scaling based on load  | Auto-scaling based on concurrency                 |
| SQL-callable inference      | `ai_query()` SQL function or REST API             |

### General compute workloads

| Snowpark Container Services | Azure Container Apps                     |
| --------------------------- | ---------------------------------------- |
| Long-running containers     | Container Apps with scale rules          |
| Scheduled containers        | Container Apps Jobs                      |
| GPU workloads               | Container Apps with GPU (or AKS)         |
| Networking                  | VNet integration with Private Endpoints  |
| Service mesh                | Dapr sidecar (built into Container Apps) |

### Migration decision tree

```
Is the container serving a model for inference?
├── Yes → Databricks Model Serving
│         - Register model in MLflow
│         - Create serving endpoint
│         - Call via ai_query() or REST
└── No → Azure Container Apps
          Is it a scheduled batch job?
          ├── Yes → Container Apps Jobs
          └── No → Container Apps (always-on or scale-to-zero)
               Does it need GPU?
               ├── Yes → Container Apps with GPU or AKS
               └── No → Container Apps (standard)
```

---

## 7. Testing migrated code

### Unit testing framework

```python
# Test file: test_transformations.py
import pytest
from pyspark.sql import SparkSession
from pyspark.sql.types import StructType, StructField, StringType, DoubleType

@pytest.fixture(scope="session")
def spark():
    return SparkSession.builder \
        .master("local[2]") \
        .appName("test") \
        .getOrCreate()

def test_classify_risk(spark):
    schema = StructType([
        StructField("id", StringType()),
        StructField("score", DoubleType())
    ])
    data = [("a", 0.9), ("b", 0.6), ("c", 0.2)]
    df = spark.createDataFrame(data, schema)

    result = df.withColumn("risk", classify_risk(col("score")))

    assert result.filter(col("risk") == "HIGH").count() == 1
    assert result.filter(col("risk") == "MEDIUM").count() == 1
    assert result.filter(col("risk") == "LOW").count() == 1
```

### Integration testing

Run the full pipeline against a test catalog in Unity Catalog:

```python
# Integration test against test catalog
def test_pipeline_end_to_end(spark):
    # Use test catalog
    spark.sql("USE CATALOG analytics_test")

    # Run pipeline
    from pipelines.daily_pipeline import run_daily_pipeline
    result = run_daily_pipeline(spark, catalog="analytics_test")

    # Validate output
    output = spark.table("analytics_test.marts.fct_daily_summary")
    assert output.count() > 0
    assert "revenue" in output.columns
```

---

## 8. Migration checklist

- [ ] Inventory all Snowpark code (Python, Java, Scala)
- [ ] Classify each module: DataFrame API, UDF, stored procedure, ML, container
- [ ] Set up Databricks workspace with Unity Catalog
- [ ] Translate imports (snowflake.snowpark to pyspark.sql)
- [ ] Rename methods (snake_case to camelCase)
- [ ] Migrate SQL UDFs (minimal changes)
- [ ] Migrate Python UDFs (decorator syntax changes)
- [ ] Convert stored procedures to notebooks
- [ ] Migrate ML pipelines to MLflow
- [ ] Register models in MLflow registry
- [ ] Set up Model Serving endpoints
- [ ] Migrate Container Services to Container Apps / Model Serving
- [ ] Write and run unit tests with local SparkSession
- [ ] Run integration tests against test catalog
- [ ] Benchmark performance against Snowpark baseline
- [ ] Deploy to production workspace

---

## Related documents

- [Feature Mapping](feature-mapping-complete.md) -- Section 5 for Snowpark features
- [Warehouse Migration](warehouse-migration.md) -- compute sizing for Spark workloads
- [Tutorial: dbt Migration](tutorial-dbt-snowflake-to-fabric.md) -- SQL-side migration
- [Master playbook](../snowflake.md) -- Section 2 capability mapping for Snowpark

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
