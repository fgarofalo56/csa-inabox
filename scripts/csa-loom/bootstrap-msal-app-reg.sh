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
# CREDENTIAL LIFECYCLE (#3335) — REUSE before mint, PRUNE only after proof.
#
# MEASURED 2026-08-13 on the live Commercial registration: NINE password
# credentials, five minted that same day (05:26, 07:06, 08:27, 09:44, 12:50Z),
# every one `--years 2`. Cause: this script minted UNCONDITIONALLY on every
# invocation and nothing ever removed one. The mint rate follows the DEPLOY
# rate, not an operator decision — deploy-fiab-commercial ran 11 times that day
# and reaches this script through csa-loom-post-deploy-bootstrap's
# `workflow_call`, so each green deploy left another 2-year live credential
# behind. Long-lived credentials accumulating without bound is a real
# security-posture defect even when sign-in works.
#
# Three rules, in this order:
#   1. REUSE — when Key Vault RECORDS a credential (the `msalKeyId` tag on the
#      secret) that is still on the app and has more than
#      LOOM_MSAL_SECRET_MIN_REMAINING_DAYS left, mint NOTHING.
#   2. MINT  — only when there is no such record, or it is unhealthy. Always
#      `--append` (a bare `credential reset` DELETES every credential and
#      strands the running console), always validated against Entra BEFORE
#      Key Vault is written.
#   3. PRUNE — only credentials that provably cannot be in use, only after the
#      in-use one is proven, DRY RUN unless the operator opts in.
#
# WHY A KEY VAULT TAG carries the provenance: the ARM secrets API deliberately
# never returns `properties.value`, so `tags.msalKeyId` lets this script learn
# WHICH credential the estate is configured to present without ever reading,
# holding, or printing the secret itself. Key ids and dates are not secrets.
# The same tag is written by the in-bicep sibling
# (modules/admin-plane/entra-app-registration.bicep), so the two provisioning
# homes share one contract and cannot drift into different reuse decisions.
# ---------------------------------------------------------------------
SECRET_YEARS="${LOOM_MSAL_SECRET_YEARS:-1}"
MIN_REMAINING_DAYS="${LOOM_MSAL_SECRET_MIN_REMAINING_DAYS:-90}"
CREDENTIAL_CEILING="${LOOM_MSAL_CREDENTIAL_CEILING:-12}"
PRUNE_ENABLED="${LOOM_MSAL_PRUNE:-0}"
PRUNE_KEEP="${LOOM_MSAL_PRUNE_KEEP:-2}"
PRUNE_MIN_AGE_DAYS="${LOOM_MSAL_PRUNE_MIN_AGE_DAYS:-7}"
ADOPT_INFERRED="${LOOM_MSAL_ADOPT_INFERRED:-0}"
# Set on the mint path only; the reuse path deliberately never holds a value.
SECRET=''

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
    --prune)              PRUNE_ENABLED=1 ;;
    --dry-run-prune)      PRUNE_ENABLED=0 ;;
    --adopt-inferred)     ADOPT_INFERRED=1 ;;
  esac
done
case "$(printf '%s' "${ENABLE_POWERBI_MCP}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) ENABLE_POWERBI_MCP=1 ;;
  *)             ENABLE_POWERBI_MCP=0 ;;
esac
case "$(printf '%s' "${PRUNE_ENABLED}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) PRUNE_ENABLED=1 ;;
  *)             PRUNE_ENABLED=0 ;;
esac
case "$(printf '%s' "${ADOPT_INFERRED}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) ADOPT_INFERRED=1 ;;
  *)             ADOPT_INFERRED=0 ;;
esac

# CONFIG INVARIANT — a renewal threshold at or beyond the credential's own
# lifetime means EVERY run finds the credential "too close to expiry" and mints
# a replacement, which is precisely the unbounded-growth defect this block was
# written to end. Fail closed and name the two numbers rather than silently
# reverting to mint-always.
if [ "${MIN_REMAINING_DAYS}" -ge "$((SECRET_YEARS * 365))" ]; then
  echo "ERROR: LOOM_MSAL_SECRET_MIN_REMAINING_DAYS=${MIN_REMAINING_DAYS} is >= the whole lifetime of a newly minted secret (LOOM_MSAL_SECRET_YEARS=${SECRET_YEARS} => $((SECRET_YEARS * 365)) days). With that configuration a freshly minted credential is already 'expiring' and every run would mint another one — the #3335 sprawl. Lower the threshold or raise the lifetime." >&2
  exit 1
fi
if [ "${PRUNE_KEEP}" -lt 1 ]; then
  echo "ERROR: LOOM_MSAL_PRUNE_KEEP=${PRUNE_KEEP} would allow the app registration to be left with no retained credential. The floor is 1." >&2
  exit 1
