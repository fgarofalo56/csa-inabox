# SAP Analytics Migration to Azure

**Migrating SAP BW, BW/4HANA, SAP Analytics Cloud, and SAP reporting to Microsoft Fabric, Power BI, Databricks, and Azure AI.**

---

## Overview

SAP analytics is typically the most complex migration workstream because it touches every business domain. SAP BW systems accumulate decades of InfoProviders, process chains, queries, and reports that represent institutional knowledge. This guide provides a structured approach to migrating SAP analytics to the CSA-in-a-Box platform --- Microsoft Fabric, Power BI, Databricks, and Azure AI --- while preserving business continuity.

---

## 1. SAP BW / BW/4HANA migration to Fabric

### 1.1 SAP BW architecture mapped to Fabric

| SAP BW concept              | Fabric / CSA-in-a-Box equivalent           | Notes                                         |
| --------------------------- | ------------------------------------------ | --------------------------------------------- |
| InfoCube                    | Fabric Lakehouse Delta table (star schema) | Fact table + dimension tables in Delta format |
| DSO / ADSO                  | Fabric Lakehouse Delta table (staging)     | dbt incremental models replace DSO activation |
| InfoObject (master data)    | Fabric Lakehouse Delta table (dimension)   | Master data with text, hierarchy, attributes  |
| CompositeProvider           | Fabric SQL endpoint view / Databricks view | Virtual layer for cross-source queries        |
| Open Hub Destination        | ADF SAP BW connector                       | Data distribution / extraction                |
| InfoSource                  | dbt source definition                      | Source system mapping                         |
| Transformation              | dbt model (SQL)                            | Transformation logic in dbt                   |
| DTP (Data Transfer Process) | ADF pipeline activity                      | Data loading orchestration                    |
| Process Chain               | ADF pipeline                               | End-to-end orchestration                      |
| BEx Query                   | Power BI DAX measure + report              | Business queries                              |
| BW Workbook                 | Power BI report                            | Excel-based analysis → Power BI               |
| BW/4HANA HANA views         | Fabric SQL endpoint views                  | SQL-based analytical views                    |

### 1.2 Migration strategy: phase by InfoArea

```
BW Migration Phases (phased by InfoArea / domain)
├── Phase 1: Finance (FI/CO)
│   ├── Extract: ADF SAP BW connector → ADLS Gen2
│   ├── Transform: dbt models (bronze/silver/gold)
│   ├── Serve: Power BI financial reports
│   └── Decommission: Finance InfoProviders in BW
├── Phase 2: Supply Chain (MM/PP/WM)
│   ├── Extract: ADF SAP BW connector → ADLS Gen2
│   ├── Transform: dbt models
│   ├── Serve: Power BI supply chain dashboards
│   └── Decommission: SC InfoProviders
├── Phase 3: Sales (SD)
│   ├── Extract: ADF SAP BW connector → ADLS Gen2
│   ├── Transform: dbt models
│   ├── Serve: Power BI sales reports
│   └── Decommission: SD InfoProviders
├── Phase 4: HR (HCM/SuccessFactors)
│   └── [similar pattern]
└── Phase 5: Custom/industry-specific
    └── [similar pattern]
```

### 1.3 Data extraction from SAP BW

#### ADF SAP BW via Open Hub connector

```json
{
    "name": "ExtractBWFinanceData",
    "type": "Copy",
    "inputs": [
        {
            "referenceName": "SapBwOpenHub_FinanceCube",
            "type": "DatasetReference"
        }
    ],
    "outputs": [
        {
            "referenceName": "ADLS_Bronze_Finance",
            "type": "DatasetReference"
        }
    ],
    "typeProperties": {
        "source": {
            "type": "SapOpenHubSource",
            "excludeLastRequest": true,
            "baseRequestId": 123456
        },
        "sink": {
            "type": "ParquetSink",
            "storeSettings": {
                "type": "AzureBlobFSWriteSettings"
            }
        }
    }
}
```

#### dbt model for SAP finance data

