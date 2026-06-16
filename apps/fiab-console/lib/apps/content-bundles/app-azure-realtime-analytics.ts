/**
 * Azure Real-Time Analytics — app-install content bundle.
 *
 * Source: docs/learn/08-solutions/azure-realtime-analytics/ — the
 * "Azure Real-Time Analytics Solution" reference architecture
 * (Kafka/Event Hubs -> Databricks Structured Streaming -> Delta Lake
 * Bronze/Silver/Gold -> MLflow + Azure OpenAI -> Power BI Direct Lake),
 * grounded in:
 *   - README.md                          (Bronze/Silver/Gold layers, tech stack, perf metrics)
 *   - implementation/databricks-setup.md (Unity Catalog catalog+schemas, cluster, ADLS mount)
 *   - implementation/stream-processing.md (Structured Streaming pipeline)
 *   - implementation/batch-processing.md (incremental merge, OPTIMIZE/ZORDER/VACUUM, SCD2)
 *   - implementation/data-quality.md     (Great Expectations + DQ validation, quarantine, KQL DQ)
 *   - implementation/azure-openai.md      (NL->SQL, insight gen, anomaly explanation, embeddings)
 *   - implementation/mlflow.md / power-bi.md (model registry + Direct Lake semantic model)
 *   - operations/dashboards.md / monitoring.md (KQL ops metrics)
 *
 * Maps each documented capability to a Loom item backed by a REAL Phase-2
 * provisioner (lib/install/provisioners/) — no new provisioner is needed;
 * every itemType below already dispatches in provisioning-engine.ts:
 *   lakehouse      -> lakehouseProvisioner    (Delta bronze/silver/gold + seeded rows)
 *   notebook (x4)  -> notebookProvisioner     (real runnable .ipynb cells)
 *   warehouse      -> warehouseProvisioner     (DQ-metrics + drift DDL + dbt gold + rows)
 *   kql-database   -> kqlDatabaseProvisioner   (ADX ops tables + functions + queries + samples)
 *   data-pipeline  -> dataPipelineProvisioner  (daily batch: Stream->DQ->Aggregate->Optimize)
 *   semantic-model -> semanticModelProvisioner (Direct Lake star model + DAX measures)
 *   activator      -> activatorProvisioner      (latency-SLA breach -> Teams page)
 *
 * Every Azure/Databricks detail is reproduced verbatim from the doc or
 * grounded in Microsoft Learn (Structured Streaming readStream/writeStream
 * with foreachBatch + checkpointLocation; Delta MERGE; OPTIMIZE ZORDER;
 * Feature/model registry via MLflow; Azure OpenAI chat.completions +
 * embeddings; Power BI Direct Lake on the gold layer).
 */

import type { AppBundle } from './types';

// ════════════════════════════════════════════════════════════════════════
//  BACKEND-AWARE SQL DIALECT
//  Per .claude/rules/no-fabric-dependency.md, Synapse Spark (Hive metastore +
//  ADLS Delta) is the Azure-native DEFAULT compute for notebooks/lakehouse;
//  Azure Databricks is opt-in. The Hive metastore has NO catalog concept and
//  NO in-engine GRANT — so Unity Catalog DDL (`CREATE CATALOG`, `USE CATALOG`,
//  3-level `catalog.schema.table` names, `GRANT … ON CATALOG/SCHEMA`) parses
//  ONLY on Databricks. Emitting it on Synapse Spark throws
//  `[PARSE_SYNTAX_ERROR] … at or near 'CATALOG'` (the live bug this fixes).
//
//  We therefore detect the engine the notebook provisioner (notebook.ts) will
//  actually route to and emit the matching dialect:
//    • Databricks  → Unity Catalog: catalog `realtime_analytics`, 3-level names.
//    • Synapse/Hive (DEFAULT) → medallion DATABASES `realtime_{bronze,silver,
//      gold}`, 2-level names, external Delta tables on the mounted ADLS path,
//      and Azure-RBAC/Access-Policy grants instead of UC GRANT.
//
//  Detection MIRRORS notebook.ts precedence exactly so the dialect can never
//  mismatch the engine: Synapse is tried first when LOOM_SYNAPSE_WORKSPACE is
//  set, so Databricks (UC) applies only when it is explicitly selected
//  (LOOM_NOTEBOOK_BACKEND=databricks) or it is the sole configured engine
//  (LOOM_DATABRICKS_HOSTNAME set and no Synapse). On the client (where LOOM_*
//  env is absent) this safely defaults to the Hive dialect — the executable
//  content that matters is built server-side at install time.
function sampleNotebookUsesUnityCatalog(): boolean {
  const env = (typeof process !== 'undefined' && process.env) || ({} as Record<string, string | undefined>);
  const forced = (env.LOOM_NOTEBOOK_BACKEND || '').toLowerCase();
  if (forced === 'databricks') return true;
  if (forced === 'synapse' || forced === 'fabric') return false;
  // Auto: Databricks only when it is configured AND Synapse is not (Synapse
  // wins when both are set, matching provisionAzureNative()).
  return !!env.LOOM_DATABRICKS_HOSTNAME && !env.LOOM_SYNAPSE_WORKSPACE;
}

const RTA_UC = sampleNotebookUsesUnityCatalog();

/**
 * Rewrite UC-style 3-level medallion references
 * (`realtime_analytics.<layer>.<table>`) to the Hive 2-level form
 * (`realtime_<layer>.<table>`) for the Synapse Spark default. No-op on
 * Databricks. Only the catalog-qualified medallion names are touched; 2-level
 * shorthand in prose and unrelated identifiers are left intact.
 */
function rta(sql: string): string {
  return RTA_UC ? sql : sql.replace(/realtime_analytics\.(bronze|silver|gold)\./g, 'realtime_$1.');
}

/** Apply the medallion dialect rewrite to every notebook cell's `source`. */
function rtaCells<T extends { source?: string | string[] }>(cells: T[]): T[] {
  return cells.map((c) => (typeof c.source === 'string' ? { ...c, source: rta(c.source) } : c));
}

// ════════════════════════════════════════════════════════════════════════
//  NOTEBOOK CELLS — 01 Unity Catalog + ADLS Bootstrap
//  (databricks-setup.md: catalog/schemas, cluster, ADLS Gen2 mount)
// ════════════════════════════════════════════════════════════════════════

