/**
 * IoT Real-Time Insights — app-install content bundle.
 *
 * Content sourced from examples/iot-streaming/: README.md, contracts/iot-telemetry.yaml,
 * kql/tables.kql, stream-analytics/transform_telemetry.asaql,
 * stream-analytics/detect_anomalies.asaql, producers/iot_simulator.py, and
 * the dbt models brz_iot_telemetry / slv_device_telemetry_cleaned /
 * slv_anomaly_flags / gld_device_health_daily / gld_anomaly_heatmap.
 *
 * Provisions an Eventstream (IoT Hub -> KQL DB), the iot-telemetry KQL
 * database with Telemetry / Devices / Anomalies tables, two KQL functions
 * (parse_telemetry, anomaly_score), starter analyst KQL queries, and a
 * Device Health dashboard with 6 tiles (cards, line, bar, pie, table).
 */

import type { AppBundle } from './types';

// ─── Eventstream content ────────────────────────────────────────────────
// Source = Azure IoT Hub (with built-in support for sample-data generator).
// Transform filters to device.health.* (heartbeat + telemetry + status).
// Destination = KQL DB `iot-telemetry`, table `Telemetry` (long-format
// schema matching examples/iot-streaming/contracts/iot-telemetry.yaml).

const EVENTSTREAM_SOURCE_IOTHUB = {
  id: 'src-iot-hub',
  type: 'iot-hub',
  config: {
    iotHubName: 'iot-loom-${tenantSlug}',
    consumerGroup: 'loom-eventstream',
    sharedAccessKeyName: 'iothubowner',
    sharedAccessKeySecretRef: 'IOT_HUB_CONNECTION_STRING',
    endpoint: 'events',
    inputFormat: 'json',
    partitionCount: 4,
    sampleDataFallback: {
      enabled: true,
      generator: 'iot_simulator',
      sensorCount: 25,
      sensorTypes: ['temperature', 'humidity', 'pressure', 'battery'],
      eventsPerSecondPerSensor: 0.2,
      description:
        'When no IoT Hub is provisioned, Loom falls back to the synthetic ' +
        'iot_simulator generator from examples/iot-streaming/producers/. ' +
        'Generates a realistic diurnal pattern with occasional spike anomalies.',
    },
  },
};

const EVENTSTREAM_DEST_KQL = {
  id: 'dst-kql-iot-telemetry',
  type: 'kql-database',
  config: {
    database: 'iot-telemetry',
    table: 'Telemetry',
    ingestionMappingName: 'TelemetryJsonMapping',
    streamingIngestion: true,
    description:
      'Real-time streaming ingestion into ADX. Sub-second query latency ' +
      'for dashboards and alert rules.',
  },
};

const EVENTSTREAM_DEST_BRONZE = {
  id: 'dst-adls-bronze',
  type: 'lakehouse',
  config: {
    workspace: 'iot-realtime',
    lakehouse: 'iot_bronze',
    folder: 'bronze/telemetry',
    format: 'parquet',
    captureIntervalSeconds: 300,
    captureSizeLimitBytes: 314572800,
    description:
      'Cold-path capture mirrors Event Hub Capture: 5-min / 300MB ' +
      'Parquet snapshots into ADLS Gen2 for batch dbt processing.',
  },
};

const EVENTSTREAM_TRANSFORM_FILTER = {
  id: 'tx-filter-health',
  type: 'filter',
  config: {
    description:
      'Filter to device.health.* messages only: heartbeats, telemetry ' +
      'samples, and status events. Drops debug / firmware-update / ' +
      'config-ack message classes.',
    where:
      "messageType startsWith 'device.health.' " +
      "and isnotempty(device_id) " +
      "and isnotempty(metric_type)",
  },
};

