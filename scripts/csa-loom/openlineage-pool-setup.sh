#!/usr/bin/env bash
# CSA Loom — wire the OpenLineage Spark listener onto a Synapse Spark pool
# (loom-next-level L2, rev-2 SRE-F2 security redesign).
#
# WHAT THIS DOES (idempotently; mirrors ai-functions-pool-setup.sh):
#   1. uploads the openlineage-spark listener jar as a Synapse WORKSPACE
#      LIBRARY (required: DEP-enabled workspaces cannot install from public
#      repos — Learn: apache-spark-azure-create-spark-configuration) and adds
#      it to the pool's packages
#   2. MINTS the per-pool ingest credential (never one global static secret):
#        workspace-token mode (default here — pairs with the OL http
#        transport's static auth.apiKey): a fresh random token bound to ONE
#        Loom workspace, stored as the Console's loom-openlineage-token ACA
#        SECRET (LOOM_OPENLINEAGE_WORKSPACE_TOKEN secretRef). RE-RUNNING THIS
#        SCRIPT ROTATES THE TOKEN (old value replaced atomically).
#        entra mode (--mode entra): creates a per-pool app registration and
#        registers appId=<workspaceId> in LOOM_OPENLINEAGE_POOL_PRINCIPALS;
#        use when your listener build carries an AAD token provider.
#   3. stamps the pool's Spark configuration with the OpenLineage conf
#      (spark.extraListeners + http transport → the Console's IN-VNET ingest
#      URL + the transport auth) — merged with the existing baked conf from
#      modules/landing-zone/synapse-spark-pools.bicep, never replacing it.
#
# The ingest route (/api/lineage/openlineage) is served on the in-VNet ingress
# only and enforces: pinned-tenant/audience Entra validation or the
# per-workspace token, workspace-scoped writes (cross-workspace → 403+audit),
# a 5 MB body cap, per-credential rate limits, and column-mapping fan-out caps.
#
# REQUIRES: az CLI logged in (Synapse workspace-package + pool update rights,
#   containerapp update rights on the Console app), curl, jq, openssl.
#
# USAGE:
#   LOOM_SYNAPSE_WORKSPACE=syn-loom-… LOOM_SYNAPSE_RG=rg-… \
#   LOOM_SPARK_POOL=loompool LOOM_ADMIN_RG=rg-csa-loom-admin-… \
#   LOOM_OPENLINEAGE_ENDPOINT=https://loom-console.<cae-domain>/api/lineage/openlineage \
#   LOOM_WORKSPACE_ID=<loom-workspace-guid> \
#     ./scripts/csa-loom/openlineage-pool-setup.sh [--mode workspace-token|entra]
set -uo pipefail

MODE="workspace-token"
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:-workspace-token}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

LOOM_SYNAPSE_WORKSPACE="${LOOM_SYNAPSE_WORKSPACE:-}"
LOOM_SYNAPSE_RG="${LOOM_SYNAPSE_RG:-}"
LOOM_SPARK_POOL="${LOOM_SPARK_POOL:-loompool}"
LOOM_ADMIN_RG="${LOOM_ADMIN_RG:-}"
LOOM_CONSOLE_APP="${LOOM_CONSOLE_APP:-loom-console}"
LOOM_OPENLINEAGE_ENDPOINT="${LOOM_OPENLINEAGE_ENDPOINT:-}"
LOOM_WORKSPACE_ID="${LOOM_WORKSPACE_ID:-}"
# openlineage-spark release used when no local jar is supplied. Override with
# OPENLINEAGE_JAR=<path> on DEP/air-gapped estates (no public Maven egress).
OPENLINEAGE_VERSION="${OPENLINEAGE_VERSION:-1.24.2}"
OPENLINEAGE_JAR="${OPENLINEAGE_JAR:-}"
SUBSCRIPTION="${SUBSCRIPTION:-${LOOM_SUBSCRIPTION_ID:-}}"

[ -n "$SUBSCRIPTION" ] && az account set --subscription "$SUBSCRIPTION" >/dev/null 2>&1 || true

