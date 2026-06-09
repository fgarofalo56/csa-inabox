# users-licenses — parity with the Microsoft 365 admin center **Active users** + **Licenses** experience

Source UI:
- Microsoft 365 admin center → **Users → Active users** grid (displayName, UPN,
  account status, assigned licenses, per-user details / license assignment).
  https://learn.microsoft.com/microsoft-365/admin/add-users/about-admin-roles
  , https://learn.microsoft.com/microsoft-365/admin/manage/assign-licenses-to-users
- Microsoft 365 admin center → **Billing → Licenses** roll-up (per-SKU
  assigned / available counts, capability status).
  https://learn.microsoft.com/microsoft-365/admin/manage/view-licenses-and-services
- Microsoft Graph backing: `GET /v1.0/subscribedSkus`,
  `GET /v1.0/users?$select=...,assignedLicenses`.
  https://learn.microsoft.com/graph/api/subscribedsku-list ,
  https://learn.microsoft.com/graph/api/user-list

Loom builds this **1:1 on Azure-native backends** — Cosmos (workspaces / items /
workspace-permissions / F5 workspace-roles) for the Loom-access view, and
Microsoft Graph (Directory.Read.All + User.Read.All on the Console UAMI) for the
Entra identity + license + account-status enrichment. **No Microsoft Fabric /
Power BI tenant is required**; Graph is the same directory the M365 admin center
reads. Available in Commercial, GCC, GCC-High (L4), and DoD (L5).

## Source feature inventory (every capability)

| #  | Capability (M365 admin center / Graph)                              | Notes |
|----|---------------------------------------------------------------------|-------|
| 1  | Searchable user grid (name, UPN, status)                            | Active users list |
| 2  | displayName + UPN per user                                          | |
| 3  | Department column                                                   | from directory profile |
| 4  | Account status (enabled / disabled / blocked sign-in)              | `accountEnabled` |
| 5  | Assigned licenses per user (SKU part numbers)                      | `assignedLicenses[].skuId` → SKU |
| 6  | Tenant license roll-up: assigned / available per SKU               | Billing → Licenses |
| 7  | Per-SKU capability status (Enabled / Warning / Suspended)          | `capabilityStatus` |
| 8  | Open a single user's detail in the admin center                   | per-user deep-link |
| 9  | Cross-link to Entra (Azure AD) user profile                       | Identity blade |
| 10 | Per-user role assignments / scoped access                         | M365 = admin roles; Loom = workspace roles |
| 11 | Sort / filter the grid                                             | column sort + search |

## Loom coverage

| #  | Status | Where |
|----|--------|-------|
| 1  | built ✅ | `app/admin/users/page.tsx` LoomDataTable + Toolbar search over `/api/admin/users` |
| 2  | built ✅ | User cell renders displayName (Graph) over UPN; UPN always present from Cosmos |
| 3  | built ✅ | Department column (Graph `department`) |
| 4  | built ✅ | Account column — `accountEnabled` → Active / Disabled badge (shown when Graph enabled) |
| 5  | built ✅ | Licenses column — `assignedLicenses[].skuId` resolved to `skuPartNumber` via the `subscribedSkus` join in the route |
| 6  | built ✅ | "License inventory" stat-card grid — one card per `subscribedSku`, `consumedUnits/prepaidUnits.enabled` |
| 7  | built ✅ | per-card capability-status Badge (success when `Enabled`, else warning) |
| 8  | built ✅ | "M365" admin deep-link — `${m365AdminBase}/Adminportal/Home#/users/:/UserDetails/{objectId}` (falls back to the users list when no objectId / DoD) |
| 9  | built ✅ | "Entra" link → `portal.azure.com` UserProfileMenuBlade by UPN |
| 10 | built ✅ | Roles cell shows legacy workspace-permissions roles + a "N ws-roles" Popover expanding the F5 principalId-keyed `workspace-roles` rows (workspace → role), joined by the user's Entra objectId |
| 11 | built ✅ | LoomDataTable provides per-column sort/filter; page Toolbar search covers UPN / name / department / role / license |

Honest-gate (⚠️, not a stub): when `LOOM_GRAPH_USERS_ENABLED` is unset or the
UAMI lacks Directory.Read.All / User.Read.All, the license + account + objectId
columns are empty and a Fluent `MessageBar intent="info"` names the exact env
var + the `grant-uami-graph-roles.sh` script to run. The grid still renders real
Cosmos-derived users, activity, and legacy roles — never an empty/error surface.

## Backend per control

| Control                         | Backend call |
|---------------------------------|--------------|
| User grid (base)                | Cosmos: `workspaces` (createdBy), `items` (createdBy), `workspace-permissions` (UPN-keyed) — tenant-scoped |
| displayName / department / accountEnabled / objectId | Graph `GET /v1.0/users?$select=id,userPrincipalName,displayName,department,accountEnabled,assignedLicenses&$filter=...&$count=true` via `listUsersWithLicenses()` (15-UPN chunks, ConsistencyLevel: eventual) |
| Licenses column                 | `assignedLicenses[].skuId` joined to `subscribedSkus.skuPartNumber` |
| License inventory cards         | Graph `GET /v1.0/subscribedSkus?$select=skuId,skuPartNumber,consumedUnits,prepaidUnits,capabilityStatus` via `fetchSubscribedSkus()` |
| ws-roles Popover                | Cosmos `workspace-roles` (F5) cross-partition read via `listAllWorkspaceRolesForWorkspaces(wsIds)`, joined to users by Entra objectId |
| M365 admin deep-link            | `detectLoomCloud()` → `admin.microsoft.com` / `admin.microsoft.us` / `admin.apps.mil` |
| Entra link                      | `portal.azure.com` UserProfileMenuBlade (static deep-link) |

## Per-cloud notes

| Feature                         | Commercial / GCC        | GCC-High (L4)          | DoD (L5)                  |
|---------------------------------|-------------------------|------------------------|---------------------------|
| Graph base (`LOOM_GRAPH_BASE`)  | graph.microsoft.com     | graph.microsoft.us     | dod-graph.microsoft.us    |
| `GET /subscribedSkus`           | available               | available              | available                 |
| `assignedLicenses` on `/users`  | available               | available              | available                 |
| M365 admin host                 | admin.microsoft.com     | admin.microsoft.us     | admin.apps.mil            |
| Per-user M365 deep-link         | `#/users/:/UserDetails/{oid}` | same             | falls back to `#/users` (no published per-user path) |

## Verification

- `tsc --noEmit` clean for the four touched files.
- `vitest run lib/azure/__tests__/graph-identity-client.test.ts` — 11 passing
  (6 new: subscribedSkus shaping, gate, error-swallow; user chunking, $count +
  ConsistencyLevel, lowercase keying, short-circuit).
- Live walk (operator): `/admin/users` with `LOOM_GRAPH_USERS_ENABLED=true` +
  the UAMI grant shows real tenant users, real `subscribedSkus` cards, real
  per-user license SKUs, the ws-roles Popover from the F5 store, and the M365
  deep-link — all with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.
