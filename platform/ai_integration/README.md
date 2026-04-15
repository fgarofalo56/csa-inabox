# AI Integration — Data Landing Zone AI Enrichment

> **Last Updated:** 2026-04-14 | **Status:** Active | **Audience:** Platform Engineers

## Table of Contents

- [Capabilities](#capabilities)
  - [RAG Pattern — Document Intelligence](#1-rag-pattern--document-intelligence)
  - [Embeddings Pipeline](#2-embeddings-pipeline)
  - [AI-Enriched Data Pipelines](#3-ai-enriched-data-pipelines)
  - [Model Serving](#4-model-serving)
- [Directory Structure](#directory-structure)
- [Integration with Data Landing Zones](#integration-with-data-landing-zones)
- [Azure Government](#azure-government)
- [Quick Start](#quick-start)

This directory provides patterns for integrating Azure AI services with the
CSA-in-a-Box data platform. Every data landing zone can leverage AI for
enrichment, classification, and analysis.

## Capabilities

### 1. RAG Pattern — Document Intelligence

Retrieve-Augment-Generate over your data lake:

```text
Documents (ADLS)  →  Azure AI Document Intelligence  →  Chunks
                          ↓
                    Text Embedding (Azure OpenAI)
                          ↓
                    Vector Store (AI Search / pgvector)
                          ↓
                    Query Engine (Azure OpenAI GPT-4)
```

**Use Cases:**
- Query regulatory documents in natural language
- Search across unstructured data in the data lake
- Auto-generate data documentation from schema metadata

### 2. Embeddings Pipeline

Convert any text data to vector embeddings for similarity search:

```python
# Embedding pipeline configuration
embedding_config:
  model: text-embedding-3-small
  dimensions: 1536
  batch_size: 100
  source: adls://silver/documents/
  target: ai-search-index or pgvector
```

### 3. AI-Enriched Data Pipelines

Inject AI capabilities into your ADF/Databricks pipelines:

| Enrichment | Azure Service | Input | Output |
|---|---|---|---|
| Entity Extraction | Azure AI Language | Text fields | Extracted entities (JSON) |
| Classification | Azure OpenAI | Records | Category labels |
| Summarization | Azure OpenAI | Long text | Summaries |
| Translation | Azure AI Translator | Multi-language | English |
| PII Detection | Azure AI Language | Any text | PII locations + redacted |
| Sentiment | Azure AI Language | Customer feedback | Sentiment scores |
| Anomaly Detection | Azure AI Anomaly Detector | Time series | Anomaly flags |

### 4. Model Serving

Deploy ML models as Azure ML endpoints per data domain:

```text
┌─────────────────────────────────────────────────────┐
│                Azure ML Workspace                    │
│                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │ USDA Models  │  │ DOT Models  │  │ EPA Models  │ │
│  │ - Crop Yield │  │ - Crash     │  │ - AQI       │ │
│  │ - Food Safety│  │   Severity  │  │   Forecast  │ │
│  │ - SNAP Pred. │  │ - Infra     │  │ - Water     │ │
│  │              │  │   Priority  │  │   Quality   │ │
│  └──────┬───────┘  └──────┬──────┘  └──────┬──────┘ │
│         └────────────┬─────┘               │         │
│                      │                      │         │
│              ┌───────┴──────────────────────┘        │
│              │    Azure ML Endpoints                  │
│              │    (Managed Online Endpoints)          │
│              └───────────────────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

## Directory Structure

```text
platform/ai_integration/
├── README.md                    # This file
├── rag/
│   ├── rag_pipeline.py          # RAG ingestion pipeline
│   ├── query_engine.py          # Natural language query
│   └── config.yaml              # RAG configuration
├── embeddings/
│   ├── embedding_pipeline.py    # Batch embedding generator
│   └── vector_store.py          # AI Search / pgvector client
├── enrichment/
│   ├── entity_extraction.py     # Named entity extraction
│   ├── pii_detection.py         # PII detection and redaction
│   ├── classification.py        # AI-powered classification
│   └── summarization.py         # Document summarization
├── serving/
│   ├── deploy_model.py          # Azure ML model deployment
│   ├── model_registry.py        # MLflow model registry
│   └── templates/               # Model serving templates
├── prompts/
│   ├── data_analysis.md         # Prompts for data analysis
│   ├── documentation.md         # Auto-documentation prompts
│   └── quality_assessment.md    # Data quality prompts
└── deploy/
    ├── ai-services.bicep        # IaC for AI services
    └── params.json              # Deployment parameters
```

## Integration with Data Landing Zones

AI services integrate at three points in the data pipeline:

1. **Bronze → Silver (Enrichment):** PII detection, entity extraction,
   classification applied during data cleansing
2. **Silver → Gold (Analysis):** ML model inference, predictions, scoring
   applied during analytics model building
3. **Gold → Consumer (Serving):** RAG queries, natural language interfaces,
   AI-powered dashboards

## Azure Government

All AI services used here are GA in Azure Government:
- Azure OpenAI: GA (GPT-4, embeddings)
- Azure AI Search: GA
- Azure ML: GA
- Azure AI Language: GA
- Azure AI Document Intelligence: GA

## Quick Start

```bash
# Set up AI services
az deployment group create \
  --template-file deploy/ai-services.bicep \
  --parameters deploy/params.json

# Run embedding pipeline
python embeddings/embedding_pipeline.py \
  --source adls://silver/documents/ \
  --model text-embedding-3-small \
  --target ai-search

# Query with RAG
python rag/query_engine.py \
  --query "What are the USDA crop yield trends for corn in Iowa?"
```

---

## Related Documentation

- [Platform Components](../README.md) - Platform component index
- [Platform Services](../../docs/PLATFORM_SERVICES.md) - Detailed platform service descriptions
- [Architecture](../../docs/ARCHITECTURE.md) - Overall system architecture
- [Data Marketplace](../data_marketplace/README.md) - Data product discovery and access
