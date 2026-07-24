// CSA Loom — N7e loom-trino: the OPT-IN Trino / Starburst Federated SQL cluster.
//
// Backs LOOM_TRINO_URL. Trino OSS (Apache-2.0) runs as a PRIVATE cluster on AKS
// inside the deployment's own VNet, registered against N1's Iceberg REST Catalog
// (LOOM_ICEBERG_CATALOG_URL) + external connectors (PostgreSQL, MySQL, Kafka,
// MongoDB, …). It is the "Federated SQL" engine: ONE statement can join a Loom
// Iceberg table with an external Postgres table — which the light default engine
// (DuckDB, N2b) does not do.
//
// THE ONE OPT-IN CARVE-OUT (loom_default_on_opt_out, round-3 operator decision):
//   Every other Loom capability is default-ON. Trino is the documented exception
//   because it stands up a full AKS cluster (real, disclosed cost). It is
//   therefore OPT-IN — deployed out-of-band, then LOOM_TRINO_URL set on the
//   Console app. It gates NO feature: SQL Lab stays fully functional on the
//   default DuckDB tier; Trino only ADDS the "Federated SQL (Trino)" engine
//   choice. The G2 gate (svc-loom-trino) discloses the AKS cost at enable time.
//
// Azure-native / OSS only. Trino, its Iceberg connector and the external
// connectors are all in-boundary — no SaaS query federation (no Starburst
// Galaxy, no Athena) is in the path, so the capability runs DISCONNECTED in an
// IL5 / air-gapped enclave. SaaS-only external connectors stay honestly gated in
// IL5. No Microsoft Fabric, no OneLake, no Power BI
// (.claude/rules/no-fabric-dependency.md).
//
// SECURITY POSTURE
//   - PRIVATE cluster (enablePrivateCluster + API-server VNet integration). The
//     coordinator has INTERNAL ingress only; the sole door is the Console BFF
//     (/api/sql/trino), which authenticates the caller, forwards the principal
//     as the Trino user, and writes a data-access audit row per query.
//   - IDENTITY-BASED storage auth via AKS Workload Identity: a user-assigned
//     managed identity (created in this module) federated to the Trino k8s
//     service account, holding **Storage Blob Data Reader** on the DLZ lake
//     (declared here via a guarded guid() role assignment). NO storage keys, NO
//     SAS, NO connection strings — the Iceberg connector reads data files in
//     place. Trino's read-only posture is enforced by its connector config.
//
// R0 PARAM-CAP RULE: admin-plane/main.bicep is at the ARM 256-parameter ceiling,
// so this module takes a single typed CONFIG-OBJECT bag and deploys OUT OF BAND
// (standalone entrypoint, orphan-allowlisted in scripts/ci/check-bicep-sync.mjs)
// exactly like the sibling data-plane/duckdb-aca.bicep and iceberg-catalog-aca.bicep.
//
//   az deployment group create -g <admin-rg> \
//     -f platform/fiab/bicep/modules/data-plane/loom-trino-aks.bicep \
//     -p location=<region> \
//        trinoConfig='{ "containerSubnetId": "<aks-subnet-id>", \
//                       "lakeStorageAccountName": "<dlz-adls-account>", \
//                       "lawId": "<log-analytics-workspace-id>", \
//                       "icebergCatalogUrl": "https://<iceberg-catalog-fqdn>" }'
//   # then install the Trino Helm chart onto the cluster (out-of-band phase,
//   #   like the loom-duckdb image build), binding the k8s ServiceAccount
//   #   `trino/trino` to the workload-identity client id output below, and:
//   # az containerapp update -n <console> -g <admin-rg> --set-env-vars \
//   #     LOOM_TRINO_URL=https://<internal-coordinator-fqdn>

targetScope = 'resourceGroup'

@description('Cluster / identity base name (DNS-label safe).')
@maxLength(24)
param name string = 'loom-trino'

@description('Deployment region (e.g. usgovvirginia / centralus).')
param location string = resourceGroup().location

@description('''R0 config bag — every setting for the opt-in Trino cluster in ONE typed object (admin-plane/main.bicep is at the ARM 256-param cap, so no new top-level params are added anywhere).

Required keys:
  containerSubnetId       In-VNet subnet resource id for the AKS node pools + private API server.
  lakeStorageAccountName  DLZ ADLS Gen2 account the Iceberg connector reads Delta/Iceberg/Parquet from.

Optional keys:
  lawId                   Log Analytics workspace resource id (omsagent + Defender). Empty => addons off.
  icebergCatalogUrl       LOOM_ICEBERG_CATALOG_URL (recorded on the identity/outputs; the Trino
                          catalog properties are set in the Helm values, not here).
  systemNodeCount / systemVmSize     System pool (defaults 3 / Standard_D4ds_v5).
  trinoNodeMinCount / trinoNodeMaxCount / trinoVmSize  Trino worker pool
                          (defaults 2 / 6 / Standard_D8ds_v5 — this is the disclosed heavy-infra cost).
  serviceAccountNamespace / serviceAccountName  Workload-identity subject (defaults trino / trino).
  assignLakeRole          Set false to skip the in-module role assignment when the
                          identity is granted out-of-band by an estate policy.''')
