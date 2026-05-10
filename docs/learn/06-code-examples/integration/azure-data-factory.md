# Azure Data Factory Integration with Azure Synapse Analytics

[Home](../../../README.md) > [Code Examples](../../README.md) > Integration > Data Factory Integration

This guide provides examples and best practices for integrating Azure Synapse Analytics with Azure Data Factory for comprehensive data orchestration, ingestion, and transformation.

## Prerequisites

- Azure Synapse Analytics workspace
- Azure Data Factory instance
- Appropriate permissions on both services
- Azure Key Vault for secret management

## Setting Up Azure Data Factory Integration with Synapse

### 1. Creating a Linked Service from ADF to Synapse

```json
{
  "name": "SynapseWorkspaceLinkedService",
  "type": "Microsoft.DataFactory/factories/linkedservices",
  "properties": {
    "annotations": [],
    "type": "AzureSynapseAnalytics",
    "typeProperties": {
      "connectionString": "Integrated Security=False;Encrypt=True;Connection Timeout=30;Data Source=your-synapse-workspace.sql.azuresynapse.net;Initial Catalog=SQLPool1",
      "password": {
        "type": "AzureKeyVaultSecret",
        "store": {
          "referenceName": "AzureKeyVaultLinkedService",
          "type": "LinkedServiceReference"
        },
        "secretName": "synapse-sql-password"
      },
      "userName": "sqladminuser"
    },
    "connectVia": {
      "referenceName": "AutoResolveIntegrationRuntime",
      "type": "IntegrationRuntimeReference"
    }
  }
}
```

### 2. Creating a Linked Service from Synapse to ADF

In your Synapse workspace, create a linked service to Azure Data Factory:

```json
{
  "name": "AzureDataFactoryLinkedService",
  "properties": {
    "type": "AzureDataFactory",
    "typeProperties": {
      "dataFactoryName": "your-data-factory",
      "subscriptionId": "your-subscription-id",
      "resourceGroup": "your-resource-group"
    }
  }
}
```

## Orchestration Scenarios

### 1. Using ADF to Orchestrate Synapse Pipelines

```json
{
  "name": "SynapseOrchestratorPipeline",
  "properties": {
    "activities": [
      {
        "name": "ExecuteSynapsePipeline",
        "type": "SynapseNotebook",
        "dependsOn": [],
        "policy": {
          "timeout": "0.12:00:00",
          "retry": 0,
          "retryIntervalInSeconds": 30,
          "secureOutput": false,
          "secureInput": false
        },
        "userProperties": [],
        "typeProperties": {
          "notebookPath": "/notebooks/DataProcessing/ProcessCustomerData",
          "sparkPool": {
            "referenceName": "SparkPool01",
            "type": "BigDataPoolReference"
          },
          "parameters": {
            "date": {
              "value": "@pipeline().parameters.ProcessingDate",
              "type": "Expression"
            }
          },
          "executorSize": "Small",
          "conf": {
            "spark.dynamicAllocation.enabled": true,
            "spark.dynamicAllocation.minExecutors": 1,
            "spark.dynamicAllocation.maxExecutors": 10
          },
          "driverSize": "Small",
          "numExecutors": 2
        },
        "linkedServiceName": {
          "referenceName": "SynapseWorkspaceLinkedService",
          "type": "LinkedServiceReference"
        }
      },
      {
        "name": "LoadDataToDataWarehouse",
        "type": "SqlServerStoredProcedure",
        "dependsOn": [
          {
            "activity": "ExecuteSynapsePipeline",
            "dependencyConditions": [
              "Succeeded"
            ]
          }
        ],
        "policy": {
          "timeout": "0.12:00:00",
          "retry": 0,
          "retryIntervalInSeconds": 30,
          "secureOutput": false,
          "secureInput": false
        },
        "userProperties": [],
        "typeProperties": {
          "storedProcedureName": "[dbo].[LoadProcessedData]",
          "storedProcedureParameters": {
            "LoadDate": {
              "value": {
                "value": "@pipeline().parameters.ProcessingDate",
                "type": "Expression"
              },
              "type": "DateTime"
            }
          }
        },
        "linkedServiceName": {
          "referenceName": "SynapseWorkspaceLinkedService",
          "type": "LinkedServiceReference"
        }
      }
    ],
    "parameters": {
      "ProcessingDate": {
        "type": "string",
        "defaultValue": "@utcnow()"
      }
    },
    "annotations": [],
    "lastPublishTime": "2025-07-15T14:22:36Z"
  },
  "type": "Microsoft.DataFactory/factories/pipelines"
}
```

