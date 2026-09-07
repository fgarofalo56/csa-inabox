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
# INCIDENT PATH — rotate after a compromise, then revoke (#3637). Full runbook:
# docs/fiab/runbooks/secret-rotation.md §2.2b. Two RUNS, never one:
#   --rotate            Mint a replacement even though the recorded credential
#                       is healthy — the reuse gate below is skipped
#                       UNCONDITIONALLY. Records msalRotateReason on the Key
#                       Vault secret, re-wires + rolls the console, then STOPS.
#                       Deletes nothing. (env: LOOM_MSAL_ROTATE=1)
#   --rotate-reason <s> Recorded as the msalRotateReason tag; default
#                       "unspecified". (env: LOOM_MSAL_ROTATE_REASON)
#   --revoke <key-id>   Delete exactly that credential, bypassing the hygiene
#                       grace, but ONLY after this run proves a NEWER credential
#                       is what the console serves — then asserts it is gone.
#                       (env: LOOM_MSAL_REVOKE_KEY_ID)
#                       A revoke REQUESTED with no key id (bare `--revoke`,
#                       `--revoke "$UNSET"`, `--revoke=`, or
#                       LOOM_MSAL_REVOKE_KEY_ID defined as an empty string)
#                       exits 1 before any Entra or Key Vault call. To run the
#                       ordinary bootstrap with no revoke, leave the variable
#                       UNSET rather than empty.
# The two flags together are REFUSED: the revision --rotate rolls is not Healthy
# when this script exits, so the credential named for revocation may still be
# the one in service. Verify sign-in between the runs.
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
# INCIDENT PATH (#3637) — rotate-after-compromise, and the revoke that follows.
#
# THE GAP THIS CLOSES. Everything above optimises for NOT minting: the reuse
# gate deliberately does nothing while the recorded credential has more than
# LOOM_MSAL_SECRET_MIN_REMAINING_DAYS left, and the prune deliberately protects
# anything inside the grace window. Both are correct for hygiene and both are
# EXACTLY WRONG after a disclosure. A credential that leaked at 09:00 has ~300
# days left, so every re-run of this script printed REUSE and kept serving it,
# and the prune's 7-day grace protected it from removal. There was no argument
# and no flag that changed either answer — the operator's only route was to
# hand-run `az ad app credential reset`/`delete`, i.e. the untested path, during
# an incident.
#
#   --rotate            Skip the reuse gate UNCONDITIONALLY and say so. Mints
#                       through the same validated `--append` path, records
#                       msalRotateReason on the Key Vault secret, re-wires and
#                       rolls the console IF one was supplied, then STOPS. It
#                       deletes NOTHING: the rolling revision is still serving
#                       the old credential until it goes Healthy, so removing it
#                       here is the stranding failure the whole design avoids.
#                       The receipt states which of the two it did — a rotation
#                       with no CONSOLE_APP_NAME/CONSOLE_RG rolls nothing, and
#                       says so rather than implying a revision exists.
#   --revoke <key-id>   Delete exactly that credential, bypassing the hygiene
#                       grace, but ONLY after this run has proven a NEWER
#                       credential is what the console serves. Then re-reads the
#                       inventory and asserts the key id is gone.
#
# THE TWO ARE DELIBERATELY SEPARATE INVOCATIONS. Between them the operator
# verifies sign-in on the new credential (docs/fiab/runbooks/secret-rotation.md
# §2.2b). A single flag that rotated and revoked in one pass would delete the
# credential the console is still serving during the revision roll.
#
# WHAT --revoke DOES NOT ESTABLISH, stated rather than implied (R7): it proves
# what the CONSOLE serves — the Key Vault msalKeyId tag, an unversioned Key
# Vault reference, and every active revision post-dating the Key Vault write. A
# consumer that captured the raw value out of band is invisible to this script
# and WILL start failing the moment the delete lands. That is the intended trade
# for a disclosed credential, and it is irreversible: Entra does not return a
# deleted password credential's value, so there is no undo.
# ---------------------------------------------------------------------
ROTATE="${LOOM_MSAL_ROTATE:-0}"
ROTATE_REASON="${LOOM_MSAL_ROTATE_REASON:-unspecified}"

