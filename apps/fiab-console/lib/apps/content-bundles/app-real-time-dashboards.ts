/**
 * Real-Time Dashboards — app-install content bundle.
 *
 * The canonical Microsoft Fabric **Real-Time Intelligence** end-to-end,
 * materialized as a Loom workspace:
 *
 *   Eventstream (live source) → Eventhouse / KQL Database → Real-Time
 *   Dashboard (multi-tile, auto-refreshing) → Data Activator alert →
 *   Power BI Direct Lake semantic model + report.
 *
 * Each item below maps 1:1 to a REAL Phase-2 provisioner already registered
 * in lib/install/provisioning-engine.ts (no new provisioner needed):
 *   eventstream    -> eventstreamProvisioner    (Fabric Eventstream item)
 *   kql-database   -> kqlDatabaseProvisioner     (Eventhouse/ADX tables + functions + seeded rows)
 *   kql-dashboard  -> kqlDashboardProvisioner    (real Fabric RealTimeDashboard.json definition)
 *   activator      -> activatorProvisioner        (Data Activator reflex rule)
 *   semantic-model -> semanticModelProvisioner   (Direct Lake star model + DAX measures)
 *   report         -> reportProvisioner           (PBIR report byConnection to the semantic model)
 *
 * Every Fabric/KQL detail is grounded in Microsoft Learn:
 *   - Real-Time Dashboard (tiles, pages, auto-refresh ≥10s, parameters,
 *     data sources, Data Activator alerts on tiles):
 *     https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-real-time-create
 *     https://learn.microsoft.com/fabric/real-time-intelligence/real-time-dashboards-overview
 *   - KQL render operator visual types (card / timechart / columnchart /
 *     barchart / piechart / anomalychart / table):
 *     https://learn.microsoft.com/kusto/query/render-operator
 *   - series_decompose_anomalies for the anomaly tile:
 *     https://learn.microsoft.com/kusto/query/series-decompose-anomalies-function
 *   - Trigger alerts from a Real-Time Dashboard via Data Activator:
 *     https://learn.microsoft.com/fabric/real-time-intelligence/data-activator/activator-get-data-real-time-dashboard
 *   - Eventstream sources/destinations:
 *     https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/overview
 *
 * The dashboard's tile viz hints (card/line/bar/pie/table) are exactly the
 * KqlDashboardContent.tiles enum the kqlDashboardProvisioner compiles into a
 * real RealTimeDashboard.json definition, so the surface is runnable the
 * moment it lands in a bound Fabric workspace (or surfaces the documented
 * remediation gate naming LOOM_KUSTO_CLUSTER_URI / the Fabric workspace).
 */

import type { AppBundle } from './types';

// ════════════════════════════════════════════════════════════════════════
//  EVENTSTREAM — live source into the Eventhouse + cold-path lakehouse
//  (Fabric Eventstream: source → optional transform → KQL DB destination)
// ════════════════════════════════════════════════════════════════════════

const ES_SOURCE_EVENTHUB = {
  id: 'src-eventhub-orders',
  type: 'event-hub',
  config: {
    // Honest config-only state: when no Event Hub is provisioned the
    // eventstreamProvisioner gates on LOOM_EVENTHUB_CONNECTION_STRING and the
    // built-in sample-data generator below keeps the dashboard runnable.
    eventHubNamespace: 'ehns-loom-${tenantSlug}',
    eventHubName: 'orders',
    consumerGroup: 'loom-rtdash',
    connectionStringSecretRef: 'LOOM_EVENTHUB_CONNECTION_STRING',
    inputFormat: 'json',
    partitionCount: 8,
    sampleDataFallback: {
      enabled: true,
      generator: 'fabric-sample-stock-events',
      description:
        'When no Event Hub is bound, the Eventstream uses the built-in ' +
        'Fabric sample data source (Stock market / Yellow-taxi style events) ' +
        'so the Eventhouse, dashboard, and Activator are exercised end-to-end ' +
        'with no external infra. Documented under Eventstream "Add sample ' +
        'data source".',
    },
  },
};

