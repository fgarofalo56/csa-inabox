# SAS Data Management Migration: SAS DI to ADF + dbt

**Audience:** Data Engineers, ETL Developers, SAS Administrators
**Purpose:** Migrate SAS Data Integration Studio jobs, DATA Step ETL pipelines, SAS libnames, and SAS format catalogs to Azure Data Factory (ADF), dbt, and Fabric Data Pipelines.

---

## 1. Overview

SAS Data Integration Studio (DI Studio) is SAS's visual ETL tool. It provides a drag-and-drop interface for building data transformation workflows that execute SAS DATA Step and PROC SQL code under the hood. The migration target is:

- **Azure Data Factory (ADF)** --- orchestration, scheduling, external data source connectivity
- **dbt (data build tool)** --- SQL-based transformations following the medallion pattern (bronze/silver/gold)
- **Fabric Data Pipelines** --- Fabric-native orchestration as ADF evolves into Fabric

| SAS DI concept                | Azure equivalent                                  | Notes                                              |
| ----------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| DI Studio Job                 | ADF Pipeline + dbt run                            | ADF orchestrates; dbt transforms                   |
| Transformations (visual)      | dbt SQL models                                    | SQL-first; Python for complex logic                |
| SAS Libname                   | Fabric lakehouse / ADLS Gen2 / ADF linked service | Data connections become cloud-native               |
| SAS Formats                   | dbt seed tables / Delta reference data            | User-defined formats become lookup joins           |
| SAS Scheduling (Platform LSF) | ADF Triggers / Fabric schedules                   | Event-driven or time-based triggers                |
| SAS Flow (visual data flow)   | ADF Data Flow (visual) / dbt model DAG            | dbt preferred; ADF Data Flow for visual-only teams |
| SAS Metadata Server           | Purview + Unity Catalog                           | Governance and lineage                             |
| Deployed Job                  | dbt model + ADF pipeline activity                 | CI/CD via Git; no manual deployment                |

---

## 2. DATA Step ETL to dbt models

### 2.1 Simple DATA Step to dbt SQL

**SAS:**

```sas
libname raw oracle path="//db-server:1521/PROD" user=&uid pw=&pwd;
libname staging '/sas/data/staging';

data staging.clean_orders;
  set raw.orders;
  where order_date >= '01JAN2025'd and status ne 'CANCELLED';
  if missing(ship_date) then ship_date = order_date + 7;
  order_year = year(order_date);
  order_quarter = qtr(order_date);
  amount_usd = amount * exchange_rate;
  length region $20;
  if country in ('US','CA','MX') then region = 'Americas';
  else if country in ('GB','DE','FR','IT','ES') then region = 'EMEA';
  else region = 'APAC';
  drop exchange_rate status;
run;
```

**dbt SQL model:**

```sql
-- models/staging/stg_clean_orders.sql
{{ config(materialized='view') }}

SELECT
    order_id,
    order_date,
    COALESCE(ship_date, DATE_ADD(order_date, 7)) AS ship_date,
    YEAR(order_date) AS order_year,
    QUARTER(order_date) AS order_quarter,
    amount * exchange_rate AS amount_usd,
    CASE
        WHEN country IN ('US', 'CA', 'MX') THEN 'Americas'
        WHEN country IN ('GB', 'DE', 'FR', 'IT', 'ES') THEN 'EMEA'
        ELSE 'APAC'
    END AS region,
    customer_id,
    product_id,
    country,
    order_date AS _loaded_at
FROM {{ source('oracle_prod', 'orders') }}
WHERE order_date >= '2025-01-01'
  AND status != 'CANCELLED'
```

```yaml
# models/staging/sources.yml
version: 2
sources:
    - name: oracle_prod
      description: Production Oracle database (replaces SAS LIBNAME raw)
      database: bronze_catalog
      schema: oracle_raw
      tables:
          - name: orders
            description: Raw orders table
            columns:
                - name: order_id
                  tests:
                      - not_null
                      - unique
```

