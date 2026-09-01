#!/usr/bin/env bash
# =====================================================================
# CSA Loom — DEDICATED catalog Entra app registration (#3339 fix 1)
# =====================================================================
# Creates (or reuses) a SEPARATE Entra application that fronts the Loom
# catalog surfaces — `iceberg-catalog` (the Apache Iceberg REST Catalog) and
# `loom-unity` (the Unity Catalog OSS metastore) — with its OWN Application ID
# URI and its OWN appRoles, and grants the Console's managed identity the role
# it needs to call them.
#
# WHY THIS EXISTS (measured 2026-08-31, #3339 / #3110 §5)
# ------------------------------------------------------
# Both catalog Container Apps were handed the CONSOLE'S OWN SIGN-IN app
# registration as their Entra audience (`entraClientId: effectiveMsalClientId`
# in platform/fiab/bicep/modules/admin-plane/main.bicep), and
# apps/loom-unity/bin/loom-entrypoint.sh derives the audiences a catalog accepts
# as `api://<clientId>,<clientId>`. The sign-in registration carries
# `appRoles: []` and `oauth2PermissionScopes: []`. Two consequences:
#
#   1. EVERY interactive console sign-in token was also a valid catalog subject
#      token. The authentication identity and the catalog's API audience were
#      the same Entra object — a trust-boundary collapse, not a naming smell.
#   2. An API with no app roles and no scopes cannot EXPRESS who may call it.
#      There is no claim for the catalog to check, so "authorized" could only
#      ever mean "authenticated".
#
# WHAT THIS SCRIPT WILL NEVER DO
# ------------------------------
# It never writes to the sign-in application object. Not its redirect URIs, not
# its credentials, not its identifierUris, not its appRoles. Every recorded
# outage in this area came from touching that object (the 2026-07-19 MSAL secret
# outage; #3335's credential sprawl), and the whole point of a dedicated
# registration is that the two objects have independent lifecycles. If
# SIGN_IN_APP_ID is supplied and the app this script resolved turns out to BE
# that object, it ABORTS without writing anything.
#
# RELATIONSHIP TO THE DEPLOY
# --------------------------
# This script produces a value; the deploy consumes it. Nothing here mutates a
# running Container App, because a var set by `az containerapp update` is
# dropped by the next `az deployment sub create` (the #3025 class — a marker
# that disappears on the next deploy reads as "never set"). The durable handoff
# is the Key Vault secret written below plus the pin printed at the end:
#
#     loomBackends.unityAudienceClientId = <catalog app id>
#
# which admin-plane/main.bicep reads as `unityAudienceClientId` and threads to
# BOTH catalog module calls and to the Console's LOOM_ICEBERG_CATALOG_AUDIENCE /
# LOOM_UNITY_AUDIENCE. UNPINNED, that variable falls back to the sign-in app —
# i.e. exactly today's behaviour — so an estate that has not run this script is
# never made worse by the bicep half.
#
# FAILS CLOSED. Every step that cannot be completed exits non-zero and says what
# was and was not done. The caller (bootstrap-msal-app-reg.sh) invokes it
# advisory-only so a directory-permission failure here can never take sign-in
# wiring down, but a direct run is honest about its own outcome.
#
# Requires: Application Administrator (or Application.ReadWrite.OwnedBy +
# ownership) on the directory, and control-plane
# Microsoft.KeyVault/vaults/secrets/write on the vault.
#
# Env:
#   KEYVAULT_NAME                  REQUIRED. Vault the client id is persisted to.
#   CATALOG_APP_DISPLAY_NAME       default "CSA Loom Catalog (<KEYVAULT_NAME>)"
#   CATALOG_CLIENT_ID_SECRET_NAME  default loom-catalog-client-id
#   EXISTING_CATALOG_CLIENT_ID     reuse this app instead of resolving by name
#   CONSOLE_UAMI_PRINCIPAL_ID      object id of the Console UAMI. When set, it is
#                                  granted the Catalog.ReadWrite app role. The
#                                  Key Vault record is GATED on that grant, so
#                                  an unset value yields an app that exists but
#                                  is reported NOT pinnable.
#   SIGN_IN_APP_ID                 the sign-in app's client id. REFUSAL GUARD only.
#
# Stdout contract (read by the caller; never a secret):
#   LOOM_CATALOG_CLIENT_ID=<appId>   the dedicated app's client id
#   LOOM_CATALOG_PINNABLE=0|1        1 only when the Console identity holds
#                                    Catalog.ReadWrite AND the id was recorded in
#                                    Key Vault. Pinning on 0 would take the
#                                    catalog from wrongly-reachable to
#                                    unreachable.
# =====================================================================
set -euo pipefail

