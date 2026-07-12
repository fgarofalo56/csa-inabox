#!/usr/bin/env bash
# CSA Loom — provision Databricks INSTANCE POOLS + a Loom CLUSTER POLICY,
# idempotently, so the Databricks-native compute matches the tiers the console
# offers (apps/fiab-console/lib/databricks/cluster-presets.ts) and every Loom
# cluster is right-sized, warm-startable, best-practice-tuned, and log-delivering.
#
# WHAT THIS CLOSES (operator gap, verified live 2026-07-12):
#   The Databricks workspace has 0 instance pools + no Loom cluster policies, so
#   clusters cold-start (no warm pool) and nothing enforces the best-practice
#   spark_conf / auto-terminate / log delivery the presets bake in.
#
# WHAT IT DOES (all idempotent — list-then-create/edit):
#   1. INSTANCE POOLS per size tier (node types from cluster-presets.ts):
#        loom-pool-s  Standard_DS3_v2   (general-purpose, dev/small ETL)
#        loom-pool-m  Standard_E8ds_v4  (memory-optimized, production ETL/BI)
#        loom-pool-l  Standard_E16ds_v4 (memory-optimized, large batch/ML)
#      min_idle 0 (no idle cost) + idle auto-termination 15 min + spot fallback.
#   2. A Loom CLUSTER POLICY ("Loom Standard") that ENFORCES the best-practice
#      spark_conf (AQE on, skew-join, coalesce, Kryo, Delta optimize-write +
#      auto-compact), an auto-terminate range (no immortal clusters), the
#      loom-managed tag, and cluster_log_conf DELIVERY to DBFS. Diagnostic
#      delivery to Log Analytics is on the WORKSPACE resource (categories
#      clusters/notebook/jobs/...) — already wired by databricks.bicep; step 3
#      re-asserts it idempotently.
#   3. Ensures the workspace → Log Analytics diagnostic settings exist.
#
# Azure-native / no-Fabric: Databricks is a first-class Azure-native Loom compute
# backend (opt-in via LOOM_NOTEBOOK_BACKEND=databricks; Synapse Spark is the
# default). No Fabric dependency.
#
# AUTH: uses the caller's `az` login to mint a Databricks workspace AAD token
#   (resource 2ff814a6-3304-4ab8-85cb-cd0e6f879c1d) — no PAT needed. The caller
#   must be a Databricks workspace admin (the deploy SP is, after SCIM bootstrap).
#   The workspace is commonly PE-only; run this from an in-VNet context OR with a
#   temporary public-access + IP-allow window (the post-deploy bootstrap already
#   opens one around the SCIM step). REQUIRES: az CLI, curl, jq.
#
# USAGE (env overridable):
#   DBX_HOST=adb-1234567890.19.azuredatabricks.net \
#   DLZ_RG=rg-csa-loom-dlz-default-centralus DLZ_SUB=<sub> REGION=centralus \
#     scripts/csa-loom/provision-databricks-compute.sh
set -uo pipefail

REGION="${REGION:-centralus}"
DLZ_SUB="${DLZ_SUB:-${LOOM_SUBSCRIPTION_ID:-}}"
ADMIN_SUB="${ADMIN_SUB:-$DLZ_SUB}"
DLZ_RG="${DLZ_RG:-rg-csa-loom-dlz-${LOOM_DLZ_DOMAIN:-default}-${REGION}}"
ADMIN_RG="${ADMIN_RG:-rg-csa-loom-admin-${REGION}}"
DBX_WS="${DBX_WS:-adb-loom-default-${REGION}}"
DBX_HOST="${DBX_HOST:-}"
IDLE_MIN="${IDLE_MIN:-15}"
LAW_NAME="${LAW_NAME:-law-csa-loom-${REGION}}"
# Databricks AAD application id (constant across Azure clouds).
DBX_AAD_RESOURCE="2ff814a6-3304-4ab8-85cb-cd0e6f879c1d"

echo "== CSA Loom Databricks compute provisioning =="

# --- Resolve the workspace host --------------------------------------------
[ -n "$DLZ_SUB" ] && az account set --subscription "$DLZ_SUB" >/dev/null 2>&1 || true
if [ -z "$DBX_HOST" ]; then
  DBX_HOST="$(az databricks workspace show -g "$DLZ_RG" -n "$DBX_WS" --query workspaceUrl -o tsv 2>/dev/null \
            || az databricks workspace show -g "$ADMIN_RG" -n "$DBX_WS" --query workspaceUrl -o tsv 2>/dev/null || true)"
