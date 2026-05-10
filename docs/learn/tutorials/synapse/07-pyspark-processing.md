# Tutorial 07: PySpark Processing in Azure Synapse

> **Navigation**: [Home](../../README.md) > [Tutorials](../README.md) > [Synapse Series](README.md) > PySpark Processing

![Tutorial](https://img.shields.io/badge/Tutorial-07%20of%2014-blue)
![Duration](https://img.shields.io/badge/Duration-60%20minutes-orange)
![Level](https://img.shields.io/badge/Level-Intermediate-yellow)

## Overview

This tutorial covers PySpark notebook development in Azure Synapse Analytics, including data transformations, DataFrame operations, and best practices for distributed processing.

## Learning Objectives

By the end of this tutorial, you will be able to:

- Create and configure PySpark notebooks
- Perform DataFrame transformations
- Implement common data processing patterns
- Optimize PySpark performance
- Handle errors and debugging

## Prerequisites

- Completed [Tutorial 06: Spark Pools](06-spark-pools.md)
- Active Synapse workspace with Spark pool
- Sample data in Data Lake Storage
- Basic Python knowledge

## Table of Contents

1. [Creating PySpark Notebooks](#creating-pyspark-notebooks)
2. [DataFrame Operations](#dataframe-operations)
3. [Data Transformations](#data-transformations)
4. [Window Functions](#window-functions)
5. [Performance Optimization](#performance-optimization)
6. [Error Handling](#error-handling)

---

## Creating PySpark Notebooks

### Step 1: Create a New Notebook

1. Navigate to **Develop** hub in Synapse Studio
2. Click **+** and select **Notebook**
3. Name it `pyspark-processing-tutorial`
4. Attach to your Spark pool

### Step 2: Configure Notebook Settings

```python
# Cell 1: Configure Spark session
from pyspark.sql import SparkSession
from pyspark.sql.functions import *
from pyspark.sql.types import *
from pyspark.sql.window import Window

# Session is pre-configured in Synapse
spark = SparkSession.builder.getOrCreate()

# Configure settings for better performance
spark.conf.set("spark.sql.shuffle.partitions", "200")
spark.conf.set("spark.sql.adaptive.enabled", "true")
spark.conf.set("spark.sql.adaptive.coalescePartitions.enabled", "true")

print(f"Spark version: {spark.version}")
print(f"Application ID: {spark.sparkContext.applicationId}")
```

---

## DataFrame Operations

### Reading Data from Data Lake

```python
# Cell 2: Read data from ADLS Gen2
storage_account = "your_storage_account"
container = "raw"

# Read CSV data
csv_df = spark.read \
    .option("header", "true") \
    .option("inferSchema", "true") \
    .csv(f"abfss://{container}@{storage_account}.dfs.core.windows.net/sales/")

# Read Parquet data
parquet_df = spark.read \
    .parquet(f"abfss://{container}@{storage_account}.dfs.core.windows.net/products/")

# Read JSON data
json_df = spark.read \
    .option("multiLine", "true") \
    .json(f"abfss://{container}@{storage_account}.dfs.core.windows.net/events/")

# Display schema
csv_df.printSchema()
```

### Basic DataFrame Operations

```python
# Cell 3: Basic operations
# Select columns
selected_df = csv_df.select("customer_id", "product_id", "quantity", "price")

# Filter rows
filtered_df = csv_df.filter(col("quantity") > 10)

# Add computed columns
enhanced_df = csv_df.withColumn("total_amount", col("quantity") * col("price")) \
                    .withColumn("processed_date", current_timestamp())

# Rename columns
renamed_df = csv_df.withColumnRenamed("customer_id", "cust_id")

# Drop columns
clean_df = csv_df.drop("unnecessary_column")

# Show results
enhanced_df.show(5)
```

### Aggregations

```python
# Cell 4: Aggregation operations
from pyspark.sql.functions import sum, avg, count, min, max, countDistinct

# Group by and aggregate
sales_summary = csv_df.groupBy("product_id") \
    .agg(
        sum("quantity").alias("total_quantity"),
        sum(col("quantity") * col("price")).alias("total_revenue"),
        avg("price").alias("avg_price"),
        count("*").alias("transaction_count"),
        countDistinct("customer_id").alias("unique_customers")
    )

# Multiple grouping
region_product_summary = csv_df.groupBy("region", "product_category") \
    .agg(
        sum("quantity").alias("total_quantity"),
        round(avg("price"), 2).alias("avg_price")
    ) \
    .orderBy(desc("total_quantity"))

sales_summary.show()
```

---

## Data Transformations

### Joining DataFrames

```python
# Cell 5: Join operations
# Create sample DataFrames
customers_df = spark.read.parquet(f"abfss://{container}@{storage_account}.dfs.core.windows.net/customers/")
products_df = spark.read.parquet(f"abfss://{container}@{storage_account}.dfs.core.windows.net/products/")

# Inner join
enriched_sales = csv_df \
    .join(customers_df, csv_df.customer_id == customers_df.id, "inner") \
    .join(products_df, csv_df.product_id == products_df.id, "inner") \
    .select(
        csv_df["*"],
        customers_df.name.alias("customer_name"),
        customers_df.segment,
        products_df.product_name,
        products_df.category
    )

# Left outer join
all_customers = customers_df \
    .join(csv_df, customers_df.id == csv_df.customer_id, "left_outer")

# Broadcast join for small tables (optimization)
from pyspark.sql.functions import broadcast

optimized_join = csv_df \
    .join(broadcast(products_df), csv_df.product_id == products_df.id)

enriched_sales.show(5)
```

### Handling Missing Data

```python
# Cell 6: Null handling
# Drop rows with nulls
clean_df = csv_df.dropna()

# Drop rows with nulls in specific columns
clean_df = csv_df.dropna(subset=["customer_id", "product_id"])

# Fill nulls with default values
filled_df = csv_df.fillna({
    "quantity": 0,
    "price": 0.0,
    "region": "Unknown"
})

# Replace specific values
replaced_df = csv_df.replace(["NA", "N/A", ""], None)

# Conditional null handling
conditional_df = csv_df.withColumn(
    "adjusted_price",
    when(col("price").isNull(), lit(0.0))
    .when(col("price") < 0, lit(0.0))
    .otherwise(col("price"))
)

filled_df.show(5)
```

### String Operations

```python
# Cell 7: String transformations
from pyspark.sql.functions import (
    upper, lower, trim, ltrim, rtrim,
    concat, concat_ws, substring, length,
    regexp_replace, regexp_extract, split
)

string_ops_df = csv_df.withColumn("upper_name", upper(col("product_name"))) \
    .withColumn("trimmed", trim(col("description"))) \
    .withColumn("name_length", length(col("product_name"))) \
    .withColumn("first_word", split(col("product_name"), " ")[0]) \
    .withColumn("clean_phone", regexp_replace(col("phone"), "[^0-9]", "")) \
    .withColumn("email_domain", regexp_extract(col("email"), "@(.+)$", 1))

string_ops_df.select("product_name", "upper_name", "name_length", "first_word").show(5)
```

### Date and Time Operations

```python
# Cell 8: Date/time transformations
from pyspark.sql.functions import (
    to_date, to_timestamp, date_format,
    year, month, dayofmonth, dayofweek, hour,
    datediff, months_between, add_months, date_add,
    current_date, current_timestamp
)

date_df = csv_df.withColumn("order_date", to_date(col("order_date_str"), "yyyy-MM-dd")) \
    .withColumn("order_year", year(col("order_date"))) \
    .withColumn("order_month", month(col("order_date"))) \
    .withColumn("order_day", dayofmonth(col("order_date"))) \
    .withColumn("day_of_week", dayofweek(col("order_date"))) \
    .withColumn("days_since_order", datediff(current_date(), col("order_date"))) \
    .withColumn("formatted_date", date_format(col("order_date"), "MMM dd, yyyy"))

date_df.select("order_date", "order_year", "order_month", "days_since_order").show(5)
```

---

## Window Functions

### Ranking Functions

```python
# Cell 9: Window ranking functions
from pyspark.sql.window import Window
from pyspark.sql.functions import row_number, rank, dense_rank, ntile, percent_rank

# Define window specification
window_by_customer = Window.partitionBy("customer_id").orderBy(desc("order_date"))
window_by_category = Window.partitionBy("category").orderBy(desc("total_amount"))

# Apply ranking functions
ranked_df = csv_df \
    .withColumn("row_num", row_number().over(window_by_customer)) \
    .withColumn("rank", rank().over(window_by_category)) \
    .withColumn("dense_rank", dense_rank().over(window_by_category)) \
    .withColumn("quartile", ntile(4).over(window_by_category)) \
    .withColumn("percentile", percent_rank().over(window_by_category))

# Get most recent order per customer
most_recent = ranked_df.filter(col("row_num") == 1)

ranked_df.show(10)
```

### Aggregate Window Functions

```python
# Cell 10: Aggregate window functions
from pyspark.sql.functions import sum, avg, min, max, count

# Running totals and moving averages
window_cumulative = Window.partitionBy("customer_id").orderBy("order_date").rowsBetween(Window.unboundedPreceding, Window.currentRow)
window_moving = Window.partitionBy("customer_id").orderBy("order_date").rowsBetween(-2, 0)

analytics_df = csv_df \
    .withColumn("running_total", sum("total_amount").over(window_cumulative)) \
    .withColumn("moving_avg_3", avg("total_amount").over(window_moving)) \
    .withColumn("customer_total", sum("total_amount").over(Window.partitionBy("customer_id"))) \
    .withColumn("pct_of_customer_total", col("total_amount") / col("customer_total") * 100)

analytics_df.select("customer_id", "order_date", "total_amount", "running_total", "moving_avg_3").show(10)
```

### Lead and Lag Functions

```python
# Cell 11: Lead and lag functions
from pyspark.sql.functions import lead, lag

window_ordered = Window.partitionBy("customer_id").orderBy("order_date")

lead_lag_df = csv_df \
    .withColumn("prev_order_amount", lag("total_amount", 1).over(window_ordered)) \
    .withColumn("next_order_amount", lead("total_amount", 1).over(window_ordered)) \
    .withColumn("prev_order_date", lag("order_date", 1).over(window_ordered)) \
    .withColumn("days_between_orders", datediff(col("order_date"), col("prev_order_date"))) \
    .withColumn("amount_change", col("total_amount") - col("prev_order_amount"))

lead_lag_df.select("customer_id", "order_date", "total_amount", "prev_order_amount", "amount_change").show(10)
```

---

## Performance Optimization

### Caching and Persistence

```python
# Cell 12: Caching strategies
from pyspark.storagelevel import StorageLevel

# Cache DataFrame in memory
csv_df.cache()

# Persist with specific storage level
csv_df.persist(StorageLevel.MEMORY_AND_DISK)

# Check if cached
print(f"Is cached: {csv_df.is_cached}")

# Unpersist when done
csv_df.unpersist()

# Best practice: Cache after expensive operations
expensive_df = csv_df \
    .join(customers_df, "customer_id") \
    .groupBy("region") \
    .agg(sum("total_amount").alias("regional_sales"))

expensive_df.cache()
expensive_df.count()  # Trigger caching

# Now use cached DataFrame for multiple operations
expensive_df.filter(col("regional_sales") > 10000).show()
expensive_df.orderBy(desc("regional_sales")).show()
```

### Partitioning Strategies

```python
# Cell 13: Partitioning for performance
# Repartition for parallel processing
repartitioned_df = csv_df.repartition(200)

# Repartition by column for joins
customer_partitioned = csv_df.repartition("customer_id")

# Coalesce to reduce partitions (no shuffle)
coalesced_df = csv_df.coalesce(10)

# Check partition count
print(f"Partition count: {csv_df.rdd.getNumPartitions()}")

# Write with partitioning
csv_df.write \
    .partitionBy("year", "month") \
    .mode("overwrite") \
    .parquet(f"abfss://curated@{storage_account}.dfs.core.windows.net/sales_partitioned/")
```

### Broadcast Variables

```python
# Cell 14: Broadcast for small lookups
# Create broadcast variable for small lookup data
lookup_data = {"A": "Category A", "B": "Category B", "C": "Category C"}
broadcast_lookup = spark.sparkContext.broadcast(lookup_data)

# Use in UDF
from pyspark.sql.functions import udf

@udf(returnType=StringType())
def lookup_category(code):
    return broadcast_lookup.value.get(code, "Unknown")

result_df = csv_df.withColumn("category_name", lookup_category(col("category_code")))

# Clean up broadcast variable when done
broadcast_lookup.unpersist()
```

---

## Error Handling

### Try-Except Patterns

```python
# Cell 15: Error handling patterns
from pyspark.sql.utils import AnalysisException

def safe_read_data(path, format="parquet"):
    """Safely read data with error handling."""
    try:
        if format == "parquet":
            return spark.read.parquet(path)
        elif format == "csv":
            return spark.read.option("header", "true").csv(path)
        elif format == "json":
            return spark.read.json(path)
        else:
            raise ValueError(f"Unsupported format: {format}")
    except AnalysisException as e:
        print(f"Analysis error reading {path}: {str(e)}")
        return None
    except Exception as e:
        print(f"Error reading {path}: {str(e)}")
        return None

# Usage
df = safe_read_data(f"abfss://{container}@{storage_account}.dfs.core.windows.net/data/")
if df is not None:
    df.show()
else:
    print("Failed to load data")
```

### Data Quality Checks

```python
# Cell 16: Data quality validation
def validate_dataframe(df, rules):
    """Validate DataFrame against rules."""
    results = []

    for rule in rules:
        rule_name = rule["name"]
        condition = rule["condition"]

        valid_count = df.filter(condition).count()
        total_count = df.count()
        pass_rate = (valid_count / total_count * 100) if total_count > 0 else 0

        results.append({
            "rule": rule_name,
            "valid_records": valid_count,
            "total_records": total_count,
            "pass_rate": f"{pass_rate:.2f}%",
            "passed": pass_rate >= rule.get("threshold", 100)
        })

    return results

# Define validation rules
validation_rules = [
    {"name": "customer_id_not_null", "condition": col("customer_id").isNotNull(), "threshold": 100},
    {"name": "positive_quantity", "condition": col("quantity") > 0, "threshold": 99},
    {"name": "valid_price_range", "condition": (col("price") >= 0) & (col("price") <= 10000), "threshold": 99.5}
]

# Run validation
results = validate_dataframe(csv_df, validation_rules)
for r in results:
    status = "PASS" if r["passed"] else "FAIL"
    print(f"[{status}] {r['rule']}: {r['pass_rate']} ({r['valid_records']}/{r['total_records']})")
```

---

## Writing Results

### Save to Data Lake

```python
# Cell 17: Save processed data
output_path = f"abfss://curated@{storage_account}.dfs.core.windows.net/processed_sales/"

# Write as Parquet (recommended)
enriched_sales.write \
    .mode("overwrite") \
    .parquet(output_path + "parquet/")

# Write partitioned by date
enriched_sales.write \
    .partitionBy("order_year", "order_month") \
    .mode("overwrite") \
    .parquet(output_path + "partitioned/")

# Write as Delta (for ACID transactions)
enriched_sales.write \
    .format("delta") \
    .mode("overwrite") \
    .save(output_path + "delta/")

print("Data saved successfully!")
```

---

## Verification Steps

1. **Verify notebook execution**: All cells should run without errors
2. **Check output data**: Query the saved data to verify correctness
3. **Monitor performance**: Check Spark UI for job execution metrics
4. **Validate data quality**: Run validation rules on output

---

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| Out of memory error | DataFrame too large | Increase executor memory or repartition |
| Slow performance | Too few partitions | Repartition data appropriately |
| Skewed data | Uneven partition sizes | Use salting or adaptive query execution |
| Job failures | Corrupt data | Add error handling and data validation |

---

## Next Steps

Continue to [Tutorial 08: Delta Lake](08-delta-lake.md) to learn about ACID transactions and time travel capabilities.

---

## Additional Resources

- [PySpark Documentation](https://spark.apache.org/docs/latest/api/python/)
- [Synapse Spark Best Practices](https://docs.microsoft.com/azure/synapse-analytics/spark/apache-spark-best-practices)
- [DataFrame API Reference](https://spark.apache.org/docs/latest/api/python/reference/pyspark.sql.html)

---

**Progress**: Tutorial 7 of 14 completed
