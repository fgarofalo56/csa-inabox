/**
 * Workspace Monitoring — app-install content bundle.
 *
 * The Azure-native parity for a Microsoft Fabric "Workspace monitoring"
 * Eventhouse, materialized as a Loom workspace (no Fabric dependency —
 * .claude/rules/no-fabric-dependency.md):
 *
 *   Azure Monitor diagnostic settings (every Loom resource)
 *     → Log Analytics workspace
 *     → [optional] data-export → Event Hubs → ADX
 *     → read-only Workspace Monitoring ADX database
 *     → Workspace Monitoring Real-Time Dashboard.
 *
 * Items:
 *   workspace-monitor  -> workspaceMonitorProvisioner — creates the read-only
 *                         ADX DB (ResourceDiagnostics / ActivityEvents /
 *                         PlatformMetrics / AppTelemetry), enables diagnostic
 *                         settings across every Loom resource, seeds verified
 *                         sample rows, and (when an Event Hub namespace is
 *                         bound) wires the live LAW→EH→ADX feed.
 *   kql-dashboard      -> kqlDashboardProvisioner — the six-tile Workspace
 *                         Monitoring dashboard over the monitoring DB.
 *
 * The dashboard's tiles query the same `loomdb_workspace_monitor` database the
 * monitor item provisions (content.database below), so it renders real data
 * the moment the install returns.
 *
 * Grounded in Microsoft Learn:
 *   - Diagnostic settings: https://learn.microsoft.com/azure/azure-monitor/essentials/diagnostic-settings
 *   - LAW data export → Event Hub: https://learn.microsoft.com/azure/azure-monitor/logs/logs-data-export
 *   - ADX Event Hub data connection: https://learn.microsoft.com/azure/data-explorer/create-event-hubs-connection
 *   - KQL render operator (tile viz): https://learn.microsoft.com/kusto/query/render-operator
 */

import type { AppBundle } from './types';

// The monitoring database name — MUST match MONITOR_DB in
// lib/install/provisioners/workspace-monitor.ts and LOOM_WORKSPACE_MONITOR_DB.
const MONITOR_DB = 'loomdb_workspace_monitor';

// ── Dashboard tile queries (over the monitoring DB) ──────────────────────────

const TILE_DIAG_COVERAGE = `// Distinct resources emitting diagnostics in the last hour (KPI card).
ResourceDiagnostics
| where TimeGenerated > ago(1h)
| summarize value = dcount(_ResourceId)
| extend display_name = 'Resources reporting (1h)'`;

const TILE_FAILED_PCT = `// Failed request % over the last hour (KPI card).
AppTelemetry
| where TimeGenerated > ago(1h)
| summarize Failed = countif(ResultCode !startswith '2'), Total = sum(ItemCount)
| extend value = round(100.0 * Failed / Total, 2)
| project value
| extend display_name = 'Failed requests % (1h)'`;

const TILE_ACTIVITY_BAR = `// Activity-log events by category over the last 24 hours.
ActivityEvents
| where TimeGenerated > ago(24h)
| summarize events = count() by Category
| order by events asc
| render barchart with (title='Activity events by category (24h)', xcolumn=Category, ycolumns=events)`;

const TILE_REQUEST_RATE = `// API request rate per 5-minute bin over the last hour.
AppTelemetry
| where TimeGenerated > ago(1h)
| summarize Requests = sum(ItemCount) by bin(TimeGenerated, 5m), AppRoleName
| render timechart with (title='API request rate (1h)')`;

const TILE_RESOURCE_ERRORS = `// Failed resource operations by category over the last 24 hours.
ResourceDiagnostics
| where TimeGenerated > ago(24h) and ResultType == 'Failed'
| summarize value = count() by Category
| render piechart with (title='Resource errors by category (24h)', xcolumn=Category, ycolumns=value)`;

const TILE_CPU_TREND = `// Container Apps CPU (nanocores) per 5-minute bin over the last hour.
PlatformMetrics
| where TimeGenerated > ago(1h) and MetricName == 'UsageNanoCores'
| summarize avg_nanocores = avg(MetricValue) by bin(TimeGenerated, 5m), DimensionValue
| render timechart with (title='Container Apps CPU nanocores (1h)')`;

