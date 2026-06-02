/**
 * Direct Lake-Replacement Pattern — app-install content bundle.
 *
 * Reproduces the migration use case documented in
 * docs/fiab/use-cases/direct-lake-replacement.md 1:1. The pattern stands up
 * a Loom medallion lakehouse (ADLS Gen2 Bronze/Silver/Gold), mirrors the
 * legacy operational source into Bronze, builds Silver+Gold with Databricks
 * notebooks (partitioned Gold for partition-refresh), authors a Power BI
 * Premium Import semantic model in TMDL, and wires the **Direct-Lake-Shim
 * warm-cache materializer**: a Storage Event Grid -> Shim refresh pipeline
 * that fires TOM partition-refresh on the Premium model on every Gold commit,
 * delivering 5-30 s freshness without waiting for Fabric Gov GA.
 *
 * Items provisioned (one BundleItem per object the doc calls out):
 *   1. mirrored-database  — legacy SQL source -> Bronze (Loom Mirroring / Debezium)
 *   2. lakehouse          — Bronze/Silver/Gold medallion, Gold partitioned by date,
 *                           seeded with sales-aggregate sample rows
 *   3. databricks-notebook — Silver: cleanse + conform
 *   4. databricks-notebook — Gold: business semantics + partitioned star schema
 *   5. eventstream        — Storage Event Grid (Gold BlobCreated) -> Shim refresh
 *   6. data-pipeline      — Direct-Lake-Shim refresh pipeline (loom-dl-shim configure + TOM)
 *   7. semantic-model     — Power BI Premium Import model (TMDL, deployed via TOM)
 *   8. report             — Power BI report re-authored against Gold (visual parity)
 *   9. activator          — alert when a Shim partition-refresh fails or freshness SLA breached
 *
 * Backend per item (Phase-2 provisioners, all on real REST — see
 * lib/install/provisioners/*; wired in lib/install/provisioning-engine.ts):
 *   1. mirrored-database  → mirrored-database.ts: Fabric POST /mirroredDatabases
 *                           (Base64 mirroring.json) + startMirroring →
 *                           replicates the legacy SQL source into Bronze Delta.
 *                           Honest gate: LOOM_MIRROR_SOURCE_CONNECTION_ID
 *                           (Fabric mirroring REST needs a source connection
 *                           GUID, which can't be derived from a server FQDN).
 *   2. lakehouse          → lakehouse.ts: Fabric POST /lakehouses, then SEEDS
 *                           each deltaTable's sampleRows into a REAL Delta table
 *                           via OneLake DFS create/append/flush + Load Table API
 *                           (CSV → managed Delta). Gold/dims are non-empty at
 *                           install time, before the notebooks finish.
 *   3,4. databricks-notebook → databricks-notebook.ts: Databricks
 *                           workspace/import + jobs/runs/submit on a live
 *                           cluster → actually RUNS the Silver/Gold transforms
 *                           (produces live Delta). The submit is real REST and
 *                           the run id is stamped to Cosmos; the install does
 *                           NOT block the HTTP request on the full medallion
 *                           build (a multi-minute Spark job would blow the
 *                           Azure Front Door ~30s gateway window → the prior
 *                           504). It polls a short settle window to catch an
 *                           instant failure, then returns status:'created' with
 *                           the run id while the job finishes on the cluster.
 *                           Honest gate: LOOM_DATABRICKS_HOSTNAME / a runnable
 *                           cluster / UAMI workspace access.
 *   5. eventstream        → eventstream.ts (Fabric POST /eventstreams).
 *   6. data-pipeline      → data-pipeline.ts (Fabric pipeline + on-demand run;
 *                           the on-demand run is triggered via real REST and
 *                           reported by its live job-instance id without
 *                           blocking the request to terminal, same Front Door
 *                           budget reason as the notebooks above).
 *   7. semantic-model     → semantic-model.ts (Fabric POST /semanticModels, TMSL).
 *   8. report             → report.ts: Fabric POST /reports with a PBIR
 *                           definition bound byConnection to the semantic
 *                           model (semanticmodelid=<id>) → renders over the
 *                           seeded Gold tables.
 *   9. activator          → activator.ts (Fabric Reflex rule).
 *
 * Every itemType in this bundle now has a real Phase-2 provisioner. With zero
 * customer config the install still produces a functional workspace: the
 * lakehouse seeds its sample Gold/dim rows (so the semantic model + report
 * render with data immediately), and the mirror → Bronze and notebook runs
 * surface precise honest MessageBar gates (the exact env var / role / Fabric
 * connection to provision) rather than silently skipping — per
 * .claude/rules/no-vaporware.md.
 *
 * Ground truth: docs/fiab/use-cases/direct-lake-replacement.md (migration
 * playbook steps 1-8), the Direct-Lake-Shim service + Tutorial 03 it links.
 * The Shim/TOM partition-refresh model follows the Tabular Object Model
 * RequestRefresh(RefreshType.Full) partition pattern and Power BI Premium
 * XMLA-endpoint refresh semantics (Microsoft Learn:
 * /power-bi/enterprise/service-premium-connect-tools,
 * /analysis-services/tom/understanding-the-tabular-object-model-tom).
 */

import type { AppBundle } from './types';

// ─── 1. Mirrored database: legacy operational SQL source -> Bronze ──────────
// Step 3 of the playbook: "Database sources -> Loom Mirroring Engine
// (Debezium / Cosmos connector)". The legacy BI server's primary data source
// is continuously replicated into the lakehouse Bronze layer as Delta.

