[← Platform Components](../README.md)

# Platform Functions — Consolidated Azure Functions namespace

> **Last Updated:** 2026-04-19 | **Status:** Active | **Audience:** Platform Engineers

> **Note (2026-04-19):** This directory consolidates the former
> `csa_platform/shared_services/` (v1-style Azure Functions app with
> PII / schema / quality / Teams validators) and `domains/sharedServices/`
> (v2 Python Functions: `aiEnrichment`, `eventProcessing`,
> `secretRotation` + `common/` helpers) into a single canonical
> namespace (CSA-0127 / AQ-0026). Library helpers live under `common/`;
> each deployable function app is a sibling top-level subdirectory.
> The former `csa_platform/shared_services/functions/` v1 app now lives
> under `validation/`.

> [!NOTE]
> **TL;DR:** Reusable Azure Functions shared across all data landing zones — covering data validation, AI enrichment, event processing, secret rotation, and notifications — all exposed via Azure API Management gateway.

Reusable Azure Functions, Container Apps, and API patterns that can be
shared across all data landing zones in the CSA-in-a-Box platform.

## Table of Contents

- [Services](#services)
- [API Management Gateway](#api-management-gateway)
- [Deployment](#deployment)
- [Directory Structure](#directory-structure)
- [Related Documentation](#related-documentation)

---

## ✨ Services

### 🧪 1. Data Validation Functions

Reusable validation logic deployed as Azure Functions:

| Function | Trigger | Purpose |
|---|---|---|
| `validate-schema` | HTTP | Validate data against JSON Schema or YAML contract |
| `validate-quality` | HTTP | Run quality rules (completeness, range, regex) |
| `detect-pii` | HTTP | Scan text fields for PII patterns |
| `validate-geospatial` | HTTP | Validate lat/lon coordinates and boundaries |

### 🔄 2. Format Conversion Functions

| Function | Input | Output |
|---|---|---|
| `csv-to-delta` | CSV blob trigger | Delta Lake table |
| `json-to-parquet` | JSON blob trigger | Parquet files |
| `xml-to-json` | XML blob trigger | JSON files |
| `excel-to-csv` | XLSX blob trigger | CSV files |
| `fhir-to-delta` | FHIR JSON | Delta Lake (for Tribal Health) |

### ⚡ 3. AI Enrichment Functions

| Function | Purpose |
|---|---|
| `extract-entities` | Named entity recognition via Azure AI Language |
| `classify-document` | Document classification via Azure OpenAI |
| `summarize-text` | Text summarization via Azure OpenAI |
| `detect-language` | Language detection via Azure AI Translator |
| `generate-embeddings` | Vector embeddings via Azure OpenAI |

### 📊 4. Notification Functions

| Function | Purpose |
|---|---|
| `send-teams-alert` | Send alerts to Microsoft Teams channels |
| `send-email-alert` | Send email notifications via SendGrid/Logic Apps |
| `create-incident` | Create incidents in ServiceNow/PagerDuty |
| `update-dashboard` | Push metrics to Grafana/Power BI |

---

## 🔌 API Management Gateway

All shared functions are discoverable through Azure API Management:

```text
https://csa-apim.azure-api.net/
├── /validation/
│   ├── POST /schema     → validate-schema
│   ├── POST /quality    → validate-quality
│   └── POST /pii        → detect-pii
├── /conversion/
│   ├── POST /csv-to-delta   → csv-to-delta
│   └── POST /json-to-parquet → json-to-parquet
├── /enrichment/
│   ├── POST /entities   → extract-entities
│   ├── POST /classify   → classify-document
│   └── POST /embeddings → generate-embeddings
└── /notifications/
    ├── POST /teams      → send-teams-alert
    └── POST /email      → send-email-alert
```

---

## 📦 Deployment

```bash
# Deploy all shared functions
func azure functionapp publish csa-shared-functions

# Deploy API Management
az deployment group create \
  --template-file deploy/apim.bicep \
  --parameters deploy/params.json
```

---

## 📁 Directory Structure

```text
csa_platform/functions/
├── README.md
├── common/                         # Shared helpers (build_health_response, build_error_response, MAX_BLOB_SIZE)
├── validation/                     # v1 Functions app (PII / schema / quality / Teams alerts)
│   ├── host.json
│   ├── requirements.txt
│   ├── detect_pii/
│   ├── send_teams_alert/
│   ├── validate_quality/
│   ├── validate_schema/
│   └── tests/
├── aiEnrichment/                   # v2 Python Functions app
│   └── functions/
├── eventProcessing/                # v2 Python Functions app
│   └── functions/
└── secretRotation/                 # v2 Python Functions app
    └── functions/
```

---

## 🔗 Related Documentation

- [Platform Components](../README.md) — Platform component index
- [Platform Services](../../docs/PLATFORM_SERVICES.md) — Detailed platform service descriptions
- [Architecture](../../docs/ARCHITECTURE.md) — Overall system architecture
- [Governance](../governance/README.md) — Purview automation and classification
- [Data Activator](../data_activator/README.md) — Event-driven alerting engine
