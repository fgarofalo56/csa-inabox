# Change Data Capture with Synapse Analytics

> __[Home](../../../README.md)__ | __[Implementation](../README.md)__ | __[Integration](README.md)__ | __Synapse CDC__

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)

Implement CDC patterns using Azure Synapse Analytics pipelines and Spark pools.

---

## Overview

Synapse Analytics provides multiple CDC approaches:

- **Synapse Pipelines**: Native CDC connectors
- **Spark Pools**: Delta Lake CDC with Change Data Feed
- **Serverless SQL**: Query CDC data with OPENROWSET
- **Dedicated SQL**: Temporal tables and merge patterns

---

## Implementation

### Step 1: Pipeline-Based CDC

```json
{
    "name": "Synapse_CDC_Pipeline",
    "properties": {
        "activities": [
            {
                "name": "IncrementalCopy",
                "type": "Copy",
                "typeProperties": {
                    "source": {
                        "type": "AzureSqlSource",
                        "sqlReaderQuery": {
                            "value": "SELECT * FROM Sales.Orders WHERE ModifiedDate > '@{pipeline().parameters.LastWatermark}' AND ModifiedDate <= '@{pipeline().parameters.CurrentWatermark}'",
                            "type": "Expression"
                        }
                    },
                    "sink": {
                        "type": "ParquetSink",
                        "storeSettings": {
                            "type": "AzureBlobFSWriteSettings"
                        },
                        "formatSettings": {
                            "type": "ParquetWriteSettings"
                        }
                    }
                }
            }
        ],
        "parameters": {
            "LastWatermark": { "type": "string" },
            "CurrentWatermark": { "type": "string" }
        }
    }
}
```

### Step 2: Spark Pool CDC with Delta Lake

```python
# Synapse Spark notebook
from delta.tables import DeltaTable
from pyspark.sql.functions import *

# Enable Change Data Feed
spark.sql("""
    CREATE TABLE IF NOT EXISTS warehouse.orders (
        order_id BIGINT,
        customer_id STRING,
        order_date DATE,
        amount DECIMAL(18,2),
        status STRING
    )
    USING DELTA
    LOCATION 'abfss://warehouse@datalake.dfs.core.windows.net/orders'
    TBLPROPERTIES (delta.enableChangeDataFeed = true)
""")

# Read changes
def get_incremental_changes(table_name: str, start_version: int):
    """Read CDC changes from Delta table."""

    changes = spark.read.format("delta") \
        .option("readChangeFeed", "true") \
        .option("startingVersion", start_version) \
        .table(table_name)

    return changes

# Apply to downstream table
def sync_to_dedicated_pool(changes_df, target_schema: str, target_table: str):
    """Sync changes to dedicated SQL pool."""

    # Filter to latest state per key
    latest_changes = changes_df \
        .filter(col("_change_type") != "update_preimage") \
        .withColumn("rn", row_number().over(
            Window.partitionBy("order_id").orderBy(col("_commit_version").desc())
        )) \
        .filter(col("rn") == 1) \
        .drop("rn", "_change_type", "_commit_version", "_commit_timestamp")

    # Write to dedicated pool staging
    latest_changes.write \
        .format("com.databricks.spark.sqldw") \
        .option("url", jdbc_url) \
        .option("tempDir", "abfss://staging@datalake.dfs.core.windows.net/polybase") \
        .option("forwardSparkAzureStorageCredentials", "true") \
        .option("dbTable", f"{target_schema}.{target_table}_staging") \
        .mode("overwrite") \
        .save()
```

### Step 3: Dedicated SQL Pool Merge