# REQUESTED and TARGETED are two different facts, and collapsing them into one
# empty string is how a destructive flag comes to succeed at nothing.
#
# The first cut keyed the whole revoke path on `[ -n "${REVOKE_KEY_ID}" ]`. So
# `--revoke` with no value — or the far more likely `--revoke "$KID"` with KID
# unset — parsed to an EMPTY id, skipped the revoke block entirely, ran the
# ordinary bootstrap to the end and printed the normal "==> Done." banner with
# exit 0. An operator mid-incident reads that as "the leaked credential is
# gone". It is still live. The symmetric guard already existed for --rotate
# (REUSED=1 refuses rather than printing a success banner over a no-op); the
# destructive half had none.
#
# So intent is tracked separately from the target, and a requested revoke with
# no target REFUSES. `+x` rather than `:-`: an env var DEFINED but empty is a
# caller that meant to name a credential and passed nothing, which is exactly
# the silent case. Leaving LOOM_MSAL_REVOKE_KEY_ID UNSET is how you say "no
# revoke" — the refusal message says so, because a workflow author wiring an
# optional input needs that answer at the moment it fires.
REVOKE_REQUESTED=0
REVOKE_KEY_ID=''
if [ -n "${LOOM_MSAL_REVOKE_KEY_ID+x}" ]; then
  REVOKE_REQUESTED=1
  REVOKE_KEY_ID="${LOOM_MSAL_REVOKE_KEY_ID}"
fi

# ---------------------------------------------------------------------
# OPT-IN: Power BI remote MCP (preview). OFF unless --enable-powerbi-mcp (or
# LOOM_ENABLE_POWERBI_MCP truthy). no-fabric-dependency: this is the ONLY place
# the bootstrap touches Power BI, and only when explicitly opted in. The
# Azure-native authoring path stays the day-one default with this OFF.
# ---------------------------------------------------------------------
ENABLE_POWERBI_MCP="${LOOM_ENABLE_POWERBI_MCP:-0}"
# A `while … shift` loop, not the previous `for arg in "$@"`: `--revoke` takes a
# VALUE, and a value-taking flag cannot be parsed by a loop that never advances.
# Unknown arguments are still ignored, as they were before.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --enable-powerbi-mcp) ENABLE_POWERBI_MCP=1 ;;
    --no-powerbi-mcp)     ENABLE_POWERBI_MCP=0 ;;
    --prune)              PRUNE_ENABLED=1 ;;
    --dry-run-prune)      PRUNE_ENABLED=0 ;;
    --adopt-inferred)     ADOPT_INFERRED=1 ;;
    --rotate)             ROTATE=1 ;;
    --rotate=*)           ROTATE=1; ROTATE_REASON="${1#--rotate=}" ;;
    --rotate-reason)      shift; ROTATE_REASON="${1:-}" ;;
    --rotate-reason=*)    ROTATE_REASON="${1#--rotate-reason=}" ;;
    --revoke)
      # Consume the next token ONLY when it is a real value. `--revoke --prune`
      # used to shift --prune into the key id, which both lost the --prune the
      # operator asked for and turned a missing target into a bogus one; a key
      # id is a GUID and can never begin with `--`, so a flag-shaped follower is
      # an absent value, and it is left in place for the loop to parse normally.
      REVOKE_REQUESTED=1
      case "${2:-}" in
        ''|--*) : ;;
        *)      REVOKE_KEY_ID="$2"; shift ;;
      esac ;;
    --revoke=*)           REVOKE_REQUESTED=1; REVOKE_KEY_ID="${1#--revoke=}" ;;
  esac
  shift || break
done
# Tag values land inside a hand-built JSON body, so anything that could close a
# string or escape it is removed here rather than trusted.
ROTATE_REASON="$(printf '%s' "${ROTATE_REASON}" | tr -d '"\\\r\n' | cut -c1-200)"
REVOKE_KEY_ID="$(printf '%s' "${REVOKE_KEY_ID}" | tr -d ' \r')"

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
case "$(printf '%s' "${ROTATE}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) ROTATE=1 ;;
  *)             ROTATE=0 ;;
esac

