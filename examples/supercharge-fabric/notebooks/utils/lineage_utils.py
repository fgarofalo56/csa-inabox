# Databricks notebook source
# MAGIC %md
# MAGIC # Notebook Utilities: Data Lineage & Pipeline Helpers
# MAGIC
# MAGIC Shared utility functions for data lineage metadata, data quality scoring,
# MAGIC safe Delta writes, post-write validation, and execution logging across
# MAGIC all medallion architecture notebooks.
# MAGIC
# MAGIC ## Usage
# MAGIC ```python
# MAGIC %run ../utils/lineage_utils
# MAGIC
# MAGIC # --- Lineage (original) ---
# MAGIC df = add_bronze_lineage(df, source_path, batch_id)
# MAGIC df = add_silver_lineage(df, source_table, batch_id)
# MAGIC df = add_gold_lineage(df, source_table, batch_id, kpi_version="1.0")
# MAGIC
# MAGIC # --- New helpers ---
# MAGIC batch_id = get_batch_id(dbutils)
# MAGIC
# MAGIC df = add_layer_metadata(df, "silver", batch_id, source_system="casino")
# MAGIC
# MAGIC df = compute_dq_score(df, [
# MAGIC     {"name": "player_id_present", "column": "player_id", "check": "not_null", "points": 25},
# MAGIC     {"name": "bet_positive", "column": "bet_amount", "check": "positive", "points": 25},
# MAGIC     {"name": "game_valid", "column": "game_type", "check": "in_set", "points": 25,
# MAGIC      "params": {"values": ["slots", "blackjack", "poker", "roulette"]}},
# MAGIC     {"name": "age_range", "column": "player_age", "check": "range", "points": 25,
# MAGIC      "params": {"min": 21, "max": 120}},
# MAGIC ])
# MAGIC
# MAGIC result = safe_write_delta(df, "lh_silver.silver_slot_cleansed",
# MAGIC                           partition_by=["gaming_date"],
# MAGIC                           optimize_columns=["player_id"],
# MAGIC                           batch_id=batch_id)
# MAGIC
# MAGIC metrics = validate_write(spark, "lh_silver.silver_slot_cleansed")
# MAGIC
# MAGIC log_execution(spark, table_name="lh_silver.silver_slot_cleansed",
# MAGIC               notebook_name="01_silver_slot_cleansed", batch_id=batch_id,
# MAGIC               layer="silver", status=result["status"],
# MAGIC               row_count_in=df_raw.count(), row_count_out=result["row_count"],
# MAGIC               dq_metrics=metrics, duration_seconds=result["duration_seconds"])
# MAGIC ```

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


import time
import uuid
from datetime import datetime

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql.functions import (
    avg,
    col,
    count,
    current_timestamp,
    lit,
    regexp_extract,
    when,
)
from pyspark.sql.functions import (
    sum as spark_sum,
)
from pyspark.sql.types import (
    DoubleType,
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)


def generate_pipeline_run_id() -> str:
    """Generate a unique pipeline run ID for tracking lineage across layers."""
    return f"run-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"


def add_bronze_lineage(
    df: DataFrame,
    source_path: str,
    batch_id: str,
    pipeline_run_id: str | None = None,
    source_system: str = "landing_zone",
) -> DataFrame:
    """Add Bronze layer lineage metadata columns.

    Args:
        df: Input DataFrame
        source_path: Path to source data
        batch_id: Batch identifier
        pipeline_run_id: Optional pipeline run ID (generated if not provided)
        source_system: Name of the source system

    Returns:
        DataFrame with lineage columns added
    """
    run_id = pipeline_run_id or generate_pipeline_run_id()

    return (
        df.withColumn("_lineage_layer", lit("bronze"))
        .withColumn("_lineage_source_system", lit(source_system))
        .withColumn("_lineage_source_path", lit(source_path))
        .withColumn("_lineage_pipeline_run_id", lit(run_id))
        .withColumn("_lineage_ingested_at", current_timestamp())
        .withColumn("_lineage_batch_id", lit(batch_id))
    )


