# fiab-0003: Catalog layering — UC managed + Purview overlay; Purview-primary in Gov; Atlas in IL5

> **Comparative positioning note.** This document is written from the
> perspective of Microsoft Azure, Cloud Scale Analytics, and CSA Loom. Any
> description of third-party or competing products, services, pricing, or
> capabilities is derived from **publicly available documentation and sources**
> believed accurate at the time of writing, and is provided for **general
> comparison only**. We do not claim expertise in, or authority over, any
> non-Microsoft product or service; the respective vendor's official
> documentation is the authoritative source for their offerings, which may
> change over time. Nothing here is intended to disparage any vendor — where a
> competing product has genuine advantages, we aim to note them honestly.
> Verify all third-party details against the vendor's current official
> documentation before making decisions.


**Status:** Accepted
**Date:** 2026-05-22
**Locked decision ref:** LD-8

## Context

CSA Loom needs a catalog architecture that:
1. Provides a technical catalog (table schemas, columns, lineage,
   permissions) for the underlying compute engines (Databricks +
   Synapse Serverless + ADX + Power BI)
2. Provides a governance overlay for sensitivity labels (MIP),
   business glossary, data products, cross-tenant audit, sovereignty
   controls
3. Exposes a cross-engine API so non-Databricks engines can read
   tables governed by the catalog
4. Works in every supported audit boundary (Commercial / GCC / GCC-
   High / IL5) — but the audit constraints differ per boundary

Per `temp/fiab-research/02-gov-boundary-availability.md` and
`temp/fiab-research/04-catalog-strategy.md`:

- **Databricks Unity Catalog managed** is the strategic technical
  catalog — full ABAC, row filters, column masks, system tables, MLflow,
  Iceberg REST endpoint. **But: not GA in usgovaz/usgovva as of 2026-
  05-22.** Databricks committed Azure Gov GA in CY2026, no specific
  quarter.
- **Microsoft Purview** is the strategic governance overlay — Data Map,
  Unified Catalog, MIP label propagation, business glossary, DSPM.
  **But: not in DoD IL5 audit scope.**
- **Apache Atlas (OSS)** is the federal-recognized lineage REST API;
  Spark / Synapse / Databricks have native hooks; deployable on AKS.
- **Unity Catalog OSS** (LF AI & Data sandbox-tier) is not production-
  grade enough for federal ATO defensibility today (v0.4.x; "APIs
  evolving"; recent 0.4.1 issuer-validation security patch).

## Decision

**Three-track catalog architecture by boundary:**

### Track A — Commercial / GCC (and Gov-IL4 when UC managed Gov-GA arrives)

```
Databricks Unity Catalog (managed)           ◄── primary technical catalog
  - ABAC + row filters + column masks + system tables
  - Iceberg REST endpoint for cross-engine reads
  - MLflow + Feature Store integration

Microsoft Purview Unified Catalog            ◄── sensitivity / sovereignty / audit overlay
  - Scans UC nightly via system.access + system.lineage
  - MIP sensitivity labels propagate to Power BI / downstream
  - Business glossary, data products, publication workflows
  - DSPM (GA May 2026 Commercial; July 2026 Gov)
```

### Track B — Gov-IL4 interim (until UC managed Gov-GA)

```
Microsoft Purview                            ◄── primary catalog
  - Scans every ADLS Gen2 account, Synapse Serverless DB, Power BI
  - Scans Databricks Hive metastore via one-way connector
  - MIP labels + business glossary + lineage

Databricks Hive metastore                    ◄── runtime catalog only
  - Workspace-scoped (no cross-workspace governance)
  - Manual lineage published from Spark/ADF → Purview via Atlas REST
```

### Track C — DoD IL5 (v1.1; Purview not in IL5 audit scope)

```
Self-hosted Apache Atlas on AKS              ◄── primary catalog
  - Solr + HBase + Kafka stack as Atlas dependencies
  - JanusGraph for lineage storage
  - Custom ABFS scanners for ADLS Gen2
  - Atlas REST API integration with Loom Console
```

### Track promotion (v1.1)

When UC managed reaches Gov-GA, ship the **catalog migration tool**
(PRP-102) that:
1. Scans Purview for Loom-registered assets
2. Registers eligible assets in the newly-provisioned UC managed
   metastore
3. Updates Console UI from "Purview primary" to "Purview overlay"
4. Maintains Purview overlay for sensitivity / sovereignty / audit

## Consequences

### Positive

- Customers in Commercial get the strongest available governance
  (UC managed + Purview overlay) with day-one Iceberg REST + system
  tables
- Federal customers in GCC-H get Purview-primary (mature, FedRAMP
  High + IL4 authorized) without depending on UC managed Gov-GA
  timing
- IL5 customers get Atlas-on-AKS (deployable in Azure Gov regions
  with IL5 isolation; lineage REST API matches federal expectations)
- Forward-compatible: Track B/C promotes to Track A as upstream
  Azure services reach Gov audit boundaries

### Negative

- Three catalog deployment paths to maintain (Bicep + Console adapters
  per track)
- Track B (Purview-primary) has a one-way connector to Databricks
  Hive — edits in Purview don't flow back to Hive
- Track C (Atlas-on-AKS) is operationally heavy (Solr + HBase + Kafka
  stack to operate)
- Customers running Track B who promote to Track A v1.1 have a
  one-time migration window

### Neutral

- The Console "Catalog" pane abstracts the underlying track —
  customers see the same UX regardless of boundary
- Sensitivity-label propagation (MIP → engine tags) works similarly
  in all tracks via a Function-based reverse-sync job

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| UC OSS as cross-engine hub | Sandbox-tier LF project; "APIs evolving" disclaimer; no FedRAMP attestation; disqualifying for federal ATO |
| Purview as primary in Commercial too | Loses UC's ABAC + system tables + MLflow integration; mediocre dev experience on Databricks |
| Three-layer (UC managed + UC OSS + Purview) | Three governance UIs to reconcile; highest build cost; no marginal benefit |
| No catalog at IL5 (rely on ADX schemas + manual lineage) | Loses sensitivity-label propagation + cross-engine lineage; federal customers will reject |

## References

- PRD: [`temp/fiab-prd/04-reference-architecture.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/04-reference-architecture.md) §4.4
- Amendments: [`temp/fiab-prd/AMENDMENTS.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-prd/AMENDMENTS.md) §A1-A5
- Research: [`temp/fiab-research/04-catalog-strategy.md`](https://github.com/fgarofalo56/csa-inabox/blob/csa-loom-pillar/temp/fiab-research/04-catalog-strategy.md)
- Parent ADR: [`docs/adr/0006-purview-over-atlas.md`](../../adr/0006-purview-over-atlas.md) — refined here for the Loom-in-Gov context
