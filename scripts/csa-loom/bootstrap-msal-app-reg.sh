#!/usr/bin/env bash
# =====================================================================
# CSA Loom — Entra app registration (MSAL) provisioner
# =====================================================================
# Day-one deploy-readiness (GH #1383). Idempotent: create-or-reuse the Loom
# Console Entra app registration, MERGE its redirect URIs with the live console
# host(s) (never overwrite — keeps the Front Door callback), keep it a
# CONFIDENTIAL web app (isFallbackPublicClient=false, since it uses a client
# secret), ensure the delegated Microsoft Graph User.Read scope, reset the
# client secret, and persist both the client secret and a STABLE SESSION_SECRET
# to Key Vault.
# Finally wire LOOM_MSAL_CLIENT_ID + the secretRefs onto the Console Container
# App so interactive login works on first sign-in.
#
# This is the SAME logic the in-bicep deploymentScript
# (modules/admin-plane/entra-app-registration.bicep) runs, so the bicep and the
# post-deploy-bootstrap homes never drift (no-vaporware bicep+bootstrap sync).
#
# Requires the caller to be signed in (az login) as a principal that holds the
# Microsoft Graph "Application Administrator" directory role (or
# Application.ReadWrite.OwnedBy) AND Key Vault Secrets Officer on the target
# vault. In CI the limitlessdata_deploy SP is used.
#
# Env:
#   APP_DISPLAY_NAME    stable display name (default "CSA Loom Console (<KEYVAULT_NAME>)")
#   CONSOLE_HOSTS       comma-separated hosts (no scheme) for redirect URIs
#   EXISTING_CLIENT_ID  use-existing override (skip create; reconcile if owned)
#   KEYVAULT_NAME       Key Vault to write secrets into (required)
#   MSAL_SECRET_NAME    default loom-msal-client-secret
#   SESSION_SECRET_NAME default session-secret
#   CONSOLE_APP_NAME    Container App name to wire (optional; e.g. loom-console)
#   CONSOLE_RG          resource group of the Container App (optional)
#   KEYVAULT_URI        https://<kv>.vault.azure.net/ (optional; for KV-backed
#                       secretRef wiring; derived from KEYVAULT_NAME when unset)
#   UAMI_RESOURCE_ID    Console UAMI resource id for KV-backed secretRef identity
#                       (optional; falls back to inline secret wiring)
#
# OPT-IN — Power BI remote MCP (preview). Default-OFF; never on a default path:
#   --enable-powerbi-mcp   flag (or LOOM_ENABLE_POWERBI_MCP=1). When set, ALSO
#                       grants the SAME Loom Console app registration the three
#                       delegated Power BI Service permissions the remote Power BI
#                       MCP endpoint (https://api.fabric.microsoft.com/v1/mcp/powerbi)
#                       requires — Dataset.Read.All, MLModel.Execute.All,
#                       Workspace.Read.All on resource
#                       https://analysis.windows.net/powerbi/api — grants admin
#                       consent, and prints the appId to set as
#                       LOOM_POWERBI_MCP_CLIENT_ID. This is the Entra half of the
#                       on-behalf-of (OBO) path Loom uses to call the remote PBI
#                       MCP under the signed-in user's RBAC. It is OPT-IN by design
#                       (.claude/rules/no-fabric-dependency.md): Loom's Azure-native
#                       semantic-model / report authoring stays the DEFAULT day-one
#                       path and never touches Power BI / Fabric. A Power BI admin
#                       must still MANUALLY enable the tenant setting "Users can use
#                       the Power BI Model Context Protocol server endpoint (preview)"
#                       — az / Microsoft Graph cannot flip that toggle.
# =====================================================================
set -euo pipefail