```sql
-- models/gold/finance/gl_journal_entries.sql
-- Replaces SAP BW InfoCube 0FI_GL_14 (General Ledger Line Items)

{{ config(
    materialized='incremental',
    unique_key='journal_entry_key',
    partition_by='posting_date',
    tags=['finance', 'sap-bw-migration']
) }}

WITH source AS (
    SELECT * FROM {{ ref('silver_sap_acdoca') }}
    {% if is_incremental() %}
    WHERE posting_date > (SELECT MAX(posting_date) FROM {{ this }})
    {% endif %}
),

enriched AS (
    SELECT
        s.rclnt AS client,
        s.rldnr AS ledger,
        s.rbukrs AS company_code,
        s.gjahr AS fiscal_year,
        s.belnr AS document_number,
        s.docln AS line_item,
        s.racct AS gl_account,
        cc.gl_account_name,
        s.rcntr AS cost_center,
        s.rprctr AS profit_center,
        s.rhcur AS local_currency,
        s.hsl AS amount_local_currency,
        s.rwcur AS transaction_currency,
        s.wsl AS amount_transaction_currency,
        s.budat AS posting_date,
        s.bldat AS document_date,
        s.usnam AS user_name,
        CONCAT(s.rclnt, s.rldnr, s.rbukrs, s.gjahr, s.belnr, s.docln)
            AS journal_entry_key
    FROM source s
    LEFT JOIN {{ ref('dim_chart_of_accounts') }} cc
        ON s.racct = cc.gl_account_number
)

SELECT * FROM enriched
```

---

## 2. Fabric Mirroring for SAP (near-real-time)

Fabric Mirroring eliminates the need for traditional ETL from SAP. It provides near-real-time replication of SAP HANA tables to OneLake as Delta tables.

### 2.1 How Fabric Mirroring for SAP works

```
SAP HANA (Azure VM)                    Microsoft Fabric
┌───────────────────┐                  ┌────────────────────────┐
│  SAP Tables       │                  │  Mirrored Database     │
│  ├── VBAK (SO hdr)│──CDC Stream──►  │  ├── vbak (Delta)      │
│  ├── VBAP (SO itm)│──CDC Stream──►  │  ├── vbap (Delta)      │
│  ├── EKKO (PO hdr)│──CDC Stream──►  │  ├── ekko (Delta)      │
│  ├── EKPO (PO itm)│──CDC Stream──►  │  ├── ekpo (Delta)      │
│  ├── ACDOCA (FI)  │──CDC Stream──►  │  ├── acdoca (Delta)    │
│  └── MARA (matl)  │──CDC Stream──►  │  └── mara (Delta)      │
└───────────────────┘                  └────────────────────────┘
                                              │
                                              ▼
                                       ┌─────────────┐
                                       │  Power BI    │
                                       │  (Direct Lake│
                                       │   mode)      │
                                       └─────────────┘
```

### 2.2 Supported SAP tables for mirroring

| SAP module        | Key tables               | Typical row count | Notes                                          |
| ----------------- | ------------------------ | ----------------- | ---------------------------------------------- |
| Finance (FI)      | ACDOCA, BKPF, FAGLFLEXA  | 10M--500M         | Universal Journal is the primary finance table |
| Sales (SD)        | VBAK, VBAP, VBRK, VBRP   | 5M--100M          | Sales orders, billing documents                |
| Purchasing (MM)   | EKKO, EKPO, EBAN, EKBE   | 5M--50M           | Purchase orders, requisitions                  |
| Materials (MM)    | MARA, MARC, MARD, MAKT   | 500K--5M          | Material master data                           |
| Inventory (MM)    | MATDOC (S/4), MSEG (ECC) | 10M--200M         | Material movements                             |
| Production (PP)   | AFKO, AFPO, AFRU         | 1M--20M           | Production orders                              |
| Plant Maintenance | AUFK, AFIH, EQUI         | 500K--10M         | Maintenance orders, equipment                  |
| Master Data       | KNA1/BUT000, LFA1/BUT000 | 100K--2M          | Customer/vendor (Business Partner in S/4)      |
| HR (HCM)          | PA0001, PA0002, PA0008   | 50K--500K         | Personnel master (if not on SuccessFactors)    |

### 2.3 Configuration steps

