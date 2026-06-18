// CSA Loom — wire the hub console's DLZ data-plane env vars (cross-subscription)
//
// dlz-attach ONLY. After a cross-sub dlz-attach the NEW DLZ's data plane (ADLS,
// Synapse) exists, but the ALREADY-DEPLOYED hub console container app has EMPTY
// env vars for it (single-sub bakes these into the console container app
// definition from singleDlz.outputs; in dlz-attach the admin plane / console is
// never redeployed). So lakehouse / notebook / warehouse editors honest-gate on
// the hub even though the backing DLZ is live.
//
// Updating an existing Container App's env from a pure ARM resource is
// impractical here: the console app is defined by admin-plane/app-deployments.bicep
// with its full template/env list, and re-declaring it from a DLZ module would
// drop every other env var. Instead this module runs a cross-sub deploymentScript
// (scoped to the hub admin RG/sub via the module `scope` in main.bicep) that does
// an ADDITIVE `az containerapp update --set-env-vars` — it merges the DLZ vars in
// without disturbing the rest of the console's configuration.
//
// The script runs AS the hub Console UAMI (consoleUamiId), which already holds
// the rights to manage its own container app (Microsoft.App/containerApps write)
// on the hub. The same env values are ALSO surfaced as module outputs so the
// orchestrator / bootstrap can verify or re-apply them out-of-band.

targetScope = 'resourceGroup'

@description('Region for the deploymentScript helper resources.')
param location string

@description('Name of the hub console Container App to update (default: loom-console).')
param consoleAppName string = 'loom-console'

@description('Resource id of a UAMI to run the script as — the hub Console UAMI, which can manage its own container app on the hub.')
param scriptUamiId string

@description('DLZ ADLS Gen2 storage account NAME (short, not URL) → LOOM_ADLS_ACCOUNT.')
param dlzAdlsAccount string

@description('DLZ Synapse workspace name → LOOM_SYNAPSE_WORKSPACE. Empty when Synapse is disabled (the env var is then skipped).')
param dlzSynapseWorkspace string = ''

@description('DLZ Event Hubs namespace NAME (short) → LOOM_EVENTHUB_NAMESPACE. Empty when Event Hubs is disabled (the var is then skipped, and the Eventstream / Data Explorer editors honest-gate, which is the correct behavior).')
param dlzEventHubNamespace string = ''

@description('DLZ resource group name → LOOM_EVENTHUB_RG (and LOOM_DLZ_RG). In dlz-attach the console was deployed with these pointing at the admin/single-sub defaults, so they must be re-pointed at the attached DLZ RG.')
param dlzResourceGroup string

@description('DLZ subscription id → LOOM_EVENTHUB_SUB. The attached DLZ lives in its own subscription, distinct from the hub admin sub the console runs in — without this the app falls back to LOOM_SUBSCRIPTION_ID (the hub sub) and the Event Hubs navigator looks in the wrong subscription.')
param dlzSubscriptionId string

@description('Compliance tags.')
param complianceTags object

// DFS endpoint host derived per sovereign cloud (dfs.core.windows.net /
// dfs.core.usgovcloudapi.net). environment() is valid at resourceGroup scope, so
// the medallion URLs are computed here rather than in the subscription-scoped
// main.bicep (which would need az.environment()).
var dfsSuffix = 'dfs.${environment().suffixes.storage}'

// Derived data-lake medallion container URLs the lakehouse/notebook editors read.
var landingUrl = 'https://${dlzAdlsAccount}.${dfsSuffix}/landing'
var bronzeUrl = 'https://${dlzAdlsAccount}.${dfsSuffix}/bronze'
var silverUrl = 'https://${dlzAdlsAccount}.${dfsSuffix}/silver'
var goldUrl = 'https://${dlzAdlsAccount}.${dfsSuffix}/gold'