# CONFIG INVARIANT — a requested revoke with no target REFUSES.
# This must precede the rotate/revoke combination check below: "you named no
# credential" is the more specific and more useful answer than "these two flags
# conflict", and it has to fire before any Entra or Key Vault call so the run
# has provably done nothing when it exits.
if [ "${REVOKE_REQUESTED}" -eq 1 ] && [ -z "${REVOKE_KEY_ID}" ]; then
  echo "ERROR: a revoke was requested but NO credential key id was given, so NOTHING was revoked and nothing else was done — this run exits before any Entra or Key Vault call. Do not read this as a completed revocation: whatever credential you meant to remove is still live." >&2
  echo "       Cause, one of: \`--revoke\` with no following value; \`--revoke \"\$KID\"\` where KID is unset or empty; \`--revoke=\`; a value that was only whitespace; or LOOM_MSAL_REVOKE_KEY_ID defined as an empty string." >&2
  echo "       To revoke, name the key id explicitly:" >&2
  echo "         bash scripts/csa-loom/bootstrap-msal-app-reg.sh --revoke <key-id>" >&2
  echo "       List the candidates (metadata only, no values):" >&2
  echo "         az ad app credential list --id <app-id> --query \"[].{keyId:keyId,start:startDateTime,end:endDateTime,label:displayName}\" -o table" >&2
  echo "       To run the ordinary bootstrap with NO revoke, leave LOOM_MSAL_REVOKE_KEY_ID UNSET (omit the variable entirely — an empty value is read as a revoke whose target went missing, not as 'no revoke')." >&2
  exit 1
fi

# CONFIG INVARIANT — rotate and revoke are two RUNS, never one.
# --rotate mints a replacement and rolls the console onto it; that revision is
# not Healthy when this process exits, so the credential named by --revoke may
# still be the one in service. Deleting it in the same pass is the stranding
# failure every other rule in this file exists to prevent. Refuse rather than
# pick an order.
if [ "${ROTATE}" -eq 1 ] && [ "${REVOKE_REQUESTED}" -eq 1 ]; then
  echo "ERROR: --rotate and --revoke cannot be combined. --rotate mints a replacement and rolls the console onto it, but that revision is not yet Healthy when this script exits — so the credential you asked to revoke may still be the one being served. Run --rotate, VERIFY sign-in on the new credential (docs/fiab/runbooks/secret-rotation.md §2.2b), then run --revoke ${REVOKE_KEY_ID}." >&2
  exit 1
fi

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
      # THE REUSE GATE IS SKIPPED UNCONDITIONALLY UNDER --rotate (#3637), and
      # the health of the outgoing credential is REPORTED rather than consulted.
      # That is the whole point: a disclosed credential is perfectly healthy by
      # every measure this gate applies, so consulting them is what kept serving
      # it. Deliberately BEFORE the remaining-days test so the ordering cannot
      # drift into "rotate unless it still looks fine".
      if [ "${ROTATE}" -eq 1 ]; then
        echo "    ROTATE — --rotate given, so the reuse gate is SKIPPED for credential ${_kid} (label ${_label}, minted ${_start}) even though it is healthy: expires ${_end}, ${REMAIN_DAYS} days away, threshold ${MIN_REMAINING_DAYS}. Minting a replacement. Reason recorded: ${ROTATE_REASON}."
        echo "           NOTHING is deleted by this run. ${_kid} stays live and valid until you revoke it explicitly:  --revoke ${_kid}"
      elif [ "${REMAIN_DAYS}" -gt "${MIN_REMAINING_DAYS}" ]; then
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
elif [ "${ROTATE}" -eq 1 ]; then
  # No recorded in-use credential, so nothing was going to be reused anyway —
  # this run mints regardless. Said out loud so a --rotate receipt never leaves
  # the reader guessing whether the flag took effect.
  echo "    ROTATE — --rotate given; there is no recorded in-use credential to skip, so this run mints for the ordinary reason. Reason recorded: ${ROTATE_REASON}."
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
    # PROVENANCE, and under --rotate the REASON with it (#3637). msalRotateReason
    # is written on the Key Vault secret rather than as a Container App env var
    # for the reason recorded at the LOOM_MSAL_SECRET_ROTATED removal below: an
    # env var is re-rendered away by the next `az deployment sub create`, and a
    # rotation marker that vanishes reads during triage as "never rotated". A
    # Key Vault tag survives every redeploy.
    _prov_tags="{\"msalKeyId\":\"${NEW_KEY_ID}\",\"msalAppId\":\"${APP_ID}\",\"msalCredentialLabel\":\"${CRED_LABEL}\",\"msalProvenance\":\"minted\"}"
    if [ "${ROTATE}" -eq 1 ]; then
      _prov_tags="{\"msalKeyId\":\"${NEW_KEY_ID}\",\"msalAppId\":\"${APP_ID}\",\"msalCredentialLabel\":\"${CRED_LABEL}\",\"msalProvenance\":\"rotated\",\"msalRotateReason\":\"${ROTATE_REASON}\",\"msalRotatedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"msalRotatedFrom\":\"${IN_USE_KEY_ID:-unknown}\"}"
    fi
    kv_secret_put "${MSAL_SECRET_NAME}" "${SECRET}" "${_prov_tags}" || exit 1
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
#
# "Optionally" is load-bearing for the receipt below. CONSOLE_APP_NAME/CONSOLE_RG
# are documented optional, so this whole block is skippable — and when it is
# skipped NOTHING was re-wired and NO revision was rolled. The --rotate receipt
# used to assert the roll unconditionally, so it has to be able to tell.
CONSOLE_ROLLED=0
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
    # Set ONLY here: the sole point at which this script has a zero exit from the
    # command that creates the new revision. Every other path either skipped the
    # block or exits 1 below.
    CONSOLE_ROLLED=1
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