### 2.2 Multi-step DATA Step to dbt model chain

**SAS:**

```sas
/* Step 1: Clean and standardize */
data work.step1;
  set raw.claims;
  claim_date = datepart(claim_datetime);
  format claim_date date9.;
  provider_id = compress(provider_id);
  diagnosis = upcase(diagnosis);
run;

/* Step 2: Enrich with lookup */
proc sql;
  create table work.step2 as
  select a.*, b.provider_name, b.specialty
  from work.step1 a
  left join reference.providers b
  on a.provider_id = b.provider_id;
quit;

/* Step 3: Aggregate */
proc summary data=work.step2 nway;
  class provider_id provider_name specialty claim_date;
  var amount;
  output out=staging.daily_claims(drop=_type_ _freq_)
    sum=total_amount n=claim_count mean=avg_amount;
run;
```

**dbt model chain:**

```sql
-- models/staging/stg_claims_clean.sql (Step 1)
{{ config(materialized='view') }}

SELECT
    claim_id,
    DATE(claim_datetime) AS claim_date,
    TRIM(provider_id) AS provider_id,
    UPPER(diagnosis) AS diagnosis,
    amount,
    patient_id
FROM {{ source('claims_raw', 'claims') }}
```

```sql
-- models/staging/stg_claims_enriched.sql (Step 2)
{{ config(materialized='view') }}

SELECT
    c.*,
    p.provider_name,
    p.specialty
FROM {{ ref('stg_claims_clean') }} c
LEFT JOIN {{ ref('seed_providers') }} p
    ON c.provider_id = p.provider_id
```

```sql
-- models/gold/fact_daily_claims.sql (Step 3)
{{ config(
    materialized='incremental',
    unique_key=['provider_id', 'claim_date'],
    incremental_strategy='merge'
) }}

SELECT
    provider_id,
    provider_name,
    specialty,
    claim_date,
    SUM(amount) AS total_amount,
    COUNT(*) AS claim_count,
    AVG(amount) AS avg_amount
FROM {{ ref('stg_claims_enriched') }}
{% if is_incremental() %}
WHERE claim_date >= DATE_SUB(CURRENT_DATE(), 3)
{% endif %}
GROUP BY provider_id, provider_name, specialty, claim_date
```

### 2.3 DATA Step with RETAIN to dbt window function

**SAS:**

```sas
proc sort data=work.transactions; by account_id transaction_date; run;

data work.running_balance;
  set work.transactions;
  by account_id;
  retain running_total 0;
  if first.account_id then running_total = 0;
  running_total + amount;
run;
```

**dbt:**

```sql
-- models/intermediate/int_running_balance.sql
SELECT
    account_id,
    transaction_date,
    amount,
    SUM(amount) OVER (
        PARTITION BY account_id
        ORDER BY transaction_date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS running_total
FROM {{ ref('stg_transactions') }}
```

### 2.4 DATA Step MERGE to dbt JOIN

**SAS:**

```sas
proc sort data=work.orders; by customer_id; run;
proc sort data=work.customers; by customer_id; run;

data work.enriched_orders;
  merge work.orders(in=a) work.customers(in=b);
  by customer_id;
  if a;  /* Left join */
  if a and b then match_flag = 'Y';
  else match_flag = 'N';
run;
```

**dbt:**

```sql
-- models/intermediate/int_enriched_orders.sql
SELECT
    o.*,
    c.customer_name,
    c.segment,
    c.region,
    CASE WHEN c.customer_id IS NOT NULL THEN 'Y' ELSE 'N' END AS match_flag
FROM {{ ref('stg_orders') }} o
LEFT JOIN {{ ref('stg_customers') }} c
    ON o.customer_id = c.customer_id
```

---

## 3. SAS Formats to dbt seed tables

### 3.1 PROC FORMAT to dbt seed

**SAS:**

