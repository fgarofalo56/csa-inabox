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
| [Antitrust Analytics on Azure](antitrust-analytics.md) | End-to-end analytics for DOJ Antitrust Division data — merger reviews, enforcement trends, and penalty analysis using CSA-in-a-Box patterns |
| [DOJ Antitrust: Step-by-Step Domain Build](doj-antitrust-deep-dive.md) | Detailed walkthrough of building the DOJ antitrust domain from data discovery through gold-layer analytics |
| [Government Data Analytics on Azure](government-data-analytics.md) | Azure Government Cloud capabilities, compliance frameworks, and reference architectures for public sector analytics |
| [Unified Analytics on Microsoft Fabric](fabric-unified-analytics.md) | Migrating CSA-in-a-Box domains to Microsoft Fabric — OneLake, Lakehouse, dbt on Fabric Data Warehouse, and Purview governance |

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

### Financial Services

Financial institutions require real-time risk analytics, regulatory reporting (Basel III, Dodd-Frank), and fraud detection pipelines — all under strict audit and compliance controls.

| Use Case | Description |
|---|---|
| [Real-Time Intelligence: Anomaly Detection](realtime-intelligence-anomaly-detection.md) | Streaming anomaly detection with Fabric RTI — Eventstreams, Eventhouse (KQL), Activator alerts, and historical enrichment via OneLake |

!!! note "More Coming Soon"
    Additional financial services use cases are in development. The patterns demonstrated in the antitrust analytics domain — medallion architecture, data quality gates, and data product contracts — apply directly to financial regulatory reporting.

---

### Healthcare Analytics

Healthcare analytics on Azure leverages HIPAA-compliant infrastructure for clinical data pipelines, population health analytics, and claims processing.

!!! note "Coming Soon"
    Healthcare use cases are planned. See the [HIPAA Security Rule compliance mapping](../compliance/hipaa-security-rule.md) for the compliance foundation these use cases will build upon.

---

### Retail & Supply Chain

Supply chain analytics combines IoT telemetry, ERP data, and demand forecasting models in a unified lakehouse architecture.

!!! note "Coming Soon"
    Retail and supply chain use cases are planned. The multi-tenant and multi-region patterns in CSA-in-a-Box provide the foundation for global supply chain visibility platforms.

---

### Reference Resources

| Resource | Description |
|---|---|
| [Azure Analytics: White Papers & Resources](azure-analytics-resources.md) | Curated collection of Microsoft architecture references, white papers, and decision guides |
| [Government Data Analytics on Azure](government-data-analytics.md) | Azure Government Cloud capabilities and compliance frameworks |