# --- ROTATE STOPS HERE (#3637) -------------------------------------------
# A rotation run does the mint, the Key Vault write and the console roll — and
# then NOTHING else. Three reasons, none of them stylistic:
#
#   1. It must not delete. The revision rolled above is not Healthy yet, so the
#      OLD credential is still what live replicas present. The prune below would
#      never pick it (it is inside the grace and is one of the newest), but
#      "the rule happens not to fire" is not a safety property — not reaching
#      the delete path at all is.
#   2. The ceiling below EXITS 1 on a count over the limit. A rotation
#      deliberately ADDS a credential, so during an incident the ceiling would
#      fail a run whose rotation actually succeeded, and the operator would read
#      a non-zero exit as "the rotation did not work". Wrong answer at the worst
#      moment.
#   3. The receipt stays unambiguous: one run, one thing done, one next step.
#
# What this run did NOT establish, said plainly (R7): whether the rolled
# revision has reached Healthy, and whether interactive sign-in works on the new
# credential. Neither is observable from here — verify before revoking.
#
# And the receipt BRANCHES on whether a revision was rolled AT ALL. The wiring
# block above is gated on CONSOLE_APP_NAME + CONSOLE_RG, both documented
# optional; the receipt below was not, so a rotate run without them printed
# "whether the rolled revision is Healthy" — naming a roll that never happened
# and asserting as fact something this run did not establish (deploy-integrity
# R7). That is the worse half of the two states, because the honest reading of
# "not verified Healthy" is "it was rolled, go check it", when the truth is that
# the new credential is sitting in Key Vault with nothing serving it.
if [ "${ROTATE}" -eq 1 ]; then
  echo "==> ROTATE COMPLETE for ${APP_ID}"
  if [ "${REUSED}" -eq 1 ]; then
    # Belt and braces. Reaching here with REUSED=1 would mean the gate skip
    # above did not take effect, i.e. --rotate silently did nothing — the exact
    # defect #3637 records. Fail rather than print a success banner over it.
    echo "    ERROR: --rotate was given but this run REUSED the existing credential and minted nothing. That is the #3637 defect, not a rotation. Refusing to report success." >&2
    exit 1
  fi
  echo "    new credential ${IN_USE_KEY_ID:-<key id unresolved>} is recorded in ${MSAL_SECRET_NAME} (msalRotateReason=${ROTATE_REASON})."
  echo "    NOTHING was deleted. Every previously-issued credential is still live and still valid."
  if [ "${CONSOLE_ROLLED}" -eq 1 ]; then
    echo "    CONSOLE ROLLED: a new revision of ${CONSOLE_APP_NAME} (${CONSOLE_RG}) was requested and the"
    echo "    update returned success, so the console is configured to serve the new credential."
    echo "    NOT VERIFIED BY THIS RUN: whether that rolled revision is Healthy, and whether"
    echo "    interactive sign-in succeeds on the new credential. This process cannot observe either."
    echo "    NEXT: verify sign-in (docs/fiab/runbooks/secret-rotation.md §2.2b), then revoke the"
    echo "    disclosed credential explicitly — deletion is IRREVERSIBLE, Entra never returns the value:"
    echo "      bash scripts/csa-loom/bootstrap-msal-app-reg.sh --revoke <key-id>"
  else
    # Reaching here with CONSOLE_ROLLED=0 can mean ONE thing only: the wiring
    # block was never entered, because it is gated on both names and every path
    # INSIDE it either sets CONSOLE_ROLLED=1 or exits 1. So "no Container App
    # was supplied" is established, not inferred — but which of the two is
    # missing is not, so it is reported rather than assumed (R7).
    echo "    CONSOLE NOT ROLLED: no Container App was supplied (CONSOLE_APP_NAME=${CONSOLE_APP_NAME:-<unset>},"
    echo "    CONSOLE_RG=${CONSOLE_RG:-<unset>}; the re-wire needs BOTH), so this run re-wired NOTHING and"
    echo "    rolled NO revision. NOTHING IS SERVING THE NEW CREDENTIAL YET — it exists in Entra and is"
    echo "    recorded in ${MSAL_SECRET_NAME}, and that is all."
    echo "    The console is still presenting whatever it was presenting before this run, which after a"
    echo "    disclosure means it is still presenting the COMPROMISED credential."
    echo "    Do NOT proceed to --revoke on this state: it will refuse anyway (the console-binding"
    echo "    proof cannot be established), and revoking what is still in service is the outage."
    echo "    NEXT, to make the rotation take effect — either re-run with the console named:"
    echo "      CONSOLE_APP_NAME=<app> CONSOLE_RG=<rg> bash scripts/csa-loom/bootstrap-msal-app-reg.sh --rotate --rotate-reason ${ROTATE_REASON}"
    echo "    or roll it out of band, which requires the app's loom-msal-client-secret to be an"
    echo "    unversioned Key Vault reference (otherwise it re-serves the stale literal):"
    echo "      az containerapp update -n <app> -g <rg> --set-env-vars LOOM_MSAL_CLIENT_ID=${APP_ID} LOOM_MSAL_CLIENT_SECRET=secretref:${MSAL_SECRET_NAME}"
  fi
  echo "    Credential inventory (metadata only, no values):"
  echo "      az ad app credential list --id ${APP_ID} --query \"[].{keyId:keyId,start:startDateTime,end:endDateTime,label:displayName}\" -o table"
  exit 0
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
# #3339 fix 1 — the DEDICATED catalog app registration.
#
# The section directly above ensures `api://<sign-in app>` exists, because that
# is the audience the catalogs accept TODAY. That is the defect, not the fix:
# admin-plane/main.bicep passed `entraClientId: effectiveMsalClientId` to BOTH
# iceberg-catalog and loom-unity, the sign-in registration carries
# `appRoles: []` / `oauth2PermissionScopes: []`, and
# apps/loom-unity/bin/loom-entrypoint.sh derives the accepted audiences as
# `api://<clientId>,<clientId>` — so ANY interactive console sign-in token is
# also a valid catalog subject token, and the catalog has no claim with which to
# express who may call it.
#
# The answer is a SECOND, dedicated Entra application with its own App ID URI
# and its own appRoles. It is created by the sibling script, never here, and the
# sign-in application object above is NEVER written to by it: every recorded
# outage in this area (the 2026-07-19 MSAL secret outage, #3335's credential
# sprawl) came from writing to that object, and the whole point of a dedicated
# registration is that the two objects have independent lifecycles. The sibling
# takes SIGN_IN_APP_ID purely as a REFUSAL GUARD — if what it resolved turns out
# to be this same object it aborts without writing anything.
#
# ORDER. This runs AFTER every sign-in step and BEFORE the credential ceiling,
# on purpose: sign-in is already wired by this point, so nothing here can affect
# it, and a credential-hygiene backlog tripping the ceiling must not stop the
# catalog registration from being provisioned.
#
# WHY THIS DOES NOT `exit 1` — deploy-integrity.md R7, not convenience. The only
# caller (.github/workflows/csa-loom-post-deploy-bootstrap.yml) answers a
# non-zero exit from this script with a fixed `::error::MSAL app-reg
# provisioning FAILED … every sign-in returns AADSTS7000215`. That sentence
# would be FALSE for a catalog-registration failure, and a false cause is what
# sent two investigations down the wrong path in the incident that rule records.
# So the outcome is CLASSIFIED and reported here in its own words, and it is
# machine-readable on stdout — `LOOM_CATALOG_CLIENT_ID=<id>` on success,
# `LOOM_CATALOG_APP_REG=failed` on failure — so a caller can branch on it
# without inheriting the wrong error string. Nothing is discarded and nothing is
# silenced: the sibling's own stdout and stderr pass straight through.
#
# Opt out with LOOM_CATALOG_APP_REG=0 (default-ON per loom_default_on_opt_out).
# ---------------------------------------------------------------------
CATALOG_APP_REG="${LOOM_CATALOG_APP_REG:-1}"
case "$(printf '%s' "${CATALOG_APP_REG}" | tr '[:upper:]' '[:lower:]')" in
  0|false|no|off) CATALOG_APP_REG=0 ;;
  *)              CATALOG_APP_REG=1 ;;