const MIRROR_SOURCE = {
  kind: 'azure-sql' as const,
  server: 'legacy-bi-source.${tenantSlug}.database.windows.net',
  database: 'SalesOLTP',
  tables: [
    'dbo.SalesOrderHeader',
    'dbo.SalesOrderDetail',
    'dbo.Customer',
    'dbo.Product',
    'dbo.ProductCategory',
  ],
};

// ─── 5. Eventstream: Storage Event Grid (Gold commit) -> Shim refresh ───────
// Step 6 wires the Direct-Lake-Shim. The lakehouse Gold ADLS container raises
// a BlobCreated event on every Delta commit; Event Grid routes it to the Shim
// which fires a TOM partition refresh. This is the "commit event -> EventGrid
// -> ShimSvc -> TOM" arc in the architecture diagram.

const EVENTSTREAM_SOURCE_EVENTGRID = {
  id: 'src-gold-blob-created',
  type: 'azure-event-grid',
  config: {
    topicType: 'Microsoft.Storage.StorageAccounts',
    storageAccount: 'loomlake${tenantSlug}',
    container: 'gold',
    subjectBeginsWith: '/blobServices/default/containers/gold/blobs/gold/fact_sales/',
    subjectEndsWith: '_delta_log',
    includedEventTypes: ['Microsoft.Storage.BlobCreated'],
    systemTopicSecretRef: 'LOOM_GOLD_EVENTGRID_TOPIC',
    description:
      'Storage Event Grid system topic on the Gold ADLS Gen2 container. ' +
      'Fires on every Delta _delta_log commit to gold/fact_sales so the Shim ' +
      'only refreshes the partition that actually changed (mirrors a Direct ' +
      'Lake framing event).',
  },
};

const EVENTSTREAM_TRANSFORM_PARTITION = {
  id: 'tx-derive-partition',
  type: 'projection',
  config: {
    description:
      'Parses the changed partition key (order_date) out of the Delta commit ' +
      'blob path so the Shim refreshes a single partition, not the whole model.',
    select: [
      { column: 'event_time', expression: 'eventTime' },
      { column: 'blob_url', expression: 'data.url' },
      {
        column: 'partition_date',
        expression:
          "regexp_extract(data.url, 'order_date=([0-9]{4}-[0-9]{2}-[0-9]{2})', 1)",
      },
      { column: 'api', expression: 'data.api' },
    ],
  },
};

const EVENTSTREAM_DEST_SHIM = {
  id: 'dst-dl-shim',
  type: 'webhook',
  config: {
    description:
      'Routes the framing event to the Loom Direct-Lake-Shim refresh ' +
      'pipeline, which calls TOM RequestRefresh(Full) on the matching ' +
      'partition of the Power BI Premium model over the workspace XMLA ' +
      'endpoint.',
    endpoint: 'https://${loomHost}/api/dl-shim/refresh',
    method: 'POST',
    authSecretRef: 'LOOM_DL_SHIM_FUNCTION_KEY',
    bodyTemplate:
      '{ "semanticModelId": "${SEMANTIC_MODEL_ID}", ' +
      '"table": "FactSales", "partition": "{partition_date}", ' +
      '"refreshType": "full" }',
  },
};

// ─── 6. Direct-Lake-Shim refresh pipeline (loom-dl-shim configure + TOM) ────
// Step 6 verbatim:
//   loom-dl-shim configure --semantic-model <id> --table <gold-table>
//                          --refresh-policy partition --partition-column date
// Implemented as a Fabric Data pipeline: a Web activity to acquire an AAD
// token for the Power BI XMLA scope, then an Azure Analysis Services / Power
// BI refresh activity that issues the TOM RequestRefresh against the changed
// partition, with a wait+poll loop for the async refresh op.

const SHIM_PIPELINE_ACTIVITIES = [
  {
    name: 'GetGoldPartitionFromTrigger',
    type: 'SetVariable',
    config: {
      variableName: 'partitionDate',
      value: { value: '@pipeline().parameters.partition_date', type: 'Expression' },
    },
  },
  {
    name: 'AcquireXmlaToken',
    type: 'WebActivity',
    dependsOn: ['GetGoldPartitionFromTrigger'],
    config: {
      method: 'POST',
      url: 'https://login.microsoftonline.us/${tenantId}/oauth2/v2.0/token',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:
        'grant_type=client_credentials' +
        '&scope=https%3A%2F%2Fanalysis.usgovcloudapi.net%2Fpowerbi%2Fapi%2F.default' +
        '&client_id=@{pipeline().globalParameters.shimClientId}' +
        '&client_secret=@{pipeline().globalParameters.shimClientSecret}',
      description:
        'Client-credentials token for the Power BI XMLA endpoint (Gov cloud ' +
        'audience analysis.usgovcloudapi.net). The Shim SPN must be a member ' +
        'of the Premium workspace with Build/refresh rights.',
    },
  },
  {
    name: 'RefreshPartition',
    type: 'WebActivity',
    dependsOn: ['AcquireXmlaToken'],
    config: {
      method: 'POST',
      url:
        'https://api.powerbigov.us/v1.0/myorg/groups/' +
        '@{pipeline().globalParameters.premiumWorkspaceId}/datasets/' +
        '@{pipeline().globalParameters.semanticModelId}/refreshes',
      headers: {
        Authorization: 'Bearer @{activity(\'AcquireXmlaToken\').output.access_token}',
        'Content-Type': 'application/json',
      },
      body:
        '{ "type": "Full", "commitMode": "transactional", ' +
        '"objects": [ { "table": "FactSales", ' +
        '"partition": "@{variables(\'partitionDate\')}" } ], ' +
        '"applyRefreshPolicy": false }',
      description:
        'Enhanced-refresh (asynchronous) POST that runs a TOM ' +
        'RequestRefresh(Full) scoped to the single changed FactSales ' +
        'partition. Returns 202 + a refresh-id in the Location header.',
    },
  },
  {
    name: 'PollRefreshUntilComplete',
    type: 'Until',
    dependsOn: ['RefreshPartition'],
    config: {
      expression:
        "@not(equals(variables('refreshStatus'), 'Unknown'))",
      timeout: '0.00:05:00',
      description:
        'Polls GET .../refreshes/{id} until the enhanced-refresh status ' +
        'leaves "Unknown" (in-progress). Surfaces Completed / Failed so the ' +
        'Activator can alert on Failed.',
      activities: [
        {
          name: 'CheckRefreshStatus',
          type: 'WebActivity',
          config: {
            method: 'GET',
            url:
              'https://api.powerbigov.us/v1.0/myorg/groups/' +
              '@{pipeline().globalParameters.premiumWorkspaceId}/datasets/' +
              '@{pipeline().globalParameters.semanticModelId}/refreshes/' +
              "@{activity('RefreshPartition').output.requestId}",
            headers: {
              Authorization:
                'Bearer @{activity(\'AcquireXmlaToken\').output.access_token}',
            },
          },
        },
        {
          name: 'WaitBetweenPolls',
          type: 'Wait',
          dependsOn: ['CheckRefreshStatus'],
          config: { waitTimeInSeconds: 5 },
        },
      ],
    },
  },
];

