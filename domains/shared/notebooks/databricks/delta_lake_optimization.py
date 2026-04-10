# Databricks notebook source
# MAGIC %md
# MAGIC # Delta Lake Optimization — CSA-in-a-Box
# MAGIC
# MAGIC Maintenance notebook for Delta Lake tables across medallion layers.
# MAGIC Run on a scheduled basis (daily for gold, weekly for silver/bronze).
# MAGIC
# MAGIC ## Operations
# MAGIC - **OPTIMIZE**: Compacts small files into larger ones for faster reads
# MAGIC - **VACUUM**: Removes old files no longer needed (respects retention period)
# MAGIC - **Z-ORDER**: Co-locates related data for faster predicate pushdown

# COMMAND ----------

# MAGIC %md
# MAGIC ## Configuration

# COMMAND ----------

from pyspark.sql import SparkSession
from datetime import datetime
import json

# Configuration
CATALOG = spark.conf.get("spark.databricks.unityCatalog.catalog", "csa_analytics")
BRONZE_SCHEMAS = ["bronze"]
SILVER_SCHEMAS = ["silver"]
GOLD_SCHEMAS = ["gold"]
VACUUM_RETENTION_HOURS = 168  # 7 days

# Optimization config per layer
LAYER_CONFIG = {
    "bronze": {
        "optimize": True,
        "vacuum": True,
        "zorder_columns": {},  # Bronze: no z-ordering (append-only)
    },
    "silver": {
        "optimize": True,
        "vacuum": True,
        "zorder_columns": {
            "slv_orders": ["order_date", "customer_id"],
            "slv_customers": ["customer_id"],
        },
    },
    "gold": {
        "optimize": True,
        "vacuum": True,
        "zorder_columns": {
            "gld_daily_order_metrics": ["order_date"],
            "gld_customer_lifetime_value": ["customer_segment", "value_tier"],
        },
    },
}

print(f"Catalog: {CATALOG}")
print(f"Vacuum retention: {VACUUM_RETENTION_HOURS} hours")
print(f"Run started: {datetime.utcnow().isoformat()}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Helper Functions

# COMMAND ----------

def _validate_identifier(name: str) -> str:
    """Validate a SQL identifier to prevent injection."""
    import re
    if not re.match(r'^[a-zA-Z0-9_]{1,256}$', name):
        raise ValueError(f"Invalid SQL identifier: {name!r}")
    return name


def get_delta_tables(catalog: str, schema: str) -> list[str]:
    """List all Delta tables in a schema."""
    cat = _validate_identifier(catalog)
    sch = _validate_identifier(schema)
    tables = spark.sql(f"SHOW TABLES IN `{cat}`.`{sch}`").collect()
    return [
        f"{catalog}.{schema}.{row.tableName}"
        for row in tables
        if not row.isTemporary
    ]


def optimize_table(table_name: str, zorder_cols: list[str] | None = None) -> dict[str, object]:
    """Run OPTIMIZE with optional Z-ORDER on a Delta table."""
    try:
        # Validate table name parts to prevent SQL injection
        for part in table_name.split("."):
            _validate_identifier(part)
        safe_name = ".".join(f"`{p}`" for p in table_name.split("."))
        if zorder_cols:
            for col in zorder_cols:
                _validate_identifier(col)
            cols = ", ".join(f"`{c}`" for c in zorder_cols)
            result = spark.sql(f"OPTIMIZE {safe_name} ZORDER BY ({cols})")
        else:
            result = spark.sql(f"OPTIMIZE {safe_name}")

        metrics = result.collect()[0]
        print(f"  OPTIMIZE {table_name}: "
              f"files added={metrics.numFilesAdded}, "
              f"files removed={metrics.numFilesRemoved}, "
              f"bytes added={metrics.numBytesAdded}")
        return {"status": "success", "metrics": metrics.asDict()}
    except Exception as e:
        print(f"  OPTIMIZE {table_name}: FAILED - {e}")
        return {"status": "error", "error": str(e)}


def vacuum_table(table_name: str, retention_hours: int) -> dict[str, str]:
    """Run VACUUM on a Delta table."""
    try:
        for part in table_name.split("."):
            _validate_identifier(part)
        safe_name = ".".join(f"`{p}`" for p in table_name.split("."))
        if not isinstance(retention_hours, int) or retention_hours < 0:
            raise ValueError(f"Invalid retention_hours: {retention_hours}")
        spark.sql(f"VACUUM {safe_name} RETAIN {retention_hours} HOURS")
        print(f"  VACUUM {table_name}: SUCCESS (retention={retention_hours}h)")
        return {"status": "success"}
    except Exception as e:
        print(f"  VACUUM {table_name}: FAILED - {e}")
        return {"status": "error", "error": str(e)}


def get_table_detail(table_name: str) -> dict[str, object]:
    """Get Delta table stats."""
    try:
        for part in table_name.split("."):
            _validate_identifier(part)
        safe_name = ".".join(f"`{p}`" for p in table_name.split("."))
        detail = spark.sql(f"DESCRIBE DETAIL {safe_name}").collect()[0]
        return {
            "name": table_name,
            "format": detail.format,
            "num_files": detail.numFiles,
            "size_bytes": detail.sizeInBytes,
            "partitions": detail.partitionColumns,
        }
    except Exception as e:
        return {"name": table_name, "error": str(e)}

# COMMAND ----------

# MAGIC %md
# MAGIC ## Execute Optimization

# COMMAND ----------

results = {"run_timestamp": datetime.utcnow().isoformat(), "tables": []}

for layer, config in LAYER_CONFIG.items():
    schemas = {"bronze": BRONZE_SCHEMAS, "silver": SILVER_SCHEMAS, "gold": GOLD_SCHEMAS}[layer]

    for schema in schemas:
        print(f"\n{'='*60}")
        print(f"Processing {layer} layer: {CATALOG}.{schema}")
        print(f"{'='*60}")

        tables = get_delta_tables(CATALOG, schema)
        print(f"Found {len(tables)} tables")

        for table in tables:
            table_short = table.split(".")[-1]
            table_result = {"table": table, "layer": layer}

            # Pre-optimization stats
            table_result["before"] = get_table_detail(table)

            # OPTIMIZE
            if config["optimize"]:
                zorder = config["zorder_columns"].get(table_short, None)
                table_result["optimize"] = optimize_table(table, zorder)

            # VACUUM
            if config["vacuum"]:
                table_result["vacuum"] = vacuum_table(table, VACUUM_RETENTION_HOURS)

            # Post-optimization stats
            table_result["after"] = get_table_detail(table)

            results["tables"].append(table_result)

# COMMAND ----------

# MAGIC %md
# MAGIC ## Summary

# COMMAND ----------

print(f"\n{'='*60}")
print("OPTIMIZATION SUMMARY")
print(f"{'='*60}")
print(f"Total tables processed: {len(results['tables'])}")

successes = sum(1 for t in results["tables"]
                if t.get("optimize", {}).get("status") == "success")
failures = sum(1 for t in results["tables"]
               if t.get("optimize", {}).get("status") == "error")

print(f"Successful: {successes}")
print(f"Failed: {failures}")

if failures > 0:
    print("\nFailed tables:")
    for t in results["tables"]:
        if t.get("optimize", {}).get("status") == "error":
            print(f"  - {t['table']}: {t['optimize']['error']}")

# Save results as JSON for monitoring
dbutils.notebook.exit(json.dumps(results, default=str))