See [Tutorial: SAP Data to Fabric](tutorial-sap-data-to-fabric.md) for step-by-step configuration.

---

## 3. SAP Analytics Cloud to Power BI

### 3.1 Feature mapping

| SAP Analytics Cloud feature | Power BI equivalent               | Parity | Notes                                                                                |
| --------------------------- | --------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| Stories (dashboards)        | Power BI reports                  | Full   | Richer visualization library in Power BI                                             |
| Models (imported data)      | Power BI semantic models          | Full   | Direct Lake eliminates import latency                                                |
| Planning (BPC integration)  | Power BI + Azure AI (limited)     | Medium | SAC planning has no direct PBI equivalent; evaluate Power BI writeback or retain BPC |
| Smart Predict               | Azure ML + Azure AI               | High   | ML capabilities exceed SAC Smart Predict                                             |
| Smart Discovery             | Power BI Quick Insights + Copilot | High   | Copilot provides natural-language insights                                           |
| Smart Assist                | Copilot for Power BI              | High   | AI-assisted report building                                                          |
| Data connectivity (live)    | DirectQuery / Direct Lake         | Full   | Direct Lake provides near-import performance with live data                          |
| Data connectivity (import)  | Import mode / Power Query         | Full   | Scheduled refresh                                                                    |
| Collaboration               | Microsoft Teams integration       | Full   | Power BI tabs in Teams channels                                                      |
| Mobile                      | Power BI Mobile app               | Full   | iOS, Android, Windows                                                                |
| Embedded analytics          | Power BI Embedded                 | Full   | Embed in custom applications                                                         |
| Multi-tenancy               | Power BI workspaces + RLS         | Full   | Row-level security for multi-tenant                                                  |

### 3.2 SAC story to Power BI report migration

| Migration step               | Tool / approach                                 | Notes                                        |
| ---------------------------- | ----------------------------------------------- | -------------------------------------------- |
| Export SAC model metadata    | SAC Content Network or manual export            | Document dimensions, measures, hierarchies   |
| Recreate data model          | Power BI Desktop (import from Fabric Lakehouse) | Use Direct Lake mode for SAP data in OneLake |
| Recreate visualizations      | Power BI Desktop                                | Manual recreation; no automated converter    |
| Recreate calculated measures | DAX measures in Power BI                        | SAC formulas → DAX conversion                |
| Recreate filters/prompts     | Power BI slicers and filters                    | Interactive filtering                        |
| Migrate users/permissions    | Entra ID groups → Power BI workspace roles      | RLS for row-level security                   |
| Validate numbers             | Side-by-side comparison                         | Compare SAC and Power BI output for key KPIs |

---

## 4. SAP BusinessObjects to Power BI

| SAP BO component         | Power BI equivalent         | Migration approach                       |
| ------------------------ | --------------------------- | ---------------------------------------- |
| Web Intelligence reports | Power BI reports            | Recreate using Power BI Desktop          |
| Crystal Reports          | Power BI paginated reports  | Use Power BI Report Builder (SSRS-based) |
| BO Universes             | Power BI semantic models    | Recreate semantic layer in Power BI      |
| BO Explorer              | Power BI Q&A + Copilot      | Natural-language query                   |
| Analysis for Office (AO) | Analyze in Excel (Power BI) | Similar Excel-based analysis experience  |
| BO Server (CMS)          | Power BI Service (cloud)    | SaaS; no server management               |
| BO scheduling            | Power BI scheduled refresh  | Automated report refresh                 |

---

## 5. SAP data to Azure AI (process intelligence)

CSA-in-a-Box enables AI-driven insights on SAP data that were never possible within the SAP ecosystem.

### 5.1 AI use cases on SAP data

