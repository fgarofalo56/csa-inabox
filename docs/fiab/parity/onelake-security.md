# onelake-security — parity with Fabric "Manage OneLake security" (data-access roles)

Source UI: Microsoft Fabric → Lakehouse / Mirrored database / Mirrored Azure
Databricks catalog → **Manage OneLake security (preview)** → roles list + role
wizard. Learn: "OneLake security (preview)" and "Data Access roles REST API"
(`PUT/GET /workspaces/{ws}/items/{id}/dataAccessRoles`).

Loom surface: a **Security** tab inside the Lakehouse, Mirrored-Database, and
Mirrored-Databricks (mirrored-catalog) editors, backed by an Azure-native ADLS
Gen2 ACL engine. The Fabric REST is an **opt-in** mirror only.

## Azure / Fabric feature inventory

| # | Fabric capability | Notes |
|---|-------------------|-------|
| 1 | List data-access roles for the item | name, permissions, paths, member count |
| 2 | Create a role via wizard | step 1 name + permission (Read / ReadWrite) |
| 3 | Role wizard — pick folders/tables | "All folders" or a folder/table subset |
| 4 | Role wizard — assign members | Entra user / group / SP identity picker |
| 5 | DefaultReader / DefaultReadWriter pre-created roles | span all paths; shown as "Default" |
| 6 | DefaultReader "spans all folders" warning | customizing while Default has `*` does not restrict |
| 7 | Edit / delete a role | re-applies / revokes the underlying grant |
| 8 | Read-only items (mirrored DB / catalog) → Read only | ReadWrite not offered |
| 9 | Enforcement on read paths | ACLs apply to OPENROWSET / Spark / DFS |
| 10 | Role-name rule (letter-first, alphanumeric, ≤128) | validated client + server |

## Loom coverage

| # | Status | Backend |
|---|--------|---------|
| 1 | built ✅ | `GET /api/items/{type}/{id}/security-roles?list=roles` → Cosmos `onelake-security-roles` |
| 2 | built ✅ | wizard step 1 → `POST {action:'create',role}` |
| 3 | built ✅ | wizard step 2 lists real ADLS dirs via `GET /api/lakehouse/paths` (Tables/ + Files/) |
| 4 | built ✅ | wizard step 3 → `GET /api/admin/permissions/principals` (Graph) + raw-OID fallback |
| 5 | built ✅ | roles named DefaultReader/DefaultReadWriter flagged `isDefault`, "Default" badge |
| 6 | built ✅ | warning MessageBar in the roles list + inline in wizard step 2 |
| 7 | built ✅ | `DELETE ?roleId=` revokes ACLs (`removeAccessControlRecursive`) + deletes doc |
| 8 | built ✅ | `allowedPermissions(itemType)` — mirrored items get `['Read']` only |
| 9 | built ✅ | **real grant**: `updateAccessControlRecursive` POSIX ACLs on the Delta folders + ancestor `--x` traversal |
| 10 | built ✅ | `ROLE_NAME_RE` enforced in wizard + BFF |
| — | honest-gate ⚠️ | when `LOOM_ONELAKE_SECURITY_ACL!=='true'` or the UAMI lacks Storage Blob Data Owner → warning MessageBar naming the env var + role |
| — | built ✅ (opt-in) | Fabric sync tab → `POST {action:'sync-to-fabric'}` → `PUT .../dataAccessRoles` (only when `LOOM_FABRIC_SECURITY_ENABLED=true` and non-Gov) |

Zero ❌. The default path is 100% Azure-native (no Fabric workspace). Gov clouds
(GCC-High / IL5) honest-gate the Fabric sync — the ADLS ACL path is the only one
and works fully there.

## Backend per control

| Control | Backend call |
|---------|--------------|
| Roles list / refresh | Cosmos query on `onelake-security-roles` (PK `/itemId`) |
| Create / update role | Cosmos upsert + `DataLakeDirectoryClient.updateAccessControlRecursive` (per member, access + default scope) + ancestor `setAccessControl` for traversal |
| Delete role | `removeAccessControlRecursive` + Cosmos delete |
| Verification view | `getAccessControl` read-back, member OIDs matched against access-scope user entries |
| Member picker | Microsoft Graph users/groups via `/api/admin/permissions/principals` |
| Folder/table picker | `listPaths` on the medallion container (Tables/, Files/) |
| Fabric sync (opt-in) | `PUT https://api.fabric.microsoft.com/v1/workspaces/{ws}/items/{id}/dataAccessRoles` |

## Per-cloud

| Cloud | ADLS ACL (default) | Fabric sync (opt-in) |
|-------|--------------------|----------------------|
| Commercial / GCC | ✅ `dfs.core.windows.net` | available with `LOOM_FABRIC_SECURITY_ENABLED=true` |
| GCC-High / IL5 | ✅ `dfs.core.usgovcloudapi.net` | honest-gated off (Fabric not authorized at boundary) |

## Bicep / config

- `synapse.bicep` / `synapse-storage-rbac.bicep`: `loomOnelakeSecurityEnabled` →
  grants the Console UAMI **Storage Blob Data Owner** (the only built-in role
  with the ACL-modify superuser bit).
- `admin-plane/main.bicep`: `loomOnelakeSecurityEnabled` →
  `LOOM_ONELAKE_SECURITY_ACL`; `loomFabricSecurityEnabled` →
  `LOOM_FABRIC_SECURITY_ENABLED` on loom-console.
- Cosmos container `onelake-security-roles` (PK `/itemId`) created lazily by
  `cosmos-client.ts`.

## Verification (acceptance)

With `LOOM_ONELAKE_SECURITY_ACL=true` and the UAMI holding Storage Blob Data
Owner, create a role over `/Tables/<t>` with one member, then open the
**Verification** view → it calls `getAccessControl` and reports the member OID
present in the live ACL — the read-back confirms the grant is real.
