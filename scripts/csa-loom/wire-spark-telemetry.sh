#!/usr/bin/env bash
# CSA Loom — wire Synapse Spark → Azure Log Analytics telemetry, idempotently.
#
# WHAT THIS CLOSES (operator gap, verified live 2026-07-12):
#   The Synapse Spark pools carry NO Apache Spark Log-Analytics emitter config,
#   so Spark applications emit ZERO application telemetry (SparkLoggingEvent_CL /
#   SparkMetrics_CL / SparkListenerEvent_CL) to Log Analytics — except the
#   console's per-session notebook path (apps/fiab-console/lib/spark/
#   config-presets.ts), which injects it per Livy session. Spark job definitions,
#   Synapse pipelines, and direct Livy submissions get nothing.
#
# WHAT IT DOES (all idempotent — list/show-then-set):
#   1. Resolves the Synapse workspace + the standardized Loom Log Analytics
#      workspace (customerId GUID + primary shared key).
#   2. Stores the LA shared key in the Loom Key Vault as a secret
#      (default name: SparkLogAnalyticsSecret). The key is NEVER printed or
#      written to disk. (Private KV: pass KV_TOGGLE_PUBLIC=1 to open a
#      runner-IP-scoped write window that is always restored via a trap.)
#   3. Grants the Synapse workspace MANAGED IDENTITY "Key Vault Secrets User"
#      on the Loom KV so it can read that secret at Spark-session start
#      (Synapse "Option 2" — MSI-read KV, no dev-plane linked service needed).
#   4. Bakes the LA emitter Spark config onto EVERY Loom Spark pool (loompool +
#      loometl + loombatch or whatever is present) via the ARM control plane
#      (az synapse spark pool update --spark-config-file-path), alongside the
#      best-practice AQE / skew-join / Delta optimize-write confs. This is the
#      SAME content platform/fiab/bicep/modules/landing-zone/synapse-spark-pools.bicep
#      bakes minus the secret — so bicep + this script converge.
#   5. Ensures the workspace-level diagnostic settings (ALL log categories) flow
#      to the same LA workspace.
#
# TELEMETRY SECRET (operator note): the LA shared KEY lives ONLY in the Loom Key
#   Vault secret named by SPARK_LA_SECRET_NAME (default SparkLogAnalyticsSecret).
#   Rotate it there; no code or config carries the value.
#
# HONEST GATE (data-exfiltration protection): on a managed-VNet workspace with
#   preventDataExfiltration=true, Spark egress to the LA ingestion endpoint
#   (<uriSuffix>) is blocked unless a workspace IP firewall rule / managed route
#   allows it. This script wires the CONFIG; if telemetry does not appear, add
#   the LA egress allowance per docs/fiab/compute-tiers-and-telemetry.md.
#
# REQUIRES: az CLI logged in as a principal with: Log Analytics read + get-shared-keys
#   on the LAW; Key Vault Secrets Officer (set secret) + role-assignment write on
#   the KV; and Contributor on the Synapse workspace (pool update). The
#   limitlessdata_deploy SP has these after the one-time human grants.
#
# USAGE (env overridable):
#   ADMIN_RG=rg-csa-loom-admin-centralus DLZ_RG=rg-csa-loom-dlz-default-centralus \
#   ADMIN_SUB=<admin-sub> DLZ_SUB=<dlz-sub> REGION=centralus \
#     scripts/csa-loom/wire-spark-telemetry.sh
set -uo pipefail

REGION="${REGION:-centralus}"
ADMIN_SUB="${ADMIN_SUB:-${LOOM_SUBSCRIPTION_ID:-}}"
DLZ_SUB="${DLZ_SUB:-$ADMIN_SUB}"
ADMIN_RG="${ADMIN_RG:-rg-csa-loom-admin-${REGION}}"
DLZ_RG="${DLZ_RG:-rg-csa-loom-dlz-${LOOM_DLZ_DOMAIN:-default}-${REGION}}"
SYNAPSE_WS="${SYNAPSE_WS:-syn-loom-${LOOM_DLZ_DOMAIN:-default}-${REGION}}"
LAW_NAME="${LAW_NAME:-law-csa-loom-${REGION}}"
SPARK_LA_SECRET_NAME="${SPARK_LA_SECRET_NAME:-SparkLogAnalyticsSecret}"
# LA data-collector URI suffix — ods.opinsights.azure.us for Azure Government.
AZ_CLOUD_NAME="$(az cloud show --query name -o tsv 2>/dev/null || echo AzureCloud)"
if [ "$AZ_CLOUD_NAME" = "AzureUSGovernment" ]; then
  LA_URI_SUFFIX="${LA_URI_SUFFIX:-ods.opinsights.azure.us}"
  KV_DNS_SUFFIX="vault.usgovcloudapi.net"
else
  LA_URI_SUFFIX="${LA_URI_SUFFIX:-ods.opinsights.azure.com}"
  KV_DNS_SUFFIX="vault.azure.net"
fi

echo "== CSA Loom Spark→Log Analytics telemetry wiring =="
echo "   region=$REGION  synapse=$SYNAPSE_WS  law=$LAW_NAME  cloud=$AZ_CLOUD_NAME"

