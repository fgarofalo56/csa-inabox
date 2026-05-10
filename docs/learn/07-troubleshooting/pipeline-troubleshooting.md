# Troubleshooting Pipeline Issues in Azure Synapse Analytics

[Home](../../README.md) > Troubleshooting > Pipeline Troubleshooting

This guide covers common pipeline issues in Azure Synapse Analytics, providing diagnostic approaches and solutions for data integration workflows, activity failures, and pipeline orchestration problems.

## Common Pipeline Issue Categories

Pipeline issues in Azure Synapse Analytics typically fall into these categories:

1. _Connectivity Issues_: Linked service connection failures and networking problems
2. _Activity Failures_: Errors in specific pipeline activities like Copy, Mapping Data Flow, or custom activities
3. _Trigger Problems_: Issues with scheduled, tumbling window, or event-based triggers
4. _Performance Bottlenecks_: Slow-running pipelines and optimization challenges
5. _Integration Failures_: Problems with external systems and services
6. _Monitoring and Debugging_: Challenges with monitoring pipelines and troubleshooting failures

## Connectivity Issues

### Linked Service Connection Failures

_Symptoms:_

- "Connection timed out" or "Cannot connect to server" errors
- Authentication failures when accessing data sources
- Intermittent connection issues to specific services

_Solutions:_

1. _Verify connection string and configuration_:
   - Check linked service configuration for typos or incorrect parameters
   - Test connection in the Synapse Studio UI
   - Validate credentials, account names, and endpoint URLs

   ```json
   // Example: Azure SQL Database linked service configuration
   {
     "name": "AzureSqlDatabaseLinkedService",
     "properties": {
       "type": "AzureSqlDatabase",
       "typeProperties": {
         "connectionString": "Server=tcp:server.database.windows.net,1433;Database=mydb;User ID=admin;Password=xxxx;Encrypt=true;Connection Timeout=30"
       },
       "connectVia": {
         "referenceName": "AutoResolveIntegrationRuntime",
         "type": "IntegrationRuntimeReference"
       }
     }
   }
   ```

2. _Check network access and firewall rules_:
   - Verify IP address restrictions and firewall settings
   - Check private endpoint configurations if used
   - Ensure that network security groups allow required traffic

   Common ports required for different services:

   | Service | Port | Protocol |
   |---------|------|----------|
   | Azure SQL | 1433 | TCP |
   | Azure Storage | 443 | HTTPS |
   | On-premises SQL Server | 1433 | TCP |
   | REST API | 443 | HTTPS |

3. _Validate credentials and permissions_:
   - Check if service account or identity has proper permissions
   - For managed identity, verify role assignments
   - Test authentication independently with the same credentials

   ```powershell
   # PowerShell: Check managed identity role assignments
   $workspace = Get-AzSynapseWorkspace -Name "workspace" -ResourceGroupName "resourcegroup"
   Get-AzRoleAssignment -ObjectId $workspace.Identity.PrincipalId
   ```

### Key Vault Integration Problems

_Symptoms:_

- "Access to Azure Key Vault is forbidden" errors
- Cannot retrieve secrets from Key Vault
- Credentials stored in Key Vault not resolving

_Solutions:_

1. _Check Key Vault access policies_:
   - Ensure Synapse managed identity has Get and List permissions for secrets
   - Verify Key Vault firewall settings allow access from Synapse

   ```powershell
   # PowerShell: Grant Key Vault permissions to Synapse managed identity
   $workspace = Get-AzSynapseWorkspace -Name "workspace" -ResourceGroupName "resourcegroup"
   Set-AzKeyVaultAccessPolicy -VaultName "keyvault" -ObjectId $workspace.Identity.PrincipalId -PermissionsToSecrets Get,List
   ```

2. _Verify Key Vault linked service_:
   - Test the Key Vault linked service connection
   - Check correct secret names and versions
   - Ensure proper URL format for Key Vault

   ```json
   // Example: Azure Key Vault linked service
   {
     "name": "AzureKeyVaultLinkedService",
     "properties": {
       "type": "AzureKeyVault",
       "typeProperties": {
         "baseUrl": "https://keyvault.vault.azure.net/"
       }
     }
   }
   ```

3. _Test secret retrieval manually_:
   - Use Azure Portal or PowerShell to test secret access
   - Verify secret value and expiration
   - Check for specific errors in the activity output

### Integration Runtime Issues

_Symptoms:_

