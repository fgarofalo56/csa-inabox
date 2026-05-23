# PRP-12 — Catalog Two-Track Wiring

## Context

Per AMENDMENTS §A1-A5: Commercial / GCC use Databricks Unity Catalog
managed + Microsoft Purview overlay. Gov-IL4 uses Microsoft Purview as
primary (UC managed not yet in Gov per `research/02-gov-boundary-
availability.md §7.1`). IL5 (v1.1) uses self-hosted Apache Atlas on
AKS (Purview not in IL5 audit scope per `research §7.4`).

PRD ref: `temp/fiab-prd/04-reference-architecture.md` §4.4;
`temp/fiab-prd/05-workload-parity.md` §5.11.

## Goal

Catalog deployment + integration wired per boundary in the platform
Bicep, with Loom Console catalog pane that reads from the correct
backend per boundary. Migration tool (v1.1) ships when UC managed
reaches Gov-GA.

## Acceptance criteria

- [ ] Bicep module `platform/fiab/bicep/modules/admin-plane/catalog.bicep`
  branches on `catalogPrimary` parameter:
  - `unity-catalog-managed`: provisions UC metastore + assigns
    workspaces (Commercial / GCC)
  - `purview`: provisions Purview account + scan-set definitions
  - `atlas-aks`: deploys Apache Atlas (Solr + HBase + Kafka) on AKS
    (v1.1 only)
- [ ] One-way Purview ↔ UC connector configured in
  Commercial / GCC for the sensitivity overlay (per
  `research/04-catalog-strategy.md §4`)
- [ ] Custom ADLS Gen2 scanner for Atlas at IL5 (v1.1)
- [ ] Loom Console "Catalog" pane (in PRP-03) abstracts the underlying
  catalog: same UI surface; per-boundary REST adapter
- [ ] Sensitivity-label propagation: MIP labels authored in Purview
  applied to UC tags via reverse-sync job (community pattern)
- [ ] System tables in UC (`system.access.*`, `system.lineage.*`)
  enabled for Purview scan ingestion

## Validation gates

- E2E in Commercial: scan a Databricks lakehouse via Purview; assert
  UC tags + Purview classifications align
- E2E in GCC-H: scan ADLS Gen2 + Synapse Serverless schemas via
  Purview; assert lineage graph populated
- Console "Catalog" pane: same UX in both boundaries; underlying
  driver swaps transparently

## Implementation outline

1. Catalog Bicep module with boundary dispatch
2. Purview scan-set definitions per source type (Databricks UC,
   Synapse Serverless, ADX, Power BI, ADLS Gen2)
3. Loom Console catalog adapter (UC client + Purview client + Atlas
   client; v1.1)
4. Reverse-sync job (Logic App + Function) — MIP labels → UC tags
5. System-tables enable script in Databricks workspace

## File changes

```
platform/fiab/bicep/modules/admin-plane/catalog.bicep    created
platform/fiab/bicep/modules/admin-plane/atlas-aks.bicep  created (v1.1 ready; conditional in v1)
platform/fiab/bicep/modules/admin-plane/purview-scans.bicep created
apps/fiab-console/lib/clients/catalog/                   created (UC, Purview, Atlas adapters)
apps/fiab-catalog-sync/                                  created (Function App: MIP → UC tags)
```

## Open questions / risks

- UC managed Gov GA timing — track quarterly; promotion track in PRP-102
- Atlas on AKS is heavy ops; v1.1 only; document early so customers know
- Power BI has no native Iceberg connector — Direct Lake reads OneLake/
  Delta directly; doesn't matter for FiaB Direct-Lake-Shim (which uses
  Premium Import via TOM)

## References

- `temp/fiab-prd/04-reference-architecture.md` §4.4
- `temp/fiab-research/04-catalog-strategy.md`
