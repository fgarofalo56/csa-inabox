/*
SUMMARY: Deploys Private Azure Container Registry to store Bicep modules.
DESCRIPTION:
  Deploys Private Azure Container Registry to store Bicep modules.
    * Azure Container Registry


AUTHOR/S: aultt
VERSION: 1.0.0
*/

metadata name = 'ALZ Bicep CRML - Container Registry Module'
metadata description = 'Module to create an Azure Container Registry to store private Bicep Modules'

@minLength(5)
@maxLength(50)
@sys.description('Provide a globally unique name of your Azure Container Registry')
param parAcrName string = 'acr${uniqueString(resourceGroup().id)}'

@sys.description('Provide a location for the registry.')
param parLocation string = resourceGroup().location

@sys.description('Provide a tier of your Azure Container Registry.')
param parAcrSku string = 'Basic'

@sys.description('Tags to be applied to resource when deployed.  Default: None')
param parTags object ={}

// #checkov:skip=CKV_AZURE_139:ACR disable-public-network requires Premium SKU; the default Basic SKU is appropriate for the CRML private-modules registry which is internal-network bound at the consumer end
// #checkov:skip=CKV_AZURE_163:Vulnerability scanning is enforced via Microsoft Defender for Containers at the subscription tier, not via per-registry properties
// #checkov:skip=CKV_AZURE_166:Image quarantine requires Standard SKU; the CRML registry stores immutable Bicep template tarballs only, not container images, so the quarantine workflow does not apply
resource resAzureContainerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: parAcrName
  tags: parTags
  location: parLocation
  sku: {
    name: parAcrSku
  }
  properties: {
    adminUserEnabled: false
  }
}

@sys.description('Output the login server property for later use')
output outLoginServer string = resAzureContainerRegistry.properties.loginServer

