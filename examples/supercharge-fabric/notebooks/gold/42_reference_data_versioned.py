# Databricks notebook source
# MAGIC %md
# MAGIC # Gold Layer: Versioned Reference Data with Effective Dating
# MAGIC
# MAGIC **Phase 14 Wave 3 — Feature 3.10**
# MAGIC
# MAGIC This notebook operationalizes the patterns described in
# MAGIC `docs/best-practices/data-management/reference-data-versioning.md` and
# MAGIC `docs/best-practices/data-management/scd-patterns.md`.
# MAGIC
# MAGIC ## 🎯 Scenario: W-2G Withholding Rates by Jurisdiction
# MAGIC
# MAGIC Casino properties operate across multiple state jurisdictions (NV, NJ, CA, NY, ...).
# MAGIC Each state sets its own **W-2G withholding rate** and **threshold amounts** for
# MAGIC slots, table games, poker, and keno. These rates are not constant — they change
# MAGIC over the years as state legislatures amend gaming statutes and as the IRS revises
# MAGIC federal withholding rules.
# MAGIC
# MAGIC The compliance question is therefore not *"what is the rate?"* but
# MAGIC *"what was the rate **on the date of the reportable event**?"* A W-2G prepared in
# MAGIC 2026 for a 2021 jackpot must use the 2021 rate that was in effect when the
# MAGIC jackpot was won — not today's rate. Re-running the same historical report a year
# MAGIC later must produce **the same numbers**, never different ones.
# MAGIC
# MAGIC ## 🧠 The Historical-Accuracy Problem
# MAGIC
# MAGIC A naive lookup table (`SELECT rate FROM ref_tax WHERE jurisdiction='NY'`)
# MAGIC silently breaks every time a rate changes:
# MAGIC
# MAGIC 1. **2021 reports run today** apply the 2026 rate to a 2021 event → wrong tax
# MAGIC 2. **Re-runs disagree** — today's report and last year's report show different
# MAGIC    numbers for the same historical event
# MAGIC 3. **Auditors cannot reconstruct** what the property knew on a specific past date
# MAGIC 4. **Soft-deleted codes vanish** — historical events that referenced a now-retired
# MAGIC    code show "Unknown"
# MAGIC
# MAGIC The fix: every reference row carries `effective_from` / `effective_to`, and every
# MAGIC consumer query joins **as of the event date**, not `current_date`.
# MAGIC
# MAGIC ## 📚 Patterns Demonstrated
# MAGIC
# MAGIC | # | Pattern | Section |
# MAGIC |---|---------|---------|
# MAGIC | 1 | Effective-dated schema with `is_current` denormalization | Schema Design |
# MAGIC | 2 | Initial baseline load (2020) | Initial Load |
# MAGIC | 3 | Close-prior + insert-new on rate change (2022) | NY Update |
# MAGIC | 4 | Net-new combination, no close (2024) | CA Poker |
# MAGIC | 5 | Multi-row batch update (2026) | NJ Update |
# MAGIC | 6 | Adjacency-list jurisdiction hierarchy + recursive walk | Hierarchies |
# MAGIC | 7 | Soft-delete (never `DELETE`) | KY Discontinuation |
# MAGIC | 8 | AS-OF join — the value-creating pattern | AS-OF Queries |
# MAGIC | 9 | Approval workflow simulation | Approval Workflow |
# MAGIC | 10 | Reconciliation against authoritative IRS publication | Reconciliation |
# MAGIC | 11 | Distribution: Azure SQL copy + ADLS direct read + Iceberg UniForm | Distribution |
# MAGIC | 12 | Invariant verification (no overlap, non-empty periods) | Verification |

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

# Imports, Fabric parameter shim, and configuration — all in one cell so the
# shim is guaranteed to be defined before it's called (avoids NameError when
# cells are run out of order after import).
import os
from datetime import datetime, date

from delta.tables import DeltaTable
from pyspark.sql import Row
from pyspark.sql.functions import (
    col,
    count,
    countDistinct,
    current_timestamp,
    expr,
    lit,
    max,
    min,
    sum,
    when,
)
from pyspark.sql.types import (
    BooleanType,
    DateType,
    DoubleType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)


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
steward_user = _get_arg("steward_user", "compliance-steward@casino.example")

# Reference-data namespace lives in the gold lakehouse using a `ref` schema-qualifier.
# (Pattern documented in `notebooks/gold/01_gold_slot_performance.py`.)
RATES_TABLE = "lh_gold.ref.tax_jurisdiction_rates"
HIER_TABLE = "lh_gold.ref.jurisdiction_hierarchy"
IRS_AUTHORITATIVE_TABLE = "lh_gold.ref.irs_authoritative_rates"
RECONCILIATION_TABLE = "lh_gold.ref.tax_rate_drift"

# Sentinel for open-ended periods (per best-practice doc — never NULL).
OPEN_END = "9999-12-31"

