[Home](../README.md) > [Docs](./) > **Architecture**

# CSA-in-a-Box Architecture

> **Last Updated:** 2026-04-15 | **Status:** Active | **Audience:** Architects

> [!NOTE]
> **Quick Summary**: Architecture reference for CSA-in-a-Box — the Azure-native reference implementation of the Microsoft "Unify your data platform" CAF guidance, built on Azure PaaS and open-source tooling. Positions Fabric as the primary control plane where GA, and CSA-in-a-Box as the Azure Government gap-filler (Fabric is forecast, not GA), the post-deprecation CAF CSA reference, and an incremental on-ramp to Fabric. Covers the DMLZ/DLZ landing zone pattern, medallion data flow (Bronze/Silver/Gold), streaming via Event Hubs + ADX, AI/ML integration, 9 vertical examples, and Azure Government compatibility.

A comprehensive architecture reference for CSA-in-a-Box — an Azure-native
reference implementation of the Microsoft "Unify your data platform" Cloud
Adoption Framework guidance, built on Azure PaaS services and open-source
tooling. Where Microsoft Fabric is GA in your region and cloud, Fabric is the
primary control plane; CSA-in-a-Box is the Fabric-parity stack on Azure PaaS
for workloads in Azure Government (Fabric forecast, not GA), for regulated
scenarios that need composable IaC, and as an incremental on-ramp whose
components compose cleanly into a future Fabric migration.

## 📑 Table of Contents