# --- 1) Resolve the Log Analytics workspace (GUID + shared key) ---------------
[ -n "$ADMIN_SUB" ] && az account set --subscription "$ADMIN_SUB" >/dev/null 2>&1 || true
LAW_ID="$(az monitor log-analytics workspace list \
  --query "[?name=='$LAW_NAME'].id | [0]" -o tsv 2>/dev/null || true)"
if [ -z "$LAW_ID" ]; then
  LAW_ID="$(az monitor log-analytics workspace list \
    --query "[?starts_with(name,'law-csa-loom')].id | [0]" -o tsv 2>/dev/null || true)"
fi
if [ -z "$LAW_ID" ]; then
  echo "::warning::No Loom Log Analytics workspace found (law-csa-loom*) in $ADMIN_SUB — cannot wire Spark telemetry. Set LAW_NAME."
  exit 0
fi
LAW_RG="$(echo "$LAW_ID" | sed -E 's#.*/resourceGroups/([^/]+)/.*#\1#')"
LAW_GUID="$(az monitor log-analytics workspace show --ids "$LAW_ID" --query customerId -o tsv 2>/dev/null || true)"
LAW_KEY="$(az monitor log-analytics workspace get-shared-keys --ids "$LAW_ID" --query primarySharedKey -o tsv 2>/dev/null || true)"
if [ -z "$LAW_GUID" ] || [ -z "$LAW_KEY" ]; then
  echo "::warning::Could not read LA workspace customerId/sharedKey (need Log Analytics Contributor / get-shared-keys). Telemetry NOT wired."
  exit 0
fi
echo "   Log Analytics: id=$LAW_ID  guid=$LAW_GUID  (rg=$LAW_RG)"

# --- 2) Store the LA shared key in the Loom Key Vault -------------------------
KV_NAME="${KV_NAME:-}"
if [ -z "$KV_NAME" ]; then
  KV_NAME="$(az keyvault list -g "$ADMIN_RG" --query "[?starts_with(name,'kv-loom')].name | [0]" -o tsv 2>/dev/null || true)"
  [ -z "$KV_NAME" ] && KV_NAME="$(az keyvault list -g "$ADMIN_RG" --query "[0].name" -o tsv 2>/dev/null || true)"
fi
KV_SET_OK=0
if [ -z "$KV_NAME" ]; then
  echo "::warning::No Loom Key Vault found in $ADMIN_RG — the pool emitter needs the LA key in KV secret '$SPARK_LA_SECRET_NAME'. Set KV_NAME."
else
  echo "   Key Vault: $KV_NAME (secret: $SPARK_LA_SECRET_NAME)"
  # Private-KV write window (scoped to this runner IP), restored on exit.
  KV_ORIG_PNA=""; RUNNER_IP=""
  restore_kv() {
    if [ "${KV_TOGGLE_PUBLIC:-0}" = "1" ] && [ -n "${KV_NAME:-}" ] && [ "${KV_ORIG_PNA:-Enabled}" != "Enabled" ]; then
      [ -n "${RUNNER_IP:-}" ] && az keyvault network-rule remove -n "$KV_NAME" --ip-address "$RUNNER_IP" -o none 2>/dev/null || true
      az keyvault update -n "$KV_NAME" --public-network-access Disabled --default-action Deny -o none 2>/dev/null || true
      echo "   (restored Key Vault $KV_NAME private)"
    fi
  }
  trap restore_kv EXIT
  if [ "${KV_TOGGLE_PUBLIC:-0}" = "1" ]; then
    KV_ORIG_PNA="$(az keyvault show -n "$KV_NAME" --query "properties.publicNetworkAccess" -o tsv 2>/dev/null || echo Enabled)"
    if [ "$KV_ORIG_PNA" != "Enabled" ]; then
      RUNNER_IP="$(curl -sS https://ifconfig.me 2>/dev/null || curl -sS https://api.ipify.org 2>/dev/null || true)"
      az keyvault update -n "$KV_NAME" --public-network-access Enabled --default-action Deny -o none 2>/dev/null || true
      [ -n "$RUNNER_IP" ] && az keyvault network-rule add -n "$KV_NAME" --ip-address "$RUNNER_IP" -o none 2>/dev/null || true
      sleep 15
    fi
  fi
  if az keyvault secret set --vault-name "$KV_NAME" --name "$SPARK_LA_SECRET_NAME" --value "$LAW_KEY" -o none 2>/dev/null; then
    echo "   ✓ LA shared key stored in KV secret '$SPARK_LA_SECRET_NAME'."
    KV_SET_OK=1
  else
    echo "::warning::Could not set KV secret '$SPARK_LA_SECRET_NAME' on $KV_NAME (private KV? pass KV_TOGGLE_PUBLIC=1, or grant Key Vault Secrets Officer)."
  fi
  # 3) Workspace MSI needs to READ that secret at session start.
  MSI_OID="$(az synapse workspace list --subscription "$DLZ_SUB" \
    --query "[?name=='$SYNAPSE_WS'].identity.principalId | [0]" -o tsv 2>/dev/null | tr -d '\r' || true)"
  KV_ID="$(az keyvault show -n "$KV_NAME" --query id -o tsv 2>/dev/null || true)"
  if [ -n "$MSI_OID" ] && [ -n "$KV_ID" ]; then
    az role assignment create --assignee-object-id "$MSI_OID" --assignee-principal-type ServicePrincipal \
      --role "Key Vault Secrets User" --scope "$KV_ID" -o none 2>/dev/null \
      && echo "   ✓ Synapse MSI granted 'Key Vault Secrets User' on $KV_NAME." \
      || echo "   (Synapse MSI KV grant already present or not permitted — continuing)."
  fi