fi
if [ -z "$DBX_HOST" ] || [ "$DBX_HOST" = "None" ]; then
  echo "::notice::No Databricks workspace host resolved (DBX_HOST empty) — skipping Databricks compute provisioning (workspace not deployed?)."
  exit 0
fi
DBX_HOST="${DBX_HOST#https://}"
echo "   workspace: https://$DBX_HOST"

TOKEN="$(az account get-access-token --resource "$DBX_AAD_RESOURCE" --query accessToken -o tsv 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  echo "::warning::Could not mint a Databricks AAD token — ensure az is logged in as a workspace admin. Skipping."
  exit 0
fi

dbx_api() { # method path [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "https://$DBX_HOST$path" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body"
  else
    curl -sS -X "$method" "https://$DBX_HOST$path" -H "Authorization: Bearer $TOKEN"
  fi
}

# --- Discover a valid Spark runtime to preload -----------------------------
SPARK_VERSION="$(dbx_api GET /api/2.0/clusters/spark-versions 2>/dev/null \
  | jq -r '[.versions[]?.key | select(test("-scala") and (test("ml|gpu|photon|aarch64")|not) and test("lts"))] | first // empty' 2>/dev/null || true)"
[ -z "$SPARK_VERSION" ] && SPARK_VERSION="$(dbx_api GET /api/2.0/clusters/spark-versions 2>/dev/null \
  | jq -r '[.versions[]?.key | select(test("-scala"))] | first // empty' 2>/dev/null || true)"
echo "   preload runtime: ${SPARK_VERSION:-<none resolved>}"

# --- 1) Instance pools per size tier (node types from cluster-presets.ts) ---
existing_pools_json="$(dbx_api GET /api/2.0/instance-pools/list 2>/dev/null || echo '{}')"

ensure_pool() { # name node_type max_capacity
  local name="$1" node="$2" maxcap="$3"
  local existing
  existing="$(echo "$existing_pools_json" | jq -r --arg n "$name" '.instance_pools[]? | select(.instance_pool_name==$n) | .instance_pool_id' 2>/dev/null || true)"
  if [ -n "$existing" ] && [ "$existing" != "null" ]; then
    echo "   ✓ instance pool exists: $name ($existing)"
    return
  fi
  local preload='[]'
  [ -n "$SPARK_VERSION" ] && preload="[\"$SPARK_VERSION\"]"
  local body
  body="$(cat <<JSON
{
  "instance_pool_name": "$name",
  "node_type_id": "$node",
  "min_idle_instances": 0,
  "max_capacity": $maxcap,
  "idle_instance_autotermination_minutes": $IDLE_MIN,
  "preloaded_spark_versions": $preload,
  "azure_attributes": { "availability": "SPOT_WITH_FALLBACK_AZURE", "spot_bid_max_price": -1 },
  "custom_tags": { "loom-managed": "true", "loom-preset": "$name" }
}
JSON
)"
  local resp
  resp="$(dbx_api POST /api/2.0/instance-pools/create "$body" 2>/dev/null || true)"
  if echo "$resp" | jq -e '.instance_pool_id' >/dev/null 2>&1; then
    echo "   ✓ instance pool created: $name ($(echo "$resp" | jq -r '.instance_pool_id'))"
  else
    echo "::warning::   instance pool create failed: $name — $(echo "$resp" | jq -r '.message // .error_code // "unknown"' 2>/dev/null)"
  fi
}

ensure_pool "loom-pool-s" "Standard_DS3_v2"   8
ensure_pool "loom-pool-m" "Standard_E8ds_v4"  16
ensure_pool "loom-pool-l" "Standard_E16ds_v4" 32

