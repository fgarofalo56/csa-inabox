// Healthcare Population Health bundle — FHIR-on-Lakehouse medallion + XGBoost
// readmission-risk model. Sourced from examples/healthcare-clinical/.
import type { AppBundle } from './types';

const bundle: AppBundle = {
  appId: 'app-healthcare-popmgt',
  intro:
    '# Healthcare Population Health\n\n' +
    'FHIR-on-Lakehouse + 30-day readmission risk scoring + Power BI patient dashboards. ' +
    'HIPAA-aligned (Safe Harbor de-identification, BAA-required for live PHI). The bundled ' +
    'lakehouse follows a bronze/silver/gold medallion pattern keyed to FHIR R4 Patient, ' +
    'Encounter, Condition, and Observation resources. The bundled ML model is a gradient ' +
    'boosted trees (XGBoost) classifier that scores 30-day inpatient readmission probability ' +
    'and is logged to MLflow on every training run.\n\n' +
    '> **No real PHI.** All sample data is synthetic and satisfies HIPAA Safe Harbor ' +
    '(45 CFR 164.514(b)(2)). Complete a HIPAA security risk assessment and execute BAAs ' +
    'with all cloud providers before loading real patient data.\n\n' +
    '## How install materializes this content\n\n' +
    'This bundle does **not** leave its starter content as inert text. At install time:\n\n' +
    '- **Lakehouse** — the medallion `deltaTables[]` below carry real DDL + `sampleRows`. ' +
    'The lakehouse provisioner lands each table\'s rows as a seed CSV in OneLake and calls ' +
    'the Fabric **Load Table** API, so `bronze.patients`, `bronze.encounters`, ' +
    '`bronze.diagnoses`, `silver.dim_patients`, `silver.fct_encounters`, and ' +
    '`gold.rpt_readmission_risk` exist as **queryable Delta tables** the moment install ' +
    'finishes. The Lakehouse editor is a live ADLS Gen2 / OneLake browser — it shows ' +
    'those real seeded tables (not the bundle JSON). The 3 declared shortcuts ' +
    '(`cms-public-data`, `npi-registry`, `ahrq-ccs-mapping`) are managed live in the ' +
    'editor\'s Shortcuts tab against the real public REST targets listed below.\n' +
    '- **ML model** — the `trainingCode` below is a complete, runnable MLflow script. The ' +
    'ml-model provisioner imports it as a Databricks notebook and runs it, which **trains ' +
    'the XGBoost classifier and registers it** in the MLflow / Unity Catalog model registry ' +
    '(`registered_model_name`). The ML Model editor then binds to that **real registered ' +
    'model** to browse versions and deploy a real-time endpoint — the seeded ' +
    'hyperparameters / features / target drive the run that produces it.\n\n' +
    '> If Databricks or a Fabric workspace is not yet wired for this deployment, install ' +
    'still creates the workspace items and the provisioner returns a precise remediation ' +
    'gate (the exact `LOOM_DATABRICKS_HOSTNAME` / `LOOM_DEFAULT_FABRIC_WORKSPACE` env var or ' +
    'RBAC role to set) instead of pretending the data/model was produced.',
  sourceDocs: [
    'examples/healthcare-clinical/README.md',
    'examples/healthcare-clinical/contracts/readmission-risk.yaml',
    'examples/healthcare-clinical/domains/bronze/stg_patients.sql',
    'examples/healthcare-clinical/domains/bronze/stg_encounters.sql',
    'examples/healthcare-clinical/domains/bronze/stg_diagnoses.sql',
    'examples/healthcare-clinical/domains/silver/dim_patients.sql',
    'examples/healthcare-clinical/domains/silver/dim_diagnoses.sql',
    'examples/healthcare-clinical/domains/silver/fct_encounters.sql',
    'examples/healthcare-clinical/domains/gold/rpt_readmission_risk.sql',
    'examples/healthcare-clinical/domains/gold/rpt_quality_measures.sql',
    'examples/healthcare-clinical/domains/gold/rpt_los_analysis.sql',
  ],
  items: [
    {
      itemType: 'lakehouse',
      displayName: 'FHIR Clinical Lakehouse',
      description:
        'FHIR R4 medallion lakehouse. Bronze: raw EHR/FHIR exports. Silver: deduplicated ' +
        'patients/encounters/diagnoses with LOS + 30-day readmission flags + CCS categories. ' +
        'Gold: readmission risk scores, CMS quality measures, length-of-stay analysis.',
      learnDoc: 'examples/healthcare-clinical',
      content: {
        kind: 'lakehouse',
        folders: [
          {
            path: 'bronze/patient/',
            description:
              'Raw FHIR Patient resources (de-identified). Age generalized to age_group, ZIP truncated to 3-digit prefix per HIPAA Safe Harbor 45 CFR 164.514(b)(2).',
          },
          {
            path: 'bronze/encounter/',
            description:
              'Raw FHIR Encounter resources from ADT feeds + EHR exports. Admit/discharge dates retained at month granularity. Includes facility, department, encounter_type, discharge_disposition, payer, DRG.',
          },
          {
            path: 'bronze/condition/',
            description:
              'Raw FHIR Condition resources with ICD-10 diagnosis codes from EHR + claims. Sequence preserved for primary vs. secondary diagnosis classification.',
          },
          {
            path: 'bronze/observation/',
            description:
              'Raw FHIR Observation resources — vitals, labs, scoring instruments (e.g., LACE, NEWS2). Bronze keeps original LOINC codes and units.',
          },
          {
            path: 'silver/dim_patients/',
            description:
              'Patient dimension enriched with derived risk factors: age-based risk tier (Standard/Moderate/Elevated/High/Critical), chronic-complex flag (>= 5 distinct diagnoses), prior utilization counts.',
          },
          {
            path: 'silver/dim_diagnoses/',
            description:
              'Diagnosis dimension. ICD-10 codes mapped to clinical domain (Circulatory, Respiratory, Endocrine, etc.) and CCS-like category (Heart Failure, COPD, Pneumonia, Type 2 Diabetes, Kidney Disease, etc.).',
          },
          {
            path: 'silver/fct_encounters/',
            description:
              'Encounter fact with derived length_of_stay_days, is_30day_readmission flag (self-join on patient_id within 30d of discharge), days_to_next_admission.',
          },
          {
            path: 'gold/rpt_readmission_risk/',
            description:
              'Per-encounter 30-day readmission risk scores (0-100) with risk tier (Low/Moderate/High/Critical) and top contributing factors. Daily refresh.',
          },
          {
            path: 'gold/rpt_quality_measures/',
            description:
              'CMS readmission rates by condition + facility + measure_period. Joined to national benchmark table; tagged Better/At/Worse than expected.',
          },
          {
            path: 'gold/rpt_los_analysis/',
            description:
              'Length-of-stay analytics by DRG + facility + period. Includes percentile_approx(0.5), variance vs. expected LOS, payer mix.',
          },
        ],
        deltaTables: [
          {
            name: 'bronze.patients',
            ddl:
              "CREATE TABLE bronze.patients (\n" +
              "  patient_id STRING NOT NULL COMMENT 'De-identified patient identifier',\n" +
              "  age_group STRING COMMENT 'Age band (18-34, 35-49, 50-64, 65-74, 75-84, 85+) per HIPAA Safe Harbor',\n" +
              "  gender STRING COMMENT 'FHIR administrative gender code',\n" +
              "  zip_3 STRING COMMENT 'Geographic generalization — 3-digit ZIP prefix only',\n" +
              "  race_ethnicity STRING COMMENT 'OMB race/ethnicity rollup',\n" +
              "  primary_language STRING COMMENT 'ISO 639-1 language code',\n" +
              "  insurance_type STRING COMMENT 'Medicare, Medicaid, Commercial, Uninsured, etc.',\n" +
              "  ingested_at TIMESTAMP NOT NULL,\n" +
              "  source_file STRING\n" +
              ") USING DELTA\n" +
              "PARTITIONED BY (insurance_type)\n" +
              "TBLPROPERTIES ('delta.appendOnly' = 'false', 'delta.enableChangeDataFeed' = 'true');",
            sampleRows: [
              ['PAT-1001', '75-84', 'Male', '200', 'White', 'en', 'Medicare'],
              ['PAT-1002', '65-74', 'Female', '201', 'Black', 'en', 'Medicaid'],
              ['PAT-1003', '85+', 'Female', '220', 'White', 'en', 'Medicare'],
              ['PAT-1004', '50-64', 'Male', '210', 'Hispanic', 'es', 'Commercial'],
              ['PAT-1005', '18-34', 'Male', '203', 'Asian', 'en', 'Uninsured'],
            ],
          },
          {
            name: 'bronze.encounters',
            ddl:
              "CREATE TABLE bronze.encounters (\n" +
              "  encounter_id STRING NOT NULL,\n" +
              "  patient_id STRING NOT NULL,\n" +
              "  admit_date DATE NOT NULL COMMENT 'Month-only granularity per HIPAA Safe Harbor',\n" +
              "  discharge_date DATE NOT NULL,\n" +
              "  facility STRING NOT NULL,\n" +
              "  department STRING,\n" +
              "  encounter_type STRING COMMENT 'Inpatient | Observation | Emergency | Outpatient',\n" +
              "  discharge_disposition STRING COMMENT 'Home | SNF | Rehab | Transfer | Expired',\n" +
              "  payer STRING,\n" +
              "  drg_code STRING COMMENT 'CMS MS-DRG code',\n" +
              "  ingested_at TIMESTAMP NOT NULL,\n" +
              "  source_file STRING\n" +
              ") USING DELTA\n" +
              "PARTITIONED BY (discharge_date)\n" +
              "TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true');",
            sampleRows: [
              ['ENC-0001', 'PAT-1001', '2025-01-01', '2025-01-01', 'General Hospital A', 'Cardiology', 'Inpatient', 'Home', 'Medicare', '291'],
              ['ENC-0002', 'PAT-1002', '2025-01-01', '2025-01-01', 'General Hospital A', 'Pulmonology', 'Inpatient', 'Home', 'Medicaid', '190'],
              ['ENC-0003', 'PAT-1003', '2025-02-01', '2025-02-01', 'Regional Medical Center', 'General Medicine', 'Inpatient', 'SNF', 'Medicare', '194'],
              ['ENC-0004', 'PAT-1001', '2025-02-01', '2025-02-01', 'General Hospital A', 'Cardiology', 'Inpatient', 'Home', 'Medicare', '291'],
              ['ENC-0011', 'PAT-1003', '2025-03-01', '2025-03-01', 'Regional Medical Center', 'General Medicine', 'Inpatient', 'Home', 'Medicare', '194'],
            ],
          },
          {
            name: 'bronze.diagnoses',
            ddl:
              "CREATE TABLE bronze.diagnoses (\n" +
              "  encounter_id STRING NOT NULL,\n" +
              "  icd10_code STRING NOT NULL COMMENT 'ICD-10-CM diagnosis code',\n" +
              "  diagnosis_type STRING COMMENT 'Admitting | Primary | Secondary',\n" +
              "  sequence INT COMMENT '1 = primary, 2+ = secondary',\n" +
              "  description STRING,\n" +
              "  present_on_admit STRING COMMENT 'POA indicator: Y | N | U | W',\n" +
              "  ingested_at TIMESTAMP NOT NULL,\n" +
              "  source_file STRING\n" +
              ") USING DELTA\n" +
              "TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true');",
            sampleRows: [
              ['ENC-0001', 'I50.9', 'Admitting', 1, 'Heart failure unspecified', 'Y'],
              ['ENC-0001', 'E11.9', 'Secondary', 2, 'Type 2 diabetes without complications', 'Y'],
              ['ENC-0002', 'J44.1', 'Admitting', 1, 'COPD with acute exacerbation', 'Y'],
              ['ENC-0003', 'J18.9', 'Admitting', 1, 'Pneumonia unspecified organism', 'Y'],
              ['ENC-0003', 'N18.3', 'Secondary', 2, 'Chronic kidney disease stage 3', 'Y'],
            ],
          },
          {
            name: 'silver.dim_patients',
            ddl:
              "CREATE TABLE silver.dim_patients (\n" +
              "  patient_id STRING NOT NULL,\n" +
              "  age_group STRING,\n" +
              "  gender STRING,\n" +
              "  zip_3 STRING,\n" +
              "  race_ethnicity STRING,\n" +
              "  primary_language STRING,\n" +
              "  insurance_type STRING,\n" +
              "  total_encounters INT NOT NULL,\n" +
              "  inpatient_count INT NOT NULL,\n" +
              "  distinct_diagnosis_count INT NOT NULL,\n" +
              "  last_discharge_date DATE,\n" +
              "  age_risk_tier STRING COMMENT 'Standard | Moderate | Elevated | High | Critical',\n" +
              "  is_chronic_complex BOOLEAN COMMENT 'TRUE when distinct_diagnosis_count >= 5',\n" +
              "  updated_at TIMESTAMP NOT NULL\n" +
              ") USING DELTA\n" +
              "PARTITIONED BY (age_risk_tier)\n" +
              "TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true');",
            sampleRows: [
              ['PAT-1001', '75-84', 'Male', '200', 'White', 'en', 'Medicare', 2, 2, 2, '2025-02-01', 'High', false],
              ['PAT-1003', '85+', 'Female', '220', 'White', 'en', 'Medicare', 2, 2, 3, '2025-03-01', 'Critical', false],
              ['PAT-1008', '75-84', 'Female', '218', 'Black', 'en', 'Medicare', 2, 2, 5, '2025-05-01', 'High', true],
            ],
          },
          {
            name: 'silver.fct_encounters',
            ddl:
              "CREATE TABLE silver.fct_encounters (\n" +
              "  encounter_id STRING NOT NULL,\n" +
              "  patient_id STRING NOT NULL,\n" +
              "  admit_date DATE NOT NULL,\n" +
              "  discharge_date DATE NOT NULL,\n" +
              "  facility STRING NOT NULL,\n" +
              "  department STRING,\n" +
              "  encounter_type STRING,\n" +
              "  discharge_disposition STRING,\n" +
              "  payer STRING,\n" +
              "  drg_code STRING,\n" +
              "  length_of_stay_days INT COMMENT 'DATEDIFF(discharge_date, admit_date)',\n" +
              "  is_30day_readmission BOOLEAN COMMENT 'TRUE iff patient had any subsequent inpatient admit within 30d of discharge',\n" +
              "  days_to_next_admission INT COMMENT 'NULL when no readmission',\n" +
              "  ingested_at TIMESTAMP NOT NULL,\n" +
              "  processed_at TIMESTAMP NOT NULL\n" +
              ") USING DELTA\n" +
              "PARTITIONED BY (discharge_date)\n" +
              "TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true');",
            sampleRows: [
              ['ENC-0001', 'PAT-1001', '2025-01-01', '2025-01-01', 'General Hospital A', 'Cardiology', 'Inpatient', 'Home', 'Medicare', '291', 4, true, 31],
              ['ENC-0003', 'PAT-1003', '2025-02-01', '2025-02-01', 'Regional Medical Center', 'General Medicine', 'Inpatient', 'SNF', 'Medicare', '194', 5, true, 28],
              ['ENC-0009', 'PAT-1008', '2025-04-01', '2025-04-01', 'Community Hospital B', 'Cardiology', 'Inpatient', 'Home', 'Medicare', '291', 6, true, 30],
            ],
          },
          {
            name: 'gold.rpt_readmission_risk',
            ddl:
              "CREATE TABLE gold.rpt_readmission_risk (\n" +
              "  encounter_id STRING NOT NULL,\n" +
              "  patient_id STRING NOT NULL,\n" +
              "  facility STRING NOT NULL,\n" +
              "  admit_date DATE NOT NULL,\n" +
              "  discharge_date DATE NOT NULL,\n" +
              "  length_of_stay_days INT NOT NULL,\n" +
              "  drg_code STRING NOT NULL,\n" +
              "  is_30day_readmission BOOLEAN NOT NULL COMMENT 'Ground truth label for training the XGBoost model',\n" +
              "  age_group STRING,\n" +
              "  age_risk_tier STRING,\n" +
              "  is_chronic_complex BOOLEAN,\n" +
              "  inpatient_count INT COMMENT 'Prior inpatient admissions for this patient',\n" +
              "  diagnosis_count INT COMMENT 'Distinct ICD-10 codes on this encounter',\n" +
              "  distinct_ccs_categories INT,\n" +
              "  has_high_risk_condition INT COMMENT '1 iff any of HF/COPD/T2D/CKD/CVA on encounter',\n" +
              "  readmission_risk_score DECIMAL(5,1) NOT NULL COMMENT '0-100 composite weighted score',\n" +
              // risk_tier values track the gold dbt model verbatim
              // (examples/healthcare-clinical/domains/gold/rpt_readmission_risk.sql
              //  emits 'Critical' >=70, 'High' >=50, 'Moderate' >=30, else 'Low').
              // NOTE: contracts/readmission-risk.yaml lists LOW|MODERATE|HIGH|VERY_HIGH
              // — that contract enum is stale vs. the SQL that actually produces the
              // column; the bundle deliberately mirrors the data-producing SQL.
              "  risk_tier STRING NOT NULL COMMENT 'Low | Moderate | High | Critical (matches gold rpt_readmission_risk.sql; contract yaml enum is stale)',\n" +
              "  top_risk_factors STRING COMMENT 'Comma-separated list of contributing factors',\n" +
              "  scored_at TIMESTAMP NOT NULL\n" +
              ") USING DELTA\n" +
              "PARTITIONED BY (risk_tier)\n" +
              "TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true');",
            sampleRows: [
              ['ENC-0001', 'PAT-1001', 'General Hospital A', '2025-01-01', '2025-01-01', 4, '291', true, '75-84', 'High', false, 1, 2, 2, 1, 73.0, 'Critical', 'Advanced age, High-risk condition, Extended LOS'],
              ['ENC-0009', 'PAT-1008', 'Community Hospital B', '2025-04-01', '2025-04-01', 6, '291', true, '75-84', 'High', true, 1, 3, 3, 1, 71.0, 'Critical', 'Advanced age, High-risk condition, Chronic complexity'],
              ['ENC-0011', 'PAT-1003', 'Regional Medical Center', '2025-03-01', '2025-03-01', 4, '194', false, '85+', 'Critical', false, 2, 1, 1, 1, 58.0, 'High', 'Advanced age, High-risk condition, Frequent admissions'],
            ],
          },
        ],
        shortcuts: [
          {
            name: 'cms-public-data',
            target: 'https://data.cms.gov/provider-data/api/1/datastore/query',
            description:
              'CMS Hospital Compare public dataset — national/state readmission benchmarks (HRRP, 30-day all-cause), HCAHPS, mortality. No API key required; refresh quarterly.',
          },
          {
            name: 'npi-registry',
            target: 'https://npiregistry.cms.hhs.gov/api/',
            description:
              'CMS NPI Registry REST API — resolve provider NPI numbers to organization/clinician metadata for facility enrichment in dim_facility.',
          },
          {
            name: 'ahrq-ccs-mapping',
            target: 'https://hcup-us.ahrq.gov/toolssoftware/ccs/ccs.jsp',
            description:
              'AHRQ HCUP CCS (Clinical Classifications Software) reference — ICD-10 to CCS category mapping used by silver.dim_diagnoses.',
          },
        ],
      },
    },
    {
      itemType: 'ml-model',
      displayName: 'Readmission Risk — XGBoost Classifier',
      description:
        '30-day inpatient readmission probability scoring model. XGBoost binary classifier ' +
        'trained on gold.rpt_readmission_risk with MLflow tracking, early stopping, and ' +
        'SHAP feature importance. Per the readmission-risk.yaml data contract. At install the ' +
        'ml-model provisioner imports + runs the trainingCode below on Databricks, which ' +
        'registers the model in the MLflow / Unity Catalog registry; open the editor and bind ' +
        'to that registered model to view versions and deploy a real-time endpoint.',
      learnDoc: 'examples/healthcare-clinical/contracts',
      content: {
        kind: 'ml-model',
        algorithm: 'Gradient Boosted Trees (XGBoost binary:logistic)',
        framework: 'xgboost',
        target: 'readmit_30d',
        features: [
          { name: 'age_group_ordinal', type: 'int' },
          { name: 'gender_code', type: 'int' },
          { name: 'insurance_type_code', type: 'int' },
          { name: 'prior_admits_90d', type: 'int' },
          { name: 'prior_admits_365d', type: 'int' },
          { name: 'charlson_score', type: 'float' },
          { name: 'diagnosis_count', type: 'int' },
          { name: 'distinct_ccs_categories', type: 'int' },
          { name: 'has_high_risk_condition', type: 'int' },
          { name: 'is_chronic_complex', type: 'int' },
          { name: 'length_of_stay_days', type: 'int' },
          { name: 'los_index', type: 'float' },
          { name: 'drg_severity_weight', type: 'float' },
          { name: 'discharge_disposition_code', type: 'int' },
          { name: 'department_code', type: 'int' },
        ],
        hyperparameters: {
          objective: 'binary:logistic',
          eval_metric: ['auc', 'aucpr', 'logloss'],
          max_depth: 6,
          learning_rate: 0.05,
          n_estimators: 500,
          subsample: 0.8,
          colsample_bytree: 0.8,
          colsample_bylevel: 0.9,
          min_child_weight: 5,
          gamma: 0.1,
          reg_alpha: 0.01,
          reg_lambda: 1.0,
          scale_pos_weight: 4.5,
          tree_method: 'hist',
          early_stopping_rounds: 30,
          random_state: 42,
        },
        trainingCode:
          '"""\n' +
          'Train the 30-day readmission risk XGBoost classifier from gold.rpt_readmission_risk.\n' +
          'Logs the run + model + SHAP summary to MLflow; persists the booster + label encoders\n' +
          'as MLflow model artifacts so the inference job can load by run_id.\n' +
          '\n' +
          'Data contract: examples/healthcare-clinical/contracts/readmission-risk.yaml\n' +
          'Target: readmit_30d (= is_30day_readmission from silver.fct_encounters)\n' +
          '"""\n' +
          'from __future__ import annotations\n' +
          '\n' +
          'import mlflow\n' +
          'import mlflow.xgboost\n' +
          'import numpy as np\n' +
          'import pandas as pd\n' +
          'import shap\n' +
          'import xgboost as xgb\n' +
          'from pyspark.sql import SparkSession\n' +
          'from pyspark.sql.functions import (\n' +
          '    col, when, count, countDistinct, datediff, lit, sum as sum_,\n' +
          ')\n' +
          'from sklearn.metrics import (\n' +
          '    average_precision_score, brier_score_loss, roc_auc_score,\n' +
          ')\n' +
          'from sklearn.model_selection import train_test_split\n' +
          '\n' +
          'spark = SparkSession.builder.appName("readmission-risk-train").getOrCreate()\n' +
          '\n' +
          'GOLD_TABLE = "gold.rpt_readmission_risk"\n' +
          'SILVER_FCT = "silver.fct_encounters"\n' +
          'SILVER_DIM_PATIENTS = "silver.dim_patients"\n' +
          'EXPERIMENT_NAME = "/Shared/csa-loom/healthcare-popmgt/readmission-risk"\n' +
          'REGISTERED_MODEL = "csa_loom.healthcare.readmission_risk_xgb"\n' +
          '\n' +
          'mlflow.set_experiment(EXPERIMENT_NAME)\n' +
          '\n' +
          '# ---------------------------------------------------------------------------\n' +
          '# 1) Pull labelled training set from Gold + add prior-admit windows from Silver.\n' +
          '# ---------------------------------------------------------------------------\n' +
          'gold = spark.table(GOLD_TABLE)\n' +
          'fct = spark.table(SILVER_FCT)\n' +
          '\n' +
          'prior_admits = (\n' +
          '    fct.alias("cur").join(\n' +
          '        fct.alias("prev"),\n' +
          '        (col("cur.patient_id") == col("prev.patient_id"))\n' +
          '        & (col("prev.discharge_date") < col("cur.admit_date")),\n' +
          '        "left",\n' +
          '    )\n' +
          '    .groupBy(col("cur.encounter_id").alias("encounter_id"))\n' +
          '    .agg(\n' +
          '        sum_(\n' +
          '            when(datediff(col("cur.admit_date"), col("prev.discharge_date")) <= 90, lit(1))\n' +
          '            .otherwise(lit(0))\n' +
          '        ).alias("prior_admits_90d"),\n' +
          '        sum_(\n' +
          '            when(datediff(col("cur.admit_date"), col("prev.discharge_date")) <= 365, lit(1))\n' +
          '            .otherwise(lit(0))\n' +
          '        ).alias("prior_admits_365d"),\n' +
          '    )\n' +
          ')\n' +
          '\n' +
          'training = (\n' +
          '    gold.join(prior_admits, on="encounter_id", how="left")\n' +
          '        .withColumn("readmit_30d", col("is_30day_readmission").cast("int"))\n' +
          '        .withColumn("los_index", col("length_of_stay_days") / lit(3.5))\n' +
          ')\n' +
          '\n' +
          'pdf: pd.DataFrame = training.toPandas()\n' +
          'pdf["prior_admits_90d"] = pdf["prior_admits_90d"].fillna(0).astype(int)\n' +
          'pdf["prior_admits_365d"] = pdf["prior_admits_365d"].fillna(0).astype(int)\n' +
          '\n' +
          '# Simple Charlson approximation from CCS categories\n' +
          'pdf["charlson_score"] = (\n' +
          '    pdf["distinct_ccs_categories"].fillna(0) * 0.5\n' +
          '    + pdf["has_high_risk_condition"].fillna(0) * 2.0\n' +
          '    + pdf["is_chronic_complex"].fillna(False).astype(int) * 1.5\n' +
          ')\n' +
          '\n' +
          '# Categorical encoders (deterministic, stable across runs)\n' +
          'AGE_GROUPS = {"18-34": 0, "35-49": 1, "50-64": 2, "65-74": 3, "75-84": 4, "85+": 5}\n' +
          'PAYERS = {"Uninsured": 0, "Medicaid": 1, "Commercial": 2, "Medicare": 3}\n' +
          'DISPO = {"Home": 0, "Rehab": 1, "SNF": 2, "Transfer": 3, "Expired": 4}\n' +
          '\n' +
          'pdf["age_group_ordinal"] = pdf["age_group"].map(AGE_GROUPS).fillna(2).astype(int)\n' +
          'pdf["insurance_type_code"] = (\n' +
          '    pdf.get("insurance_type", pd.Series(["Commercial"] * len(pdf)))\n' +
          '       .map(PAYERS).fillna(2).astype(int)\n' +
          ')\n' +
          'pdf["discharge_disposition_code"] = (\n' +
          '    pdf.get("discharge_disposition", pd.Series(["Home"] * len(pdf)))\n' +
          '       .map(DISPO).fillna(0).astype(int)\n' +
          ')\n' +
          'pdf["gender_code"] = pdf.get("gender", pd.Series(["U"] * len(pdf))).map(\n' +
          '    {"Female": 0, "Male": 1}\n' +
          ').fillna(2).astype(int)\n' +
          'pdf["department_code"] = pdf.get("department", pd.Series(["Unknown"] * len(pdf))).astype(\n' +
          '    "category"\n' +
          ').cat.codes\n' +
          'pdf["drg_severity_weight"] = pdf["drg_code"].astype("category").cat.codes / 50.0\n' +
          'pdf["has_high_risk_condition"] = pdf["has_high_risk_condition"].fillna(0).astype(int)\n' +
          'pdf["is_chronic_complex"] = pdf["is_chronic_complex"].fillna(False).astype(int)\n' +
          '\n' +
          'FEATURES = [\n' +
          '    "age_group_ordinal", "gender_code", "insurance_type_code",\n' +
          '    "prior_admits_90d", "prior_admits_365d", "charlson_score",\n' +
          '    "diagnosis_count", "distinct_ccs_categories", "has_high_risk_condition",\n' +
          '    "is_chronic_complex", "length_of_stay_days", "los_index",\n' +
          '    "drg_severity_weight", "discharge_disposition_code", "department_code",\n' +
          ']\n' +
          '\n' +
          'X = pdf[FEATURES].astype(float).values\n' +
          'y = pdf["readmit_30d"].astype(int).values\n' +
          '\n' +
          'X_train, X_holdout, y_train, y_holdout = train_test_split(\n' +
          '    X, y, test_size=0.2, stratify=y, random_state=42,\n' +
          ')\n' +
          'X_val, X_test, y_val, y_test = train_test_split(\n' +
          '    X_holdout, y_holdout, test_size=0.5, stratify=y_holdout, random_state=42,\n' +
          ')\n' +
          '\n' +
          '# ---------------------------------------------------------------------------\n' +
          '# 2) Train + log to MLflow.\n' +
          '# ---------------------------------------------------------------------------\n' +
          'with mlflow.start_run(run_name="readmission-xgb") as run:\n' +
          '    params = {\n' +
          '        "objective": "binary:logistic",\n' +
          '        "eval_metric": ["auc", "aucpr", "logloss"],\n' +
          '        "max_depth": 6,\n' +
          '        "learning_rate": 0.05,\n' +
          '        "subsample": 0.8,\n' +
          '        "colsample_bytree": 0.8,\n' +
          '        "colsample_bylevel": 0.9,\n' +
          '        "min_child_weight": 5,\n' +
          '        "gamma": 0.1,\n' +
          '        "reg_alpha": 0.01,\n' +
          '        "reg_lambda": 1.0,\n' +
          '        "scale_pos_weight": float(np.sum(y_train == 0) / max(np.sum(y_train == 1), 1)),\n' +
          '        "tree_method": "hist",\n' +
          '        "seed": 42,\n' +
          '    }\n' +
          '    mlflow.log_params(params)\n' +
          '    mlflow.log_param("n_features", len(FEATURES))\n' +
          '    mlflow.log_param("n_train", len(y_train))\n' +
          '    mlflow.log_param("n_val", len(y_val))\n' +
          '    mlflow.log_param("n_test", len(y_test))\n' +
          '\n' +
          '    dtrain = xgb.DMatrix(X_train, label=y_train, feature_names=FEATURES)\n' +
          '    dval = xgb.DMatrix(X_val, label=y_val, feature_names=FEATURES)\n' +
          '    dtest = xgb.DMatrix(X_test, label=y_test, feature_names=FEATURES)\n' +
          '\n' +
          '    booster = xgb.train(\n' +
          '        params=params,\n' +
          '        dtrain=dtrain,\n' +
          '        num_boost_round=500,\n' +
          '        evals=[(dtrain, "train"), (dval, "val")],\n' +
          '        early_stopping_rounds=30,\n' +
          '        verbose_eval=25,\n' +
          '    )\n' +
          '\n' +
          '    y_pred = booster.predict(dtest)\n' +
          '    metrics = {\n' +
          '        "test_auc": float(roc_auc_score(y_test, y_pred)),\n' +
          '        "test_aucpr": float(average_precision_score(y_test, y_pred)),\n' +
          '        "test_brier": float(brier_score_loss(y_test, y_pred)),\n' +
          '        "best_iteration": int(booster.best_iteration),\n' +
          '    }\n' +
          '    mlflow.log_metrics(metrics)\n' +
          '    print({k: round(v, 4) if isinstance(v, float) else v for k, v in metrics.items()})\n' +
          '\n' +
          '    # SHAP feature importance — log summary plot + per-feature mean(|shap|)\n' +
          '    explainer = shap.TreeExplainer(booster)\n' +
          '    shap_values = explainer.shap_values(X_test[:2000])\n' +
          '    shap_importance = pd.DataFrame(\n' +
          '        {"feature": FEATURES, "mean_abs_shap": np.mean(np.abs(shap_values), axis=0)}\n' +
          '    ).sort_values("mean_abs_shap", ascending=False)\n' +
          '    shap_importance.to_csv("shap_importance.csv", index=False)\n' +
          '    mlflow.log_artifact("shap_importance.csv")\n' +
          '\n' +
          '    mlflow.xgboost.log_model(\n' +
          '        xgb_model=booster,\n' +
          '        artifact_path="model",\n' +
          '        registered_model_name=REGISTERED_MODEL,\n' +
          '        input_example=pd.DataFrame(X_test[:5], columns=FEATURES),\n' +
          '    )\n' +
          '\n' +
          '    print(f"Logged run {run.info.run_id} -> {REGISTERED_MODEL}")\n',
      },
    },
  ],
};

export default bundle;
