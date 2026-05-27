/**
 * Pipeline Designer app bundle — Phase 1 starter content.
 *
 * Provisions a "medallion ETL orchestrator" reference workspace with
 * three pipeline runtimes wired to the same bronze → silver → gold sales
 * + customer build-out (mirroring the examples/fabric-e2e dbt project)
 * plus a Warehouse item carrying the gold-schema DDL and the dbt
 * models so the analyst can query / extend the medallion immediately.
 *
 * The intent is: same conceptual pipeline, three orchestrator surfaces.
 *
 *   1. synapse-pipeline (template "blank")    — 5 activities orchestrating
 *      ADLS landing copy → file readiness gate → Databricks notebooks
 *      bronze / silver / gold.
 *
 *   2. adf-pipeline (template "blank")        — SAP ECC ODP extract →
 *      Mapping Data Flow transformation → Sink to Lakehouse, demonstrating
 *      the ADF-native pattern for source-system extracts where Synapse
 *      pipelines would normally be overkill.
 *
 *   3. databricks-job (template "blank")      — three-task chained job
 *      bronze.py → silver.py → gold.py, sharing one job cluster, with
 *      depends_on enforcing serial execution.
 *
 *   4. warehouse                              — gold schema DDL +
 *      dbt models + starter queries. Functions as the analyst's
 *      contract for the gold layer the three pipelines populate.
 *
 * Source examples this bundle draws from:
 *   - examples/fabric-e2e/README.md
 *   - examples/fabric-e2e/dbt/dbt_project.yml
 *   - examples/fabric-e2e/dbt/models/bronze/bronze_sales.sql
 *   - examples/fabric-e2e/dbt/models/silver/silver_sales.sql
 *   - examples/fabric-e2e/dbt/models/gold/fact_sales.sql
 *   - examples/fabric-e2e/dbt/models/gold/dim_customer.sql
 *   - examples/data-api-builder/sql/setup.sql
 */
import type { AppBundle } from './types';

// ─── dbt models bundled into the Warehouse item ─────────────────────

const DBT_PROJECT_YML = `name: 'fabric_e2e'
version: '1.0.0'
config-version: 2

profile: 'fabric_e2e'

model-paths:    ["models"]
analysis-paths: ["analyses"]
test-paths:     ["tests"]
seed-paths:     ["seeds"]
macro-paths:    ["macros"]

target-path: "target"
clean-targets:
  - "target"
  - "dbt_packages"

models:
  fabric_e2e:
    bronze:
      +materialized: view
      +schema: bronze
    silver:
      +materialized: incremental
      +schema: silver
      +on_schema_change: append_new_columns
    gold:
      +materialized: incremental
      +schema: gold
      +on_schema_change: append_new_columns

seeds:
  fabric_e2e:
    +schema: bronze
    +quote_columns: false
`;

const BRONZE_SALES_SQL = `{{ config(materialized='view') }}
SELECT
    CAST(order_id AS VARCHAR)           AS order_id,
    CAST(customer_id AS VARCHAR)        AS customer_id,
    CAST(product_id AS VARCHAR)         AS product_id,
    CAST(order_date AS DATE)            AS order_date,
    CAST(ship_date AS DATE)             AS ship_date,
    CAST(quantity AS INTEGER)           AS quantity,
    CAST(unit_price AS DECIMAL(18,2))   AS unit_price,
    CAST(discount_pct AS DECIMAL(5,4))  AS discount_pct,
    CURRENT_TIMESTAMP                   AS _ingested_at
FROM {{ source('bronze', 'sales_raw') }}
`;

const SILVER_SALES_SQL = `{{ config(materialized='incremental', unique_key='order_id') }}
SELECT
    order_id,
    customer_id,
    product_id,
    order_date,
    ship_date,
    quantity,
    unit_price,
    discount_pct,
    _ingested_at
FROM {{ ref('bronze_sales') }}
WHERE order_id IS NOT NULL
  AND quantity > 0
  AND unit_price >= 0
{% if is_incremental() %}
  AND _ingested_at > (SELECT MAX(_ingested_at) FROM {{ this }})
{% endif %}
`;