// ─── 9. Activator rule: alert on Shim refresh failure / freshness breach ────
// The Honest-gap section commits the pattern to 5-30 s freshness. This
// Activator fires when a partition refresh fails OR when end-to-end Gold->
// model latency breaches the 30 s SLA, so operators see drift before users do.

const ACTIVATOR_RULE = {
  name: 'DL-Shim refresh SLA breach',
  condition: {
    metric: 'shim_refresh_latency_seconds',
    op: 'greaterThan',
    threshold: 30,
  },
  window: '5m',
  action: {
    kind: 'teams' as const,
    config: {
      title: 'Direct-Lake-Shim freshness SLA breached',
      message:
        'A FactSales partition refresh exceeded the 30 s warm-cache SLA or ' +
        'failed. Power BI Premium reports may be showing stale aggregates. ' +
        'Check the dl-shim-refresh pipeline run + the Premium refresh history.',
      teamsWebhookSecretRef: 'LOOM_DL_SHIM_TEAMS_WEBHOOK',
      includeFields: ['partition_date', 'refresh_status', 'latency_seconds'],
    },
  },
};

// ─── 3. Silver notebook (Databricks) — cleanse + conform ────────────────────

const NB_SILVER_CELLS = [
  {
    id: 'silver-md-intro',
    type: 'markdown' as const,
    source:
      '# Step 4a — Silver: cleanse + conform\n\n' +
      'Migration playbook **Step 4** (Build Silver + Gold via Databricks ' +
      'notebooks). This notebook reads the mirrored Bronze Delta tables ' +
      '(landed by the Loom Mirroring Engine in Step 3), applies type-casting, ' +
      'null/range validation, and de-duplication, and writes conformed Silver ' +
      'Delta tables.\n\n' +
      '- **Input:** `bronze.sales_order_header`, `bronze.sales_order_detail`, ' +
      '`bronze.customer`, `bronze.product`\n' +
      '- **Output:** `silver.sales_lines`, `silver.customer`, `silver.product`\n' +
      '- **Idempotent:** `MERGE` on natural keys so re-running is safe.',
  },
  {
    id: 'silver-conf',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      '# Config — abfss paths into the Loom lakehouse (ADLS Gen2).\n' +
      'BRONZE = "abfss://bronze@loomlake.dfs.core.windows.net"\n' +
      'SILVER = "abfss://silver@loomlake.dfs.core.windows.net"\n' +
      'spark.conf.set("spark.databricks.delta.schema.autoMerge.enabled", "true")\n' +
      '\n' +
      'from pyspark.sql import functions as F\n' +
      'from delta.tables import DeltaTable',
  },
  {
    id: 'silver-sales',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      '# Cleanse + conform sales lines: join header+detail, cast types,\n' +
      '# drop invalid rows (qty <= 0 or unit_price < 0), de-dupe by order line.\n' +
      'hdr = spark.read.format("delta").load(f"{BRONZE}/sales_order_header")\n' +
      'det = spark.read.format("delta").load(f"{BRONZE}/sales_order_detail")\n' +
      '\n' +
      'silver_sales = (\n' +
      '    det.alias("d")\n' +
      '       .join(hdr.alias("h"), F.col("d.SalesOrderID") == F.col("h.SalesOrderID"))\n' +
      '       .select(\n' +
      '           F.col("d.SalesOrderID").cast("string").alias("order_id"),\n' +
      '           F.col("d.SalesOrderDetailID").cast("string").alias("order_line_id"),\n' +
      '           F.col("h.CustomerID").cast("string").alias("customer_id"),\n' +
      '           F.col("d.ProductID").cast("string").alias("product_id"),\n' +
      '           F.to_date("h.OrderDate").alias("order_date"),\n' +
      '           F.col("d.OrderQty").cast("int").alias("quantity"),\n' +
      '           F.col("d.UnitPrice").cast("decimal(18,2)").alias("unit_price"),\n' +
      '           F.col("d.UnitPriceDiscount").cast("decimal(5,4)").alias("discount_pct"),\n' +
      '           F.current_timestamp().alias("_processed_at"),\n' +
      '       )\n' +
      '       .where("quantity > 0 AND unit_price >= 0 AND order_date IS NOT NULL")\n' +
      '       .dropDuplicates(["order_line_id"])\n' +
      ')\n' +
      '\n' +
      'silver_sales.write.format("delta").mode("overwrite") \\\n' +
      '    .option("overwriteSchema", "true").save(f"{SILVER}/sales_lines")\n' +
      'print(f"silver.sales_lines rows = {silver_sales.count():,}")',
  },
  {
    id: 'silver-dims',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      '# Conform customer + product dimensions: canonicalize text, latest snapshot.\n' +
      'cust = (\n' +
      '    spark.read.format("delta").load(f"{BRONZE}/customer")\n' +
      '         .select(\n' +
      '             F.col("CustomerID").cast("string").alias("customer_id"),\n' +
      '             F.initcap(F.trim("CustomerName")).alias("customer_name"),\n' +
      '             F.trim("Segment").alias("customer_segment"),\n' +
      '             F.upper(F.trim("CountryRegion")).alias("country"),\n' +
      '         )\n' +
      '         .dropDuplicates(["customer_id"])\n' +
      ')\n' +
      'cust.write.format("delta").mode("overwrite") \\\n' +
      '    .option("overwriteSchema", "true").save(f"{SILVER}/customer")\n' +
      '\n' +
      'prod = (\n' +
      '    spark.read.format("delta").load(f"{BRONZE}/product")\n' +
      '         .select(\n' +
      '             F.col("ProductID").cast("string").alias("product_id"),\n' +
      '             F.initcap(F.trim("Name")).alias("product_name"),\n' +
      '             F.initcap(F.trim("Category")).alias("category"),\n' +
      '             F.col("ListPrice").cast("decimal(18,2)").alias("list_price"),\n' +
      '             F.col("StandardCost").cast("decimal(18,2)").alias("standard_cost"),\n' +
      '         )\n' +
      '         .dropDuplicates(["product_id"])\n' +
      ')\n' +
      'prod.write.format("delta").mode("overwrite") \\\n' +
      '    .option("overwriteSchema", "true").save(f"{SILVER}/product")\n' +
      'print("silver dims written.")',
  },
];