def add_silver_lineage(
    df: DataFrame,
    source_table: str,
    batch_id: str,
    pipeline_run_id: str | None = None,
    transformations_applied: str = "",
) -> DataFrame:
    """Add Silver layer lineage metadata columns.

    Args:
        df: Input DataFrame
        source_table: Name of source Bronze table
        batch_id: Batch identifier
        pipeline_run_id: Optional pipeline run ID
        transformations_applied: Description of transformations

    Returns:
        DataFrame with lineage columns added
    """
    run_id = pipeline_run_id or generate_pipeline_run_id()

    return (
        df.withColumn("_lineage_layer", lit("silver"))
        .withColumn("_lineage_source_table", lit(source_table))
        .withColumn("_lineage_pipeline_run_id", lit(run_id))
        .withColumn("_lineage_processed_at", current_timestamp())
        .withColumn("_lineage_batch_id", lit(batch_id))
        .withColumn("_lineage_transformations", lit(transformations_applied))
    )


def add_gold_lineage(
    df: DataFrame,
    source_table: str,
    batch_id: str,
    pipeline_run_id: str | None = None,
    kpi_version: str = "1.0",
    aggregation_grain: str = "",
) -> DataFrame:
    """Add Gold layer lineage metadata columns.

    Args:
        df: Input DataFrame
        source_table: Name of source Silver table
        batch_id: Batch identifier
        pipeline_run_id: Optional pipeline run ID
        kpi_version: Version of the KPI calculation logic
        aggregation_grain: Description of aggregation level

    Returns:
        DataFrame with lineage columns added
    """
    run_id = pipeline_run_id or generate_pipeline_run_id()

    return (
        df.withColumn("_lineage_layer", lit("gold"))
        .withColumn("_lineage_source_table", lit(source_table))
        .withColumn("_lineage_pipeline_run_id", lit(run_id))
        .withColumn("_lineage_computed_at", current_timestamp())
        .withColumn("_lineage_batch_id", lit(batch_id))
        .withColumn("_lineage_kpi_version", lit(kpi_version))
        .withColumn("_lineage_aggregation_grain", lit(aggregation_grain))
    )


def get_lineage_summary(spark, table_name: str) -> None:
    """Print lineage summary for a table.

    Args:
        spark: SparkSession
        table_name: Name of the table to inspect
    """
    print(f"\n{'='*60}")
    print(f"Data Lineage Summary: {table_name}")
    print(f"{'='*60}")

    lineage_cols = [c for c in spark.table(table_name).columns if c.startswith("_lineage_")]

    if not lineage_cols:
        print("No lineage columns found in table.")
        return

    print(f"Lineage columns: {', '.join(lineage_cols)}")

    # Show latest lineage info
    spark.sql(f"""
        SELECT {', '.join(lineage_cols)}
        FROM {table_name}
        LIMIT 1
    """).show(truncate=False)


# COMMAND ----------

# =============================================================================
# Widget Parameter Extraction
# =============================================================================


def get_batch_id(dbutils=None) -> str:
    """Extract batch_id from a Fabric/Databricks widget or generate a timestamp-based default.

    This eliminates the 3-line boilerplate that appears in every notebook for
    reading the ``batch_id`` widget parameter.

    Args:
        dbutils: The ``dbutils`` object available in Fabric/Databricks notebooks.
                 Pass ``None`` when running outside a notebook environment
                 (unit tests, local dev) to get a generated timestamp ID.

    Returns:
        A batch identifier string — either the widget value or
        ``YYYYMMDD_HHMMSS`` format.

    Example::

        batch_id = get_batch_id(dbutils)
        # In Fabric: returns widget value if set, otherwise timestamp
        # Locally:   returns timestamp like "20260413_143022"
    """
    if dbutils is not None:
        try:
            # Best-effort compatibility: mssparkutils / notebookutils expose
            # getArgument; Databricks dbutils exposes widgets.getAll. Try the
            # arg fetch first (works in Fabric), fall back to widget list.
            value = _get_arg("batch_id")
            if value and str(value).strip():
                return str(value).strip()
            widget_names = [w.name for w in dbutils.widgets.getAll()]
            if "batch_id" in widget_names:
                value = _get_arg("batch_id")
                if value and value.strip():
                    return value.strip()
        except Exception:
            # Widget API not available - fall through to default
            pass

    return datetime.now().strftime("%Y%m%d_%H%M%S")


# COMMAND ----------

# =============================================================================
# Data Quality Scoring
# =============================================================================