### 2. Complex Orchestration with Synapse and ADF

This example shows how to create a complex orchestration pattern using both Synapse and ADF:

```json
{
  "name": "ComplexDataOrchestrationPipeline",
  "properties": {
    "activities": [
      {
        "name": "CheckDataAvailability",
        "type": "WebActivity",
        "dependsOn": [],
        "policy": {
          "timeout": "0.00:10:00",
          "retry": 3,
          "retryIntervalInSeconds": 60
        },
        "typeProperties": {
          "url": "https://your-function-app.azurewebsites.net/api/check-data-availability",
          "method": "GET",
          "headers": {
            "Content-Type": "application/json"
          },
          "authentication": {
            "type": "MSI",
            "resource": "https://management.azure.com"
          }
        }
      },
      {
        "name": "IngestDataToDataLake",
        "type": "Copy",
        "dependsOn": [
          {
            "activity": "CheckDataAvailability",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "source": {
            "type": "BlobSource",
            "recursive": true
          },
          "sink": {
            "type": "DelimitedTextSink",
            "storeSettings": {
              "type": "AzureBlobFSWriteSettings"
            },
            "formatSettings": {
              "type": "DelimitedTextWriteSettings",
              "quoteAllText": true,
              "fileExtension": ".csv"
            }
          },
          "enableStaging": false
        },
        "inputs": [
          {
            "referenceName": "SourceDataset",
            "type": "DatasetReference"
          }
        ],
        "outputs": [
          {
            "referenceName": "DataLakeDataset",
            "type": "DatasetReference"
          }
        ]
      },
      {
        "name": "ProcessDataWithSynapse",
        "type": "ExecutePipeline",
        "dependsOn": [
          {
            "activity": "IngestDataToDataLake",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "pipeline": {
            "referenceName": "SynapseDataProcessingPipeline",
            "type": "PipelineReference"
          },
          "waitOnCompletion": true,
          "parameters": {
            "DataPath": {
              "value": "@activity('IngestDataToDataLake').output.dataWritten",
              "type": "Expression"
            }
          }
        }
      },
      {
        "name": "NotifyCompletion",
        "type": "WebHook",
        "dependsOn": [
          {
            "activity": "ProcessDataWithSynapse",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "url": "https://your-logic-app.azurewebsites.net/api/notify",
          "method": "POST",
          "headers": {
            "Content-Type": "application/json"
          },
          "body": {
            "pipelineId": "@pipeline().Pipeline",
            "status": "Completed",
            "dataProcessed": "@activity('ProcessDataWithSynapse').output.dataProcessed"
          }
        }
      }
    ],
    "annotations": []
  }
}
```

## Data Integration Patterns

### 1. Incremental Loading from Source Systems to Synapse

