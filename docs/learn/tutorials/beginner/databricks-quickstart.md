---
title: "Azure Databricks Quickstart"
description: "__Get started with Azure Databricks in under an hour. Learn to create a workspace, run Spark notebooks, and process data at scale.__"
tags:
  - tutorials
  - beginner
---
# 🔥 Azure Databricks Quickstart

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Level](https://img.shields.io/badge/Level-Beginner-green)
![Duration](https://img.shields.io/badge/Duration-45--60_minutes-blue)

__Get started with Azure Databricks in under an hour. Learn to create a workspace, run Spark notebooks, and process data at scale.__

## 🎯 Learning Objectives

After completing this quickstart, you will be able to:

- Understand what Azure Databricks is and its capabilities
- Create a Databricks workspace
- Launch and configure a Spark cluster
- Create and run notebooks with PySpark
- Load and analyze data from ADLS Gen2
- Visualize results with built-in charts

## 📋 Prerequisites

Before starting, ensure you have:

- [ ] __Azure subscription__ - [Create free account](https://azure.microsoft.com/free/)
- [ ] __Azure Portal access__ - [portal.azure.com](https://portal.azure.com)
- [ ] __Basic Python knowledge__ - Understanding of variables, loops, functions
- [ ] __ADLS Gen2 account__ (optional) - [Create one](adls-gen2-quickstart.md) or use sample data

## 🔍 What is Azure Databricks?

Azure Databricks is an Apache Spark-based analytics platform optimized for Azure, providing:

- __Unified analytics__ - Data engineering, data science, and ML
- __Collaborative notebooks__ - Interactive development environment
- __Auto-scaling clusters__ - Elastic compute resources
- __Delta Lake__ - Reliable data lakes with ACID transactions
- __Integration__ - Seamless Azure service connectivity

### __Key Concepts__

- __Workspace__: Environment for notebooks, clusters, and data
- __Cluster__: Set of computation resources (VMs)
- __Notebook__: Interactive document with code and visualizations
- __Delta Lake__: Storage layer with reliability and performance
- __Job__: Scheduled execution of notebooks or JARs

### __When to Use Databricks__

✅ __Good For:__

- Big data processing (TB-PB scale)
- ETL/ELT pipelines
- Machine learning workflows
- Real-time streaming analytics
- Collaborative data science

❌ __Not Ideal For:__

- Small datasets (<1GB)
- Simple SQL queries (use Synapse Serverless)
- Real-time low-latency apps (use Event Hubs)

## 🚀 Step 1: Create Databricks Workspace

### __Using Azure Portal__

1. __Navigate to Azure Portal__
   - Go to [portal.azure.com](https://portal.azure.com)
   - Click "Create a resource"
   - Search for "Azure Databricks"
   - Click "Create"

2. __Configure Basics__
   - __Subscription__: Select your subscription
   - __Resource Group__: Create new "rg-databricks-quickstart"
   - __Workspace Name__: "databricks-quickstart-[yourname]"
   - __Region__: Select nearest region
   - __Pricing Tier__: Trial (Premium - 14 days free) or Standard

3. __Networking__ (Optional)
   - Keep default public network access for quickstart

4. __Review and Create__
   - Click "Review + create"
   - Click "Create"
   - Wait 3-5 minutes for deployment

### __Using Azure CLI__

```bash
# Set variables
RESOURCE_GROUP="rg-databricks-quickstart"
LOCATION="eastus"
WORKSPACE_NAME="databricks-quickstart-$RANDOM"

# Create resource group
az group create \
  --name $RESOURCE_GROUP \
  --location $LOCATION

# Create Databricks workspace
az databricks workspace create \
  --resource-group $RESOURCE_GROUP \
  --name $WORKSPACE_NAME \
  --location $LOCATION \
  --sku trial

echo "Workspace: $WORKSPACE_NAME"
```

## 🖥️ Step 2: Launch Workspace

1. __Navigate to Workspace__
   - Go to your Databricks workspace in Azure Portal
   - Click "Launch Workspace"
   - You'll be redirected to Databricks portal

2. __First Time Setup__
   - May need to sign in with Azure credentials
   - Accept terms if prompted

## ⚙️ Step 3: Create Cluster

### __Create Compute Cluster__

1. __Navigate to Compute__
   - Click "Compute" icon in left sidebar
   - Click "Create Cluster"

2. __Configure Cluster__
   - __Cluster Name__: "quickstart-cluster"
   - __Cluster Mode__: Single Node (for quickstart/development)
   - __Databricks Runtime__: Latest LTS version (e.g., 12.2 LTS)
   - __Node Type__: Standard_DS3_v2 (or smallest available)
   - __Terminate after__: 30 minutes of inactivity

3. __Create Cluster__
   - Click "Create Cluster"
   - Wait 3-5 minutes for cluster to start
   - Status changes to "Running" when ready

> **💡 Tip:** Single Node mode is cheaper for learning. Use Standard mode for production workloads.

## 📓 Step 4: Create Your First Notebook

### __Create Notebook__

1. __Navigate to Workspace__
   - Click "Workspace" icon in left sidebar
   - Click your username folder
   - Click dropdown arrow > "Create" > "Notebook"

2. __Configure Notebook__
   - __Name__: "Quickstart Tutorial"
   - __Default Language__: Python
   - __Cluster__: Select "quickstart-cluster"
   - Click "Create"

### __Run Your First Code__

```python
# Cell 1: Hello Databricks!
print("🔥 Hello from Databricks!")
print(f"Spark version: {spark.version}")
print(f"Running on cluster: {spark.conf.get('spark.databricks.clusterUsageTags.clusterName')}")
```

Click "Run Cell" or press `Shift+Enter`

## 📊 Step 5: Work with DataFrames

### __Create Sample Data__

```python
# Cell 2: Create sample sales data
from pyspark.sql import Row
from datetime import datetime, timedelta

# Generate sample data
sales_data = [
    Row(order_id=1001, customer_id="C101", product="Laptop", amount=1299.99, order_date="2024-01-15"),
    Row(order_id=1002, customer_id="C102", product="Chair", amount=249.99, order_date="2024-01-15"),
    Row(order_id=1003, customer_id="C101", product="Monitor", amount=399.99, order_date="2024-01-16"),
    Row(order_id=1004, customer_id="C103", product="Desk", amount=549.99, order_date="2024-01-16"),
    Row(order_id=1005, customer_id="C102", product="Keyboard", amount=89.99, order_date="2024-01-17"),
    Row(order_id=1006, customer_id="C104", product="Mouse", amount=39.99, order_date="2024-01-17"),
    Row(order_id=1007, customer_id="C101", product="Lamp", amount=79.99, order_date="2024-01-18"),
    Row(order_id=1008, customer_id="C105", product="Tablet", amount=599.99, order_date="2024-01-18"),
]

# Create DataFrame
df = spark.createDataFrame(sales_data)

# Display DataFrame
display(df)
```

### __Basic DataFrame Operations__

```python
# Cell 3: Explore the data
print(f"Total orders: {df.count()}")
print(f"\nColumns: {df.columns}")
print(f"\nSchema:")
df.printSchema()
```

```python
# Cell 4: Filter and aggregate
from pyspark.sql.functions import sum, avg, count

# Calculate total sales
total_sales = df.select(sum("amount")).collect()[0][0]
print(f"Total sales: ${total_sales:,.2f}")

# Sales by customer
customer_sales = df.groupBy("customer_id") \
    .agg(
        count("order_id").alias("order_count"),
        sum("amount").alias("total_spent")
    ) \
    .orderBy("total_spent", ascending=False)

display(customer_sales)
```

## 📈 Step 6: Visualizations

### __Create Charts__

```python
# Cell 5: Sales by customer
customer_sales = df.groupBy("customer_id") \
    .agg(sum("amount").alias("total_sales")) \
    .orderBy("total_sales", ascending=False)

display(customer_sales)
```

After running the cell:

1. Click the chart icon below results
2. Select "Bar Chart"
3. Configure:
   - __Keys__: customer_id
   - __Values__: total_sales
4. Click "Apply"

## 💾 Step 7: Write Data to Delta Lake

### __Save as Delta Table__

```python
# Cell 6: Write to Delta Lake
# Delta Lake provides ACID transactions and time travel

# Write DataFrame to Delta table
df.write \
    .format("delta") \
    .mode("overwrite") \
    .saveAsTable("sales_data")

print("✅ Data saved to Delta table: sales_data")
```

### __Read from Delta Table__

```python
# Cell 7: Read from Delta table
sales_df = spark.table("sales_data")

print(f"Loaded {sales_df.count()} rows from Delta table")
display(sales_df)
```

## 🔗 Step 8: Connect to ADLS Gen2 (Optional)

If you have an ADLS Gen2 account:

```python
# Cell 8: Configure ADLS Gen2 access
storage_account = "your-storage-account"
container = "data"

# Set Spark configuration for storage access
spark.conf.set(
    f"fs.azure.account.key.{storage_account}.dfs.core.windows.net",
    "your-storage-account-key"  # Get from Azure Portal > Access Keys
)

# Read CSV from ADLS Gen2
adls_path = f"abfss://{container}@{storage_account}.dfs.core.windows.net/sales.csv"

df_adls = spark.read \
    .format("csv") \
    .option("header", "true") \
    .option("inferSchema", "true") \
    .load(adls_path)

display(df_adls)
```

### __Better: Use Service Principal__

```python
# Cell 9: Service Principal authentication (recommended for production)
service_principal_id = "your-service-principal-id"
service_principal_secret = "your-service-principal-secret"
tenant_id = "your-tenant-id"

spark.conf.set(
    f"fs.azure.account.auth.type.{storage_account}.dfs.core.windows.net",
    "OAuth"
)
spark.conf.set(
    f"fs.azure.account.oauth.provider.type.{storage_account}.dfs.core.windows.net",
    "org.apache.hadoop.fs.azurebfs.oauth2.ClientCredsTokenProvider"
)
spark.conf.set(
    f"fs.azure.account.oauth2.client.id.{storage_account}.dfs.core.windows.net",
    service_principal_id
)
spark.conf.set(
    f"fs.azure.account.oauth2.client.secret.{storage_account}.dfs.core.windows.net",
    service_principal_secret
)
spark.conf.set(
    f"fs.azure.account.oauth2.client.endpoint.{storage_account}.dfs.core.windows.net",
    f"https://login.microsoftonline.com/{tenant_id}/oauth2/token"
)
```

## 🎯 Useful Databricks Features

### __Magic Commands__

```python
# %python - Run Python code (default)
# %sql - Run SQL queries
# %scala - Run Scala code
# %r - Run R code
# %sh - Run shell commands
# %fs - File system commands
# %md - Markdown for documentation
```

### __File System Commands__

```python
# Cell 10: Explore DBFS (Databricks File System)
%fs ls /

# List Delta tables
%fs ls /user/hive/warehouse/

# Create directory
%fs mkdirs /tmp/mydata
```

### __SQL Queries__

```python
# Cell 11: Query with SQL
%sql
SELECT
    customer_id,
    COUNT(*) as order_count,
    SUM(amount) as total_spent
FROM sales_data
GROUP BY customer_id
ORDER BY total_spent DESC
```

## 💡 Best Practices

### __Cluster Management__

1. __Use auto-termination__ - Set 30-60 minutes for dev clusters
2. __Right-size clusters__ - Start small, scale up if needed
3. __Use spot instances__ - 60-80% cost savings for fault-tolerant workloads
4. __Pools__ - Pre-warmed VMs for faster cluster starts

### __Notebook Organization__

1. __Use markdown__ - Document your analysis
2. __Cell structure__ - One logical operation per cell
3. __Parameters__ - Use widgets for parameterized notebooks
4. __Version control__ - Integrate with Git repos

### __Performance Tips__

1. __Cache DataFrames__ - `df.cache()` for repeated operations
2. __Partition data__ - Use `partitionBy()` for large datasets
3. __Optimize file sizes__ - 128MB-1GB per file
4. __Use Delta Lake__ - Better performance than Parquet

## 🔧 Troubleshooting

### __Common Issues__

__Cluster won't start__

- ✅ Check quota in subscription
- ✅ Verify VM type available in region
- ✅ Check networking/firewall rules

__Out of memory errors__

- ✅ Increase worker node size
- ✅ Add more workers
- ✅ Optimize DataFrame operations
- ✅ Use broadcast joins for small tables

__Slow performance__

- ✅ Check data skew
- ✅ Optimize partition count
- ✅ Use Delta Lake optimizations
- ✅ Enable adaptive query execution

__Cannot access storage__

- ✅ Verify credentials
- ✅ Check firewall rules
- ✅ Ensure managed identity has permissions

## 🎓 Next Steps

### __Beginner Practice__

- [ ] Load your own CSV data
- [ ] Create more complex SQL queries
- [ ] Build visualizations
- [ ] Schedule a notebook as a job

### __Intermediate Challenges__

- [ ] Implement ETL pipeline
- [ ] Use Delta Lake time travel
- [ ] Create parameterized widgets
- [ ] Integrate with Azure Data Factory

### __Advanced Topics__

- [ ] Build ML models with MLflow
- [ ] Implement streaming with Structured Streaming
- [ ] Use Auto Loader for incremental data
- [ ] Set up CI/CD with Azure DevOps

## 📚 Additional Resources

### __Documentation__

- [Databricks Overview](https://learn.microsoft.com/azure/databricks/introduction/)
- [PySpark API Reference](https://spark.apache.org/docs/latest/api/python/)
- [Delta Lake Guide](https://docs.delta.io/latest/index.html)

### __Next Tutorials__

- [Databricks Notebooks](databricks-notebooks.md) - Deep dive into notebooks
- [Delta Lake Basics](delta-lake-basics.md) - Learn Delta Lake features
- [Data Engineer Path](../learning-paths/data-engineer-path.md)

### __Training__

- [Databricks Academy](https://academy.databricks.com/) - Free courses
- [Databricks Community Edition](https://community.cloud.databricks.com/) - Free tier
- [Microsoft Learn Databricks](https://learn.microsoft.com/training/browse/?products=azure-databricks)

## 🧹 Cleanup

To avoid Azure charges:

### __Delete Cluster__

1. Navigate to "Compute"
2. Click cluster name
3. Click "Terminate"
4. Click "Confirm"

### __Delete Workspace__

```bash
# Delete resource group
az group delete --name rg-databricks-quickstart --yes --no-wait
```

Or use Azure Portal:

1. Navigate to Resource Groups
2. Select "rg-databricks-quickstart"
3. Click "Delete resource group"
4. Type resource group name to confirm
5. Click "Delete"

## 🎉 Congratulations!

You've successfully:

✅ Created Azure Databricks workspace
✅ Launched and configured a Spark cluster
✅ Created and ran interactive notebooks
✅ Processed data with PySpark
✅ Saved data to Delta Lake
✅ Built visualizations

You're ready to build big data solutions with Azure Databricks!

---

__Next Recommended Tutorial:__ [Databricks Notebooks](databricks-notebooks.md) for advanced notebook techniques

---

*Last Updated: January 2025*
*Tutorial Version: 1.0*
*Tested with: Databricks Runtime 12.2 LTS*
