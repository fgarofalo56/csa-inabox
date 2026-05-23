# OneLake parity

## What Fabric does

OneLake is Microsoft Fabric's single logical data lake — one
provisioned per tenant. Every Fabric workload writes here automatically.
Built on ADLS Gen2 APIs/SDKs underneath, exposed through a unified
namespace at `https://<tenant>.onelake.dfs.fabric.microsoft.com`.
Delta Parquet is the default table format; **OneLake shortcuts** mount
to any ADLS Gen2 / S3 / GCS / SharePoint / OneDrive location with
delegated credentials managed by the gateway. As of May 2026, OneLake
Security enforces RLS/CLS/object-level grants uniformly across Spark,
Polaris T-SQL, KQL, and semantic models at the storage protocol layer.

## CSA Loom parity design

CSA Loom delivers an **engine-layer** equivalent of OneLake:

### Storage substrate

- **ADLS Gen2** storage accounts, hierarchical namespace enabled
- One storage account per DLZ (per domain), with containers per
  workspace
- Path convention: `<workspace>/<lakehouse>/Tables/<table>/`
  and `<workspace>/<lakehouse>/Files/<file>` — matches OneLake's path
  shape to ease forward migration

### Unified namespace

The Loom Console renders a unified "OneLake-equivalent" path tree
that resolves to the correct ADLS account + container + path. Clients
that read raw ABFS paths get the real underlying URL — Loom doesn't
require routing through a custom gateway for IO performance.

### Shortcuts service

`apps/fiab-shortcuts-service` (lightweight Container App / AKS workload)
maintains shortcut definitions in Cosmos DB:
- ADLS Gen2 → ADLS Gen2 shortcuts (cross-workspace, cross-DLZ)
- Cross-cloud shortcuts to S3 / GCS with short-lived STS credentials
  minted on read
- Caches recently-read paths in Azure Cache for Redis (configurable
  retention)
- Surfaces shortcut CRUD via REST API consumed by the Loom Console

### RBAC + RLS + CLS — engine-layer enforcement

Two-layer enforcement:

| Layer | Mechanism |
|---|---|
| Storage | ADLS Gen2 ACLs + Storage RBAC for service-account separation between DLZs and workspaces |
| Engine | Unity Catalog row filters + column masks (Commercial); Synapse Serverless RLS + Spark SQL views (Gov); ADX row-level security; Power BI semantic-model RLS |

### OneLake Catalog equivalent

The Loom Console **Catalog** pane provides cross-workspace metadata
discovery + Search backed by UC + Purview (Commercial / GCC) or
Purview (Gov-IL4) or Atlas (IL5).

## Per-boundary behavior

| Boundary | Notes |
|---|---|
| Commercial / GCC | ADLS Gen2 + UC catalog tags + Purview overlay |
| GCC-High / IL4 | Same; Purview-primary; HSM-CMK optional |
| DoD IL5 (v1.1) | HSM-CMK required; double-encryption (`requireInfrastructureEncryption: true`); Atlas-on-AKS catalog |

## Honest gaps

- **No engine-agnostic enforcement.** Fabric's OneLake Security
  enforces RLS/CLS in the storage protocol; CSA Loom enforces at the
  engine layer. A user reading raw ABFS bypasses row/column filters.
  Mitigation: network-isolate storage (PE-only) + gate access through
  engines.
- **Shortcuts have 20-80 ms latency overhead** — same as Fabric's
  OneLake shortcuts; acceptable for large sequential reads.
- **Write-back shortcuts** to non-ADLS targets — v1 ships read-only
  cross-cloud; v1.1 considers write-back via the shortcuts service.
- **No single tenant-wide DFS hostname** — clients use
  `<account>.dfs.core.windows.net` directly (not a unified
  `onelake.contoso.com`). The Console namespace tree gives the visual
  unification.

## Forward migration

When Fabric Gov GA arrives:

1. Create OneLake shortcuts pointing at the Loom ADLS Gen2 paths —
   **zero data movement**
2. Data is queryable from Fabric workloads immediately
3. Customer optionally promotes selected workloads into native
   OneLake paths via copy at their cadence
4. Loom shortcuts service is retired (Fabric's native shortcuts
   handle cross-cloud reads)

## Related

- ADR: [fiab-0003 Catalog layering](../adr/0003-catalog-layering.md)
- Build PRP: PRP-02 (storage Bicep) + PRP-12 (catalog wiring)
- Tutorial: [Tutorial 02 — First lakehouse + Delta tables](../tutorials/02-first-lakehouse.md)
- Governance: [Catalog](../governance/catalog.md)
