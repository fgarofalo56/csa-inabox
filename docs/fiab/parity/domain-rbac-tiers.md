# domain-rbac-tiers — parity with Microsoft Fabric Domains role model (D2)

Source UI: https://learn.microsoft.com/fabric/governance/domains (Domains tab,
Domain settings → Domain admins / Domain contributors; Fabric admin vs domain
admin vs domain contributor role rules).

This surface implements the D2 identity hierarchy on top of Loom's existing
Azure-native RBAC (Cosmos + Entra/Graph + ARM — NO Fabric dependency).

## Fabric feature inventory (grounded in Learn)

| Fabric capability | Loom coverage |
|---|---|
| Fabric admin = all domains, tenant settings, create/delete domains | ✅ Tenant admin (LOOM_TENANT_ADMIN_OID / LOOM_TENANT_ADMIN_GROUP_ID), `isTenantAdminTier` |
| Domain admin = sees/edits only domains they admin; edit description/image/contributors/delegated settings; associate workspaces | ✅ Domain admin via the domain's Entra `adminGroupId` (+ legacy `admins[]`); PATCH /api/admin/domains, assign-workspaces, member management, DLZ panes |
| Domain admin CANNOT rename, delete, or change the admin list, no tenant settings | ✅ field-level tenant-admin gating in PATCH (`name`/`admins`/`adminGroupId`/`contributorGroupId`/`parentId` tenant-admin-only) |
| Domain contributor = workspace admins authorized to assign THEIR workspaces; no Domains-tab admin | ✅ Domain contributor via `contributorGroupId` (+ legacy `contributors.scope`); assign-workspaces requires workspace Admin per `resolveEffectiveRole` |
| Two Entra groups per domain (admins, contributors) | ✅ `adminGroupId` / `contributorGroupId` (Entra SECURITY groups); auto-provision via `provisionDomainGroups` (Group.ReadWrite.All) or bind existing |
| Workspace roles (Admin/Member/Contributor/Viewer) beneath domain tier | ✅ unchanged — `workspace-roles-client` |
| Domains tab "Domain admins / Domain contributors" people-pickers | ✅ /admin/permissions → Domain access tab (tier badge per domain + group binding via IdentityPicker) |
| Domain pickers scoped to administered domains | ✅ /workspaces Create dialog filters by `callerTier` |

## Backend per control

- Tier resolution: `lib/auth/domain-role.ts` `resolveDomainTier` — cached on the
  session `groups` claim, Microsoft Graph `transitiveMembers` fallback only for
  the Entra >200-group claim-overage case.
- Group provisioning: `lib/azure/domain-groups.ts` → Graph `POST /groups`
  (securityEnabled). Honest 503 gate when Group.ReadWrite.All not consented.
- Enforcement: `assign-workspaces`, `PATCH /api/admin/domains`,
  `/api/admin/capacity/{cost,utilization,viz-config}` (DLZ cost + monitor panes)
  and `/api/admin/scaling/*` (DLZ **scale** pane — adx, ai-search, aks, apim,
  capacity, compute, container-apps, cosmos, databricks-cluster,
  databricks-warehouse, foundry-compute, synapse-dwu — GET+POST+PUT) — all
  tenant/domain-admin only via the shared `lib/auth/dlz-gate.ts`
  `denyIfNoDlzAccess` helper; `/api/workspaces/[id]/role-assignments`
  (owning-domain admin).

### DLZ-pane gate granularity (deliberate)

The DLZ **scale / cost / monitor** panes read & mutate the SHARED data
landing-zone infrastructure (Fabric/PBI capacity, ADX, AKS, APIM, Cosmos,
Synapse, Databricks, AML compute, SHIR VMSS) that the whole tenant's domains
sit on — these are not per-domain *workspace* resources, and there is no
resource→domain map to scope a SKU resize or a cost query against. The panes
are therefore gated at **"tenant-admin OR domain-admin of ≥1 domain"**
granularity (`canAccessDlzPanes`), NOT per-resource per-domain. Per-domain
authority that DOES have a domain target — rename/admins/move, member
management, workspace assignment — is enforced per-domain in PATCH
`/api/admin/domains`, `assign-workspaces`, and `role-assignments`. "Scoped to
their domain's workspaces" in the role model thus applies to those
domain-targeted surfaces; the shared-infra DLZ panes are admin-tier-gated.
- Bicep: `loomDomainGroupProvisioningEnabled` (main.bicep → admin-plane →
  `LOOM_DOMAIN_GROUP_PROVISIONING` env + Group.ReadWrite.All AppRole in
  identity-graph-rbac.bicep). Bootstrap: `grant-identity-graph-approles.sh`.

## Honest gates (⚠, never ❌)

- Group provisioning disabled / un-consented → 503 with the exact remediation
  (LOOM_DOMAIN_GROUP_PROVISIONING + Group.ReadWrite.All + admin consent).
- DLZ panes for non-admins → 403 naming the /admin/permissions Domain access
  path (scale `/api/admin/scaling/*`, cost + monitor `/api/admin/capacity/*`).
- Domains always work via the legacy `admins[]` / `contributors` model when no
  Entra groups are bound — no Fabric dependency, Azure-native default.