const ES_TRANSFORM_PROJECT = {
  id: 'tx-shape-orders',
  type: 'manage-fields',
  config: {
    description:
      'Manage-fields transform: normalizes the raw order event into the ' +
      'Eventhouse Orders schema (event_time, order_id, region, channel, ' +
      'amount, latency_ms, status) and drops debug / heartbeat envelopes. ' +
      'Mirrors the Eventstream editor "Manage fields" operator.',
    fields: [
      { name: 'event_time', expression: 'TO_TIMESTAMP(payload.ts)' },
      { name: 'order_id',   expression: 'payload.orderId' },
      { name: 'region',     expression: 'payload.region' },
      { name: 'channel',    expression: 'payload.channel' },
      { name: 'amount',     expression: 'CAST(payload.amount AS DOUBLE)' },
      { name: 'latency_ms', expression: 'CAST(payload.latencyMs AS BIGINT)' },
      { name: 'status',     expression: 'payload.status' },
    ],
    where: "payload.kind = 'order' AND payload.orderId IS NOT NULL",
  },
};

const ES_DEST_EVENTHOUSE = {
  id: 'dst-eventhouse-orders',
  type: 'kql-database',
  config: {
    database: 'RealTimeOrders',
    table: 'Orders',
    ingestionMappingName: 'OrdersJsonMapping',
    inputDataFormat: 'json',
    streamingIngestion: true,
    description:
      'Direct-ingestion destination into the RealTimeOrders Eventhouse / KQL ' +
      'database, table Orders. Streaming ingestion gives the Real-Time ' +
      'Dashboard sub-second freshness.',
  },
};

const ES_DEST_LAKEHOUSE = {
  id: 'dst-lakehouse-cold',
  type: 'lakehouse',
  config: {
    workspace: 'real-time-dashboards',
    lakehouse: 'rtdash_bronze',
    table: 'orders_raw',
    minimumRows: 100000,
    maximumDurationSeconds: 120,
    description:
      'Cold-path mirror: the Eventstream also lands events into a Lakehouse ' +
      'Delta table for batch / Direct Lake so the Power BI semantic model can ' +
      'read history the hot ADX cache has aged out.',
  },
};

// ════════════════════════════════════════════════════════════════════════
//  EVENTHOUSE / KQL DATABASE — Orders + Regions, functions, starter queries
//  (seeded sample rows so every dashboard tile renders on first open)
// ════════════════════════════════════════════════════════════════════════

// update-policy style enrichment function: parse raw → typed Orders rows.
//
// Each KQL function below is a COMPLETE `.create-or-alter function …{…}`
// control command (the shape the kqlDatabaseProvisioner runs verbatim — it
// detects a full command past any leading `//` comment lines and does NOT
// re-wrap it, which is what previously caused the SYN0002 double-wrap). Both
// functions are valid CSL; `parse_orders` reads the real RawOrders landing
// table declared in `tables[]` below so it passes Kusto semantic validation
// at create time. Wired as the Orders update policy (see ingestionPolicies):
//   .alter table Orders policy update
//   @'[{"IsEnabled":true,"Source":"RawOrders","Query":"parse_orders()", … }]'
const KQL_FN_PARSE_ORDERS = `// Shapes a raw streamed order envelope into a typed Orders row. Wired as the
// Orders table update policy so streaming-ingested RawOrders fan out into
// Orders.
.create-or-alter function parse_orders()
{
    RawOrders
    | extend p = parse_json(payload)
    | project
        event_time = todatetime(p.ts),
        order_id   = tostring(p.orderId),
        region     = tostring(p.region),
        channel    = tostring(p.channel),
        amount     = todouble(p.amount),
        latency_ms = tolong(p.latencyMs),
        status     = tostring(p.status)
    | where isnotempty(order_id)
}`;

// Rolling-window revenue + error-rate health, parameterized by time window so
// the dashboard time-range parameter flows in.
const KQL_FN_ORDER_HEALTH = `// Per-region order health over a window: order count, revenue, p95 latency,
// and error rate. Used by the dashboard's per-region table tile.
.create-or-alter function order_health(window:timespan = 1h)
{
    Orders
    | where event_time > ago(window)
    | summarize
        orders      = count(),
        revenue     = sum(amount),
        p95_latency = percentile(latency_ms, 95),
        errors      = countif(status == 'failed')
        by region
    | extend error_rate_pct = round(100.0 * errors / orders, 2)
    | order by revenue desc
}`;

