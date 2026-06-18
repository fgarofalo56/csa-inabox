// One-shot Databricks SCIM bootstrap via VNet-integrated deploymentScript.
// Runs Azure CLI inside an ACI placed in snet-workloads (spoke VNet, can
// reach the Databricks workspace which rejects all non-VNet traffic).
//
// Registers the Console UAMI as a Databricks workspace ServicePrincipal
// with the entitlements every Loom Databricks editor needs end-to-end:
//   - workspace-access          : sign in, browse, run notebooks
//   - databricks-sql-access     : connect SQL warehouses / Lakeview
//   - allow-cluster-create      : POST /api/2.1/clusters/create
//   - allow-instance-pool-create: POST /api/2.0/instance-pools/create
//   - databricks-jobs-api-access: POST /api/2.0/pipelines (DLT), MLflow
//     experiments/models, serving-endpoints — the Unity Catalog write-path
//     editor's DLT/MLflow/Serving create surfaces. Without it those POSTs 403.
//
// History: pre-2026-05-27 builds only granted workspace-access +
// databricks-sql-access, which produced the
// {"error_code":"PERMISSION_DENIED","message":"You are not authorized to
// create clusters. Please contact your administrator."} 403 in the
// Cluster editor's Save flow. Re-run this deploymentScript via
// `azd up` (idempotent — script POSTs 201 if absent, PATCHes the
// entitlements list if the SP already exists) to repair an existing
// deployment.

targetScope = 'resourceGroup'

@description('Primary region')
param location string = resourceGroup().location

@description('Databricks workspace hostname (api host)')
param databricksHost string

@description('Console UAMI client (application) id — what we register in Databricks')
param consoleUamiClientId string

@description('Deploying SP client id (workspace admin)')
param deploySpClientId string

@description('Deploying SP secret')
@secure()
param deploySpSecret string

@description('Tenant id')
param tenantId string = subscription().tenantId

@description('Spoke subnet id (snet-workloads) for ACI placement')
param spokeSubnetId string

@description('Resource group of the UAMI that runs the script (must have Contributor on this RG)')
param scriptUamiId string

// =====================================================================
// Deployment-script staging storage account
//   Azure deploymentScripts stage their script + outputs on a storage
//   account that the backing Azure Container Instance mounts as a FILE
//   SHARE — and the ONLY way ACI can mount a file share is via a SHARED
//   KEY. A DLZ subscription commonly enforces `allowSharedKeyAccess=false`
//   (Azure Policy), so the script service's auto-created SA rejects key auth
//   and this SCIM bootstrap fails with `KeyBasedAuthenticationNotPermitted
//   (403)`.
//
//   Fix: stand up a small DEDICATED staging SA that explicitly ALLOWS
//   shared-key access (it only ever holds the throwaway script file share
//   + log blobs, never data) and point the deploymentScript at it via the
//   `storageAccountSettings` property. Mirrors the #1440 pattern in
//   landing-zone/synapse.bicep. Per Learn (deployment-script-template#use-
//   existing-storage-account): kind StorageV2, allowSharedKeyAccess=true, no
//   storage firewall (public network on); the deploying principal supplies
//   the key via listKeys (it has Contributor on this RG via the deployment).
// =====================================================================
var scriptStagingSaName = take('sadsloomscim${uniqueString(resourceGroup().id, 'databricks-scim-staging')}', 24)

resource scriptStagingStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: scriptStagingSaName
  location: location
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

