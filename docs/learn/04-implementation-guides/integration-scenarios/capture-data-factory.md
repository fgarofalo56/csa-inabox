# Change Data Capture with Azure Data Factory

> __[Home](../../../README.md)__ | __[Implementation](../README.md)__ | __[Integration](README.md)__ | __Data Factory CDC__

![Status](https://img.shields.io/badge/Status-Active-brightgreen?style=flat-square)
![Complexity](https://img.shields.io/badge/Complexity-Intermediate-yellow?style=flat-square)

Implement incremental data loading using Azure Data Factory's CDC capabilities.

---

## Overview

Azure Data Factory provides native CDC support for capturing and processing data changes from various sources.

### Supported Sources

- SQL Server (with CT/CDC enabled)
- Azure SQL Database
- Azure Cosmos DB (Change Feed)
- SAP systems
- Oracle (with LogMiner)

---

## Implementation

### Step 1: Enable CDC on Source

```sql
-- Enable CDC on Azure SQL Database
EXEC sys.sp_cdc_enable_db;

-- Enable CDC on specific table
EXEC sys.sp_cdc_enable_table
    @source_schema = N'Sales',
    @source_name = N'Orders',
    @role_name = NULL,
    @supports_net_changes = 1;

-- Verify CDC is enabled
SELECT name, is_cdc_enabled FROM sys.databases WHERE name = DB_NAME();
```

### Step 2: Create CDC Pipeline in Data Factory

```json
{
    "name": "CDC_Orders_Pipeline",
    "properties": {
        "activities": [
            {
                "name": "GetChangeData",
                "type": "Copy",
                "inputs": [
                    {
                        "referenceName": "SqlServerCDCSource",
                        "type": "DatasetReference"
                    }
                ],
                "outputs": [
                    {
                        "referenceName": "DeltaLakeSink",
                        "type": "DatasetReference"
                    }
                ],
                "typeProperties": {
                    "source": {
                        "type": "SqlServerSource",
                        "sqlReaderQuery": {
                            "value": "@concat('SELECT * FROM cdc.fn_cdc_get_net_changes_Sales_Orders(@from_lsn, @to_lsn, ''all'')')",
                            "type": "Expression"
                        }
                    },
                    "sink": {
                        "type": "DeltaSink",
                        "writeBatchSize": 10000,
                        "deltaTableName": "orders_cdc"
                    },
                    "enableStaging": false
                }
            }
        ],
        "parameters": {
            "from_lsn": { "type": "string" },
            "to_lsn": { "type": "string" }
        }
    }
}
```

### Step 3: Watermark Management

```json
{
    "name": "CDC_With_Watermark",
    "properties": {
        "activities": [
            {
                "name": "LookupLastWatermark",
                "type": "Lookup",
                "typeProperties": {
                    "source": {
                        "type": "AzureSqlSource",
                        "sqlReaderQuery": "SELECT MAX(lsn) as last_lsn FROM watermark_table WHERE table_name = 'Orders'"
                    },
                    "dataset": {
                        "referenceName": "WatermarkDataset",
                        "type": "DatasetReference"
                    }
                }
            },
            {
                "name": "GetCurrentLSN",
                "type": "Lookup",
                "typeProperties": {
                    "source": {
                        "type": "SqlServerSource",
                        "sqlReaderQuery": "SELECT sys.fn_cdc_get_max_lsn() as current_lsn"
                    }
                }
            },
            {
                "name": "CopyChanges",
                "type": "Copy",
                "dependsOn": [
                    { "activity": "LookupLastWatermark", "dependencyConditions": ["Succeeded"] },
                    { "activity": "GetCurrentLSN", "dependencyConditions": ["Succeeded"] }
                ],
                "typeProperties": {
                    "source": {
                        "type": "SqlServerSource",
                        "sqlReaderQuery": {
                            "value": "@concat('DECLARE @from_lsn binary(10) = 0x', activity('LookupLastWatermark').output.firstRow.last_lsn, '; DECLARE @to_lsn binary(10) = 0x', activity('GetCurrentLSN').output.firstRow.current_lsn, '; SELECT * FROM cdc.fn_cdc_get_net_changes_Sales_Orders(@from_lsn, @to_lsn, ''all'')')",
                            "type": "Expression"
                        }
                    }
                }
            },
            {
                "name": "UpdateWatermark",
                "type": "SqlServerStoredProcedure",
                "dependsOn": [
                    { "activity": "CopyChanges", "dependencyConditions": ["Succeeded"] }
                ],
                "typeProperties": {
                    "storedProcedureName": "usp_UpdateWatermark",
                    "storedProcedureParameters": {
                        "table_name": { "value": "Orders" },
                        "lsn": { "value": { "value": "@activity('GetCurrentLSN').output.firstRow.current_lsn", "type": "Expression" } }
                    }
                }
            }
        ]
    }
}
```

### Step 4: Apply Changes to Delta Lake

```python
# Databricks notebook to merge CDC changes
from delta.tables import DeltaTable

def apply_cdc_changes(cdc_path: str, target_table: str):
    """Apply CDC changes using MERGE."""

    # Read CDC data
    cdc_df = spark.read.format("delta").load(cdc_path)

    # Get target table
    target = DeltaTable.forName(spark, target_table)

    # Merge changes
    target.alias("target").merge(
        cdc_df.alias("source"),
        "target.order_id = source.order_id"
    ).whenMatchedUpdate(
        condition="source.__$operation = 4",  # Update
        set={
            "customer_id": "source.customer_id",
            "order_date": "source.order_date",
            "amount": "source.amount",
            "updated_at": "current_timestamp()"
        }
    ).whenMatchedDelete(
        condition="source.__$operation = 1"  # Delete
    ).whenNotMatchedInsert(
        condition="source.__$operation = 2",  # Insert
        values={
            "order_id": "source.order_id",
            "customer_id": "source.customer_id",
            "order_date": "source.order_date",
            "amount": "source.amount",
            "created_at": "current_timestamp()",
            "updated_at": "current_timestamp()"
        }
    ).execute()
```

---

## Cosmos DB Change Feed Integration

```json
{
    "name": "CosmosDB_ChangeFeed_Pipeline",
    "properties": {
        "activities": [
            {
                "name": "CopyChangeFeed",
                "type": "Copy",
                "typeProperties": {
                    "source": {
                        "type": "CosmosDbSqlApiSource",
                        "preferredRegions": ["East US"],
                        "detectDatetime": true
                    },
                    "sink": {
                        "type": "DeltaSink"
                    }
                }
            }
        ]
    }
}
```

---

## Monitoring and Alerting

```json
{
    "name": "CDC_Monitor",
    "properties": {
        "activities": [
            {
                "name": "CheckCDCLatency",
                "type": "Lookup",
                "typeProperties": {
                    "source": {
                        "type": "SqlServerSource",
                        "sqlReaderQuery": "SELECT DATEDIFF(MINUTE, MAX(tran_end_time), GETDATE()) as latency_minutes FROM cdc.lsn_time_mapping"
                    }
                }
            },
            {
                "name": "AlertOnHighLatency",
                "type": "WebActivity",
                "dependsOn": [
                    { "activity": "CheckCDCLatency", "dependencyConditions": ["Succeeded"] }
                ],
                "typeProperties": {
                    "url": "https://your-logic-app-url",
                    "method": "POST",
                    "body": {
                        "value": "@json(concat('{\"latency\":', activity('CheckCDCLatency').output.firstRow.latency_minutes, '}'))",
                        "type": "Expression"
                    }
                },
                "condition": "@greater(activity('CheckCDCLatency').output.firstRow.latency_minutes, 30)"
            }
        ]
    }
}
```

---

## Related Documentation

- [Databricks CDC](capture-databricks.md)
- [Synapse CDC](capture-synapse-analytics.md)
- [Data Factory Best Practices](../../05-best-practices/service-specific/data-factory.md)

---

*Last Updated: January 2025*
