# Forward migration to Microsoft Fabric

The strategic anchor of CSA Loom. When Microsoft Fabric reaches your
audit boundary, forward-migrate your workloads with minimal rewrite.

## When to migrate

Trigger conditions:
- Microsoft Fabric reaches your audit boundary GA (FedRAMP High /
  IL4 / IL5)
- Your customer has F-SKU Fabric capacity available
- You've completed Loom v1 stabilization (not mid-deployment)

Verify via [Azure Government product GA roadmap](https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap)
+ subscribe to the Fabric Blog Gov announcements channel.

## Migration matrix

Per [ADR fiab-0012](../adr/0012-forward-migration.md):

| Loom artifact | Fabric equivalent | Migration mechanism | Effort |
|---|---|---|---|
| ADLS Gen2 Delta tables | OneLake Delta tables | OneLake shortcut → **zero data movement** | **Low** |
| Loom workspaces | Fabric workspaces | Re-create with same name/domain; bind to same Git folder | Low |
| Loom Domains | Fabric Domains | Domain metadata exports to JSON; Fabric Domains API import | Low |
| Loom Mirroring configs (Debezium-based) | Fabric Mirroring | Per-source case-by-case; switch when Fabric Mirroring covers source | Variable |
| Loom Activator rules | Fabric Reflex / Data Activator | JSON export → Reflex import; rule primitives mostly map 1:1 | Low-Medium |
| Loom Data Agents | Fabric Data Agents | Agent config JSON → Fabric Data Agents REST API | Low |
| Direct-Lake-Shim semantic models | Direct Lake on OneLake | Re-author TMDL for Direct Lake on OneLake storage mode | Medium |
| Databricks notebooks | Fabric Spark notebooks | Git folder port; rebuild deps for Fabric Spark runtime | Medium |
| dbt models | dbt in Fabric Data Factory | dbt-fabric adapter; **change connection string** | **Low** |
| Synapse Serverless tables | Fabric Warehouse | Re-create as Warehouse tables; T-SQL DDL ports | Medium |
| Databricks SQL Warehouse tables | Fabric Warehouse | Re-create; UC tables → Fabric items | Medium |
| ADX databases / KQL queries | Fabric Eventhouse | **Same engine**; databases attach as Eventhouse | **Low** |
| Power BI semantic models | Power BI in Fabric | Already in Power BI Premium; rebind to OneLake shortcut | Low |
| Purview catalog | Fabric Purview | **Same engine**; Fabric items auto-register | **Zero** |

## Migration tooling — `fiab-migrate` CLI (v1.1)

```bash
# 1. Snapshot the Loom estate
fiab-migrate snapshot \
  --admin-plane-sub-id <SUB-A> \
  --output ./loom-state.json

# 2. Plan migration to target Fabric capacity
fiab-migrate plan \
  --snapshot ./loom-state.json \
  --target-fabric-tenant <TENANT> \
  --target-capacity F128 \
  --output ./migration-plan.json

# 3. Execute the plan
fiab-migrate execute \
  --plan ./migration-plan.json \
  --dry-run    # or --commit

# 4. Verify
fiab-migrate verify \
  --plan ./migration-plan.json
```

The plan output flags per-item migration verdict (Direct / Manual /
Skip) so customer can prioritize.

## OneLake shortcut as the data-movement bridge

For Delta tables, forward migration is **zero data movement**:

1. Create OneLake shortcut from Fabric workspace pointing at the
   existing Loom ADLS Gen2 lakehouse path
2. Data is queryable from Fabric workloads immediately
3. Customer optionally promotes data into native OneLake paths later
   via copy (incremental, customer-paced)

## Side-by-side run pattern

Most customers run Loom and Fabric side-by-side for N weeks during
transition:

1. Migrate semantic models + Power BI reports first (lowest risk;
   highest user-visibility)
2. Keep Loom Activator + Mirroring + Direct-Lake-Shim running for
   workloads not yet migrated
3. Migrate workloads piecemeal — pipeline-by-pipeline, dashboard-by-
   dashboard
4. Validate parallel-run results (KQL query against both systems;
   diff results)
5. After ~30-90 days of clean side-by-side, decommission Loom
   components per workload

## Decommissioning Loom (after migration complete)

- Loom Console: stop the Container App / AKS workload; tear down RG
- Loom Mirroring Engine: stop CDC connectors; verify Fabric Mirroring
  covers all sources
- Loom Activator Engine: confirm all rules migrated to Reflex; stop
  service
- Loom Direct-Lake-Shim: stop service (Direct Lake handles freshness
  natively in Fabric)
- Loom Data Agents: confirm migrated to Fabric Data Agents; stop
  extension service
- ADLS Gen2 lakehouses: keep (now accessed via OneLake shortcut from
  Fabric)
- Catalog (Purview / UC): keep — Fabric uses the same Purview

## Reverse migration (Fabric → Loom)

Less common but legitimate (customer pilots in Fabric Commercial,
moves to Gov). See [Upgrade & migration](upgrade-migration.md).

## Commitments

Loom commits:
- **OneLake shortcut path remains stable** across Loom versions
- **dbt models port unchanged** (no Loom-specific extensions)
- **TMDL semantic-model format is canonical**
- **Activator rule JSON schema is published**
- **`fiab-migrate` CLI ships in v1.1** — included in standard support

## Related

- ADR: [fiab-0012 Forward migration](../adr/0012-forward-migration.md)
- Runbook: [Forward migrate to Fabric](../runbooks/forward-migrate-to-fabric.md)
- Use case: [Hybrid Fabric Commercial + Loom Gov](../use-cases/hybrid-topology.md)
- Parent: [Microsoft Fabric in Azure Government](../../fabric-in-gov-cloud.md)
