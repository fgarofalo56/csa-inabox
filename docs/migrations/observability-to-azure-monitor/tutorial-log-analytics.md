# Tutorial: Log Analytics with Azure Monitor Agent and KQL

**Time:** 60-90 minutes
**Prerequisites:** Azure subscription, Linux or Windows VM, Azure CLI
**Last updated:** 2026-04-30

---

## What you will build

In this tutorial, you will:

1. Deploy a Log Analytics workspace with appropriate configuration
2. Deploy Azure Monitor Agent (AMA) via Data Collection Rules (DCR)
3. Ingest custom application logs using the Logs Ingestion API
4. Write KQL queries that replace common Datadog/Splunk/New Relic log queries
5. Create a workbook dashboard for log monitoring
6. Set up log-based alert rules

By the end, you will have a complete log management pipeline replacing the log collection, search, and alerting functionality of Datadog Logs, New Relic Logs, or Splunk Log Observer.

---

## Step 1: Deploy Log Analytics workspace

```bash
# Variables
RESOURCE_GROUP="rg-log-tutorial"
LOCATION="eastus"
WORKSPACE_NAME="law-log-tutorial"

# Create resource group
az group create --name $RESOURCE_GROUP --location $LOCATION

# Create Log Analytics workspace with 90-day retention
az monitor log-analytics workspace create \
  --resource-group $RESOURCE_GROUP \
  --workspace-name $WORKSPACE_NAME \
  --retention-in-days 90 \
  --sku PerGB2018

# Get workspace ID and key
WORKSPACE_ID=$(az monitor log-analytics workspace show \
  --resource-group $RESOURCE_GROUP \
  --workspace-name $WORKSPACE_NAME \
  --query customerId -o tsv)

WORKSPACE_RESOURCE_ID=$(az monitor log-analytics workspace show \
  --resource-group $RESOURCE_GROUP \
  --workspace-name $WORKSPACE_NAME \
  --query id -o tsv)

echo "Workspace ID: $WORKSPACE_ID"
```

---

## Step 2: Create a Data Collection Rule

Data Collection Rules (DCRs) define what data to collect, how to transform it, and where to send it. DCRs replace:

- **Datadog:** `datadog.yaml` configuration + log processing pipelines
- **New Relic:** `newrelic-infra.yml` + log forwarding configuration
- **Splunk:** `inputs.conf` + `props.conf` + `transforms.conf`

### DCR for Linux syslog and custom application logs

```bash
# Create DCR for syslog collection
az monitor data-collection rule create \
  --name "dcr-linux-logs" \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION \
  --data-sources '{
    "syslog": [
      {
        "name": "syslogDataSource",
        "facilityNames": ["auth", "authpriv", "daemon", "kern", "syslog", "local0"],
        "logLevels": ["Warning", "Error", "Critical", "Alert", "Emergency"],
        "streams": ["Microsoft-Syslog"]
      }
    ]
  }' \
  --destinations '{
    "logAnalytics": [
      {
        "name": "logAnalytics",
        "workspaceResourceId": "'"$WORKSPACE_RESOURCE_ID"'"
      }
    ]
  }' \
  --data-flows '[
    {
      "streams": ["Microsoft-Syslog"],
      "destinations": ["logAnalytics"]
    }
  ]'

DCR_ID=$(az monitor data-collection rule show \
  --name "dcr-linux-logs" \
  --resource-group $RESOURCE_GROUP \
  --query id -o tsv)
```

### Deploy AMA on a Linux VM

```bash
# Install AMA extension on VM
az vm extension set \
  --name AzureMonitorLinuxAgent \
  --publisher Microsoft.Azure.Monitor \
  --resource-group $RESOURCE_GROUP \
  --vm-name $VM_NAME \
  --enable-auto-upgrade true

# Associate VM with DCR
az monitor data-collection rule association create \
  --name "assoc-linux-syslog" \
  --resource "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Compute/virtualMachines/{vm}" \
  --rule-id $DCR_ID
```

