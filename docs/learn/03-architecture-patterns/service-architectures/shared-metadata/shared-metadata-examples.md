# Azure Synapse Shared Metadata - Code Examples

[Home](../../../README.md) > [Architecture](../../README.md) > Shared Metadata > Code Examples

This document provides practical code examples for implementing the shared metadata architecture in Azure Synapse Analytics, focusing on serverless replicated databases, three-part naming solutions, and best practices for implementing layered architectures.

## Creating and Synchronizing Databases Between Spark and Serverless SQL

### Creating a Database and Table in Spark

```python
# In a Spark notebook
# Create a new database
spark.sql("CREATE DATABASE IF NOT EXISTS sales_db")

# Create a table using Parquet format (will be synchronized to SQL)
spark.sql("""
CREATE TABLE IF NOT EXISTS sales_db.transactions (
    transaction_id STRING,
    customer_id STRING,
    product_id STRING,
    quantity INT,
    price DECIMAL(10,2),
    transaction_date DATE,
    store_id STRING
) USING PARQUET
""")

# Insert sample data
spark.sql("""
INSERT INTO sales_db.transactions VALUES 
('T1001', 'C100', 'P5001', 2, 120.50, '2023-02-15', 'S001'),
('T1002', 'C102', 'P5002', 1, 89.99, '2023-02-15', 'S002'),
('T1003', 'C100', 'P5003', 3, 25.25, '2023-02-16', 'S001'),
('T1004', 'C103', 'P5001', 1, 120.50, '2023-02-16', 'S003')
""")
```

### Accessing the Synchronized Table from Serverless SQL

```sql
-- Connect to Serverless SQL Pool
-- The database has been automatically created and synchronized

-- View available tables in the synchronized database
USE sales_db;
SELECT * FROM sys.tables;

-- Query the synchronized table
-- Note the "dbo" schema - tables appear in the dbo schema in SQL
SELECT * 
FROM sales_db.dbo.transactions
WHERE transaction_date = '2023-02-15';

-- Using three-part naming
SELECT t.customer_id, SUM(t.price * t.quantity) AS total_spent
FROM sales_db.dbo.transactions t
GROUP BY t.customer_id
ORDER BY total_spent DESC;
```

## Working with Delta Tables

```python
# In a Spark notebook
# Create a Delta table (will be synchronized to SQL)
spark.sql("CREATE DATABASE IF NOT EXISTS inventory_db")

spark.sql("""
CREATE TABLE IF NOT EXISTS inventory_db.product_inventory (
    product_id STRING,
    product_name STRING,
    category STRING,
    quantity_on_hand INT,
    reorder_level INT,
    last_updated TIMESTAMP
) USING DELTA
""")

# Insert sample data
spark.sql("""
INSERT INTO inventory_db.product_inventory VALUES 
('P5001', 'Premium Widget', 'Widgets', 350, 100, current_timestamp()),
('P5002', 'Standard Widget', 'Widgets', 500, 150, current_timestamp()),
('P5003', 'Economy Gadget', 'Gadgets', 275, 75, current_timestamp()),
('P5004', 'Premium Gadget', 'Gadgets', 120, 50, current_timestamp())
""")

# Update data - these changes will be synchronized to SQL
spark.sql("""
UPDATE inventory_db.product_inventory 
SET quantity_on_hand = 300, last_updated = current_timestamp()
WHERE product_id = 'P5001'
""")
```

### Querying Delta Table from Serverless SQL

```sql
-- Delta tables are also synchronized (in preview)
SELECT * FROM inventory_db.dbo.product_inventory
WHERE category = 'Widgets';

-- Join with the sales data from another database
SELECT 
    i.product_id,
    i.product_name,
    i.quantity_on_hand,
    SUM(t.quantity) AS quantity_sold,
    SUM(t.price * t.quantity) AS total_revenue
FROM inventory_db.dbo.product_inventory i
JOIN sales_db.dbo.transactions t ON i.product_id = t.product_id
GROUP BY 
    i.product_id,
    i.product_name,
    i.quantity_on_hand
ORDER BY total_revenue DESC;
```

## Managing Schema Evolution

### Adding Columns in Spark (Synchronized to SQL)

```python
# Add a column to existing table in Spark
spark.sql("""
ALTER TABLE sales_db.transactions 
ADD COLUMN payment_method STRING
""")

# Update the new column
spark.sql("""
UPDATE sales_db.transactions
SET payment_method = 
    CASE 
        WHEN transaction_id = 'T1001' THEN 'Credit Card'
        WHEN transaction_id = 'T1002' THEN 'Cash'
        WHEN transaction_id = 'T1003' THEN 'Credit Card'
        WHEN transaction_id = 'T1004' THEN 'Digital Wallet'
    END
""")
```

### Querying Updated Schema in SQL

```sql
-- The new column is now available in SQL after synchronization
SELECT 
    transaction_id, 
    customer_id,
    payment_method,
    price * quantity AS total
FROM sales_db.dbo.transactions
WHERE payment_method = 'Credit Card';
```