KEYVAULT_NAME="${KEYVAULT_NAME:?KEYVAULT_NAME is required}"
CATALOG_APP_DISPLAY_NAME="${CATALOG_APP_DISPLAY_NAME:-CSA Loom Catalog (${KEYVAULT_NAME})}"
CATALOG_CLIENT_ID_SECRET_NAME="${CATALOG_CLIENT_ID_SECRET_NAME:-loom-catalog-client-id}"
EXISTING_CATALOG_CLIENT_ID="${EXISTING_CATALOG_CLIENT_ID:-}"
CONSOLE_UAMI_PRINCIPAL_ID="${CONSOLE_UAMI_PRINCIPAL_ID:-}"
SIGN_IN_APP_ID="${SIGN_IN_APP_ID:-}"

# App role ids are per-application GUIDs. They are FIXED constants rather than
# generated, so a re-run of this script recognises the roles it created last
# time instead of minting a second pair with the same value.
ROLE_ID_READ='6d3c0d2a-8e2d-4a4a-9a35-0d64e5b3d5f1'
ROLE_ID_READWRITE='2f0f7b9c-1e2a-4f5b-9d6c-3a7e8b1c4d20'
ROLE_VALUE_READ='Catalog.Read'
ROLE_VALUE_READWRITE='Catalog.ReadWrite'

trim() { printf '%s' "$1" | tr -d ' \r' | sed 's/^None$//'; }

# ---------------------------------------------------------------------
# 1. Resolve or CREATE the dedicated application.
# ---------------------------------------------------------------------
echo "==> Resolving the dedicated catalog app registration '${CATALOG_APP_DISPLAY_NAME}'"
CATALOG_APP_ID=''
if [ -n "${EXISTING_CATALOG_CLIENT_ID}" ]; then
  CATALOG_APP_ID="$(trim "${EXISTING_CATALOG_CLIENT_ID}")"
  echo "    using the supplied catalog app (client) id: ${CATALOG_APP_ID}"
else
  # A directory READ that fails is UNKNOWN, never "the app does not exist"
  # (deploy-integrity.md R7). Creating a second registration because a read was
  # refused is precisely how duplicate app objects accumulate.
  if ! LIST_OUT="$(az ad app list --filter "displayName eq '${CATALOG_APP_DISPLAY_NAME}'" --query "[0].appId" -o tsv 2>&1)"; then
    echo "    ERROR: could not query the directory for '${CATALOG_APP_DISPLAY_NAME}'. This is a Microsoft Graph read; it failing means the signed-in principal cannot read application objects (it needs Application Administrator, or Application.ReadWrite.OwnedBy). It does NOT mean the app is absent, so nothing was created." >&2
    printf '%s\n' "${LIST_OUT}" | head -3 >&2
    exit 1
  fi
  CATALOG_APP_ID="$(trim "${LIST_OUT}")"
  if [ -z "${CATALOG_APP_ID}" ]; then
    echo "    creating a NEW app registration (the sign-in app is not touched)"
    if ! CREATE_OUT="$(az ad app create --display-name "${CATALOG_APP_DISPLAY_NAME}" --sign-in-audience AzureADMyOrg --query appId -o tsv 2>&1)"; then
      echo "    ERROR: could not create the catalog app registration '${CATALOG_APP_DISPLAY_NAME}'." >&2
      printf '%s\n' "${CREATE_OUT}" | head -3 >&2
      exit 1
    fi
    CATALOG_APP_ID="$(trim "${CREATE_OUT}")"
    if [ -z "${CATALOG_APP_ID}" ]; then
      echo "    ERROR: 'az ad app create' returned no appId for '${CATALOG_APP_DISPLAY_NAME}'. Refusing to continue against an unknown object." >&2
      exit 1
    fi
    sleep 20 # Entra replication, before the updates below
  else
    echo "    reusing the catalog app registration: ${CATALOG_APP_ID}"
  fi
