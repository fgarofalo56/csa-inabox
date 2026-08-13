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

@description('Lifetime in YEARS of a newly minted MSAL client secret (#3335). Default 1, not 2: the script now RENEWS automatically once a credential is inside msalMinRemainingDays of expiry, so a shorter lifetime shortens the exposure of any single credential without risking the expiry outage a long gap used to hide. Raise it for an estate that redeploys less often than that renewal window.')
@minValue(1)
@maxValue(2)
param msalSecretYears int = 1

@description('Renew when the recorded credential has fewer than this many days left (#3335). MUST be well under msalSecretYears*365 or every run mints a replacement — which is the credential-sprawl defect itself.')
@minValue(7)
@maxValue(180)
param msalMinRemainingDays int = 90

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
      // #3335 — same contract as scripts/csa-loom/bootstrap-msal-app-reg.sh
      // (LOOM_MSAL_SECRET_YEARS / LOOM_MSAL_SECRET_MIN_REMAINING_DAYS). Stated
      // in the template rather than left to a shell default so the credential
      // lifetime this estate mints is visible in the deployment, not implied.
      { name: 'MSAL_SECRET_YEARS', value: string(msalSecretYears) }
      { name: 'MSAL_MIN_REMAINING_DAYS', value: string(msalMinRemainingDays) }
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

# GROUPS CLAIM (#3175). Without this Entra emits NO `groups` claim at all, and
# every group-based authorization path in Loom is dead on arrival: tenant admin
# by group can never succeed, capability grants to a group never match, and item
# ACLs granted to a group never match. The console half (reading the claim in the
# auth callback) is useless without this half, and vice versa.
# SecurityGroup = security groups + directory roles, which is what Loom binds.
if az ad app update --id "$APP_ID" --set groupMembershipClaims=SecurityGroup; then
  echo "groupMembershipClaims=SecurityGroup set on $APP_ID"
else
  # Not silently swallowed: if this fails, group-based authz stays dead and the
  # only working admin path is the single-user LOOM_TENANT_ADMIN_OID bootstrap.
  echo "::warning::groupMembershipClaims update FAILED on $APP_ID — Entra will emit no groups claim, so group-based authorization (tenant admin by group, capability grants to a group, group item ACLs) will NOT work. Set it by hand: az ad app update --id $APP_ID --set groupMembershipClaims=SecurityGroup"
fi

# CREDENTIAL LIFECYCLE (#3335) — must stay identical in intent to
# scripts/csa-loom/bootstrap-msal-app-reg.sh, which is the home that actually
# runs on every estate today. Two defects lived here:
#
#   1. A BARE `az ad app credential reset` (no --append). Per the az help,
#      "By default, this command clears all passwords and keys" — so this line
#      DELETED every credential the app had, including the one the running
#      console was still serving, producing AADSTS7000215 from the instant it
#      ran until the next revision roll. The sibling script has carried
#      --append since that was understood; this copy never got it.
#   2. Minting unconditionally, which is the #3335 sprawl (measured: 9 live
#      credentials, 5 minted in one day, each --years 2).
#
# The fix is the same contract as the sibling: the `msalKeyId` TAG on the Key
# Vault secret records WHICH credential the estate presents, so provenance is
# readable without ever reading the secret value. When that credential is still
# on the app and not near expiry, mint nothing.
#
# THE PRUNE DELIBERATELY DOES NOT LIVE HERE. A deploymentScript runs
# unattended inside an ARM deployment with no operator reviewing a dry run, and
# it cannot prove what the Container App is bound to (the app may not exist yet
# on a first deploy). Deleting credentials from that position is exactly the
# blind delete this change exists to prevent; pruning stays in the bootstrap
# script, which can prove the console's binding first.
MINT=1
IN_USE_KEY_ID=$(az keyvault secret show --vault-name "$KEYVAULT_NAME" --name "$MSAL_SECRET_NAME" --query "tags.msalKeyId" -o tsv) || IN_USE_KEY_ID=''
IN_USE_KEY_ID=$(printf '%s' "$IN_USE_KEY_ID" | tr -d ' \r')
if [ -n "$IN_USE_KEY_ID" ]; then
  CRED_END=$(az ad app credential list --id "$APP_ID" --query "[?keyId=='$IN_USE_KEY_ID'].endDateTime | [0]" -o tsv) || CRED_END=''
  CRED_END=$(printf '%s' "$CRED_END" | tr -d ' \r')
  case "$CRED_END" in
    ''|None) echo "Key Vault records credential $IN_USE_KEY_ID but the app no longer carries it — minting a replacement" ;;
    *)
      REMAIN=$(( ( $(date -u -d "$CRED_END" +%s) - $(date -u +%s) ) / 86400 ))
      if [ "$REMAIN" -gt "${MSAL_MIN_REMAINING_DAYS:-90}" ]; then
        MINT=0
        echo "REUSE: $MSAL_SECRET_NAME holds credential $IN_USE_KEY_ID, live until $CRED_END ($REMAIN days). Minting nothing."
      else
        echo "RENEW: credential $IN_USE_KEY_ID expires $CRED_END ($REMAIN days) — minting a replacement"
      fi ;;
  esac
fi
if [ "$MINT" -eq 1 ]; then
  # --append: never wipe the credential the running console is still serving.
  # The label is unique per run and is how this credential's key id is resolved
  # afterwards (`credential reset` returns appId/password/tenant, not the key id).
  CRED_LABEL="loom-console-$(date -u +%Y%m%dT%H%M%SZ)"
  SECRET=$(az ad app credential reset --id "$APP_ID" --append --years "${MSAL_SECRET_YEARS:-1}" --display-name "$CRED_LABEL" --query password -o tsv)
  az keyvault secret set --vault-name "$KEYVAULT_NAME" --name "$MSAL_SECRET_NAME" --value "$SECRET" -o none
  NEW_KEY_ID=$(az ad app credential list --id "$APP_ID" --query "[?displayName=='$CRED_LABEL'].keyId | [0]" -o tsv) || NEW_KEY_ID=''
  NEW_KEY_ID=$(printf '%s' "$NEW_KEY_ID" | tr -d ' \r')
  if [ -n "$NEW_KEY_ID" ] && [ "$NEW_KEY_ID" != "None" ]; then
    # Provenance for the NEXT run's reuse check. Key ids are not secrets.
    az keyvault secret set --vault-name "$KEYVAULT_NAME" --name "$MSAL_SECRET_NAME" --value "$SECRET" \
      --tags "msalKeyId=$NEW_KEY_ID" "msalAppId=$APP_ID" "msalCredentialLabel=$CRED_LABEL" -o none
    echo "Wrote $MSAL_SECRET_NAME to $KEYVAULT_NAME (msalKeyId=$NEW_KEY_ID)"
  else
    echo "Wrote $MSAL_SECRET_NAME to $KEYVAULT_NAME, but the new credential's key id could not be resolved by its label — the next run cannot reuse and will mint again."
  fi
fi

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
