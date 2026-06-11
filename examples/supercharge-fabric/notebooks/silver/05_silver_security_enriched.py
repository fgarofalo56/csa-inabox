# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Security Events Enriched
# MAGIC
# MAGIC This notebook enriches security events with correlation and incident tracking.
# MAGIC
# MAGIC ## Transformations:
# MAGIC - Event correlation across locations
# MAGIC - Incident clustering
# MAGIC - Response time calculation
# MAGIC - Threat scoring

# COMMAND ----------

# ---------------------------------------------------------------------------
# Fabric/local compatibility shim
# ---------------------------------------------------------------------------
import os

try:
    import notebookutils  # Fabric runtime
    def _get_arg(name, default=None):
        try:
            return notebookutils.notebook.getArgument(name, default)
        except Exception:
            return os.environ.get(name.upper(), default)
    def _notebook_exit(status: str) -> None:
        notebookutils.notebook.exit(status)
except ImportError:
    try:
        import mssparkutils  # legacy Synapse/Fabric runtime
        def _get_arg(name, default=None):
            try:
                return mssparkutils.notebook.getArgument(name, default)
            except Exception:
                return os.environ.get(name.upper(), default)
        def _notebook_exit(status: str) -> None:
            mssparkutils.notebook.exit(status)
    except ImportError:
        def _get_arg(name, default=None):
            return os.environ.get(name.upper(), default)
        def _notebook_exit(status: str) -> None:
            raise SystemExit(status)


from datetime import datetime

from delta.tables import DeltaTable
from pyspark.sql.functions import (
    col,
    count,
    current_timestamp,
    expr,
    filter,
    hour,
    least,
    lit,
    sum,
    unix_timestamp,
    when,
    window,
)
from pyspark.sql.window import Window

# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))
source_table = "lh_bronze.dbo.bronze_security_events"
target_table = "lh_silver.dbo.silver_security_enriched"