esac

if [ "${CATALOG_APP_REG}" -eq 1 ]; then
  echo "==> Provisioning the DEDICATED catalog app registration (#3339 fix 1)"
  CATALOG_SCRIPT="$(dirname "$0")/bootstrap-catalog-app-reg.sh"
  if [ ! -f "${CATALOG_SCRIPT}" ]; then
    echo "    ERROR: ${CATALOG_SCRIPT} is not in this checkout, so the dedicated catalog app registration was NOT provisioned. Sign-in IS wired and unaffected. Until it is created and pinned as loomBackends.unityAudienceClientId, the catalogs keep accepting the SIGN-IN app's audience — the #3339 trust boundary stays collapsed." >&2
    echo "LOOM_CATALOG_APP_REG=failed"
  else
    # The Console UAMI's OBJECT id, so the sibling can grant it
    # Catalog.ReadWrite on the new resource app. Without that grant Entra
    # refuses a client-credentials token for api://<catalog app>/.default
    # altogether, and pinning the new audience would take the catalog from
    # "wrongly reachable" to "not reachable at all". The sibling refuses to
    # persist the client id when it cannot make the grant, so an unreadable
    # identity here degrades to "app created, not pinnable" — never to a pin
    # that breaks the estate.
    CONSOLE_UAMI_OID=''
    if [ -n "${UAMI_RESOURCE_ID:-}" ]; then
      if UAMI_OID_OUT="$(az identity show --ids "${UAMI_RESOURCE_ID}" --query principalId -o tsv 2>&1)"; then
        CONSOLE_UAMI_OID="$(printf '%s' "${UAMI_OID_OUT}" | tr -d ' \r')"
      else
        echo "    WARNING: could not read the principal id of ${UAMI_RESOURCE_ID}. This is an ARM read; it failing means the identity is unreadable from here, NOT that it does not exist. The catalog app will still be created, but with no app-role assignment — so it must not be pinned yet." >&2
        printf '%s\n' "${UAMI_OID_OUT}" | head -3 >&2
      fi
    else
      echo "    NOTE: UAMI_RESOURCE_ID was not supplied, so no Console identity can be granted the catalog role. The app registration is still created; it must not be pinned until the grant exists."
    fi
    if KEYVAULT_NAME="${KEYVAULT_NAME}" \
       SIGN_IN_APP_ID="${APP_ID}" \
       CONSOLE_UAMI_PRINCIPAL_ID="${CONSOLE_UAMI_OID}" \
       bash "${CATALOG_SCRIPT}"; then
      echo "    dedicated catalog app registration reconciled"
    else
      echo "    ERROR: the dedicated catalog app registration did NOT complete — read the sibling's output above for the specific step and its remediation. Sign-in IS wired and working; this failure is the #3339 trust boundary, not availability. Until the app exists, is granted to the Console identity, and is pinned as loomBackends.unityAudienceClientId, iceberg-catalog and loom-unity keep accepting the console SIGN-IN app's audience." >&2
      echo "LOOM_CATALOG_APP_REG=failed"
    fi
  fi
