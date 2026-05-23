# Upgrade & migration

Day-2 lifecycle: upgrading Loom releases, migrating between deployment
modes, promoting boundaries.

## Upgrade lifecycle

See [Deployment — Upgrade lifecycle](../deployment/upgrade.md) for
release cadence, `azd up` re-run flow, Console "Updates" pane.

Summary:
- **Patch (v1.0.0 → v1.0.1)**: on-demand; security/critical bugs
- **Minor (v1.0 → v1.1)**: quarterly; new features
- **Major (v1 → v2)**: as needed; breaking changes called out in
  release notes

## Single-sub → multi-sub migration

Customer outgrows single-sub mode (Admin Plane + 1 DLZ in one sub)
and needs domain-level subscription separation.

Procedure:
1. Provision new subscriptions (sub-B, sub-C, ..., sub-N) under same
   Entra tenant
2. Grant Loom MCP MI the necessary PIM-eligible Contributor role on
   each new sub
3. Run `azd env set CSA_LOOM_DEPLOYMENT_MODE multi-sub`
4. Run `azd env set CSA_LOOM_DLZ_SUB_IDS "<sub-b-id>,<sub-c-id>"`
5. Run `azd up` — provisions new DLZs in new subs
6. **Migrate workspaces** from old single-sub DLZ to new per-domain
   DLZs via Loom Console "Workspaces → Move to domain" action
7. After verification, decommission old single-sub DLZ

Move-workspace action:
- Creates new RG in target DLZ
- Copies Delta tables (using ADF Copy or azcopy)
- Re-deploys semantic models in target Power BI workspace
- Updates Console references
- Customer downtime: depends on data volume (minutes to hours)

## Boundary promotion (GCC-H → IL5 — v1.1)

When v1.1 ships IL5 support, customers running in GCC-H can promote.

Important: **boundary promotion is not in-place**. IL5 requires
different regions, different Marketplace plan (customer-managed
only), HSM-CMK storage, Atlas-on-AKS catalog. Promotion =
side-by-side deploy + migrate.

Procedure:
1. Stand up new Loom Admin Plane in IL5 (`il5.bicepparam`) in a fresh
   subscription
2. Stand up new DLZ(s) in IL5 subs
3. Use `fiab-migrate snapshot` to capture current GCC-H estate
4. Use `fiab-migrate execute --target il5` to populate IL5 estate
5. Re-deploy semantic models for IL5 Power BI workspace
6. Cutover end-users (Power BI reports point at new workspace)
7. Decommission GCC-H estate after parallel-run validation period

Full runbook: [Boundary promotion](../runbooks/boundary-promotion.md).

## Adding a new DLZ to existing multi-sub install

Customer onboards new agency / domain.

Procedure (via Console):
1. Open Loom Console → Setup Wizard (`/setup`)
2. Click **Add Data Landing Zone**
3. Wizard interviews:
   - Target subscription ID
   - Domain name
   - Region
   - Capacity SKU
   - Domain Steward Entra group
4. Wizard renders `.bicepparam` → user confirms → MCP deploys
5. New DLZ appears in Console "Workspaces" pane within 25-40 min

Procedure (via CLI):
```bash
azd env set CSA_LOOM_DLZ_SUB_IDS "<existing-ids>,<new-sub-id>"
azd up
```

Full runbook: [DLZ onboard new domain](../runbooks/dlz-onboard-new-domain.md).

## Workspace migration between DLZs

Workspace can be moved from DLZ-A to DLZ-B (same boundary, same
tenant):

1. Source workspace exports state to JSON (Console "Workspaces →
   Export")
2. Target DLZ imports the state (Console "Workspaces → Import")
3. Delta tables copied (or shortcut'd) to target ADLS path
4. Semantic models re-deployed to target Power BI workspace
5. Activator rules + Data Agents re-registered
6. Source workspace decommissioned

## Forward migration to Microsoft Fabric

The strategic anchor — see [Forward to Fabric](forward-to-fabric.md).

## Reverse migration (Fabric → Loom)

Customer pilots in Fabric Commercial → needs to move to Gov.

| From Fabric | To Loom | Effort |
|---|---|---|
| OneLake Delta tables | ADLS Gen2 (same Delta layout) | Low — `azcopy sync` |
| Fabric Warehouse | Databricks SQL Warehouse (Commercial) or Synapse Serverless (Gov) | Medium |
| Fabric notebooks | Databricks notebooks | Medium — runtime swap |
| Reflex rules | Loom Activator rules JSON | Medium — primitives mostly map; some require re-author |
| Direct Lake semantic models | Premium Import + Direct-Lake-Shim | Medium — re-author TMDL |
| Fabric Data Agents | Loom Data Agents | Low — config export/import |
| Power BI semantic models | Stay in Power BI; rebind to Loom lakehouses | Low |

Asymmetry: Fabric-only items (Direct Lake sub-second, Fabric IQ
family, Operations Agent) don't reverse-map cleanly.

## Related

- [Deployment upgrade](../deployment/upgrade.md)
- [Forward to Fabric](forward-to-fabric.md)
- Runbooks: [DLZ onboard new domain](../runbooks/dlz-onboard-new-domain.md), [Boundary promotion](../runbooks/boundary-promotion.md)
