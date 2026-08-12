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
#   MSAL_CLIENT_ID_SECRET_NAME  default loom-msal-client-id — the app registration's
#                       (non-secret) CLIENT ID, persisted so a later
#                       `az deployment sub create` can resolve it back into
#                       LOOM_MSAL_CLIENT_ID instead of re-rendering an empty one
#                       (which would blank sign-in)
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

# GROUPS CLAIM (#3175) — see the identical block in
# platform/fiab/bicep/modules/admin-plane/entra-app-registration.bicep. Both
# provisioning paths must set it or the estate they produce has dead group authz.
if az ad app update --id "${APP_ID}" --set groupMembershipClaims=SecurityGroup; then
  echo "    groupMembershipClaims=SecurityGroup set"
else
  echo "::warning::groupMembershipClaims update FAILED on ${APP_ID} — Entra will emit no groups claim, so group-based authorization will NOT work. Set it by hand: az ad app update --id ${APP_ID} --set groupMembershipClaims=SecurityGroup"
fi

# ---------------------------------------------------------------------------
# KEY VAULT ACCESS GOES THROUGH ARM, NOT THE DATA PLANE (#3176).
#
# MEASURED on Commercial 2026-08-09: the Loom vault is publicNetworkAccess=
# Disabled + defaultAction=Deny, and Azure Policy `KeyVault_PublicNetwork_Modify`
# (assignment MCAPSGovDeployPolicies, effect `modify`) SILENTLY reverts any
# attempt to open a write window — `az keyvault update --public-network-access
# Enabled` returns rc=0 and an ARM PATCH returns HTTP 200, and the vault stays
# Disabled. The activity log shows the vault write succeeding next to
# `Microsoft.Authorization/policies/modify/action`.
#
# So every `az keyvault secret set` from a public runner failed, the caller
# swallowed it into a warning, and the estate ran with an app registration that
# had ZERO credentials while the Console presented a stale Key Vault value —
# AADSTS7000215 on every sign-in, with a green bootstrap. That is the outage
# this function exists to prevent.
#
# The ARM control plane is a DIFFERENT path and is not gated by the vault's
# network ACL — it is how bicep provisions secrets into private vaults. Verified
# working against the live private vault.
#
# Requires control-plane `Microsoft.KeyVault/vaults/secrets/write` (Key Vault
# Contributor / Contributor), which is a different grant from the data-plane
# "Key Vault Secrets Officer" role the old path needed.
# ---------------------------------------------------------------------------
kv_arm_base() {
  # Derived from the vault's own ARM id, so no extra subscription/RG inputs have
  # to be threaded in (and none can drift out of sync with KEYVAULT_NAME).
  if [ -z "${KV_ARM_ID:-}" ]; then
    KV_ARM_ID="$(az keyvault show --name "${KEYVAULT_NAME}" --query id -o tsv)"
    if [ -z "${KV_ARM_ID:-}" ]; then
      echo "    ERROR: could not resolve the ARM id of Key Vault '${KEYVAULT_NAME}'. This is a control-plane read; it failing means the vault does not exist under this subscription or the identity cannot see it — NOT that the vault is network-blocked." >&2
      return 1
    fi
  fi
  echo "https://management.azure.com${KV_ARM_ID}/secrets"
}

# kv_secret_put <name> <value> — write via ARM. Fails loudly; never prints the value.
kv_secret_put() {
  local _n="$1" _v="$2" _out
  if ! _out="$(az rest --method PUT \
        --url "$(kv_arm_base)/${_n}?api-version=2023-07-01" \
        --body "{\"properties\":{\"value\":\"${_v}\"}}" -o none 2>&1)"; then
    # Scrub the value out of any echoed request body before surfacing the error.
    echo "    ERROR: could not write ${_n} to ${KEYVAULT_NAME} via ARM:" >&2
    printf '%s\n' "${_out}" | grep -vF "${_v}" | head -5 >&2
    return 1
  fi
  return 0
}

# kv_secret_exists <name> — ARM GET. Answers EXISTENCE without returning the
# value (ARM deliberately does not expose it). This replaces a data-plane
# `az keyvault secret show ... 2>/dev/null || true`, which on a private vault
# returned empty for "unreachable" and was then read as "absent" — regenerating
# session-secret and RE-KEYING EVERY LIVE SESSION (the #1534 bug class).
kv_secret_exists() {
  az rest --method GET --url "$(kv_arm_base)/$1?api-version=2023-07-01" -o none >/dev/null 2>&1
}

