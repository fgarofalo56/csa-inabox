# Loom AI functions in Spark/pandas — loom-ai-functions
#
# Demo notebook for the `ai_functions` library (dist `loom-ai-functions`). Runs
# on a Loom Synapse Spark pool (or Databricks); also runs in pure pandas. Drop
# this into a Synapse/Databricks notebook or open it in VS Code — the `# %%`
# markers delimit cells.
#
# Backend: Azure OpenAI (no Microsoft Fabric / Power BI dependency). The Spark
# pool's managed identity calls AOAI under the "Cognitive Services OpenAI User"
# role granted by platform/fiab/bicep/modules/admin-plane/aoai-spark-rbac.bicep.
# Install onto a pool with scripts/csa-loom/ai-functions-pool-setup.sh.

# %% [markdown]
# # AI functions in Spark/pandas
# Enrich a text column with Azure OpenAI directly from a notebook cell:
# `ai.summarize`, `ai.classify`, `ai.sentiment`, `ai.extract`, `ai.translate`.

# %%
# --- Cell 1: install (only if the wheel is not already baked into the pool) ---
# The bootstrap script (scripts/csa-loom/ai-functions-pool-setup.sh) bakes the
# wheel into the pool, so this is usually unnecessary. To install ad hoc:
#
# %pip install abfss://synapse@<adls>.dfs.core.windows.net/synapse/workspaces/<ws>/sparkpools/<pool>/libraries/python/loom_ai_functions-0.1.0-py3-none-any.whl
# dbutils.library.restartPython()   # Databricks only

# %%
# --- Cell 2: honest reachability gate (run this first) -----------------------
# Raises AoaiBridgeConfigError / AoaiBridgeAuthError with an actionable message
# (naming the missing env var / role) if AOAI is not reachable — never a silent
# empty result.
import ai_functions as ai

ai.check_reachable()

# %%
# --- Cell 3: pandas path — classify real rows --------------------------------
import pandas as pd

df = pd.DataFrame(
    {
        "text": [
            "deploy failed at 3am, prod is down",
            "quarterly review went well, nothing urgent",
            "system alert: CPU at 98% on node-4",
        ]
    }
)
df["priority"] = ai.classify(df["text"], labels=["urgent", "normal", "low"])
df  # noqa: B018  — display the enriched DataFrame
# Expected: real labels from gpt-4o, e.g. urgent / low / urgent — not mock data.

# %%
# --- Cell 4: Spark DataFrame path — summarize on an executor ------------------
# ai.summarize(col) returns a vectorized pandas_udf Column; the AOAI calls run
# on each executor under the cluster's managed identity.
from pyspark.sql import SparkSession
from pyspark.sql.functions import col

spark = SparkSession.builder.getOrCreate()
sdf = spark.createDataFrame(
    [
        ("The quarterly earnings exceeded analyst expectations by 12% on strong cloud growth.",),
        ("System alert: disk I/O latency spike on node-4 at 02:47 UTC, auto-failover engaged.",),
    ],
    ["description"],
)
sdf = sdf.withColumn("summary", ai.summarize(col("description"), max_tokens=60))
sdf.show(truncate=False)

# %%
# --- Cell 5: sentiment, translate, extract -----------------------------------
reviews = pd.DataFrame({"review": ["Absolutely loved it!", "Terrible, would not recommend."]})
reviews["sentiment"] = ai.sentiment(reviews["review"])
reviews["spanish"] = ai.translate(reviews["review"], target_lang="Spanish")
reviews["fields"] = ai.extract(reviews["review"], fields=["tone", "recommend"])
reviews  # noqa: B018

# %%
# --- Cell 6: failure path is loud, not silent --------------------------------
# Clearing the endpoint makes check_reachable raise AoaiBridgeConfigError (not a
# Python KeyError, not a silent empty df) — the honest-gate contract.
import os

_orig = os.environ.get("LOOM_AOAI_ENDPOINT", "")
os.environ["LOOM_AOAI_ENDPOINT"] = ""
try:
    ai.check_reachable(raise_on_fail=True)
except ai.AoaiBridgeConfigError as exc:
    print(f"Honest gate fired as expected:\n{exc}")
finally:
    os.environ["LOOM_AOAI_ENDPOINT"] = _orig
