// app-lakehouse-inspector — provisions a medallion (bronze/silver/gold) Lakehouse
// pre-stamped with the retail-sales star schema from examples/fabric-e2e + a
// companion notebook that profiles each tier so the user immediately sees a
// fully formed lakehouse, not an empty browser pane.
import type { AppBundle } from './types';

const bundle: AppBundle = {
  appId: 'app-lakehouse-inspector',
  intro:
    '## Lakehouse Inspector\n\n' +
    'A medallion-architecture lakehouse pre-populated with the retail-sales reference ' +
    'star schema (bronze raw, silver cleansed, gold dim/fact) from the `examples/fabric-e2e` ' +
    'reference architecture. Use the companion `Lakehouse Inspector Walkthrough` notebook ' +
    'to profile rows, check nulls, and explore the gold layer with Spark SQL.\n\n' +
    'Folders mirror dbt layers exactly: `bronze/<entity>/`, `silver/<entity>/`, ' +
    '`gold/<dim_or_fact>/`. Two OneLake shortcuts are pre-wired to demonstrate the ' +
    'zero-copy pattern (curated public dataset + sister-workspace shortcut).',
  sourceDocs: [
    'examples/fabric-e2e/ARCHITECTURE.md',
    'examples/fabric-e2e/contracts/dim_customer.yaml',
    'examples/fabric-e2e/contracts/dim_product.yaml',
    'examples/fabric-e2e/contracts/dim_date.yaml',
    'examples/fabric-e2e/contracts/fact_sales.yaml',
    'examples/fabric-e2e/dbt/models/bronze/_sources.yml',
    'examples/fabric-e2e/dbt/models/bronze/bronze_sales.sql',
    'examples/fabric-e2e/dbt/models/silver/silver_sales.sql',
    'examples/fabric-e2e/dbt/models/gold/fact_sales.sql',
    'examples/fabric-e2e/dbt/models/gold/dim_customer.sql',
    'examples/financial-fraud-detection/contracts/fraud-scores.yaml',
  ],
  items: [
    {
      itemType: 'lakehouse',
      displayName: 'Retail Sales Medallion Lakehouse',
      description:
        'Bronze/silver/gold medallion lakehouse seeded with the retail-sales reference ' +
        'star schema (3 dims + 1 fact). Source: examples/fabric-e2e.',
      learnDoc: 'reference-architecture/data-flow-medallion',
      content: {
        kind: 'lakehouse',
        folders: [
          {
            path: 'bronze/sales/',
            description:
              'Raw landed sales order line items from the ERP / order-entry system. ' +
              'Partitioned by ingestion date (YYYY/MM/DD). Materialized as views in dbt — no transformation.',
          },
          {
            path: 'bronze/customers/',
            description:
              'Raw customer master extracts from CRM, one full snapshot per ingestion day. ' +
              'Tracks all attribute changes for downstream SCD2 in silver/gold.',
          },
          {
            path: 'bronze/products/',
            description:
              'Raw product catalog from the PIM system. Daily full-snapshot drops; ' +
              'silver layer deduplicates by product_id + ingestion_ts.',
          },
          {
            path: 'silver/sales/',
            description:
              'Cleansed sales lines. Type-cast, null-filtered (order_id NOT NULL, ' +
              'quantity > 0, unit_price >= 0). Incremental on `_ingested_at`.',
          },
          {
            path: 'silver/customers/',
            description:
              'Cleansed customer rows with canonicalized country/region codes. ' +
              'One row per customer_id + ingestion_ts so gold can build SCD2 history.',
          },
          {
            path: 'silver/products/',
            description:
              'Cleansed product rows. Category/subcategory normalized to title case; ' +
              'list_price validated in $0-$100K range per the dim_product contract.',
          },
          {
            path: 'gold/dim_customer/',
            description:
              'SCD Type 2 customer dimension. Surrogate key `customer_key` (bigint), ' +
              'natural key `customer_id` preserved. `valid_from` / `valid_to` / `is_current` track history.',
          },
          {
            path: 'gold/dim_product/',
            description:
              'SCD Type 2 product dimension. Surrogate key `product_key` (bigint). ' +
              'list_price snapshotted per version so historical fact rows reflect the price at the time of sale.',
          },
          {
            path: 'gold/dim_date/',
            description:
              'Static date dimension (1900-01-01 → 2099-12-31). `date_key` is YYYYMMDD integer. ' +
              'Marked as the date table for Power BI time intelligence (YTD/QTD/MTD/PY).',
          },
          {
            path: 'gold/fact_sales/',
            description:
              'One row per sales order line item. Foreign keys to dim_customer, dim_product, ' +
              'and dim_date (role-playing order_date_key + ship_date_key). Pre-computed extended_amount / cost_amount / margin_amount.',
          },
        ],
        deltaTables: [
          {
            name: 'bronze_sales',
            ddl:
              'CREATE TABLE bronze.bronze_sales (\n' +
              '    order_id        VARCHAR(64)    NOT NULL,\n' +
              '    customer_id     VARCHAR(64)    NOT NULL,\n' +
              '    product_id      VARCHAR(64)    NOT NULL,\n' +
              '    order_date      DATE           NOT NULL,\n' +
              '    ship_date       DATE,\n' +
              '    quantity        INT            NOT NULL,\n' +
              '    unit_price      DECIMAL(18,2)  NOT NULL,\n' +
              '    discount_pct    DECIMAL(5,4)   NOT NULL,\n' +
              '    _ingested_at    TIMESTAMP      NOT NULL\n' +
              ') USING DELTA\n' +
              'PARTITIONED BY (order_date);',
            sampleRows: [
              ['ORD-100001', 'CUST-0042', 'SKU-9001', '2026-04-01', '2026-04-04', 2, 49.99, 0.0000, '2026-04-01T03:00:00Z'],
              ['ORD-100002', 'CUST-0017', 'SKU-9214', '2026-04-01', '2026-04-03', 1, 129.00, 0.1000, '2026-04-01T03:00:00Z'],
              ['ORD-100003', 'CUST-0103', 'SKU-9001', '2026-04-02', '2026-04-05', 5, 49.99, 0.0500, '2026-04-02T03:00:00Z'],
              ['ORD-100004', 'CUST-0204', 'SKU-9555', '2026-04-02', '2026-04-06', 1, 899.00, 0.0000, '2026-04-02T03:00:00Z'],
              ['ORD-100005', 'CUST-0042', 'SKU-9101', '2026-04-03', '2026-04-08', 3, 19.95, 0.0000, '2026-04-03T03:00:00Z'],
              ['ORD-100006', 'CUST-0322', 'SKU-9214', '2026-04-04', '2026-04-09', 2, 129.00, 0.1500, '2026-04-04T03:00:00Z'],
              ['ORD-100007', 'CUST-0017', 'SKU-9999', '2026-04-05', '2026-04-12', 1, 2499.00, 0.0000, '2026-04-05T03:00:00Z'],
              ['ORD-100008', 'CUST-0480', 'SKU-9101', '2026-04-05', '2026-04-08', 10, 19.95, 0.2000, '2026-04-05T03:00:00Z'],
            ],
          },
          {
            name: 'bronze_customers',
            ddl:
              'CREATE TABLE bronze.bronze_customers (\n' +
              '    customer_id        VARCHAR(64)  NOT NULL,\n' +
              '    customer_name      VARCHAR(200) NOT NULL,\n' +
              '    customer_segment   VARCHAR(50)  NOT NULL,\n' +
              '    country            VARCHAR(80)  NOT NULL,\n' +
              '    region             VARCHAR(80)  NOT NULL,\n' +
              '    _ingested_at       TIMESTAMP    NOT NULL\n' +
              ') USING DELTA;',
            sampleRows: [
              ['CUST-0017', 'Acme Industrial Holdings', 'Enterprise', 'United States', 'AMER', '2026-04-01T02:30:00Z'],
              ['CUST-0042', 'Smith Family Trust', 'Consumer', 'United States', 'AMER', '2026-04-01T02:30:00Z'],
              ['CUST-0103', 'Globex SA', 'SMB', 'France', 'EMEA', '2026-04-01T02:30:00Z'],
              ['CUST-0204', 'Initech LLC', 'SMB', 'United States', 'AMER', '2026-04-01T02:30:00Z'],
              ['CUST-0322', 'Hooli Pte Ltd', 'Enterprise', 'Singapore', 'APAC', '2026-04-01T02:30:00Z'],
              ['CUST-0480', 'Pied Piper Inc.', 'SMB', 'United States', 'AMER', '2026-04-01T02:30:00Z'],
            ],
          },
          {
            name: 'bronze_products',
            ddl:
              'CREATE TABLE bronze.bronze_products (\n' +
              '    product_id     VARCHAR(64)    NOT NULL,\n' +
              '    product_name   VARCHAR(200)   NOT NULL,\n' +
              '    category       VARCHAR(80)    NOT NULL,\n' +
              '    subcategory    VARCHAR(80)    NOT NULL,\n' +
              '    list_price     DECIMAL(18,2)  NOT NULL,\n' +
              '    _ingested_at   TIMESTAMP      NOT NULL\n' +
              ') USING DELTA;',
            sampleRows: [
              ['SKU-9001', 'Mechanical Keyboard MK-1', 'Peripherals', 'Keyboards', 49.99, '2026-04-01T02:00:00Z'],
              ['SKU-9101', 'USB-C Hub Pro', 'Peripherals', 'Hubs & Docks', 19.95, '2026-04-01T02:00:00Z'],
              ['SKU-9214', '27" 4K UHD Monitor', 'Displays', 'Monitors', 129.00, '2026-04-01T02:00:00Z'],
              ['SKU-9555', 'Studio Microphone X', 'Audio', 'Microphones', 899.00, '2026-04-01T02:00:00Z'],
              ['SKU-9999', 'Workstation Laptop Pro', 'Computers', 'Laptops', 2499.00, '2026-04-01T02:00:00Z'],
            ],
          },
          {
            name: 'silver_sales',
            ddl:
              '-- Translated from dbt/models/silver/silver_sales.sql\n' +
              'CREATE TABLE silver.silver_sales (\n' +
              '    order_id       VARCHAR(64)    NOT NULL,\n' +
              '    customer_id    VARCHAR(64)    NOT NULL,\n' +
              '    product_id     VARCHAR(64)    NOT NULL,\n' +
              '    order_date     DATE           NOT NULL,\n' +
              '    ship_date      DATE,\n' +
              '    quantity       INT            NOT NULL,\n' +
              '    unit_price     DECIMAL(18,2)  NOT NULL,\n' +
              '    discount_pct   DECIMAL(5,4)   NOT NULL,\n' +
              '    _ingested_at   TIMESTAMP      NOT NULL,\n' +
              '    CONSTRAINT silver_sales_qty_pos CHECK (quantity > 0),\n' +
              '    CONSTRAINT silver_sales_price_nn CHECK (unit_price >= 0)\n' +
              ') USING DELTA\n' +
              "TBLPROPERTIES ('delta.appendOnly' = 'false');",
            sampleRows: [
              ['ORD-100001', 'CUST-0042', 'SKU-9001', '2026-04-01', '2026-04-04', 2, 49.99, 0.0000, '2026-04-01T03:00:00Z'],
              ['ORD-100002', 'CUST-0017', 'SKU-9214', '2026-04-01', '2026-04-03', 1, 129.00, 0.1000, '2026-04-01T03:00:00Z'],
              ['ORD-100003', 'CUST-0103', 'SKU-9001', '2026-04-02', '2026-04-05', 5, 49.99, 0.0500, '2026-04-02T03:00:00Z'],
              ['ORD-100005', 'CUST-0042', 'SKU-9101', '2026-04-03', '2026-04-08', 3, 19.95, 0.0000, '2026-04-03T03:00:00Z'],
              ['ORD-100008', 'CUST-0480', 'SKU-9101', '2026-04-05', '2026-04-08', 10, 19.95, 0.2000, '2026-04-05T03:00:00Z'],
            ],
          },
          {
            name: 'silver_customers',
            ddl:
              'CREATE TABLE silver.silver_customers (\n' +
              '    customer_id        VARCHAR(64)  NOT NULL,\n' +
              '    customer_name      VARCHAR(200) NOT NULL,\n' +
              '    customer_segment   VARCHAR(50)  NOT NULL,\n' +
              '    country            VARCHAR(80)  NOT NULL,\n' +
              '    region             VARCHAR(80)  NOT NULL,\n' +
              '    _ingested_at       TIMESTAMP    NOT NULL\n' +
              ') USING DELTA;',
            sampleRows: [
              ['CUST-0017', 'Acme Industrial Holdings', 'Enterprise', 'United States', 'AMER', '2026-04-01T02:30:00Z'],
              ['CUST-0042', 'Smith Family Trust', 'Consumer', 'United States', 'AMER', '2026-04-01T02:30:00Z'],
              ['CUST-0103', 'Globex SA', 'SMB', 'France', 'EMEA', '2026-04-01T02:30:00Z'],
              ['CUST-0204', 'Initech LLC', 'SMB', 'United States', 'AMER', '2026-04-01T02:30:00Z'],
              ['CUST-0322', 'Hooli Pte Ltd', 'Enterprise', 'Singapore', 'APAC', '2026-04-01T02:30:00Z'],
              ['CUST-0480', 'Pied Piper Inc.', 'SMB', 'United States', 'AMER', '2026-04-01T02:30:00Z'],
            ],
          },
          {
            name: 'silver_products',
            ddl:
              'CREATE TABLE silver.silver_products (\n' +
              '    product_id     VARCHAR(64)    NOT NULL,\n' +
              '    product_name   VARCHAR(200)   NOT NULL,\n' +
              '    category       VARCHAR(80)    NOT NULL,\n' +
              '    subcategory    VARCHAR(80)    NOT NULL,\n' +
              '    list_price     DECIMAL(18,2)  NOT NULL,\n' +
              '    _ingested_at   TIMESTAMP      NOT NULL,\n' +
              '    CONSTRAINT silver_products_price_band CHECK (list_price BETWEEN 0 AND 100000)\n' +
              ') USING DELTA;',
            sampleRows: [
              ['SKU-9001', 'Mechanical Keyboard MK-1', 'Peripherals', 'Keyboards', 49.99, '2026-04-01T02:00:00Z'],
              ['SKU-9101', 'USB-C Hub Pro', 'Peripherals', 'Hubs & Docks', 19.95, '2026-04-01T02:00:00Z'],
              ['SKU-9214', '27" 4K UHD Monitor', 'Displays', 'Monitors', 129.00, '2026-04-01T02:00:00Z'],
              ['SKU-9555', 'Studio Microphone X', 'Audio', 'Microphones', 899.00, '2026-04-01T02:00:00Z'],
              ['SKU-9999', 'Workstation Laptop Pro', 'Computers', 'Laptops', 2499.00, '2026-04-01T02:00:00Z'],
            ],
          },
          {
            name: 'dim_customer',
            ddl:
              '-- Translated from dbt/models/gold/dim_customer.sql (SCD Type 2)\n' +
              'CREATE TABLE gold.dim_customer (\n' +
              '    customer_key       BIGINT         NOT NULL,\n' +
              '    customer_id        VARCHAR(64)    NOT NULL,\n' +
              '    customer_name      VARCHAR(200)   NOT NULL,\n' +
              '    customer_segment   VARCHAR(50)    NOT NULL,\n' +
              '    country            VARCHAR(80)    NOT NULL,\n' +
              '    region             VARCHAR(80)    NOT NULL,\n' +
              '    valid_from         TIMESTAMP      NOT NULL,\n' +
              '    valid_to           TIMESTAMP,\n' +
              '    is_current         BOOLEAN        NOT NULL,\n' +
              '    CONSTRAINT pk_dim_customer PRIMARY KEY (customer_key)\n' +
              ') USING DELTA\n' +
              "TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true');",
            sampleRows: [
              [1, 'CUST-0017', 'Acme Industrial Holdings', 'Enterprise', 'United States', 'AMER', '2026-01-01T00:00:00Z', null, true],
              [2, 'CUST-0042', 'Smith Family Trust', 'Consumer', 'United States', 'AMER', '2026-01-01T00:00:00Z', null, true],
              [3, 'CUST-0103', 'Globex SA', 'SMB', 'France', 'EMEA', '2026-01-01T00:00:00Z', null, true],
              [4, 'CUST-0204', 'Initech LLC', 'SMB', 'United States', 'AMER', '2026-01-01T00:00:00Z', null, true],
              [5, 'CUST-0322', 'Hooli Pte Ltd', 'Enterprise', 'Singapore', 'APAC', '2026-01-01T00:00:00Z', null, true],
              [6, 'CUST-0480', 'Pied Piper Inc.', 'SMB', 'United States', 'AMER', '2026-01-01T00:00:00Z', null, true],
            ],
          },
          {
            name: 'dim_product',
            ddl:
              '-- Grounded in examples/fabric-e2e/contracts/dim_product.yaml (SCD Type 2)\n' +
              'CREATE TABLE gold.dim_product (\n' +
              '    product_key    BIGINT         NOT NULL,\n' +
              '    product_id     VARCHAR(64)    NOT NULL,\n' +
              '    product_name   VARCHAR(200)   NOT NULL,\n' +
              '    category       VARCHAR(80)    NOT NULL,\n' +
              '    subcategory    VARCHAR(80)    NOT NULL,\n' +
              '    list_price     DECIMAL(18,2)  NOT NULL,\n' +
              '    valid_from     TIMESTAMP      NOT NULL,\n' +
              '    valid_to       TIMESTAMP,\n' +
              '    is_current     BOOLEAN        NOT NULL,\n' +
              '    CONSTRAINT pk_dim_product PRIMARY KEY (product_key),\n' +
              '    CONSTRAINT dim_product_price_band CHECK (list_price BETWEEN 0 AND 100000)\n' +
              ') USING DELTA\n' +
              "TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true');",
            // product_key 1..5 align to fact_sales.product_key (1=SKU-9001,
            // 2=SKU-9101, 3=SKU-9214, 4=SKU-9555, 5=SKU-9999). is_current=TRUE
            // for every row so cell-category-margin's `p.is_current = TRUE`
            // join filter returns all five products.
            sampleRows: [
              [1, 'SKU-9001', 'Mechanical Keyboard MK-1', 'Peripherals', 'Keyboards', 49.99, '2026-01-01T00:00:00Z', null, true],
              [2, 'SKU-9101', 'USB-C Hub Pro', 'Peripherals', 'Hubs & Docks', 19.95, '2026-01-01T00:00:00Z', null, true],
              [3, 'SKU-9214', '27" 4K UHD Monitor', 'Displays', 'Monitors', 129.00, '2026-01-01T00:00:00Z', null, true],
              [4, 'SKU-9555', 'Studio Microphone X', 'Audio', 'Microphones', 899.00, '2026-01-01T00:00:00Z', null, true],
              [5, 'SKU-9999', 'Workstation Laptop Pro', 'Computers', 'Laptops', 2499.00, '2026-01-01T00:00:00Z', null, true],
            ],
          },
          {
            name: 'dim_date',
            ddl:
              '-- Grounded in examples/fabric-e2e/contracts/dim_date.yaml.\n' +
              '-- Static date dimension; date_key is the YYYYMMDD integer surrogate key\n' +
              '-- referenced by fact_sales.order_date_key / ship_date_key.\n' +
              'CREATE TABLE gold.dim_date (\n' +
              '    date_key       BIGINT       NOT NULL,\n' +
              '    date           DATE         NOT NULL,\n' +
              '    year           INT          NOT NULL,\n' +
              '    quarter        INT          NOT NULL,\n' +
              '    month          INT          NOT NULL,\n' +
              '    month_name     VARCHAR(20)  NOT NULL,\n' +
              '    day_of_week    INT          NOT NULL,\n' +
              '    is_weekend     BOOLEAN      NOT NULL,\n' +
              '    is_holiday     BOOLEAN      NOT NULL,\n' +
              '    CONSTRAINT pk_dim_date PRIMARY KEY (date_key)\n' +
              ') USING DELTA;',
            // Covers every distinct order_date_key + ship_date_key in fact_sales
            // (April 2026, all Q2 / month 4) so both role-playing FK joins resolve.
            // day_of_week is 0=Sunday..6=Saturday; is_weekend = (dow in {0,6}).
            sampleRows: [
              [20260401, '2026-04-01', 2026, 2, 4, 'April', 3, false, false],
              [20260402, '2026-04-02', 2026, 2, 4, 'April', 4, false, false],
              [20260403, '2026-04-03', 2026, 2, 4, 'April', 5, false, false],
              [20260404, '2026-04-04', 2026, 2, 4, 'April', 6, true, false],
              [20260405, '2026-04-05', 2026, 2, 4, 'April', 0, true, false],
              [20260406, '2026-04-06', 2026, 2, 4, 'April', 1, false, false],
              [20260408, '2026-04-08', 2026, 2, 4, 'April', 3, false, false],
              [20260409, '2026-04-09', 2026, 2, 4, 'April', 4, false, false],
              [20260412, '2026-04-12', 2026, 2, 4, 'April', 0, true, false],
            ],
          },
          {
            name: 'fact_sales',
            ddl:
              '-- Translated from dbt/models/gold/fact_sales.sql\n' +
              'CREATE TABLE gold.fact_sales (\n' +
              '    sales_key          BIGINT         NOT NULL,\n' +
              '    customer_key       BIGINT         NOT NULL,\n' +
              '    product_key        BIGINT         NOT NULL,\n' +
              '    order_date_key     BIGINT         NOT NULL,\n' +
              '    ship_date_key      BIGINT         NOT NULL,\n' +
              '    order_id           VARCHAR(64)    NOT NULL,\n' +
              '    quantity           INT            NOT NULL,\n' +
              '    unit_price         DECIMAL(18,2)  NOT NULL,\n' +
              '    discount_pct       DECIMAL(5,4)   NOT NULL,\n' +
              '    extended_amount    DECIMAL(18,2)  NOT NULL,\n' +
              '    cost_amount        DECIMAL(18,2)  NOT NULL,\n' +
              '    margin_amount      DECIMAL(18,2)  NOT NULL,\n' +
              '    CONSTRAINT pk_fact_sales PRIMARY KEY (sales_key)\n' +
              ') USING DELTA\n' +
              'PARTITIONED BY (order_date_key);',
            sampleRows: [
              [1, 2, 1, 20260401, 20260404, 'ORD-100001', 2, 49.99, 0.0000, 99.98, 54.99, 44.99],
              [2, 1, 3, 20260401, 20260403, 'ORD-100002', 1, 129.00, 0.1000, 116.10, 70.95, 45.15],
              [3, 3, 1, 20260402, 20260405, 'ORD-100003', 5, 49.99, 0.0500, 237.45, 137.47, 99.98],
              [4, 4, 4, 20260402, 20260406, 'ORD-100004', 1, 899.00, 0.0000, 899.00, 494.45, 404.55],
              [5, 2, 2, 20260403, 20260408, 'ORD-100005', 3, 19.95, 0.0000, 59.85, 32.92, 26.93],
              [6, 5, 3, 20260404, 20260409, 'ORD-100006', 2, 129.00, 0.1500, 219.30, 141.90, 77.40],
              [7, 1, 5, 20260405, 20260412, 'ORD-100007', 1, 2499.00, 0.0000, 2499.00, 1374.45, 1124.55],
              [8, 6, 2, 20260405, 20260408, 'ORD-100008', 10, 19.95, 0.2000, 159.60, 109.73, 49.87],
            ],
          },
        ],
        shortcuts: [
          {
            name: 'open-data-retail-public',
            target: 'https://datasetsforfabric.blob.core.windows.net/retail-public/orders.csv',
            description:
              'Read-only shortcut to a curated public retail orders dataset. Demonstrates the ' +
              'OneLake-to-public-Azure-Storage shortcut pattern. No credentials required (anonymous read).',
          },
          {
            name: 'sister-fraud-scores',
            target: 'onelake://fraud-analytics-prod/lakehouse-fraud/gold/fraud_scores',
            description:
              'Cross-workspace shortcut to the certified fraud_scores Delta table in the ' +
              'financial-fraud-detection workspace (see examples/financial-fraud-detection/contracts/fraud-scores.yaml). ' +
              'Uses the workspace MI for auth — no SAS tokens.',
          },
        ],
      },
    },
    {
      itemType: 'notebook',
      displayName: 'Lakehouse Inspector Walkthrough',
      description:
        'Profile each medallion tier: list tables, count rows, check nulls, and run ' +
        'a few representative Spark SQL queries on the gold star schema.',
      learnDoc: 'guides/spark-notebook-quickstart',
      content: {
        kind: 'notebook',
        defaultLang: 'pyspark',
        cells: [
          {
            id: 'cell-md-intro',
            type: 'markdown',
            source:
              '# Lakehouse Inspector Walkthrough\n\n' +
              'This notebook walks the **bronze / silver / gold** medallion lakehouse provisioned ' +
              'by the Lakehouse Inspector app. You will:\n\n' +
              '1. List every Delta table across all three tiers\n' +
              '2. Profile row counts per tier\n' +
              '3. Compute null counts on primary keys (data-quality smoke test)\n' +
              '4. Run sample queries against the gold star schema (`fact_sales` joined to dims)\n' +
              '5. Inspect a OneLake shortcut to confirm cross-workspace reads work\n\n' +
              '> All cells are idempotent — run any in any order. Default language is **PySpark**; ' +
              'Spark SQL cells are tagged accordingly.',
          },
          {
            id: 'cell-list-tables',
            type: 'code',
            lang: 'pyspark',
            source:
              '# 1. Enumerate every Delta table across all three medallion tiers.\n' +
              'tiers = ["bronze", "silver", "gold"]\n' +
              'rows = []\n' +
              'for tier in tiers:\n' +
              '    for t in spark.catalog.listTables(tier):\n' +
              '        rows.append((tier, t.name, t.tableType))\n' +
              '\n' +
              'from pyspark.sql import Row\n' +
              'df_tables = spark.createDataFrame([Row(tier=r[0], table=r[1], type=r[2]) for r in rows])\n' +
              'df_tables.orderBy("tier", "table").show(truncate=False)',
          },
          {
            id: 'cell-row-counts',
            type: 'code',
            lang: 'pyspark',
            source:
              '# 2. Row counts per tier. Useful smoke test — silver should >= bronze after dedupe;\n' +
              '#    gold may be smaller (dims) or larger (fact) depending on grain.\n' +
              'targets = [\n' +
              '    "bronze.bronze_sales", "bronze.bronze_customers", "bronze.bronze_products",\n' +
              '    "silver.silver_sales", "silver.silver_customers", "silver.silver_products",\n' +
              '    "gold.dim_customer", "gold.dim_product", "gold.dim_date", "gold.fact_sales",\n' +
              ']\n' +
              'for t in targets:\n' +
              '    try:\n' +
              '        n = spark.table(t).count()\n' +
              '        print(f"{t:35s}  rows = {n:>10,}")\n' +
              '    except Exception as e:\n' +
              '        print(f"{t:35s}  MISSING ({type(e).__name__})")',
          },
          {
            id: 'cell-null-pks',
            type: 'code',
            lang: 'pyspark',
            source:
              '# 3. Null check on every primary key + critical FK. Any non-zero count is a real bug.\n' +
              'from pyspark.sql.functions import col, sum as ssum, when\n' +
              '\n' +
              'checks = [\n' +
              '    ("bronze.bronze_sales",   ["order_id", "customer_id", "product_id"]),\n' +
              '    ("silver.silver_sales",   ["order_id", "customer_id", "product_id"]),\n' +
              '    ("gold.dim_customer",     ["customer_key", "customer_id"]),\n' +
              '    ("gold.dim_product",      ["product_key", "product_id"]),\n' +
              '    ("gold.dim_date",         ["date_key", "date"]),\n' +
              '    ("gold.fact_sales",       ["sales_key", "customer_key", "product_key", "order_date_key"]),\n' +
              ']\n' +
              '\n' +
              'for table, cols in checks:\n' +
              '    df = spark.table(table)\n' +
              '    aggs = [ssum(when(col(c).isNull(), 1).otherwise(0)).alias(c) for c in cols]\n' +
              '    out = df.agg(*aggs).first().asDict()\n' +
              '    bad = {k: v for k, v in out.items() if v and v > 0}\n' +
              '    flag = "OK " if not bad else "FAIL"\n' +
              '    print(f"[{flag}] {table:25s} nulls = {bad if bad else \\"{}\\" }")',
          },
          {
            id: 'cell-md-sample-queries',
            type: 'markdown',
            source:
              '## Sample gold-layer queries\n\n' +
              'The next two cells are **Spark SQL** queries against the gold star schema. ' +
              'They should run sub-second on the seed data and demonstrate the join pattern ' +
              'Power BI semantic models use under Direct Lake.',
          },
          {
            id: 'cell-top-customers',
            type: 'code',
            lang: 'sparksql',
            source:
              '-- Top 10 customers by extended sales amount in 2026-Q2.\n' +
              'SELECT\n' +
              '    c.customer_name,\n' +
              '    c.customer_segment,\n' +
              '    c.country,\n' +
              '    SUM(f.extended_amount) AS total_sales,\n' +
              '    SUM(f.margin_amount)   AS total_margin,\n' +
              '    COUNT(*)               AS line_count\n' +
              'FROM gold.fact_sales f\n' +
              'JOIN gold.dim_customer c ON c.customer_key = f.customer_key\n' +
              'JOIN gold.dim_date     d ON d.date_key     = f.order_date_key\n' +
              "WHERE d.year = 2026 AND d.quarter = 2\n" +
              'GROUP BY c.customer_name, c.customer_segment, c.country\n' +
              'ORDER BY total_sales DESC\n' +
              'LIMIT 10;',
          },
          {
            id: 'cell-category-margin',
            type: 'code',
            lang: 'sparksql',
            source:
              '-- Margin % by product category — useful for the gross-margin measure in Power BI.\n' +
              'SELECT\n' +
              '    p.category,\n' +
              '    SUM(f.extended_amount) AS revenue,\n' +
              '    SUM(f.margin_amount)   AS margin,\n' +
              '    ROUND(SUM(f.margin_amount) / NULLIF(SUM(f.extended_amount), 0) * 100, 2) AS margin_pct\n' +
              'FROM gold.fact_sales f\n' +
              'JOIN gold.dim_product p ON p.product_key = f.product_key AND p.is_current = TRUE\n' +
              'GROUP BY p.category\n' +
              'ORDER BY revenue DESC;',
          },
          {
            id: 'cell-shortcut',
            type: 'code',
            lang: 'pyspark',
            source:
              '# 5. Read through the cross-workspace shortcut to fraud_scores (gold).\n' +
              '#    Confirms the workspace MI has Storage Blob Data Reader on the sister ADLS path.\n' +
              '#\n' +
              '#    The sister storage account is deployment-specific, so we resolve it from the\n' +
              '#    LOOM_SISTER_ADLS_ACCOUNT Spark conf / env var instead of hard-coding a placeholder.\n' +
              '#    If it is not set, we print an honest remediation note rather than failing on an\n' +
              "#    unresolved '<...>' path.\n" +
              'import os\n' +
              'sister = (\n' +
              '    spark.conf.get("spark.loom.sisterAdlsAccount", None)\n' +
              '    or os.environ.get("LOOM_SISTER_ADLS_ACCOUNT")\n' +
              ')\n' +
              'if not sister:\n' +
              '    print(\n' +
              '        "[GATE] Cross-workspace shortcut not configured.\\n"\n' +
              '        "       Set the sister ADLS account before running this cell, e.g.:\\n"\n' +
              '        "         spark.conf.set(\\"spark.loom.sisterAdlsAccount\\", \\"<your_fraud_adls_account>\\")\\n"\n' +
              '        "       or provision LOOM_SISTER_ADLS_ACCOUNT in the workspace and grant the\\n"\n' +
              '        "       workspace MI \\"Storage Blob Data Reader\\" on that account. The shortcut\\n"\n' +
              '        "       target is declared on this lakehouse as \\"sister-fraud-scores\\"."\n' +
              '    )\n' +
              'else:\n' +
              '    fraud = spark.read.format("delta").load(\n' +
              '        f"abfss://gold@{sister}.dfs.core.windows.net/fraud_analytics/fraud_scores"\n' +
              '    )\n' +
              '    print("fraud_scores schema:")\n' +
              '    fraud.printSchema()\n' +
              '    print(f"\\nrow count = {fraud.count():,}")\n' +
              '    fraud.select("transaction_id", "risk_tier", "fraud_probability").show(5, truncate=False)',
          },
          {
            id: 'cell-md-next',
            type: 'markdown',
            source:
              '## Next steps\n\n' +
              '- Wire the gold layer to a **semantic model** (see the Data Steward app for a starter).\n' +
              '- Add a **dbt test job** that re-runs `not_null` + `unique` checks on every PR.\n' +
              '- Publish `fact_sales` as a **data product** via the Data Steward Console.',
          },
        ],
      },
    },
  ],
};

export default bundle;