| Use case                  | SAP data source                           | Azure AI service                        | Business value                                              |
| ------------------------- | ----------------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| Invoice anomaly detection | BSEG/ACDOCA, BKPF                         | Azure OpenAI + Anomaly Detector         | Detect duplicate payments, unusual amounts, timing patterns |
| Demand forecasting        | VBAK (sales orders), MATDOC (consumption) | Azure ML + Time Series Forecasting      | Predict demand for inventory optimization                   |
| Supplier risk scoring     | EKKO (POs), LFA1 (vendors), EKBE (GR/IR)  | Azure OpenAI + custom ML                | Score suppliers on delivery, quality, financial risk        |
| Contract analysis         | SAP document management (attachments)     | Azure AI Document Intelligence + OpenAI | Extract terms, obligations, renewal dates from contracts    |
| Predictive maintenance    | EQUI (equipment), AFIH (notifications)    | Azure ML + IoT integration              | Predict equipment failures from maintenance history         |
| Cash flow forecasting     | BSID/BSIK (open items), BKPF (postings)   | Azure ML + Time Series                  | Predict cash position for treasury management               |
| Customer churn prediction | KNA1 (customers), VBAK (orders)           | Azure ML                                | Identify at-risk customers from order patterns              |

### 5.2 Architecture for SAP AI

```
SAP HANA (Azure VM)
    │
    ▼ (Fabric Mirroring)
OneLake (Delta Tables)
    │
    ├──► Databricks (ML model training)
    │       │
    │       └──► Azure ML (model registry, deployment)
    │               │
    │               └──► Real-time inference endpoint
    │
    ├──► Azure OpenAI (prompt-based analytics)
    │       │
    │       └──► "Summarize AP aging for company code 1000"
    │            "Which suppliers have the highest late delivery rate?"
    │            "Detect anomalies in GL postings for Q4 2025"
    │
    └──► Power BI (AI visuals)
            │
            └──► Key Influencers, Decomposition Tree, Smart Narratives
```

### 5.3 Example: Invoice anomaly detection with Azure OpenAI

```python
# Databricks notebook: Invoice anomaly detection on SAP data
from pyspark.sql import SparkSession
from openai import AzureOpenAI

# Read SAP finance data from OneLake (Fabric Mirroring)
df_invoices = spark.read.format("delta").load(
    "abfss://sap-finance@onelake.dfs.fabric.microsoft.com/acdoca"
)

# Aggregate invoice patterns by vendor
vendor_stats = df_invoices.groupBy("lifnr").agg(
    F.count("*").alias("invoice_count"),
    F.avg("wsl").alias("avg_amount"),
    F.stddev("wsl").alias("stddev_amount"),
    F.max("wsl").alias("max_amount"),
    F.min("budat").alias("first_posting"),
    F.max("budat").alias("last_posting")
)

# Flag statistical anomalies
anomalies = vendor_stats.filter(
    (F.col("max_amount") > F.col("avg_amount") + 3 * F.col("stddev_amount"))
)

# Use Azure OpenAI to summarize findings
client = AzureOpenAI(
    azure_endpoint="https://aoai-sap-analytics.openai.azure.com/",
    api_version="2024-02-15-preview"
)

anomaly_summary = client.chat.completions.create(
    model="gpt-4o",
    messages=[{
        "role": "system",
        "content": "You are a financial analyst reviewing SAP invoice data."
    }, {
        "role": "user",
        "content": f"Analyze these vendor invoice anomalies and provide recommendations:\n{anomalies.toPandas().to_string()}"
    }]
)
```

---

## 6. Migration timeline for SAP analytics

| Phase          | Duration               | Activities                                                                               |
| -------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| Discovery      | 4--6 weeks             | Inventory BW InfoProviders, SAC stories, BO reports; categorize by domain and complexity |
| Pilot domain   | 6--8 weeks             | Migrate one InfoArea (e.g., Finance) end-to-end; validate with business users            |
| Parallel run   | 4--8 weeks             | Run old and new analytics in parallel; compare outputs                                   |
| Phased rollout | 3--6 months per domain | Migrate remaining domains (Supply Chain, Sales, HR, etc.)                                |
| Decommission   | 4--8 weeks             | Shut down BW/SAC after all domains migrated                                              |

---

**Last updated:** 2026-04-30
**Maintainers:** CSA-in-a-Box core team
**Related:** [Feature Mapping](feature-mapping-complete.md) | [Tutorial: SAP Data to Fabric](tutorial-sap-data-to-fabric.md) | [Integration Migration](integration-migration.md)
