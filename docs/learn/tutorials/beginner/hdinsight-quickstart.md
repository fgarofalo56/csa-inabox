---
title: "Azure HDInsight Quickstart"
description: "__Get started with Azure HDInsight. Learn to create Hadoop clusters and run big data workloads on Azure.__"
tags:
  - tutorials
  - beginner
---
# 🐘 Azure HDInsight Quickstart

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Level](https://img.shields.io/badge/Level-Beginner-green)
![Duration](https://img.shields.io/badge/Duration-45--60_minutes-blue)

__Get started with Azure HDInsight. Learn to create Hadoop clusters and run big data workloads on Azure.__

## 🎯 Learning Objectives

After completing this quickstart, you will be able to:

- Understand what Azure HDInsight is and its capabilities
- Create an HDInsight cluster with Hadoop
- Upload data to cluster storage
- Run MapReduce and Hive jobs
- Query data with HiveQL
- Monitor cluster performance

## 📋 Prerequisites

- [ ] __Azure subscription__ - [Create free account](https://azure.microsoft.com/free/)
- [ ] __Azure Storage account__ - [Create one](adls-gen2-quickstart.md)
- [ ] __Basic SQL knowledge__ - Understanding of SELECT, WHERE, JOIN
- [ ] __SSH client__ (optional) - For cluster access

## 🔍 What is Azure HDInsight?

Azure HDInsight is a fully managed, cloud-based service for open-source analytics frameworks:

- __Hadoop__ - Batch processing with MapReduce
- __Spark__ - Fast in-memory processing
- __HBase__ - NoSQL database
- __Kafka__ - Event streaming
- __Interactive Query__ - Interactive Hive (LLAP)

### __Key Features__

✅ Fully managed Hadoop clusters
✅ Enterprise-grade security
✅ Integration with Azure services
✅ Cost-effective with auto-scaling
✅ Multiple frameworks support

### __When to Use HDInsight__

✅ __Good For:__

- Migrating on-premises Hadoop workloads
- Batch ETL processing
- Log and event analytics
- Data warehousing
- Machine learning at scale

❌ __Consider Alternatives For:__

- Real-time analytics (use Databricks or Synapse)
- Small datasets (use Synapse Serverless)
- Managed notebooks (use Databricks)

## 🚀 Step 1: Create HDInsight Cluster

### __Using Azure Portal__

1. __Navigate to Azure Portal__
   - Go to [portal.azure.com](https://portal.azure.com)
   - Click "Create a resource"
   - Search for "HDInsight"
   - Click "Create"

2. __Configure Basics__
   - __Subscription__: Select subscription
   - __Resource Group__: Create "rg-hdinsight-quickstart"
   - __Cluster Name__: "hdinsight-quickstart-[yourname]"
   - __Region__: Select nearest region
   - __Cluster Type__: Hadoop
   - __Version__: Latest (e.g., Hadoop 3.1.1)
   - __Tier__: Standard

3. __Configure Security + Networking__
   - __Cluster Login Username__: admin
   - __Cluster Login Password__: Create strong password
   - __SSH Username__: sshuser
   - __SSH Password__: Same or different password

4. __Configure Storage__
   - __Primary Storage Type__: Azure Storage or ADLS Gen2
   - __Select a Storage Account__: Choose existing or create new
   - __Container__: Create new "hdinsight"
   - __Filesystem__: "hdinsight" (for ADLS Gen2)

5. __Configure Scale__
   - __Head nodes__: 2 (default)
   - __Worker nodes__: 2 (minimum for quickstart)
   - __Node Size__: D13 v2 (or smaller for cost savings)

6. __Review and Create__
   - Click "Review + create"
   - Click "Create"
   - Wait 15-20 minutes for deployment

## 📂 Step 2: Upload Sample Data

### __Create Sample Data__

Create `sales.csv`:

```csv
order_id,product,category,amount,order_date
1001,Laptop,Electronics,1299.99,2024-01-15
1002,Chair,Furniture,249.99,2024-01-15
1003,Monitor,Electronics,399.99,2024-01-16
1004,Desk,Furniture,549.99,2024-01-16
1005,Keyboard,Electronics,89.99,2024-01-17
```

### __Upload to Cluster Storage__

```bash
# Using Azure Storage Explorer or Azure Portal
# 1. Navigate to storage account
# 2. Go to "hdinsight" container
# 3. Create folder "data"
# 4. Upload sales.csv to data/sales.csv
```

### __Using Azure CLI__

```bash
# Set variables
STORAGE_ACCOUNT="your-storage-account"
CONTAINER="hdinsight"

# Upload file
az storage blob upload \
  --account-name $STORAGE_ACCOUNT \
  --container-name $CONTAINER \
  --name data/sales.csv \
  --file sales.csv \
  --auth-mode login
```

## 🔍 Step 3: Create Hive Table

### __Access Hive View__

1. Navigate to HDInsight cluster in Azure Portal
2. Click "Cluster dashboards" → "Ambari home"
3. Login with cluster credentials
4. Click Hive View icon (9 squares grid)

### __Create External Table__

```sql
-- Create database
CREATE DATABASE IF NOT EXISTS sales_db;

USE sales_db;

-- Create external table
CREATE EXTERNAL TABLE sales (
    order_id INT,
    product STRING,
    category STRING,
    amount DECIMAL(10,2),
    order_date DATE
)
ROW FORMAT DELIMITED
FIELDS TERMINATED BY ','
STORED AS TEXTFILE
LOCATION 'wasb://hdinsight@your-storage-account.blob.core.windows.net/data/'
TBLPROPERTIES ("skip.header.line.count"="1");

-- Verify data loaded
SELECT * FROM sales LIMIT 10;
```

## 📊 Step 4: Query Data with HiveQL

### __Basic Queries__

```sql
-- Total sales
SELECT
    SUM(amount) as total_sales,
    COUNT(*) as order_count
FROM sales;
```

```sql
-- Sales by category
SELECT
    category,
    COUNT(*) as order_count,
    SUM(amount) as total_sales,
    AVG(amount) as avg_order_value
FROM sales
GROUP BY category
ORDER BY total_sales DESC;
```

```sql
-- Top products
SELECT
    product,
    SUM(amount) as revenue
FROM sales
GROUP BY product
ORDER BY revenue DESC
LIMIT 5;
```

### __Advanced Analysis__

```sql
-- Daily sales with running total
SELECT
    order_date,
    SUM(amount) as daily_sales,
    SUM(SUM(amount)) OVER (
        ORDER BY order_date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) as running_total
FROM sales
GROUP BY order_date
ORDER BY order_date;
```

## 💻 Step 5: Run MapReduce Job (Optional)

### __Word Count Example__

```bash
# SSH into cluster
ssh sshuser@your-cluster-name-ssh.azurehdinsight.net

# Run word count on sample data
hadoop jar \
  /usr/hdp/current/hadoop-mapreduce-client/hadoop-mapreduce-examples.jar \
  wordcount \
  wasb:///example/data/gutenberg/davinci.txt \
  wasb:///example/data/WordCountOutput

# View results
hdfs dfs -cat /example/data/WordCountOutput/part-r-00000
```

## 🎯 Step 6: Create Managed Table

```sql
-- Create managed table for better performance
CREATE TABLE sales_managed
STORED AS ORC
AS
SELECT * FROM sales;

-- Query managed table (faster)
SELECT * FROM sales_managed;
```

## 📈 Step 7: Monitor Cluster

### __Ambari Dashboard__

1. Navigate to cluster → Ambari home
2. View dashboard metrics:
   - CPU usage
   - Memory usage
   - Disk I/O
   - YARN applications

### __YARN Resource Manager__

1. Click "YARN" in left menu
2. Click "Quick Links" → "Resource Manager UI"
3. View running applications
4. Check job history

## ⚡ Performance Optimization

### __Optimize Table Format__

```sql
-- Use ORC format for better performance
CREATE TABLE sales_orc
STORED AS ORC
TBLPROPERTIES ("orc.compress"="SNAPPY")
AS SELECT * FROM sales;
```

### __Partitioning__

```sql
-- Partition by date for better query performance
CREATE TABLE sales_partitioned (
    order_id INT,
    product STRING,
    category STRING,
    amount DECIMAL(10,2)
)
PARTITIONED BY (order_date DATE)
STORED AS ORC;

-- Insert data
INSERT INTO sales_partitioned PARTITION (order_date)
SELECT order_id, product, category, amount, order_date
FROM sales;
```

### __Enable Compression__

```sql
-- Enable compression for better storage
SET hive.exec.compress.output=true;
SET mapred.output.compression.codec=org.apache.hadoop.io.compress.SnappyCodec;
```

## 🔧 Troubleshooting

### __Common Issues__

__Cannot Access Data__

- ✅ Verify storage account connection
- ✅ Check firewall rules
- ✅ Ensure correct path format (wasb:// or abfs://)

__Query Fails with "Out of Memory"__

- ✅ Increase node size
- ✅ Add more worker nodes
- ✅ Optimize query (use filters)
- ✅ Use partitioning

__Cluster Creation Fails__

- ✅ Check subscription quotas
- ✅ Verify VM availability in region
- ✅ Ensure storage account accessible

__Slow Performance__

- ✅ Use ORC format
- ✅ Partition tables
- ✅ Increase cluster size
- ✅ Enable vectorization

## 🎓 Next Steps

### __Beginner Practice__

- [ ] Load your own data
- [ ] Create multiple tables
- [ ] Join tables in queries
- [ ] Export results to storage

### __Intermediate Topics__

- [ ] [HDInsight Spark](../intermediate/hdinsight-spark.md)
- [ ] [HDInsight HBase](../advanced/hdinsight-hbase.md)
- [ ] Schedule jobs with Azure Data Factory
- [ ] Implement security with ESP

### __Advanced Topics__

- [ ] [Hadoop Migration](../advanced/hadoop-migration-workshop.md)
- [ ] [Kafka Streaming](../advanced/hdinsight-kafka-streaming.md)
- [ ] Custom scripts and actions
- [ ] Multi-cluster architectures

## 📚 Additional Resources

### __Documentation__

- [HDInsight Overview](https://learn.microsoft.com/azure/hdinsight/)
- [Hive on HDInsight](https://learn.microsoft.com/azure/hdinsight/hadoop/hdinsight-use-hive)
- [Best Practices](https://learn.microsoft.com/azure/hdinsight/hdinsight-hadoop-provision-linux-clusters)

### __Next Tutorials__

- [HDInsight Hadoop Deep Dive](hdinsight-hadoop.md)
- [Data Engineer Path](../learning-paths/data-engineer-path.md)

## 🧹 Cleanup

To avoid charges:

```bash
# Delete resource group
az group delete --name rg-hdinsight-quickstart --yes --no-wait
```

> **💰 Cost Tip:** HDInsight clusters incur charges while running. Delete when not in use!

## 🎉 Congratulations!

You've successfully:

✅ Created HDInsight Hadoop cluster
✅ Uploaded and queried data
✅ Used Hive for SQL-like analysis
✅ Optimized tables for performance
✅ Monitored cluster resources

Ready for enterprise big data processing!

---

*Last Updated: January 2025*
*Tutorial Version: 1.0*