echo "==> Resetting client secret + persisting to Key Vault ${KEYVAULT_NAME}"
# --append, NOT a bare reset. A bare `credential reset` DELETES every existing
# credential and mints a new one, so the running Console — which is still
# serving the OLD secret until its next revision — starts failing sign-in the
# instant this line runs, and stays broken until the roll lands. Appending keeps
# the outgoing secret valid across that window.
SECRET="$(az ad app credential reset --id "${APP_ID}" --append --years 2 --query password -o tsv)"
if [ -z "${SECRET:-}" ]; then
  echo "    ERROR: credential reset returned an empty password for ${APP_ID}. Nothing was written to Key Vault; sign-in still uses the previous secret." >&2
  exit 1
fi

# PROVE the secret before persisting it. Entra replicates new client secrets
# ASYNCHRONOUSLY — a token request in the first seconds is answered
# AADSTS7000215 ("invalid client secret") even though the secret is genuine.
# Observed live 2026-08-09: attempt 1 rejected, attempt 2 (+10s) issued a token.
# Writing an unproven value would put Key Vault and the app registration back
# out of sync, which is the exact failure this script is meant to end.
echo "    validating the new secret against Entra (async replication)"
# Tenant + login host resolved from the signed-in context rather than assumed,
# so this is correct in every cloud (the AD endpoint differs in Gov).
_tenant="$(az account show --query tenantId -o tsv)"
_login_host="$(az cloud show --query endpoints.activeDirectory -o tsv 2>&1)" || _login_host=''
case "${_login_host}" in https://*) : ;; *) _login_host='https://login.microsoftonline.com' ;; esac
_login_host="${_login_host%/}"
if [ -z "${_tenant:-}" ]; then
  echo "    ERROR: could not resolve the tenant id from the current az context, so the new secret cannot be validated. Refusing to write an unproven secret to Key Vault." >&2
  exit 1
fi
_ok=0
for _i in 1 2 3 4 5 6 7 8; do
  _resp="$(curl -s -X POST "${_login_host}/${_tenant}/oauth2/v2.0/token" \
    -d "client_id=${APP_ID}" --data-urlencode "client_secret=${SECRET}" \
    -d "scope=https://graph.microsoft.com/.default" -d "grant_type=client_credentials" --max-time 30)"
  if printf '%s' "${_resp}" | grep -q '"access_token"'; then _ok=1; break; fi
  echo "      attempt ${_i}: $(printf '%s' "${_resp}" | grep -oE 'AADSTS[0-9]+' | sort -u | tr '\n' ' ')— retrying in $((_i * 10))s"
  sleep "$((_i * 10))"
done
if [ "${_ok}" -ne 1 ]; then
  echo "    ERROR: Entra never issued a token for the newly minted secret after 8 attempts. It was NOT written to Key Vault, so the previous secret remains authoritative and sign-in is unchanged." >&2
  exit 1
fi

kv_secret_put "${MSAL_SECRET_NAME}" "${SECRET}" || exit 1
echo "    wrote ${MSAL_SECRET_NAME} (validated: Entra issued a token with it)"

# SIGN-IN DURABILITY — persist the app registration's CLIENT ID too.
# It is not a secret; it is the DURABLE record of which app registration this
# estate uses. Without it, every later `az deployment sub create` re-renders
# effectiveMsalClientId from an unset LOOM_MSAL_CLIENT_ID, blanks the Console's
# LOOM_MSAL_CLIENT_ID and takes sign-in dark on the very next reconcile
# (an ACA template rewrite drops every env var it does not declare). The deploy
# workflows now read this secret back
# into LOOM_MSAL_CLIENT_ID before running the template (see the "Resolve the
# existing MSAL client id" steps in deploy-fiab-gcch / deploy-fiab-il5 /
# csa-loom-post-deploy-bootstrap), which makes the reconcile idempotent.
MSAL_CLIENT_ID_SECRET_NAME="${MSAL_CLIENT_ID_SECRET_NAME:-loom-msal-client-id}"
kv_secret_put "${MSAL_CLIENT_ID_SECRET_NAME}" "${APP_ID}" \
  && echo "    wrote ${MSAL_CLIENT_ID_SECRET_NAME}=${APP_ID} (redeploys resolve it from here)" \
  || echo "    WARN: could not persist ${MSAL_CLIENT_ID_SECRET_NAME} — a later redeploy may blank sign-in until LOOM_MSAL_CLIENT_ID is supplied"

