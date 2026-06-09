# loom-ai-functions

LLM enrichment for **Spark / pandas notebook cells**, backed by Azure OpenAI —
the notebook-surface companion to the Console SQL-editor "AI Functions" helper
(`apps/fiab-console/lib/azure/ai-functions-client.ts`). **No Microsoft Fabric,
Power BI, or OneLake dependency.**

```python
import ai_functions as ai

ai.check_reachable()                       # honest gate — run this first

# pandas Series -> Series (pandas notebook cell)
df["priority"] = ai.classify(df["text"], labels=["urgent", "normal", "low"])

# pyspark Column -> Column (Spark cell)
from pyspark.sql.functions import col
sdf = sdf.withColumn("summary", ai.summarize(col("description")))
```

## Functions

| Function | Input | Output | Options |
|----------|-------|--------|---------|
| `ai.summarize(data)` | str / Series / Column | 2-3 sentence summary | `max_tokens` |
| `ai.classify(data)` | " | one label | `labels=[...]`, `max_tokens` |
| `ai.sentiment(data)` | " | positive/negative/neutral | `max_tokens` |
| `ai.extract(data)` | " | JSON string | `fields=[...]`, `max_tokens` |
| `ai.translate(data)` | " | translated text | `target_lang="fr"`, `max_tokens` |

Each accepts a `str` (one call), a `pandas.Series` (thread-batched), or a
`pyspark.sql.Column` (vectorized `pandas_udf`, batched per executor).

## Configuration

Read from the Spark pool environment first, then the active Spark session conf:

| Setting | Env var | Spark conf | Default |
|---------|---------|------------|---------|
| Endpoint | `LOOM_AOAI_ENDPOINT` | `spark.loom.aoai.endpoint` | — (required) |
| Deployment | `LOOM_AOAI_DEPLOYMENT` | `spark.loom.aoai.deployment` | `gpt-4o` |
| Token audience | `LOOM_AOAI_AUDIENCE` | `spark.loom.aoai.audience` | `https://cognitiveservices.azure.com` |
| API key (optional) | `LOOM_AOAI_KEY` | — | unset → managed-identity auth |
| UAMI client id | `LOOM_UAMI_CLIENT_ID` / `AZURE_CLIENT_ID` | — | unset → system-assigned MSI |
| Batch concurrency | `LOOM_AI_FN_WORKERS` | — | `8` |

These are wired per-boundary by `platform/fiab/bicep/modules/admin-plane/main.bicep`
(the endpoint host and audience flip to `.openai.azure.us` /
`cognitiveservices.azure.us` on GCC-High / IL5). On a pool, the values are
delivered by `platform/fiab/bootstrap/ai-functions-pool-setup.sh`.

## Auth

* `LOOM_AOAI_KEY` set → `api-key` header auth (no token fetched).
* otherwise → AAD bearer token from the Spark pool's managed identity. A UAMI is
  preferred when its client id is set; else the system-assigned MSI is used. The
  pool's identity needs **Cognitive Services OpenAI User** on the AI Services
  account (`aoai-csa-loom-<region>`) — granted by
  `platform/fiab/bicep/modules/admin-plane/aoai-spark-rbac.bicep`.

## Honest gate

`ai.check_reachable()` performs one real AOAI round-trip and raises a typed,
actionable error (naming the missing env var / role / deployment) when the
service is unreachable — never a silent empty result. The five functions raise
the same typed errors (`AoaiBridgeConfigError`, `AoaiBridgeAuthError`,
`AoaiBridgeDeploymentError`, `AoaiBridgeRateLimitError`) on failure.

## Install (Spark pool)

The wheel is baked into the Loom Synapse Spark pool by the bootstrap script:

```bash
LOOM_SYNAPSE_WORKSPACE=... LOOM_ADLS_ACCOUNT=... LOOM_SPARK_POOL=loompool \
  LOOM_SYNAPSE_RG=... platform/fiab/bootstrap/ai-functions-pool-setup.sh
```

For local development: `pip install -e ".[spark]"` from this directory.

## Tests

```bash
python -m pytest apps/copilot/ai_functions/tests/ -v
```