```json
{
  "name": "IncrementalLoadPipeline",
  "properties": {
    "activities": [
      {
        "name": "LookupLastProcessedDate",
        "type": "Lookup",
        "dependsOn": [],
        "policy": {
          "timeout": "0.01:00:00",
          "retry": 3,
          "retryIntervalInSeconds": 30
        },
        "typeProperties": {
          "source": {
            "type": "AzureSqlSource",
            "sqlReaderQuery": "SELECT MAX(LastProcessedDate) AS LastProcessedDate FROM [control].[WatermarkTable] WHERE TableName = 'CustomerTransactions'"
          },
          "dataset": {
            "referenceName": "SynapseControlDataset",
            "type": "DatasetReference"
          },
          "firstRowOnly": true
        }
      },
      {
        "name": "GetNewData",
        "type": "Copy",
        "dependsOn": [
          {
            "activity": "LookupLastProcessedDate",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "source": {
            "type": "SqlSource",
            "sqlReaderQuery": {
              "value": "SELECT * FROM [Sales].[CustomerTransactions] WHERE TransactionDate > '@{activity('LookupLastProcessedDate').output.firstRow.LastProcessedDate}'",
              "type": "Expression"
            }
          },
          "sink": {
            "type": "SqlDWSink",
            "preCopyScript": "TRUNCATE TABLE [staging].[CustomerTransactions]",
            "tableOption": "autoCreate",
            "allowPolyBase": true,
            "polyBaseSettings": {
              "rejectValue": 0,
              "rejectType": "value",
              "useTypeDefault": true
            }
          },
          "enableStaging": true,
          "stagingSettings": {
            "linkedServiceName": {
              "referenceName": "AzureBlobStorage1",
              "type": "LinkedServiceReference"
            },
            "path": "staging"
          }
        },
        "inputs": [
          {
            "referenceName": "SourceSystemDataset",
            "type": "DatasetReference"
          }
        ],
        "outputs": [
          {
            "referenceName": "SynapseStageDataset",
            "type": "DatasetReference"
          }
        ]
      },
      {
        "name": "MergeDataIntoTarget",
        "type": "SqlServerStoredProcedure",
        "dependsOn": [
          {
            "activity": "GetNewData",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "storedProcedureName": "[dbo].[MergeCustomerTransactions]"
        },
        "linkedServiceName": {
          "referenceName": "SynapseWorkspaceLinkedService",
          "type": "LinkedServiceReference"
        }
      },
      {
        "name": "UpdateWatermark",
        "type": "SqlServerStoredProcedure",
        "dependsOn": [
          {
            "activity": "MergeDataIntoTarget",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "storedProcedureName": "[control].[UpdateWatermark]",
          "storedProcedureParameters": {
            "TableName": {
              "value": "CustomerTransactions",
              "type": "String"
            },
            "WatermarkValue": {
              "value": {
                "value": "@utcnow()",
                "type": "Expression"
              },
              "type": "DateTime"
            }
          }
        },
        "linkedServiceName": {
          "referenceName": "SynapseWorkspaceLinkedService",
          "type": "LinkedServiceReference"
        }
      }
    ]
  }
}
```

### 2. Synapse Data Loading with Spark Through ADF

```python
# This code would be part of a Synapse notebook that ADF calls
from pyspark.sql import SparkSession
from pyspark.sql.functions import *
from notebookutils import mssparkutils

# Get parameters from ADF pipeline
data_path = getArgument("DataPath")
table_name = getArgument("TargetTable")

# Initialize Spark session
spark = SparkSession.builder.appName("ADF Integration").getOrCreate()

# Read data from data lake
df = spark.read.format("delta").load(data_path)

# Perform transformations
transformed_df = df.withColumn("ProcessedDate", current_timestamp()) \
                   .withColumn("ProcessedBy", lit("ADF-Synapse-Integration"))

# Write to Delta table
transformed_df.write \
             .format("delta") \
             .mode("append") \
             .saveAsTable(table_name)

# Log completion for ADF to pick up
completion_info = {
    "status": "success",
    "rows_processed": transformed_df.count(),
    "target_table": table_name
}

# Write completion info to a location ADF can access
import json
mssparkutils.fs.put(
    "abfs://container@account.dfs.core.windows.net/logs/completion_info.json",
    json.dumps(completion_info),
    True  # overwrite
)
```

## Best Practices for Synapse and ADF Integration

1. __Use the Right Tool for the Job__:
   - ADF for orchestration and data movement
   - Synapse for complex transformations and analytics

