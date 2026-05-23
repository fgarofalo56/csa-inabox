# Multi-cloud data virtualization

CSA Loom is Azure-first but supports **read-side virtualization**
across cloud boundaries via ADLS Gen2 shortcuts + Loom's Shortcuts
service (covered in [OneLake parity](../workloads/onelake-parity.md)).

## Supported cross-cloud reads

| Source | Mechanism |
|---|---|
| AWS S3 | ADLS Gen2 shortcut via Loom Shortcuts service; IAM role for delegated credential |
| Google Cloud Storage | ADLS Gen2 shortcut; GCS workload identity federation |
| ADLS Gen2 (another tenant) | Cross-tenant shortcut with delegated SAS / Entra B2B |
| Snowflake (read-only) | External data sharing via Delta Sharing protocol (v1.1) |
| Databricks (other workspace) | Delta Sharing protocol |

All cross-cloud reads:
- Are **customer-controlled** — Loom doesn't initiate cross-cloud
  data movement
- Carry an **audit trail** — every shortcut access logged
- Honor **per-boundary egress rules** — IL5 restricts which external
  destinations are reachable via Azure Firewall app rules

## When to use cross-cloud virtualization

| Scenario | Pattern |
|---|---|
| Read public datasets from S3 (NOAA, Census, etc.) | ADLS Gen2 shortcut with anonymous public access |
| Enrich Loom analytics with partner data in another cloud | Cross-tenant shortcut + B2B identity |
| Cross-cloud analytics across hybrid Fabric Commercial + Loom Gov | OneLake shortcut from Fabric to Loom ADLS Gen2 path (when Fabric reaches Gov) |
| Migrate from S3 / GCS to ADLS Gen2 | Use shortcut as bridge; gradually copy to native ADLS |

## When NOT to use cross-cloud

- Customer hasn't approved the cross-cloud egress
- The data is restricted by IL5 / ITAR / CUI policies that prevent
  external read
- Latency-sensitive use cases (cross-cloud reads have 100-500 ms
  per-request latency)

## What Loom doesn't support

- **Cross-cloud writes** — Loom doesn't write to S3 / GCS
- **Federated query joining S3 + GCS + ADLS in one query** — joins
  require landing data in ADLS first (via shortcut + materialize)
- **Cross-cloud Power BI Direct Lake** — Direct Lake reads from
  ADLS / OneLake only

## Cross-cloud B2B identity

For human cross-cloud collaboration:
- Entra ID Cross-Cloud Settings configures B2B trust between Azure
  Commercial + Azure Gov tenants
- Users invited as guests can read approved resources
- Conditional Access policies on both sides enforce MFA + compliance
- Documented in [Hybrid topology use case](../use-cases/hybrid-topology.md)

## Related

- ADR: [fiab-0012 Forward migration](../adr/0012-forward-migration.md)
- Use case: [Hybrid Fabric Commercial + Loom Gov](../use-cases/hybrid-topology.md)
- Workload: [OneLake parity](../workloads/onelake-parity.md)
- Parent: [Multi-Cloud Data Virtualization with Azure](../../use-cases/multi-cloud-data-virtualization.md)
