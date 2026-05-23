# Runbook — Onboard a new DLZ (new agency / domain)

## When to use

Federal customer onboarding a new agency, mission area, or business
domain. Adds a new Data Landing Zone to an existing multi-sub Loom
deployment.

## Prerequisites

| Item | Notes |
|---|---|
| New Azure subscription under same Entra tenant | Single Entra tenant required for multi-sub |
| Available `/16` CIDR for new spoke VNet | Use `10.<N>.0.0/16` where N = next available |
| Domain Stewards Entra group object ID | Customer creates the group with the appropriate Stewards |
| Capacity SKU decision (F4 / F8 / F32 / F64) | Per-DLZ sizing |
| Region (within audit boundary) | Should match Admin Plane region or paired region |

## Procedure (Console / Setup Wizard path)

1. **Sign in to Loom Console** as a FiaB Admin
2. Navigate to **Setup Wizard** (`/setup`)
3. Click **Add Data Landing Zone**
4. Wizard interviews:
   - Target subscription ID
   - Domain name (e.g., "Mission Ops", "Finance", "Procurement")
   - Region
   - Capacity SKU
   - Domain Steward Entra group
   - Workspace identity naming convention
5. Wizard renders the `.bicepparam` live in right pane — review
6. Click **Deploy** to confirm
7. MCP activates PIM-for-Groups → Contributor on new sub
8. MCP submits deployment (~25-40 min)
9. Wizard streams progress; emits completion narration
10. New DLZ appears in Console "Workspaces" pane

## Procedure (CLI path)

```bash
cd platform/fiab/azd
azd env select prod-multi-sub

# Append new sub to DLZ list
CURRENT=$(azd env get-values | grep CSA_LOOM_DLZ_SUB_IDS | cut -d= -f2 | tr -d '"')
NEW_SUB="<new-sub-id>"
azd env set CSA_LOOM_DLZ_SUB_IDS "${CURRENT},${NEW_SUB}"

# Append domain name
CURRENT_NAMES=$(azd env get-values | grep CSA_LOOM_DLZ_NAMES | cut -d= -f2 | tr -d '"')
azd env set CSA_LOOM_DLZ_NAMES "${CURRENT_NAMES},Mission Ops"

# Re-deploy (idempotent — only the new DLZ provisions)
azd up
```

## Post-deploy validation

1. **Console check** — new DLZ appears in Workspaces pane
2. **Network check** — VNet peering active between Admin Plane hub
   and new spoke
3. **Identity check** — Domain Stewards group has appropriate Loom
   role assignments
4. **Catalog check** — Purview scan registered for new DLZ's ADLS
   accounts
5. **Smoke test** — create a test workspace in the new DLZ via
   Console; ingest sample data; run query

## Common issues

| Issue | Fix |
|---|---|
| VNet peering fails (CIDR conflict) | Pick non-overlapping CIDR; update `.bicepparam` |
| PIM activation fails | Verify Loom MCP MI is member of `Loom MCP Operators` PIM-eligible group; admin must approve elevation if not auto-approved |
| Domain Stewards group not found | Verify object ID; group must exist in same Entra tenant |
| Capacity quota insufficient | Request quota for Databricks Premium in target region |

## Decommission a DLZ

```bash
azd env set CSA_LOOM_REMOVE_DLZ_SUB_ID <sub-id>
azd down --only-dlz <sub-id>
```

This:
- Tears down all RGs in the target DLZ sub
- Removes VNet peering from Admin Plane hub
- Cleans up Purview scan registrations
- Preserves Admin Plane + other DLZs

## Related

- [Multi-sub multi-tenant deployment](../deployment/multi-sub-multi-tenant.md)
- [Workspace RBAC](../governance/workspace-rbac.md)
- Tenant ADR: [fiab-0011 Tenancy model](../adr/0011-tenancy-model.md)