- "Integration runtime is not available" errors
- Self-hosted integration runtime connectivity problems
- Performance issues with specific integration runtimes

_Solutions:_

1. _Check integration runtime status_:
   - Verify Azure IR or self-hosted IR status in Synapse Studio
   - Check for alerts or monitoring data indicating issues
   - Ensure sufficient capacity for workload

2. _Troubleshoot self-hosted integration runtime_:
   - Check self-hosted IR logs in Event Viewer (Application and Services Logs > Microsoft > Integration Runtime)
   - Verify outbound connectivity on port 443
   - Check for machine resource constraints (CPU, memory)

   ```powershell
   # PowerShell: Restart self-hosted integration runtime service
   Restart-Service -Name "DIAHostService"
   ```

3. _Configure high availability for critical workloads_:
   - Set up multiple nodes for self-hosted integration runtime
   - Implement proper monitoring and alerting
   - Consider auto-scaling for Azure integration runtime

## Activity Failures

### Copy Activity Issues

_Symptoms:_

- Copy activity fails with specific error messages
- Slow performance during data transfer
- Unexpected data transformation issues

_Solutions:_

1. _Analyze activity error details_:
   - Review the error message and stack trace in the monitoring view
   - Check specific error codes and failure categories
   - Identify which phase of the copy activity failed (pre-copy, copy, post-copy)

2. _Address common copy activity errors_:

   | Error | Common Cause | Solution |
   |-------|-------------|----------|
   | Credential issue | Invalid connection string or secret | Verify credentials and test connection |
   | Source table not found | Invalid table name or permissions | Check source object existence and permissions |
   | Column mapping error | Schema mismatch between source and sink | Review column mappings and data types |
   | File format error | Incorrect format settings | Validate format settings match the actual data |
   | Network error | Connectivity or firewall issues | Check network settings and firewall rules |

3. _Optimize copy performance_:
   - Use parallel copies and partitioning for large datasets
   - Configure appropriate integration runtime
   - Use staging for complex transformations

   ```json
   // Example: Copy activity with performance optimizations
   {
     "name": "OptimizedCopyActivity",
     "type": "Copy",
     "typeProperties": {
       "source": {
         "type": "AzureSqlSource",
         "sqlReaderQuery": "SELECT * FROM MyTable",
         "partitionOption": "PhysicalPartitionsOfTable"
       },
       "sink": {
         "type": "DelimitedTextSink",
         "storeSettings": {
           "type": "AzureBlobFSWriteSettings"
         }
       },
       "enableStaging": true,
       "stagingSettings": {
         "linkedServiceName": {
           "referenceName": "AzureBlobStorage",
           "type": "LinkedServiceReference"
         },
         "path": "staging"
       },
       "parallelCopies": 32,
       "dataIntegrationUnits": 128
     }
   }
   ```

### Mapping Data Flow Problems

_Symptoms:_

- Data flow fails during execution
- Unexpected transformations or data results
- Performance issues with complex transformations

_Solutions:_

1. _Debug with data flow monitoring_:
   - Use the data preview feature to verify transformations
   - Enable debug mode for detailed inspection
   - Check row counts and data samples at each step

2. _Address common data flow errors_:
   - Data type mismatches: Validate schema and use explicit casting
   - Expression errors: Test expressions in the expression builder
   - Memory issues: Optimize partitioning and enable debugging with optimized mode

   ```sql
   // Example: Explicit data type handling in data flow expression
   toInteger(trim(movieId))
   
   // Handling null values
   iifNull(rating, 0.0)
   ```

3. _Optimize data flow performance_:
   - Configure appropriate TTL for debug sessions
   - Use partitioning strategies for large datasets
   - Adjust optimization settings for performance

   ```json
   // Example: Data flow activity with optimization settings
   {
     "name": "DataFlowActivity",
     "type": "ExecuteDataFlow",
     "typeProperties": {
       "dataFlow": {
         "referenceName": "TransformMovieRatings",
         "type": "DataFlowReference"
       },
       "compute": {
         "coreCount": 32,
         "computeType": "General"
       },
       "staging": {
         "linkedService": {
           "referenceName": "AzureBlobStorage",
           "type": "LinkedServiceReference"
         },
         "folderPath": "staging/dataflow"
       }
     }
   }
   ```

### Spark Activity Issues

_Symptoms:_

- Spark notebook or job activities failing
- Long-running Spark activities timing out
- Resource constraints during execution

