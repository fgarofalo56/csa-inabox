---
title: Use Cases
description: Real-world use cases and industry scenarios for CSA-in-a-Box on Azure
---

## Use Cases Overview

CSA-in-a-Box provides reusable patterns for building enterprise analytics platforms on Azure. This section showcases concrete use cases across industries, demonstrating how the framework's domain-driven architecture, medallion lakehouse patterns, and data product contracts translate into production-ready analytics solutions.

Each use case includes reference architectures, data source catalogs, implementation walkthroughs, and links to published resources.

---

### Government & Public Sector

Government agencies face unique challenges: strict compliance requirements (FedRAMP, IL4/IL5), complex data governance mandates, and the need to derive actionable insights from vast public datasets.

| Use Case | Description |
|---|---|
| [Antitrust Analytics on Azure](antitrust-analytics.md) | End-to-end analytics for DOJ Antitrust Division data — merger reviews, enforcement trends, and penalty analysis |
| [DOJ Antitrust: Step-by-Step Domain Build](doj-antitrust-deep-dive.md) | Detailed walkthrough of building the DOJ antitrust domain from data discovery through gold-layer analytics |
| [Government Data Analytics on Azure](government-data-analytics.md) | Azure Government Cloud capabilities, compliance frameworks, and reference architectures for public sector analytics |
| [DOT Multi-Modal Transportation Analytics](dot-transportation-analytics.md) | Highway safety, bridge infrastructure, transit ridership, and FAA aviation operations across NHTSA, FHWA, FTA, and FAA |
| [FAA Aviation Safety & Operations Analytics](faa-aviation-analytics.md) | Dedicated FAA analytics — ATADS airport operations, delay patterns, wildlife strikes, NAS performance dashboards |
| [EPA Environmental Analytics](epa-environmental-analytics.md) | Real-time air quality monitoring, drinking water safety, toxic releases, and environmental justice overlays |
| [NOAA Climate & Ocean Analytics](noaa-climate-analytics.md) | Climate monitoring (100K+ stations), severe weather tracking, marine ecosystem health, and satellite imagery processing |
| [NASA Earth Science & Space Data Analytics](nasa-earth-science-analytics.md) | Earth observation, FIRMS wildfire detection, NEO planetary defense, solar/meteorological data from NASA APIs |
| [Department of Interior Natural Resources](interior-natural-resources-analytics.md) | Real-time earthquake monitoring, water resources, National Park capacity, wildfire risk, and wildlife conservation across USGS, NPS, BLM, FWS |
| [USDA Agricultural Analytics](usda-agriculture-analytics.md) | Crop yield forecasting, SNAP enrollment analysis, food safety risk scoring from NASS, FNS, FSIS, and FoodData Central |
| [USPS Postal Operations Analytics](usps-postal-analytics.md) | Last-mile delivery optimization (230K+ routes), volume forecasting, and facility utilization (34K+ post offices) |
| [Department of Commerce Economic Analytics](commerce-economic-analytics.md) | Regional economic resilience, trade pattern analysis, and census demographics from Census Bureau, BEA, NIST, ITA |

!!! tip "Start Here"
    If you're new to CSA-in-a-Box, the [DOJ Antitrust Deep Dive](doj-antitrust-deep-dive.md) is the best end-to-end example of how a domain gets built from scratch.

---

### Legal & Regulatory Analytics

Legal analytics transforms unstructured court filings, enforcement actions, and regulatory data into structured, queryable datasets that support case strategy, compliance monitoring, and policy analysis.

| Use Case | Description |
|---|---|
| [Antitrust Analytics on Azure](antitrust-analytics.md) | Covers Sherman Act, Clayton Act, and FTC Act enforcement data pipelines |
| [AI Document Analytics & eDiscovery](ai-document-analytics-ediscovery.md) | AI-enhanced document review, Purview eDiscovery integration, and governed analytics for litigation workflows |
| [Azure Analytics Resources](azure-analytics-resources.md) | Includes eDiscovery and legal analytics white papers and architecture guidance |

---

### Financial Services & Fraud Detection

Financial institutions require real-time risk analytics, regulatory reporting (Basel III, Dodd-Frank), and fraud detection pipelines — all under strict audit and compliance controls.

| Use Case | Description |
|---|---|
| [Real-Time Intelligence: Anomaly Detection](realtime-intelligence-anomaly-detection.md) | Streaming anomaly detection with Fabric RTI — Eventstreams, Eventhouse (KQL), Activator alerts, and historical enrichment via OneLake |
| [Casino & Gaming Operations Analytics](casino-gaming-analytics.md) | Real-time slot telemetry, player 360 analytics, floor optimization, and Title 31 AML compliance for tribal gaming |

---

### Healthcare Analytics

Healthcare analytics on Azure leverages HIPAA-compliant infrastructure for clinical data pipelines, population health analytics, and claims processing.

| Use Case | Description |
|---|---|
| [IHS & Tribal Health Analytics](tribal-health-analytics.md) | Azure Government deployment with HIPAA compliance, tribal data sovereignty, HL7 FHIR alignment, and GPRA clinical measures (all synthetic data) |

---

### Cybersecurity & Threat Detection

Security operations centers require real-time threat detection, MITRE ATT&CK correlation, and continuous compliance monitoring.

| Use Case | Description |
|---|---|
| [Federal Cybersecurity & Threat Analytics](cybersecurity-threat-analytics.md) | Sentinel-based SOC analytics, Isolation Forest anomaly detection, MITRE ATT&CK mapping, CMMC/NIST 800-53 compliance, and Zero Trust patterns |

---

### Microsoft Fabric

Microsoft Fabric represents the next generation of Microsoft's unified analytics platform. CSA-in-a-Box tracks Fabric as a strategic target (see [ADR-0010](../adr/0010-fabric-strategic-target.md)).

| Use Case | Description |
|---|---|
| [Unified Analytics on Microsoft Fabric](fabric-unified-analytics.md) | Migrating CSA-in-a-Box domains to Fabric — OneLake, Lakehouse, dbt on Fabric Data Warehouse, and Purview governance |
| [Real-Time Intelligence: Anomaly Detection](realtime-intelligence-anomaly-detection.md) | Streaming analytics with Fabric RTI — Eventstreams, Eventhouse (KQL), Activator |
| [AI Document Analytics & eDiscovery](ai-document-analytics-ediscovery.md) | Purview eDiscovery, Spark NLP, and Azure AI Search on Fabric |

---

### Multi-Cloud & Data Virtualization

Enterprises with data distributed across AWS, GCP, on-premises, and SaaS platforms need to query and govern data in place — without copying it everywhere.

| Use Case | Description |
|---|---|
| [Multi-Cloud Data Virtualization with Azure](multi-cloud-data-virtualization.md) | Complete architecture for cross-cloud analytics with OneLake shortcuts, Synapse serverless, Azure Arc, and Purview — best practices, lessons learned, and cost optimization |

---

### Reference Resources

| Resource | Description |
|---|---|
| [Azure Analytics: White Papers & Resources](azure-analytics-resources.md) | Curated collection of Microsoft architecture references, white papers, and decision guides |
| [Government Data Analytics on Azure](government-data-analytics.md) | Azure Government Cloud capabilities and compliance frameworks |