fi
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

# kv_secret_put <name> <value> [tagsJson] — write via ARM. Fails loudly; never prints the value.
kv_secret_put() {
  local _n="$1" _v="$2" _tags="${3:-}" _body _out
  if [ -n "${_tags}" ]; then
    _body="{\"tags\":${_tags},\"properties\":{\"value\":\"${_v}\"}}"
  else
    _body="{\"properties\":{\"value\":\"${_v}\"}}"
  fi
  if ! _out="$(az rest --method PUT \
        --url "$(kv_arm_base)/${_n}?api-version=2023-07-01" \
        --body "${_body}" -o none 2>&1)"; then
    # Scrub the value out of any echoed request body before surfacing the error.
    echo "    ERROR: could not write ${_n} to ${KEYVAULT_NAME} via ARM:" >&2
    printf '%s\n' "${_out}" | grep -vF "${_v}" | head -5 >&2
    return 1
  fi
  return 0
}

# kv_secret_patch_tags <name> <tagsJson> — tag-only update (no value in the
# request body at all, so there is nothing to scrub and nothing to leak). Used
# by the one-time --adopt-inferred migration to record provenance on a secret
# this script did not itself write.
kv_secret_patch_tags() {
  local _n="$1" _tags="$2" _out
  if ! _out="$(az rest --method PATCH \
        --url "$(kv_arm_base)/${_n}?api-version=2023-07-01" \
        --body "{\"tags\":${_tags}}" -o none 2>&1)"; then
    echo "    ERROR: could not update the tags on ${_n} in ${KEYVAULT_NAME}:" >&2
    printf '%s\n' "${_out}" | head -5 >&2
    return 1
  fi
  return 0
}

# kv_secret_get <name> <jmespath> — read ONE metadata field over ARM. Echoes it
# (possibly empty). THREE distinct outcomes, because collapsing them is the bug
# class this file has already been burned by twice (deploy-integrity.md R7,
# and the #1534 session re-key where "unreachable" was read as "absent"):
#   rc 0 — read succeeded; stdout is the field (empty when the field is unset)
#   rc 2 — the secret does not exist (MEASURED: ARM answers HTTP 404 with
#          `"code":"ResourceNotFound"` and az exits 1)
#   rc 1 — the read itself failed; the answer is UNKNOWN, never "absent"
# The ARM secrets API never returns properties.value, so no call through here
# can expose the secret — only metadata (tags, attributes).
kv_secret_get() {
  local _n="$1" _q="$2" _out
  if _out="$(az rest --method GET \
        --url "$(kv_arm_base)/${_n}?api-version=2023-07-01" --query "${_q}" -o tsv 2>&1)"; then
    printf '%s' "${_out}" | tr -d ' \r' | sed 's/^None$//'
    return 0
  fi
  case "${_out}" in
    *ResourceNotFound*|*SecretNotFound*) return 2 ;;
  esac
  printf '%s\n' "${_out}" | head -3 >&2
  return 1
}

# iso_epoch <iso8601> — Unix seconds. Fails (non-zero, no output) on anything it
# cannot parse, so a caller can treat the timestamp as unknown instead of
# silently computing an age from a zero.
iso_epoch() {
  local _e
  _e="$(date -u -d "$1" +%s)" || return 1
  printf '%s' "${_e}"
}

# count_nonempty — count non-blank lines on stdin. Avoids `grep -c`, which exits
# non-zero on zero matches and would abort the script under `set -e`.
count_nonempty() {
  local _n=0 _l
  while IFS= read -r _l; do
    if [ -n "${_l}" ]; then _n=$((_n + 1)); fi
  done
  printf '%s' "${_n}"
}

# cred_line <keyId> <tsv> — the `keyId|start|end|displayName` row for a key id,
# or empty. Pure shell, so a miss is an empty string rather than a `set -e` abort.
cred_line() {
  local _want="$1" _tsv="$2" _l _hit=''
  while IFS= read -r _l; do
    case "${_l}" in "${_want}|"*) _hit="${_l}" ;; esac
  done <<< "${_tsv}"
  printf '%s' "${_hit}"
}

# kv_secret_exists <name> — ARM GET. Answers EXISTENCE without returning the
# value (ARM deliberately does not expose it). This replaces a data-plane
# `az keyvault secret show ... 2>/dev/null || true`, which on a private vault
# returned empty for "unreachable" and was then read as "absent" — regenerating
# session-secret and RE-KEYING EVERY LIVE SESSION (the #1534 bug class).
kv_secret_exists() {
  az rest --method GET --url "$(kv_arm_base)/$1?api-version=2023-07-01" -o none >/dev/null 2>&1
}

