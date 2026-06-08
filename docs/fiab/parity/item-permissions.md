# item-permissions — parity with Fabric item Share / Manage permissions

Source UI:
- Fabric item context menu → **Share** dialog (grant people access + per-type
  permissions) and **Manage permissions** page (list / change / remove).
  <https://learn.microsoft.com/fabric/get-started/share-items>
  <https://learn.microsoft.com/fabric/get-started/give-access-workspaces>
- Fabric item-permission types (Read, Edit, Reshare, ReadData, ReadAll-SQL,
  ReadAll-Spark, SubscribeOneLakeEvents, Execute, Build).
  <https://learn.microsoft.com/rest/api/fabric/core/items/add-item-permissions>
- Azure-native equivalents:
  - ADLS Gen2 POSIX ACLs (data-plane file/dir access)
    <https://learn.microsoft.com/azure/storage/blobs/data-lake-storage-access-control>
  - Storage data-plane RBAC (Storage Blob Data Reader/Contributor)
    <https://learn.microsoft.com/azure/storage/blobs/assign-azure-role-data-access>
  - Microsoft Graph principal search (users/groups)
    <https://learn.microsoft.com/graph/api/user-list>

Per `.claude/rules/no-fabric-dependency.md` the Azure-native backend is the
DEFAULT and needs NO Fabric workspace:

- **Source of truth** → Cosmos `item-permissions` container (PK `/itemId`).
- **Data-plane grant** → ADLS Gen2 POSIX ACL entry for the principal's Entra OID
  on the item's storage path (for data-plane permission types).
- **Engine access** → ARM Storage data-plane RBAC at the container scope so SQL /
  Spark engines (which use AAD RBAC, not POSIX ACLs) can reach the data.
- **Fabric `/share`** → strictly opt-in & additive, gated behind
  `LOOM_FABRIC_PERMISSIONS_ENABLED=true` and never reached in GCC-High / IL5.

## Azure/Fabric feature inventory (Share + Manage permissions)

| #  | Capability (real UI)                                              | Notes |
|----|-------------------------------------------------------------------|-------|
| 1  | Search Entra users to share with                                  | Graph `/users` |
| 2  | Search Entra groups to share with                                 | Graph `/groups` |
| 3  | Grant **Read** (always implied — cannot share without it)         | POSIX r-x + Storage Blob Data Reader |
| 4  | Grant **Edit**                                                    | POSIX rwx + Storage Blob Data Contributor |
| 5  | Grant **Reshare**                                                 | Loom-side metadata (governs delegated sharing) |
| 6  | Grant **ReadData** (SQL analytics endpoint / TDS)                 | POSIX r-x + Storage Blob Data Reader |
| 7  | Grant **ReadAll-SQL**                                             | POSIX r-x + Storage Blob Data Reader |
| 8  | Grant **ReadAll-Spark** (OneLake / Spark APIs)                    | POSIX r-x + Storage Blob Data Reader |
| 9  | Grant **SubscribeOneLakeEvents**                                  | Loom-side metadata |
| 10 | Grant **Execute** (run notebooks / pipelines / jobs)             | Loom-side metadata, shown only for runnable items |
| 11 | Grant **Build** (semantic models)                                | Loom-side metadata, shown only for semantic-model |
| 12 | Permission set tailored to item type                             | data-plane types only on lakehouse/warehouse/etc. |
| 13 | Multi-step dialog (pick principal → review → grant)              | Fluent Dialog, 2 steps |
| 14 | Manage permissions: list everyone with access                    | live Cosmos rows |
| 15 | Manage permissions: change / remove a grant                      | DELETE revokes Cosmos row + ACL + RBAC |
| 16 | DLP-restricted item disables Edit + Reshare, shows badge (T19)   | Purview DLP policy reflection |
| 17 | Revocation takes effect on next sign-in / token refresh          | AAD/POSIX caveat surfaced in UI |

## Loom coverage

| #  | Capability | Status | Where |
|----|------------|--------|-------|
| 1  | Search users | ✅ | `GET /api/admin/permissions/principals?kind=user` (reused) |
| 2  | Search groups | ✅ | `GET /api/admin/permissions/principals?kind=group` (reused) |
| 3  | Read | ✅ | `grantItemPermission` → `upsertAclEntry` + `grantContainerRole` |
| 4  | Edit | ✅ | same, rwx + Contributor |
| 5  | Reshare | ✅ | Cosmos row metadata |
| 6  | ReadData | ✅ | ACL + Reader |
| 7  | ReadAll-SQL | ✅ | ACL + Reader |
| 8  | ReadAll-Spark | ✅ | ACL + Reader |
| 9  | SubscribeOneLakeEvents | ✅ | Cosmos row metadata |
| 10 | Execute | ✅ | Cosmos row metadata (offered for runnable item types) |
| 11 | Build | ✅ | Cosmos row metadata (offered for semantic-model) |
| 12 | Type-tailored permission set | ✅ | `permissionOptionsFor()` in `share-item-dialog.tsx` |
| 13 | Multi-step Share dialog | ✅ | `lib/dialogs/share-item-dialog.tsx` |
| 14 | List grants | ✅ | `GET /api/items/[type]/[id]/permissions` → `listItemPermissions` |
| 15 | Revoke grant | ✅ | `DELETE …?permissionId=` → `revokeItemPermission` |
| 16 | DLP badge + Edit/Reshare block | ✅ | `resolveDlp()` (Purview DLP Graph) + MessageBar |
| 17 | Revocation caveat | ✅ | Caption on page + dialog |
| —  | No-Fabric default | ✅ | works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET; Fabric `/share` opt-in only |

Honest gates (⚠️, not ❌): when an item has no resolved ADLS storage path the
data-plane types are recorded in Loom but not mirrored to a POSIX ACL (an
`intent="info"` MessageBar explains this); when the Console UAMI lacks Graph
permissions the principal search surfaces the exact remediation.

## Backend per control

| Control | Backend REST / data-plane |
|---------|---------------------------|
| Principal search | Microsoft Graph `/v1.0/users` · `/groups` |
| Grant (Cosmos) | Cosmos `item-permissions` `items.upsert` |
| Grant (ACL) | `DataLakeDirectoryClient.setAccessControl` (DFS) |
| Grant (RBAC) | ARM `Microsoft.Authorization/roleAssignments` PUT @ container scope |
| Grant (Fabric, opt-in) | `POST api.fabric.microsoft.com/v1/workspaces/{ws}/items/{id}/users` |
| DLP reflection | Microsoft Graph `/beta/security/dataLossPreventionPolicies` |
| Revoke (ACL) | `setAccessControl` (principal entry removed) |
| Revoke (RBAC) | ARM role-assignment DELETE |
| Revoke (Cosmos) | Cosmos `item.delete` |

## Bicep / bootstrap sync

- Cosmos `item-permissions` container — created lazily by `cosmos-client.ensure()`.
- `LOOM_FABRIC_PERMISSIONS_ENABLED` (opt-in) — `param loomFabricPermissionsEnabled`
  in `platform/fiab/bicep/modules/admin-plane/main.bicep`, wired into the console
  Container App env (omitted in GCC-High / IL5).
- UAMI Storage Blob Data Owner (ACLs) + RG Contributor (role-assignment write) +
  Graph User.Read.All/Group.Read.All — already granted by existing modules.
