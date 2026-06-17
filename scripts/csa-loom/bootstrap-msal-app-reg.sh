#!/usr/bin/env bash
# =====================================================================
# CSA Loom — Entra app registration (MSAL) provisioner
# =====================================================================
# Day-one deploy-readiness (GH #1383). Idempotent: create-or-reuse the Loom
# Console Entra app registration, reconcile its redirect URIs to the live
# console host(s), enable public-client (device-code CLI) flows, ensure the
# delegated Microsoft Graph User.Read scope, reset the client secret, and
# persist both the client secret and a STABLE SESSION_SECRET to Key Vault.
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
GRAPH_RA="[{\"resourceAppId\":\"${GRAPH_APP_ID}\",\"resourceAccess\":[{\"id\":\"${GRAPH_USER_READ}\",\"type\":\"Scope\"}]}]"

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

echo "==> Reconciling redirect URIs"
REDIRECTS=()
IFS=',' read -ra HOSTS <<< "${CONSOLE_HOSTS}"
for h in "${HOSTS[@]}"; do
  h="$(echo "$h" | tr -d ' ')"
  [ -n "$h" ] && REDIRECTS+=("https://${h}/auth/callback")
done
REDIRECTS+=("http://localhost:3000/auth/callback")
echo "    ${REDIRECTS[*]}"
az ad app update --id "${APP_ID}" --web-redirect-uris "${REDIRECTS[@]}" || echo "    WARN: redirect-uri update failed (app owned elsewhere?)"

echo "==> Enabling public-client flows (device-code CLI) + delegated Graph User.Read"
az ad app update --id "${APP_ID}" --set isFallbackPublicClient=true || echo "    WARN: isFallbackPublicClient update failed"
az ad app update --id "${APP_ID}" --required-resource-accesses "${GRAPH_RA}" || echo "    WARN: required-resource-accesses update failed"

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
  if [ -n "${UAMI_RESOURCE_ID:-}" ]; then
    az containerapp secret set -n "${CONSOLE_APP_NAME}" -g "${CONSOLE_RG}" --secrets \
      "loom-msal-client-secret=keyvaultref:${KV_URI}secrets/${MSAL_SECRET_NAME},identityref:${UAMI_RESOURCE_ID}" \
      "session-secret=keyvaultref:${KV_URI}secrets/${SESSION_SECRET_NAME},identityref:${UAMI_RESOURCE_ID}" -o none || \
      echo "    WARN: KV-backed secret set failed; falling back to inline"
  else
    az containerapp secret set -n "${CONSOLE_APP_NAME}" -g "${CONSOLE_RG}" --secrets \
      "loom-msal-client-secret=${SECRET}" -o none || echo "    WARN: inline secret set failed"
  fi
  az containerapp update -n "${CONSOLE_APP_NAME}" -g "${CONSOLE_RG}" \
    --set-env-vars "LOOM_MSAL_CLIENT_ID=${APP_ID}" "LOOM_MSAL_CLIENT_SECRET=secretref:${MSAL_SECRET_NAME}" -o none || echo "    WARN: env-var update failed"
  echo "    wired LOOM_MSAL_CLIENT_ID=${APP_ID} + LOOM_MSAL_CLIENT_SECRET=secretref:${MSAL_SECRET_NAME}"
fi

echo "==> Done. App (client) id: ${APP_ID}"
echo "    NOTE: a Global/Application Administrator may still need to grant admin"
echo "    consent for the app's Graph permissions in Entra ID → App registrations."
echo "LOOM_MSAL_CLIENT_ID=${APP_ID}"