print(f"Processing batch: {batch_id}")
print(f"Reference tables: {RATES_TABLE}, {HIER_TABLE}")
print(f"Steward: {steward_user}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Schema Design — `ref.tax_jurisdiction_rates`
# MAGIC
# MAGIC | Column | Type | Purpose |
# MAGIC |--------|------|---------|
# MAGIC | `jurisdiction_code` | STRING | Stable code (NV / NJ / CA / NY / KY) |
# MAGIC | `jurisdiction_name` | STRING | Display name |
# MAGIC | `game_category` | STRING | slots / table / poker / keno |
# MAGIC | `withholding_rate` | DOUBLE | Decimal rate, e.g., `0.24` for 24% |
# MAGIC | `threshold_amount` | DOUBLE | W-2G triggers above this amount |
# MAGIC | `effective_from` | DATE | Inclusive start of validity |
# MAGIC | `effective_to` | DATE | Exclusive end; `9999-12-31` if open |
# MAGIC | `version` | STRING | Semver of the rate-set release |
# MAGIC | `source` | STRING | Authority (IRS Pub 515, NY DTF, NJ DGE, ...) |
# MAGIC | `approved_by` | STRING | Steward who approved (NULL = proposed) |
# MAGIC | `approved_at` | TIMESTAMP | Approval time |
# MAGIC | `is_current` | BOOLEAN | Denormalized fast-lookup flag |
# MAGIC | `is_active` | BOOLEAN | Soft-delete flag (false = retired) |
# MAGIC | `_load_ts` | TIMESTAMP | Pipeline write time (system audit) |
# MAGIC | `_batch_id` | STRING | Batch lineage |
# MAGIC
# MAGIC ### Invariants
# MAGIC - `(jurisdiction_code, game_category, effective_from)` is unique
# MAGIC - `effective_to > effective_from` for every row
# MAGIC - Periods do not overlap for the same `(jurisdiction_code, game_category)`
# MAGIC - Exactly one row has `is_current = true` per `(jurisdiction_code, game_category)`

# COMMAND ----------

RATES_SCHEMA = StructType([
    StructField("jurisdiction_code", StringType(), False),
    StructField("jurisdiction_name", StringType(), False),
    StructField("game_category", StringType(), False),
    StructField("withholding_rate", DoubleType(), False),
    StructField("threshold_amount", DoubleType(), False),
    StructField("effective_from", DateType(), False),
    StructField("effective_to", DateType(), False),
    StructField("version", StringType(), False),
    StructField("source", StringType(), False),
    StructField("approved_by", StringType(), True),       # NULL = proposed
    StructField("approved_at", TimestampType(), True),
    StructField("is_current", BooleanType(), False),
    StructField("is_active", BooleanType(), False),
    StructField("_load_ts", TimestampType(), False),
    StructField("_batch_id", StringType(), False),
])

# Ensure schema namespace exists. Lakehouse schemas are GA in Fabric (Dec 2025).
spark.sql("CREATE SCHEMA IF NOT EXISTS lh_gold.ref")

# Drop and recreate for a clean demo run. In production the table is append-only
# and managed by MERGE; demo notebooks reset for repeatability.
spark.sql(f"DROP TABLE IF EXISTS {RATES_TABLE}")

spark.createDataFrame([], RATES_SCHEMA) \
    .write.format("delta") \
    .partitionBy("is_current") \
    .saveAsTable(RATES_TABLE)

print(f"Created empty effective-dated table: {RATES_TABLE}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Helper: Effective-Dated Insert
# MAGIC
# MAGIC The canonical operation: when a rate changes, we **close the prior open row**
# MAGIC (set its `effective_to` to the new effective date and flip `is_current = false`)
# MAGIC and then **insert the new open row** (`effective_to = '9999-12-31'`,
# MAGIC `is_current = true`).
# MAGIC
# MAGIC The function below is idempotent: if the same (jurisdiction, game, effective_from)
# MAGIC payload arrives twice it is a no-op.

# COMMAND ----------

def upsert_rate(
    *,
    jurisdiction_code: str,
    jurisdiction_name: str,
    game_category: str,
    withholding_rate: float,
    threshold_amount: float,
    effective_from: str,           # 'YYYY-MM-DD'
    version: str,
    source: str,
    approved_by: str | None,
    approved_at: datetime | None,
):
    """Effective-dated insert. Closes any currently-open row for the same
    (jurisdiction_code, game_category) and inserts a new open row.
    """
    eff_from_date = datetime.strptime(effective_from, "%Y-%m-%d").date()
    eff_to_date = datetime.strptime(OPEN_END, "%Y-%m-%d").date()
    now_ts = datetime.utcnow()

    target = DeltaTable.forName(spark, RATES_TABLE)

    # Step 1: close any currently-open row for this (jurisdiction, game).
    # Skip if the new effective_from equals an existing row (idempotency).
    target.update(
        condition=(
            f"jurisdiction_code = '{jurisdiction_code}' "
            f"AND game_category = '{game_category}' "
            f"AND is_current = true "
            f"AND effective_from < DATE('{effective_from}')"
        ),
        set={
            "effective_to": f"DATE('{effective_from}')",
            "is_current": "false",
        },
    )

    # Step 2: insert the new open row (only if not already present).
    new_row = spark.createDataFrame(
        [Row(
            jurisdiction_code=jurisdiction_code,
            jurisdiction_name=jurisdiction_name,
            game_category=game_category,
            withholding_rate=float(withholding_rate),
            threshold_amount=float(threshold_amount),
            effective_from=eff_from_date,
            effective_to=eff_to_date,
            version=version,
            source=source,
            approved_by=approved_by,
            approved_at=approved_at,
            is_current=(approved_by is not None),  # proposed rows are not current
            is_active=True,
            _load_ts=now_ts,
            _batch_id=batch_id,
        )],
        schema=RATES_SCHEMA,
    )

    target.alias("t").merge(
        new_row.alias("s"),
        "t.jurisdiction_code = s.jurisdiction_code "
        "AND t.game_category   = s.game_category "
        "AND t.effective_from  = s.effective_from",
    ).whenNotMatchedInsertAll().execute()

# COMMAND ----------

# MAGIC %md
# MAGIC ## Initial Load — 2020 Baseline
# MAGIC
# MAGIC Populate the table with the 4 jurisdictions × 4 game categories grid as it stood
# MAGIC on 2020-01-01. Real values are illustrative — the demo is about the *pattern*,
# MAGIC not the regulatory accuracy of any specific state's tables.

# COMMAND ----------

now_ts = datetime.utcnow()

# (jurisdiction_code, jurisdiction_name, game_category, rate, threshold)
BASELINE_2020 = [
    ("NV", "Nevada",     "slots",  0.000,  1200.0),  # NV has no state withholding on slots
    ("NV", "Nevada",     "table",  0.000,  5000.0),
    ("NV", "Nevada",     "poker",  0.000,  5000.0),
    ("NV", "Nevada",     "keno",   0.000,  1500.0),

    ("NJ", "New Jersey", "slots",  0.030,  1200.0),
    ("NJ", "New Jersey", "table",  0.080,  5000.0),
    ("NJ", "New Jersey", "poker",  0.080,  5000.0),
    ("NJ", "New Jersey", "keno",   0.030,  1500.0),

    ("CA", "California", "slots",  0.070,  1200.0),
    ("CA", "California", "table",  0.070,  5000.0),
    # CA had no poker withholding in 2020 — added later
    ("CA", "California", "keno",   0.070,  1500.0),

    ("NY", "New York",   "slots",  0.0850, 1200.0),
    ("NY", "New York",   "table",  0.0882, 5000.0),
    ("NY", "New York",   "poker",  0.0882, 5000.0),
    ("NY", "New York",   "keno",   0.0850, 1500.0),
]

for code, name, cat, rate, thr in BASELINE_2020:
    upsert_rate(
        jurisdiction_code=code,
        jurisdiction_name=name,
        game_category=cat,
        withholding_rate=rate,
        threshold_amount=thr,
        effective_from="2020-01-01",
        version="1.0.0",
        source="IRS Pub 515 (2020) + state DOR feeds",
        approved_by=steward_user,
        approved_at=now_ts,
    )

print(f"Baseline rows: {spark.table(RATES_TABLE).count()}")  # 15 (CA poker missing)
spark.table(RATES_TABLE).orderBy("jurisdiction_code", "game_category").show(30, False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2022 Update — NY Raises Slot Withholding Rate
# MAGIC
# MAGIC Effective 2022-04-01, New York raises slot withholding from 8.50% to 10.50%.
# MAGIC The prior open row is closed (its `effective_to` becomes 2022-04-01) and a new
# MAGIC open row is inserted. Historical reports for 2020 / 2021 / Q1-2022 must continue
# MAGIC to use the 8.50% rate.

# COMMAND ----------

upsert_rate(
    jurisdiction_code="NY",
    jurisdiction_name="New York",
    game_category="slots",
    withholding_rate=0.1050,
    threshold_amount=1200.0,
    effective_from="2022-04-01",
    version="1.1.0",                         # minor bump (rate amend, additive change)
    source="NY DTF TSB-M-22(2)R + IRS Pub 515 (2022)",
    approved_by=steward_user,
    approved_at=datetime.utcnow(),
)

print("NY slots history after 2022 update:")
spark.sql(f"""
    SELECT jurisdiction_code, game_category, withholding_rate,
           effective_from, effective_to, is_current, version
    FROM {RATES_TABLE}
    WHERE jurisdiction_code = 'NY' AND game_category = 'slots'
    ORDER BY effective_from
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2024 Update — California Introduces Poker Withholding
# MAGIC
# MAGIC California had no poker withholding in 2020. Effective 2024-01-01 a new
# MAGIC combination `(CA, poker, 0.07)` appears. There is **no prior row to close** —
# MAGIC this is a pure insert.

# COMMAND ----------

upsert_rate(
    jurisdiction_code="CA",
    jurisdiction_name="California",
    game_category="poker",
    withholding_rate=0.07,
    threshold_amount=5000.0,
    effective_from="2024-01-01",
    version="1.2.0",                         # minor bump (additive — new code combination)
    source="CA FTB Notice 2023-12 + IRS Pub 515 (2024)",
    approved_by=steward_user,
    approved_at=datetime.utcnow(),
)

print("CA poker rows (should be exactly one, open-ended):")
spark.sql(f"""
    SELECT jurisdiction_code, game_category, withholding_rate,
           effective_from, effective_to, is_current
    FROM {RATES_TABLE}
    WHERE jurisdiction_code = 'CA' AND game_category = 'poker'
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2026 Update — NJ Multi-Row Batch
# MAGIC
# MAGIC New Jersey amends both table and poker rates effective 2026-01-01. We process
# MAGIC the change as a **batch** to demonstrate atomic multi-row updates. Each call to
# MAGIC `upsert_rate` is independent; in production a single MERGE-with-CTE could
# MAGIC achieve the same result in one transaction.

# COMMAND ----------

NJ_2026 = [
    # (game_category, new_rate, threshold)
    ("table", 0.090, 5000.0),
    ("poker", 0.090, 5000.0),
]

for cat, rate, thr in NJ_2026:
    upsert_rate(
        jurisdiction_code="NJ",
        jurisdiction_name="New Jersey",
        game_category=cat,
        withholding_rate=rate,
        threshold_amount=thr,
        effective_from="2026-01-01",
        version="2.0.0",                     # MAJOR bump — rate change; consumers must review
        source="NJ DGE 2025-Reg-08 + IRS Pub 515 (2026)",
        approved_by=steward_user,
        approved_at=datetime.utcnow(),
    )

print("NJ history after 2026 batch update:")
spark.sql(f"""
    SELECT jurisdiction_code, game_category, withholding_rate,
           effective_from, effective_to, is_current, version
    FROM {RATES_TABLE}
    WHERE jurisdiction_code = 'NJ'
    ORDER BY game_category, effective_from
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Jurisdiction Hierarchy — Adjacency List
# MAGIC
# MAGIC Tax authority follows a hierarchy: **Federal → State → Local**. For W-2G we
# MAGIC mostly join at the state level, but some local jurisdictions (e.g., New York
# MAGIC City) levy their own additional withholding on top of state. We model this with
# MAGIC the simplest pattern (adjacency list — `parent_code`, `child_code`) and
# MAGIC demonstrate iterative traversal in PySpark.
# MAGIC
# MAGIC > Closure-table and path-enumeration alternatives are documented in
# MAGIC > `docs/best-practices/data-management/reference-data-versioning.md`. Adjacency
# MAGIC > list is chosen here because the tree is shallow (3 levels) and changes
# MAGIC > infrequently.

# COMMAND ----------

HIER_SCHEMA = StructType([
    StructField("parent_code", StringType(), True),       # NULL = root (FED)
    StructField("child_code", StringType(), False),
    StructField("level", StringType(), False),            # FEDERAL / STATE / LOCAL
    StructField("display_name", StringType(), False),
    StructField("effective_from", DateType(), False),
    StructField("effective_to", DateType(), False),
    StructField("is_current", BooleanType(), False),
])

spark.sql(f"DROP TABLE IF EXISTS {HIER_TABLE}")
spark.createDataFrame([], HIER_SCHEMA).write.format("delta").saveAsTable(HIER_TABLE)

# (parent, child, level, display)
HIER_ROWS = [
    (None,  "FED",      "FEDERAL", "United States Federal"),
    ("FED", "NV",       "STATE",   "Nevada"),
    ("FED", "NJ",       "STATE",   "New Jersey"),
    ("FED", "CA",       "STATE",   "California"),
    ("FED", "NY",       "STATE",   "New York"),
    ("FED", "KY",       "STATE",   "Kentucky"),
    ("NJ",  "NJ-AC",    "LOCAL",   "Atlantic City, NJ"),
    ("NY",  "NY-NYC",   "LOCAL",   "New York City, NY"),
    ("CA",  "CA-LA",    "LOCAL",   "Los Angeles County, CA"),
]

eff_from_date = date(2020, 1, 1)
eff_to_date = datetime.strptime(OPEN_END, "%Y-%m-%d").date()

hier_df = spark.createDataFrame(
    [Row(
        parent_code=p, child_code=c, level=lvl, display_name=name,
        effective_from=eff_from_date, effective_to=eff_to_date, is_current=True,
    ) for p, c, lvl, name in HIER_ROWS],
    schema=HIER_SCHEMA,
)
hier_df.write.format("delta").mode("append").saveAsTable(HIER_TABLE)

print(f"Hierarchy rows: {spark.table(HIER_TABLE).count()}")
spark.table(HIER_TABLE).orderBy("level", "child_code").show(20, False)

# COMMAND ----------

# MAGIC %md
# MAGIC ### Recursive Walk — All Descendants of FED
# MAGIC
# MAGIC Spark SQL does not natively support `WITH RECURSIVE`. The pragmatic pattern is
# MAGIC iterative join with a fixed maximum depth (3 here for FED → STATE → LOCAL).

# COMMAND ----------

def walk_hierarchy(root_code: str, max_depth: int = 5):
    """Iteratively expand all (ancestor, descendant, depth) pairs from a root code."""
    hier = spark.table(HIER_TABLE).filter("is_current = true")
    # Seed: root reaches itself at depth 0
    result = spark.createDataFrame(
        [Row(ancestor=root_code, descendant=root_code, depth=0)],
        schema="ancestor STRING, descendant STRING, depth INT",
    )
    frontier = result
    for d in range(1, max_depth + 1):
        next_level = (frontier.alias("f")
            .join(hier.alias("h"), col("f.descendant") == col("h.parent_code"), "inner")
            .select(
                col("f.ancestor").alias("ancestor"),
                col("h.child_code").alias("descendant"),
                lit(d).alias("depth"),
            )
        )
        if next_level.limit(1).count() == 0:
            break
        result = result.unionByName(next_level)
        frontier = next_level
    return result

descendants = walk_hierarchy("FED", max_depth=3)
print("All jurisdictions under FED:")
descendants.orderBy("depth", "descendant").show(20, False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Soft-Delete — Kentucky Discontinues Keno
# MAGIC
# MAGIC Effective 2025-07-01 the (illustrative) state of Kentucky discontinues its keno
# MAGIC withholding category. We **never** `DELETE` — that would orphan every historical
# MAGIC W-2G that referenced KY-keno. Instead:
# MAGIC
# MAGIC 1. Insert a 2024 baseline KY-keno row (so we have something to retire)
# MAGIC 2. Close that row at 2025-07-01 by setting `effective_to` and `is_current=false`
# MAGIC 3. Set `is_active=false` to stop *new* transactions from using the code
# MAGIC
# MAGIC Historical events with `event_date < 2025-07-01` still resolve correctly via
# MAGIC the as-of join.

# COMMAND ----------

# Step 1: insert a KY-keno baseline so we have something to retire.
upsert_rate(
    jurisdiction_code="KY",
    jurisdiction_name="Kentucky",
    game_category="keno",
    withholding_rate=0.06,
    threshold_amount=1500.0,
    effective_from="2024-01-01",
    version="1.2.0",
    source="KY DOR Reg 103 KAR 18:020 + IRS Pub 515 (2024)",
    approved_by=steward_user,
    approved_at=datetime.utcnow(),
)

# Step 2 + 3: close the open row and mark inactive.
DeltaTable.forName(spark, RATES_TABLE).update(
    condition=(
        "jurisdiction_code = 'KY' AND game_category = 'keno' AND is_current = true"
    ),
    set={
        "effective_to": "DATE('2025-07-01')",
        "is_current": "false",
        "is_active": "false",
    },
)

print("KY keno row after soft-delete (period closed, is_active=false, no row deleted):")
spark.sql(f"""
    SELECT jurisdiction_code, game_category, withholding_rate,
           effective_from, effective_to, is_current, is_active
    FROM {RATES_TABLE}
    WHERE jurisdiction_code = 'KY'
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## AS-OF Queries — The Value-Creating Pattern
# MAGIC
# MAGIC This is the heart of the notebook. A consumer (e.g., a year-end W-2G generator)
# MAGIC computes withholding for an event by joining the event to the rate that was in
# MAGIC effect on the **event date**, not today.
# MAGIC
# MAGIC The query pattern:
# MAGIC
# MAGIC ```sql
# MAGIC ON  rates.jurisdiction_code = event.jurisdiction
# MAGIC AND rates.game_category    = event.game
# MAGIC AND rates.effective_from   <= event.event_date
# MAGIC AND event.event_date       <  rates.effective_to
# MAGIC ```
# MAGIC
# MAGIC We expose this as a Python helper for ad-hoc use and as a SQL view for BI tools.

# COMMAND ----------

def tax_due_for_w2g(
    *,
    jurisdiction: str,
    game: str,
    amount: float,
    event_date: str,                   # 'YYYY-MM-DD'
) -> dict:
    """Return the tax due for a W-2G event, using the rate in effect on event_date."""
    row = spark.sql(f"""
        SELECT withholding_rate, threshold_amount, version, effective_from, effective_to
        FROM {RATES_TABLE}
        WHERE jurisdiction_code = '{jurisdiction}'
          AND game_category     = '{game}'
          AND effective_from   <= DATE('{event_date}')
          AND DATE('{event_date}') < effective_to
    """).collect()

    if not row:
        return {"jurisdiction": jurisdiction, "game": game, "event_date": event_date,
                "amount": amount, "tax_due": None,
                "error": f"No rate found for ({jurisdiction}, {game}) on {event_date}"}

    r = row[0]
    triggered = amount >= r["threshold_amount"]
    tax = round(amount * r["withholding_rate"], 2) if triggered else 0.0
    return {
        "jurisdiction": jurisdiction,
        "game": game,
        "event_date": event_date,
        "amount": amount,
        "withholding_rate": r["withholding_rate"],
        "threshold_amount": r["threshold_amount"],
        "w2g_triggered": triggered,
        "tax_due": tax,
        "rate_version": r["version"],
        "rate_effective_from": str(r["effective_from"]),
        "rate_effective_to": str(r["effective_to"]),
    }

# COMMAND ----------

# MAGIC %md
# MAGIC ### Demonstration — 2021 vs 2024 NY Slot Jackpot
# MAGIC
# MAGIC A $50,000 NY slot jackpot won in 2021 used the 8.50% rate.
# MAGIC The same jackpot in 2024 uses 10.50%. The historical answer must never change.

# COMMAND ----------

print("2021 jackpot (correct: 8.50% × 50000 = 4250.00):")
print(tax_due_for_w2g(jurisdiction="NY", game="slots", amount=50000.0, event_date="2021-08-15"))

print("\n2024 jackpot (correct: 10.50% × 50000 = 5250.00):")
print(tax_due_for_w2g(jurisdiction="NY", game="slots", amount=50000.0, event_date="2024-08-15"))

# COMMAND ----------

# MAGIC %md
# MAGIC ### The Bug Pattern — `is_current = true` Instead of As-Of
# MAGIC
# MAGIC The single most common reference-data bug: filter `is_current = true` and treat
# MAGIC the result as "the rate." This silently mis-classifies every historical event.
# MAGIC The cell below shows what *would* happen if a developer wrote the bug.

# COMMAND ----------

def buggy_tax_due(jurisdiction: str, game: str, amount: float) -> float:
    """❌ DO NOT USE — demonstrates the bug. Always uses today's rate."""
    row = spark.sql(f"""
        SELECT withholding_rate
        FROM {RATES_TABLE}
        WHERE jurisdiction_code = '{jurisdiction}'
          AND game_category     = '{game}'
          AND is_current = true
    """).collect()
    if not row:
        return 0.0
    return round(amount * row[0]["withholding_rate"], 2)

correct = tax_due_for_w2g(
    jurisdiction="NY", game="slots", amount=50000.0, event_date="2021-08-15",
)["tax_due"]
buggy = buggy_tax_due("NY", "slots", 50000.0)

print(f"AS-OF (correct):       ${correct:,.2f}   <- uses 2021 rate (8.50%)")
print(f"is_current (buggy):    ${buggy:,.2f}   <- uses today's rate (10.50%)")
print(f"Discrepancy on a single jackpot: ${abs(buggy - correct):,.2f}")
print("On a year of jackpots this drift would be material, and re-running the same")
print("report after another rate change would change every historical number.")

# COMMAND ----------

# MAGIC %md
# MAGIC ### SQL View — `vw_tax_jurisdiction_rates_asof`
# MAGIC
# MAGIC Publish the as-of join as a view so BI tools and SQL consumers cannot
# MAGIC accidentally write the buggy pattern. The view takes an event date column as
# MAGIC input and is meant to be used in a join against any fact table that has an
# MAGIC `event_date`.
# MAGIC
# MAGIC ```sql
# MAGIC -- Consumer pattern:
# MAGIC SELECT f.event_id, f.amount, r.withholding_rate, f.amount * r.withholding_rate AS tax
# MAGIC FROM   gold.fact_w2g_event AS f
# MAGIC JOIN   ref.tax_jurisdiction_rates AS r
# MAGIC   ON   r.jurisdiction_code = f.jurisdiction_code
# MAGIC  AND   r.game_category    = f.game_category
# MAGIC  AND   r.effective_from   <= f.event_date
# MAGIC  AND   f.event_date       <  r.effective_to;
# MAGIC ```

# COMMAND ----------

# MAGIC %md
# MAGIC ## Approval Workflow Simulation
# MAGIC
# MAGIC Compliance reference data must follow a two-step workflow:
# MAGIC
# MAGIC 1. **Propose** — pipeline (or steward via Power Apps / Translytical Task Flow)
# MAGIC    inserts a row with `approved_by = NULL` and `is_current = false`.
# MAGIC    The row is *not* visible to consumers because every consumer query filters
# MAGIC    `WHERE approved_by IS NOT NULL`.
# MAGIC 2. **Approve** — a second steward reviews the diff, approves, and promotes
# MAGIC    the row by setting `approved_by`, `approved_at`, closing the prior current
# MAGIC    row, and flipping `is_current = true` on the new row.
# MAGIC
# MAGIC We simulate a proposed 2027 NY slot rate change.

# COMMAND ----------

# Step 1: insert the proposed row (approved_by = NULL → not current).
upsert_rate(
    jurisdiction_code="NY",
    jurisdiction_name="New York",
    game_category="slots",
    withholding_rate=0.115,                  # proposed 11.5%
    threshold_amount=1200.0,
    effective_from="2027-01-01",
    version="2.1.0-proposed",
    source="NY DTF TSB-M-26(7)R [PROPOSED]",
    approved_by=None,                        # ← not approved yet
    approved_at=None,
)

print("Proposed row visible to stewards but is_current = false:")
spark.sql(f"""
    SELECT jurisdiction_code, game_category, withholding_rate, version,
           effective_from, effective_to, is_current, approved_by
    FROM {RATES_TABLE}
    WHERE jurisdiction_code = 'NY' AND game_category = 'slots'
    ORDER BY effective_from
""").show(truncate=False)

# COMMAND ----------

# Step 2: approver reviews diff, then promotes the proposed row.
approver_user = "second-compliance-steward@casino.example"
approval_ts = datetime.utcnow()

# Close the prior current row (2022-04-01 → open).
DeltaTable.forName(spark, RATES_TABLE).update(
    condition=(
        "jurisdiction_code = 'NY' AND game_category = 'slots' "
        "AND is_current = true AND effective_from = DATE('2022-04-01')"
    ),
    set={
        "effective_to": "DATE('2027-01-01')",
        "is_current": "false",
    },
)

# Promote the proposed row.
DeltaTable.forName(spark, RATES_TABLE).update(
    condition=(
        "jurisdiction_code = 'NY' AND game_category = 'slots' "
        "AND effective_from = DATE('2027-01-01') AND approved_by IS NULL"
    ),
    set={
        "approved_by": f"'{approver_user}'",
        "approved_at": f"timestamp('{approval_ts.strftime('%Y-%m-%d %H:%M:%S')}')",
        "is_current": "true",
        "version": "'2.1.0'",                # drop the -proposed suffix
    },
)

print("After approval — NY slot history is correct, all rows approved:")
spark.sql(f"""
    SELECT jurisdiction_code, game_category, withholding_rate, version,
           effective_from, effective_to, is_current, approved_by
    FROM {RATES_TABLE}
    WHERE jurisdiction_code = 'NY' AND game_category = 'slots'
    ORDER BY effective_from
""").show(truncate=False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Reconciliation — Compare to Authoritative IRS Publication
# MAGIC
# MAGIC In production, IRS Publication 515 is the federal authority and each state DOR
# MAGIC publishes the state component. A nightly reconciliation job compares our
# MAGIC `is_current = true` rows to the authoritative feed and writes any drift into a
# MAGIC drift table for steward review.
# MAGIC
# MAGIC Here we synthesize a small "authoritative" feed and intentionally introduce one
# MAGIC drift row to demonstrate the alert path.

# COMMAND ----------

AUTH_SCHEMA = StructType([
    StructField("jurisdiction_code", StringType(), False),
    StructField("game_category", StringType(), False),
    StructField("withholding_rate", DoubleType(), False),
    StructField("threshold_amount", DoubleType(), False),
    StructField("publication", StringType(), False),
])

# "Authoritative" snapshot. Note the deliberate CA-table drift: authority says 0.075
# but our table still shows 0.070.
AUTH_ROWS = [
    ("NV", "slots",  0.000,  1200.0, "IRS Pub 515 (2026)"),
    ("NV", "table",  0.000,  5000.0, "IRS Pub 515 (2026)"),
    ("NJ", "slots",  0.030,  1200.0, "NJ DGE 2026"),
    ("NJ", "table",  0.090,  5000.0, "NJ DGE 2026"),    # matches our 2026 update
    ("NJ", "poker",  0.090,  5000.0, "NJ DGE 2026"),
    ("CA", "slots",  0.070,  1200.0, "CA FTB 2026"),
    ("CA", "table",  0.075,  5000.0, "CA FTB 2026"),    # ← DRIFT (we have 0.070)
    ("CA", "poker",  0.070,  5000.0, "CA FTB 2026"),
    ("NY", "slots",  0.1050, 1200.0, "NY DTF 2026"),    # current row pre-2027
    ("NY", "table",  0.0882, 5000.0, "NY DTF 2026"),
]

spark.sql(f"DROP TABLE IF EXISTS {IRS_AUTHORITATIVE_TABLE}")
spark.createDataFrame(
    [Row(jurisdiction_code=j, game_category=g, withholding_rate=r,
         threshold_amount=t, publication=p) for j, g, r, t, p in AUTH_ROWS],
    schema=AUTH_SCHEMA,
).write.format("delta").saveAsTable(IRS_AUTHORITATIVE_TABLE)

print(f"Authoritative snapshot rows: {spark.table(IRS_AUTHORITATIVE_TABLE).count()}")

# COMMAND ----------

# Reconciliation: compare current internal rates to the authoritative feed.
drift = spark.sql(f"""
    SELECT
        a.jurisdiction_code,
        a.game_category,
        r.withholding_rate    AS internal_rate,
        a.withholding_rate    AS authoritative_rate,
        r.threshold_amount    AS internal_threshold,
        a.threshold_amount    AS authoritative_threshold,
        a.publication,
        current_timestamp()   AS detected_at
    FROM {IRS_AUTHORITATIVE_TABLE} a
    LEFT JOIN (
        SELECT jurisdiction_code, game_category, withholding_rate, threshold_amount
        FROM {RATES_TABLE}
        WHERE is_current = true AND is_active = true
    ) r
      ON r.jurisdiction_code = a.jurisdiction_code
     AND r.game_category    = a.game_category
    WHERE r.withholding_rate IS NULL
       OR ABS(r.withholding_rate    - a.withholding_rate)    > 1e-9
       OR ABS(r.threshold_amount    - a.threshold_amount)    > 1e-9
""")

drift.write.format("delta").mode("overwrite").option("overwriteSchema", "true") \
    .saveAsTable(RECONCILIATION_TABLE)

drift_count = spark.table(RECONCILIATION_TABLE).count()
print(f"Drift rows detected: {drift_count}  (expected: 1 — CA table)")
spark.table(RECONCILIATION_TABLE).show(truncate=False)

if drift_count > 0:
    print(f"⚠️  {drift_count} drift row(s) routed to steward queue.")
    print("    Steward action: review authority publication, then upsert_rate(...) "
          "with the corrected value.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Distribution — Azure SQL point-lookups, ADLS direct read, Iceberg interop
# MAGIC
# MAGIC Reference tables are small, change infrequently, and are consumed by many
# MAGIC engines. The Azure-native distribution paths (no Fabric, no OneLake) are:
# MAGIC
# MAGIC - **Azure SQL Database copy** — for low-latency point lookups from
# MAGIC   transactional applications (W-2G generator, casino floor management
# MAGIC   system). The small ref table is written to Azure SQL via the Spark JDBC
# MAGIC   connector; for continuous sync use an ADF/Synapse CDC copy.
# MAGIC - **ADLS Gen2 direct read** — the canonical Azure-native equivalent of a
# MAGIC   cross-workspace shortcut: consumers read the ADLS Delta path directly
# MAGIC   (RBAC-scoped) or register a Synapse Serverless external table over it —
# MAGIC   no copy, single source of truth.
# MAGIC - **Iceberg interop** — Delta UniForm exposes the same Delta files as
# MAGIC   Iceberg so Snowflake / Trino / Athena read them via the Iceberg catalog.
# MAGIC
# MAGIC Every snippet below performs a real Azure-native operation; none depends
# MAGIC on a Fabric capacity, workspace, or REST API.

# COMMAND ----------

# --- Distribute to Azure SQL Database for low-latency point lookups ---
# The Spark JDBC connector writes the small ref table to Azure SQL DB. Auth uses
# an AAD access token (workspace identity); the SQL server is the Azure-native
# warehouse-family endpoint (*.database.windows.net). Apps then query it with
# sub-millisecond latency — the same effective_from / effective_to columns are
# available there. For continuous sync, schedule an ADF/Synapse CDC copy.
AZURE_SQL_SERVER = _get_arg("azure_sql_server", "<sql-server-name>.database.windows.net")
AZURE_SQL_DB = _get_arg("azure_sql_db", "loom_ref")
SQL_JDBC_URL = (
    f"jdbc:sqlserver://{AZURE_SQL_SERVER}:1433;database={AZURE_SQL_DB};"
    "encrypt=true;trustServerCertificate=false;"
    "authentication=ActiveDirectoryMSI"
)
try:
    (
        spark.table(RATES_TABLE)
        .write.format("jdbc")
        .option("url", SQL_JDBC_URL)
        .option("dbtable", "dbo.tax_jurisdiction_rates")
        .mode("overwrite")
        .save()
    )
    print(f"Distributed {RATES_TABLE} -> Azure SQL {AZURE_SQL_DB}.dbo.tax_jurisdiction_rates")
except Exception as e:
    # Honest infra gate: surfaces when Azure SQL is not provisioned in this env.
    print(f"Azure SQL distribution skipped (set azure_sql_server / grant the workspace "
          f"identity db_datawriter on {AZURE_SQL_DB}): {e}")

# --- Cross-workspace consumption via ADLS Gen2 direct read ---
# No shortcut object exists in ADLS. Consumers read the Delta path directly
# (RBAC: Storage Blob Data Reader on the container) or register a Synapse
# Serverless external table over it — single source of truth, no copy.
REF_DELTA_PATH = "abfss://gold@{{ADLS_ACCOUNT}}.dfs.core.windows.net/ref/tax_jurisdiction_rates"
print("Cross-workspace consumers read directly from:", REF_DELTA_PATH)
print(
    "Synapse Serverless external table DDL:\n"
    "  CREATE EXTERNAL TABLE ref.tax_jurisdiction_rates\n"
    f"  WITH (LOCATION='{REF_DELTA_PATH}', DATA_SOURCE=adls_gold, FILE_FORMAT=delta_fmt);"
)

# --- Iceberg interop for external engines (Delta UniForm) ---
# Enable Delta UniForm so the same Delta files are also readable as Iceberg by
# Snowflake / Trino / Athena — Azure-native, no Fabric/OneLake catalog.
try:
    spark.sql(
        f"ALTER TABLE {RATES_TABLE} SET TBLPROPERTIES("
        "'delta.universalFormat.enabledFormats'='iceberg', "
        "'delta.enableIcebergCompatV2'='true')"
    )
    print(f"Delta UniForm (Iceberg) enabled on {RATES_TABLE} for external-engine reads.")
except Exception as e:
    print(f"Iceberg UniForm requires Delta 3.x runtime; skipped: {e}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Verification — Sample Calculations and Invariants

# COMMAND ----------

# Verification 1: 2021 sample W-2G calculation.
print("=" * 70)
print("Verification 1 — 2021 W-2G calculation (NY $50K slot jackpot)")
print("=" * 70)
result_2021 = tax_due_for_w2g(jurisdiction="NY", game="slots", amount=50000.0,
                              event_date="2021-08-15")
print(f"  rate used:       {result_2021['withholding_rate']}  "
      f"(version {result_2021['rate_version']})")
print(f"  effective range: {result_2021['rate_effective_from']} → "
      f"{result_2021['rate_effective_to']}")
print(f"  tax due:         ${result_2021['tax_due']:,.2f}")
assert result_2021["tax_due"] == 4250.00, "2021 NY slot tax should be 4250.00"

# COMMAND ----------

# Verification 2: 2024 sample W-2G calculation (after rate change).
print("=" * 70)
print("Verification 2 — 2024 W-2G calculation (same NY $50K slot jackpot)")
print("=" * 70)
result_2024 = tax_due_for_w2g(jurisdiction="NY", game="slots", amount=50000.0,
                              event_date="2024-08-15")
print(f"  rate used:       {result_2024['withholding_rate']}  "
      f"(version {result_2024['rate_version']})")
print(f"  effective range: {result_2024['rate_effective_from']} → "
      f"{result_2024['rate_effective_to']}")
print(f"  tax due:         ${result_2024['tax_due']:,.2f}")
assert result_2024["tax_due"] == 5250.00, "2024 NY slot tax should be 5250.00"

# COMMAND ----------

# Verification 3: invariant — effective_from < effective_to on every row.
print("=" * 70)
print("Verification 3 — Invariant: effective_from < effective_to on every row")
print("=" * 70)
bad_periods = spark.sql(f"""
    SELECT jurisdiction_code, game_category, effective_from, effective_to
    FROM {RATES_TABLE}
    WHERE effective_to <= effective_from
""")
bad_count = bad_periods.count()
print(f"  rows violating invariant: {bad_count}")
assert bad_count == 0, "Invariant violation: at least one row has effective_to <= effective_from"
print("  PASS — every period is non-empty.")

# COMMAND ----------

# Verification 4: invariant — no overlapping periods for any (jurisdiction, game).
print("=" * 70)
print("Verification 4 — Invariant: no overlapping periods per (jurisdiction, game)")
print("=" * 70)
overlaps = spark.sql(f"""
    SELECT a.jurisdiction_code, a.game_category,
           a.effective_from AS a_from, a.effective_to AS a_to,
           b.effective_from AS b_from, b.effective_to AS b_to
    FROM {RATES_TABLE} a
    JOIN {RATES_TABLE} b
      ON a.jurisdiction_code = b.jurisdiction_code
     AND a.game_category    = b.game_category
     AND a.effective_from   < b.effective_from           -- avoid self-pair
     AND a.effective_to     > b.effective_from           -- a ends after b starts
     AND a.effective_from   < b.effective_to             -- a starts before b ends
""")
overlap_count = overlaps.count()
print(f"  overlapping period pairs: {overlap_count}")
if overlap_count > 0:
    overlaps.show(truncate=False)
assert overlap_count == 0, "Invariant violation: overlapping periods detected"
print("  PASS — periods are disjoint within each (jurisdiction, game).")

# COMMAND ----------

# Verification 5: invariant — exactly one row per (jurisdiction, game) has is_current = true
# (excluding inactive / soft-deleted combinations).
print("=" * 70)
print("Verification 5 — Invariant: exactly one current row per (jurisdiction, game)")
print("=" * 70)
multi_current = spark.sql(f"""
    SELECT jurisdiction_code, game_category, COUNT(*) AS current_rows
    FROM {RATES_TABLE}
    WHERE is_current = true
    GROUP BY jurisdiction_code, game_category
    HAVING COUNT(*) > 1
""")
multi_count = multi_current.count()
print(f"  combinations with > 1 current row: {multi_count}")
if multi_count > 0:
    multi_current.show(truncate=False)
assert multi_count == 0, "Invariant violation: multiple current rows detected"
print("  PASS — at most one current row per (jurisdiction, game).")

# COMMAND ----------

# Summary report of every (jurisdiction, game) trail.
print("=" * 70)
print("Final reference table — full history per (jurisdiction, game)")
print("=" * 70)
spark.sql(f"""
    SELECT jurisdiction_code, game_category, withholding_rate,
           threshold_amount, effective_from, effective_to,
           is_current, is_active, version, approved_by
    FROM {RATES_TABLE}
    ORDER BY jurisdiction_code, game_category, effective_from
""").show(50, False)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Optimize for Direct Lake

# COMMAND ----------

spark.sql(f"OPTIMIZE {RATES_TABLE} ZORDER BY (jurisdiction_code, game_category)")
spark.sql(f"OPTIMIZE {HIER_TABLE}  ZORDER BY (parent_code, child_code)")
print("Reference tables optimized with Z-Order for as-of join performance.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Cleanup
# MAGIC
# MAGIC In a real environment we keep the reference tables — they *are* the deliverable.
# MAGIC In a notebook demo, leave the data intact for downstream notebooks to consume.
# MAGIC The cell below is a no-op placeholder that documents what cleanup *would*
# MAGIC look like if this were a teardown (do not run in production).

# COMMAND ----------

# In production: do NOT drop reference tables. They are the source of truth.
# In demo teardown only:
#
#   spark.sql(f"DROP TABLE IF EXISTS {RATES_TABLE}")
#   spark.sql(f"DROP TABLE IF EXISTS {HIER_TABLE}")
#   spark.sql(f"DROP TABLE IF EXISTS {IRS_AUTHORITATIVE_TABLE}")
#   spark.sql(f"DROP TABLE IF EXISTS {RECONCILIATION_TABLE}")
#
# The reconciliation table is the only one that may be safely truncated on a
# schedule (rows older than retention policy), since drift events are written
# fresh on each run.
print("Reference tables retained — they are the deliverable.")
print(f"Batch {batch_id} complete.")

_notebook_exit(f"SUCCESS:{batch_id}")
