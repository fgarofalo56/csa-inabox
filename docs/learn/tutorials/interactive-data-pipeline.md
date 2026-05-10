# Interactive Tutorial: End-to-End Data Pipeline in Synapse Analytics

[Home](../../README.md) > Tutorials > Interactive Data Pipeline

This interactive tutorial guides you through building a complete data pipeline in Azure Synapse Analytics, from data ingestion to transformation and visualization. Follow along with notebook examples, pipeline templates, and step-by-step instructions.

## Introduction

In this tutorial, you'll learn how to:

1. Set up a data source connection
2. Ingest data using Synapse pipelines
3. Transform data using Spark pools
4. Create a Delta Lake table
5. Query data using Serverless SQL
6. Visualize results with Power BI integration

The entire tutorial is designed to be completed in approximately 2-3 hours, depending on your familiarity with Azure Synapse Analytics.

## Prerequisites

Before you begin, ensure you have:

- An Azure subscription with permissions to create resources
- A Synapse Analytics workspace with:
  - Spark pool (Small or Medium size)
  - Serverless SQL pool
  - Storage account with ADLS Gen2
- Sample data files (provided in the tutorial)
- Power BI Desktop (optional for visualization section)

## Setup: Create Resources and Sample Data

### Step 1: Download the Tutorial Files

1. Download the tutorial files from our GitHub repository:

```bash
git clone https://github.com/microsoft/synapse-tutorials.git
cd synapse-tutorials/end-to-end-pipeline
```

1. Upload the sample data to your storage account using the Azure Storage Explorer or the following PowerShell script:

```powershell
$storageAccountName = "your-storage-account-name"
$containerName = "tutorial"
$localFolderPath = "./sample-data"

# Create context
$ctx = New-AzStorageContext -StorageAccountName $storageAccountName -UseConnectedAccount

# Create container if it doesn't exist
New-AzStorageContainer -Name $containerName -Context $ctx -ErrorAction SilentlyContinue

# Upload files
$files = Get-ChildItem -Path $localFolderPath -File
foreach ($file in $files) {
    Set-AzStorageBlobContent -File $file.FullName -Container $containerName -Blob "raw/sales/$($file.Name)" -Context $ctx
}

Write-Output "Sample data uploaded successfully to $storageAccountName/$containerName/raw/sales/"
```

### Step 2: Set Up Linked Service for Sample Data

1. In Synapse Studio, navigate to __Manage__ > __Linked services__
2. Click __+ New__ to create a new linked service
3. Select __Azure Data Lake Storage Gen2__ and click __Continue__
4. Configure the linked service:
   - Name: `TutorialDataStorage`
   - Authentication method: Select appropriate method (Managed Identity recommended)
   - Account selection method: From Azure subscription
   - Azure subscription: Select your subscription
   - Storage account name: Select your storage account
   - Test connection: Verify connection succeeds
5. Click __Create__

## Part 1: Data Ingestion with Synapse Pipeline

### Step 1: Create a Pipeline

1. In Synapse Studio, navigate to __Integrate__
2. Click __+__ > __Pipeline__
3. Name your pipeline `SalesPipeline`

### Step 2: Add Copy Data Activity

1. In the Activities pane, expand __Move & Transform__ and drag a __Copy data__ activity to the pipeline canvas
2. Select the Copy data activity and configure:
   - __Source tab__:
     - Source dataset: Click __+ New__
     - Select __Azure Data Lake Storage Gen2__ > __DelimitedText__
     - Name: `SalesRawData`
     - Linked service: Select `TutorialDataStorage`
     - File path: Browse to `/tutorial/raw/sales/`
     - First row as header: Checked
     - Import schema: From connection/store
   - __Sink tab__:
     - Sink dataset: Click __+ New__
     - Select __Azure Data Lake Storage Gen2__ > __DelimitedText__
     - Name: `SalesStaging`
     - Linked service: Select `TutorialDataStorage`
     - File path: Type `/tutorial/staging/sales/`
     - First row as header: Checked
3. In the __Mapping tab__, click __Import schemas__ and verify column mappings

### Step 3: Add Parameters and Trigger Settings

1. Go to the __Parameters__ tab for your pipeline
2. Add a parameter:
   - Name: `ProcessDate`
   - Type: String
   - Default value: `@utcnow('yyyy-MM-dd')`
3. Configure the Copy activity:
   - Select the Copy activity
   - Go to __Sink__ > __SalesStaging dataset__ > __Parameters__
   - Set File path to: `/tutorial/staging/sales/@{pipeline().parameters.ProcessDate}/`

### Step 4: Run the Pipeline

1. Click __Debug__ to run the pipeline
2. Monitor the pipeline execution in the __Output__ tab
3. Once completed, verify data was copied to the staging folder

## Part 2: Data Transformation with Spark

### Step 1: Create a Spark Notebook

1. In Synapse Studio, navigate to __Develop__
2. Click __+__ > __Notebook__
3. Name your notebook `SalesTransformation`
4. Connect to your Spark pool

