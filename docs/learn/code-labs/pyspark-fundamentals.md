# PySpark Fundamentals Lab

> **[Home](../README.md)** | **[Code Labs](README.md)** | **PySpark Fundamentals**

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Level](https://img.shields.io/badge/Level-Beginner-green?style=flat-square)
![Duration](https://img.shields.io/badge/Duration-2%20hours-blue?style=flat-square)

Hands-on lab for learning PySpark fundamentals on Azure Synapse Analytics.

---

## Lab Overview

### Learning Objectives

By the end of this lab, you will be able to:

- Create and configure a SparkSession
- Load data from various sources
- Perform DataFrame transformations
- Write optimized Spark queries
- Save results to different formats

### Prerequisites

- Azure Synapse workspace access
- Basic Python knowledge
- Familiarity with SQL concepts

---

## Lab 1: Getting Started

### Exercise 1.1: Create SparkSession

```python
# In Synapse notebooks, SparkSession is pre-configured
# For standalone environments:
from pyspark.sql import SparkSession

spark = SparkSession.builder \
    .appName("PySpark Fundamentals") \
    .config("spark.sql.adaptive.enabled", "true") \
    .getOrCreate()

# Verify configuration
print(f"Spark version: {spark.version}")
print(f"Application ID: {spark.sparkContext.applicationId}")
```

### Exercise 1.2: Load Sample Data

```python
# Create sample DataFrame
data = [
    (1, "Alice", "Engineering", 75000),
    (2, "Bob", "Sales", 65000),
    (3, "Charlie", "Engineering", 80000),
    (4, "Diana", "HR", 55000),
    (5, "Eve", "Sales", 70000)
]

columns = ["id", "name", "department", "salary"]
df = spark.createDataFrame(data, columns)

# Display DataFrame
df.show()
df.printSchema()
```

---

## Lab 2: DataFrame Operations

### Exercise 2.1: Basic Transformations

```python
from pyspark.sql.functions import col, upper, when, lit

# Select specific columns
df.select("name", "department").show()

# Add computed column
df_with_bonus = df.withColumn(
    "bonus",
    when(col("salary") > 70000, col("salary") * 0.15)
    .otherwise(col("salary") * 0.10)
)
df_with_bonus.show()

# Filter rows
engineers = df.filter(col("department") == "Engineering")
engineers.show()

# Rename column
df_renamed = df.withColumnRenamed("salary", "annual_salary")
df_renamed.show()
```

### Exercise 2.2: Aggregations

```python
from pyspark.sql.functions import count, avg, sum, max, min

# Group by department
dept_stats = df.groupBy("department").agg(
    count("*").alias("employee_count"),
    avg("salary").alias("avg_salary"),
    max("salary").alias("max_salary"),
    min("salary").alias("min_salary"),
    sum("salary").alias("total_salary")
)
dept_stats.show()

# Multiple aggregations with ordering
df.groupBy("department") \
    .agg(avg("salary").alias("avg_salary")) \
    .orderBy(col("avg_salary").desc()) \
    .show()
```

---

## Lab 3: Working with Files

### Exercise 3.1: Read from Data Lake

```python
# Read Parquet
parquet_df = spark.read.parquet(
    "abfss://data@storage.dfs.core.windows.net/samples/employees.parquet"
)

# Read CSV with options
csv_df = spark.read \
    .option("header", "true") \
    .option("inferSchema", "true") \
    .csv("abfss://data@storage.dfs.core.windows.net/samples/employees.csv")

# Read JSON
json_df = spark.read.json(
    "abfss://data@storage.dfs.core.windows.net/samples/events.json"
)

# Read Delta Lake
delta_df = spark.read.format("delta").load(
    "abfss://data@storage.dfs.core.windows.net/delta/customers"
)
```

### Exercise 3.2: Write Data

```python
# Write as Parquet (partitioned)
df.write \
    .mode("overwrite") \
    .partitionBy("department") \
    .parquet("abfss://data@storage.dfs.core.windows.net/output/employees_parquet")

# Write as Delta Lake
df.write \
    .format("delta") \
    .mode("overwrite") \
    .save("abfss://data@storage.dfs.core.windows.net/output/employees_delta")

# Write to SQL table
df.write \
    .mode("overwrite") \
    .saveAsTable("employees")
```

---

## Lab 4: Joins and Unions

### Exercise 4.1: Join Operations

```python
# Create second DataFrame
departments_data = [
    ("Engineering", "Building A", "John"),
    ("Sales", "Building B", "Jane"),
    ("HR", "Building A", "Mike"),
    ("Marketing", "Building C", "Sarah")
]

departments = spark.createDataFrame(
    departments_data,
    ["dept_name", "location", "manager"]
)

# Inner join
joined_df = df.join(
    departments,
    df.department == departments.dept_name,
    "inner"
)
joined_df.show()

# Left join
left_joined = df.join(
    departments,
    df.department == departments.dept_name,
    "left"
)
left_joined.show()
```

### Exercise 4.2: Union and Distinct

```python
# Create additional employees
new_employees = spark.createDataFrame([
    (6, "Frank", "Marketing", 72000),
    (7, "Grace", "Engineering", 85000)
], columns)

# Union DataFrames
all_employees = df.union(new_employees)
all_employees.show()

# Remove duplicates
distinct_depts = all_employees.select("department").distinct()
distinct_depts.show()
```

---

## Lab 5: Window Functions

### Exercise 5.1: Ranking

```python
from pyspark.sql.window import Window
from pyspark.sql.functions import row_number, rank, dense_rank

# Define window
dept_window = Window.partitionBy("department").orderBy(col("salary").desc())

# Add ranking columns
ranked_df = df.withColumn("row_num", row_number().over(dept_window)) \
    .withColumn("rank", rank().over(dept_window)) \
    .withColumn("dense_rank", dense_rank().over(dept_window))

ranked_df.show()
```

### Exercise 5.2: Running Totals

```python
from pyspark.sql.functions import sum as spark_sum, avg as spark_avg

# Cumulative sum window
cumsum_window = Window.partitionBy("department") \
    .orderBy("id") \
    .rowsBetween(Window.unboundedPreceding, Window.currentRow)

# Running total and average
df_with_cumsum = df.withColumn(
    "cumulative_salary",
    spark_sum("salary").over(cumsum_window)
).withColumn(
    "running_avg",
    spark_avg("salary").over(cumsum_window)
)

df_with_cumsum.show()
```

---

## Lab 6: SQL Interface

### Exercise 6.1: Spark SQL

```python
# Register temp view
df.createOrReplaceTempView("employees")

# Run SQL query
result = spark.sql("""
    SELECT
        department,
        COUNT(*) as emp_count,
        AVG(salary) as avg_salary,
        SUM(salary) as total_salary
    FROM employees
    GROUP BY department
    HAVING COUNT(*) > 0
    ORDER BY avg_salary DESC
""")

result.show()
```

### Exercise 6.2: Complex SQL

```python
# CTE and subquery
spark.sql("""
    WITH dept_stats AS (
        SELECT
            department,
            AVG(salary) as dept_avg
        FROM employees
        GROUP BY department
    )
    SELECT
        e.name,
        e.department,
        e.salary,
        d.dept_avg,
        e.salary - d.dept_avg as diff_from_avg
    FROM employees e
    JOIN dept_stats d ON e.department = d.department
    ORDER BY diff_from_avg DESC
""").show()
```

---

## Challenge Exercise

### Build an Analytics Pipeline

```python
# Challenge: Create an employee analytics pipeline

# Step 1: Load data
employees_df = spark.read.parquet("/path/to/employees")
departments_df = spark.read.parquet("/path/to/departments")

# Step 2: Join and enrich
enriched = employees_df.join(
    departments_df,
    employees_df.dept_id == departments_df.id,
    "left"
)

# Step 3: Add analytics
from pyspark.sql.functions import current_date, datediff

analytics = enriched \
    .withColumn("tenure_days", datediff(current_date(), col("hire_date"))) \
    .withColumn("salary_percentile",
        percent_rank().over(Window.orderBy("salary")))

# Step 4: Aggregate
summary = analytics.groupBy("department").agg(
    count("*").alias("headcount"),
    avg("salary").alias("avg_salary"),
    avg("tenure_days").alias("avg_tenure")
)

# Step 5: Save results
summary.write \
    .format("delta") \
    .mode("overwrite") \
    .save("/output/department_analytics")
```

---

## Related Documentation

- [Spark SQL Tutorial](../tutorials/intermediate/spark-sql-tutorial.md)
- [Spark Performance Tuning](../best-practices/spark-performance/README.md)
- [Delta Lake Guide](../delta-lake-guide.md)

---

*Last Updated: January 2025*