const EVENTSTREAM_TRANSFORM_ENRICH = {
  id: 'tx-enrich-quality',
  type: 'projection',
  config: {
    description:
      'Adds a quality_flag derived from range checks (temp -60..60 C, ' +
      'humidity 0..100 %, pressure 870..1084 hPa, battery 0..100 %). ' +
      'Mirrors stream-analytics/transform_telemetry.asaql.',
    select: [
      { column: 'device_id',     expression: 'device_id' },
      { column: 'event_time',    expression: 'CAST(timestamp AS datetime)' },
      { column: 'metric_type',   expression: 'metric_type' },
      { column: 'value',         expression: 'CAST(metric_value AS double)' },
      { column: 'site_id',       expression: 'site_id' },
      { column: 'firmware_version', expression: 'firmware_version' },
      {
        column: 'quality_flag',
        expression:
          "CASE " +
          "WHEN metric_value IS NULL THEN 'missing' " +
          "WHEN metric_type = 'temperature_c' AND (metric_value < -60 OR metric_value > 60) THEN 'out_of_range' " +
          "WHEN metric_type = 'humidity_pct'  AND (metric_value <   0 OR metric_value > 100) THEN 'out_of_range' " +
          "WHEN metric_type = 'pressure_hpa'  AND (metric_value < 870 OR metric_value > 1084) THEN 'out_of_range' " +
          "WHEN metric_type = 'battery_pct'   AND (metric_value <   0 OR metric_value > 100) THEN 'out_of_range' " +
          "ELSE 'good' END",
      },
    ],
  },
};

// ─── KQL Database tables ────────────────────────────────────────────────

const KQL_FN_PARSE = `// Parses a raw Event Hub JSON payload into a normalized long-form row.
// Returns one row per metric_type per device per event_time.
//
// Usage:
//   RawTelemetry
//   | invoke parse_telemetry()
//   | summarize avg(value) by device_id, metric_type, bin(event_time, 1m)
.create-or-alter function parse_telemetry()
{
    RawTelemetry
    | extend parsed = parse_json(payload)
    | extend
        device_id     = tostring(parsed.device_id),
        event_time    = todatetime(parsed.timestamp),
        site_id       = tostring(parsed.site_id),
        firmware      = tostring(parsed.firmware_version),
        temperature_c = todouble(parsed.temperature_c),
        humidity_pct  = todouble(parsed.humidity_pct),
        pressure_hpa  = todouble(parsed.pressure_hpa),
        battery_pct   = todouble(parsed.battery_pct)
    | mv-expand metric = pack_array(
        bag_pack('metric_type', 'temperature_c', 'value', temperature_c),
        bag_pack('metric_type', 'humidity_pct',  'value', humidity_pct),
        bag_pack('metric_type', 'pressure_hpa',  'value', pressure_hpa),
        bag_pack('metric_type', 'battery_pct',   'value', battery_pct)
      )
    | extend
        metric_type = tostring(metric.metric_type),
        value       = todouble(metric.value)
    | where isnotnull(value)
    | project device_id, event_time, metric_type, value,
              site_id, firmware
}`;

const KQL_FN_ANOMALY = `// Computes a per-reading anomaly score using a rolling z-score over the
// trailing 120 readings per (device, metric). Mirrors the logic in the
// dbt model slv_anomaly_flags and the Stream Analytics job
// detect_anomalies.asaql.
//
// Severity:
//   critical  = temperature outside [-20, 45] C OR |z| > 4
//   warning   = temperature outside [-15, 40] C OR |z| > 3
//   info      = |z| > 2
//   none      = otherwise
.create-or-alter function anomaly_score(StartTime: datetime = datetime(null),
                                        EndTime:   datetime = datetime(null))
{
    let _start = iff(isnull(StartTime), ago(24h), StartTime);
    let _end   = iff(isnull(EndTime),   now(),    EndTime);
    // Per-(device, metric) baseline mean/std over the evaluation window.
    let baseline =
        Telemetry
        | where event_time between (_start .. _end)
        | summarize rolling_mean = avg(value), rolling_std = stdev(value)
            by device_id, metric_type;
    Telemetry
    | where event_time between (_start .. _end)
    | join kind=inner baseline on device_id, metric_type
    | extend zscore = iff(rolling_std == 0 or isnull(rolling_std),
                          real(null),
                          (value - rolling_mean) / rolling_std)
    | extend severity = case(
        metric_type == 'temperature_c' and (value > 45 or value < -20), 'critical',
        metric_type == 'temperature_c' and (value > 40 or value < -15), 'warning',
        abs(zscore) > 4, 'critical',
        abs(zscore) > 3, 'warning',
        abs(zscore) > 2, 'info',
        'none')
    | extend is_anomaly = severity != 'none'
    | project device_id, metric_type, event_time, value,
              rolling_mean, rolling_std, zscore, severity, is_anomaly
}`;