### Deploy AMA on a Windows VM

```bash
# Install AMA extension
az vm extension set \
  --name AzureMonitorWindowsAgent \
  --publisher Microsoft.Azure.Monitor \
  --resource-group $RESOURCE_GROUP \
  --vm-name $VM_NAME \
  --enable-auto-upgrade true
```

### DCR for Windows Event Logs

```json
{
    "dataSources": {
        "windowsEventLogs": [
            {
                "name": "windowsEvents",
                "streams": ["Microsoft-Event"],
                "xPathQueries": [
                    "Application!*[System[(Level=1 or Level=2 or Level=3)]]",
                    "Security!*[System[(EventID=4624 or EventID=4625 or EventID=4648)]]",
                    "System!*[System[(Level=1 or Level=2 or Level=3)]]"
                ]
            }
        ]
    }
}
```

---

## Step 3: Ingest custom logs via REST API

For applications that do not run on VMs (SaaS platforms, serverless, custom collectors), use the Logs Ingestion API.

### Create a custom log table and DCR endpoint

```bash
# Create a Data Collection Endpoint (DCE)
az monitor data-collection endpoint create \
  --name "dce-custom-logs" \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION \
  --public-network-access Enabled

DCE_ENDPOINT=$(az monitor data-collection endpoint show \
  --name "dce-custom-logs" \
  --resource-group $RESOURCE_GROUP \
  --query logsIngestion.endpoint -o tsv)
```

### Create a DCR for custom log ingestion

```bash
az monitor data-collection rule create \
  --name "dcr-custom-app-logs" \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION \
  --data-collection-endpoint-id $DCE_ID \
  --stream-declarations '{
    "Custom-AppLogs_CL": {
      "columns": [
        {"name": "TimeGenerated", "type": "datetime"},
        {"name": "Level", "type": "string"},
        {"name": "Service", "type": "string"},
        {"name": "Message", "type": "string"},
        {"name": "TraceId", "type": "string"},
        {"name": "UserId", "type": "string"},
        {"name": "DurationMs", "type": "real"}
      ]
    }
  }' \
  --destinations '{
    "logAnalytics": [
      {
        "name": "logAnalytics",
        "workspaceResourceId": "'"$WORKSPACE_RESOURCE_ID"'"
      }
    ]
  }' \
  --data-flows '[
    {
      "streams": ["Custom-AppLogs_CL"],
      "destinations": ["logAnalytics"],
      "transformKql": "source | where Level != \"DEBUG\" | extend Environment = \"production\"",
      "outputStream": "Custom-AppLogs_CL"
    }
  ]'
```

### Send logs via REST API

```bash
# Get an access token
TOKEN=$(az account get-access-token --resource "https://monitor.azure.com" --query accessToken -o tsv)

# Get DCR immutable ID
DCR_IMMUTABLE_ID=$(az monitor data-collection rule show \
  --name "dcr-custom-app-logs" \
  --resource-group $RESOURCE_GROUP \
  --query immutableId -o tsv)

# Send log entries
curl -X POST \
  "${DCE_ENDPOINT}/dataCollectionRules/${DCR_IMMUTABLE_ID}/streams/Custom-AppLogs_CL?api-version=2023-01-01" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {
      "TimeGenerated": "2026-04-30T10:00:00Z",
      "Level": "Error",
      "Service": "order-api",
      "Message": "Connection timeout to database server db-prod-01",
      "TraceId": "abc123def456",
      "UserId": "user-789",
      "DurationMs": 30000.0
    },
    {
      "TimeGenerated": "2026-04-30T10:00:05Z",
      "Level": "Info",
      "Service": "order-api",
      "Message": "Retry succeeded after 2 attempts",
      "TraceId": "abc123def456",
      "UserId": "user-789",
      "DurationMs": 450.0
    }
  ]'
```

---

## Step 4: Write KQL queries

### Query 1: Search for errors (replaces basic log search)

