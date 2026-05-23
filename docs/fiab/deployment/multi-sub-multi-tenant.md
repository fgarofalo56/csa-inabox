# Multi-subscription multi-tenant deployment

The production pattern for federal customers: Admin Plane in one
subscription; each Data Landing Zone in its own subscription;
cross-sub VNet peering; single Entra tenant.

## When to use multi-sub

- Production federal deployment with multiple domains / agencies
- Per-domain subscription-level cost separation
- Per-domain billing reports + budgets
- Per-domain RBAC isolation (each DLZ has its own admin team)
- Per-domain policy / governance overrides

## Architecture

```
┌────────────────────────────────────────────────┐
│ Subscription A — CSA Loom Admin Plane          │
│   - Hub VNet (10.0.0.0/16)                     │
│   - Loom Console + Setup Wizard + MCP + Copilot│
│   - Catalog overlay (Purview / UC managed)     │
│   - AI Foundry / Azure ML Hub                  │
│   - AI Search                                  │
│   - Monitoring (App Insights + LA + Sentinel)  │
│   - Key Vault                                  │
└─────────────────┬──────────────────────────────┘
                  │ VNet peering
                  ▼
┌─────────────────────────────┐  ┌──────────────────────────────┐
│ Subscription B — DLZ "Finance"│  │ Subscription C — DLZ "Procurement"│
│   - Spoke VNet (10.1.0.0/16) │  │   - Spoke VNet (10.2.0.0/16)  │
│   - Databricks workspace     │  │   - Databricks workspace      │
│   - Synapse Serverless       │  │   - Synapse Serverless        │
│   - ADX database (shared cluster) │  │   - ADX database              │
│   - ADLS Gen2 accounts       │  │   - ADLS Gen2 accounts        │
│   - Power BI workspace(s)    │  │   - Power BI workspace(s)     │
│   - Parity services (per-DLZ)│  │   - Parity services           │
└──────────────────────────────┘  └──────────────────────────────┘
```

## Prerequisites

| Item | Notes |
|---|---|
| Single Entra tenant spanning all subscriptions | Required — no cross-tenant multi-sub support |
| Contributor + User Access Administrator on each sub | For initial deploy |
| Available `/16` CIDR per DLZ (peerable to hub) | Hub: `10.0.0.0/16`; DLZ N: `10.N.0.0/16` |
| Subscription owner email per DLZ for billing alerts | Optional but recommended |

## Initial deploy

```bash
azd env new prod-multi-sub
azd env set CSA_LOOM_DEPLOYMENT_MODE multi-sub
azd env set CSA_LOOM_ADMIN_SUB_ID <sub-a-id>
azd env set CSA_LOOM_DLZ_SUB_IDS "<sub-b-id>,<sub-c-id>"
azd env set CSA_LOOM_DLZ_NAMES "Finance,Procurement"
azd env set CSA_LOOM_HUB_VNET_CIDR 10.0.0.0/16
azd up
```

This deploys:
1. Admin Plane into sub-A
2. DLZ "Finance" into sub-B with `10.1.0.0/16` (auto-assigned from
   index)
3. DLZ "Procurement" into sub-C with `10.2.0.0/16`
4. VNet peering between hub (sub-A) and each spoke (sub-B, sub-C)

## Adding a new DLZ via Console (after initial deploy)

1. Open Loom Console → Setup Wizard route (`/setup`)
2. Click **Add Data Landing Zone**
3. Wizard interviews:
   - Target subscription ID (new sub)
   - Domain name (e.g., "Mission Ops")
   - Region
   - Capacity SKU (per-DLZ)
   - Domain Steward Entra group
4. Wizard renders the `.bicepparam` live in right pane
5. Confirm → MCP activates PIM-for-Groups → Contributor on new sub
6. MCP submits Bicep deployment
7. ~25-40 min later, new DLZ appears in Console
8. PIM membership expires; MCP retains RG-level Contributor only

## Per-DLZ governance overrides

Each DLZ can have:
- Its own Entra group memberships (Domain Stewards, Workspace Admins)
- Its own OAP rules (per-DLZ egress allow-list)
- Its own capacity sizing (one DLZ on F8; another on F32)
- Its own custom Azure Policy assignments

Tenant-level settings (set in Admin Plane) flow down to all DLZs
unless overridden per-domain.

## Cross-DLZ data sharing

Per [Workspace RBAC](../governance/workspace-rbac.md):

1. Source workspace in DLZ-A publishes data product to org Marketplace
2. Target workspace in DLZ-B requests access via Console "Catalog"
3. Source admin approves
4. Delta Sharing protocol (or direct UC grant in Commercial; ADLS-
   level grant in Gov)

## Cost reporting

Each DLZ subscription has independent Azure billing. Loom Console
**Monitoring → Cost** pane aggregates across DLZs for org-level view.
Customer's existing Azure Cost Management API integration unchanged.

## Tear down

```bash
# Delete a specific DLZ (preserves other DLZs + Admin Plane)
azd env set CSA_LOOM_REMOVE_DLZ_SUB_ID <sub-b-id>
azd down --only-dlz

# Delete everything
azd down --purge --force
```

## Limitations

- Cross-tenant multi-sub **not supported** in v1 (single Entra tenant
  required)
- Subscription transfer between DLZs not supported — re-deploy as new
  DLZ instead
- Single-sub → multi-sub conversion is a one-time migration (runbook
  documents the steps)

## Related

- [Tenancy model ADR](../adr/0011-tenancy-model.md)
- [Reference architecture §4.2](../architecture.md#tenancy-model)
- [Workspace RBAC](../governance/workspace-rbac.md)
- Runbook: [DLZ onboard new domain](../runbooks/dlz-onboard-new-domain.md)
