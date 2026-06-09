# sql-database-share — parity with Azure SQL database "Access control (IAM)" + schema source control

Source UI:
- Azure portal **Access control (IAM) → Role assignments → Add role
  assignment** scoped to a single Azure SQL database resource
  (`Microsoft.Sql/servers/{server}/databases/{db}`)
  (https://learn.microsoft.com/azure/role-based-access-control/role-assignments-portal).
- Azure RBAC **delegate role assignments with conditions** (constrained
  RBAC-Admin)
  (https://learn.microsoft.com/azure/role-based-access-control/delegate-role-assignments-overview).
- Azure SQL Database **schema source control / SSDT + Git** (DACPAC diff,
  schema compare)
  (https://learn.microsoft.com/sql/tools/sqlpackage/sqlpackage).

Loom builds the per-database Share experience 1:1 on **Azure-native ARM RBAC**
(role assignments at the database scope + Microsoft Graph principal picker) —
**no Microsoft Fabric / Power BI tenant required**. Schema source control is an
**honest connection gate** (ADO / GitHub) per `no-vaporware.md`.

## Source feature inventory (every capability)

| # | Capability (Azure portal IAM / Git) | Notes |
|---|-------------------------------------|-------|
| 1 | Pick a principal (user / group) via a searchable Entra picker | display name + UPN search |
| 2 | Choose a role from a role dropdown | scoped to the resource's applicable roles |
| 3 | Assign the role at the database scope (real ARM PUT) | returns the assignment id |
| 4 | List current role assignments declared at this scope | principal + type + role |
| 5 | Show the role assignment id (receipt) | full ARM id |
| 6 | Remove (revoke) a role assignment | ARM DELETE |
| 7 | Least-privilege: assigner cannot escalate beyond allowed roles | ABAC-constrained RBAC-Admin |
| 8 | Honest 403 when the caller lacks grant rights | ARM authorization error verbatim |
| 9 | Connect schema source control (Azure DevOps / GitHub) | repo + PAT |
| 10 | DACPAC schema diff / migration history | SqlPackage pipeline |

## Loom coverage

| # | Status | Where |
|---|--------|-------|
| 1 | built ✅ | `GET /api/items/azure-sql-database/[id]/principal-search?q=&kind=` → Microsoft Graph (`graph-principals.ts`); `ShareDialog` debounced picker with `Persona` rows |
| 2 | built ✅ | role `Dropdown` (Reader / Contributor / SQL DB Contributor) in `share-dialog.tsx` |
| 3 | built ✅ | `POST …/share` → `grantDatabaseRole()` ARM PUT `Microsoft.Authorization/roleAssignments` at `…/databases/{db}` scope |
| 4 | built ✅ | `GET …/share` → `listDatabaseRoleAssignments()` (`$filter=atScope()`); "Current access" sub-tab table |
| 5 | built ✅ | success MessageBar prints `assignment.id` with a copy button |
| 6 | built ✅ | `DELETE …/share?assignmentId=` → `revokeDatabaseRoleAssignment()` ARM DELETE; Revoke button per row |
| 7 | built ✅ | `sql-database-share-rbac.bicep` grants RBAC-Admin **ABAC-constrained** to the three role GUIDs only |
| 8 | built ✅ | `armRequest` throws `AzureSqlError(403)`; route `handleErr` returns HTTP 403 + verbatim ARM message; dialog renders it in an error MessageBar |
| 9 | honest-gate ⚠️ | Source control tab MessageBar names `LOOM_SQL_GIT_PROVIDER` / `LOOM_SQL_GIT_ADO_*` / `LOOM_SQL_GIT_GITHUB_*`; bicep params + `docs/fiab/v3-tenant-bootstrap.md#sql-database-git` |
| 10 | honest-gate ⚠️ | documented SqlPackage `/Action:Extract` + `/Action:Script` pipeline step (bootstrap doc) — runs in ADO/GitHub, not a fake in-app commit form |

## Backend per control

| Control | Backend |
|---------|---------|
| Principal search | Microsoft Graph `/users` + `/groups` `$filter=startswith(...)` (cloud-aware via `cloud-endpoints.graphBase()`) |
| Assign | ARM `PUT …/databases/{db}/providers/Microsoft.Authorization/roleAssignments/{guid}?api-version=2022-04-01` |
| Current access | ARM `GET …/databases/{db}/providers/Microsoft.Authorization/roleAssignments?$filter=atScope()` |
| Revoke | ARM `DELETE {roleAssignmentArmId}?api-version=2022-04-01` |
| Git tab | env-driven honest gate (no ARM data-plane API exists for schema VCS) |

## Per-cloud behaviour

ARM + Graph hosts route through `cloud-endpoints.ts` (`armBase()` / `graphBase()`):
Commercial + GCC use `management.azure.com` + `graph.microsoft.com`; GCC-High
uses `management.usgovcloudapi.net` + `graph.microsoft.us`; DoD adds
`dod-graph.microsoft.us`. The four role-definition GUIDs are identical across all
clouds. The Git gate is identical text in every cloud (DoD: use ADO Government
endpoints, not commercial `dev.azure.com`).

## Verification

`LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET — the entire Share surface is Azure-only.
Assigning **Reader** to a real principal returns a live ARM assignment id
(receipt); the Current access tab lists it; Revoke removes it on re-list; an
unauthorized Console UAMI yields an honest 403. Unit-covered by
`apps/fiab-console/lib/azure/__tests__/azure-sql-client-share.test.ts`.
