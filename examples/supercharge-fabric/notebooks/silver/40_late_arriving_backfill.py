# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Late-Arriving Data with Watermarked Idempotent Backfill
# MAGIC
# MAGIC **Phase 14 Wave 3 Feature 3.11** — operationalizes
# MAGIC `docs/best-practices/data-management/late-arriving-data.md`.
# MAGIC
# MAGIC Real-world slot telemetry does **not** arrive in order. Machines lose connectivity in
# MAGIC tunnels; compliance officers correct CTR amounts days later; bug fixes require replaying
# MAGIC weeks of history. This notebook demonstrates a Silver pipeline that handles every
# MAGIC late-arrival scenario **idempotently** — re-running produces the same result, never
# MAGIC duplicates, never silently drops data.
# MAGIC
# MAGIC ## Scenarios Handled
# MAGIC
# MAGIC | # | Scenario | Pattern |
# MAGIC |---|----------|---------|
# MAGIC | 1 | **Late events** (`event_ts < arrival_ts` by hours/days) | 24h watermark, MERGE on event_id |
# MAGIC | 2 | **Corrections** (`is_correction=true`) | MERGE replaces, original_amount preserved |
# MAGIC | 3 | **Backfills** | Parameterized `process_mode="backfill"` — bypasses watermark |
# MAGIC | 4 | **Out-of-order ingestion** (B arrives before A) | `arrival_ts > existing` MERGE guard |
# MAGIC | 5 | **Reprocess after bug** | Bronze-as-source-of-truth, replay impacted partitions |
# MAGIC | 6 | **Duplicate retry storms** | Dedupe on `event_id` keeping latest `arrival_ts` |
# MAGIC | 7 | **Very late events** (beyond watermark) | Quarantine to `dlq_late_slot` for stewards |
# MAGIC
# MAGIC ## Key Concepts
# MAGIC
# MAGIC **`event_ts` vs `arrival_ts`** — `event_ts` is when the slot pull / payout / error actually
# MAGIC happened; `arrival_ts` is when Bronze received the event. Business KPIs aggregate by
# MAGIC `event_ts`. Operational SLAs measure `arrival_ts - event_ts` (the lag). Aggregating by
# MAGIC `arrival_ts` is the most common late-arrival anti-pattern.
# MAGIC
# MAGIC **Watermark** — a moving threshold *"we don't expect events older than time T"*. We use
# MAGIC `current_max_event_ts - 24h`. Events past T -> dead-letter queue, not silently dropped.
# MAGIC
# MAGIC **Idempotency** — non-negotiable. Three pillars: natural key (`event_id`),
# MAGIC `MERGE WHEN MATCHED UPDATE` instead of INSERT, and dedup windows for retry storms (keep
# MAGIC latest `arrival_ts`).

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration
# MAGIC
# MAGIC Parameters: `process_mode` (`"incremental"` default | `"backfill"`),
# MAGIC `backfill_start_date` / `backfill_end_date` (required for backfill mode),
# MAGIC `watermark_hours` (default 24), `batch_id`, `reprocess_date` (for bug-replay demo).

# COMMAND ----------

import os
import uuid
from datetime import datetime, timedelta

from delta.tables import DeltaTable
from pyspark.sql import DataFrame
from pyspark.sql.functions import (
    avg,
    coalesce,
    col,
    concat_ws,
    count,
    current_timestamp,
    date_format,
    lit,
    max as max_,
    row_number,
    sha2,
    sum as sum_,
    to_date,
    unix_timestamp,
    when,
)
from pyspark.sql.types import (
    BooleanType,
    DateType,
    DecimalType,
    IntegerType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)
from pyspark.sql.window import Window


def _get_arg(name: str, default=None):
    """Read a notebook parameter from Fabric/Synapse runtime, env var, or default."""
    try:
        import notebookutils  # Fabric runtime
        return notebookutils.notebook.getArgument(name, default)
    except Exception:
        try:
            import mssparkutils  # legacy Synapse/Fabric runtime
            return mssparkutils.notebook.getArgument(name, default)
        except Exception:
            return os.environ.get(name.upper(), default)


