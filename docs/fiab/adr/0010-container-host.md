# fiab-0010: Container host — Container Apps in Commercial/GCC; AKS in GCC-High/IL5

**Status:** Accepted
**Date:** 2026-05-22

## Context

CSA Loom deploys several workloads as containers:
- Loom Console (Next.js)
- Loom Setup Orchestrator (Tier B MAF in Gov)
- Self-hosted Azure MCP server
- Loom Activator Engine
- Loom Mirroring Engine (Debezium Connect runtime)
- Loom Direct-Lake Shim
- Loom Data Agents extension service
- Atlas catalog (IL5 only)
- Presidio sidecar (Gov where Content Safety unavailable)

Per `temp/fiab-research/02-gov-boundary-availability.md §7.11`:

> Azure Container Apps in Gov:
> - ✅ FedRAMP High (Azure Gov)
> - ✅ DoD IL2
> - ❌ **NOT in IL4**
> - ❌ **NOT in IL5**

This is the second-biggest constraint after Databricks SQL Warehouse.
**Container Apps cannot host CSA Loom in GCC-High / IL4 / IL5**.

AKS, by contrast, is authorized FedRAMP High + IL4 + IL5 + IL6 in
Azure Gov.

## Decision

**Dispatch container host by boundary:**

- **Commercial / GCC**: Azure Container Apps
- **GCC-High / IL4 / IL5**: Azure Kubernetes Service (AKS)

Bicep parameter `containerPlatform` (`'containerApps' | 'aks'`) drives
the dispatch. Each workload's Bicep module branches on this parameter:

```bicep
// In platform/fiab/bicep/modules/admin-plane/console-app.bicep:
@allowed(['containerApps', 'aks'])
param containerPlatform string

resource consoleAca 'Microsoft.App/containerApps@2024-03-01' = if (containerPlatform == 'containerApps') {
  // Container App definition
}

resource consoleAksHelm 'helmReleases' = if (containerPlatform == 'aks') {
  // Helm release into AKS cluster
}
```

Per-workload container images are **identical** across both hosts.
The Dockerfile / build pipeline produces one image per workload that
runs on either Container Apps or AKS without modification.

Helm charts under `apps/<workload>/helm/` define the AKS deployment
shape (Deployment + Service + Ingress + NetworkPolicy). The
`platform/fiab/bicep/modules/admin-plane/container-platform.bicep`
module deploys either:
- Container App Environment + per-workload Container Apps
- AKS cluster + Helm chart installs per workload

## Consequences

### Positive

- Container Apps' scale-to-zero + fast deployment is great for low-
  utilization Commercial / GCC tenants
- AKS gives full Kubernetes control + IL5 audit compliance for federal
  tenants
- Container images are identical — engineering team builds + tests
  once; deployment shape is the only delta
- No code changes per boundary — runtime behavior is identical

### Negative

- Two deployment patterns to maintain (Container App Bicep + Helm
  chart per workload)
- AKS operational overhead is higher (node-pool patching, networking,
  ingress controllers) vs Container Apps' fully-managed model
- Helm chart authoring is engineering investment per workload (~1
  day per workload to author + smoke-test in v1)
- Federal customers running in GCC-High / IL5 carry the AKS
  operational burden

### Neutral

- AKS supports HPA + autoscaler for the same scaling intent as
  Container Apps; just configured differently
- Both hosts pull images from the Admin Plane's ACR — same image
  registry pattern in both boundaries
- Both hosts authenticate via UAMI; same identity story

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Container Apps everywhere | Not authorized at IL4 / IL5 — blocks federal v1 |
| AKS everywhere | Higher operational overhead for Commercial / GCC tenants; Container Apps is the simpler managed option there |
| Azure App Service everywhere | Doesn't support the per-workload container patterns we need (Debezium Connect, Spark Streaming, Atlas-on-AKS stack) |
| VM Scale Sets | Heavy ops; reinvents Kubernetes / Container Apps' scaling model |
| Wait for Container Apps IL4/IL5 audit | No public timeline; blocks federal v1 |

## References

- PRD: [`temp/fiab-prd/04-reference-architecture.md`](../../../temp/fiab-prd/04-reference-architecture.md) §4.3
- Research: [`temp/fiab-research/02-gov-boundary-availability.md`](../../../temp/fiab-research/02-gov-boundary-availability.md) §7.11
- External: [Azure services in FedRAMP/DoD audit scope](https://learn.microsoft.com/azure/azure-government/compliance/azure-services-in-fedramp-auditscope)
- Build: PRP-02 — `platform/fiab/bicep/modules/admin-plane/container-platform.bicep`