_Solutions:_

1. _Review Spark application logs_:
   - Check Spark driver and executor logs for errors
   - Look for out-of-memory exceptions or task failures
   - Analyze Spark UI for performance bottlenecks

2. _Address common Spark issues_:
   - Memory problems: Adjust executor and driver memory
   - Job failures: Check for code errors or data issues
   - Dependency issues: Verify required libraries and versions

   ```json
   // Example: Spark activity with custom configuration
   {
     "name": "SparkActivity",
     "type": "SynapseNotebook",
     "typeProperties": {
       "notebook": {
         "referenceName": "ProcessData",
         "type": "NotebookReference"
       },
       "parameters": {
         "date": "2023-04-01"
       },
       "conf": {
         "spark.dynamicAllocation.enabled": "true",
         "spark.dynamicAllocation.minExecutors": "2",
         "spark.dynamicAllocation.maxExecutors": "10"
       },
       "numExecutors": 4
     },
     "linkedServiceName": {
       "referenceName": "SynapseSparkPool",
       "type": "LinkedServiceReference"
     }
   }
   ```

3. _Optimize Spark configuration_:
   - Configure appropriate Spark pool and size
   - Use dynamic allocation for variable workloads
   - Implement proper partitioning strategies

## Trigger Problems

### Schedule Trigger Issues

_Symptoms:_

- Pipeline not running at expected times
- Inconsistent schedule execution
- Missing pipeline runs

_Solutions:_

1. _Verify trigger definition_:
   - Check timezone configuration and DST handling
   - Validate CRON expression for correctness
   - Ensure pipeline reference is correct

   ```json
   // Example: Schedule trigger configuration
   {
     "name": "DailyTrigger",
     "properties": {
       "type": "ScheduleTrigger",
       "typeProperties": {
         "recurrence": {
           "frequency": "Day",
           "interval": 1,
           "startTime": "2023-01-01T00:00:00Z",
           "timeZone": "UTC",
           "schedule": {
             "hours": [1],
             "minutes": [30]
           }
         }
       },
       "pipelines": [
         {
           "pipelineReference": {
             "referenceName": "DailyProcessingPipeline",
             "type": "PipelineReference"
           },
           "parameters": {
             "WindowStart": "@trigger().scheduledTime",
             "WindowEnd": "@trigger().scheduledTime"
           }
         }
       ]
     }
   }
   ```

2. _Check trigger activation status_:
   - Verify trigger is activated in Synapse Studio
   - Look for overlapping schedules or conflicts
   - Check resource constraints that may delay execution

3. _Monitor and analyze trigger history_:
   - Review trigger run history in monitoring view
   - Check for failed trigger executions
   - Analyze patterns in delayed or skipped executions

### Tumbling Window Trigger Issues

_Symptoms:_

- Gaps in tumbling window execution
- Dependency issues between window runs
- Reprocessing or backfill problems

_Solutions:_

1. _Check window configuration_:
   - Verify window size and delay settings
   - Check dependency settings for correctness
   - Validate start and end times

   ```json
   // Example: Tumbling window trigger with dependencies
   {
     "name": "TumblingWindowTrigger",
     "properties": {
       "type": "TumblingWindowTrigger",
       "typeProperties": {
         "frequency": "Hour",
         "interval": 1,
         "startTime": "2023-01-01T00:00:00Z",
         "delay": "00:10:00",
         "maxConcurrency": 3,
         "retryPolicy": {
           "count": 3,
           "intervalInSeconds": 30
         },
         "dependsOn": [
           {
             "type": "TumblingWindowTriggerDependencyReference",
             "offset": "1",
             "size": "1",
             "referenceTrigger": {
               "referenceName": "PreviousHourTrigger",
               "type": "TriggerReference"
             }
           }
         ]
       },
       "pipeline": {
         "pipelineReference": {
           "referenceName": "HourlyProcessingPipeline",
           "type": "PipelineReference"
         },
         "parameters": {
           "WindowStart": "@trigger().outputs.windowStartTime",
           "WindowEnd": "@trigger().outputs.windowEndTime"
         }
       }
     }
   }
   ```

2. _Troubleshoot dependency chains_:
   - Visualize dependency chains in monitoring view
   - Check for circular dependencies
   - Verify parent trigger execution status

3. _Implement proper error handling_:
   - Configure retry policies for transient failures
   - Set up appropriate concurrency limits
   - Use activity timeout settings strategically