def _build_dq_condition(rule: dict, df: DataFrame) -> col:
    """Build a PySpark ``when`` expression for a single DQ rule.

    Supported checks:

    * ``not_null``  — column is not null and (for strings) not empty
    * ``positive``  — numeric column > 0
    * ``in_set``    — column value is in ``params["values"]``
    * ``range``     — numeric column between ``params["min"]`` and ``params["max"]`` inclusive
    * ``regex``     — string column matches ``params["pattern"]``

    Returns:
        A Column expression that evaluates to the rule's ``points`` on pass or 0.
    """
    column_name: str = rule["column"]
    check: str = rule["check"]
    points: int = rule["points"]
    params: dict = rule.get("params", {})

    c = col(column_name)

    if check == "not_null":
        condition = c.isNotNull()
        # For string columns also reject empty / whitespace-only values
        field_names = {f.name: f.dataType for f in df.schema.fields}
        if column_name in field_names and isinstance(field_names[column_name], StringType):
            condition = condition & (c != "")
    elif check == "positive":
        condition = c.isNotNull() & (c > 0)
    elif check == "in_set":
        allowed = params.get("values", [])
        condition = c.isNotNull() & c.isin(allowed)
    elif check == "range":
        lo = params.get("min", float("-inf"))
        hi = params.get("max", float("inf"))
        condition = c.isNotNull() & (c >= lo) & (c <= hi)
    elif check == "regex":
        pattern = params.get("pattern", ".*")
        condition = c.isNotNull() & (regexp_extract(c.cast("string"), pattern, 0) != "")
    else:
        raise ValueError(
            f"Unknown DQ check type '{check}'. "
            f"Supported: not_null, positive, in_set, range, regex."
        )

    return when(condition, lit(points)).otherwise(lit(0))


def compute_dq_score(
    df: DataFrame,
    rules: list[dict],
    score_column: str = "_dq_score",
    passed_column: str = "_dq_passed",
    pass_threshold: int = 75,
) -> DataFrame:
    """Apply data-quality scoring rules and append score columns.

    Each rule is a dictionary with keys:

    * ``name``   — human-readable rule label (used for traceability)
    * ``column`` — DataFrame column to evaluate
    * ``check``  — one of ``not_null``, ``positive``, ``in_set``, ``range``, ``regex``
    * ``points`` — integer points awarded when the check passes
    * ``params`` — (optional) dict of check-specific parameters:

      - ``in_set``:  ``{"values": [...]}}``
      - ``range``:   ``{"min": N, "max": N}``
      - ``regex``:   ``{"pattern": "..."}``

    The function normalises the raw point total to a 0–100 scale and adds a
    boolean pass/fail column.

    All scoring is done via PySpark column expressions — no Python-level row
    iteration.

    Args:
        df: Input DataFrame.
        rules: List of rule dictionaries.
        score_column: Name for the 0-100 score column.
        passed_column: Name for the boolean pass/fail column.
        pass_threshold: Minimum score to count as *passed* (default 75).

    Returns:
        DataFrame with ``score_column`` (IntegerType, 0-100) and
        ``passed_column`` (BooleanType) appended.

    Raises:
        ValueError: If ``rules`` is empty or contains an unsupported check type.

    Example::

        rules = [
            {"name": "id_present",   "column": "player_id",  "check": "not_null",  "points": 30},
            {"name": "bet_positive", "column": "bet_amount", "check": "positive",  "points": 30},
            {"name": "game_valid",   "column": "game_type",  "check": "in_set",    "points": 20,
             "params": {"values": ["slots", "blackjack", "poker"]}},
            {"name": "age_ok",       "column": "player_age", "check": "range",     "points": 20,
             "params": {"min": 21, "max": 120}},
        ]
        df = compute_dq_score(df, rules)
    """
    if not rules:
        raise ValueError("At least one DQ rule is required.")

    max_points = sum(r["points"] for r in rules)
    if max_points <= 0:
        raise ValueError("Total possible points must be > 0.")

    # Build per-rule columns and sum them
    rule_exprs = [_build_dq_condition(rule, df) for rule in rules]

    # Accumulate raw score
    raw_score = rule_exprs[0]
    for expr in rule_exprs[1:]:
        raw_score = raw_score + expr

    # Normalise to 0-100
    normalised = (raw_score * 100 / max_points).cast("int")

    df = df.withColumn(score_column, normalised)
    df = df.withColumn(passed_column, col(score_column) >= pass_threshold)

    return df


# COMMAND ----------

# =============================================================================
# Unified Layer Metadata
# =============================================================================