echo "==> Reconciling the client secret (reuse -> mint -> Key Vault ${KEYVAULT_NAME})"
NOW_EPOCH="$(date -u +%s)"

# The credential inventory, read ONCE. A failure here is FATAL, never "the app
# has no credentials": every decision below (reuse, mint, prune, the ceiling) is
# derived from this list, and reading an unanswered query as an empty one is the
# unknown-as-negative class that has already produced false verdicts in this
# repo. `credential list` returns METADATA only (key id, dates, display name) —
# no password is exposed by it.
if ! CRED_TSV="$(az ad app credential list --id "${APP_ID}" \
      --query "[].join('|', [keyId, startDateTime, endDateTime, not_null(displayName, '-')])" -o tsv)"; then
  echo "    ERROR: could not list the password credentials of app ${APP_ID}. This is a Microsoft Graph read; it failing means the signed-in principal cannot read the application object (it needs Application Administrator, or Application.ReadWrite.OwnedBy plus ownership) — it does NOT mean the app has no credentials. Refusing to mint, write, or prune against an unknown inventory." >&2
  exit 1
fi
CRED_TSV="$(printf '%s' "${CRED_TSV}" | tr -d ' \r')"
CRED_COUNT="$(printf '%s\n' "${CRED_TSV}" | count_nonempty)"
echo "    ${CRED_COUNT} password credential(s) currently on ${APP_ID}"

# --- 1. REUSE -------------------------------------------------------------
# WHICH credential is this estate actually configured to present? Key Vault is
# the source of truth (the Container App resolves the secret from it), so the
# answer is recorded ON the Key Vault secret as the `msalKeyId` tag.
KV_TAG=''
KV_RC=0
KV_TAG="$(kv_secret_get "${MSAL_SECRET_NAME}" "tags.msalKeyId")" || KV_RC=$?
IN_USE_KEY_ID=''
IN_USE_KNOWN=0
REUSED=0
case "${KV_RC}" in
  0) IN_USE_KEY_ID="${KV_TAG}"
     if [ -z "${IN_USE_KEY_ID}" ]; then
       echo "    ${MSAL_SECRET_NAME} exists but carries no msalKeyId tag — it predates the #3335 provenance contract, so which credential it holds is UNKNOWN."
     fi ;;
  2) echo "    ${MSAL_SECRET_NAME} does not exist in ${KEYVAULT_NAME} yet (first bootstrap of this estate)." ;;
  *) echo "    WARNING: ${MSAL_SECRET_NAME} could NOT be read from ${KEYVAULT_NAME} (see the error above). The in-use credential is UNKNOWN, so this run mints a fresh one and will NOT prune anything." ;;
esac

# ONE-TIME MIGRATION (opt-in, --adopt-inferred / LOOM_MSAL_ADOPT_INFERRED=1).
# An estate provisioned before #3335 has an untagged secret, so the very next
# run would mint one more credential purely to establish provenance. This
# correlates the Key Vault secret's `updated` timestamp with the credential
# start times and, when EXACTLY ONE credential matches inside a tight window,
# records the tag instead of minting. A tie or a miss adopts NOTHING — an
# inferred provenance that is merely plausible would let the prune delete a
# live credential, so ambiguity falls back to minting (the safe direction).
if [ "${KV_RC}" -eq 0 ] && [ -z "${IN_USE_KEY_ID}" ] && [ "${ADOPT_INFERRED}" -eq 1 ]; then
  KV_UPDATED=''
  KV_UPDATED="$(kv_secret_get "${MSAL_SECRET_NAME}" "properties.attributes.updated")" || KV_UPDATED=''
  if [ -n "${KV_UPDATED}" ]; then
    _match=''
    _matches=0
    while IFS='|' read -r _k _s _e _d; do
      [ -n "${_k}" ] || continue
      if _se="$(iso_epoch "${_s}")"; then
        _delta=$(( KV_UPDATED - _se ))
        # The bootstrap writes Key Vault seconds after minting; 15 minutes is
        # generous for a slow validation loop and still far tighter than the
        # 80-minute gap between the closest two credentials measured live.
        if [ "${_delta}" -ge -60 ] && [ "${_delta}" -le 900 ]; then
          _match="${_k}"; _matches=$(( _matches + 1 ))
          echo "    adopt-inferred candidate ${_k} (start ${_s}, end ${_e}, label ${_d}) — ${_delta}s before the Key Vault write"
        fi
      fi
    done <<< "${CRED_TSV}"
    if [ "${_matches}" -eq 1 ]; then
      if kv_secret_patch_tags "${MSAL_SECRET_NAME}" "{\"msalKeyId\":\"${_match}\",\"msalAppId\":\"${APP_ID}\",\"msalProvenance\":\"inferred-from-updated-timestamp\"}"; then
        IN_USE_KEY_ID="${_match}"
        echo "    ADOPTED ${_match} as the in-use credential (tag recorded; provenance=inferred). No credential was minted for this."
      fi
    else
      echo "    adopt-inferred found ${_matches} candidate(s), not exactly 1 — adopting nothing and minting instead. Ambiguous provenance must never authorize a prune."
    fi
  else
    echo "    adopt-inferred could not read the Key Vault secret's updated timestamp — adopting nothing."
  fi