const bundle: AppBundle = {
  appId: 'app-workspace-monitoring',
  intro:
    '## Workspace Monitoring — Azure-native monitoring Eventhouse\n\n' +
    'The Azure-native parity for Microsoft Fabric **workspace monitoring**, ' +
    'materialized as a Loom workspace and runnable on first open — no Fabric ' +
    'capacity or workspace required:\n\n' +
    '1. **Diagnostic settings** — installing the app audits every Loom ' +
    'resource and enables the standardized `diag-loom-stdz` setting on any ' +
    'that is missing it, so logs + metrics flow to the Loom Log Analytics ' +
    'workspace.\n' +
    '2. **Workspace Monitoring DB** — a read-only Azure Data Explorer database ' +
    '(`' + MONITOR_DB + '`) with `ResourceDiagnostics`, `ActivityEvents`, ' +
    '`PlatformMetrics`, and `AppTelemetry` tables plus `RequestRate` / ' +
    '`DiagnosticCoverage` helper functions, seeded with verified sample rows.\n' +
    '3. **Live feed (optional)** — set `LOOM_EVENTHUB_NAMESPACE_RESOURCE_ID` ' +
    'and a Log Analytics data-export rule streams AzureDiagnostics / ' +
    'AzureActivity / AzureMetrics / AppRequests through Event Hubs into ADX ' +
    'continuously.\n' +
    '4. **Workspace Monitoring Dashboard** — a six-tile Real-Time Dashboard ' +
    '(resources reporting, failed %, activity by category, API request rate, ' +
    'resource errors, CPU trend) over the live monitoring DB.\n\n' +
    'Every item provisions against the live ADX + Azure Monitor backends via ' +
    'its real Phase-2 provisioner, or surfaces a precise remediation MessageBar ' +
    'naming the exact env var / role to set (per no-vaporware.md).',
  sourceDocs: [
    'https://learn.microsoft.com/azure/azure-monitor/essentials/diagnostic-settings',
    'https://learn.microsoft.com/azure/azure-monitor/logs/logs-data-export',
    'https://learn.microsoft.com/azure/data-explorer/create-event-hubs-connection',
    'https://learn.microsoft.com/azure/data-explorer/kusto/access-control/role-based-access-control',
    'https://learn.microsoft.com/kusto/query/render-operator',
  ],
  items: [
    // ─── Workspace Monitoring DB (read-only ADX, Azure Monitor fed) ──────────
    {
      itemType: 'workspace-monitor',
      displayName: 'Workspace Monitoring DB',
      description:
        'Read-only Azure Data Explorer database of platform usage + performance ' +
        'telemetry (ResourceDiagnostics, ActivityEvents, PlatformMetrics, ' +
        'AppTelemetry), fed by Azure Monitor diagnostic settings. Provisioning ' +
        'enables diag-loom-stdz across every Loom resource and seeds verified ' +
        'sample rows so the dashboard renders immediately.',
      learnDoc: 'workspace-monitoring/database',
      content: {
        kind: 'kql-database',
        // The schema below documents the read-only telemetry the provisioner
        // creates + seeds. The workspaceMonitorProvisioner owns the real
        // backend creation (fixed DB name + diagnostic-settings export); this
        // content is the editor's source-of-truth view of the tables.
        tables: [
          {
            name: 'ResourceDiagnostics',
            columns: [
              { name: 'TimeGenerated', type: 'datetime' },
              { name: 'ResourceId', type: 'string' },
              { name: 'Category', type: 'string' },
              { name: 'OperationName', type: 'string' },
              { name: 'ResultType', type: 'string' },
              { name: 'Caller', type: 'string' },
              { name: 'Properties', type: 'dynamic' },
              { name: '_ResourceId', type: 'string' },
            ],
          },
          {
            name: 'ActivityEvents',
            columns: [
              { name: 'TimeGenerated', type: 'datetime' },
              { name: 'OperationName', type: 'string' },
              { name: 'ActivityStatus', type: 'string' },
              { name: 'Caller', type: 'string' },
              { name: 'ResourceId', type: 'string' },
              { name: 'ResourceGroup', type: 'string' },
              { name: 'CorrelationId', type: 'string' },
              { name: 'Level', type: 'string' },
              { name: 'Category', type: 'string' },
            ],
          },
          {
            name: 'PlatformMetrics',
            columns: [
              { name: 'TimeGenerated', type: 'datetime' },
              { name: 'ResourceId', type: 'string' },
              { name: 'MetricName', type: 'string' },
              { name: 'MetricValue', type: 'real' },
              { name: 'UnitName', type: 'string' },
              { name: 'DimensionName', type: 'string' },
              { name: 'DimensionValue', type: 'string' },
            ],
          },
          {
            name: 'AppTelemetry',
            columns: [
              { name: 'TimeGenerated', type: 'datetime' },
              { name: 'Name', type: 'string' },
              { name: 'ResultCode', type: 'string' },
              { name: 'DurationMs', type: 'real' },
              { name: 'OperationId', type: 'string' },
              { name: 'AppRoleName', type: 'string' },
              { name: 'ItemCount', type: 'long' },
            ],
          },
        ],
        starterQueries: [
          { name: 'Diagnostic coverage (1h)', kql: 'DiagnosticCoverage(1h)' },
          { name: 'Request rate (1h)', kql: 'RequestRate(1h)' },
          {
            name: 'Top failing operations (24h)',
            kql:
              "ResourceDiagnostics\n" +
              "| where TimeGenerated > ago(24h) and ResultType == 'Failed'\n" +
              "| summarize failures = count() by OperationName, Category\n" +
              "| order by failures desc",
          },
        ],
      },
    },

    // ─── Workspace Monitoring Dashboard (6 tiles over the monitor DB) ────────
    {
      itemType: 'kql-dashboard',
      displayName: 'Workspace Monitoring Dashboard',
      description:
        'Six-tile Real-Time Dashboard over the Workspace Monitoring DB: ' +
        'resources reporting, failed request %, activity events by category, ' +
        'API request rate, resource errors by category, and Container Apps CPU ' +
        'trend. Renders live ADX data the moment the database is seeded.',
      learnDoc: 'workspace-monitoring/dashboard',
      content: {
        kind: 'kql-dashboard',
        // Bind the tiles to the monitoring DB the sibling workspace-monitor
        // item provisions (fixed name; slugs to itself — underscores only).
        database: MONITOR_DB,
        tiles: [
          { title: 'Resources reporting (1h)', viz: 'card', kql: TILE_DIAG_COVERAGE },
          { title: 'Failed requests % (1h)', viz: 'card', kql: TILE_FAILED_PCT },
          { title: 'Activity events by category (24h)', viz: 'bar', kql: TILE_ACTIVITY_BAR },
          { title: 'API request rate (1h)', viz: 'line', kql: TILE_REQUEST_RATE },
          { title: 'Resource errors by category (24h)', viz: 'pie', kql: TILE_RESOURCE_ERRORS },
          { title: 'Container Apps CPU (1h)', viz: 'line', kql: TILE_CPU_TREND },
        ],
      },
    },
  ],
};

export default bundle;