# EXISTENCE, not value. See kv_secret_exists: the old data-plane read used
# `2>/dev/null || true`, so an unreachable private vault looked identical to an
# absent secret and this branch regenerated session-secret — silently re-keying
# every live session on a healthy estate.
if kv_secret_exists "${SESSION_SECRET_NAME}"; then
  echo "    ${SESSION_SECRET_NAME} already present — preserved (sessions survive)"
else
  SS="$(openssl rand -hex 32)"
  kv_secret_put "${SESSION_SECRET_NAME}" "${SS}" || exit 1
  echo "    generated + wrote ${SESSION_SECRET_NAME}"
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
    if ! az containerapp secret set -n "${CONSOLE_APP_NAME}" -g "${CONSOLE_RG}" --secrets \
      "loom-msal-client-secret=${SECRET}" -o none; then
      echo "    ERROR: this run could NOT write the secret 'loom-msal-client-secret' on"
      echo "           ${CONSOLE_APP_NAME} (${CONSOLE_RG}) — neither as a Key Vault reference nor"
      echo "           inline. A new credential WAS minted in Entra and written to Key Vault."
      echo "           What this script cannot tell you: if the app's secret is ALREADY a Key Vault"
      echo "           reference from an earlier deploy, the new value is picked up on the next"
      echo "           revision roll; if it is an inline literal, the console still holds the"
      echo "           PREVIOUS secret and sign-in will fail with AADSTS7000215. Check with:"
      echo "             az containerapp secret list -n ${CONSOLE_APP_NAME} -g ${CONSOLE_RG} \\"
      echo "               --query \"[].{name:name,keyVaultUrl:keyVaultUrl}\" -o table"
      echo "           Refusing to continue on an unverified rotation (deploy-integrity.md R6/R7)."
      echo "           Remediation: grant the deploy principal 'Container Apps Contributor' (or"
      echo "           Contributor) on ${CONSOLE_APP_NAME} in ${CONSOLE_RG}, then re-run this script."
      exit 1
    fi
  fi
  # Force a new revision so the updated secret value/reference is picked up
  # immediately (a secret-set alone does NOT roll running replicas). Setting the
  # env vars both wires LOOM_MSAL_CLIENT_ID and serves as the revision-roll.
  #
  # NO rotation-marker env var is stamped here (#3025). This block used to also
  # set LOOM_MSAL_SECRET_ROTATED. On 2026-08-10 that marker was measured ABSENT
  # from all 425 env vars on the live loom-console: this script was its only
  # writer, it was never declared in
  # platform/fiab/bicep/modules/admin-plane/main.bicep, and the next
  # `az deployment sub create` re-renders the container template without it —
  # the same class that dropped the admin OID, LOOM_ADLS_ACCOUNT and the Front
  # Door vanity binding. A marker that disappears on the next deploy reads as
  # "never rotated" during AADSTS7000215 triage, which is worse than no marker.
  # The record that survives a redeploy is the Entra credential list
  # (`az ad app credential list --id <APP_ID>`) cross-read with the Key Vault
  # version timeline and the active revision's createdTime — see
  # docs/fiab/runbooks/secret-rotation.md §2.1.
  #
  # The result is BRANCHED, not discarded. Until 2026-08-11 this command ended
  # in `|| echo "WARN: env-var update failed"` and the next line printed
  # "wired LOOM_MSAL_CLIENT_ID=… " unconditionally — asserting a write that may
  # never have happened (deploy-integrity.md R7).
  if az containerapp update -n "${CONSOLE_APP_NAME}" -g "${CONSOLE_RG}" \
    --set-env-vars "LOOM_MSAL_CLIENT_ID=${APP_ID}" "LOOM_MSAL_CLIENT_SECRET=secretref:${MSAL_SECRET_NAME}" -o none; then
    echo "    wired LOOM_MSAL_CLIENT_ID=${APP_ID} + LOOM_MSAL_CLIENT_SECRET=secretref:${MSAL_SECRET_NAME} (kvref=${KVREF_OK})"
  else
    echo "    ERROR: the env-var update on ${CONSOLE_APP_NAME} (${CONSOLE_RG}) FAILED."
    echo "           LOOM_MSAL_CLIENT_ID / LOOM_MSAL_CLIENT_SECRET are NOT confirmed wired, and the"
    echo "           revision roll is NOT confirmed either (the CLI returned non-zero; this script"
    echo "           does not know how far the update got). The running console may therefore still"
    echo "           be serving the PREVIOUS client secret while Entra holds the new one →"
    echo "           AADSTS7000215 on sign-in. Confirm with \`az containerapp revision list\`."
    echo "           Remediation: grant the deploy principal 'Container Apps Contributor' (or"
    echo "           Contributor) on ${CONSOLE_APP_NAME} in ${CONSOLE_RG}, confirm the app name and"
    echo "           resource group, then re-run this script or the equivalent:"
    echo "             az containerapp update -n ${CONSOLE_APP_NAME} -g ${CONSOLE_RG} \\"
    echo "               --set-env-vars LOOM_MSAL_CLIENT_ID=${APP_ID} LOOM_MSAL_CLIENT_SECRET=secretref:${MSAL_SECRET_NAME}"
    exit 1
  fi