fail() { echo "ERROR: $*" >&2; exit 1; }
[ -n "$LOOM_SYNAPSE_WORKSPACE" ] || fail "set LOOM_SYNAPSE_WORKSPACE"
[ -n "$LOOM_SYNAPSE_RG" ] || fail "set LOOM_SYNAPSE_RG"
[ -n "$LOOM_ADMIN_RG" ] || fail "set LOOM_ADMIN_RG (the Console container app's resource group)"
[ -n "$LOOM_OPENLINEAGE_ENDPOINT" ] || fail "set LOOM_OPENLINEAGE_ENDPOINT (the IN-VNET console ingest URL — https://loom-console.<cae-domain>/api/lineage/openlineage; NEVER the public Front Door host)"
[ -n "$LOOM_WORKSPACE_ID" ] || fail "set LOOM_WORKSPACE_ID (the Loom workspace this pool's lineage is scoped to)"
case "$LOOM_OPENLINEAGE_ENDPOINT" in
  *azurefd.net*|*limitlessdata.ai*) fail "LOOM_OPENLINEAGE_ENDPOINT points at the PUBLIC host — the ingest is in-VNet only (rev-2 security redesign). Use the CAE default-domain URL." ;;
esac

# ── 1. listener jar → workspace library → pool package ─────────────────────
JAR_NAME="openlineage-spark_2.12-${OPENLINEAGE_VERSION}.jar"
if [ -z "$OPENLINEAGE_JAR" ]; then
  OPENLINEAGE_JAR="/tmp/${JAR_NAME}"
  if [ ! -f "$OPENLINEAGE_JAR" ]; then
    echo "Downloading ${JAR_NAME} from Maven Central (override with OPENLINEAGE_JAR=<path> on DEP estates)…"
    curl -fsSL -o "$OPENLINEAGE_JAR" \
      "https://repo1.maven.org/maven2/io/openlineage/openlineage-spark_2.12/${OPENLINEAGE_VERSION}/${JAR_NAME}" \
      || fail "jar download failed — on a DEP-enabled workspace supply OPENLINEAGE_JAR=<local path> (no public-repo egress)"
  fi
else
  JAR_NAME="$(basename "$OPENLINEAGE_JAR")"
fi

echo "Uploading workspace package ${JAR_NAME} → ${LOOM_SYNAPSE_WORKSPACE}…"
az synapse workspace-package upload \
  --workspace-name "$LOOM_SYNAPSE_WORKSPACE" \
  --package "$OPENLINEAGE_JAR" >/dev/null 2>&1 \
  || echo "  (package already uploaded — continuing)"

echo "Adding ${JAR_NAME} to pool ${LOOM_SPARK_POOL}…"
az synapse spark pool update \
  --name "$LOOM_SPARK_POOL" \
  --workspace-name "$LOOM_SYNAPSE_WORKSPACE" \
  --resource-group "$LOOM_SYNAPSE_RG" \
  --package-action Add --package "$JAR_NAME" >/dev/null 2>&1 \
  || echo "  (package already attached — continuing)"

# ── 2. mint the per-pool credential + register it on the Console ────────────
AUTH_CONF=""
if [ "$MODE" = "workspace-token" ]; then
  TOKEN="$(openssl rand -hex 32)"
  echo "Minting per-workspace token for workspace ${LOOM_WORKSPACE_ID} (re-run = rotate)…"
  az containerapp secret set \
    --name "$LOOM_CONSOLE_APP" --resource-group "$LOOM_ADMIN_RG" \
    --secrets "loom-openlineage-token=${LOOM_WORKSPACE_ID}=${TOKEN}" >/dev/null \
    || fail "could not set the loom-openlineage-token secret on ${LOOM_CONSOLE_APP}"
  az containerapp update \
    --name "$LOOM_CONSOLE_APP" --resource-group "$LOOM_ADMIN_RG" \
    --set-env-vars "LOOM_OPENLINEAGE_AUTH_MODE=workspace-token" \
                   "LOOM_OPENLINEAGE_WORKSPACE_TOKEN=secretref:loom-openlineage-token" >/dev/null \
    || fail "could not wire LOOM_OPENLINEAGE_WORKSPACE_TOKEN on ${LOOM_CONSOLE_APP}"
  AUTH_CONF="spark.openlineage.transport.auth.type api_key
