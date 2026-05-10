# 🎭 Advanced Pipeline Orchestration

![Tutorial](https://img.shields.io/badge/Tutorial-Advanced_Orchestration-blue)
![Duration](https://img.shields.io/badge/Duration-25_minutes-green)
![Level](https://img.shields.io/badge/Level-Advanced-red)

__Master complex orchestration patterns including conditional logic, loops, parallelism, and dynamic pipeline execution for enterprise-scale data workflows.__

## 📋 Table of Contents

- [If Condition Activity](#if-condition-activity)
- [Switch Activity](#switch-activity)
- [Until Activity](#until-activity)
- [Execute Pipeline Activity](#execute-pipeline-activity)
- [Web Activity](#web-activity)
- [Next Steps](#next-steps)

## 🔀 If Condition Activity

Implement conditional branching in pipelines.

### Basic If Condition

```json
{
  "name": "CheckFileSize",
  "type": "IfCondition",
  "dependsOn": [
    {"activity": "GetFileMetadata", "dependencyConditions": ["Succeeded"]}
  ],
  "typeProperties": {
    "expression": {
      "value": "@greater(activity('GetFileMetadata').output.size, 1000000)",
      "type": "Expression"
    },
    "ifTrueActivities": [
      {
        "name": "ProcessLargeFile",
        "type": "Copy"
      }
    ],
    "ifFalseActivities": [
      {
        "name": "ProcessSmallFile",
        "type": "Copy"
      }
    ]
  }
}
```

### Nested Conditions

```json
{
  "name": "MultiLevelCheck",
  "type": "IfCondition",
  "typeProperties": {
    "expression": {
      "value": "@equals(pipeline().parameters.Environment, 'Production')",
      "type": "Expression"
    },
    "ifTrueActivities": [
      {
        "name": "ProductionValidation",
        "type": "IfCondition",
        "typeProperties": {
          "expression": {
            "value": "@activity('DataQualityCheck').output.isValid",
            "type": "Expression"
          }
        }
      }
    ]
  }
}
```

## 🔄 Switch Activity

Multiple conditional branches based on a value.

```json
{
  "name": "RouteByFileType",
  "type": "Switch",
  "dependsOn": [
    {"activity": "DetermineFileType", "dependencyConditions": ["Succeeded"]}
  ],
  "typeProperties": {
    "on": {
      "value": "@activity('DetermineFileType').output.fileExtension",
      "type": "Expression"
    },
    "cases": [
      {
        "value": "csv",
        "activities": [
          {"name": "ProcessCSV", "type": "Copy"}
        ]
      },
      {
        "value": "json",
        "activities": [
          {"name": "ProcessJSON", "type": "Copy"}
        ]
      },
      {
        "value": "parquet",
        "activities": [
          {"name": "ProcessParquet", "type": "Copy"}
        ]
      }
    ],
    "defaultActivities": [
      {
        "name": "LogUnsupportedFormat",
        "type": "WebActivity"
      }
    ]
  }
}
```

## 🔁 Until Activity

Repeat activities until a condition is met.

```json
{
  "name": "WaitForFileArrival",
  "type": "Until",
  "typeProperties": {
    "expression": {
      "value": "@equals(activity('CheckFileExists').output.exists, true)",
      "type": "Expression"
    },
    "timeout": "00:30:00",
    "activities": [
      {
        "name": "CheckFileExists",
        "type": "GetMetadata",
        "typeProperties": {
          "dataset": {"referenceName": "ExpectedFile"},
          "fieldList": ["exists"]
        }
      },
      {
        "name": "Wait30Seconds",
        "type": "Wait",
        "dependsOn": [{"activity": "CheckFileExists"}],
        "typeProperties": {
          "waitTimeInSeconds": 30
        }
      }
    ]
  }
}
```

## 📞 Execute Pipeline Activity

Call other pipelines for modular design.

```json
{
  "name": "ExecuteDataQualityPipeline",
  "type": "ExecutePipeline",
  "typeProperties": {
    "pipeline": {
      "referenceName": "DataQualityCheckPipeline",
      "type": "PipelineReference"
    },
    "parameters": {
      "tableName": "@{pipeline().parameters.TargetTable}",
      "validationRules": "@{pipeline().parameters.Rules}"
    },
    "waitOnCompletion": true
  }
}
```

## 🌐 Web Activity

Call REST APIs and webhooks.

### REST API Call

```json
{
  "name": "CallExternalAPI",
  "type": "WebActivity",
  "typeProperties": {
    "url": "https://api.example.com/data",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer @{pipeline().parameters.APIToken}"
    },
    "body": {
      "dataDate": "@{pipeline().parameters.ProcessDate}",
      "recordCount": "@{activity('CountRecords').output.count}"
    }
  }
}
```

## 📚 Additional Resources

- [Control Flow Documentation](https://docs.microsoft.com/azure/data-factory/control-flow-activities)

## 🚀 Next Steps

__→ [09. Data Transformation Patterns](09-transformation-patterns.md)__

---

__Module Progress__: 8 of 18 complete

*Tutorial Version: 1.0*
*Last Updated: January 2025*
