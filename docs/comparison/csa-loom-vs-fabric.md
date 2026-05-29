# CSA Loom vs Microsoft Fabric — feature-by-feature

!!! info "Comparative positioning note"
    This document is written from the
    perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
    description of third-party or competing products, services, pricing, or
    capabilities is derived from **publicly available documentation and sources**
    believed accurate at the time of writing, and is provided for **general
    comparison only**. We do not claim expertise in, or authority over, any
    non-Microsoft product or service; the respective vendor's official
    documentation is the authoritative source for their offerings, which may
    change over time. Nothing here is intended to disparage any vendor — where a
    competing product has genuine advantages, we aim to note them honestly.
    Verify all third-party details against the vendor's current official
    documentation before making decisions.


_Last updated: 2026-05-22_

CSA Loom is a productized Azure-native parity layer for Microsoft
Fabric, deployable into any Azure tenant where Fabric isn't yet
generally available. This page is the side-by-side capability
comparison.

For the older / broader csa-inabox vs Fabric comparison, see
[CSA-in-a-Box vs Microsoft Fabric](csa-inabox-vs-fabric.md). This
page is **CSA Loom-specific** — Loom is the productized SaaS-feel
form of csa-inabox.

## Positioning at a glance

| | CSA Loom | Microsoft Fabric |
|---|---|---|
| **Shape** | Productized + customer-deployable parity layer on Azure-native + open source | Unified SaaS analytics platform |
| **Where it ships** | Commercial + GCC + GCC-High + IL5 (v1.1) | Azure Commercial GA; Gov **`Forecasted`** (no public date) |
| **Audit boundaries** | FedRAMP High + DoD IL4 + IL5 + ITAR-eligible | FedRAMP High + DoD IL2 (Commercial baseline) |
| **Compute model** | Hybrid Databricks + Synapse Serverless + ADX + Power BI Premium | F-SKU capacity (single CU pool) |
| **Pricing** | Free in v1 (Azure consumption only) | F-SKU + overage |
| **Vendor coupling** | Microsoft 1P + open-source under the covers | Microsoft 1P SaaS |
| **Best fit** | Federal / DoD / regulated commercial blocked from Fabric | Commercial; wants managed SaaS simplicity |

## Per-capability comparison

See the full [CSA Loom parity matrix](../fiab/parity-matrix.md) for
the workload-by-workload table. Headline differences:

### Storage + namespace

| Capability | CSA Loom | Fabric |
|---|---|---|
| Storage primitive | ADLS Gen2 + unified path tree | OneLake (single tenant-wide namespace) |
| Shortcuts | Loom Shortcuts service (cross-cloud, ADLS) | OneLake shortcuts (ADLS, S3, GCS) |
| RBAC enforcement | Engine-layer (UC / Purview / Synapse / Power BI / ADX) | Storage-protocol-layer (OneLake Security) |
| Cross-engine | UC Iceberg REST + Delta UniForm (Commercial); manual (Gov) | OneLake native |

### Direct Lake (the headline difference)

| Capability | CSA Loom | Fabric |
|---|---|---|
| Engine | Power BI Premium Import + warm-cache materializer | VertiPaq direct over Delta-Parquet |
| Freshness | 5-30 seconds (partition refresh) | Sub-second |
| Storage mode | Import (with Direct-Lake-Shim refresh) | Direct Lake (native) |
| F-SKU required | Yes (in GCC-H/IL5); no parity in GCC | Yes (F-SKU only) |

**Honest gap**: sub-second freshness is not achievable in Loom.
See [Direct Lake parity workload page](../fiab/workloads/direct-lake-parity.md)
for the engineering rationale.

### Data Activator / Reflex

| Capability | CSA Loom Activator Engine | Fabric Reflex |
|---|---|---|
| Engine | ADX + NRules + Redis + Function dispatcher | KQL/Eventhouse + per-object state engine |
| Rule primitives | All 8 Fabric primitives implemented | Native |
| End-to-end latency | 5-30 s | 5-30 s |
| Action surface | Teams / Email / Power Automate / Logic App / Databricks Job / ADF / UDF / webhook | Same surface + native Fabric items |

### Mirroring (zero-ETL CDC)