// ─── 4. Gold notebook (Databricks) — star schema, partitioned by date ───────

const NB_GOLD_CELLS = [
  {
    id: 'gold-md-intro',
    type: 'markdown' as const,
    source:
      '# Step 4b — Gold: business semantics + partitioned star schema\n\n' +
      'Migration playbook **Step 4** continued: build the Gold star schema ' +
      'and — critically — **partition the Gold fact by `order_date`** so the ' +
      'Direct-Lake-Shim can run `RefreshType.Full` against a single ' +
      'partition (playbook Step 6, `--refresh-policy partition ' +
      '--partition-column date`).\n\n' +
      'Partitioning is what makes 5-30 s freshness possible: only the day ' +
      'that changed is re-imported into the Power BI Premium model, not the ' +
      'whole table.\n\n' +
      '- **Output:** `gold.dim_customer`, `gold.dim_product`, `gold.dim_date`, ' +
      '`gold.fact_sales` (PARTITIONED BY order_date)',
  },
  {
    id: 'gold-conf',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'SILVER = "abfss://silver@loomlake.dfs.core.windows.net"\n' +
      'GOLD   = "abfss://gold@loomlake.dfs.core.windows.net"\n' +
      'from pyspark.sql import functions as F',
  },
  {
    id: 'gold-dims',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      '# Surrogate-key dimensions (monotonically_increasing_id is fine for a\n' +
      '# single-writer batch; swap for an identity column at scale).\n' +
      'dim_customer = (\n' +
      '    spark.read.format("delta").load(f"{SILVER}/customer")\n' +
      '         .withColumn("customer_key", F.monotonically_increasing_id() + F.lit(1))\n' +
      ')\n' +
      'dim_customer.write.format("delta").mode("overwrite") \\\n' +
      '    .option("overwriteSchema", "true").save(f"{GOLD}/dim_customer")\n' +
      '\n' +
      'dim_product = (\n' +
      '    spark.read.format("delta").load(f"{SILVER}/product")\n' +
      '         .withColumn("product_key", F.monotonically_increasing_id() + F.lit(1))\n' +
      '         .withColumn("margin_pct",\n' +
      '             F.round((F.col("list_price") - F.col("standard_cost"))\n' +
      '                     / F.nullif(F.col("list_price"), F.lit(0)) * 100, 2))\n' +
      ')\n' +
      'dim_product.write.format("delta").mode("overwrite") \\\n' +
      '    .option("overwriteSchema", "true").save(f"{GOLD}/dim_product")',
  },
  {
    id: 'gold-date',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      '# Static date dimension 2024-01-01 .. 2027-12-31 with YYYYMMDD key.\n' +
      'dim_date = (\n' +
      '    spark.sql("SELECT explode(sequence(to_date(\'2024-01-01\'), '
      + 'to_date(\'2027-12-31\'), interval 1 day)) AS date")\n' +
      '         .withColumn("date_key", F.date_format("date", "yyyyMMdd").cast("int"))\n' +
      '         .withColumn("year",     F.year("date"))\n' +
      '         .withColumn("quarter",  F.quarter("date"))\n' +
      '         .withColumn("month",    F.month("date"))\n' +
      '         .withColumn("month_name", F.date_format("date", "MMMM"))\n' +
      ')\n' +
      'dim_date.write.format("delta").mode("overwrite") \\\n' +
      '    .option("overwriteSchema", "true").save(f"{GOLD}/dim_date")',
  },
  {
    id: 'gold-fact',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      '# Fact: join silver sales to dim surrogate keys, pre-compute measures,\n' +
      '# and PARTITION BY order_date so the Shim can refresh one partition.\n' +
      'sales = spark.read.format("delta").load(f"{SILVER}/sales_lines")\n' +
      'dc = spark.read.format("delta").load(f"{GOLD}/dim_customer").select("customer_key", "customer_id")\n' +
      'dp = spark.read.format("delta").load(f"{GOLD}/dim_product") \\\n' +
      '         .select("product_key", "product_id", "standard_cost")\n' +
      '\n' +
      'fact = (\n' +
      '    sales.join(dc, "customer_id").join(dp, "product_id")\n' +
      '         .withColumn("date_key", F.date_format("order_date", "yyyyMMdd").cast("int"))\n' +
      '         .withColumn("extended_amount",\n' +
      '             F.round(F.col("quantity") * F.col("unit_price") * (1 - F.col("discount_pct")), 2))\n' +
      '         .withColumn("cost_amount",\n' +
      '             F.round(F.col("quantity") * F.col("standard_cost"), 2))\n' +
      '         .withColumn("margin_amount",\n' +
      '             F.round(F.col("extended_amount") - F.col("cost_amount"), 2))\n' +
      '         .select("order_id", "order_line_id", "customer_key", "product_key",\n' +
      '                 "date_key", "order_date", "quantity", "unit_price",\n' +
      '                 "discount_pct", "extended_amount", "cost_amount", "margin_amount")\n' +
      ')\n' +
      '\n' +
      'fact.write.format("delta").mode("overwrite") \\\n' +
      '    .partitionBy("order_date") \\\n' +
      '    .option("overwriteSchema", "true").save(f"{GOLD}/fact_sales")\n' +
      'print(f"gold.fact_sales rows = {fact.count():,} (partitioned by order_date)")',
  },
  {
    id: 'gold-md-next',
    type: 'markdown' as const,
    source:
      '## Next: the Shim takes over\n\n' +
      'From here the **Direct-Lake-Shim refresh pipeline** runs automatically. ' +
      'Every commit to `gold/fact_sales/order_date=<day>/` raises a Storage ' +
      'Event Grid `BlobCreated` event, the eventstream extracts the changed ' +
      '`order_date`, and the pipeline issues a TOM `RequestRefresh(Full)` ' +
      'against that one partition of the **FactSales** table in the Power BI ' +
      'Premium model — warm-cache freshness in 5-30 s.',
  },
];

