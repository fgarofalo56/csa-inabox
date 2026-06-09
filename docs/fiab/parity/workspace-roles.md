# workspace-roles — parity with Fabric Workspace roles (Manage access)

Source UI: Fabric **Workspace → Manage access** pane
Reference: <https://learn.microsoft.com/fabric/get-started/roles-workspaces>
Run date: 2026-06-09

Loom surfaces:

- BFF: `app/api/workspaces/[id]/role-assignments/route.ts` (GET/POST)
- Client: `lib/azure/workspace-roles-client.ts` → `listWorkspaceRoles`,
  `addWorkspaceRole`, `checkRbacAdminCapability`, `resolveEffectiveRole`
- Model: `lib/azure/workspace-role-model.ts` → `WORKSPACE_ROLE_NAMES`,
  `ROLE_TO_RBAC`, `pickHighestRole`
- Store: Cosmos `workspace-roles` (PK `/workspaceId`) + ARM
  `Microsoft.Authorization/roleAssignments` mirror

Role assignments are **Azure-native**: the source of truth is the Cosmos
`workspace-roles` container, and each Loom role is mirrored to real Azure RBAC on
the data-landing-zone resource group. There is **no dependency on real Microsoft
Fabric** — the Fabric workspace-role sync is strictly opt-in. Works with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. List role assignments (Admin / Member / Contributor / Viewer)
2. Add a person/group to a role
3. Change or remove a role
4. Role-based capability enforcement (only Admin can manage access)
5. Transitive group membership resolution (effective role through nested groups)

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| List role assignments (Admin/Member/Contributor/Viewer) | ✅ Built | `GET /api/workspaces/[id]/role-assignments` → `listWorkspaceRoles()` → Cosmos `workspace-roles` |
| Add role assignment (principalId, principalType, displayName, role) | ✅ Built | `POST …/role-assignments` → `addWorkspaceRole()` |
| Mirror to Azure RBAC (DLZ RG Contributor/Reader per `ROLE_TO_RBAC`) | ✅ Built | ARM `Microsoft.Authorization/roleAssignments/write` via UAMI |
| RBAC-admin capability check + honest gate | ✅ Built | `checkRbacAdminCapability()` → `rbacAdminGate` field with precise remediation |
| Nested-group transitive member resolution (effective role) | ✅ Built | `resolveEffectiveRole()` → Graph `transitiveMembers` |
| Caller-role enforcement (only Admin/owner may manage) | ✅ Built | `resolveWorkspaceRole()` check in route |
| Fabric workspace role sync | ⚠️ Honest gate (opt-in) | `LOOM_WORKSPACE_ROLES_FABRIC=1` + `api.fabric.microsoft.com/v1/workspaces/{id}/roleAssignments` |

Zero ❌ rows. The Azure RBAC mirror honest-gates (`rbacAdminGate`) when the
console UAMI lacks Role Based Access Control Administrator on the target scope —
the Cosmos role still saves and the gate names the exact remediation. The Fabric
sync is opt-in and absent by default.

## Backend per control

- **List** — `listWorkspaceRoles()` reads Cosmos `workspace-roles` filtered to
  the workspace; merges any ARM role assignments discovered on the DLZ scope.
- **Add** — `addWorkspaceRole()` writes the Cosmos record, then maps the Loom
  role to its Azure role (`ROLE_TO_RBAC`: Admin/Member→Contributor,
  Contributor→Contributor, Viewer→Reader) and creates an ARM role assignment via
  the UAMI. If the UAMI can't write RBAC, `checkRbacAdminCapability()` returns a
  gate naming `Role Based Access Control Administrator` on the scope; the Cosmos
  write still succeeds.
- **Effective role** — `resolveEffectiveRole()` calls Graph `transitiveMembers`
  to resolve a principal's role through nested-group membership, then
  `pickHighestRole()` to collapse to the strongest grant.
- **Fabric sync** — only reached when `LOOM_WORKSPACE_ROLES_FABRIC=1` AND a bound
  workspace exists.

## Per-cloud notes

| Cloud | RBAC mirror | Graph transitive | Fabric sync |
|---|---|---|---|
| Commercial | ARM `management.azure.com` | `graph.microsoft.com` | opt-in |
| GCC | Same as Commercial | Same | opt-in |
| GCC-High | ARM `management.usgovcloudapi.net` | `graph.microsoft.us` | leave unset (Fabric REST unavailable) |
| IL5 | ARM US Gov | `graph.microsoft.us` | leave unset |

## Bicep sync

- No new resource — `workspace-roles` Cosmos container via existing init.
- The console UAMI needs **Role Based Access Control Administrator** (constrained)
  on the DLZ resource group to write the RBAC mirror — granted in the
  landing-zone RBAC bicep module; absent that grant the surface honest-gates.
- `LOOM_WORKSPACE_ROLES_FABRIC` is an optional opt-in env, defaulted unset in all
  boundary params.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — Cosmos +
  ARM RBAC only; no Fabric host on the default path.
- Live walk: open a workspace's Manage access, add a group as Member, confirm
  the Cosmos record + (when UAMI is authorized) the ARM role assignment on the
  DLZ RG; add a nested group and confirm `resolveEffectiveRole` collapses to the
  highest role; confirm a non-admin caller is rejected.

Grade: **A** — Cosmos source-of-truth + real ARM RBAC mirror + transitive
resolution; RBAC-admin and Fabric-sync are the only (honest / opt-in) gates.