// ─── Starter analyst KQL queries ────────────────────────────────────────

const KQL_Q_HEARTBEAT = `// Last-5-minute heartbeat: which devices have reported in the most
// recent 5-minute window? Sites with zero heartbeats are at risk.
Telemetry
| where event_time > ago(5m)
| summarize
    last_seen   = max(event_time),
    reading_count = count(),
    metrics_reported = dcount(metric_type)
    by device_id, site_id
| extend silence_sec = datetime_diff('second', now(), last_seen)
| order by silence_sec desc`;

const KQL_Q_NOISY = `// Top-10 noisy devices in the last hour, ranked by anomaly count.
// "Noisy" = generates anomaly flags out of proportion to its reading volume.
// Baseline mean/std are computed per (device, metric), then each reading's
// z-score is evaluated against its own device+metric baseline.
let baseline =
    Telemetry
    | where event_time > ago(1h)
    | summarize mean = avg(value), std = stdev(value)
        by device_id, metric_type;
Telemetry
| where event_time > ago(1h)
| join kind=inner baseline on device_id, metric_type
| extend zscore = iff(std == 0 or isnull(std), real(null), (value - mean) / std)
| summarize
    anomaly_count = countif(abs(zscore) > 3),
    reading_count = count(),
    metrics       = make_set(metric_type)
    by device_id
| where anomaly_count > 0
| top 10 by anomaly_count desc
| project device_id, anomaly_count, reading_count, metrics`;

const KQL_Q_SITE_ANOM = `// Anomalies in the last 24h broken out by site + severity.
// Powers the per-site bar visual on the dashboard.
Anomalies
| where event_time > ago(24h)
| join kind=leftouter Devices on device_id
| summarize anomalies = count()
    by site_id, severity
| order by site_id asc, severity asc`;

const KQL_Q_MTTR = `// Mean Time To Recovery (MTTR) per device over the last 7 days.
// "Recovery" = an anomaly event followed by 5+ minutes of normal readings.
Anomalies
| where event_time > ago(7d) and is_anomaly == true
| order by device_id asc, event_time asc
| serialize
| extend next_anomaly = next(event_time, 1, datetime(2099-01-01))
| extend gap_minutes  = datetime_diff('minute', next_anomaly, event_time)
| where gap_minutes >= 5
| summarize
    incidents     = count(),
    avg_mttr_min  = avg(gap_minutes),
    p90_mttr_min  = percentile(gap_minutes, 90),
    max_mttr_min  = max(gap_minutes)
    by device_id
| order by avg_mttr_min desc
| take 25`;

const KQL_Q_TOP_DRIFT = `// Devices whose rolling-mean has drifted > 3 sigma from the long-term
// device baseline in the last hour. Likely sensor degradation candidates.
let baseline =
    Telemetry
    | where event_time between (ago(30d) .. ago(1d))
    | summarize lt_mean = avg(value), lt_std = stdev(value)
        by device_id, metric_type;
Telemetry
| where event_time > ago(1h)
| summarize current_mean = avg(value) by device_id, metric_type
| join kind=inner baseline on device_id, metric_type
| extend drift_sigma = (current_mean - lt_mean) / lt_std
| where abs(drift_sigma) > 3
| order by abs(drift_sigma) desc
| project device_id, metric_type, current_mean, lt_mean, lt_std, drift_sigma`;

const KQL_Q_LOW_BATTERY = `// Devices reporting battery < 20% — schedule a field-tech visit.
Telemetry
| where metric_type == 'battery_pct'
  and event_time > ago(1h)
| summarize (event_time, latest_pct) = arg_max(event_time, value) by device_id
| where latest_pct < 20
| join kind=leftouter Devices on device_id
| project device_id, latest_pct, site_id, location_lat, location_lon, last_service_date
| order by latest_pct asc`;

// ─── KQL Dashboard tiles ────────────────────────────────────────────────

