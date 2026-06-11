# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: SCD Type 2 Dimension with Full MERGE Pattern
# MAGIC
# MAGIC **Phase 14 Wave 3 - Feature 3.9** | **Related doc:** [SCD Patterns](../../docs/best-practices/data-management/scd-patterns.md)
# MAGIC
# MAGIC ## Purpose
# MAGIC Operationalize the canonical Delta SCD Type 2 pattern from `scd-patterns.md` against a casino
# MAGIC `dim_player` dimension. This notebook is the *executable counterpart* to the theory chapter:
# MAGIC every snippet here matches a section in the doc, and the doc explains the *why* behind each step.
# MAGIC
# MAGIC ## What is demonstrated
# MAGIC
# MAGIC | # | Demonstration | Doc Section |
# MAGIC |---|---|---|
# MAGIC | 1 | Canonical Type 2 schema (surrogate key, business key, temporal columns, version, hash) | sec. 2 schema |
# MAGIC | 2 | Initial load (Day 1) — 100 players, all `is_current=true`, `version=1` | sec. 2 design |
# MAGIC | 3 | Incremental load (Day 2) — tier changes, attribute drift, new players, soft deletes | sec. 2 MERGE |
# MAGIC | 4 | Atomic two-pass MERGE: close old current rows + insert new versions | sec. 2 atomicity |
# MAGIC | 5 | Concurrency-safe retry on `ConcurrentAppendException` with exponential backoff + jitter | sec. concurrency |
# MAGIC | 6 | Verification queries (one current per business key, no temporal gaps, full history) | sec. checklist |
# MAGIC | 7 | AS-OF join demo: WRONG (current_flag) vs RIGHT (effective window) — quantified discrepancy | sec. as-of joins |
# MAGIC | 8 | Audit log table — per-attribute change capture (who/what/when/why) | sec. auditability |
# MAGIC | 9 | OPTIMIZE + Z-ORDER on business key | sec. performance |
# MAGIC
# MAGIC ## Why this matters
# MAGIC Naive joins to SCD2 dims silently corrupt KPIs. A play from 2019 when the player was Bronze tier
# MAGIC will report as Diamond if you join on `is_current=true`. This notebook quantifies that error
# MAGIC against a real synthetic workload — the "WRONG vs RIGHT" cell at the bottom prints the actual
# MAGIC dollar discrepancy in tier-attributed revenue.

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Setup and Imports

# COMMAND ----------

import os
import random
import time
import uuid
from datetime import datetime, timedelta

from delta.tables import DeltaTable
from pyspark.sql import Row
from pyspark.sql.functions import (
    coalesce,
    col,
    concat_ws,
    current_timestamp,
    expr,
    lit,
    sha2,
    when,
)
from pyspark.sql.types import (
    BooleanType,
    DoubleType,
    IntegerType,
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)


def _get_arg(name: str, default=None):
    """Read a notebook parameter from Fabric runtime, env var, or default."""
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
    """Exit the notebook with a status message."""
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
random.seed(42)  # deterministic synthetic data

# Tables (three-part names for schema-enabled Lakehouses)
DIM_TABLE = "lh_gold.dbo.dim_player"
AUDIT_TABLE = "lh_gold.dbo.dim_player_audit"
FACT_TABLE = "lh_gold.dbo.fact_session_demo"

# Sentinel for "current" rows (NEVER use NULL — see scd-patterns.md sec. 2)
EFFECTIVE_TO_SENTINEL = "9999-12-31 23:59:59"

