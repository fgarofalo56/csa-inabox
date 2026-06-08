# onelake-catalog-secure — parity with the Microsoft Fabric OneLake catalog **Secure** tab

Source UI: https://learn.microsoft.com/fabric/governance/secure-your-data
(OneLake catalog Secure tab — "View users" and "View security roles").

Azure-native — **no Fabric / Power BI dependency** (per
`.claude/rules/no-fabric-dependency.md`). The access matrix is rolled up from
real Azure planes; a real Fabric tenant is never required.

## Fabric feature inventory (every capability)

| # | Fabric Secure-tab capability | Notes |
|---|------------------------------|-------|
| 1 | Two sub-views: **View users** / **View security roles** | Toggle at top |
| 2 | View users — one row per unique principal (user/group/SP) | Columns roll up access |
| 3 | View users — count/role of access per workspace | |
| 4 | Toolbar **Add users** (onboard a principal to access) | Opens a grant flow |
| 5 | Toolbar **Manage access** (edit / remove) | |
| 6 | Left rail **workspace selector** (scope the rollup) | Only workspaces where caller is Admin/Member |
| 7 | View security roles — one row per OneLake security role | Columns: Item, Role name, Role type, Permission (Read/ReadWrite), Location, Data owner |
| 8 | Role row → manage **Data in role** + **Members in role** | |
| 9 | Per-principal access level surfaced (read vs read-write) | |

## Loom coverage (Azure-native)

| # | Loom coverage | Backend |
|---|---------------|---------|
| 1 | ✅ `TabList` View users / View security roles in `secure-view.tsx` | client |
| 2 | ✅ Principal × access-level matrix — one row per Entra OID | `GET /api/onelake/security` → `buildMatrix()` |
| 3 | ✅ Columns: Workspace role, Storage RBAC, ACL (rwx), UC grants per principal | RBAC + ACL + Cosmos + UC merge |
| 4 | ✅ **Grant access** dialog — Entra principal search + Storage Blob Data role | `POST /api/onelake/security` → `grantContainerRole` |
| 5 | ✅ Revoke supported (`DELETE ?id=`); matrix re-fetches after grant | `revokeContainerRoleAssignment` |
| 6 | ✅ Left-rail **container (lakehouse zone)** + **workspace** selectors | `KNOWN_CONTAINERS` + `/api/workspaces` |
| 7 | ✅ View security roles — Storage RBAC role rows (Permission Read/ReadWrite) + Location | `listContainerRoleAssignments` |
| 8 | ✅ **OneLake security roles panel** = POSIX ACL entries table (Azure-native equivalent) | `getAcl(container, '')` |
| 9 | ✅ Read/Write/Execute bits per principal + per ACL entry | DFS `getAccessControl` |

Honest gates (⚠️, full surface still renders — per `no-vaporware.md`):

- ⚠️ **Storage RBAC env gate** — `LOOM_SUBSCRIPTION_ID` + `LOOM_DLZ_RG` unset →
  503 `NotConfiguredBar` naming
  `platform/fiab/bicep/modules/landing-zone/storage-rbac-admin.bicep`.
- ⚠️ **POSIX ACL gate** — on 403 the UAMI needs **Storage Blob Data Owner** on
  the HNS container to read ACLs (same bicep module); on a non-HNS account the
  panel explains ACLs don't apply and RBAC governs access.
- ⚠️ **Unity Catalog gate** — Commercial/GCC only. In GCC-High/IL5/DoD the UC
  call is skipped with a message; when `LOOM_DATABRICKS_HOSTNAME` is unset the
  UC column is gated.

Zero ❌ — no missing rows, no stub banners.

## Backend per control

| Control | Backend (real Azure plane) |
|---------|----------------------------|
| Principal matrix (RBAC) | ARM `roleAssignments?$filter=atScope()` at the container scope (all clouds) |
| ACL / OneLake security roles | DFS `getAccessControl()` on the container root (all clouds, HNS) |
| Workspace roles | Cosmos `workspace-roles` container (`listWorkspaceRoles`) |
| UC grants | Databricks `/api/2.1/unity-catalog/permissions/catalog/{name}` (Comm/GCC) |
| Grant access | ARM `PUT roleAssignments/{guid}` (`grantContainerRole`) |
| Revoke | ARM `DELETE roleAssignments/{id}` (`revokeContainerRoleAssignment`) |
| Principal search | `/api/admin/permissions/principals` (Microsoft Graph) |
| OID → UPN enrichment | Microsoft Graph `directoryObjects` (opt-in `LOOM_GRAPH_USERS_ENABLED`) |

## Per-cloud

| Cloud | RBAC | ACL | Workspace roles | Unity Catalog |
|-------|------|-----|-----------------|---------------|
| Commercial | ✅ | ✅ | ✅ | ✅ |
| GCC | ✅ | ✅ | ✅ | ✅ |
| GCC-High / IL5 / DoD | ✅ | ✅ | ✅ | ⚠️ gated (UC n/a in Gov) |

No new infra / env vars — reuses `LOOM_SUBSCRIPTION_ID`, `LOOM_DLZ_RG`,
`LOOM_GRAPH_USERS_ENABLED`, `LOOM_DATABRICKS_HOSTNAME` (all already wired in
`platform/fiab/bicep/modules/admin-plane/main.bicep`) and the RBAC-Admin grant
in `storage-rbac-admin.bicep`.

## Verification

- `npx tsc --noEmit` — clean on touched files.
- `app/api/onelake/__tests__/security.test.ts` — 12/12 (matrix assembly, ACL
  403 honest gate, RBAC env gate, Gov-cloud UC skip, grant/revoke contract).
- No mock principals: every matrix row originates from ARM, the DFS ACL, Cosmos
  or UC — or an honest gate.