fi

if [ -n "${IN_USE_KEY_ID}" ]; then
  IN_USE_LINE="$(cred_line "${IN_USE_KEY_ID}" "${CRED_TSV}")"
  if [ -z "${IN_USE_LINE}" ]; then
    echo "    RENEW — Key Vault records credential ${IN_USE_KEY_ID}, but the app registration no longer carries it (deleted out of band). Minting a replacement."
  else
    IFS='|' read -r _kid _start _end _label <<< "${IN_USE_LINE}"
    if END_EPOCH="$(iso_epoch "${_end}")"; then
      REMAIN_DAYS=$(( (END_EPOCH - NOW_EPOCH) / 86400 ))
      if [ "${REMAIN_DAYS}" -gt "${MIN_REMAINING_DAYS}" ]; then
        REUSED=1
        IN_USE_KNOWN=1
        echo "    REUSE — ${MSAL_SECRET_NAME} holds credential ${_kid} (label ${_label}, minted ${_start}), which is still on the app and expires ${_end} in ${REMAIN_DAYS} days (threshold ${MIN_REMAINING_DAYS}). NOTHING minted; Key Vault untouched."
      else
        echo "    RENEW — credential ${_kid} expires ${_end}, ${REMAIN_DAYS} days away and inside the ${MIN_REMAINING_DAYS}-day renewal window. Minting a replacement."
      fi
    else
      echo "    RENEW — could not parse the expiry '${_end}' of credential ${_kid}, so its health is UNKNOWN. Minting a replacement rather than assuming it is fine."
    fi
  fi
fi

# --- 2. MINT --------------------------------------------------------------
if [ "${REUSED}" -ne 1 ]; then
  # --append, NOT a bare reset. A bare `credential reset` DELETES every existing
  # credential and mints a new one, so the running Console — which is still
  # serving the OLD secret until its next revision — starts failing sign-in the
  # instant this line runs, and stays broken until the roll lands. Appending keeps
  # the outgoing secret valid across that window.
  #
  # The label is unique per run and is how the key id of THIS credential is
  # resolved afterwards: `az ad app credential reset` returns appId/password/
  # tenant, not the key id, and picking "the newest" would race a concurrent
  # deploy (11 ran on 2026-08-13).
  CRED_LABEL="loom-console-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  echo "    minting a new client secret: label ${CRED_LABEL}, lifetime ${SECRET_YEARS}y, APPENDED"
  SECRET="$(az ad app credential reset --id "${APP_ID}" --append --years "${SECRET_YEARS}" --display-name "${CRED_LABEL}" --query password -o tsv)"
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

  # Resolve the key id of the credential just minted, BY ITS UNIQUE LABEL. This
  # is the provenance record the reuse check and the prune both depend on; if it
  # cannot be resolved the secret is still written (an estate with a working
  # secret and no provenance beats an estate with neither), but the prune is
  # disarmed for this run rather than guessing which credential is live.
  NEW_KEY_ID=''
  NEW_KEY_ID="$(az ad app credential list --id "${APP_ID}" \
    --query "[?displayName=='${CRED_LABEL}'].keyId | [0]" -o tsv)" || NEW_KEY_ID=''
  NEW_KEY_ID="$(printf '%s' "${NEW_KEY_ID}" | tr -d ' \r' | sed 's/^None$//')"
  if [ -n "${NEW_KEY_ID}" ]; then
    kv_secret_put "${MSAL_SECRET_NAME}" "${SECRET}" \
      "{\"msalKeyId\":\"${NEW_KEY_ID}\",\"msalAppId\":\"${APP_ID}\",\"msalCredentialLabel\":\"${CRED_LABEL}\",\"msalProvenance\":\"minted\"}" || exit 1
    IN_USE_KEY_ID="${NEW_KEY_ID}"
    IN_USE_KNOWN=1
    echo "    wrote ${MSAL_SECRET_NAME} (validated: Entra issued a token with it; provenance tag msalKeyId=${NEW_KEY_ID})"
  else
    kv_secret_put "${MSAL_SECRET_NAME}" "${SECRET}" || exit 1
    IN_USE_KEY_ID=''
    IN_USE_KNOWN=0
    echo "    wrote ${MSAL_SECRET_NAME} (validated), but the key id of the new credential could NOT be resolved by its label '${CRED_LABEL}'. Sign-in is correct; provenance is not recorded, so this run will not prune."
  fi
