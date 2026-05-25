// One-shot Databricks SCIM bootstrap via VNet-integrated deploymentScript.
// Runs Azure CLI inside an ACI placed in snet-workloads (spoke VNet, can
// reach the Databricks workspace which rejects all non-VNet traffic).
//
// Registers the Console UAMI as a Databricks workspace ServicePrincipal
// with workspace-access + databricks-sql-access entitlements.

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

      echo "POSTing SCIM ServicePrincipal..."
      RESP=$(curl -sS -w "\nHTTP_CODE=%{http_code}" -X POST \
        "https://$DBX_HOST/api/2.0/preview/scim/v2/ServicePrincipals" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/scim+json" \
        -d "{\"schemas\":[\"urn:ietf:params:scim:schemas:core:2.0:ServicePrincipal\"],\"applicationId\":\"$UAMI_APP\",\"displayName\":\"uami-loom-console-eastus2\",\"entitlements\":[{\"value\":\"workspace-access\"},{\"value\":\"databricks-sql-access\"}]}")
      echo "Response: $RESP"
      CODE=$(echo "$RESP" | grep HTTP_CODE | cut -d= -f2)
      if [ "$CODE" = "201" ] || [ "$CODE" = "409" ]; then
        echo "SUCCESS (created or already exists)"
        echo "{\"status\":\"ok\",\"http\":\"$CODE\"}" > $AZ_SCRIPTS_OUTPUT_PATH
      else
        echo "FAILED with HTTP $CODE"
        exit 1
      fi
    '''
  }
}

output result object = bootstrap.properties.outputs