def add_layer_metadata(
    df: DataFrame,
    layer: str,
    batch_id: str,
    source_system: str = "fabric-poc",
    pipeline_run_id: str | None = None,
    source_path: str = "",
    source_table: str = "",
    transformations_applied: str = "",
    kpi_version: str = "1.0",
    aggregation_grain: str = "",
) -> DataFrame:
    """Add standard metadata columns for any medallion layer.

    This is a *unified* alternative to calling ``add_bronze_lineage``,
    ``add_silver_lineage``, or ``add_gold_lineage`` individually.  It adds a
    consistent set of ``_meta_*`` columns regardless of layer, making
    cross-layer queries straightforward.

    The original per-layer functions are preserved for backward compatibility.

    Args:
        df: Input DataFrame.
        layer: One of ``"bronze"``, ``"silver"``, or ``"gold"``.
        batch_id: Batch identifier.
        source_system: Originating system name.
        pipeline_run_id: Optional tracking ID (auto-generated when ``None``).
        source_path: (Bronze) landing-zone path.
        source_table: (Silver/Gold) upstream table name.
        transformations_applied: (Silver) free-text description.
        kpi_version: (Gold) KPI logic version tag.
        aggregation_grain: (Gold) aggregation level description.

    Returns:
        DataFrame with ``_meta_*`` columns appended.
    """
    run_id = pipeline_run_id or generate_pipeline_run_id()
    layer_lower = layer.strip().lower()

    df = (
        df.withColumn("_meta_layer", lit(layer_lower))
        .withColumn("_meta_source_system", lit(source_system))
        .withColumn("_meta_pipeline_run_id", lit(run_id))
        .withColumn("_meta_batch_id", lit(batch_id))
        .withColumn("_meta_processed_at", current_timestamp())
    )

    if layer_lower == "bronze":
        df = df.withColumn("_meta_source_path", lit(source_path))
    elif layer_lower == "silver":
        df = (
            df.withColumn("_meta_source_table", lit(source_table))
            .withColumn("_meta_transformations", lit(transformations_applied))
        )
    elif layer_lower == "gold":
        df = (
            df.withColumn("_meta_source_table", lit(source_table))
            .withColumn("_meta_kpi_version", lit(kpi_version))
            .withColumn("_meta_aggregation_grain", lit(aggregation_grain))
        )

    return df


# COMMAND ----------

# =============================================================================
# Safe Delta Write
# =============================================================================


def safe_write_delta(
    df: DataFrame,
    table_name: str,
    mode: str = "overwrite",
    partition_by: list[str] | None = None,
    optimize_columns: list[str] | None = None,
    batch_id: str = "",
) -> dict:
    """Write a DataFrame to a Delta table with comprehensive error handling.

    Wraps the write in ``try / except``, enables schema evolution via
    ``mergeSchema``, records wall-clock duration, and optionally runs
    ``OPTIMIZE`` with ``ZORDER BY`` after a successful write.

    Args:
        df: DataFrame to persist.
        table_name: Fully-qualified Delta table name
                    (e.g. ``"lh_silver.silver_slot_cleansed"``).
        mode: Spark write mode — ``"overwrite"`` (default) or ``"append"``.
        partition_by: Optional list of columns to partition by.
        optimize_columns: Optional list of columns for ``ZORDER BY`` inside
                          an ``OPTIMIZE`` statement executed after the write.
        batch_id: Batch identifier recorded in the return dict for
                  downstream logging.

    Returns:
        A dict with keys:

        * ``status``           — ``"success"`` or ``"error"``
        * ``table_name``       — echo of the target table
        * ``row_count``        — number of rows written (0 on error)
        * ``duration_seconds`` — wall-clock seconds for the entire operation
        * ``batch_id``         — echo of the batch id
        * ``error``            — error message string (empty on success)

    Example::

        result = safe_write_delta(
            df, "lh_silver.silver_slot_cleansed",
            partition_by=["gaming_date"],
            optimize_columns=["player_id"],
            batch_id=batch_id,
        )
        print(result)
        # {'status': 'success', 'table_name': 'lh_silver.silver_slot_cleansed',
        #  'row_count': 128450, 'duration_seconds': 12.3, 'batch_id': '...', 'error': ''}
    """
    start = time.time()
    result: dict = {
        "status": "error",
        "table_name": table_name,
        "row_count": 0,
        "duration_seconds": 0.0,
        "batch_id": batch_id,
        "error": "",
    }

    try:
        # Cache count before write so we don't re-evaluate the plan after
        row_count = df.count()

        writer = (
            df.write
            .format("delta")
            .mode(mode)
            .option("mergeSchema", "true")
        )

        if partition_by:
            writer = writer.partitionBy(*partition_by)

        writer.saveAsTable(table_name)

        # Post-write optimisation (best-effort)
        if optimize_columns:
            try:
                spark = df.sparkSession
                zorder_cols = ", ".join(optimize_columns)
                spark.sql(f"OPTIMIZE {table_name} ZORDER BY ({zorder_cols})")
            except Exception:
                # OPTIMIZE is advisory — do not fail the overall write
                pass
        elif optimize_columns is None:
            # Still run OPTIMIZE without ZORDER for compaction
            try:
                spark = df.sparkSession
                spark.sql(f"OPTIMIZE {table_name}")
            except Exception:
                pass

        result["status"] = "success"
        result["row_count"] = row_count

    except Exception as exc:
        result["error"] = str(exc)

    result["duration_seconds"] = round(time.time() - start, 2)
    return result