- [🏗️ High-Level Architecture](#️-high-level-architecture)
- [🏗️ Architecture Layers](#️-architecture-layers)
  - [1. Data Management Landing Zone (DMLZ)](#1-data-management-landing-zone-dmlz)
  - [2. Data Landing Zone (DLZ)](#2-data-landing-zone-dlz)
  - [3. Platform Services](#3-platform-services)
  - [4. Consumer Layer](#4-consumer-layer)
  - [5. Azure Government Parallel](#5-azure-government-parallel)
- [🔄 Data Flow](#-data-flow)
  - [Batch Data Flow](#batch-data-flow)
  - [Streaming Data Flow](#streaming-data-flow)
  - [Data Governance Flow](#data-governance-flow)
- [💡 Vertical Examples](#-vertical-examples)
- [📁 Repository Structure](#-repository-structure)
- [⚙️ Primary Tech Choices](#️-primary-tech-choices)
- [🔒 Security Architecture](#-security-architecture)
- [🚀 Next Steps](#-next-steps)

---

## 🏗️ High-Level Architecture

```mermaid
graph TB
    %% ─── Data Sources ───────────────────────────────────────────────
    subgraph Sources["Data Sources"]
        direction LR
        Batch["Batch Sources<br/>(SQL, API, Files)"]
        Stream["Streaming Sources<br/>(IoT, Events)"]
        OpenData["Open Data APIs<br/>(USDA, NOAA, EPA, Census)"]
    end

    %% ─── Data Management Landing Zone ────────────────────────────────
    subgraph DMLZ["Data Management Landing Zone"]
        direction TB
        Purview["Microsoft Purview<br/>Catalog &amp; Governance"]
        KV["Azure Key Vault<br/>Secrets Management"]
        Marketplace["Data Marketplace API<br/>Discovery &amp; Access"]
        GovFramework["Governance Framework<br/>Classification, Lineage, MDM"]
        APIM["API Management<br/>Gateway &amp; Rate Limiting"]
    end

    %% ─── Data Landing Zone ──────────────────────────────────────────
    subgraph DLZ["Data Landing Zone(s)"]
        direction TB

        subgraph Ingest["Ingestion Layer"]
            ADF["Azure Data Factory<br/>Orchestration"]
            MetaFW["Metadata Framework<br/>Auto-generated Pipelines"]
            EventHub["Event Hubs<br/>Streaming Ingestion"]
            IoTHub["IoT Hub + DPS<br/>Device Management"]
        end

        subgraph Storage["Storage — OneLake Pattern"]
            direction LR
            Bronze["ADLS Gen2<br/>Bronze (Raw)"]
            Silver["ADLS Gen2<br/>Silver (Validated)"]
            Gold["ADLS Gen2<br/>Gold (Business)"]
        end

        subgraph Compute["Compute Layer"]
            Databricks["Azure Databricks<br/>Spark + Unity Catalog"]
            Synapse["Azure Synapse<br/>SQL Pools + Spark"]
            dbt["dbt Core<br/>Medallion Transforms"]
        end

        subgraph RealTime["Real-Time Analytics"]
            ADX["Azure Data Explorer<br/>KQL Engine"]
            ASA["Stream Analytics<br/>Windowed Aggregation"]
        end

        subgraph AI["AI / ML Layer"]
            AzureML["Azure ML<br/>Model Training"]
            AOAI["Azure OpenAI<br/>GPT-4, Embeddings"]
            RAG["RAG Patterns<br/>Domain Knowledge"]
        end
    end

    %% ─── Platform Services ──────────────────────────────────────────
    subgraph Platform["Platform Services"]
        direction TB
        DataActivator["Data Activator<br/>Event-driven Alerts"]
        DirectLake["Direct Lake<br/>Power BI over Delta"]
        SharedSvc["Shared Services<br/>Azure Functions"]
        OSSAlt["OSS Alternatives<br/>Gov Gap Fillers"]
    end

    %% ─── Consumer Layer ─────────────────────────────────────────────
    subgraph Consumers["Consumer Layer"]
        direction LR
        PowerBI["Power BI<br/>Dashboards &amp; Reports"]
        Portal["Data Onboarding Portal<br/>3 Implementations"]
        APIs["REST APIs<br/>Data Products"]
        Teams["Teams Alerts<br/>Webhooks"]
    end

    %% ─── Connections ────────────────────────────────────────────────
    Batch --> ADF
    Stream --> EventHub
    Stream --> IoTHub
    OpenData --> ADF
    IoTHub --> EventHub

    ADF --> Bronze
    EventHub --> Bronze
    MetaFW --> ADF

    Bronze --> dbt
    dbt --> Silver
    Silver --> dbt
    dbt --> Gold

    Databricks --> Bronze
    Databricks --> Silver
    Databricks --> Gold
    Synapse --> Gold

    EventHub --> ADX
    EventHub --> ASA
    ASA --> Gold
    ASA --> ADX

    Gold --> PowerBI
    Gold --> APIs
    Gold --> DirectLake
    DirectLake --> PowerBI
    ADX --> PowerBI

    Purview --> Bronze
    Purview --> Silver
    Purview --> Gold
    Marketplace --> Purview
    GovFramework --> Purview

    AOAI --> RAG
    AzureML --> Gold

    DataActivator --> Teams
    SharedSvc --> ADF

    Portal --> APIM
    APIM --> Marketplace
    APIM --> ADF

    KV --> ADF
    KV --> Databricks
    KV --> SharedSvc

    %% ─── Styling ────────────────────────────────────────────────────
    classDef source fill:#e1f5fe,stroke:#0288d1
    classDef dmlz fill:#f3e5f5,stroke:#7b1fa2
    classDef dlz fill:#e8f5e9,stroke:#388e3c
    classDef platform fill:#fff3e0,stroke:#f57c00
    classDef consumer fill:#fce4ec,stroke:#c62828

    class Batch,Stream,OpenData source
    class Purview,KV,Marketplace,GovFramework,APIM dmlz
    class ADF,MetaFW,EventHub,IoTHub,Bronze,Silver,Gold,Databricks,Synapse,dbt,ADX,ASA,AzureML,AOAI,RAG dlz
    class DataActivator,DirectLake,SharedSvc,OSSAlt platform
    class PowerBI,Portal,APIs,Teams consumer
```

---

## 🏗️ Architecture Layers

### 1. Data Management Landing Zone (DMLZ)

The DMLZ provides centralized governance and shared services across all Data
Landing Zones. It is deployed once per environment and manages cross-cutting
concerns.

**Components:**

| Component | Service | Purpose |
|-----------|---------|---------|
| Data Catalog | Microsoft Purview | Asset discovery, classification, lineage tracking |
| Secrets Management | Azure Key Vault | Connection strings, tokens, certificates |
| Data Marketplace | Custom FastAPI + Purview | Self-service data product discovery and access requests |
| Governance Framework | Purview + Custom | Sensitivity labels, automated classification, MDM |
| API Gateway | API Management | Rate limiting, authentication, routing for all platform APIs |

**Deployment:** `deploy/bicep/DMLZ/main.bicep`

### 2. Data Landing Zone (DLZ)

Each DLZ represents a domain boundary — a self-contained analytics environment
with its own storage, compute, and pipelines. Organizations deploy one or more
DLZs based on data domain segmentation (e.g., Finance, Health, Environmental).

#### 🗄️ Storage — OneLake Pattern

The medallion architecture uses ADLS Gen2 containers mapped to quality tiers:

| Layer | Container | Format | Purpose |
|-------|-----------|--------|---------|
| Bronze | `bronze/` | Parquet / JSON / Avro | Raw ingestion, append-only, immutable |
| Silver | `silver/` | Delta Lake | Validated, deduplicated, typed, conformed |
| Gold | `gold/` | Delta Lake | Business-ready aggregates, dimensions, facts |

This mirrors Microsoft Fabric's OneLake with Unity Catalog providing the unified
metadata layer across all storage accounts.

#### ⚙️ Ingestion Layer

- **Azure Data Factory** — Batch orchestration with parameterized, metadata-driven
  pipelines. The metadata framework (`csa_platform/metadata_framework/`) auto-generates
  ADF pipelines from source registration YAML.
- **Event Hubs** — Kafka-compatible streaming ingestion for IoT, telemetry, and
  real-time events. Supports Capture to ADLS for cold-path archival.
- **IoT Hub + DPS** — Managed device provisioning and telemetry routing for IoT
  scenarios (weather stations, AQI sensors, industrial equipment).

#### ⚡ Compute Layer

- **Azure Databricks** — Primary Spark engine with Unity Catalog for fine-grained
  access control. Used for complex transformations, ML feature engineering, and
  interactive analytics.
- **Azure Synapse** — SQL-based analytics with dedicated and serverless SQL pools.
  Multi-workspace isolation per organization when needed.
- **dbt Core** — SQL-first transformations implementing the medallion pattern.
  Each domain has its own dbt project with Bronze, Silver, and Gold models.

#### 📊 Real-Time Analytics

- **Azure Data Explorer (ADX)** — Sub-second KQL queries over streaming data.
  Used for IoT dashboards, anomaly detection, and operational monitoring.
- **Stream Analytics** — Windowed aggregation (tumbling, hopping, sliding) with
  built-in anomaly detection via `AnomalyDetection_SpikeAndDip`.

#### 🤖 AI / ML Layer

- **Azure ML** — Model training, registry, and deployment. Integrated with
  Databricks for feature store access.
- **Azure OpenAI** — GPT-4 and embedding models for document enrichment,
  classification, summarization, and RAG-based Q&A.
- **RAG Patterns** — Domain-specific retrieval-augmented generation using
  vector search over gold-layer data products.

**Deployment:** `deploy/bicep/DLZ/main.bicep`

### 3. Platform Services

Platform services extend the base landing zones with Fabric-equivalent
capabilities. Each component is independently deployable.

| Service | Fabric Equivalent | Location |
|---------|-------------------|----------|
| OneLake Pattern | OneLake | `csa_platform/onelake_pattern/` |
| Data Activator | Data Activator | `csa_platform/data_activator/` |
| Direct Lake | Direct Lake mode | `csa_platform/direct_lake/` |
| Data Marketplace | Data Sharing | `csa_platform/data_marketplace/` |
| Metadata Framework | Metadata-driven ADF | `csa_platform/metadata_framework/` |
| AI Integration | Copilot / AI | `csa_platform/ai_integration/` |
| Shared Services | Shared Functions | `csa_platform/shared_services/` |
| OSS Alternatives | N/A (Gov gaps) | `csa_platform/oss_alternatives/` |
| Multi-Synapse | Multi-workspace | `csa_platform/multi_synapse/` |
| Governance | Purview Integration | `csa_platform/purview_governance/` + top-level `governance/` |

See [PLATFORM_SERVICES.md](PLATFORM_SERVICES.md) for detailed deployment guides.

### 4. Consumer Layer

The consumer layer exposes processed data to end users and downstream systems.

- **Power BI** — Direct Lake mode connects Power BI directly to Delta Lake files
  in ADLS Gen2 via Databricks SQL endpoints, eliminating data import overhead.
- **Data Onboarding Portal** — Three implementations (PowerApps, React/Next.js,
  Kubernetes) sharing a common FastAPI backend.
- **REST APIs** — Data product APIs exposed through API Management with OAuth2
  authentication and rate limiting.
- **Teams Alerts** — Webhook-based notifications for pipeline failures, data
  quality violations, and anomaly detection alerts.

### 5. Azure Government Parallel

Every component in CSA-in-a-Box is designed to run in Azure Government
(FedRAMP High, IL4, IL5). Government deployments use:

- Separate Bicep parameter files (`deploy/bicep/gov/`)
- Government-specific endpoints (`.us` instead of `.com`)
- Compliance tagging (FedRAMP level, FISMA impact, data classification)
- OSS alternatives for services not yet available in Gov

See [GOV_SERVICE_MATRIX.md](GOV_SERVICE_MATRIX.md) for the full service
availability matrix.

---

## 🔄 Data Flow

### Batch Data Flow

```mermaid
graph LR
    Source["Source"] --> ADF["ADF Copy Activity"]
    ADF --> Bronze["Bronze<br/>(raw Parquet/JSON)"]
    Bronze --> dbtB["dbt Bronze model<br/>(typed, partitioned)"]
    dbtB --> dbtS["dbt Silver model<br/>(validated, deduplicated)"]
    dbtS --> dbtG["dbt Gold model<br/>(business aggregates)"]
    dbtG --> Consumer["Power BI / API<br/>Data Product"]
```

### Streaming Data Flow

```mermaid
graph LR
    IoT["IoT Device"] --> Hub["IoT Hub"]
    Hub --> EH["Event Hub"]
    EH --> Hot["Hot Path: ADX<br/>(sub-second KQL)"]
    EH --> Warm["Warm Path: Stream Analytics<br/>(windowed aggregation)"]
    EH --> Cold["Cold Path: ADLS Bronze<br/>(Event Hub Capture)"]
    Warm --> PBI["Power BI / ADX"]
    Cold --> dbt["dbt → Gold"]
```

### Data Governance Flow

```mermaid
graph LR
    Reg["Source Registration"] --> Scan["Purview Scan"]
    Scan --> Class["Auto-Classification"]
    Class --> Labels["Sensitivity Labels"]
    Labels --> Policies["Access Policies"]
    Policies --> Lineage["Lineage Captured"]
    Lineage --> Market["Data Marketplace Discovery"]
    Market --> Grant["Access Request → Approval → Grant"]
```

---

## 💡 Vertical Examples

CSA-in-a-Box includes 9 vertical-specific implementations that demonstrate
end-to-end patterns for real agencies and industries:

| Vertical | Directory | Key Patterns |
|----------|-----------|-------------|
| USDA (NASS Agriculture) | `examples/usda/` | API ingestion, crop analytics, dbt medallion |
| DOT (Transportation) | `examples/dot/` | Safety data, geospatial, FMCSA/NHTSA |
| USPS (Postal Service) | `examples/usps/` | Address validation, delivery metrics |
| NOAA (Weather/Climate) | `examples/noaa/` | Weather station streaming, climate analysis |
| EPA (Environmental) | `examples/epa/` | AQI sensors, compliance monitoring |
| Commerce (Census/BEA) | `examples/commerce/` | Census data, economic indicators |
| Interior (USGS/BLM) | `examples/interior/` | Geospatial, land management |
| Tribal Health (BIA/IHS) | `examples/tribal-health/` | HIPAA, tribal sovereignty, health analytics |
| Casino Analytics | `examples/casino-analytics/` | Slot telemetry, revenue, Title 31 |
| IoT Streaming | `examples/iot-streaming/` | Generic IoT, real-time, anomaly detection |

Each vertical includes seed data generators, dbt models, deployment templates,
and domain-specific documentation.

---

## 📁 Repository Structure

```text
csa-inabox/
├── deploy/                     # Infrastructure as Code
│   ├── bicep/
│   │   ├── landing-zone-alz/  # Azure Landing Zone (Management + Connectivity)
│   │   ├── DMLZ/               # Data Management Landing Zone
│   │   ├── DLZ/                # Data Landing Zone
│   │   ├── gov/                # Azure Government templates
│   │   └── shared/             # Shared Bicep modules
│   ├── terraform/              # Terraform alternative
│   └── scripts/                # Deployment orchestration
│
├── domains/                    # Domain-specific data assets
│   ├── shared/                 # Core domain (customers, orders, products)
│   ├── finance/                # Finance domain (invoices, payments)
│   ├── inventory/              # Inventory domain (stock, warehouses)
│   └── sales/                  # Sales domain (orders, revenue)
│
├── examples/                   # Vertical implementations
│   ├── usda/                   # USDA agriculture analytics
│   ├── dot/                    # DOT transportation safety
│   ├── noaa/                   # NOAA weather & climate
│   ├── epa/                    # EPA environmental monitoring
│   ├── iot-streaming/          # Generic IoT & streaming patterns
│   └── ...                     # 5 more verticals
│
├── csa_platform/                # Fabric-equivalent platform services
│   ├── onelake_pattern/        # Unified data lake
│   ├── data_activator/         # Event-driven alerting
│   ├── direct_lake/            # Power BI Direct Lake
│   ├── data_marketplace/       # Data product marketplace
│   ├── metadata_framework/     # Auto-pipeline generation
│   ├── ai_integration/         # RAG, enrichment, model serving
│   ├── shared_services/        # Reusable Azure Functions
│   └── oss_alternatives/       # OSS for Gov gaps
│
├── portal/                     # Data onboarding portal (3 frontends)
│   ├── shared/                 # Shared FastAPI backend
│   ├── react-webapp/           # React/Next.js frontend
│   ├── powerapps/              # Power Apps frontend
│   └── kubernetes/             # AKS-deployed frontend
│
├── governance/                 # Cross-cutting governance
│   ├── common/                 # Logging, validation, contracts
│   ├── contracts/              # Data product contract framework
│   ├── purview/                # Catalog, glossary, classification
│   └── dataquality/            # Great Expectations quality checks
│
├── monitoring/                 # Observability
│   ├── grafana/dashboards/     # Pipeline, quality, infra dashboards
│   └── alerts/                 # Budget and operational alert templates
│
├── docs/                       # Documentation
├── tests/                      # Unit and integration tests
└── scripts/                    # Utility scripts
```

---

## ⚙️ Primary Tech Choices

This table is a **cheat sheet** of the default pick for each concern. For branching decisions with scenario-specific tradeoffs (cost, latency, compliance, skill match, anti-patterns), see the 8 decision trees at [`docs/decisions/`](decisions/) (machine-readable source of truth at [`decision-trees/`](../decision-trees/)).

| Concern | Primary Choice | Alternative | Rationale |
|---------|---------------|-------------|-----------|
| Batch Orchestration | Azure Data Factory | Airflow on AKS | ADF is native, metadata-driven |
| Streaming | Event Hubs + ADX | Kafka on AKS | Event Hubs has Kafka API compatibility |
| Transformation | dbt Core + Databricks | Synapse Spark | dbt provides testability and lineage |
| Storage | ADLS Gen2 (Delta) | Iceberg on ADLS | Delta has best Databricks integration |
| Governance | Microsoft Purview | Apache Atlas | Purview integrates with Azure ecosystem |
| ML / AI | Azure ML + OpenAI | MLflow + Ollama | Azure ML for managed, OSS for Gov |
| Real-time Queries | Azure Data Explorer | ClickHouse on AKS | ADX is native, managed |
| API Gateway | API Management | Kong on AKS | APIM integrates with Entra ID |
| Secrets | Key Vault | HashiCorp Vault | Key Vault is native to Azure |
| IaC | Bicep | Terraform | Bicep is Azure-native, Terraform for multi-cloud |

---

## 🔒 Security Architecture

All deployments enforce:

- **Network isolation** — Private endpoints for all PaaS services, no public access
- **Identity-based access** — Managed identities, no shared keys in production
- **Encryption** — At rest (platform-managed or CMK) and in transit (TLS 1.2+)
- **RBAC** — Least-privilege role assignments per domain
- **Audit logging** — Diagnostic settings to Log Analytics workspace
- **Data classification** — Automated PII detection and sensitivity labeling via Purview

---

## 🚀 Next Steps

- [GETTING_STARTED.md](GETTING_STARTED.md) — Prerequisites and deployment walkthrough
- [QUICKSTART.md](QUICKSTART.md) — 60-minute hands-on tutorial
- [PLATFORM_SERVICES.md](PLATFORM_SERVICES.md) — Platform component deep-dive
- [GOV_SERVICE_MATRIX.md](GOV_SERVICE_MATRIX.md) — Azure Government compatibility
- **Fabric migration path** — See the
  [`fabric-vs-databricks-vs-synapse` decision tree](../decision-trees/fabric-vs-databricks-vs-synapse/),
  [ADR-0010 (positioning)](adr/ADR-0010-positioning.md), and the
  Palantir migration playbook in [`migrations/`](migrations/) for guidance on
  when to stay on CSA-in-a-Box, when to adopt Microsoft Fabric, and how
  components compose into a Fabric migration.

---

## 🔗 Related Documentation

- [Platform Services](PLATFORM_SERVICES.md) — Platform component deep-dive
- [Getting Started](GETTING_STARTED.md) — Prerequisites and deployment walkthrough
- [Multi-Region DR](DR.md) — Multi-region disaster recovery runbook
- [Quick Start](QUICKSTART.md) — 60-minute hands-on tutorial