param trinoConfig object

@description('Compliance/cost tags. The loom-next-level tag is unioned in.')
param complianceTags object = {}

// ── Config-bag unpacking (typed locals; every optional key has a real default) ─
var containerSubnetId = trinoConfig.containerSubnetId
var lakeStorageAccountName = trinoConfig.lakeStorageAccountName
var lawId = string(trinoConfig.?lawId ?? '')
var systemNodeCount = int(trinoConfig.?systemNodeCount ?? 3)
var systemVmSize = string(trinoConfig.?systemVmSize ?? 'Standard_D4ds_v5')
var trinoNodeMinCount = int(trinoConfig.?trinoNodeMinCount ?? 2)
var trinoNodeMaxCount = int(trinoConfig.?trinoNodeMaxCount ?? 6)
var trinoVmSize = string(trinoConfig.?trinoVmSize ?? 'Standard_D8ds_v5')
var saNamespace = string(trinoConfig.?serviceAccountNamespace ?? 'trino')
var saName = string(trinoConfig.?serviceAccountName ?? 'trino')
var assignLakeRole = bool(trinoConfig.?assignLakeRole ?? true)

var tags = union(complianceTags, { 'loom-next-level': 'true' })

// Storage Blob Data Reader — the Iceberg connector only READS lake files. The
// built-in role id is cloud-invariant.
var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

// ── Workload identity for the Trino pods (federated to the k8s ServiceAccount) ─
resource trinoUami 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'uami-${name}'
  location: location
  tags: tags
}

resource lake 'Microsoft.Storage/storageAccounts@2024-01-01' existing = {
  name: lakeStorageAccountName
}

// Guarded guid() name — deterministic per (scope, identity, role) so a re-deploy
// is idempotent and two modules granting the same pair never collide.
resource lakeReadRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignLakeRole) {
  name: guid(lake.id, trinoUami.id, storageBlobDataReaderRoleId)
  scope: lake
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderRoleId)
    principalId: trinoUami.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── Private AKS cluster (mirrors admin-plane/container-platform.bicep) ─────────
resource aks 'Microsoft.ContainerService/managedClusters@2025-04-01' = {
  name: 'aks-${name}-${location}'
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    dnsPrefix: 'aks-${name}'
    enableRBAC: true
    aadProfile: {
      managed: true
      enableAzureRBAC: true
    }
    apiServerAccessProfile: {
      enablePrivateCluster: true
      enableVnetIntegration: true
      subnetId: containerSubnetId
    }
    agentPoolProfiles: [
      {
        name: 'system'
        count: systemNodeCount
        vmSize: systemVmSize
        mode: 'System'
        osType: 'Linux'
        osSKU: 'AzureLinux'
        vnetSubnetID: containerSubnetId
        availabilityZones: ['1', '2', '3']
        enableAutoScaling: true
        minCount: systemNodeCount
        maxCount: systemNodeCount + 2
      }
      {
        name: 'trino'
        count: trinoNodeMinCount
        vmSize: trinoVmSize
        mode: 'User'
        osType: 'Linux'
        osSKU: 'AzureLinux'
        vnetSubnetID: containerSubnetId
        availabilityZones: ['1', '2', '3']
        enableAutoScaling: true
        minCount: trinoNodeMinCount
        maxCount: trinoNodeMaxCount
        nodeLabels: { workload: 'trino' }
      }
    ]
    networkProfile: {
      networkPlugin: 'azure'
      networkPolicy: 'cilium'
      networkDataplane: 'cilium'
      loadBalancerSku: 'standard'
      outboundType: 'userDefinedRouting'
    }
    azureMonitorProfile: {
      metrics: { enabled: true }
    }
    addonProfiles: empty(lawId) ? {} : {
      omsagent: {
        enabled: true
        config: {
          logAnalyticsWorkspaceResourceID: lawId
        }
      }
    }
    securityProfile: {
      workloadIdentity: { enabled: true }
      imageCleaner: {
        enabled: true
        intervalHours: 24
      }
    }
    oidcIssuerProfile: { enabled: true }
  }
}

// Federated credential: bind the Trino k8s ServiceAccount to the workload UAMI
// so the Iceberg connector authenticates to ADLS as the identity (no secrets).
resource fedCred 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: trinoUami
  name: 'trino-workload'
  properties: {
    issuer: aks.properties.oidcIssuerProfile.issuerURL
    subject: 'system:serviceaccount:${saNamespace}:${saName}'
    audiences: ['api://AzureADTokenExchange']
  }
}

@description('AKS cluster resource id.')
output aksId string = aks.id

@description('AKS cluster name.')
output aksName string = aks.name

@description('OIDC issuer URL — used when installing the Trino Helm chart with Workload Identity.')
output oidcIssuer string = aks.properties.oidcIssuerProfile.issuerURL

@description('Trino workload identity client id — annotate the trino ServiceAccount with this.')
output workloadClientId string = trinoUami.properties.clientId

@description('Trino workload identity principal id (granted Storage Blob Data Reader on the lake here).')
output workloadPrincipalId string = trinoUami.properties.principalId

@description('True when the in-module lake read grant was created.')
output lakeRoleAssigned bool = assignLakeRole