// Org-visuals (Embed codes F22 / Organizational visuals F23) container URL —
// the BLOB endpoint of the same DLZ storage account. Single-sub bakes
// LOOM_ORG_VISUALS_URL into the console env from loomStorageAccount; in
// dlz-attach the console was deployed before this DLZ existed, so the var is
// blank and the self-audit "Embed codes / Org visuals" check warns even though
// the org-visuals container is live. Wire it here, additively, alongside the
// ADLS/medallion env. (Note: .blob — not the .dfs medallion host.)
var orgVisualsUrl = 'https://${dlzAdlsAccount}.blob.${environment().suffixes.storage}/org-visuals'

// =====================================================================
// Deployment-script staging storage account
//   Azure deploymentScripts stage their script + outputs on a storage
//   account that the backing Azure Container Instance mounts as a FILE
//   SHARE — and the ONLY way ACI can mount a file share is via a SHARED
//   KEY. A subscription that enforces `allowSharedKeyAccess=false` (Azure
//   Policy — common on the DLZ AND the hub) makes the script service's
//   auto-created SA reject key auth, and this deploymentScript fails on a
//   clean dlz-attach deploy with `KeyBasedAuthenticationNotPermitted (403)`.
//
//   Fix: stand up a small DEDICATED staging SA that explicitly ALLOWS
//   shared-key access (it only ever holds the throwaway script file share
//   + log blobs, never data) and point the deploymentScript at it via the
//   `storageAccountSettings` property. Per Learn
//   (deployment-script-template#use-existing-storage-account):
//     - kind must be Storage/StorageV2 (StorageV2 here)
//     - allowSharedKeyAccess MUST be true
//     - storage firewall rules are NOT supported → public network access on
//     - the deploying principal needs listKeys on the SA (it has Contributor
//       on this RG via the deployment), which is how storageAccountKey below
//       is supplied. The script UAMI mounts via that key, so it needs no
//       extra RBAC on this SA — keeping the grant minimal.
//   Mirrors the #1440 pattern in landing-zone/synapse.bicep. This module is
//   scoped to the HUB admin RG/sub (main.bicep), so the staging SA lives in
//   the hub RG where the script actually runs.
// =====================================================================
var scriptStagingSaName = take('sadsloomhce${uniqueString(resourceGroup().id, 'hub-console-dlz-env-staging')}', 24)