spark.openlineage.transport.auth.apiKey ${TOKEN}"
else
  APP_NAME="loom-openlineage-${LOOM_SPARK_POOL}"
  echo "Creating per-pool app registration ${APP_NAME} (entra mode)…"
  APP_ID="$(az ad app list --display-name "$APP_NAME" --query '[0].appId' -o tsv 2>/dev/null)"
  if [ -z "$APP_ID" ] || [ "$APP_ID" = "null" ]; then
    APP_ID="$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)" || fail "app create failed"
    az ad sp create --id "$APP_ID" >/dev/null 2>&1 || true
  fi
  echo "Registering ${APP_ID}=${LOOM_WORKSPACE_ID} on the Console (LOOM_OPENLINEAGE_POOL_PRINCIPALS)…"
  EXISTING="$(az containerapp show --name "$LOOM_CONSOLE_APP" --resource-group "$LOOM_ADMIN_RG" \
    --query "properties.template.containers[0].env[?name=='LOOM_OPENLINEAGE_POOL_PRINCIPALS'].value | [0]" -o tsv 2>/dev/null)"
  case ",${EXISTING}," in
    *",${APP_ID}=${LOOM_WORKSPACE_ID},"*) MERGED="$EXISTING" ;;
    *) MERGED="${EXISTING:+${EXISTING},}${APP_ID}=${LOOM_WORKSPACE_ID}" ;;
  esac
  az containerapp update \
    --name "$LOOM_CONSOLE_APP" --resource-group "$LOOM_ADMIN_RG" \
    --set-env-vars "LOOM_OPENLINEAGE_AUTH_MODE=entra" \
                   "LOOM_OPENLINEAGE_POOL_PRINCIPALS=${MERGED}" >/dev/null \
    || fail "could not register the pool principal on ${LOOM_CONSOLE_APP}"
  echo "NOTE: the stock openlineage-spark http transport sends a STATIC bearer only."
  echo "      Entra mode requires a listener build with an AAD client-credential token"
  echo "      provider (secret for ${APP_ID} → 'az ad app credential reset --id ${APP_ID}')."
  echo "      If your listener lacks one, use the default workspace-token mode instead."
fi

# ── 3. stamp the pool Spark configuration (merge, never replace) ────────────
CONF_FILE="$(mktemp /tmp/loom-openlineage-conf.XXXXXX)"
EXISTING_CONF="$(az synapse spark pool show \
  --name "$LOOM_SPARK_POOL" --workspace-name "$LOOM_SYNAPSE_WORKSPACE" \
  --resource-group "$LOOM_SYNAPSE_RG" \
  --query 'sparkConfigProperties.content' -o tsv 2>/dev/null | grep -v '^spark\.openlineage\.' | grep -v '^spark\.extraListeners' || true)"
{
  [ -n "$EXISTING_CONF" ] && printf '%s\n' "$EXISTING_CONF"
  echo "spark.extraListeners io.openlineage.spark.agent.OpenLineageSparkListener"
  echo "spark.openlineage.transport.type http"
  echo "spark.openlineage.transport.url ${LOOM_OPENLINEAGE_ENDPOINT}"
  echo "spark.openlineage.namespace loom"
  [ -n "$AUTH_CONF" ] && printf '%s\n' "$AUTH_CONF"
} > "$CONF_FILE"

echo "Updating pool Spark configuration (${LOOM_SPARK_POOL})…"
az synapse spark pool update \
  --name "$LOOM_SPARK_POOL" \
  --workspace-name "$LOOM_SYNAPSE_WORKSPACE" \
  --resource-group "$LOOM_SYNAPSE_RG" \
  --spark-config-file-path "$CONF_FILE" >/dev/null \
  || fail "pool spark-config update failed"
rm -f "$CONF_FILE"

echo ""
echo "DONE. Pool ${LOOM_SPARK_POOL} now emits OpenLineage RunEvents to:"
echo "  ${LOOM_OPENLINEAGE_ENDPOINT}  (in-VNet, workspace ${LOOM_WORKSPACE_ID}, mode ${MODE})"
echo "New Spark sessions pick the listener up; running sessions keep the old conf."
echo "Rotation: re-run this script (workspace-token mode replaces the secret atomically)."
echo "Runbook: docs/fiab/runbooks/openlineage-spark-lineage.md"