print(f"Processing batch: {batch_id}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Security Data

# COMMAND ----------

if not spark.catalog.tableExists(source_table):
    raise Exception(f"Source table {source_table} does not exist")

df_bronze = spark.table(source_table)
print(f"Bronze records: {df_bronze.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Validation

# COMMAND ----------

# Validate security events
df_validated = df_bronze \
    .withColumn("is_valid_event_type",
        col("event_type").isNotNull() & (col("event_type") != "")) \
    .withColumn("is_valid_timestamp",
        col("event_timestamp").isNotNull()) \
    .withColumn("is_valid_location",
        col("location_id").isNotNull()) \
    .withColumn("has_severity",
        col("severity_level").isNotNull())

# Calculate DQ score
df_with_dq = df_validated \
    .withColumn("_dq_score",
        (when(col("is_valid_event_type"), lit(30)).otherwise(lit(0)) +
         when(col("is_valid_timestamp"), lit(30)).otherwise(lit(0)) +
         when(col("is_valid_location"), lit(25)).otherwise(lit(0)) +
         when(col("has_severity"), lit(15)).otherwise(lit(0)))) \
    .withColumn("_dq_passed", col("_dq_score") >= 70)

df_quality = df_with_dq.filter(col("_dq_passed"))
print(f"Records passing DQ: {df_quality.count():,}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Threat Scoring

# COMMAND ----------

# Assign threat scores based on event type and context
df_threat_scored = df_quality \
    .withColumn("base_threat_score",
        when(col("severity_level") == "CRITICAL", lit(100))
        .when(col("severity_level") == "HIGH", lit(75))
        .when(col("severity_level") == "MEDIUM", lit(50))
        .when(col("severity_level") == "LOW", lit(25))
        .otherwise(lit(10))) \
    .withColumn("event_threat_modifier",
        when(col("event_type").isin("THREAT_DETECTED", "WEAPON_DETECTED"), lit(50))
        .when(col("event_type").isin("EXCLUSION_VIOLATION", "TRESPASS"), lit(40))
        .when(col("event_type").isin("ALTERCATION", "ASSAULT"), lit(35))
        .when(col("event_type").isin("UNAUTHORIZED_ACCESS"), lit(25))
        .when(col("event_type").isin("SUSPICIOUS_ACTIVITY"), lit(15))
        .otherwise(lit(0))) \
    .withColumn("threat_score",
        least(lit(100), col("base_threat_score") + col("event_threat_modifier")))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Event Correlation

# COMMAND ----------

# Window for location-based correlation (5-minute window)
location_window = Window \
    .partitionBy("location_id") \
    .orderBy(unix_timestamp(col("event_timestamp"))) \
    .rangeBetween(-300, 0)

# Window for person-based correlation (if person_id exists)
person_window = Window \
    .partitionBy("person_id") \
    .orderBy(unix_timestamp(col("event_timestamp"))) \
    .rangeBetween(-3600, 0)  # 1 hour

# Add correlation metrics
df_correlated = df_threat_scored \
    .withColumn("location_events_5min",
        count("*").over(location_window)) \
    .withColumn("location_high_severity_5min",
        sum(when(col("severity_level").isin("CRITICAL", "HIGH"), 1).otherwise(0)).over(location_window)) \
    .withColumn("is_cluster_event",
        col("location_events_5min") >= 3) \
    .withColumn("person_events_1hr",
        when(col("person_id").isNotNull(),
            count("*").over(person_window)).otherwise(lit(0))) \
    .withColumn("is_repeat_person",
        col("person_events_1hr") >= 2)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Incident Classification

# COMMAND ----------

# Classify incidents
df_classified = df_correlated \
    .withColumn("incident_type",
        when(col("event_type").isin("THREAT_DETECTED", "WEAPON_DETECTED", "ASSAULT"), "ACTIVE_THREAT")
        .when(col("event_type").isin("EXCLUSION_VIOLATION", "TRESPASS"), "EXCLUSION_BREACH")
        .when(col("event_type").isin("ALTERCATION", "PATRON_COMPLAINT"), "DISTURBANCE")
        .when(col("event_type").isin("UNAUTHORIZED_ACCESS", "ACCESS_DENIED"), "ACCESS_VIOLATION")
        .when(col("event_type").isin("MEDICAL_EMERGENCY"), "MEDICAL")
        .when(col("event_type").isin("CAMERA_ALERT", "CAMERA_OBSTRUCTION"), "SURVEILLANCE_ALERT")
        .otherwise("OTHER")) \
    .withColumn("requires_dispatch",
        col("incident_type").isin("ACTIVE_THREAT", "MEDICAL", "DISTURBANCE") |
        (col("threat_score") >= 75)) \
    .withColumn("requires_review",
        col("incident_type").isin("EXCLUSION_BREACH", "ACCESS_VIOLATION") |
        col("is_repeat_person"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Response Time Tracking

# COMMAND ----------

# Add response tracking fields
df_with_response = df_classified \
    .withColumn("expected_response_minutes",
        when(col("incident_type") == "ACTIVE_THREAT", lit(2))
        .when(col("incident_type") == "MEDICAL", lit(3))
        .when(col("incident_type") == "DISTURBANCE", lit(5))
        .when(col("incident_type") == "EXCLUSION_BREACH", lit(5))
        .otherwise(lit(15))) \
    .withColumn("response_sla_timestamp",
        col("event_timestamp") + expr("INTERVAL 1 MINUTE") * col("expected_response_minutes"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Final Silver DataFrame

# COMMAND ----------

df_silver = df_with_response \
    .withColumn("_silver_timestamp", current_timestamp()) \
    .withColumn("_batch_id", lit(batch_id)) \
    .drop(
        "is_valid_event_type", "is_valid_timestamp",
        "is_valid_location", "has_severity",
        "base_threat_score", "event_threat_modifier"
    )

# COMMAND ----------

# MAGIC %md
# MAGIC ## Write to Silver Table

# COMMAND ----------

try:
    # Delta MERGE upsert — deduplicate on event_id
    if spark.catalog.tableExists(target_table):
        deltaTable = DeltaTable.forName(spark, target_table)
        deltaTable.alias("target").merge(
            df_silver.alias("source"),
            "target.event_id = source.event_id"
        ).whenMatchedUpdateAll(
            condition="target._silver_timestamp < source._silver_timestamp"
        ).whenNotMatchedInsertAll(
        ).execute()
    else:
        # First run — create the table
        df_silver.write.format("delta") \
            .mode("overwrite") \
            .partitionBy("event_date", "severity_level") \
            .option("overwriteSchema", "true") \
            .saveAsTable(target_table)

    record_count = spark.table(target_table).count()
    print(f"Merged {spark.table(target_table).count():,} source records into {target_table} (total: {record_count:,})")
except Exception as e:
    print(f"ERROR in lh_silver.silver_security_enriched (batch_id={batch_id}): {e}")
    raise

# COMMAND ----------

# MAGIC %md
# MAGIC ## Security Summary

# COMMAND ----------

# Incident type summary
spark.sql(f"""
    SELECT
        incident_type,
        COUNT(*) as events,
        ROUND(AVG(threat_score), 1) as avg_threat_score,
        SUM(CASE WHEN requires_dispatch THEN 1 ELSE 0 END) as dispatch_required,
        SUM(CASE WHEN requires_review THEN 1 ELSE 0 END) as review_required
    FROM {target_table}
    GROUP BY incident_type
    ORDER BY events DESC
""").show()

# COMMAND ----------

# High-threat events
spark.sql(f"""
    SELECT
        event_timestamp,
        incident_type,
        threat_score,
        location_id,
        event_type
    FROM {target_table}
    WHERE threat_score >= 75
    ORDER BY threat_score DESC, event_timestamp DESC
    LIMIT 20
""").show()

# COMMAND ----------

# Cluster events (potential incidents)
spark.sql(f"""
    SELECT
        event_date,
        location_id,
        COUNT(*) as cluster_events,
        MAX(threat_score) as max_threat
    FROM {target_table}
    WHERE is_cluster_event = true
    GROUP BY event_date, location_id
    HAVING COUNT(*) >= 5
    ORDER BY cluster_events DESC
""").show()
