# Catalog

Per [ADR fiab-0003](../adr/0003-catalog-layering.md), CSA Loom ships
a **three-track catalog architecture** by boundary.

## Track A — Commercial (and Gov-IL4 when UC managed Gov-GA arrives)

**Databricks Unity Catalog (managed)** as the primary technical
catalog + **Microsoft Purview Unified Catalog** as the sensitivity /
sovereignty / audit overlay.

| Layer | Role |
|---|---|
| UC managed | catalogs / schemas / tables / volumes / functions / models; ABAC + row filters + column masks + system tables; Iceberg REST endpoint for cross-engine reads |
| Purview Unified Catalog | scans UC nightly via system.access + system.lineage; MIP sensitivity labels propagate to Power BI; business glossary; DSPM (GA May 2026 Commercial; July 2026 Gov) |

Cross-engine consumption:
- Power BI Premium → Direct Lake / Direct-Lake-Shim on Delta (via
  UniForm)
- Synapse Serverless → external tables over ADLS Gen2 paths
- ADX → OneLake-style shortcuts
- Trino / DuckDB / Spark OSS → UC Iceberg REST

## Track B — Gov-IL4 interim (until UC managed Gov-GA)

**Microsoft Purview** as primary catalog. Databricks runs with
workspace-scoped Hive metastore.

| Layer | Role |
|---|---|
| Purview | scans every ADLS Gen2 account, Synapse Serverless DB, Power BI; scans Databricks Hive via one-way connector; MIP labels + business glossary + lineage |
| Databricks Hive metastore | runtime catalog only (workspace-scoped) |

Manual lineage published from Spark/ADF via Atlas REST API → Purview.

## Track C — DoD IL5 (v1.1; Purview not in IL5 audit scope)

**Self-hosted Apache Atlas on AKS** as primary catalog.

| Layer | Role |
|---|---|
| Atlas on AKS | Solr + HBase + Kafka stack; JanusGraph for lineage; Atlas REST API integration with Loom Console; custom ABFS scanners |

## Track promotion (v1.1)

When UC managed reaches Gov-GA, the **catalog migration tool**
(PRP-102) migrates Gov customers from Track B to Track A.

## Loom Console "Catalog" pane

Abstracts the underlying track. Same UI surface regardless of
boundary. Backed by per-track REST adapter:
- UC adapter (Commercial / GCC)
- Purview adapter (Gov-IL4)
- Atlas adapter (IL5)

Sensitivity-label propagation: MIP labels in Purview → UC tags via
reverse-sync job (Logic App + Function — community pattern).

## Related

- ADR: [fiab-0003 Catalog layering](../adr/0003-catalog-layering.md)
- Build PRP: PRP-12 — Catalog wiring
- Research: [`temp/fiab-research/04-catalog-strategy.md`](../../../temp/fiab-research/04-catalog-strategy.md)
- Parent: [Microsoft Purview Guide](../../guides/purview.md), [Unity Catalog Guide](../../guides/databricks-unity-catalog.md)
