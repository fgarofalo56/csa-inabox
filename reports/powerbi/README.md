# CSA-in-a-Box: Power BI Dashboards & Azure Monitor Workbooks

[reports](../../reports/) / **powerbi**

> **Last Updated:** 2026-04-14 | **Status:** Active | **Audience:** Analysts / Data Engineers

> [!TIP]
> **TL;DR** — Six operational dashboards (Platform Health, Pipeline Performance, Data Quality, Data Freshness, Cost Attribution, Streaming Analytics) built with KQL queries against Log Analytics and ADX. Deploy via Power BI Desktop with DirectQuery or Import mode. Azure Monitor Workbook templates provide portal-native alternatives. Row-Level Security and scheduled refresh are covered for production use.

## Table of Contents

- [Directory Structure](#-directory-structure)
- [Prerequisites](#-prerequisites)
- [Setting Up Data Sources](#-setting-up-data-sources)
- [Creating Each Dashboard](#-creating-each-dashboard)
- [Deploying Azure Monitor Workbooks](#-deploying-azure-monitor-workbooks)
- [Configuring Scheduled Refresh](#-configuring-scheduled-refresh)
- [Row-Level Security (RLS)](#-row-level-security-rls)
- [Publishing to Power BI Service](#-publishing-to-power-bi-service)
- [Troubleshooting](#-troubleshooting)
- [Custom Log Table Setup](#-custom-log-table-setup)
- [Related Documentation](#-related-documentation)

Operational dashboards for monitoring the CSA-in-a-Box platform across health, pipelines, data quality, freshness, cost, and streaming analytics.

---

## 📁 Directory Structure

```text
reports/powerbi/
├── README.md                          # This file
├── queries/                           # KQL query files for Power BI and Workbooks
│   ├── platform_health.kql            # Service availability, errors, utilization
│   ├── pipeline_performance.kql       # ADF pipeline runs, durations, failures
│   ├── data_quality.kql               # dbt tests, quality violations, schema drift
│   ├── data_freshness.kql             # Refresh times, SLA compliance, stale data
│   ├── cost_attribution.kql           # Cost by service, domain, efficiency
│   └── streaming_analytics.kql        # Real-time throughput, funnel, anomalies
├── dataset-definitions/               # Power BI semantic model definitions
│   ├── platform_dashboard_model.yaml  # Model for platform + pipeline + quality
│   └── streaming_dashboard_model.yaml # Model for streaming analytics (ADX)
└── workbooks/                         # Azure Monitor Workbook templates (JSON)
    ├── platform_health_workbook.json  # Platform health monitoring
    ├── pipeline_performance_workbook.json  # ADF pipeline performance
    └── data_quality_workbook.json     # Data quality + freshness monitoring
```

---

## 📎 Prerequisites

Before setting up the dashboards, ensure you have:

| Requirement | Details |
|-------------|---------|
| **Log Analytics Workspace** | Workspace ID and Resource ID where Azure Diagnostics are sent |
| **Azure Data Explorer Cluster** | Cluster URI (e.g., `https://csaadx.eastus.kusto.windows.net`) for streaming data |
| **Power BI Desktop** | Latest version ([download](https://powerbi.microsoft.com/desktop/)) |
| **Power BI Pro/Premium License** | Required for publishing and scheduled refresh |
| **Azure AD Permissions** | Reader access to Log Analytics workspace and ADX cluster |
| **Diagnostic Settings** | Azure resources configured to send logs to Log Analytics |
| **Custom Log Tables** | `DbtTestResults_CL`, `DataQuality_CL`, `SchemaRegistry_CL`, `DataFreshness_CL` populated by your pipelines |

### ⚙️ Verify Diagnostic Settings

Ensure these Azure resources have diagnostic settings enabled to send logs to your Log Analytics workspace:

- **Azure Data Factory**: Enable `ADFPipelineRun`, `ADFActivityRun`, `ADFTriggerRun`
- **Azure Key Vault**: Enable `AuditEvent`
- **Azure SQL / Cosmos DB**: Enable relevant diagnostic categories
- **Azure Storage**: Enable `StorageBlobLogs`
- **VMs / App Services**: Enable `Heartbeat` via Azure Monitor Agent

---

## ⚙️ Setting Up Data Sources

### Option A: Direct Query (Recommended for Operational Dashboards)

Direct Query sends KQL queries to Log Analytics / ADX in real-time. Best for dashboards that need current data.

1. Open Power BI Desktop
2. Click **Get Data** > **Azure** > **Azure Log Analytics** (or **Azure Data Explorer**)
3. Enter your workspace ID or cluster URI
4. Authenticate with your Azure AD organizational account
5. Choose **DirectQuery** mode
6. In the query editor, paste queries from the `.kql` files

```text
Workspace ID: {your-workspace-id}
Connection Mode: DirectQuery
```

### Option B: Import Mode (Recommended for Historical / Cost Dashboards)

Import mode loads data into the Power BI model. Best for cost data and historical trends where real-time isn't needed.

1. Follow the same connection steps as Direct Query
2. Choose **Import** mode instead
3. Configure refresh schedule after publishing (see Section 5)

### Connecting to Azure Data Explorer

For streaming analytics queries:

1. **Get Data** > **Azure** > **Azure Data Explorer (Kusto)**
2. Enter cluster URI: `https://{cluster-name}.{region}.kusto.windows.net`
3. Enter database name: `streaming`
4. Authenticate with Azure AD
5. Paste queries from `streaming_analytics.kql`

---

## 💡 Creating Each Dashboard

### 💡 3.1 Platform Health Dashboard

**Queries:** `queries/platform_health.kql` (6 queries)
**Model:** `dataset-definitions/platform_dashboard_model.yaml`

| Visual | Query | Visualization Type |
|--------|-------|--------------------|
| Service Availability | `ServiceAvailabilityHeatmap` | Heatmap / Matrix |
| Error Rate Trends | `ErrorRateTimeSeries` | Line Chart (5-min granularity) |
| Resource Utilization | `ResourceUtilization` | Multi-line Chart with thresholds |
| Active Connections | `ActiveConnectionsByService` | Stacked Bar Chart |
| Storage Growth | `StorageCapacityGrowth` | Combo Chart (bar + trend line) |
| Key Vault Operations | `KeyVaultOperations` | Table with conditional formatting |

**Setup steps:**
1. Create a new report in Power BI Desktop
2. Add Log Analytics data source (Direct Query)
3. Create 6 queries using the KQL from `platform_health.kql`
4. Name each query matching the `let` variable names
5. Build visuals per the table above
6. Add slicers for `ResourceType` and `TimeGenerated`

### 💡 3.2 Pipeline Performance Dashboard

**Queries:** `queries/pipeline_performance.kql` (5 queries)

| Visual | Query | Visualization Type |
|--------|-------|--------------------|
| Pipeline Status Summary | `PipelineRunStatus` | Stacked Bar (by pipeline) |
| Duration Percentiles | `PipelineDurationTrends` | Multi-line (P50/P95/P99) |
| Data Volume | `DataMovementVolumes` | Stacked Area Chart |
| Failure Analysis | `ActivityFailures` | Sortable Grid with drill-down |
| Trigger Timeline | `TriggerExecutionTimeline` | Table / Gantt-style |

### 💡 3.3 Data Quality Dashboard

**Queries:** `queries/data_quality.kql` (4 queries)

| Visual | Query | Visualization Type |
|--------|-------|--------------------|
| dbt Test Pass/Fail | `DbtTestPassFailRates` | Stacked Area (pass/fail/warn) |
| Rule Violations | `DataQualityViolations` | Grouped Bar (domain x rule type) |
| Schema Drift | `SchemaDriftDetection` | Grid with severity formatting |
| Null Rate Tracking | `NullRateTracking` | Heatmap (column x date) |

### 💡 3.4 Data Freshness Dashboard

**Queries:** `queries/data_freshness.kql` (4 queries)

| Visual | Query | Visualization Type |
|--------|-------|--------------------|
| Gold Layer Refresh | `GoldLayerRefreshTimes` | Grid (color-coded by age) |
| SLA Compliance | `FreshnessSLACompliance` | Donut + Trend line |
| Pipeline Latency | `PipelineLayerLatency` | Waterfall / Stacked bar |
| Stale Data Alerts | `StaleDataAlerts` | Red-highlighted grid |

### 💡 3.5 Cost Attribution Dashboard

**Queries:** `queries/cost_attribution.kql` (4 queries)

| Visual | Query | Visualization Type |
|--------|-------|--------------------|
| Daily Cost by Service | `DailyCostByService` | Stacked Area Chart |
| Cost per Domain | `CostPerDomain` | Donut + Trend line |
| Compute Efficiency | `ComputeEfficiency` | Combo (bar + line) |
| MoM Trend | `MonthOverMonthCostTrend` | Grouped Bar + KPI card |

### 💡 3.6 Streaming Analytics Dashboard

**Queries:** `queries/streaming_analytics.kql` (5 queries)
**Model:** `dataset-definitions/streaming_dashboard_model.yaml`

| Visual | Query | Visualization Type |
|--------|-------|--------------------|
| Event Throughput | `RealTimeEventThroughput` | Line Chart (10s granularity) |
| Event Distribution | `EventTypeDistribution` | Donut / Pie Chart |
| Error Rate + Anomalies | `ErrorRateWithAnomalies` | Line + Anomaly band overlay |
| Geographic Distribution | `GeographicDistribution` | Map (bubble/choropleth) |
| Revenue Funnel | `RevenueFunnel` | Funnel Chart |

---

## 📦 Deploying Azure Monitor Workbooks

Azure Monitor Workbooks provide interactive dashboards directly in the Azure Portal. Three workbook templates are provided.

### Method 1: Azure Portal Import

1. Navigate to **Azure Portal** > **Monitor** > **Workbooks**
2. Click **+ New**
3. Click the **Advanced Editor** button (`</>` icon in the toolbar)
4. Open one of the workbook JSON files (e.g., `platform_health_workbook.json`)
5. Copy the entire JSON content
6. Paste into the Advanced Editor, replacing any existing content
7. Click **Apply**
8. Configure the parameters (Subscription, Resource Group, Time Range)
9. Click **Save** and choose a resource group and name

Repeat for each workbook:
- `platform_health_workbook.json` → "CSA Platform Health Dashboard"
- `pipeline_performance_workbook.json` → "CSA Pipeline Performance"
- `data_quality_workbook.json` → "CSA Data Quality Monitor"

### Method 2: Bicep / ARM Template Deployment

Deploy workbooks as infrastructure-as-code:

```bicep
@description('Log Analytics Workspace Resource ID')
param workspaceResourceId string

@description('Location for the workbook resource')
param location string = resourceGroup().location

resource platformHealthWorkbook 'Microsoft.Insights/workbooks@2022-04-01' = {
  name: guid('csa-platform-health-workbook', resourceGroup().id)
  location: location
  kind: 'shared'
  properties: {
    displayName: 'CSA Platform Health Dashboard'
    category: 'workbook'
    sourceId: workspaceResourceId
    serializedData: loadTextContent('workbooks/platform_health_workbook.json')
  }
}

resource pipelinePerformanceWorkbook 'Microsoft.Insights/workbooks@2022-04-01' = {
  name: guid('csa-pipeline-performance-workbook', resourceGroup().id)
  location: location
  kind: 'shared'
  properties: {
    displayName: 'CSA Pipeline Performance'
    category: 'workbook'
    sourceId: workspaceResourceId
    serializedData: loadTextContent('workbooks/pipeline_performance_workbook.json')
  }
}

resource dataQualityWorkbook 'Microsoft.Insights/workbooks@2022-04-01' = {
  name: guid('csa-data-quality-workbook', resourceGroup().id)
  location: location
  kind: 'shared'
  properties: {
    displayName: 'CSA Data Quality Monitor'
    category: 'workbook'
    sourceId: workspaceResourceId
    serializedData: loadTextContent('workbooks/data_quality_workbook.json')
  }
}
```

Deploy with:

```bash
az deployment group create \
  --resource-group rg-csa-monitoring \
  --template-file deploy/workbooks.bicep \
  --parameters workspaceResourceId="/subscriptions/{sub-id}/resourceGroups/{rg}/providers/Microsoft.OperationalInsights/workspaces/{workspace-name}"
```

### Method 3: Azure CLI

```bash
# Deploy a workbook from JSON file
az monitor app-insights workbook create \
  --resource-group rg-csa-monitoring \
  --name "csa-platform-health" \
  --display-name "CSA Platform Health Dashboard" \
  --category workbook \
  --kind shared \
  --source-id "/subscriptions/{sub-id}/resourceGroups/{rg}/providers/Microsoft.OperationalInsights/workspaces/{workspace}" \
  --serialized-data @workbooks/platform_health_workbook.json
```

---

## ⚙️ Configuring Scheduled Refresh

After publishing reports to Power BI Service:

1. Go to **Power BI Service** > **Settings** (gear icon) > **Datasets**
2. Select the dataset
3. Under **Scheduled refresh**, configure:

| Dataset | Refresh Frequency | Mode |
|---------|-------------------|------|
| Platform Health | Every 15 minutes | DirectQuery (auto) |
| Pipeline Performance | Every 15 minutes | DirectQuery (auto) |
| Data Quality | Every hour | Import + Scheduled |
| Data Freshness | Every 15 minutes | DirectQuery (auto) |
| Cost Attribution | Daily (6:00 AM UTC) | Import + Scheduled |
| Streaming Analytics | Real-time | DirectQuery (auto) |

### DirectQuery Notes

DirectQuery datasets don't need scheduled refresh -- they query the source in real-time. However, you should configure:

- **Query timeout**: Set to 120 seconds for complex queries
- **Auto page refresh**: Enable for operational dashboards (minimum 10 seconds for Premium)

### Import Mode Scheduled Refresh

For Import mode datasets:
1. Configure **Data gateway** if connecting from on-premises (not needed for cloud-to-cloud)
2. Set **Refresh schedule** (up to 48 refreshes/day for Premium, 8 for Pro)
3. Enable **Refresh failure notifications** to a distribution list

### Incremental Refresh (Recommended for Historical Data)

For large datasets, configure incremental refresh:

1. Create `RangeStart` and `RangeEnd` parameters (DateTime type)
2. Filter queries using these parameters
3. In Power BI Desktop: **Transform data** > Right-click table > **Incremental refresh**
4. Configure:
   - Archive data: 90 days (or 365 for cost data)
   - Incrementally refresh: Last 1 day
   - Detect data changes: `TimeGenerated` column

---

## 🔒 Row-Level Security (RLS)

RLS restricts data access based on the user viewing the report.

### Setting Up Domain-Based RLS

1. In Power BI Desktop, go to **Modeling** > **Manage roles**
2. Create a role named `DomainFilter`
3. Add DAX filter expressions per table:

```dax
// For DataQuality table
[Domain] = LOOKUPVALUE(
    DomainAccess[Domain],
    DomainAccess[UserEmail], USERPRINCIPALNAME()
)
```

4. Create a `DomainAccess` table mapping users to domains:

| UserEmail | Domain |
|-----------|--------|
| alice@contoso.com | sales |
| bob@contoso.com | inventory |
| carol@contoso.com | customers |

5. After publishing, assign users to roles in Power BI Service:
   - **Settings** > **Security** > Add members to the `DomainFilter` role

### Cost Data RLS

Cost data should only be visible to authorized finance users:

1. Create a `CostViewer` role
2. Add a static filter: `TRUE()` (all data visible to role members)
3. Only assign finance team members to this role
4. Non-members see no cost data at all

### 🧪 Testing RLS

In Power BI Desktop:
1. **Modeling** > **View as** > Select a role
2. Optionally enter a specific user identity
3. Verify only the expected data is visible

---

## 📦 Publishing to Power BI Service

### Step-by-Step Publishing

1. **Save** your Power BI Desktop file (.pbix)
2. Click **Publish** in the Home ribbon
3. Select the target workspace (e.g., "CSA Operations")
4. Wait for the publish to complete
5. Navigate to the Power BI Service to verify

### Post-Publishing Checklist

- [ ] Verify all visuals render correctly in the browser
- [ ] Configure scheduled refresh (Section 5)
- [ ] Set up RLS role membership (Section 6)
- [ ] Create a Power BI App for distribution
- [ ] Set up email subscriptions for key stakeholders
- [ ] Configure data alerts on critical metrics (Error Rate > 5%, etc.)
- [ ] Pin key visuals to a shared dashboard
- [ ] Verify mobile layout renders correctly

### Creating a Power BI App

For broader distribution:

1. In the workspace, click **Create app**
2. Configure:
   - **Name**: "CSA-in-a-Box Operations"
   - **Description**: "Platform health, pipeline, quality, and cost dashboards"
   - **Navigation**: Organize reports into sections
   - **Permissions**: Select Azure AD security groups
3. Click **Publish app**

### 🔒 Data Sensitivity Labels

If your organization uses Microsoft Information Protection:

1. Apply sensitivity labels to datasets and reports
2. Common labels for this data:
   - Platform Health: **Internal**
   - Cost Attribution: **Confidential**
   - Streaming Analytics: **Internal**

---

## 🔧 Troubleshooting

| Issue | Solution |
|-------|----------|
| "No data" in visuals | Verify diagnostic settings are enabled on Azure resources |
| Query timeout | Reduce time range, switch from Direct Query to Import, or optimize KQL |
| Custom tables missing | Ensure `DbtTestResults_CL`, `DataQuality_CL`, etc. are populated by your pipelines |
| Authentication error | Re-authenticate with Azure AD in data source settings |
| Workbook parameter not binding | Check parameter names match `{ParameterName}` placeholders in queries |
| ADX connection refused | Verify cluster URI and that your Azure AD account has Viewer permissions on the database |

---

## ⚙️ Custom Log Table Setup

The data quality and freshness dashboards depend on custom Log Analytics tables. Here's how to populate them:

### DbtTestResults_CL

Send dbt test results via the Log Analytics Data Collector API:

```python
import requests
import json
import datetime
import hashlib
import hmac
import base64

def send_to_log_analytics(workspace_id, shared_key, log_type, body):
    """Send custom log data to Log Analytics."""
    rfc1123date = datetime.datetime.utcnow().strftime('%a, %d %b %Y %H:%M:%S GMT')
    content_length = len(body)
    string_to_hash = f"POST\n{content_length}\napplication/json\nx-ms-date:{rfc1123date}\n/api/logs"
    bytes_to_hash = bytes(string_to_hash, encoding="utf-8")
    decoded_key = base64.b64decode(shared_key)
    encoded_hash = base64.b64encode(
        hmac.new(decoded_key, bytes_to_hash, digestmod=hashlib.sha256).digest()
    ).decode()
    signature = f"SharedKey {workspace_id}:{encoded_hash}"

    uri = f"https://{workspace_id}.ods.opinsights.azure.com/api/logs?api-version=2016-04-01"
    headers = {
        'content-type': 'application/json',
        'Authorization': signature,
        'Log-Type': log_type,
        'x-ms-date': rfc1123date
    }
    response = requests.post(uri, data=body, headers=headers)
    return response.status_code

# Example: Send dbt test results
test_results = [
    {
        "test_name": "not_null_orders_order_id",
        "status": "pass",
        "model_name": "orders",
        "domain": "sales",
        "test_type": "not_null",
        "failures": 0,
        "execution_time": 1234.5
    }
]
send_to_log_analytics(
    workspace_id="your-workspace-id",
    shared_key="your-shared-key",
    log_type="DbtTestResults",
    body=json.dumps(test_results)
)
```

### DataFreshness_CL

Populate from your freshness monitoring pipeline:

```json
[
  {
    "table_name": "gold_orders",
    "domain": "sales",
    "layer": "gold",
    "last_refresh": "2024-01-15T14:30:00Z",
    "row_count": 1500000,
    "freshness_target_minutes": 60,
    "pipeline_name": "pl_gold_orders"
  }
]
```

---

## 🔗 Related Documentation

- [Platform Services](../../docs/PLATFORM_SERVICES.md) - CSA-in-a-Box platform service details
- [Architecture Overview](../../docs/ARCHITECTURE.md) - Platform architecture reference
- [Azure Monitor Workbooks documentation](https://learn.microsoft.com/en-us/azure/azure-monitor/visualize/workbooks-overview)
- [Power BI + Azure Log Analytics connector](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/log-powerbi)
- [Power BI + Azure Data Explorer connector](https://learn.microsoft.com/en-us/azure/data-explorer/power-bi-overview)
- [KQL reference](https://learn.microsoft.com/en-us/kusto/query/)
- [Power BI Row-Level Security](https://learn.microsoft.com/en-us/power-bi/enterprise/service-admin-rls)
