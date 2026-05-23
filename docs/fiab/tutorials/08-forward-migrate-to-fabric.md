# Tutorial 08 — Forward-migrate a lakehouse to Fabric

When Microsoft Fabric reaches your audit boundary, migrate your
Loom lakehouse forward via OneLake shortcut. **30 minutes** (demo only
— real migrations span weeks).

## Prerequisites

- Loom lakehouse with Bronze / Silver / Gold tables (from previous
  tutorials)
- Fabric workspace in the same Entra tenant with F-SKU capacity
- `fiab-migrate` CLI (ships in v1.1; this tutorial uses Loom v1.1+)

## Important: this is the strategic anchor

The whole reason CSA Loom is a defensible investment is that this
migration works cleanly. You're testing the bridge today against a
Fabric Commercial workspace so you understand the pattern before
your Gov boundary's Fabric GA arrives.

## Steps

### 1. Verify Fabric workspace is ready

Open Fabric portal at `https://app.fabric.microsoft.com` (Commercial)
or `https://app.fabric.microsoft.us` (Gov, when Fabric Gov GAs):
- Workspace exists
- Bound to F-SKU capacity (F8+)
- You're a Workspace Admin

### 2. Snapshot the Loom estate

```bash
fiab-migrate snapshot \
  --admin-plane-sub-id <YOUR-SUB-A> \
  --workspace <your-loom-workspace> \
  --output ./loom-snapshot.json
```

Output captures:
- Workspace definition
- All lakehouses + tables (metadata, not data)
- Semantic models (TMDL)
- Activator rules (JSON)
- Data Agent configs (JSON)
- Lineage from Purview

### 3. Plan migration

```bash
fiab-migrate plan \
  --snapshot ./loom-snapshot.json \
  --target-fabric-tenant <TENANT-ID> \
  --target-workspace <fabric-workspace-id> \
  --output ./migration-plan.json
```

Plan output:
- Per-item verdict (Direct / Manual / Skip)
- Dependency order
- Estimated effort per item

For this tutorial, the lakehouse should show as **Direct** (OneLake
shortcut).

### 4. Execute: create OneLake shortcut

```bash
fiab-migrate execute \
  --plan ./migration-plan.json \
  --workload lakehouse \
  --commit
```

This:
- Creates a Fabric Lakehouse item in the target workspace
- Creates a OneLake shortcut from `Tables/` pointing at your Loom
  ADLS Gen2 path:
  `https://onelake.dfs.fabric.microsoft.com/<workspace>/<lakehouse>/Tables/noaa_silver_daily`
  → `abfss://<container>@<storage>.dfs.core.windows.net/Tables/noaa_silver_daily`
- **Zero data movement** — Fabric reads the Delta directly via the
  shortcut

### 5. Verify in Fabric

Open the Fabric Lakehouse:
- `noaa_silver_daily` appears in Tables (shortcut icon)
- Query in Fabric notebook:
  ```python
  df = spark.table("workspace_name.lakehouse_name.noaa_silver_daily")
  df.show(10)
  ```
- SQL Analytics Endpoint can read the same table

Compare to Loom: query returns identical results.

### 6. Migrate semantic model

```bash
fiab-migrate execute \
  --plan ./migration-plan.json \
  --workload semantic-model \
  --commit
```

This:
- Re-authors the TMDL semantic model with **Direct Lake on OneLake**
  storage mode (replaces the Direct-Lake-Shim warm-cache pattern)
- Deploys to Fabric workspace
- Power BI reports automatically rebind if they used the same
  semantic model name

### 7. Compare freshness

In Loom:
- Direct-Lake-Shim refresh latency: 5-30 s (per Tutorial 03)

In Fabric (after migration):
- Direct Lake on OneLake native: **sub-second**

This is the **gap that closes** when you forward-migrate.

### 8. Side-by-side run

Don't decommission Loom immediately. Run side-by-side for 30-90 days:
- Loom continues to serve queries
- Fabric serves queries via OneLake shortcut (same data, faster
  freshness)
- Compare results, validate identity passthrough works in both
- Migrate Power BI reports to Fabric workspace per cadence

### 9. Decommission (when ready)

After parallel-run validation:
- Stop Direct-Lake-Shim service (Fabric handles freshness natively)
- Update Console UI to flag the workspace as "migrated to Fabric"
- Optionally retire the entire Loom workspace if all artifacts
  migrated
- ADLS Gen2 data remains (now accessed via OneLake shortcut from
  Fabric)

## What's next

- [Forward to Fabric runbook](../runbooks/forward-migrate-to-fabric.md) —
  production migration procedure
- [Hybrid topology use case](../use-cases/hybrid-topology.md) —
  running Fabric Commercial + Loom Gov long-term
- [Operations — Forward to Fabric](../operations/forward-to-fabric.md)

## Cleanup (this tutorial)

If just demoing:
- Delete the Fabric Lakehouse shortcut (Fabric portal → Settings →
  Delete)
- Loom estate untouched

## Troubleshooting

- OneLake shortcut creation fails: verify Entra B2B trust between
  Loom Gov tenant + Fabric Commercial tenant (only relevant for
  cross-cloud hybrid; same-tenant works natively)
- Query result mismatch: verify schema parity (Fabric reads same
  Delta files, so should be identical)