=== "KQL"

    ```kusto
    AppLogs_CL
    | where TimeGenerated > ago(1h)
    | where Level == "Error"
    | project TimeGenerated, Service, Message, TraceId
    | order by TimeGenerated desc
    | take 50
    ```

=== "Datadog equivalent"

    ```
    service:order-api level:error
    ```

=== "Splunk equivalent"

    ```spl
    index=app_logs level=ERROR | head 50
    ```

### Query 2: Error count by service (timechart)

```kusto
AppLogs_CL
| where TimeGenerated > ago(24h)
| where Level == "Error"
| summarize ErrorCount = count() by bin(TimeGenerated, 15m), Service
| render timechart
```

### Query 3: Slow operations (P95 duration)

```kusto
AppLogs_CL
| where TimeGenerated > ago(1h)
| where isnotempty(DurationMs)
| summarize
    P50 = percentile(DurationMs, 50),
    P95 = percentile(DurationMs, 95),
    P99 = percentile(DurationMs, 99),
    Count = count()
    by Service
| order by P95 desc
```

### Query 4: Log pattern analysis (replaces Datadog Log Patterns)

```kusto
AppLogs_CL
| where TimeGenerated > ago(1h)
| where Level == "Error"
| summarize Count = count() by Message = extract(@"^(.{0,100})", 1, Message)
| order by Count desc
| take 20
```

### Query 5: Unique users affected by errors

```kusto
AppLogs_CL
| where TimeGenerated > ago(1h)
| where Level == "Error"
| summarize
    ErrorCount = count(),
    AffectedUsers = dcount(UserId),
    Services = make_set(Service)
    by Message = extract(@"^(.{0,80})", 1, Message)
| order by AffectedUsers desc
```

### Query 6: Trace reconstruction (follow a request across services)

```kusto
AppLogs_CL
| where TraceId == "abc123def456"
| order by TimeGenerated asc
| project TimeGenerated, Service, Level, Message, DurationMs
```

### Query 7: Log volume analysis (cost monitoring)

```kusto
Usage
| where TimeGenerated > ago(30d)
| where DataType == "AppLogs_CL"
| summarize DailyGB = sum(Quantity) / 1024.0 by bin(TimeGenerated, 1d)
| render timechart
```

### Query 8: Join logs with Application Insights traces

```kusto
// Correlate custom logs with Application Insights request traces
AppLogs_CL
| where Level == "Error"
| join kind=inner (
    AppRequests
    | where Success == false
) on $left.TraceId == $right.OperationId
| project
    TimeGenerated,
    LogMessage = Message,
    RequestUrl = Url,
    RequestDuration = DurationMs1,
    ResponseCode = ResultCode,
    Service
```

---

## Step 5: Create a workbook dashboard

### Create the workbook via Azure CLI

```bash
az monitor app-insights workbook create \
  --resource-group $RESOURCE_GROUP \
  --name "Log Analytics Overview" \
  --location $LOCATION \
  --kind shared \
  --category workbook \
  --serialized-data '{
    "version": "Notebook/1.0",
    "items": [
      {
        "type": 9,
        "content": {
          "version": "KqlParameterItem/1.0",
          "parameters": [
            {
              "name": "TimeRange",
              "type": 4,
              "defaultValue": "Last 1 hour",
              "label": "Time Range"
            },
            {
              "name": "Service",
              "type": 2,
              "query": "AppLogs_CL | distinct Service",
              "multiSelect": true,
              "label": "Service"
            }
          ]
        },
        "name": "parameters"
      },
      {
        "type": 1,
        "content": {
          "json": "## Log Analytics Dashboard\nThis workbook provides an overview of application logs, error trends, and service health."
        },
        "name": "header"
      },
      {
        "type": 3,
        "content": {
          "version": "KqlItem/1.0",
          "query": "AppLogs_CL | where TimeGenerated {TimeRange} | where Service in ({Service}) or \"{Service}\" == \"All\" | summarize ErrorCount = countif(Level == \"Error\"), WarnCount = countif(Level == \"Warning\"), InfoCount = countif(Level == \"Info\") by bin(TimeGenerated, 5m) | render timechart",
          "title": "Log Volume by Level",
          "visualization": "timechart"
        },
        "name": "logVolumeChart"
      },
      {
        "type": 3,
        "content": {
          "version": "KqlItem/1.0",
          "query": "AppLogs_CL | where TimeGenerated {TimeRange} | where Level == \"Error\" | summarize ErrorCount = count() by Service | order by ErrorCount desc",
          "title": "Error Count by Service",
          "visualization": "barchart"
        },
        "name": "errorsByService"
      },
      {
        "type": 3,
        "content": {
          "version": "KqlItem/1.0",
          "query": "AppLogs_CL | where TimeGenerated {TimeRange} | where Level == \"Error\" | summarize Count = count(), FirstSeen = min(TimeGenerated), LastSeen = max(TimeGenerated) by Message = substring(Message, 0, 120), Service | order by Count desc | take 20",
          "title": "Top 20 Error Messages",
          "visualization": "table"
        },
        "name": "topErrors"
      }
    ]
  }'
```

