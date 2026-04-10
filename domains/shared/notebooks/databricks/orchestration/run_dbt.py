# Databricks notebook source
# MAGIC %md
# MAGIC # dbt Runner — CSA-in-a-Box
# MAGIC
# MAGIC Orchestration notebook for running dbt commands on Databricks.
# MAGIC Called by ADF pipeline `pl_run_dbt_models` or manually for ad-hoc runs.

# COMMAND ----------

# MAGIC %md
# MAGIC ## Parameters

# COMMAND ----------

dbutils.widgets.text("dbt_command", "run", "dbt Command (run/test/build/compile)")
dbutils.widgets.text("target", "prod", "dbt Target Profile")
dbutils.widgets.text("models", "+", "dbt Model Selection (+ for all)")
dbutils.widgets.text("full_refresh", "false", "Full Refresh (true/false)")

dbt_command = dbutils.widgets.get("dbt_command")
target = dbutils.widgets.get("target")
models = dbutils.widgets.get("models")
full_refresh = dbutils.widgets.get("full_refresh").lower() == "true"

# Validate inputs to prevent command injection
import re
VALID_DBT_COMMANDS = {"run", "test", "build", "compile", "seed", "snapshot"}
if dbt_command not in VALID_DBT_COMMANDS:
    raise ValueError(f"Invalid dbt command: {dbt_command!r}. Must be one of {VALID_DBT_COMMANDS}")

if models != "+" and not re.match(r'^[a-zA-Z0-9_.,+*/:@-]+$', models):
    raise ValueError(f"Invalid model selection pattern: {models!r}")

VALID_TARGETS = {"dev", "staging", "prod"}
if target not in VALID_TARGETS:
    raise ValueError(f"Invalid target: {target!r}. Must be one of {VALID_TARGETS}")

print(f"Command: dbt {dbt_command}")
print(f"Target: {target}")
print(f"Models: {models}")
print(f"Full refresh: {full_refresh}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Install dbt

# COMMAND ----------

# MAGIC %pip install dbt-databricks dbt-core

# COMMAND ----------

import subprocess
import sys
import os
import json
from datetime import datetime

# COMMAND ----------

# MAGIC %md
# MAGIC ## Run dbt

# COMMAND ----------

# Set working directory to dbt project
dbt_project_dir = "/Workspace/Repos/csa-inabox/domains/shared/dbt"

# Build command
cmd = ["dbt", dbt_command, "--target", target, "--profiles-dir", dbt_project_dir]

if models != "+":
    cmd.extend(["--select", models])

if full_refresh and dbt_command in ("run", "build"):
    cmd.append("--full-refresh")

print(f"Executing: {' '.join(cmd)}")
print(f"Working directory: {dbt_project_dir}")
print(f"Started: {datetime.utcnow().isoformat()}")
print("-" * 60)

# Execute dbt
result = subprocess.run(
    cmd,
    cwd=dbt_project_dir,
    capture_output=True,
    text=True,
    timeout=3600,  # 1 hour timeout
)

print(result.stdout)

if result.stderr:
    print("STDERR:")
    print(result.stderr)

print("-" * 60)
print(f"Finished: {datetime.utcnow().isoformat()}")
print(f"Exit code: {result.returncode}")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Parse Results

# COMMAND ----------

# Try to read dbt run results
run_results_path = os.path.join(dbt_project_dir, "target", "run_results.json")

if os.path.exists(run_results_path):
    with open(run_results_path) as f:
        run_results = json.load(f)

    total = len(run_results.get("results", []))
    passed = sum(1 for r in run_results.get("results", []) if r["status"] == "pass")
    failed = sum(1 for r in run_results.get("results", []) if r["status"] in ("fail", "error"))
    skipped = sum(1 for r in run_results.get("results", []) if r["status"] == "skipped")

    summary = {
        "dbt_command": dbt_command,
        "target": target,
        "total": total,
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "elapsed_time": run_results.get("elapsed_time"),
        "exit_code": result.returncode,
        "timestamp": datetime.utcnow().isoformat(),
    }

    print(f"\ndbt {dbt_command} Results:")
    print(f"  Total:   {total}")
    print(f"  Passed:  {passed}")
    print(f"  Failed:  {failed}")
    print(f"  Skipped: {skipped}")

    if failed > 0:
        print("\nFailed models/tests:")
        for r in run_results.get("results", []):
            if r["status"] in ("fail", "error"):
                print(f"  - {r['unique_id']}: {r.get('message', 'No message')}")

    dbutils.notebook.exit(json.dumps(summary))
else:
    print("No run_results.json found")
    dbutils.notebook.exit(json.dumps({
        "exit_code": result.returncode,
        "error": "No run_results.json found",
        "stdout": result.stdout[-2000:] if result.stdout else "",
    }))

# COMMAND ----------

# Fail the notebook if dbt failed
if result.returncode != 0:
    raise Exception(f"dbt {dbt_command} failed with exit code {result.returncode}")