// ─── Starter analyst KQL queries (Eventhouse / queryset) ─────────────────

const KQL_Q_REVENUE_TREND = `// Revenue per minute over the last 4 hours (powers the trend tile).
Orders
| where event_time > ago(4h)
| summarize revenue = sum(amount) by bin(event_time, 1m)
| order by event_time asc
| render timechart with (title='Revenue / minute (4h)')`;

const KQL_Q_ORDERS_BY_REGION = `// Orders by region in the last hour (powers the per-region bar tile).
Orders
| where event_time > ago(1h)
| summarize orders = count() by region
| order by orders asc
| render barchart with (title='Orders by Region (1h)',
                       xcolumn=region, ycolumns=orders)`;

const KQL_Q_LATENCY_ANOMALY = `// Order-processing latency with anomalies highlighted. Uses
// make-series + series_decompose_anomalies so the anomaly tile flags
// spikes the eye would miss.
let step = 1m;
Orders
| where event_time > ago(6h)
| make-series p95 = percentile(latency_ms, 95) default=0
    on event_time step step
| extend (anomalies, score, baseline) =
    series_decompose_anomalies(p95, 1.5, -1, 'linefit')
| render anomalychart with (title='Latency p95 anomalies (6h)',
                           anomalycolumns=anomalies)`;

const KQL_Q_ERROR_RATE = `// Error rate (% failed orders) per 5-minute bin over the last 2 hours.
Orders
| where event_time > ago(2h)
| summarize
    total  = count(),
    failed = countif(status == 'failed')
    by bin(event_time, 5m)
| extend error_rate_pct = round(100.0 * failed / total, 2)
| order by event_time asc
| render timechart with (title='Error rate % (2h)')`;

const KQL_Q_CHANNEL_MIX = `// Channel mix in the last hour (powers the channel pie tile).
Orders
| where event_time > ago(1h)
| summarize value = count() by channel
| render piechart with (title='Orders by Channel (1h)',
                       xcolumn=channel, ycolumns=value)`;

const KQL_Q_TOP_REGIONS = `// Per-region health roll-up (orders, revenue, p95 latency, error rate).
order_health(1h)`;

// ════════════════════════════════════════════════════════════════════════
//  REAL-TIME DASHBOARD TILES — compiled into a real RealTimeDashboard.json
//  (kqlDashboardProvisioner; viz ∈ card|line|bar|pie|table)
// ════════════════════════════════════════════════════════════════════════

const TILE_TOTAL_REVENUE = `// Total revenue in the last hour (KPI card).
Orders
| where event_time > ago(1h)
| summarize value = round(sum(amount), 2)
| extend display_name = 'Revenue (1h)'`;

const TILE_ORDERS_PER_MIN = `// Current order rate — orders in the last minute (KPI card).
Orders
| where event_time > ago(1m)
| summarize value = count()
| extend display_name = 'Orders / min'`;

const TILE_ERROR_RATE_CARD = `// Error rate over the last 15 minutes (KPI card; red over SLA).
Orders
| where event_time > ago(15m)
| summarize total = count(), failed = countif(status == 'failed')
| extend value = round(100.0 * failed / total, 2)
| project value
| extend display_name = 'Error rate % (15m)'`;

const TILE_REVENUE_TREND = `// Revenue per minute timechart over the last 4 hours.
Orders
| where event_time > ago(4h)
| summarize revenue = sum(amount) by bin(event_time, 1m)
| order by event_time asc
| render timechart with (title='Revenue / minute (4h)')`;

const TILE_ORDERS_REGION_BAR = `// Orders by region in the last hour.
Orders
| where event_time > ago(1h)
| summarize orders = count() by region
| order by orders asc
| render barchart with (title='Orders by Region (1h)',
                       xcolumn=region, ycolumns=orders)`;

const TILE_CHANNEL_PIE = `// Channel mix in the last hour.
Orders
| where event_time > ago(1h)
| summarize value = count() by channel
| render piechart with (title='Orders by Channel (1h)',
                       xcolumn=channel, ycolumns=value)`;