resource scriptStagingStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: scriptStagingSaName
  location: location
  tags: complianceTags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    // REQUIRED for deploymentScripts — ACI mounts the staging file share via a
    // shared key. This SA holds only ephemeral script staging (never data), so
    // allowing shared-key access here does NOT weaken the data-plane posture.
    allowSharedKeyAccess: true
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    // deploymentScripts do not support storage firewall rules (Learn), so the
    // staging SA keeps default public network access; it carries no data.
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource wireDlzEnv 'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  name: 'wire-hub-console-dlz-env'
  location: location
  tags: complianceTags
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${scriptUamiId}': {}
    }
  }
  properties: {
    azCliVersion: '2.64.0'
    retentionInterval: 'PT1H'
    timeout: 'PT15M'
    // Stage on the dedicated shared-key-enabled SA so this does not hit
    // KeyBasedAuthenticationNotPermitted on a sub that denies shared-key access.
    storageAccountSettings: {
      storageAccountName: scriptStagingSaName
      storageAccountKey: scriptStagingStorage.listKeys().keys[0].value
    }
    environmentVariables: [
      { name: 'APP_NAME', value: consoleAppName }
      { name: 'RG_NAME', value: resourceGroup().name }
      { name: 'ADLS_ACCOUNT', value: dlzAdlsAccount }
      { name: 'LANDING_URL', value: landingUrl }
      { name: 'BRONZE_URL', value: bronzeUrl }
      { name: 'SILVER_URL', value: silverUrl }
      { name: 'GOLD_URL', value: goldUrl }
      { name: 'ORG_VISUALS_URL', value: orgVisualsUrl }
      { name: 'SYNAPSE_WS', value: dlzSynapseWorkspace }
      { name: 'EVENTHUB_NS', value: dlzEventHubNamespace }
      { name: 'DLZ_RG', value: dlzResourceGroup }
      { name: 'DLZ_SUB', value: dlzSubscriptionId }
    ]
    scriptContent: '''
set -euo pipefail
echo "Wiring DLZ data-plane env onto hub console '$APP_NAME' (rg=$RG_NAME)..."
az extension add --name containerapp --upgrade --yes 2>/dev/null || true

# Build the additive env-var set. LOOM_SYNAPSE_WORKSPACE is only set when a
# Synapse workspace was provisioned (empty => editor honest-gates, which is the
# correct behavior, so we skip the var rather than blank it).
SET_ARGS=( \
  "LOOM_ADLS_ACCOUNT=$ADLS_ACCOUNT" \
  "LOOM_LANDING_URL=$LANDING_URL" \
  "LOOM_BRONZE_URL=$BRONZE_URL" \
  "LOOM_SILVER_URL=$SILVER_URL" \
  "LOOM_GOLD_URL=$GOLD_URL" \
  "LOOM_ORG_VISUALS_URL=$ORG_VISUALS_URL" \
)
if [ -n "$SYNAPSE_WS" ]; then
  SET_ARGS+=( "LOOM_SYNAPSE_WORKSPACE=$SYNAPSE_WS" )
fi

# Re-point the DLZ resource group + subscription at the ATTACHED DLZ. In
# dlz-attach the console was deployed with LOOM_DLZ_RG / LOOM_EVENTHUB_RG pointing
# at the admin/single-sub default RG and the sub-scoped vars at the hub sub, so
# cross-sub DLZ resources (Event Hubs, and any RG/sub-relative navigator) resolve
# to the wrong place. LOOM_DLZ_RG is the default RG many navigators fall back to,
# so re-pointing it fixes the whole DLZ coordinate set, not just Event Hubs.
if [ -n "$DLZ_RG" ]; then
  SET_ARGS+=( "LOOM_DLZ_RG=$DLZ_RG" )
fi

# Event Hubs — the Eventstream / Real-Time Data Explorer navigators bind to this
# namespace. LOOM_EVENTHUB_RG / LOOM_EVENTHUB_SUB are set explicitly (rather than
# relying on the app's LOOM_DLZ_RG / LOOM_SUBSCRIPTION_ID fallbacks) because the
# console's LOOM_SUBSCRIPTION_ID is the HUB sub, not the DLZ sub. Only set when a
# namespace exists (empty => editor honest-gates, the correct behavior — so we
# skip the var rather than blank it).
if [ -n "$EVENTHUB_NS" ]; then
  SET_ARGS+=( "LOOM_EVENTHUB_NAMESPACE=$EVENTHUB_NS" )
  if [ -n "$DLZ_RG" ]; then
    SET_ARGS+=( "LOOM_EVENTHUB_RG=$DLZ_RG" )
  fi
  if [ -n "$DLZ_SUB" ]; then
    SET_ARGS+=( "LOOM_EVENTHUB_SUB=$DLZ_SUB" )
  fi
fi

echo "  set-env-vars: ${SET_ARGS[*]}"
# --set-env-vars MERGES (adds/updates the named vars, leaves the rest intact).
az containerapp update \
  --name "$APP_NAME" \
  --resource-group "$RG_NAME" \
  --set-env-vars "${SET_ARGS[@]}" \
  || { echo "ERROR: failed to update '$APP_NAME' env on the hub. The Console UAMI must hold Microsoft.App/containerApps/write on the hub admin RG. Re-run the orchestrator bootstrap or apply manually with the values in this deployment's outputs."; exit 1; }

echo "Done. Hub console will pick up the new env on its next revision."
'''
  }
}

output loomAdlsAccount string = dlzAdlsAccount
output loomLandingUrl string = landingUrl
output loomBronzeUrl string = bronzeUrl
output loomSilverUrl string = silverUrl
output loomGoldUrl string = goldUrl
output loomOrgVisualsUrl string = orgVisualsUrl
output loomSynapseWorkspace string = dlzSynapseWorkspace
output loomEventHubNamespace string = dlzEventHubNamespace
output loomEventHubRg string = dlzResourceGroup
output loomEventHubSub string = dlzSubscriptionId
output loomDlzRg string = dlzResourceGroup
