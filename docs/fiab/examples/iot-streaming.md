# IoT Streaming on CSA Loom

End-to-end IoT telemetry → real-time analytics + activator rules +
predictive maintenance. Manufacturing, public sector infrastructure,
energy + utilities.

## What you'll build

```
Source: Edge devices / IoT sensors (Azure IoT Hub or MQTT broker)
    ↓ Loom Real-Time Hub (Eventstream / ASA)
Eventstream processing:
    - Filter, project, aggregate over windows
    - Detect anomalies
    ↓ Eventhouse / KQL Database (ADX)
Real-Time Dashboard (live monitoring)
    ↓ Loom Activator Engine
Threshold alerts: sensor sustained out-of-range → Teams + Databricks Job
    ↓ Loom Direct-Lake-Shim
Power BI semantic model (operational + predictive trends)
    ↓ Loom Data Agent
NL Q&A: "How many sensor anomalies today?" / "Show me predicted
maintenance for fleet X"
```

## Components

| Loom capability | Used for |
|---|---|
| Real-Time Hub | Streaming source registration |
| Eventstream (ASA) | Stream transforms |
| ADX | KQL storage + dashboards |
| Activator Engine | Threshold rules (`andStays` for sustained anomalies) |
| Databricks ML | Predictive maintenance scoring |
| Power BI Premium | Operational dashboards |
| Data Agent | NL Q&A for ops teams |

## Sample Activator rule (sustained high temperature)

```json
{
  "name": "Sensor temperature sustained high",
  "dataSource": {
    "type": "adx-kql",
    "query": "TemperatureReadings | where ts > ago(15m) | summarize avg(temp_c) by sensor_id, bin(ts, 1m)",
    "splitColumn": "sensor_id",
    "cadenceMinutes": 1
  },
  "rules": [{
    "expression": {
      "operator": "andStays",
      "left": {"operator": "isAbove", "attribute": "avg_temp_c", "threshold": 85},
      "durationMinutes": 5
    },
    "actions": [
      {"type": "teams-message", "channel": "#ops-alerts",
       "template": "Sensor {sensor_id} temp {avg_temp_c}°C sustained > 85°C for 5 min"},
      {"type": "databricks-job", "jobId": "create-maintenance-ticket",
       "parameters": {"sensor_id": "{sensor_id}"}}
    ]
  }]
}
```

## Per-boundary notes

| Boundary | Notes |
|---|---|
| Commercial | Stream Analytics + ADX both fully featured |
| GCC | Same |
| GCC-High / IL4 | Stream Analytics + ADX authorized; Container Apps → AKS for Activator host |
| IL5 (v1.1) | Same as IL4 + Atlas catalog |

## Cost (F8 baseline for small fleet)

~$3,500/mo:
- Power BI Premium F8: $1,050
- ADX cluster (D14_v2): $600
- IoT Hub (small tier, 400K msgs/day): $50
- Stream Analytics (3 SUs): $250
- Databricks Premium (light ML): $800
- ADLS Gen2: $200
- Activator Engine + Data Agent: $250
- Misc: $300

## Source code

[`examples/fiab-iot-streaming/`](https://github.com/fgarofalo56/csa-inabox/tree/csa-loom-pillar/examples/fiab-iot-streaming)

## Forward migration

ADX KQL queries + dashboards port 1:1 to Fabric Eventhouse + Real-
Time Dashboard. Activator rules JSON-port to Fabric Reflex. Power BI
re-author for Direct Lake on OneLake.

## Related

- [Real-Time Intelligence parity workload](../workloads/real-time-intelligence.md)
- [Data Activator parity workload](../workloads/data-activator-parity.md)
- [Tutorial 04 — Activator rules](../tutorials/04-activator-rules.md)
- Existing source: [`examples/iot-streaming/`](../../examples/iot-streaming.md), [`manufacturing-iot/`](manufacturing-iot.md)