const NB_BOOTSTRAP_CELLS = [
  {
    id: 'boot-md-intro',
    type: 'markdown' as const,
    source: RTA_UC
      ? '# 01 — Unity Catalog + ADLS Bootstrap\n\n' +
        'Creates the **`realtime_analytics`** Unity Catalog with the medallion ' +
        '`bronze` / `silver` / `gold` schemas and mounts the ADLS Gen2 data ' +
        'container the streaming + batch jobs read and write.\n\n' +
        '| Layer | Schema | Purpose |\n' +
        '| --- | --- | --- |\n' +
        '| Bronze | `realtime_analytics.bronze` | Raw ingested events (schema evolution, 90d hot / 2y cold) |\n' +
        '| Silver | `realtime_analytics.silver` | Validated + enriched events (enforced schema) |\n' +
        '| Gold | `realtime_analytics.gold` | Business-ready aggregates (star schema, Direct Lake) |\n\n' +
        'Mirrors `implementation/databricks-setup.md` (Databricks compute).'
      : '# 01 — Medallion Schemas + ADLS Bootstrap\n\n' +
        'Creates the medallion **databases** `realtime_bronze` / `realtime_silver` ' +
        '/ `realtime_gold` in the **Synapse Spark Hive metastore** (the Azure-native ' +
        'default — no Unity Catalog) and mounts the ADLS Gen2 data container the ' +
        'streaming + batch jobs read and write. Each medallion layer is a Spark ' +
        'database (the 2-level `database.table` namespace Hive supports); tables are ' +
        'external Delta tables stored on the mounted ADLS path.\n\n' +
        '| Layer | Database | Purpose |\n' +
        '| --- | --- | --- |\n' +
        '| Bronze | `realtime_bronze` | Raw ingested events (schema evolution, 90d hot / 2y cold) |\n' +
        '| Silver | `realtime_silver` | Validated + enriched events (enforced schema) |\n' +
        '| Gold | `realtime_gold` | Business-ready aggregates (star schema) |\n\n' +
        'Mirrors `implementation/databricks-setup.md`, adapted to the Synapse Spark ' +
        'default. (Set `LOOM_NOTEBOOK_BACKEND=databricks` to use Unity Catalog instead.)',
  },
  {
    id: 'boot-code-catalog',
    type: 'code' as const,
    lang: 'sparksql' as const,
    source: RTA_UC
      ? // Databricks / Unity Catalog: catalog + schemas + UC grants.
        '-- Create the catalog + medallion schemas (Unity Catalog, Databricks compute).\n' +
        'CREATE CATALOG IF NOT EXISTS realtime_analytics;\n' +
        'USE CATALOG realtime_analytics;\n\n' +
        'CREATE SCHEMA IF NOT EXISTS realtime_analytics.bronze;\n' +
        'CREATE SCHEMA IF NOT EXISTS realtime_analytics.silver;\n' +
        'CREATE SCHEMA IF NOT EXISTS realtime_analytics.gold;\n\n' +
        '-- Least-privilege grants from the doc (Unity Catalog).\n' +
        'GRANT USE CATALOG ON CATALOG realtime_analytics TO `data-engineers`;\n' +
        'GRANT ALL PRIVILEGES ON SCHEMA realtime_analytics.bronze TO `data-engineers`;\n' +
        'GRANT USE SCHEMA, SELECT ON SCHEMA realtime_analytics.gold TO `analysts`;'
      : // Synapse Spark / Hive metastore (Azure-native DEFAULT): the Hive
        // metastore has no catalog concept, so each medallion layer is a Spark
        // DATABASE (CREATE SCHEMA is the Spark-SQL synonym for CREATE DATABASE).
        // Both forms accept IF NOT EXISTS on Synapse Spark.
        '-- Create the medallion databases (Synapse Spark / Hive metastore — no\n' +
        '-- Unity Catalog; a database is the top-level namespace).\n' +
        'CREATE DATABASE IF NOT EXISTS realtime_bronze;\n' +
        'CREATE DATABASE IF NOT EXISTS realtime_silver;\n' +
        'CREATE DATABASE IF NOT EXISTS realtime_gold;\n\n' +
        '-- Least-privilege access is enforced OUTSIDE the engine on Synapse Spark:\n' +
        '-- the Hive metastore has no `GRANT … ON CATALOG/SCHEMA`. Grant the\n' +
        '-- `data-engineers` and `analysts` groups Storage Blob Data Reader /\n' +
        '-- Contributor on the ADLS Gen2 medallion containers via Azure RBAC, or use\n' +
        "-- Loom's Access Policy editor (lib/panes/uc-security-panel + the access-\n" +
        '-- policy wizard). On the Databricks backend these become Unity Catalog\n' +
        '-- GRANT statements automatically.',
  },
  {
    id: 'boot-code-bronze-ddl',
    type: 'code' as const,
    lang: 'sparksql' as const,
    source: RTA_UC
      ? // Databricks / Unity Catalog: managed Delta table under the catalog.
        '-- Bronze raw-events table (README "Quick Start" + data-quality schema).\n' +
        'CREATE TABLE IF NOT EXISTS realtime_analytics.bronze.events (\n' +
        '  event_id          STRING,\n' +
        '  event_timestamp   TIMESTAMP,\n' +
        '  event_type        STRING,\n' +
        '  user_id           STRING,\n' +
        '  amount            DECIMAL(10,2),\n' +
        '  currency          STRING,\n' +
        '  product_id        STRING,\n' +
        '  metadata          MAP<STRING, STRING>,\n' +
        '  _ingested_at      TIMESTAMP\n' +
        ') USING DELTA\n' +
        "TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true');"
      : // Synapse Spark / Hive: external Delta table on the mounted ADLS path
        // (the same /mnt/data container the next cell mounts), 2-level name.
        '-- Bronze raw-events table (README "Quick Start" + data-quality schema).\n' +
        '-- External Delta table on the mounted ADLS Gen2 path so the data persists\n' +
        '-- in the lake independent of the Hive metastore entry.\n' +
        'CREATE TABLE IF NOT EXISTS realtime_bronze.events (\n' +
        '  event_id          STRING,\n' +
        '  event_timestamp   TIMESTAMP,\n' +
        '  event_type        STRING,\n' +
        '  user_id           STRING,\n' +
        '  amount            DECIMAL(10,2),\n' +
        '  currency          STRING,\n' +
        '  product_id        STRING,\n' +
        '  metadata          MAP<STRING, STRING>,\n' +
        '  _ingested_at      TIMESTAMP\n' +
        ') USING DELTA\n' +
        "LOCATION '/mnt/data/bronze/events'\n" +
        "TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true');",
  },
  {
    id: 'boot-code-mount',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      '# Mount ADLS Gen2 with a service principal (databricks-setup.md).\n' +
      'configs = {\n' +
      '    "fs.azure.account.auth.type": "OAuth",\n' +
      '    "fs.azure.account.oauth.provider.type":\n' +
      '        "org.apache.hadoop.fs.azurebfs.oauth2.ClientCredsTokenProvider",\n' +
      '    "fs.azure.account.oauth2.client.id":\n' +
      '        dbutils.secrets.get("kv-secrets", "sp-client-id"),\n' +
      '    "fs.azure.account.oauth2.client.secret":\n' +
      '        dbutils.secrets.get("kv-secrets", "sp-client-secret"),\n' +
      '    "fs.azure.account.oauth2.client.endpoint":\n' +
      '        f"https://login.microsoftonline.com/{tenant_id}/oauth2/token",\n' +
      '}\n\n' +
      '# Customer-supplied ADLS Gen2 account + container (no hard-coded placeholder).\n' +
      '# Set these as notebook widgets or job params; the mount is illustrative\n' +
      '# setup, not a Loom-managed data load.\n' +
      'adls_account = dbutils.widgets.get("adls_account") if "adls_account" in [w.name for w in dbutils.widgets.getAll()] else spark.conf.get("spark.loom.adlsAccount", "")\n' +
      'adls_container = "landing"\n' +
      'assert adls_account, "Set the adls_account widget (or spark.loom.adlsAccount) to your ADLS Gen2 account."\n' +
      'if not any(m.mountPoint == "/mnt/data" for m in dbutils.fs.mounts()):\n' +
      '    dbutils.fs.mount(\n' +
      '        source=f"abfss://{adls_container}@{adls_account}.dfs.core.windows.net/",\n' +
      '        mount_point="/mnt/data",\n' +
      '        extra_configs=configs,\n' +
      '    )\n\n' +
      'display(dbutils.fs.ls("/mnt/data"))',
  },
];

// ════════════════════════════════════════════════════════════════════════
//  NOTEBOOK CELLS — 02 Structured Streaming (Bronze -> Silver, DQ gate)
//  (stream-processing.md + data-quality.md streaming quality pipeline)
// ════════════════════════════════════════════════════════════════════════