fi

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
  # this run even on a KV-literal estate.
  #
  # ONLY on the MINT path (#3335). On the REUSE path this script deliberately
  # never holds a secret value — it proved the credential's health from Key Vault
  # metadata alone — so there is nothing to inline, and nothing NEEDS inlining:
  # no rotation happened, so whatever the console is already serving is exactly
  # as correct as it was before this run. Saying so is not the same as claiming
  # a write (deploy-integrity.md R7).
  if [ "${KVREF_OK}" -ne 1 ] && [ -z "${SECRET}" ]; then
    echo "    no inline secret write: this run REUSED the existing credential, so no new value exists"
    echo "           and none is needed — the console keeps serving the credential Key Vault already"
    echo "           records (${IN_USE_KEY_ID:-provenance unknown}). Note the app's secret is NOT a Key"
    echo "           Vault reference on this estate; to make future rotations propagate automatically,"
    echo "           supply UAMI_RESOURCE_ID so it can be wired as keyvaultref."
  elif [ "${KVREF_OK}" -ne 1 ]; then
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

# ---------------------------------------------------------------------
# 3. PRUNE (#3335) — delete superseded credentials, DRY RUN by default.
#
# THE SAFETY ARGUMENT (why this cannot strand the running app):
#
#   P1  It runs LAST — after the new credential was validated against Entra,
#       after Key Vault was written, and after the Container App wiring +
#       revision roll returned success. Every one of those steps exits the
#       script on failure, so reaching this block means the estate is already
#       serving the credential recorded in Key Vault.
#   P2  The in-use credential must be KNOWN, not guessed. If the Key Vault
#       provenance tag is missing/unreadable, or the freshly minted key id could
#       not be resolved, the prune is disarmed entirely.
#   P3  The console's credential source must be PROVEN to be that same Key Vault
#       secret — an UNVERSIONED `keyvaultref` to <vault>/secrets/<msal secret>.
#       With that binding, no credential other than the tagged one can be what
#       the console presents. Without it (inline literal, or unreadable), the
#       prune degrades to expired-only credentials, which can strand nobody.
#   P3b Every ACTIVE revision must have been created at or after the Key Vault
#       secret's last write. A Key Vault reference is resolved when a revision
#       is CREATED and then pinned, so a revision older than the last write is
#       still serving the previous version — i.e. a previous credential. If any
#       active revision predates it, the prune refuses.
#   P4  Even then, a credential is only a candidate when it is (a) not the
#       in-use one, (b) not among the newest LOOM_MSAL_PRUNE_KEEP, (c) older
#       than LOOM_MSAL_PRUNE_MIN_AGE_DAYS, and (d) minted STRICTLY BEFORE the
#       in-use one — i.e. demonstrably superseded.
#   P5  Deletion is one credential at a time, oldest first, and the retained set
#       is computed BEFORE the first delete. An interrupted run therefore leaves
#       a SUPERSET of the keep set — never fewer than the in-use credential plus
#       the retained window. There is no ordering in which this reaches zero.
#   P6  It is DRY RUN unless the operator opts in (LOOM_MSAL_PRUNE=1 / --prune).
#       The dry run prints key ids and dates only — never a secret value.
#
# RESIDUAL RISK, stated rather than implied: a consumer that captured a raw
# credential value out of band (not through Key Vault) is invisible to this
# script. P4's age + keep window covers recent ones; the dry-run list is how the
# operator checks the rest before authorizing. Commercial reuses this secret for
# Dataverse S2S, but through the SAME Key Vault secret, so P3 covers it.
# ---------------------------------------------------------------------
echo "==> Credential hygiene for ${APP_ID}"
if ! CRED_TSV="$(az ad app credential list --id "${APP_ID}" \
      --query "[].join('|', [keyId, startDateTime, endDateTime, not_null(displayName, '-')])" -o tsv)"; then
  echo "    ERROR: could not re-read the credential inventory of ${APP_ID} after wiring. Sign-in is wired and working; what is unknown is the credential COUNT, so neither the prune nor the ceiling can be evaluated. Refusing to report a hygiene verdict this run could not measure." >&2
  exit 1
