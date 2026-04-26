# End-to-End Examples

> **Industry vertical implementations of CSA-in-a-Box.** Each example is a self-contained, working deployment for a specific federal agency, tribal organization, or commercial sector — with real or synthetic data, dbt medallion models, data product contracts, deployment scripts, and analytics notebooks.

## What's here

| Example | Domain | Highlights |
|---------|--------|------------|
| [AI Agents](ai-agents.md) | AI / LLMs | Multi-agent orchestration patterns with Semantic Kernel + Foundry |
| [Casino Analytics (Tribal)](casino-analytics.md) | Gaming / Tribal | Player lifetime value, fraud detection, regulatory reporting |
| [Commerce Economic Analytics](commerce.md) | Federal (DoC) | BEA/Census macroeconomic indicators, trade-flow analysis |
| [Cybersecurity](cybersecurity.md) | SecOps | MITRE ATT&CK alert enrichment, Sentinel + KQL hunting |
| [Data API Builder](data-api-builder.md) | Mesh enablement | REST/GraphQL over Lakehouse for federated consumption |
| [DOT Transportation](dot.md) | Federal (DoT) | FAA/FRA/FMCSA safety + capacity analytics |
| [EPA Environmental](epa.md) | Federal (EPA) | Real-time AQI streaming, water-safety, EJ scoring |
| [GeoAnalytics](geoanalytics.md) | Geospatial | PostGIS + ArcGIS Enterprise BYOL patterns |
| [Interior Natural Resources](interior.md) | Federal (DOI) | USGS, BLM, FWS land + water + wildlife datasets |
| [IoT Streaming](iot-streaming.md) | Streaming | Event Hubs → ASA → Fabric RTI / Eventhouse |
| [ML Lifecycle (Loan Default)](ml-lifecycle.md) | MLOps | End-to-end MLflow + responsible AI scorecard |
| [NOAA Climate & Ocean](noaa.md) | Federal (NOAA) | Climate models, ocean buoy ingestion, severe-weather alerts |
| [Streaming](streaming.md) | Streaming | Lambda + Kappa reference implementations |
| [Tribal Health](tribal-health.md) | Healthcare / Tribal | IHS-aligned warehouse, FHIR ingestion, equity dashboards |
| [USDA Agriculture](usda.md) | Federal (USDA) | NASS production stats, crop forecasting, drought overlays |
| [USPS Postal Operations](usps.md) | Federal (USPS) | Mail volume, facility ops, delivery analytics |

!!! info "How these pages work"
    Each example page below is **rendered live from `examples/<vertical>/README.md`** in the source repo. If you spot something out of date, edit the README directly — the docs site picks it up on the next publish.
