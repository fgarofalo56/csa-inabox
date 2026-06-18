// =====================================================================
// CSA Loom — Entra app registration (MSAL) provisioner
// =====================================================================
// Day-one deploy-readiness (PRP deploy-readiness gaps #2 + #3, GH #1383).
//
// A fresh Loom deploy used to ship with NO usable MSAL credential:
//   • loomMsalClientId defaulted to a hardcoded shared app reg (or empty);
//   • loomMsalClientSecret defaulted empty → the confidential client had no
//     secret → interactive login returned an opaque 500;
//   • even when a shared app was used, its redirect URIs never matched the new
//     console host (each deploy gets a unique Front Door / vanity FQDN) →
//     AADSTS redirect_uri mismatch.
//
// This module makes the app registration a REAL, provisioned-by-default backend.
// The Entra app registration is a Microsoft Graph object (not ARM), so it is
// created/reconciled by an `azCLI` deploymentScript running under a
// user-assigned identity that already holds the Graph permissions + the
// Application Administrator directory role (granted out-of-band by the
// post-deploy bootstrap — see scripts/csa-loom/bootstrap-msal-app-reg.sh,
// which is the SAME logic so the bicep and workflow homes never drift).
//
// IDEMPOTENT: find-by-display-name → create if absent → always reconcile the
// web redirect URIs to the current console host(s) + localhost → enable public
// client flows (device-code CLI login) → ensure delegated Graph User.Read →
// reset the client secret → write the secret (and a stable SESSION_SECRET) to
// Key Vault. Re-running is safe (every step is a PUT/upsert).
//
// HONEST GATE (consistent with ai-search.bicep deployGovernanceIndex): the
// deploymentScript only runs when a `scriptIdentityId` with Graph app-admin is
// supplied. Key Vault is private-endpoint locked, so a public ACI cannot write
// its secrets — pass `scriptSubnetId` to VNet-inject the script so it can reach
// the KV private endpoint. When no identity is supplied the module is a no-op
// and the post-deploy bootstrap workflow provisions the app registration
// instead (the default push-button path). Either way the FLAG
// (loomMsalAppRegEnabled) is ON by default — the app registration is never an
// un-provisioned, un-configured surprise on first login.

targetScope = 'resourceGroup'

@description('Primary region for the deployment script ACI.')
param location string

@description('Region override for the deployment script (ACI quota).')
param scriptLocation string = location

@description('Display name for the Entra app registration (must be stable across redeploys so find-by-name is idempotent). e.g. "CSA Loom Console (rg-csa-loom-admin)".')
param appDisplayName string

@description('Console host(s) (comma-separated, no scheme) whose https://<host>/auth/callback redirect URIs are reconciled onto the app — Front Door host, vanity domain, app-gateway FQDN. localhost:3000 is always added for local dev. Empty is allowed (only localhost) — the post-deploy bootstrap adds the runtime FQDN.')
param consoleHosts string = ''

@description('Use-existing override: when set, this app (client) id is reconciled instead of creating a new registration. The script only updates redirect URIs / flags if the script identity owns the app.')
param existingClientId string = ''

@description('User-assigned identity resource id for the deployment script. MUST hold Microsoft Graph Application.ReadWrite.OwnedBy + the Application Administrator directory role (so az ad app create/update/credential-reset succeed) AND Key Vault Secrets Officer on the target vault. Empty → the script is skipped and the post-deploy bootstrap provisions the app registration instead.')
param scriptIdentityId string = ''

@description('Subnet resource id to VNet-inject the deployment script so it can reach the private-endpoint-locked Key Vault data plane to write the secrets. Empty → the script runs on public ACI (Graph works, but the KV secret write requires the vault to allow the script egress; otherwise use the bootstrap path).')
param scriptSubnetId string = ''

@description('Key Vault name the client secret + SESSION_SECRET are written to.')
param keyVaultName string

@description('KV secret name for the MSAL client secret (Container App reads it as a keyVaultUrl secretRef).')
param msalSecretName string = 'loom-msal-client-secret'

@description('KV secret name for the session signing secret (stable, generated once).')
param sessionSecretName string = 'session-secret'

@description('Forces the script to re-run when changed (e.g. on a redeploy you want to re-reconcile redirect URIs). Defaults to a per-template value so a normal redeploy re-reconciles.')
param forceUpdateTag string = utcNow()

@description('Compliance tags.')
param complianceTags object = {}

var runScript = !empty(scriptIdentityId)