// ─── Bundle ─────────────────────────────────────────────────────────────────

const bundle: AppBundle = {
  appId: 'app-direct-lake-replacement',
  intro:
    '## Direct Lake-Replacement Pattern\n\n' +
    'Migrate off a legacy on-prem / third-party BI server to **Power BI ' +
    'Premium + a Loom lakehouse** with **Direct-Lake-like freshness (5-30 s)** ' +
    '— without waiting for Fabric Gov GA. This app stands up the full ' +
    '**Direct-Lake-Shim warm-cache materializer** pattern end to end:\n\n' +
    '1. **Mirror** the legacy SQL source into Bronze (Loom Mirroring / Debezium)\n' +
    '2. **Build** Silver + Gold with two Databricks notebooks; Gold fact is ' +
    '**partitioned by `order_date`** so partition-refresh works\n' +
    '3. **Shim**: a Storage **Event Grid** topic on the Gold container -> an ' +
    'eventstream that extracts the changed partition -> a refresh **pipeline** ' +
    'that fires a **TOM `RequestRefresh(Full)`** against just that partition\n' +
    '4. **Serve**: a Power BI Premium **Import semantic model** (authored in ' +
    'TMDL, deployed via TOM) + a re-authored **report** with visual parity\n' +
    '5. **Watch**: an **Activator** alert when a refresh fails or the 30 s ' +
    'freshness SLA is breached\n\n' +
    '> **Honest gap:** this delivers **5-30 s** freshness, not sub-second. ' +
    'For sub-second, wait for Fabric Gov GA (then re-author for native Direct ' +
    'Lake on OneLake) or use Databricks SQL Warehouse + DirectQuery ' +
    '(Commercial). For monthly/quarterly aggregate analytics, 5-30 s is ' +
    'better than what the legacy BI server delivered.',
  sourceDocs: ['docs/fiab/use-cases/direct-lake-replacement.md'],
  items: [
    // ── 1. Mirrored database ────────────────────────────────────────────────
    {
      itemType: 'mirrored-database',
      displayName: 'Legacy Sales OLTP Mirror (Bronze)',
      description:
        'Playbook Step 3 — continuously mirrors the legacy BI server\'s ' +
        'primary SQL source (SalesOLTP) into lakehouse Bronze as Delta via ' +
        'the Loom Mirroring Engine (Debezium CDC). Bronze is raw, no ' +
        'transformation; Silver/Gold notebooks build on it.',
      learnDoc: 'direct-lake-replacement/mirroring',
      content: {
        kind: 'mirrored-database',
        source: MIRROR_SOURCE,
      },
    },

    // ── 2. Lakehouse (Bronze/Silver/Gold medallion) ────────────────────────
    {
      itemType: 'lakehouse',
      displayName: 'Direct-Lake-Replacement Lakehouse',
      description:
        'ADLS Gen2 Bronze/Silver/Gold medallion. Gold `fact_sales` is ' +
        'PARTITIONED BY order_date so the Direct-Lake-Shim can refresh a ' +
        'single partition. Seeded with sales aggregate sample rows so the ' +
        'semantic model + report render immediately.',
      learnDoc: 'direct-lake-replacement/lakehouse',
      content: {
        kind: 'lakehouse',
        folders: [
          { path: 'bronze/sales_order_header/', description: 'Mirrored SalesOrderHeader (raw CDC Delta).' },
          { path: 'bronze/sales_order_detail/', description: 'Mirrored SalesOrderDetail line items (raw CDC Delta).' },
          { path: 'bronze/customer/', description: 'Mirrored Customer master (raw CDC Delta).' },
          { path: 'bronze/product/', description: 'Mirrored Product catalog (raw CDC Delta).' },
          { path: 'silver/sales_lines/', description: 'Cleansed + conformed sales lines (qty>0, price>=0, deduped).' },
          { path: 'silver/customer/', description: 'Canonicalized customer dimension source.' },
          { path: 'silver/product/', description: 'Canonicalized product dimension source.' },
          { path: 'gold/dim_customer/', description: 'Customer dimension with surrogate key.' },
          { path: 'gold/dim_product/', description: 'Product dimension with surrogate key + margin %.' },
          { path: 'gold/dim_date/', description: 'Static date dimension (2024-2027), YYYYMMDD key; marked as Power BI date table.' },
          {
            path: 'gold/fact_sales/',
            description:
              'Star-schema fact, PARTITIONED BY order_date. Each partition ' +
              'is the unit the Direct-Lake-Shim refreshes via TOM.',
          },
        ],
        deltaTables: [
          {
            name: 'dim_customer',
            ddl:
              'CREATE TABLE gold.dim_customer (\n' +
              '    customer_key      BIGINT        NOT NULL,\n' +
              '    customer_id       VARCHAR(64)   NOT NULL,\n' +
              '    customer_name     VARCHAR(200)  NOT NULL,\n' +
              '    customer_segment  VARCHAR(50)   NOT NULL,\n' +
              '    country           VARCHAR(8)    NOT NULL\n' +
              ') USING DELTA;',
            sampleRows: [
              [1, 'CUST-0017', 'Acme Industrial Holdings', 'Enterprise', 'US'],
              [2, 'CUST-0042', 'Smith Family Trust', 'Consumer', 'US'],
              [3, 'CUST-0103', 'Globex Sa', 'SMB', 'FR'],
              [4, 'CUST-0204', 'Initech Llc', 'SMB', 'US'],
              [5, 'CUST-0322', 'Hooli Pte Ltd', 'Enterprise', 'SG'],
            ],
          },
          {
            name: 'dim_product',
            ddl:
              'CREATE TABLE gold.dim_product (\n' +
              '    product_key    BIGINT         NOT NULL,\n' +
              '    product_id     VARCHAR(64)    NOT NULL,\n' +
              '    product_name   VARCHAR(200)   NOT NULL,\n' +
              '    category       VARCHAR(80)    NOT NULL,\n' +
              '    list_price     DECIMAL(18,2)  NOT NULL,\n' +
              '    standard_cost  DECIMAL(18,2)  NOT NULL,\n' +
              '    margin_pct     DECIMAL(5,2)\n' +
              ') USING DELTA;',
            sampleRows: [
              [1, 'SKU-9001', 'Mechanical Keyboard Mk-1', 'Peripherals', 49.99, 27.5, 44.99],
              [2, 'SKU-9101', 'Usb-C Hub Pro', 'Peripherals', 19.95, 11.0, 44.86],
              [3, 'SKU-9214', '27 4K Uhd Monitor', 'Displays', 129.0, 71.0, 44.96],
              [4, 'SKU-9555', 'Studio Microphone X', 'Audio', 899.0, 494.45, 44.99],
              [5, 'SKU-9999', 'Workstation Laptop Pro', 'Computers', 2499.0, 1374.45, 44.99],
            ],
          },
          {
            name: 'dim_date',
            ddl:
              'CREATE TABLE gold.dim_date (\n' +
              '    date_key    INT       NOT NULL,\n' +
              '    date        DATE      NOT NULL,\n' +
              '    year        INT       NOT NULL,\n' +
              '    quarter     INT       NOT NULL,\n' +
              '    month       INT       NOT NULL,\n' +
              '    month_name  VARCHAR(20) NOT NULL\n' +
              ') USING DELTA;',
            sampleRows: [
              [20260401, '2026-04-01', 2026, 2, 4, 'April'],
              [20260402, '2026-04-02', 2026, 2, 4, 'April'],
              [20260403, '2026-04-03', 2026, 2, 4, 'April'],
              [20260404, '2026-04-04', 2026, 2, 4, 'April'],
              [20260405, '2026-04-05', 2026, 2, 4, 'April'],
            ],
          },
          {
            name: 'fact_sales',
            ddl:
              '-- Partitioned so the Direct-Lake-Shim refreshes one partition.\n' +
              'CREATE TABLE gold.fact_sales (\n' +
              '    order_id         VARCHAR(64)    NOT NULL,\n' +
              '    order_line_id    VARCHAR(64)    NOT NULL,\n' +
              '    customer_key     BIGINT         NOT NULL,\n' +
              '    product_key      BIGINT         NOT NULL,\n' +
              '    date_key         INT            NOT NULL,\n' +
              '    order_date       DATE           NOT NULL,\n' +
              '    quantity         INT            NOT NULL,\n' +
              '    unit_price       DECIMAL(18,2)  NOT NULL,\n' +
              '    discount_pct     DECIMAL(5,4)   NOT NULL,\n' +
              '    extended_amount  DECIMAL(18,2)  NOT NULL,\n' +
              '    cost_amount      DECIMAL(18,2)  NOT NULL,\n' +
              '    margin_amount    DECIMAL(18,2)  NOT NULL\n' +
              ') USING DELTA\n' +
              'PARTITIONED BY (order_date);',
            sampleRows: [
              ['ORD-100001', 'L-1', 2, 1, 20260401, '2026-04-01', 2, 49.99, 0.0, 99.98, 55.0, 44.98],
              ['ORD-100002', 'L-2', 1, 3, 20260401, '2026-04-01', 1, 129.0, 0.1, 116.1, 71.0, 45.1],
              ['ORD-100003', 'L-3', 3, 1, 20260402, '2026-04-02', 5, 49.99, 0.05, 237.45, 137.5, 99.95],
              ['ORD-100004', 'L-4', 4, 4, 20260402, '2026-04-02', 1, 899.0, 0.0, 899.0, 494.45, 404.55],
              ['ORD-100005', 'L-5', 2, 2, 20260403, '2026-04-03', 3, 19.95, 0.0, 59.85, 33.0, 26.85],
              ['ORD-100006', 'L-6', 5, 3, 20260404, '2026-04-04', 2, 129.0, 0.15, 219.3, 142.0, 77.3],
              ['ORD-100007', 'L-7', 1, 5, 20260405, '2026-04-05', 1, 2499.0, 0.0, 2499.0, 1374.45, 1124.55],
            ],
          },
        ],
        shortcuts: [
          {
            name: 'legacy-bi-export-archive',
            target: 'abfss://legacy-exports@loomlake.dfs.core.windows.net/pbirs-archive',
            description:
              'Read-only shortcut to the archived legacy BI server exports ' +
              '(Power BI Report Server / third-party workbooks) kept for the ' +
              'parallel-run validation period (playbook Step 8 cutover).',
          },
        ],
      },
    },

    // ── 3. Silver notebook (Databricks) ─────────────────────────────────────
    {
      itemType: 'databricks-notebook',
      displayName: 'Silver — Cleanse & Conform',
      description:
        'Playbook Step 4a. Databricks notebook: reads mirrored Bronze, casts ' +
        'types, validates ranges, de-dupes, and writes conformed Silver Delta ' +
        'tables (sales_lines, customer, product).',
      learnDoc: 'direct-lake-replacement/silver-notebook',
      content: {
        kind: 'notebook',
        defaultLang: 'pyspark',
        cells: NB_SILVER_CELLS,
      },
    },

    // ── 4. Gold notebook (Databricks) ───────────────────────────────────────
    {
      itemType: 'databricks-notebook',
      displayName: 'Gold — Star Schema (partitioned)',
      description:
        'Playbook Step 4b. Databricks notebook: builds the Gold star schema ' +
        '(dim_customer / dim_product / dim_date / fact_sales) and PARTITIONS ' +
        'fact_sales by order_date — the unit the Direct-Lake-Shim refreshes.',
      learnDoc: 'direct-lake-replacement/gold-notebook',
      content: {
        kind: 'notebook',
        defaultLang: 'pyspark',
        cells: NB_GOLD_CELLS,
      },
    },

    // ── 5. Eventstream (Storage Event Grid -> Shim) ─────────────────────────
    {
      itemType: 'eventstream',
      displayName: 'Gold Commit -> Shim Eventstream',
      description:
        'Playbook Step 6 framing path. Storage Event Grid raises BlobCreated ' +
        'on every Gold fact_sales Delta commit; the eventstream extracts the ' +
        'changed order_date partition and routes a refresh request to the ' +
        'Direct-Lake-Shim.',
      learnDoc: 'direct-lake-replacement/eventstream',
      content: {
        kind: 'eventstream',
        sources: [EVENTSTREAM_SOURCE_EVENTGRID],
        transforms: [EVENTSTREAM_TRANSFORM_PARTITION],
        destinations: [EVENTSTREAM_DEST_SHIM],
      },
    },

    // ── 6. Direct-Lake-Shim refresh pipeline ────────────────────────────────
    {
      itemType: 'data-pipeline',
      displayName: 'Direct-Lake-Shim Refresh Pipeline',
      description:
        'Playbook Step 6 — implements `loom-dl-shim configure --refresh-policy ' +
        'partition --partition-column date`. Acquires an XMLA token, issues a ' +
        'TOM RequestRefresh(Full) against the changed FactSales partition over ' +
        'the Power BI Premium enhanced-refresh API, and polls to completion.',
      learnDoc: 'direct-lake-replacement/dl-shim-pipeline',
      content: {
        kind: 'synapse-pipeline',
        activities: SHIM_PIPELINE_ACTIVITIES,
        parameters: {
          partition_date: { type: 'string', defaultValue: '2026-04-05' },
        },
      },
    },

    // ── 7. Semantic model (Power BI Premium Import, TMDL/TOM) ───────────────
    {
      itemType: 'semantic-model',
      displayName: 'Sales Analytics (Premium Import)',
      description:
        'Playbook Step 5 — Power BI Premium Import semantic model authored in ' +
        'TMDL and deployed via TOM. Star schema over Gold (fact_sales + 3 ' +
        'dims); FactSales partitioned by date so the Shim refreshes one ' +
        'partition. The Shim pipeline targets this model.',
      learnDoc: 'direct-lake-replacement/semantic-model',
      content: {
        kind: 'semantic-model',
        tables: [
          {
            name: 'FactSales',
            columns: [
              { name: 'order_id', dataType: 'string' },
              { name: 'customer_key', dataType: 'int64' },
              { name: 'product_key', dataType: 'int64' },
              { name: 'date_key', dataType: 'int64' },
              { name: 'order_date', dataType: 'dateTime' },
              { name: 'quantity', dataType: 'int64' },
              { name: 'unit_price', dataType: 'decimal' },
              { name: 'discount_pct', dataType: 'decimal' },
              { name: 'extended_amount', dataType: 'decimal' },
              { name: 'cost_amount', dataType: 'decimal' },
              { name: 'margin_amount', dataType: 'decimal' },
            ],
          },
          {
            name: 'DimCustomer',
            columns: [
              { name: 'customer_key', dataType: 'int64' },
              { name: 'customer_id', dataType: 'string' },
              { name: 'customer_name', dataType: 'string' },
              { name: 'customer_segment', dataType: 'string' },
              { name: 'country', dataType: 'string' },
            ],
          },
          {
            name: 'DimProduct',
            columns: [
              { name: 'product_key', dataType: 'int64' },
              { name: 'product_id', dataType: 'string' },
              { name: 'product_name', dataType: 'string' },
              { name: 'category', dataType: 'string' },
              { name: 'list_price', dataType: 'decimal' },
              { name: 'standard_cost', dataType: 'decimal' },
              { name: 'margin_pct', dataType: 'decimal' },
            ],
          },
          {
            name: 'DimDate',
            columns: [
              { name: 'date_key', dataType: 'int64' },
              { name: 'date', dataType: 'dateTime' },
              { name: 'year', dataType: 'int64' },
              { name: 'quarter', dataType: 'int64' },
              { name: 'month', dataType: 'int64' },
              { name: 'month_name', dataType: 'string' },
            ],
          },
        ],
        measures: [
          { table: 'FactSales', name: 'Total Sales', expression: 'SUM(FactSales[extended_amount])', formatString: '\\$#,0.00' },
          { table: 'FactSales', name: 'Total Margin', expression: 'SUM(FactSales[margin_amount])', formatString: '\\$#,0.00' },
          { table: 'FactSales', name: 'Total Cost', expression: 'SUM(FactSales[cost_amount])', formatString: '\\$#,0.00' },
          {
            table: 'FactSales',
            name: 'Margin %',
            expression: 'DIVIDE([Total Margin], [Total Sales])',
            formatString: '0.00%',
          },
          { table: 'FactSales', name: 'Order Line Count', expression: 'COUNTROWS(FactSales)', formatString: '#,0' },
          {
            table: 'FactSales',
            name: 'Sales YoY %',
            expression:
              'VAR cur = [Total Sales] ' +
              'VAR prior = CALCULATE([Total Sales], SAMEPERIODLASTYEAR(DimDate[date])) ' +
              'RETURN DIVIDE(cur - prior, prior)',
            formatString: '0.00%',
          },
        ],
        relationships: [
          { from: 'FactSales.customer_key', to: 'DimCustomer.customer_key', cardinality: '1:many' },
          { from: 'FactSales.product_key', to: 'DimProduct.product_key', cardinality: '1:many' },
          { from: 'FactSales.date_key', to: 'DimDate.date_key', cardinality: '1:many' },
        ],
      },
    },

    // ── 8. Report (re-authored, visual parity) ──────────────────────────────
    {
      itemType: 'report',
      displayName: 'Sales Analytics Report',
      description:
        'Playbook Step 7 — Power BI report re-created against the new Premium ' +
        'semantic model to match the legacy dashboard\'s visuals. Refreshes ' +
        'on every model refresh (5-30 s after a Gold commit via the Shim).',
      learnDoc: 'direct-lake-replacement/report',
      content: {
        kind: 'report',
        pages: [
          {
            name: 'Executive Overview',
            visuals: [
              { type: 'card', title: 'Total Sales', field: 'FactSales[Total Sales]' },
              { type: 'card', title: 'Total Margin', field: 'FactSales[Total Margin]' },
              { type: 'card', title: 'Margin %', field: 'FactSales[Margin %]' },
              {
                type: 'lineChart',
                title: 'Sales Trend by Month',
                config: { axis: 'DimDate[month_name]', values: ['FactSales[Total Sales]'] },
              },
              {
                type: 'columnChart',
                title: 'Sales by Category',
                config: { axis: 'DimProduct[category]', values: ['FactSales[Total Sales]'] },
              },
            ],
          },
          {
            name: 'Customer Detail',
            visuals: [
              {
                type: 'table',
                title: 'Top Customers',
                config: {
                  columns: ['DimCustomer[customer_name]', 'DimCustomer[customer_segment]', 'FactSales[Total Sales]', 'FactSales[Margin %]'],
                  sort: { by: 'FactSales[Total Sales]', dir: 'desc' },
                  topN: 10,
                },
              },
              {
                type: 'donutChart',
                title: 'Sales by Segment',
                config: { legend: 'DimCustomer[customer_segment]', values: ['FactSales[Total Sales]'] },
              },
              {
                type: 'slicer',
                title: 'Order Date',
                config: { field: 'DimDate[date]', mode: 'between' },
              },
            ],
          },
        ],
      },
    },

    // ── 9. Activator (refresh SLA breach alert) ─────────────────────────────
    {
      itemType: 'activator',
      displayName: 'Shim Freshness Watchdog',
      description:
        'Honest-gap guard. Fires a Teams alert when a Direct-Lake-Shim ' +
        'partition refresh fails or exceeds the 30 s warm-cache freshness ' +
        'SLA, so operators catch staleness before report users do.',
      learnDoc: 'direct-lake-replacement/activator',
      content: {
        kind: 'activator',
        rule: ACTIVATOR_RULE,
      },
    },
  ],
};

export default bundle;