const GOLD_FACT_SALES_SQL = `{{ config(materialized='incremental', unique_key='sales_key') }}
SELECT
    ROW_NUMBER() OVER (ORDER BY s.order_id, s._ingested_at) AS sales_key,
    c.customer_key,
    p.product_key,
    od.date_key AS order_date_key,
    sd.date_key AS ship_date_key,
    s.order_id,
    s.quantity,
    s.unit_price,
    s.discount_pct,
    CAST(s.quantity * s.unit_price * (1 - s.discount_pct) AS DECIMAL(18,2)) AS extended_amount,
    CAST(s.quantity * p.list_price * 0.55 AS DECIMAL(18,2)) AS cost_amount,
    CAST(s.quantity * s.unit_price * (1 - s.discount_pct) - s.quantity * p.list_price * 0.55 AS DECIMAL(18,2)) AS margin_amount
FROM {{ ref('silver_sales') }} s
JOIN {{ ref('dim_customer') }} c ON c.customer_id = s.customer_id AND c.is_current
JOIN {{ ref('dim_product')  }} p ON p.product_id  = s.product_id  AND p.is_current
JOIN {{ ref('dim_date')     }} od ON od.date = s.order_date
JOIN {{ ref('dim_date')     }} sd ON sd.date = s.ship_date
{% if is_incremental() %}
WHERE s._ingested_at > (SELECT MAX(s._ingested_at)
                        FROM {{ ref('silver_sales') }} s
                        JOIN {{ this }} f ON f.order_id = s.order_id)
{% endif %}
`;

const GOLD_DIM_CUSTOMER_SQL = `{{ config(materialized='incremental', unique_key='customer_key') }}
-- SCD Type 2 customer dimension. New row per customer change; valid_to/is_current
-- closed by upstream merge logic (not shown here for brevity).
SELECT
    ROW_NUMBER() OVER (ORDER BY customer_id, _ingested_at) AS customer_key,
    customer_id,
    customer_name,
    customer_segment,
    country,
    region,
    _ingested_at AS valid_from,
    CAST(NULL AS TIMESTAMP) AS valid_to,
    TRUE AS is_current
FROM {{ ref('silver_customers') }}
{% if is_incremental() %}
WHERE _ingested_at > (SELECT MAX(valid_from) FROM {{ this }})
{% endif %}
`;

const GOLD_DIM_PRODUCT_SQL = `{{ config(materialized='incremental', unique_key='product_key') }}
SELECT
    ROW_NUMBER() OVER (ORDER BY product_id, _ingested_at) AS product_key,
    product_id,
    product_name,
    category,
    subcategory,
    brand,
    CAST(list_price AS DECIMAL(18,2)) AS list_price,
    _ingested_at AS valid_from,
    CAST(NULL AS TIMESTAMP) AS valid_to,
    TRUE AS is_current
FROM {{ ref('silver_products') }}
{% if is_incremental() %}
WHERE _ingested_at > (SELECT MAX(valid_from) FROM {{ this }})
{% endif %}
`;

const GOLD_DIM_DATE_SQL = `{{ config(materialized='table') }}
-- Calendar dimension; date-grain. Role-played as order_date_key and
-- ship_date_key in fact_sales. Build once, rebuild only when the calendar
-- horizon changes.
WITH bounds AS (
    SELECT CAST('2024-01-01' AS DATE) AS start_date,
           CAST('2030-12-31' AS DATE) AS end_date
),
calendar AS (
    SELECT EXPLODE(SEQUENCE(start_date, end_date, INTERVAL 1 DAY)) AS date
    FROM bounds
)
SELECT
    CAST(REPLACE(CAST(date AS STRING), '-', '') AS INTEGER) AS date_key,
    date,
    YEAR(date)                AS year,
    QUARTER(date)             AS quarter,
    MONTH(date)               AS month,
    DAY(date)                 AS day,
    DAYOFWEEK(date)           AS day_of_week,
    DATE_FORMAT(date, 'EEEE') AS day_name,
    DATE_FORMAT(date, 'MMMM') AS month_name,
    WEEKOFYEAR(date)          AS iso_week,
    CASE WHEN DAYOFWEEK(date) IN (1, 7) THEN TRUE ELSE FALSE END AS is_weekend
FROM calendar
`;

// ─── Warehouse DDL — gold star schema ───────────────────────────────