const TILE_REGION_HEALTH_TABLE = `// Per-region health roll-up: orders, revenue, p95 latency, error rate.
Orders
| where event_time > ago(1h)
| summarize
    orders      = count(),
    revenue     = round(sum(amount), 2),
    p95_latency = percentile(latency_ms, 95),
    errors      = countif(status == 'failed')
    by region
| extend error_rate_pct = round(100.0 * errors / orders, 2)
| extend health_band = case(
    error_rate_pct <= 1.0 and p95_latency < 500, 'GREEN',
    error_rate_pct <= 5.0 and p95_latency < 1500, 'YELLOW',
    'RED')
| project region, orders, revenue, p95_latency, error_rate_pct, health_band
| order by revenue desc`;

// ════════════════════════════════════════════════════════════════════════
//  BUNDLE
// ════════════════════════════════════════════════════════════════════════

const bundle: AppBundle = {
  appId: 'app-real-time-dashboards',
  intro:
    '## Real-Time Dashboards — Fabric Real-Time Intelligence end-to-end\n\n' +
    'The full Microsoft Fabric **Real-Time Intelligence** path, materialized ' +
    'as a Loom workspace and runnable on first open:\n\n' +
    '1. **Eventstream** — a live Event Hub source (with a built-in Fabric ' +
    'sample-data fallback) shapes order events and lands them in the ' +
    '`RealTimeOrders` Eventhouse + a cold-path Lakehouse table.\n' +
    '2. **Eventhouse / KQL Database** — the `Orders` + `Regions` tables, a ' +
    '`parse_orders` update function and an `order_health` rollup function, ' +
    'plus six starter analyst queries — all seeded with sample rows so every ' +
    'tile renders immediately.\n' +
    '3. **Real-Time Dashboard** — a seven-tile auto-refreshing dashboard ' +
    '(revenue / order-rate / error-rate KPI cards, revenue trend, orders-by-' +
    'region bar, channel-mix pie, per-region health table) compiled into a ' +
    'real Fabric `RealTimeDashboard.json` definition.\n' +
    '4. **Data Activator** — a reflex rule pages on-call via Teams when the ' +
    'order error rate breaches the 5% SLA.\n' +
    '5. **Power BI** — a Direct Lake semantic model over the cold-path orders ' +
    'with revenue / AOV / error-rate DAX measures, surfaced in an executive ' +
    'report.\n\n' +
    'Every item provisions against live Fabric/ADX backends via its real ' +
    'Phase-2 provisioner, or surfaces a precise remediation MessageBar naming ' +
    'the exact env var / role / workspace to set (per no-vaporware.md).',
  sourceDocs: [
    'https://learn.microsoft.com/fabric/real-time-intelligence/real-time-dashboards-overview',
    'https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-real-time-create',
    'https://learn.microsoft.com/fabric/real-time-intelligence/dashboard-parameters',
    'https://learn.microsoft.com/fabric/real-time-intelligence/data-activator/activator-get-data-real-time-dashboard',
    'https://learn.microsoft.com/kusto/query/render-operator',
    'https://learn.microsoft.com/kusto/query/series-decompose-anomalies-function',
    'https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/overview',
    'https://learn.microsoft.com/fabric/real-time-intelligence/event-streams/add-source-events-hub',
    'https://learn.microsoft.com/kusto/management/create-alter-function',
    'https://learn.microsoft.com/kusto/management/update-policy',
    'https://learn.microsoft.com/kusto/management/alter-table-cache-policy-command',
    'https://learn.microsoft.com/kusto/management/alter-merge-table-retention-policy-command',
  ],
  items: [
    // ─── Eventstream: live source → Eventhouse + cold Lakehouse ───────────
    {
      itemType: 'eventstream',
      displayName: 'Real-Time Orders Eventstream',
      description:
        'Routes live order events from an Event Hub (or the built-in Fabric ' +
        'sample-data source) through a manage-fields transform into the ' +
        'RealTimeOrders Eventhouse and a cold-path Lakehouse Delta table.',
      learnDoc: 'real-time-dashboards/eventstream',
      content: {
        kind: 'eventstream',
        sources: [ES_SOURCE_EVENTHUB],
        transforms: [ES_TRANSFORM_PROJECT],
        destinations: [ES_DEST_EVENTHOUSE, ES_DEST_LAKEHOUSE],
      },
    },

    // ─── Eventhouse / KQL Database: Orders + Regions (seeded) ─────────────
    {
      itemType: 'kql-database',
      displayName: 'RealTimeOrders Eventhouse',
      description:
        'ADX/Eventhouse database with Orders (typed order events) and Regions ' +
        '(catalog) tables, the parse_orders update function and order_health ' +
        'rollup, plus six starter analyst queries. Seeded with sample rows so ' +
        'the dashboard tiles render before any live data arrives.',
      learnDoc: 'real-time-dashboards/eventhouse',
      content: {
        kind: 'kql-database',
        tables: [
          {
            // Raw streaming landing table. The Eventstream direct-ingestion
            // destination lands the unparsed JSON envelope here; the
            // `parse_orders` update function fans each row out into the typed
            // Orders table (see the update policy in `ingestionPolicies`).
            // Declared first so `parse_orders` passes Kusto semantic
            // validation when the function is created.
            name: 'RawOrders',
            columns: [
              { name: 'payload',     type: 'string'   },
              { name: 'enqueued_at', type: 'datetime' },
            ],
            sample: [
              ['{"ts":"2026-06-01T14:00:00Z","orderId":"ord-100001","region":"us-east","channel":"web","amount":42.50,"latencyMs":180,"status":"completed","kind":"order"}', '2026-06-01T14:00:00Z'],
              ['{"ts":"2026-06-01T14:00:07Z","orderId":"ord-100004","region":"us-east","channel":"partner","amount":0.00,"latencyMs":2100,"status":"failed","kind":"order"}', '2026-06-01T14:00:07Z'],
            ],
          },
          {
            name: 'Orders',
            columns: [
              { name: 'event_time', type: 'datetime' },
              { name: 'order_id',   type: 'string'   },
              { name: 'region',     type: 'string'   },
              { name: 'channel',    type: 'string'   },
              { name: 'amount',     type: 'real'     },
              { name: 'latency_ms', type: 'long'     },
              { name: 'status',     type: 'string'   },
            ],
            sample: [
              ['2026-06-01T14:00:00Z', 'ord-100001', 'us-east', 'web',    42.50,  180, 'completed'],
              ['2026-06-01T14:00:02Z', 'ord-100002', 'us-west', 'mobile', 220.00, 240, 'completed'],
              ['2026-06-01T14:00:05Z', 'ord-100003', 'eu-west', 'web',    18.99,  310, 'completed'],
              ['2026-06-01T14:00:07Z', 'ord-100004', 'us-east', 'partner', 0.00, 2100, 'failed'],
              ['2026-06-01T14:00:09Z', 'ord-100005', 'apac',    'mobile', 305.75, 195, 'completed'],
              ['2026-06-01T14:00:12Z', 'ord-100006', 'us-west', 'web',    77.40,  220, 'completed'],
              ['2026-06-01T14:00:14Z', 'ord-100007', 'eu-west', 'partner', 0.00, 1800, 'failed'],
              ['2026-06-01T14:00:16Z', 'ord-100008', 'apac',    'web',    133.10, 260, 'completed'],
            ],
          },
          {
            name: 'Regions',
            columns: [
              { name: 'region',      type: 'string' },
              { name: 'region_name', type: 'string' },
              { name: 'currency',    type: 'string' },
              { name: 'sla_p95_ms',  type: 'long'   },
              { name: 'is_active',   type: 'bool'   },
            ],
            sample: [
              ['us-east', 'US East (Virginia)', 'USD', 500, true],
              ['us-west', 'US West (Oregon)',   'USD', 500, true],
              ['eu-west', 'EU West (Ireland)',  'EUR', 700, true],
              ['apac',    'Asia Pacific (Tokyo)', 'JPY', 800, true],
            ],
          },
        ],
        functions: [
          { name: 'parse_orders', body: KQL_FN_PARSE_ORDERS },
          { name: 'order_health', body: KQL_FN_ORDER_HEALTH },
        ],
        ingestionPolicies: [
          {
            table: 'Orders',
            // One control command per line — executed verbatim by the
            // provisioner (it splits on newline). Syntax grounded in Learn:
            //  - retention uses .alter-merge (merges into existing policy):
            //    https://learn.microsoft.com/kusto/management/alter-merge-table-retention-policy-command
            //  - caching uses .alter (NOT .alter-merge — caching has no merge
            //    form; `.alter table T policy caching hot = 7d`):
            //    https://learn.microsoft.com/kusto/management/alter-table-cache-policy-command
            //  - streamingingestion enable gives the dashboard sub-second
            //    freshness:
            //    https://learn.microsoft.com/kusto/management/show-table-streaming-ingestion-policy-command
            policy:
              '.alter-merge table Orders policy retention softdelete = 90d\n' +
              '.alter table Orders policy caching hot = 7d\n' +
              '.alter table Orders policy streamingingestion enable',
          },
          {
            table: 'RawOrders',
            // Update policy: every row landed in RawOrders is transformed by
            // parse_orders() and appended to Orders. transactional=true so a
            // bad row fails ingestion rather than silently dropping. Grounded
            // in Learn (update policy):
            //   https://learn.microsoft.com/kusto/management/update-policy
            policy:
              ".alter table Orders policy update " +
              "@'[{\"IsEnabled\":true,\"Source\":\"RawOrders\",\"Query\":\"parse_orders()\",\"IsTransactional\":true,\"PropagateIngestionProperties\":false}]'",
          },
        ],
        starterQueries: [
          { name: 'Revenue / minute (4h)',           kql: KQL_Q_REVENUE_TREND },
          { name: 'Orders by region (1h)',           kql: KQL_Q_ORDERS_BY_REGION },
          { name: 'Latency p95 anomalies (6h)',      kql: KQL_Q_LATENCY_ANOMALY },
          { name: 'Error rate % (2h)',               kql: KQL_Q_ERROR_RATE },
          { name: 'Orders by channel (1h)',          kql: KQL_Q_CHANNEL_MIX },
          { name: 'Per-region health roll-up (1h)',  kql: KQL_Q_TOP_REGIONS },
        ],
      },
    },

    // ─── Real-Time Dashboard: 7-tile auto-refresh ─────────────────────────
    {
      itemType: 'kql-dashboard',
      displayName: 'Real-Time Orders Dashboard',
      description:
        'Seven-tile auto-refreshing Real-Time Dashboard: revenue / order-rate ' +
        '/ error-rate KPI cards, a revenue trend line, an orders-by-region ' +
        'bar, a channel-mix pie, and a per-region health table. Compiled into ' +
        'a real Fabric RealTimeDashboard.json definition bound to the ' +
        'RealTimeOrders Eventhouse.',
      learnDoc: 'real-time-dashboards/dashboard',
      content: {
        kind: 'kql-dashboard',
        tiles: [
          { title: 'Revenue (1h)',            viz: 'card',  kql: TILE_TOTAL_REVENUE },
          { title: 'Orders / min',            viz: 'card',  kql: TILE_ORDERS_PER_MIN },
          { title: 'Error rate % (15m)',      viz: 'card',  kql: TILE_ERROR_RATE_CARD },
          { title: 'Revenue / minute (4h)',   viz: 'line',  kql: TILE_REVENUE_TREND },
          { title: 'Orders by Region (1h)',   viz: 'bar',   kql: TILE_ORDERS_REGION_BAR },
          { title: 'Orders by Channel (1h)',  viz: 'pie',   kql: TILE_CHANNEL_PIE },
          { title: 'Region Health Roll-up',   viz: 'table', kql: TILE_REGION_HEALTH_TABLE },
        ],
      },
    },

    // ─── Data Activator: error-rate SLA breach → Teams ────────────────────
    {
      itemType: 'activator',
      displayName: 'Order Error-Rate SLA Alert',
      description:
        'Data Activator reflex rule that fires when the order error rate ' +
        'breaches the 5% SLA over a 15-minute window, paging the on-call ' +
        'channel via Teams. Wired to the error-rate tile on the Real-Time ' +
        'Orders Dashboard.',
      learnDoc: 'real-time-dashboards/activator',
      content: {
        kind: 'activator',
        rule: {
          name: 'order_error_rate_sla_breach',
          condition: { metric: 'error_rate_pct', op: '>', threshold: 5 },
          window: '15 minutes',
          action: {
            kind: 'teams',
            config: {
              channel: 'rtdash-oncall',
              title: 'Order error-rate SLA breach — > 5% failed (15m)',
              body:
                'The order error rate exceeded the 5% SLA over the last 15 ' +
                'minutes. Open the Real-Time Orders Dashboard, check the ' +
                'per-region health table and latency anomaly tile, and inspect ' +
                'the failing channel/region in the RealTimeOrders Eventhouse.',
            },
          },
        },
      },
    },

    // ─── Semantic model: Direct Lake star over the cold-path orders ───────
    {
      itemType: 'semantic-model',
      displayName: 'Real-Time Orders Semantic Model',
      description:
        'Power BI Direct Lake star model over the cold-path orders (orders ' +
        'fact + dim_region) with revenue / order-count / AOV / error-rate DAX ' +
        'measures. Powers the executive Real-Time Orders report.',
      learnDoc: 'real-time-dashboards/semantic-model',
      content: {
        kind: 'semantic-model',
        tables: [
          {
            name: 'orders',
            columns: [
              { name: 'event_time', dataType: 'dateTime' },
              { name: 'order_id',   dataType: 'string'   },
              { name: 'region',     dataType: 'string'   },
              { name: 'channel',    dataType: 'string'   },
              { name: 'amount',     dataType: 'decimal'  },
              { name: 'latency_ms', dataType: 'int64'    },
              { name: 'status',     dataType: 'string'   },
            ],
          },
          {
            name: 'dim_region',
            columns: [
              { name: 'region',      dataType: 'string' },
              { name: 'region_name', dataType: 'string' },
              { name: 'currency',    dataType: 'string' },
              { name: 'sla_p95_ms',  dataType: 'int64'  },
            ],
          },
        ],
        measures: [
          {
            table: 'orders',
            name: 'Total Revenue',
            expression: 'SUM(orders[amount])',
            formatString: '\\$#,0.00',
          },
          {
            table: 'orders',
            name: 'Total Orders',
            expression: 'COUNTROWS(orders)',
            formatString: '#,0',
          },
          {
            table: 'orders',
            name: 'Avg Order Value',
            expression: 'DIVIDE([Total Revenue], [Total Orders])',
            formatString: '\\$#,0.00',
          },
          {
            table: 'orders',
            name: 'Error Rate %',
            expression:
              'DIVIDE(CALCULATE([Total Orders], orders[status] = "failed"), [Total Orders])',
            formatString: '0.00%',
          },
        ],
        relationships: [
          { from: 'orders.region', to: 'dim_region.region', cardinality: 'many:many' },
        ],
      },
    },

    // ─── Report: PBIR bound byConnection to the semantic model ────────────
    {
      itemType: 'report',
      displayName: 'Real-Time Orders Report',
      description:
        'Executive Power BI report bound byConnection to the Real-Time Orders ' +
        'semantic model: a KPI page (revenue, orders, AOV, error rate) and a ' +
        'regional breakdown page (revenue by region + error rate by channel).',
      learnDoc: 'real-time-dashboards/report',
      content: {
        kind: 'report',
        pages: [
          {
            name: 'Overview',
            visuals: [
              { type: 'card',        title: 'Total Revenue',    field: 'Total Revenue' },
              { type: 'card',        title: 'Total Orders',     field: 'Total Orders' },
              { type: 'card',        title: 'Avg Order Value',  field: 'Avg Order Value' },
              { type: 'card',        title: 'Error Rate %',     field: 'Error Rate %' },
              {
                type: 'lineChart',
                title: 'Revenue Trend',
                config: { axis: 'orders.event_time', values: ['Total Revenue'] },
              },
            ],
          },
          {
            name: 'By Region',
            visuals: [
              {
                type: 'clusteredBarChart',
                title: 'Revenue by Region',
                config: { axis: 'dim_region.region_name', values: ['Total Revenue'] },
              },
              {
                type: 'columnChart',
                title: 'Error Rate by Channel',
                config: { axis: 'orders.channel', values: ['Error Rate %'] },
              },
              {
                type: 'table',
                title: 'Region Detail',
                config: {
                  columns: [
                    'dim_region.region_name',
                    'Total Orders',
                    'Total Revenue',
                    'Avg Order Value',
                    'Error Rate %',
                  ],
                },
              },
            ],
          },
        ],
      },
    },
  ],
};

export default bundle;
