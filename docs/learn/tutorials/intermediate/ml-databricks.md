---
title: "Machine Learning on Databricks"
description: "__Build machine learning pipelines on Databricks. Learn MLflow, AutoML, and model deployment.__"
tags:
  - tutorials
  - intermediate
---
# 🤖 Machine Learning on Databricks

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Level](https://img.shields.io/badge/Level-Intermediate-yellow)
![Duration](https://img.shields.io/badge/Duration-75--90_minutes-blue)

__Build machine learning pipelines on Databricks. Learn MLflow, AutoML, and model deployment.__

## 🎯 Learning Objectives

- Build ML models with Spark MLlib
- Track experiments with MLflow
- Use AutoML for automated model selection
- Deploy models for inference
- Implement feature engineering

## 📋 Prerequisites

- [ ] __Databricks workspace__ - [Quickstart](../beginner/databricks-quickstart.md)
- [ ] __Python ML libraries__ - scikit-learn, pandas
- [ ] __Basic ML concepts__ - Classification, regression

## 🧠 Step 1: Load and Prepare Data

```python
# Load data
df = spark.read.csv("/data/customer-churn.csv", header=True, inferSchema=True)

# Feature engineering
from pyspark.sql.functions import *

df_features = df.withColumn(
    "total_spend",
    col("monthly_charges") * col("tenure")
)

# Split data
train_df, test_df = df_features.randomSplit([0.8, 0.2], seed=42)
```

## 🏗️ Step 2: Build ML Pipeline

```python
from pyspark.ml import Pipeline
from pyspark.ml.feature import VectorAssembler, StringIndexer
from pyspark.ml.classification import LogisticRegression

# Feature transformation
assembler = VectorAssembler(
    inputCols=["tenure", "monthly_charges", "total_spend"],
    outputCol="features"
)

# Model
lr = LogisticRegression(
    featuresCol="features",
    labelCol="churn",
    maxIter=10
)

# Pipeline
pipeline = Pipeline(stages=[assembler, lr])

# Train
model = pipeline.fit(train_df)
```

## 📊 Step 3: Track with MLflow

```python
import mlflow
import mlflow.spark

# Start run
with mlflow.start_run():
    # Train model
    model = pipeline.fit(train_df)

    # Log parameters
    mlflow.log_param("maxIter", 10)

    # Evaluate
    predictions = model.transform(test_df)
    accuracy = evaluator.evaluate(predictions)

    # Log metrics
    mlflow.log_metric("accuracy", accuracy)

    # Log model
    mlflow.spark.log_model(model, "model")
```

## 🚀 Step 4: Deploy Model

```python
# Load model
model = mlflow.spark.load_model("runs:/run-id/model")

# Batch prediction
predictions = model.transform(new_data)

# Save results
predictions.write.format("delta").save("/ml/predictions")
```

## 📚 Resources

- [MLflow Documentation](https://mlflow.org/)
- [Spark MLlib Guide](https://spark.apache.org/docs/latest/ml-guide.html)

---

*Last Updated: January 2025*