```sas
proc format;
  value $stfmt
    'AL' = 'Alabama'    'AK' = 'Alaska'     'AZ' = 'Arizona'
    'AR' = 'Arkansas'   'CA' = 'California'  'CO' = 'Colorado'
    /* ... all 50 states ... */
    other = 'Unknown';

  value agegrp
    0 -< 18  = 'Minor'
    18 -< 35 = 'Young Adult'
    35 -< 55 = 'Middle Age'
    55 -< 65 = 'Pre-Retirement'
    65 - high = 'Senior';

  value $risk_score_fmt
    'A','B' = 'Low Risk'
    'C','D' = 'Medium Risk'
    'E','F' = 'High Risk';
run;
```

**dbt seed (CSV file):**

```csv
-- seeds/state_lookup.csv
state_code,state_name
AL,Alabama
AK,Alaska
AZ,Arizona
AR,Arkansas
CA,California
CO,Colorado
```

**dbt macro for range-based formats:**

```sql
-- macros/apply_age_group.sql
{% macro age_group(age_column) %}
  CASE
    WHEN {{ age_column }} < 18 THEN 'Minor'
    WHEN {{ age_column }} < 35 THEN 'Young Adult'
    WHEN {{ age_column }} < 55 THEN 'Middle Age'
    WHEN {{ age_column }} < 65 THEN 'Pre-Retirement'
    ELSE 'Senior'
  END
{% endmacro %}
```

**Usage in dbt model:**

```sql
-- models/staging/stg_patients.sql
SELECT
    patient_id,
    age,
    {{ age_group('age') }} AS age_group,
    state_code,
    s.state_name,
    risk_code,
    CASE
        WHEN risk_code IN ('A', 'B') THEN 'Low Risk'
        WHEN risk_code IN ('C', 'D') THEN 'Medium Risk'
        WHEN risk_code IN ('E', 'F') THEN 'High Risk'
        ELSE 'Unknown'
    END AS risk_category
FROM {{ source('raw', 'patients') }} p
LEFT JOIN {{ ref('state_lookup') }} s
    ON p.state_code = s.state_code
```

---

## 4. SAS scheduling to ADF triggers

### 4.1 SAS Platform LSF schedule to ADF trigger

**SAS (Platform LSF job definition):**

```
JOB daily_etl
  SCHEDULE daily 02:00
  COMMAND /opt/sas/config/deploy/daily_etl.sh
  PRE_EXEC check_source_data.sh
  POST_EXEC send_notification.sh
  MAX_RUNTIME 120
  RERUN_ON_FAILURE 2
```

**ADF Pipeline with trigger:**

```json
{
    "name": "pipeline_daily_etl",
    "properties": {
        "activities": [
            {
                "name": "check_source_data",
                "type": "Lookup",
                "typeProperties": {
                    "source": {
                        "type": "AzureSqlSource",
                        "sqlReaderQuery": "SELECT COUNT(*) AS row_count FROM source.daily_feed WHERE load_date = CAST(GETDATE() AS DATE)"
                    }
                }
            },
            {
                "name": "run_dbt_models",
                "type": "DatabricksNotebook",
                "dependsOn": [
                    {
                        "activity": "check_source_data",
                        "dependencyConditions": ["Succeeded"]
                    }
                ],
                "typeProperties": {
                    "notebookPath": "/pipelines/run_dbt",
                    "baseParameters": {
                        "dbt_command": "dbt run --select tag:daily",
                        "run_date": "@pipeline().TriggerTime"
                    }
                }
            },
            {
                "name": "run_dbt_tests",
                "type": "DatabricksNotebook",
                "dependsOn": [
                    {
                        "activity": "run_dbt_models",
                        "dependencyConditions": ["Succeeded"]
                    }
                ],
                "typeProperties": {
                    "notebookPath": "/pipelines/run_dbt",
                    "baseParameters": {
                        "dbt_command": "dbt test --select tag:daily"
                    }
                }
            }
        ]
    }
}
```

**ADF Schedule Trigger:**