const NB_STREAM_CELLS = [
  {
    id: 'stream-md-intro',
    type: 'markdown' as const,
    source:
      '# 02 — Structured Streaming (Bronze → Silver)\n\n' +
      'Reads the raw `bronze.events` Delta stream, applies the data-quality ' +
      'gate (null / format / timestamp / duplicate checks), routes valid rows ' +
      'to `silver.validated_events` and quarantines the rest. Achieves the ' +
      'documented **<5 s p99 latency** with a 30-second micro-batch trigger ' +
      'and a checkpoint for exactly-once semantics.\n\n' +
      'Mirrors `implementation/stream-processing.md` + the *Streaming Quality ' +
      'Checks* section of `implementation/data-quality.md`.',
  },
  {
    id: 'stream-code-read',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'from pyspark.sql import functions as F\n\n' +
      '# Read the bronze events as a stream (Delta source).\n' +
      'streaming_df = (\n' +
      '    spark.readStream\n' +
      '         .format("delta")\n' +
      '         .table("realtime_analytics.bronze.events")\n' +
      ')',
  },
  {
    id: 'stream-code-dq',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      '# Apply the documented streaming data-quality checks.\n' +
      'VALID_EVENT_TYPES = ["click", "view", "purchase", "signup"]\n\n' +
      'quality_checked = (\n' +
      '    streaming_df\n' +
      '    .withColumn("quality_check_timestamp", F.current_timestamp())\n' +
      '    .withColumn("is_valid_format", F.col("event_type").isin(VALID_EVENT_TYPES))\n' +
      '    .withColumn(\n' +
      '        "is_valid_timestamp",\n' +
      '        (F.col("event_timestamp") >= F.current_timestamp() - F.expr("INTERVAL 1 DAY"))\n' +
      '        & (F.col("event_timestamp") <= F.current_timestamp()),\n' +
      '    )\n' +
      '    .withColumn(\n' +
      '        "is_valid_amount",\n' +
      '        F.when(F.col("amount").isNotNull(),\n' +
      '               (F.col("amount") >= 0) & (F.col("amount") <= 1000000))\n' +
      '         .otherwise(F.lit(True)),\n' +
      '    )\n' +
      '    .withColumn(\n' +
      '        "quality_passed",\n' +
      '        F.col("event_id").isNotNull()\n' +
      '        & F.col("is_valid_format")\n' +
      '        & F.col("is_valid_timestamp")\n' +
      '        & F.col("is_valid_amount"),\n' +
      '    )\n' +
      ')',
  },
  {
    id: 'stream-code-foreach',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'def process_quality_batch(batch_df, batch_id):\n' +
      '    """Split each micro-batch into valid (silver) + quarantine."""\n' +
      '    valid = batch_df.filter(F.col("quality_passed"))\n' +
      '    invalid = batch_df.filter(~F.col("quality_passed"))\n\n' +
      '    (valid.drop("quality_passed")\n' +
      '          .write.format("delta").mode("append")\n' +
      '          .saveAsTable("realtime_analytics.silver.validated_events"))\n\n' +
      '    (invalid.write.format("delta").mode("append")\n' +
      '            .saveAsTable("realtime_analytics.bronze.events_quarantine"))\n\n' +
      '    metrics = batch_df.agg(\n' +
      '        F.count("*").alias("total_records"),\n' +
      '        F.sum(F.col("quality_passed").cast("int")).alias("valid_records"),\n' +
      '    ).withColumn("batch_id", F.lit(batch_id)) \\\n' +
      '     .withColumn("timestamp", F.current_timestamp())\n' +
      '    (metrics.write.format("delta").mode("append")\n' +
      '            .saveAsTable("realtime_analytics.gold.streaming_quality_metrics"))\n\n\n' +
      'query = (\n' +
      '    quality_checked.writeStream\n' +
      '    .format("delta")\n' +
      '    .outputMode("append")\n' +
      '    .option("checkpointLocation", "/mnt/checkpoints/silver/validated_events")\n' +
      '    .trigger(processingTime="30 seconds")\n' +
      '    .foreachBatch(process_quality_batch)\n' +
      '    .start()\n' +
      ')\n' +
      'query.awaitTermination()',
  },
];

// ════════════════════════════════════════════════════════════════════════
//  NOTEBOOK CELLS — 03 Batch Gold Aggregation + Delta Optimize
//  (batch-processing.md: incremental MERGE, partition pruning, OPTIMIZE)
// ════════════════════════════════════════════════════════════════════════

const NB_BATCH_CELLS = [
  {
    id: 'batch-md-intro',
    type: 'markdown' as const,
    source:
      '# 03 — Batch Gold Aggregation + Delta Optimize\n\n' +
      'Daily batch that incrementally merges new `silver.validated_events` ' +
      'into the gold star-schema fact (`gold.customer_daily_metrics`), then ' +
      'runs `OPTIMIZE … ZORDER` + `VACUUM` for query performance. Scheduled ' +
      'from the **Daily Batch Processing** pipeline in this workspace.\n\n' +
      'Mirrors `implementation/batch-processing.md`.',
  },
  {
    id: 'batch-code-merge',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'from delta.tables import DeltaTable\n' +
      'from pyspark.sql import functions as F\n\n\n' +
      'def build_customer_daily_metrics():\n' +
      '    """Incrementally aggregate validated events into the gold fact."""\n' +
      '    daily = (\n' +
      '        spark.table("realtime_analytics.silver.validated_events")\n' +
      '             .withColumn("metric_date", F.to_date("event_timestamp"))\n' +
      '             .groupBy("user_id", "metric_date")\n' +
      '             .agg(\n' +
      '                 F.count("*").alias("event_count"),\n' +
      '                 F.sum(F.when(F.col("event_type") == "purchase", F.col("amount"))\n' +
      '                        .otherwise(0)).alias("total_revenue"),\n' +
      '                 F.countDistinct("product_id").alias("unique_products"),\n' +
      '             )\n' +
      '    )\n\n' +
      '    target = DeltaTable.forName(spark, "realtime_analytics.gold.customer_daily_metrics")\n' +
      '    (target.alias("t").merge(\n' +
      '        daily.alias("s"),\n' +
      '        "t.user_id = s.user_id AND t.metric_date = s.metric_date")\n' +
      '     .whenMatchedUpdateAll()\n' +
      '     .whenNotMatchedInsertAll()\n' +
      '     .execute())\n\n\n' +
      'build_customer_daily_metrics()',
  },
  {
    id: 'batch-code-optimize',
    type: 'code' as const,
    lang: 'sparksql' as const,
    source:
      '-- Compact + Z-order the gold fact, then reclaim old files.\n' +
      'OPTIMIZE realtime_analytics.gold.customer_daily_metrics\n' +
      '  ZORDER BY (metric_date, user_id);\n\n' +
      'VACUUM realtime_analytics.gold.customer_daily_metrics RETAIN 168 HOURS;\n\n' +
      'ANALYZE TABLE realtime_analytics.gold.customer_daily_metrics\n' +
      '  COMPUTE STATISTICS FOR ALL COLUMNS;',
  },
];

// ════════════════════════════════════════════════════════════════════════
//  NOTEBOOK CELLS — 04 Azure OpenAI: NL->SQL + Automated Insights
//  (azure-openai.md: chat.completions NL->SQL, insight gen, anomaly explain)
// ════════════════════════════════════════════════════════════════════════