KEYVAULT_NAME="${KEYVAULT_NAME:?KEYVAULT_NAME is required}"
APP_DISPLAY_NAME="${APP_DISPLAY_NAME:-CSA Loom Console (${KEYVAULT_NAME})}"
CONSOLE_HOSTS="${CONSOLE_HOSTS:-}"
EXISTING_CLIENT_ID="${EXISTING_CLIENT_ID:-}"
MSAL_SECRET_NAME="${MSAL_SECRET_NAME:-loom-msal-client-secret}"
SESSION_SECRET_NAME="${SESSION_SECRET_NAME:-session-secret}"
GRAPH_APP_ID='00000003-0000-0000-c000-000000000000'
GRAPH_USER_READ='e1fe6dd8-ba31-4d61-89e7-88639da4683d' # delegated User.Read
GRAPH_OBJ="{\"resourceAppId\":\"${GRAPH_APP_ID}\",\"resourceAccess\":[{\"id\":\"${GRAPH_USER_READ}\",\"type\":\"Scope\"}]}"
GRAPH_RA="[${GRAPH_OBJ}]"

# ---------------------------------------------------------------------
# OPT-IN: Power BI remote MCP (preview). OFF unless --enable-powerbi-mcp (or
# LOOM_ENABLE_POWERBI_MCP truthy). no-fabric-dependency: this is the ONLY place
# the bootstrap touches Power BI, and only when explicitly opted in. The
# Azure-native authoring path stays the day-one default with this OFF.
# ---------------------------------------------------------------------
ENABLE_POWERBI_MCP="${LOOM_ENABLE_POWERBI_MCP:-0}"
for arg in "$@"; do
  case "$arg" in
    --enable-powerbi-mcp) ENABLE_POWERBI_MCP=1 ;;
    --no-powerbi-mcp)     ENABLE_POWERBI_MCP=0 ;;
  esac
done
case "$(printf '%s' "${ENABLE_POWERBI_MCP}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) ENABLE_POWERBI_MCP=1 ;;
  *)             ENABLE_POWERBI_MCP=0 ;;
esac
# Power BI Service first-party API (delegated permissions for the remote MCP).
PBI_RESOURCE_APP_ID='00000009-0000-0000-c000-000000000000'
PBI_RESOURCE_URI='https://analysis.windows.net/powerbi/api'
PBI_MCP_ENDPOINT='https://api.fabric.microsoft.com/v1/mcp/powerbi'
PBI_SCOPE_NAMES=("Dataset.Read.All" "MLModel.Execute.All" "Workspace.Read.All")

echo "==> Resolving Entra app registration '${APP_DISPLAY_NAME}'"
if [ -n "${EXISTING_CLIENT_ID}" ]; then
  APP_ID="${EXISTING_CLIENT_ID}"
  echo "    Using existing app (client) id: ${APP_ID}"
else
  APP_ID="$(az ad app list --filter "displayName eq '${APP_DISPLAY_NAME}'" --query "[0].appId" -o tsv 2>/dev/null || true)"
  if [ -z "${APP_ID:-}" ]; then
    echo "    Creating new app registration"
    APP_ID="$(az ad app create --display-name "${APP_DISPLAY_NAME}" --sign-in-audience AzureADMyOrg --query appId -o tsv)"
    sleep 20 # allow Entra replication before subsequent updates
  else
    echo "    Reusing app registration: ${APP_ID}"
  fi
fi

echo "==> Reconciling redirect URIs (MERGE — never overwrite existing callbacks)"
# INCIDENT 2026-06-17: this step used to OVERWRITE web.redirectUris with only the
# computed set derived from the ACA ingress FQDN. Real users reach the console
# through Azure Front Door (e.g. loom-console-xxxx.b02.azurefd.net), so the app
# sends the Front Door host as redirect_uri. Overwriting dropped the Front Door
# callback → AADSTS50011 redirect-URI mismatch → interactive login dead. We now
# UNION the computed redirects with the app's CURRENT web.redirectUris so any
# already-correct Front Door callback survives even if the caller only passes the
# ACA host.
REDIRECTS=()
IFS=',' read -ra HOSTS <<< "${CONSOLE_HOSTS}"
for h in "${HOSTS[@]}"; do
  h="$(echo "$h" | tr -d ' ')"
  [ -n "$h" ] && REDIRECTS+=("https://${h}/auth/callback")