```json
{
    "name": "trigger_daily_0200",
    "properties": {
        "type": "ScheduleTrigger",
        "typeProperties": {
            "recurrence": {
                "frequency": "Day",
                "interval": 1,
                "startTime": "2026-01-01T02:00:00Z",
                "timeZone": "Eastern Standard Time"
            }
        },
        "pipelines": [
            { "pipelineReference": { "referenceName": "pipeline_daily_etl" } }
        ]
    }
}
```

### 4.2 Event-driven processing

**SAS (file watcher):**

```sas
/* SAS Management Console file-arrival trigger */
/* Watches /sas/data/incoming/ for new files */
```

**ADF Event Trigger:**

```json
{
    "name": "trigger_file_arrival",
    "properties": {
        "type": "BlobEventsTrigger",
        "typeProperties": {
            "blobPathBeginsWith": "/incoming/",
            "events": ["Microsoft.Storage.BlobCreated"],
            "scope": "/subscriptions/.../storageAccounts/sastorageprod"
        },
        "pipelines": [
            {
                "pipelineReference": {
                    "referenceName": "pipeline_process_incoming"
                }
            }
        ]
    }
}
```

---

## 5. SAS dataset migration (SAS7BDAT to Delta)

### 5.1 Automated conversion

```python
# Convert SAS7BDAT files to Delta tables in Fabric lakehouse
import pandas as pd
import os

def migrate_sas_datasets(sas_data_path, target_catalog, target_schema):
    """Migrate all SAS7BDAT files in a directory to Delta tables.

    Args:
        sas_data_path: Path to SAS data directory (mounted via ANF or copied to ADLS)
        target_catalog: Unity Catalog catalog name
        target_schema: Schema (database) name
    """
    sas_files = [f for f in os.listdir(sas_data_path) if f.endswith('.sas7bdat')]

    for sas_file in sas_files:
        table_name = sas_file.replace('.sas7bdat', '').lower()
        file_path = os.path.join(sas_data_path, sas_file)

        print(f"Converting {sas_file} -> {target_catalog}.{target_schema}.{table_name}")

        # Read SAS dataset
        df = pd.read_sas(file_path, encoding='latin1')

        # Handle SAS date columns (SAS dates are days since 1960-01-01)
        date_cols = [col for col in df.columns if df[col].dtype == 'float64'
                     and col.lower().endswith(('_dt', '_date', 'date'))]
        for col in date_cols:
            df[col] = pd.to_datetime(df[col], unit='D', origin='1960-01-01',
                                      errors='coerce')

        # Write to Delta table
        spark_df = spark.createDataFrame(df)
        spark_df.write.mode("overwrite").saveAsTable(
            f"{target_catalog}.{target_schema}.{table_name}"
        )

        print(f"  Migrated {len(df)} rows, {len(df.columns)} columns")

# Run migration
migrate_sas_datasets(
    sas_data_path="/mnt/sas-data/staging/",
    target_catalog="bronze",
    target_schema="sas_migrated"
)
```

### 5.2 Validation queries

```sql
-- Validate row counts match between SAS and Delta
SELECT
    'sas_original' AS source,
    COUNT(*) AS row_count,
    COUNT(DISTINCT customer_id) AS distinct_customers,
    SUM(amount) AS total_amount,
    AVG(amount) AS avg_amount
FROM bronze.sas_migrated.clean_orders

UNION ALL

SELECT
    'dbt_model' AS source,
    COUNT(*) AS row_count,
    COUNT(DISTINCT customer_id) AS distinct_customers,
    SUM(amount_usd) AS total_amount,
    AVG(amount_usd) AS avg_amount
FROM gold.analytics.fact_orders
```

---

## 6. dbt project structure for SAS migration

