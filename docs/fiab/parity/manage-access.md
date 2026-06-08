# manage-access — parity with the Fabric workspace "Manage access" experience

Source UI: Microsoft Fabric workspace → **Manage access** pane
(`https://learn.microsoft.com/fabric/fundamentals/give-access-workspaces`,
`https://learn.microsoft.com/fabric/fundamentals/roles-workspaces`).

Azure-native parity also draws on the Azure portal **Access control (IAM) →
Role assignments** experience
(`https://learn.microsoft.com/azure/role-based-access-control/role-assignments-portal`)
since the backend is real Azure RBAC, not a Fabric capacity.

## Source feature inventory (Fabric "Manage access")

| # | Capability | Notes |
|---|------------|-------|
| 1 | List members with role | User / group / service principal, role per principal |
| 2 | Four workspace roles | Admin, Member, Contributor, Viewer (priority order) |
| 3 | Add people / groups | Search the directory by name; pick user OR group (or SP) |
| 4 | Assign a role on add | Role picker with per-role capability description |
| 5 | Groups as principals | Security groups (incl. nested) resolve to a workspace role |
| 6 | Remove a member | Revokes the principal's access |
| 7 | Effective-role precedence | Highest role wins when inherited via multiple groups |
| 8 | Permission gating | Only Admins (and the owner) can manage access |

## Loom coverage

| # | Capability | Status | Where |
|---|------------|--------|-------|
| 1 | Member list + role | built ✅ | `manage-access-pane.tsx` Table; `GET /role-assignments` → Cosmos `workspace-roles` |
| 2 | Admin/Member/Contributor/Viewer | built ✅ | `workspace-role-model.ts` `ROLE_PRIORITY` + role badges |
| 3 | Add user/group via Entra search | built ✅ | `AddRoleDialog` User/Group tabs → `GET /api/admin/permissions/principals` (real Graph) |
| 4 | Role picker w/ descriptions | built ✅ | `AddRoleDialog` Dropdown with `ROLE_DESCRIPTIONS` |
| 5 | Group principals → RBAC | built ✅ | `Group` principalType row + Azure RBAC mirror (Contributor/Reader) |
| 6 | Remove member | built ✅ | `DELETE /role-assignments/{principalId}` → revoke RBAC + delete Cosmos row |
| 7 | Highest-role resolution (nested) | built ✅ | `resolveEffectiveRole` + `pickHighestRole` (Graph `transitiveMembers`); unit-tested |
| 8 | Admin-only management | built ✅ | `resolveWorkspaceRole` gate (owner/`admin`) on POST/DELETE |
| — | Azure RBAC enforcement gate | honest-gate ⚠️ | `checkRbacAdminCapability` → `rbacAdminGate` MessageBar when UAMI lacks RBAC-Admin |
| — | Fabric role mirroring | honest-gate ⚠️ (opt-in) | `LOOM_WORKSPACE_ROLES_FABRIC=1` only; UNSET ⇒ Azure-native, no Fabric call |

Zero ❌. The only non-built states are honest infra/opt-in gates that still render
the full surface, per `no-vaporware.md` / `ui-parity.md`.

## Backend per control

| Control | Backend |
|---------|---------|
| List members | Cosmos `workspace-roles` (PK `/workspaceId`) — system of record |
| Add member | Cosmos upsert + **ARM** `PUT …/Microsoft.Authorization/roleAssignments/{guid}` on the DLZ RG (Admin/Member→Contributor `b24988ac…`; Contributor/Viewer→Reader `acdd72a7…`) |
| Remove member | **ARM** `DELETE` the mirrored assignment + Cosmos delete |
| Entra search | **Microsoft Graph** `/users` `/groups` (existing `principals` route; now cloud-aware via `graphBase()`) |
| Nested-group resolution | **Microsoft Graph** `/groups/{id}/transitiveMembers` |
| RBAC-admin probe | **ARM** zero-cost `roleAssignments?$top=1` list (403 ⇒ honest gate) |
| Fabric mirror (opt-in) | **Fabric** `POST`/`DELETE /v1/workspaces/{id}/roleAssignments` — only when `LOOM_WORKSPACE_ROLES_FABRIC=1` |

## No-Fabric-dependency compliance

Default path (env unset) touches only Cosmos + ARM + Graph — never
`api.fabric.microsoft.com`. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.
Bicep grants the constrained RBAC-Admin role (`workspace-rbac.bicep`,
ABAC-limited to Contributor + Reader) so the mirror is enforced out of the box.
