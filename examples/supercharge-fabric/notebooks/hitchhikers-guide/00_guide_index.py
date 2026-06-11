# Fabric notebook source
# MAGIC %md
# MAGIC # 🧭 The Hitchhiker's Guide to Fabric — Index
# MAGIC
# MAGIC > "DON'T PANIC." — Cover of *The Hitchhiker's Guide to the Galaxy*
# MAGIC >
# MAGIC > A persona-organized cheat-sheet collection for everything you'd ever
# MAGIC > want to do inside a Fabric notebook. Every snippet is the **April 2026
# MAGIC > canonical Microsoft Learn syntax**, with the legacy patterns flagged
# MAGIC > where they still exist.
# MAGIC
# MAGIC ## How to use this guide
# MAGIC
# MAGIC 1. Don't read it cover to cover — **open the persona notebook for the
# MAGIC    problem you have right now**.
# MAGIC 2. Each cell is **independently runnable** against any modern Fabric
# MAGIC    workspace (F-SKU or trial, default lakehouse attached).
# MAGIC 3. Replace bracketed placeholders (`<workspace-id>`, `<your-vault>`,
# MAGIC    `<connection-id>`) with your environment's values.
# MAGIC 4. The snippets favor **`mssparkutils.*`** — the legacy
# MAGIC    `mssparkutils.*` namespace still works but Microsoft will retire it.
# MAGIC
# MAGIC ## The seven notebooks
# MAGIC
# MAGIC | # | Notebook | Audience | Topics |
# MAGIC |---|---|---|---|
# MAGIC | 00 | `00_guide_index.py` (this file) | Everyone | TOC + conventions |
# MAGIC | 01 | `01_guide_connectivity.py` | Data engineers, integration leads | ADLS Gen2, S3, GCS, on-prem SQL, Snowflake, Synapse, Databricks, Warehouse, SQL DB, Lakehouse SQL endpoint, Eventhouse, GraphQL, Power BI semantic models, Fabric REST, Cosmos, PostgreSQL, MySQL |
# MAGIC | 02 | `02_guide_lakehouse_warehouse_ops.py` | Data engineers | Delta reads/writes, OneLake addressing, default lakehouse, lakehouse CRUD, Warehouse from Spark, schemas, partitions, MERGE, OPTIMIZE/Z-ORDER/VACUUM |
# MAGIC | 03 | `03_guide_security_identity.py` | Security engineers, admins | OneLake RLS/CLS, Warehouse RLS/CLS/DDM, semantic model RLS via DAX, workspace identity & SPN tokens, Key Vault secrets, MSAL |
# MAGIC | 04 | `04_guide_admin_governance.py` | Platform admins | Workspace/lakehouse/warehouse REST, role assignments, Git integration, deployment pipelines, tenant settings, semantic model refresh, capacity assignment, workspace monitoring KQL |
# MAGIC | 05 | `05_guide_automation_utilities.py` | Automation engineers | `notebookutils` fs/credentials/notebook/runtime, parallel DAG runs, parameter cells, public Run-Notebook API |
# MAGIC | 06 | `06_guide_troubleshooting.py` | Everyone (eventually) | Symptom→cause→fix matrix with links |
# MAGIC
# MAGIC ## Conventions
# MAGIC
# MAGIC - 🚩 LEGACY — works but deprecated.
# MAGIC - ✅ 2026-CANONICAL — current best practice.
# MAGIC - ⚠️ PREVIEW — feature still labelled Preview in April 2026.
# MAGIC - 💡 TIP — non-obvious insight.
# MAGIC - 🔗 source link in inline link form on every non-trivial pattern.
# MAGIC
# MAGIC ## Pre-flight: who am I, where am I?

# COMMAND ----------

ctx = mssparkutils.runtime.context
print("Workspace:", ctx.currentWorkspaceName, "/", ctx.currentWorkspaceId)
print("Notebook :", ctx.currentNotebookName,  "/", ctx.currentNotebookId)
print("Region   :", getattr(ctx, "currentRegion", "(unknown)"))

# COMMAND ----------

# MAGIC %md
# MAGIC ## Pre-flight: which Fabric runtime am I on?
# MAGIC
# MAGIC Runtimes carry major behavior changes — Runtime 2.0 introduced
# MAGIC notebookutils, schemas-enabled lakehouses by default, and some
# MAGIC breaking Spark Connect changes. Always confirm before relying on a
# MAGIC pattern. 🔗 [spark-runtime-migration](https://learn.microsoft.com/en-us/fabric/data-engineering/runtime).

# COMMAND ----------

print(spark.version)
print(spark.conf.get("spark.executor.memory"))
print(spark.conf.get("spark.databricks.delta.optimizeWrite.enabled", "(unset)"))
