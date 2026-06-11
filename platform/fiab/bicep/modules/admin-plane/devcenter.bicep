// =====================================================================
// CSA Loom — Azure Deployment Environments (DevCenter) for release-environment
// =====================================================================
// audit-T29 / deep T55 (Palantir Apollo → Shuttle parity). Optional module
// that provisions an Azure Deployment Environments DevCenter + project so the
// `release-environment` item type can offer catalog-driven, Bicep-runner
// environments per promotion stage.
//
// This is the Azure-native equivalent of Palantir Apollo's environment
// catalog. It is STRICTLY OPTIONAL: when it is not deployed the
// release-environment editor still functions (it records promotions and shows
// real ARM deployment history) and surfaces an honest infra-gate naming
// LOOM_DEVCENTER_PROJECT. No Microsoft Fabric is involved on any path
// (.claude/rules/no-fabric-dependency.md).
//
// Wire the project name into the Console app env as LOOM_DEVCENTER_PROJECT
// (admin-plane/main.bicep param loomDevCenterProject) to lift the gate.
// Catalog environment definitions (environment.yaml + a Bicep template) are
// synced from a git catalog repo — see docs/fiab/v3-tenant-bootstrap.md.
// =====================================================================

@description('Azure region.')
param location string = resourceGroup().location

@description('DevCenter name.')
param devCenterName string = 'loom-devcenter'

@description('Deployment Environments project name (this is the value wired into LOOM_DEVCENTER_PROJECT).')
param projectName string = 'loom-release'

@description('Console UAMI resource id — the DevCenter uses this user-assigned identity to deploy environments.')
param uamiResourceId string

@description('Optional resource tags.')
param tags object = {}

resource devcenter 'Microsoft.DevCenter/devcenters@2025-02-01' = {
  name: devCenterName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uamiResourceId}': {}
    }
  }
}

// One environment type the project's environments are created under. Promotion
// stages (dev/test/prod) map to environments of this type at deploy time.
resource envType 'Microsoft.DevCenter/devcenters/environmentTypes@2025-02-01' = {
  parent: devcenter
  name: 'loom-stage'
  properties: {}
}

resource project 'Microsoft.DevCenter/projects@2025-02-01' = {
  name: projectName
  location: location
  tags: tags
  properties: {
    devCenterId: devcenter.id
    description: 'CSA Loom release-environment (Apollo/Shuttle parity) — catalog-driven Azure Deployment Environments.'
  }
}

@description('Project name to set as LOOM_DEVCENTER_PROJECT on the Console app.')
output projectName string = project.name
@description('DevCenter resource id.')
output devCenterId string = devcenter.id
@description('Environment type name promotions deploy under.')
output environmentTypeName string = envType.name