const NB_OPENAI_CELLS = [
  {
    id: 'ai-md-intro',
    type: 'markdown' as const,
    source:
      '# 04 — Azure OpenAI: NL→SQL + Automated Insights\n\n' +
      'Wires **Azure OpenAI** into the gold layer for natural-language→SQL, ' +
      'automated insight generation, and anomaly explanation. Uses the ' +
      '`gpt-4` deployment for reasoning and `text-embedding-3-large` for ' +
      'semantic search, with the key pulled from Key Vault (never hardcoded).\n\n' +
      'Mirrors `implementation/azure-openai.md`.',
  },
  {
    id: 'ai-code-client',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'from openai import AzureOpenAI\n\n' +
      'client = AzureOpenAI(\n' +
      '    azure_endpoint=dbutils.secrets.get("kv-secrets", "azure-openai-endpoint"),\n' +
      '    api_key=dbutils.secrets.get("kv-secrets", "azure-openai-key"),\n' +
      '    api_version="2024-02-15-preview",\n' +
      ')',
  },
  {
    id: 'ai-code-nl2sql',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'def natural_language_to_sql(user_query: str, schema_context: str) -> str:\n' +
      '    """Convert a natural-language question into Spark SQL over the gold layer."""\n' +
      '    system_prompt = f"""You are a SQL expert for Azure Databricks Delta Lake.\n\n' +
      'Schema context:\n' +
      '{schema_context}\n\n' +
      'Generate syntactically correct Spark SQL.\n' +
      'Use only the tables and columns provided in the schema."""\n\n' +
      '    response = client.chat.completions.create(\n' +
      '        model="gpt-4",\n' +
      '        messages=[\n' +
      '            {"role": "system", "content": system_prompt},\n' +
      '            {"role": "user", "content": user_query},\n' +
      '        ],\n' +
      '        temperature=0,\n' +
      '        max_tokens=500,\n' +
      '    )\n' +
      '    return response.choices[0].message.content\n\n\n' +
      'schema = """\n' +
      'Table: realtime_analytics.gold.customer_daily_metrics\n' +
      'Columns: user_id, metric_date, event_count, total_revenue, unique_products\n' +
      '"""\n' +
      'sql = natural_language_to_sql(\n' +
      '    "Show me the top 10 users by revenue in the last 30 days", schema)\n' +
      'print(sql)\n' +
      'display(spark.sql(sql))',
  },
  {
    id: 'ai-code-insights',
    type: 'code' as const,
    lang: 'pyspark' as const,
    source:
      'def generate_insights(dataframe, context: str = "") -> str:\n' +
      '    """Summarize a DataFrame into executive insights with GPT-4."""\n' +
      '    summary = dataframe.describe().toPandas().to_string()\n' +
      '    prompt = f"""Analyze the following data and provide key insights:\n\n' +
      'Context: {context}\n\n' +
      'Data Summary:\n' +
      '{summary}\n\n' +
      'Provide:\n' +
      '1. Key trends\n' +
      '2. Anomalies or outliers\n' +
      '3. Actionable recommendations"""\n\n' +
      '    response = client.chat.completions.create(\n' +
      '        model="gpt-4",\n' +
      '        messages=[{"role": "user", "content": prompt}],\n' +
      '        temperature=0.7,\n' +
      '        max_tokens=800,\n' +
      '    )\n' +
      '    return response.choices[0].message.content\n\n\n' +
      'gold = spark.table("realtime_analytics.gold.customer_daily_metrics")\n' +
      'print(generate_insights(gold, "Customer behaviour for the current quarter"))',
  },
];

// ════════════════════════════════════════════════════════════════════════
//  WAREHOUSE DDL — Data-Quality metrics + DQ validation functions (seeded)
//  (data-quality.md: data_quality_metrics, streaming_quality_metrics, dashboard view)
// ════════════════════════════════════════════════════════════════════════

// Dedicated Synapse SQL pools do NOT support `CREATE TABLE IF NOT EXISTS`
// (Parse error "Incorrect syntax near IF") nor `DROP TABLE IF EXISTS` — those
// are SQL Server 2016+ / Fabric Warehouse syntax. The documented idempotent
// pattern for a dedicated pool is an OBJECT_ID pre-existence check + DROP, then
// a plain CREATE TABLE. Grounded in Microsoft Learn:
//   - "Design tables using Synapse SQL pool" (CREATE TABLE has no IF NOT EXISTS;
//     unsupported table features) and
//   - "Temporary tables in Synapse SQL" / DROP TABLE (T-SQL) — the
//     `IF OBJECT_ID('t') IS NOT NULL DROP TABLE t` idiom is the supported
//     existence-guarded drop (DROP TABLE IF EXISTS is NOT supported on a
//     dedicated pool: its DROP TABLE syntax has no IF EXISTS clause).
//
// Each statement is a SINGLE statement terminated by `;\n` so the warehouse
// provisioner's `splitBatches` (split on `;\n`) feeds the dedicated-pool TDS
// endpoint one valid batch at a time. The single-statement `IF … DROP TABLE x;`
// needs no BEGIN/END, so it survives the splitter intact, and re-running the
// install is idempotent (drop-then-create reloads a clean schema each time).
const WAREHOUSE_DDL = [
  '-- Per-table data-quality metrics (data-quality.md _log_quality_metrics).',
  "IF OBJECT_ID('data_quality_metrics', 'U') IS NOT NULL DROP TABLE data_quality_metrics;",
  'CREATE TABLE data_quality_metrics (',
  '    table_name      VARCHAR(128)  NOT NULL,',
  '    [timestamp]     DATETIME2(3)  NOT NULL,',
  '    total_records   BIGINT        NOT NULL,',
  '    valid_records   BIGINT        NOT NULL,',
  '    quality_score   DECIMAL(5,2)  NOT NULL',
  ');',
  '',
  '-- Streaming micro-batch quality metrics (foreachBatch sink).',
  "IF OBJECT_ID('streaming_quality_metrics', 'U') IS NOT NULL DROP TABLE streaming_quality_metrics;",
  'CREATE TABLE streaming_quality_metrics (',
  '    batch_id        BIGINT        NOT NULL,',
  '    [timestamp]     DATETIME2(3)  NOT NULL,',
  '    total_records   BIGINT        NOT NULL,',
  '    valid_records   BIGINT        NOT NULL,',
  '    invalid_records BIGINT        NOT NULL',
  ');',
].join('\n');

// ════════════════════════════════════════════════════════════════════════
//  KQL — operational metrics database (operations/dashboards + monitoring)
// ════════════════════════════════════════════════════════════════════════

// ADX/Eventhouse identifies a management/control command by its FIRST
// non-whitespace character being a dot (`.`). A leading `//` comment makes the
// literal first character a `/`, which the engine rejects with
//   SYN0100: 'Admin commands must have a dot (.) character as their first
//             non-whitespace character'.
// So the function body MUST begin with `.create-or-alter function` — no leading
// comment lines. The descriptive text that used to lead the body now lives in
// the command's own `with (docstring=…, folder=…)` clause, which the
// `.create-or-alter function` syntax supports (Microsoft Learn:
// ".create-or-alter function command"). This is correct regardless of how the
// kql-database provisioner forwards the body.
const KQL_FN_SUCCESS_RATE =
  ".create-or-alter function with (docstring = 'Data-quality success rate per table over a window (data-quality.md).', folder = 'RealTimeAnalytics')\n" +
  'success_rate(window: timespan = 24h)\n' +
  '{\n' +
  '    QualityMetrics\n' +
  '    | where TimeGenerated > ago(window)\n' +
  '    | summarize\n' +
  '        AvgQualityScore = avg(QualityScore),\n' +
  '        TotalProcessed  = sum(TotalRecords),\n' +
  '        TotalValid      = sum(ValidRecords),\n' +
  '        SuccessRate     = (sum(ValidRecords) * 100.0 / sum(TotalRecords))\n' +
  '        by bin(TimeGenerated, 1h), TableName\n' +
  '}';

const KQL_Q_PIPELINE_LATENCY =
  '// End-to-end pipeline latency (ingest -> silver) p50/p95/p99.\n' +
  '// The platform SLA is <5 s p99 (README performance metrics).\n' +
  'PipelineLatency\n' +
  '| where TimeGenerated > ago(1h)\n' +
  '| summarize\n' +
  '    p50 = percentile(LatencyMs, 50),\n' +
  '    p95 = percentile(LatencyMs, 95),\n' +
  '    p99 = percentile(LatencyMs, 99)\n' +
  '    by bin(TimeGenerated, 5m)\n' +
  '| extend sla_breached_p99 = p99 > 5000\n' +
  '| order by TimeGenerated asc';

const KQL_Q_THROUGHPUT =
  '// Ingestion throughput (events/sec) — README target is 1.2M events/sec.\n' +
  'IngestionThroughput\n' +
  '| where TimeGenerated > ago(1h)\n' +
  '| summarize events = sum(EventCount) by bin(TimeGenerated, 1m)\n' +
  '| extend events_per_sec = events / 60.0\n' +
  '| order by TimeGenerated asc';

const KQL_Q_DQ_FAILURES =
  '// Quality failures by validation error type in the last 24h.\n' +
  'ValidationErrors\n' +
  '| where TimeGenerated > ago(24h)\n' +
  '| summarize TotalErrors = sum(ErrorCount) by ErrorType\n' +
  '| order by TotalErrors desc';