fi

# ---------------------------------------------------------------------
# 2. THE REFUSAL GUARD. Everything below WRITES to ${CATALOG_APP_ID}. If that
#    resolved to the sign-in application — an operator passing the wrong
#    EXISTING_CATALOG_CLIENT_ID, or someone renaming the sign-in app to the
#    catalog display name — this script would be modifying the object whose
#    every past modification produced an outage. There is no reason to proceed
#    and no safe way to: the point of the change is that the two objects are
#    DIFFERENT.
# ---------------------------------------------------------------------
if [ -n "${SIGN_IN_APP_ID}" ] && [ "$(trim "${SIGN_IN_APP_ID}")" = "${CATALOG_APP_ID}" ]; then
  echo "    ERROR: the resolved catalog app id ${CATALOG_APP_ID} IS the console sign-in app registration. Refusing to write appRoles, an Application ID URI, or a role assignment onto the sign-in object — that is the exact collapse #3339 exists to undo. Nothing was changed. Supply a different EXISTING_CATALOG_CLIENT_ID, or clear it and let this script create a dedicated app." >&2
  exit 1
fi

# ---------------------------------------------------------------------
# 3. Application ID URI. Without it no client can request
#    `api://<catalog app id>/.default` at all, and the catalog cannot derive an
#    audience to accept.
# ---------------------------------------------------------------------
echo "==> Ensuring the Application ID URI api://${CATALOG_APP_ID}"
CURRENT_URIS=''
if ! CURRENT_URIS="$(az ad app show --id "${CATALOG_APP_ID}" --query "identifierUris" -o tsv 2>&1)"; then
  echo "    ERROR: could not read ${CATALOG_APP_ID}. The Application ID URI and appRoles were NOT reconciled." >&2
  printf '%s\n' "${CURRENT_URIS}" | head -3 >&2
  exit 1
fi
if printf '%s' "${CURRENT_URIS}" | tr -d '\r' | grep -qx "api://${CATALOG_APP_ID}"; then
  echo "    already present"
else
  if ! URI_OUT="$(az ad app update --id "${CATALOG_APP_ID}" --identifier-uris "api://${CATALOG_APP_ID}" -o none 2>&1)"; then
    echo "    ERROR: could not set the Application ID URI on ${CATALOG_APP_ID}. Without it a client cannot mint api://${CATALOG_APP_ID}/.default, so pinning this app as the catalog audience would SEAL the catalog rather than secure it. Not persisting the client id." >&2
    printf '%s\n' "${URI_OUT}" | head -3 >&2
    exit 1
  fi
  echo "    set api://${CATALOG_APP_ID}"
fi

# ---------------------------------------------------------------------
# 4. appRoles — the vocabulary the sign-in app never had.
#
#    APPLICATION-type roles (not delegated scopes): the caller is the Console's
#    managed identity minting a client-credentials token, which carries `roles`
#    and never `scp`. MERGED with whatever is already on the app: an operator
#    who added their own role must not lose it to this reconcile.
# ---------------------------------------------------------------------
echo "==> Ensuring the catalog appRoles (${ROLE_VALUE_READ}, ${ROLE_VALUE_READWRITE})"
if ! EXISTING_ROLES="$(az ad app show --id "${CATALOG_APP_ID}" --query "appRoles[].value" -o tsv 2>&1)"; then
  echo "    ERROR: could not read the current appRoles of ${CATALOG_APP_ID}. Refusing to overwrite an inventory this run could not measure." >&2
  printf '%s\n' "${EXISTING_ROLES}" | head -3 >&2
  exit 1
fi
EXISTING_ROLES="$(printf '%s' "${EXISTING_ROLES}" | tr -d ' \r')"
HAS_READ=0
HAS_RW=0
while IFS= read -r _rv; do
  [ "${_rv}" = "${ROLE_VALUE_READ}" ] && HAS_READ=1
  [ "${_rv}" = "${ROLE_VALUE_READWRITE}" ] && HAS_RW=1
done <<< "${EXISTING_ROLES}"

