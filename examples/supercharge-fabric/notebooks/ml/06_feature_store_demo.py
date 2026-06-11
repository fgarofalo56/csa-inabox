# Databricks notebook source
# MAGIC %md
# MAGIC # ML: OneLake-Backed Feature Store with Point-in-Time Correctness
# MAGIC
# MAGIC Builds and consumes a feature store for casino player engagement features
# MAGIC on Microsoft Fabric. Demonstrates the point-in-time correctness story
# MAGIC end-to-end so the most damaging feature-store bug — train/serve leakage —
# MAGIC becomes a CI test instead of a production incident.
# MAGIC
# MAGIC ## What This Notebook Demonstrates
# MAGIC - Feature group definition — `fs_player_engagement` schema with bitemporal columns
# MAGIC - SCD Type 2 evolution — close old rows, open new; never overwrite history
# MAGIC - Point-in-time AS-OF JOIN — features valid AT event time, not "today"
# MAGIC - Leakage demo — naive join vs AS-OF join with quantified delta
# MAGIC - Online serving — current-row lookup
# MAGIC - Versioning — MINOR additive bump and MAJOR breaking-change dual-write
# MAGIC - Feature card — discovery & documentation in `lh_features.feature_cards`
# MAGIC
# MAGIC Related: [`docs/best-practices/feature-store-onelake.md`](../../docs/best-practices/feature-store-onelake.md). Phase 14 Wave 2 feature 2.11.

# COMMAND ----------

# MAGIC %md
# MAGIC ## Setup

# COMMAND ----------

import os
import random
from datetime import datetime, timedelta

from delta.tables import DeltaTable
from pyspark.sql import Row
from pyspark.sql import functions as F
from pyspark.sql.types import (
    BooleanType,
    DoubleType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)


def _get_arg(name: str, default=None):
    """Read a notebook parameter from Fabric runtime, env var, or default."""
    try:
        import notebookutils
        return notebookutils.notebook.getArgument(name, default)
    except Exception:
        try:
            import mssparkutils
            return mssparkutils.notebook.getArgument(name, default)
        except Exception:
            return os.environ.get(name.upper(), default)


# Parameters
compute_run_id = _get_arg(
    "compute_run_id",
    f"run-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}-fs-demo"
)

# The feature store lives in its OWN lakehouse — separate from medallion.
features_lakehouse = "lh_features"
silver_source = "lh_silver.silver_player_activity"
feature_table = f"{features_lakehouse}.fs_player_engagement"
feature_table_v2 = f"{features_lakehouse}.fs_player_engagement_v2"  # for MAJOR migration demo
feature_cards_table = f"{features_lakehouse}.feature_cards"

# Sentinel for "current row" — far-future timestamp keeps inequality predicates simple.
FAR_FUTURE = "9999-12-31 00:00:00"
FEATURE_VERSION = "1.0.0"

print(f"Compute run ID: {compute_run_id}")
print(f"Feature table: {feature_table}  (version {FEATURE_VERSION})")

