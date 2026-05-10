---
title: "Delta Lake Basics"
description: "__Learn Delta Lake fundamentals. Understand ACID transactions, time travel, and schema evolution for reliable data lakes.__"
tags:
  - tutorials
  - beginner
---
# 🔺 Delta Lake Basics

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Level](https://img.shields.io/badge/Level-Beginner-green)
![Duration](https://img.shields.io/badge/Duration-40--50_minutes-blue)

__Learn Delta Lake fundamentals. Understand ACID transactions, time travel, and schema evolution for reliable data lakes.__

## 🎯 Learning Objectives

After completing this tutorial, you will be able to:

- Understand what Delta Lake is and its benefits
- Create and manage Delta tables
- Perform ACID transactions on data lakes
- Use time travel to query historical data
- Implement schema evolution
- Optimize Delta tables for performance

## 📋 Prerequisites

- [ ] __Databricks workspace__ or __Synapse Spark pool__
- [ ] __Basic Spark knowledge__ - DataFrames and SQL
- [ ] __ADLS Gen2 account__ (optional)

## 🔍 What is Delta Lake?

Delta Lake is an open-source storage layer that brings reliability to data lakes:

- __ACID transactions__ - Atomic, Consistent, Isolated, Durable
- __Time travel__ - Query historical versions
- __Schema enforcement__ - Prevent bad data
- __Scalable metadata__ - Handle billions of files
- __Unified batch and streaming__ - One source of truth

### __Problems Delta Lake Solves__

❌ __Without Delta Lake:__

- Failed writes leave corrupt data
- No way to roll back mistakes
- Cannot see historical data
- Schema changes break pipelines
- Slow queries on small files

✅ __With Delta Lake:__

- ACID transactions guarantee consistency
- Time travel for auditing and rollback
- Schema evolution without breaking changes
- Automatic file compaction
- Faster queries with statistics

## 🚀 Step 1: Create Delta Table

### __From DataFrame__

```python
# Cell 1: Create sample data
from pyspark.sql import Row
from datetime import datetime

# Sample sales data
sales_data = [
    Row(order_id=1001, customer="John Doe", product="Laptop", amount=1299.99, date="2024-01-15"),
    Row(order_id=1002, customer="Jane Smith", product="Chair", amount=249.99, date="2024-01-15"),
    Row(order_id=1003, customer="John Doe", product="Monitor", amount=399.99, date="2024-01-16"),
    Row(order_id=1004, customer="Bob Johnson", product="Desk", amount=549.99, date="2024-01-16"),
]

df = spark.createDataFrame(sales_data)

# Write as Delta table
df.write.format("delta").mode("overwrite").save("/tmp/delta/sales")

print("✅ Delta table created at /tmp/delta/sales")
```

### __Create Managed Table__

```python
# Cell 2: Create managed Delta table
df.write.format("delta") \
    .mode("overwrite") \
    .saveAsTable("sales")

print("✅ Managed Delta table 'sales' created")
```

### __From Existing Data__

```python
# Cell 3: Convert Parquet to Delta
# Assume you have existing Parquet files
parquet_path = "/mnt/data/parquet/sales"
delta_path = "/mnt/data/delta/sales"

# Read Parquet
df_parquet = spark.read.parquet(parquet_path)

# Write as Delta
df_parquet.write.format("delta").save(delta_path)

print("✅ Converted Parquet to Delta")
```

## 📖 Step 2: Read Delta Tables

### __Load Delta Table__

```python
# Cell 4: Read Delta table
from delta.tables import DeltaTable

# Read as DataFrame
df_sales = spark.read.format("delta").load("/tmp/delta/sales")

# Or read managed table
df_sales = spark.table("sales")

display(df_sales)
```

### __SQL Query__

```sql
-- Cell 5: Query with SQL
%sql
SELECT * FROM sales WHERE amount > 300
```

## ✏️ Step 3: Update and Delete (ACID)

### __Update Records__

```python
# Cell 6: Update specific records
from delta.tables import DeltaTable

# Get Delta table instance
delta_table = DeltaTable.forPath(spark, "/tmp/delta/sales")

# Update amount for specific order
delta_table.update(
    condition="order_id = 1001",
    set={"amount": "1199.99"}  # Price reduction
)

print("✅ Updated order 1001")
```

### __Delete Records__

```python
# Cell 7: Delete records
delta_table.delete("order_id = 1004")

print("✅ Deleted order 1004")
```

### __Conditional Updates__

```python
# Cell 8: Update with conditions
# Apply 10% discount to orders over $500
delta_table.update(
    condition="amount > 500",
    set={"amount": "amount * 0.9"}
)

print("✅ Applied discount to high-value orders")
```

## 🔄 Step 4: Merge (Upsert)

Merge is powerful for handling updates and inserts in one operation.

```python
# Cell 9: Prepare updates and new records
updates = [
    Row(order_id=1001, customer="John Doe", product="Laptop Pro", amount=1399.99, date="2024-01-17"),  # Update
    Row(order_id=1005, customer="Alice Brown", product="Tablet", amount=599.99, date="2024-01-17"),  # Insert
]

updates_df = spark.createDataFrame(updates)

# Perform merge (upsert)
delta_table.alias("target").merge(
    updates_df.alias("source"),
    "target.order_id = source.order_id"
).whenMatchedUpdate(
    set={
        "product": "source.product",
        "amount": "source.amount",
        "date": "source.date"
    }
).whenNotMatchedInsert(
    values={
        "order_id": "source.order_id",
        "customer": "source.customer",
        "product": "source.product",
        "amount": "source.amount",
        "date": "source.date"
    }
).execute()

print("✅ Merge completed: 1 updated, 1 inserted")
```

## ⏰ Step 5: Time Travel

Query historical versions of your data!

### __View History__

```python
# Cell 10: Show table history
history = delta_table.history()
display(history.select("version", "timestamp", "operation", "operationMetrics"))
```

### __Query by Version__

```python
# Cell 11: Query specific version
df_version_0 = spark.read.format("delta") \
    .option("versionAsOf", 0) \
    .load("/tmp/delta/sales")

print("Original data (version 0):")
display(df_version_0)
```

### __Query by Timestamp__

```python
# Cell 12: Query by timestamp
from datetime import datetime, timedelta

# Query data as it was yesterday
yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

df_yesterday = spark.read.format("delta") \
    .option("timestampAsOf", yesterday) \
    .load("/tmp/delta/sales")

display(df_yesterday)
```

### __Restore Previous Version__

```python
# Cell 13: Rollback to previous version
delta_table.restoreToVersion(0)

print("✅ Restored to version 0")
```

## 🎨 Step 6: Schema Evolution

### __Add New Columns__

```python
# Cell 14: Add columns with mergeSchema
new_data = [
    Row(order_id=1006, customer="Eve Wilson", product="Phone", amount=899.99,
        date="2024-01-18", region="West", payment_method="Credit")  # New columns!
]

new_df = spark.createDataFrame(new_data)

# Merge schema automatically
new_df.write.format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \
    .save("/tmp/delta/sales")

print("✅ Added new columns: region, payment_method")
```

### __Schema Enforcement__

```python
# Cell 15: Schema validation prevents bad data
try:
    bad_data = [
        Row(order_id="ABC", customer="Test", amount="invalid")  # Wrong types
    ]
    bad_df = spark.createDataFrame(bad_data)
    bad_df.write.format("delta").mode("append").save("/tmp/delta/sales")
except Exception as e:
    print(f"❌ Schema enforcement prevented bad data: {str(e)}")
```

## ⚡ Step 7: Optimize Tables

### __Compact Small Files__

```python
# Cell 16: Optimize table
from delta.tables import DeltaTable

delta_table = DeltaTable.forPath(spark, "/tmp/delta/sales")

# Compact small files
delta_table.optimize().executeCompaction()

print("✅ Table optimized: Files compacted")
```

### __Z-Order Clustering__

```python
# Cell 17: Z-order for better filtering
# Improves performance for commonly filtered columns
delta_table.optimize().executeZOrderBy("customer", "date")

print("✅ Z-order applied on customer and date")
```

### __Vacuum Old Files__

```python
# Cell 18: Remove old file versions
# BE CAREFUL: Cannot time travel past vacuum!

# First, disable retention check (only for testing)
spark.conf.set("spark.databricks.delta.retentionDurationCheck.enabled", "false")

# Vacuum files older than 0 hours (remove all old versions)
delta_table.vacuum(0)  # Default is 7 days

print("✅ Old versions removed")

# Re-enable retention check
spark.conf.set("spark.databricks.delta.retentionDurationCheck.enabled", "true")
```

> **⚠️ Warning:** Vacuum permanently deletes old files. Time travel won't work for deleted versions!

## 📊 Step 8: Monitor Table Metrics

### __Describe Table__

```python
# Cell 19: Get table details
delta_table.detail().show()

# Key metrics
detail = delta_table.detail().collect()[0]
print(f"Number of files: {detail['numFiles']}")
print(f"Size in bytes: {detail['sizeInBytes']}")
print(f"Table format: {detail['format']}")
```

### __Table Statistics__

```sql
-- Cell 20: SQL table stats
%sql
DESCRIBE DETAIL delta.`/tmp/delta/sales`
```

## 💡 Best Practices

### __1. Partition Large Tables__

```python
# Cell 21: Partition by date
df.write.format("delta") \
    .partitionBy("date") \
    .save("/tmp/delta/sales_partitioned")

# Faster queries with partition pruning
df_filtered = spark.read.format("delta") \
    .load("/tmp/delta/sales_partitioned") \
    .where("date = '2024-01-15'")  # Only scans relevant partition
```

### __2. Use Constraints__

```sql
-- Cell 22: Add table constraints
%sql
ALTER TABLE sales ADD CONSTRAINT positive_amount CHECK (amount > 0);
ALTER TABLE sales ADD CONSTRAINT valid_order_id CHECK (order_id > 0);
```

### __3. Optimize Regularly__

```python
# Cell 23: Schedule optimization
# Run in job daily
def optimize_daily_tables():
    tables = ["sales", "customers", "products"]
    for table in tables:
        spark.sql(f"OPTIMIZE {table}")
        print(f"✅ Optimized {table}")

optimize_daily_tables()
```

### __4. Monitor Table Growth__

```python
# Cell 24: Track table size
def get_table_size(table_path):
    detail = DeltaTable.forPath(spark, table_path).detail().collect()[0]
    size_gb = detail['sizeInBytes'] / (1024**3)
    return size_gb

size = get_table_size("/tmp/delta/sales")
print(f"Table size: {size:.2f} GB")
```

## 🔧 Troubleshooting

### __Common Issues__

__ConcurrentAppendException__

- ✅ Expected for concurrent writes
- ✅ Delta automatically retries
- ✅ Use merge for updates, not overwrite

__AnalysisException: Path does not exist__

- ✅ Verify table path
- ✅ Check if table created
- ✅ Use correct format("delta")

__Schema mismatch__

- ✅ Use mergeSchema=true to add columns
- ✅ Use overwriteSchema=true to replace schema
- ✅ Check data types match

__Slow queries__

- ✅ Run OPTIMIZE
- ✅ Use Z-ORDER on filter columns
- ✅ Partition large tables
- ✅ Update statistics

## 🎓 Practice Exercises

### __Exercise 1: Build Change Data Capture (CDC)__

- [ ] Create sales table
- [ ] Simulate daily updates
- [ ] Track changes with versions
- [ ] Build change log query

### __Exercise 2: Implement SCD Type 2__

- [ ] Create customer dimension table
- [ ] Track historical changes
- [ ] Use merge for updates
- [ ] Query point-in-time data

### __Exercise 3: Optimize Large Dataset__

- [ ] Load 1M+ row dataset
- [ ] Partition by date
- [ ] Run OPTIMIZE and Z-ORDER
- [ ] Compare query performance

## 📚 Additional Resources

### __Documentation__

- [Delta Lake Documentation](https://docs.delta.io/)
- [Delta Lake on Databricks](https://learn.microsoft.com/azure/databricks/delta/)
- [Best Practices](https://learn.microsoft.com/azure/databricks/delta/best-practices)

### __Next Tutorials__

- [Delta Lake Deep Dive](../code-labs/delta-lake-deep-dive.md)
- [Data Lakehouse](../integration/data-lakehouse.md)
- [Data Engineer Path](../learning-paths/data-engineer-path.md)

### __Guides__

- [Delta Lake Optimization](../../best-practices/delta-lake-optimization.md)
- [Synapse Delta Lake](../../02-services/analytics-compute/azure-synapse/spark-pools/delta-lakehouse/README.md)

## 🎉 Summary

You've learned:

✅ Create and manage Delta tables
✅ ACID transactions (update, delete, merge)
✅ Time travel for historical queries
✅ Schema evolution
✅ Table optimization
✅ Best practices

Delta Lake brings database reliability to your data lake!

---

*Last Updated: January 2025*
*Tutorial Version: 1.0*