### Step 2: Read and Transform the Data

Add the following code to your notebook cells:

```python
# Cell 1: Set up parameters and paths
from pyspark.sql.functions import col, to_date, year, month, dayofmonth, hour, minute, sum, avg, count
from pyspark.sql.types import DoubleType, IntegerType
import datetime

# Get current date for folder path
process_date = datetime.datetime.now().strftime("%Y-%m-%d")
staging_path = f"abfss://tutorial@<your-storage-account-name>.dfs.core.windows.net/staging/sales/{process_date}"
curated_path = "abfss://tutorial@<your-storage-account-name>.dfs.core.windows.net/curated/sales"

print(f"Processing data from {staging_path}")
```

```python
# Cell 2: Read the staging data
df_sales = spark.read.format("csv") \
    .option("header", "true") \
    .option("inferSchema", "true") \
    .load(staging_path)

# Display the schema and sample data
df_sales.printSchema()
df_sales.show(5)
```

```python
# Cell 3: Transform and clean the data
# Convert string columns to appropriate types
df_transformed = df_sales \
    .withColumn("SaleAmount", col("SaleAmount").cast(DoubleType())) \
    .withColumn("Quantity", col("Quantity").cast(IntegerType())) \
    .withColumn("SaleDate", to_date(col("SaleDate"), "yyyy-MM-dd"))

# Add date dimension columns for analysis
df_transformed = df_transformed \
    .withColumn("Year", year(col("SaleDate"))) \
    .withColumn("Month", month(col("SaleDate"))) \
    .withColumn("Day", dayofmonth(col("SaleDate")))

# Show transformed data
df_transformed.show(5)
```

```python
# Cell 4: Create aggregations for analysis
# Sales by product
df_product_sales = df_transformed \
    .groupBy("ProductID", "ProductName", "Year", "Month") \
    .agg(
        sum("SaleAmount").alias("TotalSales"),
        sum("Quantity").alias("TotalQuantity"),
        count("*").alias("TransactionCount")
    )

# Display results
df_product_sales.show(5)
```

```python
# Cell 5: Save data as Delta tables
# Save detailed sales data
df_transformed.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .save(f"{curated_path}/detailed")

# Save aggregated sales data
df_product_sales.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .partitionBy("Year", "Month") \
    .save(f"{curated_path}/aggregated")

print("Data successfully transformed and saved as Delta tables")
```

```python
# Cell 6: Create Spark SQL tables for the data
# Create database if not exists
spark.sql("CREATE DATABASE IF NOT EXISTS sales")

# Create tables pointing to Delta locations
spark.sql(f"""
CREATE TABLE IF NOT EXISTS sales.detailed_sales 
USING DELTA
LOCATION '{curated_path}/detailed'
""")

spark.sql(f"""
CREATE TABLE IF NOT EXISTS sales.product_sales_monthly 
USING DELTA
LOCATION '{curated_path}/aggregated'
""")

# Verify tables
spark.sql("SHOW TABLES IN sales").show()
```

### Step 3: Run the Notebook

1. Replace `<your-storage-account-name>` with your actual storage account name
2. Run each cell in sequence by clicking the __▶__ button
3. Review the output of each cell to ensure it executes correctly

## Part 3: Query Data with Serverless SQL

### Step 1: Navigate to Serverless SQL

1. In Synapse Studio, click on __Data__ in the left navigation
2. Expand your workspace and select __Built-in__
3. Navigate to __Lake database__ > __sales__
4. You should see the tables created by Spark: `detailed_sales` and `product_sales_monthly`

### Step 2: Create Views for Analysis

Run the following SQL queries:

```sql
-- Create a view for sales trends
CREATE OR ALTER VIEW sales.vw_SalesTrends AS
SELECT 
    Year,
    Month,
    ProductName,
    TotalSales,
    TotalQuantity,
    TotalSales / TotalQuantity AS AvgPricePerUnit
FROM 
    sales.product_sales_monthly
WHERE 
    TotalQuantity > 0;
```

```sql
-- Create a view for product performance ranking
CREATE OR ALTER VIEW sales.vw_ProductPerformance AS
WITH ProductRanking AS (
    SELECT 
        ProductName,
        SUM(TotalSales) AS TotalRevenue,
        SUM(TotalQuantity) AS TotalUnitsSold,
        RANK() OVER(ORDER BY SUM(TotalSales) DESC) AS RevenuRank
    FROM 
        sales.product_sales_monthly
    GROUP BY 
        ProductName
)
SELECT 
    ProductName,
    TotalRevenue,
    TotalUnitsSold,
    RevenuRank,
    CASE 
        WHEN RevenuRank <= 3 THEN 'Top Performer'
        WHEN RevenuRank <= 10 THEN 'Strong Performer'
        WHEN RevenuRank <= 20 THEN 'Average Performer'
        ELSE 'Under Performer'
    END AS PerformanceCategory
FROM 
    ProductRanking;
```

