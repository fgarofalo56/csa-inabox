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
    environmentVariables: [
      { name: 'APP_NAME', value: consoleAppName }
      { name: 'RG_NAME', value: resourceGroup().name }
      { name: 'ADLS_ACCOUNT', value: dlzAdlsAccount }
      { name: 'LANDING_URL', value: landingUrl }
      { name: 'BRONZE_URL', value: bronzeUrl }
      { name: 'SILVER_URL', value: silverUrl }
      { name: 'GOLD_URL', value: goldUrl }
      { name: 'SYNAPSE_WS', value: dlzSynapseWorkspace }
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
)
if [ -n "$SYNAPSE_WS" ]; then
  SET_ARGS+=( "LOOM_SYNAPSE_WORKSPACE=$SYNAPSE_WS" )
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
output loomSynapseWorkspace string = dlzSynapseWorkspace