resource appRegScript 'Microsoft.Resources/deploymentScripts@2023-08-01' = if (runScript) {
  name: 'script-loom-msal-app-reg'
  location: scriptLocation
  tags: complianceTags
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${scriptIdentityId}': {}
    }
  }
  properties: {
    azCliVersion: '2.61.0'
    retentionInterval: 'PT1H'
    timeout: 'PT15M'
    forceUpdateTag: forceUpdateTag
    cleanupPreference: 'OnSuccess'
    // VNet-inject when a subnet is supplied so the KV (private-endpoint locked)
    // data-plane secret writes succeed. The container needs a storage account
    // for VNet-injected scripts; ARM auto-provisions one when subnetIds is set.
    containerSettings: empty(scriptSubnetId) ? null : {
      subnetIds: [
        { id: scriptSubnetId }
      ]
    }
    environmentVariables: [
      { name: 'APP_DISPLAY_NAME', value: appDisplayName }
      { name: 'CONSOLE_HOSTS', value: consoleHosts }
      { name: 'EXISTING_CLIENT_ID', value: existingClientId }
      { name: 'KEYVAULT_NAME', value: keyVaultName }
      { name: 'MSAL_SECRET_NAME', value: msalSecretName }
      { name: 'SESSION_SECRET_NAME', value: sessionSecretName }
    ]
    scriptContent: '''
set -euo pipefail
GRAPH_RA='[{"resourceAppId":"00000003-0000-0000-c000-000000000000","resourceAccess":[{"id":"e1fe6dd8-ba31-4d61-89e7-88639da4683d","type":"Scope"}]}]'

if [ -n "${EXISTING_CLIENT_ID:-}" ]; then
  APP_ID="$EXISTING_CLIENT_ID"
  echo "Using existing app registration: $APP_ID"
else
  APP_ID=$(az ad app list --filter "displayName eq '$APP_DISPLAY_NAME'" --query "[0].appId" -o tsv 2>/dev/null || true)
  if [ -z "${APP_ID:-}" ]; then
    echo "Creating app registration '$APP_DISPLAY_NAME'"
    APP_ID=$(az ad app create --display-name "$APP_DISPLAY_NAME" --sign-in-audience AzureADMyOrg --query appId -o tsv)
    # Allow Entra to replicate the new object before subsequent updates.
    sleep 20
  else
    echo "Reusing app registration '$APP_DISPLAY_NAME': $APP_ID"
  fi
fi

# Reconcile web redirect URIs by MERGING the computed set with the app's CURRENT
# redirect URIs (never overwrite). INCIDENT 2026-06-17: overwriting with only the
# computed set (derived from the ACA ingress FQDN passed in CONSOLE_HOSTS) dropped
# the Azure Front Door callback that real users hit → AADSTS50011 redirect-URI
# mismatch → login dead. Union + dedupe keeps any already-correct Front Door host.
REDIRECTS=()
IFS=',' read -ra HOSTS <<< "${CONSOLE_HOSTS:-}"
for h in "${HOSTS[@]}"; do
  h=$(echo "$h" | tr -d ' ')
  [ -n "$h" ] && REDIRECTS+=("https://$h/auth/callback")
done
REDIRECTS+=("http://localhost:3000/auth/callback")
CURRENT_REDIRECTS=$(az ad app show --id "$APP_ID" --query "web.redirectUris" -o tsv 2>/dev/null || true)
while IFS= read -r r; do
  r=$(echo "$r" | tr -d ' \r')
  [ -n "$r" ] && REDIRECTS+=("$r")
done <<< "$CURRENT_REDIRECTS"
MERGED_REDIRECTS=()
for r in "${REDIRECTS[@]}"; do
  dup=0
  for seen in "${MERGED_REDIRECTS[@]:-}"; do [ "$seen" = "$r" ] && { dup=1; break; }; done
  [ "$dup" -eq 0 ] && MERGED_REDIRECTS+=("$r")
done
echo "Reconciling redirect URIs: ${MERGED_REDIRECTS[*]}"
az ad app update --id "$APP_ID" --web-redirect-uris "${MERGED_REDIRECTS[@]}" || echo "WARN: redirect-uri update failed (app may be owned elsewhere)"

# CONFIDENTIAL web app — it authenticates with a client secret, so it must NOT be
# a fallback public client. INCIDENT 2026-06-17: isFallbackPublicClient=true made
# Entra treat the client as public and reject the client_secret at token exchange
# → AADSTS700025 → login dead. Keep it false. Plus delegated Graph User.Read.
az ad app update --id "$APP_ID" --set isFallbackPublicClient=false || echo "WARN: isFallbackPublicClient update failed"
az ad app update --id "$APP_ID" --required-resource-accesses "$GRAPH_RA" || echo "WARN: required-resource-accesses update failed"

# Reset the client secret (2-year lifetime) and persist to Key Vault.
SECRET=$(az ad app credential reset --id "$APP_ID" --years 2 --query password -o tsv)
az keyvault secret set --vault-name "$KEYVAULT_NAME" --name "$MSAL_SECRET_NAME" --value "$SECRET" -o none
echo "Wrote $MSAL_SECRET_NAME to $KEYVAULT_NAME"

# Stable SESSION_SECRET — generate once, never rotate on redeploy (so sessions
# survive). Only write when absent.
EXISTING_SS=$(az keyvault secret show --vault-name "$KEYVAULT_NAME" --name "$SESSION_SECRET_NAME" --query value -o tsv 2>/dev/null || true)
if [ -z "${EXISTING_SS:-}" ]; then
  SS=$(openssl rand -hex 32)
  az keyvault secret set --vault-name "$KEYVAULT_NAME" --name "$SESSION_SECRET_NAME" --value "$SS" -o none
  echo "Generated + wrote $SESSION_SECRET_NAME"
else
  echo "$SESSION_SECRET_NAME already present — preserved"
fi

echo "{\"appId\":\"$APP_ID\"}" > "$AZ_SCRIPTS_OUTPUT_PATH"
'''
  }
}

@description('The provisioned/reconciled Entra app (client) id. Empty when the script did not run (no script identity) — callers fall back to the bootstrap-provisioned value.')
output appId string = runScript ? appRegScript!.properties.outputs.appId : ''

@description('True when this module provisioned the app registration + wrote the secrets to Key Vault (so callers can KV-back the Container App secretRefs).')
output provisioned bool = runScript
