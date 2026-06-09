#!/usr/bin/env bash
# CSA Loom — bootstrap the notebook AI-functions library (loom-ai-functions)
# onto a Synapse Spark pool.
#
# WHAT THIS DOES (idempotently):
#   1. builds the `loom-ai-functions` wheel from apps/copilot/ai_functions/
#   2. uploads it to the workspace package path on the DLZ ADLS Gen2 account
#   3. adds it to the Spark pool's workspace packages so every new session can
#      `import ai_functions as ai`
#   4. sets the AOAI env on the pool (LOOM_AOAI_ENDPOINT / _DEPLOYMENT /
#      _AUDIENCE) via a Spark configuration file, so the library resolves the
#      account without per-notebook setup
#
# The Spark pool's managed identity must already hold "Cognitive Services
# OpenAI User" on the AOAI account — granted by
# platform/fiab/bicep/modules/admin-plane/aoai-spark-rbac.bicep (wired from the
# orchestrator) at deploy time. If you used a BYO/existing AOAI account, grant
# that role manually before running notebooks.
#
# REQUIRES: az CLI logged in (rights to upload blobs on the DLZ SA + update the
#   Spark pool), Python with `pip` + `build`/`wheel`, and jq.
#
# USAGE (env overridable; sovereign suffix auto-derived from AZURE_CLOUD):
#   LOOM_SYNAPSE_WORKSPACE=syn-loom-… LOOM_SYNAPSE_RG=… LOOM_SPARK_POOL=loompool \
#     LOOM_ADLS_ACCOUNT=saloom… LOOM_AOAI_ENDPOINT=https://aoai-…openai.azure.com \
#     ./scripts/csa-loom/ai-functions-pool-setup.sh
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PKG_DIR="$REPO_ROOT/apps/copilot/ai_functions"
WHEEL_DIR="$PKG_DIR/dist"

LOOM_SYNAPSE_WORKSPACE="${LOOM_SYNAPSE_WORKSPACE:-}"
LOOM_SYNAPSE_RG="${LOOM_SYNAPSE_RG:-}"
LOOM_SPARK_POOL="${LOOM_SPARK_POOL:-loompool}"
LOOM_ADLS_ACCOUNT="${LOOM_ADLS_ACCOUNT:-}"
LOOM_AOAI_ENDPOINT="${LOOM_AOAI_ENDPOINT:-}"
LOOM_AOAI_DEPLOYMENT="${LOOM_AOAI_DEPLOYMENT:-gpt-4o}"
LOOM_AOAI_AUDIENCE="${LOOM_AOAI_AUDIENCE:-}"
SUBSCRIPTION="${SUBSCRIPTION:-${LOOM_SUBSCRIPTION_ID:-}}"

[ -n "$SUBSCRIPTION" ] && az account set --subscription "$SUBSCRIPTION" >/dev/null 2>&1 || true

# Derive sovereign suffixes from the active cloud (Commercial vs Gov).
CLOUD="$(az cloud show --query name -o tsv 2>/dev/null || echo AzureCloud)"
if [ "$CLOUD" = "AzureUSGovernment" ]; then
  DFS_SUFFIX="dfs.core.usgovcloudapi.net"
  [ -z "$LOOM_AOAI_AUDIENCE" ] && LOOM_AOAI_AUDIENCE="https://cognitiveservices.azure.us"
else
  DFS_SUFFIX="dfs.core.windows.net"
  [ -z "$LOOM_AOAI_AUDIENCE" ] && LOOM_AOAI_AUDIENCE="https://cognitiveservices.azure.com"
fi

if [ -z "$LOOM_SYNAPSE_WORKSPACE" ] || [ -z "$LOOM_ADLS_ACCOUNT" ]; then
  echo "ERROR: set LOOM_SYNAPSE_WORKSPACE and LOOM_ADLS_ACCOUNT." >&2
  exit 1
fi
if [ -z "$LOOM_AOAI_ENDPOINT" ]; then
  echo "WARNING: LOOM_AOAI_ENDPOINT is not set — the wheel will install, but" >&2
  echo "         ai.check_reachable() will honest-gate until the pool gets an" >&2
  echo "         endpoint. Pass LOOM_AOAI_ENDPOINT to wire it now." >&2