### Event Trigger Issues

_Symptoms:_

- Pipeline not triggered by storage events
- Delayed reaction to events
- Event trigger firing too often or for unexpected events

_Solutions:_

1. _Verify event source configuration_:
   - Check storage account and container names
   - Validate event types and filters
   - Ensure event grid subscription is active

   ```json
   // Example: Event trigger configuration
   {
     "name": "BlobEventTrigger",
     "properties": {
       "type": "BlobEventsTrigger",
       "typeProperties": {
         "blobPathBeginsWith": "/container/blobs/input/",
         "blobPathEndsWith": ".csv",
         "ignoreEmptyBlobs": true,
         "scope": "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/resourcegroup/providers/Microsoft.Storage/storageAccounts/storageaccount",
         "events": ["Microsoft.Storage.BlobCreated"]
       },
       "pipeline": {
         "pipelineReference": {
           "referenceName": "ProcessCSVPipeline",
           "type": "PipelineReference"
         },
         "parameters": {
           "blobPath": "@trigger().outputs.body.url"
         }
       }
     }
   }
   ```

2. _Test event generation manually_:
   - Upload test files to trigger events
   - Use Storage Explorer to verify file paths
   - Check event delivery with Event Grid diagnostics

3. _Monitor event processing_:
   - Set up diagnostic logs for event subscriptions
   - Check for filtered or dropped events
   - Verify event delivery latency

## Performance Bottlenecks

### Slow Pipeline Execution

_Symptoms:_

- Pipelines taking longer than expected
- Increasing execution times over time
- Specific activities causing delays

_Solutions:_

1. _Analyze pipeline monitoring data_:
   - Identify slow-running activities using the monitoring view
   - Compare historical performance data
   - Look for patterns in performance degradation

2. _Optimize activity configuration_:
   - For Copy activities, use parallel copies and staging
   - For Data Flows, optimize partitioning and transformations
   - For Lookups, limit result size and use caching

   ```json
   // Example: Optimized lookup activity
   {
     "name": "CachedLookup",
     "type": "Lookup",
     "typeProperties": {
       "source": {
         "type": "AzureSqlSource",
         "sqlReaderQuery": "SELECT TOP 100 * FROM ConfigTable",
         "queryTimeout": "02:00:00",
         "partitionOption": "None"
       },
       "dataset": {
         "referenceName": "AzureSqlTable",
         "type": "DatasetReference"
       },
       "firstRowOnly": false,
       "cachingOptions": {
         "enableCaching": true,
         "cacheDuration": "06:00:00"
       }
     }
   }
   ```

3. _Implement parallel processing_:
   - Use ForEach activities with batch size and parallel execution
   - Implement proper dependency chains between activities
   - Balance parallelism with available resources

   ```json
   // Example: Optimized ForEach activity
   {
     "name": "ParallelProcessing",
     "type": "ForEach",
     "typeProperties": {
       "items": {
         "value": "@activity('GetFileList').output.value",
         "type": "Expression"
       },
       "batchCount": 10,
       "isSequential": false,
       "activities": [
         {
           "name": "ProcessFile",
           "type": "Copy",
           "...": "..."
         }
       ]
     }
   }
   ```

### Resource Constraints

_Symptoms:_

- "Resource limitation" errors
- Queue time increasing for pipeline runs
- Throttling errors from connected services

_Solutions:_

1. _Monitor resource utilization_:
   - Check integration runtime metrics
   - Monitor Azure service quotas and limits
   - Analyze patterns in resource consumption

2. _Optimize resource allocation_:
   - Scale up integration runtime for compute-intensive workloads
   - Configure appropriate concurrency limits for triggers
   - Schedule pipelines to avoid peak times

3. _Implement rate limiting and backoff strategies_:
   - Add wait activities between retries
   - Implement exponential backoff for API calls
   - Use circuit breaker patterns for unreliable services

   ```json
   // Example: Wait activity with exponential backoff
   {
     "name": "ExponentialBackoff",
     "type": "Wait",
     "typeProperties": {
       "waitTimeInSeconds": {
         "value": "@mul(power(2, activity('SetRetry').output.firstRow.RetryCount), 15)",
         "type": "Expression"
       }
     },
     "dependsOn": [
       {
         "activity": "SetRetry",
         "dependencyConditions": ["Succeeded"]
       }
     ]
   }
   ```

## Integration Failures

### Error Handling in Pipelines

_Symptoms:_