fi

# ---------------------------------------------------------------------
# svc-loom-unity-authz — Application ID URI only. DELIBERATELY NOT the
# authorization flip.
#
# Loom Unity's `authMode=entra` needs an audience, and the Console's managed
# identity cannot request `api://<app-id>/.default` at all unless the app
# registration exposes that Application ID URI. Ensuring it here is free,
# idempotent, and a prerequisite for the follow-up work, so it stays.
#
# What this script MUST NOT do yet is stamp LOOM_UNITY_AUTH=enable +
# LOOM_UNITY_ENTRA_CLIENT_ID onto a running catalog and LOOM_UNITY_AUTH_MODE=entra
# onto the Console. Measured against the pinned image
# (docs/fiab/security/loom-unity-authz-proof.md): upstream unitycatalog — v0.5.0
# AND v0.5.1 — rejects any bearer whose `iss` is not its own `internal` issuer, so
# the Entra token the Console mints is answered 403 PERMISSION_DENIED on
# /api/2.1/unity-catalog/* even with a byte-exact audience match. Flipping those
# vars would therefore not secure the catalog; it would take every live Unity
# surface down (and on v0.5.0 also 500 every grants READ — upstream #1603).
#
# The flip belongs in the same change as the BFF token-exchange client
# (POST /api/1.0/unity-control/auth/tokens) plus registration of the Console
# principal as an enabled Unity Catalog user. Until then the catalog is deployed
# with the explicit, audited authMode=disabled opt-out by
# .github/workflows/gov-uc-purview-wire.yml and the finding is reported OPEN.
# ---------------------------------------------------------------------
if [ -n "${CONSOLE_RG:-}" ]; then
  echo "==> Ensuring the Application ID URI (prerequisite for Loom Unity authorization)"
  CURRENT_URIS="$(az ad app show --id "${APP_ID}" --query "identifierUris" -o tsv 2>/dev/null || true)"
  if ! printf '%s' "${CURRENT_URIS}" | grep -qx "api://${APP_ID}"; then
    az ad app update --id "${APP_ID}" --identifier-uris "api://${APP_ID}" -o none \
      && echo "    set Application ID URI api://${APP_ID}" \
      || echo "    WARN: could not set the Application ID URI (app owned elsewhere?) — a client will not be able to mint api://${APP_ID}/.default"
  else
    echo "    Application ID URI api://${APP_ID} already present"
  fi
  UNITY_APP_NAME="${UNITY_APP_NAME:-loom-unity}"
  if az containerapp show -n "${UNITY_APP_NAME}" -g "${CONSOLE_RG}" -o none 2>/dev/null; then
    echo "    NOTE: ${UNITY_APP_NAME} is deployed here and is NOT being switched to Entra authorization by this script."
    echo "          Upstream only accepts tokens it issued itself, so enabling it today would reject the Console too."
    echo "          Tracked: the BFF token-exchange client. See docs/fiab/security/loom-unity-authz-proof.md."
  fi
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
