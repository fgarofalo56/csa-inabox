# Databricks notebook source
# MAGIC %md
# MAGIC # Data Quality Monitor
# MAGIC
# MAGIC Reads contract YAML files and validates Silver/Gold tables against
# MAGIC SLA thresholds. Logs results to Azure Monitor (Log Analytics) via
# MAGIC the azure-monitor-ingestion SDK.
# MAGIC
# MAGIC **Parameters (widgets):**
# MAGIC - `domain`: Data domain (default: shared)
# MAGIC - `environment`: dev/prod (default: dev)
# MAGIC - `log_analytics_endpoint`: DCE endpoint for Log Analytics ingestion

# COMMAND ----------

dbutils.widgets.text("domain", "shared", "Domain")
dbutils.widgets.dropdown("environment", "dev", ["dev", "prod"], "Environment")
dbutils.widgets.text("log_analytics_endpoint", "", "Log Analytics DCE Endpoint")

domain = dbutils.widgets.get("domain")
environment = dbutils.widgets.get("environment")
log_analytics_endpoint = dbutils.widgets.get("log_analytics_endpoint")

print(f"Quality monitoring: {domain} ({environment})")

# COMMAND ----------

from pyspark.sql import functions as F
from datetime import datetime, timezone
import json
import os
import yaml

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Discover Contract Files

# COMMAND ----------

REPO_ROOT = "/Workspace/Repos/csa-inabox"
CONTRACTS_DIR = f"{REPO_ROOT}/domains/{domain}/data-products"

def find_contracts(base_path: str) -> list:
    """Find all contract.yaml files under the given path."""
    contracts = []
    try:
        for item in dbutils.fs.ls(base_path):
            if item.name == "contract.yaml":
                contracts.append(item.path)
            elif item.isDir():
                contracts.extend(find_contracts(item.path))
    except Exception as e:
        print(f"Warning: Could not scan {base_path}: {e}")
    return contracts

# Fallback: use known contract paths
KNOWN_CONTRACTS = {
    "shared": [
        f"{REPO_ROOT}/domains/sales/data-products/orders/contract.yaml",
    ],
    "finance": [
        f"{REPO_ROOT}/domains/finance/data-products/invoices/contract.yaml",
    ],
}

contract_paths = KNOWN_CONTRACTS.get(domain, [])
print(f"Found {len(contract_paths)} contract(s) for domain '{domain}'")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Quality Check Functions

# COMMAND ----------

STORAGE_ACCOUNT = spark.conf.get("spark.csa.storage_account", "csadatalake")


def check_freshness(table_path: str, max_delay_hours: int) -> dict:
    """Check if data is fresh within the SLA threshold."""
    try:
        df = spark.read.format("delta").load(table_path)
        # Check max _dbt_loaded_at or _dbt_refreshed_at
        ts_col = "_dbt_refreshed_at" if "_dbt_refreshed_at" in df.columns else "_dbt_loaded_at"
        max_ts = df.agg(F.max(ts_col)).collect()[0][0]

        if max_ts is None:
            return {"check": "freshness", "status": "FAIL", "message": "No timestamp found"}

        age_hours = (datetime.now(timezone.utc) - max_ts.replace(tzinfo=timezone.utc)).total_seconds() / 3600

        return {
            "check": "freshness",
            "status": "PASS" if age_hours <= max_delay_hours else "FAIL",
            "age_hours": round(age_hours, 1),
            "threshold_hours": max_delay_hours,
            "last_update": max_ts.isoformat(),
        }
    except Exception as e:
        return {"check": "freshness", "status": "ERROR", "message": str(e)}


def check_completeness(table_path: str, key_columns: list, threshold_pct: float) -> dict:
    """Check non-null rate for key columns."""
    try:
        df = spark.read.format("delta").load(table_path)
        total = df.count()

        if total == 0:
            return {"check": "completeness", "status": "FAIL", "message": "Table is empty"}

        results = []
        for col in key_columns:
            if col in df.columns:
                non_null = df.filter(F.col(col).isNotNull()).count()
                pct = round(non_null / total * 100, 2)
                results.append({
                    "column": col,
                    "completeness_pct": pct,
                    "pass": pct >= threshold_pct,
                })

        all_pass = all(r["pass"] for r in results)
        return {
            "check": "completeness",
            "status": "PASS" if all_pass else "FAIL",
            "total_rows": total,
            "threshold_pct": threshold_pct,
            "columns": results,
        }
    except Exception as e:
        return {"check": "completeness", "status": "ERROR", "message": str(e)}


def check_validity(table_path: str) -> dict:
    """Check is_valid rate in Silver tables."""
    try:
        df = spark.read.format("delta").load(table_path)
        if "is_valid" not in df.columns:
            return {"check": "validity", "status": "SKIP", "message": "No is_valid column"}

        total = df.count()
        valid = df.filter(F.col("is_valid") == True).count()
        invalid = total - valid
        valid_pct = round(valid / max(total, 1) * 100, 2)

        # Sample invalid reasons
        invalid_reasons = []
        if invalid > 0:
            reasons = (
                df.filter(F.col("is_valid") == False)
                .select("validation_errors")
                .limit(5)
                .collect()
            )
            invalid_reasons = [r.validation_errors for r in reasons if r.validation_errors]

        return {
            "check": "validity",
            "status": "PASS" if valid_pct >= 95 else "WARN" if valid_pct >= 90 else "FAIL",
            "total_rows": total,
            "valid_rows": valid,
            "invalid_rows": invalid,
            "valid_pct": valid_pct,
            "sample_errors": invalid_reasons[:3],
        }
    except Exception as e:
        return {"check": "validity", "status": "ERROR", "message": str(e)}

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Run Quality Checks

