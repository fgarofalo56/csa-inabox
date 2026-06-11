# Fabric notebook source
# MAGIC %md
# MAGIC # 🧭 Hitchhiker's Guide — 05: Automation & Utilities
# MAGIC
# MAGIC The `notebookutils` namespace is the Fabric-native equivalent of
# MAGIC Databricks' `dbutils`. Everything here works in Spark and Python
# MAGIC notebooks (with a few callouts where they differ).
# MAGIC
# MAGIC | # | Topic |
# MAGIC |---|---|
# MAGIC | A | Namespace conventions (🚩 LEGACY → ✅ 2026-CANONICAL) |
# MAGIC | B | File system one-liners |
# MAGIC | C | Mount / unmount helpers |
# MAGIC | D | Credentials & tokens |
# MAGIC | E | Notebook orchestration (single run) |
# MAGIC | F | Parallel DAG runs |
# MAGIC | G | Parameter cells |
# MAGIC | H | Public Run-Notebook API + exit value |
# MAGIC | I | Runtime context inspection |
# MAGIC | J | Logging from notebooks |

# COMMAND ----------

# MAGIC %md
# MAGIC ## A — Namespace conventions
# MAGIC
# MAGIC 🚩 `mssparkutils.*` — legacy, still works
# MAGIC ✅ `mssparkutils.*` — 2026 canonical
# MAGIC ❌ `dbutils.*` — does NOT exist in Fabric
# MAGIC
# MAGIC | Databricks | Fabric equivalent |
# MAGIC |---|---|
# MAGIC | `dbutils.fs.ls` | `mssparkutils.fs.ls` |
# MAGIC | `dbutils.notebook.run` | `mssparkutils.notebook.run` |
# MAGIC | `dbutils.secrets.get` | `mssparkutils.credentials.getSecret` |
# MAGIC | `dbutils.widgets.get` | Parameter cell (UI-marked "Parameters") |
# MAGIC
# MAGIC 🔗 [notebook-utilities](https://learn.microsoft.com/en-us/fabric/data-engineering/notebook-utilities)

# COMMAND ----------

# MAGIC %md
# MAGIC ## B — File system one-liners

# COMMAND ----------

mssparkutils.fs.mkdirs("Files/raw/2026/05")
mssparkutils.fs.ls("Files/raw")
mssparkutils.fs.cp("Files/in.csv", "Files/archive/in.csv", recurse=False)
mssparkutils.fs.mv("Files/src.csv", "Files/done/src.csv", create_path=True, overwrite=True)
mssparkutils.fs.put("Files/marker.txt", "ok", overwrite=True)
mssparkutils.fs.head("Files/marker.txt", maxBytes=100)
mssparkutils.fs.fastcp(src="abfss://...", dst="abfss://...", recurse=True)  # azcopy
# ⚠️ create_path default differs Spark vs Python notebook — always pass it.

# COMMAND ----------

# MAGIC %md
# MAGIC ## C — Mounts

# COMMAND ----------

existing = mssparkutils.fs.mounts()
if not any(m.mountPoint == "/data" for m in existing):
    mssparkutils.fs.mount("abfss://c@acct.dfs.core.windows.net", "/data")

local = mssparkutils.fs.getMountPath("/data")
print(local)  # use as if it were a local path

mssparkutils.fs.unmount("/data")

# COMMAND ----------

# MAGIC %md
# MAGIC ## D — Credentials & tokens

# COMMAND ----------

secret = mssparkutils.credentials.getSecret("https://kv.vault.azure.net/", "name")
mssparkutils.credentials.putSecret("https://kv.vault.azure.net/", "name", "value")

storage_token = mssparkutils.credentials.getToken("storage")
pbi_token     = mssparkutils.credentials.getToken("pbi")
kusto_token   = mssparkutils.credentials.getToken("kusto")
kv_token      = mssparkutils.credentials.getToken("keyvault")
fabric_token  = mssparkutils.credentials.getToken("https://management.azure.com")

# COMMAND ----------

# MAGIC %md
# MAGIC ## E — Notebook orchestration (single run)

# COMMAND ----------

result = mssparkutils.notebook.run("ChildNotebook", 90, {"input": 20})
print("child returned:", result)

# Cross-workspace
result = mssparkutils.notebook.run(
    "ChildNotebook", 90, {"input": 20},
    "fe0a6e2a-a909-4aa3-a698-0a651de790aa",
)

# COMMAND ----------

# MAGIC %md
# MAGIC ## F — Parallel DAG runs
# MAGIC
# MAGIC `runMultiple` accepts a DAG with `dependencies`, `concurrency`, and
# MAGIC per-activity args.

# COMMAND ----------

spec = {
  "activities": [
    {"name": "A", "path": "Notebook_A", "args": {"x": 1}},
    {"name": "B", "path": "Notebook_B", "args": {"x": 2}, "dependencies": ["A"]},
    {"name": "C", "path": "Notebook_C", "args": {"x": 3}, "dependencies": ["A"]},
    {"name": "D", "path": "Notebook_D", "args": {"x": 4}, "dependencies": ["B", "C"]},
  ],
  "timeoutInSeconds": 3600, "concurrency": 5,
}
results = mssparkutils.notebook.runMultiple(spec)
print(results)

# COMMAND ----------

# MAGIC %md
# MAGIC ## G — Parameter cells
# MAGIC
# MAGIC In the Fabric notebook UI, mark a cell as **Parameters** (right-click
# MAGIC the cell header). Any variables defined become overridable at
# MAGIC `mssparkutils.notebook.run(..., args)` time. ⚠️ Only int / float /
# MAGIC bool / string supported.

# COMMAND ----------

# MAGIC %md
# MAGIC ## H — Public Run-Notebook API
# MAGIC
# MAGIC `POST /v1/workspaces/{ws}/items/{notebookId}/jobs/instances?jobType=RunNotebook`
# MAGIC → poll Get Item Job Instance → read `exitValue`.
# MAGIC
# MAGIC 🔗 [notebook-public-api](https://learn.microsoft.com/en-us/fabric/data-engineering/notebook-public-api)

# COMMAND ----------

# MAGIC %md
# MAGIC ## I — Runtime context

# COMMAND ----------

ctx = mssparkutils.runtime.context
print(ctx.currentNotebookName, ctx.currentNotebookId)
print(ctx.currentWorkspaceName, ctx.currentWorkspaceId)

# COMMAND ----------

# MAGIC %md
# MAGIC ## J — Logging from notebooks
# MAGIC
# MAGIC Use plain `print()` and / or the `logging` module. Output is captured
# MAGIC by the notebook job instance; Workspace Monitoring picks up the
# MAGIC structured logs. Avoid emitting secrets.

# COMMAND ----------

import logging
log = logging.getLogger(__name__)
log.setLevel(logging.INFO)
log.info("Tutorial 57 — Hitchhiker's Guide cell ran successfully.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Exit value
# MAGIC
# MAGIC Use `mssparkutils.notebook.exit("...")` to return a value to the
# MAGIC orchestrator. 🚩 **Do NOT call inside try/except** — it raises a
# MAGIC special signal that the harness intercepts; catching it breaks
# MAGIC pipeline branching on exit values.

# COMMAND ----------

mssparkutils.notebook.exit("ok")