2. __Parameter Passing__: Use pipeline parameters to make your integrations dynamic and reusable.

3. __Error Handling__: Implement comprehensive error handling and notifications across both services.

4. __Monitoring Integration__: Set up integrated monitoring across both services using Azure Monitor.

5. __Performance Optimization__:
   - Use PolyBase for bulk data loading into Synapse
   - Leverage mapping data flows for no-code transformations
   - Use Spark pools for complex transformations

6. __Security Best Practices__:
   - Use managed identities for authentication between services
   - Store secrets in Azure Key Vault
   - Implement private endpoints for network isolation
   - Use RBAC to control access to both services

7. __Cost Optimization__:
   - Scale down resources when not in use
   - Use serverless SQL pools for ad-hoc queries
   - Monitor DTU/DWU usage in dedicated SQL pools
   - Optimize pipeline execution frequency

8. __Pipeline Design__:
   - Break complex processes into modular pipelines
   - Use triggers for scheduling and event-based execution
   - Implement proper dependency management between activities
   - Use pipeline templates for consistent implementation

## Common Integration Scenarios

### Scenario 1: Multi-Stage Data Processing

```text
Source Systems → ADF (Extraction) → Data Lake → Synapse Spark (Transformation) → Synapse SQL (Serving)
```

### Scenario 2: Metadata-Driven Processing

```text
Metadata Store → ADF Control Flow → Dynamic Activity Generation → Synapse Execution
```

### Scenario 3: Hybrid Batch and Streaming

```text
Real-time Sources → Event Hub → Stream Analytics → Synapse Delta Tables
Historical Sources → ADF → Data Lake → Synapse Spark → Synapse Delta Tables
```

## Monitoring and Troubleshooting

### Implementing End-to-End Monitoring

```json
{
  "name": "MonitoringPipeline",
  "properties": {
    "activities": [
      {
        "name": "GetPipelineRuns",
        "type": "WebActivity",
        "typeProperties": {
          "url": "https://management.azure.com/subscriptions/{subscription-id}/resourceGroups/{resource-group}/providers/Microsoft.Synapse/workspaces/{workspace-name}/pipelineRuns?api-version=2019-06-01-preview&startTime={start-time}&endTime={end-time}",
          "method": "GET",
          "authentication": {
            "type": "MSI",
            "resource": "https://management.azure.com/"
          }
        }
      },
      {
        "name": "ProcessMonitoringData",
        "type": "AzureFunction",
        "dependsOn": [
          {
            "activity": "GetPipelineRuns",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "functionName": "ProcessMonitoringData",
          "method": "POST",
          "body": {
            "pipelineRuns": "@activity('GetPipelineRuns').output"
          }
        },
        "linkedServiceName": {
          "referenceName": "AzureFunctionLinkedService",
          "type": "LinkedServiceReference"
        }
      }
    ],
    "triggers": {
      "Schedule": {
        "type": "ScheduleTrigger",
        "typeProperties": {
          "recurrence": {
            "frequency": "Hour",
            "interval": 1,
            "startTime": "2025-08-01T00:00:00Z",
            "timeZone": "UTC"
          }
        }
      }
    }
  }
}
```

### Custom Logging Solution

```python
# Example of a custom logging function in Synapse Spark
def log_pipeline_activity(pipeline_name, activity_name, status, details=None):
    """Log pipeline activity to a central logging table"""
    from datetime import datetime
    
    log_entry = {
        "timestamp": datetime.utcnow().isoformat(),
        "pipeline_name": pipeline_name,
        "activity_name": activity_name,
        "status": status,
        "details": details if details else {}
    }
    
    # Write to Delta table
    spark.createDataFrame([log_entry]).write \
         .format("delta") \
         .mode("append") \
         .saveAsTable("logs.pipeline_execution")
    
    # Optionally send to Application Insights or other monitoring service
    # send_to_app_insights(log_entry)
```
