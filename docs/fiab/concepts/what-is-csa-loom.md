# What is CSA Loom?

CSA Loom is the Cloud Scale Analytics platform that delivers the
Microsoft Fabric experience inside any Azure tenant where Fabric is not
yet generally available — federal civilian, DoD, state/local government,
regulated commercial, and other sovereignty-constrained environments.

## The problem it solves

Microsoft Fabric is not GA in any US Government cloud as of 2026. The
Azure Government (GCC-High / IL4, FedRAMP High) and DoD IL5 boundaries
all have Fabric listed as `Forecasted` with no published GA date. Every
federal customer that requires FedRAMP High, IL4, IL5, ITAR, CJIS, IRS
1075, CMMC L2/L3, or data-sovereignty controls cannot adopt Fabric today.

CSA Loom fills that gap now, running entirely in your existing Azure
Government tenant with no dependency on Microsoft Fabric.

## What Loom is

Loom is four things working together:

**1. A push-button deployment.** `azd up` or the "Deploy to Azure"
button stands the full Loom stack up in your Azure subscription in
60–100 minutes. No Fabric capacity or Fabric workspace is required —
everything runs on Azure-native services.

**2. A Fluent UI v9 console** (Next.js on Azure Container Apps or AKS)
that mirrors the Fabric workspace layout: Lakehouse, Warehouse, Notebook,
Semantic Model, KQL database, KQL dashboard, Real-Time Intelligence,
Data Agents, Activator, and Data Marketplace — all over your existing
Azure stack.

**3. A conversational Setup Wizard** (Loom Copilot) that interviews
you about your tenant, subscriptions, boundary, and capacity sizing,
renders a live `.bicepparam` preview, and deploys via a self-hosted
Azure MCP server inside your Admin Plane.

**4. Parity services** that deliver Fabric-only capabilities on
Azure-native backends:

| Loom service | What it delivers | Backend |
|---|---|---|
| Direct-Lake Shim | Power BI Direct Lake freshness | Power BI Premium Import + Event Grid TOM refresh |
| Activator Engine | Reflex / Data Activator rules | NRules + Redis + Azure Functions backed by ADX |
| Mirroring Engine | Zero-ETL database mirroring | OSS Debezium + Event Hubs + Spark + Delta MERGE |
| Loom Data Agents | NL2SQL / NL2DAX / NL2KQL chat | Azure OpenAI + AI Search + identity passthrough |

## The Azure-native backend

Every Loom item type maps to an Azure service — Fabric is strictly
opt-in, never required:

| Loom item | Azure-native backend |
|---|---|
| Lakehouse | ADLS Gen2 + Delta tables |
| Warehouse | Synapse Dedicated SQL pool |
| KQL database / eventhouse | Azure Data Explorer (ADX) |
| Data pipeline | Synapse pipeline or ADF |
| Eventstream | Azure Event Hubs + Stream Analytics |
| Semantic model | Loom-native tabular layer over warehouse/lakehouse |
| Report | Loom-native report renderer; Power BI Premium optional |
| Catalog / domains | Microsoft Purview (Commercial/GCC/GCC-H) or Apache Atlas on AKS (IL5) |

## Tenancy model

Loom aligns with Microsoft CAF's Cloud Scale Analytics pattern:

- **Admin Plane** — one subscription per organization (the Data
  Management Zone); hosts the Console, MCP server, Copilot, shared
  catalog, and shared ADX cluster.
- **Data Landing Zone (DLZ)** — one subscription per domain, agency,
  or mission; each DLZ's spoke VNet peers to the Admin Plane hub VNet.
- **Workspace** — a data product inside a DLZ (a resource group with
  Loom items: lakehouses, warehouses, notebooks, pipelines, etc.).

## Gov boundaries

| Boundary | Loom availability | Container compute | Catalog |
|---|---|---|---|
| Azure Commercial / GCC | GA (v1) | Container Apps | Databricks Unity Catalog + Purview overlay |
| FedRAMP High / GCC-H / IL4 | v1 | AKS | Microsoft Purview (primary) |
| DoD IL5 | v1.1 | AKS | Apache Atlas on AKS |

## Forward migration

When Microsoft Fabric reaches your audit boundary, your Loom investment
ports forward 1:1: Delta tables become OneLake shortcuts, dbt models
run unchanged, TMDL semantic models are identical, KQL queries are
identical. You are not trapped in Loom — Loom is the bridge to Fabric.

## Get started

- [Reference architecture](../architecture.md) — per-layer diagram,
  per-boundary dispatch matrix, catalog strategy.
- [Deployment quickstart](../deployment/quickstart.md) — `azd up` or
  Deploy-to-Azure button.
- [Parity matrix](../parity-matrix.md) — workload-by-workload coverage
  and honest gaps.
- [Workloads](../workloads/index.md) — one page per Fabric workload.