if [ "${HAS_READ}" -eq 1 ] && [ "${HAS_RW}" -eq 1 ]; then
  echo "    both roles already defined"
else
  # Read the FULL current array so the write is a merge, not a replacement.
  if ! CURRENT_ROLE_JSON="$(az ad app show --id "${CATALOG_APP_ID}" --query "appRoles" -o json 2>&1)"; then
    echo "    ERROR: could not read the appRoles array of ${CATALOG_APP_ID}; nothing was written." >&2
    printf '%s\n' "${CURRENT_ROLE_JSON}" | head -3 >&2
    exit 1
  fi
  ADDITIONS=''
  if [ "${HAS_READ}" -ne 1 ]; then
    ADDITIONS="{\"id\":\"${ROLE_ID_READ}\",\"isEnabled\":true,\"allowedMemberTypes\":[\"Application\"],\"value\":\"${ROLE_VALUE_READ}\",\"displayName\":\"Read the Loom catalog\",\"description\":\"Read namespaces, tables and Iceberg REST metadata from the Loom catalog.\"}"
  fi
  if [ "${HAS_RW}" -ne 1 ]; then
    [ -n "${ADDITIONS}" ] && ADDITIONS="${ADDITIONS},"
    ADDITIONS="${ADDITIONS}{\"id\":\"${ROLE_ID_READWRITE}\",\"isEnabled\":true,\"allowedMemberTypes\":[\"Application\"],\"value\":\"${ROLE_VALUE_READWRITE}\",\"displayName\":\"Read and write the Loom catalog\",\"description\":\"Create, alter and drop namespaces and tables in the Loom catalog, and read its Iceberg REST metadata.\"}"
  fi
  # `[]` / `null` are both real answers from Graph for an app with no roles.
  case "$(printf '%s' "${CURRENT_ROLE_JSON}" | tr -d ' \n\r')" in
    ''|'[]'|'null') MERGED_ROLES="[${ADDITIONS}]" ;;
    *)              MERGED_ROLES="$(printf '%s' "${CURRENT_ROLE_JSON}" | sed 's/[[:space:]]*\]$//')"
                    MERGED_ROLES="${MERGED_ROLES},${ADDITIONS}]" ;;
  esac
  if ! ROLE_OUT="$(az ad app update --id "${CATALOG_APP_ID}" --app-roles "${MERGED_ROLES}" -o none 2>&1)"; then
    echo "    ERROR: could not write the appRoles onto ${CATALOG_APP_ID}. The app exists and has its Application ID URI, but it still cannot express WHO may call the catalog, so this run does not claim the trust boundary is closed." >&2
    printf '%s\n' "${ROLE_OUT}" | head -3 >&2
    exit 1
  fi
  echo "    wrote appRoles (merged with ${EXISTING_ROLES:-none} already present)"
fi

# ---------------------------------------------------------------------
# 5. The service principal. A resource app with no SP in this tenant cannot be
#    an audience at all — a client-credentials request for
#    api://<appId>/.default is answered AADSTS500011 "resource principal not
#    found". Creating it is what makes the pin usable.
# ---------------------------------------------------------------------
echo "==> Ensuring the catalog service principal"
CATALOG_SP_OID=''
if SP_OUT="$(az ad sp show --id "${CATALOG_APP_ID}" --query id -o tsv 2>&1)"; then
  CATALOG_SP_OID="$(trim "${SP_OUT}")"
  echo "    present: ${CATALOG_SP_OID}"
else
  if ! SP_CREATE="$(az ad sp create --id "${CATALOG_APP_ID}" --query id -o tsv 2>&1)"; then
    echo "    ERROR: no service principal exists for ${CATALOG_APP_ID} and one could not be created. Pinning this app as the catalog audience would make every token request fail with AADSTS500011, so the client id is NOT being persisted." >&2
    printf '%s\n' "${SP_CREATE}" | head -3 >&2
    exit 1
  fi
  CATALOG_SP_OID="$(trim "${SP_CREATE}")"
  echo "    created: ${CATALOG_SP_OID}"
  sleep 10
fi