resource bootstrap 'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  name: 'loom-dbx-scim-bootstrap'
  location: location
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${scriptUamiId}': {} }
  }
  properties: {
    azCliVersion: '2.64.0'
    retentionInterval: 'PT1H'
    timeout: 'PT30M'
    cleanupPreference: 'OnSuccess'
    // Stage on the dedicated shared-key-enabled SA so this does not hit
    // KeyBasedAuthenticationNotPermitted on a DLZ that denies shared-key access.
    storageAccountSettings: {
      storageAccountName: scriptStagingSaName
      storageAccountKey: scriptStagingStorage.listKeys().keys[0].value
    }
    containerSettings: {
      subnetIds: [
        { id: spokeSubnetId }
      ]
    }
    environmentVariables: [
      { name: 'TENANT', value: tenantId }
      { name: 'SP_ID', value: deploySpClientId }
      { name: 'SP_SECRET', secureValue: deploySpSecret }
      { name: 'UAMI_APP', value: consoleUamiClientId }
      { name: 'DBX_HOST', value: databricksHost }
    ]
    scriptContent: '''
      set -e
      DBX_SCOPE=2ff814a6-3304-4ab8-85cb-cd0e6f879c1d
      echo "Getting Databricks AAD token..."
      TOKEN=$(curl -sS -X POST "https://login.microsoftonline.com/$TENANT/oauth2/v2.0/token" \
        -d "client_id=$SP_ID&client_secret=$SP_SECRET&scope=$DBX_SCOPE/.default&grant_type=client_credentials" \
        | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
      echo "Token length: ${#TOKEN}"
      if [ -z "$TOKEN" ]; then echo "FAILED to acquire token"; exit 1; fi

      ENTS='[{"value":"workspace-access"},{"value":"databricks-sql-access"},{"value":"allow-cluster-create"},{"value":"allow-instance-pool-create"},{"value":"databricks-jobs-api-access"}]'

      echo "POSTing SCIM ServicePrincipal (or PATCHing entitlements if it exists)..."
      RESP=$(curl -sS -w "\nHTTP_CODE=%{http_code}" -X POST \
        "https://$DBX_HOST/api/2.0/preview/scim/v2/ServicePrincipals" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/scim+json" \
        -d "{\"schemas\":[\"urn:ietf:params:scim:schemas:core:2.0:ServicePrincipal\"],\"applicationId\":\"$UAMI_APP\",\"displayName\":\"uami-loom-console-eastus2\",\"entitlements\":$ENTS}")
      echo "Response: $RESP"
      CODE=$(echo "$RESP" | grep HTTP_CODE | cut -d= -f2)

      # If the SP already exists (409), look it up and PATCH the entitlements
      # so existing deployments inherit allow-cluster-create + allow-instance-
      # pool-create + databricks-jobs-api-access (DLT/MLflow/serving) without
      # manual remediation.
      if [ "$CODE" = "409" ]; then
        echo "SP exists; resolving id + PATCHing entitlements..."
        LIST=$(curl -sS \
          "https://$DBX_HOST/api/2.0/preview/scim/v2/ServicePrincipals?filter=applicationId%20eq%20%22$UAMI_APP%22" \
          -H "Authorization: Bearer $TOKEN")
        SP_ID=$(echo "$LIST" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -n1)
        echo "Resolved SP id: $SP_ID"
        if [ -z "$SP_ID" ]; then echo "FAILED to resolve SP id"; exit 1; fi
        PATCH=$(curl -sS -w "\nHTTP_CODE=%{http_code}" -X PATCH \
          "https://$DBX_HOST/api/2.0/preview/scim/v2/ServicePrincipals/$SP_ID" \
          -H "Authorization: Bearer $TOKEN" \
          -H "Content-Type: application/scim+json" \
          -d "{\"schemas\":[\"urn:ietf:params:scim:api:messages:2.0:PatchOp\"],\"Operations\":[{\"op\":\"replace\",\"path\":\"entitlements\",\"value\":$ENTS}]}")
        PCODE=$(echo "$PATCH" | grep HTTP_CODE | cut -d= -f2)
        echo "PATCH response: $PATCH"
        if [ "$PCODE" = "200" ] || [ "$PCODE" = "204" ]; then
          echo "SUCCESS (entitlements patched on existing SP)"
          echo "{\"status\":\"ok\",\"http\":\"$PCODE\",\"action\":\"patched\"}" > $AZ_SCRIPTS_OUTPUT_PATH
          exit 0
        else
          echo "PATCH FAILED with HTTP $PCODE"
          exit 1
        fi
      fi

      if [ "$CODE" = "201" ]; then
        echo "SUCCESS (created with full entitlement set)"
        echo "{\"status\":\"ok\",\"http\":\"$CODE\",\"action\":\"created\"}" > $AZ_SCRIPTS_OUTPUT_PATH
      else
        echo "FAILED with HTTP $CODE"
        exit 1
      fi
    '''
  }
}

output result object = bootstrap.properties.outputs