# COMMAND ----------

# =============================================================================
# Post-Write Validation
# =============================================================================


def validate_write(
    spark: SparkSession,
    table_name: str,
    expected_min_rows: int = 1,
    dq_score_column: str = "_dq_score",
) -> dict:
    """Run post-write validation checks on a Delta table.

    Queries the table and returns a metrics dictionary covering row counts,
    data-quality score statistics, and partition information.

    Args:
        spark: Active SparkSession.
        table_name: Fully-qualified Delta table name.
        expected_min_rows: Minimum acceptable row count.  If the actual count
                          is below this value the ``row_count_ok`` flag will
                          be ``False``.
        dq_score_column: Name of the integer DQ score column produced by
                         :func:`compute_dq_score`.  Set to ``""`` or
                         ``None`` to skip DQ metrics.

    Returns:
        A dict with keys:

        * ``table_name``       — echo of the table
        * ``row_count``        — total rows
        * ``row_count_ok``     — ``True`` when >= ``expected_min_rows``
        * ``avg_dq_score``     — mean DQ score (``None`` if column absent)
        * ``perfect_pct``      — % of rows with a score of 100
        * ``failed_pct``       — % of rows below default pass threshold (75)
        * ``partition_cols``    — list of partition column names (if any)
        * ``partition_count``   — number of distinct partitions

    Example::

        metrics = validate_write(spark, "lh_silver.silver_slot_cleansed")
        assert metrics["row_count_ok"]
    """
    result: dict = {
        "table_name": table_name,
        "row_count": 0,
        "row_count_ok": False,
        "avg_dq_score": None,
        "perfect_pct": None,
        "failed_pct": None,
        "partition_cols": [],
        "partition_count": 0,
    }

    try:
        tbl = spark.table(table_name)
        total = tbl.count()
        result["row_count"] = total
        result["row_count_ok"] = total >= expected_min_rows

        # DQ metrics (only when column exists)
        if dq_score_column and dq_score_column in tbl.columns and total > 0:
            stats = tbl.agg(
                avg(col(dq_score_column)).alias("avg_score"),
                (spark_sum(when(col(dq_score_column) == 100, 1).otherwise(0)) * 100 / count("*")).alias("perfect_pct"),
                (spark_sum(when(col(dq_score_column) < 75, 1).otherwise(0)) * 100 / count("*")).alias("failed_pct"),
            ).collect()[0]

            result["avg_dq_score"] = round(float(stats["avg_score"]), 2) if stats["avg_score"] is not None else None
            result["perfect_pct"] = round(float(stats["perfect_pct"]), 2) if stats["perfect_pct"] is not None else None
            result["failed_pct"] = round(float(stats["failed_pct"]), 2) if stats["failed_pct"] is not None else None

        # Partition info (best-effort via DESCRIBE DETAIL)
        try:
            detail = spark.sql(f"DESCRIBE DETAIL {table_name}").collect()
            if detail:
                part_cols = detail[0]["partitionColumns"]
                if part_cols:
                    result["partition_cols"] = list(part_cols)
                    result["partition_count"] = tbl.select(part_cols).distinct().count()
        except Exception:
            pass

    except Exception:
        # Table may not exist yet — return zeroed metrics
        pass

    return result