## Implementing Layered Architecture with Shared Metadata

### Raw Layer (Direct Access, Minimal Shared Metadata)

```python
# In Spark, create a database for raw data
spark.sql("CREATE DATABASE IF NOT EXISTS raw_data")

# Create external table pointing to raw data files
spark.sql("""
CREATE TABLE raw_data.customer_raw (
    customer_data STRING
) USING CSV
LOCATION 'abfss://datalake@storageaccount.dfs.core.windows.net/raw/customers/'
OPTIONS (header 'true', inferSchema 'true')
""")
```

### Silver Layer (Apply Shared Metadata)

```python
# Create curated database for transformed/validated data
spark.sql("CREATE DATABASE IF NOT EXISTS silver_db")

# Transform raw data into structured format with proper data types
spark.sql("""
CREATE TABLE silver_db.customers
USING PARQUET
AS
SELECT 
    from_json(customer_data, 'id STRING, name STRING, email STRING, signup_date DATE') AS customer
FROM raw_data.customer_raw
""")

# Flatten the structure for easier access
spark.sql("""
CREATE TABLE silver_db.customers_flattened
USING PARQUET
AS
SELECT 
    customer.id AS customer_id,
    customer.name AS full_name,
    customer.email,
    customer.signup_date
FROM silver_db.customers
""")
```

### Gold Layer (Business-Ready Data with Full Shared Metadata)

```python
# Create business-ready database
spark.sql("CREATE DATABASE IF NOT EXISTS gold_db")

# Create business metrics table that joins data from multiple sources
spark.sql("""
CREATE TABLE gold_db.customer_sales_summary
USING DELTA
AS
SELECT 
    c.customer_id,
    c.full_name,
    c.email,
    COUNT(t.transaction_id) AS total_transactions,
    SUM(t.price * t.quantity) AS total_spent,
    MAX(t.transaction_date) AS last_purchase_date
FROM silver_db.customers_flattened c
LEFT JOIN sales_db.transactions t ON c.customer_id = t.customer_id
GROUP BY c.customer_id, c.full_name, c.email
""")
```

### Accessing the Layered Architecture from SQL

```sql
-- Raw layer is typically accessed directly in Spark, not via shared metadata

-- Silver layer via shared metadata
SELECT * FROM silver_db.dbo.customers_flattened
WHERE signup_date >= '2023-01-01';

-- Gold layer via shared metadata
SELECT 
    customer_id,
    full_name,
    total_transactions,
    total_spent,
    CASE 
        WHEN total_spent > 1000 THEN 'Premium'
        WHEN total_spent > 500 THEN 'Standard'
        ELSE 'Basic'
    END AS customer_tier
FROM gold_db.dbo.customer_sales_summary
ORDER BY total_spent DESC;
```

## Working with Manual External Tables for Non-Synchronized Formats

If you have data in formats not automatically synchronized from Spark (like JSON, ORC), you can manually create external tables in serverless SQL:

```sql
-- Create an external data source if you don't have one
CREATE DATABASE scoped CREDENTIAL [SasCredential]
WITH IDENTITY='SHARED ACCESS SIGNATURE',
SECRET = 'sv=2020-02-10&ss=bfqt&srt=sco&sp=rwdlacupx&se=2023-04-15T01:15:28Z&st=2021-03-15T17:15:28Z&spr=https&sig=XXXXX'

CREATE EXTERNAL DATA SOURCE ExternalDataSource
WITH (
    LOCATION = 'https://storageaccount.dfs.core.windows.net/datalake',
    CREDENTIAL = [SasCredential]
)

-- Create an external file format for JSON
CREATE EXTERNAL FILE FORMAT JsonFormat
WITH (
    FORMAT_TYPE = JSON
)

-- Create an external table for JSON data
CREATE EXTERNAL TABLE external_db.customer_preferences (
    customer_id VARCHAR(50),
    preferences NVARCHAR(MAX)
)
WITH (
    LOCATION = '/analytics/customer-preferences/',
    DATA_SOURCE = ExternalDataSource,
    FILE_FORMAT = JsonFormat
)
```

## Monitoring Metadata Synchronization

```sql
-- Check if tables have been synchronized correctly
USE sales_db;
SELECT 
    name, 
    create_date, 
    modify_date,
    type_desc
FROM sys.tables;

-- Check external data sources
SELECT * FROM sys.external_data_sources;

-- Check external file formats
SELECT * FROM sys.external_file_formats;

-- View column definitions
SELECT 
    t.name AS table_name,
    c.name AS column_name,
    ty.name AS data_type,
    c.max_length,
    c.precision,
    c.scale,
    c.is_nullable
FROM sys.tables t
JOIN sys.columns c ON t.object_id = c.object_id
JOIN sys.types ty ON c.user_type_id = ty.user_type_id
WHERE t.name = 'transactions'
ORDER BY c.column_id;
```

These code examples demonstrate how to implement the shared metadata architecture in Azure Synapse Analytics using best practices for serverless replicated databases, handling three-part naming, and implementing a layered data architecture.