done
REDIRECTS+=("http://localhost:3000/auth/callback") # preserve dev callback
# Read the app's current web redirect URIs and union with the computed set.
CURRENT_REDIRECTS="$(az ad app show --id "${APP_ID}" --query "web.redirectUris" -o tsv 2>/dev/null || true)"
while IFS= read -r r; do
  r="$(echo "$r" | tr -d ' \r')"
  [ -n "$r" ] && REDIRECTS+=("$r")
done <<< "${CURRENT_REDIRECTS}"
# Dedupe while preserving order.
MERGED_REDIRECTS=()
for r in "${REDIRECTS[@]}"; do
  dup=0
  for seen in "${MERGED_REDIRECTS[@]:-}"; do
    [ "$seen" = "$r" ] && { dup=1; break; }
  done
  [ "$dup" -eq 0 ] && MERGED_REDIRECTS+=("$r")
done
echo "    ${MERGED_REDIRECTS[*]}"
az ad app update --id "${APP_ID}" --web-redirect-uris "${MERGED_REDIRECTS[@]}" || echo "    WARN: redirect-uri update failed (app owned elsewhere?)"

# Build the app's required-resource-accesses. Microsoft Graph User.Read is ALWAYS
# present. When the Power BI MCP opt-in is enabled, MERGE in the three delegated
# Power BI Service scopes the remote MCP requires — resolved BY NAME from the
# Power BI Service first-party SP so we never bake a wrong/stale permission GUID.
# Resolution is dynamic + fail-soft: if a scope can't be resolved we keep the
# Graph-only set and print an honest note rather than fabricating GUIDs
# (.claude/rules/no-vaporware.md).
REQUIRED_RA="${GRAPH_RA}"
PBI_RA_APPLIED=0
if [ "${ENABLE_POWERBI_MCP}" -eq 1 ]; then
  echo "==> [opt-in] Resolving Power BI delegated scopes for the remote MCP (preview)"
  echo "    resource ${PBI_RESOURCE_URI} (Power BI Service SP ${PBI_RESOURCE_APP_ID})"
  PBI_ACCESS_ENTRIES=()
  for s in "${PBI_SCOPE_NAMES[@]}"; do
    sid="$(az ad sp show --id "${PBI_RESOURCE_APP_ID}" --query "oauth2PermissionScopes[?value=='${s}'].id | [0]" -o tsv 2>/dev/null | tr -d ' \r')"
    if [ -z "${sid}" ] || [ "${sid}" = "None" ]; then
      echo "    WARN: could not resolve Power BI delegated scope '${s}' (is the Power BI Service SP ${PBI_RESOURCE_APP_ID} present in this tenant and the caller able to read the directory?) — skipping it"
    else
      echo "    ${s} = ${sid}"
      PBI_ACCESS_ENTRIES+=("{\"id\":\"${sid}\",\"type\":\"Scope\"}")
    fi
  done
  if [ "${#PBI_ACCESS_ENTRIES[@]}" -gt 0 ]; then
    IFS=','; PBI_ACCESS_JOINED="${PBI_ACCESS_ENTRIES[*]}"; unset IFS
    PBI_OBJ="{\"resourceAppId\":\"${PBI_RESOURCE_APP_ID}\",\"resourceAccess\":[${PBI_ACCESS_JOINED}]}"
    REQUIRED_RA="[${GRAPH_OBJ},${PBI_OBJ}]"
    PBI_RA_APPLIED=1
  else
    echo "    WARN: no Power BI scopes resolved — applying Graph-only permissions. Add the 3"
    echo "          delegated Power BI Service scopes manually in Entra ID → App registrations."
  fi
fi

