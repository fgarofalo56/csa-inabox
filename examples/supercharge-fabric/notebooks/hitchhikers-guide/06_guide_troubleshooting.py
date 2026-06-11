# Fabric notebook source
# MAGIC %md
# MAGIC # 🧭 Hitchhiker's Guide — 06: Troubleshooting
# MAGIC
# MAGIC > Symptom → likely cause → fix. Every fix points at a canonical MS Learn
# MAGIC > doc so you can read further.

# COMMAND ----------

# MAGIC %md
# MAGIC | Symptom | Likely cause | Fix / reference |
# MAGIC |---|---|---|
# MAGIC | `mssparkutils` shows deprecation warning | 2026 namespace rename | Switch to `notebookutils` — [docs](https://learn.microsoft.com/en-us/fabric/data-engineering/notebook-utilities) |
# MAGIC | `mssparkutils.notebook.exit()` silently ignored | Called inside try/except, or pipeline misreads exit value | Move `exit()` out of exception handlers; check pipeline configuration |
# MAGIC | Mirrored Databricks catalog item is empty | `EXTERNAL USE SCHEMA` privilege missing OR runtime <3.4 / Delta <2.4 | [azure-databricks-limitations](https://learn.microsoft.com/en-us/fabric/mirroring/azure-databricks-limitations) |
# MAGIC | SQL endpoint queries succeed but **OneLake RLS is not applied** | Endpoint is in **Delegated identity mode** — SQL grants govern, not OneLake | Switch to **User identity mode** — [docs](https://learn.microsoft.com/en-us/fabric/onelake/security/sql-analytics-endpoint-onelake-security) |
# MAGIC | Direct Lake report **falls back to DirectQuery** | Warehouse RLS/CLS on the underlying table | Lift the rules to OneLake security ([RLS](https://learn.microsoft.com/en-us/fabric/data-warehouse/row-level-security)) |
# MAGIC | OAP blocks a legitimate outbound call | Need MPE (DE/OneLake) OR Data Connection Rule (DF/mirror) — **not interchangeable per workload** | [OAP overview](https://learn.microsoft.com/en-us/fabric/security/workspace-outbound-access-protection-overview) |
# MAGIC | `mssparkutils.fs.cp` is slow against S3/GCS shortcut | abfss path hits the control plane every hop | Mount the shortcut path instead |
# MAGIC | SPN can't read Fabric admin API | Tenant setting "Service principals can access read-only admin APIs" not enabled for SPN's security group | [enable-service-principal-admin-apis](https://learn.microsoft.com/en-us/fabric/admin/enable-service-principal-admin-apis) |
# MAGIC | Refresh fails RLS/OLS evaluation under SPN | SPNs **cannot** be RLS members | Use **Fixed Identity** on Direct Lake model, or a real user account |
# MAGIC | Open mirroring stops ingesting | File naming not monotonic / missing `_partnerEvents.json` / missing `__rowMarker__` column | [open-mirroring-landing-zone-format](https://learn.microsoft.com/en-us/fabric/mirroring/open-mirroring-landing-zone-format) |
# MAGIC | Mirrored Cosmos query expensive | Hitting Cosmos directly burns RU | Query the OneLake Delta projection — [docs](https://learn.microsoft.com/en-us/fabric/mirroring/azure-cosmos-db) |
# MAGIC | Iceberg shortcut won't convert to virtual Delta | `bucket[N]` / `truncate[W]` / `void` partition transforms unsupported; or Snowflake drop/recreate produced stale metadata | [onelake-iceberg-snowflake](https://learn.microsoft.com/en-us/fabric/onelake/onelake-iceberg-snowflake) |
# MAGIC | pyodbc to Fabric SQL DB hangs | TCP 1433 outbound blocked, or ODBC <18 | Open 1433; upgrade to ODBC 18+ — [how-to-connect](https://learn.microsoft.com/en-us/fabric/data-warehouse/how-to-connect) |
# MAGIC | Spark notebook reads relative path; Python notebook breaks | Default lakehouse base path differs (Spark: ABFSS; Python: `/home/trusted-service-user/work`) | Use absolute abfss paths across notebook types |
# MAGIC | `sempy` can't list datasets | sempy needs Spark 3.4+ runtime | Upgrade workspace default Spark runtime ([sempy](https://learn.microsoft.com/en-us/python/api/semantic-link-sempy/sempy.fabric)) |
# MAGIC | UC column masks not enforced after Databricks mirror | UC RLS/CLS **do not** carry through to Fabric | Apply OneLake CLS (Preview) on the mirrored item, or exclude PII columns at mirror config time |
# MAGIC | Workspace assignment fails cross-region | Cross-region migration unsupported for non-PowerBI items | Recreate items in the new region |
# MAGIC | "Cannot rename schema/table in inclusion/exclusion list" | Documented limitation | Drop the mirror item, recreate after rename ([limitations](https://learn.microsoft.com/en-us/fabric/mirroring/azure-databricks-limitations)) |

# COMMAND ----------

# MAGIC %md
# MAGIC ## Self-diagnostic helpers
# MAGIC
# MAGIC Drop the cells below into the start of any notebook that's misbehaving.

# COMMAND ----------

# 1. Confirm you're actually in Fabric (not a stray Databricks notebook)
try:
    mssparkutils.runtime.context
    print("OK — running in Fabric")
except NameError:
    print("WARNING — notebookutils not available; likely running outside Fabric")

# COMMAND ----------

# 2. Confirm Spark runtime
print("Spark:", spark.version)

# COMMAND ----------

# 3. Confirm the default lakehouse is what you think
try:
    print(spark.sql("SHOW SCHEMAS").show(truncate=False))
except Exception as e:
    print("No default lakehouse attached:", e)

# COMMAND ----------

# 4. Confirm your identity carries the scopes you think it does
import jwt  # PyJWT — pip install pyjwt if not present
token = mssparkutils.credentials.getToken("https://management.azure.com")
claims = jwt.decode(token, options={"verify_signature": False})
print("aud :", claims.get("aud"))
print("appid:", claims.get("appid"))
print("upn :", claims.get("upn") or claims.get("unique_name"))
print("roles:", claims.get("roles"))
print("scp :", claims.get("scp"))
