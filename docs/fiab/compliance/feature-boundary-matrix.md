# Feature × Boundary Matrix

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


The canonical per-CSA-Loom-feature × per-Azure-boundary availability
table. Drives the per-boundary `.bicepparam` files + customer audit
documentation.

Legend: ✅ available · ⚠ available with workaround · ❌ not available

## Core platform

| Feature | Commercial | GCC | GCC-H / IL4 | IL5 (v1.1) |
|---|---|---|---|---|
| Loom Console (Next.js + Fluent UI v9) | ✅ | ✅ | ✅ AKS | ✅ AKS |
| Loom Setup Wizard | ✅ Foundry Agent Service | ✅ Foundry Agent Service | ✅ MAF + AOAI direct | ✅ MAF + AOAI direct |
| Loom Copilot runtime | ✅ | ✅ | ✅ | ✅ |
| Self-hosted Azure MCP server | ✅ | ✅ | ✅ | ✅ |
| Single-sub deployment mode | ✅ | ✅ | ✅ | ✅ |
| Multi-sub deployment mode | ✅ | ✅ | ✅ | ✅ |
| `azd up` deploy | ✅ | ✅ | ✅ | ✅ |
| Deploy-to-Azure button | ✅ | ✅ | ✅ | ✅ |
| Marketplace Managed App listing | ❌ deferred | ❌ deferred | ❌ deferred | ❌ deferred (LD-4) |

## Compute + Storage

| Feature | Commercial | GCC | GCC-H / IL4 | IL5 (v1.1) |
|---|---|---|---|---|
| Azure Databricks Premium workspace | ✅ | ✅ | ✅ classic only | ✅ classic only |
| Databricks Unity Catalog managed | ✅ | ✅ | ❌ (Hive metastore) | ❌ (Hive metastore) |
| Databricks SQL Warehouse | ✅ | ✅ | ❌ (Synapse Serverless instead) | ❌ |
| Databricks Photon (SQL Warehouse) | ✅ | ✅ | ❌ | ❌ |
| Databricks Photon (classic cluster) | ✅ | ✅ | ⚠ verify per-cluster | ⚠ verify |
| Databricks Model Serving | ✅ | ✅ | ❌ (Azure ML or AKS-MLflow) | ❌ |
| Databricks Vector Search | ✅ | ✅ | ❌ (Azure AI Search) | ❌ |
| Synapse Serverless SQL | ✅ | ✅ | ✅ | ✅ |
| Azure Data Explorer (ADX / Kusto) | ✅ | ✅ | ✅ | ✅ |
| ADLS Gen2 (HNS) | ✅ | ✅ | ✅ | ✅ + HSM-CMK |
| Container Apps | ✅ | ✅ | ❌ (AKS) | ❌ (AKS) |
| AKS | ✅ | ✅ | ✅ | ✅ |
| Functions Premium EP1 | ✅ | ✅ | ✅ | ✅ |
| Functions Flex Consumption | ✅ | ✅ | ❓ verify | ❓ |

## AI + Catalog

| Feature | Commercial | GCC | GCC-H / IL4 | IL5 (v1.1) |
|---|---|---|---|---|
| Microsoft Purview Data Map + Catalog | ✅ | ✅ | ✅ | ❌ (Atlas-on-AKS) |
| Purview DSPM (new experience) | ✅ May 2026 | ⚠ July 2026 | ⚠ July 2026 | ❌ |
| Apache Atlas on AKS (self-hosted) | ⚠ optional | ⚠ optional | ⚠ optional | ✅ required |
| Microsoft AI Foundry Hub (new) | ✅ | ✅ | ❌ (Azure ML Classic Hub) | ❌ |
| Azure ML Classic Hub | ✅ | ✅ | ✅ | ✅ |
| Foundry Agent Service | ✅ Mar 2026 GA | ⚠ verify regions | ❌ Gov-GA unconfirmed | ❌ |
| Microsoft Agent Framework 1.0 | ✅ | ✅ | ✅ (library, deployable anywhere) | ✅ |
| Azure AI Search vector | ✅ | ✅ | ✅ | ✅ |
| Azure OpenAI (gpt-4o / gpt-4.1) | ✅ | ✅ | ✅ usgovvirginia/usgovarizona | ✅ same Gov regions |
| Azure OpenAI Batch API | ✅ | ✅ | ❌ | ❌ |
| Azure OpenAI Content Safety | ✅ | ✅ | ❌ at IL4 (self-hosted Presidio) | ❌ |
| Azure OpenAI Assistants v1 | ✅ deprecating | ✅ | ❓ | ❓ |

## BI + Power BI

