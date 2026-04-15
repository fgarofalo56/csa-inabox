# CSA-in-a-Box: Comprehensive Platform Research Report

> **Last Updated:** 2026-04-14 | **Status:** Reference | **Audience:** Architects / Leadership

**Date:** 2026-04-09
**Purpose:** Deep research for building a complete Cloud-Scale Analytics / Data Mesh / Data Fabric platform in Azure as an open-source alternative to Microsoft Fabric.

---

## Table of Contents

- [1. Azure Cloud-Scale Analytics Architecture](#1-azure-cloud-scale-analytics-architecture)
  - [1.1 Overview and Current Status](#11-overview-and-current-status)
  - [1.2 Core Architectural Concepts](#12-core-architectural-concepts)
  - [1.3 Data Lake Architecture (Medallion Pattern)](#13-data-lake-architecture-medallion-pattern)
  - [1.4 Hub-Spoke Network Topology](#14-hub-spoke-network-topology)
  - [1.5 Integration with Azure Landing Zones (ALZ)](#15-integration-with-azure-landing-zones-alz)
- [2. Data Mesh Architecture in Azure](#2-data-mesh-architecture-in-azure)
  - [2.1 Core Principles](#21-core-principles)
  - [2.2 Mapping Data Mesh to Azure / CSA](#22-mapping-data-mesh-to-azure--csa)
  - [2.3 Data Domains](#23-data-domains)
  - [2.4 Data Products](#24-data-products)
  - [2.5 Self-Serve Data Infrastructure](#25-self-serve-data-infrastructure)
  - [2.6 Federated Governance](#26-federated-governance)
  - [2.7 Unity Catalog vs Purview for Governance](#27-unity-catalog-vs-purview-for-governance)
- [3. Data Fabric Architecture](#3-data-fabric-architecture)
  - [3.1 How Data Fabric Differs from Data Mesh](#31-how-data-fabric-differs-from-data-mesh)
  - [3.2 Data Fabric Core Components](#32-data-fabric-core-components)
  - [3.3 Azure Services for Data Fabric Patterns](#33-azure-services-for-data-fabric-patterns)
  - [3.4 Hybrid Approach for csa-inabox](#34-hybrid-approach-for-csa-inabox)
- [4. Microsoft Fabric Alternative Components](#4-microsoft-fabric-alternative-components)
  - [4.1 Complete Component Mapping](#41-complete-component-mapping)
  - [4.2 Detailed Component Analysis](#42-detailed-component-analysis)
- [5. Required Azure Services for a Complete Platform](#5-required-azure-services-for-a-complete-platform)
  - [5.1 Complete Service Catalog](#51-complete-service-catalog)
  - [5.2 Service Dependencies Map](#52-service-dependencies-map)
- [6. Deployment Strategy for 4 Azure Subscriptions](#6-deployment-strategy-for-4-azure-subscriptions)
  - [6.1 Recommended Subscription Layout](#61-recommended-subscription-layout)
  - [6.2 Alternative: Scale-Out Layout](#62-alternative-scale-out-layout)
  - [6.3 Cross-Subscription Networking](#63-cross-subscription-networking)
  - [6.4 Policy Inheritance and Management Group Hierarchy](#64-policy-inheritance-and-management-group-hierarchy)
  - [6.5 RBAC Strategy](#65-rbac-strategy)
- [7. Best Practices and Standards](#7-best-practices-and-standards)
  - [7.1 Azure Well-Architected Framework for Data Platforms](#71-azure-well-architected-framework-for-data-platforms)
  - [7.2 Zero-Trust Network Architecture](#72-zero-trust-network-architecture)
  - [7.3 Data Classification and Sensitivity Labeling](#73-data-classification-and-sensitivity-labeling)
  - [7.4 Cost Management and FinOps](#74-cost-management-and-finops)
  - [7.5 Disaster Recovery and Business Continuity](#75-disaster-recovery-and-business-continuity)
- [8. Reference Templates and IaC](#8-reference-templates-and-iac)
  - [8.1 Microsoft Official Templates](#81-microsoft-official-templates)
  - [8.2 Template Architecture](#82-template-architecture)
  - [8.3 csa-inabox Deployment Approach](#83-csa-inabox-deployment-approach)
  - [8.4 Existing csa-inabox Assets](#84-existing-csa-inabox-assets)
- [9. Sources and References](#9-sources-and-references)
- [Appendix A: Service SKU Recommendations](#appendix-a-service-sku-recommendations)
- [Appendix B: Naming Convention](#appendix-b-naming-convention)
- [Appendix C: Deployment Order](#appendix-c-deployment-order)

---

## 1. Azure Cloud-Scale Analytics Architecture

### 1.1 Overview and Current Status

Microsoft's Cloud-Scale Analytics (CSA) was the reference architecture for building enterprise data platforms on Azure. It was part of the Cloud Adoption Framework (CAF) and provided prescriptive guidance for data landing zones, governance, and scalable analytics.

**Important Note:** As of early 2026, Microsoft has **deprecated** the Cloud-Scale Analytics scenario. The deprecation notice states: *"The Cloud-Scale Analytics scenario has been deprecated and is no longer maintained or supported. To ensure only the best guidance is surfaced, this guidance will be deleted April 2026."* Microsoft redirects to their new **"Unify your data platform"** guidance at `https://aka.ms/cafdata`.

**What this means for csa-inabox:** The CSA architecture remains the best-documented and most comprehensive open reference for building a modular, enterprise-grade data platform on Azure. While Microsoft is consolidating guidance (likely pushing toward Fabric), the architectural patterns, landing zone structure, and IaC templates remain valid and are exactly what we need. Our project preserves and extends these patterns with open-source tooling.

### 1.2 Core Architectural Concepts

CSA consists of two primary architectural constructs:

#### Data Management Landing Zone (DMLZ)
A **separate Azure subscription** that provides centralized governance for the entire analytics platform:

| Component | Azure Service | Purpose |
|-----------|---------------|---------|
| Data Catalog | Microsoft Purview | Register, classify, discover data sources across all landing zones |
| Data Governance | Purview + Unity Catalog | Centralized access control, auditing, lineage, data quality |
| Primary Data Management | Purview + custom | Master data management, golden records |
| Data Sharing & Contracts | Entra ID Entitlement Mgmt | Access packages, sharing policies |
| API Catalog | Azure API Management | Standardized API documentation and governance |
| Data Quality | Purview Data Quality | Quality metrics, validation, monitoring |
| Data Modeling Repository | ER/Studio, custom | Centralized entity relationship models |
| Container Registry | Azure Container Registry | Standard containers for data science |
| Service Layer | Custom microservices | Data marketplace, operations console, automation |
| Networking | VNet, DNS, Peering | Hub connectivity to all data landing zones |
| Security | Key Vault, Defender | Centralized secrets and threat protection |

**Key Design Decision:** The DMLZ must be deployed as a separate subscription under a management group with appropriate governance policies. It connects to data landing zones via VNet peering and to the connectivity subscription.

#### Data Landing Zone (DLZ)
Each DLZ is a **separate Azure subscription** that hosts analytics workloads for a specific domain or business unit:

| Layer | Resource Groups | Purpose |
|-------|----------------|---------|
| **Platform Services** (Required) | `network-rg`, `security-rg` | VNet, NSGs, route tables, monitoring, Defender |
| **Core Services** (Required) | `storage-rg`, `runtimes-rg`, `mgmt-rg`, `external-data-rg` | Data lakes, shared IRs, CI/CD agents, external storage |
| **Core Services** (Optional) | `data-ingestion-rg`, `shared-applications-rg` | ADF, SQL metastore, shared Databricks |
| **Data Application** (Optional) | `data-application-rg` (one or more) | Per-application resources |
| **Reporting** (Optional) | `reporting-rg` | Visualization, Power BI gateways |

### 1.3 Data Lake Architecture (Medallion Pattern)

Each DLZ provisions **three ADLS Gen2 storage accounts** forming a logical data lake:

| Lake # | Layer | Medallion | Containers | Description |
|--------|-------|-----------|------------|-------------|
| 1 | Raw | Bronze | `landing`, `conformance` | Immutable source data, data quality gates |
| 2 | Enriched | Silver | `standardized` | Merged, cleansed, type-aligned data |
| 2 | Curated | Gold | `data-products` | Aggregated, modeled, consumption-ready |
| 3 | Development | N/A | `analytics-sandbox`, `synapse-primary-*` | Exploratory sandboxes, workspace storage |

**Container Folder Structure (Raw/Landing):**
```text
Landing/
  Log/{Application Name}/
  Master and Reference/{Source System}/
  Telemetry/{Source System}/{Application}/
  Transactional/{Source System}/{Entity}/{Version}/
    Delta/{rundate=YYYY-MM-DD}/
    Full/
```

**Container Folder Structure (Raw/Conformance):**
```text
Conformance/
  Transactional/{Source System}/{Entity}/{Version}/
    Delta/
      Input/{rundate=YYYY-MM-DD}/
      Output/{rundate=YYYY-MM-DD}/
      Error/{rundate=YYYY-MM-DD}/
    Full/
      Input/{rundate=YYYY-MM-DD}/
      Output/{rundate=YYYY-MM-DD}/
      Error/{rundate=YYYY-MM-DD}/
```

**Container Folder Structure (Enriched/Standardized):**
```text
Standardized/
  Transactional/{Source System}/{Entity}/{Version}/
    General/{rundate=YYYY-MM-DD}/
    Sensitive/{rundate=YYYY-MM-DD}/
```

**Container Folder Structure (Curated/Data Products):**
```text
{Data Product}/
  {Entity}/{Version}/
    General/{rundate=YYYY-MM-DD}/
    Sensitive/{rundate=YYYY-MM-DD}/
```

**Key Configuration:**
- Enable Hierarchical Namespace (HNS) on all ADLS Gen2 accounts
- Use ACLs + Microsoft Entra groups for fine-grained access control
- Separate `General` and `Sensitive` folders for data classification
- Store data in Delta Lake format (Parquet + transaction log)

### 1.4 Hub-Spoke Network Topology

The networking architecture follows a hub-spoke model integrated with Azure Landing Zones:

```text
                    ┌─────────────────────┐
                    │   Connectivity Sub   │
                    │   (Hub VNet)         │
                    │   - Azure Firewall   │
                    │   - ExpressRoute     │
                    │   - VPN Gateway      │
                    └──────────┬──────────┘
                               │ VNet Peering
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────▼──────┐  ┌─────▼────────┐  ┌───▼──────────┐
    │  DMLZ VNet     │  │  DLZ-1 VNet  │  │  DLZ-2 VNet  │
    │  - Purview     │  │  - Storage   │  │  - Storage   │
    │  - Governance  │  │  - Compute   │  │  - Compute   │
    │  - ACR         │  │  - ADF       │  │  - ADF       │
    └────────┬───────┘  └──────────────┘  └──────────────┘
             │ VNet Peering to each DLZ
             └──────────────────────────────────────────┘
```

**Design Principles:**
- All PaaS services use **Private Endpoints** (no public IPs)
- VNet peering between DMLZ and each DLZ
- VNet peering between DLZs for cross-domain data sharing
- Central Azure Private DNS zones for endpoint resolution
- DNS A-records automated via Azure Policy (`deployIfNotExists`)
- Site-to-Site VPN for third-party cloud connectivity
- ExpressRoute for on-premises connectivity through the hub
- NSGs and route tables per subnet
- Azure Firewall in the hub for traffic inspection

**Private DNS Zones Required:**
- `privatelink.blob.core.windows.net`
- `privatelink.dfs.core.windows.net`
- `privatelink.database.windows.net`
- `privatelink.sql.azuresynapse.net`
- `privatelink.dev.azuresynapse.net`
- `privatelink.azuresynapse.net`
- `privatelink.vaultcore.azure.net`
- `privatelink.datafactory.azure.net`
- `privatelink.adf.azure.com`
- `privatelink.purview.azure.com`
- `privatelink.purviewstudio.azure.com`
- `privatelink.servicebus.windows.net`
- `privatelink.azuredatabricks.net`
- `privatelink.azurecr.io`
- `privatelink.monitor.azure.com`

### 1.5 Integration with Azure Landing Zones (ALZ)

CSA builds on top of Azure Landing Zones. The ALZ reference architecture provides:

**Management Group Hierarchy:**
```text
Tenant Root Group
├── Platform
│   ├── Management        (Log Analytics, Automation, Sentinel)
│   ├── Connectivity      (Hub VNet, Firewall, ExpressRoute, DNS)
│   └── Identity          (Domain Controllers, Entra ID Connect)
├── Landing Zones
│   ├── Corp              (Internal workloads with private connectivity)
│   │   ├── DMLZ Sub      (Data Management Landing Zone)
│   │   ├── DLZ-Dev Sub   (Development Data Landing Zone)
│   │   └── DLZ-Prod Sub  (Production Data Landing Zone)
│   └── Online            (Internet-facing workloads)
├── Sandbox               (Experimentation)
└── Decommissioned
```

**Platform Landing Zone Subscriptions:**
1. **Management Subscription** - Log Analytics workspace, Azure Monitor, Automation, Sentinel
2. **Connectivity Subscription** - Hub VNet, Azure Firewall, ExpressRoute, VPN, DNS zones
3. **Identity Subscription** - AD domain controllers (if needed)

**Application Landing Zone Subscriptions (for data):**
4. **DMLZ Subscription** - Data governance, Purview, ACR, shared services
5. **DLZ Subscription(s)** - One per data domain or environment

---

## 2. Data Mesh Architecture in Azure

### 2.1 Core Principles

Data mesh, as defined by Zhamak Dehghani, is an architectural pattern built on four principles:

1. **Domain-Oriented Data Ownership** - Data is owned by domain teams who understand it best
2. **Data as a Product** - Data products are first-class citizens with defined quality, SLAs, and discoverability
3. **Self-Serve Data Infrastructure Platform** - A platform that enables domain teams to build data products autonomously
4. **Federated Computational Governance** - Governance policies automated and embedded in the platform

### 2.2 Mapping Data Mesh to Azure / CSA

| Data Mesh Concept | CSA Implementation | Azure Services |
|-------------------|--------------------|----------------|
| **Data Domain** | Data Landing Zone (one per domain) | Azure Subscription + VNet + resource groups |
| **Data Product** | Data Application resource group | ADLS Gen2, ADF, Databricks, SQL |
| **Self-Serve Platform** | DMLZ + automated provisioning | IaC templates, Azure DevOps, Policy |
| **Federated Governance** | DMLZ + Purview + Policy | Purview, Azure Policy, Entra ID |
| **Data Catalog** | Centralized in DMLZ | Microsoft Purview |
| **Domain Team** | Data Application Team | Entra security groups |
| **Data Contract** | Sharing repository in DMLZ | Purview policies, Entra entitlement mgmt |

### 2.3 Data Domains

Three criteria for defining data domains:
1. **Long-term ownership** - Boundaries must support identified, persistent owners
2. **Match reality** - Domains should reflect actual business operations, not theoretical concepts
3. **Atomic integrity** - Don't combine unrelated areas into a single domain

Domain examples: Sales, Marketing, Finance, Supply Chain, Customer, Product

### 2.4 Data Products

A successful data product must be:
- **Usable** - Has users outside the immediate data domain
- **Valuable** - Maintains value over time
- **Feasible** - Can be built from available data and technology

Data product components:
- Data (the actual datasets)
- Code assets (generation, delivery, pipelines)
- Metadata (descriptions, schemas, lineage, quality metrics)
- Policies (access control, retention, classification)

Delivery formats: API, table, dataset in data lake, report, stream

### 2.5 Self-Serve Data Infrastructure

The DMLZ provides automation services (not products, but patterns to implement):

| Service | Scope |
|---------|-------|
| DLZ Provisioning | Creates new data landing zones via IaC |
| Data Product Onboarding | Creates resource groups, configures resources |
| Data Agnostic Ingestion | Metadata-driven ingestion engine using ADF + SQL metastore |
| Metadata Service | Exposes and creates platform metadata |
| Access Provisioning | Creates access packages and approval workflows |
| Data Lifecycle | Manages retention, cold storage, deletion |
| Domain Onboarding | Captures domain metadata, creates domain infrastructure |

### 2.6 Federated Governance

Implementation approach:
- **Automated policies** via Azure Policy (enforced at management group level)
- **Code-first** - Standards, policies, and platform deployment as code
- **Purview** for cross-domain data cataloging, classification, and lineage
- **Unity Catalog** (if using Databricks) for workspace-level governance
- **Entra ID entitlement management** for access request/approval workflows

### 2.7 Unity Catalog vs Purview for Governance

| Aspect | Microsoft Purview | Databricks Unity Catalog |
|--------|------------------|-------------------------|
| **Scope** | Tenant-wide, all Azure data sources | Databricks workspaces only |
| **Cataloging** | All Azure + 100+ connectors | Databricks tables, volumes, models |
| **Access Control** | Policy-based, integrated with Entra ID | Fine-grained table/column ACLs |
| **Lineage** | Cross-service, ADF, Synapse | Spark jobs, notebooks, SQL |
| **Data Quality** | Built-in quality rules | Partner integrations |
| **Classification** | Automatic sensitivity classification | Manual tags + Purview integration |
| **Cost** | Included with Azure (consumption model) | Included with Databricks Premium |
| **Recommendation** | Use as enterprise-wide catalog | Use in addition to Purview for Databricks-specific governance |

**Best Practice:** Use **both** together. Purview provides the enterprise-wide catalog, classification, and cross-platform lineage. Unity Catalog provides fine-grained access control, auditing, and lineage within the Databricks ecosystem. They are complementary, not competing.

---

## 3. Data Fabric Architecture

### 3.1 How Data Fabric Differs from Data Mesh

| Aspect | Data Mesh | Data Fabric |
|--------|-----------|-------------|
| **Philosophy** | Organizational (decentralized ownership) | Technical (automated integration) |
| **Core Driver** | Domain teams own their data products | Metadata/AI automates data integration |
| **Governance** | Federated (domain teams + central policies) | Centralized (knowledge graph-driven) |
| **Integration** | Self-serve, domain teams build pipelines | Automated, AI discovers and integrates |
| **Best For** | Large orgs with autonomous business units | Orgs needing to unify disparate data sources |
| **Key Technology** | Self-serve platform + catalog | Knowledge graph + metadata layer + ML |
| **Data Ownership** | Distributed to domains | Central with virtual access |

### 3.2 Data Fabric Core Components

1. **Knowledge Graph / Metadata Layer**
   - Active metadata that learns from usage patterns
   - Automatic relationship discovery between data assets
   - Semantic layer that provides business context
   - Azure Services: Purview, Cosmos DB (graph API), custom knowledge graph

2. **Automated Data Integration**
   - AI-driven data discovery and cataloging
   - Automatic schema mapping and transformation
   - Self-optimizing data pipelines
   - Azure Services: ADF, Purview auto-classification, Azure ML

3. **Unified Access Layer**
   - Virtual data access without physical movement
   - Polyglot query (SQL, Spark, API)
   - Azure Services: Synapse Serverless SQL, Databricks SQL Warehouses

4. **Governance and Security**
   - Policy-driven, automated enforcement
   - Data lineage tracking
   - Compliance monitoring
   - Azure Services: Purview, Azure Policy, Defender for Cloud

### 3.3 Azure Services for Data Fabric Patterns

| Pattern | Azure Services |
|---------|---------------|
| **Metadata Layer** | Purview (catalog, lineage, classification) |
| **Knowledge Graph** | Cosmos DB Gremlin API, Purview relationships |
| **Virtual Access** | Synapse Serverless SQL pools (query across data lakes) |
| **Automated Integration** | ADF metadata-driven pipelines, Purview auto-scan |
| **Semantic Layer** | Power BI datasets, Azure Analysis Services |
| **Data Virtualization** | Synapse Serverless SQL, Databricks lakehouse federation |

### 3.4 Hybrid Approach for csa-inabox

For `csa-inabox`, we recommend a **hybrid data mesh + data fabric** approach:
- **Data Mesh organizational model** - Domain teams own data products in DLZs
- **Data Fabric technical layer** - Centralized metadata, automated discovery, virtual access via DMLZ
- This gives the best of both: decentralized ownership with automated, AI-driven governance

---

## 4. Microsoft Fabric Alternative Components

This section maps each Microsoft Fabric capability to equivalent Azure services for our open-source platform.

### 4.1 Complete Component Mapping

| Capability | Microsoft Fabric | csa-inabox Alternative | Open Source? | Notes |
|------------|-----------------|----------------------|--------------|-------|
| **Data Lakehouse** | Fabric Lakehouse (OneLake) | ADLS Gen2 + Delta Lake | Delta Lake: Yes | Delta Lake is open source, ADLS is PaaS |
| **Spark Compute** | Fabric Spark | Synapse Spark Pools / Databricks | Spark: Yes | Apache Spark is open source |
| **Data Warehouse** | Fabric Warehouse | Synapse Dedicated SQL / Serverless SQL | No | Azure-managed service |
| **Data Integration** | Fabric Data Pipelines | Azure Data Factory | No | ADF is Azure-managed |
| **Real-Time Analytics** | Fabric Real-Time Intelligence | Azure Data Explorer + Event Hubs | No | ADX is Azure-managed |
| **Power BI** | Fabric Power BI | Power BI (standalone) | No | Same service, different licensing |
| **Data Governance** | Fabric Governance | Purview + Unity Catalog | Unity Catalog: Partially | Purview is Azure-managed |
| **AI/ML** | Fabric Data Science | Azure ML + Databricks ML | MLflow: Yes | MLflow is open source |
| **Data Engineering** | Fabric Data Engineering | Spark on Synapse/Databricks | Spark: Yes | |
| **Data Activator** | Fabric Data Activator | Event Grid + Logic Apps + Functions | No | Azure-managed |
| **Mirroring** | Fabric Mirroring | ADF CDC + Debezium | Debezium: Yes | Open source CDC |
| **Shortcuts** | OneLake Shortcuts | ADLS linked services + mount points | N/A | Native ADLS capability |

### 4.2 Detailed Component Analysis

#### 4.2.1 Data Lakehouse: Delta Lake on ADLS Gen2

**Architecture:**
- **Storage:** ADLS Gen2 with Hierarchical Namespace enabled
- **Table Format:** Delta Lake (open-source, Apache 2.0 license)
- **Features:** ACID transactions, time travel, schema evolution, unified batch/streaming
- **Alternative formats:** Apache Iceberg, Apache Hudi (for future flexibility)

**Configuration Recommendations:**
- Enable soft delete with 7-day retention
- Use lifecycle management policies for hot/cool/archive tiering
- Enable versioning for critical datasets
- Storage redundancy: LRS for dev, GRS for production
- Use customer-managed keys (CMK) via Key Vault for encryption

#### 4.2.2 Compute: Synapse Spark Pools vs Databricks

**Synapse Spark Pools:**
- Integrated with Synapse workspace
- Auto-pause and auto-scale
- Good for organizations already using Synapse ecosystem
- Lower cost for intermittent workloads
- Limited compared to Databricks for advanced ML

**Azure Databricks:**
- Most feature-rich Spark platform
- Unity Catalog for governance
- Photon engine for SQL performance
- MLflow integration for ML lifecycle
- Delta Live Tables for declarative ETL
- Cluster policies for cost control
- Premium tier required for Unity Catalog

**Recommendation:** Use **Databricks as primary compute** for its superior governance (Unity Catalog), ML capabilities, and ecosystem. Use **Synapse Serverless SQL** for ad-hoc querying of the data lake. This provides the best combination of capabilities.

#### 4.2.3 Data Warehouse: Synapse SQL Options

**Synapse Dedicated SQL Pool:**
- Traditional MPP data warehouse
- Persistent storage and compute
- Best for large-scale, predictable analytical workloads
- Expensive (pay-per-hour even when idle)
- Consider for enterprise reporting marts

**Synapse Serverless SQL Pool:**
- Query data in-place in ADLS Gen2
- Pay-per-query model
- Excellent for exploratory analysis
- Can create views over Delta Lake tables
- No data movement required
- Great complement to the lakehouse pattern

**Recommendation:** Use **Serverless SQL as primary query engine** for the lakehouse. Use Dedicated SQL only for specific high-performance reporting marts if needed. This dramatically reduces cost.

#### 4.2.4 Data Integration: Azure Data Factory

**Core Capabilities:**
- 100+ connectors (on-premises, cloud, SaaS)
- Metadata-driven pipeline patterns
- Self-hosted Integration Runtime for on-premises connectivity
- Mapping data flows for code-free transformation
- Tumbling window and event-driven triggers
- Integration with Purview for lineage

**Metadata-Driven Ingestion Pattern:**
- Store connection metadata in Azure SQL Database
- ADF reads metadata to dynamically generate pipelines
- Parameterized datasets and linked services
- Single pipeline template handles multiple source types
- This is the recommended "data agnostic ingestion engine" in CSA

**Alternative/Complement:** Use **dbt** (already in the csa-inabox repo) for transformation logic. ADF handles orchestration and data movement; dbt handles SQL-based transformations in the lakehouse.

#### 4.2.5 Real-Time Analytics

**Azure Data Explorer (ADX / Kusto):**
- Purpose-built for log and telemetry analytics
- KQL (Kusto Query Language) for ad-hoc analysis
- Sub-second query performance on massive datasets
- Streaming ingestion from Event Hubs, IoT Hub
- Time series analysis built-in

**Azure Event Hubs:**
- Managed Kafka-compatible event streaming
- Millions of events per second
- Event capture to ADLS Gen2 (Avro format)
- Kafka protocol support (Schema Registry)

**Real-Time Architecture:**
```text
Sources → Event Hubs → Databricks Structured Streaming → Delta Lake
                    └→ Azure Data Explorer (for operational analytics)
                    └→ Event Hubs Capture → ADLS Gen2 (archival)
```

#### 4.2.6 Power BI

Power BI standalone works identically to Fabric Power BI for reporting:
- Direct Lake mode (connect to Delta Lake tables)
- Import mode (for high-performance dashboards)
- DirectQuery (for real-time data)
- Premium capacity for large-scale deployment
- Power BI Embedded for ISV scenarios

**Recommendation:** Use Power BI Premium Per Capacity for the organization, connected directly to Delta Lake tables via Synapse Serverless SQL or Databricks SQL Warehouses.

#### 4.2.7 AI/ML

**Azure Machine Learning:**
- End-to-end ML lifecycle
- Responsible AI dashboard
- Managed compute instances and clusters
- Automated ML (AutoML)
- Model registry and deployment

**Databricks ML:**
- MLflow (open source) for experiment tracking
- Feature Store
- Model Serving
- AutoML
- Deep learning with GPU clusters

**Azure OpenAI Service:**
- GPT-4, embeddings, DALL-E
- Private endpoint support
- Content filtering
- Fine-tuning capabilities

**Recommendation:** Use **Databricks ML + MLflow** as primary ML platform (open-source ML tracking). Add Azure ML for specialized needs (AutoML, Responsible AI). Use Azure OpenAI for generative AI workloads.

---

## 5. Required Azure Services for a Complete Platform

### 5.1 Complete Service Catalog

#### Networking
| Service | Purpose | Subscription |
|---------|---------|-------------|
| Azure Virtual Network (VNet) | Network isolation per landing zone | All |
| VNet Peering | Hub-spoke connectivity | All |
| Private Endpoints | Secure PaaS access | All |
| Azure Private DNS Zones | Private endpoint resolution | Connectivity |
| Network Security Groups (NSG) | Subnet-level traffic filtering | All |
| Route Tables (UDR) | Force traffic through firewall | All |
| Azure Firewall | Central traffic inspection, FQDN filtering | Connectivity |
| Azure Bastion | Secure RDP/SSH to jumpboxes | Connectivity |
| ExpressRoute | On-premises connectivity | Connectivity |
| VPN Gateway | Site-to-Site for third-party clouds | Connectivity |

#### Identity & Access
| Service | Purpose | Subscription |
|---------|---------|-------------|
| Microsoft Entra ID | Identity provider | Tenant-wide |
| Managed Identities | Service-to-service auth (no passwords) | All |
| RBAC | Role-based access control | All |
| Service Principals | CI/CD and automation authentication | All |
| Entra ID Entitlement Mgmt | Self-service access request/approval | Tenant-wide |
| Privileged Identity Management | Just-in-time admin access | Tenant-wide |
| Conditional Access | Context-aware access policies | Tenant-wide |

#### Storage
| Service | Purpose | Subscription |
|---------|---------|-------------|
| ADLS Gen2 (HNS-enabled) | Data lake storage (3 per DLZ) | DLZ |
| Azure Blob Storage | External data staging | DLZ |
| Azure SQL Database | Metadata stores, ADF metastore | DLZ, DMLZ |
| Cosmos DB | Knowledge graph (optional), app data | DMLZ |

#### Compute
| Service | Purpose | Subscription |
|---------|---------|-------------|
| Azure Databricks | Primary Spark compute, ML, SQL analytics | DLZ |
| Synapse Analytics | Serverless SQL, optional Spark pools | DLZ |
| Azure Kubernetes Service (AKS) | Microservices, API hosting (optional) | DMLZ |
| Azure Functions | Event-driven automation | DLZ, DMLZ |
| Virtual Machines | Self-hosted IR, jumpboxes | DLZ |

#### Data Integration
| Service | Purpose | Subscription |
|---------|---------|-------------|
| Azure Data Factory | Orchestration, data movement | DLZ |
| Self-Hosted Integration Runtime | On-premises/private network access | DLZ |
| Event Hubs | Real-time event ingestion | DLZ |
| Event Grid | Event-driven triggers | DLZ |
| Service Bus | Reliable message queuing | DLZ, DMLZ |
| IoT Hub | IoT device telemetry (optional) | DLZ |

#### Governance
| Service | Purpose | Subscription |
|---------|---------|-------------|
| Microsoft Purview | Data catalog, classification, lineage | DMLZ (tenant-scoped) |
| Azure Policy | Governance enforcement | Management Group |
| Databricks Unity Catalog | Spark-level data governance | DLZ (Databricks) |
| Management Groups | Policy hierarchy, RBAC inheritance | Tenant-wide |

#### Security
| Service | Purpose | Subscription |
|---------|---------|-------------|
| Azure Key Vault | Secrets, keys, certificates | All |
| Microsoft Defender for Cloud | Threat protection, security posture | All |
| Microsoft Sentinel | SIEM, threat detection, SOAR | Management |
| Defender for Identity | Identity threat detection | Management |
| Defender for Storage | Storage threat protection | DLZ |
| Defender for SQL | Database threat protection | DLZ |

#### Monitoring
| Service | Purpose | Subscription |
|---------|---------|-------------|
| Azure Monitor | Platform metrics and alerts | All |
| Log Analytics Workspace | Centralized logging | Management |
| Application Insights | Application performance monitoring | DMLZ, DLZ |
| Azure Workbooks | Custom dashboards | Management |
| Diagnostic Settings | Service-level telemetry | All |

#### AI/ML
| Service | Purpose | Subscription |
|---------|---------|-------------|
| Azure Machine Learning | ML lifecycle management | DLZ |
| Azure OpenAI Service | Generative AI workloads | DLZ |
| Azure Cognitive Services | Pre-built AI (Vision, Language, etc.) | DLZ |
| Databricks ML / MLflow | Experiment tracking, model registry | DLZ |

### 5.2 Service Dependencies Map

```text
                    ┌─────────────────────────────────┐
                    │        Microsoft Entra ID         │
                    │    (Tenant-wide identity)         │
                    └──────────────┬──────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
┌───────▼───────┐         ┌────────▼───────┐         ┌───────▼────────┐
│  Management   │         │  Connectivity  │         │    Identity    │
│  Subscription │         │  Subscription  │         │  Subscription  │
│               │         │                │         │                │
│ Log Analytics │         │ Hub VNet       │         │ AD DCs (opt)   │
│ Sentinel      │         │ Firewall       │         │                │
│ Automation    │         │ ExpressRoute   │         └────────────────┘
│ Monitor       │         │ DNS Zones      │
└───────────────┘         │ Bastion        │
                          └───────┬────────┘
                                  │ VNet Peering
                    ┌─────────────┼──────────────┐
                    │                            │
           ┌────────▼───────┐          ┌─────────▼──────┐
           │     DMLZ       │          │     DLZ(s)     │
           │  Subscription  │          │  Subscription  │
           │                │          │                │
           │ Purview        │◄─peering─┤ ADLS Gen2 x3   │
           │ Key Vault      │          │ Databricks     │
           │ ACR            │          │ Synapse        │
           │ SQL Database   │          │ ADF + IR       │
           │ AKS (optional) │          │ Key Vault      │
           │ API Management │          │ Event Hubs     │
           └────────────────┘          │ Azure ML       │
                                       │ Power BI       │
                                       └────────────────┘
```

---

## 6. Deployment Strategy for 4 Azure Subscriptions

### 6.1 Recommended Subscription Layout

For the csa-inabox initial deployment with 4 subscriptions:

```text
Tenant Root Group
└── csa-inabox (Management Group)
    ├── Platform (Management Group)
    │   ├── Sub 1: csa-platform      (Management + Connectivity + Identity)
    │   │   ├── rg-management        (Log Analytics, Automation, Sentinel)
    │   │   ├── rg-connectivity      (Hub VNet, Firewall, DNS zones)
    │   │   └── rg-identity          (Optional AD DCs)
    │   │
    │   └── Sub 2: csa-governance    (Data Management Landing Zone)
    │       ├── rg-governance        (Purview, Policy artifacts)
    │       ├── rg-network           (DMLZ VNet, peering, private endpoints)
    │       ├── rg-shared-services   (ACR, API Management, Key Vault)
    │       └── rg-service-layer     (Automation microservices, data marketplace)
    │
    └── Landing Zones (Management Group)
        ├── Sub 3: csa-data-nonprod  (Development + Test DLZ)
        │   ├── rg-network           (DLZ VNet, NSGs, route tables)
        │   ├── rg-security          (Key Vault, Defender)
        │   ├── rg-storage           (ADLS Gen2 x3: raw, enriched, dev)
        │   ├── rg-compute           (Databricks, Synapse)
        │   ├── rg-integration       (ADF, shared IR, Event Hubs)
        │   ├── rg-data-app-{name}   (Per data product)
        │   └── rg-monitoring        (Diagnostic settings)
        │
        └── Sub 4: csa-data-prod     (Production DLZ)
            ├── rg-network
            ├── rg-security
            ├── rg-storage
            ├── rg-compute
            ├── rg-integration
            ├── rg-data-app-{name}
            └── rg-monitoring
```

### 6.2 Alternative: Scale-Out Layout

For larger deployments, expand to domain-based DLZs:

```text
Landing Zones (Management Group)
├── Sub: csa-dlz-finance     (Finance domain DLZ)
├── Sub: csa-dlz-sales       (Sales domain DLZ)
├── Sub: csa-dlz-marketing   (Marketing domain DLZ)
└── Sub: csa-dlz-operations  (Operations domain DLZ)
```

### 6.3 Cross-Subscription Networking

**VNet Address Space Allocation:**
```text
Hub VNet (csa-platform):     10.0.0.0/16
  - GatewaySubnet:           10.0.0.0/24
  - AzureFirewallSubnet:     10.0.1.0/24
  - AzureBastionSubnet:      10.0.2.0/24
  - ManagementSubnet:        10.0.10.0/24

DMLZ VNet (csa-governance):  10.1.0.0/16
  - PurviewSubnet:           10.1.1.0/24
  - SharedServicesSubnet:    10.1.2.0/24
  - PrivateEndpointSubnet:   10.1.10.0/24

DLZ-NonProd VNet:            10.2.0.0/16
  - DatabricksPublicSubnet:  10.2.1.0/24
  - DatabricksPrivateSubnet: 10.2.2.0/24
  - SynapseSubnet:           10.2.3.0/24
  - PrivateEndpointSubnet:   10.2.10.0/24
  - IntegrationSubnet:       10.2.11.0/24
  - DataApp1Subnet:          10.2.20.0/24

DLZ-Prod VNet:               10.3.0.0/16
  - (Same structure as NonProd)
```

**Peering Configuration:**
| From | To | Direction | Purpose |
|------|------|-----------|---------|
| Hub | DMLZ | Bidirectional | Governance connectivity |
| Hub | DLZ-NonProd | Bidirectional | Internet/on-premises access |
| Hub | DLZ-Prod | Bidirectional | Internet/on-premises access |
| DMLZ | DLZ-NonProd | Bidirectional | Purview scanning, governance |
| DMLZ | DLZ-Prod | Bidirectional | Purview scanning, governance |
| DLZ-NonProd | DLZ-Prod | Optional* | Cross-environment data sharing |

*Cross-DLZ peering between non-prod and prod should be avoided in most cases for isolation.

### 6.4 Policy Inheritance and Management Group Hierarchy

**Management Group Policies:**

| Management Group | Key Policies |
|-----------------|--------------|
| **Root (csa-inabox)** | - Require tags (cost center, environment, owner) |
|                        | - Allowed locations (restrict to approved regions) |
|                        | - Audit diagnostic settings |
|                        | - Deny public IP addresses |
| **Platform** | - Require resource locks on critical resources |
|              | - Deny unauthorized resource types |
| **Landing Zones** | - Deploy Private DNS zone groups (deployIfNotExists) |
|                    | - Require HTTPS/TLS |
|                    | - Deploy Defender for Cloud |
|                    | - Deny public network access on storage accounts |
|                    | - Require encryption at rest with CMK |
|                    | - Deny creation of classic resources |

### 6.5 RBAC Strategy

| Role | Scope | Principals |
|------|-------|-----------|
| Owner | Management Group: csa-inabox | Platform team (PIM-protected) |
| Contributor | Sub: csa-platform | Platform operations team |
| Network Contributor | Hub VNet resource group | Network team |
| Contributor | Sub: csa-governance | Data governance team |
| Purview Data Curator | Purview account | Data stewards |
| Contributor | DLZ resource groups | Data domain teams |
| User Access Administrator | DLZ subscription | Data platform team |
| Private DNS Zone Contributor | DNS resource group | Service principals for DLZ deployments |
| Network Contributor | DLZ subnets (child scope) | Data application team service principals |
| Reader | Sub: csa-data-prod | All data consumers |
| Storage Blob Data Reader | ADLS Gen2 curated | Data analysts, BI users |
| Storage Blob Data Contributor | ADLS Gen2 raw/enriched | Data engineers |

---

## 7. Best Practices and Standards

### 7.1 Azure Well-Architected Framework for Data Platforms

**Reliability:**
- Use GRS (Geo-Redundant Storage) for production data lakes
- Configure ADLS Gen2 soft delete and versioning
- Design for regional failover of critical services
- Implement retry policies in all data pipelines
- Use Availability Zones for Databricks, Synapse, Key Vault

**Security:**
- Zero-trust: Never trust, always verify
- Private endpoints for all PaaS services (no public access)
- Customer-managed keys for encryption at rest
- TLS 1.2+ for all data in transit
- Managed identities over service principals where possible
- Azure Policy to enforce security baseline
- Microsoft Defender for all data services

**Cost Optimization:**
- Synapse Serverless SQL (pay-per-query) over Dedicated SQL
- Databricks auto-scaling and auto-terminate policies
- ADLS lifecycle management (hot → cool → archive)
- Reserved instances for predictable Databricks/Synapse workloads
- Azure Advisor cost recommendations
- Tag-based cost allocation and chargeback

**Operational Excellence:**
- Infrastructure as Code (Bicep/Terraform) for all deployments
- CI/CD pipelines for data platform changes
- GitOps for configuration management
- Centralized monitoring via Log Analytics
- Automated alerting on pipeline failures
- Runbooks for common operational tasks

**Performance Efficiency:**
- Delta Lake Z-ordering for query optimization
- Databricks Photon engine for SQL workloads
- Partition pruning in data lake queries
- Caching strategies in Power BI and Synapse
- Right-sizing compute clusters

### 7.2 Zero-Trust Network Architecture

**Principles applied to data platforms:**

1. **Verify Explicitly** - Every access request is fully authenticated and authorized
   - Managed identities for service-to-service
   - Entra ID for user access
   - Conditional access policies

2. **Use Least-Privilege Access** - Just-in-time, just-enough access
   - PIM for admin roles
   - ACLs on data lake folders (not container level)
   - Granular RBAC roles

3. **Assume Breach** - Minimize blast radius
   - Network segmentation (subnets per workload)
   - Private endpoints (no public access surface)
   - NSGs with deny-all default
   - Azure Firewall for egress filtering
   - Micro-segmentation within DLZs

**Network Zero-Trust Checklist:**
- [ ] All PaaS services behind private endpoints
- [ ] Public network access disabled on all storage accounts
- [ ] Azure Firewall filtering all outbound traffic
- [ ] NSGs on every subnet with explicit allow rules
- [ ] No public IP addresses on any resource
- [ ] DNS resolution through private DNS zones only
- [ ] Jumpbox + Bastion for administrative access
- [ ] TLS 1.2 minimum on all services

### 7.3 Data Classification and Sensitivity Labeling

**Classification Levels:**

| Level | Label | Description | Handling |
|-------|-------|-------------|----------|
| 1 | Public | Approved for public release | No restrictions |
| 2 | Internal | General business data | Require authentication |
| 3 | Confidential | Sensitive business data | Encrypt, limited access |
| 4 | Highly Confidential | PII, financial, regulated | Encrypt, audit, MFA, DLP |
| 5 | Restricted | Top secret, regulated | Full audit, approval workflow |

**Implementation:**
- Microsoft Purview auto-classification scans data lakes
- Sensitivity labels applied to ADLS containers/folders
- Data in `Sensitive` folders gets Confidential or higher classification
- Azure Information Protection for document-level classification
- DLP policies via Purview to prevent data exfiltration
- Classification drives access control and retention policies

### 7.4 Cost Management and FinOps

**Cost Levers for Data Platforms:**

| Service | Cost Strategy |
|---------|--------------|
| **ADLS Gen2** | Lifecycle policies: hot (30 days) → cool (90 days) → archive |
| **Databricks** | Auto-terminate (15 min idle), spot instances for batch, cluster pools |
| **Synapse** | Serverless SQL (pay-per-TB scanned), auto-pause dedicated pools |
| **ADF** | Pipeline optimization, avoid excessive data movement |
| **Event Hubs** | Right-size throughput units, auto-inflate |
| **Key Vault** | Standard tier (not Premium) unless HSM required |
| **Purview** | Scan scheduling (not continuous) |

**FinOps Practices:**
- Tag all resources with: `costCenter`, `environment`, `owner`, `project`
- Use Azure Cost Management + Billing for dashboards
- Set budgets and alerts per subscription and resource group
- Weekly cost review by platform team
- Reserved Instances for Databricks (1-year or 3-year)
- Dev/test pricing for non-production subscriptions
- Auto-shutdown schedules for non-production compute
- Right-sizing reviews quarterly

### 7.5 Disaster Recovery and Business Continuity

**RPO/RTO Targets by Data Layer:**

| Layer | RPO | RTO | Strategy |
|-------|-----|-----|----------|
| Raw (Bronze) | 24 hours | 4 hours | Source re-ingest + GRS |
| Enriched (Silver) | 4 hours | 2 hours | GRS + reprocessing pipelines |
| Curated (Gold) | 1 hour | 1 hour | GRS + hot standby |
| Metadata (Purview) | 0 (continuous) | 1 hour | Managed service redundancy |

**BCDR Architecture:**
- ADLS Gen2: GRS or GZRS for cross-region replication
- Azure SQL: Active geo-replication or auto-failover groups
- Key Vault: Soft delete + purge protection enabled
- Databricks: Multi-region workspace deployment (active-passive)
- ADF: Pipeline definitions in git (redeploy from source)
- Purview: Tenant-scoped, inherently resilient

**Backup Strategy:**
- ADLS: Blob versioning + soft delete + point-in-time restore
- Azure SQL: Automated backups (7-35 day retention)
- Databricks: Unity Catalog metadata backed by managed storage
- Key Vault: Soft-delete (90 days) + purge protection
- IaC: All infrastructure defined in code (Bicep/Terraform in git)

---

## 8. Reference Templates and IaC

### 8.1 Microsoft Official Templates

Microsoft provides official Bicep/ARM templates in GitHub:

| Repository | Purpose | Deployment |
|------------|---------|------------|
| [Azure/data-management-zone](https://github.com/Azure/data-management-zone) | DMLZ template (Purview, governance, networking) | One per platform |
| [Azure/data-landing-zone](https://github.com/Azure/data-landing-zone) | DLZ template (storage, compute, integration) | One per DLZ |
| [Azure/data-product-batch](https://github.com/Azure/data-product-batch) | Batch data processing workload | One+ per DLZ |
| [Azure/data-product-streaming](https://github.com/Azure/data-product-streaming) | Streaming data processing workload | One+ per DLZ |
| [Azure/data-product-analytics](https://github.com/Azure/data-product-analytics) | Analytics and data science workload | One+ per DLZ |

**Template Stack:** Bicep (67.5%), PowerShell, Shell
**Deployment Methods:** Azure Portal (Deploy to Azure), GitHub Actions, Azure DevOps

### 8.2 Template Architecture

```text
data-management-zone/
├── infra/
│   ├── main.json          (ARM template entry point)
│   └── modules/           (Bicep modules)
│       ├── Purview/
│       ├── Network/
│       │   ├── privateDnsZones/
│       │   └── virtualNetworkLinks/
│       ├── KeyVault/
│       ├── ContainerRegistry/
│       └── ...
├── code/                  (Application code)
├── docs/                  (Documentation)
├── .github/               (GitHub Actions workflows)
└── .ado/                  (Azure DevOps pipelines)

data-landing-zone/
├── infra/
│   ├── main.json
│   └── modules/
│       ├── Storage/       (ADLS Gen2 accounts)
│       ├── Databricks/
│       ├── Synapse/
│       ├── DataFactory/
│       ├── Network/
│       └── ...
├── code/
├── docs/
├── .github/
└── .ado/
```

### 8.3 csa-inabox Deployment Approach

For our project, we should:

1. **Fork/adapt** the Microsoft templates as our baseline
2. **Add Terraform** support alongside Bicep (for multi-cloud flexibility)
3. **Create a unified deployment orchestrator** that:
   - Deploys the platform subscription (management + connectivity)
   - Deploys the DMLZ subscription
   - Deploys DLZ subscriptions
   - Configures cross-subscription networking
   - Sets up governance policies
4. **Add open-source tooling layer:**
   - dbt for SQL transformations
   - Great Expectations for data quality
   - Apache Airflow or Dagster for orchestration (optional)
   - MLflow for ML lifecycle
   - OpenMetadata or DataHub as Purview alternative (optional)

### 8.4 Existing csa-inabox Assets

Based on the current repo structure:
- `deploy/arm/` - ARM templates (e.g., Purview)
- `deploy/bicep/` - Bicep modules (DMLZ, network, private DNS zones)
- `scripts/sql/` - SQL scripts, Hive metastore notebook
- `tools/dbt/` - dbt environment for transformations
- `codeqlDB/` - Code quality database

---

## 9. Sources and References

### Microsoft Official Documentation

- [Cloud-Scale Analytics Overview](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/) - Main CSA scenario (deprecated, redirects to Unify your data platform)
- [Data Landing Zone Architecture](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/architectures/data-landing-zone) - DLZ component architecture
- [Data Management Landing Zone](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/architectures/data-management-landing-zone) - DMLZ governance architecture
- [What is Data Mesh?](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/architectures/what-is-data-mesh) - Data mesh principles on Azure
- [Network Topology and Connectivity](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/eslz-network-topology-and-connectivity) - Networking architecture
- [Identity and Access Management](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/eslz-identity-and-access-management) - IAM for data platforms
- [Security, Governance, and Compliance](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/eslz-security-governance-and-compliance) - Security architecture
- [Data Lake Zones and Containers](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/cloud-scale-analytics/best-practices/data-lake-zones) - Medallion architecture
- [What is an Azure Landing Zone?](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/landing-zone/) - ALZ reference architecture
- [Subscription Considerations](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/landing-zone/design-area/resource-org-subscriptions) - Subscription organization
- [Unify Your Data Platform (new guidance)](https://aka.ms/cafdata) - Replacement for CSA

### GitHub Repositories

- [Azure/data-management-zone](https://github.com/Azure/data-management-zone) - DMLZ Bicep templates
- [Azure/data-landing-zone](https://github.com/Azure/data-landing-zone) - DLZ Bicep templates
- [Azure/data-product-batch](https://github.com/Azure/data-product-batch) - Batch processing template
- [Azure/data-product-streaming](https://github.com/Azure/data-product-streaming) - Streaming template
- [Azure/data-product-analytics](https://github.com/Azure/data-product-analytics) - Analytics/DS template

### Architecture Frameworks

- [Azure Well-Architected Framework](https://learn.microsoft.com/en-us/azure/well-architected/) - Five pillars
- [Cloud Adoption Framework](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/) - Cloud adoption methodology
- [Azure Landing Zone Accelerator](https://aka.ms/alz/accelerator) - IaC deployment

### Open Source Projects

- [Delta Lake](https://delta.io/) - Open-source lakehouse storage layer
- [Apache Spark](https://spark.apache.org/) - Distributed compute engine
- [dbt](https://www.getdbt.com/) - SQL transformation framework
- [MLflow](https://mlflow.org/) - ML lifecycle management
- [Great Expectations](https://greatexpectations.io/) - Data quality validation
- [Debezium](https://debezium.io/) - Change data capture

---

## Appendix A: Service SKU Recommendations

| Service | Development | Production |
|---------|-------------|------------|
| ADLS Gen2 | Standard LRS, Hot | Standard GRS, Hot/Cool tiering |
| Databricks | Standard, Standard_DS3_v2 | Premium, Standard_DS4_v2+, Unity Catalog |
| Synapse | Serverless SQL only | Serverless SQL + DW100c (if dedicated needed) |
| ADF | Pay-as-you-go | Pay-as-you-go (consider reserved DIU) |
| Key Vault | Standard | Standard (Premium for HSM) |
| SQL Database | Basic/S0 (metastore) | S1/S2 (metastore) |
| Event Hubs | Basic (1 TU) | Standard (auto-inflate to 20 TU) |
| Purview | N/A (tenant-scoped) | N/A (tenant-scoped) |
| Azure Firewall | Basic | Standard or Premium |
| Log Analytics | Pay-as-you-go | Commitment tier (100GB/day+) |

## Appendix B: Naming Convention

```text
{resourceType}-{project}-{environment}-{region}-{instance}

Examples:
  rg-csa-prod-eastus2-001          (Resource Group)
  st-csa-prod-eastus2-raw          (Storage Account - raw lake)
  st-csa-prod-eastus2-enriched     (Storage Account - enriched lake)
  st-csa-prod-eastus2-dev          (Storage Account - development lake)
  adf-csa-prod-eastus2-001         (Data Factory)
  dbw-csa-prod-eastus2-001         (Databricks Workspace)
  syn-csa-prod-eastus2-001         (Synapse Workspace)
  kv-csa-prod-eastus2-001          (Key Vault)
  vnet-csa-prod-eastus2-001        (Virtual Network)
  pep-csa-prod-eastus2-st-raw      (Private Endpoint for raw storage)
  nsg-csa-prod-eastus2-dbw-pub     (NSG for Databricks public subnet)
  pdz-blob-core-windows-net        (Private DNS Zone)
```

## Appendix C: Deployment Order

```text
Phase 1: Foundation
  1. Management Groups and Policy Definitions
  2. Platform Subscription (Management + Connectivity)
     a. Log Analytics Workspace
     b. Hub VNet + Azure Firewall
     c. Private DNS Zones
     d. Azure Bastion

Phase 2: Governance
  3. DMLZ Subscription
     a. DMLZ VNet + Peering to Hub
     b. Key Vault
     c. Purview Account
     d. Azure Container Registry
     e. Shared SQL Database (metadata)

Phase 3: Data Landing Zones
  4. DLZ Subscription (NonProd first, then Prod)
     a. DLZ VNet + Peering to Hub + Peering to DMLZ
     b. NSGs and Route Tables
     c. Key Vault
     d. ADLS Gen2 accounts (x3) + Private Endpoints
     e. Databricks Workspace (VNet-injected) + Private Endpoints
     f. Synapse Workspace + Private Endpoints
     g. Azure Data Factory + Private Endpoints + Self-Hosted IR
     h. Event Hubs Namespace + Private Endpoints

Phase 4: Governance Configuration
  5. Purview Configuration
     a. Register data sources (ADLS, SQL, Databricks)
     b. Configure scanning schedules
     c. Set up classification rules
     d. Configure access policies
  6. Unity Catalog Configuration
     a. Create metastore
     b. Configure external locations
     c. Set up catalogs and schemas
     d. Configure access controls

Phase 5: Data Products
  7. Deploy data product templates
     a. Source-aligned data applications
     b. Consumer-aligned data applications
     c. ADF metadata-driven ingestion pipelines
     d. dbt transformation models
```

---

*This report was compiled from Microsoft's official Cloud Adoption Framework documentation, GitHub reference templates, and Azure architecture guidance. The information is current as of April 2026.*

---

## Related Documentation

- [ARCHITECTURE.md](../ARCHITECTURE.md) - Platform architecture overview
- [PLATFORM_SERVICES.md](../PLATFORM_SERVICES.md) - Platform services reference and SKU details
- [MULTI_REGION.md](../MULTI_REGION.md) - Multi-region deployment for high availability