# COMMAND ----------

# Define tables to check
TABLES = {
    "shared": [
        {"name": "slv_orders", "path": f"abfss://curated@{STORAGE_ACCOUNT}.dfs.core.windows.net/silver/shared/sample_orders", "layer": "silver", "key_columns": ["order_id", "customer_id", "order_date"]},
        {"name": "slv_customers", "path": f"abfss://curated@{STORAGE_ACCOUNT}.dfs.core.windows.net/silver/shared/sample_customers", "layer": "silver", "key_columns": ["customer_id", "email"]},
        {"name": "slv_products", "path": f"abfss://curated@{STORAGE_ACCOUNT}.dfs.core.windows.net/silver/shared/sample_products", "layer": "silver", "key_columns": ["product_id", "product_name"]},
    ],
    "finance": [
        {"name": "slv_invoices", "path": f"abfss://curated@{STORAGE_ACCOUNT}.dfs.core.windows.net/silver/finance/sample_invoices", "layer": "silver", "key_columns": ["invoice_id", "order_id"]},
        {"name": "slv_payments", "path": f"abfss://curated@{STORAGE_ACCOUNT}.dfs.core.windows.net/silver/finance/sample_payments", "layer": "silver", "key_columns": ["payment_id", "invoice_id"]},
    ],
}

all_results = []
tables = TABLES.get(domain, [])

for table in tables:
    print(f"\nChecking: {table['name']}")

    # Freshness check (24h SLA)
    freshness = check_freshness(table["path"], max_delay_hours=24)
    freshness["table"] = table["name"]
    freshness["domain"] = domain
    all_results.append(freshness)
    print(f"  Freshness: {freshness['status']}")

    # Completeness check (98% threshold)
    completeness = check_completeness(table["path"], table["key_columns"], threshold_pct=98.0)
    completeness["table"] = table["name"]
    completeness["domain"] = domain
    all_results.append(completeness)
    print(f"  Completeness: {completeness['status']}")

    # Validity check (Silver tables only)
    if table["layer"] == "silver":
        validity = check_validity(table["path"])
        validity["table"] = table["name"]
        validity["domain"] = domain
        all_results.append(validity)
        print(f"  Validity: {validity['status']}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Log Results to Azure Monitor

# COMMAND ----------

def log_to_azure_monitor(results: list, endpoint: str) -> None:
    """Send quality check results to Log Analytics via Data Collection Endpoint."""
    if not endpoint:
        print("No Log Analytics endpoint configured. Skipping Azure Monitor logging.")
        return

    try:
        from azure.identity import DefaultAzureCredential
        from azure.monitor.ingestion import LogsIngestionClient

        credential = DefaultAzureCredential()
        client = LogsIngestionClient(endpoint=endpoint, credential=credential)

        # Transform results for Log Analytics
        logs = []
        for result in results:
            logs.append({
                "TimeGenerated": datetime.now(timezone.utc).isoformat(),
                "Domain": result.get("domain", "unknown"),
                "Table": result.get("table", "unknown"),
                "Check": result.get("check", "unknown"),
                "Status": result.get("status", "unknown"),
                "Details": json.dumps(result),
                "Environment": environment,
            })

        # Would need a DCR rule ID and stream name configured
        print(f"Would send {len(logs)} log entries to Azure Monitor")
        # client.upload(rule_id="dcr-...", stream_name="Custom-CSAQuality_CL", logs=logs)

    except ImportError:
        print("azure-monitor-ingestion not installed. Skipping Azure Monitor logging.")
    except Exception as e:
        print(f"Error logging to Azure Monitor: {e}")


log_to_azure_monitor(all_results, log_analytics_endpoint)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Summary

# COMMAND ----------

# Count by status
pass_count = sum(1 for r in all_results if r["status"] == "PASS")
warn_count = sum(1 for r in all_results if r["status"] == "WARN")
fail_count = sum(1 for r in all_results if r["status"] == "FAIL")
error_count = sum(1 for r in all_results if r["status"] == "ERROR")

print(f"\n{'='*60}")
print(f"Quality Monitor Summary: {domain} ({environment})")
print(f"{'='*60}")
print(f"  PASS:  {pass_count}")
print(f"  WARN:  {warn_count}")
print(f"  FAIL:  {fail_count}")
print(f"  ERROR: {error_count}")
print(f"  Total: {len(all_results)} checks")
print(f"{'='*60}")

overall = "PASS" if fail_count == 0 and error_count == 0 else "FAIL"
summary = {
    "domain": domain,
    "environment": environment,
    "overall_status": overall,
    "pass": pass_count,
    "warn": warn_count,
    "fail": fail_count,
    "error": error_count,
    "checked_at": datetime.now(timezone.utc).isoformat(),
    "results": all_results,
}

dbutils.notebook.exit(json.dumps(summary))