fi
CRED_TSV="$(printf '%s' "${CRED_TSV}" | tr -d ' \r')"
CRED_COUNT="$(printf '%s\n' "${CRED_TSV}" | count_nonempty)"

PRUNE_ARMED=1
PRUNE_EXPIRED_ONLY=0
if [ "${IN_USE_KNOWN}" -ne 1 ] || [ -z "${IN_USE_KEY_ID}" ]; then
  PRUNE_ARMED=0
  echo "    prune DISARMED: the in-use credential is not known for this run (P2). Nothing is a provable supersession, so nothing is a candidate."
fi

IN_USE_START_EPOCH=''
if [ "${PRUNE_ARMED}" -eq 1 ]; then
  IN_USE_LINE="$(cred_line "${IN_USE_KEY_ID}" "${CRED_TSV}")"
  if [ -n "${IN_USE_LINE}" ]; then
    IFS='|' read -r _kid _start _end _label <<< "${IN_USE_LINE}"
    if ! IN_USE_START_EPOCH="$(iso_epoch "${_start}")"; then
      PRUNE_ARMED=0
      echo "    prune DISARMED: could not parse the start time '${_start}' of the in-use credential ${_kid} (label ${_label}, expires ${_end}), so 'minted before it' cannot be evaluated."
    fi
  else
    PRUNE_ARMED=0
    echo "    prune DISARMED: the in-use credential ${IN_USE_KEY_ID} is not in the app's credential list."
  fi
fi

# P3 + P3b — is the console PROVABLY serving the Key Vault secret we tagged?
if [ "${PRUNE_ARMED}" -eq 1 ] && [ -n "${CONSOLE_APP_NAME:-}" ] && [ -n "${CONSOLE_RG:-}" ]; then
  CA_SECRET_URL=''
  CA_READ_OK=1
  CA_SECRET_URL="$(az containerapp secret list -n "${CONSOLE_APP_NAME}" -g "${CONSOLE_RG}" \
    --query "[?name=='loom-msal-client-secret'].keyVaultUrl | [0]" -o tsv)" || CA_READ_OK=0
  CA_SECRET_URL="$(printf '%s' "${CA_SECRET_URL}" | tr -d ' \r' | sed 's/^None$//')"
  if [ "${CA_READ_OK}" -ne 1 ]; then
    PRUNE_EXPIRED_ONLY=1
    echo "    prune limited to ALREADY-EXPIRED credentials: the ${CONSOLE_APP_NAME} secret binding could not be read, so which credential the console serves is UNKNOWN (P3). ('secret list' returns names and Key Vault URLs only — no values.)"
  else
    case "${CA_SECRET_URL}" in
      *"/secrets/${MSAL_SECRET_NAME}")
        # P3b — a Key Vault reference is resolved at revision CREATION and then
        # pinned, so an older active revision still serves an older version.
        KV_UPDATED_EPOCH=''
        KV_UPDATED_EPOCH="$(kv_secret_get "${MSAL_SECRET_NAME}" "properties.attributes.updated")" || KV_UPDATED_EPOCH=''
        REV_TIMES=''
        REV_READ_OK=1
        REV_TIMES="$(az containerapp revision list -n "${CONSOLE_APP_NAME}" -g "${CONSOLE_RG}" \
          --query "[?properties.active].properties.createdTime" -o tsv)" || REV_READ_OK=0
        REV_TIMES="$(printf '%s' "${REV_TIMES}" | tr -d ' \r')"
        if [ "${REV_READ_OK}" -ne 1 ] || [ -z "${KV_UPDATED_EPOCH}" ]; then
          PRUNE_EXPIRED_ONLY=1
          echo "    prune limited to ALREADY-EXPIRED credentials: could not compare the active revisions against the Key Vault write time (P3b)."
        else
          _stale=0
          while IFS= read -r _rt; do
            [ -n "${_rt}" ] || continue
            if _re="$(iso_epoch "${_rt}")"; then
              if [ "${_re}" -lt "${KV_UPDATED_EPOCH}" ]; then
                _stale=1
                echo "    active revision created ${_rt} PREDATES the Key Vault write — it still resolves the previous secret version."
              fi
            else
              _stale=1
              echo "    could not parse an active revision's createdTime '${_rt}'."
            fi
          done <<< "${REV_TIMES}"
          if [ "${_stale}" -eq 1 ]; then
            PRUNE_EXPIRED_ONLY=1
            echo "    prune limited to ALREADY-EXPIRED credentials: at least one active revision predates the current Key Vault secret version (P3b), so a previous credential may still be in service."
          else
            echo "    console binding PROVEN: loom-msal-client-secret is an unversioned Key Vault reference to ${MSAL_SECRET_NAME}, and every active revision post-dates the current version (P3/P3b)."
          fi
        fi
        ;;
      *)
        PRUNE_EXPIRED_ONLY=1
        echo "    prune limited to ALREADY-EXPIRED credentials: ${CONSOLE_APP_NAME}'s loom-msal-client-secret is not an unversioned Key Vault reference to ${MSAL_SECRET_NAME} (P3), so what it serves cannot be derived from the Key Vault tag."
        ;;
    esac
  fi