fi

# --- 1) Build the wheel ----------------------------------------------------
echo "==> Building loom-ai-functions wheel from $PKG_DIR…"
rm -rf "$WHEEL_DIR"
( cd "$PKG_DIR" && python -m pip wheel . --no-deps -w dist >/dev/null )
WHEEL_FILE="$(ls "$WHEEL_DIR"/loom_ai_functions-*.whl 2>/dev/null | head -1)"
if [ -z "$WHEEL_FILE" ]; then
  echo "ERROR: wheel build produced no artifact in $WHEEL_DIR." >&2
  exit 1
fi
WHEEL_NAME="$(basename "$WHEEL_FILE")"
echo "   built $WHEEL_NAME"

# --- 2) Upload to the workspace package path -------------------------------
BLOB_PATH="synapse/workspaces/${LOOM_SYNAPSE_WORKSPACE}/sparkpools/${LOOM_SPARK_POOL}/libraries/python/${WHEEL_NAME}"
echo "==> Uploading to abfss://synapse@${LOOM_ADLS_ACCOUNT}.${DFS_SUFFIX}/${BLOB_PATH}…"
az storage blob upload \
  --account-name "$LOOM_ADLS_ACCOUNT" \
  --container-name "synapse" \
  --name "$BLOB_PATH" \
  --file "$WHEEL_FILE" \
  --auth-mode login \
  --overwrite >/dev/null \
  && echo "   uploaded." \
  || { echo "ERROR: blob upload failed." >&2; exit 1; }

# --- 3) Add the wheel to the Spark pool's workspace packages ---------------
echo "==> Adding $WHEEL_NAME to Spark pool $LOOM_SPARK_POOL…"
az synapse spark pool update \
  --name "$LOOM_SPARK_POOL" \
  --workspace-name "$LOOM_SYNAPSE_WORKSPACE" \
  --resource-group "${LOOM_SYNAPSE_RG:-$(az synapse workspace list --query "[?name=='$LOOM_SYNAPSE_WORKSPACE'].resourceGroup | [0]" -o tsv)}" \
  --package-action Add \
  --package "$WHEEL_NAME" >/dev/null 2>&1 \
  && echo "   pool updated (new sessions pick it up within ~5 min)." \
  || echo "   pool package add reported a warning — it may already be present."

# --- 4) Push the AOAI env onto the pool via a Spark config file ------------
if [ -n "$LOOM_AOAI_ENDPOINT" ]; then
  echo "==> Writing AOAI Spark configuration (endpoint / deployment / audience)…"
  CFG_FILE="$(mktemp)"
  cat > "$CFG_FILE" <<EOF
spark.loom.aoai.endpoint ${LOOM_AOAI_ENDPOINT}
spark.loom.aoai.deployment ${LOOM_AOAI_DEPLOYMENT}
spark.loom.aoai.audience ${LOOM_AOAI_AUDIENCE}
EOF
  az synapse spark pool update \
    --name "$LOOM_SPARK_POOL" \
    --workspace-name "$LOOM_SYNAPSE_WORKSPACE" \
    --resource-group "${LOOM_SYNAPSE_RG:-$(az synapse workspace list --query "[?name=='$LOOM_SYNAPSE_WORKSPACE'].resourceGroup | [0]" -o tsv)}" \
    --spark-config-file-path "$CFG_FILE" >/dev/null 2>&1 \
    && echo "   Spark config applied." \
    || echo "   could not apply Spark config — set spark.loom.aoai.* per-session instead."
  rm -f "$CFG_FILE"
fi

echo
echo "Done. In a notebook on '$LOOM_SPARK_POOL':"
echo "    import ai_functions as ai"
echo "    ai.check_reachable()"
echo "    df['label'] = ai.classify(df['text'], labels=['urgent','normal','low'])"
echo "See docs/fiab/notebooks/ai_functions_demo.py for a full walkthrough."
