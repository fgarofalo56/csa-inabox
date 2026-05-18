---
title: End-to-End Examples
description: 18 industry-vertical implementations of CSA-in-a-Box — federal agencies, tribal organizations, healthcare, financial services, AI, IoT, and more.
---

# End-to-End Examples

**Industry vertical implementations of CSA-in-a-Box.** Each example is a self-contained, working deployment for a specific federal agency, tribal organization, or commercial sector — with real or synthetic data, dbt medallion models, data product contracts, deployment scripts, and analytics notebooks.

!!! info "How these pages work"
    Each example page is **rendered live from `examples/<vertical>/README.md`** in the source repo. If you spot something out of date, edit the README directly — the docs site picks it up on the next publish.

---

## Federal agencies

<div class="grid cards" markdown>

- :material-bank:{ .lg .middle } **Commerce — Economic Analytics**

    ***

    BEA / Census macroeconomic indicators, trade-flow analysis.

    [:octicons-arrow-right-24: Commerce](commerce.md)

- :material-train:{ .lg .middle } **DOT — Transportation**

    ***

    FAA / FRA / FMCSA safety + capacity analytics.

    [:octicons-arrow-right-24: DOT](dot.md)

- :material-leaf:{ .lg .middle } **EPA — Environmental**

    ***

    Real-time AQI streaming, water-safety, EJ scoring.

    [:octicons-arrow-right-24: EPA](epa.md)

- :material-pine-tree:{ .lg .middle } **Interior — Natural Resources**

    ***

    USGS, BLM, FWS land + water + wildlife datasets.

    [:octicons-arrow-right-24: Interior](interior.md)

- :material-weather-partly-cloudy:{ .lg .middle } **NOAA — Climate & Ocean**

    ***

    Climate models, ocean buoy ingestion, severe-weather alerts.

    [:octicons-arrow-right-24: NOAA](noaa.md)

- :material-tractor:{ .lg .middle } **USDA — Agriculture**

    ***

    NASS production stats, crop forecasting, drought overlays.

    [:octicons-arrow-right-24: USDA](usda.md)

- :material-mailbox:{ .lg .middle } **USPS — Postal Operations**

    ***

    Mail volume, facility ops, delivery analytics.

    [:octicons-arrow-right-24: USPS](usps.md)

- :material-rocket-launch:{ .lg .middle } **NASA — API-First Multi-Model**

    ***

    Federated mission-center pattern with APIM Premium v2 + multi-model AI + zero-move data on Azure Government. Synthetic facilities data plus public open-science references.

    [:octicons-arrow-right-24: NASA API-First](nasa-api-first.md)

</div>

---

## Healthcare & tribal

<div class="grid cards" markdown>

- :material-hospital-box:{ .lg .middle } **Tribal Health**

    ***

    IHS-aligned warehouse, FHIR ingestion, equity dashboards.

    [:octicons-arrow-right-24: Tribal Health](tribal-health.md)

- :material-cards-playing:{ .lg .middle } **Casino Analytics (Tribal)**

    ***

    Player lifetime value, fraud detection, regulatory reporting.

    [:octicons-arrow-right-24: Casino Analytics](casino-analytics.md)

</div>

---

## Financial services & security

<div class="grid cards" markdown>

- :material-finance:{ .lg .middle } **Financial Fraud Detection**

    ***

    Real-time transaction scoring, SAR generation, ML fraud pipeline (BSA-AML).

    [:octicons-arrow-right-24: Fraud Detection](financial-fraud-detection.md)

- :material-shield-bug:{ .lg .middle } **Cybersecurity**

    ***

    MITRE ATT&CK alert enrichment, Sentinel + KQL hunting.

    [:octicons-arrow-right-24: Cybersecurity](cybersecurity.md)

</div>

---

## AI, ML & streaming

<div class="grid cards" markdown>

- :material-robot:{ .lg .middle } **AI Agents**

    ***

    Multi-agent orchestration patterns with Semantic Kernel + Azure AI Foundry.

    [:octicons-arrow-right-24: AI Agents](ai-agents.md)

- :material-brain:{ .lg .middle } **ML Lifecycle (Loan Default)**

    ***

    End-to-end MLflow + responsible-AI scorecard.

    [:octicons-arrow-right-24: ML Lifecycle](ml-lifecycle.md)

- :material-broadcast:{ .lg .middle } **IoT Streaming**

    ***

    Event Hubs → ASA → Fabric RTI / Eventhouse.

    [:octicons-arrow-right-24: IoT Streaming](iot-streaming.md)

- :material-flash:{ .lg .middle } **Streaming (Lambda + Kappa)**

    ***

    Lambda + Kappa reference implementations.

    [:octicons-arrow-right-24: Streaming](streaming.md)

</div>

---

## Geospatial & API enablement

<div class="grid cards" markdown>

- :material-map:{ .lg .middle } **GeoAnalytics**

    ***

    PostGIS + ArcGIS Enterprise BYOL patterns.

    [:octicons-arrow-right-24: GeoAnalytics](geoanalytics.md)

- :material-api:{ .lg .middle } **Data API Builder**

    ***

    REST / GraphQL over Lakehouse for federated consumption.

    [:octicons-arrow-right-24: Data API Builder](data-api-builder.md)

</div>
