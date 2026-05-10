# 🔄 Visual Pipeline Builder Demo

![Status: Active](https://img.shields.io/badge/Status-Active-brightgreen)
![Type: Interactive](https://img.shields.io/badge/Type-Interactive-purple)
![Difficulty: Intermediate](https://img.shields.io/badge/Difficulty-Intermediate-yellow)

## 📋 Overview

An interactive visual pipeline builder for Azure Data Factory and Synapse Pipelines. Design, test, and deploy data integration pipelines using drag-and-drop components without writing code.

**Duration:** 30-45 minutes
**Format:** Interactive canvas with pre-built activities
**Prerequisites:** Understanding of data integration concepts

## 🎯 Learning Objectives

- Design data pipelines using visual drag-and-drop interface
- Configure pipeline activities and parameters
- Implement branching and conditional logic
- Set up triggers and scheduling
- Test and debug pipelines interactively
- Export pipeline definitions as JSON/ARM templates

## 🚀 Prerequisites and Setup

### Access Requirements

- **Browser-Based:** Modern browser with HTML5 support
- **Sample Connections:** Pre-configured data sources
- **Templates:** Ready-to-use pipeline patterns
- **Validation:** Real-time configuration checking

### Pipeline Canvas Features

```javascript
// Pipeline Builder Configuration
const pipelineBuilder = {
  canvas: {
    gridSize: 10,
    snapToGrid: true,
    zoomLevels: [0.5, 0.75, 1.0, 1.25, 1.5, 2.0],
    autoLayout: true
  },

  activities: {
    dataMovement: [
      'Copy Data',
      'Data Flow',
      'Azure Function',
      'Stored Procedure'
    ],
    transformation: [
      'Mapping Data Flow',
      'Databricks Notebook',
      'Synapse Spark',
      'SQL Pool Stored Procedure'
    ],
    control: [
      'If Condition',
      'For Each',
      'Until',
      'Wait',
      'Execute Pipeline'
    ],
    general: [
      'Set Variable',
      'Append Variable',
      'Web Activity',
      'Get Metadata'
    ]
  },

  validation: {
    realTime: true,
    showWarnings: true,
    blockInvalidConnections: true
  }
};
```

## 🎨 Canvas Interface

### Activity Palette

```html
<!-- Pipeline Builder UI -->
<div class="pipeline-builder">
  <aside class="activities-palette">
    <div class="activity-category">
      <h3>📦 Data Movement</h3>
      <div class="activity-item" draggable="true" data-activity="copy">
        <span class="icon">📄</span>
        <span class="label">Copy Data</span>
      </div>
      <div class="activity-item" draggable="true" data-activity="dataflow">
        <span class="icon">🔄</span>
        <span class="label">Data Flow</span>
      </div>
    </div>

    <div class="activity-category">
      <h3>⚡ Transformation</h3>
      <div class="activity-item" draggable="true" data-activity="mapping-dataflow">
        <span class="icon">🗺️</span>
        <span class="label">Mapping Data Flow</span>
      </div>
      <div class="activity-item" draggable="true" data-activity="databricks">
        <span class="icon">🧱</span>
        <span class="label">Databricks</span>
      </div>
    </div>

    <div class="activity-category">
      <h3>🎮 Control Flow</h3>
      <div class="activity-item" draggable="true" data-activity="if-condition">
        <span class="icon">❓</span>
        <span class="label">If Condition</span>
      </div>
      <div class="activity-item" draggable="true" data-activity="foreach">
        <span class="icon">🔁</span>
        <span class="label">ForEach</span>
      </div>
    </div>
  </aside>

  <main class="pipeline-canvas">
    <div class="canvas-toolbar">
      <button class="btn-validate">✅ Validate</button>
      <button class="btn-debug">🐛 Debug</button>
      <button class="btn-export">💾 Export</button>
      <button class="btn-zoom-in">🔍+</button>
      <button class="btn-zoom-out">🔍-</button>
    </div>

    <svg id="pipeline-canvas" width="100%" height="800">
      <!-- Pipeline activities and connections drawn here -->
    </svg>
  </main>

  <aside class="properties-panel">
    <h3>Activity Properties</h3>
    <div id="activity-properties">
      <!-- Dynamic properties based on selected activity -->
    </div>
  </aside>
</div>
```

## 📚 Sample Pipeline Templates

### Template 1: Simple Data Copy

```json
{
  "name": "CopyBlobToSynapse",
  "properties": {
    "activities": [
      {
        "name": "CopyFromBlob",
        "type": "Copy",
        "inputs": [
          {
            "referenceName": "SourceBlobDataset",
            "type": "DatasetReference"
          }
        ],
        "outputs": [
          {
            "referenceName": "SynapseSQLDataset",
            "type": "DatasetReference"
          }
        ],
        "typeProperties": {
          "source": {
            "type": "BlobSource",
            "recursive": true
          },
          "sink": {
            "type": "SqlDWSink",
            "preCopyScript": "TRUNCATE TABLE staging.Sales",
            "writeBatchSize": 10000,
            "tableOption": "autoCreate"
          },
          "enableStaging": false,
          "dataIntegrationUnits": 4
        }
      }
    ],
    "annotations": ["demo", "simple-copy"]
  }
}
```

### Template 2: Incremental Load with Watermark

```json
{
  "name": "IncrementalLoadPipeline",
  "properties": {
    "activities": [
      {
        "name": "GetOldWatermark",
        "type": "Lookup",
        "typeProperties": {
          "source": {
            "type": "AzureSqlSource",
            "sqlReaderQuery": "SELECT MAX(LastModifiedDate) as WatermarkValue FROM watermark_table"
          },
          "dataset": {
            "referenceName": "WatermarkDataset",
            "type": "DatasetReference"
          }
        }
      },
      {
        "name": "GetNewWatermark",
        "type": "Lookup",
        "dependsOn": [
          {
            "activity": "GetOldWatermark",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "source": {
            "type": "AzureSqlSource",
            "sqlReaderQuery": "SELECT MAX(LastModifiedDate) as NewWatermarkValue FROM source_table"
          },
          "dataset": {
            "referenceName": "SourceDataset",
            "type": "DatasetReference"
          }
        }
      },
      {
        "name": "IncrementalCopy",
        "type": "Copy",
        "dependsOn": [
          {
            "activity": "GetNewWatermark",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "source": {
            "type": "AzureSqlSource",
            "sqlReaderQuery": {
              "value": "@concat('SELECT * FROM source_table WHERE LastModifiedDate > ''', activity('GetOldWatermark').output.firstRow.WatermarkValue, ''' AND LastModifiedDate <= ''', activity('GetNewWatermark').output.firstRow.NewWatermarkValue, '''')",
              "type": "Expression"
            }
          },
          "sink": {
            "type": "SqlDWSink"
          }
        }
      },
      {
        "name": "UpdateWatermark",
        "type": "StoredProcedure",
        "dependsOn": [
          {
            "activity": "IncrementalCopy",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "storedProcedureName": "usp_update_watermark",
          "storedProcedureParameters": {
            "NewWatermarkValue": {
              "value": "@activity('GetNewWatermark').output.firstRow.NewWatermarkValue",
              "type": "DateTime"
            }
          }
        }
      }
    ]
  }
}
```

### Template 3: Error Handling and Retry Logic

```json
{
  "name": "RobustDataPipeline",
  "properties": {
    "activities": [
      {
        "name": "CopyWithRetry",
        "type": "Copy",
        "retryIntervals": [60, 180, 300],
        "typeProperties": {
          "source": {
            "type": "BlobSource"
          },
          "sink": {
            "type": "SqlDWSink"
          },
          "enableSkipIncompatibleRow": true,
          "logSettings": {
            "enableCopyActivityLog": true,
            "copyActivityLogSettings": {
              "logLevel": "Warning",
              "enableReliableLogging": true
            },
            "logLocationSettings": {
              "linkedServiceName": {
                "referenceName": "BlobStorage",
                "type": "LinkedServiceReference"
              },
              "path": "logs/copy-activity"
            }
          }
        }
      },
      {
        "name": "OnFailureNotification",
        "type": "WebActivity",
        "dependsOn": [
          {
            "activity": "CopyWithRetry",
            "dependencyConditions": ["Failed"]
          }
        ],
        "typeProperties": {
          "method": "POST",
          "url": "https://prod-xx.eastus.logic.azure.com:443/workflows/xxx",
          "body": {
            "PipelineName": "@pipeline().Pipeline",
            "RunId": "@pipeline().RunId",
            "ErrorMessage": "@activity('CopyWithRetry').Error.message"
          }
        }
      }
    ]
  }
}
```

## 🎮 Step-by-Step Tutorial

### Tutorial 1: Build Your First Pipeline

**Step 1: Create New Pipeline**

```javascript
// Initialize new pipeline
const createPipeline = () => {
  return {
    name: 'MyFirstPipeline',
    properties: {
      activities: [],
      parameters: {},
      variables: {},
      annotations: []
    }
  };
};
```

**Step 2: Add Copy Activity**

1. Drag "Copy Data" from palette to canvas
2. Configure source:
   - Dataset: `SourceBlobDataset`
   - Path: `raw-data/sales/*.csv`
   - Format: CSV with header

3. Configure sink:
   - Dataset: `SynapseSQLDataset`
   - Table: `staging.Sales`
   - Write behavior: Truncate and load

**Step 3: Add Data Flow Activity**

1. Drag "Mapping Data Flow" to canvas
2. Connect Copy activity to Data Flow (on success)
3. Configure transformations:
   - Source: staging table
   - Derived Column: Add calculated fields
   - Filter: Remove invalid records
   - Aggregate: Summary statistics
   - Sink: Final destination table

**Step 4: Add Control Flow**

```javascript
// If Condition configuration
const ifCondition = {
  name: 'CheckRowCount',
  type: 'IfCondition',
  dependsOn: [
    {
      activity: 'CopyData',
      dependencyConditions: ['Succeeded']
    }
  ],
  typeProperties: {
    expression: {
      value: "@greater(activity('CopyData').output.rowsCopied, 0)",
      type: 'Expression'
    },
    ifTrueActivities: [
      {
        name: 'ProcessData',
        type: 'DataFlow'
      }
    ],
    ifFalseActivities: [
      {
        name: 'SendAlert',
        type: 'WebActivity'
      }
    ]
  }
};
```

**Step 5: Test Pipeline**

```javascript
// Debug run configuration
const debugPipeline = async (pipelineDefinition) => {
  const response = await fetch('/api/pipeline/debug', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pipeline: pipelineDefinition,
      debugSettings: {
        sampleRowCount: 1000,
        timeout: 300,
        continueOnError: false
      }
    })
  });

  const result = await response.json();
  return {
    runId: result.runId,
    status: result.status,
    output: result.output,
    duration: result.duration
  };
};
```

### Tutorial 2: Advanced Control Flow

**ForEach Loop Example**

```json
{
  "name": "ProcessMultipleFiles",
  "type": "ForEach",
  "typeProperties": {
    "items": {
      "value": "@pipeline().parameters.FileList",
      "type": "Expression"
    },
    "isSequential": false,
    "batchCount": 4,
    "activities": [
      {
        "name": "CopyFile",
        "type": "Copy",
        "typeProperties": {
          "source": {
            "type": "BlobSource",
            "recursive": false,
            "path": "@item().FilePath"
          },
          "sink": {
            "type": "SqlDWSink"
          }
        }
      }
    ]
  }
}
```

**Until Loop Example**

```json
{
  "name": "WaitForFile",
  "type": "Until",
  "typeProperties": {
    "expression": {
      "value": "@equals(variables('FileExists'), true)",
      "type": "Expression"
    },
    "timeout": "01:00:00",
    "activities": [
      {
        "name": "CheckFileExists",
        "type": "GetMetadata",
        "typeProperties": {
          "fieldList": ["exists"],
          "storeSettings": {
            "type": "AzureBlobStorageReadSettings",
            "recursive": false
          }
        }
      },
      {
        "name": "SetFileExists",
        "type": "SetVariable",
        "dependsOn": [
          {
            "activity": "CheckFileExists",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "variableName": "FileExists",
          "value": "@activity('CheckFileExists').output.exists"
        }
      },
      {
        "name": "Wait30Seconds",
        "type": "Wait",
        "dependsOn": [
          {
            "activity": "SetFileExists",
            "dependencyConditions": ["Succeeded"]
          }
        ],
        "typeProperties": {
          "waitTimeInSeconds": 30
        }
      }
    ]
  }
}
```

## 💡 Best Practices Visualizer

### Performance Optimization

```javascript
// Pipeline performance analysis
const analyzePipelinePerformance = (pipeline) => {
  const recommendations = [];

  // Check for sequential ForEach
  pipeline.activities
    .filter(a => a.type === 'ForEach')
    .forEach(forEach => {
      if (forEach.typeProperties.isSequential) {
        recommendations.push({
          severity: 'warning',
          activity: forEach.name,
          message: 'ForEach is running sequentially',
          suggestion: 'Set isSequential to false for parallel execution',
          impact: 'High - Could reduce execution time by 70%'
        });
      }
    });

  // Check Copy activity settings
  pipeline.activities
    .filter(a => a.type === 'Copy')
    .forEach(copy => {
      const diu = copy.typeProperties.dataIntegrationUnits || 2;
      if (diu < 4) {
        recommendations.push({
          severity: 'info',
          activity: copy.name,
          message: 'Using default DIU settings',
          suggestion: 'Consider increasing DIU for large data volumes',
          impact: 'Medium - Could improve copy performance'
        });
      }
    });

  return recommendations;
};
```

### Security Best Practices

```javascript
// Security validation
const validatePipelineSecurity = (pipeline) => {
  const issues = [];

  // Check for hardcoded credentials
  const jsonStr = JSON.stringify(pipeline);
  if (jsonStr.includes('password') || jsonStr.includes('key')) {
    issues.push({
      severity: 'critical',
      message: 'Potential hardcoded credentials detected',
      suggestion: 'Use Key Vault for storing sensitive information'
    });
  }

  // Check for dynamic content without validation
  pipeline.activities.forEach(activity => {
    if (activity.type === 'WebActivity') {
      const url = activity.typeProperties.url;
      if (url.includes('@pipeline()') || url.includes('@activity()')) {
        issues.push({
          severity: 'warning',
          activity: activity.name,
          message: 'Dynamic URL construction detected',
          suggestion: 'Validate and sanitize dynamic inputs'
        });
      }
    }
  });

  return issues;
};
```

## 🔧 Troubleshooting

### Common Pipeline Issues

#### Issue: Activity Timeout

**Symptoms:**

```json
{
  "errorCode": "2200",
  "message": "Activity timed out after 7 days",
  "failureType": "UserError"
}
```

**Solution:**

```json
{
  "name": "LongRunningActivity",
  "type": "Copy",
  "policy": {
    "timeout": "7.00:00:00",
    "retry": 3,
    "retryIntervalInSeconds": 300
  }
}
```

#### Issue: Concurrent Execution Limit

**Solution:**

```json
{
  "name": "BulkCopyPipeline",
  "properties": {
    "concurrency": 50,
    "activities": [...]
  }
}
```

#### Issue: Expression Evaluation Errors

```javascript
// Common expression patterns
const expressions = {
  // Concatenate strings
  concat: "@concat('prefix_', variables('fileName'), '.csv')",

  // Conditional logic
  if: "@if(equals(variables('status'), 'active'), 'process', 'skip')",

  // Access activity output
  activityOutput: "@activity('CopyData').output.rowsCopied",

  // Pipeline parameters
  parameter: "@pipeline().parameters.EnvironmentName",

  // Date formatting
  dateFormat: "@formatDateTime(utcnow(), 'yyyy-MM-dd')",

  // Array operations
  first: "@first(pipeline().parameters.FileList)",
  last: "@last(pipeline().parameters.FileList)",
  join: "@join(pipeline().parameters.Tags, ',')"
};
```

## 🔗 Embedded Demo Link

**Launch Pipeline Builder:** [https://demos.csa-inabox.com/pipeline-builder](https://demos.csa-inabox.com/pipeline-builder)

**Features:**

- Visual drag-and-drop designer
- Real-time validation
- Template library
- Debug mode with sample data
- Export to JSON/ARM template
- Version history

## 📚 Additional Resources

- [Pipeline Activities Reference](../../code-examples/integration-guide.md)
- [Data Factory Best Practices](../../best-practices/pipeline-optimization.md)
- [Expression Language Reference](https://docs.microsoft.com/azure/data-factory/control-flow-expression-language-functions)
- [Troubleshooting Guide](../../troubleshooting/pipeline-troubleshooting/README.md)

## 💬 Feedback

> **💡 How useful was the Pipeline Builder?**

- ✅ **Created my first pipeline** - [Share your success](https://github.com/csa-inabox/docs/discussions)
- ⚠️ **Encountered issues** - [Report problem](https://github.com/csa-inabox/docs/issues/new)
- 💡 **Missing features** - [Request feature](https://github.com/csa-inabox/docs/issues/new?title=[Pipeline]+Feature)

---

*Last Updated: January 2025 | Version: 1.0.0*