### Step 3: Run Interactive Queries

Now run these analytical queries:

```sql
-- Monthly sales trend
SELECT 
    Year,
    Month,
    SUM(TotalSales) AS MonthlySales
FROM 
    sales.product_sales_monthly
GROUP BY 
    Year, Month
ORDER BY 
    Year, Month;
```

```sql
-- Top 10 products by revenue
SELECT TOP 10
    ProductName,
    TotalRevenue,
    TotalUnitsSold,
    PerformanceCategory
FROM 
    sales.vw_ProductPerformance
ORDER BY 
    RevenuRank;
```

## Part 4: Create an End-to-End Orchestrated Pipeline

Now let's combine all the steps into a single orchestrated pipeline:

### Step 1: Create a Master Pipeline

1. In Synapse Studio, navigate to __Integrate__
2. Click __+__ > __Pipeline__
3. Name your pipeline `MasterSalesPipeline`

### Step 2: Add the Copy Data Activity

1. Drag a __Copy data__ activity from the __Move & Transform__ category
2. Configure it exactly as in Part 1, using the same source and sink datasets

### Step 3: Add the Notebook Activity

1. Drag a __Notebook__ activity from the __Synapse__ category
2. Connect the Copy activity's output to the Notebook activity input
3. Configure the Notebook:
   - Notebook: Select `SalesTransformation`
   - Spark pool: Select your Spark pool
   - Base parameters: Leave empty (the notebook uses current date)

### Step 4: Configure Pipeline Success Email (Optional)

1. Drag a __Web__ activity from the __General__ category
2. Connect the Notebook activity's output to the Web activity input
3. Configure for sending an email notification using Logic Apps or other email service

### Step 5: Run the Master Pipeline

1. Click __Debug__ to test the pipeline
2. Monitor the execution in the pipeline canvas
3. Verify all activities complete successfully

## Part 5: Visualize Results with Power BI

### Step 1: Connect Power BI to Synapse

1. In Synapse Studio, navigate to __Develop__
2. Click __+__ > __Power BI__ > __Power BI report__
3. If prompted, sign in to your Power BI account

### Step 2: Create a Direct Query Report

1. Select __Build new report__
2. In the connection dialog:
   - Connect to: Select your Synapse workspace
   - SQL pool: Select __Built-in__
   - Database: Select __sales__
3. Choose DirectQuery mode

### Step 3: Design Visualizations

Create the following visualizations:

1. __Sales Trend Line Chart__:
   - Drag `vw_SalesTrends` to the canvas
   - Create a line chart with:
     - Axis: Month and Year
     - Values: TotalSales

2. __Product Performance Card__:
   - Create a table visualization with:
     - Values: ProductName, TotalRevenue, PerformanceCategory
   - Apply conditional formatting to PerformanceCategory

3. __Units Sold by Product Pie Chart__:
   - Create a pie chart with:
     - Legend: ProductName
     - Values: TotalUnitsSold

### Step 4: Save and Publish the Report

1. Save the report as `Sales Analysis Dashboard`
2. Click __Publish__ to publish to your Power BI workspace
3. Return to Synapse Studio and link the report to your workspace

## Part 6: Automate and Schedule

### Step 1: Create a Trigger for the Pipeline

1. In Synapse Studio, navigate to __Integrate__
2. Select your `MasterSalesPipeline`
3. Click __Add trigger__ > __New/Edit__
4. Configure a schedule trigger:
   - Type: Schedule
   - Start date: Select today's date
   - Recurrence: Daily
   - Time: Set to run during off-peak hours

### Step 2: Set Up Monitoring

1. Navigate to __Monitor__ in Synapse Studio
2. Select __Pipeline runs__
3. Configure pipeline run alerts:
   - Click __New alert rule__
   - Set condition: Failed pipeline runs
   - Set action group: Create a new action group for email notifications

## Conclusion and Next Steps

Congratulations! You've completed an end-to-end data pipeline in Azure Synapse Analytics that:

1. Ingests data from a source
2. Stages and transforms the data
3. Loads it into Delta Lake tables
4. Makes it available for SQL analysis
5. Visualizes the results with Power BI
6. Automates and orchestrates the entire process

### Next Steps

To extend this tutorial:

1. Add data quality validation steps
2. Implement incremental loading patterns
3. Add machine learning predictions to the pipeline
4. Integrate with Azure Purview for data governance
5. Implement CI/CD for your pipeline using Azure DevOps

## Troubleshooting

If you encounter issues during this tutorial, refer to the [Troubleshooting Guide](../troubleshooting/README.md) for common solutions to Synapse problems.

## Resources

- [Sample data and notebooks on GitHub](https://github.com/microsoft/synapse-tutorials)
- [Synapse Analytics Documentation](https://docs.microsoft.com/en-us/azure/synapse-analytics/)
- [Delta Lake Documentation](https://docs.delta.io/latest/index.html)
- [Power BI Documentation](https://docs.microsoft.com/en-us/power-bi/)
