# 🎯 Spark Notebook Interactive Sandbox

![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)
![Type: Interactive](https://img.shields.io/badge/Type-Interactive-purple)
![Difficulty: Intermediate](https://img.shields.io/badge/Difficulty-Intermediate-yellow)

## 📋 Overview

A fully interactive Spark notebook environment for experimenting with PySpark, Scala, and SparkSQL. This sandbox provides a safe, isolated environment to learn Spark concepts, test code, and explore data processing patterns without affecting production resources.

**Duration:** Self-paced
**Format:** Live coding environment with pre-loaded datasets
**Prerequisites:** Basic Python or Scala knowledge

## 🎯 Learning Objectives

By using this interactive sandbox, you will:

- Write and execute PySpark code in a real Spark environment
- Understand DataFrame operations and transformations
- Practice data manipulation and aggregation techniques
- Learn Spark optimization strategies
- Experiment with different data formats (Parquet, Delta, CSV, JSON)
- Explore Spark SQL and DataFrame API equivalence

## 🚀 Prerequisites and Setup

### Access Requirements

- **Browser-Based:** Modern web browser with JavaScript enabled
- **No Installation:** Runs entirely in your browser
- **Sample Data:** Pre-loaded datasets available
- **Save Progress:** Optional account creation for saving work

### Environment Specifications

```yaml
spark_config:
  version: "3.4.0"
  scala_version: "2.12"
  python_version: "3.10"

resources:
  driver_memory: "4g"
  executor_memory: "4g"
  executor_cores: 2
  num_executors: 2

packages:
  - delta-core_2.12:2.4.0
  - azure-storage:8.6.6
  - mssql-jdbc:11.2.0
```

### Quick Start

```python
# Your first Spark code
# This runs immediately in the sandbox

from pyspark.sql import SparkSession
from pyspark.sql.functions import *

# Spark session is already initialized as 'spark'
print(f"Spark Version: {spark.version}")
print(f"Python Version: {sys.version}")

# Load sample data
df = spark.read.parquet("/samples/sales_data.parquet")
df.show(5)
```

## 🎮 Interactive Features

### Code Editor

```javascript
// Monaco Editor Configuration
const editorConfig = {
  language: 'python',
  theme: 'vs-dark',
  automaticLayout: true,
  minimap: { enabled: true },
  fontSize: 14,
  wordWrap: 'on',
  scrollBeyondLastLine: false,

  // IntelliSense configuration
  suggest: {
    snippetsPreventQuickSuggestions: false
  },

  // PySpark-specific features
  quickSuggestions: {
    other: true,
    comments: false,
    strings: true
  }
};

// Code completion for PySpark
const pysparkCompletions = [
  {
    label: 'read.parquet',
    insertText: 'spark.read.parquet("${1:path}")',
    documentation: 'Read Parquet file into DataFrame'
  },
  {
    label: 'groupBy.agg',
    insertText: 'groupBy("${1:column}").agg(${2:aggregation})',
    documentation: 'Group by column and aggregate'
  }
];
```

### Live Data Visualization

```python
# Built-in visualization
from pyspark.sql.functions import col, sum, count

# Sample sales analysis
sales_by_category = df.groupBy("category") \
    .agg(
        sum("revenue").alias("total_revenue"),
        count("*").alias("transaction_count")
    ) \
    .orderBy(col("total_revenue").desc())

# Display with built-in charting
display(sales_by_category)
# Automatically generates: bar chart, line chart, pie chart, table

# Custom visualization with matplotlib
import matplotlib.pyplot as plt

data = sales_by_category.toPandas()
plt.figure(figsize=(12, 6))
plt.bar(data['category'], data['total_revenue'])
plt.xlabel('Category')
plt.ylabel('Revenue')
plt.title('Revenue by Category')
plt.xticks(rotation=45)
plt.tight_layout()
plt.show()
```

## 📚 Pre-Loaded Sample Datasets

### Available Datasets

```python
# Dataset catalog
datasets = {
    "sales": {
        "path": "/samples/sales_data.parquet",
        "format": "parquet",
        "rows": 1000000,
        "schema": """
            transaction_id: string
            timestamp: timestamp
            customer_id: string
            product_id: string
            category: string
            quantity: integer
            price: decimal(10,2)
            revenue: decimal(10,2)
            region: string
        """
    },

    "customers": {
        "path": "/samples/customers.parquet",
        "format": "parquet",
        "rows": 50000,
        "schema": """
            customer_id: string
            name: string
            email: string
            signup_date: date
            region: string
            segment: string
        """
    },

    "products": {
        "path": "/samples/products.parquet",
        "format": "parquet",
        "rows": 10000,
        "schema": """
            product_id: string
            name: string
            category: string
            subcategory: string
            price: decimal(10,2)
            cost: decimal(10,2)
        """
    },

    "clickstream": {
        "path": "/samples/clickstream.json",
        "format": "json",
        "rows": 5000000,
        "schema": """
            session_id: string
            user_id: string
            timestamp: timestamp
            page_url: string
            action: string
            device_type: string
        """
    }
}

# Helper function to load datasets
def load_dataset(name):
    """Load a pre-configured sample dataset"""
    if name not in datasets:
        raise ValueError(f"Dataset '{name}' not found")

    config = datasets[name]
    df = spark.read.format(config["format"]).load(config["path"])
    print(f"Loaded {name}: {df.count()} rows")
    return df

# Usage
sales_df = load_dataset("sales")
customers_df = load_dataset("customers")
```

## 🎓 Interactive Tutorials

### Tutorial 1: DataFrame Basics

```python
# ============================================
# Tutorial 1: DataFrame Basics
# ============================================

# Step 1: Load data
df = spark.read.parquet("/samples/sales_data.parquet")

# Step 2: Explore schema
print("Schema:")
df.printSchema()

# Step 3: Basic operations
print("\nFirst 10 rows:")
df.show(10)

print("\nColumn names:")
print(df.columns)

print("\nDataFrame shape:")
print(f"Rows: {df.count()}, Columns: {len(df.columns)}")

# Step 4: Select columns
selected_df = df.select("transaction_id", "customer_id", "revenue")
selected_df.show(5)

# Step 5: Filter data
high_value_df = df.filter(col("revenue") > 1000)
print(f"\nHigh value transactions: {high_value_df.count()}")

# Step 6: Sort data
top_transactions = df.orderBy(col("revenue").desc()).limit(10)
top_transactions.show()

# ✅ Exercise: Find all transactions in the 'Electronics' category
# where quantity > 2. Sort by revenue descending.
# Write your code below:

```

### Tutorial 2: Aggregations and GroupBy

```python
# ============================================
# Tutorial 2: Aggregations and GroupBy
# ============================================

from pyspark.sql.functions import *

# Load data
df = spark.read.parquet("/samples/sales_data.parquet")

# Basic aggregation
print("Total Revenue:", df.agg(sum("revenue")).collect()[0][0])

# Group by single column
category_sales = df.groupBy("category") \
    .agg(
        sum("revenue").alias("total_revenue"),
        avg("revenue").alias("avg_revenue"),
        count("*").alias("transaction_count"),
        min("revenue").alias("min_revenue"),
        max("revenue").alias("max_revenue")
    ) \
    .orderBy(col("total_revenue").desc())

category_sales.show()

# Group by multiple columns
region_category_sales = df.groupBy("region", "category") \
    .agg(
        sum("revenue").alias("total_revenue"),
        countDistinct("customer_id").alias("unique_customers")
    ) \
    .orderBy("region", col("total_revenue").desc())

region_category_sales.show()

# Advanced: Window functions
from pyspark.sql.window import Window

# Calculate running total by region
window_spec = Window.partitionBy("region").orderBy("timestamp")

df_with_running_total = df.withColumn(
    "running_total",
    sum("revenue").over(window_spec)
)

df_with_running_total.select(
    "timestamp", "region", "revenue", "running_total"
).show(20)

# Ranking
window_rank = Window.partitionBy("category").orderBy(col("revenue").desc())

top_per_category = df.withColumn(
    "rank",
    row_number().over(window_rank)
).filter(col("rank") <= 5)

top_per_category.show()

# ✅ Exercise: Calculate the average revenue per customer
# for each region. Show only regions with avg > $500.
# Write your code below:

```

### Tutorial 3: Joins and Complex Transformations

```python
# ============================================
# Tutorial 3: Joins and Complex Transformations
# ============================================

# Load datasets
sales_df = load_dataset("sales")
customers_df = load_dataset("customers")
products_df = load_dataset("products")

# Inner Join
enriched_sales = sales_df \
    .join(customers_df, "customer_id", "inner") \
    .join(products_df, "product_id", "inner") \
    .select(
        "transaction_id",
        "timestamp",
        customers_df["name"].alias("customer_name"),
        customers_df["segment"],
        products_df["name"].alias("product_name"),
        "quantity",
        "revenue"
    )

enriched_sales.show(10)

# Left Join (to include all sales even without customer data)
all_sales = sales_df \
    .join(customers_df, "customer_id", "left") \
    .select(
        "transaction_id",
        "customer_id",
        customers_df["name"].alias("customer_name"),
        "revenue"
    )

# Count missing customer data
missing_customers = all_sales.filter(col("customer_name").isNull()).count()
print(f"Transactions with missing customer data: {missing_customers}")

# Complex transformation: Customer Lifetime Value
from pyspark.sql.functions import *

customer_ltv = enriched_sales \
    .groupBy("customer_id", "customer_name", "segment") \
    .agg(
        sum("revenue").alias("lifetime_value"),
        count("transaction_id").alias("purchase_count"),
        avg("revenue").alias("avg_order_value"),
        min("timestamp").alias("first_purchase"),
        max("timestamp").alias("last_purchase")
    ) \
    .withColumn(
        "customer_tenure_days",
        datediff(col("last_purchase"), col("first_purchase"))
    ) \
    .withColumn(
        "purchase_frequency",
        col("purchase_count") / (col("customer_tenure_days") + 1)
    ) \
    .orderBy(col("lifetime_value").desc())

customer_ltv.show(20)

# Self-join: Find customers who bought the same product twice
repeat_purchases = sales_df.alias("s1") \
    .join(
        sales_df.alias("s2"),
        (col("s1.customer_id") == col("s2.customer_id")) &
        (col("s1.product_id") == col("s2.product_id")) &
        (col("s1.transaction_id") != col("s2.transaction_id"))
    ) \
    .select(
        col("s1.customer_id"),
        col("s1.product_id"),
        col("s1.timestamp").alias("first_purchase"),
        col("s2.timestamp").alias("second_purchase")
    )

print(f"Repeat purchases: {repeat_purchases.count()}")

# ✅ Exercise: Find the top 10 customers by lifetime value
# in the 'Premium' segment. Include their average order value
# and purchase frequency.
# Write your code below:

```

### Tutorial 4: Performance Optimization

```python
# ============================================
# Tutorial 4: Performance Optimization
# ============================================

from pyspark.sql.functions import *
import time

# Load large dataset
df = spark.read.parquet("/samples/sales_data.parquet")

# ===== Optimization 1: Caching =====
print("Without caching:")
start = time.time()
df.count()
print(f"First count: {time.time() - start:.2f} seconds")

start = time.time()
df.count()
print(f"Second count: {time.time() - start:.2f} seconds")

# Enable caching
df.cache()
df.count()  # Trigger caching

print("\nWith caching:")
start = time.time()
df.count()
print(f"Cached count: {time.time() - start:.2f} seconds")

# ===== Optimization 2: Partitioning =====
# Check current partitions
print(f"\nCurrent partitions: {df.rdd.getNumPartitions()}")

# Repartition for better parallelism
df_repartitioned = df.repartition(8, "region")
print(f"After repartitioning: {df_repartitioned.rdd.getNumPartitions()}")

# ===== Optimization 3: Broadcast Joins =====
from pyspark.sql.functions import broadcast

# Small table
small_df = spark.createDataFrame([
    ("Electronics", 0.1),
    ("Clothing", 0.15),
    ("Food", 0.05)
], ["category", "tax_rate"])

# Regular join (can be slow)
regular_join = df.join(small_df, "category")

# Broadcast join (faster for small tables)
broadcast_join = df.join(broadcast(small_df), "category")

# ===== Optimization 4: Predicate Pushdown =====
# Filter early to reduce data movement
filtered_df = df \
    .filter(col("timestamp") >= "2024-01-01") \
    .filter(col("region") == "North") \
    .select("transaction_id", "revenue")

# ===== Optimization 5: Column Pruning =====
# Select only needed columns early
pruned_df = df.select("customer_id", "revenue", "timestamp")

# Then perform operations
customer_summary = pruned_df \
    .groupBy("customer_id") \
    .agg(sum("revenue").alias("total_revenue"))

# ===== Monitoring and Explain Plan =====
# View execution plan
df.filter(col("revenue") > 1000).explain(True)

# ✅ Exercise: Optimize this query
# Original (slow):
slow_query = df \
    .join(customers_df, "customer_id") \
    .filter(col("revenue") > 500) \
    .filter(col("region") == "East") \
    .select("transaction_id", "revenue")

# Optimize and compare execution plans:
# Write your optimized version below:

```

### Tutorial 5: Working with Different Data Formats

```python
# ============================================
# Tutorial 5: Data Formats and Delta Lake
# ============================================

from delta.tables import *

# ===== Reading Different Formats =====

# CSV
csv_df = spark.read \
    .option("header", "true") \
    .option("inferSchema", "true") \
    .csv("/samples/data.csv")

# JSON
json_df = spark.read.json("/samples/data.json")

# Parquet
parquet_df = spark.read.parquet("/samples/data.parquet")

# Delta
delta_df = spark.read.format("delta").load("/samples/delta_table")

# ===== Writing Data =====

# Write as Parquet with compression
df.write \
    .mode("overwrite") \
    .option("compression", "snappy") \
    .parquet("/output/sales_parquet")

# Write as Delta with partitioning
df.write \
    .format("delta") \
    .mode("overwrite") \
    .partitionBy("region", "category") \
    .save("/output/sales_delta")

# ===== Delta Lake Operations =====

# Create Delta table
df.write \
    .format("delta") \
    .mode("overwrite") \
    .save("/delta/sales")

# Read Delta table
delta_sales = spark.read.format("delta").load("/delta/sales")

# Update operation
deltaTable = DeltaTable.forPath(spark, "/delta/sales")

deltaTable.update(
    condition = col("revenue") < 0,
    set = { "revenue": lit(0) }
)

# Delete operation
deltaTable.delete(condition = col("quantity") == 0)

# Merge (UPSERT) operation
new_data = spark.createDataFrame([
    ("TXN001", 150.00),
    ("TXN999", 200.00)
], ["transaction_id", "revenue"])

deltaTable.alias("target") \
    .merge(
        new_data.alias("source"),
        "target.transaction_id = source.transaction_id"
    ) \
    .whenMatchedUpdate(set = { "revenue": col("source.revenue") }) \
    .whenNotMatchedInsertAll() \
    .execute()

# Time travel
# Read historical version
historical_df = spark.read \
    .format("delta") \
    .option("versionAsOf", 0) \
    .load("/delta/sales")

# Read as of timestamp
timestamp_df = spark.read \
    .format("delta") \
    .option("timestampAsOf", "2024-01-01") \
    .load("/delta/sales")

# View history
deltaTable.history().show()

# ✅ Exercise: Create a Delta table from sales data,
# perform an update to fix negative revenues,
# and query the table before and after the update using time travel.
# Write your code below:

```

## 💡 Code Snippets Library

### Quick Actions

```python
# ===== Common Operations =====

# 1. Schema operations
df.printSchema()
df.dtypes
df.columns

# 2. Data inspection
df.show(20, truncate=False)
df.describe().show()
df.summary().show()

# 3. Column operations
df.withColumn("new_col", lit("value"))
df.withColumnRenamed("old_name", "new_name")
df.drop("column_name")

# 4. Null handling
df.na.drop()
df.na.fill({"column": "default_value"})
df.filter(col("column").isNotNull())

# 5. String operations
df.filter(col("name").like("%pattern%"))
df.withColumn("upper_name", upper(col("name")))
df.withColumn("length", length(col("name")))

# 6. Date operations
df.withColumn("year", year(col("date_column")))
df.withColumn("month", month(col("date_column")))
df.withColumn("date_diff", datediff(col("end_date"), col("start_date")))

# 7. Type conversions
df.withColumn("price_int", col("price").cast("integer"))
df.withColumn("timestamp", to_timestamp(col("date_string"), "yyyy-MM-dd"))

# 8. UDFs (User Defined Functions)
from pyspark.sql.types import StringType

def categorize_revenue(revenue):
    if revenue < 100:
        return "Low"
    elif revenue < 500:
        return "Medium"
    else:
        return "High"

categorize_udf = udf(categorize_revenue, StringType())
df.withColumn("revenue_category", categorize_udf(col("revenue")))
```

## 🔧 Advanced Features

### Spark SQL Integration

```python
# Register DataFrame as temp view
df.createOrReplaceTempView("sales")

# Use SQL to query
result = spark.sql("""
    SELECT
        region,
        category,
        SUM(revenue) as total_revenue,
        COUNT(*) as transaction_count
    FROM sales
    WHERE timestamp >= '2024-01-01'
    GROUP BY region, category
    HAVING SUM(revenue) > 10000
    ORDER BY total_revenue DESC
""")

result.show()

# Mix SQL and DataFrame API
spark.sql("SELECT * FROM sales WHERE region = 'North'") \
    .groupBy("category") \
    .agg(avg("revenue")) \
    .show()
```

### Streaming Simulation

```python
# Simulate streaming data
from pyspark.sql.types import *
import time

schema = StructType([
    StructField("timestamp", TimestampType(), True),
    StructField("sensor_id", StringType(), True),
    StructField("temperature", DoubleType(), True),
    StructField("humidity", DoubleType(), True)
])

# Create streaming DataFrame (simulated)
streaming_df = spark.readStream \
    .schema(schema) \
    .json("/streaming/input")

# Perform transformations
processed_df = streaming_df \
    .withColumn("temp_celsius", (col("temperature") - 32) * 5/9) \
    .filter(col("temperature") > 100)

# Write stream (simulated)
query = processed_df.writeStream \
    .format("memory") \
    .queryName("sensor_data") \
    .start()

# Query the in-memory table
spark.sql("SELECT * FROM sensor_data").show()
```

## 🔧 Troubleshooting

### Common Issues

#### Issue: Out of Memory Errors

**Symptoms:**

```text
org.apache.spark.SparkException: Job aborted due to stage failure:
java.lang.OutOfMemoryError: Java heap space
```

**Solution:**

```python
# 1. Reduce data size
df_sample = df.sample(0.1)  # Use 10% sample

# 2. Increase partitions
df_repartitioned = df.repartition(100)

# 3. Use iterative processing
for partition in df.rdd.mapPartitions(lambda x: [list(x)]):
    process_partition(partition)

# 4. Clear cache when done
df.unpersist()
```

#### Issue: Slow Joins

**Symptoms:**

- Join operations taking very long
- Skewed data distribution

**Solution:**

```python
# 1. Broadcast small tables
from pyspark.sql.functions import broadcast
result = large_df.join(broadcast(small_df), "key")

# 2. Salt keys for skewed joins
from pyspark.sql.functions import rand, concat

salted_df = df.withColumn("salted_key",
    concat(col("key"), lit("_"), (rand() * 10).cast("int")))

# 3. Increase shuffle partitions
spark.conf.set("spark.sql.shuffle.partitions", "200")
```

#### Issue: Data Type Mismatches

**Solution:**

```python
# Check schema
df.printSchema()

# Cast columns
df = df.withColumn("price", col("price").cast("decimal(10,2)"))

# Handle null values before operations
df = df.na.fill({"price": 0.0})
```

## 🔗 Embedded Demo Link

**Launch Spark Sandbox:** [https://demos.csa-inabox.com/spark-sandbox](https://demos.csa-inabox.com/spark-sandbox)

**Features:**

- Real-time code execution
- Pre-loaded sample datasets
- Save and share notebooks
- Export results
- Collaborative editing

## 📚 Additional Resources

### Documentation

- [PySpark API Reference](https://spark.apache.org/docs/latest/api/python/)
- [Spark SQL Guide](https://spark.apache.org/docs/latest/sql-programming-guide.html)
- [Delta Lake Documentation](https://docs.delta.io/)

### Code Examples

- [Spark Best Practices](../../code-examples/README.md)
- [Performance Tuning Guide](../../best-practices/spark-performance.md)
- [Delta Lake Examples](../../code-examples/delta-lake-guide.md)

## 💬 Feedback

> **💡 How was your Spark Sandbox experience?**

- ✅ **Helpful and educational** - [Share feedback](https://github.com/csa-inabox/docs/discussions)
- ⚠️ **Had issues** - [Report problem](https://github.com/csa-inabox/docs/issues/new)
- 💡 **Feature request** - [Suggest improvement](https://github.com/csa-inabox/docs/issues/new?title=[Sandbox]+Feature)

---

*Last Updated: January 2025 | Version: 1.0.0*