- Failed pipelines without proper error information
- Cascading failures affecting multiple pipelines
- Inconsistent error handling across activities

_Solutions:_

1. _Implement comprehensive error handling_:
   - Use activity failure outputs in expressions
   - Configure email notifications for failures
   - Store error details in logging tables

   ```json
   // Example: Error handling with IfCondition
   {
     "name": "ErrorHandling",
     "type": "IfCondition",
     "typeProperties": {
       "expression": {
         "value": "@equals(activity('CopyData').output.executionDetails[0].status, 'Failed')",
         "type": "Expression"
       },
       "ifTrueActivities": [
         {
           "name": "LogError",
           "type": "WebActivity",
           "typeProperties": {
             "method": "POST",
             "url": "https://prod-00.westus.logic.azure.com:443/...",
             "body": {
               "value": "{ \"pipelineName\": \"@{pipeline().Pipeline}\", \"error\": \"@{activity('CopyData').error.message}\" }",
               "type": "Expression"
             }
           }
         }
       ]
     },
     "dependsOn": [
       {
         "activity": "CopyData",
         "dependencyConditions": ["Completed"]
       }
     ]
   }
   ```

2. _Set up retry policies_:
   - Configure appropriate retry counts and intervals
   - Use different strategies for different failure types
   - Implement circuit breaker pattern for external services

   ```json
   // Example: Activity with retry policy
   {
     "name": "CopyWithRetry",
     "type": "Copy",
     "typeProperties": {
       "...": "..."
     },
     "policy": {
       "retry": 3,
       "retryIntervalInSeconds": 60,
       "secureOutput": false,
       "secureInput": false,
       "timeout": "01:00:00"
     }
   }
   ```

3. _Create dedicated error handling pipelines_:
   - Implement reusable error handling patterns
   - Centralize error logging and notification
   - Set up automated recovery procedures

### External Service Integration Problems

_Symptoms:_

- Failures when connecting to REST APIs
- Timeout errors with third-party services
- Inconsistent responses from external endpoints

_Solutions:_

1. _Analyze API errors_:
   - Check response status codes and bodies
   - Validate request headers and authentication
   - Test API directly with tools like Postman

2. _Implement robust Web activities_:
   - Handle authentication properly
   - Parse and validate responses
   - Configure appropriate timeouts

   ```json
   // Example: Web activity with authentication and error handling
   {
     "name": "CallRestAPI",
     "type": "WebActivity",
     "typeProperties": {
       "method": "POST",
       "url": "https://api.example.com/data",
       "headers": {
         "Content-Type": "application/json",
         "Authorization": {
           "value": "@concat('Bearer ', activity('GetToken').output.access_token)",
           "type": "Expression"
         }
       },
       "body": {
         "value": "@{activity('PrepareRequest').output.value}",
         "type": "Expression"
       },
       "authentication": {
         "type": "MSI",
         "resource": "https://api.example.com"
       },
       "connectVia": {
         "referenceName": "AutoResolveIntegrationRuntime",
         "type": "IntegrationRuntimeReference"
       }
     },
     "policy": {
       "timeout": "00:01:00",
       "retry": 2,
       "retryIntervalInSeconds": 30
     }
   }
   ```

3. _Implement circuit breaker patterns_:
   - Track failure rates for external services
   - Implement fallback mechanisms
   - Use exponential backoff for retries

## Monitoring and Debugging

### Pipeline Monitoring Challenges

_Symptoms:_

- Difficulty tracking pipeline execution
- Missing or incomplete monitoring data
- Challenges correlating related pipeline runs

_Solutions:_

1. _Set up comprehensive monitoring_:
   - Configure diagnostic settings to send logs to Log Analytics
   - Create custom dashboards for pipeline monitoring
   - Implement end-to-end tracing with correlation IDs

   ```powershell
   # PowerShell: Configure diagnostic settings for Synapse workspace
   $workspace = Get-AzSynapseWorkspace -Name "workspace" -ResourceGroupName "resourcegroup"
   $logAnalytics = Get-AzOperationalInsightsWorkspace -ResourceGroupName "resourcegroup" -Name "logworkspace"
   
   Set-AzDiagnosticSetting -ResourceId $workspace.Id `
                          -Name "SynapseDiagnostics" `
                          -WorkspaceId $logAnalytics.ResourceId `
                          -Category @("IntegrationPipelineRuns", "IntegrationActivityRuns", "IntegrationTriggerRuns") `
                          -EnableLog $true
   ```

