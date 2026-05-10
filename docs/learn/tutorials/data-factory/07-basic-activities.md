---
title: "️ Basic Pipeline Activities"
description: "__Master fundamental pipeline activities including Copy, Lookup, Get Metadata, and Delete activities for building robust data workflows.__"
tags:
  - tutorials
  - data-factory
---
# ⚙️ Basic Pipeline Activities

![Tutorial](https://img.shields.io/badge/Tutorial-Basic_Activities-blue)
![Duration](https://img.shields.io/badge/Duration-20_minutes-green)
![Level](https://img.shields.io/badge/Level-Beginner-brightgreen)

__Master fundamental pipeline activities including Copy, Lookup, Get Metadata, and Delete activities for building robust data workflows.__

## 📋 Table of Contents

- [Activity Types Overview](#activity-types-overview)
- [Copy Activity](#copy-activity)
- [Lookup Activity](#lookup-activity)
- [Get Metadata Activity](#get-metadata-activity)
- [Delete Activity](#delete-activity)
- [ForEach Activity](#foreach-activity)
- [Hands-On Examples](#hands-on-examples)
- [Next Steps](#next-steps)

## 📊 Activity Types Overview

| Activity Type | Purpose | Common Use Cases |
|---------------|---------|------------------|
| __Copy__ | Move data between stores | ETL/ELT, data migration |
| __Lookup__ | Retrieve configuration | Dynamic pipelines, metadata-driven |
| __Get Metadata__ | Get file/folder info | File validation, conditional logic |
| __Delete__ | Remove files/data | Cleanup, archival |
| __ForEach__ | Iterate collections | Process multiple files/tables |
| __If Condition__ | Conditional branching | Error handling, validation |
| __Wait__ | Add delays | Rate limiting, scheduling |

## 📥 Copy Activity

The most fundamental activity for data movement.

### Basic Copy Activity

```json
{
  "name": "CopyBlobToSQL",
  "type": "Copy",
  "inputs": [
    {
      "referenceName": "SourceBlobDataset",
      "type": "DatasetReference"
    }
  ],
  "outputs": [
    {
      "referenceName": "SinkSqlDataset",
      "type": "DatasetReference"
    }
  ],
  "typeProperties": {
    "source": {
      "type": "DelimitedTextSource",
      "storeSettings": {
        "type": "AzureBlobStorageReadSettings",
        "recursive": true
      },
      "formatSettings": {
        "type": "DelimitedTextReadSettings",
        "skipLineCount": 0
      }
    },
    "sink": {
      "type": "AzureSqlSink",
      "writeBehavior": "insert",
      "sqlWriterUseTableLock": false,
      "tableOption": "autoCreate"
    },
    "enableStaging": false,
    "translator": {
      "type": "TabularTranslator",
      "typeConversion": true,
      "typeConversionSettings": {
        "allowDataTruncation": true,
        "treatBooleanAsNumber": false
      }
    }
  }
}
```

### Copy Activity with Column Mapping

```json
{
  "typeProperties": {
    "translator": {
      "type": "TabularTranslator",
      "mappings": [
        {
          "source": {"name": "CustomerID"},
          "sink": {"name": "customer_id"}
        },
        {
          "source": {"name": "CustomerName"},
          "sink": {"name": "customer_name"}
        },
        {
          "source": {"name": "OrderDate"},
          "sink": {"name": "order_date"}
        }
      ]
    }
  }
}
```

### Copy with Performance Optimization

```json
{
  "typeProperties": {
    "source": {
      "type": "AzureSqlSource",
      "sqlReaderQuery": "SELECT * FROM Sales WHERE OrderDate >= '@{pipeline().parameters.StartDate}'",
      "queryTimeout": "02:00:00",
      "partitionOption": "PhysicalPartitionsOfTable"
    },
    "sink": {
      "type": "ParquetSink",
      "storeSettings": {
        "type": "AzureBlobFSWriteSettings",
        "maxConcurrentConnections": 5,
        "copyBehavior": "PreserveHierarchy"
      }
    },
    "enableStaging": true,
    "stagingSettings": {
      "linkedServiceName": {
        "referenceName": "AzureBlobStorage_Staging",
        "type": "LinkedServiceReference"
      },
      "path": "staging"
    },
    "parallelCopies": 32,
    "dataIntegrationUnits": 16
  }
}
```

## 🔍 Lookup Activity

Retrieve metadata or small datasets to drive pipeline logic.

### Single Row Lookup

```json
{
  "name": "LookupMaxDate",
  "type": "Lookup",
  "typeProperties": {
    "source": {
      "type": "AzureSqlSource",
      "sqlReaderQuery": "SELECT MAX(ModifiedDate) as MaxDate FROM Sales",
      "queryTimeout": "02:00:00"
    },
    "dataset": {
      "referenceName": "AzureSqlTable_Dataset",
      "type": "DatasetReference"
    },
    "firstRowOnly": true
  }
}
```

### Multiple Rows Lookup

```json
{
  "name": "LookupTableList",
  "type": "Lookup",
  "typeProperties": {
    "source": {
      "type": "AzureSqlSource",
      "sqlReaderQuery": "SELECT TableName, SchemaName FROM ConfigTables WHERE IsActive = 1"
    },
    "dataset": {
      "referenceName": "ConfigDatabase_Dataset",
      "type": "DatasetReference"
    },
    "firstRowOnly": false
  }
}
```

### Using Lookup Results

```json
{
  "name": "CopyUsingLookup",
  "type": "Copy",
  "dependsOn": [
    {
      "activity": "LookupMaxDate",
      "dependencyConditions": ["Succeeded"]
    }
  ],
  "typeProperties": {
    "source": {
      "type": "AzureSqlSource",
      "sqlReaderQuery": "SELECT * FROM Sales WHERE ModifiedDate > '@{activity('LookupMaxDate').output.firstRow.MaxDate}'"
    }
  }
}
```

## 📁 Get Metadata Activity

Retrieve properties of files or folders.

### Get File Properties

```json
{
  "name": "GetFileMetadata",
  "type": "GetMetadata",
  "typeProperties": {
    "dataset": {
      "referenceName": "BlobFile_Dataset",
      "type": "DatasetReference",
      "parameters": {
        "containerName": "input",
        "fileName": "data.csv"
      }
    },
    "fieldList": [
      "exists",
      "itemName",
      "lastModified",
      "size",
      "structure"
    ],
    "storeSettings": {
      "type": "AzureBlobStorageReadSettings",
      "recursive": true,
      "enablePartitionDiscovery": false
    }
  }
}
```

### Get Folder Contents

```json
{
  "name": "GetFolderMetadata",
  "type": "GetMetadata",
  "typeProperties": {
    "dataset": {
      "referenceName": "BlobFolder_Dataset",
      "type": "DatasetReference",
      "parameters": {
        "containerName": "input",
        "folderPath": "daily"
      }
    },
    "fieldList": [
      "childItems",
      "exists",
      "itemName"
    ]
  }
}
```

### Conditional Logic Based on Metadata

```json
{
  "name": "CheckFileExists",
  "type": "IfCondition",
  "dependsOn": [
    {
      "activity": "GetFileMetadata",
      "dependencyConditions": ["Succeeded"]
    }
  ],
  "typeProperties": {
    "expression": {
      "value": "@activity('GetFileMetadata').output.exists",
      "type": "Expression"
    },
    "ifTrueActivities": [
      {
        "name": "CopyFile",
        "type": "Copy"
      }
    ],
    "ifFalseActivities": [
      {
        "name": "LogMissingFile",
        "type": "WebActivity"
      }
    ]
  }
}
```

## 🗑️ Delete Activity

Remove files or data after processing.

### Delete File

```json
{
  "name": "DeleteProcessedFile",
  "type": "Delete",
  "typeProperties": {
    "dataset": {
      "referenceName": "BlobFile_Dataset",
      "type": "DatasetReference",
      "parameters": {
        "containerName": "processed",
        "fileName": "@{pipeline().parameters.FileName}"
      }
    },
    "enableLogging": true,
    "logStorageSettings": {
      "linkedServiceName": {
        "referenceName": "AzureBlobStorage_Logging",
        "type": "LinkedServiceReference"
      },
      "path": "deletion-logs"
    }
  }
}
```

### Delete Folder

```json
{
  "name": "DeleteOldFiles",
  "type": "Delete",
  "typeProperties": {
    "dataset": {
      "referenceName": "BlobFolder_Dataset",
      "type": "DatasetReference",
      "parameters": {
        "folderPath": "archive/2023"
      }
    },
    "recursive": true,
    "maxConcurrentConnections": 10
  }
}
```

## 🔁 ForEach Activity

Iterate over collections to process multiple items.

### Basic ForEach

```json
{
  "name": "ProcessFiles",
  "type": "ForEach",
  "dependsOn": [
    {
      "activity": "GetFolderMetadata",
      "dependencyConditions": ["Succeeded"]
    }
  ],
  "typeProperties": {
    "items": {
      "value": "@activity('GetFolderMetadata').output.childItems",
      "type": "Expression"
    },
    "isSequential": false,
    "batchCount": 20,
    "activities": [
      {
        "name": "CopyEachFile",
        "type": "Copy",
        "inputs": [
          {
            "referenceName": "SourceFile_Dataset",
            "type": "DatasetReference",
            "parameters": {
              "fileName": "@item().name"
            }
          }
        ],
        "outputs": [
          {
            "referenceName": "DestinationFile_Dataset",
            "type": "DatasetReference",
            "parameters": {
              "fileName": "@item().name"
            }
          }
        ]
      }
    ]
  }
}
```

### ForEach with Table List

```json
{
  "name": "CopyMultipleTables",
  "type": "ForEach",
  "dependsOn": [
    {
      "activity": "LookupTableList",
      "dependencyConditions": ["Succeeded"]
    }
  ],
  "typeProperties": {
    "items": {
      "value": "@activity('LookupTableList').output.value",
      "type": "Expression"
    },
    "isSequential": true,
    "activities": [
      {
        "name": "CopyTable",
        "type": "Copy",
        "typeProperties": {
          "source": {
            "type": "AzureSqlSource",
            "sqlReaderQuery": "SELECT * FROM @{item().SchemaName}.@{item().TableName}"
          }
        }
      }
    ]
  }
}
```

## 🎯 Hands-On Examples

### Example 1: File Processing Pipeline

Complete pipeline that processes files with validation.

```json
{
  "name": "FileProcessingPipeline",
  "properties": {
    "activities": [
      {
        "name": "GetFileList",
        "type": "GetMetadata",
        "typeProperties": {
          "dataset": {"referenceName": "InputFolder"},
          "fieldList": ["childItems"]
        }
      },
      {
        "name": "ProcessEachFile",
        "type": "ForEach",
        "dependsOn": [{"activity": "GetFileList", "dependencyConditions": ["Succeeded"]}],
        "typeProperties": {
          "items": "@activity('GetFileList').output.childItems",
          "activities": [
            {
              "name": "CopyFile",
              "type": "Copy"
            },
            {
              "name": "DeleteSourceFile",
              "type": "Delete"
            }
          ]
        }
      }
    ]
  }
}
```

### Example 2: Metadata-Driven Copy

```json
{
  "name": "MetadataDrivenCopy",
  "properties": {
    "parameters": {
      "ConfigTableName": {"type": "string"}
    },
    "activities": [
      {
        "name": "GetCopyConfig",
        "type": "Lookup",
        "typeProperties": {
          "source": {
            "type": "AzureSqlSource",
            "sqlReaderQuery": "SELECT * FROM @{pipeline().parameters.ConfigTableName}"
          },
          "firstRowOnly": false
        }
      },
      {
        "name": "CopyEachTable",
        "type": "ForEach",
        "dependsOn": [{"activity": "GetCopyConfig"}],
        "typeProperties": {
          "items": "@activity('GetCopyConfig').output.value",
          "activities": [
            {
              "name": "CopyData",
              "type": "Copy",
              "typeProperties": {
                "source": {
                  "type": "@{item().SourceType}",
                  "query": "@{item().SourceQuery}"
                },
                "sink": {
                  "type": "@{item().SinkType}"
                }
              }
            }
          ]
        }
      }
    ]
  }
}
```

## ✅ Best Practices

### Copy Activity

1. __Enable Staging for Large Data Transfers__
   - Improves reliability
   - Better performance for cross-region copies

2. __Use Partitioning__
   - Parallel processing
   - Faster data movement

3. __Configure Appropriate DIU__
   - Start with 4-8 DIUs
   - Scale based on data volume

### Lookup Activity

1. __Minimize Data Retrieved__
   - Use specific SELECT statements
   - Only retrieve necessary columns

2. __Use First Row Only When Possible__
   - Better performance
   - Lower memory usage

### ForEach Activity

1. __Use Batch Processing__
   - Set appropriate batchCount
   - Balance parallelism and resource usage

2. __Consider Sequential vs Parallel__
   - Sequential for ordered processing
   - Parallel for independent items

## 📚 Additional Resources

- [Copy Activity Documentation](https://docs.microsoft.com/azure/data-factory/copy-activity-overview)
- [Control Flow Activities](https://docs.microsoft.com/azure/data-factory/control-flow-activities)
- [Activity Performance Guide](https://docs.microsoft.com/azure/data-factory/copy-activity-performance)

## 🚀 Next Steps

Basic activities mastered! Proceed to:

__→ [08. Advanced Orchestration](08-advanced-orchestration.md)__ - Complex pipeline patterns

---

__Module Progress__: 7 of 18 complete

*Tutorial Version: 1.0*
*Last Updated: January 2025*