const TILE_DEVICE_COUNT = `// Total active devices (heard from in the last hour)
Telemetry
| where event_time > ago(1h)
| summarize value = dcount(device_id)
| extend display_name = 'Active Devices (1h)'`;

const TILE_ACTIVE_ANOMALIES = `// Open anomalies = anomaly events in the last 15 minutes that
// have not yet been followed by a clean reading.
Anomalies
| where event_time > ago(15m) and is_anomaly == true
| summarize value = count()
| extend display_name = 'Active Anomalies (15m)'`;

const TILE_HEARTBEAT_LINE = `// Heartbeat over time — distinct devices reporting per 1-minute bin
// over the last 4 hours.
Telemetry
| where event_time > ago(4h)
| summarize devices_reporting = dcount(device_id)
    by bin(event_time, 1m)
| order by event_time asc
| render timechart with (title='Device Heartbeats (last 4h)')`;

const TILE_NOISY_BAR = `// Top-10 noisy devices in the last hour by anomaly count.
Anomalies
| where event_time > ago(1h) and is_anomaly == true
| summarize anomalies = count() by device_id
| top 10 by anomalies desc
| order by anomalies asc
| render barchart with (title='Top 10 Noisy Devices (1h)',
                       xcolumn=device_id, ycolumns=anomalies)`;

const TILE_SEVERITY_PIE = `// Anomalies broken out by severity in the last 24 hours.
Anomalies
| where event_time > ago(24h) and is_anomaly == true
| summarize value = count() by severity
| render piechart with (title='Anomalies by Severity (24h)',
                       xcolumn=severity, ycolumns=value)`;

const TILE_SITE_HEALTH_TABLE = `// Per-site health roll-up: active devices, anomaly rate, last heartbeat.
let recent_anom =
    Anomalies
    | where event_time > ago(24h) and is_anomaly == true
    | summarize anomalies = count() by device_id;
Telemetry
| where event_time > ago(24h)
| summarize
    readings     = count(),
    last_seen    = max(event_time),
    active_devs  = dcount(device_id)
    by site_id
| join kind=leftouter (
    Devices
    | join kind=leftouter recent_anom on device_id
    | summarize site_anomalies = sum(anomalies) by site_id
  ) on site_id
| extend
    anomaly_rate_pct = round(100.0 * coalesce(site_anomalies, 0) / readings, 3),
    silence_sec      = datetime_diff('second', now(), last_seen),
    health_band      = case(
        coalesce(site_anomalies, 0) == 0 and silence_sec < 300, 'GREEN',
        coalesce(site_anomalies, 0) <= 5 and silence_sec < 900, 'YELLOW',
        'RED')
| project site_id, active_devs, readings, anomalies = coalesce(site_anomalies, 0),
          anomaly_rate_pct, last_seen, silence_sec, health_band
| order by health_band asc, anomaly_rate_pct desc`;

// ─── Bundle ─────────────────────────────────────────────────────────────