2. _Implement custom logging_:
   - Add logging activities to pipelines
   - Store execution metadata in dedicated tables
   - Implement custom metrics for business KPIs

   ```json
   // Example: Custom logging activity
   {
     "name": "LogPipelineExecution",
     "type": "SqlServerStoredProcedure",
     "typeProperties": {
       "storedProcedureName": "[dbo].[LogPipelineExecution]",
       "storedProcedureParameters": {
         "PipelineName": {
           "value": {
             "value": "@pipeline().Pipeline",
             "type": "Expression"
           },
           "type": "String"
         },
         "RunId": {
           "value": {
             "value": "@pipeline().RunId",
             "type": "Expression"
           },
           "type": "String"
         },
         "StartTime": {
           "value": {
             "value": "@pipeline().TriggerTime",
             "type": "Expression"
           },
           "type": "DateTime"
         },
         "Status": {
           "value": "Succeeded",
           "type": "String"
         },
         "Parameters": {
           "value": {
             "value": "@string(pipeline().parameters)",
             "type": "Expression"
           },
           "type": "String"
         }
       }
     },
     "linkedServiceName": {
       "referenceName": "AzureSqlDatabase",
       "type": "LinkedServiceReference"
     }
   }
   ```

3. _Query and analyze pipeline logs_:

   ```sql
   -- Log Analytics query for pipeline performance analysis
   SynapseIntegrationPipelineRuns
   | where TimeGenerated > ago(7d)
   | where Status == "Succeeded"
   | summarize AvgDuration = avg(todouble(DurationInMs)/1000), MaxDuration = max(todouble(DurationInMs)/1000), RunCount = count() by PipelineName
   | sort by AvgDuration desc
   ```

### Debugging Complex Pipelines

_Symptoms:_

- Difficulty identifying root cause of failures
- Challenges with pipeline parameter passing
- Problems with expressions and dynamic content

_Solutions:_

1. _Use debug mode and data preview_:
   - Enable debug mode for data flows
   - Test expressions with the expression builder
   - Add set variable activities to inspect values

2. _Implement incremental testing strategy_:
   - Test individual activities first
   - Build up to complete pipelines
   - Use test parameters and datasets

3. _Debug dynamic content and expressions_:
   - Use set variable activities to capture expression results
   - Output debug information to pipeline annotations
   - Implement logging of dynamic content values

   ```json
   // Example: Debugging expressions with Set Variable
   {
     "name": "DebugExpression",
     "type": "SetVariable",
     "typeProperties": {
       "variableName": "DebugOutput",
       "value": {
         "value": "@concat('WindowStart: ', pipeline().parameters.WindowStart, ', Files: ', string(activity('GetFileList').output.childItems))",
         "type": "Expression"
       }
     },
     "dependsOn": [
       {
         "activity": "GetFileList",
         "dependencyConditions": ["Succeeded"]
       }
     ]
   }
   ```

## Best Practices for Reliable Pipelines

1. _Design for resiliency_:
   - Implement comprehensive error handling
   - Use idempotent operations where possible
   - Design for retry and recovery scenarios

2. _Optimize performance_:
   - Use parallel processing for independent operations
   - Implement appropriate batching strategies
   - Schedule pipelines to avoid resource contention

3. _Monitor and maintain_:
   - Implement comprehensive logging and monitoring
   - Set up alerts for critical failures
   - Regularly review and optimize pipeline performance

4. _Implement proper testing_:
   - Create test environments with reduced data volumes
   - Implement CI/CD for pipeline development
   - Maintain test datasets for validation

## Related Topics

- [Pipeline Monitoring and Alerting](../monitoring/monitoring-setup.md)
- [Pipeline Performance Optimization](../best-practices/pipeline-optimization.md)
- [Pipeline Security Best Practices](../best-practices/security.md)
- [DevOps Integration for Pipelines](../devops/pipeline-ci-cd.md)

## External Resources

- [Azure Synapse Analytics Pipeline Documentation](https://docs.microsoft.com/en-us/azure/synapse-analytics/get-started-pipelines)
- [Microsoft Learn: Troubleshooting Synapse Pipelines](https://learn.microsoft.com/en-us/azure/data-factory/data-factory-troubleshoot-guide)
- [Pipeline Activity Reference](https://docs.microsoft.com/en-us/azure/data-factory/concepts-pipelines-activities)
