# Databricks notebook source
# MAGIC %md
# MAGIC # Silver Layer: Player Master with SCD Type 2
# MAGIC
# MAGIC This notebook implements Slowly Changing Dimension Type 2 for player data,
# MAGIC tracking historical changes to player attributes over time.
# MAGIC
# MAGIC ## SCD Type 2 Pattern:
# MAGIC - Track changes to key attributes (tier, email, address)
# MAGIC - Maintain history with effective dates
# MAGIC - Current record flagged with is_current = True
# MAGIC
# MAGIC ## Implementation:
# MAGIC - **Delta MERGE** for scalable SCD2 (no `.collect()` calls)
# MAGIC - Two-step merge: expire old rows, then insert new versions
# MAGIC - Row-hash comparison for efficient change detection

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

# Imports, Fabric parameter shim, and configuration — all in one cell so the
# shim is guaranteed to be defined before it's called (avoids NameError when
# cells are run out of order after import).
import os
from datetime import datetime

from delta.tables import DeltaTable
from pyspark.sql.functions import (
    coalesce,
    col,
    concat_ws,
    current_date,
    current_timestamp,
    lit,
    sha2,
    when,
)
from pyspark.sql.functions import (
    max as spark_max,
)
from pyspark.sql.types import DateType


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
    """Exit the notebook with a status message (Fabric/Synapse pipelines consume this)."""
    try:
        import notebookutils
        notebookutils.notebook.exit(status)
    except Exception:
        try:
            import mssparkutils
            mssparkutils.notebook.exit(status)
        except Exception:
            raise SystemExit(status)


# Parameters
batch_id = _get_arg("batch_id", datetime.now().strftime("%Y%m%d_%H%M%S"))

# Source and target
SOURCE_TABLE = "lh_bronze.dbo.bronze_player_profile"
TARGET_TABLE = "lh_silver.dbo.silver_player_master"
KEY_COLUMN = "player_id"

# Attributes that trigger a new version when changed
TRACKED_ATTRIBUTES = [
    "loyalty_tier",
    "email",
    "phone",
    "address",
    "city",
    "state",
    "zip_code",
    "marketing_opt_in",
]

# All columns to carry through from bronze
COLUMN_LIST = [
    "player_id",
    "first_name",
    "last_name",
    "date_of_birth",
    "gender",
    "email",
    "phone",
    "address",
    "city",
    "state",
    "zip_code",
    "loyalty_tier",
    "enrollment_date",
    "marketing_opt_in",
    "ssn_hash",
]