| Feature | Commercial | GCC | GCC-H / IL4 | IL5 (v1.1) |
|---|---|---|---|---|
| Power BI Premium F-SKU | ✅ | ❌ P-SKU only | ✅ | ✅ |
| Power BI Premium P-SKU | ✅ | ✅ | n/a | n/a |
| Microsoft Fabric (full SaaS) | ✅ | ❌ Forecasted | ❌ Forecasted | ❌ Forecasted |
| **Direct Lake (native Fabric)** | ✅ | ❌ Structural (no F-SKU in GCC) | ❌ Forecasted | ❌ Forecasted |
| **Direct Lake parity (Loom shim)** | ✅ | ❌ Structural (no F-SKU) | ✅ | ✅ |
| Power BI Azure Maps visual | ✅ | ❌ | ❌ | ❌ |
| Power BI BYO ADLS Gen2 storage | ✅ | ❌ | ✅ | ✅ |
| Power BI Autoscale | ✅ | ❌ | ✅ | ✅ |

## Parity services

| Feature | Commercial | GCC | GCC-H / IL4 | IL5 (v1.1) |
|---|---|---|---|---|
| Loom Activator Engine | ✅ Container Apps | ✅ Container Apps | ✅ AKS | ✅ AKS |
| Loom Mirroring Engine (Debezium) | ✅ | ✅ | ✅ | ✅ |
| Loom Direct-Lake Shim | ✅ | ❌ no F-SKU | ✅ | ✅ |
| Loom Data Agents (extends apps/copilot) | ✅ | ✅ | ✅ | ✅ |
| Loom Operations Agent (v1.1) | ⚠ v1.1 | ⚠ v1.1 | ⚠ v1.1 | ⚠ v1.1 |

## Security + Governance

| Feature | Commercial | GCC | GCC-H / IL4 | IL5 (v1.1) |
|---|---|---|---|---|
| Defender for Cloud (per-workload plans) | ✅ all plans | ✅ all plans | ✅ except AI Threat Protection | ✅ except AI TP |
| Defender for Cloud — AI Threat Protection | ✅ | ✅ | ❌ ([Sentinel workaround](defender-ai-workaround.md)) | ❌ ([Sentinel workaround](defender-ai-workaround.md)) |
| Microsoft Sentinel | ✅ | ✅ | ✅ | ✅ |
| Microsoft Entra ID (incl. PIM) | ✅ | ✅ | ✅ | ✅ |
| Cross-cloud B2B | ✅ | ✅ | ✅ (with caveats) | ⚠ ITAR / IL5 policy review |
| Key Vault Premium HSM | ✅ | ✅ | ✅ | ✅ required |
| HSM-backed CMK on storage | ⚠ optional | ⚠ optional | ⚠ recommended | ✅ required |
| Infrastructure encryption | ⚠ optional | ⚠ optional | ⚠ recommended | ✅ required |

## Networking

| Feature | Commercial | GCC | GCC-H / IL4 | IL5 (v1.1) |
|---|---|---|---|---|
| Hub-spoke VNet topology | ✅ | ✅ | ✅ | ✅ |
| Private Endpoints on all PaaS | ✅ | ✅ | ✅ | ✅ |
| Azure Firewall Premium | ✅ | ✅ | ✅ | ✅ |
| Application Gateway WAF v2 | ✅ | ✅ | ✅ | ✅ |
| Azure Front Door Premium | ✅ | ✅ | ✅ | ⚠ partial |
| ExpressRoute / VPN | ✅ | ✅ | ✅ | ✅ |

## Compliance authorizations

| Authorization | Commercial | GCC | GCC-H / IL4 | IL5 (v1.1) |
|---|---|---|---|---|
| FedRAMP High | ✅ | ✅ | ✅ | ✅ |
| DoD IL2 | ✅ | ✅ | ✅ | ✅ |
| DoD IL4 | (n/a) | (n/a) | ✅ | ✅ |
| DoD IL5 | (n/a) | (n/a) | (n/a) | ✅ |
| HIPAA BAA | ✅ | ✅ | ✅ | ✅ |
| CJIS | ✅ + state addendum | ✅ | ✅ | ✅ |
| IRS 1075 | ✅ | ✅ | ✅ | ✅ |
| ITAR | ❌ | ❌ | ✅ | ✅ |
| CMMC L2 (via FedRAMP H baseline) | ✅ | ✅ | ✅ | ✅ |
| CMMC L3 (via FedRAMP H baseline) | ⚠ | ⚠ | ✅ | ✅ |
| StateRAMP | ✅ | ✅ | ✅ | ✅ |
| CNSSI 1253 | (n/a) | (n/a) | (n/a) | ✅ |

## Related

- Reference: [Per-boundary dispatch matrix](../architecture.md#per-boundary-dispatch-matrix)
- Source: [`temp/fiab-research/02-gov-boundary-availability.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-research/02-gov-boundary-availability.md)
- Compliance: [Commercial](commercial.md), [GCC](gcc.md), [GCC-H](gcc-high.md), [IL5](dod-il5.md)
- Defender workaround: [Defender AI workaround](defender-ai-workaround.md)