### Workbook visualization types available

| Type       | Use case                                  | KQL render command      |
| ---------- | ----------------------------------------- | ----------------------- |
| Time chart | Metrics over time, trend analysis         | `render timechart`      |
| Bar chart  | Comparison across categories              | `render barchart`       |
| Pie chart  | Proportion/distribution                   | `render piechart`       |
| Table/Grid | Detailed data with conditional formatting | Default (no render)     |
| Tiles      | Single-value KPIs                         | Tile visualization type |
| Map        | Geographic distribution                   | Map visualization type  |
| Scatter    | Correlation between two metrics           | `render scatterchart`   |

---

## Step 6: Create log-based alert rules

### Alert: Error spike (more than 50 errors in 5 minutes)

```bash
az monitor scheduled-query create \
  --name "Error Spike Alert" \
  --resource-group $RESOURCE_GROUP \
  --scopes $WORKSPACE_RESOURCE_ID \
  --condition "count > 50" \
  --condition-query "AppLogs_CL | where Level == 'Error' | summarize ErrorCount = count()" \
  --evaluation-frequency 5m \
  --window-size 5m \
  --severity 1 \
  --action-groups $ACTION_GROUP_ID \
  --description "Fires when more than 50 errors occur in a 5-minute window"
```

### Alert: New error message (never seen before)

```kusto
// This query finds error messages that appeared in the last 15 minutes
// but did not appear in the previous 24 hours
let recentErrors = AppLogs_CL
| where TimeGenerated > ago(15m)
| where Level == "Error"
| distinct Message;
let historicalErrors = AppLogs_CL
| where TimeGenerated between (ago(24h) .. ago(15m))
| where Level == "Error"
| distinct Message;
recentErrors
| join kind=leftanti historicalErrors on Message
```

---

## Verification checklist

After completing this tutorial, verify:

- [ ] Azure Monitor Agent is installed and reporting on target VMs
- [ ] Syslog data appears in the Syslog table in Log Analytics
- [ ] Custom logs appear in the AppLogs_CL table
- [ ] DCR transformations are filtering debug logs and adding custom fields
- [ ] KQL queries return expected results
- [ ] Workbook dashboard displays log volume, errors, and top error messages
- [ ] Log-based alert rules fire correctly when conditions are met
- [ ] Log volume and estimated cost are within expected range

---

## Next steps

- [APM Migration](apm-migration.md) -- instrument applications with Application Insights
- [Metrics Migration](metrics-migration.md) -- migrate custom metrics and Prometheus
- [Alerting Migration](alerting-migration.md) -- migrate remaining alert rules
- [Best Practices](best-practices.md) -- optimize log tiers, sampling, and archive

---

**Related:** [Tutorial: Application Insights](tutorial-app-insights.md) | [Log Migration](log-migration.md) | [Dashboard Migration](dashboard-migration.md)