# ---------------------------------------------------------------------
# 6. Grant the Console's managed identity Catalog.ReadWrite.
#
#    This is the half that makes the dedicated audience USABLE rather than
#    merely separate: with `.default` on a resource, Entra issues a token to a
#    daemon client only when that client holds an app-role assignment on the
#    resource. Without this step, pinning the new audience would take the
#    catalog path from "wrongly reachable" to "not reachable at all".
#
#    Sovereign-safe: the Graph host is read from the signed-in cloud, never
#    assumed to be graph.microsoft.com (cloud-parity.md).
# ---------------------------------------------------------------------
CATALOG_PINNABLE=0
if [ -n "${CONSOLE_UAMI_PRINCIPAL_ID}" ]; then
  echo "==> Granting ${ROLE_VALUE_READWRITE} to the Console managed identity ${CONSOLE_UAMI_PRINCIPAL_ID}"
  GRAPH_HOST=''
  if GRAPH_OUT="$(az cloud show --query endpoints.microsoftGraphResourceId -o tsv 2>&1)"; then
    GRAPH_HOST="$(printf '%s' "${GRAPH_OUT}" | tr -d ' \r')"
  fi
  case "${GRAPH_HOST}" in https://*) : ;; *) GRAPH_HOST='https://graph.microsoft.com/' ;; esac
  GRAPH_HOST="${GRAPH_HOST%/}"
  ASSIGN_URL="${GRAPH_HOST}/v1.0/servicePrincipals/${CONSOLE_UAMI_PRINCIPAL_ID}/appRoleAssignments"

  EXISTING_ASSIGN=''
  if ! EXISTING_ASSIGN="$(az rest --method GET --url "${ASSIGN_URL}" \
        --query "value[?resourceId=='${CATALOG_SP_OID}' && appRoleId=='${ROLE_ID_READWRITE}'] | [0].id" -o tsv 2>&1)"; then
    echo "    ERROR: could not read the existing app-role assignments of ${CONSOLE_UAMI_PRINCIPAL_ID}. Whether the grant exists is UNKNOWN, so this run neither creates a duplicate nor claims the grant is in place." >&2
    printf '%s\n' "${EXISTING_ASSIGN}" | head -3 >&2
    exit 1
  fi
  EXISTING_ASSIGN="$(trim "${EXISTING_ASSIGN}")"
  if [ -n "${EXISTING_ASSIGN}" ]; then
    echo "    already granted (assignment ${EXISTING_ASSIGN})"
    CATALOG_PINNABLE=1
  else
    ASSIGN_BODY="{\"principalId\":\"${CONSOLE_UAMI_PRINCIPAL_ID}\",\"resourceId\":\"${CATALOG_SP_OID}\",\"appRoleId\":\"${ROLE_ID_READWRITE}\"}"
    if ! ASSIGN_OUT="$(az rest --method POST --url "${ASSIGN_URL}" --headers "Content-Type=application/json" --body "${ASSIGN_BODY}" -o none 2>&1)"; then
      echo "    ERROR: could not grant ${ROLE_VALUE_READWRITE} on ${CATALOG_APP_ID} to ${CONSOLE_UAMI_PRINCIPAL_ID}. Pinning loomBackends.unityAudienceClientId=${CATALOG_APP_ID} WITHOUT this grant would stop the Console minting a catalog token at all, so the client id is NOT being persisted. Remediation: the signed-in principal needs Application Administrator (or AppRoleAssignment.ReadWrite.All) in this tenant." >&2
      printf '%s\n' "${ASSIGN_OUT}" | head -3 >&2
      exit 1
    fi
    echo "    granted ${ROLE_VALUE_READWRITE} (appRoleId ${ROLE_ID_READWRITE}) on ${CATALOG_SP_OID}"
    CATALOG_PINNABLE=1
  fi
else
  echo "==> CONSOLE_UAMI_PRINCIPAL_ID not supplied — no app-role assignment was made."
  echo "    The dedicated app exists and can express authorization, but NOTHING holds"
  echo "    ${ROLE_VALUE_READWRITE} yet. Do NOT pin loomBackends.unityAudienceClientId until the"
  echo "    Console identity is granted it, or the Console will be unable to mint a"
  echo "    catalog token at all."
fi

