# IoT & Streaming Analytics Examples

Real-time data ingestion and analytics patterns for IoT sensors, telemetry,
and event streaming. These patterns are used across multiple verticals
(NOAA weather stations, EPA air quality sensors, casino slot machines).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Data Sources                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │   IoT    │ │ Weather  │ │ AQI      │ │ Casino Slot  │   │
│  │  Sensors │ │ Stations │ │ Monitors │ │ Machines     │   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘   │
└───────┼──────────────┼───────────┼───────────────┼──────────┘
        │              │           │               │
        └──────────────┴─────┬─────┴───────────────┘
                             │
                    ┌────────┴────────┐
                    │   Azure IoT Hub  │ (optional — for managed devices)
                    └────────┬────────┘
                             │
                    ┌────────┴────────┐
                    │  Event Hubs      │  (Kafka-compatible)
                    │  Namespace       │
                    │  ├── raw-events  │
                    │  ├── processed   │
                    │  └── alerts      │
                    └──┬──────┬───┬───┘
                       │      │   │
              ┌────────┘      │   └────────────┐
              │               │                 │
     ┌────────┴───────┐  ┌───┴──────────┐  ┌──┴──────────────┐
     │  Azure Data    │  │  Stream      │  │  ADLS Gen2      │
     │  Explorer      │  │  Analytics   │  │  Capture        │
     │  (Real-time)   │  │  (Transform) │  │  (Cold storage) │
     │                │  │              │  │                  │
     │  KQL Queries   │  │  Windowed    │  │  Bronze layer    │
     │  Real-time     │  │  Aggregation │  │  (Parquet/Delta) │
     │  Dashboards    │  │  Alerts      │  │                  │
     └────────────────┘  └──────────────┘  └──────────────────┘
```

## Streaming Patterns

### Pattern 1: Hot Path (Real-Time)

Event Hub → Azure Data Explorer for sub-second query latency:

```kql
// Real-time slot machine events (last 5 minutes)
SlotEvents
| where timestamp > ago(5m)
| summarize
    total_spins = count(),
    total_coin_in = sum(coin_in),
    total_coin_out = sum(coin_out),
    hold_pct = round((sum(coin_in) - sum(coin_out)) / sum(coin_in) * 100, 2)
  by bin(timestamp, 1m), floor_zone
| render timechart
```

### Pattern 2: Warm Path (Near Real-Time)

Event Hub → Stream Analytics → Power BI for aggregated dashboards:

```sql
-- Stream Analytics query: 5-minute windowed aggregation
SELECT
    System.Timestamp() AS window_end,
    sensor_id,
    AVG(temperature) AS avg_temp,
    MAX(temperature) AS max_temp,
    MIN(temperature) AS min_temp,
    COUNT(*) AS reading_count
INTO [PowerBIOutput]
FROM [EventHubInput]
TIMESTAMP BY event_time
GROUP BY
    sensor_id,
    TumblingWindow(minute, 5)
```

### Pattern 3: Cold Path (Batch)

Event Hub Capture → ADLS Gen2 → dbt/Databricks for historical analytics:

```yaml
# Event Hub Capture configuration
capture:
  enabled: true
  encoding: Avro
  intervalInSeconds: 300
  sizeLimitInBytes: 314572800
  destination:
    name: EventHubArchive.AzureBlockBlob
    storageAccountResourceId: /subscriptions/.../storageAccounts/csastor
    blobContainer: bronze
    archiveNameFormat: "{Namespace}/{EventHub}/{PartitionId}/{Year}/{Month}/{Day}/{Hour}/{Minute}/{Second}"
```

### Pattern 4: Anomaly Detection

Stream Analytics anomaly detection on streaming data:

```sql
-- Detect anomalies in AQI readings
SELECT
    sensor_id,
    event_time,
    aqi_value,
    AnomalyDetection_SpikeAndDip(aqi_value, 95, 120, 'spikesanddips')
      OVER (PARTITION BY sensor_id LIMIT DURATION(minute, 120)) AS anomaly_score
INTO [AlertOutput]
FROM [AQIInput]
WHERE anomaly_score > 0.8
```

## Directory Structure

```
examples/iot-streaming/
├── README.md                        # This file
├── producers/
│   ├── iot_simulator.py             # Generic IoT sensor simulator
│   ├── weather_station_producer.py  # NOAA weather station producer
│   ├── aqi_sensor_producer.py       # EPA AQI sensor producer
│   └── slot_machine_producer.py     # Casino slot event producer
├── consumers/
│   ├── adx_consumer.py              # ADX ingestion consumer
│   └── adls_consumer.py             # ADLS capture consumer
├── stream-analytics/
│   ├── weather_aggregation.asaql    # Weather windowed aggregation
│   ├── aqi_anomaly_detection.asaql  # AQI anomaly detection
│   └── slot_realtime_metrics.asaql  # Casino real-time metrics
├── kql/
│   ├── tables.kql                   # ADX table definitions
│   ├── ingestion_mappings.kql       # JSON/Avro ingestion mappings
│   ├── weather_queries.kql          # Weather analytics queries
│   ├── aqi_queries.kql              # Air quality queries
│   └── casino_queries.kql          # Casino floor queries
├── deploy/
│   ├── streaming.bicep              # IaC for streaming infrastructure
│   └── params.json                  # Deployment parameters
└── dashboards/
    ├── realtime_weather.json        # ADX dashboard for weather
    ├── aqi_monitoring.json          # AQI real-time monitoring
    └── casino_floor.json            # Casino floor dashboard
```

## Quick Start

```bash
# Deploy streaming infrastructure
az deployment group create \
  --template-file deploy/streaming.bicep \
  --parameters deploy/params.json

# Start a sensor simulator
python producers/iot_simulator.py \
  --connection-string "$EVENTHUB_CONNECTION_STRING" \
  --sensor-count 10 \
  --interval-seconds 5

# Create ADX tables and mappings
kusto query -database realtime -script kql/tables.kql
kusto query -database realtime -script kql/ingestion_mappings.kql

# Open ADX dashboard
az kusto dashboard show --cluster-name csa-adx --database realtime
```

## Azure Government

All streaming services are available in Azure Government:
- Event Hubs: GA
- Azure Data Explorer: GA
- Stream Analytics: GA
- IoT Hub: GA
- ADLS Gen2 (Capture): GA