// ════════════════════════════════════════════════════════════════════════
//  KQL DASHBOARD TILES — Real-Time Operations dashboard (operations/*)
// ════════════════════════════════════════════════════════════════════════

const TILE_THROUGHPUT_CARD =
  '// Current ingestion throughput (events/sec, last 1 min).\n' +
  'IngestionThroughput\n' +
  '| where TimeGenerated > ago(1m)\n' +
  '| summarize value = sum(EventCount) / 60.0\n' +
  "| extend display_name = 'Events / sec (1m)'";

const TILE_LATENCY_CARD =
  '// p99 end-to-end latency (ms) — turns red over the 5000 ms SLA.\n' +
  'PipelineLatency\n' +
  '| where TimeGenerated > ago(5m)\n' +
  '| summarize value = percentile(LatencyMs, 99)\n' +
  "| extend display_name = 'p99 latency (ms)'";

const TILE_LATENCY_LINE =
  '// p50/p95/p99 latency timechart over the last 4 hours.\n' +
  'PipelineLatency\n' +
  '| where TimeGenerated > ago(4h)\n' +
  '| summarize p50 = percentile(LatencyMs, 50),\n' +
  '            p95 = percentile(LatencyMs, 95),\n' +
  '            p99 = percentile(LatencyMs, 99)\n' +
  '    by bin(TimeGenerated, 5m)\n' +
  "| render timechart with (title='Pipeline Latency p50/p95/p99 (4h)')";

const TILE_DQ_BAR =
  '// Data-quality success rate by table in the last hour.\n' +
  'QualityMetrics\n' +
  '| where TimeGenerated > ago(1h)\n' +
  '| summarize SuccessRate = sum(ValidRecords) * 100.0 / sum(TotalRecords)\n' +
  '    by TableName\n' +
  '| order by SuccessRate asc\n' +
  "| render barchart with (title='DQ Success Rate by Table (1h)',\n" +
  '                       xcolumn=TableName, ycolumns=SuccessRate)';

const TILE_ERROR_PIE =
  '// Validation failures by error type (24h).\n' +
  'ValidationErrors\n' +
  '| where TimeGenerated > ago(24h)\n' +
  '| summarize value = sum(ErrorCount) by ErrorType\n' +
  "| render piechart with (title='Validation Failures by Type (24h)',\n" +
  '                       xcolumn=ErrorType, ycolumns=value)';

// ════════════════════════════════════════════════════════════════════════
//  BUNDLE
// ════════════════════════════════════════════════════════════════════════

