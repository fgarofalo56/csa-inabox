# admin-workspaces — parity with Fabric "Admin portal → Workspaces"

Source UI: Microsoft Fabric Admin portal → Workspaces list
(<https://learn.microsoft.com/fabric/admin/portal-workspaces>) and the
per-workspace Settings flyout (<https://learn.microsoft.com/fabric/fundamentals/workspaces>).

CSA Loom surface: `/admin/workspaces` (page `app/admin/workspaces/page.tsx`),
BFF `GET /api/admin/workspaces` (`app/api/admin/workspaces/route.ts`),
server client `lib/clients/workspaces-client.ts`.

## Fabric/Azure feature inventory

Fabric's Admin-portal Workspaces view is a tenant-wide governance grid. Every
capability the real UI exposes:

| # | Capability (Fabric Admin portal) |
|---|----------------------------------|
| 1 | Tenant-wide list of EVERY workspace, regardless of owner |
| 2 | Columns: Name, State, Capacity, (item count / contents), Owners/Admins, Last-modified |
| 3 | Workspace state shown as a status (Active / Provisioning / Suspended / Deleted) |
| 4 | Search across the list |
| 5 | Per-column filter |
| 6 | Drill into a workspace's settings / govern affordance from the row |
| 7 | Open the workspace itself |

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Tenant-wide list | ✅ | `listAllWorkspacesAdmin()` cross-partition `SELECT * FROM c` on the `workspaces` container (no partitionKey) — returns every workspace, not just the admin's. isTenantAdmin-gated. |
| 2 | Name / State / Capacity / Items / Owners / Last-modified columns | ✅ | All rendered in `LoomDataTable`. Item count + last-modified computed LIVE from the `items` container via a batch `GROUP BY` (COUNT + MAX(updatedAt)). |
| 3 | State badge | ✅ | Fluent `Badge` colour-mapped per state (Active→success, Provisioning→informative, Suspended→warning, Deleted→danger); unknown → outline/subtle. |
| 4 | Search | ✅ | `Toolbar` search across name, description, owners, domain, capacity. |
| 5 | Per-column filter | ✅ | `LoomDataTable` per-column filter row (text/select/date inferred). |
| 6 | Row → workspace settings/govern flyout | ✅ | Row click + per-row "Settings" button open `WorkspaceSettingsDrawer` (General / Permissions / Git / OneLake / Sensitivity / Danger). Drawer now supports controlled `open`/`onOpenChange`/`hideTrigger`. |
| 7 | Open workspace | ✅ | Per-row "Open" link → `/workspaces/{id}`. |

Owners = creator + every Admin-role principal from the F5 `workspace-roles`
container (cross-partition join; degrades to `[createdBy]` if the read fails).

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Workspace list | Cosmos `loom/workspaces`, cross-partition scan (Console UAMI, Cosmos DB Built-in Data Contributor) |
| Item count + last-modified | Cosmos `loom/items`, cross-partition `GROUP BY` |
| Owners | Cosmos `loom/workspace-roles` (Admin rows) + `workspace.createdBy` |
| Admin gate | `isTenantAdmin` (LOOM_TENANT_ADMIN_OID / LOOM_TENANT_ADMIN_GROUP_ID) |
| Settings → General | `PATCH /api/workspaces/[id]` |
| Settings → Permissions | `ManageAccessPane` → workspace-roles + real Azure RBAC |
| Settings → Git / OneLake / Danger | `/api/workspaces/[id]/scm`, `/api/storage/accounts` + lifecycle, `DELETE /api/workspaces/[id]` |

## No-Fabric-dependency

Azure Cosmos DB NoSQL only — zero calls to api.fabric.microsoft.com /
api.powerbi.com. Works fully with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Verification

`GET /api/admin/workspaces` returns real Cosmos rows with live item counts and
states; no `return []` / stub body. Covered by
`app/api/admin/__tests__/admin-routes.test.ts` (tenant-wide cross-partition +
owners, 403 non-admin gate, 401 unauthenticated).
