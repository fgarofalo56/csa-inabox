# 📓 Azure Databricks Notebooks Introduction

![Status](https://img.shields.io/badge/Status-Active-brightgreen)
![Level](https://img.shields.io/badge/Level-Beginner-green)
![Duration](https://img.shields.io/badge/Duration-35--45_minutes-blue)

__Master Databricks notebooks for interactive data analysis. Learn notebook features, best practices, and collaboration techniques.__

## 🎯 Learning Objectives

After completing this tutorial, you will be able to:

- Understand notebook structure and capabilities
- Use multiple languages in one notebook
- Create interactive visualizations
- Implement notebook widgets for parameters
- Share and collaborate on notebooks
- Use notebook utilities and magic commands

## 📋 Prerequisites

- [ ] __Databricks workspace__ - [Create one](databricks-quickstart.md)
- [ ] __Active cluster__ - Running Spark cluster
- [ ] __Basic Python/SQL knowledge__

## 📘 What Are Databricks Notebooks?

Notebooks are interactive documents that combine:

- __Code__ - Python, Scala, SQL, R
- __Visualizations__ - Charts, graphs, maps
- __Markdown__ - Documentation and explanations
- __Results__ - Output from code execution

### __Key Features__

✅ Multi-language support
✅ Collaborative editing
✅ Version control integration
✅ Scheduled execution
✅ Interactive widgets
✅ Export capabilities (HTML, DBC, iPython)

## 🎨 Notebook Structure

### __Create a New Notebook__

1. Click "Workspace" → Your user folder
2. Click dropdown → "Create" → "Notebook"
3. Name: "Notebook Tutorial"
4. Language: Python
5. Cluster: Select your cluster

### __Cell Types__

```python
# Code Cell (Default)
print("This is a code cell")
result = 2 + 2
print(f"Result: {result}")
```

```markdown
%md
# Markdown Cell

Use markdown for documentation:
- **Bold text**
- *Italic text*
- [Links](https://databricks.com)
- `Code` formatting

## Headers and formatting
```

## 🔤 Multi-Language Support

### __Language Magic Commands__

```python
# Cell 1: Python (default)
%python
data = [1, 2, 3, 4, 5]
print(f"Python: Sum = {sum(data)}")
```

```sql
-- Cell 2: SQL
%sql
SELECT 'Hello from SQL' as message
```

```scala
// Cell 3: Scala
%scala
val numbers = List(1, 2, 3, 4, 5)
println(s"Scala: Sum = ${numbers.sum}")
```

```r
# Cell 4: R
%r
numbers <- c(1, 2, 3, 4, 5)
cat(sprintf("R: Sum = %d", sum(numbers)))
```

### __Mixing Languages Example__

```python
# Cell 5: Create data in Python
%python
sales_data = [
    ("2024-01", 10000),
    ("2024-02", 15000),
    ("2024-03", 12000)
]

df = spark.createDataFrame(sales_data, ["month", "revenue"])
df.createOrReplaceTempView("sales")
```

```sql
-- Cell 6: Query with SQL
%sql
SELECT
    month,
    revenue,
    SUM(revenue) OVER (ORDER BY month) as running_total
FROM sales
```

## 📊 Visualizations

### __Display Function__

```python
# Cell 7: Create sample data
from pyspark.sql.functions import col, rand

# Generate data
df = spark.range(0, 100) \
    .withColumn("category", (col("id") % 5).cast("string")) \
    .withColumn("value", (rand() * 100).cast("int"))

# Display with built-in viz
display(df)
```

### __Chart Types__

After running `display()`:

1. Click chart icon
2. Select chart type:
   - __Bar Chart__
   - __Line Chart__
   - __Pie Chart__
   - __Scatter Plot__
   - __Map__
3. Configure axes and aggregations

### __Custom Visualizations__

```python
# Cell 8: Use matplotlib
%python
import matplotlib.pyplot as plt
import pandas as pd

# Convert to Pandas for plotting
pdf = df.groupBy("category").count().toPandas()

plt.figure(figsize=(10, 6))
plt.bar(pdf['category'], pdf['count'])
plt.xlabel('Category')
plt.ylabel('Count')
plt.title('Items by Category')
plt.show()
```

```python
# Cell 9: Use plotly for interactive charts
%python
import plotly.express as px

# Convert to Pandas
pdf = df.toPandas()

fig = px.scatter(pdf, x="id", y="value", color="category",
                 title="Interactive Scatter Plot")
fig.show()
```

## 🎛️ Notebook Widgets

Widgets create interactive parameters for notebooks.

### __Text Widget__

```python
# Cell 10: Create text widget
dbutils.widgets.text("customer_id", "C101", "Customer ID")

# Get widget value
customer_id = dbutils.widgets.get("customer_id")
print(f"Selected customer: {customer_id}")
```

### __Dropdown Widget__

```python
# Cell 11: Create dropdown
dbutils.widgets.dropdown("category", "Electronics",
                         ["Electronics", "Furniture", "Clothing"],
                         "Product Category")

category = dbutils.widgets.get("category")
print(f"Selected category: {category}")
```

### __Multiselect Widget__

```python
# Cell 12: Create multiselect
dbutils.widgets.multiselect("regions", "US",
                            ["US", "EU", "APAC", "LATAM"],
                            "Regions")

regions = dbutils.widgets.get("regions").split(",")
print(f"Selected regions: {regions}")
```

### __Remove Widgets__

```python
# Cell 13: Remove specific or all widgets
dbutils.widgets.remove("customer_id")  # Remove one
# dbutils.widgets.removeAll()  # Remove all
```

## 🛠️ Notebook Utilities (dbutils)

### __File System Operations__

```python
# Cell 14: File system commands
%fs ls /

# Using dbutils
files = dbutils.fs.ls("/")
for file in files:
    print(f"{file.name} - {file.size} bytes")
```

### __Secrets Management__

```python
# Cell 15: Access secrets
# First, create secret scope (via CLI or API)

# Retrieve secret
storage_key = dbutils.secrets.get(scope="my-scope", key="storage-key")

# Use secret (value hidden in logs)
print(f"Secret retrieved: {'*' * 10}")
```

### __Notebook Workflows__

```python
# Cell 16: Run another notebook
result = dbutils.notebook.run(
    "/Users/user@example.com/data-processing",
    timeout_seconds=300,
    arguments={"date": "2024-01-01"}
)
print(f"Result: {result}")
```

## 📝 Best Practices

### __1. Document Your Code__

```markdown
%md
# Data Processing Pipeline

## Overview
This notebook processes sales data from ADLS Gen2.

## Steps
1. Load raw data
2. Clean and transform
3. Save to Delta Lake

## Author: Your Name
## Last Updated: 2024-01-09
```

### __2. Organize with Sections__

```python
# === Configuration ===
storage_account = "mystorageaccount"
container = "data"

# === Data Loading ===
df = spark.read.csv(f"abfss://{container}@{storage_account}.dfs.core.windows.net/sales.csv")

# === Data Processing ===
df_clean = df.filter(col("amount") > 0)

# === Save Results ===
df_clean.write.format("delta").save("/mnt/processed/sales")
```

### __3. Use Functions for Reusability__

```python
# Cell 17: Define reusable functions
def load_data(path, format="csv"):
    """Load data from storage"""
    return spark.read.format(format) \
        .option("header", "true") \
        .option("inferSchema", "true") \
        .load(path)

def save_to_delta(df, table_name):
    """Save DataFrame to Delta table"""
    df.write.format("delta") \
        .mode("overwrite") \
        .saveAsTable(table_name)
    print(f"✅ Saved to {table_name}")
```

### __4. Error Handling__

```python
# Cell 18: Implement error handling
try:
    df = spark.read.csv("/path/to/file.csv")
    print(f"✅ Loaded {df.count()} rows")
except Exception as e:
    print(f"❌ Error loading data: {str(e)}")
    # Handle error or log
```

## 🤝 Collaboration Features

### __Comments__

```python
# Cell 19: Add comments to cells
# Click the comment icon in the cell menu
# Team members can reply to comments
# Use @mention to notify specific users

print("Code with comments for team review")
```

### __Version Control__

1. __Git Integration__
   - Workspace → Settings → Git Integration
   - Connect to Azure DevOps or GitHub
   - Commit, push, pull directly from notebooks

2. __Revision History__
   - File → Revision History
   - See all changes
   - Restore previous versions

### __Sharing__

1. __Share Notebook__
   - Click "Share" button
   - Set permissions:
     - Can View
     - Can Run
     - Can Edit
     - Can Manage

2. __Export Notebook__
   - File → Export
   - Formats: DBC, HTML, iPython, Source File

## ⚡ Advanced Features

### __Parameterized Notebooks__

```python
# Cell 20: Define parameters
dbutils.widgets.text("date", "2024-01-01")
dbutils.widgets.text("environment", "prod")

# Use in code
process_date = dbutils.widgets.get("date")
env = dbutils.widgets.get("environment")

print(f"Processing data for {process_date} in {env}")
```

### __Databricks Connect__

Run notebooks from local IDE:

```python
# Local development
from databricks.connect import DatabricksSession

spark = DatabricksSession.builder \
    .remote(
        host="<workspace-url>",
        token="<personal-access-token>",
        cluster_id="<cluster-id>"
    ) \
    .getOrCreate()
```

### __Notebook Jobs__

Schedule notebooks:

1. Workflows → Create Job
2. Add notebook task
3. Set schedule (cron)
4. Configure cluster
5. Set parameters
6. Enable notifications

## 🔧 Troubleshooting

### __Common Issues__

__Cell Won't Execute__

- ✅ Check cluster status (running?)
- ✅ Verify cluster attached to notebook
- ✅ Check for syntax errors

__Cannot See Widget__

- ✅ Run widget creation cell
- ✅ Check if widgets hidden (View → Show Widgets)
- ✅ Clear output and re-run

__Import Errors__

- ✅ Install library on cluster
- ✅ Use `%pip install package-name`
- ✅ Restart Python kernel

__Notebook Too Slow__

- ✅ Clear unused DataFrames
- ✅ Unpersist cached data
- ✅ Restart cluster
- ✅ Use larger cluster

## 🎓 Practice Exercises

### __Exercise 1: Interactive Dashboard__

Create a notebook with:

- [ ] Dropdown for date range selection
- [ ] Load data based on selection
- [ ] Display summary statistics
- [ ] Show 3 different visualizations

### __Exercise 2: Reusable Functions__

Build a notebook library with:

- [ ] Data loading functions
- [ ] Transformation utilities
- [ ] Validation checks
- [ ] Error handling

### __Exercise 3: Multi-Language Pipeline__

Create pipeline using:

- [ ] Python for data loading
- [ ] SQL for aggregations
- [ ] Python for ML model
- [ ] SQL for results

## 📚 Additional Resources

### __Documentation__

- [Databricks Notebooks Guide](https://learn.microsoft.com/azure/databricks/notebooks/)
- [Notebook Utilities](https://learn.microsoft.com/azure/databricks/dev-tools/databricks-utils)
- [Visualization Guide](https://learn.microsoft.com/azure/databricks/visualizations/)

### __Next Tutorials__

- [Delta Lake Basics](delta-lake-basics.md) - Work with Delta tables
- [Spark SQL Tutorial](../intermediate/spark-sql-tutorial.md)
- [ML on Databricks](../intermediate/ml-databricks.md)

## 🎉 Summary

You've learned:

✅ Notebook structure and features
✅ Multi-language support
✅ Visualization techniques
✅ Interactive widgets
✅ Collaboration features
✅ Best practices

Ready to build interactive data applications!

---

*Last Updated: January 2025*
*Tutorial Version: 1.0*
