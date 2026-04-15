# Platform Services Guide

Platform services are the Fabric-equivalent capabilities that extend the base
landing zones. Each service is independently deployable and has its own README
with detailed usage instructions.

## Services Overview

```mermaid
graph LR
    subgraph "Core Services"
        OL[OneLake Pattern]
        MF[Metadata Framework]
        SS[Shared Services]
    end

    subgraph "Intelligence"
        AI[AI Integration]
        DA[Data Activator]
        DL[Direct Lake]
    end

    subgraph "Governance"
        DM[Data Marketplace]
        GV[Governance Framework]
        MS[Multi-Synapse]
    end

    subgraph "Gap Fillers"
        OSS[OSS Alternatives]
    end

    MF --> OL
    SS --> MF
    AI --> OL
    DA --> SS
    DL --> OL
    DM --> GV
    GV --> OL
```

## 1. OneLake Pattern

**Location:** `platform/onelake-pattern/`
**Fabric Equivalent:** OneLake

Implements a unified data lake using ADLS Gen2 with Unity Catalog providing the
shared metadata layer. All domain data lives in a single logical lake with
physical separation via containers and folders.

**What it does:**
- Provides a standardized storage layout (Bronze / Silver / Gold) per domain
- Configures Unity Catalog for cross-domain metadata and access control
- Sets up storage lifecycle policies (hot → cool → archive)
- Creates shared Delta Lake tables accessible across Databricks and Synapse

**Deploy:**
```bash
az deployment group create \
  --resource-group rg-datalake \
  --template-file platform/onelake-pattern/deploy/onelake.bicep \
  --parameters platform/onelake-pattern/deploy/params.json
```

**Dependencies:** ADLS Gen2 (from DLZ deployment), Databricks workspace

---

## 2. Data Activator

**Location:** `platform/data-activator/`
**Fabric Equivalent:** Data Activator

Event-driven alerting and automation triggered by data conditions. Replaces
Fabric Data Activator using Event Grid, Logic Apps, and Azure Functions.

**What it does:**
- Monitors data lake events (new files, schema changes, quality violations)
- Triggers alerts via Teams webhooks, email, or PagerDuty
- Executes remediation workflows (re-run pipeline, quarantine bad data)
- Provides configurable thresholds and notification routing

**Deploy:**
```bash
az deployment group create \
  --resource-group rg-platform \
  --template-file platform/data-activator/deploy/activator.bicep \
  --parameters platform/data-activator/deploy/params.json
```

**Dependencies:** Event Grid (from DLZ), Logic Apps, Azure Functions, Key Vault

---

## 3. Direct Lake

**Location:** `platform/direct-lake/`
**Fabric Equivalent:** Direct Lake mode in Power BI

Enables Power BI to query Delta Lake files directly from ADLS Gen2 via
Databricks SQL endpoints, eliminating the need to import data into Power BI
datasets.

**What it does:**
- Configures Databricks SQL Serverless endpoints for Power BI consumption
- Provides DAX measures and M query templates for common patterns
- Sets up row-level security passthrough from Entra ID to Unity Catalog
- Optimizes Delta tables for Direct Lake performance (file size, Z-ordering)

**Deploy:**
```bash
# Databricks SQL endpoint is created via workspace configuration
databricks sql-endpoints create \
  --name "powerbi-direct-lake" \
  --cluster-size "Small" \
  --auto-stop-mins 30
```

**Dependencies:** Databricks workspace with Unity Catalog, Power BI Pro/Premium

---

## 4. Data Marketplace

**Location:** `platform/data_marketplace/`
**Fabric Equivalent:** Data Sharing / OneLake Data Hub

A self-service portal for discovering, requesting access to, and consuming data
products published across the organization.

**What it does:**
- Exposes a FastAPI-based catalog of data products with search and filtering
- Integrates with Purview for asset metadata and lineage
- Provides an access request and approval workflow (owner-based, time-bound)
- Tracks data product quality scores and SLA compliance
- Publishes usage metrics and consumer analytics

**Deploy:**
```bash
# Deploy the marketplace API
az deployment group create \
  --resource-group rg-platform \
  --template-file platform/data_marketplace/deploy/marketplace.bicep \
  --parameters platform/data_marketplace/deploy/params.json

# Initialize the catalog
python platform/data_marketplace/api/marketplace_api.py --init
```

**Dependencies:** Purview, API Management, Azure SQL or Cosmos DB for catalog state

---

## 5. Governance Framework

**Location:** `platform/governance/`
**Fabric Equivalent:** Purview-integrated governance

Extends Microsoft Purview with automated data governance workflows including
classification, sensitivity labeling, and master data management.

**What it does:**
- Automatically classifies new assets using built-in and custom classifiers
- Applies sensitivity labels (Public, Internal, Confidential, CUI, PHI)
- Captures lineage from ADF, Databricks, dbt, and Synapse
- Enforces data product contracts (schema, SLA, quality thresholds)
- Provides a master data management (MDM) framework for reference data

**Deploy:**
```bash
# Bootstrap Purview with glossary, classifications, and scan rules
python scripts/purview/bootstrap_catalog.py \
  --purview-account <purview-name> \
  --config governance/purview/catalog-config.yaml
```

**Dependencies:** Microsoft Purview, Key Vault

---

## 6. Multi-Synapse

**Location:** `platform/multi-synapse/`
**Fabric Equivalent:** Multi-workspace Synapse

