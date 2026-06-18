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

@description('DLZ subscription id → LOOM_EVENTHUB_SUB + LOOM_DLZ_SUBSCRIPTION_ID. The attached DLZ lives in its own subscription, distinct from the hub admin sub the console runs in — without this the app falls back to LOOM_SUBSCRIPTION_ID (the hub sub) and DLZ navigators (Event Hubs, Capacity page, etc.) look in the wrong subscription.')
param dlzSubscriptionId string

@description('DLZ Databricks workspace URL (e.g. adb-123.4.azuredatabricks.net) → LOOM_DATABRICKS_HOSTNAME. Empty when Databricks is disabled (the var is then skipped and the Databricks-backed surfaces honest-gate, which is correct).')
param dlzDatabricksWorkspaceUrl string = ''

@description('DLZ Azure Data Factory name → LOOM_ADF_NAME / LOOM_ADF_FACTORY. Empty when ADF is disabled (the var is then skipped and the mirror/CDC editors honest-gate).')
param dlzAdfFactoryName string = ''

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
      { name: 'ORG_VISUALS_URL', value: orgVisualsUrl }
      { name: 'SYNAPSE_WS', value: dlzSynapseWorkspace }
      { name: 'EVENTHUB_NS', value: dlzEventHubNamespace }
      { name: 'DLZ_RG', value: dlzResourceGroup }
      { name: 'DLZ_SUB', value: dlzSubscriptionId }
      { name: 'DATABRICKS_URL', value: dlzDatabricksWorkspaceUrl }
      { name: 'ADF_NAME', value: dlzAdfFactoryName }
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

# DLZ subscription — the attached DLZ lives in its own sub, distinct from the hub
# admin sub the console runs in. LOOM_DLZ_SUBSCRIPTION_ID lets DLZ-scoped
# navigators (Capacity page ARM listing, ADF, etc.) target the right sub instead
# of falling back to the hub's LOOM_SUBSCRIPTION_ID.
if [ -n "$DLZ_SUB" ]; then
  SET_ARGS+=( "LOOM_DLZ_SUBSCRIPTION_ID=$DLZ_SUB" )
fi

# Databricks workspace hostname — empty when Databricks is disabled (skip the var
# so the Databricks-backed surfaces honest-gate, which is correct).
if [ -n "$DATABRICKS_URL" ]; then
  SET_ARGS+=( "LOOM_DATABRICKS_HOSTNAME=$DATABRICKS_URL" )
fi

# Azure Data Factory — set both the canonical LOOM_ADF_NAME and the
# LOOM_ADF_FACTORY alias the adf-client also reads, plus the ADF RG/sub (the DLZ
# RG/sub). Empty name => ADF disabled, so skip (mirror/CDC editors honest-gate).
if [ -n "$ADF_NAME" ]; then
  SET_ARGS+=( "LOOM_ADF_NAME=$ADF_NAME" "LOOM_ADF_FACTORY=$ADF_NAME" )
  if [ -n "$DLZ_RG" ]; then
    SET_ARGS+=( "LOOM_ADF_RG=$DLZ_RG" )
  fi
  if [ -n "$DLZ_SUB" ]; then
    SET_ARGS+=( "LOOM_ADF_SUB=$DLZ_SUB" "LOOM_ADF_SUBSCRIPTION_ID=$DLZ_SUB" )
  fi
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
output loomDlzSubscriptionId string = dlzSubscriptionId
output loomDatabricksHostname string = dlzDatabricksWorkspaceUrl
output loomAdfFactoryName string = dlzAdfFactoryName