```sql
-- Create staging table
CREATE TABLE staging.orders_cdc (
    order_id BIGINT,
    customer_id NVARCHAR(50),
    order_date DATE,
    amount DECIMAL(18,2),
    status NVARCHAR(20),
    operation_type CHAR(1)  -- I=Insert, U=Update, D=Delete
)
WITH (
    DISTRIBUTION = HASH(order_id),
    HEAP
);

-- Merge procedure
CREATE PROCEDURE dbo.usp_MergeOrdersCDC
AS
BEGIN
    -- Handle deletes
    DELETE FROM dbo.orders
    WHERE order_id IN (
        SELECT order_id FROM staging.orders_cdc WHERE operation_type = 'D'
    );

    -- Handle updates
    UPDATE t
    SET
        t.customer_id = s.customer_id,
        t.order_date = s.order_date,
        t.amount = s.amount,
        t.status = s.status,
        t.modified_date = GETDATE()
    FROM dbo.orders t
    INNER JOIN staging.orders_cdc s ON t.order_id = s.order_id
    WHERE s.operation_type = 'U';

    -- Handle inserts
    INSERT INTO dbo.orders (order_id, customer_id, order_date, amount, status, created_date)
    SELECT order_id, customer_id, order_date, amount, status, GETDATE()
    FROM staging.orders_cdc
    WHERE operation_type = 'I'
    AND order_id NOT IN (SELECT order_id FROM dbo.orders);

    -- Clear staging
    TRUNCATE TABLE staging.orders_cdc;
END;
```

### Step 4: Serverless SQL CDC Queries

```sql
-- Query CDC data directly from Data Lake
SELECT
    _change_type,
    _commit_version,
    _commit_timestamp,
    order_id,
    customer_id,
    amount
FROM OPENROWSET(
    BULK 'https://datalake.dfs.core.windows.net/warehouse/orders/_change_data/',
    FORMAT = 'DELTA'
) AS changes
WHERE _commit_timestamp > DATEADD(hour, -24, GETUTCDATE());

-- Create view for CDC monitoring
CREATE VIEW vw_orders_cdc_summary AS
SELECT
    CAST(_commit_timestamp AS DATE) as change_date,
    _change_type,
    COUNT(*) as change_count
FROM OPENROWSET(
    BULK 'https://datalake.dfs.core.windows.net/warehouse/orders/_change_data/',
    FORMAT = 'DELTA'
) AS changes
GROUP BY CAST(_commit_timestamp AS DATE), _change_type;
```

### Step 5: Temporal Tables for History

```sql
-- Create temporal table in dedicated pool
CREATE TABLE dbo.orders_temporal (
    order_id BIGINT NOT NULL,
    customer_id NVARCHAR(50),
    order_date DATE,
    amount DECIMAL(18,2),
    status NVARCHAR(20),
    valid_from DATETIME2 GENERATED ALWAYS AS ROW START,
    valid_to DATETIME2 GENERATED ALWAYS AS ROW END,
    PERIOD FOR SYSTEM_TIME (valid_from, valid_to),
    CONSTRAINT PK_orders_temporal PRIMARY KEY NONCLUSTERED (order_id)
)
WITH (
    DISTRIBUTION = HASH(order_id),
    SYSTEM_VERSIONING = ON (HISTORY_TABLE = history.orders)
);

-- Query historical data
SELECT * FROM dbo.orders_temporal
FOR SYSTEM_TIME AS OF '2024-01-15 10:00:00';

-- Query changes in time range
SELECT * FROM dbo.orders_temporal
FOR SYSTEM_TIME BETWEEN '2024-01-01' AND '2024-01-31';
```

---

## Orchestration Pattern

```json
{
    "name": "Full_CDC_Orchestration",
    "properties": {
        "activities": [
            {
                "name": "GetWatermarks",
                "type": "Lookup"
            },
            {
                "name": "ExtractChanges",
                "type": "Copy",
                "dependsOn": ["GetWatermarks"]
            },
            {
                "name": "TransformWithSpark",
                "type": "SynapseNotebook",
                "dependsOn": ["ExtractChanges"]
            },
            {
                "name": "LoadToDedicatedPool",
                "type": "SqlPoolStoredProcedure",
                "dependsOn": ["TransformWithSpark"]
            },
            {
                "name": "UpdateWatermarks",
                "type": "SqlServerStoredProcedure",
                "dependsOn": ["LoadToDedicatedPool"]
            }
        ]
    }
}
```

---

## Related Documentation

- [Data Factory CDC](capture-data-factory.md)
- [Databricks CDC](capture-databricks.md)
- [Synapse Best Practices](../../05-best-practices/service-specific/synapse-analytics.md)

---

*Last Updated: January 2025*
