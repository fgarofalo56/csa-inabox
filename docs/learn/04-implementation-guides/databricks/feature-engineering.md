---
title: "Feature Engineering Guide"
description: "Best practices and patterns for feature engineering in Databricks."
tags:
  - implementation
  - databricks
---
# 🔧 Feature Engineering Guide

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)

Best practices and patterns for feature engineering in Databricks.

---

## 🎯 Overview

Feature engineering transforms raw data into meaningful inputs for machine learning models.

---

## 📊 Common Feature Types

### Numerical Features

```python
from pyspark.sql.functions import *
from pyspark.ml.feature import StandardScaler, VectorAssembler

# Log transformation for skewed data
df = df.withColumn("log_amount", log1p(col("amount")))

# Binning/Discretization
df = df.withColumn(
    "amount_bucket",
    when(col("amount") < 100, "low")
    .when(col("amount") < 500, "medium")
    .otherwise("high")
)

# Z-score normalization
assembler = VectorAssembler(inputCols=["amount"], outputCol="amount_vec")
scaler = StandardScaler(inputCol="amount_vec", outputCol="scaled_amount")
```

### Temporal Features

```python
# Extract temporal components
df = df.withColumn("day_of_week", dayofweek(col("timestamp")))
df = df.withColumn("hour_of_day", hour(col("timestamp")))
df = df.withColumn("is_weekend", col("day_of_week").isin([1, 7]).cast("int"))
df = df.withColumn("quarter", quarter(col("timestamp")))

# Cyclical encoding for periodic features
df = df.withColumn("hour_sin", sin(2 * 3.14159 * col("hour_of_day") / 24))
df = df.withColumn("hour_cos", cos(2 * 3.14159 * col("hour_of_day") / 24))
```

### Aggregation Features

```python
from pyspark.sql.window import Window

# Rolling window aggregations
window_30d = Window.partitionBy("customer_id").orderBy("timestamp").rangeBetween(-30*86400, 0)

df = df.withColumn("rolling_30d_sum", sum("amount").over(window_30d))
df = df.withColumn("rolling_30d_count", count("*").over(window_30d))
df = df.withColumn("rolling_30d_avg", avg("amount").over(window_30d))

# Lag features
df = df.withColumn("prev_amount", lag("amount", 1).over(Window.partitionBy("customer_id").orderBy("timestamp")))
df = df.withColumn("amount_change", col("amount") - col("prev_amount"))
```

### Categorical Features

```python
from pyspark.ml.feature import StringIndexer, OneHotEncoder

# String indexing
indexer = StringIndexer(inputCol="category", outputCol="category_index")
df = indexer.fit(df).transform(df)

# One-hot encoding
encoder = OneHotEncoder(inputCol="category_index", outputCol="category_vec")
df = encoder.fit(df).transform(df)

# Target encoding (mean encoding)
target_means = df.groupBy("category").agg(avg("target").alias("category_target_mean"))
df = df.join(target_means, "category")
```

---

## 🛡️ Best Practices

### Avoid Data Leakage

```python
# Use point-in-time correct features
from databricks.feature_engineering import FeatureLookup

# Correct: Timestamp-aware lookup
feature_lookup = FeatureLookup(
    table_name="features.customer_history",
    lookup_key="customer_id",
    timestamp_lookup_key="event_timestamp",  # Ensures no future data leakage
    feature_names=["historical_avg"]
)
```

### Handle Missing Values

```python
# Strategy 1: Fill with statistics
df = df.fillna({"amount": df.select(mean("amount")).collect()[0][0]})

# Strategy 2: Create indicator
df = df.withColumn("amount_missing", col("amount").isNull().cast("int"))
df = df.fillna({"amount": 0})

# Strategy 3: Forward fill (for time series)
window = Window.partitionBy("customer_id").orderBy("timestamp").rowsBetween(Window.unboundedPreceding, 0)
df = df.withColumn("amount_filled", last("amount", ignorenulls=True).over(window))
```

---

## 📚 Related Documentation

- [Feature Store Setup](feature-store-setup.md)
- [MLOps Pipeline](mlops-pipeline.md)

---

*Last Updated: January 2025*