elif [ "${PRUNE_ARMED}" -eq 1 ]; then
  PRUNE_EXPIRED_ONLY=1
  echo "    prune limited to ALREADY-EXPIRED credentials: no Container App was supplied, so no consumer binding could be proven (P3)."
fi

# P4 — build the candidate set. Newest first, so the index IS the keep rank.
PRUNE_CANDIDATES=''
PRUNE_KEPT=0
PRUNE_HELD_BY_GRACE=0
if [ "${PRUNE_ARMED}" -eq 1 ]; then
  CRED_SORTED="$(printf '%s\n' "${CRED_TSV}" | sort -t'|' -k2,2r)"
  _rank=0
  while IFS='|' read -r _k _s _e _d; do
    [ -n "${_k}" ] || continue
    _rank=$(( _rank + 1 ))
    _verdict=''
    _expired=0
    if _ee="$(iso_epoch "${_e}")"; then
      if [ "${_ee}" -lt "${NOW_EPOCH}" ]; then _expired=1; fi
    else
      _verdict="KEEP (expiry '${_e}' unparseable — never delete what cannot be evaluated)"
    fi
    if [ -z "${_verdict}" ] && [ "${_k}" = "${IN_USE_KEY_ID}" ]; then
      _verdict='KEEP (in use — recorded in Key Vault)'
    fi
    if [ -z "${_verdict}" ] && [ "${_rank}" -le "${PRUNE_KEEP}" ]; then
      _verdict="KEEP (one of the newest ${PRUNE_KEEP})"
    fi
    if [ -z "${_verdict}" ]; then
      if _se="$(iso_epoch "${_s}")"; then
        _age_days=$(( (NOW_EPOCH - _se) / 86400 ))
        if [ "${_age_days}" -lt "${PRUNE_MIN_AGE_DAYS}" ]; then
          _verdict="KEEP (minted ${_age_days}d ago, inside the ${PRUNE_MIN_AGE_DAYS}d grace)"
          PRUNE_HELD_BY_GRACE=$(( PRUNE_HELD_BY_GRACE + 1 ))
        elif [ -n "${IN_USE_START_EPOCH}" ] && [ "${_se}" -ge "${IN_USE_START_EPOCH}" ]; then
          _verdict='KEEP (not older than the in-use credential — not provably superseded)'
        elif [ "${PRUNE_EXPIRED_ONLY}" -eq 1 ] && [ "${_expired}" -ne 1 ]; then
          _verdict='KEEP (still valid, and this run may only remove already-expired credentials)'
        fi
      else
        _verdict="KEEP (start '${_s}' unparseable)"
      fi
    fi
    if [ -z "${_verdict}" ]; then
      PRUNE_CANDIDATES="${PRUNE_CANDIDATES}${_k}
"
      printf '    PRUNE  %s  start %s  end %s  label %s\n' "${_k}" "${_s}" "${_e}" "${_d}"
    else
      PRUNE_KEPT=$(( PRUNE_KEPT + 1 ))
      printf '    keep   %s  start %s  end %s  label %s  — %s\n' "${_k}" "${_s}" "${_e}" "${_d}" "${_verdict}"
    fi
  done <<< "${CRED_SORTED}"
fi

PRUNE_N="$(printf '%s' "${PRUNE_CANDIDATES}" | count_nonempty)"
# P5 — the retained set is computed before any delete, and never reaches zero.
if [ "${PRUNE_N}" -gt 0 ] && [ "${PRUNE_KEPT}" -lt 1 ]; then
  echo "    REFUSING to prune: the computed keep set is empty, which would leave the app registration with no credential at all. This is a bug in the candidate logic, not a state to act on." >&2
  PRUNE_CANDIDATES=''
  PRUNE_N=0
fi

