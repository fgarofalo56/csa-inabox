# workspace-access — parity with the Fabric workspace "Manage access" (admin-plane, F9)

Source UI: Microsoft Fabric **Admin portal** → workspace governance + the
per-workspace **Manage access** pane
(`https://learn.microsoft.com/fabric/fundamentals/give-access-workspaces`,
`https://learn.microsoft.com/fabric/fundamentals/roles-workspaces`).

Azure-native parity draws on the Azure portal **Access control (IAM) → Role
assignments** experience
(`https://learn.microsoft.com/azure/role-based-access-control/role-assignments-portal`)
because the backend is real Azure RBAC, not a Fabric capacity.

This is the **admin-plane** counterpart to `manage-access.md`: instead of an
owner managing their own workspace from the workspace surface, a **tenant
admin** opens **Admin → Permissions → Workspace access**, picks ANY workspace,
and manages its roster. Same backend, admin-scoped authz.

## Source feature inventory

| # | Capability | Notes |
|---|------------|-------|
| 1 | Pick a workspace | Admin selects any workspace in the tenant |
| 2 | List members with role | User / group / service principal, role per principal |
| 3 | Four workspace roles | Admin, Member, Contributor, Viewer |
| 4 | Add people / groups / SPs | Directory search; user, group, or service principal |
| 5 | Assign a role on add | Role picker with per-role capability description |
| 6 | Edit an existing member's role | Change role in place |
| 7 | Remove a member | Revokes the principal's access (with confirmation) |
| 8 | Groups (incl. nested) as principals | Security groups resolve to a workspace role |
| 9 | Admin-only management | Workspace Admin/owner OR tenant admin |

## Loom coverage

| # | Capability | Status | Where |
|---|------------|--------|-------|
| 1 | Workspace picker | built ✅ | `permissions/page.tsx` `WorkspaceAccessTab` → `GET /api/admin/workspaces` |
| 2 | Member list + role + Azure RBAC column | built ✅ | `workspace-access.tsx` Table; `listRoleAssignments` → Cosmos `workspace-roles` |
| 3 | Admin/Member/Contributor/Viewer | built ✅ | `WORKSPACE_ROLE_NAMES` + role badges |
| 4 | Add user/group/SP via Entra | built ✅ | `AddMemberDialog` → `<IdentityPicker kind="all">` → `GET /api/governance/identities/search` (real Graph) |
| 5 | Role picker w/ descriptions | built ✅ | `AddMemberDialog` Dropdown w/ `ROLE_DESCRIPTIONS` |
| 6 | Edit member role (upsert) | built ✅ | `EditRoleDialog` → `addRoleAssignment` re-POST (Cosmos upsert + RBAC re-PUT) |
| 7 | Remove member (confirm) | built ✅ | `RemoveConfirmDialog` → `DELETE /role-assignments/{principalId}` |
| 8 | Group principals → RBAC | built ✅ | `Group` principalType row + Azure RBAC mirror (Contributor/Reader) |
| 9 | Admin-only management | built ✅ | `resolveWorkspaceRole` (owner/`admin`) OR `isTenantAdmin` bypass on GET/POST/DELETE |
| — | Azure RBAC enforcement gate | honest-gate ⚠️ | `checkRbacAdminCapability` → `rbacAdminGate` MessageBar when UAMI lacks RBAC-Admin |
| — | Fabric role mirroring | honest-gate ⚠️ (opt-in) | `LOOM_WORKSPACE_ROLES_FABRIC=1` only; UNSET ⇒ Azure-native, no Fabric call |

Zero ❌. The only non-built states are honest infra/opt-in gates that still
render the full surface, per `no-vaporware.md` / `ui-parity.md`.

## Backend per control

| Control | Backend |
|---------|---------|
| Workspace list | Cosmos `workspaces` (tenant-partitioned) via `GET /api/admin/workspaces` |
| List members | Cosmos `workspace-roles` (PK `/workspaceId`) — system of record |
| Add / edit member | Cosmos upsert + **ARM** `PUT …/Microsoft.Authorization/roleAssignments/{guid}` on the DLZ RG (Admin/Member→Contributor `b24988ac…`; Contributor/Viewer→Reader `acdd72a7…`); deterministic GUID ⇒ re-PUT is idempotent |
| Remove member | **ARM** `DELETE` the mirrored assignment + Cosmos delete |
| Entra search | **Microsoft Graph** `/users` `/groups` `/servicePrincipals` (`graph-identity-client.ts`, cloud-aware via `graphBase()`) |
| Nested-group expansion | **Microsoft Graph** `/groups/{id}/transitiveMembers` |
| RBAC-admin probe | **ARM** zero-cost `roleAssignments?$top=1` list (403 ⇒ honest gate) |
| Fabric mirror (opt-in) | **Fabric** `POST`/`DELETE /v1/workspaces/{id}/roleAssignments` — only when `LOOM_WORKSPACE_ROLES_FABRIC=1` |

## No-Fabric-dependency compliance

Default path (env unset) touches only Cosmos + ARM + Graph — never
`api.fabric.microsoft.com`. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.
`LOOM_WORKSPACE_ROLES_FABRIC` is now wired to opt-in **only in Commercial**
(`main.bicep`); GCC, GCC-High, IL5, and DoD always run Azure-native.
Bicep grants the constrained RBAC-Admin role (`workspace-rbac.bicep`,
ABAC-limited to Contributor + Reader) so the mirror is enforced out of the box.

## E2E acceptance (per task)

Adding a real group as **Member** creates:
1. a Cosmos `workspace-roles` doc `{workspaceId}:{groupObjectId}` with
   `role: 'Member'`, `principalType: 'Group'`, `azureRoleStatus: 'active'`; AND
2. a verifiable **Azure RBAC** role assignment on the DLZ RG
   (`Contributor` for the group principal) — confirm with
   `az role assignment list --assignee <groupObjectId> --scope /subscriptions/<sub>/resourceGroups/<dlz-rg>`.

Removing the member deletes the Cosmos doc AND revokes the RBAC assignment
(the same `az role assignment list` returns empty for that assignee/scope).
