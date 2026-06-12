// CSA Loom — Apache Atlas namespace on the admin AKS cluster (IL5 catalog primary)
//
// Deployed as a SEPARATE module (D7 — audit-t165) so the namespace lands in the
// AKS cluster's resource group (the console RG) even though the catalog
// dispatcher itself now lives in rg-csa-loom-shared-data. A
// `Microsoft.ContainerService/managedClusters/namespaces` child must be created
// in the same RG as its parent managed cluster — the catalog module is scoped to
// shared-data, so this child is split out and scoped back to the cluster's RG by
// the caller (catalog.bicep) via `scope: resourceGroup(<aks-rg>)`.
targetScope = 'resourceGroup'

@description('AKS managed cluster name (the admin container-platform cluster that hosts Atlas).')
param aksClusterName string

// Note: AKS namespace as a top-level ARM resource is preview-only. Production
// uses Flux/GitOps to apply k8s manifests; this Bicep resource at minimum
// creates the namespace + labels so the GitOps workflow has a target.
resource atlasNamespace 'Microsoft.ContainerService/managedClusters/namespaces@2025-04-01' = {
  name: '${aksClusterName}/atlas-csa-loom'
  properties: {
    metadata: {
      labels: {
        'csa-loom': 'catalog-primary'
      }
    }
  }
}