const WAREHOUSE_DDL = `-- =============================================================================
-- Pipeline Designer — Gold Layer DDL
-- Star schema populated by bronze → silver → gold dbt models, run by the
-- Synapse pipeline, ADF pipeline, or Databricks job in this same app.
-- Target platform: Synapse Dedicated SQL Pool (also runs on Fabric Warehouse
-- with the noted TEXT replacements documented under docs/fiab/warehouse.md).
-- =============================================================================

-- ─── Schemas ────────────────────────────────────────────────────────────────
IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = 'gold')      EXEC('CREATE SCHEMA gold');
GO

-- ─── Dimension: Customer (SCD-2) ───────────────────────────────────────────
CREATE TABLE gold.dim_customer (
    customer_key       BIGINT          NOT NULL,
    customer_id        VARCHAR(64)     NOT NULL,
    customer_name      NVARCHAR(200)   NOT NULL,
    customer_segment   NVARCHAR(50)    NOT NULL,
    country            NVARCHAR(80)    NOT NULL,
    region             NVARCHAR(80)    NOT NULL,
    valid_from         DATETIME2       NOT NULL,
    valid_to           DATETIME2       NULL,
    is_current         BIT             NOT NULL DEFAULT 1,
    CONSTRAINT PK_dim_customer PRIMARY KEY NONCLUSTERED (customer_key) NOT ENFORCED
)
WITH (DISTRIBUTION = REPLICATE, CLUSTERED COLUMNSTORE INDEX);
GO

-- ─── Dimension: Product (SCD-2) ────────────────────────────────────────────
CREATE TABLE gold.dim_product (
    product_key        BIGINT          NOT NULL,
    product_id         VARCHAR(64)     NOT NULL,
    product_name       NVARCHAR(200)   NOT NULL,
    category           NVARCHAR(80)    NOT NULL,
    subcategory        NVARCHAR(80)    NULL,
    brand              NVARCHAR(80)    NULL,
    list_price         DECIMAL(18,2)   NOT NULL,
    valid_from         DATETIME2       NOT NULL,
    valid_to           DATETIME2       NULL,
    is_current         BIT             NOT NULL DEFAULT 1,
    CONSTRAINT PK_dim_product PRIMARY KEY NONCLUSTERED (product_key) NOT ENFORCED
)
WITH (DISTRIBUTION = REPLICATE, CLUSTERED COLUMNSTORE INDEX);
GO

-- ─── Dimension: Date (role-played as order_date + ship_date) ───────────────
CREATE TABLE gold.dim_date (
    date_key           INT             NOT NULL,
    date               DATE            NOT NULL,
    year               INT             NOT NULL,
    quarter            INT             NOT NULL,
    month              INT             NOT NULL,
    day                INT             NOT NULL,
    day_of_week        INT             NOT NULL,
    day_name           NVARCHAR(20)    NOT NULL,
    month_name         NVARCHAR(20)    NOT NULL,
    iso_week           INT             NOT NULL,
    is_weekend         BIT             NOT NULL,
    CONSTRAINT PK_dim_date PRIMARY KEY NONCLUSTERED (date_key) NOT ENFORCED
)
WITH (DISTRIBUTION = REPLICATE, CLUSTERED COLUMNSTORE INDEX);
GO

-- ─── Fact: Sales ───────────────────────────────────────────────────────────
CREATE TABLE gold.fact_sales (
    sales_key          BIGINT          NOT NULL,
    customer_key       BIGINT          NOT NULL,
    product_key        BIGINT          NOT NULL,
    order_date_key     INT             NOT NULL,
    ship_date_key      INT             NOT NULL,
    order_id           VARCHAR(64)     NOT NULL,
    quantity           INT             NOT NULL,
    unit_price         DECIMAL(18,2)   NOT NULL,
    discount_pct       DECIMAL(5,4)    NOT NULL,
    extended_amount    DECIMAL(18,2)   NOT NULL,
    cost_amount        DECIMAL(18,2)   NOT NULL,
    margin_amount      DECIMAL(18,2)   NOT NULL,
    CONSTRAINT PK_fact_sales PRIMARY KEY NONCLUSTERED (sales_key) NOT ENFORCED
)
WITH (DISTRIBUTION = HASH(customer_key), CLUSTERED COLUMNSTORE INDEX);
GO

-- ─── Convenience views for downstream BI ──────────────────────────────────
CREATE OR ALTER VIEW gold.v_sales_by_segment AS
SELECT
    c.customer_segment,
    d.year,
    d.quarter,
    SUM(f.extended_amount) AS revenue,
    SUM(f.margin_amount)   AS margin,
    COUNT_BIG(*)           AS order_lines
FROM gold.fact_sales f
JOIN gold.dim_customer c ON c.customer_key = f.customer_key
JOIN gold.dim_date     d ON d.date_key     = f.order_date_key
GROUP BY c.customer_segment, d.year, d.quarter;
GO

CREATE OR ALTER VIEW gold.v_top_products_by_margin AS
SELECT TOP 100
    p.product_id,
    p.product_name,
    p.category,
    SUM(f.extended_amount) AS revenue,
    SUM(f.margin_amount)   AS margin,
    SUM(f.margin_amount) * 1.0 / NULLIF(SUM(f.extended_amount), 0) AS margin_pct
FROM gold.fact_sales f
JOIN gold.dim_product p ON p.product_key = f.product_key
GROUP BY p.product_id, p.product_name, p.category
ORDER BY margin DESC;
GO
`;

