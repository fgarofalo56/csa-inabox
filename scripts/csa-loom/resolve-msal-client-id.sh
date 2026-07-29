#!/usr/bin/env bash
# =====================================================================
# CSA Loom — resolve the estate's EXISTING Entra (MSAL) app-registration
# client id, for re-runs of the push-button deploy.
# =====================================================================
# svc-loom-unity-authz (round 2). An Entra app registration is a Microsoft Graph
# object; ARM/bicep cannot create one. Deploy phase 3
# (scripts/csa-loom/bootstrap-msal-app-reg.sh) creates it and stamps
# LOOM_MSAL_CLIENT_ID + the Loom Unity audience onto the running Container Apps.
#
# The problem this script fixes: every LATER `az deployment sub create` re-renders
# the whole ACA template from `readEnvironmentVariable('LOOM_MSAL_CLIENT_ID','')`.
# With that env unset the template renders an EMPTY client id, which
#   * blanks the Console's LOOM_MSAL_CLIENT_ID (sign-in breaks), and
#   * re-SEALS the Loom Unity catalog (authMode=entra with no pinnable audience
#     ⇒ sentinel `.invalid` audience, zero replicas, every caller rejected),
# silently undoing phase 3. A declarative ACA template removes any env var it does
# not declare, so this is not hypothetical.
#
# Resolution order (first non-empty wins), all READ-ONLY:
#   1. $LOOM_MSAL_CLIENT_ID already in the environment (explicit operator/CI value)
#   2. Key Vault secret `loom-msal-client-id` in the estate's admin Key Vault
#      (written by bootstrap-msal-app-reg.sh)
#   3. The LOOM_MSAL_CLIENT_ID env var on the live Console Container App
#      (covers estates bootstrapped before the Key Vault record existed)
#
# Prints the client id on stdout (empty string when there is none — a genuinely
# fresh subscription). NEVER fails the caller: an empty result is the correct
# answer on a first deploy, and the catalog then deploys sealed rather than open.
#
# Usage:
#   CID=$(bash scripts/csa-loom/resolve-msal-client-id.sh)          # auto-discover
#   CID=$(bash scripts/csa-loom/resolve-msal-client-id.sh --rg rg-csa-loom-admin-eastus2)
#   echo "LOOM_MSAL_CLIENT_ID=$CID" >> "$GITHUB_ENV"
# =====================================================================
set -uo pipefail

RG="${LOOM_ADMIN_RG:-}"
KV="${LOOM_ADMIN_KEYVAULT:-}"
CONSOLE_APP="${CONSOLE_APP_NAME:-loom-console}"
SECRET_NAME="${MSAL_CLIENT_ID_SECRET_NAME:-loom-msal-client-id}"

while [ $# -gt 0 ]; do
  case "$1" in
    --rg) RG="${2:-}"; shift 2 ;;
    --keyvault) KV="${2:-}"; shift 2 ;;
    --console-app) CONSOLE_APP="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

log() { echo "[resolve-msal-client-id] $*" >&2; }

# 1 — already supplied.
if [ -n "${LOOM_MSAL_CLIENT_ID:-}" ]; then
  log "using LOOM_MSAL_CLIENT_ID from the environment"
  printf '%s' "${LOOM_MSAL_CLIENT_ID}"
  exit 0
fi

# Discover the admin resource group when not given.
if [ -z "${RG}" ]; then
  RG="$(az group list --query "[?starts_with(name,'rg-csa-loom-admin-')].name | [0]" -o tsv 2>/dev/null | tr -d '\r')"
fi
if [ -z "${RG}" ]; then
  log "no rg-csa-loom-admin-* resource group in this subscription — fresh estate, no app registration yet"
  printf ''
  exit 0
fi

# 2 — Key Vault record (the durable one bootstrap-msal-app-reg.sh writes).
if [ -z "${KV}" ]; then
  KV="$(az keyvault list -g "${RG}" --query "[0].name" -o tsv 2>/dev/null | tr -d '\r')"
fi
if [ -n "${KV}" ]; then
  CID="$(az keyvault secret show --vault-name "${KV}" --name "${SECRET_NAME}" --query value -o tsv 2>/dev/null | tr -d '\r')"
  if [ -n "${CID:-}" ]; then
    log "resolved from Key Vault ${KV}/${SECRET_NAME}"
    printf '%s' "${CID}"
    exit 0
  fi
fi

# 3 — the live Console Container App (pre-Key-Vault estates).
CID="$(az containerapp show -n "${CONSOLE_APP}" -g "${RG}" \
  --query "properties.template.containers[0].env[?name=='LOOM_MSAL_CLIENT_ID'].value | [0]" \
  -o tsv 2>/dev/null | tr -d '\r')"
if [ -n "${CID:-}" ] && [ "${CID}" != "None" ]; then
  log "resolved from the live ${CONSOLE_APP} Container App (consider re-running bootstrap-msal-app-reg.sh so it is also recorded in Key Vault)"
  printf '%s' "${CID}"
  exit 0
fi

log "no existing app registration found in ${RG} — the deploy will render an empty client id (Loom Unity deploys SEALED until deploy phase 3 runs)"
printf ''
exit 0