echo "==> Ensuring confidential web app (NOT a fallback public client) + delegated Graph User.Read"
# INCIDENT 2026-06-17: this step used to set isFallbackPublicClient=true. The Loom
# Console is a CONFIDENTIAL web app that authenticates with a client secret. When
# isFallbackPublicClient=true, Entra treats the client as public and rejects the
# client_secret at the token exchange → AADSTS700025 "Client is public so neither
# client_assertion nor client_secret should be presented." → login dead. It MUST
# be false. (Idempotent: --set is safe to re-run.) NOTE: the Loom Console remains
# a confidential web app even with the Power BI MCP opt-in — it mints a per-user
# OBO token for the PBI resource, it is NOT an external public MCP client.
az ad app update --id "${APP_ID}" --set isFallbackPublicClient=false || echo "    WARN: isFallbackPublicClient update failed"
az ad app update --id "${APP_ID}" --required-resource-accesses "${REQUIRED_RA}" || echo "    WARN: required-resource-accesses update failed"

echo "==> Resetting client secret + persisting to Key Vault ${KEYVAULT_NAME}"
SECRET="$(az ad app credential reset --id "${APP_ID}" --years 2 --query password -o tsv)"
az keyvault secret set --vault-name "${KEYVAULT_NAME}" --name "${MSAL_SECRET_NAME}" --value "${SECRET}" -o none
echo "    wrote ${MSAL_SECRET_NAME}"

EXISTING_SS="$(az keyvault secret show --vault-name "${KEYVAULT_NAME}" --name "${SESSION_SECRET_NAME}" --query value -o tsv 2>/dev/null || true)"
if [ -z "${EXISTING_SS:-}" ]; then
  SS="$(openssl rand -hex 32)"
  az keyvault secret set --vault-name "${KEYVAULT_NAME}" --name "${SESSION_SECRET_NAME}" --value "${SS}" -o none
  echo "    generated + wrote ${SESSION_SECRET_NAME}"
else
  echo "    ${SESSION_SECRET_NAME} already present — preserved (sessions survive)"
fi

# Optionally wire the Console Container App so LOOM_MSAL_CLIENT_ID + secretRefs
# take effect without a full redeploy.
if [ -n "${CONSOLE_APP_NAME:-}" ] && [ -n "${CONSOLE_RG:-}" ]; then
  echo "==> Wiring Container App ${CONSOLE_APP_NAME} (${CONSOLE_RG})"
  KV_URI="${KEYVAULT_URI:-https://${KEYVAULT_NAME}.vault.azure.net/}"
  KVREF_OK=0
  if [ -n "${UAMI_RESOURCE_ID:-}" ]; then
    # Preferred + durable: make the Container App secret a KV REFERENCE
    # (unversioned URI → resolves the LATEST version on each new revision). This
    # is what permanently breaks the "bootstrap rotates the secret → running
    # console keeps the OLD baked value → AADSTS7000215 → login loop" cycle: a
    # future rotation propagates on the next revision roll with no re-wiring.
    if az containerapp secret set -n "${CONSOLE_APP_NAME}" -g "${CONSOLE_RG}" --secrets \
      "loom-msal-client-secret=keyvaultref:${KV_URI}secrets/${MSAL_SECRET_NAME},identityref:${UAMI_RESOURCE_ID}" \
      "session-secret=keyvaultref:${KV_URI}secrets/${SESSION_SECRET_NAME},identityref:${UAMI_RESOURCE_ID}" -o none; then
      KVREF_OK=1
    else
      echo "    WARN: KV-backed secret set failed; falling back to the inline rotated value"
    fi
  fi
  # Belt-and-suspenders: if the KV reference could not be wired (no UAMI, or the
  # secret-set failed — e.g. RBAC still propagating), push the FRESHLY-ROTATED
  # literal value so the running console gets the matching secret immediately on
  # this run even on a KV-literal estate. (We already hold ${SECRET} from the
  # credential reset above.)
  if [ "${KVREF_OK}" -ne 1 ]; then
    az containerapp secret set -n "${CONSOLE_APP_NAME}" -g "${CONSOLE_RG}" --secrets \
      "loom-msal-client-secret=${SECRET}" -o none || echo "    WARN: inline secret set failed"
  fi
  # Force a new revision so the updated secret value/reference is picked up
  # immediately (a secret-set alone does NOT roll running replicas). Setting the
  # env vars both wires LOOM_MSAL_CLIENT_ID and serves as the revision-roll.
  az containerapp update -n "${CONSOLE_APP_NAME}" -g "${CONSOLE_RG}" \
    --set-env-vars "LOOM_MSAL_CLIENT_ID=${APP_ID}" "LOOM_MSAL_CLIENT_SECRET=secretref:${MSAL_SECRET_NAME}" -o none || echo "    WARN: env-var update failed"
  echo "    wired LOOM_MSAL_CLIENT_ID=${APP_ID} + LOOM_MSAL_CLIENT_SECRET=secretref:${MSAL_SECRET_NAME} (kvref=${KVREF_OK})"