```
dbt_sas_migration/
├── dbt_project.yml
├── packages.yml
├── seeds/
│   ├── state_lookup.csv          # SAS $stfmt format
│   ├── agency_lookup.csv         # SAS $agencyf format
│   ├── risk_categories.csv       # SAS $risk_score_fmt format
│   └── icd10_lookup.csv          # SAS diagnosis format catalog
├── models/
│   ├── staging/
│   │   ├── sources.yml           # SAS LIBNAME equivalents
│   │   ├── stg_claims_clean.sql  # DATA Step cleaning
│   │   ├── stg_orders_clean.sql
│   │   └── stg_patients.sql
│   ├── intermediate/
│   │   ├── int_enriched_orders.sql   # Multi-step DATA Step
│   │   ├── int_running_balance.sql   # RETAIN logic
│   │   └── int_claims_enriched.sql
│   └── gold/
│       ├── fact_daily_claims.sql     # PROC SUMMARY output
│       ├── fact_orders.sql
│       └── dim_providers.sql
├── macros/
│   ├── age_group.sql             # SAS value format -> macro
│   ├── fiscal_year.sql           # SAS INTNX equivalent
│   └── validate_output.sql       # Reconciliation helper
├── tests/
│   ├── assert_row_count_match.sql
│   └── assert_sum_match.sql
└── profiles.yml
```

### 6.1 dbt_project.yml

```yaml
name: sas_migration
version: "1.0.0"
config-version: 2
profile: fabric_lakehouse

model-paths: ["models"]
seed-paths: ["seeds"]
test-paths: ["tests"]
macro-paths: ["macros"]

models:
    sas_migration:
        staging:
            +materialized: view
            +schema: staging
        intermediate:
            +materialized: ephemeral
        gold:
            +materialized: incremental
            +schema: gold
            +tags: ["daily"]

seeds:
    sas_migration:
        +schema: reference
```

---

## 7. SAS autoexec.sas to dbt/Python configuration

**SAS autoexec.sas:**

```sas
/* Global settings applied at SAS session startup */
options mprint mlogic symbolgen;
options compress=yes reuse=yes;
options fmtsearch=(work library.formats);

/* Standard libnames */
libname raw '/sas/data/raw';
libname staging '/sas/data/staging';
libname gold '/sas/data/gold';
libname reference '/sas/data/reference';

/* Global macro variables */
%let env = PROD;
%let fiscal_year = 2026;
%let report_date = %sysfunc(today(), date9.);

/* Load standard format catalog */
libname fmtlib '/sas/formats';
options fmtsearch=(fmtlib);
```

**dbt equivalent (profiles.yml + dbt_project.yml):**

```yaml
# profiles.yml - replaces LIBNAME statements
fabric_lakehouse:
    target: prod
    outputs:
        prod:
            type: fabric
            workspace: analytics-prod
            lakehouse: gold_lakehouse
            threads: 4

# dbt_project.yml - replaces %LET variables
vars:
    env: "PROD"
    fiscal_year: 2026
    report_date: "{{ modules.datetime.date.today().isoformat() }}"
```

---

## 8. Migration checklist

| Step | SAS artifact            | Azure target                          | Validation                                       |
| ---- | ----------------------- | ------------------------------------- | ------------------------------------------------ |
| 1    | SAS datasets (SAS7BDAT) | Delta tables in Fabric lakehouse      | Row counts, column types, sample data comparison |
| 2    | PROC FORMAT catalogs    | dbt seed CSV files + macros           | Apply formats and compare values                 |
| 3    | Macro libraries         | Python functions + dbt macros         | Output comparison for each macro                 |
| 4    | LIBNAME statements      | dbt sources.yml + ADF linked services | Connectivity validation                          |
| 5    | DATA Step programs      | dbt SQL models                        | Row-level reconciliation                         |
| 6    | PROC SQL programs       | dbt SQL models                        | Output comparison                                |
| 7    | DI Studio jobs          | ADF pipelines + dbt DAGs              | End-to-end pipeline execution                    |
| 8    | Scheduling (LSF)        | ADF triggers + Fabric schedules       | Schedule validation; monitoring alerts           |
| 9    | autoexec.sas            | dbt profiles + project config         | Session configuration comparison                 |
| 10   | SAS logs                | Azure Monitor + dbt logs              | Error detection and notification                 |

---

**Maintainers:** csa-inabox core team
**Last updated:** 2026-04-30