else
  echo "==> Dedicated catalog app registration SKIPPED (LOOM_CATALOG_APP_REG=0)."
  echo "    iceberg-catalog and loom-unity therefore keep accepting the console SIGN-IN app's"
  echo "    audience: every interactive sign-in token stays a valid catalog subject token (#3339)."
  echo "LOOM_CATALOG_APP_REG=skipped"
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

# ---------------------------------------------------------------------
# REVOKE (#3637) — delete ONE named credential, now, because it is burnt.
#
# HOW THIS DIFFERS FROM THE PRUNE, and why it is not just "prune with a
# narrower filter": the prune answers "what is provably superseded and safe to
# tidy", so it deliberately KEEPS the newest N and holds anything inside
# LOOM_MSAL_PRUNE_MIN_AGE_DAYS. A disclosed credential is usually BOTH recent
# and among the newest, which is exactly why no prune configuration could ever
# remove it — the operator's only route was hand-running `az`.
#
# THE SAFETY CHAIN, link by link, and which links are DESIGNED vs INCIDENTAL —
# because "prune would not have picked it anyway" is an accident, not a control:
#
#   DESIGNED  R1  The key id must exist on the app right now. A revoke against
#                 an id that is not there is reported as already-absent, never
#                 as a successful deletion.
#   DESIGNED  R2  It must NOT be the credential Key Vault records as in use.
#                 This is the direct stranding guard and it refuses outright.
#   DESIGNED  R3  The in-use credential must be STRICTLY NEWER than the one
#                 being revoked. "A newer credential is what the console serves"
#                 is the actual precondition; R2 alone would allow revoking a
#                 credential minted AFTER the one in service.
#   DESIGNED  R4  The console binding must be PROVEN — the same P3/P3b evidence
#                 the prune requires (unversioned Key Vault reference to this
#                 secret, and every active revision post-dating the Key Vault
#                 write). Reusing that computation rather than re-deriving it is
#                 deliberate: two spellings of one proof drift apart.
#   DESIGNED  R5  The deletion is ASSERTED afterwards by re-reading the
#                 inventory. `az ad app credential delete` exiting 0 is not
#                 evidence the credential is gone.
#   NOT A CONTROL The age grace (LOOM_MSAL_PRUNE_MIN_AGE_DAYS) and the keep
#                 window are BYPASSED here on purpose, and that is stated in the
#                 output rather than hidden. They protect consumers this script
#                 cannot see; a disclosed credential is worth breaking them for.
#
# WHAT THIS CANNOT ESTABLISH (R7): whether some other consumer holds the raw
# value. It cannot, so it says so instead of implying the delete is safe for
# everyone. And the delete is IRREVERSIBLE — Entra never returns a deleted
# password credential's value, so there is no restore, only another rotation.
# ---------------------------------------------------------------------
# Keyed on the REQUEST, not on the id being non-empty. By here an empty id has
# already exited 1 above, so the two are equivalent today — but keying on intent
# means a future edit that lets an empty id through lands in this block and hits
# R1's explicit refusal, instead of silently falling through to the ordinary
# bootstrap and its success banner. That fall-through was the defect.
if [ "${REVOKE_REQUESTED}" -eq 1 ]; then
  echo "==> REVOKE requested for credential ${REVOKE_KEY_ID} on ${APP_ID}"
  REVOKE_LINE="$(cred_line "${REVOKE_KEY_ID}" "${CRED_TSV}")"
  if [ -z "${REVOKE_LINE}" ]; then
    echo "    ERROR: ${APP_ID} has no password credential with key id ${REVOKE_KEY_ID}. This run did NOT delete anything, and it cannot tell you whether that id was already removed or never existed — the inventory read at the top of this run shows only what is present NOW. Current inventory (metadata only):" >&2
    printf '%s\n' "${CRED_TSV}" | sed 's/^/      /' >&2
    exit 1
  fi
  IFS='|' read -r _rk _rs _re _rd <<< "${REVOKE_LINE}"
  echo "    target: ${_rk}  start ${_rs}  end ${_re}  label ${_rd}"

  # R2 — never the credential Key Vault records as in use.
  if [ "${IN_USE_KNOWN}" -ne 1 ] || [ -z "${IN_USE_KEY_ID}" ]; then
    echo "    REFUSING to revoke: this run could not establish which credential the estate is configured to present (the ${MSAL_SECRET_NAME} msalKeyId tag is absent or unreadable — see above). Deleting a credential without knowing what is in service is the stranding failure, and 'probably not this one' is not a proof. Re-run without --revoke first so provenance is recorded, then revoke." >&2
    exit 1
  fi
  if [ "${REVOKE_KEY_ID}" = "${IN_USE_KEY_ID}" ]; then
    echo "    REFUSING to revoke: ${REVOKE_KEY_ID} IS the credential ${MSAL_SECRET_NAME} records as in use, so deleting it takes sign-in down immediately (AADSTS7000215). Rotate first — that mints a replacement and rolls the console onto it — then revoke this one:" >&2
    echo "      bash scripts/csa-loom/bootstrap-msal-app-reg.sh --rotate --rotate-reason <why>" >&2
    echo "      # verify sign-in, then:" >&2
    echo "      bash scripts/csa-loom/bootstrap-msal-app-reg.sh --revoke ${REVOKE_KEY_ID}" >&2
    exit 1
  fi

  # R3 — the in-use credential must be strictly NEWER than the target.
  REVOKE_START_EPOCH=''
  if ! REVOKE_START_EPOCH="$(iso_epoch "${_rs}")"; then
    echo "    REFUSING to revoke: the start time '${_rs}' of ${REVOKE_KEY_ID} could not be parsed, so 'the credential in service is newer than this one' cannot be evaluated. Never delete what cannot be evaluated." >&2
    exit 1
  fi
  if [ -z "${IN_USE_START_EPOCH}" ]; then
    echo "    REFUSING to revoke: the start time of the in-use credential ${IN_USE_KEY_ID} could not be established this run (see the DISARMED note above), so 'a newer credential is what the console serves' is unproven." >&2
    exit 1
  fi
  if [ "${IN_USE_START_EPOCH}" -le "${REVOKE_START_EPOCH}" ]; then
    echo "    REFUSING to revoke: ${REVOKE_KEY_ID} (minted ${_rs}) is NOT older than the in-use credential ${IN_USE_KEY_ID}. The precondition is that a NEWER credential is already what the console serves; here the target is the same age or newer, so removing it may be removing the successor rather than the superseded one." >&2
    exit 1
  fi

  # R4 — the console binding proof, reused verbatim from P3/P3b above.
  if [ "${PRUNE_ARMED}" -ne 1 ] || [ "${PRUNE_EXPIRED_ONLY}" -eq 1 ]; then
    echo "    REFUSING to revoke: what the console actually serves is NOT proven this run (the P3/P3b lines above say why — an unreadable binding, an inline or version-pinned secret, or an active revision that predates the current Key Vault version). The Key Vault tag records what the estate is CONFIGURED to present; without the binding proof it does not establish what running replicas are presenting. Fix the binding, or roll the console onto the current secret, then revoke." >&2
    exit 1
  fi

  echo "    PROCEEDING. ${IN_USE_KEY_ID} (minted after ${_rs}) is proven to be what the console serves; ${REVOKE_KEY_ID} is older and is not it."
  echo "    This BYPASSES the ${PRUNE_MIN_AGE_DAYS}-day hygiene grace and the keep window ON PURPOSE — they exist"
  echo "    for consumers this script cannot see, and a disclosed credential is worth breaking them for."
  echo "    NOT ESTABLISHED by this run: whether anything outside the console holds this credential's raw"
  echo "    value. Anything that does will start failing the moment the delete lands."
  echo "    IRREVERSIBLE: Entra does not return a deleted password credential's value. There is no undo,"
  echo "    only another rotation."
  if ! az ad app credential delete --id "${APP_ID}" --key-id "${REVOKE_KEY_ID}"; then
    echo "    ERROR: the delete of ${REVOKE_KEY_ID} on ${APP_ID} FAILED (the signed-in principal may lack Application Administrator, or Application.ReadWrite.OwnedBy plus ownership). The credential is presumed STILL LIVE — this run cannot confirm otherwise. Sign-in is unaffected." >&2
    exit 1
  fi

  # R5 — assert it is GONE. A zero exit from `credential delete` is not evidence.
  if ! REVOKE_AFTER_TSV="$(az ad app credential list --id "${APP_ID}" --query "[].keyId" -o tsv)"; then
    echo "    ERROR: the delete command succeeded but the inventory could NOT be re-read, so this run cannot confirm ${REVOKE_KEY_ID} is gone. Unconfirmed is not done. Verify manually: az ad app credential list --id ${APP_ID} --query \"[].keyId\" -o tsv" >&2
    exit 1
  fi
  REVOKE_AFTER_TSV="$(printf '%s' "${REVOKE_AFTER_TSV}" | tr -d ' \r')"
  if printf '%s\n' "${REVOKE_AFTER_TSV}" | grep -qx -- "${REVOKE_KEY_ID}"; then
    echo "    ERROR: ${REVOKE_KEY_ID} is STILL present on ${APP_ID} after a delete that reported success. Do not treat this credential as revoked." >&2
    exit 1
  fi
  echo "    REVOKED — ${REVOKE_KEY_ID} is confirmed absent from ${APP_ID} (re-read after the delete)."
  echo "    $(printf '%s\n' "${REVOKE_AFTER_TSV}" | count_nonempty) credential(s) remain, including the in-use ${IN_USE_KEY_ID}."
  echo "==> Done (revoke). App (client) id: ${APP_ID}"
  exit 0
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
