# Manufacturing IoT on CSA Loom

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


Defense industrial base (CMMC L2/L3-aligned) IoT analytics. Sensor
data from manufacturing equipment → real-time monitoring +
predictive maintenance + supply-chain visibility.

## What you'll build

Same architecture as [IoT Streaming](iot-streaming.md), with
CMMC-aligned controls:

```
Source: Manufacturing sensors (IoT Hub + edge gateways)
    ↓ Loom Real-Time Hub
Eventstream (ASA): filter, project, anomaly detection
    ↓ Eventhouse / KQL DB
Real-Time Dashboard (production-floor monitoring)
    ↓ Loom Activator Engine
Maintenance alerts: equipment-degradation patterns → maintenance team
    ↓ Loom Direct-Lake-Shim
Power BI Premium semantic model (OEE, downtime trend, OEE)
    ↓ Loom Data Agent
NL Q&A: "What's the OEE for line 5 this week?"
        "Show me top 10 root causes for downtime this month"
```

## CMMC L2/L3 alignment

Per [CMMC 2.0 L2 extension](../compliance/cmmc-2.0-l2-fiab.md):

- Deployed in GCC-High (ITAR-eligible boundary)
- Customer-managed deploy (no publisher persistent access)
- Per-workspace Entra groups limited to US-person workforce
- Sensitivity labels: `ITAR-Restricted` for CUI manufacturing data
- Sentinel rules for cross-workspace exfiltration patterns
- 1-year audit log retention (federal contractor baseline)

## Components

| Loom capability | Used for |
|---|---|
| Real-Time Hub | Manufacturing sensor source registration |
| Eventstream (ASA) | Per-equipment anomaly detection |
| ADX | KQL store for time-series analytics |
| Activator Engine | Maintenance alert dispatch |
| Power BI Premium | OEE + downtime dashboards |
| Loom Data Agent | NL Q&A for plant managers |

## Per-boundary notes

| Boundary | Notes |
|---|---|
| Commercial | Not recommended for ITAR workloads |
| GCC | Not ITAR-eligible |
| **GCC-High / IL4** | **Recommended for ITAR + CMMC L2/L3** |
| IL5 (v1.1) | Classified DIB workloads |

## CMMC-aligned controls implementation

| CMMC Practice | Loom contribution |
|---|---|
| AC.L2-3.1.1 Limit access | Entra groups + per-workspace UAMI |
| AU.L2-3.3.1 Create audit logs | LAW + Sentinel ingest |
| CM.L2-3.4.1 Baseline configuration | Bicep + Git |
| IA.L2-3.5.3 MFA | Entra Conditional Access |
| IR.L2-3.6.1 Incident response | Sentinel + Loom runbooks |
| MA.L2-3.7.2 Remote maintenance | MCP-as-update-channel (PIM-elevated, audit-logged) |
| MP.L2-3.8.1 Protect CUI media | ADLS encryption + sensitivity labels |
| SC.L2-3.13.1 Boundary protection | Hub-spoke + Private Endpoints |
| SI.L2-3.14.1 Identify flaws | Defender for Cloud (per-workload) |

## Cost (F32 GCC-H baseline for mid-size manufacturer)

~$8,500/mo:
- Power BI Premium F32: $4,200
- IoT Hub (1M msgs/day): $250
- Stream Analytics (5 SUs): $400
- ADX cluster (D14_v2): $600
- Databricks Premium (predictive ML): $1,500
- ADLS Gen2: $300
- AOAI (Data Agent): $250
- Sentinel (5 GB/day): $700
- Misc: $300

## Source code

[`examples/fiab-manufacturing-iot/`](https://github.com/fgarofalo56/csa-inabox/tree/csa-loom-pillar/examples/fiab-manufacturing-iot)

## Forward migration

Same as IoT Streaming.

## Related

- [IoT Streaming example](iot-streaming.md) — base architecture
- [CMMC 2.0 L2 compliance extension](../compliance/cmmc-2.0-l2-fiab.md)
- [ITAR compliance extension](../compliance/itar-fiab.md)
- Existing source: [`examples/manufacturing-iot/`](../../examples/manufacturing-iot.md)
