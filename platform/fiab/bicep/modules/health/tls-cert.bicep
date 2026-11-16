// CSA Loom Health Data Services (LHDS) - default self-signed ingress certificate.
//
// Operator decision 2026-11-15 (auto-bind-by-default.md s5: infra prerequisites are
// deployed, not requested): when no real certificate is supplied
// (healthConfig.tlsCertificateSecretUri empty) the stamp ingress gets a Key Vault
// generated SELF-SIGNED certificate whose subject and SAN are the ingress public
// FQDN. A CA-issued certificate supplied through tlsCertificateSecretUri always wins
// and this module is not deployed.
//
// ARM cannot create Key Vault certificates, so a deploymentScript does it. The stamp
// vault is private-endpoint only (keyvault.bicep: publicNetworkAccess Disabled), so
// the script container is VNet-injected into the delegated subnet network.bicep
// creates (snet-script) and reaches the vault through its private endpoint. The
// script staging storage account allows shared-key access (a deploymentScripts
// requirement; it holds only the throwaway script share and logs, never data) and is
// firewalled to that one subnet through a service endpoint.
//
// Idempotent: a re-deploy keeps the existing certificate unless it is missing, its
// subject is not the current FQDN, or it expires within renewBeforeDays. The policy
// also carries an AutoRenew lifetime action, and the gateway reads the VERSION-LESS
// secret URI, so Key Vault renewals roll without a redeploy. The private key never
// leaves the vault through this module: only the PUBLIC certificate fingerprint is
// emitted, so CI (which cannot reach the private vault) can pin it.

targetScope = 'resourceGroup'

@description('Region of the script container and its staging storage.')
param location string

@description('Name of the stamp Key Vault (existing).')
param keyVaultName string

@description('Subnet delegated to Microsoft.ContainerInstance/containerGroups, with the Microsoft.Storage service endpoint (network.bicep snet-script).')
param scriptSubnetId string

@description('Ingress public FQDN: becomes the certificate subject CN and its only DNS SAN.')
param fqdn string

@description('Certificate name in the vault. Deterministic so CI can find it.')
param certName string = 'lhds-ingress-selfsigned'

@description('Re-issue when the existing certificate expires within this many days.')
@minValue(1)
@maxValue(300)
param renewBeforeDays int = 30

@description('Tags applied to every resource.')
param tags object = {}

// Built-in role id, global GUID (identical in every cloud).
var kvCertificatesOfficerRoleId = 'a4417e6f-fecd-4de8-b567-7b0420556985'
var stagingName = take('sthlhdsc${uniqueString(resourceGroup().id, 'lhds-tls-script')}', 24)

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

resource scriptIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-lhds-tls-script-${take(uniqueString(resourceGroup().id), 6)}'
  location: location
  tags: tags
}

resource certOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, scriptIdentity.id, kvCertificatesOfficerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvCertificatesOfficerRoleId)
    principalId: scriptIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'LHDS ingress: create the self-signed TLS certificate in the stamp vault.'
  }
}

resource staging 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: stagingName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    // Left true: the script now mounts the share as its identity (stagingFileRole, no key), but
    // Learn's deployment-script-vnet page was not available to confirm shared key is unneeded,
    // so it is not tightened here (follow-up: set false once a live run proves it).
    allowSharedKeyAccess: true
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
      virtualNetworkRules: [
        { id: scriptSubnetId, action: 'Allow' }
      ]
    }
  }
}

// A VNet-injected script on a firewalled storage account authenticates to it as the script identity
// (no account key): Storage File Data Privileged Contributor scoped to the account. Without it ARM
// rejects the script with DeploymentScriptStorageAccountWithServiceEndpointEnabled (run 43794877307).
// https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/deployment-script-vnet
var storageFilePrivilegedContributorRoleId = '69566ab7-960f-475b-8e7c-b3118f30c6bd'

resource stagingFileRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: staging
  name: guid(staging.id, scriptIdentity.id, storageFilePrivilegedContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageFilePrivilegedContributorRoleId)
    principalId: scriptIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    description: 'LHDS ingress: the VNet-injected script mounts its staging file share as this identity.'
  }
}

resource issueCert'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  name: 'script-lhds-ingress-tls'
  location: location
  kind: 'AzureCLI'
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${scriptIdentity.id}': {}
    }
  }
  properties: {
    azCliVersion: '2.67.0'
    retentionInterval: 'PT1H'
    timeout: 'PT30M'
    cleanupPreference: 'OnSuccess'
    forceUpdateTag: uniqueString(fqdn, certName, string(renewBeforeDays))
    storageAccountSettings: {
      storageAccountName: staging.name
    }
    containerSettings: {
      subnetIds: [
        { id: scriptSubnetId }
      ]
    }
    environmentVariables: [
      { name: 'KV_NAME', value: keyVaultName }
      { name: 'CERT_NAME', value: certName }
      { name: 'CERT_FQDN', value: fqdn }
      { name: 'RENEW_BEFORE_DAYS', value: string(renewBeforeDays) }
    ]
    // Script lives in tls-cert.sh (column 0: heredocs are indentation-sensitive). Fails closed.
    scriptContent: loadTextContent('tls-cert.sh')
  }
  dependsOn: [
    certOfficer
    stagingFileRole
  ]
}

@description('Certificate name in the stamp vault.')
output certificateName string = certName

@description('Version-less secret URI the Application Gateway reads (renewals roll without a redeploy).')
output secretUri string = '${vault.properties.vaultUri}secrets/${certName}'

@description('Public FQDN the certificate is issued for.')
output fqdn string = fqdn

@description('Public certificate facts for CI pinning: notAfter, thumbprintSha1, fingerprintSha256, versionId. No private material.')
output certificate object = issueCert.properties.outputs