Provides a shared Synapse Analytics environment with per-organization or
per-domain isolation using workspace-level RBAC and network segmentation.

**What it does:**
- Deploys multiple Synapse workspaces with shared managed VNet
- Configures per-workspace SQL pools (dedicated and serverless)
- Sets up cross-workspace linked services for shared data access
- Implements workspace-level RBAC and audit logging

**Deploy:**
```bash
az deployment group create \
  --resource-group rg-synapse \
  --template-file platform/multi-synapse/deploy/synapse.bicep \
  --parameters @platform/multi-synapse/deploy/params.json
```

**Dependencies:** DLZ VNet, ADLS Gen2, Key Vault

---

## 7. Metadata Framework

**Location:** `platform/metadata-framework/`
**Fabric Equivalent:** Metadata-driven Data Factory pipelines

Auto-generates ADF pipelines from YAML-based source registration metadata.
Register a source once and the framework creates copy activities, Bronze
ingestion, scheduling, and error handling automatically.

**What it does:**
- Reads source registration YAML files with connection, schema, schedule metadata
- Generates parameterized ADF pipeline JSON
- Deploys pipelines via ARM/Bicep or ADF REST API
- Supports incremental load watermarking and change data capture

**Configuration:**
```yaml
# Example source registration
source:
  name: usda_crop_data
  type: rest_api
  connection:
    base_url: https://quickstats.nass.usda.gov/api/api_GET
    auth_type: api_key
    key_vault_secret: nass-api-key
  schedule:
    frequency: daily
    time: "06:00"
  destination:
    container: bronze
    folder: usda/crop_data
    format: parquet
```

**Dependencies:** Azure Data Factory, Key Vault, ADLS Gen2

---

## 8. AI Integration

**Location:** `platform/ai_integration/`
**Fabric Equivalent:** Copilot / AI features

Provides domain-aware AI capabilities including document enrichment, entity
extraction, text summarization, and RAG-based question answering.

**What it does:**
- **Document Classifier** — Categorizes incoming documents using Azure OpenAI
- **Entity Extractor** — Extracts named entities (people, orgs, locations) from text
- **Text Summarizer** — Generates concise summaries of data product descriptions
- **RAG Patterns** — Retrieval-augmented generation over gold-layer data products
- **Model Serving** — Deploys custom ML models as API endpoints

**Deploy:**
```bash
pip install -r platform/ai_integration/requirements.txt

# Configure Azure OpenAI connection
export AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
export AZURE_OPENAI_API_KEY=<key>
export AZURE_OPENAI_DEPLOYMENT=gpt-4
```

**Dependencies:** Azure OpenAI, Azure ML (optional), ADLS Gen2

---

## 9. Shared Services

**Location:** `platform/shared-services/`
**Fabric Equivalent:** Shared utility functions

A library of reusable Azure Functions for common data operations used across
pipelines and platform services.

**Available Functions:**

| Function | Purpose |
|----------|---------|
| `detect_pii` | Scans text columns for PII using regex and AI classification |
| `validate_schema` | Validates incoming data against registered JSON/Avro schemas |
| `validate_quality` | Runs Great Expectations checkpoints and returns results |
| `send_teams_alert` | Posts formatted alerts to Microsoft Teams via webhook |

**Deploy:**
```bash
cd platform/shared-services/functions

# Deploy to Azure Functions
func azure functionapp publish <function-app-name> --python

# Or deploy via Bicep
az deployment group create \
  --resource-group rg-platform \
  --template-file platform/shared-services/deploy/functions.bicep
```

**Dependencies:** Azure Functions runtime, Key Vault, Teams webhook URL

---

## 10. OSS Alternatives

**Location:** `platform/oss-alternatives/`
**Fabric Equivalent:** N/A (fills Azure Government gaps)

Containerized open-source alternatives for services that are unavailable or
restricted in Azure Government at certain impact levels.

**Available Alternatives:**

| Service Gap | OSS Replacement | Deployment |
|-------------|----------------|-----------|
| Entra ID B2C (not in Gov) | Keycloak | Helm chart on AKS |
| AI Search (no IL5) | OpenSearch | Helm chart on AKS |
| Azure ML (no IL5) | MLflow + Kubeflow | Helm chart on AKS |
| Cognitive Services (limited) | Hugging Face Inference | Docker on AKS |

**Deploy:**
```bash
# Example: deploy Keycloak on AKS
helm install keycloak platform/oss-alternatives/keycloak/chart \
  --namespace identity \
  --values platform/oss-alternatives/keycloak/values-gov.yaml
```

**Dependencies:** AKS cluster, Azure Container Registry

---

## Service Dependency Map

Deploy platform services in this recommended order:

```
1. OneLake Pattern         (foundation — storage + metadata)
2. Shared Services         (reusable functions)
3. Governance Framework    (classification + lineage)
4. Metadata Framework      (auto-pipeline generation)
5. Data Marketplace        (discovery + access)
6. AI Integration          (enrichment + RAG)
7. Data Activator          (alerting + automation)
8. Direct Lake             (Power BI consumption)
9. Multi-Synapse           (if multi-org needed)
10. OSS Alternatives       (if Gov gaps exist)
```

## Configuration

All platform services read shared configuration from:

- **Key Vault** — Connection strings, API keys, secrets
- **App Configuration** — Feature flags, service endpoints, environment settings
- **Environment Variables** — Local development overrides

See the root [`.env.example`](../.env.example) for all required environment variables.
