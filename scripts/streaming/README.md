# Streaming Analytics Pipeline

> **Last Updated:** 2026-04-15 | **Status:** Active | **Audience:** Developers

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Event Schema](#event-schema)
- [Sample Queries](#sample-queries)
- [Deploying Queries](#deploying-queries)
- [Input/Output Configuration](#inputoutput-configuration)
- [Testing with VS Code](#testing-with-vs-code)
- [Monitoring](#monitoring)
- [Reference Data Setup](#reference-data-setup)
- [File Index](#file-index)

Real-time event processing for the CSA-in-a-Box platform using Azure Event Hub, Azure Stream Analytics, and Azure Data Explorer (ADX).

## Architecture Overview

```text
produce_events.py                Stream Analytics Jobs               Sinks
 (Event Producer)                (ASAQL Queries)
                           +---------------------------------+
                           |                                 |
  +-----------------+      |  tumbling_window_event_counts   +----> ADX (RawEvents table)
  |  Event Hub      +----->|  sliding_window_anomaly         +----> Blob / Alert sink
  |  (events topic) |      |  session_window_user_activity   +----> ADX / Blob
  |                 |      |  reference_join_enrichment      +----> ADX / Blob
  +-----------------+      |         |                       |
                           |         | LEFT JOIN             |
                           |    +----+-----+                 |
                           |    | Blob     |                 |
                           |    | (Customer|                 |
                           |    | Ref Data)|                 |
                           |    +----------+                 |
                           +---------------------------------+
```

**Data flow:**

1. `produce_events.py` generates realistic clickstream/IoT events and publishes them to Event Hub.
2. Stream Analytics jobs consume events from Event Hub, apply windowed aggregations and transformations.
3. Results are written to ADX tables (for dashboards/KQL queries), Blob Storage (for archival), or alert sinks.

## Event Schema

Events produced by `produce_events.py` follow this schema:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "source": "csa-inabox-producer",
  "type": "page_view",
  "timestamp": "2026-04-12T14:30:00.000Z",
  "data": {
    "event_number": 42,
    "session_id": "sess-0123",
    "customer_id": 157,
    "device": "desktop",
    "region": "eastus",
    "page": "/products/detail",
    "browser": "Chrome",
    "load_time_ms": 450
  }
}
```

### Event Types

| Type | Weight | Type-Specific Fields |
|---|---|---|
| `page_view` | 30% | `page`, `browser`, `load_time_ms` |
| `button_click` | 20% | `page`, `browser`, `load_time_ms` |
| `form_submit` | 5% | |
| `search_query` | 10% | `query`, `results_count` |
| `add_to_cart` | 8% | `product_id`, `amount` |
| `checkout_start` | 3% | |
| `purchase_complete` | 2% | `product_id`, `amount` |
| `error` | 2% | `error_code`, `error_message` |
| `sensor_reading` | 15% | `sensor_id`, `temperature`, `humidity` |
| `heartbeat` | 5% | |

### Common Fields (all events)

| Field | Type | Description |
|---|---|---|
| `id` | string (UUID) | Unique event identifier |
| `source` | string | Always `"csa-inabox-producer"` |
| `type` | string | One of the event types above |
| `timestamp` | string (ISO 8601) | UTC event timestamp |
| `data.session_id` | string | Format: `sess-NNNN` |
| `data.customer_id` | int or null | 1-200, null for 30% of events |
| `data.device` | string | `desktop`, `mobile`, `tablet`, `iot_sensor`, `api_client` |
| `data.region` | string | `eastus`, `westus`, `northeurope`, `southeastasia`, `brazilsouth` |

## Sample Queries

All queries are in `queries/` and use Stream Analytics SQL (compatibility level 1.2).

### 1. Tumbling Window Event Counts (`tumbling_window_event_counts.asaql`)

Aggregates events into **5-minute non-overlapping windows** grouped by event type and region. Computes event count, distinct sessions/customers, and load time statistics.

**Use case:** Dashboards, trend analysis, capacity monitoring.

### 2. Sliding Window Anomaly Detection (`sliding_window_anomaly.asaql`)

Detects anomalous error rates over a **10-minute sliding window**. Fires alerts when:
- Error rate exceeds 5% of total events
- Error count spikes to 3x the previous window (via `LAG()`)

**Use case:** Operational alerting, incident detection.

### 3. Session Window User Activity (`session_window_user_activity.asaql`)

Groups events by `session_id` using a **session window** (5-minute inactivity timeout, 30-minute max). Tracks pages visited, purchase status, cart activity, and errors per session.

**Use case:** User behavior analytics, conversion funnel analysis.

### 4. Reference JOIN Enrichment (`reference_join_enrichment.asaql`)

Enriches streaming events with customer attributes from a **Blob-backed reference dataset** via LEFT JOIN. Adds customer tier, segment, and lifetime value.

**Use case:** Customer segmentation, personalized analytics, high-value customer tracking.

## Deploying Queries

### Option A: Azure Portal

1. Navigate to your Stream Analytics job in the Azure Portal.
2. Under **Job topology** > **Query**, paste the contents of an `.asaql` file.
3. Configure the matching inputs and outputs (see [Input/Output Configuration](#inputoutput-configuration)).
4. Click **Save query**, then **Start** the job.

### Option B: Bicep / ARM Template

Use the `transformation` property on the Stream Analytics job resource:

```bicep
resource streamAnalyticsJob 'Microsoft.StreamAnalytics/streamingjobs@2021-10-01-preview' = {
  name: 'csa-streaming-job'
  location: resourceGroup().location
  properties: {
    sku: { name: 'Standard' }
    compatibilityLevel: '1.2'
    eventsOutOfOrderPolicy: 'Adjust'
    eventsOutOfOrderMaxDelayInSeconds: 5
    eventsLateArrivalMaxDelayInSeconds: 16
    outputStartMode: 'JobStartTime'
    transformation: {
      name: 'Transformation'
      properties: {
        streamingUnits: 3
        query: loadTextContent('queries/tumbling_window_event_counts.asaql')
      }
    }
  }
}
```

### Option C: Azure CLI

```bash
# Create or update the job transformation with a query file
az stream-analytics transformation create \
  --resource-group rg-csa-inabox \
  --job-name csa-streaming-job \
  --name Transformation \
  --streaming-units 3 \
  --transformation-query "$(cat queries/tumbling_window_event_counts.asaql)"
```

### Option D: PowerShell

```powershell
$query = Get-Content -Path "queries/tumbling_window_event_counts.asaql" -Raw

New-AzStreamAnalyticsTransformation `
  -ResourceGroupName "rg-csa-inabox" `
  -JobName "csa-streaming-job" `
  -Name "Transformation" `
  -StreamingUnit 3 `
  -Query $query
```

## Input/Output Configuration

### Input: Event Hub (`EventHubInput`)

| Setting | Value |
|---|---|
| Input alias | `EventHubInput` |
| Source type | Event Hub |
| Event Hub namespace | `csaevents` (or your namespace) |
| Event Hub name | `events` |
| Consumer group | `$Default` or `streamanalytics` |
| Authentication | Managed Identity (recommended) or connection string |
| Serialization | JSON, UTF-8 |
| Event compression | None |

### Output: Azure Data Explorer (`ADXOutput`)

| Setting | Value |
|---|---|
| Output alias | `ADXOutput` |
| Sink type | Azure Data Explorer |
| Cluster URI | `https://csa-adx.eastus.kusto.windows.net` |
| Database | `csadb` |
| Table | `RawEvents` (or query-specific table) |
| Authentication | Managed Identity |

### Output: Blob Storage / Alert Sink (`AlertOutput`, `SessionOutput`, `EnrichedOutput`)

| Setting | Value |
|---|---|
| Output alias | `AlertOutput` / `SessionOutput` / `EnrichedOutput` |
| Sink type | Blob Storage or Azure Function (for alerts) |
| Storage account | `csastorageaccount` |
| Container | `streaming-output` |
| Path pattern | `{alias}/{date}/{time}` |
| Serialization | JSON or Parquet |

### Reference Data: Customer Lookup (`CustomerReference`)

| Setting | Value |
|---|---|
| Reference alias | `CustomerReference` |
| Source type | Blob Storage |
| Storage account | `csastorageaccount` |
| Container | `reference-data` |
| Path pattern | `customers/current.json` |
| Serialization | JSON or CSV |
| Refresh | Every 15 minutes or on blob update |

**Sample reference data file** (`customers/current.json`):

```json
[
  {"customer_id": 1, "tier": "premium", "segment": "loyal", "lifetime_value": 2450.00, "signup_date": "2024-01-15"},
  {"customer_id": 2, "tier": "basic", "segment": "new", "lifetime_value": 120.50, "signup_date": "2025-11-02"},
  {"customer_id": 3, "tier": "enterprise", "segment": "returning", "lifetime_value": 15800.00, "signup_date": "2023-06-20"}
]
```

## Testing with VS Code

The [Azure Stream Analytics Tools for VS Code](https://marketplace.visualstudio.com/items?itemName=ms-bigdatatools.vscode-asa) extension enables local development and testing.

### Setup

1. Install the extension: `ms-bigdatatools.vscode-asa`
2. Open the `scripts/streaming/queries/` folder as a workspace.
3. Create a local input configuration file (`.asaproj` or via the extension's UI).

### Local Testing

1. Create sample input data from `produce_events.py`:
   ```bash
   python produce_events.py --dry-run --rate 5 --duration 10 > test_input.json
   ```
2. In VS Code, right-click an `.asaql` file and select **ASA: Run Local Run**.
3. Map `EventHubInput` to the local `test_input.json` file.
4. Inspect results in the output panel.

### Cloud Testing

1. Right-click the `.asaql` file and select **ASA: Submit to Azure**.
2. The extension will create/update the Stream Analytics job with the query.

## Monitoring

### Key Metrics

Monitor these metrics in the Azure Portal under your Stream Analytics job:

| Metric | Healthy Range | Action if Exceeded |
|---|---|---|
| **SU % Utilization** | < 80% | Scale up streaming units |
| **Watermark Delay** | < 30 seconds | Check input throughput, increase SUs |
| **Input Event Backlog** | < 1000 | Scale up SUs or optimize query |
| **Runtime Errors** | 0 | Check Activity Log for deserialization or query errors |
| **Out-of-Order Events** | Low | Adjust `eventsOutOfOrderMaxDelayInSeconds` |
| **Late Input Events** | Low | Adjust `eventsLateArrivalMaxDelayInSeconds` |

### Diagnostic Logs

Enable diagnostic logs for deeper troubleshooting:

```bash
az monitor diagnostic-settings create \
  --resource "/subscriptions/{sub}/resourceGroups/rg-csa-inabox/providers/Microsoft.StreamAnalytics/streamingjobs/csa-streaming-job" \
  --name "csa-asa-diagnostics" \
  --workspace "/subscriptions/{sub}/resourceGroups/rg-csa-inabox/providers/Microsoft.OperationalInsights/workspaces/csa-logs" \
  --logs '[{"category":"Execution","enabled":true},{"category":"Authoring","enabled":true}]' \
  --metrics '[{"category":"AllMetrics","enabled":true}]'
```

### Sample KQL Queries for Monitoring (in Log Analytics)

```kql
// Stream Analytics errors in the last 24 hours
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.STREAMANALYTICS"
| where Category == "Execution"
| where Level == "Error"
| project TimeGenerated, OperationName, ResultDescription
| order by TimeGenerated desc

// SU utilization trend
AzureMetrics
| where ResourceProvider == "MICROSOFT.STREAMANALYTICS"
| where MetricName == "ResourceUtilization"
| summarize avg(Average) by bin(TimeGenerated, 5m)
| render timechart
```

## Reference Data Setup

### Creating the Customer Reference Dataset

1. **Create the Blob container:**

   ```bash
   az storage container create \
     --account-name csastorageaccount \
     --name reference-data \
     --auth-mode login
   ```

2. **Generate sample reference data:**

   ```python
   import json, random

   tiers = ["free", "basic", "premium", "enterprise"]
   segments = ["new", "returning", "loyal", "churned"]

   customers = []
   for i in range(1, 201):
       customers.append({
           "customer_id": i,
           "tier": random.choice(tiers),
           "segment": random.choice(segments),
           "lifetime_value": round(random.uniform(0, 20000), 2),
           "signup_date": f"2024-{random.randint(1,12):02d}-{random.randint(1,28):02d}"
       })

   with open("customers.json", "w") as f:
       json.dump(customers, f, indent=2)
   ```

3. **Upload to Blob Storage:**

   ```bash
   az storage blob upload \
     --account-name csastorageaccount \
     --container-name reference-data \
     --name customers/current.json \
     --file customers.json \
     --auth-mode login
   ```

4. **Configure in Stream Analytics:** Add a reference input named `CustomerReference` pointing to the blob path `customers/current.json`.

### Refreshing Reference Data

Reference data in Stream Analytics can be refreshed by:

- **Overwriting the blob** at the same path (Stream Analytics polls for changes).
- **Using a date/time path pattern** like `customers/{date}/customers.json` and configuring the refresh interval.
- **Setting a refresh interval** (e.g., every 15 minutes) in the input configuration.

## File Index

```text
scripts/streaming/
  produce_events.py                         # Event producer (Event Hub publisher)
  adx_setup.kql                             # ADX table/mapping/view definitions
  README.md                                 # This file
  queries/
    tumbling_window_event_counts.asaql       # 5-min tumbling window aggregation
    sliding_window_anomaly.asaql             # 10-min sliding window anomaly detection
    session_window_user_activity.asaql       # Session window user tracking
    reference_join_enrichment.asaql          # Reference data JOIN enrichment
```

---

## Related Documentation

- [IoT Streaming Example](../../examples/iot-streaming/README.md) — End-to-end streaming example
- [Architecture Overview](../../docs/ARCHITECTURE.md) — Platform architecture reference