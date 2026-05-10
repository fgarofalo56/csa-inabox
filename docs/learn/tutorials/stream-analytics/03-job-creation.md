# 🔧 Tutorial 3: Stream Analytics Job Creation

![Tutorial](https://img.shields.io/badge/Tutorial-03_Job_Creation-blue)
![Duration](https://img.shields.io/badge/Duration-35_minutes-green)
![Level](https://img.shields.io/badge/Level-Intermediate-yellow)

__Create your first Azure Stream Analytics job with proper input/output configuration. Learn the fundamentals of Stream Analytics Query Language (SAQL) and test queries with live data.__

## 🎯 Learning Objectives

After completing this tutorial, you will be able to:

- ✅ __Create Stream Analytics job__ with optimal settings
- ✅ __Configure Event Hub input__ with timestamp and partition settings
- ✅ __Set up multiple outputs__ including Blob Storage and SQL Database
- ✅ __Write basic SAQL queries__ for data transformation
- ✅ __Test queries__ with sample data and live streams
- ✅ __Monitor job metrics__ and troubleshoot issues

## ⏱️ Time Estimate: 35 minutes

- __Job Creation & Configuration__: 15 minutes
- __Input/Output Setup__: 10 minutes
- __Query Development__: 10 minutes

## 📋 Prerequisites

- [x] Completed [Tutorial 01: Environment Setup](01-environment-setup.md)
- [x] Completed [Tutorial 02: Data Generator Setup](02-data-generator.md)
- [x] Data generators actively sending events to Event Hub
- [x] Storage Account created

## 🛠️ Step 1: Create Stream Analytics Job

### __1.1 Create Job via Azure CLI__

Create a Stream Analytics job in your resource group:

```powershell
# Create Stream Analytics job
az stream-analytics job create `
    --name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --location $env:STREAM_LOCATION `
    --output-error-policy "Drop" `
    --events-outoforder-policy "Adjust" `
    --events-outoforder-max-delay 10 `
    --events-late-arrival-max-delay 5 `
    --data-locale "en-US" `
    --compatibility-level "1.2" `
    --tags "Environment=Tutorial" "Purpose=Learning"

# Verify job creation
az stream-analytics job show `
    --name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --query "{Name:name, State:jobState, CreatedDate:createdDate}" `
    --output table
```

__Expected Output:__

```text
Name                      State    CreatedDate
------------------------  -------  -----------------------
streamtutorial-asa-1234   Created  2025-01-15T10:30:00Z
```

### __1.2 Configure Streaming Units__

Set appropriate compute capacity for the job:

```powershell
# Configure with 1 Streaming Unit (SU) for tutorial
az stream-analytics job update `
    --name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --streaming-units 1

# Verify streaming units
az stream-analytics job show `
    --name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --query "transformation.streamingUnits" `
    --output tsv
```

> __💡 Streaming Units:__ Start with 1 SU for development. Scale up to 3, 6, or more SUs for production based on throughput requirements.

## 📥 Step 2: Configure Event Hub Input

### __2.1 Create Input Configuration File__

Create JSON configuration for Event Hub input:

```powershell
# Create input configuration
$inputConfig = @{
    properties = @{
        type = "Stream"
        datasource = @{
            type = "Microsoft.ServiceBus/EventHub"
            properties = @{
                serviceBusNamespace = $env:STREAM_EH_NAMESPACE
                eventHubName = $env:STREAM_EH_NAME
                consumerGroupName = "`$Default"
                authenticationMode = "ConnectionString"
                sharedAccessPolicyName = "ListenPolicy"
                sharedAccessPolicyKey = (az eventhubs eventhub authorization-rule keys list `
                    --name ListenPolicy `
                    --eventhub-name $env:STREAM_EH_NAME `
                    --namespace-name $env:STREAM_EH_NAMESPACE `
                    --resource-group $env:STREAM_RG `
                    --query primaryKey `
                    --output tsv)
            }
        }
        serialization = @{
            type = "Json"
            properties = @{
                encoding = "UTF8"
            }
        }
    }
} | ConvertTo-Json -Depth 10

# Save to file
$inputConfig | Out-File -FilePath "eventhub-input.json" -Encoding UTF8

# Create input
az stream-analytics input create `
    --job-name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --name "EventHubInput" `
    --properties @eventhub-input.json
```

### __2.2 Configure Timestamp Settings__

Define how to extract event time from your data:

```powershell
# Update input with timestamp configuration
$timestampConfig = @{
    properties = @{
        type = "Stream"
        datasource = @{
            type = "Microsoft.ServiceBus/EventHub"
            properties = @{
                serviceBusNamespace = $env:STREAM_EH_NAMESPACE
                eventHubName = $env:STREAM_EH_NAME
                consumerGroupName = "`$Default"
                authenticationMode = "ConnectionString"
                sharedAccessPolicyName = "ListenPolicy"
                sharedAccessPolicyKey = (az eventhubs eventhub authorization-rule keys list `
                    --name ListenPolicy `
                    --eventhub-name $env:STREAM_EH_NAME `
                    --namespace-name $env:STREAM_EH_NAMESPACE `
                    --resource-group $env:STREAM_RG `
                    --query primaryKey `
                    --output tsv)
            }
        }
        serialization = @{
            type = "Json"
            properties = @{
                encoding = "UTF8"
            }
        }
    }
} | ConvertTo-Json -Depth 10 | Out-File -FilePath "eventhub-input-timestamp.json" -Encoding UTF8

az stream-analytics input update `
    --job-name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --name "EventHubInput" `
    --properties @eventhub-input-timestamp.json
```

### __2.3 Test Input Connection__

Verify Event Hub input is configured correctly:

```powershell
# Test input connectivity
az stream-analytics input test `
    --job-name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --input-name "EventHubInput"

# Check input status
az stream-analytics input show `
    --job-name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --input-name "EventHubInput" `
    --query "{Name:name, Type:properties.type, Source:properties.datasource.type}" `
    --output table
```

## 📤 Step 3: Configure Outputs

### __3.1 Create Blob Storage Output__

Configure output for raw data archival:

```powershell
# Create Blob Storage output configuration
$blobOutputConfig = @{
    properties = @{
        datasource = @{
            type = "Microsoft.Storage/Blob"
            properties = @{
                storageAccounts = @(
                    @{
                        accountName = $env:STREAM_SA
                        accountKey = $env:STREAM_SA_KEY
                    }
                )
                container = "rawdata"
                pathPattern = "{date}/{time}"
                dateFormat = "yyyy-MM-dd"
                timeFormat = "HH"
            }
        }
        serialization = @{
            type = "Json"
            properties = @{
                encoding = "UTF8"
                format = "LineSeparated"
            }
        }
    }
} | ConvertTo-Json -Depth 10 | Out-File -FilePath "blob-output.json" -Encoding UTF8

# Create Blob output
az stream-analytics output create `
    --job-name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --name "BlobOutput" `
    --properties @blob-output.json
```

### __3.2 Create Azure SQL Database Output__

First, create a SQL Database for structured outputs:

```powershell
# Create SQL Server
$sqlServerName = "streamtutorial-sql-$(Get-Random -Minimum 1000 -Maximum 9999)"
$sqlAdminUser = "sqladmin"
$sqlAdminPassword = "P@ssw0rd$(Get-Random -Minimum 1000 -Maximum 9999)!"

az sql server create `
    --name $sqlServerName `
    --resource-group $env:STREAM_RG `
    --location $env:STREAM_LOCATION `
    --admin-user $sqlAdminUser `
    --admin-password $sqlAdminPassword

# Configure firewall to allow Azure services
az sql server firewall-rule create `
    --server $sqlServerName `
    --resource-group $env:STREAM_RG `
    --name "AllowAzureServices" `
    --start-ip-address 0.0.0.0 `
    --end-ip-address 0.0.0.0

# Create database
$sqlDatabaseName = "StreamAnalyticsDB"

az sql db create `
    --server $sqlServerName `
    --resource-group $env:STREAM_RG `
    --name $sqlDatabaseName `
    --service-objective Basic `
    --max-size 2GB

# Save SQL credentials
[Environment]::SetEnvironmentVariable("STREAM_SQL_SERVER", $sqlServerName, "User")
[Environment]::SetEnvironmentVariable("STREAM_SQL_DB", $sqlDatabaseName, "User")
[Environment]::SetEnvironmentVariable("STREAM_SQL_USER", $sqlAdminUser, "User")
[Environment]::SetEnvironmentVariable("STREAM_SQL_PASSWORD", $sqlAdminPassword, "User")

Write-Host "SQL Database created: $sqlServerName/$sqlDatabaseName"
```

Create the output table:

```powershell
# Install SqlServer module if not present
if (!(Get-Module -ListAvailable -Name SqlServer)) {
    Install-Module -Name SqlServer -Force -AllowClobber
}

# Create table for sensor readings
$createTableQuery = @"
CREATE TABLE SensorReadings (
    DeviceId NVARCHAR(50) NOT NULL,
    Location NVARCHAR(200) NOT NULL,
    EventTimestamp DATETIME2 NOT NULL,
    Temperature FLOAT NOT NULL,
    Humidity FLOAT NOT NULL,
    Pressure FLOAT NOT NULL,
    Vibration FLOAT NOT NULL,
    Status NVARCHAR(20) NOT NULL,
    EventType NVARCHAR(20) NOT NULL,
    PRIMARY KEY (DeviceId, EventTimestamp)
);

CREATE NONCLUSTERED INDEX IX_SensorReadings_Timestamp
    ON SensorReadings(EventTimestamp DESC);

CREATE NONCLUSTERED INDEX IX_SensorReadings_Status
    ON SensorReadings(Status);
"@

$connectionString = "Server=tcp:$sqlServerName.database.windows.net,1433;Initial Catalog=$sqlDatabaseName;Persist Security Info=False;User ID=$sqlAdminUser;Password=$sqlAdminPassword;MultipleActiveResultSets=False;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;"

Invoke-Sqlcmd -ConnectionString $connectionString -Query $createTableQuery

Write-Host "✅ SQL table created successfully"
```

Configure SQL Database output:

```powershell
# Create SQL output configuration
$sqlOutputConfig = @{
    properties = @{
        datasource = @{
            type = "Microsoft.Sql/Server/Database"
            properties = @{
                server = "$sqlServerName.database.windows.net"
                database = $sqlDatabaseName
                user = $sqlAdminUser
                password = $sqlAdminPassword
                table = "SensorReadings"
            }
        }
    }
} | ConvertTo-Json -Depth 10 | Out-File -FilePath "sql-output.json" -Encoding UTF8

# Create SQL output
az stream-analytics output create `
    --job-name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --name "SqlOutput" `
    --properties @sql-output.json
```

### __3.3 Verify Output Configuration__

List all configured outputs:

```powershell
# List all outputs
az stream-analytics output list `
    --job-name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --query "[].{Name:name, Type:properties.datasource.type}" `
    --output table
```

__Expected Output:__

```text
Name        Type
----------  ---------------------------------
BlobOutput  Microsoft.Storage/Blob
SqlOutput   Microsoft.Sql/Server/Database
```

## 📝 Step 4: Write Stream Analytics Query

### __4.1 Create Pass-Through Query__

Start with a simple query that passes all data through:

```sql
-- Basic pass-through query
-- Reads from Event Hub and writes to all outputs

-- Output 1: Send all raw data to Blob Storage
SELECT
    deviceId,
    location,
    timestamp AS eventTimestamp,
    temperature,
    humidity,
    pressure,
    vibration,
    status,
    eventType,
    System.Timestamp() AS processingTime
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp;

-- Output 2: Send structured data to SQL Database
SELECT
    deviceId,
    location,
    CAST(timestamp AS datetime) AS eventTimestamp,
    temperature,
    humidity,
    pressure,
    vibration,
    status,
    eventType
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp;
```

### __4.2 Update Job with Query__

Apply the query to your Stream Analytics job:

```powershell
# Create query file
$query = @"
-- Stream Analytics Query
-- Tutorial 03: Basic pass-through query with multiple outputs

-- Archive all raw data to Blob Storage
SELECT
    deviceId,
    location,
    timestamp AS eventTimestamp,
    temperature,
    humidity,
    pressure,
    vibration,
    status,
    eventType,
    System.Timestamp() AS processingTime
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp;

-- Send structured data to SQL Database
SELECT
    deviceId,
    location,
    CAST(timestamp AS datetime) AS eventTimestamp,
    temperature,
    humidity,
    pressure,
    vibration,
    status,
    eventType
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp;
"@

$query | Out-File -FilePath "stream-query.sql" -Encoding UTF8

# Update transformation with query
$transformationConfig = @{
    properties = @{
        streamingUnits = 1
        query = $query
    }
} | ConvertTo-Json -Depth 10 | Out-File -FilePath "transformation.json" -Encoding UTF8

az stream-analytics transformation create `
    --job-name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --name "Transformation" `
    --streaming-units 1 `
    --saql @stream-query.sql
```

## ▶️ Step 5: Start and Test the Job

### __5.1 Start Stream Analytics Job__

Begin processing events:

```powershell
# Start job with JobStartTime to process from now
az stream-analytics job start `
    --job-name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --output-start-mode JobStartTime

# Monitor job startup
Write-Host "Starting job... This may take 1-2 minutes."
Start-Sleep -Seconds 60

# Check job state
az stream-analytics job show `
    --name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --query "{Name:name, State:jobState, LastOutputTime:lastOutputEventTime}" `
    --output table
```

### __5.2 Verify Data Flow__

Ensure data generator is running and check outputs:

```powershell
# Start data generator in background
Start-Process python -ArgumentList "sensor_data_generator.py" -NoNewWindow

# Wait for data to flow through pipeline
Write-Host "Waiting for data to flow through pipeline..."
Start-Sleep -Seconds 120

# Check SQL Database for records
$verifyQuery = "SELECT COUNT(*) AS RecordCount, MIN(EventTimestamp) AS FirstEvent, MAX(EventTimestamp) AS LastEvent FROM SensorReadings;"

Invoke-Sqlcmd -ConnectionString $connectionString -Query $verifyQuery | Format-Table
```

__Expected Output:__

```text
RecordCount FirstEvent                LastEvent
----------- ----------------------    ----------------------
240         2025-01-15 10:45:00.000   2025-01-15 10:47:00.000
```

### __5.3 Verify Blob Storage Output__

Check that files are being written to Blob Storage:

```powershell
# List blobs in rawdata container
az storage blob list `
    --account-name $env:STREAM_SA `
    --account-key $env:STREAM_SA_KEY `
    --container-name "rawdata" `
    --query "[].{Name:name, Size:properties.contentLength, LastModified:properties.lastModified}" `
    --output table
```

## 📊 Step 6: Monitor Job Performance

### __6.1 View Job Metrics__

Monitor key performance indicators:

```powershell
# Get job resource ID
$jobResourceId = az stream-analytics job show `
    --name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --query id `
    --output tsv

# View input events metric
az monitor metrics list `
    --resource $jobResourceId `
    --metric "InputEvents" `
    --start-time (Get-Date).AddMinutes(-10).ToString("yyyy-MM-ddTHH:mm:ssZ") `
    --end-time (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ") `
    --interval PT1M `
    --aggregation Total `
    --output table

# View output events metric
az monitor metrics list `
    --resource $jobResourceId `
    --metric "OutputEvents" `
    --start-time (Get-Date).AddMinutes(-10).ToString("yyyy-MM-ddTHH:mm:ssZ") `
    --end-time (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ") `
    --interval PT1M `
    --aggregation Total `
    --output table
```

### __6.2 Check for Errors__

Monitor for any runtime errors:

```powershell
# View runtime errors
az monitor metrics list `
    --resource $jobResourceId `
    --metric "Errors" `
    --start-time (Get-Date).AddMinutes(-10).ToString("yyyy-MM-ddTHH:mm:ssZ") `
    --end-time (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ") `
    --interval PT1M `
    --aggregation Total `
    --output table

# Check watermark delay (event processing latency)
az monitor metrics list `
    --resource $jobResourceId `
    --metric "AMLCalloutInputEvents" `
    --start-time (Get-Date).AddMinutes(-10).ToString("yyyy-MM-ddTHH:mm:ssZ") `
    --end-time (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ") `
    --interval PT1M `
    --output table
```

## ✅ Validation

### __Validation Checklist__

- [ ] Stream Analytics job created and running
- [ ] Event Hub input connected and receiving data
- [ ] Blob Storage output writing files
- [ ] SQL Database receiving records
- [ ] No errors in job metrics
- [ ] Processing latency under 10 seconds

### __Query Sample Data from SQL__

```powershell
# Query latest sensor readings
$sampleQuery = @"
SELECT TOP 10
    DeviceId,
    Location,
    EventTimestamp,
    Temperature,
    Humidity,
    Status
FROM SensorReadings
ORDER BY EventTimestamp DESC;
"@

Invoke-Sqlcmd -ConnectionString $connectionString -Query $sampleQuery | Format-Table
```

## 🎓 Key Concepts Learned

### __Stream Analytics Architecture__

- __Inputs__: Data sources (Event Hubs, IoT Hub, Blob Storage)
- __Query__: Transformation logic using SAQL
- __Outputs__: Destinations (Storage, SQL, Power BI, Event Hubs)
- __Transformation__: Compute resources (Streaming Units)

### __SAQL Fundamentals__

- __TIMESTAMP BY__: Defines event time field
- __System.Timestamp()__: Processing time when event reached output
- __INTO__: Directs query results to specific output
- __Multiple Outputs__: Single query can write to multiple destinations

### __Job Configuration__

- __Streaming Units__: Compute capacity allocation
- __Out-of-Order Policy__: How to handle late events
- __Error Policy__: Drop or retry on output errors
- __Compatibility Level__: Query language feature set

## 🚀 Next Steps

You've created a working Stream Analytics job! Continue to:

__[Tutorial 04: Basic Queries →](04-basic-queries.md)__

In the next tutorial, you'll learn:

- Advanced SELECT statements with filtering
- WHERE clauses for conditional processing
- Aggregations and GROUP BY operations
- Data type conversions and calculations

## 📚 Additional Resources

- [Stream Analytics Query Language Reference](https://docs.microsoft.com/stream-analytics-query/stream-analytics-query-language-reference)
- [Configure Inputs for Stream Analytics](https://docs.microsoft.com/azure/stream-analytics/stream-analytics-define-inputs)
- [Configure Outputs for Stream Analytics](https://docs.microsoft.com/azure/stream-analytics/stream-analytics-define-outputs)

## 🔧 Troubleshooting

### __Issue: Job Fails to Start__

__Symptoms:__ Job state shows "Failed" after start attempt

__Solution:__

```powershell
# Check for configuration errors
az stream-analytics job show --name $env:STREAM_JOB --resource-group $env:STREAM_RG --query "properties"

# Review job diagnostic logs
az monitor diagnostic-settings list --resource $jobResourceId
```

### __Issue: No Data in Outputs__

__Symptoms:__ Job running but no data in Blob or SQL

__Solution:__

```powershell
# Verify input is receiving events
az stream-analytics input test --job-name $env:STREAM_JOB --resource-group $env:STREAM_RG --input-name "EventHubInput"

# Check if data generator is running
# Restart generator if needed
python sensor_data_generator.py
```

---

__Tutorial Progress:__ 3 of 11 complete | __Next:__ [Basic Queries](04-basic-queries.md)

*Last Updated: January 2025*