# COMMAND ----------

# =============================================================================
# Execution Logging
# =============================================================================

_EXECUTION_LOG_TABLE = "lh_gold.pipeline_execution_log"

_EXECUTION_LOG_SCHEMA = StructType([
    StructField("log_id", StringType(), False),
    StructField("table_name", StringType(), False),
    StructField("notebook_name", StringType(), False),
    StructField("batch_id", StringType(), False),
    StructField("layer", StringType(), False),
    StructField("status", StringType(), False),
    StructField("row_count_in", LongType(), True),
    StructField("row_count_out", LongType(), True),
    StructField("dq_avg_score", DoubleType(), True),
    StructField("dq_perfect_pct", DoubleType(), True),
    StructField("dq_failed_pct", DoubleType(), True),
    StructField("duration_seconds", DoubleType(), True),
    StructField("error_message", StringType(), True),
    StructField("logged_at", TimestampType(), False),
])


def _ensure_execution_log_table(spark: SparkSession) -> None:
    """Create the pipeline execution log Delta table if it does not exist."""
    try:
        spark.catalog.tableExists(_EXECUTION_LOG_TABLE)
        if spark.catalog.tableExists(_EXECUTION_LOG_TABLE):
            return
    except Exception:
        pass

    # Create an empty DataFrame with the schema and persist it
    empty = spark.createDataFrame([], schema=_EXECUTION_LOG_SCHEMA)
    empty.write.format("delta").mode("overwrite").saveAsTable(_EXECUTION_LOG_TABLE)


def log_execution(
    spark: SparkSession,
    table_name: str,
    notebook_name: str,
    batch_id: str,
    layer: str,
    status: str,
    row_count_in: int = 0,
    row_count_out: int = 0,
    dq_metrics: dict | None = None,
    duration_seconds: float = 0.0,
    error_message: str | None = None,
) -> None:
    """Append an execution record to the central pipeline log table.

    The target table (``lh_gold.pipeline_execution_log``) is created
    automatically on first call.  Every row represents one notebook run and
    captures row counts, DQ scores, timing, and error details.

    Args:
        spark: Active SparkSession.
        table_name: The Delta table that was written.
        notebook_name: Name of the calling notebook (e.g. ``"01_silver_slot_cleansed"``).
        batch_id: Batch identifier for the run.
        layer: Medallion layer — ``"bronze"``, ``"silver"``, or ``"gold"``.
        status: Outcome — typically ``"success"`` or ``"error"``.
        row_count_in: Number of rows read (input).
        row_count_out: Number of rows written (output).
        dq_metrics: Optional dict returned by :func:`validate_write`.  If
                    provided, ``avg_dq_score``, ``perfect_pct``, and
                    ``failed_pct`` are extracted automatically.
        duration_seconds: Wall-clock seconds for the pipeline step.
        error_message: Error string when ``status`` is ``"error"``.

    Example::

        log_execution(
            spark,
            table_name="lh_silver.silver_slot_cleansed",
            notebook_name="01_silver_slot_cleansed",
            batch_id=batch_id,
            layer="silver",
            status="success",
            row_count_in=raw_count,
            row_count_out=result["row_count"],
            dq_metrics=metrics,
            duration_seconds=result["duration_seconds"],
        )
    """
    _ensure_execution_log_table(spark)

    dq = dq_metrics or {}

    log_row = {
        "log_id": f"log-{uuid.uuid4().hex[:12]}",
        "table_name": table_name,
        "notebook_name": notebook_name,
        "batch_id": batch_id,
        "layer": layer.strip().lower(),
        "status": status,
        "row_count_in": int(row_count_in),
        "row_count_out": int(row_count_out),
        "dq_avg_score": float(dq.get("avg_dq_score", 0)) if dq.get("avg_dq_score") is not None else None,
        "dq_perfect_pct": float(dq.get("perfect_pct", 0)) if dq.get("perfect_pct") is not None else None,
        "dq_failed_pct": float(dq.get("failed_pct", 0)) if dq.get("failed_pct") is not None else None,
        "duration_seconds": float(duration_seconds),
        "error_message": error_message,
        "logged_at": datetime.now(),
    }

    log_df = spark.createDataFrame([log_row], schema=_EXECUTION_LOG_SCHEMA)
    log_df.write.format("delta").mode("append").saveAsTable(_EXECUTION_LOG_TABLE)