const bundle: AppBundle = {
  appId: 'app-iot-realtime',
  intro:
    'Real-time IoT analytics workspace: IoT Hub -> Eventstream -> KQL ' +
    'Database (Telemetry, Devices, Anomalies) -> 6-tile Device Health ' +
    'dashboard. Includes parse_telemetry / anomaly_score KQL functions ' +
    'and starter queries for heartbeat, noisy-device, MTTR, drift, and ' +
    'low-battery scenarios. Mirrors the streaming patterns in ' +
    'examples/iot-streaming.',
  sourceDocs: [
    'examples/iot-streaming/README.md',
    'examples/iot-streaming/contracts/iot-telemetry.yaml',
    'examples/iot-streaming/kql/tables.kql',
    'examples/iot-streaming/stream-analytics/transform_telemetry.asaql',
    'examples/iot-streaming/stream-analytics/detect_anomalies.asaql',
    'examples/iot-streaming/producers/iot_simulator.py',
    'examples/iot-streaming/domains/dbt/models/bronze/brz_iot_telemetry.sql',
    'examples/iot-streaming/domains/dbt/models/silver/slv_device_telemetry_cleaned.sql',
    'examples/iot-streaming/domains/dbt/models/silver/slv_anomaly_flags.sql',
    'examples/iot-streaming/domains/dbt/models/gold/gld_device_health_daily.sql',
    'examples/iot-streaming/domains/dbt/models/gold/gld_anomaly_heatmap.sql',
  ],
  items: [
    {
      itemType: 'eventstream',
      displayName: 'IoT Telemetry Eventstream',
      description:
        'Routes device heartbeats / telemetry / status events from Azure ' +
        'IoT Hub into the iot-telemetry KQL database and mirrors them to ' +
        'ADLS Gen2 bronze. Falls back to a synthetic iot_simulator source ' +
        'when no IoT Hub is provisioned.',
      learnDoc: 'iot-realtime/eventstream',
      content: {
        kind: 'eventstream',
        sources: [EVENTSTREAM_SOURCE_IOTHUB],
        transforms: [EVENTSTREAM_TRANSFORM_FILTER, EVENTSTREAM_TRANSFORM_ENRICH],
        destinations: [EVENTSTREAM_DEST_KQL, EVENTSTREAM_DEST_BRONZE],
      },
    },
    {
      itemType: 'kql-database',
      displayName: 'IoT Telemetry KQL Database',
      description:
        'ADX database with Telemetry (long-form metric readings), Devices ' +
        '(catalog), and Anomalies (scored events). Includes parse_telemetry ' +
        'and anomaly_score functions and 5 starter analyst queries.',
      learnDoc: 'iot-realtime/kql-database',
      content: {
        kind: 'kql-database',
        tables: [
          {
            name: 'Telemetry',
            columns: [
              { name: 'device_id',        type: 'string'   },
              { name: 'event_time',       type: 'datetime' },
              { name: 'metric_type',      type: 'string'   },
              { name: 'value',            type: 'real'     },
              { name: 'site_id',          type: 'string'   },
              { name: 'firmware_version', type: 'string'   },
              { name: 'quality_flag',     type: 'string'   },
              { name: 'ingested_at',      type: 'datetime' },
            ],
            sample: [
              ['dev-0001', '2026-05-26T14:00:00Z', 'temperature_c',  22.4, 'site-DC1', '1.4.2', 'good', '2026-05-26T14:00:01Z'],
              ['dev-0001', '2026-05-26T14:00:00Z', 'humidity_pct',   48.1, 'site-DC1', '1.4.2', 'good', '2026-05-26T14:00:01Z'],
              ['dev-0001', '2026-05-26T14:00:00Z', 'pressure_hpa', 1013.2, 'site-DC1', '1.4.2', 'good', '2026-05-26T14:00:01Z'],
              ['dev-0001', '2026-05-26T14:00:00Z', 'battery_pct',    87.0, 'site-DC1', '1.4.2', 'good', '2026-05-26T14:00:01Z'],
              ['dev-0042', '2026-05-26T14:00:05Z', 'temperature_c',  47.8, 'site-DC2', '1.4.2', 'out_of_range', '2026-05-26T14:00:06Z'],
            ],
          },
          {
            name: 'Devices',
            columns: [
              { name: 'device_id',        type: 'string'   },
              { name: 'device_type',      type: 'string'   },
              { name: 'vendor',           type: 'string'   },
              { name: 'site_id',          type: 'string'   },
              { name: 'location_lat',     type: 'real'     },
              { name: 'location_lon',     type: 'real'     },
              { name: 'install_date',     type: 'datetime' },
              { name: 'firmware_version', type: 'string'   },
              { name: 'last_service_date', type: 'datetime' },
              { name: 'is_active',        type: 'bool'     },
            ],
            sample: [
              ['dev-0001', 'env-sensor',    'Acme',     'site-DC1', 38.8951, -77.0364, '2025-01-15', '1.4.2', '2026-03-01', true],
              ['dev-0042', 'env-sensor',    'Acme',     'site-DC2', 40.7128, -74.0060, '2024-09-20', '1.4.2', '2025-11-12', true],
              ['dev-1001', 'pressure-loop', 'BetaCorp', 'site-FAC1', 34.0522, -118.2437, '2023-06-10', '2.1.0', '2026-02-18', true],
            ],
          },
          {
            name: 'Anomalies',
            columns: [
              { name: 'device_id',     type: 'string'   },
              { name: 'metric_type',   type: 'string'   },
              { name: 'event_time',    type: 'datetime' },
              { name: 'value',         type: 'real'     },
              { name: 'rolling_mean',  type: 'real'     },
              { name: 'rolling_std',   type: 'real'     },
              { name: 'zscore',        type: 'real'     },
              { name: 'severity',      type: 'string'   },
              { name: 'is_anomaly',    type: 'bool'     },
              { name: 'detected_at',   type: 'datetime' },
              { name: 'method',        type: 'string'   },
            ],
            sample: [
              ['dev-0042', 'temperature_c', '2026-05-26T14:00:05Z', 47.8, 22.1, 1.4, 18.4, 'critical', true,  '2026-05-26T14:00:06Z', 'threshold'],
              ['dev-0042', 'temperature_c', '2026-05-26T14:00:10Z', 46.9, 22.4, 1.5, 16.3, 'critical', true,  '2026-05-26T14:00:11Z', 'threshold'],
              ['dev-0017', 'humidity_pct',  '2026-05-26T13:42:00Z', 92.4, 48.2, 4.1, 10.8, 'warning',  true,  '2026-05-26T13:42:01Z', 'zscore'],
              ['dev-1001', 'pressure_hpa',  '2026-05-26T12:15:00Z', 988.0, 1013.1, 2.9, -8.7, 'warning',  true,  '2026-05-26T12:15:01Z', 'iqr'],
            ],
          },
        ],
        functions: [
          { name: 'parse_telemetry', body: KQL_FN_PARSE },
          { name: 'anomaly_score',   body: KQL_FN_ANOMALY },
        ],
        ingestionPolicies: [
          {
            table: 'Telemetry',
            policy:
              '.alter-merge table Telemetry policy retention softdelete = 90d\n' +
              '.alter-merge table Telemetry policy caching   hot        =  7d\n' +
              '.alter table Telemetry policy streamingingestion enable',
          },
          {
            table: 'Anomalies',
            policy:
              '.alter-merge table Anomalies policy retention softdelete = 365d\n' +
              '.alter-merge table Anomalies policy caching   hot        =  30d',
          },
        ],
        starterQueries: [
          { name: 'Heartbeat - last 5 minutes',                  kql: KQL_Q_HEARTBEAT },
          { name: 'Top 10 noisy devices (last 1 hour)',          kql: KQL_Q_NOISY },
          { name: 'Anomalies by site + severity (last 24h)',     kql: KQL_Q_SITE_ANOM },
          { name: 'MTTR per device (last 7 days)',               kql: KQL_Q_MTTR },
          { name: 'Top drift devices vs 30d baseline (1h)',      kql: KQL_Q_TOP_DRIFT },
          { name: 'Low-battery devices (< 20%)',                 kql: KQL_Q_LOW_BATTERY },
        ],
      },
    },
    {
      itemType: 'kql-dashboard',
      displayName: 'Device Health Dashboard',
      description:
        'Six-tile real-time dashboard: active-device count, open-anomaly ' +
        'count, heartbeat timeline, top-10 noisy devices, severity ' +
        'breakdown, and per-site health table. Auto-refreshes every 30s.',
      learnDoc: 'iot-realtime/device-health-dashboard',
      content: {
        kind: 'kql-dashboard',
        tiles: [
          { title: 'Active Devices (1h)',         viz: 'card',  kql: TILE_DEVICE_COUNT },
          { title: 'Active Anomalies (15m)',      viz: 'card',  kql: TILE_ACTIVE_ANOMALIES },
          { title: 'Device Heartbeats (last 4h)', viz: 'line',  kql: TILE_HEARTBEAT_LINE },
          { title: 'Top 10 Noisy Devices (1h)',   viz: 'bar',   kql: TILE_NOISY_BAR },
          { title: 'Anomalies by Severity (24h)', viz: 'pie',   kql: TILE_SEVERITY_PIE },
          { title: 'Site Health Roll-up (24h)',   viz: 'table', kql: TILE_SITE_HEALTH_TABLE },
        ],
      },
    },
  ],
};

export default bundle;
