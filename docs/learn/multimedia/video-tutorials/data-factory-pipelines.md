# Video Script: Azure Data Factory Pipeline Creation

![Duration: 30 minutes](https://img.shields.io/badge/Duration-30%20minutes-blue)
![Level: Intermediate](https://img.shields.io/badge/Level-Intermediate-orange)
![Version: 1.0](https://img.shields.io/badge/Version-1.0-blue)

## Video Metadata

- **Title**: Azure Data Factory Pipeline Creation - Complete Guide
- **Duration**: 30:00
- **Target Audience**: Data engineers and ETL developers
- **Skill Level**: Intermediate
- **Prerequisites**:
  - Basic understanding of ETL concepts
  - Azure subscription with Data Factory resource
  - Familiarity with data sources (SQL, Blob Storage)
  - Understanding of data transformation concepts
- **Tools Required**:
  - Azure Portal access
  - Data Factory Studio
  - Sample data sources configured
  - Azure Storage Explorer (optional)

## Learning Objectives

By the end of this video, viewers will be able to:

1. Create and configure Azure Data Factory pipelines from scratch
2. Implement data movement activities with various connectors
3. Add data transformation logic using data flows
4. Configure pipeline parameters and expressions
5. Set up triggers and scheduling for automation
6. Monitor and troubleshoot pipeline executions

## Video Script

### Opening Hook (0:00 - 0:45)

**[SCENE 1: Animated Title Sequence]**
**[Background: Azure blue with data flow animations]**

**NARRATOR**:
"Data doesn't move itself. Whether you're migrating databases, synchronizing systems, or building a modern data warehouse, you need reliable, scalable data integration. Enter Azure Data Factory - Microsoft's cloud-based ETL and data integration service."

**[VISUAL: Quick montage showing]**
- Data flowing between various sources
- Pipeline execution graphs
- Transformation activities
- Monitoring dashboards

**NARRATOR**:
"In the next 30 minutes, I'll show you how to build production-ready data pipelines that move and transform data at scale. Let's get started!"

**[TRANSITION: Fade to Data Factory Studio]**

### Introduction & Architecture (0:45 - 3:30)

**[SCENE 2: Architecture Overview]**

**NARRATOR**:
"Azure Data Factory, or ADF, is a fully managed serverless data integration service. It allows you to create, schedule, and orchestrate data workflows that can move and transform data from over 95 different sources."

**[VISUAL: ADF architecture diagram]**

**Key Components**:
- **Pipelines**: Logical grouping of activities
- **Activities**: Individual tasks (copy, transform, control flow)
- **Datasets**: Data structures within data stores
- **Linked Services**: Connection strings to data sources
- **Triggers**: Schedule or event-based execution
- **Integration Runtime**: Compute infrastructure

**NARRATOR**:
"Think of pipelines as workflows. Each pipeline contains activities that perform specific tasks, and these activities work with datasets through linked services. The Integration Runtime provides the compute environment where activities execute."

**[VISUAL: Show how components relate]**

**NARRATOR**:
"Today we'll build a complete pipeline that extracts data from Azure SQL Database, transforms it, and loads it into Azure Data Lake Storage - a classic ETL pattern."

**[TRANSITION: Zoom into Data Factory Studio]**

### Section 1: Setting Up Linked Services (3:30 - 7:00)

**[SCENE 3: Data Factory Studio Screen Recording]**

**NARRATOR**:
"Before we can move data, we need to establish connections to our source and destination systems. These are called Linked Services."

**[VISUAL: Navigate to Manage hub in ADF Studio]**

#### Creating Source Linked Service (3:30 - 5:00)

**NARRATOR**:
"First, let's create a linked service for our Azure SQL Database source."

**[VISUAL: Click on Linked Services, then New]**

**Steps Shown**:
1. Click "New linked service"
2. Search for "Azure SQL Database"
3. Configure connection:

```json
{
  "name": "SourceSqlDatabase",
  "type": "AzureSqlDatabase",
  "typeProperties": {
    "connectionString": "Server=tcp:myserver.database.windows.net,1433;Database=SourceDB;",
    "authenticationType": "ManagedIdentity"
  }
}
```

**NARRATOR**:
"Notice I'm using Managed Identity for authentication - this is a security best practice that eliminates the need to store credentials."

**[VISUAL: Test connection, show success message]**

#### Creating Destination Linked Service (5:00 - 6:30)

**NARRATOR**:
"Now let's create a linked service for our Azure Data Lake Storage destination."

**[VISUAL: Create new linked service for ADLS Gen2]**

**Configuration**:
```json
{
  "name": "DestinationDataLake",
  "type": "AzureBlobFS",
  "typeProperties": {
    "url": "https://mydatalake.dfs.core.windows.net/",
    "authenticationType": "ManagedIdentity"
  }
}
```

**Key Points**:
- Use ADLS Gen2 connector for better performance
- Managed Identity simplifies security
- Test connection before proceeding

**[VISUAL: Show both linked services in the list]**

**NARRATOR**:
"Great! Now we have secure connections to both our source and destination."

**[TRANSITION: Navigate to Author hub]**

### Section 2: Creating Datasets (7:00 - 10:30)

**[SCENE 4: Dataset Configuration]**

**NARRATOR**:
"Datasets represent the structure of data within our linked services. Let's create datasets for our source and destination."

#### Source Dataset (7:00 - 8:30)

**[VISUAL: Create new dataset]**

**NARRATOR**:
"I'll create a dataset pointing to our source table in SQL Database."

**[VISUAL: Select Azure SQL Database, choose linked service]**

**Dataset Configuration**:
```json
{
  "name": "SourceCustomersTable",
  "properties": {
    "linkedServiceName": "SourceSqlDatabase",
    "type": "AzureSqlTable",
    "schema": [
      { "name": "customer_id", "type": "int" },
      { "name": "name", "type": "varchar" },
      { "name": "email", "type": "varchar" },
      { "name": "created_date", "type": "datetime" }
    ],
    "typeProperties": {
      "tableName": "dbo.Customers"
    }
  }
}
```

**[VISUAL: Preview data button, show sample rows]**

**NARRATOR**:
"The preview feature lets us verify we're connected to the right table and see the data structure."

#### Destination Dataset (8:30 - 10:00)

**[VISUAL: Create dataset for Data Lake]**

**NARRATOR**:
"Now let's create a dataset for our destination in the data lake. I'll use Parquet format for optimal performance and compression."

**Dataset Configuration**:
```json
{
  "name": "DestinationCustomersParquet",
  "properties": {
    "linkedServiceName": "DestinationDataLake",
    "type": "Parquet",
    "typeProperties": {
      "location": {
        "type": "AzureBlobFSLocation",
        "folderPath": "raw/customers",
        "container": "data"
      },
      "compressionCodec": "snappy"
    }
  }
}
```

**Key Decisions**:
- Parquet format for analytics workloads
- Snappy compression for balance of speed/size
- Organized folder structure (raw/customers)

**[VISUAL: Show both datasets in Author hub]**

**[TRANSITION: Create new pipeline]**

### Section 3: Building the Pipeline (10:30 - 18:00)

**[SCENE 5: Pipeline Canvas]**

**NARRATOR**:
"Now for the exciting part - building our pipeline! I'll create a pipeline that not only copies data but also includes error handling and logging."

**[VISUAL: Click New Pipeline]**

#### Adding Copy Data Activity (10:30 - 13:00)

**NARRATOR**:
"The Copy Data activity is the workhorse of ADF. Let's add one to our pipeline."

**[VISUAL: Drag Copy Data activity to canvas]**

**Configuration Steps**:

**Source Tab**:
```json
{
  "source": {
    "type": "AzureSqlSource",
    "sqlReaderQuery": "SELECT * FROM dbo.Customers WHERE created_date >= '@{pipeline().parameters.StartDate}'"
  }
}
```

**NARRATOR**:
"Notice I'm using a parameterized query. This makes our pipeline reusable - we can pass different start dates each time it runs."

**Sink Tab**:
```json
{
  "sink": {
    "type": "ParquetSink",
    "storeSettings": {
      "type": "AzureBlobFSWriteSettings",
      "copyBehavior": "PreserveHierarchy"
    }
  }
}
```

**Mapping Tab**:
**[VISUAL: Show schema mapping interface]**

**NARRATOR**:
"ADF automatically maps columns with matching names, but we can customize the mapping if needed."

#### Adding Parameters (13:00 - 14:30)

**[VISUAL: Click on pipeline canvas background]**

**NARRATOR**:
"Let's add parameters to make this pipeline flexible and reusable."

**Parameters Configuration**:
```json
{
  "parameters": {
    "StartDate": {
      "type": "String",
      "defaultValue": "2024-01-01"
    },
    "Environment": {
      "type": "String",
      "defaultValue": "dev"
    },
    "NotificationEmail": {
      "type": "String",
      "defaultValue": "dataops@company.com"
    }
  }
}
```

**Key Benefits**:
- Reusable across different scenarios
- No need to modify pipeline for different dates
- Can be triggered with different values

#### Adding Control Flow Logic (14:30 - 16:30)

**NARRATOR**:
"Professional pipelines need error handling. Let's add some control flow activities."

**[VISUAL: Add If Condition activity]**

**Validation Check**:
```json
{
  "name": "CheckRowCount",
  "type": "IfCondition",
  "expression": "@greater(activity('CopyCustomers').output.rowsCopied, 0)",
  "ifTrueActivities": [
    {
      "name": "LogSuccess",
      "type": "WebActivity"
    }
  ],
  "ifFalseActivities": [
    {
      "name": "LogWarning",
      "type": "WebActivity"
    }
  ]
}
```

**[VISUAL: Connect activities with success/failure paths]**

**NARRATOR**:
"This If Condition checks if any rows were copied. If yes, we log success. If no, we log a warning. This helps us catch data quality issues early."

#### Adding Error Handling (16:30 - 18:00)

**[VISUAL: Configure failure path from Copy activity]**

**NARRATOR**:
"Let's add error notification using a Web Activity."

**Web Activity Configuration**:
```json
{
  "name": "SendErrorNotification",
  "type": "WebActivity",
  "method": "POST",
  "url": "https://prod-01.eastus.logic.azure.com/workflows/...",
  "body": {
    "pipelineName": "@{pipeline().Pipeline}",
    "errorMessage": "@{activity('CopyCustomers').error.message}",
    "runId": "@{pipeline().RunId}",
    "timestamp": "@{utcnow()}"
  }
}
```

**NARRATOR**:
"This Web Activity calls an Azure Logic App that sends email notifications when the pipeline fails. Critical for production monitoring."

**[VISUAL: Show complete pipeline with all activities]**

**[TRANSITION: Save and validate pipeline]**

### Section 4: Advanced Features (18:00 - 23:00)

**[SCENE 6: Advanced Configuration]**

#### Data Flow Transformations (18:00 - 20:00)

**NARRATOR**:
"Sometimes you need to transform data during the copy process. Let's add a Data Flow activity."

**[VISUAL: Add Data Flow activity to pipeline]**

**NARRATOR**:
"Data Flows provide a visual interface for building complex transformations without writing code."

**[VISUAL: Create new Data Flow]**

**Transformation Example**:
```
Source (Customers)
  → Filter (created_date >= $StartDate)
  → DerivedColumn (full_name = concat(first_name, ' ', last_name))
  → AggregateByRegion (count customers by region)
  → Sink (Write to Data Lake)
```

**[VISUAL: Show Data Flow canvas with transformations]**

**Key Transformations Available**:
- Filter: Remove unwanted rows
- Derived Column: Create calculated fields
- Aggregate: Group and summarize data
- Join: Combine multiple sources
- Pivot/Unpivot: Reshape data
- Window: Ranking and windowing functions

#### Incremental Data Loading (20:00 - 21:30)

**NARRATOR**:
"For large tables, you don't want to copy all data every time. Let's implement incremental loading using a watermark."

**[VISUAL: Add Lookup activity before Copy]**

**Watermark Lookup**:
```sql
-- Get last successful load timestamp
SELECT MAX(load_timestamp) as LastLoadTime
FROM control.WatermarkTable
WHERE table_name = 'Customers'
```

**Modified Copy Query**:
```sql
SELECT *
FROM dbo.Customers
WHERE modified_date > '@{activity('GetWatermark').output.firstRow.LastLoadTime}'
```

**[VISUAL: Add Stored Procedure activity after Copy]**

**Update Watermark**:
```sql
UPDATE control.WatermarkTable
SET load_timestamp = '@{utcnow()}'
WHERE table_name = 'Customers'
```

**NARRATOR**:
"This pattern ensures we only copy changed data, dramatically improving performance for large tables."

#### Parallel Execution (21:30 - 23:00)

**NARRATOR**:
"ADF can process multiple activities in parallel for better performance."

**[VISUAL: Add ForEach activity]**

**ForEach Configuration**:
```json
{
  "name": "ForEachTable",
  "type": "ForEach",
  "typeProperties": {
    "items": "@pipeline().parameters.TableList",
    "isSequential": false,
    "batchCount": 4,
    "activities": [
      {
        "name": "CopyTableData",
        "type": "Copy"
      }
    ]
  }
}
```

**NARRATOR**:
"By setting isSequential to false and specifying a batch count, we can copy multiple tables simultaneously. This can reduce total pipeline execution time by 70% or more."

**[VISUAL: Show parallel execution in monitoring]**

**[TRANSITION: Navigate to Triggers]**

### Section 5: Scheduling and Triggers (23:00 - 26:00)

**[SCENE 7: Trigger Configuration]**

**NARRATOR**:
"A pipeline is useless if you have to run it manually every time. Let's set up triggers for automation."

#### Schedule Trigger (23:00 - 24:00)

**[VISUAL: Add trigger, select Schedule trigger]**

**Schedule Configuration**:
```json
{
  "name": "DailyCustomerSync",
  "properties": {
    "type": "ScheduleTrigger",
    "typeProperties": {
      "recurrence": {
        "frequency": "Day",
        "interval": 1,
        "startTime": "2024-01-01T02:00:00Z",
        "timeZone": "UTC",
        "schedule": {
          "hours": [2],
          "minutes": [0]
        }
      }
    }
  }
}
```

**NARRATOR**:
"This trigger runs our pipeline daily at 2 AM UTC - a common pattern for overnight batch processing."

#### Tumbling Window Trigger (24:00 - 25:00)

**NARRATOR**:
"For incremental loads, Tumbling Window triggers are better because they handle backfill automatically."

**Configuration**:
```json
{
  "name": "HourlyIncremental",
  "properties": {
    "type": "TumblingWindowTrigger",
    "typeProperties": {
      "frequency": "Hour",
      "interval": 1,
      "startTime": "2024-01-01T00:00:00Z",
      "maxConcurrency": 1
    },
    "pipeline": {
      "parameters": {
        "WindowStart": "@trigger().outputs.windowStartTime",
        "WindowEnd": "@trigger().outputs.windowEndTime"
      }
    }
  }
}
```

**Key Benefits**:
- Automatic retry of failed windows
- Backfill historical data
- Exactly-once processing guarantee

#### Event-Based Trigger (25:00 - 26:00)

**NARRATOR**:
"You can also trigger pipelines based on events, like when a file arrives in Blob Storage."

**[VISUAL: Create Storage Event trigger]**

**Event Trigger Configuration**:
```json
{
  "name": "OnFileArrival",
  "properties": {
    "type": "BlobEventsTrigger",
    "typeProperties": {
      "blobPathBeginsWith": "/data/landing/",
      "blobPathEndsWith": ".csv",
      "events": ["Microsoft.Storage.BlobCreated"]
    }
  }
}
```

**NARRATOR**:
"This trigger fires whenever a CSV file is created in the landing folder - perfect for real-time data ingestion scenarios."

**[TRANSITION: Navigate to Monitor hub]**

### Section 6: Monitoring and Troubleshooting (26:00 - 28:30)

**[SCENE 8: Monitoring Dashboard]**

**NARRATOR**:
"Let's explore the monitoring capabilities that help you keep pipelines running smoothly."

#### Pipeline Runs View (26:00 - 27:00)

**[VISUAL: Show Monitor hub with pipeline runs]**

**NARRATOR**:
"The Monitor hub shows all pipeline executions with their status, duration, and trigger type."

**[VISUAL: Click on a pipeline run]**

**Key Metrics Displayed**:
- Run status (Succeeded, Failed, In Progress)
- Start time and duration
- Trigger type (Manual, Schedule, Event)
- Input/output parameters

**[VISUAL: Click on Copy activity to see details]**

**Activity Details**:
```json
{
  "rowsRead": 150000,
  "rowsCopied": 150000,
  "dataRead": "45.5 MB",
  "dataWritten": "38.2 MB",
  "throughput": "2.8 MB/s",
  "duration": "00:02:15"
}
```

#### Troubleshooting Failed Runs (27:00 - 28:00)

**NARRATOR**:
"When a pipeline fails, ADF provides detailed error information."

**[VISUAL: Click on failed pipeline run]**

**Error Analysis**:
```json
{
  "errorCode": "2200",
  "message": "Timeout occurred while waiting for response from SQL Database",
  "failureType": "UserError",
  "target": "CopyCustomers",
  "details": [
    {
      "message": "Connection timeout after 30 seconds",
      "recommendation": "Check network connectivity or increase timeout setting"
    }
  ]
}
```

**Common Issues and Solutions**:
1. **Authentication errors**: Verify Managed Identity permissions
2. **Timeout errors**: Increase timeout or optimize query
3. **Schema mismatch**: Check source/sink mapping
4. **Resource limits**: Adjust DIU (Data Integration Units) settings

#### Performance Optimization (28:00 - 28:30)

**[VISUAL: Show activity duration breakdown]**

**NARRATOR**:
"The performance breakdown helps identify bottlenecks."

**Optimization Tips**:
- Increase DIU for large data volumes
- Use PolyBase for SQL Data Warehouse
- Enable staging for better performance
- Partition large datasets
- Use binary copy when possible

**[TRANSITION: Conclusion]**

### Best Practices Recap (28:30 - 29:15)

**[SCENE 9: Best Practices Overlay]**

**NARRATOR**:
"Before we wrap up, let's recap the best practices we've covered."

**Design Patterns**:
- ✅ Use parameters for reusability
- ✅ Implement error handling and notifications
- ✅ Use incremental loading for large tables
- ✅ Enable parallel execution when possible
- ✅ Leverage Managed Identity for security

**Performance**:
- ✅ Choose appropriate file formats (Parquet for analytics)
- ✅ Partition data logically
- ✅ Adjust DIU based on workload
- ✅ Use compression for data transfer
- ✅ Monitor and optimize query performance

**Security**:
- ✅ Use Managed Identity instead of credentials
- ✅ Enable private endpoints for sensitive data
- ✅ Implement RBAC for access control
- ✅ Encrypt data in transit and at rest
- ✅ Audit pipeline executions

**Cost Optimization**:
- ✅ Use Serverless SQL for ad-hoc queries
- ✅ Schedule pipelines during off-peak hours
- ✅ Clean up old pipeline runs
- ✅ Right-size DIU allocation
- ✅ Use auto-scale for Integration Runtime

### Conclusion & Next Steps (29:15 - 30:00)

**[SCENE 10: Conclusion]**

**NARRATOR**:
"Congratulations! You now know how to build production-ready data pipelines in Azure Data Factory."

**What We Covered**:
- ✅ Linked services and datasets
- ✅ Copy and transformation activities
- ✅ Control flow and error handling
- ✅ Triggers and scheduling
- ✅ Monitoring and troubleshooting

**Next Steps**:
1. Build your first pipeline with real data sources
2. Explore Data Flow transformations
3. Implement CI/CD for pipeline deployment
4. Integrate with Azure Synapse Analytics
5. Set up alerts and notifications

**Resources**:
- [ADF Documentation](https://docs.microsoft.com/azure/data-factory/)
- [Pipeline Templates](https://docs.microsoft.com/azure/data-factory/solution-templates-introduction)
- [Best Practices Guide](https://docs.microsoft.com/azure/data-factory/concepts-pipelines-activities)
- [Pricing Calculator](https://azure.microsoft.com/pricing/details/data-factory/)

**NARRATOR**:
"Thanks for watching! If you found this helpful, check out our video on Synapse Analytics integration. Don't forget to like and subscribe for more Azure tutorials!"

**[VISUAL: End screen with related videos]**

**[FADE OUT]**

## Production Notes

### Visual Assets Required

- [x] Opening animation with data flow graphics
- [x] ADF architecture diagram (4K)
- [x] Linked service configuration screenshots
- [x] Dataset preview examples
- [x] Pipeline canvas recordings
- [x] Data Flow transformation visuals
- [x] Monitoring dashboard screenshots
- [x] Error troubleshooting examples
- [x] End screen with channel branding

### Screen Recording Checklist

- [x] Clean ADF Studio interface
- [x] Sample workspace pre-configured
- [x] Test data sources connected
- [x] Pipeline templates prepared
- [x] Monitoring data available
- [x] Browser zoom at 90% for visibility
- [x] High-contrast mode disabled (use default theme)

### Audio Requirements

- [x] Professional narration (technical but approachable)
- [x] Background music (subtle, tech-focused)
- [x] Sound effects for activity execution
- [x] Audio ducking during detailed configurations
- [x] Consistent volume levels throughout

### Post-Production Tasks

- [x] Chapter markers at each major section
- [x] Captions with technical term accuracy
- [x] Code callouts and zoom-ins for JSON
- [x] Highlight cursor during important clicks
- [x] Add progress bar for long operations
- [x] Include comparison overlays for before/after
- [x] Custom thumbnail with pipeline graphic
- [x] Export in 1080p and 4K

### Accessibility Checklist

- [x] Closed captions with 99%+ accuracy
- [x] Audio descriptions for visual diagrams
- [x] Full transcript available
- [x] High contrast verified for all text
- [x] Font size 18pt minimum
- [x] No rapid transitions or flashing

### Video SEO Metadata

**Title**: Azure Data Factory Pipelines - Complete Tutorial from Scratch (2024)

**Description**:
```
Master Azure Data Factory pipeline creation! This 30-minute comprehensive tutorial shows you how to build production-ready ETL pipelines with monitoring, error handling, and automation.

🎯 What You'll Learn:
✅ Linked services and dataset configuration
✅ Copy and transformation activities
✅ Control flow and error handling
✅ Scheduling with triggers
✅ Monitoring and troubleshooting

⏱️ Timestamps:
0:00 - Introduction
0:45 - ADF Architecture Overview
3:30 - Setting Up Linked Services
7:00 - Creating Datasets
10:30 - Building the Pipeline
18:00 - Advanced Features
23:00 - Scheduling and Triggers
26:00 - Monitoring and Troubleshooting
28:30 - Best Practices
29:15 - Conclusion

🔗 Resources:
📖 Documentation: [link]
💻 Sample Pipelines: [link]
🎓 Next Video: Stream Analytics Integration

#Azure #DataFactory #ETL #DataEngineering #DataIntegration
```

**Tags**: Azure Data Factory, ADF, ETL, Data Pipeline, Data Engineering, Azure, Cloud Computing, Data Integration, Big Data, Tutorial

## Related Videos

- **Next**: [Stream Analytics Introduction](stream-analytics-intro.md)
- **Related**: [Synapse Analytics Integration](synapse-fundamentals.md)
- **Advanced**: [CI/CD for Data Pipelines](ci-cd-pipelines.md)

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2024-01-15 | Initial script creation |

---

**📊 Estimated Production Time**: 50-60 hours (pre-production: 10hrs, recording: 15hrs, editing: 25hrs, QA: 10hrs)

**🎬 Production Status**: ![Status](https://img.shields.io/badge/Status-Script%20Complete-brightgreen)

*Last Updated: January 2025*
