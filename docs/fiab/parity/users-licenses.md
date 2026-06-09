# users-licenses — parity with Fabric Admin Users

Source UI: Fabric Admin portal → **Users** (Microsoft 365 admin center users)
Reference: <https://learn.microsoft.com/fabric/admin/service-admin-portal-users>
Run date: 2026-06-09

Loom surfaces:

- Page: `/admin/users` → `app/admin/users/page.tsx`
- BFF: `app/api/admin/users/route.ts`

The user list is **Azure-native**: derived from the deployment's own Cosmos
containers, with optional Microsoft Graph enrichment. There is **no dependency on
real Microsoft Fabric** — it renders with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. List users with display name + UPN
2. Per-user workspace participation + item ownership
3. Last activity
4. License / subscription assignment
5. Deep-link to manage the user in Entra / M365 admin
6. Search

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| User list (UPN, workspace owned/member counts, item-created count, last activity, roles) | ✅ Built | `GET /api/admin/users` → Cosmos derivation from `workspaces` + `workspace-permissions` + `items` |
| Search across UPN + display name | ✅ Built | Client-side filter |
| Entra deep-link per user | ✅ Built | `Open16Regular` link to the Entra portal (cloud-aware domain) |
| Display name + department enrichment | ⚠️ Honest gate | Microsoft Graph `Directory.Read.All`; MessageBar names `LOOM_GRAPH_USERS_ENABLED` + the app role. The page works without Graph (UPN-only). |
| License / subscription column | ⚠️ Honest gate | No Power BI REST license query; the column shows Cosmos-derived Loom roles. Fabric license data requires Power BI REST `GET /admin/users/{id}/subscriptions` (not wired). |

Zero ❌ rows. Both ⚠️ gates (Graph enrichment, Fabric license data) keep the
page fully rendering with the Cosmos-derived data; each names the exact
remediation, per `no-vaporware.md`.

## Backend per control

- **User list** — `GET /api/admin/users` aggregates across Cosmos `workspaces`
  (owner + member counts), `workspace-permissions` (roles), and `items`
  (created-count + `MAX(updatedAt)` for last activity), keyed by UPN.
- **Enrichment** — when `LOOM_GRAPH_USERS_ENABLED` and the UAMI holds
  `Directory.Read.All`, display name + department are fetched from Graph;
  otherwise the row shows the UPN and the gate names the role.
- **License** — Loom shows Cosmos-derived roles; Fabric subscription/license data
  would need the Power BI admin REST subscriptions endpoint, disclosed as a gate.
- **Deep-link** — per-user Entra portal URL, domain switched per cloud.

## Per-cloud notes

| Cloud | Graph endpoint |
|---|---|
| Commercial / GCC | `graph.microsoft.com` |
| GCC-High / IL5 | `dod-graph.microsoft.us` (Entra deep-link domain switches accordingly) |

`Directory.Read.All` is available in all clouds, so the enrichment gate can be
lifted in every boundary by granting the role.

## Bicep sync

- No new resource — derives from existing Cosmos containers.
- `LOOM_GRAPH_USERS_ENABLED` env in `admin-plane/main.bicep` `apps[]`.
- The console UAMI's `Directory.Read.All` Graph app-role grant is in the
  admin-plane RBAC bicep (optional; absent → honest gate).

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset — Cosmos
  derivation only.
- Live walk: open `/admin/users`, confirm the list shows UPN + workspace/item
  counts + last activity from real Cosmos data, search filters, and the Entra
  deep-link opens the right cloud's portal; with Graph enabled, confirm display
  name + department populate; confirm the license column honestly states its
  source.

Grade: **B+** — real Cosmos-derived user inventory + search + Entra deep-link;
Graph enrichment and Fabric license data are honest gates.
