/**
 * CSA Loom — prebuilt KQL query library for the Monitor → Logs tab.
 *
 * Every Loom Azure resource routes its diagnostic logs + metrics to ONE Log
 * Analytics workspace (see platform/fiab/bicep/modules/shared/diagnostic-settings.bicep,
 * categoryGroup=allLogs + AllMetrics). With the default (Azure-diagnostics)
 * destination, resource logs land in the `AzureDiagnostics` table and platform
 * metrics in `AzureMetrics`; a handful of resources always use dedicated tables
 * (Container Apps, App Insights, Entra). These queries are written against those
 * real tables/columns so they return rows on a live Loom workspace.
 *
 * Grounded in:
 *   - learn.microsoft.com/azure/azure-monitor/reference/tables/azurediagnostics
 *   - learn.microsoft.com/azure/azure-monitor/reference/tables/azuremetrics
 *   - per-service "monitor … with Azure Monitor" Learn pages (ADF, ADX, Synapse,
 *     Cosmos, Key Vault, APIM, Storage, Event Hubs, AI Search, Container Apps).
 *
 * The library is consumed by:
 *   - app/api/monitor/logs/route.ts  (GET returns the catalog; POST runs one)
 *   - lib/components/monitor/monitor-pane.tsx  (categorized picker)
 *   - the in-Loom Copilot build-assist (suggest-a-query tool)
 */

export type KqlCategory =
  | 'Troubleshooting'
  | 'Performance'
  | 'Audit & Security'
  | 'Cost & Usage'
  | 'Diagnostics & Health'
  | 'Data platform'
  | 'Networking';

export interface KqlQuery {
  id: string;
  label: string;
  category: KqlCategory;
  /** Azure service this query targets, for grouping/filtering. */
  service?: string;
  query: string;
  description: string;
  /** Render hint: 'table' (grid), 'timechart' (line), 'barchart', 'piechart'. */
  chart?: 'table' | 'timechart' | 'barchart' | 'piechart';
}