| Capability | CSA Loom Mirroring Engine | Fabric Mirroring |
|---|---|---|
| Sources | Azure SQL / Postgres / MySQL / Cosmos / Snowflake / Oracle / SAP (Open Mirroring) | Same sources native |
| Mechanism | OSS Debezium + Spark Structured Streaming + Delta MERGE | First-party |
| Latency | Sub-minute steady-state | Sub-minute steady-state |
| First-touch UX | Templated configs + CLI (v1); Console UI (v1.1) | Click-to-mirror native |

### Data Agents

| Capability | CSA Loom Data Agents | Fabric Data Agents |
|---|---|---|
| Foundation | Extends `apps/copilot/` + `azure-functions/copilot-chat/` | Azure OpenAI Assistant API |
| Tools | NL2SQL + NL2DAX + NL2KQL + Microsoft Graph + custom AI Search | Same |
| Identity passthrough | OBO via MSAL BFF | Native (Entra Agent ID) |
| Up to 5 data sources per agent | Yes | Yes |
| Foundry integration | Commercial only (when Foundry Agent Service available) | Native |

### Compliance + Sovereignty

| Boundary | CSA Loom | Microsoft Fabric |
|---|---|---|
| Azure Commercial GA | ✅ | ✅ |
| Azure Government GCC | ✅ | `Forecasted` |
| Azure Government GCC-High / IL4 | ✅ | `Forecasted` |
| Azure Government DoD IL5 | ✅ v1.1 | `Forecasted` |
| ITAR (in GCC-High) | ✅ | ❌ |
| HIPAA BAA | ✅ all boundaries | ✅ Commercial |
| CMMC L2 / L3 | ✅ | Commercial only |

**This is the headline differentiator.** Fabric is `Forecasted`
across all four Gov boundaries today. Federal customers cannot
adopt Fabric — and CSA Loom is what they should deploy.

## When to choose which

### Choose Microsoft Fabric if

- You're on Azure Commercial
- Power BI is central to your delivery
- You want the simplest possible operational footprint (single CU
  pool, one workspace plane)
- You don't need fine-grained Bicep / per-resource control
- You're comfortable with Microsoft-SaaS coupling

### Choose CSA Loom if

- You're on Azure Government (or migrating to it)
- ITAR / CMMC L2/L3 requirements
- IL5 audit scope (v1.1)
- You have existing Synapse / Databricks investment to evolve
- Spark / ML workloads are heavy enough to want Photon + UC
- You need per-DLZ subscription isolation (multi-domain federal)
- You want `publicNetworkAccess = disabled` everywhere via Bicep

### Choose BOTH (hybrid)

- Federal customer with both Commercial + Gov estates
- Pattern: Fabric in Commercial for public data; Loom in Gov for
  CUI / classified
- See [Hybrid topology use case](../fiab/use-cases/hybrid-topology.md)

## Forward migration

When Microsoft Fabric reaches your audit boundary:

| CSA Loom artifact | Fabric equivalent | Migration mechanism |
|---|---|---|
| Delta tables | OneLake Delta tables | **Zero data movement** (OneLake shortcut) |
| dbt models | dbt in Fabric Data Factory | **Low** (dbt-fabric adapter) |
| Notebooks | Fabric Spark notebooks | Medium (runtime swap) |
| TMDL semantic models | Direct Lake on OneLake | Medium (re-author) |
| ADX databases / KQL | Fabric Eventhouse | **Low** (same engine) |
| Activator rules | Fabric Reflex | Low-Medium (JSON port) |
| Data Agents | Fabric Data Agents | Low (config export/import) |
| Purview catalog | Fabric Purview | **Zero** (same engine) |

See [Forward to Fabric runbook](../fiab/runbooks/forward-migrate-to-fabric.md).

## Related

- [CSA Loom — the pillar](../fiab/index.md)
- [CSA Loom — parity matrix (workload-by-workload)](../fiab/parity-matrix.md)
- [CSA Loom — reference architecture](../fiab/architecture.md)
- [CSA-in-a-Box vs Microsoft Fabric (legacy comparison)](csa-inabox-vs-fabric.md)
- [Microsoft Fabric in Azure Government — availability](../fabric-in-gov-cloud.md)
- ADR: [`fiab-0012` — Forward migration](../fiab/adr/0012-forward-migration.md)

## See also

- ← Previous: [Microsoft Fabric Platform Guide](../guides/microsoft-fabric.md)
- → Next: [CSA Loom — overview](../fiab/index.md)
- ⌂ Index: [Documentation home](../index.md)