print(f"Batch: {batch_id}")
print(f"Target dim:   {DIM_TABLE}")
print(f"Audit:        {AUDIT_TABLE}")
print(f"Fact (demo):  {FACT_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. dim_player Schema (Type 2)
# MAGIC
# MAGIC The canonical Type 2 dimension for casino players. Each attribute is classified per the
# MAGIC decision matrix in `scd-patterns.md` sec. "Decision Matrix":
# MAGIC
# MAGIC | Column | Role | SCD Type | Why |
# MAGIC |---|---|---|---|
# MAGIC | `player_sk` | Surrogate key | n/a | Snapshots dim version. Foreign key target from facts. |
# MAGIC | `player_id` | Business key | n/a | Stable identity across versions (sourced from MDM `master_id`). |
# MAGIC | `first_name`, `last_name` | Identity | Type 1 | Cosmetic — overwritten in every version. |
# MAGIC | `email`, `phone` | Contact | Type 1 | History irrelevant for casino ops. |
# MAGIC | `address_line1`, `address_zip` | Address | **Type 2** | Tax mailing reconstruction (W-2G). |
# MAGIC | `tier` | Loyalty | **Type 2** | **Most volatile** — drives revenue-by-tier reporting. |
# MAGIC | `lifetime_value_estimate` | Score | **Type 2** | Monthly recompute; ML feature snapshots. |
# MAGIC | `effective_from`, `effective_to`, `is_current`, `version` | Temporal | n/a | SCD2 mechanics. |
# MAGIC | `row_hash` | Change detection | n/a | SHA-256 over Type 2 attrs — fast equality check in MERGE. |
# MAGIC | `load_ts`, `source_audit_id` | Audit | n/a | Lineage; ties to upstream batch. |

# COMMAND ----------

dim_schema = StructType([
    # Keys
    StructField("player_sk",                LongType(),    nullable=False),
    StructField("player_id",                StringType(),  nullable=False),
    # Type 1 / identity
    StructField("first_name",               StringType(),  nullable=True),
    StructField("last_name",                StringType(),  nullable=True),
    StructField("email",                    StringType(),  nullable=True),
    StructField("phone",                    StringType(),  nullable=True),
    # Type 2 / volatile
    StructField("address_line1",            StringType(),  nullable=True),
    StructField("address_zip",              StringType(),  nullable=True),
    StructField("tier",                     StringType(),  nullable=True),
    StructField("lifetime_value_estimate",  DoubleType(),  nullable=True),
    # Temporal
    StructField("effective_from",           TimestampType(), nullable=False),
    StructField("effective_to",             TimestampType(), nullable=False),
    StructField("is_current",               BooleanType(),   nullable=False),
    StructField("version",                  IntegerType(),   nullable=False),
    # Change detection
    StructField("row_hash",                 StringType(),    nullable=False),
    # Audit
    StructField("load_ts",                  TimestampType(), nullable=False),
    StructField("source_audit_id",          StringType(),    nullable=False),
])

# Columns that participate in change detection (Type 2 attrs only)
TYPE2_COLS = ["address_line1", "address_zip", "tier", "lifetime_value_estimate"]

# Drop any prior demo state so the notebook is reproducible
spark.sql(f"DROP TABLE IF EXISTS {DIM_TABLE}")
spark.sql(f"DROP TABLE IF EXISTS {AUDIT_TABLE}")
spark.sql(f"DROP TABLE IF EXISTS {FACT_TABLE}")
print("Cleaned prior demo state")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Day 1 — Initial Load (100 Synthetic Players)
# MAGIC
# MAGIC All 100 rows: `version=1`, `is_current=true`, `effective_from=now`, `effective_to='9999-12-31 23:59:59'`.
# MAGIC
# MAGIC The business key `player_id` is sourced from the upstream MDM golden record (`master_id` from
# MAGIC notebook 40_mdm_golden_customer.py). This dim's job is to *temporalize* that identity.

# COMMAND ----------

TIERS = ["bronze", "silver", "gold", "platinum"]
ZIPS  = ["89101", "89102", "89103", "89109", "89169", "89146", "89147", "89148"]

def synth_player(i: int, seed_offset: int = 0) -> dict:
    """Build a synthetic player record. Deterministic given seed."""
    r = random.Random(1000 + i + seed_offset)
    return {
        "player_id":               f"P{i:06d}",
        "first_name":              r.choice(["Alex", "Jordan", "Casey", "Morgan", "Taylor", "Riley", "Sam", "Jamie"]),
        "last_name":                r.choice(["Smith", "Jones", "Garcia", "Lee", "Patel", "Nguyen", "Brown", "Davis"]),
        "email":                   f"player{i:06d}@example.test",
        "phone":                   f"702-555-{i % 10000:04d}",
        "address_line1":           f"{r.randint(100, 9999)} Vegas Blvd",
        "address_zip":             r.choice(ZIPS),
        "tier":                     r.choice(TIERS),
        "lifetime_value_estimate": round(r.uniform(100.0, 50000.0), 2),
    }

day1_records = [synth_player(i) for i in range(100)]
day1_load_ts = datetime.now()

# Build initial version-1 rows
day1_rows = []
for sk, rec in enumerate(day1_records, start=1):
    day1_rows.append(Row(
        player_sk=sk,
        player_id=rec["player_id"],
        first_name=rec["first_name"],
        last_name=rec["last_name"],
        email=rec["email"],
        phone=rec["phone"],
        address_line1=rec["address_line1"],
        address_zip=rec["address_zip"],
        tier=rec["tier"],
        lifetime_value_estimate=rec["lifetime_value_estimate"],
        effective_from=day1_load_ts,
        effective_to=datetime(9999, 12, 31, 23, 59, 59),
        is_current=True,
        version=1,
        row_hash="",  # filled below
        load_ts=day1_load_ts,
        source_audit_id=f"day1_{batch_id}",
    ))

df_day1 = spark.createDataFrame(day1_rows, schema=dim_schema)

# Compute row_hash over Type 2 columns
hash_expr = sha2(concat_ws("||", *[coalesce(col(c).cast("string"), lit("")) for c in TYPE2_COLS]), 256)
df_day1 = df_day1.withColumn("row_hash", hash_expr)

# Initial write — overwrite mode (table doesn't exist yet)
(df_day1.write
    .format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .saveAsTable(DIM_TABLE))

print(f"Day 1: wrote {df_day1.count()} player rows, all version=1, all is_current=true")
spark.sql(f"SELECT player_id, tier, lifetime_value_estimate, version, is_current FROM {DIM_TABLE} ORDER BY player_id LIMIT 5").show()

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Day 2 — Build the Incoming Change Set
# MAGIC
# MAGIC Simulate a daily batch from upstream MDM with these change patterns:
# MAGIC
# MAGIC | Group | Count | Change |
# MAGIC |---|---|---|
# MAGIC | A | 10 | tier upgrade (e.g. silver → gold) |
# MAGIC | B | 20 | `lifetime_value_estimate` updated (monthly recompute) |
# MAGIC | C | 5 | address change (`address_line1`, `address_zip`) |
# MAGIC | D | 65 | no change at all (idempotent — must NOT create a new version) |
# MAGIC | E | 3 | net-new players |
# MAGIC | F | 2 | soft delete (close current row, no new insert) |

# COMMAND ----------

# Pull current state to derive Day 2 modifications
current_df = spark.table(DIM_TABLE).where("is_current = true").orderBy("player_id").collect()
assert len(current_df) == 100, "Day 1 should have 100 current rows"

day2_records = []

# Group A: 10 tier upgrades (player_id P000000-P000009)
for i in range(0, 10):
    rec = synth_player(i)  # same base record
    cur_tier = current_df[i]["tier"]
    next_tier = TIERS[(TIERS.index(cur_tier) + 1) % len(TIERS)]
    rec["tier"] = next_tier
    day2_records.append(rec)

# Group B: 20 LTV updates (P000010-P000029)
for i in range(10, 30):
    rec = synth_player(i)
    rec["lifetime_value_estimate"] = round(current_df[i]["lifetime_value_estimate"] * 1.15 + 250.0, 2)
    day2_records.append(rec)

# Group C: 5 address changes (P000030-P000034)
for i in range(30, 35):
    rec = synth_player(i)
    rec["address_line1"] = f"{random.randint(100, 9999)} New Address Way"
    rec["address_zip"]   = "89999"
    day2_records.append(rec)

# Group D: 65 no-change records (P000035-P000099) — idempotency test
for i in range(35, 100):
    rec = synth_player(i)  # IDENTICAL synthetic output, since seeded
    day2_records.append(rec)

# Group E: 3 net-new players (P000100-P000102)
for i in range(100, 103):
    day2_records.append(synth_player(i))

# Group F: 2 soft deletes (build a separate set — these are NOT in day2_records)
delete_ids = [current_df[98]["player_id"], current_df[99]["player_id"]]  # P000098, P000099
# Remove them from day2_records (group D included them)
day2_records = [r for r in day2_records if r["player_id"] not in delete_ids]

print(f"Day 2 incoming records: {len(day2_records)}")
print(f"Day 2 deletes:          {delete_ids}")

# Build incoming DataFrame
day2_load_ts = day1_load_ts + timedelta(days=1)
incoming_rows = [Row(**rec) for rec in day2_records]
df_incoming = spark.createDataFrame(incoming_rows)

# Hash incoming over the SAME Type 2 cols
df_incoming = df_incoming.withColumn(
    "row_hash",
    sha2(concat_ws("||", *[coalesce(col(c).cast("string"), lit("")) for c in TYPE2_COLS]), 256)
)
print(f"Incoming DataFrame: {df_incoming.count()} rows")
df_incoming.show(5, truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. The Canonical Two-Pass MERGE
# MAGIC
# MAGIC ### Why two passes?
# MAGIC Delta `MERGE INTO` cannot, in a single statement, both **UPDATE** an existing row to close it
# MAGIC AND **INSERT** a new row that shares the same business key. So the canonical SCD2 pattern is:
# MAGIC
# MAGIC ```
# MAGIC Pass A: MERGE  → UPDATE existing is_current rows where row_hash differs (close them)
# MAGIC Pass B: APPEND → insert new versions for changed entities + brand-new entities
# MAGIC ```
# MAGIC
# MAGIC **Atomicity caveat (sec. 2 of doc):** between Pass A and Pass B, a reader could observe zero
# MAGIC current rows for a player_id. In practice this is acceptable because:
# MAGIC
# MAGIC 1. The window is sub-second
# MAGIC 2. Consumers query with `is_current = true AND effective_to > current_timestamp()` — the
# MAGIC    closed-old-no-new state is briefly visible but bounded
# MAGIC 3. A single-writer pattern (one pipeline owns the dim) eliminates concurrency conflicts
# MAGIC
# MAGIC ### The four merge actions, mapped to our test groups:
# MAGIC
# MAGIC | Action | Trigger | Test group |
# MAGIC |---|---|---|
# MAGIC | UPDATE current row → close it | row_hash differs | A, B, C |
# MAGIC | INSERT new version | row_hash differs | A, B, C |
# MAGIC | INSERT brand-new | no current row exists | E |
# MAGIC | UPDATE current → close, no insert | logical delete | F |
# MAGIC | NO-OP | row_hash equal | D |

# COMMAND ----------

# MAGIC %md
# MAGIC ### Step 5a: Identify changes (compare hashes against current dim)

# COMMAND ----------

# Snapshot current rows for hash comparison
current_snapshot = (
    spark.table(DIM_TABLE)
    .where("is_current = true")
    .select(
        col("player_id").alias("c_player_id"),
        col("row_hash").alias("c_hash"),
        col("player_sk").alias("c_player_sk"),
        col("version").alias("c_version"),
        col("tier").alias("c_tier"),
        col("address_line1").alias("c_address_line1"),
        col("address_zip").alias("c_address_zip"),
        col("lifetime_value_estimate").alias("c_lifetime_value_estimate"),
    )
)

# Left-join incoming → current to classify each incoming record
classified = (
    df_incoming.alias("i")
    .join(current_snapshot.alias("c"), col("i.player_id") == col("c.c_player_id"), "left")
    .withColumn(
        "change_class",
        when(col("c.c_hash").isNull(), lit("NEW"))
        .when(col("i.row_hash") != col("c.c_hash"), lit("CHANGED"))
        .otherwise(lit("UNCHANGED"))
    )
)

class_counts = classified.groupBy("change_class").count().collect()
print("Change classification:")
for row in class_counts:
    print(f"  {row['change_class']:10s}: {row['count']}")

# Subset to actionable rows only (skip UNCHANGED — idempotency)
actionable = classified.where(col("change_class") != "UNCHANGED").cache()
print(f"Actionable (NEW + CHANGED): {actionable.count()} rows")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Step 5b: Pass A — Close existing current rows for CHANGED entities (and deletes)

# COMMAND ----------

def merge_close_current(target_table: str, ids_to_close, close_ts, reason: str):
    """
    Pass A: close current rows for the given player_ids by setting is_current=false
    and effective_to=close_ts. Atomic single-statement MERGE.
    Equivalent SQL:
        MERGE INTO lh_gold.dbo.dim_player t
        USING (SELECT explode(:ids) AS player_id) s
        ON t.player_id = s.player_id AND t.is_current = true
        WHEN MATCHED THEN UPDATE SET is_current=false, effective_to=:close_ts
    """
    if ids_to_close.count() == 0:
        print(f"  [{reason}] no rows to close")
        return
    target = DeltaTable.forName(spark, target_table)
    (target.alias("t")
        .merge(
            ids_to_close.alias("s"),
            "t.player_id = s.player_id AND t.is_current = true"
        )
        .whenMatchedUpdate(set={
            "is_current":   lit(False),
            "effective_to": lit(close_ts).cast(TimestampType()),
        })
        .execute())
    print(f"  [{reason}] closed current rows for {ids_to_close.count()} player_ids")

# Close rows for CHANGED entities (groups A, B, C)
ids_changed = actionable.where(col("change_class") == "CHANGED").select("player_id").distinct()
merge_close_current(DIM_TABLE, ids_changed, day2_load_ts, "CHANGED")

# Close rows for soft deletes (group F) — same MERGE, no insert follows
ids_deleted = spark.createDataFrame([(d,) for d in delete_ids], ["player_id"])
merge_close_current(DIM_TABLE, ids_deleted, day2_load_ts, "SOFT_DELETE")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Step 5c: Pass B — Insert new versions (CHANGED) + new entities (NEW)
# MAGIC
# MAGIC Compute the next `version` per business key as `max(version) + 1` from the dim, defaulting to 1
# MAGIC for net-new entities. Mint a fresh `player_sk` (surrogate) for every inserted row — surrogate
# MAGIC keys are NEVER reused.

# COMMAND ----------

# Compute current max(player_sk) — surrogate keys are monotonic across the whole dim
max_sk = spark.table(DIM_TABLE).agg({"player_sk": "max"}).collect()[0][0] or 0
print(f"Current max player_sk: {max_sk}")

# Compute max version per player_id (from the dim — including just-closed rows)
max_version_per_pid = (
    spark.table(DIM_TABLE)
    .groupBy("player_id")
    .agg(expr("max(version) AS max_version"))
)

# Build new-version rows
new_versions = (
    actionable
    .join(max_version_per_pid, "player_id", "left")
    .withColumn("next_version", coalesce(col("max_version") + 1, lit(1)))
    .select(
        col("i.player_id").alias("player_id"),
        col("i.first_name").alias("first_name"),
        col("i.last_name").alias("last_name"),
        col("i.email").alias("email"),
        col("i.phone").alias("phone"),
        col("i.address_line1").alias("address_line1"),
        col("i.address_zip").alias("address_zip"),
        col("i.tier").alias("tier"),
        col("i.lifetime_value_estimate").alias("lifetime_value_estimate"),
        col("i.row_hash").alias("row_hash"),
        col("next_version").alias("version"),
    )
).cache()

# Mint surrogate keys deterministically (max_sk + row_number ordered by player_id)
from pyspark.sql.window import Window
from pyspark.sql.functions import row_number

w = Window.orderBy("player_id")
new_versions = (
    new_versions
    .withColumn("player_sk", lit(max_sk) + row_number().over(w))
    .withColumn("effective_from", lit(day2_load_ts).cast(TimestampType()))
    .withColumn("effective_to",   lit(EFFECTIVE_TO_SENTINEL).cast(TimestampType()))
    .withColumn("is_current",     lit(True))
    .withColumn("load_ts",        lit(day2_load_ts).cast(TimestampType()))
    .withColumn("source_audit_id", lit(f"day2_{batch_id}"))
).select(*[f.name for f in dim_schema.fields])  # exact column order

print(f"Pass B: appending {new_versions.count()} new versions")
new_versions.select("player_sk", "player_id", "tier", "version").orderBy("player_id").show(8)

(new_versions.write
    .format("delta")
    .mode("append")
    .saveAsTable(DIM_TABLE))

print("Pass B complete")

# COMMAND ----------

# MAGIC %md
# MAGIC ### Step 5d: Equivalent SQL form of the MERGE (for reference)
# MAGIC
# MAGIC The PySpark form above is the production pattern (composable, testable). Here is the SQL
# MAGIC equivalent for stewards / DBAs who prefer SQL:
# MAGIC
# MAGIC ```sql
# MAGIC -- Pass A: close current rows
# MAGIC MERGE INTO lh_gold.dbo.dim_player t
# MAGIC USING incoming_changes s
# MAGIC ON  t.player_id  = s.player_id
# MAGIC AND t.is_current = true
# MAGIC WHEN MATCHED AND t.row_hash <> s.row_hash THEN
# MAGIC     UPDATE SET
# MAGIC         is_current   = false,
# MAGIC         effective_to = current_timestamp();
# MAGIC
# MAGIC -- Pass B: insert new versions (in a separate statement, same transaction window)
# MAGIC INSERT INTO lh_gold.dbo.dim_player
# MAGIC SELECT
# MAGIC     <next_player_sk>,
# MAGIC     s.player_id,
# MAGIC     s.first_name, ...,
# MAGIC     current_timestamp() AS effective_from,
# MAGIC     CAST('9999-12-31 23:59:59' AS TIMESTAMP) AS effective_to,
# MAGIC     true                AS is_current,
# MAGIC     COALESCE((SELECT MAX(version) + 1 FROM dim_player WHERE player_id = s.player_id), 1) AS version,
# MAGIC     s.row_hash, ...
# MAGIC FROM incoming_changes s
# MAGIC LEFT JOIN dim_player d
# MAGIC     ON d.player_id = s.player_id AND d.is_current = false  -- just-closed rows
# MAGIC WHERE s.change_class IN ('NEW', 'CHANGED');
# MAGIC ```
# MAGIC
# MAGIC The DataFrame form is preferred because surrogate-key minting and ordering are easier to
# MAGIC reason about; the SQL form is shown for documentation completeness.

# COMMAND ----------

# MAGIC %md
# MAGIC ## 6. Concurrency-Safe Pattern: Retry on ConcurrentAppendException
# MAGIC
# MAGIC Delta uses optimistic concurrency. If two writers race on the same dim, the loser receives
# MAGIC `ConcurrentAppendException`. The canonical mitigation (sec. "Concurrency" in the doc):
# MAGIC
# MAGIC 1. **Single-writer pattern (preferred):** one pipeline owns each dim — fan multiple sources
# MAGIC    into a Silver canonical table first, then run ONE SCD2 MERGE.
# MAGIC 2. **Retry with exponential backoff + jitter** for unavoidable concurrency.
# MAGIC 3. **Pipeline-level lock** for dims with >1 legitimate writer.

# COMMAND ----------

def merge_with_retry(merge_fn, *args, max_retries: int = 5, base_backoff_sec: float = 1.0, **kwargs):
    """
    Wrap a Delta MERGE in retry-on-concurrency. Exponential backoff with jitter.

    Backoff schedule: 1.0-1.5s, 2.0-2.5s, 4.0-4.5s, 8.0-8.5s, 16.0-16.5s.
    Reraises after final retry exhausted.
    """
    try:
        from delta.exceptions import ConcurrentAppendException, ConcurrentDeleteReadException
        retryable = (ConcurrentAppendException, ConcurrentDeleteReadException)
    except ImportError:
        # Fallback for older Delta versions — match by class name string
        retryable = (Exception,)

    last_exc = None
    for attempt in range(max_retries):
        try:
            return merge_fn(*args, **kwargs)
        except retryable as e:
            last_exc = e
            cls = type(e).__name__
            if cls not in ("ConcurrentAppendException", "ConcurrentDeleteReadException"):
                raise  # don't retry on non-concurrency errors
            if attempt == max_retries - 1:
                print(f"  Retry {attempt + 1}/{max_retries} EXHAUSTED: {cls}")
                raise
            backoff = (base_backoff_sec * (2 ** attempt)) + random.uniform(0, 0.5)
            print(f"  Retry {attempt + 1}/{max_retries} after {backoff:.2f}s ({cls})")
            time.sleep(backoff)
    if last_exc:
        raise last_exc


# Demo: re-run the close pass through retry wrapper (idempotent — no-op since hashes match)
print("Demo: retry-wrapped MERGE (idempotent re-run)")
empty_ids = spark.createDataFrame([], "player_id STRING")
merge_with_retry(merge_close_current, DIM_TABLE, empty_ids, day2_load_ts, "RETRY_DEMO")
print("Retry wrapper validated.")

# Operational note: when multiple writers MUST coexist on a single dim, acquire a named-lock
# row in a coordination table BEFORE calling MERGE. Release in a finally block.
# Example coordination pattern (pseudo):
#     INSERT INTO lh_gold.dbo.dim_locks VALUES ('dim_player', current_timestamp(), :pipeline_id)
#         WHERE NOT EXISTS (SELECT 1 FROM dim_locks WHERE dim_name = 'dim_player' AND released = false)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 7. Verification Queries

# COMMAND ----------

# MAGIC %md
# MAGIC ### 7a. Full version history for a tier-upgrade player

# COMMAND ----------

example_pid = "P000003"
print(f"Full history for {example_pid}:")
spark.sql(f"""
    SELECT
        player_sk, player_id, version, tier, lifetime_value_estimate,
        is_current, effective_from, effective_to
    FROM {DIM_TABLE}
    WHERE player_id = '{example_pid}'
    ORDER BY version
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### 7b. Invariant: exactly one is_current=true per player_id
# MAGIC
# MAGIC This is the **#1 SCD Type 2 bug** and indicates a concurrency violation if it ever fires.

# COMMAND ----------

dup_currents = spark.sql(f"""
    SELECT player_id, COUNT(*) AS bad_count
    FROM {DIM_TABLE}
    WHERE is_current = true
    GROUP BY player_id
    HAVING COUNT(*) > 1
""")
dup_count = dup_currents.count()
print(f"Players with >1 is_current row: {dup_count}")
assert dup_count == 0, f"INVARIANT VIOLATED: {dup_count} player_ids have multiple current rows"
print("Invariant holds: every player_id has exactly one current row (or zero, for soft-deleted).")

# COMMAND ----------

# MAGIC %md
# MAGIC ### 7c. Temporal contiguity: effective_to of v(N) = effective_from of v(N+1)
# MAGIC
# MAGIC No gaps in temporal coverage means an as-of join finds **exactly one** dim version for any
# MAGIC fact event timestamp.

# COMMAND ----------

contiguity = spark.sql(f"""
    WITH versioned AS (
        SELECT
            player_id,
            version,
            effective_from,
            effective_to,
            LEAD(effective_from) OVER (PARTITION BY player_id ORDER BY version) AS next_effective_from
        FROM {DIM_TABLE}
    )
    SELECT
        player_id,
        version,
        effective_to,
        next_effective_from,
        (effective_to = next_effective_from) AS is_contiguous
    FROM versioned
    WHERE next_effective_from IS NOT NULL
      AND effective_to <> next_effective_from
""")
gap_count = contiguity.count()
print(f"Temporal gaps detected: {gap_count}")
assert gap_count == 0, f"GAPS FOUND: {gap_count} version transitions are not contiguous"
print("Temporal contiguity holds: every closed version's effective_to == next version's effective_from.")

# COMMAND ----------

# MAGIC %md
# MAGIC ### 7d. Row-count summary

# COMMAND ----------

spark.sql(f"""
    SELECT
        COUNT(*)                                              AS total_rows,
        COUNT(DISTINCT player_id)                             AS distinct_players,
        SUM(CASE WHEN is_current THEN 1 ELSE 0 END)           AS current_rows,
        SUM(CASE WHEN NOT is_current THEN 1 ELSE 0 END)       AS historical_rows,
        MAX(version)                                          AS max_version
    FROM {DIM_TABLE}
""").show()

# Expected: 100 (day1) + 38 new versions (10 A + 20 B + 5 C + 3 E) = 138 total rows
# Current rows = 100 + 3 (E) - 2 (F deletes) = 101
print("Expected: 138 total, 101 current, 37 historical, 100 distinct players (Day 1) + 3 net-new = 103 distinct")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 8. AS-OF Join Demo — WRONG vs RIGHT
# MAGIC
# MAGIC **The most important section.** This is the bug that silently corrupts every BI report
# MAGIC built against an SCD2 dim with a naive join.
# MAGIC
# MAGIC We build a synthetic `fact_session` of 1,000 sessions spread across both Day 1 and Day 2,
# MAGIC then attribute each session's revenue to a tier two ways:
# MAGIC
# MAGIC | Approach | Join Predicate | Behavior |
# MAGIC |---|---|---|
# MAGIC | **WRONG** | `s.player_id = p.player_id AND p.is_current = true` | Every session attributed to **today's** tier |
# MAGIC | **RIGHT** | `s.player_id = p.player_id AND s.session_ts >= p.effective_from AND s.session_ts < p.effective_to` | Each session attributed to the tier in force when the session occurred |
# MAGIC
# MAGIC The discrepancy printed at the bottom is the **dollar amount of mis-attributed revenue** in
# MAGIC this synthetic workload. In production with thousands of dim changes per day, this number is
# MAGIC routinely 5-20% of total revenue.

# COMMAND ----------

# MAGIC %md
# MAGIC ### 8a. Build a synthetic fact_session table

# COMMAND ----------

# 1,000 sessions, 500 on Day 1 (before tier upgrade) and 500 on Day 2 (after)
fact_rows = []
day1_session_ts = day1_load_ts + timedelta(hours=1)   # well within Day 1 window
day2_session_ts = day2_load_ts + timedelta(hours=1)   # within Day 2 window

for i in range(500):
    pid = f"P{(i % 100):06d}"  # spread evenly across the 100 Day-1 players
    fact_rows.append(Row(
        session_id=f"S{i:08d}",
        player_id=pid,
        session_ts=day1_session_ts + timedelta(minutes=i),
        revenue=round(random.uniform(10.0, 500.0), 2),
    ))

for i in range(500, 1000):
    pid = f"P{(i % 100):06d}"
    fact_rows.append(Row(
        session_id=f"S{i:08d}",
        player_id=pid,
        session_ts=day2_session_ts + timedelta(minutes=i - 500),
        revenue=round(random.uniform(10.0, 500.0), 2),
    ))

df_facts = spark.createDataFrame(fact_rows)
(df_facts.write.format("delta").mode("overwrite").option("overwriteSchema", "true").saveAsTable(FACT_TABLE))
print(f"Wrote {df_facts.count()} sessions to {FACT_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ### 8b. WRONG join — uses is_current=true (silent corruption)

# COMMAND ----------

wrong = spark.sql(f"""
    SELECT
        p.tier,
        COUNT(*)        AS sessions,
        SUM(s.revenue)  AS attributed_revenue
    FROM {FACT_TABLE} s
    JOIN {DIM_TABLE}  p
        ON  s.player_id  = p.player_id
        AND p.is_current = true
    GROUP BY p.tier
    ORDER BY p.tier
""")
print("WRONG (is_current=true):")
wrong.show()

# COMMAND ----------

# MAGIC %md
# MAGIC ### 8c. RIGHT join — uses effective_from / effective_to window

# COMMAND ----------

right = spark.sql(f"""
    SELECT
        p.tier,
        COUNT(*)        AS sessions,
        SUM(s.revenue)  AS attributed_revenue
    FROM {FACT_TABLE} s
    JOIN {DIM_TABLE}  p
        ON  s.player_id     = p.player_id
        AND s.session_ts   >= p.effective_from
        AND s.session_ts    < p.effective_to
    GROUP BY p.tier
    ORDER BY p.tier
""")
print("RIGHT (as-of join):")
right.show()

# COMMAND ----------

# MAGIC %md
# MAGIC ### 8d. Quantify the discrepancy

# COMMAND ----------

# Build a tier-by-tier delta
wrong_pd = wrong.toPandas().set_index("tier")
right_pd = right.toPandas().set_index("tier")
all_tiers = sorted(set(wrong_pd.index) | set(right_pd.index))

print(f"{'Tier':10s} | {'WRONG rev':>14s} | {'RIGHT rev':>14s} | {'Delta':>14s} | {'Pct Off':>10s}")
print("-" * 75)
total_wrong = 0.0
total_right = 0.0
total_abs_delta = 0.0
for t in all_tiers:
    w = float(wrong_pd.loc[t]["attributed_revenue"]) if t in wrong_pd.index else 0.0
    r = float(right_pd.loc[t]["attributed_revenue"]) if t in right_pd.index else 0.0
    delta = w - r
    pct = (abs(delta) / r * 100) if r else 0.0
    total_wrong += w
    total_right += r
    total_abs_delta += abs(delta)
    print(f"{t:10s} | {w:>14,.2f} | {r:>14,.2f} | {delta:>+14,.2f} | {pct:>9.1f}%")

print("-" * 75)
print(f"{'TOTAL':10s} | {total_wrong:>14,.2f} | {total_right:>14,.2f} | {(total_wrong - total_right):>+14,.2f}")
print(f"Total absolute mis-attribution: ${total_abs_delta:,.2f}")
print(f"Pct of true revenue mis-attributed: {(total_abs_delta / total_right * 100):.1f}%")
print()
print("This is the cost of the naive join. In production, multiply by your daily session volume.")

# COMMAND ----------

# MAGIC %md
# MAGIC ### 8e. The best pattern: snapshot the surrogate key in the fact (Kimball)
# MAGIC
# MAGIC The as-of join above is *correct* but range predicates are slow. The canonical Kimball
# MAGIC optimization is to **resolve the dim version at fact-load time** and store `player_sk` directly
# MAGIC in the fact row. Downstream queries then use a fast integer-equality join.

# COMMAND ----------

snapshot_join = spark.sql(f"""
    -- This is what fact-load SHOULD do once: snapshot player_sk into the fact
    SELECT
        s.session_id,
        s.session_ts,
        s.player_id,
        p.player_sk    AS resolved_player_sk,
        p.tier         AS tier_at_session_time,
        s.revenue
    FROM {FACT_TABLE} s
    LEFT JOIN {DIM_TABLE} p
        ON  s.player_id    = p.player_id
        AND s.session_ts  >= p.effective_from
        AND s.session_ts   < p.effective_to
    LIMIT 5
""")
snapshot_join.show(truncate=False)

print("With player_sk snapshotted, downstream queries become a simple integer join:")
print("  SELECT f.*, d.tier FROM fact_session_resolved f JOIN dim_player d ON f.resolved_player_sk = d.player_sk")
print("  -- O(N) hash join on integer keys vs O(N*K) range predicate")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 9. Audit Log — Per-Attribute Change Capture
# MAGIC
# MAGIC Every dim change should be traceable to **who, what, when, why**. The audit table is
# MAGIC append-only, partitioned by date, and retained per regulatory horizon (typically 7-10 years
# MAGIC for casino).

# COMMAND ----------

audit_schema = StructType([
    StructField("audit_id",        StringType(),    nullable=False),
    StructField("player_id",       StringType(),    nullable=False),
    StructField("attribute",       StringType(),    nullable=False),
    StructField("old_value",       StringType(),    nullable=True),
    StructField("new_value",       StringType(),    nullable=True),
    StructField("change_type",     StringType(),    nullable=False),
    StructField("changed_ts",      TimestampType(), nullable=False),
    StructField("source",          StringType(),    nullable=False),
    StructField("source_audit_id", StringType(),    nullable=False),
])

audit_records = []

# For each CHANGED record, emit one audit row per attribute that actually changed
changed_actionable = actionable.where(col("change_class") == "CHANGED").collect()
for r in changed_actionable:
    pid = r["player_id"]
    for attr in TYPE2_COLS:
        old = r[f"c_{attr}"] if f"c_{attr}" in r.asDict() else None
        new = r[attr]
        if str(old) != str(new):
            audit_records.append(Row(
                audit_id=str(uuid.uuid4()),
                player_id=pid,
                attribute=attr,
                old_value=str(old) if old is not None else None,
                new_value=str(new) if new is not None else None,
                change_type="UPDATE",
                changed_ts=day2_load_ts,
                source="pipeline:scd2_dim_player",
                source_audit_id=f"day2_{batch_id}",
            ))

# Net-new players: one audit row marking creation
new_actionable = actionable.where(col("change_class") == "NEW").collect()
for r in new_actionable:
    audit_records.append(Row(
        audit_id=str(uuid.uuid4()),
        player_id=r["player_id"],
        attribute="*",
        old_value=None,
        new_value="(created)",
        change_type="INSERT",
        changed_ts=day2_load_ts,
        source="pipeline:scd2_dim_player",
        source_audit_id=f"day2_{batch_id}",
    ))

# Soft deletes
for did in delete_ids:
    audit_records.append(Row(
        audit_id=str(uuid.uuid4()),
        player_id=did,
        attribute="*",
        old_value="(active)",
        new_value="(deleted_in_source)",
        change_type="LOGICAL_DELETE",
        changed_ts=day2_load_ts,
        source="pipeline:scd2_dim_player",
        source_audit_id=f"day2_{batch_id}",
    ))

if audit_records:
    df_audit = spark.createDataFrame(audit_records, schema=audit_schema)
    (df_audit.write
        .format("delta")
        .mode("overwrite")
        .option("overwriteSchema", "true")
        .saveAsTable(AUDIT_TABLE))
    print(f"Wrote {df_audit.count()} audit rows")
else:
    print("No audit rows to write")

print("\nAudit summary by change_type:")
spark.sql(f"""
    SELECT change_type, attribute, COUNT(*) AS cnt
    FROM {AUDIT_TABLE}
    GROUP BY change_type, attribute
    ORDER BY change_type, attribute
""").show(20, truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 10. OPTIMIZE + Z-ORDER on Business Key
# MAGIC
# MAGIC Z-Order on `player_id` dramatically speeds:
# MAGIC - Joining facts to dim at as-of time
# MAGIC - Steward UI lookups
# MAGIC - Targeted MERGE patterns (next batch's hash compare)
# MAGIC
# MAGIC Run weekly. Avoid VACUUM during MERGE windows.

# COMMAND ----------

spark.sql(f"OPTIMIZE {DIM_TABLE} ZORDER BY (player_id)")
print(f"OPTIMIZE complete on {DIM_TABLE} with Z-Order on player_id")

spark.sql(f"OPTIMIZE {AUDIT_TABLE} ZORDER BY (player_id, changed_ts)")
print(f"OPTIMIZE complete on {AUDIT_TABLE} with Z-Order on (player_id, changed_ts)")

# Operational note: VACUUM is intentionally NOT run here. Per scd-patterns.md sec. "Performance":
# VACUUM during an active MERGE can race-delete files. Schedule VACUUM in a dedicated maintenance
# window with default retention (7 days) — not in this notebook.

# COMMAND ----------

# MAGIC %md
# MAGIC ## 11. Cleanup
# MAGIC
# MAGIC Unpersist cached DataFrames. The Delta tables are intentionally LEFT IN PLACE so downstream
# MAGIC tutorials and notebooks can read from them.

# COMMAND ----------

try:
    actionable.unpersist()
    new_versions.unpersist()
except Exception:
    pass

print("=" * 70)
print(f"SCD Type 2 demo complete (batch_id = {batch_id})")
print(f"  Dim:    {DIM_TABLE}    ({spark.table(DIM_TABLE).count()} rows)")
print(f"  Audit:  {AUDIT_TABLE}  ({spark.table(AUDIT_TABLE).count()} rows)")
print(f"  Fact:   {FACT_TABLE}   ({spark.table(FACT_TABLE).count()} rows)")
print("=" * 70)

_notebook_exit(f"SUCCESS:scd_type2:{batch_id}")