export const KQL_LIBRARY: KqlQuery[] = [
  // ── Troubleshooting ──────────────────────────────────────────────────────
  {
    id: 'tshoot-recent-errors',
    label: 'All resource errors & warnings (24h)',
    category: 'Troubleshooting',
    chart: 'table',
    description: 'Every diagnostic log row across all Loom resources at Warning/Error level in the last day — the first stop for "what broke".',
    query: `AzureDiagnostics
| where TimeGenerated > ago(24h)
| where Level in ("Error", "Warning", "Critical")
| project TimeGenerated, ResourceProvider, Resource, Category, Level, OperationName, ResultDescription
| sort by TimeGenerated desc
| take 200`,
  },
  {
    id: 'tshoot-failed-ops',
    label: 'Failed operations by resource (24h)',
    category: 'Troubleshooting',
    chart: 'barchart',
    description: 'Count of failed/error operations grouped by resource — surfaces the noisiest failing component.',
    query: `AzureDiagnostics
| where TimeGenerated > ago(24h)
| where ResultType in ("Failed", "Failure") or Level == "Error"
| summarize Failures = count() by Resource, ResourceProvider
| sort by Failures desc`,
  },
  {
    id: 'tshoot-aca-console',
    label: 'Container Apps console errors (1h)',
    category: 'Troubleshooting',
    service: 'Container Apps',
    chart: 'table',
    description: 'Console output from the Loom Container Apps (console/mcp/activator) filtered to error-like lines.',
    query: `ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(1h)
| where Log_s has_any ("error", "Error", "ERROR", "exception", "Exception", "fail")
| project TimeGenerated, ContainerAppName_s, RevisionName_s, Log_s
| sort by TimeGenerated desc
| take 200`,
  },
  {
    id: 'tshoot-aca-restarts',
    label: 'Container Apps system events / restarts (24h)',
    category: 'Troubleshooting',
    service: 'Container Apps',
    chart: 'table',
    description: 'Scaling, provisioning and restart events from the Container Apps environment.',
    query: `ContainerAppSystemLogs_CL
| where TimeGenerated > ago(24h)
| project TimeGenerated, ContainerAppName_s, Type_s, Reason_s, Log_s
| sort by TimeGenerated desc
| take 200`,
  },
  {
    id: 'tshoot-app-exceptions',
    label: 'Application exceptions (24h)',
    category: 'Troubleshooting',
    chart: 'table',
    description: 'Unhandled application exceptions from the App Insights-linked workspace.',
    query: `AppExceptions
| where TimeGenerated > ago(24h)
| project TimeGenerated, ProblemId, OuterMessage, CloudRoleName, ClientType
| sort by TimeGenerated desc
| take 100`,
  },

  // ── Performance ──────────────────────────────────────────────────────────
  {
    id: 'perf-request-latency',
    label: 'App request latency p50/p95/p99 (24h)',
    category: 'Performance',
    chart: 'timechart',
    description: 'Server response-time percentiles over time from App Insights requests.',
    query: `AppRequests
| where TimeGenerated > ago(24h)
| summarize p50 = percentile(DurationMs, 50), p95 = percentile(DurationMs, 95), p99 = percentile(DurationMs, 99) by bin(TimeGenerated, 15m)
| sort by TimeGenerated asc`,
  },
  {
    id: 'perf-request-volume',
    label: 'Request volume & failure rate (24h)',
    category: 'Performance',
    chart: 'timechart',
    description: 'Requests per 15-minute bin split by success/failure — throughput and error-rate trend.',
    query: `AppRequests
| where TimeGenerated > ago(24h)
| summarize Total = count(), Failed = countif(Success == false) by bin(TimeGenerated, 15m)
| extend FailureRatePct = round(100.0 * Failed / Total, 2)
| sort by TimeGenerated asc`,
  },
  {
    id: 'perf-metrics-cpu-mem',
    label: 'CPU & memory by resource (6h)',
    category: 'Performance',
    chart: 'timechart',
    description: 'Average platform CPU and memory percentage across all resources emitting AzureMetrics.',
    query: `AzureMetrics
| where TimeGenerated > ago(6h)
| where MetricName in ("CpuPercentage", "MemoryPercentage", "Percentage CPU", "cpu_percent", "memory_percent")
| summarize Avg = avg(Average) by bin(TimeGenerated, 5m), Resource, MetricName
| sort by TimeGenerated asc`,
  },
  {
    id: 'perf-slowest-deps',
    label: 'Slowest dependencies (24h)',
    category: 'Performance',
    chart: 'barchart',
    description: 'Outbound dependency calls (SQL, HTTP, Cosmos) ranked by average duration — find the slow backend.',
    query: `AppDependencies
| where TimeGenerated > ago(24h)
| summarize Calls = count(), AvgMs = round(avg(DurationMs), 1), p95 = percentile(DurationMs, 95) by Type, Target
| sort by AvgMs desc
| take 50`,
  },

  // ── Audit & Security ─────────────────────────────────────────────────────
  {
    id: 'sec-signins',
    label: 'Entra sign-ins (24h)',
    category: 'Audit & Security',
    chart: 'table',
    description: 'Recent Entra ID interactive sign-ins (requires SigninLogs ingestion).',
    query: `SigninLogs
| where TimeGenerated > ago(24h)
| project TimeGenerated, UserPrincipalName, AppDisplayName, ResultType, Status, IPAddress, Location
| sort by TimeGenerated desc
| take 100`,
  },
  {
    id: 'sec-signin-failures',
    label: 'Failed sign-ins by user (24h)',
    category: 'Audit & Security',
    chart: 'barchart',
    description: 'Sign-in failures grouped by user — brute-force / lockout signal.',
    query: `SigninLogs
| where TimeGenerated > ago(24h)
| where ResultType != 0
| summarize Failures = count() by UserPrincipalName, ResultType
| sort by Failures desc`,
  },
  {
    id: 'sec-kv-access',
    label: 'Key Vault secret access (24h)',
    category: 'Audit & Security',
    service: 'Key Vault',
    chart: 'table',
    description: 'Every Key Vault data-plane operation (secret/key get, set) with caller identity.',
    query: `AzureDiagnostics
| where TimeGenerated > ago(24h)
| where ResourceProvider == "MICROSOFT.KEYVAULT"
| project TimeGenerated, Resource, OperationName, ResultType, CallerIPAddress, identity_claim_upn_s
| sort by TimeGenerated desc
| take 200`,
  },
  {
    id: 'sec-kv-denied',
    label: 'Key Vault denied requests (7d)',
    category: 'Audit & Security',
    service: 'Key Vault',
    chart: 'table',
    description: 'Key Vault operations that returned a non-success result — firewall blocks or RBAC denials.',
    query: `AzureDiagnostics
| where TimeGenerated > ago(7d)
| where ResourceProvider == "MICROSOFT.KEYVAULT"
| where ResultType != "Success"
| project TimeGenerated, Resource, OperationName, ResultType, ResultSignature, CallerIPAddress
| sort by TimeGenerated desc`,
  },
  {
    id: 'sec-admin-activity',
    label: 'Privileged control-plane writes (24h)',
    category: 'Audit & Security',
    chart: 'table',
    description: 'Write/delete/action control-plane operations from the Activity log — who changed what.',
    query: `AzureActivity
| where TimeGenerated > ago(24h)
| where OperationNameValue has_any ("write", "delete", "action")
| where ActivityStatusValue == "Success"
| project TimeGenerated, Caller, OperationNameValue, ResourceGroup, _ResourceId
| sort by TimeGenerated desc
| take 200`,
  },

  // ── Cost & Usage ─────────────────────────────────────────────────────────
  {
    id: 'cost-ingestion-by-table',
    label: 'Log ingestion (GB) by table (24h)',
    category: 'Cost & Usage',
    chart: 'barchart',
    description: 'Data-ingestion volume per table — the #1 driver of Log Analytics cost.',
    query: `Usage
| where TimeGenerated > ago(24h)
| where IsBillable == true
| summarize GB = round(sum(Quantity) / 1024, 3) by DataType
| sort by GB desc`,
  },
  {
    id: 'cost-ingestion-trend',
    label: 'Daily ingestion trend (30d)',
    category: 'Cost & Usage',
    chart: 'timechart',
    description: 'Billable ingestion per day over a month — spot a runaway log source.',
    query: `Usage
| where TimeGenerated > ago(30d)
| where IsBillable == true
| summarize GB = round(sum(Quantity) / 1024, 2) by bin(TimeGenerated, 1d)
| sort by TimeGenerated asc`,
  },

  // ── Diagnostics & Health ─────────────────────────────────────────────────
  {
    id: 'health-heartbeat',
    label: 'Agent heartbeat (last seen)',
    category: 'Diagnostics & Health',
    chart: 'table',
    description: 'Most recent heartbeat per monitored host/agent — detect a stopped agent.',
    query: `Heartbeat
| summarize LastSeen = max(TimeGenerated) by Computer, _ResourceId
| extend MinutesAgo = round(datetime_diff('minute', now(), LastSeen) * -1, 0)
| sort by LastSeen desc`,
  },
  {
    id: 'health-resources-logging',
    label: 'Which resources are emitting logs (24h)',
    category: 'Diagnostics & Health',
    chart: 'barchart',
    description: 'Distinct resources sending diagnostics — confirms diagnostic settings are ON and flowing to this workspace.',
    query: `AzureDiagnostics
| where TimeGenerated > ago(24h)
| summarize Rows = count(), Categories = dcount(Category) by ResourceProvider, Resource
| sort by Rows desc`,
  },
  {
    id: 'health-metric-coverage',
    label: 'Which resources are emitting metrics (24h)',
    category: 'Diagnostics & Health',
    chart: 'barchart',
    description: 'Distinct resources sending platform metrics — the metrics half of diagnostic-settings coverage.',
    query: `AzureMetrics
| where TimeGenerated > ago(24h)
| summarize Metrics = dcount(MetricName), Samples = count() by Resource, ResourceProvider
| sort by Samples desc`,
  },

  // ── Data platform (per-service deep dives) ───────────────────────────────
  {
    id: 'adf-pipeline-runs',
    label: 'ADF / Synapse pipeline runs (24h)',
    category: 'Data platform',
    service: 'Data Factory',
    chart: 'table',
    description: 'Pipeline activity runs with status and duration from Data Factory diagnostics.',
    query: `AzureDiagnostics
| where TimeGenerated > ago(24h)
| where ResourceProvider in ("MICROSOFT.DATAFACTORY", "MICROSOFT.SYNAPSE")
| where Category in ("PipelineRuns", "ActivityRuns", "IntegrationRuntimeLogs", "SynapseIntegrationPipelineRuns", "SynapseIntegrationActivityRuns")
| project TimeGenerated, Resource, Category, pipelineName_s, activityName_s, status_s, OperationName
| sort by TimeGenerated desc
| take 200`,
  },
  {
    id: 'adf-failed-activities',
    label: 'ADF failed activities (7d)',
    category: 'Data platform',
    service: 'Data Factory',
    chart: 'table',
    description: 'Failed activity runs with error messages — pipeline debugging.',
    query: `AzureDiagnostics
| where TimeGenerated > ago(7d)
| where ResourceProvider in ("MICROSOFT.DATAFACTORY", "MICROSOFT.SYNAPSE")
| where Category in ("ActivityRuns", "SynapseIntegrationActivityRuns")
| where status_s == "Failed"
| project TimeGenerated, Resource, pipelineName_s, activityName_s, activityType_s, Error_s
| sort by TimeGenerated desc`,
  },
  {
    id: 'adx-query-perf',
    label: 'ADX query performance (24h)',
    category: 'Data platform',
    service: 'Data Explorer',
    chart: 'table',
    description: 'Kusto/ADX command + query execution durations and CPU.',
    query: `AzureDiagnostics
| where TimeGenerated > ago(24h)
| where ResourceProvider == "MICROSOFT.KUSTO"
| where Category in ("Command", "Query", "SucceededIngestion", "FailedIngestion")
| project TimeGenerated, Resource, Category, OperationName, State_s, TotalCpu_s, Duration_s
| sort by TimeGenerated desc
| take 200`,
  },
  {
    id: 'cosmos-ru-throttle',
    label: 'Cosmos DB throttled requests (24h)',
    category: 'Data platform',
    service: 'Cosmos DB',
    chart: 'timechart',
    description: 'HTTP 429 (rate-limited) Cosmos data-plane requests over time — RU pressure.',
    query: `AzureDiagnostics
| where TimeGenerated > ago(24h)
| where ResourceProvider == "MICROSOFT.DOCUMENTDB"
| where Category == "DataPlaneRequests"
| summarize Throttled = countif(toint(statusCode_s) == 429), Total = count() by bin(TimeGenerated, 15m)
| extend ThrottlePct = round(100.0 * Throttled / Total, 2)
| sort by TimeGenerated asc`,
  },
  {
    id: 'cosmos-ru-by-collection',
    label: 'Cosmos RU consumption by container (6h)',
    category: 'Data platform',
    service: 'Cosmos DB',
    chart: 'barchart',
    description: 'Request-unit charge grouped by collection — find the expensive container.',
    query: `AzureDiagnostics
| where TimeGenerated > ago(6h)
| where ResourceProvider == "MICROSOFT.DOCUMENTDB"
| where Category == "DataPlaneRequests"
| summarize TotalRU = round(sum(todouble(requestCharge_s)), 1) by collectionName_s, OperationName
| sort by TotalRU desc
| take 50`,
  },
  {
    id: 'storage-transactions',
    label: 'Storage transactions & latency (24h)',
    category: 'Data platform',
    service: 'Storage',
    chart: 'timechart',
    description: 'Blob/ADLS transaction count and end-to-end latency from StorageBlobLogs.',
    query: `StorageBlobLogs
| where TimeGenerated > ago(24h)
| summarize Transactions = count(), AvgE2EMs = round(avg(DurationMs), 1), Errors = countif(StatusCode >= 400) by bin(TimeGenerated, 30m)
| sort by TimeGenerated asc`,
  },
  {
    id: 'apim-requests',
    label: 'APIM gateway requests & backend latency (24h)',
    category: 'Data platform',
    service: 'API Management',
    chart: 'timechart',
    description: 'API Management gateway request volume, response codes and backend time.',
    query: `ApiManagementGatewayLogs
| where TimeGenerated > ago(24h)
| summarize Requests = count(), Errors = countif(ResponseCode >= 400), AvgBackendMs = round(avg(BackendTime), 1) by bin(TimeGenerated, 15m)
| sort by TimeGenerated asc`,
  },
  {
    id: 'search-query-latency',
    label: 'AI Search query latency & throttling (24h)',
    category: 'Data platform',
    service: 'AI Search',
    chart: 'timechart',
    description: 'Cognitive/AI Search query operations, latency and 503 throttling.',
    query: `AzureDiagnostics
| where TimeGenerated > ago(24h)
| where ResourceProvider == "MICROSOFT.SEARCH"
| where OperationName == "Query.Search"
| summarize Queries = count(), AvgMs = round(avg(DurationMs), 1), Throttled = countif(resultSignature_d == 503) by bin(TimeGenerated, 15m)
| sort by TimeGenerated asc`,
  },
  {
    id: 'eventhub-throughput',
    label: 'Event Hubs incoming/outgoing throughput (6h)',
    category: 'Data platform',
    service: 'Event Hubs',
    chart: 'timechart',
    description: 'Incoming vs outgoing messages and throttled requests from Event Hubs metrics.',
    query: `AzureMetrics
| where TimeGenerated > ago(6h)
| where ResourceProvider == "MICROSOFT.EVENTHUB"
| where MetricName in ("IncomingMessages", "OutgoingMessages", "ThrottledRequests")
| summarize Total = sum(Total) by bin(TimeGenerated, 15m), MetricName
| sort by TimeGenerated asc`,
  },

  // ── Networking ───────────────────────────────────────────────────────────
  {
    id: 'net-appgw-codes',
    label: 'App Gateway / Front Door response codes (24h)',
    category: 'Networking',
    service: 'Application Gateway',
    chart: 'timechart',
    description: 'HTTP response-code distribution at the public edge — 4xx/5xx surge detection.',
    query: `AzureDiagnostics
| where TimeGenerated > ago(24h)
| where ResourceProvider in ("MICROSOFT.NETWORK", "MICROSOFT.CDN")
| where Category in ("ApplicationGatewayAccessLog", "FrontDoorAccessLog", "FrontdoorAccessLog")
| summarize Requests = count() by bin(TimeGenerated, 15m), httpStatus_d
| sort by TimeGenerated asc`,
  },
  {
    id: 'net-appgw-backend-health',
    label: 'App Gateway backend health & latency (6h)',
    category: 'Networking',
    service: 'Application Gateway',
    chart: 'timechart',
    description: 'Backend response latency and unhealthy host count from App Gateway performance logs.',
    query: `AzureDiagnostics
| where TimeGenerated > ago(6h)
| where Category == "ApplicationGatewayPerformanceLog"
| summarize AvgLatencyMs = round(avg(latency_d), 1), Unhealthy = avg(unHealthyHostCount_d) by bin(TimeGenerated, 15m)
| sort by TimeGenerated asc`,
  },
];

/** Distinct categories in declared order, for grouped pickers. */
export const KQL_CATEGORIES: KqlCategory[] = [
  'Troubleshooting',
  'Performance',
  'Audit & Security',
  'Cost & Usage',
  'Diagnostics & Health',
  'Data platform',
  'Networking',
];

export function kqlById(id: string): KqlQuery | undefined {
  return KQL_LIBRARY.find((q) => q.id === id);
}