# ---------------------------------------------------------------------
# 7. Persist the client id — ONLY when it is safe to pin.
#
#    Same ARM control-plane path, and the same reason, as loom-msal-client-id in
#    the sibling bootstrap: the Loom vault is publicNetworkAccess=Disabled and
#    the data plane is unreachable from a public runner. A client id is not a
#    secret; this is a durable RECORD so a later deploy can resolve the pin
#    instead of re-deriving an empty one.
#
#    GATED ON THE GRANT, deliberately. This secret exists to be read back and
#    turned into `loomBackends.unityAudienceClientId`. Recording an id that
#    NOTHING is authorized to call would be recording a trap: pinning it takes
#    the catalog from "wrongly reachable" (today's defect) to "not reachable at
#    all" (an outage), because Entra issues a `.default` client-credentials
#    token only to a client holding an app-role assignment on the resource. The
#    app registration itself is still created and reported — the run is not
#    wasted; it is just not yet pinnable, and says so.
# ---------------------------------------------------------------------
if [ "${CATALOG_PINNABLE}" -ne 1 ]; then
  echo "==> NOT persisting ${CATALOG_CLIENT_ID_SECRET_NAME}: the Console identity does not hold ${ROLE_VALUE_READWRITE} on ${CATALOG_APP_ID}."
  echo "    The app registration IS provisioned, with its Application ID URI and appRoles."
  echo "    What is missing is the app-role assignment that makes it usable, so the id is"
  echo "    deliberately not recorded as pinnable. Re-run with CONSOLE_UAMI_PRINCIPAL_ID set"
  echo "    to the Console UAMI's object id (the sibling bootstrap derives it from"
  echo "    UAMI_RESOURCE_ID) to complete it."
  echo "==> Done. Dedicated catalog app (client) id: ${CATALOG_APP_ID}"
  echo "LOOM_CATALOG_CLIENT_ID=${CATALOG_APP_ID}"
  echo "LOOM_CATALOG_PINNABLE=0"
  exit 0
fi

echo "==> Persisting ${CATALOG_CLIENT_ID_SECRET_NAME} to ${KEYVAULT_NAME}"
if ! KV_ARM_ID="$(az keyvault show --name "${KEYVAULT_NAME}" --query id -o tsv 2>&1)"; then
  echo "    ERROR: could not resolve the ARM id of Key Vault '${KEYVAULT_NAME}'. This is a control-plane read; it failing means the vault does not exist under this subscription or the identity cannot see it — NOT that the vault is network-blocked. The app registration IS provisioned; only the record of it is missing." >&2
  printf '%s\n' "${KV_ARM_ID}" | head -3 >&2
  exit 1
fi
KV_ARM_ID="$(trim "${KV_ARM_ID}")"
if ! KV_PUT="$(az rest --method PUT \
      --url "https://management.azure.com${KV_ARM_ID}/secrets/${CATALOG_CLIENT_ID_SECRET_NAME}?api-version=2023-07-01" \
      --body "{\"properties\":{\"value\":\"${CATALOG_APP_ID}\"}}" -o none 2>&1)"; then
  echo "    ERROR: could not write ${CATALOG_CLIENT_ID_SECRET_NAME} to ${KEYVAULT_NAME} via ARM. The app registration IS provisioned (${CATALOG_APP_ID}); what is missing is the durable record a later deploy reads back. Requires Microsoft.KeyVault/vaults/secrets/write." >&2
  printf '%s\n' "${KV_PUT}" | head -3 >&2
  exit 1
fi
echo "    wrote ${CATALOG_CLIENT_ID_SECRET_NAME}=${CATALOG_APP_ID}"

echo "==> Done. Dedicated catalog app (client) id: ${CATALOG_APP_ID}"
echo "    Pin it on the next deployment so the catalog stops accepting sign-in tokens:"
echo "      param observabilityConfig = { backendOverrides: { unityAudienceClientId: '${CATALOG_APP_ID}' } }"
echo "    platform/fiab/bicep/main.bicep unions that over loomBackends, and"
echo "    admin-plane/main.bicep threads it to iceberg-catalog, loom-unity and the"
echo "    Console's LOOM_ICEBERG_CATALOG_AUDIENCE / LOOM_UNITY_AUDIENCE."
echo "LOOM_CATALOG_CLIENT_ID=${CATALOG_APP_ID}"
echo "LOOM_CATALOG_PINNABLE=1"