// ─── Bundle ──────────────────────────────────────────────────────────

const bundle: AppBundle = {
  appId: 'app-pipeline-designer',
  intro: `# Pipeline Designer

A reference orchestrator workspace built around a single medallion ETL —
bronze → silver → gold for retail sales — wired across **three runtimes**
so you can compare patterns:

1. **Synapse pipeline** (\`synapse-pipeline\`) — 5 activities: copy raw
   files into landing → wait until a sentinel exists → run three Databricks
   notebooks (bronze, silver, gold) in serial.

2. **ADF pipeline** (\`adf-pipeline\`) — the source-system extract pattern:
   SAP ECC ODP via the SAP Table connector → Mapping Data Flow with
   business-rule transforms → Sink to Fabric Lakehouse. This is the right
   surface when the source needs ADF's connector library.

3. **Databricks job** (\`databricks-job\`) — chained tasks
   bronze → silver → gold sharing one job cluster, depends_on enforcing
   order. The right surface when transformation logic is mostly PySpark
   and you want first-class job-cluster reuse.

A **Warehouse** item is also provisioned containing the gold-schema DDL
(star schema: \`fact_sales\` + \`dim_customer\` + \`dim_product\` +
\`dim_date\`), the dbt models that build it, and two starter analytic
views. All three pipelines target this same schema, so you can run any
of them and see the result in the warehouse editor.

## Next steps

- Open the Warehouse editor first to skim the schema and starter queries.
- Pick one of the three pipelines and click **Validate** to see the
  parsed activity graph.
- Wire each pipeline's parameters to your tenant's storage / workspace
  ids. The bundle ships with placeholder linked-service refs; the editor
  surfaces them.`,
  sourceDocs: [
    'examples/fabric-e2e/README.md',
    'examples/fabric-e2e/dbt/dbt_project.yml',
    'examples/fabric-e2e/dbt/models/bronze/bronze_sales.sql',
    'examples/fabric-e2e/dbt/models/silver/silver_sales.sql',
    'examples/fabric-e2e/dbt/models/gold/fact_sales.sql',
    'examples/fabric-e2e/dbt/models/gold/dim_customer.sql',
    'examples/data-api-builder/sql/setup.sql',
  ],
  items: [
    // ─── Synapse pipeline ──────────────────────────────────────────────
    {
      itemType: 'synapse-pipeline',
      displayName: 'Medallion ETL — Synapse Orchestrator',
      description:
        'Five-activity Synapse pipeline: copy raw sales/customer files to landing → wait for sentinel → bronze notebook → silver notebook → gold notebook. Targets the gold.fact_sales star schema in the bundled warehouse.',
      learnDoc: 'pipelines/synapse-medallion',
      content: {
        kind: 'synapse-pipeline',
        parameters: {
          runDate: {
            type: 'String',
            defaultValue: '@formatDateTime(utcnow(), \'yyyy-MM-dd\')',
          },
          sourceContainer: {
            type: 'String',
            defaultValue: 'raw-sales-drop',
          },
          targetWorkspace: {
            type: 'String',
            defaultValue: 'csa-retail-sales-dev',
          },
          databricksClusterId: {
            type: 'String',
            defaultValue: 'job-cluster-medallion',
          },
        },
        activities: [
          {
            name: 'Copy_RawToLanding',
            type: 'Copy',
            config: {
              description:
                'Copy CSV / parquet drops from the source container into ADLS gen2 landing/{runDate}/. Uses staged copy with a 4-DIU compute scale, ABFS Hadoop sink, and a max retry of 3 with exponential backoff.',
              inputs: [
                {
                  referenceName: 'ds_source_drop_csv',
                  type: 'DatasetReference',
                  parameters: { container: '@pipeline().parameters.sourceContainer' },
                },
              ],
              outputs: [
                {
                  referenceName: 'ds_landing_parquet',
                  type: 'DatasetReference',
                  parameters: { runDate: '@pipeline().parameters.runDate' },
                },
              ],
              typeProperties: {
                source: { type: 'DelimitedTextSource', storeSettings: { type: 'AzureBlobFSReadSettings', recursive: true } },
                sink: { type: 'ParquetSink', storeSettings: { type: 'AzureBlobFSWriteSettings' } },
                enableStaging: false,
                dataIntegrationUnits: 4,
                parallelCopies: 2,
              },
              policy: { timeout: '0.12:00:00', retry: 3, retryIntervalInSeconds: 30 },
              linkedServiceName: { referenceName: 'ls_adls_gen2', type: 'LinkedServiceReference' },
            },
          },
          {
            name: 'Wait_ForFiles',
            type: 'Until',
            dependsOn: ['Copy_RawToLanding'],
            config: {
              description:
                'Poll the landing folder for a _SUCCESS sentinel that the source system writes after the final file lands. Exits the loop once present; fails the pipeline after a 30-minute deadline.',
              expression: {
                value: "@equals(activity('Lookup_Sentinel').output.firstRow.exists, true)",
                type: 'Expression',
              },
              timeout: '00:30:00',
              activities: [
                {
                  name: 'Wait_30s',
                  type: 'Wait',
                  typeProperties: { waitTimeInSeconds: 30 },
                },
                {
                  name: 'Lookup_Sentinel',
                  type: 'Lookup',
                  typeProperties: {
                    source: { type: 'JsonSource' },
                    dataset: {
                      referenceName: 'ds_landing_sentinel',
                      type: 'DatasetReference',
                      parameters: { runDate: '@pipeline().parameters.runDate' },
                    },
                    firstRowOnly: true,
                  },
                },
              ],
            },
          },
          {
            name: 'Notebook_Bronze',
            type: 'DatabricksNotebook',
            dependsOn: ['Wait_ForFiles'],
            config: {
              description:
                'Run the bronze materialization (dbt model bronze_sales / bronze_customers / bronze_products as Spark views). Reads from landing/{runDate}/ and writes Delta to bronze/{runDate}/.',
              notebookPath: '/Workspace/Repos/csa-loom/medallion/bronze',
              baseParameters: {
                run_date: '@pipeline().parameters.runDate',
                source_path: "@concat('landing/', pipeline().parameters.runDate, '/')",
                target_schema: 'bronze',
              },
              libraries: [
                { pypi: { package: 'dbt-databricks==1.8.7' } },
                { pypi: { package: 'great-expectations==0.18.21' } },
              ],
              linkedServiceName: { referenceName: 'ls_databricks_csa', type: 'LinkedServiceReference' },
              policy: { timeout: '0.02:00:00', retry: 1, retryIntervalInSeconds: 60 },
            },
          },
          {
            name: 'Notebook_Silver',
            type: 'DatabricksNotebook',
            dependsOn: ['Notebook_Bronze'],
            config: {
              description:
                'Run the silver build (dbt incremental models silver_sales / silver_customers / silver_products). Applies type casts, null filters, and unit-price ≥ 0 constraints from the dbt project.',
              notebookPath: '/Workspace/Repos/csa-loom/medallion/silver',
              baseParameters: {
                run_date: '@pipeline().parameters.runDate',
                target_schema: 'silver',
                dbt_models: 'silver_sales silver_customers silver_products',
              },
              linkedServiceName: { referenceName: 'ls_databricks_csa', type: 'LinkedServiceReference' },
              policy: { timeout: '0.02:00:00', retry: 1, retryIntervalInSeconds: 60 },
            },
          },
          {
            name: 'Notebook_Gold',
            type: 'DatabricksNotebook',
            dependsOn: ['Notebook_Silver'],
            config: {
              description:
                'Run the gold build (dbt models dim_customer / dim_product / dim_date / fact_sales). Produces the star schema and refreshes the gold.v_sales_by_segment + gold.v_top_products_by_margin views.',
              notebookPath: '/Workspace/Repos/csa-loom/medallion/gold',
              baseParameters: {
                run_date: '@pipeline().parameters.runDate',
                target_workspace: '@pipeline().parameters.targetWorkspace',
                target_schema: 'gold',
                dbt_models: 'dim_customer dim_product dim_date fact_sales',
                refresh_semantic_model: 'true',
              },
              linkedServiceName: { referenceName: 'ls_databricks_csa', type: 'LinkedServiceReference' },
              policy: { timeout: '0.04:00:00', retry: 1, retryIntervalInSeconds: 60 },
            },
          },
        ],
      },
    },

    // ─── ADF pipeline ──────────────────────────────────────────────────
    {
      itemType: 'adf-pipeline',
      displayName: 'SAP-to-Lakehouse Extract',
      description:
        'Source-system extract pattern: SAP ECC ODP via SAP Table connector → Mapping Data Flow (business-rule transforms) → Sink to Fabric Lakehouse bronze/silver tables. Use this when the source needs ADF\'s connector library rather than Synapse\'s notebook surface.',
      learnDoc: 'pipelines/adf-sap-extract',
      content: {
        kind: 'adf-pipeline',
        parameters: {
          runDate: {
            type: 'String',
            defaultValue: '@formatDateTime(utcnow(), \'yyyy-MM-dd\')',
          },
          sapSystemId: {
            type: 'String',
            defaultValue: 'ECP',
          },
          lakehouseId: {
            type: 'String',
            defaultValue: '00000000-0000-0000-0000-000000000000',
          },
          extractTables: {
            type: 'Array',
            defaultValue: ['VBAK', 'VBAP', 'KNA1', 'MARA'],
          },
        },
        activities: [
          {
            name: 'Copy_SapToLanding',
            type: 'Copy',
            config: {
              description:
                'Pull the configured SAP tables via the SAP Table connector (ODP enabled). Uses a self-hosted IR for on-prem reach and writes Parquet to ADLS landing partitioned by sap_system_id / run_date / table_name.',
              inputs: [
                {
                  referenceName: 'ds_sap_table',
                  type: 'DatasetReference',
                  parameters: {
                    sapSystemId: '@pipeline().parameters.sapSystemId',
                    tableName: "@item()",
                  },
                },
              ],
              outputs: [
                {
                  referenceName: 'ds_landing_sap_parquet',
                  type: 'DatasetReference',
                  parameters: {
                    sapSystemId: '@pipeline().parameters.sapSystemId',
                    runDate: '@pipeline().parameters.runDate',
                    tableName: "@item()",
                  },
                },
              ],
              typeProperties: {
                source: {
                  type: 'SapTableSource',
                  partitionOption: 'PartitionOnInt',
                  partitionSettings: { partitionColumnName: 'MANDT', partitionUpperBound: '999', partitionLowerBound: '000' },
                  rowCount: 0,
                  batchSize: 100000,
                },
                sink: { type: 'ParquetSink', storeSettings: { type: 'AzureBlobFSWriteSettings' } },
                parallelCopies: 4,
              },
              policy: { timeout: '0.06:00:00', retry: 2, retryIntervalInSeconds: 60 },
              linkedServiceName: { referenceName: 'ls_sap_ecc_selfhosted', type: 'LinkedServiceReference' },
            },
          },
          {
            name: 'Transform_BusinessRules',
            type: 'ExecuteDataFlow',
            dependsOn: ['Copy_SapToLanding'],
            config: {
              description:
                'Mapping Data Flow that applies the business rules — currency normalization to USD via ECB daily rate, MANDT client filter (only the productive client), and SCD-2 derived columns (valid_from / valid_to / is_current). Outputs into Lakehouse silver tables.',
              dataflow: {
                referenceName: 'df_sap_silver',
                type: 'DataFlowReference',
                parameters: {
                  runDate: '@pipeline().parameters.runDate',
                  productiveClient: { value: '100', type: 'string' },
                },
              },
              compute: { coreCount: 16, computeType: 'General' },
              traceLevel: 'Fine',
              integrationRuntime: { referenceName: 'ir_dataflow_eastus2', type: 'IntegrationRuntimeReference' },
              policy: { timeout: '0.04:00:00', retry: 1, retryIntervalInSeconds: 60 },
            },
          },
          {
            name: 'Sink_ToLakehouse',
            type: 'Copy',
            dependsOn: ['Transform_BusinessRules'],
            config: {
              description:
                'Land the silver Parquet into the Fabric Lakehouse via the OneLake connector, using MERGE semantics on customer_id / product_id / order_id so re-runs of the same runDate are idempotent.',
              inputs: [
                {
                  referenceName: 'ds_silver_parquet',
                  type: 'DatasetReference',
                  parameters: { runDate: '@pipeline().parameters.runDate' },
                },
              ],
              outputs: [
                {
                  referenceName: 'ds_lakehouse_delta',
                  type: 'DatasetReference',
                  parameters: { lakehouseId: '@pipeline().parameters.lakehouseId' },
                },
              ],
              typeProperties: {
                source: { type: 'ParquetSource', storeSettings: { type: 'AzureBlobFSReadSettings', recursive: true } },
                sink: { type: 'LakehouseTableSink', tableActionOption: 'Upsert', keyColumns: ['customer_id', 'product_id', 'order_id'] },
                enableSkipIncompatibleRow: false,
                parallelCopies: 4,
              },
              policy: { timeout: '0.04:00:00', retry: 2, retryIntervalInSeconds: 60 },
              linkedServiceName: { referenceName: 'ls_fabric_onelake', type: 'LinkedServiceReference' },
            },
          },
          {
            name: 'Notify_OnFailure',
            type: 'WebActivity',
            dependsOn: ['Sink_ToLakehouse'],
            config: {
              description:
                'Posts a Teams channel notification on completion (success or failure). Pulls the channel webhook from Key Vault via the Web activity\'s authentication = MSI flow.',
              method: 'POST',
              url: { value: "@concat(activity('GetWebhook').output.value, '')", type: 'Expression' },
              body: {
                value: "@concat('{\\\"text\\\":\\\"SAP → Lakehouse run ', pipeline().parameters.runDate, ' status=', pipeline().Status, '\\\"}')",
                type: 'Expression',
              },
              headers: { 'Content-Type': 'application/json' },
              authentication: { type: 'MSI', resource: 'https://vault.azure.net' },
              dependsOnCondition: 'Completion',
            },
          },
        ],
      },
    },

    // ─── Databricks job ────────────────────────────────────────────────
    {
      itemType: 'databricks-job',
      displayName: 'Medallion ETL — Databricks Job',
      description:
        'Three-task chained Databricks job (bronze → silver → gold) sharing a single job cluster. depends_on enforces serial execution; each task points at /Workspace/Repos/csa-loom/medallion/{bronze,silver,gold}.py.',
      learnDoc: 'pipelines/databricks-medallion-job',
      content: {
        kind: 'databricks-job',
        cluster: {
          sparkVersion: '15.4.x-photon-scala2.12',
          nodeType: 'Standard_DS3_v2',
          numWorkers: 4,
        },
        tasks: [
          {
            name: 'bronze',
            type: 'notebook_task',
            notebookPath: '/Workspace/Repos/csa-loom/medallion/bronze',
            config: {
              description:
                'Materialize bronze layer (sales_raw, customers_raw, products_raw → bronze.* views). Reads landing/{run_date}/ from ADLS, writes Delta into the lakehouse default schema bronze. Idempotent — re-running with the same run_date overwrites the day partition.',
              base_parameters: {
                run_date: '{{ job.parameters.run_date }}',
                source_path: 'abfss://landing@<storage>.dfs.core.windows.net/{{ job.parameters.run_date }}/',
                target_schema: 'bronze',
              },
              timeout_seconds: 1800,
              retry_on_timeout: false,
              max_retries: 1,
              min_retry_interval_millis: 60000,
              libraries: [
                { pypi: { package: 'dbt-databricks==1.8.7' } },
                { pypi: { package: 'great-expectations==0.18.21' } },
              ],
              email_notifications: { on_failure: ['data-platform-oncall@example.com'] },
            },
          },
          {
            name: 'silver',
            type: 'notebook_task',
            notebookPath: '/Workspace/Repos/csa-loom/medallion/silver',
            config: {
              description:
                'Run silver dbt incremental models. Applies the WHERE order_id IS NOT NULL AND quantity > 0 AND unit_price >= 0 quality gate from the dbt project. Failures here block the gold task via depends_on.',
              base_parameters: {
                run_date: '{{ job.parameters.run_date }}',
                target_schema: 'silver',
                dbt_models: 'silver_sales silver_customers silver_products',
              },
              depends_on: [{ task_key: 'bronze' }],
              timeout_seconds: 1800,
              retry_on_timeout: false,
              max_retries: 1,
              min_retry_interval_millis: 60000,
            },
          },
          {
            name: 'gold',
            type: 'notebook_task',
            notebookPath: '/Workspace/Repos/csa-loom/medallion/gold',
            config: {
              description:
                'Build the star schema (dim_customer, dim_product, dim_date, fact_sales) and refresh the Direct Lake semantic model. On success emits a job event tagged "medallion.gold.refreshed" that the Loom Activator picks up.',
              base_parameters: {
                run_date: '{{ job.parameters.run_date }}',
                target_schema: 'gold',
                dbt_models: 'dim_customer dim_product dim_date fact_sales',
                refresh_semantic_model: 'true',
              },
              depends_on: [{ task_key: 'silver' }],
              timeout_seconds: 3600,
              retry_on_timeout: false,
              max_retries: 1,
              min_retry_interval_millis: 60000,
              email_notifications: {
                on_success: ['data-platform-bi@example.com'],
                on_failure: ['data-platform-oncall@example.com'],
              },
            },
          },
        ],
      },
    },

    // ─── Warehouse — gold schema target ────────────────────────────────
    {
      itemType: 'warehouse',
      displayName: 'Sales Star Schema — Gold Warehouse',
      description:
        'The gold target that all three pipelines populate. Star schema (fact_sales + dim_customer + dim_product + dim_date) with dbt models and two analyst-friendly views. Lives on Synapse Dedicated SQL pool / Fabric Warehouse.',
      learnDoc: 'warehouse/sales-gold',
      content: {
        kind: 'warehouse',
        ddl: WAREHOUSE_DDL,
        dbtProject: DBT_PROJECT_YML,
        dbtModels: [
          { layer: 'bronze', name: 'bronze_sales',    sql: BRONZE_SALES_SQL },
          { layer: 'silver', name: 'silver_sales',    sql: SILVER_SALES_SQL },
          { layer: 'gold',   name: 'dim_customer',    sql: GOLD_DIM_CUSTOMER_SQL },
          { layer: 'gold',   name: 'dim_product',     sql: GOLD_DIM_PRODUCT_SQL },
          { layer: 'gold',   name: 'dim_date',        sql: GOLD_DIM_DATE_SQL },
          { layer: 'gold',   name: 'fact_sales',      sql: GOLD_FACT_SALES_SQL },
        ],
        starterQueries: [
          {
            name: 'Top 10 customers by margin — last 90 days',
            sql: `SELECT TOP 10
    c.customer_id,
    c.customer_name,
    c.customer_segment,
    SUM(f.extended_amount) AS revenue,
    SUM(f.margin_amount)   AS margin
FROM gold.fact_sales f
JOIN gold.dim_customer c ON c.customer_key = f.customer_key
JOIN gold.dim_date     d ON d.date_key     = f.order_date_key
WHERE d.date >= DATEADD(DAY, -90, CAST(SYSUTCDATETIME() AS DATE))
GROUP BY c.customer_id, c.customer_name, c.customer_segment
ORDER BY margin DESC;`,
          },
          {
            name: 'Revenue by quarter and customer segment',
            sql: `SELECT
    d.year,
    d.quarter,
    c.customer_segment,
    SUM(f.extended_amount) AS revenue,
    SUM(f.margin_amount)   AS margin,
    COUNT_BIG(*)           AS order_lines
FROM gold.fact_sales f
JOIN gold.dim_customer c ON c.customer_key = f.customer_key
JOIN gold.dim_date     d ON d.date_key     = f.order_date_key
GROUP BY d.year, d.quarter, c.customer_segment
ORDER BY d.year, d.quarter, c.customer_segment;`,
          },
          {
            name: 'Top categories by margin pct',
            sql: `SELECT TOP 25
    p.category,
    SUM(f.extended_amount) AS revenue,
    SUM(f.margin_amount)   AS margin,
    SUM(f.margin_amount) * 1.0 / NULLIF(SUM(f.extended_amount), 0) AS margin_pct
FROM gold.fact_sales f
JOIN gold.dim_product p ON p.product_key = f.product_key
GROUP BY p.category
ORDER BY margin_pct DESC;`,
          },
          {
            name: 'Pipeline freshness — what is the latest order_date in gold?',
            sql: `SELECT
    MAX(d.date)            AS latest_order_date,
    DATEDIFF(HOUR, MAX(d.date), SYSUTCDATETIME()) AS hours_behind_now,
    COUNT_BIG(*)           AS total_order_lines
FROM gold.fact_sales f
JOIN gold.dim_date d ON d.date_key = f.order_date_key;`,
          },
        ],
      },
    },
  ],
};

export default bundle;
