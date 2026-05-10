---
title: "Tutorial 4: Batch Data Ingestion"
description: "__Build robust batch data ingestion pipelines using Azure Synapse Pipelines and Azure Data Factory. Learn to ingest multiple data formats, handle schema changes, and implement error handling.__"
tags:
  - tutorials
  - synapse
---
# 📥 Tutorial 4: Batch Data Ingestion

![Tutorial](https://img.shields.io/badge/Tutorial-04_Batch_Ingestion-blue)
![Duration](https://img.shields.io/badge/Duration-40_minutes-green)
![Level](https://img.shields.io/badge/Level-Intermediate-yellow)

__Build robust batch data ingestion pipelines using Azure Synapse Pipelines and Azure Data Factory. Learn to ingest multiple data formats, handle schema changes, and implement error handling.__

## 🎯 Learning Objectives

After completing this tutorial, you will be able to:

- ✅ __Create copy activities__ for ingesting data from various sources
- ✅ __Handle multiple data formats__ (CSV, JSON, Parquet, Avro)
- ✅ __Implement schema mapping__ and data type conversions
- ✅ __Configure error handling__ and data validation
- ✅ __Schedule and monitor__ pipeline executions

## ⏱️ Time Estimate: 40 minutes

- __Pipeline Creation__: 15 minutes
- __Data Format Handling__: 15 minutes
- __Error Handling & Testing__: 10 minutes

## 📋 Prerequisites

### __Completed Tutorials__

- [x] [Tutorial 1: Environment Setup](01-environment-setup.md)
- [x] [Tutorial 2: Workspace Basics](02-workspace-basics.md)
- [x] [Tutorial 3: Data Lake Setup](03-data-lake-setup.md)

### __Required Resources__

- [ ] Synapse workspace configured
- [ ] ADLS Gen2 storage with landing/raw/curated zones
- [ ] Sample datasets prepared

### __Verify Prerequisites__

```powershell
# Load workspace configuration
$config = Get-Content "workspace-config.json" | ConvertFrom-Json

# Verify storage containers exist
az storage fs list --account-name $config.StorageAccount --auth-mode login --output table
```

## 📊 Step 1: Prepare Sample Datasets

### __1.1 Create Sample CSV Data__

```powershell
# Create customer data CSV
$customerData = @"
CustomerID,FirstName,LastName,Email,Country,RegistrationDate
C001,John,Smith,john.smith@example.com,USA,2024-01-15
C002,Maria,Garcia,maria.garcia@example.com,Spain,2024-02-20
C003,Yuki,Tanaka,yuki.tanaka@example.com,Japan,2024-03-10
C004,Ahmed,Hassan,ahmed.hassan@example.com,Egypt,2024-03-15
C005,Emma,Johnson,emma.johnson@example.com,UK,2024-04-01
"@

$customerData | Out-File "customers.csv" -Encoding UTF8

# Upload to landing zone
az storage blob upload `
  --account-name $config.StorageAccount `
  --container-name "landing" `
  --name "customers/2024/customers.csv" `
  --file "customers.csv" `
  --auth-mode login

Write-Host "✅ Customer CSV uploaded to landing zone" -ForegroundColor Green
```

### __1.2 Create Sample JSON Data__

```powershell
# Create transaction data JSON
$transactions = @(
    @{TransactionID="T001"; CustomerID="C001"; Amount=125.50; ProductCategory="Electronics"; TransactionDate="2024-05-01T10:30:00Z"}
    @{TransactionID="T002"; CustomerID="C002"; Amount=45.99; ProductCategory="Books"; TransactionDate="2024-05-01T11:15:00Z"}
    @{TransactionID="T003"; CustomerID="C001"; Amount=299.99; ProductCategory="Clothing"; TransactionDate="2024-05-02T09:45:00Z"}
    @{TransactionID="T004"; CustomerID="C003"; Amount=89.00; ProductCategory="Electronics"; TransactionDate="2024-05-02T14:20:00Z"}
    @{TransactionID="T005"; CustomerID="C004"; Amount=12.50; ProductCategory="Books"; TransactionDate="2024-05-03T16:00:00Z"}
) | ConvertTo-Json

$transactions | Out-File "transactions.json" -Encoding UTF8

# Upload to landing zone
az storage blob upload `
  --account-name $config.StorageAccount `
  --container-name "landing" `
  --name "transactions/2024-05/transactions.json" `
  --file "transactions.json" `
  --auth-mode login

Write-Host "✅ Transaction JSON uploaded to landing zone" -ForegroundColor Green
```

### __1.3 Create Sample Parquet Data__

```python
# Create sample_parquet_generator.py
import pandas as pd
from datetime import datetime, timedelta

# Generate product catalog data
products = {
    'ProductID': [f'P{str(i).zfill(4)}' for i in range(1, 101)],
    'ProductName': [f'Product {i}' for i in range(1, 101)],
    'Category': ['Electronics', 'Books', 'Clothing', 'Home', 'Sports'] * 20,
    'Price': [round(10 + (i * 5.5), 2) for i in range(1, 101)],
    'StockQuantity': [50 + (i * 10) for i in range(1, 101)],
    'LastUpdated': [datetime.now() - timedelta(days=i) for i in range(100)]
}

df = pd.DataFrame(products)
df.to_parquet('product_catalog.parquet', index=False, engine='pyarrow')
print("✅ Parquet file created: product_catalog.parquet")
```

```powershell
# Run Python script to generate Parquet file
python sample_parquet_generator.py

# Upload to landing zone
az storage blob upload `
  --account-name $config.StorageAccount `
  --container-name "landing" `
  --name "products/product_catalog.parquet" `
  --file "product_catalog.parquet" `
  --auth-mode login

Write-Host "✅ Product Parquet uploaded to landing zone" -ForegroundColor Green
```

## 🔧 Step 2: Create Datasets in Synapse

### __2.1 Create Source Dataset for CSV__

**Via Synapse Studio**:

```text
1. Navigate to Data → Linked → Click on storage account
2. Right-click "landing" container → New dataset
3. Select format: "Delimited Text"
4. Configuration:
   - Name: "ds_customers_csv"
   - Linked service: WorkspaceStorage
   - File path: landing/customers/2024/
   - First row as header: Yes
   - Import schema: From connection/store
5. Click "OK" → Publish
```

**Via Azure CLI (JSON Definition)**:

```powershell
# Create dataset JSON
$csvDataset = @"
{
  "name": "ds_customers_csv",
  "properties": {
    "linkedServiceName": {
      "referenceName": "WorkspaceStorage",
      "type": "LinkedServiceReference"
    },
    "type": "DelimitedText",
    "typeProperties": {
      "location": {
        "type": "AzureBlobFSLocation",
        "fileName": "customers.csv",
        "folderPath": "customers/2024",
        "fileSystem": "landing"
      },
      "columnDelimiter": ",",
      "escapeChar": "\\",
      "firstRowAsHeader": true,
      "quoteChar": "\""
    },
    "schema": [
      {"name": "CustomerID", "type": "String"},
      {"name": "FirstName", "type": "String"},
      {"name": "LastName", "type": "String"},
      {"name": "Email", "type": "String"},
      {"name": "Country", "type": "String"},
      {"name": "RegistrationDate", "type": "String"}
    ]
  }
}
"@

$csvDataset | Out-File "ds_customers_csv.json"

az synapse dataset create `
  --workspace-name $config.WorkspaceName `
  --name "ds_customers_csv" `
  --file "ds_customers_csv.json"

Write-Host "✅ CSV dataset created" -ForegroundColor Green
```

### __2.2 Create Sink Dataset for Parquet__

```powershell
# Create sink dataset for raw zone
$sinkDataset = @"
{
  "name": "ds_customers_parquet",
  "properties": {
    "linkedServiceName": {
      "referenceName": "WorkspaceStorage",
      "type": "LinkedServiceReference"
    },
    "type": "Parquet",
    "typeProperties": {
      "location": {
        "type": "AzureBlobFSLocation",
        "folderPath": "customers",
        "fileSystem": "raw"
      },
      "compressionCodec": "snappy"
    }
  }
}
"@

$sinkDataset | Out-File "ds_customers_parquet.json"

az synapse dataset create `
  --workspace-name $config.WorkspaceName `
  --name "ds_customers_parquet" `
  --file "ds_customers_parquet.json"

Write-Host "✅ Parquet sink dataset created" -ForegroundColor Green
```

### __2.3 Create JSON Dataset__

```powershell
# Create JSON source dataset
$jsonDataset = @"
{
  "name": "ds_transactions_json",
  "properties": {
    "linkedServiceName": {
      "referenceName": "WorkspaceStorage",
      "type": "LinkedServiceReference"
    },
    "type": "Json",
    "typeProperties": {
      "location": {
        "type": "AzureBlobFSLocation",
        "fileName": "transactions.json",
        "folderPath": "transactions/2024-05",
        "fileSystem": "landing"
      }
    },
    "schema": {}
  }
}
"@

$jsonDataset | Out-File "ds_transactions_json.json"

az synapse dataset create `
  --workspace-name $config.WorkspaceName `
  --name "ds_transactions_json" `
  --file "ds_transactions_json.json"

Write-Host "✅ JSON dataset created" -ForegroundColor Green
```

## 🔄 Step 3: Build Copy Pipeline

### __3.1 Create Basic Copy Pipeline__

**Via Synapse Studio**:

```text
1. Navigate to Integrate → + New → Pipeline
2. Name: "pl_ingest_customers"
3. From Activities → Move & transform → Drag "Copy data" to canvas
4. Configure Copy activity:
   - General tab:
     - Name: "CopyCustomersCSVToParquet"
   - Source tab:
     - Source dataset: ds_customers_csv
   - Sink tab:
     - Sink dataset: ds_customers_parquet
     - Copy method: Merge files
   - Mapping tab:
     - Import schemas
     - Review column mappings
5. Click "Validate" → Fix any errors
6. Click "Publish all"
```

**Via Azure CLI (JSON Definition)**:

```powershell
# Create pipeline JSON
$pipeline = @"
{
  "name": "pl_ingest_customers",
  "properties": {
    "activities": [
      {
        "name": "CopyCustomersCSVToParquet",
        "type": "Copy",
        "inputs": [
          {
            "referenceName": "ds_customers_csv",
            "type": "DatasetReference"
          }
        ],
        "outputs": [
          {
            "referenceName": "ds_customers_parquet",
            "type": "DatasetReference"
          }
        ],
        "typeProperties": {
          "source": {
            "type": "DelimitedTextSource",
            "storeSettings": {
              "type": "AzureBlobFSReadSettings",
              "recursive": true
            }
          },
          "sink": {
            "type": "ParquetSink",
            "storeSettings": {
              "type": "AzureBlobFSWriteSettings",
              "copyBehavior": "PreserveHierarchy"
            }
          },
          "enableStaging": false,
          "translator": {
            "type": "TabularTranslator",
            "mappings": [
              {"source": {"name": "CustomerID"}, "sink": {"name": "CustomerID", "type": "String"}},
              {"source": {"name": "FirstName"}, "sink": {"name": "FirstName", "type": "String"}},
              {"source": {"name": "LastName"}, "sink": {"name": "LastName", "type": "String"}},
              {"source": {"name": "Email"}, "sink": {"name": "Email", "type": "String"}},
              {"source": {"name": "Country"}, "sink": {"name": "Country", "type": "String"}},
              {"source": {"name": "RegistrationDate"}, "sink": {"name": "RegistrationDate", "type": "DateTime"}}
            ]
          }
        }
      }
    ]
  }
}
"@

$pipeline | Out-File "pl_ingest_customers.json"

az synapse pipeline create `
  --workspace-name $config.WorkspaceName `
  --name "pl_ingest_customers" `
  --file "pl_ingest_customers.json"

Write-Host "✅ Copy pipeline created" -ForegroundColor Green
```

### __3.2 Add Data Validation Activity__

```powershell
# Enhanced pipeline with validation
$pipelineWithValidation = @"
{
  "name": "pl_ingest_customers_validated",
  "properties": {
    "activities": [
      {
        "name": "ValidateSourceExists",
        "type": "Validation",
        "typeProperties": {
          "dataset": {
            "referenceName": "ds_customers_csv",
            "type": "DatasetReference"
          },
          "timeout": "00:05:00",
          "sleep": 10,
          "minimumSize": 100
        }
      },
      {
        "name": "CopyCustomersCSVToParquet",
        "type": "Copy",
        "dependsOn": [
          {
            "activity": "ValidateSourceExists",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "inputs": [{"referenceName": "ds_customers_csv", "type": "DatasetReference"}],
        "outputs": [{"referenceName": "ds_customers_parquet", "type": "DatasetReference"}],
        "typeProperties": {
          "source": {"type": "DelimitedTextSource"},
          "sink": {"type": "ParquetSink"},
          "enableStaging": false,
          "dataIntegrationUnits": 4
        }
      }
    ]
  }
}
"@

$pipelineWithValidation | Out-File "pl_ingest_customers_validated.json"

az synapse pipeline create `
  --workspace-name $config.WorkspaceName `
  --name "pl_ingest_customers_validated" `
  --file "pl_ingest_customers_validated.json"

Write-Host "✅ Validated pipeline created" -ForegroundColor Green
```

### __3.3 Configure Error Handling__

```text
Error Handling Configuration in Copy Activity:

1. Source tab → Error tolerance settings:
   - Fault tolerance: Skip incompatible rows
   - Max errors allowed: 100
   - Log incompatible rows: Yes
   - Log storage: landing/errors/

2. Settings tab:
   - Data consistency verification: Yes
   - Enable logging: Yes
   - Log level: Warning

3. Sink tab → Pre-copy script:
   - Run cleanup query before copy (if applicable)
```

## 📝 Step 4: Handle Multiple Formats

### __4.1 Create Multi-Format Ingestion Pipeline__

```powershell
# Pipeline for ingesting all data formats
$multiFormatPipeline = @"
{
  "name": "pl_ingest_all_sources",
  "properties": {
    "activities": [
      {
        "name": "IngestCustomersCSV",
        "type": "Copy",
        "inputs": [{"referenceName": "ds_customers_csv", "type": "DatasetReference"}],
        "outputs": [{"referenceName": "ds_customers_parquet", "type": "DatasetReference"}],
        "typeProperties": {
          "source": {"type": "DelimitedTextSource"},
          "sink": {"type": "ParquetSink"}
        }
      },
      {
        "name": "IngestTransactionsJSON",
        "type": "Copy",
        "dependsOn": [],
        "inputs": [{"referenceName": "ds_transactions_json", "type": "DatasetReference"}],
        "outputs": [{"referenceName": "ds_transactions_parquet", "type": "DatasetReference"}],
        "typeProperties": {
          "source": {"type": "JsonSource"},
          "sink": {"type": "ParquetSink"}
        }
      },
      {
        "name": "CopyProductParquet",
        "type": "Copy",
        "dependsOn": [],
        "inputs": [{"referenceName": "ds_products_parquet_landing", "type": "DatasetReference"}],
        "outputs": [{"referenceName": "ds_products_parquet_raw", "type": "DatasetReference"}],
        "typeProperties": {
          "source": {"type": "ParquetSource"},
          "sink": {"type": "ParquetSink"}
        }
      }
    ]
  }
}
"@

$multiFormatPipeline | Out-File "pl_ingest_all_sources.json"
Write-Host "✅ Multi-format ingestion pipeline defined" -ForegroundColor Green
```

### __4.2 Schema Mapping for Different Formats__

**CSV to Parquet with Type Conversion**:

```json
{
  "translator": {
    "type": "TabularTranslator",
    "mappings": [
      {
        "source": {"name": "CustomerID", "type": "String"},
        "sink": {"name": "customer_id", "type": "String"}
      },
      {
        "source": {"name": "RegistrationDate", "type": "String"},
        "sink": {"name": "registration_date", "type": "DateTime"}
      }
    ],
    "typeConversion": true,
    "typeConversionSettings": {
      "allowDataTruncation": false,
      "treatBooleanAsNumber": false,
      "dateTimeFormat": "yyyy-MM-dd"
    }
  }
}
```

**JSON to Parquet with Flattening**:

```json
{
  "translator": {
    "type": "TabularTranslator",
    "mappings": [
      {"source": {"path": "$.TransactionID"}, "sink": {"name": "transaction_id"}},
      {"source": {"path": "$.CustomerID"}, "sink": {"name": "customer_id"}},
      {"source": {"path": "$.Amount"}, "sink": {"name": "amount", "type": "Decimal"}},
      {"source": {"path": "$.ProductCategory"}, "sink": {"name": "category"}},
      {"source": {"path": "$.TransactionDate"}, "sink": {"name": "transaction_date", "type": "DateTime"}}
    ]
  }
}
```

## 🚀 Step 5: Execute and Monitor Pipeline

### __5.1 Trigger Pipeline Manually__

```powershell
# Run pipeline manually
az synapse pipeline create-run `
  --workspace-name $config.WorkspaceName `
  --name "pl_ingest_customers" `
  --output json

# Get run ID from output
$runId = "paste-run-id-here"

# Monitor pipeline run
az synapse pipeline-run show `
  --workspace-name $config.WorkspaceName `
  --run-id $runId `
  --output table

Write-Host "✅ Pipeline triggered successfully" -ForegroundColor Green
```

### __5.2 Monitor in Synapse Studio__

**Via UI**:

```text
1. Navigate to Monitor → Pipeline runs
2. Find your pipeline: "pl_ingest_customers"
3. Click on run to view details:
   - Activity runs
   - Input/output data
   - Duration and status
   - Error messages (if any)
4. Click on activity name → View details:
   - Rows read/written
   - Data volume
   - Throughput
   - DIU (Data Integration Units) used
```

### __5.3 Query Ingested Data__

```sql
-- Query ingested Parquet data using Serverless SQL
-- Execute in Synapse Studio → Develop → New SQL script

-- Query customer data in raw zone
SELECT TOP 10
    CustomerID,
    FirstName,
    LastName,
    Email,
    Country,
    RegistrationDate
FROM OPENROWSET(
    BULK 'https://[storage-account].dfs.core.windows.net/raw/customers/*.parquet',
    FORMAT = 'PARQUET'
) AS customers
ORDER BY RegistrationDate DESC;

-- Verify row count
SELECT COUNT(*) as TotalCustomers
FROM OPENROWSET(
    BULK 'https://[storage-account].dfs.core.windows.net/raw/customers/*.parquet',
    FORMAT = 'PARQUET'
) AS customers;
```

## ⏰ Step 6: Schedule Pipeline Execution

### __6.1 Create Schedule Trigger__

```powershell
# Create daily trigger at 2 AM
$trigger = @"
{
  "name": "tr_daily_ingest",
  "properties": {
    "type": "ScheduleTrigger",
    "typeProperties": {
      "recurrence": {
        "frequency": "Day",
        "interval": 1,
        "startTime": "2024-01-01T02:00:00Z",
        "timeZone": "UTC",
        "schedule": {}
      }
    },
    "pipelines": [
      {
        "pipelineReference": {
          "referenceName": "pl_ingest_all_sources",
          "type": "PipelineReference"
        },
        "parameters": {}
      }
    ]
  }
}
"@

$trigger | Out-File "tr_daily_ingest.json"

az synapse trigger create `
  --workspace-name $config.WorkspaceName `
  --name "tr_daily_ingest" `
  --file "tr_daily_ingest.json"

# Start trigger
az synapse trigger start `
  --workspace-name $config.WorkspaceName `
  --name "tr_daily_ingest"

Write-Host "✅ Schedule trigger created and started" -ForegroundColor Green
```

### __6.2 Create Tumbling Window Trigger__

```powershell
# Trigger for incremental loads every 6 hours
$tumblingTrigger = @"
{
  "name": "tr_tumbling_6h",
  "properties": {
    "type": "TumblingWindowTrigger",
    "typeProperties": {
      "frequency": "Hour",
      "interval": 6,
      "startTime": "2024-01-01T00:00:00Z",
      "delay": "00:00:00",
      "maxConcurrency": 1,
      "retryPolicy": {
        "count": 3,
        "intervalInSeconds": 300
      }
    },
    "pipeline": {
      "pipelineReference": {
        "referenceName": "pl_ingest_customers",
        "type": "PipelineReference"
      },
      "parameters": {
        "windowStart": "@trigger().outputs.windowStartTime",
        "windowEnd": "@trigger().outputs.windowEndTime"
      }
    }
  }
}
"@

$tumblingTrigger | Out-File "tr_tumbling_6h.json"
Write-Host "✅ Tumbling window trigger configured" -ForegroundColor Green
```

## 🎯 Step 7: Implement Advanced Patterns

### __7.1 Parameterized Pipeline for Reusability__

```powershell
# Generic copy pipeline with parameters
$parameterizedPipeline = @"
{
  "name": "pl_generic_copy",
  "properties": {
    "parameters": {
      "sourceContainer": {"type": "String"},
      "sourcePath": {"type": "String"},
      "sinkContainer": {"type": "String"},
      "sinkPath": {"type": "String"},
      "fileFormat": {"type": "String", "defaultValue": "parquet"}
    },
    "activities": [
      {
        "name": "DynamicCopy",
        "type": "Copy",
        "typeProperties": {
          "source": {
            "type": "BinarySource",
            "storeSettings": {
              "type": "AzureBlobFSReadSettings",
              "recursive": true
            }
          },
          "sink": {
            "type": "BinarySink",
            "storeSettings": {
              "type": "AzureBlobFSWriteSettings"
            }
          }
        }
      }
    ]
  }
}
"@

$parameterizedPipeline | Out-File "pl_generic_copy.json"
Write-Host "✅ Parameterized pipeline created for reusability" -ForegroundColor Green
```

### __7.2 Error Logging Pipeline__

```sql
-- Create error log table in Serverless SQL
CREATE EXTERNAL TABLE bronze.ingestion_errors (
    ErrorID UNIQUEIDENTIFIER,
    PipelineName NVARCHAR(200),
    ActivityName NVARCHAR(200),
    SourceFile NVARCHAR(500),
    ErrorMessage NVARCHAR(MAX),
    ErrorTimestamp DATETIME2,
    RowData NVARCHAR(MAX)
)
WITH (
    LOCATION = 'ingestion-errors/',
    DATA_SOURCE = WorkspaceStorage,
    FILE_FORMAT = ParquetFormat
);
```

### __7.3 Metadata-Driven Ingestion__

```powershell
# Create control table for metadata-driven pipelines
$controlTableScript = @"
CREATE TABLE control.ingestion_metadata (
    SourceID INT IDENTITY(1,1),
    SourceName NVARCHAR(100),
    SourceType NVARCHAR(50),
    SourcePath NVARCHAR(500),
    TargetPath NVARCHAR(500),
    IsActive BIT,
    LastProcessedDate DATETIME2,
    ProcessingFrequency NVARCHAR(20)
);

INSERT INTO control.ingestion_metadata VALUES
('Customers', 'CSV', 'landing/customers/', 'raw/customers/', 1, NULL, 'Daily'),
('Transactions', 'JSON', 'landing/transactions/', 'raw/transactions/', 1, NULL, 'Hourly'),
('Products', 'Parquet', 'landing/products/', 'raw/products/', 1, NULL, 'Weekly');
"@

Write-Host "✅ Metadata-driven pattern configured" -ForegroundColor Green
```

## ✅ Step 8: Validate and Test

### __8.1 Comprehensive Pipeline Testing__

```powershell
# Pipeline validation script
Write-Host "🔍 Validating Batch Ingestion Pipelines..." -ForegroundColor Cyan

# Test 1: Verify pipelines exist
$pipelines = az synapse pipeline list `
  --workspace-name $config.WorkspaceName `
  --query "[].name" `
  --output tsv

$expectedPipelines = @("pl_ingest_customers", "pl_ingest_all_sources")
foreach ($pipeline in $expectedPipelines) {
    if ($pipelines -contains $pipeline) {
        Write-Host "✅ Pipeline exists: $pipeline" -ForegroundColor Green
    } else {
        Write-Host "❌ Pipeline missing: $pipeline" -ForegroundColor Red
    }
}

# Test 2: Verify datasets exist
$datasets = az synapse dataset list `
  --workspace-name $config.WorkspaceName `
  --query "[].name" `
  --output tsv

Write-Host "`n✅ Datasets configured: $($datasets.Count)" -ForegroundColor Green

# Test 3: Check data in raw zone
$rawFiles = az storage blob list `
  --account-name $config.StorageAccount `
  --container-name "raw" `
  --auth-mode login `
  --query "[].name" `
  --output tsv

if ($rawFiles) {
    Write-Host "✅ Data files in raw zone: $($rawFiles.Count)" -ForegroundColor Green
} else {
    Write-Host "⚠️ No data files found in raw zone" -ForegroundColor Yellow
}

Write-Host "`n🎯 Validation complete!" -ForegroundColor Cyan
```

### __8.2 Performance Benchmarking__

```sql
-- Query to analyze pipeline performance
SELECT
    PipelineName,
    ActivityName,
    AVG(DurationInMs) as AvgDurationMs,
    AVG(RowsRead) as AvgRowsRead,
    AVG(RowsWritten) as AvgRowsWritten,
    AVG(DataRead / 1024 / 1024) as AvgDataReadMB,
    COUNT(*) as RunCount
FROM monitoring.pipeline_activity_runs
WHERE RunDate >= DATEADD(day, -7, GETDATE())
GROUP BY PipelineName, ActivityName
ORDER BY AvgDurationMs DESC;
```

## 💡 Key Concepts Review

### __Data Formats Comparison__

| Format | Best For | Compression | Schema Evolution | Query Performance |
|--------|----------|-------------|------------------|-------------------|
| **CSV** | Simple data, human-readable | Low | Manual | Slow |
| **JSON** | Nested/hierarchical data | Medium | Flexible | Medium |
| **Parquet** | Analytics workloads | High | Schema-on-read | Fast |
| **Avro** | Streaming, schema evolution | Medium | Built-in | Medium |

### __Pipeline Best Practices__

- ✅ Use parameterization for reusable pipelines
- ✅ Implement error handling and logging
- ✅ Enable data validation before copy
- ✅ Use appropriate Data Integration Units (DIU)
- ✅ Schedule during off-peak hours
- ✅ Monitor and optimize copy performance

### __Error Handling Strategies__

1. **Validation Activity**: Check file existence and size
2. **Fault Tolerance**: Skip incompatible rows
3. **Error Logging**: Store failed rows for review
4. **Retry Logic**: Configure retry policy for transient failures
5. **Alerting**: Set up email notifications for failures

## 🎉 Congratulations

You've successfully built batch data ingestion pipelines. Your solution now includes:

- ✅ __Multi-format data ingestion__ (CSV, JSON, Parquet)
- ✅ __Schema mapping and validation__
- ✅ __Error handling and logging__
- ✅ __Scheduled pipeline execution__
- ✅ __Monitoring and performance tracking__

## 🚀 What's Next?

**Continue to Tutorial 5**: [Real-time Data Streaming](05-streaming-ingestion.md)

In the next tutorial, you'll:

- Set up Azure Event Hubs for streaming data
- Build real-time ingestion pipelines
- Implement stream processing with Spark Structured Streaming
- Combine batch and streaming workloads

## 💬 Troubleshooting

### __Common Issues and Solutions__

**Issue**: Copy activity fails with "Access Denied"

```powershell
# Verify managed identity has storage permissions
$workspaceId = az synapse workspace show `
  --name $config.WorkspaceName `
  --resource-group $config.ResourceGroup `
  --query identity.principalId `
  --output tsv

az role assignment create `
  --role "Storage Blob Data Contributor" `
  --assignee $workspaceId `
  --scope "/subscriptions/$(az account show --query id --output tsv)/resourceGroups/$($config.ResourceGroup)/providers/Microsoft.Storage/storageAccounts/$($config.StorageAccount)"
```

**Issue**: Schema mismatch errors

```text
Solution:
1. Enable "Skip incompatible rows" in copy activity
2. Review column mappings in Mapping tab
3. Use explicit type conversions in translator configuration
```

**Issue**: Pipeline runs slowly

```powershell
# Increase Data Integration Units (DIU) in copy activity
# Default: 4, Maximum: 256
# Update in pipeline JSON: "dataIntegrationUnits": 16
```

---

__Tutorial Progress__: 4 of 14 completed
__Next__: [05. Real-time Streaming →](05-streaming-ingestion.md)
__Time Investment__: 40 minutes ✅

*Reliable batch ingestion is the foundation of data lakes. Master these patterns before moving to streaming.*
