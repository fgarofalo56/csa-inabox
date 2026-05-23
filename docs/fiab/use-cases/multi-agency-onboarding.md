# Multi-Agency Onboarding

A federal department onboarding additional agencies to its CSA Loom
deployment after the initial Admin Plane + first DLZ are live.

## When to use

- Department has Loom deployed for 1-2 agencies; ready to add a third
- New federal contractor / mission area joins
- Existing single-agency workspace outgrows shared-sub model; needs
  per-agency subscription separation

## Procedure (Console / Setup Wizard path)

Per [DLZ onboard new domain runbook](../runbooks/dlz-onboard-new-domain.md).

### Prerequisites

| Item | Action |
|---|---|
| New Azure subscription for the agency | Department procurement |
| Single Entra tenant for the department | Required (no cross-tenant multi-sub support) |
| `/16` CIDR for new spoke VNet | Pick `10.<N>.0.0/16` (next available) |
| Domain Stewards Entra group | Customer creates with appropriate stewards |
| Capacity SKU decision (F4/F8/F32/F64) | Per-agency sizing |
| Region (within audit boundary) | Match Admin Plane or paired region |
| Mission area / domain name | Used in catalog tags |

### Procedure

1. Sign in to Loom Console as a Loom Admin
2. Navigate to **Setup Wizard** (`/setup`)
3. Click **Add Data Landing Zone**
4. Wizard interviews:
   - Target subscription ID (new sub)
   - Domain name (e.g., "Mission Operations")
   - Region
   - Capacity SKU
   - Domain Steward Entra group
   - Workspace identity naming convention
5. Wizard renders `.bicepparam` live; user reviews + confirms
6. MCP activates PIM-for-Groups → Contributor on new sub
7. MCP submits Bicep deployment (~25-40 min)
8. New DLZ appears in Console "Workspaces" pane

### Post-deploy validation

- New DLZ visible in Workspaces pane with Domain Steward group as
  admin
- VNet peering active between Admin Plane hub and new spoke
- Catalog scans registered for new DLZ's ADLS accounts
- Smoke test: create test workspace, ingest sample data, run query

### Hand-off to agency Domain Steward

After Console verification:
- Add agency-specific Workspace Admin groups
- Set per-agency OAP (Outbound Access Protection) rules
- Document per-agency cost allocation
- Schedule 30-min on-boarding session with agency team

## Common federal patterns

### Pattern A: Single department, many agencies (Department of X)

- Department CIO owns Admin Plane
- Per-bureau DLZs
- Cross-bureau Marketplace for shared data products
- See [Federal Data Mesh](federal-data-mesh.md)

### Pattern B: Joint program (multi-department)

- Lead agency owns Admin Plane
- Partner agencies have DLZs in their own subscriptions
- Single Entra tenant (joint program tenant)
- Cross-agency RBAC tightly scoped (data residency policies)

### Pattern C: Contractor consortium (DIB CMMC L2/L3)

- Lead contractor owns Admin Plane
- Sub-contractors have DLZs
- ITAR-eligible workloads in GCC-High
- Per-contractor cost separation

## Single-sub → multi-sub conversion

If you started Loom in single-sub mode and need to convert to
multi-sub:

1. Provision new subs for the additional DLZs
2. Set `CSA_LOOM_DEPLOYMENT_MODE=multi-sub` + add `CSA_LOOM_DLZ_SUB_IDS`
3. Run `azd up` — provisions new DLZs in new subs
4. Use Console "Workspaces → Move to domain" to migrate existing
   workspaces to per-domain DLZs
5. After verification, decommission the old single-sub DLZ

## Multi-tenant constraint

Loom v1 requires **single Entra tenant for all subs**. Cross-tenant
multi-sub deployments are NOT supported in v1. Customers needing
cross-tenant (e.g., partner federation across separate orgs):
- Use cross-cloud B2B + Delta Sharing for cross-tenant data sharing
- Deploy separate Loom installations per tenant; bridge via
  Marketplace + Delta Sharing
- v1.1 may consider cross-tenant patterns — track in backlog

## Common issues

| Issue | Fix |
|---|---|
| VNet CIDR conflict | Pick non-overlapping CIDR; update `.bicepparam` |
| PIM activation fails | Verify Loom MCP MI is member of `Loom MCP Operators` PIM-eligible group |
| Domain Stewards group not found | Verify object ID; group must exist in same Entra tenant |
| Capacity quota insufficient | Request quota for Databricks Premium in target region |

## Related

- [Federal Data Mesh use case](federal-data-mesh.md)
- [Multi-sub multi-tenant deployment](../deployment/multi-sub-multi-tenant.md)
- [Workspace RBAC](../governance/workspace-rbac.md)
- Runbook: [DLZ onboard new domain](../runbooks/dlz-onboard-new-domain.md)
