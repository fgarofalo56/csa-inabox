---
title: "Spark on HDInsight"
description: "__Master Apache Spark on HDInsight. Learn in-memory processing, DataFrames, SQL, and streaming analytics.__"
tags:
  - tutorials
  - intermediate
---
# ⚡ Spark on HDInsight

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Level](https://img.shields.io/badge/Level-Intermediate-yellow)
![Duration](https://img.shields.io/badge/Duration-60--75_minutes-blue)

__Master Apache Spark on HDInsight. Learn in-memory processing, DataFrames, SQL, and streaming analytics.__

## 🎯 Learning Objectives

- Create HDInsight Spark cluster
- Work with Spark DataFrames and SQL
- Implement batch and streaming processing
- Optimize Spark jobs for performance
- Integrate with Azure services

## 📋 Prerequisites

- [ ] __Azure subscription__
- [ ] __HDInsight experience__ - [HDInsight Quickstart](../beginner/hdinsight-quickstart.md)
- [ ] __Python or Scala knowledge__
- [ ] __Understanding of distributed systems__

## 🚀 Step 1: Create Spark Cluster

```bash
# Azure CLI
az hdinsight create \
  --name spark-cluster-01 \
  --resource-group rg-hdinsight \
  --type spark \
  --component-version Spark=3.1 \
  --cluster-tier standard \
  --worker-node-count 2 \
  --storage-account mystorageaccount
```

## 📊 Step 2: Spark DataFrames

```python
# Create DataFrame from CSV
df = spark.read.csv(
    "wasb:///data/sales.csv",
    header=True,
    inferSchema=True
)

# Show DataFrame
df.show()

# DataFrame operations
df_filtered = df.filter(df.amount > 100)
df_grouped = df.groupBy("category").sum("amount")
```

## 🔥 Step 3: Spark SQL

```python
# Register temp view
df.createOrReplaceTempView("sales")

# SQL query
result = spark.sql("""
    SELECT
        category,
        COUNT(*) as orders,
        SUM(amount) as revenue
    FROM sales
    GROUP BY category
    ORDER BY revenue DESC
""")

result.show()
```

## 🌊 Step 4: Structured Streaming

```python
# Read stream from Event Hubs
stream_df = spark.readStream \
    .format("eventhubs") \
    .options(**ehConf) \
    .load()

# Process stream
query = stream_df \
    .groupBy("category") \
    .count() \
    .writeStream \
    .outputMode("complete") \
    .format("console") \
    .start()
```

## ⚡ Performance Optimization

- Cache frequently used DataFrames
- Partition data appropriately
- Use broadcast joins for small tables
- Configure executor memory and cores

## 📚 Next Steps

- [ML on Databricks](ml-databricks.md)
- [Spark SQL Tutorial](spark-sql-tutorial.md)

---

*Last Updated: January 2025*