if [ "${PRUNE_N}" -eq 0 ]; then
  echo "    nothing to prune (${PRUNE_KEPT} credential(s) retained)"
  # An estate cleaning up EXISTING sprawl will usually land here on the first
  # run: the accumulated credentials were minted within days of each other, so
  # every one is inside the grace. Saying so is the difference between a
  # working no-op and a prune that looks broken.
  if [ "${PRUNE_HELD_BY_GRACE}" -gt 0 ]; then
    echo "    ${PRUNE_HELD_BY_GRACE} of them are held ONLY by the ${PRUNE_MIN_AGE_DAYS}-day grace window."
    echo "    The grace is a safety margin for consumers this script cannot see; the console's own"
    echo "    binding is already proven separately (P3/P3b above). To clean up an existing backlog,"
    echo "    re-run the DRY RUN with a shorter window, review it, then authorize:"
    echo "      LOOM_MSAL_PRUNE_MIN_AGE_DAYS=1 …            # dry run, shows what would go"
    echo "      LOOM_MSAL_PRUNE_MIN_AGE_DAYS=1 LOOM_MSAL_PRUNE=1 …"
  fi
elif [ "${PRUNE_ENABLED}" -ne 1 ]; then
  echo "    DRY RUN — ${PRUNE_N} credential(s) above are marked PRUNE and were NOT deleted."
  echo "    Review the key ids and dates, then authorize the prune by re-running with"
  echo "      LOOM_MSAL_PRUNE=1   (or the --prune flag)"
  echo "    Key ids and dates are the only credential data printed here; no secret value is ever read or logged."
else
  PRUNE_FAILED=0
  while IFS= read -r _k; do
    [ -n "${_k}" ] || continue
    if az ad app credential delete --id "${APP_ID}" --key-id "${_k}"; then
      echo "    deleted superseded credential ${_k}"
    else
      PRUNE_FAILED=$(( PRUNE_FAILED + 1 ))
      echo "    ERROR: could not delete credential ${_k} (the signed-in principal may lack Application Administrator on ${APP_ID})." >&2
    fi
  done <<< "${PRUNE_CANDIDATES}"
  if [ "${PRUNE_FAILED}" -gt 0 ]; then
    echo "    ERROR: ${PRUNE_FAILED} of ${PRUNE_N} deletions FAILED. Sign-in is wired and unaffected — the in-use credential was never a candidate — but the cleanup did not complete and superseded credentials remain live." >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------
# CEILING (#3335) — the regression alarm, asserted on the LIVE count.
#
# This is the check that makes a reuse regression visible. If the reuse gate
# above is ever removed or bypassed, the mint rate returns to one per deploy —
# MEASURED at 11 deploys in a single day — and this trips within about a day.
# It has no opt-out flag, no `|| true`, and no `continue-on-error` wrapper: a
# hygiene check that cannot fail measures nothing.
#
# It runs LAST on purpose. Everything sign-in depends on has already succeeded
# by this point, so a non-zero exit here means "the estate works, the credential
# hygiene does not" — never "sign-in is broken".
#
# The default (12) is an INTERIM ceiling: the live Commercial registration
# carried 9 credentials when this was written and the steady state under these
# rules is PRUNE_KEEP + 1 = 3. Lower it to 3 in the same change that lands the
# first operator-authorized prune.
# ---------------------------------------------------------------------
if ! FINAL_TSV="$(az ad app credential list --id "${APP_ID}" --query "[].keyId" -o tsv)"; then
  echo "    ERROR: could not read the final credential count of ${APP_ID}, so the hygiene ceiling could not be asserted. An unmeasured ceiling is not a passed ceiling." >&2
  exit 1
fi
FINAL_COUNT="$(printf '%s\n' "${FINAL_TSV}" | tr -d ' \r' | count_nonempty)"
if [ "${FINAL_COUNT}" -gt "${CREDENTIAL_CEILING}" ]; then
  echo "::error::MSAL credential ceiling exceeded on ${APP_ID}: ${FINAL_COUNT} live password credentials, ceiling ${CREDENTIAL_CEILING} (#3335)."
  echo "    Sign-in IS wired and working — this failure is credential hygiene, not availability."
  echo "    Long-lived credentials are accumulating, which means the reuse gate is not taking effect."
  echo "    Inspect (metadata only, no values):"
  echo "      az ad app credential list --id ${APP_ID} --query \"[].{keyId:keyId,start:startDateTime,end:endDateTime,label:displayName}\" -o table"
  echo "    Then either re-run with LOOM_MSAL_PRUNE=1 to remove the superseded ones, or"
  echo "    find why every run is minting (the reuse gate needs the ${MSAL_SECRET_NAME} msalKeyId tag)."
  exit 1
fi
echo "    ${FINAL_COUNT} live credential(s), within the ceiling of ${CREDENTIAL_CEILING}"

echo "==> Done. App (client) id: ${APP_ID}"
echo "    NOTE: a Global/Application Administrator may still need to grant admin"
echo "    consent for the app's Graph permissions in Entra ID → App registrations."
echo "LOOM_MSAL_CLIENT_ID=${APP_ID}"