print(f"Processing batch: {batch_id}")
print(f"Source: {SOURCE_TABLE}")
print(f"Target: {TARGET_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Read Bronze Data

# COMMAND ----------

df_bronze = spark.table(SOURCE_TABLE)

df_bronze.printSchema()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Prepare Incoming Data with Row Hash

# COMMAND ----------

# Select relevant columns from bronze and compute a hash over tracked attributes
df_incoming = (
    df_bronze
    .select(
        *[col(c) for c in COLUMN_LIST],
        col("_bronze_ingested_at").alias("source_timestamp"),
    )
    .withColumn(
        "row_hash",
        sha2(
            concat_ws("||", *[coalesce(col(c).cast("string"), lit("")) for c in TRACKED_ATTRIBUTES]),
            256,
        ),
    )
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## SCD Type 2 Merge Logic (Delta MERGE - No .collect())

# COMMAND ----------

try:
    table_exists = spark.catalog.tableExists(TARGET_TABLE)
except Exception:
    table_exists = False

if not table_exists:
    # ---------------------------------------------------------------
    # Initial Load: target table does not exist yet
    # ---------------------------------------------------------------
    print("Target table does not exist - performing initial load")

    df_initial = (
        df_incoming
        .withColumn("effective_date", current_date())
        .withColumn("end_date", lit(None).cast(DateType()))
        .withColumn("is_current", lit(True))
        .withColumn("version", lit(1))
        .withColumn("_silver_timestamp", current_timestamp())
        .withColumn("_silver_updated_at", current_timestamp())
        .withColumn("_batch_id", lit(batch_id))
    )

    df_initial.write.format("delta").mode("overwrite").saveAsTable(TARGET_TABLE)
    record_count = spark.table(TARGET_TABLE).count()
    print(f"Initial load complete: {record_count:,} records")

else:
    # ---------------------------------------------------------------
    # Incremental Load: SCD2 via Delta MERGE (two-step)
    # ---------------------------------------------------------------
    print("Target table exists - performing SCD Type 2 merge")

    deltaTable = DeltaTable.forName(spark, TARGET_TABLE)

    # Get current-state rows from silver with their hashes
    df_current = (
        deltaTable.toDF()
        .filter(col("is_current") == True)
        .select(
            col(KEY_COLUMN).alias("existing_player_id"),
            col("row_hash").alias("existing_hash"),
            col("version").alias("existing_version"),
        )
    )

    # Join incoming against current state to detect changes and new records.
    # Broadcast the current-state side when it is expected to be smaller than
    # the incoming feed; for very large dimensions remove the hint.
    from pyspark.sql.functions import broadcast

    df_compared = (
        df_incoming.alias("inc")
        .join(
            broadcast(df_current).alias("cur"),
            col("inc.player_id") == col("cur.existing_player_id"),
            "left",
        )
        .withColumn(
            "_change_type",
            when(col("cur.existing_player_id").isNull(), lit("new"))
            .when(col("inc.row_hash") != col("cur.existing_hash"), lit("changed"))
            .otherwise(lit("unchanged")),
        )
    )

    # Filter to only new + changed records and cache (used in two steps)
    df_changed = (
        df_compared
        .filter(col("_change_type") != "unchanged")
        .select(
            *[col(f"inc.{c}") for c in COLUMN_LIST],
            col("inc.source_timestamp"),
            col("inc.row_hash"),
            col("_change_type"),
            col("cur.existing_version"),
        )
    ).cache()

    changed_count = df_changed.count()
    print(f"Records to process (new + changed): {changed_count:,}")

    if changed_count > 0:
        # ---- Step 1: Expire existing current rows where hash changed ----
        # Build a DataFrame of only changed (not new) player_ids + hashes
        df_expire_source = (
            df_changed
            .filter(col("_change_type") == "changed")
            .select(
                col("player_id"),
                col("row_hash"),
            )
        )

        if df_expire_source.head(1):  # at least one changed row
            deltaTable.alias("target").merge(
                df_expire_source.alias("source"),
                "target.player_id = source.player_id AND target.is_current = true",
            ).whenMatchedUpdate(
                set={
                    "is_current": lit(False),
                    "end_date": current_date(),
                    "_silver_updated_at": current_timestamp(),
                }
            ).execute()
            print("Step 1 complete: expired old current rows for changed players")

        # ---- Step 2: Insert new current rows for changed + new records ----
        df_to_insert = (
            df_changed
            .withColumn("effective_date", current_date())
            .withColumn("end_date", lit(None).cast(DateType()))
            .withColumn("is_current", lit(True))
            .withColumn(
                "version",
                when(col("_change_type") == "new", lit(1))
                .otherwise(coalesce(col("existing_version"), lit(0)) + 1),
            )
            .withColumn("_silver_timestamp", current_timestamp())
            .withColumn("_silver_updated_at", current_timestamp())
            .withColumn("_batch_id", lit(batch_id))
            .drop("_change_type", "existing_version")
        )

        df_to_insert.write.format("delta").mode("append").saveAsTable(TARGET_TABLE)
        print(f"Step 2 complete: inserted {changed_count:,} new version rows")
    else:
        print("No changes detected - nothing to merge")

    # Release cached DataFrame
    df_changed.unpersist()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Post-Write Validation

# COMMAND ----------

# Total records
total_records = spark.sql(
    f"SELECT COUNT(*) as total FROM {TARGET_TABLE}"
).first()["total"]
print(f"Total records in Silver: {total_records:,}")

# Current records
current_records = spark.sql(
    f"SELECT COUNT(*) as current FROM {TARGET_TABLE} WHERE is_current = True"
).first()["current"]
print(f"Current records: {current_records:,}")

# Historical records
historical_records = total_records - current_records
print(f"Historical records: {historical_records:,}")

# COMMAND ----------

# Players with multiple versions (showing SCD working)
spark.sql(f"""
    SELECT
        player_id,
        COUNT(*) as versions,
        MIN(effective_date) as first_record,
        MAX(effective_date) as last_record
    FROM {TARGET_TABLE}
    GROUP BY player_id
    HAVING COUNT(*) > 1
    ORDER BY versions DESC
    LIMIT 10
""").show()

# COMMAND ----------

# Sample of versioned records
spark.sql(f"""
    SELECT
        player_id,
        loyalty_tier,
        effective_date,
        end_date,
        is_current,
        version
    FROM {TARGET_TABLE}
    WHERE player_id IN (
        SELECT player_id
        FROM {TARGET_TABLE}
        GROUP BY player_id
        HAVING COUNT(*) > 1
        LIMIT 1
    )
    ORDER BY version
""").show()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Data Quality Summary

# COMMAND ----------

# Quality metrics on current records
df_dq = spark.sql(f"""
    SELECT
        COUNT(*)                       as total_current,
        COUNT(email)                   as has_email,
        COUNT(phone)                   as has_phone,
        COUNT(address)                 as has_address,
        COUNT(loyalty_tier)            as has_tier,
        COUNT(DISTINCT loyalty_tier)   as unique_tiers,
        ROUND(COUNT(email)   * 100.0 / COUNT(*), 1) as email_pct,
        ROUND(COUNT(phone)   * 100.0 / COUNT(*), 1) as phone_pct,
        ROUND(COUNT(address) * 100.0 / COUNT(*), 1) as address_pct
    FROM {TARGET_TABLE}
    WHERE is_current = True
""")
df_dq.show(truncate=False)

# Compute a simple DQ score (% of key fields populated)
dq_row = df_dq.first()
dq_score = round(
    (dq_row["email_pct"] + dq_row["phone_pct"] + dq_row["address_pct"]) / 3, 1
)
print(f"Data Quality Score (avg field completeness): {dq_score}%")

# COMMAND ----------

# Tier distribution
spark.sql(f"""
    SELECT
        loyalty_tier,
        COUNT(*) as players,
        ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 2) as pct
    FROM {TARGET_TABLE}
    WHERE is_current = True
    GROUP BY loyalty_tier
    ORDER BY players DESC
""").show()
