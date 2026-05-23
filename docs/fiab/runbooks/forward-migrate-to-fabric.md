# Runbook — Forward migrate to Microsoft Fabric

## When to use

Microsoft Fabric has reached GA in your audit boundary (verify via
[Azure Government product GA roadmap](https://learn.microsoft.com/azure/azure-government/documentation-government-product-roadmap)).
You're ready to migrate workloads from Loom to Fabric.

## Pre-migration checklist

| Item | Verify |
|---|---|
| Fabric GA in target boundary | Microsoft Learn audit-scope page |
| F-SKU Fabric capacity provisioned | Fabric Admin portal |
| Power BI Premium F-SKU (current Loom) | matches Fabric capacity tier |
| Loom is on v1.1+ | `fiab-migrate` CLI requires v1.1 |
| Git repo for notebooks + TMDL + rules + agent configs | source-of-truth for migration |
| OneLake shortcut quota | tenant-level shortcut limits |
| Test workspace in Fabric | for parallel-run validation |

## Procedure

### Step 1 — Snapshot the Loom estate

```bash
fiab-migrate snapshot \
  --admin-plane-sub-id <SUB-A> \
  --output ./loom-state-$(date +%Y%m%d).json
```

Captures:
- Workspace definitions
- Domain hierarchy
- Activator rule definitions
- Mirroring configs
- Data Agent configs
- TMDL semantic-model files (from Git)
- Lineage exports from Purview
- Sensitivity-label mappings

### Step 2 — Plan migration

```bash
fiab-migrate plan \
  --snapshot ./loom-state-20260901.json \
  --target-fabric-tenant <TENANT-ID> \
  --target-capacity F128 \
  --output ./migration-plan.json
```

Plan output:
- Per-item verdict (Direct / Manual / Skip)
- Estimated migration effort per item
- Dependency order (some items must migrate before others)

Review with stakeholders before proceeding.

### Step 3 — Execute (dry-run first)

```bash
# Dry-run — shows what would happen
fiab-migrate execute --plan ./migration-plan.json --dry-run

# Commit
fiab-migrate execute --plan ./migration-plan.json --commit
```

Execution order (default):
1. Create Fabric workspaces (mirror Loom workspaces 1:1)
2. Create OneLake shortcuts pointing at Loom ADLS Gen2 paths
3. Import Activator rules → Fabric Reflex
4. Import Data Agents → Fabric Data Agents REST API
5. Re-author TMDL semantic models for Direct Lake on OneLake
6. Re-bind Power BI reports to new semantic models
7. Re-deploy notebooks via Git folder bind to Fabric workspace
8. Migrate Mirroring sources per-source (some switch to Fabric
   Mirroring; others stay on Loom)

### Step 4 — Verify

```bash
fiab-migrate verify --plan ./migration-plan.json
```

Verifies:
- Workspace counts match
- Sample queries return same results across both systems
- Activator rules fire equivalently
- Data Agent answers benchmark questions identically
- Semantic model query latency meets SLA on Fabric

### Step 5 — Cutover

For each workload:
1. Point downstream consumers (BI clients, scheduled jobs, ETL
   pipelines) at the Fabric workspace
2. Side-by-side run for 30-90 days (per workload risk)
3. Monitor parallel-run diff; investigate any divergence
4. Decommission Loom workload after clean parallel-run period

### Step 6 — Decommission Loom

After all workloads migrated:
- Stop Loom Console + parity services
- Tear down Loom Admin Plane RG
- Keep ADLS Gen2 lakehouses (now accessed via OneLake shortcut from
  Fabric)
- Keep Purview (Fabric uses the same Purview)

## Hybrid run pattern

Most customers don't fully decommission Loom. Hybrid pattern:
- Migrate primary workloads to Fabric
- Keep Loom for workloads Fabric doesn't yet cover (e.g., custom
  Activator rules using primitives Fabric Reflex doesn't support)
- Run hybrid indefinitely

See [Hybrid topology use case](../use-cases/hybrid-topology.md).

## Rollback

If a workload migration causes issues:
1. Stop directing traffic at Fabric for that workload
2. Re-point at original Loom workspace (still operational)
3. Investigate; fix; retry migration

## Related

- ADR: [fiab-0012 Forward migration](../adr/0012-forward-migration.md)
- Operations: [Forward to Fabric](../operations/forward-to-fabric.md)
- Use case: [Hybrid topology](../use-cases/hybrid-topology.md)