def _notebook_exit(status: str) -> None:
    """Exit the notebook with a status message — Fabric pipelines consume this."""
    try:
        import notebookutils
        notebookutils.notebook.exit(status)
    except Exception:
        try:
            import mssparkutils
            mssparkutils.notebook.exit(status)
        except Exception:
            raise SystemExit(status)


# Parameters (set by pipeline or manual)
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))
process_mode = _get_arg("process_mode", "incremental")  # "incremental" | "backfill"
backfill_start_date = _get_arg("backfill_start_date", None)  # e.g., "2026-01-15"
backfill_end_date = _get_arg("backfill_end_date", None)
watermark_hours = int(_get_arg("watermark_hours", 24))
reprocess_date = _get_arg("reprocess_date", None)  # for the reprocessing-after-bug demo

silver_load_id = f"silver_{batch_id}_{uuid.uuid4().hex[:8]}"

# Source and targets
source_table = "lh_bronze.bronze_slot_telemetry"
target_table = "lh_silver.silver_slot_late_arriving"
dlq_table = "lh_silver.dlq_late_slot"
audit_table = "lh_silver.reprocessing_audit"
restated_table = "lh_silver.restated_periods"
metrics_table = "lh_silver.late_arrival_metrics"

print(f"Batch ID:        {batch_id}")
print(f"Silver load ID:  {silver_load_id}")
print(f"Process mode:    {process_mode}")
print(f"Watermark hours: {watermark_hours}")
print(f"Source:          {source_table}")
print(f"Target:          {target_table}")
print(f"DLQ:             {dlq_table}")
if process_mode == "backfill":
    print(f"Backfill window: {backfill_start_date} -> {backfill_end_date}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 1 — Generate Bronze Data with Realistic Chaos
# MAGIC
# MAGIC In production Bronze is populated by upstream ingestion. For the demo we synthesize:
# MAGIC
# MAGIC | Bucket | Count | Description |
# MAGIC |--------|-------|-------------|
# MAGIC | Normal | 100 | `arrival_ts == event_ts` — happy path |
# MAGIC | Late (in-window) | 20 | `event_ts + 2d` — late but within 24h of max event |
# MAGIC | Very late | 5 | `event_ts + 30d` — beyond watermark, quarantined |
# MAGIC | Corrections | 3 | `is_correction=true` — restates prior amount |
# MAGIC | Duplicates | 2 | Same `event_id`, two `arrival_ts` (retry storm) |

# COMMAND ----------

# Bronze schema for this demo
bronze_schema = StructType([
    StructField("event_id", StringType(), False),
    StructField("machine_id", StringType(), False),
    StructField("player_id", StringType(), True),
    StructField("event_type", StringType(), False),  # spin | payout | error
    StructField("amount", DecimalType(18, 2), True),
    StructField("currency", StringType(), True),
    StructField("event_ts", TimestampType(), False),
    StructField("arrival_ts", TimestampType(), False),
    StructField("is_correction", BooleanType(), False),
    StructField("corrects_event_id", StringType(), True),
    StructField("bronze_load_id", StringType(), False),
])

NOW = datetime.utcnow().replace(microsecond=0)
ANCHOR = NOW - timedelta(hours=2)  # peak event activity 2h ago
bronze_load_id = f"bronze_demo_{batch_id}"

rows = []
# 100 normal events (arrival == event)
for i in range(100):
    ets = ANCHOR - timedelta(minutes=i)
    rows.append((f"evt-normal-{i:04d}", f"SLOT-{(i % 10) + 1:03d}", f"PLR-{i % 25:04d}",
                 "spin" if i % 3 else "payout", 50.00 + (i % 13) * 1.50, "USD",
                 ets, ets, False, None, bronze_load_id))
# 20 late but in-window (event 18h before max, arrives ~now)
for i in range(20):
    ets = ANCHOR - timedelta(hours=18, minutes=i)
    rows.append((f"evt-late-{i:04d}", f"SLOT-OFFLINE-{(i % 3) + 1:03d}",
                 f"PLR-{(i + 100) % 25:04d}", "spin", 25.00 + i, "USD",
                 ets, ets + timedelta(hours=18), False, None, bronze_load_id))
# 5 very-late (event 30 days ago, beyond 24h watermark -> DLQ)
for i in range(5):
    ets = ANCHOR - timedelta(days=30, minutes=i)
    rows.append((f"evt-verylate-{i:04d}", f"SLOT-DEAD-{i + 1:03d}", f"PLR-LOST-{i:03d}",
                 "spin", 10.00 + i, "USD", ets, NOW, False, None, bronze_load_id))
# 3 corrections (restate normal events as payouts crossing $10K CTR threshold)
for i, t in enumerate([5, 10, 15]):
    ets = ANCHOR - timedelta(minutes=t)
    rows.append((f"evt-correction-{i:04d}", f"SLOT-{(t % 10) + 1:03d}", f"PLR-{t % 25:04d}",
                 "payout", 11200.00 + i * 100, "USD", ets, NOW, True,
                 f"evt-normal-{t:04d}", bronze_load_id))
# 2 retry-storm duplicates (same event_id appears twice with different arrival_ts)
rows.append(("evt-normal-0050", "SLOT-001", "PLR-0000", "spin", 999.00, "USD",
             ANCHOR - timedelta(minutes=50), NOW + timedelta(seconds=1), False, None, bronze_load_id))
rows.append(("evt-normal-0051", "SLOT-002", "PLR-0001", "spin", 888.00, "USD",
             ANCHOR - timedelta(minutes=51), NOW + timedelta(seconds=2), False, None, bronze_load_id))

print(f"Generated {len(rows):,} Bronze rows: 100 normal | 20 late | 5 very-late | 3 corrections | 2 dupes")

df_bronze_demo = spark.createDataFrame(rows, schema=bronze_schema)

# Write Bronze (append; Bronze is append-only by contract)
spark.sql("CREATE SCHEMA IF NOT EXISTS lh_bronze")
(df_bronze_demo.write
    .format("delta")
    .mode("append")
    .option("mergeSchema", "true")
    .saveAsTable(source_table))

print(f"Wrote {df_bronze_demo.count():,} rows to {source_table}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 2 — Read Bronze for This Run
# MAGIC
# MAGIC We re-read Bronze from the table (not the in-memory DataFrame) because production reads
# MAGIC from the Lakehouse. This proves the demo works against actual Delta storage.

# COMMAND ----------

df_bronze = spark.table(source_table).filter(col("bronze_load_id") == lit(bronze_load_id))
print(f"Bronze rows for this run: {df_bronze.count():,}")
df_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 3 — Silver Schema
# MAGIC
# MAGIC Preserves `event_ts` AND `arrival_ts` so Gold can compute business KPIs (by `event_ts`)
# MAGIC and operational SLAs (lag) from the same row. Correction columns (`is_corrected`,
# MAGIC `original_amount`, `correction_ts`) preserve restatement history. Partitioned by
# MAGIC `event_date` (from `event_ts`) so corrections land in their *original* partition.

# COMMAND ----------

silver_schema = StructType([
    StructField("event_id", StringType(), False),
    StructField("machine_id", StringType(), False),
    StructField("player_id", StringType(), True),
    StructField("event_type", StringType(), False),
    StructField("amount", DecimalType(18, 2), True),
    StructField("currency", StringType(), True),
    StructField("event_ts", TimestampType(), False),
    StructField("event_date", DateType(), False),       # partition key
    StructField("arrival_ts", TimestampType(), False),
    StructField("is_corrected", BooleanType(), False),  # this row has been amended
    StructField("original_amount", DecimalType(18, 2), True),
    StructField("correction_ts", TimestampType(), True),
    StructField("last_updated", TimestampType(), False),
    StructField("bronze_load_id", StringType(), False),
    StructField("silver_load_id", StringType(), False),
    StructField("row_hash", StringType(), False),       # for restated-period detection
])

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 4 — Watermark
# MAGIC
# MAGIC `watermark = max(event_ts) - watermark_hours`. Computed from Bronze's max `event_ts`
# MAGIC (not wall-clock) so reruns are deterministic. Incremental mode: events past watermark
# MAGIC -> DLQ. Backfill mode: watermark bypassed; operator owns the date range.

# COMMAND ----------

if process_mode == "backfill":
    if not (backfill_start_date and backfill_end_date):
        msg = "ERROR: backfill mode requires backfill_start_date and backfill_end_date"
        print(msg)
        _notebook_exit(msg)
    print(f"Backfill mode -- processing event_date in [{backfill_start_date}, {backfill_end_date}]")
    df_in_scope = df_bronze.filter(
        (to_date("event_ts") >= lit(backfill_start_date)) &
        (to_date("event_ts") <= lit(backfill_end_date))
    )
    df_late_quarantine = spark.createDataFrame([], df_bronze.schema)  # no DLQ in backfill
    watermark_ts_str = "BACKFILL_BYPASS"
else:
    # Incremental: derive watermark from Bronze's max event_ts
    max_event_ts_row = df_bronze.agg(max_("event_ts").alias("m")).collect()[0]
    if max_event_ts_row["m"] is None:
        print("Bronze is empty for this run -- nothing to do")
        _notebook_exit("EMPTY_BRONZE")
    max_event_ts = max_event_ts_row["m"]
    watermark_ts = max_event_ts - timedelta(hours=watermark_hours)
    watermark_ts_str = watermark_ts.isoformat()
    print(f"Max event_ts in Bronze: {max_event_ts}")
    print(f"Watermark threshold:    {watermark_ts}  (= max - {watermark_hours}h)")

    df_in_scope = df_bronze.filter(col("event_ts") >= lit(watermark_ts))
    df_late_quarantine = df_bronze.filter(col("event_ts") < lit(watermark_ts))

print(f"In-scope rows (will be processed): {df_in_scope.count():,}")
print(f"Beyond-watermark rows (-> DLQ):    {df_late_quarantine.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 5 — Late-Event Quarantine (DLQ)
# MAGIC
# MAGIC Events past watermark go to `lh_silver.dlq_late_slot` with reason + timestamp. A daily
# MAGIC steward review job promotes acceptable rows back to Silver, marks suspect rows
# MAGIC `is_rejected=true`, and ignores duplicates. Silently rejecting late data is the most
# MAGIC common cause of under-reporting.

# COMMAND ----------

if df_late_quarantine.count() > 0:
    df_dlq = (df_late_quarantine
        .withColumn("quarantine_reason", lit("beyond_watermark_24h"))
        .withColumn("quarantine_ts", current_timestamp())
        .withColumn("watermark_threshold", lit(watermark_ts_str))
        .withColumn("silver_load_id", lit(silver_load_id)))

    (df_dlq.write
        .format("delta")
        .mode("append")
        .option("mergeSchema", "true")
        .saveAsTable(dlq_table))
    print(f"Wrote {df_dlq.count():,} late events to {dlq_table}")
else:
    print("No beyond-watermark events to quarantine")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 6 — Dedupe on `event_id` (Retry-Storm Defense)
# MAGIC
# MAGIC Bronze is append-only and accepts duplicates. We collapse them by keeping the latest
# MAGIC `arrival_ts` per `event_id` — a retry typically carries the more authoritative payload.

# COMMAND ----------

dedupe_window = (Window.partitionBy("event_id").orderBy(col("arrival_ts").desc()))

df_deduped = (df_in_scope
    .withColumn("_rn", row_number().over(dedupe_window))
    .filter(col("_rn") == 1)
    .drop("_rn"))

print(f"After dedupe on event_id: {df_deduped.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 7 — Split Corrections from Regular Events
# MAGIC
# MAGIC Two passes: regular events MERGE on `event_id`; corrections MERGE on
# MAGIC `event_id = corrects_event_id`, replacing `amount` and stamping `is_corrected=true`.

# COMMAND ----------

df_regular = df_deduped.filter(col("is_correction") == lit(False))
df_corrections = df_deduped.filter(col("is_correction") == lit(True))

print(f"Regular events:  {df_regular.count():,}")
print(f"Corrections:     {df_corrections.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 8 — Project Regular Events into Silver Shape
# MAGIC
# MAGIC Adds `event_date` (partition key), `row_hash` (sha256 over business columns, used for
# MAGIC restated-period detection in Step 12), and default correction-column values.

# COMMAND ----------

def project_to_silver(df: DataFrame) -> DataFrame:
    return (df
        .withColumn("event_date", to_date("event_ts"))
        .withColumn("is_corrected", lit(False))
        .withColumn("original_amount", lit(None).cast(DecimalType(18, 2)))
        .withColumn("correction_ts", lit(None).cast(TimestampType()))
        .withColumn("last_updated", current_timestamp())
        .withColumn("silver_load_id", lit(silver_load_id))
        .withColumn("row_hash",
            sha2(concat_ws("||",
                col("event_id"),
                col("machine_id"),
                coalesce(col("player_id"), lit("")),
                col("event_type"),
                coalesce(col("amount").cast("string"), lit("")),
                coalesce(col("currency"), lit("")),
                col("event_ts").cast("string"),
            ), 256))
        .select(*[f.name for f in silver_schema.fields]))

df_regular_silver = project_to_silver(df_regular)
print(f"Projected regular events to Silver shape: {df_regular_silver.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 9 — Idempotent MERGE for Regular Events
# MAGIC
# MAGIC Match on `event_id`. Guard: `WHEN MATCHED AND source.arrival_ts > target.arrival_ts`.
# MAGIC This makes reruns no-ops, prevents stale messages overwriting fresh rows, and handles
# MAGIC out-of-order ingestion (batch B newer than batch A but arriving first). First run
# MAGIC creates the table partitioned by `event_date`.

# COMMAND ----------

# Regular-event MERGE (do NOT touch is_corrected / original_amount / correction_ts)
REGULAR_UPDATE = {c: f"source.{c}" for c in
    ["machine_id", "player_id", "event_type", "amount", "currency",
     "event_ts", "event_date", "arrival_ts", "bronze_load_id", "silver_load_id", "row_hash"]}
REGULAR_UPDATE["last_updated"] = "current_timestamp()"

if not spark.catalog.tableExists(target_table):
    print(f"First run -- creating {target_table}")
    (df_regular_silver.write.format("delta").mode("overwrite")
        .partitionBy("event_date").option("overwriteSchema", "true")
        .saveAsTable(target_table))
    print(f"Created Silver with {spark.table(target_table).count():,} rows")
else:
    target = DeltaTable.forName(spark, target_table)
    (target.alias("target")
        .merge(df_regular_silver.alias("source"), "target.event_id = source.event_id")
        .whenMatchedUpdate(condition="source.arrival_ts > target.arrival_ts", set=REGULAR_UPDATE)
        .whenNotMatchedInsertAll()
        .execute())
    print(f"Silver row count after regular MERGE: {spark.table(target_table).count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 10 — Apply Corrections (MERGE with Restatement)
# MAGIC
# MAGIC For each correction: match on `event_id = corrects_event_id`, capture prior `amount`
# MAGIC into `original_amount` (first correction wins), replace `amount`, stamp `is_corrected=true`
# MAGIC and `correction_ts`, recompute `row_hash` (so Step 12 detects the change). Our 3
# MAGIC injected corrections restate $50-$70 spins as $11,200+ payouts, crossing the CTR $10K
# MAGIC threshold — downstream compliance opens amendment tickets on `is_corrected=true AND amount>=10000`.

# COMMAND ----------

if df_corrections.count() > 0 and spark.catalog.tableExists(target_table):
    df_corr_proj = df_corrections.select(
        col("corrects_event_id").alias("target_event_id"),
        col("amount").alias("new_amount"),
        col("event_type").alias("new_event_type"),
        col("arrival_ts").alias("correction_arrival_ts"),
        col("bronze_load_id").alias("new_bronze_load_id"),
    )

    target = DeltaTable.forName(spark, target_table)
    (target.alias("target")
        .merge(df_corr_proj.alias("corr"), "target.event_id = corr.target_event_id")
        .whenMatchedUpdate(set={
            # First correction wins for original_amount (compliance baseline)
            "original_amount":   "CASE WHEN target.is_corrected = false "
                                 "THEN target.amount ELSE target.original_amount END",
            "amount":            "corr.new_amount",
            "event_type":        "corr.new_event_type",
            "is_corrected":      "true",
            "correction_ts":     "corr.correction_arrival_ts",
            "last_updated":      "current_timestamp()",
            "bronze_load_id":    "corr.new_bronze_load_id",
            "silver_load_id":    f"'{silver_load_id}'",
            "row_hash":          "sha2(concat_ws('||', target.event_id, target.machine_id, "
                                 "coalesce(target.player_id, ''), corr.new_event_type, "
                                 "coalesce(cast(corr.new_amount as string), ''), "
                                 "coalesce(target.currency, ''), "
                                 "cast(target.event_ts as string)), 256)",
        })
        .execute())

    corrected_count = spark.table(target_table).filter(col("is_corrected") == lit(True)).count()
    print(f"Applied {df_corrections.count()} corrections; Silver has {corrected_count} corrected rows")
else:
    print("No corrections to apply")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 11 — Reprocessing After Bug Discovery
# MAGIC
# MAGIC Scenario: dedup bug affecting events on `2026-01-15`. Bronze is intact (Bronze is
# MAGIC **never** deleted — that is the whole reason scenario 5 is survivable). Replay that day
# MAGIC from Bronze; idempotent MERGE updates affected rows only. Audit row written to
# MAGIC `lh_silver.reprocessing_audit` regardless of whether matching events exist (compliance
# MAGIC captures the *attempt*). Trigger by passing `reprocess_date` as a parameter.

# COMMAND ----------

if reprocess_date:
    print(f"Reprocessing event_date = {reprocess_date} from Bronze")
    df_replay = (spark.table(source_table)
        .filter(to_date("event_ts") == lit(reprocess_date))
        .filter(col("is_correction") == lit(False)))
    affected = df_replay.count()

    audit_schema = StructType([
        StructField("audit_id", StringType(), False),
        StructField("affected_partition", StringType(), False),
        StructField("reason", StringType(), False),
        StructField("start_ts", TimestampType(), False),
        StructField("end_ts", TimestampType(), False),
        StructField("rows_replayed", IntegerType(), False),
        StructField("silver_load_id", StringType(), False),
        StructField("actor", StringType(), False),
    ])
    audit_row = spark.createDataFrame([(
        f"audit_{uuid.uuid4().hex[:8]}", reprocess_date,
        "ENG-4421: dedup key fix -- replay from Bronze",
        datetime.utcnow(), datetime.utcnow(), affected, silver_load_id,
        os.environ.get("USER", "system"),
    )], schema=audit_schema)
    (audit_row.write.format("delta").mode("append")
        .option("mergeSchema", "true").saveAsTable(audit_table))

    if affected > 0:
        df_replay_silver = project_to_silver(df_replay)
        target = DeltaTable.forName(spark, target_table)
        (target.alias("target")
            .merge(df_replay_silver.alias("source"), "target.event_id = source.event_id")
            .whenMatchedUpdate(condition="source.arrival_ts >= target.arrival_ts",
                               set=REGULAR_UPDATE)
            .whenNotMatchedInsertAll()
            .execute())
        print(f"Replay merged {affected:,} rows; audit row in {audit_table}")
    else:
        print(f"No Bronze rows for {reprocess_date}; audit row still written")
else:
    print("No reprocess_date parameter; skipping (set reprocess_date='2026-01-15' to trigger)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 12 — Restated-Period Detection
# MAGIC
# MAGIC Compare current Silver row hashes vs. prior version via Delta time-travel
# MAGIC (`versionAsOf`). Rows where `row_hash` changed AND `is_corrected=true` are logged to
# MAGIC `lh_silver.restated_periods`. Downstream Gold reads this table to discover which
# MAGIC `event_date`s changed and uses `replaceWhere` to rebuild only those partitions —
# MAGIC the cascading-restatement pattern.

# COMMAND ----------

try:
    history = DeltaTable.forName(spark, target_table).history(2).collect()
    if len(history) >= 2:
        prior_version = int(history[1]["version"])
        df_current = spark.table(target_table)
        df_prior = spark.read.format("delta").option("versionAsOf", prior_version).table(target_table)

        df_restated = (df_current.alias("c")
            .join(df_prior.alias("p"), "event_id", "left")
            .filter(col("c.is_corrected") == lit(True))
            .filter(col("p.row_hash").isNull() | (col("c.row_hash") != col("p.row_hash")))
            .select(
                col("c.event_id"),
                col("c.event_date").alias("affected_partition"),
                col("c.amount").alias("new_amount"),
                col("p.amount").alias("prior_amount"),
                col("c.correction_ts"),
                col("c.silver_load_id"),
                current_timestamp().alias("detected_ts"),
                lit("correction_or_late_arrival").alias("restatement_reason"),
            ))

        restated_count = df_restated.count()
        if restated_count > 0:
            (df_restated.write.format("delta").mode("append")
                .option("mergeSchema", "true").saveAsTable(restated_table))
            print(f"Logged {restated_count} restated rows; affected partitions:")
            df_restated.select("affected_partition").distinct().show(truncate=False)
        else:
            print("No restated periods detected (no row_hash changes)")
    else:
        print("First Silver write -- skipping restatement detection")
except Exception as e:
    print(f"Restatement detection skipped: {e}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 13 — Late-Arrival Metrics
# MAGIC
# MAGIC Hourly metrics for monitoring/alerting: late event count, avg/max arrival lag, DLQ
# MAGIC count (write-off rate), correction count. Data Activator alerts on late ratio > 1% for
# MAGIC 1h (page source-system owner first), p99 lag > 2x baseline, or restatement frequency
# MAGIC > 4-week mean + 2-sigma.

# COMMAND ----------

# Aggregate metrics over the in-scope batch
df_silver_now = spark.table(target_table).filter(col("silver_load_id") == lit(silver_load_id))

if df_silver_now.count() > 0:
    df_metrics = (df_silver_now
        .withColumn("lag_seconds",
                    unix_timestamp("arrival_ts") - unix_timestamp("event_ts"))
        .withColumn("event_hour", date_format("event_ts", "yyyy-MM-dd HH:00:00"))
        .groupBy("event_hour")
        .agg(
            count("*").alias("event_count"),
            sum_(when(col("lag_seconds") > 3600, 1).otherwise(0)).alias("late_event_count"),
            avg("lag_seconds").alias("avg_lag_sec"),
            max_("lag_seconds").alias("max_lag_sec"),
            sum_(when(col("is_corrected") == lit(True), 1).otherwise(0)).alias("correction_count"),
        )
        .withColumn("dlq_count", lit(df_late_quarantine.count()))
        .withColumn("silver_load_id", lit(silver_load_id))
        .withColumn("computed_ts", current_timestamp())
        .withColumn("process_mode", lit(process_mode)))

    (df_metrics.write.format("delta").mode("append")
        .option("mergeSchema", "true")
        .saveAsTable(metrics_table))
    print(f"Wrote metrics rows to {metrics_table}")
    df_metrics.show(truncate=False)
else:
    print("No rows in this load; skipping metrics")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 14 — Verification
# MAGIC
# MAGIC Three assertions: (1) no duplicate `event_id` in Silver (idempotency), (2) corrected
# MAGIC rows have `is_corrected=true` and `original_amount` set (correctness), (3) DLQ count
# MAGIC equals the 5 very-late events injected (watermark).

# COMMAND ----------

# 1) Idempotency: no event_id appears twice in Silver
dup_count = (spark.table(target_table).groupBy("event_id").count()
    .filter(col("count") > 1).count())
print(f"[Idempotency] Duplicate event_ids: {dup_count} -- {'PASS' if dup_count == 0 else 'FAIL'}")

# 2) Correctness: corrected rows have is_corrected=true and original_amount populated
corrected = (spark.table(target_table)
    .filter(col("is_corrected") == lit(True))
    .filter(col("silver_load_id") == lit(silver_load_id)))
print(f"[Correctness] Corrected rows in this load: {corrected.count()} (expected: 3)")
corrected.select("event_id", "original_amount", "amount", "is_corrected", "correction_ts").show(truncate=False)

# 3) Watermark: DLQ has the very-late events
if df_late_quarantine.count() > 0:
    dlq_now = (spark.table(dlq_table)
        .filter(col("silver_load_id") == lit(silver_load_id)).count())
    expected_dlq = 5
    print(f"[Watermark] DLQ rows from this load: {dlq_now}  (expected: {expected_dlq})  "
          f"-- {'PASS' if dlq_now == expected_dlq else 'FAIL'}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 15 — Re-Run Idempotency Proof
# MAGIC
# MAGIC Re-execute the regular MERGE; verify row count is unchanged. In production, this
# MAGIC property is what protects backfills from doubling totals.

# COMMAND ----------

silver_count_before = spark.table(target_table).count()

# Repeat the regular MERGE -- a true idempotency test would yield zero deltas
target = DeltaTable.forName(spark, target_table)
(target.alias("target")
    .merge(df_regular_silver.alias("source"), "target.event_id = source.event_id")
    .whenMatchedUpdate(condition="source.arrival_ts > target.arrival_ts", set=REGULAR_UPDATE)
    .whenNotMatchedInsertAll()
    .execute())

silver_count_after = spark.table(target_table).count()
delta = silver_count_after - silver_count_before
print(f"[Idempotency Re-run] Before: {silver_count_before:,} After: {silver_count_after:,} "
      f"Delta: {delta} -- {'PASS' if delta == 0 else 'FAIL'}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 16 — Optimize

# COMMAND ----------

try:
    spark.sql(f"OPTIMIZE {target_table} ZORDER BY (event_id, machine_id)")
    print(f"Optimized {target_table}")
except Exception as e:
    print(f"OPTIMIZE skipped: {e}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Step 17 — Cleanup (Demo Only)
# MAGIC
# MAGIC In production we **never** drop tables. For demo runs the reset block below is optional.

# COMMAND ----------

# --- Reset block (DO NOT RUN IN PROD) ---
# for t in [target_table, dlq_table, audit_table, restated_table, metrics_table]:
#     spark.sql(f"DROP TABLE IF EXISTS {t}")
# spark.sql(f"DELETE FROM {source_table} WHERE bronze_load_id = '{bronze_load_id}'")

print("Demo complete -- all tables preserved.")
print("Backfill rerun:   process_mode='backfill', backfill_start_date='YYYY-MM-DD', backfill_end_date='YYYY-MM-DD'")
print("Reprocess rerun:  reprocess_date='YYYY-MM-DD'")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary
# MAGIC
# MAGIC **Tables produced:** `silver_slot_late_arriving` (cleansed, correction-aware),
# MAGIC `dlq_late_slot` (beyond-watermark), `reprocessing_audit` (bug-replay log),
# MAGIC `restated_periods` (Gold input), `late_arrival_metrics` (monitoring).
# MAGIC
# MAGIC **Modes:** `incremental` (24h watermark, default), `backfill` (watermark bypassed,
# MAGIC explicit date range), `reprocess` (via `reprocess_date`).
# MAGIC
# MAGIC **References:** `docs/best-practices/data-management/late-arriving-data.md`,
# MAGIC `docs/best-practices/incremental-refresh-cdc.md`, Tyler Akidau *Streaming Systems*,
# MAGIC Apache Beam *Dataflow Model*.

# COMMAND ----------

_notebook_exit(f"SUCCESS|silver_load_id={silver_load_id}|mode={process_mode}|"
               f"target={target_table}|dlq={df_late_quarantine.count()}|"
               f"corrections={df_corrections.count() if process_mode != 'backfill' else 0}")