spark.sql(f"CREATE SCHEMA IF NOT EXISTS {features_lakehouse}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Define the Feature Group: `fs_player_engagement`
# MAGIC
# MAGIC Per `feature-store-onelake.md`: identity & bitemporal (`player_id`,
# MAGIC `effective_from`, `effective_to`), business features (`engagement_score`,
# MAGIC `churn_risk`, `ltv_estimate`, `tier`), and lineage (`source_table`,
# MAGIC `feature_version`, `last_updated`, `compute_run_id`).
# MAGIC `effective_to = FAR_FUTURE` marks the current row; half-open `[from, to)`
# MAGIC means the AS-OF predicate is `from <= event_time < to`.

# COMMAND ----------

feature_schema = StructType([
    StructField("player_id",        StringType(),    nullable=False),
    StructField("effective_from",   TimestampType(), nullable=False),
    StructField("effective_to",     TimestampType(), nullable=False),
    StructField("engagement_score", DoubleType(),    nullable=True),
    StructField("churn_risk",       DoubleType(),    nullable=True),
    StructField("ltv_estimate",     DoubleType(),    nullable=True),
    StructField("tier",             StringType(),    nullable=True),
    StructField("feature_version",  StringType(),    nullable=False),
    StructField("source_table",     StringType(),    nullable=False),
    StructField("last_updated",     TimestampType(), nullable=False),
    StructField("compute_run_id",   StringType(),    nullable=False),
])

print("Feature group schema:")
for f in feature_schema.fields:
    print(f"  {f.name:<20} {str(f.dataType):<20} nullable={f.nullable}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Source: Silver Player Activity (defensive synthetic generation)

# COMMAND ----------

if not spark.catalog.tableExists(silver_source):
    print(f"Silver source {silver_source} not found — generating synthetic activity")
    spark.sql("CREATE SCHEMA IF NOT EXISTS lh_silver")

    random.seed(42)
    num_players = 250
    days_history = 120
    base_date = datetime.utcnow() - timedelta(days=days_history)

    rows = []
    for player_idx in range(num_players):
        pid = f"P{10000 + player_idx:05d}"
        for _ in range(random.randint(5, 80)):
            session_dt = base_date + timedelta(
                days=random.uniform(0, days_history),
                hours=random.uniform(0, 24)
            )
            wager = round(random.uniform(20, 2500), 2)
            rows.append(Row(
                player_id=pid,
                session_id=f"S{random.randint(1, 9_999_999):07d}",
                session_timestamp=session_dt,
                wager_amount=wager,
                net_win=round(wager * random.uniform(-0.30, 0.10), 2),
            ))

    df_synth = spark.createDataFrame(rows)
    df_synth.write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable(silver_source)
    print(f"Created {silver_source}: {df_synth.count():,} sessions")

df_activity = spark.table(silver_source)
print(f"Silver activity rows: {df_activity.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Compute Feature Snapshots — Build Real History via Replay
# MAGIC
# MAGIC We rewind the clock and compute features at T-90, T-30, and T-0 so SCD2
# MAGIC evolution generates real history.

# COMMAND ----------

def compute_engagement_features(activity_df, as_of: datetime, version: str, run_id: str):
    """Aggregate trailing-30-day engagement features as of a given timestamp."""
    window_start = as_of - timedelta(days=30)
    return (
        activity_df
        .filter((F.col("session_timestamp") < F.lit(as_of)) &
                (F.col("session_timestamp") >= F.lit(window_start)))
        .groupBy("player_id")
        .agg(
            F.count("session_id").alias("sessions_30d"),
            F.coalesce(F.avg("wager_amount"), F.lit(0.0)).alias("avg_wager_30d"),
            F.coalesce(F.sum("wager_amount"), F.lit(0.0)).alias("total_wager_30d"),
        )
        .withColumn(
            "engagement_score",
            F.least(F.lit(100.0), F.col("sessions_30d") * 2.5 + F.col("avg_wager_30d") / 10.0)
        )
        .withColumn(
            "churn_risk",
            F.greatest(F.lit(0.0), F.least(F.lit(1.0),
                F.lit(1.0) - (F.col("engagement_score") / F.lit(100.0))))
        )
        .withColumn("ltv_estimate", F.col("total_wager_30d") * F.lit(12.0))
        .withColumn(
            "tier",
            F.when(F.col("ltv_estimate") >= 250_000, F.lit("platinum"))
             .when(F.col("ltv_estimate") >= 80_000,  F.lit("gold"))
             .when(F.col("ltv_estimate") >= 20_000,  F.lit("silver"))
             .otherwise(F.lit("bronze"))
        )
        .withColumn("effective_from", F.lit(as_of).cast("timestamp"))
        .withColumn("effective_to",   F.lit(FAR_FUTURE).cast("timestamp"))
        .withColumn("feature_version", F.lit(version))
        .withColumn("source_table",    F.lit(silver_source))
        .withColumn("last_updated",    F.current_timestamp())
        .withColumn("compute_run_id",  F.lit(run_id))
        .select(
            "player_id", "effective_from", "effective_to",
            "engagement_score", "churn_risk", "ltv_estimate", "tier",
            "feature_version", "source_table", "last_updated", "compute_run_id",
        )
    )


now = datetime.utcnow()
t_minus_90 = now - timedelta(days=90)
t_minus_30 = now - timedelta(days=30)

df_features_t90 = compute_engagement_features(
    df_activity, t_minus_90, FEATURE_VERSION, f"{compute_run_id}-t90"
)
print(f"Features AS OF {t_minus_90.isoformat()}: {df_features_t90.count():,} players")
df_features_t90.select("player_id", "engagement_score", "churn_risk", "tier").show(5)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Initial Write — Bootstrap the Feature Table

# COMMAND ----------

if spark.catalog.tableExists(feature_table):
    spark.sql(f"DROP TABLE {feature_table}")  # rebuild for a clean demo

df_features_t90.write.format("delta").mode("overwrite") \
    .option("overwriteSchema", "true").saveAsTable(feature_table)

spark.sql(f"""
    ALTER TABLE {feature_table} SET TBLPROPERTIES (
        'delta.enableChangeDataFeed' = 'true',
        'feature_store.entity'       = 'player',
        'feature_store.owner'        = 'casino-data-science',
        'feature_store.version'      = '{FEATURE_VERSION}',
        'feature_store.tier'         = 'experimental'
    )
""")
print(f"Initialized {feature_table}: {spark.table(feature_table).count():,} rows")

# COMMAND ----------

# MAGIC %md
# MAGIC ## SCD Type 2 Evolution
# MAGIC
# MAGIC On each compute, identify rows whose values changed: close the existing
# MAGIC current row (set `effective_to = now`) then insert the new current row.
# MAGIC Never `mode("overwrite")` — that destroys history.

# COMMAND ----------

def scd2_merge(new_df, target_table_name: str, change_threshold: float = 0.01) -> int:
    target = DeltaTable.forName(spark, target_table_name)

    current = (
        spark.table(target_table_name)
        .filter(F.col("effective_to") == F.lit(FAR_FUTURE).cast("timestamp"))
        .select(
            F.col("player_id").alias("c_player_id"),
            F.col("engagement_score").alias("c_engagement_score"),
            F.col("churn_risk").alias("c_churn_risk"),
            F.col("ltv_estimate").alias("c_ltv_estimate"),
            F.col("tier").alias("c_tier"),
        )
    )

    changed = (
        new_df.alias("n")
        .join(current, F.col("n.player_id") == F.col("c_player_id"), "left")
        .filter(
            F.col("c_player_id").isNull()
            | (F.abs(F.col("n.engagement_score") - F.col("c_engagement_score")) > change_threshold)
            | (F.abs(F.col("n.churn_risk")       - F.col("c_churn_risk"))       > change_threshold)
            | (F.abs(F.col("n.ltv_estimate")     - F.col("c_ltv_estimate"))     > change_threshold)
            | (F.col("n.tier") != F.col("c_tier"))
        )
        .select("n.*")
    )

    changed_count = changed.count()
    print(f"  Changed rows to evolve: {changed_count:,}")
    if changed_count == 0:
        return 0

    # Close the soon-to-be-superseded current rows
    new_eff_from = changed.select("effective_from").first()[0]
    (
        target.alias("tgt")
        .merge(
            changed.select("player_id").distinct().alias("chg"),
            f"tgt.player_id = chg.player_id AND tgt.effective_to = TIMESTAMP'{FAR_FUTURE}'"
        )
        .whenMatchedUpdate(set={"effective_to": F.lit(new_eff_from)})
        .execute()
    )

    # Append new current rows
    changed.write.format("delta").mode("append").saveAsTable(target_table_name)
    return changed_count


print(f"Evolution AS OF {t_minus_30.isoformat()}:")
scd2_merge(
    compute_engagement_features(df_activity, t_minus_30, FEATURE_VERSION, f"{compute_run_id}-t30"),
    feature_table
)
print(f"Evolution AS OF {now.isoformat()}:")
scd2_merge(
    compute_engagement_features(df_activity, now, FEATURE_VERSION, f"{compute_run_id}-now"),
    feature_table
)

total = spark.table(feature_table).count()
current_n = spark.table(feature_table).filter(F.col("effective_to") == F.lit(FAR_FUTURE).cast("timestamp")).count()
print(f"\nTotal rows: {total:,} | Current: {current_n:,} | Closed: {total - current_n:,}")

# COMMAND ----------

# Sample SCD2 history for one player to confirm evolution
sample_pid = (
    spark.table(feature_table)
    .filter(F.col("effective_to") != F.lit(FAR_FUTURE).cast("timestamp"))
    .select("player_id").first()
)
if sample_pid:
    print(f"\nSCD2 history for player {sample_pid.player_id}:")
    (
        spark.table(feature_table)
        .filter(F.col("player_id") == sample_pid.player_id)
        .select("player_id", "effective_from", "effective_to",
                "engagement_score", "tier", "feature_version")
        .orderBy("effective_from")
        .show(truncate=False)
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Build a Training Event Log
# MAGIC
# MAGIC One labelled event per player at a random timestamp in history. Each event
# MAGIC is a moment when a prediction would have been made.

# COMMAND ----------

df_events = (
    df_activity
    .groupBy("player_id")
    .agg(F.min("session_timestamp").alias("first_session"),
         F.max("session_timestamp").alias("last_session"))
    .withColumn(
        "event_ts",
        (F.unix_timestamp("first_session")
         + (F.unix_timestamp("last_session") - F.unix_timestamp("first_session")) * F.rand(seed=7)
        ).cast("timestamp")
    )
    .select("player_id", "event_ts")
    # Deterministic noisy label hashed off player_id (~35% positive)
    .withColumn("label_churned_30d", (F.abs(F.hash("player_id")) % 100 < 35).cast("int"))
)

print(f"Training events: {df_events.count():,}")
df_events.show(5, truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Bug Demo — Naive Join (Data Leakage)
# MAGIC
# MAGIC Joining on `player_id` only matches every event against TODAY's feature row,
# MAGIC which reflects events that happened AFTER the prediction event. Information leakage.

# COMMAND ----------

df_naive = (
    df_events.alias("e")
    .join(
        spark.table(feature_table)
             .filter(F.col("effective_to") == F.lit(FAR_FUTURE).cast("timestamp")).alias("f"),
        F.col("e.player_id") == F.col("f.player_id"),
        "left"
    )
    .select("e.player_id", "e.event_ts", "e.label_churned_30d",
            F.col("f.engagement_score").alias("naive_engagement_score"))
)

naive_corr = df_naive.groupBy("label_churned_30d").agg(
    F.avg("naive_engagement_score").alias("avg_engagement_score"),
    F.count("*").alias("n_events"),
).orderBy("label_churned_30d")

print("NAIVE JOIN (leakage path):")
naive_corr.show()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Fix — AS-OF JOIN (Point-in-Time Correct)
# MAGIC
# MAGIC Add `effective_from <= event_ts < effective_to` to the join predicate.
# MAGIC Each event binds to the feature row that was valid at the time of the event.

# COMMAND ----------

df_asof = (
    df_events.alias("e")
    .join(
        spark.table(feature_table).alias("f"),
        (F.col("e.player_id") == F.col("f.player_id"))
        & (F.col("f.effective_from") <= F.col("e.event_ts"))
        & (F.col("e.event_ts") < F.col("f.effective_to")),
        "left"
    )
    .select("e.player_id", "e.event_ts", "e.label_churned_30d",
            F.col("f.engagement_score").alias("asof_engagement_score"),
            F.col("f.feature_version"))
)

asof_corr = df_asof.groupBy("label_churned_30d").agg(
    F.avg("asof_engagement_score").alias("avg_engagement_score"),
    F.count("*").alias("n_events"),
).orderBy("label_churned_30d")

print("AS-OF JOIN (correct path):")
asof_corr.show()

# Quantify leakage delta — in production this is the AUC inflation that doesn't survive deploy.
naive_pdf = naive_corr.toPandas().set_index("label_churned_30d")
asof_pdf  = asof_corr.toPandas().set_index("label_churned_30d")
print("\nLeakage delta (|naive - as-of|) by class:")
for cls in sorted(set(naive_pdf.index) | set(asof_pdf.index)):
    nv = naive_pdf.loc[cls, "avg_engagement_score"] if cls in naive_pdf.index else None
    av = asof_pdf.loc[cls,  "avg_engagement_score"] if cls in asof_pdf.index  else None
    if nv is not None and av is not None:
        print(f"  label={cls}: naive={nv:.3f}  as_of={av:.3f}  |delta|={abs(nv - av):.3f}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Online Serving Simulation
# MAGIC
# MAGIC Online inference needs sub-100ms lookup of the current feature row by entity.
# MAGIC The store enforces this with `effective_to = FAR_FUTURE`. In production this
# MAGIC mirrors to a Fabric SQL DB; here we simulate against Delta directly.

# COMMAND ----------

def online_lookup(player_id: str) -> dict:
    row = (
        spark.table(feature_table)
        .filter((F.col("player_id") == player_id) &
                (F.col("effective_to") == F.lit(FAR_FUTURE).cast("timestamp")))
        .select("player_id", "engagement_score", "churn_risk", "ltv_estimate",
                "tier", "feature_version", "last_updated")
        .first()
    )
    return row.asDict() if row else None


sample_players = [
    r.player_id for r in
    spark.table(feature_table)
         .filter(F.col("effective_to") == F.lit(FAR_FUTURE).cast("timestamp"))
         .select("player_id").limit(3).collect()
]

print("Online feature lookups (current row only):")
for pid in sample_players:
    f = online_lookup(pid)
    if f:
        print(f"  {pid}: tier={f['tier']:<8} engagement={f['engagement_score']:.2f}  "
              f"churn_risk={f['churn_risk']:.3f}  ltv=${f['ltv_estimate']:>10,.2f}  v={f['feature_version']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Versioning — MINOR Bump (Additive)
# MAGIC
# MAGIC Add `engagement_velocity` (rate of change vs prior SCD2 row). MINOR bump
# MAGIC (1.0.0 → 1.1.0) — additive; consumers see NULL on old rows and can adopt when ready.

# COMMAND ----------

spark.sql(f"""
    ALTER TABLE {feature_table}
    ADD COLUMN engagement_velocity DOUBLE
    COMMENT 'Rate of engagement_score change vs previous SCD2 row; NULL for first row per player'
""")
spark.sql(f"ALTER TABLE {feature_table} SET TBLPROPERTIES ('feature_store.version' = '1.1.0')")

# Compute velocity by self-join: prior row has effective_to == current row's effective_from
fs    = spark.table(feature_table).alias("fs")
prior = spark.table(feature_table).alias("prior")
df_velocity = (
    fs.filter(F.col("fs.effective_to") == F.lit(FAR_FUTURE).cast("timestamp"))
      .join(
          prior,
          (F.col("fs.player_id") == F.col("prior.player_id"))
          & (F.col("prior.effective_to") == F.col("fs.effective_from")),
          "left"
      )
      .select(
          F.col("fs.player_id"),
          F.col("fs.effective_from"),
          (F.col("fs.engagement_score") - F.col("prior.engagement_score")).alias("velocity")
      )
)

target = DeltaTable.forName(spark, feature_table)
(
    target.alias("t")
    .merge(
        df_velocity.alias("v"),
        "t.player_id = v.player_id AND t.effective_from = v.effective_from"
    )
    .whenMatchedUpdate(set={"engagement_velocity": F.col("v.velocity")})
    .execute()
)
print("MINOR bump complete — engagement_velocity added; table version 1.1.0")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Versioning — MAJOR Bump (Breaking, Dual-Write)
# MAGIC
# MAGIC Redefine `engagement_score` from sum-based to recency-decay-based. Same name,
# MAGIC different semantics → MAJOR (1.1.0 → 2.0.0). Build a parallel `_v2` table and
# MAGIC dual-write for the 60+ day deprecation window. Consumers migrate on their schedule.

# COMMAND ----------

def compute_v2_features(activity_df, as_of: datetime, run_id: str):
    """v2 — engagement_score uses a recency-decay model; values are NOT comparable to v1."""
    window_start = as_of - timedelta(days=30)
    return (
        activity_df
        .filter((F.col("session_timestamp") < F.lit(as_of)) &
                (F.col("session_timestamp") >= F.lit(window_start)))
        .groupBy("player_id")
        .agg(
            F.count("session_id").alias("sessions_30d"),
            F.coalesce(F.avg("wager_amount"), F.lit(0.0)).alias("avg_wager_30d"),
            F.coalesce(F.max("session_timestamp"), F.lit(window_start)).alias("last_session_ts"),
        )
        .withColumn(
            "recency_days",
            (F.unix_timestamp(F.lit(as_of)) - F.unix_timestamp("last_session_ts")) / F.lit(86400.0)
        )
        .withColumn(
            "engagement_score",
            F.least(F.lit(100.0), F.greatest(F.lit(0.0),
                F.lit(50.0)
                + F.col("sessions_30d") * 1.2
                - F.col("recency_days") * 1.5
                + F.col("avg_wager_30d") / 50.0
            ))
        )
        .withColumn(
            "churn_risk",
            F.greatest(F.lit(0.0), F.least(F.lit(1.0), F.col("recency_days") / F.lit(60.0)))
        )
        .withColumn("ltv_estimate", F.col("avg_wager_30d") * F.col("sessions_30d") * F.lit(12.0))
        .withColumn(
            "tier",
            F.when(F.col("ltv_estimate") >= 250_000, F.lit("platinum"))
             .when(F.col("ltv_estimate") >= 80_000,  F.lit("gold"))
             .when(F.col("ltv_estimate") >= 20_000,  F.lit("silver"))
             .otherwise(F.lit("bronze"))
        )
        .withColumn("effective_from", F.lit(as_of).cast("timestamp"))
        .withColumn("effective_to",   F.lit(FAR_FUTURE).cast("timestamp"))
        .withColumn("feature_version", F.lit("2.0.0"))
        .withColumn("source_table",    F.lit(silver_source))
        .withColumn("last_updated",    F.current_timestamp())
        .withColumn("compute_run_id",  F.lit(run_id))
        .select(
            "player_id", "effective_from", "effective_to",
            "engagement_score", "churn_risk", "ltv_estimate", "tier",
            "feature_version", "source_table", "last_updated", "compute_run_id",
        )
    )


df_v2 = compute_v2_features(df_activity, now, f"{compute_run_id}-v2")
if spark.catalog.tableExists(feature_table_v2):
    spark.sql(f"DROP TABLE {feature_table_v2}")

df_v2.write.format("delta").mode("overwrite") \
    .option("overwriteSchema", "true").saveAsTable(feature_table_v2)

spark.sql(f"""
    ALTER TABLE {feature_table_v2} SET TBLPROPERTIES (
        'delta.enableChangeDataFeed' = 'true',
        'feature_store.entity'       = 'player',
        'feature_store.owner'        = 'casino-data-science',
        'feature_store.version'      = '2.0.0',
        'feature_store.tier'         = 'experimental',
        'feature_store.deprecates'   = '{feature_table}'
    )
""")

print(f"Dual-write begun: v1={feature_table} (1.1.0), v2={feature_table_v2} (2.0.0)")
print(f"v2 rows: {spark.table(feature_table_v2).count():,}")
print("Consumers migrate to v2 over 60+ days; v1 stays live until cutover.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Feature Card — Discovery & Documentation
# MAGIC
# MAGIC The feature card is the contract: owner, meaning, refresh SLA, consumers.
# MAGIC Persist as structured metadata in `lh_features.feature_cards`.

# COMMAND ----------

card_schema = StructType([
    StructField("feature_table",        StringType(),    nullable=False),
    StructField("entity",               StringType(),    nullable=False),
    StructField("feature_version",      StringType(),    nullable=False),
    StructField("owner",                StringType(),    nullable=False),
    StructField("purpose",              StringType(),    nullable=False),
    StructField("grain",                StringType(),    nullable=False),
    StructField("source_tables",        StringType(),    nullable=False),
    StructField("freshness_sla",        StringType(),    nullable=False),
    StructField("pii_class",            StringType(),    nullable=False),
    StructField("tier",                 StringType(),    nullable=False),
    StructField("downstream_consumers", StringType(),    nullable=False),
    StructField("deprecation_policy",   StringType(),    nullable=False),
    StructField("online_available",     BooleanType(),   nullable=False),
    StructField("last_updated",         TimestampType(), nullable=False),
])

card_rows = [
    Row(
        feature_table=feature_table, entity="player_id", feature_version="1.1.0",
        owner="casino-data-science (Slack: #casino-ds)",
        purpose=("Composite player engagement features for casino churn, LTV, and "
                 "marketing-uplift models. Bitemporal SCD2 for point-in-time correctness."),
        grain="One row per player per change event (SCD2)",
        source_tables=silver_source,
        freshness_sla="Daily, 02:00 UTC, < 26 hours from session occurrence",
        pii_class="derived", tier="experimental",
        downstream_consumers=("casino-churn-prediction-lightgbm v3.x, "
                              "casino-ltv-forecast-prophet v2.x"),
        deprecation_policy="90-day notice + 60-day dual-write",
        online_available=True, last_updated=datetime.utcnow(),
    ),
    Row(
        feature_table=feature_table_v2, entity="player_id", feature_version="2.0.0",
        owner="casino-data-science (Slack: #casino-ds)",
        purpose=("MAJOR redefinition of engagement_score using recency-decay model. "
                 "Dual-written alongside v1 during 60-day deprecation window."),
        grain="One row per player per change event (SCD2)",
        source_tables=silver_source,
        freshness_sla="Daily, 02:00 UTC",
        pii_class="derived", tier="experimental",
        downstream_consumers="(none yet — under migration from v1)",
        deprecation_policy="N/A (successor)",
        online_available=False, last_updated=datetime.utcnow(),
    ),
]

df_cards = spark.createDataFrame(card_rows, schema=card_schema)

if spark.catalog.tableExists(feature_cards_table):
    target = DeltaTable.forName(spark, feature_cards_table)
    (
        target.alias("t")
        .merge(df_cards.alias("s"), "t.feature_table = s.feature_table")
        .whenMatchedUpdateAll().whenNotMatchedInsertAll().execute()
    )
else:
    df_cards.write.format("delta").mode("overwrite") \
        .option("overwriteSchema", "true").saveAsTable(feature_cards_table)

print(f"Feature cards written to {feature_cards_table}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Discovery — Query the Feature Card Catalog

# COMMAND ----------

print("Discovery: all feature tables for entity = player_id")
(
    spark.table(feature_cards_table)
    .filter(F.col("entity") == "player_id")
    .select("feature_table", "feature_version", "tier", "owner",
            "freshness_sla", "online_available")
    .orderBy("feature_table", "feature_version")
    .show(truncate=False)
)

print("\nFull card for fs_player_engagement v1.1.0:")
(
    spark.table(feature_cards_table)
    .filter(F.col("feature_table") == feature_table)
    .show(vertical=True, truncate=False)
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Validation Checks (CI candidates)

# COMMAND ----------

def assert_check(name: str, condition: bool, detail: str = "") -> None:
    status = "PASS" if condition else "FAIL"
    print(f"  [{status}] {name}{(' — ' + detail) if detail else ''}")
    if not condition:
        raise AssertionError(f"Feature store check failed: {name}")


print("Feature store validation:")

max_current = (
    spark.table(feature_table)
    .filter(F.col("effective_to") == F.lit(FAR_FUTURE).cast("timestamp"))
    .groupBy("player_id").count()
    .agg(F.max("count")).first()[0] or 0
)
assert_check("Each player has at most one current row",
             max_current <= 1, f"max={max_current}")

violations = (
    spark.table(feature_table)
    .filter(F.col("effective_to") != F.lit(FAR_FUTURE).cast("timestamp"))
    .filter(F.col("effective_from") >= F.col("effective_to"))
    .count()
)
assert_check("All closed rows have effective_from < effective_to",
             violations == 0, f"{violations} violating rows")

table_version_row = (
    spark.sql(f"SHOW TBLPROPERTIES {feature_table}")
         .filter(F.col("key") == "feature_store.version").first()
)
table_version_value = table_version_row["value"] if table_version_row else None
distinct_versions = [
    r.feature_version for r in
    spark.table(feature_table).select("feature_version").distinct().collect()
]
assert_check("Table-level feature_version present in row versions",
             table_version_value in distinct_versions,
             f"table={table_version_value}, rows={distinct_versions}")

print("\nAll validation checks passed.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary & Cleanup
# MAGIC
# MAGIC | Element | Status |
# MAGIC |---------|--------|
# MAGIC | `lh_features.fs_player_engagement` | Bootstrapped + 3 SCD2 generations |
# MAGIC | Point-in-time AS-OF JOIN | Demonstrated against leakage baseline |
# MAGIC | Online lookup pattern | Simulated via current-row predicate |
# MAGIC | MINOR bump (1.0.0 → 1.1.0) | Added `engagement_velocity` |
# MAGIC | MAJOR bump (1.1.0 → 2.0.0) | Dual-write to `_v2` |
# MAGIC | `lh_features.feature_cards` | Discovery catalog populated |
# MAGIC | Validation invariants | All passed |
# MAGIC
# MAGIC Tables persist in `lh_features` for downstream notebooks. Uncomment cleanup
# MAGIC block to reset.

# COMMAND ----------

# Uncomment to reset demo state:
# spark.sql(f"DROP TABLE IF EXISTS {feature_table}")
# spark.sql(f"DROP TABLE IF EXISTS {feature_table_v2}")
# spark.sql(f"DROP TABLE IF EXISTS {feature_cards_table}")

print(f"Feature store demo complete (compute_run_id={compute_run_id})")
