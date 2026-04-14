# Shared Services — Reusable Function Library

Reusable Azure Functions, Container Apps, and API patterns that can be
shared across all data landing zones in the CSA-in-a-Box platform.

## Services

### 1. Data Validation Functions

Reusable validation logic deployed as Azure Functions:

| Function | Trigger | Purpose |
|---|---|---|
| `validate-schema` | HTTP | Validate data against JSON Schema or YAML contract |
| `validate-quality` | HTTP | Run quality rules (completeness, range, regex) |
| `detect-pii` | HTTP | Scan text fields for PII patterns |
| `validate-geospatial` | HTTP | Validate lat/lon coordinates and boundaries |

### 2. Format Conversion Functions

| Function | Input | Output |
|---|---|---|
| `csv-to-delta` | CSV blob trigger | Delta Lake table |
| `json-to-parquet` | JSON blob trigger | Parquet files |
| `xml-to-json` | XML blob trigger | JSON files |
| `excel-to-csv` | XLSX blob trigger | CSV files |
| `fhir-to-delta` | FHIR JSON | Delta Lake (for Tribal Health) |

### 3. AI Enrichment Functions

| Function | Purpose |
|---|---|
| `extract-entities` | Named entity recognition via Azure AI Language |
| `classify-document` | Document classification via Azure OpenAI |
| `summarize-text` | Text summarization via Azure OpenAI |
| `detect-language` | Language detection via Azure AI Translator |
| `generate-embeddings` | Vector embeddings via Azure OpenAI |

### 4. Notification Functions

| Function | Purpose |
|---|---|
| `send-teams-alert` | Send alerts to Microsoft Teams channels |
| `send-email-alert` | Send email notifications via SendGrid/Logic Apps |
| `create-incident` | Create incidents in ServiceNow/PagerDuty |
| `update-dashboard` | Push metrics to Grafana/Power BI |

## API Management Gateway

All shared functions are discoverable through Azure API Management:

```
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

## Deployment

```bash
# Deploy all shared functions
func azure functionapp publish csa-shared-functions

# Deploy API Management
az deployment group create \
  --template-file deploy/apim.bicep \
  --parameters deploy/params.json
```

## Directory Structure

```
platform/shared-services/
├── README.md
├── functions/
│   ├── host.json
│   ├── requirements.txt
│   ├── validate_schema/
│   ├── validate_quality/
│   ├── detect_pii/
│   ├── csv_to_delta/
│   ├── json_to_parquet/
│   ├── extract_entities/
│   └── send_teams_alert/
├── container-apps/
│   ├── stateful-processor/    # Long-running data processing
│   └── batch-orchestrator/    # Batch job orchestration
├── apim/
│   ├── policies/              # API Management policies
│   └── products/              # API products (internal, external)
└── deploy/
    ├── functions.bicep
    ├── apim.bicep
    └── params.json
```
