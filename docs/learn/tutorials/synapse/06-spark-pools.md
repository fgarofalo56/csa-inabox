---
title: "Tutorial 6: Spark Pool Configuration"
description: "__Configure and optimize Apache Spark pools for performance and cost-efficiency. Learn pool sizing, auto-scaling, package management, and performance tuning.__"
tags:
  - tutorials
  - synapse
---
# 🔥 Tutorial 6: Spark Pool Configuration

![Tutorial](https://img.shields.io/badge/Tutorial-06_Spark_Pools-blue)
![Duration](https://img.shields.io/badge/Duration-30_minutes-green)
![Level](https://img.shields.io/badge/Level-Intermediate-yellow)

__Configure and optimize Apache Spark pools for performance and cost-efficiency. Learn pool sizing, auto-scaling, package management, and performance tuning.__

## 🎯 Learning Objectives

- ✅ __Create Spark pools__ with optimal configurations
- ✅ __Implement auto-scaling__ and auto-pause policies
- ✅ __Manage Python/Scala packages__ and library dependencies
- ✅ __Tune Spark performance__ parameters
- ✅ __Monitor resource utilization__ and optimize costs

## ⏱️ Time Estimate: 30 minutes

## 📋 Prerequisites

- [x] [Tutorial 1: Environment Setup](01-environment-setup.md)
- [x] [Tutorial 2: Workspace Basics](02-workspace-basics.md)

## 🏗️ Step 1: Create Production Spark Pool

```powershell
$config = Get-Content "workspace-config.json" | ConvertFrom-Json

# Create medium-sized Spark pool for production workloads
az synapse spark pool create `
  --name "sparkmedium" `
  --workspace-name $config.WorkspaceName `
  --resource-group $config.ResourceGroup `
  --spark-version "3.4" `
  --node-count 5 `
  --node-size Medium `
  --node-size-family MemoryOptimized `
  --enable-auto-scale true `
  --min-node-count 3 `
  --max-node-count 10 `
  --enable-auto-pause true `
  --delay 15 `
  --enable-dynamic-executor-allocation true `
  --tags Environment=Production Workload=Analytics

Write-Host "✅ Production Spark pool created" -ForegroundColor Green
```

## ⚙️ Step 2: Configure Spark Settings

### __2.1 Spark Configuration File__

```python
# spark-defaults.conf
spark.dynamicAllocation.enabled true
spark.dynamicAllocation.minExecutors 2
spark.dynamicAllocation.maxExecutors 10
spark.sql.shuffle.partitions 200
spark.sql.adaptive.enabled true
spark.sql.adaptive.coalescePartitions.enabled true
spark.sql.files.maxPartitionBytes 134217728
spark.speculation true
spark.sql.parquet.compression.codec snappy
spark.eventLog.enabled true
```

### __2.2 Apply Configuration__

```powershell
# Upload Spark configuration
az storage blob upload `
  --account-name $config.StorageAccount `
  --container-name "synapsefs" `
  --name "spark-config/spark-defaults.conf" `
  --file "spark-defaults.conf" `
  --auth-mode login

Write-Host "✅ Spark configuration uploaded" -ForegroundColor Green
```

## 📦 Step 3: Package Management

### __3.1 Create Requirements File__

```text
# requirements.txt
pandas==2.1.0
numpy==1.25.0
delta-spark==3.0.0
azure-storage-blob==12.19.0
pyarrow==13.0.0
matplotlib==3.8.0
scikit-learn==1.3.0
```

### __3.2 Install Packages__

```powershell
# Upload requirements.txt
az storage blob upload `
  --account-name $config.StorageAccount `
  --container-name "synapsefs" `
  --name "spark-config/requirements.txt" `
  --file "requirements.txt" `
  --auth-mode login

# Update Spark pool to use requirements
az synapse spark pool update `
  --name "sparkmedium" `
  --workspace-name $config.WorkspaceName `
  --resource-group $config.ResourceGroup `
  --library-requirements "requirements.txt"

Write-Host "✅ Package requirements configured" -ForegroundColor Green
```

## 🎯 Step 4: Performance Tuning

### __4.1 Optimize for Different Workloads__

**ETL Workloads**:

```python
spark.conf.set("spark.sql.shuffle.partitions", "200")
spark.conf.set("spark.sql.adaptive.enabled", "true")
spark.conf.set("spark.sql.adaptive.coalescePartitions.enabled", "true")
```

**Machine Learning**:

```python
spark.conf.set("spark.executor.memory", "8g")
spark.conf.set("spark.executor.cores", "4")
spark.conf.set("spark.python.worker.memory", "2g")
```

**Streaming**:

```python
spark.conf.set("spark.streaming.backpressure.enabled", "true")
spark.conf.set("spark.streaming.receiver.maxRate", "10000")
```

### __4.2 Memory Management__

```python
# Optimal memory configuration
spark.conf.set("spark.executor.memoryOverhead", "2g")
spark.conf.set("spark.memory.fraction", "0.8")
spark.conf.set("spark.memory.storageFraction", "0.3")
```

## 📊 Step 5: Monitor Performance

```sql
-- Query Spark application metrics
SELECT
    application_id,
    application_name,
    start_time,
    end_time,
    DATEDIFF(second, start_time, end_time) as duration_seconds,
    executor_count,
    executor_cores_total,
    executor_memory_total_gb
FROM monitoring.spark_applications
WHERE start_time >= DATEADD(day, -7, GETDATE())
ORDER BY start_time DESC;
```

## ✅ Validation

```powershell
# Verify Spark pool configuration
az synapse spark pool show `
  --name "sparkmedium" `
  --workspace-name $config.WorkspaceName `
  --resource-group $config.ResourceGroup `
  --query "{Name:name, NodeSize:nodeSize, MinNodes:autoScale.minNodeCount, MaxNodes:autoScale.maxNodeCount, AutoPause:autoPause.enabled}" `
  --output table

Write-Host "✅ Spark pool validated" -ForegroundColor Green
```

## 💡 Best Practices

- ✅ Enable auto-pause with 15-minute delay
- ✅ Use auto-scaling for variable workloads
- ✅ Pin library versions in requirements.txt
- ✅ Enable adaptive query execution
- ✅ Monitor and right-size node count/size

## 🚀 What's Next?

**Continue to Tutorial 7**: [PySpark Data Processing](07-pyspark-processing.md)

---

__Tutorial Progress__: 6 of 14 completed
__Next__: [07. PySpark Processing →](07-pyspark-processing.md)