fi

# ---------------------------------------------------------------------
# OPT-IN: grant admin consent for the Power BI delegated permissions and print
# the env vars to wire. Admin consent here covers the whole app (Graph User.Read
# + the 3 Power BI scopes). Requires the caller to be a Privileged Role /
# Application Administrator; warn-and-continue otherwise (no-vaporware: name the
# exact manual step). The tenant setting cannot be flipped by az/Graph.
# ---------------------------------------------------------------------
if [ "${ENABLE_POWERBI_MCP}" -eq 1 ]; then
  echo "==> [opt-in] Granting admin consent for the app's delegated permissions (Graph + Power BI)"
  # Ensure the enterprise app (service principal) exists so consent can be granted.
  az ad sp show --id "${APP_ID}" -o none 2>/dev/null || az ad sp create --id "${APP_ID}" -o none 2>/dev/null || echo "    WARN: could not ensure a service principal for ${APP_ID}"
  sleep 15 # allow required-resource-access + SP replication before consent
  if az ad app permission admin-consent --id "${APP_ID}" -o none 2>/dev/null; then
    echo "    admin consent granted (Graph User.Read + the 3 Power BI delegated scopes)"
  else
    echo "    WARN: admin-consent failed — a Privileged Role / Application Administrator must grant"
    echo "          admin consent in Entra ID → App registrations → ${APP_ID} → API permissions →"
    echo "          Grant admin consent (for the Power BI Service delegated permissions)."
  fi
  echo ""
  echo "    Power BI remote MCP (preview) — set on the Console Container App:"
  echo "      LOOM_POWERBI_MCP_CLIENT_ID=${APP_ID}"
  echo "      LOOM_POWERBI_MCP_ENDPOINT=${PBI_MCP_ENDPOINT}"
  echo "    MANUAL (az/Graph cannot do this): a Power BI admin must enable the tenant setting"
  echo "      \"Users can use the Power BI Model Context Protocol server endpoint (preview)\""
  echo "    in the Power BI admin portal. Until both the env var is set AND the tenant setting is"
  echo "    enabled, the Loom Power BI MCP surface shows an honest gate and the Azure-native"
  echo "    semantic-model / report authoring path remains the day-one default."
  if [ "${PBI_RA_APPLIED}" -ne 1 ]; then
    echo "    NOTE: the Power BI delegated scopes were NOT applied (see WARN above) — resolve before use."
  fi
  echo "LOOM_POWERBI_MCP_CLIENT_ID=${APP_ID}"
  echo "LOOM_POWERBI_MCP_ENDPOINT=${PBI_MCP_ENDPOINT}"
fi

echo "==> Done. App (client) id: ${APP_ID}"
echo "    NOTE: a Global/Application Administrator may still need to grant admin"
echo "    consent for the app's Graph permissions in Entra ID → App registrations."
echo "LOOM_MSAL_CLIENT_ID=${APP_ID}"
