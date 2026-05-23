# Data Residency

CSA Loom enforces data residency through per-resource region pinning
in Bicep + Azure policy enforcement.

## Per-boundary residency

| Boundary | Allowed Azure regions |
|---|---|
| Commercial | Any global Azure region per customer choice |
| GCC | Azure Commercial US regions only (eastus, westus, etc.) |
| GCC-High / IL4 | usgovvirginia, usgovtexas, usgovarizona (Azure Government) |
| IL5 (v1.1) | usdodcentral, usdodeast (US DoD regions) OR usgov* with IL5 isolation config |

Per [Reference architecture §4.3](../architecture.md), the boundary-
specific `.bicepparam` files set `location` + endpoint suffixes
accordingly. Bicep `@allowed` constraints prevent cross-boundary
misconfiguration.

## Cross-region replication (within boundary)

| Component | Replication |
|---|---|
| ADLS Gen2 | GRS / RA-GRS within the boundary's region pair (e.g., usgovvirginia ↔ usgovtexas for GCC-H) |
| Cosmos DB | Multi-region writes within boundary |
| Key Vault | Geo-replicated within boundary |
| Databricks workspace | Single region; DR via re-deploy from Bicep |
| Synapse workspace | Single region |
| Power BI Premium capacity | Pinned to one region; cross-region replication via Power BI service when supported |
| ADX cluster | Single region; follower cluster pattern for DR (v1.1) |

## Cross-cloud data movement

Loom doesn't move data across boundaries. Cross-boundary scenarios
(e.g., Commercial public dataset → Gov tenant) use:

- **Cross-cloud B2B** for identity (see [Hybrid topology](../use-cases/hybrid-topology.md))
- **Customer-controlled** data import via Azcopy + audited via
  Activity Log
- **OneLake shortcut** to S3 / GCS (read-only) when the customer
  consents to the cross-cloud egress

## Encryption + sovereignty

| Boundary | Encryption-at-rest | CMK requirement |
|---|---|---|
| Commercial | Microsoft-managed (FIPS 140-2 validated) | Optional |
| GCC | Same as Commercial | Optional |
| GCC-High / IL4 | Microsoft-managed | Recommended (Key Vault Premium) |
| IL5 (v1.1) | **CMK required** | **HSM-backed CMK + infrastructure encryption** (`requireInfrastructureEncryption: true`) |

## Egress controls

Every Loom workload deploys with `publicNetworkAccess = disabled`.
Private endpoints for storage, KV, OpenAI, Databricks, Purview, ADX,
AI Search, ACR, Cosmos. Outbound egress restricted by Azure Firewall
app rules (allow-list of FQDN destinations).

## Audit trail

Every data-residency-relevant action (cross-region replication
toggle, CMK rotation, OAP rule change) → Activity Log → Sentinel
(Gov boundaries).

## Related

- ADR: [fiab-0010 Container host](../adr/0010-container-host.md), [fiab-0011 Tenancy model](../adr/0011-tenancy-model.md)
- Compliance: [Compliance index](../compliance/index.md)
- Parent: [Multi-Region](../../MULTI_REGION.md), [Multi-Tenant](../../MULTI_TENANT.md)