const bundle: AppBundle = {
  appId: 'app-azure-realtime-analytics',
  intro: rta(
    '## Azure Real-Time Analytics — Kafka/Event Hubs → Databricks → Delta → Power BI\n\n' +
    'The full enterprise real-time analytics reference architecture, ' +
    'materialized as a Loom workspace (target SLA: **1.2M events/sec, ' +
    '<5 s p99 latency, 99.99% availability**):\n\n' +
    '1. **Ingestion → Bronze** — Event Hubs / Kafka land raw events in the ' +
    '`realtime_analytics.bronze.events` Delta table.\n' +
    '2. **Streaming → Silver** — Databricks Structured Streaming applies the ' +
    'data-quality gate (null/format/timestamp/dedupe) and routes valid rows ' +
    'to `silver.validated_events`, quarantining the rest.\n' +
    '3. **Batch → Gold** — daily incremental MERGE builds the ' +
    '`gold.customer_daily_metrics` star fact, then `OPTIMIZE ZORDER` + ' +
    '`VACUUM`.\n' +
    '4. **AI/ML** — Azure OpenAI for NL→SQL + automated insights; MLflow ' +
    'model registry.\n' +
    '5. **BI** — a Direct Lake semantic model over the gold layer powers ' +
    'Power BI.\n' +
    '6. **Operations** — an ADX ops database + Real-Time Operations dashboard ' +
    'track throughput, latency SLA, and DQ success rate; an Activator rule ' +
    'pages the platform team on a p99 latency-SLA breach.\n\n' +
    'The lakehouse, four notebooks, warehouse, KQL ops database, batch ' +
    'pipeline, semantic model, and Activator rule are all provisioned + ' +
    'seeded against live Azure/Fabric backends at install time (or surface a ' +
    'precise remediation gate naming the env var / role to set).'),
  sourceDocs: [
    'docs/learn/08-solutions/azure-realtime-analytics/README.md',
    'docs/learn/08-solutions/azure-realtime-analytics/architecture/components.md',
    'docs/learn/08-solutions/azure-realtime-analytics/architecture/data-flow.md',
    'docs/learn/08-solutions/azure-realtime-analytics/implementation/databricks-setup.md',
    'docs/learn/08-solutions/azure-realtime-analytics/implementation/stream-processing.md',
    'docs/learn/08-solutions/azure-realtime-analytics/implementation/batch-processing.md',
    'docs/learn/08-solutions/azure-realtime-analytics/implementation/data-quality.md',
    'docs/learn/08-solutions/azure-realtime-analytics/implementation/azure-openai.md',
    'docs/learn/08-solutions/azure-realtime-analytics/implementation/mlflow.md',
    'docs/learn/08-solutions/azure-realtime-analytics/implementation/power-bi.md',
    'docs/learn/08-solutions/azure-realtime-analytics/operations/dashboards.md',
    'docs/learn/08-solutions/azure-realtime-analytics/operations/monitoring.md',
  ],
  items: [
    // ─── Lakehouse: medallion Bronze/Silver/Gold Delta (seeded) ───────────
    {
      itemType: 'lakehouse',
      displayName: 'Real-Time Analytics Lakehouse',
      description:
        'OneLake/Delta medallion lakehouse: bronze raw events, silver ' +
        'validated events + quarantine, and the gold customer_daily_metrics ' +
        'star fact + dimension. Seeded with sample rows so the streaming and ' +
        'batch notebooks run end-to-end on first open.',
      learnDoc: 'azure-realtime-analytics',
      content: {
        kind: 'lakehouse',
        folders: [
          { path: 'Files/landing', description: 'Event Hubs / Kafka capture landing zone (Avro/JSON).' },
          { path: 'Files/checkpoints', description: 'Structured Streaming checkpoint locations.' },
          { path: 'Tables/bronze', description: 'Raw ingested events (schema evolution).' },
          { path: 'Tables/silver', description: 'Validated + enriched events.' },
          { path: 'Tables/gold', description: 'Business-ready aggregates (Direct Lake).' },
        ],
        deltaTables: [
          {
            name: 'bronze_events',
            ddl: rta(
              'CREATE TABLE realtime_analytics.bronze.events (\n' +
              '  event_id          STRING,\n' +
              '  event_timestamp   TIMESTAMP,\n' +
              '  event_type        STRING,\n' +
              '  user_id           STRING,\n' +
              '  amount            DECIMAL(10,2),\n' +
              '  currency          STRING,\n' +
              '  product_id        STRING,\n' +
              '  metadata          MAP<STRING,STRING>,\n' +
              '  _ingested_at      TIMESTAMP\n' +
              ") USING DELTA TBLPROPERTIES ('delta.enableChangeDataFeed' = 'true')"),
            sampleRows: [
              ['evt-100001', '2026-05-31T14:00:01Z', 'view',     'user-0001', null,    'USD', 'prod-A1', null, '2026-05-31T14:00:02Z'],
              ['evt-100002', '2026-05-31T14:00:03Z', 'click',    'user-0001', null,    'USD', 'prod-A1', null, '2026-05-31T14:00:04Z'],
              ['evt-100003', '2026-05-31T14:00:09Z', 'purchase', 'user-0001', 42.50,   'USD', 'prod-A1', null, '2026-05-31T14:00:10Z'],
              ['evt-100004', '2026-05-31T14:01:00Z', 'signup',   'user-0002', null,    'EUR', null,      null, '2026-05-31T14:01:01Z'],
              ['evt-100005', '2026-05-31T14:01:12Z', 'purchase', 'user-0002', 220.00,  'EUR', 'prod-B2', null, '2026-05-31T14:01:13Z'],
              ['evt-100006', '2026-05-31T14:02:00Z', 'view',     'user-0003', null,    'GBP', 'prod-C3', null, '2026-05-31T14:02:01Z'],
              ['evt-100007', '2026-05-31T14:02:30Z', 'purchase', 'user-0003', 305.75,  'GBP', 'prod-C3', null, '2026-05-31T14:02:31Z'],
              // Bad rows the DQ gate must quarantine: invalid type + out-of-range amount.
              ['evt-100008', '2026-05-31T14:03:00Z', 'unknown',  'user-0004', 9.99,    'USD', 'prod-D4', null, '2026-05-31T14:03:01Z'],
              ['evt-100009', '2026-05-31T14:03:30Z', 'purchase', 'user-0005', 5000000.0, 'USD', 'prod-E5', null, '2026-05-31T14:03:31Z'],
            ],
          },
          {
            name: 'silver_validated_events',
            ddl: rta(
              'CREATE TABLE realtime_analytics.silver.validated_events (\n' +
              '  event_id                STRING,\n' +
              '  event_timestamp         TIMESTAMP,\n' +
              '  event_type              STRING,\n' +
              '  user_id                 STRING,\n' +
              '  amount                  DECIMAL(10,2),\n' +
              '  currency                STRING,\n' +
              '  product_id              STRING,\n' +
              '  quality_check_timestamp TIMESTAMP\n' +
              ') USING DELTA'),
            sampleRows: [
              ['evt-100001', '2026-05-31T14:00:01Z', 'view',     'user-0001', null,   'USD', 'prod-A1', '2026-05-31T14:00:05Z'],
              ['evt-100003', '2026-05-31T14:00:09Z', 'purchase', 'user-0001', 42.50,  'USD', 'prod-A1', '2026-05-31T14:00:11Z'],
              ['evt-100005', '2026-05-31T14:01:12Z', 'purchase', 'user-0002', 220.00, 'EUR', 'prod-B2', '2026-05-31T14:01:14Z'],
              ['evt-100007', '2026-05-31T14:02:30Z', 'purchase', 'user-0003', 305.75, 'GBP', 'prod-C3', '2026-05-31T14:02:32Z'],
            ],
          },
          {
            name: 'gold_customer_daily_metrics',
            ddl: rta(
              'CREATE TABLE realtime_analytics.gold.customer_daily_metrics (\n' +
              '  user_id          STRING,\n' +
              '  metric_date      DATE,\n' +
              '  event_count      BIGINT,\n' +
              '  total_revenue    DECIMAL(18,2),\n' +
              '  unique_products  BIGINT\n' +
              ') USING DELTA PARTITIONED BY (metric_date)'),
            sampleRows: [
              ['user-0001', '2026-05-31', 3, 42.50,  1],
              ['user-0002', '2026-05-31', 2, 220.00, 1],
              ['user-0003', '2026-05-31', 2, 305.75, 1],
            ],
          },
          {
            name: 'gold_dim_product',
            ddl: rta(
              'CREATE TABLE realtime_analytics.gold.dim_product (\n' +
              '  product_id    STRING,\n' +
              '  product_name  STRING,\n' +
              '  category      STRING,\n' +
              '  list_price    DECIMAL(10,2)\n' +
              ') USING DELTA'),
            sampleRows: [
              ['prod-A1', 'Wireless Earbuds',   'electronics', 42.50],
              ['prod-B2', 'Standing Desk',      'home',        220.00],
              ['prod-C3', '4K Monitor',         'electronics', 305.75],
              ['prod-D4', 'Notebook Pack',      'office',      9.99],
              ['prod-E5', 'Gaming Laptop',      'electronics', 1899.00],
            ],
          },
        ],
        // Internal shortcut to the tenant's OWN landing container (Event Hubs
        // Capture writes here). `internal://<container>/<path>` resolves to the
        // primary ADLS account the Console UAMI already reads — no external host,
        // no {{ADLS_ACCOUNT}} placeholder to 404. The install provisioner
        // registers it as a real shortcut row.
        shortcuts: [
          {
            name: 'eventhub_capture',
            target: 'internal://landing/eventhub-capture',
            kind: 'files',
            description:
              'Shortcut to the tenant landing container Event Hubs Capture path so the raw ' +
              'Avro/JSON capture files are queryable without copying.',
          },
        ],
      },
    },

    // ─── Notebook 01: Unity Catalog + ADLS Bootstrap ──────────────────────
    {
      itemType: 'notebook',
      displayName: RTA_UC ? '01 — Unity Catalog + ADLS Bootstrap' : '01 — Medallion Schemas + ADLS Bootstrap',
      description: RTA_UC
        ? 'Creates the realtime_analytics Unity Catalog with bronze/silver/gold ' +
          'schemas, the bronze.events Delta table, and mounts the ADLS Gen2 ' +
          'data container. (databricks-setup.md.)'
        : 'Creates the realtime_bronze/silver/gold medallion databases in the ' +
          'Synapse Spark Hive metastore, the bronze events external Delta table, ' +
          'and mounts the ADLS Gen2 data container. (databricks-setup.md, ' +
          'Azure-native default.)',
      learnDoc: 'azure-realtime-analytics',
      content: { kind: 'notebook', defaultLang: 'pyspark', cells: NB_BOOTSTRAP_CELLS },
    },

    // ─── Notebook 02: Structured Streaming (Bronze -> Silver) ─────────────
    {
      itemType: 'notebook',
      displayName: '02 — Structured Streaming (Bronze → Silver)',
      description:
        'Databricks Structured Streaming job: reads bronze.events, applies ' +
        'the data-quality gate, writes valid rows to silver.validated_events ' +
        'and quarantines the rest with a 30 s micro-batch + checkpoint. ' +
        '(stream-processing.md + data-quality.md.)',
      learnDoc: 'azure-realtime-analytics',
      content: { kind: 'notebook', defaultLang: 'pyspark', cells: rtaCells(NB_STREAM_CELLS) },
    },

    // ─── Notebook 03: Batch Gold Aggregation + Optimize ───────────────────
    {
      itemType: 'notebook',
      displayName: '03 — Batch Gold Aggregation + Optimize',
      description:
        'Daily incremental MERGE of silver into the gold ' +
        'customer_daily_metrics star fact, followed by OPTIMIZE ZORDER + ' +
        'VACUUM + ANALYZE. (batch-processing.md.)',
      learnDoc: 'azure-realtime-analytics',
      content: { kind: 'notebook', defaultLang: 'pyspark', cells: rtaCells(NB_BATCH_CELLS) },
    },

    // ─── Notebook 04: Azure OpenAI NL->SQL + Insights ─────────────────────
    {
      itemType: 'notebook',
      displayName: '04 — Azure OpenAI (NL→SQL + Insights)',
      description:
        'Wires Azure OpenAI gpt-4 + text-embedding-3-large into the gold ' +
        'layer for natural-language→SQL, automated insight generation, and ' +
        'anomaly explanation. (azure-openai.md.)',
      learnDoc: 'azure-realtime-analytics',
      content: { kind: 'notebook', defaultLang: 'pyspark', cells: rtaCells(NB_OPENAI_CELLS) },
    },

    // ─── Warehouse: data-quality + streaming metrics (seeded) ─────────────
    {
      itemType: 'warehouse',
      displayName: 'Data Quality Warehouse',
      description:
        'Warehouse holding the per-table data_quality_metrics and ' +
        'streaming_quality_metrics tables plus a gold DQ dashboard view. ' +
        'Seeded with sample rows so the DQ dashboard renders immediately. ' +
        '(data-quality.md.)',
      learnDoc: 'azure-realtime-analytics',
      content: {
        kind: 'warehouse',
        ddl: WAREHOUSE_DDL,
        // Seeded by the warehouse provisioner (seedSampleRows) AFTER the DDL so
        // the DQ dashboard view + starter queries return non-empty result sets
        // the moment the app opens. Explicit `columns` so the multi-row INSERT
        // targets columns by name (the bracketed [timestamp] reserved word is
        // quoted by the provisioner's quoteIdent). ISO-8601 datetime literals
        // are accepted by Synapse DATETIME2.
        sampleRows: [
          {
            table: 'data_quality_metrics',
            columns: ['table_name', 'timestamp', 'total_records', 'valid_records', 'quality_score'],
            rows: [
              ['silver.validated_events',       '2026-05-31T14:00:00', 100000, 99800, 99.80],
              ['silver.validated_events',       '2026-05-31T13:00:00', 98000,  97608, 99.60],
              ['gold.customer_daily_metrics',   '2026-05-31T14:00:00', 25000,  25000, 100.00],
              ['gold.customer_daily_metrics',   '2026-05-31T13:00:00', 24500,  24500, 100.00],
            ],
          },
          {
            table: 'streaming_quality_metrics',
            columns: ['batch_id', 'timestamp', 'total_records', 'valid_records', 'invalid_records'],
            rows: [
              [1001, '2026-05-31T14:00:30', 5200, 5188, 12],
              [1002, '2026-05-31T14:01:00', 5310, 5301, 9],
              [1003, '2026-05-31T14:01:30', 4980, 4972, 8],
              [1004, '2026-05-31T14:02:00', 5125, 5096, 29],
            ],
          },
        ],
        starterQueries: [
          {
            name: 'DQ success rate by table (today)',
            sql:
              'SELECT table_name,\n' +
              '       SUM(total_records)  AS total_records,\n' +
              '       SUM(valid_records)  AS valid_records,\n' +
              '       CAST(SUM(valid_records) * 100.0 / NULLIF(SUM(total_records),0) AS DECIMAL(5,2)) AS success_rate\n' +
              'FROM data_quality_metrics\n' +
              'WHERE CAST([timestamp] AS DATE) = CAST(GETUTCDATE() AS DATE)\n' +
              'GROUP BY table_name\n' +
              'ORDER BY success_rate ASC;',
          },
          {
            name: 'Streaming reject rate (last 100 batches)',
            sql:
              'SELECT TOP 100 batch_id, [timestamp], total_records, valid_records,\n' +
              '       invalid_records,\n' +
              '       CAST(invalid_records * 100.0 / NULLIF(total_records,0) AS DECIMAL(5,2)) AS reject_pct\n' +
              'FROM streaming_quality_metrics\n' +
              'ORDER BY batch_id DESC;',
          },
        ],
        dbtModels: [
          {
            layer: 'gold',
            name: 'data_quality_dashboard',
            sql:
              'SELECT\n' +
              '  table_name,\n' +
              '  CAST([timestamp] AS DATE)                              AS metric_date,\n' +
              '  AVG(quality_score)                                     AS avg_quality_score,\n' +
              '  SUM(total_records)                                     AS total_records_processed,\n' +
              '  SUM(valid_records)                                     AS total_valid_records,\n' +
              '  (SUM(valid_records) * 100.0 / NULLIF(SUM(total_records),0)) AS success_rate,\n' +
              '  MAX([timestamp])                                       AS last_update\n' +
              'FROM data_quality_metrics\n' +
              'GROUP BY table_name, CAST([timestamp] AS DATE)',
          },
        ],
      },
    },

    // ─── KQL: operational metrics database (seeded) ───────────────────────
    {
      itemType: 'kql-database',
      displayName: 'Real-Time Ops KQL Database',
      description:
        'ADX/Eventhouse database holding IngestionThroughput, ' +
        'PipelineLatency, QualityMetrics, and ValidationErrors operational ' +
        'tables with a success_rate function and starter SLA/throughput ' +
        'queries. (operations/dashboards.md + data-quality.md KQL.)',
      learnDoc: 'azure-realtime-analytics',
      content: {
        kind: 'kql-database',
        tables: [
          {
            name: 'IngestionThroughput',
            columns: [
              { name: 'TimeGenerated', type: 'datetime' },
              { name: 'Source',        type: 'string'   },
              { name: 'EventCount',    type: 'long'     },
            ],
            sample: [
              ['2026-05-31T14:00:00Z', 'eventhub-ns-01', 71500000],
              ['2026-05-31T14:01:00Z', 'eventhub-ns-01', 72100000],
              ['2026-05-31T14:02:00Z', 'eventhub-ns-01', 70800000],
            ],
          },
          {
            name: 'PipelineLatency',
            columns: [
              { name: 'TimeGenerated', type: 'datetime' },
              { name: 'Stage',         type: 'string'   },
              { name: 'LatencyMs',     type: 'long'     },
            ],
            sample: [
              ['2026-05-31T14:00:00Z', 'ingest_to_silver', 2100],
              ['2026-05-31T14:00:05Z', 'ingest_to_silver', 3700],
              ['2026-05-31T14:00:10Z', 'ingest_to_silver', 4800],
              ['2026-05-31T14:00:15Z', 'ingest_to_silver', 5300],
            ],
          },
          {
            name: 'QualityMetrics',
            columns: [
              { name: 'TimeGenerated', type: 'datetime' },
              { name: 'TableName',     type: 'string'   },
              { name: 'QualityScore',  type: 'real'     },
              { name: 'TotalRecords',  type: 'long'     },
              { name: 'ValidRecords',  type: 'long'     },
            ],
            sample: [
              ['2026-05-31T14:00:00Z', 'silver.validated_events', 99.8, 100000, 99800],
              ['2026-05-31T14:00:00Z', 'gold.customer_daily_metrics', 100.0, 25000, 25000],
              ['2026-05-31T13:00:00Z', 'silver.validated_events', 99.6, 98000, 97608],
            ],
          },
          {
            name: 'ValidationErrors',
            columns: [
              { name: 'TimeGenerated', type: 'datetime' },
              { name: 'ErrorType',     type: 'string'   },
              { name: 'ErrorCount',    type: 'long'     },
            ],
            sample: [
              ['2026-05-31T14:00:00Z', 'invalid_event_type', 120],
              ['2026-05-31T14:00:00Z', 'amount_out_of_range', 40],
              ['2026-05-31T14:00:00Z', 'timestamp_invalid', 25],
              ['2026-05-31T14:00:00Z', 'duplicate_event_id', 15],
            ],
          },
        ],
        functions: [
          { name: 'success_rate', body: KQL_FN_SUCCESS_RATE },
        ],
        ingestionPolicies: [
          {
            // Retention uses `.alter-merge … policy retention softdelete = …`;
            // caching uses `.alter … policy caching hot = …` (NO `-merge`, and
            // the `=` is required). Grounded in Microsoft Learn:
            //   .alter-merge table policy retention command, and
            //   .alter table policy caching command (`.alter table T policy caching hot = 30d`).
            table: 'PipelineLatency',
            policy:
              '.alter-merge table PipelineLatency policy retention softdelete = 30d\n' +
              '.alter table PipelineLatency policy caching hot = 7d',
          },
          {
            table: 'IngestionThroughput',
            policy:
              '.alter-merge table IngestionThroughput policy retention softdelete = 90d\n' +
              '.alter table IngestionThroughput policy caching hot = 14d',
          },
        ],
        starterQueries: [
          { name: 'Pipeline latency p50/p95/p99 (SLA 5s)', kql: KQL_Q_PIPELINE_LATENCY },
          { name: 'Ingestion throughput (events/sec)',     kql: KQL_Q_THROUGHPUT },
          { name: 'DQ failures by error type (24h)',       kql: KQL_Q_DQ_FAILURES },
        ],
      },
    },

    // ─── KQL Dashboard: Real-Time Operations ──────────────────────────────
    {
      itemType: 'kql-dashboard',
      displayName: 'Real-Time Operations Dashboard',
      description:
        'Five-tile operations dashboard: throughput card, p99-latency card ' +
        '(SLA 5 s), latency timechart, DQ success-rate bar, and validation-' +
        'failure pie. Auto-refreshes every 30 s. (operations/dashboards.md.)',
      learnDoc: 'azure-realtime-analytics',
      content: {
        kind: 'kql-dashboard',
        // Bind the dashboard's data source to the SAME ADX database the sibling
        // "Real-Time Ops KQL Database" item provisions, so its tiles resolve the
        // seeded tables (IngestionThroughput / PipelineLatency / QualityMetrics /
        // ValidationErrors). kql-db.ts derives the DB name from that item's
        // displayName: 'Real-Time Ops KQL Database' → 'Real_Time_Ops_KQL_Database'.
        // Without this the dashboard fell back to LOOM_KUSTO_DEFAULT_DB (where the
        // tables don't exist) and every tile failed with SEM0100 "Failed to
        // resolve table or column expression named 'QualityMetrics'".
        database: 'Real_Time_Ops_KQL_Database',
        tiles: [
          { title: 'Events / sec (1m)',                 viz: 'card',  kql: TILE_THROUGHPUT_CARD },
          { title: 'p99 latency (ms)',                  viz: 'card',  kql: TILE_LATENCY_CARD },
          { title: 'Pipeline Latency p50/p95/p99 (4h)', viz: 'line',  kql: TILE_LATENCY_LINE },
          { title: 'DQ Success Rate by Table (1h)',     viz: 'bar',   kql: TILE_DQ_BAR },
          { title: 'Validation Failures by Type (24h)', viz: 'pie',   kql: TILE_ERROR_PIE },
        ],
      },
    },

    // ─── Data pipeline: daily batch orchestration ─────────────────────────
    {
      itemType: 'data-pipeline',
      displayName: 'Daily Batch Processing Pipeline',
      description:
        'Orchestrates the daily batch path from the doc: Stream-checkpoint → ' +
        'Bronze→Silver DQ → Gold aggregation → Delta optimize, each invoking ' +
        'the corresponding Databricks notebook. (batch-processing.md ADF ' +
        'DailyBatchProcessing.)',
      learnDoc: 'azure-realtime-analytics',
      content: {
        kind: 'adf-pipeline',
        parameters: {
          ProcessingDate: { type: 'string', defaultValue: '@utcnow()' },
        },
        activities: [
          {
            name: 'BronzeToSilverDQ',
            type: 'DatabricksNotebook',
            config: {
              notebookPath: '/Shared/RealTimeAnalytics/02_structured_streaming',
              baseParameters: {
                processing_date: "@{formatDateTime(pipeline().parameters.ProcessingDate, 'yyyy-MM-dd')}",
              },
              description: 'Drains the streaming checkpoint + runs the DQ gate (Step 2).',
            },
          },
          {
            name: 'GoldAggregation',
            type: 'DatabricksNotebook',
            dependsOn: ['BronzeToSilverDQ'],
            config: {
              notebookPath: '/Shared/RealTimeAnalytics/03_batch_gold_aggregation',
              baseParameters: {
                processing_date: "@{formatDateTime(pipeline().parameters.ProcessingDate, 'yyyy-MM-dd')}",
              },
              description: 'Incremental MERGE into gold.customer_daily_metrics (Step 3).',
            },
          },
          {
            // ADF has no "DatabricksSparkSql" activity type (only
            // DatabricksNotebook / DatabricksSparkJar / DatabricksSparkPython),
            // so a DatabricksSparkSql activity fails the run with "unrecognized
            // activity type". The OPTIMIZE/Z-ORDER/VACUUM maintenance runs as a
            // Databricks notebook, with the table + tuning passed as parameters.
            name: 'OptimizeGold',
            type: 'DatabricksNotebook',
            dependsOn: ['GoldAggregation'],
            config: {
              notebookPath: '/Shared/RealTimeAnalytics/04_optimize_gold',
              baseParameters: {
                target_table: rta('realtime_analytics.gold.customer_daily_metrics'),
                zorder_by: 'metric_date,user_id',
                vacuum_retain_hours: '168',
              },
              description: 'OPTIMIZE + Z-order + VACUUM of the gold fact (Step 4) via the maintenance notebook (spark.sql).',
            },
          },
        ],
      },
    },

    // ─── Semantic model: Direct Lake star over the gold layer ─────────────
    {
      itemType: 'semantic-model',
      displayName: 'Real-Time Analytics Semantic Model',
      description:
        'Power BI Direct Lake star model over the gold layer ' +
        '(customer_daily_metrics fact + dim_product) with revenue / event / ' +
        'AOV DAX measures. Powers the executive Power BI report. (power-bi.md.)',
      learnDoc: 'azure-realtime-analytics',
      content: {
        kind: 'semantic-model',
        tables: [
          {
            name: 'customer_daily_metrics',
            columns: [
              { name: 'user_id',         dataType: 'string'  },
              { name: 'metric_date',     dataType: 'dateTime' },
              { name: 'event_count',     dataType: 'int64'   },
              { name: 'total_revenue',   dataType: 'decimal' },
              { name: 'unique_products', dataType: 'int64'   },
            ],
          },
          {
            name: 'dim_product',
            columns: [
              { name: 'product_id',   dataType: 'string'  },
              { name: 'product_name', dataType: 'string'  },
              { name: 'category',     dataType: 'string'  },
              { name: 'list_price',   dataType: 'decimal' },
            ],
          },
        ],
        measures: [
          {
            table: 'customer_daily_metrics',
            name: 'Total Revenue',
            expression: 'SUM(customer_daily_metrics[total_revenue])',
            formatString: '\\$#,0.00',
          },
          {
            table: 'customer_daily_metrics',
            name: 'Total Events',
            expression: 'SUM(customer_daily_metrics[event_count])',
            formatString: '#,0',
          },
          {
            table: 'customer_daily_metrics',
            name: 'Active Users',
            expression: 'DISTINCTCOUNT(customer_daily_metrics[user_id])',
            formatString: '#,0',
          },
          {
            table: 'customer_daily_metrics',
            name: 'Avg Order Value',
            expression:
              'DIVIDE([Total Revenue], CALCULATE(SUM(customer_daily_metrics[event_count])))',
            formatString: '\\$#,0.00',
          },
        ],
        // The gold fact `customer_daily_metrics` is aggregated at the
        // (user_id, metric_date) grain (see the lakehouse DDL above) and
        // therefore carries NO product_id column — so it CANNOT relate to
        // dim_product without breaking the model (TOM rejects a relationship
        // whose FromColumn doesn't exist). dim_product is published as a
        // standalone dimension here; a product-grain relationship would
        // require a separate product-level fact (e.g. gold.product_daily_*).
        // Every relationship below references a column that exists on both
        // sides of the join.
        relationships: [],
      },
    },

    // ─── Activator: latency-SLA breach -> Teams ───────────────────────────
    {
      itemType: 'activator',
      displayName: 'Latency SLA Breach Alert',
      description:
        'Fires when the p99 ingest→silver latency exceeds the documented ' +
        '5000 ms SLA, paging the platform team via Teams. Mirrors the ' +
        'high-latency-alert in the operations runbooks.',
      learnDoc: 'azure-realtime-analytics',
      content: {
        kind: 'activator',
        rule: {
          name: 'pipeline_latency_sla_breach',
          condition: { metric: 'p99_latency_ms', op: '>', threshold: 5000 },
          window: '5 minutes',
          action: {
            kind: 'teams',
            config: {
              channel: 'rta-platform-oncall',
              title: 'Pipeline latency SLA breach — p99 > 5000 ms',
              body:
                'The ingest→silver p99 latency exceeded the 5 s SLA. Inspect ' +
                'the Real-Time Operations dashboard and the PipelineLatency ' +
                'KQL table; check streaming back-pressure and cluster autoscale.',
            },
          },
        },
      },
    },
  ],
};

export default bundle;
