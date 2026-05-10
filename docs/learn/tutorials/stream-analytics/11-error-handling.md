# 🛡️ Tutorial 11: Error Handling and Resilience

![Tutorial](https://img.shields.io/badge/Tutorial-11_Error_Handling-blue)
![Duration](https://img.shields.io/badge/Duration-35_minutes-green)
![Level](https://img.shields.io/badge/Level-Advanced-orange)

__Build resilient Stream Analytics solutions with comprehensive error handling, retry policies, dead-letter queues, and monitoring. Ensure production reliability and fault tolerance.__

## 🎯 Learning Objectives

- ✅ __Configure error policies__ for data and output errors
- ✅ __Implement dead-letter queues__ for failed events
- ✅ __Handle late-arriving events__ appropriately
- ✅ __Set up monitoring and alerting__ for failures
- ✅ __Implement retry strategies__ for transient errors
- ✅ __Design fault-tolerant architectures__

## ⏱️ Time Estimate: 35 minutes

## 📋 Prerequisites

- [x] Completed [Tutorial 10: Performance Tuning](10-performance-tuning.md)
- [x] Understanding of error handling concepts
- [x] Production Stream Analytics job

## ⚙️ Step 1: Configure Error Policies

### __1.1 Set Job-Level Error Policies__

```powershell
# Configure error policies for the job
az stream-analytics job update `
    --name $env:STREAM_JOB `
    --resource-group $env:STREAM_RG `
    --output-error-policy "Drop" `
    --events-outoforder-policy "Adjust" `
    --events-outoforder-max-delay 10 `
    --events-late-arrival-max-delay 5

Write-Host "Error policies configured:"
Write-Host "  Output Error Policy: Drop (failed outputs are dropped)"
Write-Host "  Out-of-Order Policy: Adjust (reorder events within 10s window)"
Write-Host "  Late Arrival: Accept events up to 5s late"
```

__Policy Options:__

| Policy | Options | Recommendation |
|--------|---------|----------------|
| __Output Error__ | Drop, Stop | Drop (for resilience) |
| __Out-of-Order__ | Adjust, Drop | Adjust (for accuracy) |
| __Late Arrival__ | 0-21 days | 5-60 seconds (balance data quality and latency) |

### __1.2 Understand Error Policy Impact__

```sql
-- Query demonstrating event time handling
SELECT
    deviceId,
    timestamp AS eventTime,
    System.Timestamp() AS processingTime,
    DATEDIFF(second, timestamp, System.Timestamp()) AS latencySeconds,
    CASE
        WHEN DATEDIFF(second, timestamp, System.Timestamp()) > 60 THEN 'Late Event'
        WHEN DATEDIFF(second, timestamp, System.Timestamp()) < -10 THEN 'Out of Order'
        ELSE 'On Time'
    END AS eventStatus
INTO
    BlobOutput
FROM
    EventHubInput TIMESTAMP BY timestamp;
```

## 🔄 Step 2: Implement Dead-Letter Queue

### __2.1 Create Dead-Letter Event Hub__

```powershell
# Create Event Hub for dead-letter events
$dlqEventHubName = "dead-letter-queue"

az eventhubs eventhub create `
    --name $dlqEventHubName `
    --namespace-name $env:STREAM_EH_NAMESPACE `
    --resource-group $env:STREAM_RG `
    --partition-count 4 `
    --message-retention 7  # Keep for 7 days for investigation

# Create shared access policy
az eventhubs eventhub authorization-rule create `
    --name SendPolicy `
    --eventhub-name $dlqEventHubName `
    --namespace-name $env:STREAM_EH_NAMESPACE `
    --resource-group $env:STREAM_RG `
    --rights Send

# Save DLQ connection string
$dlqConnectionString = az eventhubs eventhub authorization-rule keys list `
    --name SendPolicy `
    --eventhub-name $dlqEventHubName `
    --namespace-name $env:STREAM_EH_NAMESPACE `
    --resource-group $env:STREAM_RG `
    --query primaryConnectionString `
    --output tsv

[Environment]::SetEnvironmentVariable("STREAM_DLQ_CONN", $dlqConnectionString, "User")

Write-Host "Dead-letter queue created: $dlqEventHubName"
```

### __2.2 Route Failed Events to DLQ__

Since Stream Analytics doesn't natively support DLQ output, use Azure Function:

```python
# File: ErrorHandler/__init__.py

import logging
import json
import os
from datetime import datetime
import azure.functions as func
from azure.eventhub import EventHubProducerClient, EventData

def main(req: func.HttpRequest) -> func.HttpResponse:
    """
    Handle failed events and send to dead-letter queue.
    """
    logging.info('Processing error event')

    try:
        # Get original event data
        req_body = req.get_json()

        # Enrich with error metadata
        error_event = {
            **req_body,
            'error': {
                'timestamp': datetime.utcnow().isoformat(),
                'source': 'StreamAnalytics',
                'reason': req_body.get('errorReason', 'Unknown'),
                'retryCount': req_body.get('retryCount', 0)
            }
        }

        # Send to dead-letter queue
        send_to_dlq(error_event)

        return func.HttpResponse(
            json.dumps({"status": "success", "message": "Event sent to DLQ"}),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as e:
        logging.error(f"Error handling failed event: {str(e)}")
        return func.HttpResponse(
            json.dumps({"status": "error", "message": str(e)}),
            status_code=500,
            mimetype="application/json"
        )


def send_to_dlq(event: dict):
    """Send event to dead-letter queue."""
    connection_string = os.environ.get('STREAM_DLQ_CONN')
    eventhub_name = "dead-letter-queue"

    producer = EventHubProducerClient.from_connection_string(
        conn_str=connection_string,
        eventhub_name=eventhub_name
    )

    try:
        event_data_batch = producer.create_batch()
        event_data_batch.add(EventData(json.dumps(event)))
        producer.send_batch(event_data_batch)
        logging.info(f"Event sent to DLQ: {event.get('deviceId', 'unknown')}")
    finally:
        producer.close()
```

### __2.3 Monitor Dead-Letter Queue__

```python
# File: monitor_dlq.py

import os
from azure.eventhub import EventHubConsumerClient

def on_event(partition_context, event):
    """Process dead-letter event."""
    event_data = json.loads(event.body_as_str())

    print(f"\n{'='*60}")
    print(f"Dead-Letter Event Detected")
    print(f"{'='*60}")
    print(f"Device ID: {event_data.get('deviceId')}")
    print(f"Original Timestamp: {event_data.get('timestamp')}")
    print(f"Error Timestamp: {event_data.get('error', {}).get('timestamp')}")
    print(f"Error Reason: {event_data.get('error', {}).get('reason')}")
    print(f"Retry Count: {event_data.get('error', {}).get('retryCount')}")
    print(f"Original Event: {json.dumps(event_data, indent=2)}")
    print(f"{'='*60}\n")

    partition_context.update_checkpoint(event)


def monitor_dlq():
    """Monitor dead-letter queue for failed events."""
    connection_string = os.environ.get("STREAM_DLQ_CONN")
    eventhub_name = "dead-letter-queue"

    consumer = EventHubConsumerClient.from_connection_string(
        conn_str=connection_string,
        consumer_group="$Default",
        eventhub_name=eventhub_name
    )

    print("Monitoring dead-letter queue for failed events...")
    print("Press Ctrl+C to stop\n")

    try:
        with consumer:
            consumer.receive(
                on_event=on_event,
                starting_position="-1"
            )
    except KeyboardInterrupt:
        print("\nMonitoring stopped")


if __name__ == "__main__":
    monitor_dlq()
```

## 🔍 Step 3: Data Validation and Error Detection

### __3.1 Input Data Validation__

```sql
-- Validate and categorize incoming events
WITH ValidationCheck AS (
    SELECT
        *,
        CASE
            WHEN deviceId IS NULL THEN 'Missing DeviceId'
            WHEN temperature IS NULL THEN 'Missing Temperature'
            WHEN temperature < -50 OR temperature > 150 THEN 'Temperature Out of Range'
            WHEN humidity IS NULL THEN 'Missing Humidity'
            WHEN humidity < 0 OR humidity > 100 THEN 'Humidity Out of Range'
            WHEN timestamp IS NULL THEN 'Missing Timestamp'
            ELSE NULL
        END AS validationError
    FROM
        EventHubInput TIMESTAMP BY timestamp
)
-- Route valid events to normal processing
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    humidity,
    vibration,
    status
INTO
    SqlOutput
FROM
    ValidationCheck
WHERE
    validationError IS NULL;

-- Route invalid events to error output
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    humidity,
    validationError AS errorReason,
    'DataValidationError' AS errorType,
    System.Timestamp() AS detectionTime
INTO
    ErrorOutput
FROM
    ValidationCheck
WHERE
    validationError IS NOT NULL;
```

### __3.2 Detect Duplicate Events__

```sql
-- Deduplicate events within time window
WITH RankedEvents AS (
    SELECT
        *,
        ROW_NUMBER() OVER (
            PARTITION BY deviceId, timestamp
            LIMIT DURATION(second, 10)
        ) AS rowNum
    FROM
        EventHubInput TIMESTAMP BY timestamp
)
SELECT
    deviceId,
    location,
    timestamp,
    temperature,
    humidity,
    vibration
INTO
    SqlOutput
FROM
    RankedEvents
WHERE
    rowNum = 1;  -- Only keep first occurrence
```

### __3.3 Handle Missing Data__

```sql
-- Fill missing values with defaults or last known values
SELECT
    deviceId,
    location,
    timestamp,
    COALESCE(temperature, LAG(temperature) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 5)), 72.0) AS temperature,
    COALESCE(humidity, LAG(humidity) OVER (PARTITION BY deviceId LIMIT DURATION(minute, 5)), 45.0) AS humidity,
    COALESCE(vibration, 0.0) AS vibration,
    CASE
        WHEN temperature IS NULL THEN 'Temperature Imputed'
        WHEN humidity IS NULL THEN 'Humidity Imputed'
        ELSE NULL
    END AS dataQualityNote
INTO
    SqlOutput
FROM
    EventHubInput TIMESTAMP BY timestamp;
```

## 📊 Step 4: Monitoring and Alerting

### __4.1 Configure Diagnostic Settings__

```powershell
# Enable diagnostic logging
$logAnalyticsWorkspace = "stream-analytics-logs"

# Create Log Analytics workspace
az monitor log-analytics workspace create `
    --workspace-name $logAnalyticsWorkspace `
    --resource-group $env:STREAM_RG `
    --location $env:STREAM_LOCATION

$workspaceId = az monitor log-analytics workspace show `
    --workspace-name $logAnalyticsWorkspace `
    --resource-group $env:STREAM_RG `
    --query id `
    --output tsv

# Configure diagnostic settings
az monitor diagnostic-settings create `
    --name "StreamAnalyticsDiagnostics" `
    --resource $jobResourceId `
    --workspace $workspaceId `
    --logs '[
        {
            "category": "Execution",
            "enabled": true
        },
        {
            "category": "Authoring",
            "enabled": true
        }
    ]' `
    --metrics '[
        {
            "category": "AllMetrics",
            "enabled": true
        }
    ]'

Write-Host "Diagnostic logging configured to Log Analytics"
```

### __4.2 Create Alert Rules__

```powershell
# Alert on high error rate
az monitor metrics alert create `
    --name "StreamAnalyticsHighErrorRate" `
    --resource-group $env:STREAM_RG `
    --scopes $jobResourceId `
    --condition "avg Errors > 10" `
    --window-size 5m `
    --evaluation-frequency 1m `
    --action-group-name "StreamAnalyticsAlerts" `
    --description "Alert when error rate exceeds 10 errors per 5 minutes"

# Alert on job failure
az monitor metrics alert create `
    --name "StreamAnalyticsJobFailed" `
    --resource-group $env:STREAM_RG `
    --scopes $jobResourceId `
    --condition "total Errors > 100" `
    --window-size 15m `
    --evaluation-frequency 5m `
    --severity 0 `
    --description "Critical alert when job has more than 100 errors in 15 minutes"

# Alert on high watermark delay (processing lag)
az monitor metrics alert create `
    --name "StreamAnalyticsHighLatency" `
    --resource-group $env:STREAM_RG `
    --scopes $jobResourceId `
    --condition "max WatermarkDelay > 300" `
    --window-size 15m `
    --evaluation-frequency 5m `
    --severity 2 `
    --description "Warning when processing delay exceeds 5 minutes"
```

### __4.3 Query Diagnostic Logs__

```kql
// Log Analytics (KQL) queries for troubleshooting

// Find all errors in last 24 hours
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.STREAMANALYTICS"
| where Category == "Execution"
| where Level == "Error"
| where TimeGenerated > ago(24h)
| project TimeGenerated, OperationName, Message, Level
| order by TimeGenerated desc

// Error distribution by type
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.STREAMANALYTICS"
| where Level == "Error"
| where TimeGenerated > ago(7d)
| summarize ErrorCount = count() by OperationName
| order by ErrorCount desc

// Data conversion errors
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.STREAMANALYTICS"
| where Message contains "conversion error"
| where TimeGenerated > ago(24h)
| project TimeGenerated, Message
| order by TimeGenerated desc
```

## 🔄 Step 5: Retry and Recovery Strategies

### __5.1 Implement Exponential Backoff in Functions__

```python
# File: ResilientFunction/__init__.py

import logging
import time
import json
from typing import Optional
import azure.functions as func

MAX_RETRIES = 3
BASE_DELAY = 1  # seconds

def exponential_backoff_retry(func, *args, **kwargs):
    """
    Retry function with exponential backoff.
    """
    for attempt in range(MAX_RETRIES):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                # Last attempt failed
                logging.error(f"All {MAX_RETRIES} attempts failed: {str(e)}")
                raise
            else:
                # Calculate delay: 1s, 2s, 4s
                delay = BASE_DELAY * (2 ** attempt)
                logging.warning(f"Attempt {attempt + 1} failed, retrying in {delay}s: {str(e)}")
                time.sleep(delay)


def send_to_external_api(data: dict) -> Optional[dict]:
    """Send data to external API with retry logic."""
    import requests

    url = "https://api.example.com/events"
    headers = {"Content-Type": "application/json"}

    response = requests.post(url, json=data, headers=headers, timeout=10)
    response.raise_for_status()

    return response.json()


def main(req: func.HttpRequest) -> func.HttpResponse:
    """Process event with retry logic."""
    try:
        req_body = req.get_json()

        # Process with retry
        result = exponential_backoff_retry(send_to_external_api, req_body)

        return func.HttpResponse(
            json.dumps({"status": "success", "result": result}),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as e:
        logging.error(f"Failed to process event after retries: {str(e)}")
        return func.HttpResponse(
            json.dumps({"status": "error", "message": str(e)}),
            status_code=500,
            mimetype="application/json"
        )
```

### __5.2 Job Restart Automation__

```powershell
# Script: restart-failed-job.ps1
# Automatically restart job if it enters Failed state

$jobName = $env:STREAM_JOB
$resourceGroup = $env:STREAM_RG

# Check job state
$jobState = az stream-analytics job show `
    --name $jobName `
    --resource-group $resourceGroup `
    --query "jobState" `
    --output tsv

Write-Host "Current job state: $jobState"

if ($jobState -eq "Failed") {
    Write-Host "Job is in Failed state. Attempting restart..."

    # Stop job
    az stream-analytics job stop `
        --name $jobName `
        --resource-group $resourceGroup

    # Wait for stop
    Start-Sleep -Seconds 30

    # Start job
    az stream-analytics job start `
        --name $jobName `
        --resource-group $resourceGroup `
        --output-start-mode JobStartTime

    Write-Host "Job restart initiated"

    # Send notification
    # Add email/Teams/Slack notification here

} elseif ($jobState -ne "Running") {
    Write-Host "Warning: Job is not running (State: $jobState)"
}
```

## ✅ Resilience Checklist

- [ ] __Error policies configured__ (Drop, Adjust, Late arrival)
- [ ] __Dead-letter queue implemented__ for failed events
- [ ] __Input validation__ in queries
- [ ] __Duplicate detection__ implemented
- [ ] __Missing data handling__ configured
- [ ] __Diagnostic logging enabled__ to Log Analytics
- [ ] __Alert rules created__ for errors and failures
- [ ] __Retry logic__ in Azure Functions
- [ ] __Job monitoring__ automated
- [ ] __Recovery procedures__ documented

## 🎓 Key Concepts Learned

### __Error Handling Strategy__

1. __Prevent__: Validate data before processing
2. __Detect__: Monitor for errors and anomalies
3. __Respond__: Route to DLQ, alert operators
4. __Recover__: Retry with backoff, auto-restart
5. __Learn__: Analyze patterns, improve validation

### __Production Best Practices__

- Always use Drop policy for output errors (resilience over consistency)
- Set reasonable late arrival windows (5-60 seconds)
- Implement comprehensive monitoring
- Create runbooks for common failure scenarios
- Test failure scenarios regularly
- Document recovery procedures

## 🎉 Tutorial Series Complete!

__Congratulations!__ You've completed the Azure Stream Analytics Tutorial Series.

### __What You've Learned:__

1. ✅ Environment setup and configuration
2. ✅ Data generation and ingestion
3. ✅ Stream Analytics job creation
4. ✅ Basic query development
5. ✅ Windowing functions
6. ✅ Joins and temporal operations
7. ✅ Anomaly detection
8. ✅ Power BI integration
9. ✅ Azure Functions integration
10. ✅ Performance tuning
11. ✅ Error handling and resilience

### __Next Steps:__

- Apply these patterns to real production scenarios
- Explore advanced topics (ML integration, custom deserializers)
- Build end-to-end streaming solutions
- Contribute improvements to these tutorials

## 📚 Additional Resources

- [Stream Analytics Error Handling](https://docs.microsoft.com/azure/stream-analytics/stream-analytics-troubleshoot-output)
- [Monitoring Best Practices](https://docs.microsoft.com/azure/stream-analytics/stream-analytics-monitoring)
- [Production Deployment Guide](https://docs.microsoft.com/azure/stream-analytics/stream-analytics-tools-for-visual-studio-cicd)

---

__Tutorial Progress:__ 11 of 11 complete ✅ | __Series Complete!__

*Last Updated: January 2025*

## 💬 Feedback

Completed the series? We'd love to hear from you:

- ✅ __Helpful?__ - [Give us a star](https://github.com/fgarofalo56/csa-inabox-docs)
- 💡 __Suggestions?__ - [Share feedback](https://github.com/fgarofalo56/csa-inabox-docs/discussions)
- 🐛 __Issues?__ - [Report problems](https://github.com/fgarofalo56/csa-inabox-docs/issues)

Thank you for completing the Azure Stream Analytics Tutorial Series!
