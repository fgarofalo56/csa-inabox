# Lineage

## Sources of lineage

CSA Loom surfaces lineage from every compute engine:

| Engine | Lineage source |
|---|---|
| Databricks Spark | `system.lineage_*` system tables (Commercial); manual via Atlas REST (Gov where UC managed not yet available) |
| Databricks SQL Warehouse | Same as Spark (Commercial) |
| Synapse Serverless | Synapse diagnostic logs → ADF → Purview |
| ADF pipelines | Native ADF → Purview integration |
| Azure Data Explorer | `.show database schema` + update policies → Atlas REST |
| Power BI semantic models | Power BI activity log + lineage view |
| Loom Mirroring Engine | CDC source → Bronze table lineage published to catalog overlay |
| Loom Activator Engine | Rule → action lineage stored in Cosmos DB |
| Loom Direct-Lake-Shim | Lakehouse partition → semantic model refresh log |

## Per-track lineage UX

| Track | Lineage display |
|---|---|
| UC managed + Purview (Commercial / GCC) | Console "Catalog" pane shows lineage from UC system tables + Purview lineage graph for cross-engine joins |
| Purview-primary (Gov-IL4) | Purview lineage graph |
| Atlas (IL5) | Atlas UI (embedded in Console) + JanusGraph queries |

## Cross-engine lineage

A Loom workspace's typical pipeline:

```
Operational DB (CDC source)
   ↓ Loom Mirroring Engine
Bronze Delta table (ADLS Gen2)
   ↓ Databricks Spark notebook (medallion transforms)
Silver Delta table
   ↓ Databricks Spark / dbt
Gold Delta table
   ↓ Loom Direct-Lake-Shim (warm cache)
Power BI semantic model
   ↓ Power BI report
End user
```

Every arrow in this graph emits a lineage event. The catalog overlay
(UC + Purview or Purview-primary or Atlas) renders the end-to-end
graph in the Console.

## Lineage retention

| Boundary | Default retention |
|---|---|
| Commercial | 90 days |
| GCC / GCC-H | 1 year (federal audit requirements) |
| IL5 | 7 years (CNSSI 1253) |

Configurable via `platform/fiab/bicep/modules/admin-plane/catalog.bicep`
parameters.

## Limitations

- **Notebook-internal lineage** (function-level lineage) — not
  captured today; v1.1 considers DataHub-style call-graph capture
- **Cross-tenant lineage** (e.g., to a Power BI report in another
  tenant) — not captured; out of scope
- **External lineage** (e.g., to a Tableau workbook outside Loom) —
  not captured; documented as a gap

## Related

- ADR: [fiab-0003 Catalog layering](../adr/0003-catalog-layering.md)
- Catalog: [Catalog](catalog.md)
- Parent: [Data Lineage Guide](../../governance/DATA_LINEAGE.md)