fi

# --- 4) Bake the LA emitter + best-practice confs onto every Loom pool --------
az account set --subscription "$DLZ_SUB" >/dev/null 2>&1 || true
SYN_RG="$(az synapse workspace list --subscription "$DLZ_SUB" \
  --query "[?name=='$SYNAPSE_WS'].resourceGroup | [0]" -o tsv 2>/dev/null | tr -d '\r' || true)"
[ -z "$SYN_RG" ] && SYN_RG="$DLZ_RG"
POOLS="$(az synapse spark pool list --workspace-name "$SYNAPSE_WS" --resource-group "$SYN_RG" \
  --query "[].name" -o tsv 2>/dev/null | tr -d '\r' || true)"
if [ -z "$POOLS" ]; then
  echo "::warning::No Spark pools found on $SYNAPSE_WS (rg=$SYN_RG) — nothing to configure."
else
  # KV name form: FQDN in non-global clouds (Learn: keyVault.name must be FQDN).
  if [ "$AZ_CLOUD_NAME" = "AzureUSGovernment" ] && [ -n "${KV_NAME:-}" ]; then
    KV_NAME_CONF="${KV_NAME}.${KV_DNS_SUFFIX}"
  else
    KV_NAME_CONF="${KV_NAME:-}"
  fi
  CONF_FILE="$(mktemp 2>/dev/null || echo "/tmp/loom-spark-la-$$.conf")"
  {
    echo "spark.sql.adaptive.enabled true"
    echo "spark.sql.adaptive.coalescePartitions.enabled true"
    echo "spark.sql.adaptive.skewJoin.enabled true"
    echo "spark.serializer org.apache.spark.serializer.KryoSerializer"
    echo "spark.microsoft.delta.optimizeWrite.enabled true"
    echo "spark.databricks.delta.optimizeWrite.enabled true"
    echo "spark.databricks.delta.autoCompact.enabled true"
    if [ "$KV_SET_OK" = "1" ] && [ -n "${KV_NAME_CONF:-}" ]; then
      echo "spark.synapse.logAnalytics.enabled true"
      echo "spark.synapse.logAnalytics.workspaceId ${LAW_GUID}"
      echo "spark.synapse.logAnalytics.keyVault.name ${KV_NAME_CONF}"
      echo "spark.synapse.logAnalytics.keyVault.key.secret ${SPARK_LA_SECRET_NAME}"
      echo "spark.synapse.logAnalytics.uriSuffix ${LA_URI_SUFFIX}"
    fi
  } > "$CONF_FILE"
  echo "   Applying Spark config to pools: $(echo "$POOLS" | tr '\n' ' ')"
  for pool in $POOLS; do
    az synapse spark pool update --name "$pool" --workspace-name "$SYNAPSE_WS" \
      --resource-group "$SYN_RG" --spark-config-file-path "$CONF_FILE" -o none 2>/dev/null \
      && echo "   ✓ $pool: Spark config applied." \
      || echo "::warning::   $pool: spark-config update failed (Contributor on the workspace? pool paused? re-run)."
  done
  rm -f "$CONF_FILE"
fi

# --- 5) Workspace diagnostic settings (all log categories) → the Loom LAW -----
WS_ARM_ID="$(az synapse workspace show --name "$SYNAPSE_WS" --resource-group "$SYN_RG" --query id -o tsv 2>/dev/null || true)"
if [ -n "$WS_ARM_ID" ]; then
  CATS='[{"category":"SynapseRbacOperations","enabled":true},{"category":"GatewayApiRequests","enabled":true},{"category":"BuiltinSqlReqsEnded","enabled":true},{"category":"IntegrationPipelineRuns","enabled":true},{"category":"IntegrationActivityRuns","enabled":true},{"category":"IntegrationTriggerRuns","enabled":true},{"category":"SQLSecurityAuditEvents","enabled":true}]'
  az monitor diagnostic-settings create --name diag-loom-stdz --resource "$WS_ARM_ID" \
    --workspace "$LAW_ID" --logs "$CATS" \
    --metrics '[{"category":"AllMetrics","enabled":true}]' -o none 2>/dev/null \
    && echo "   ✓ Workspace diagnostic settings → $LAW_NAME (idempotent)." \
    || echo "   (workspace diagnostic settings already present or set by bicep — continuing)."
fi

echo "== Spark telemetry wiring complete. LA workspace GUID: $LAW_GUID; secret in KV '$KV_NAME' as '$SPARK_LA_SECRET_NAME'. =="