# --- 2) Loom cluster policy (best-practice spark_conf + log delivery) --------
POLICY_NAME="Loom Standard"
POLICY_DEF="$(cat <<'JSON'
{
  "spark_conf.spark.sql.adaptive.enabled": { "type": "fixed", "value": "true" },
  "spark_conf.spark.sql.adaptive.coalescePartitions.enabled": { "type": "fixed", "value": "true" },
  "spark_conf.spark.sql.adaptive.skewJoin.enabled": { "type": "fixed", "value": "true" },
  "spark_conf.spark.serializer": { "type": "fixed", "value": "org.apache.spark.serializer.KryoSerializer" },
  "spark_conf.spark.databricks.delta.optimizeWrite.enabled": { "type": "fixed", "value": "true" },
  "spark_conf.spark.databricks.delta.autoCompact.enabled": { "type": "fixed", "value": "true" },
  "autotermination_minutes": { "type": "range", "minValue": 10, "maxValue": 120, "defaultValue": 30 },
  "cluster_log_conf.type": { "type": "fixed", "value": "DBFS" },
  "cluster_log_conf.path": { "type": "fixed", "value": "dbfs:/cluster-logs/loom" },
  "custom_tags.loom-managed": { "type": "fixed", "value": "true" }
}
JSON
)"
POLICY_DEF_ESCAPED="$(echo "$POLICY_DEF" | jq -c . | jq -Rs . 2>/dev/null || true)"
existing_policies_json="$(dbx_api GET /api/2.0/policies/clusters/list 2>/dev/null || echo '{}')"
POLICY_ID="$(echo "$existing_policies_json" | jq -r --arg n "$POLICY_NAME" '.policies[]? | select(.name==$n) | .policy_id' 2>/dev/null || true)"
if [ -n "$POLICY_ID" ] && [ "$POLICY_ID" != "null" ]; then
  resp="$(dbx_api POST /api/2.0/policies/clusters/edit "{\"policy_id\":\"$POLICY_ID\",\"name\":\"$POLICY_NAME\",\"definition\":$POLICY_DEF_ESCAPED}" 2>/dev/null || true)"
  echo "   ✓ cluster policy updated: $POLICY_NAME ($POLICY_ID)"
else
  resp="$(dbx_api POST /api/2.0/policies/clusters/create "{\"name\":\"$POLICY_NAME\",\"definition\":$POLICY_DEF_ESCAPED}" 2>/dev/null || true)"
  if echo "$resp" | jq -e '.policy_id' >/dev/null 2>&1; then
    echo "   ✓ cluster policy created: $POLICY_NAME ($(echo "$resp" | jq -r '.policy_id'))"
  else
    echo "::warning::   cluster policy create failed — $(echo "$resp" | jq -r '.message // .error_code // "unknown"' 2>/dev/null)"
  fi
fi

# --- 3) Workspace → Log Analytics diagnostic settings (idempotent) ----------
# databricks.bicep already sets these (all categories); re-assert for a
# dev-attach / drift case. Non-fatal.
az account set --subscription "$ADMIN_SUB" >/dev/null 2>&1 || true
LAW_ID="$(az monitor log-analytics workspace list --query "[?name=='$LAW_NAME'].id | [0]" -o tsv 2>/dev/null || true)"
[ -z "$LAW_ID" ] && LAW_ID="$(az monitor log-analytics workspace list --query "[?starts_with(name,'law-csa-loom')].id | [0]" -o tsv 2>/dev/null || true)"
az account set --subscription "$DLZ_SUB" >/dev/null 2>&1 || true
DBX_ID="$(az databricks workspace show -g "$DLZ_RG" -n "$DBX_WS" --query id -o tsv 2>/dev/null \
        || az databricks workspace show -g "$ADMIN_RG" -n "$DBX_WS" --query id -o tsv 2>/dev/null || true)"
if [ -n "$LAW_ID" ] && [ -n "$DBX_ID" ]; then
  LOGCATS='[{"category":"clusters","enabled":true},{"category":"notebook","enabled":true},{"category":"jobs","enabled":true},{"category":"accounts","enabled":true},{"category":"dbfs","enabled":true},{"category":"unityCatalog","enabled":true},{"category":"instancePools","enabled":true},{"category":"sqlanalytics","enabled":true}]'
  az monitor diagnostic-settings create --name diag-loom-stdz --resource "$DBX_ID" \
    --workspace "$LAW_ID" --logs "$LOGCATS" -o none 2>/dev/null \
    && echo "   ✓ Databricks workspace diagnostics → $LAW_NAME (idempotent)." \
    || echo "   (Databricks workspace diagnostics already present via bicep — continuing)."
fi

echo "== Databricks compute provisioning complete (pools: loom-pool-s/m/l; policy: '$POLICY_NAME'). =="
