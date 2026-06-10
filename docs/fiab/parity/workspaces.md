# workspaces — parity with Fabric Workspaces browser + admin inventory

Source UI: Fabric **Workspaces** flyout/list + Admin → **Workspaces**
Reference: <https://learn.microsoft.com/fabric/get-started/workspaces>
Run date: 2026-06-09

Loom surfaces:

- User browser: `/workspaces` → `app/workspaces/page.tsx`
- Admin inventory: `/admin/workspaces` → `app/admin/workspaces/page.tsx`
- BFF: `app/api/workspaces/route.ts` (GET with `?count=true`),
  `app/api/admin/workspaces/route.ts`

Workspaces are a **Loom-native** organizational construct persisted in the Cosmos
`workspaces` container (PK `/tenantId`). There is **no dependency on real
Microsoft Fabric** — both surfaces render and operate with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. Browse my workspaces (tile + list views)
2. Search / filter / sort workspaces
3. Pin favourite workspaces
4. See item count and last activity per workspace
5. Create a workspace from the browser
6. Tenant-admin: see all workspaces across all owners, with item counts and
   activity, and open any of them

## Loom coverage

### User browser (`/workspaces`)

| Capability | Status | Backend |
|---|---|---|
| Tile view + List view toggle (persisted) | ✅ Built | `localStorage` `loom.workspaces.viewMode.v1` |
| Live search (debounced 150ms) across name + description | ✅ Built | Client filter |
| Sort: Name A-Z/Z-A, Created newest/oldest, Last accessed, Item count | ✅ Built | Client sort; persisted `loom.workspaces.sortMode.v1` |
| Filter: capacity (none/shared/dedicated), domain (dynamic), owner (Me/All) | ✅ Built | Client filter + chip rendering |
| Pin toggle per workspace (pinned float to top) | ✅ Built | `localStorage` `loom.workspaces.pinned.v1` |
| Colour-coded tiles (capacity / domain / neither) | ✅ Built | `itemVisual()` |
| Item-count aggregation | ✅ Built | `GET /api/workspaces?count=true` → Cosmos GROUP BY `workspaceId` |
| Create workspace | ✅ Built | `CreateWorkspaceDialog` (see `workspace-create.md`) |

### Admin inventory (`/admin/workspaces`)

| Capability | Status | Backend |
|---|---|---|
| Tenant-wide workspace inventory (all owners) | ✅ Built | `GET /api/admin/workspaces` → Cosmos `workspaces` (tenant-scoped) |
| Per-row item count + last activity | ✅ Built | Cosmos `items` COUNT + MAX(updatedAt) |
| Per-row Open link | ✅ Built | `/workspaces/{id}` |

Zero ❌ rows, zero ⚠️ gates — entirely Cosmos-backed Loom-native data.

## Backend per control

- **User browser** — `GET /api/workspaces` → `workspacesContainer()` filtered to
  the caller's owned/member workspaces; `?count=true` adds a per-workspace item
  count via `itemsContainer()` `GROUP BY workspaceId`. View/sort/filter/pin state
  is client-only in `localStorage`.
- **Admin inventory** — `GET /api/admin/workspaces` reads the full
  `workspaces` container scoped to `tenantId` (admin role enforced), joining
  `items` for count + `MAX(updatedAt)` for last activity.

## Per-cloud notes

| Cloud | Behaviour |
|---|---|
| Commercial / GCC / GCC-High / IL5 | Identical — Cosmos-backed, cloud-agnostic. Capacity binding shown on a tile is informational (the real capacity assignment is covered in `workspace-create.md`). |

## Bicep sync

- No new resource — the `workspaces` and `items` Cosmos containers are created by
  the existing Cosmos init step.
- No new env var or role grant.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- Live walk: open `/workspaces`, toggle tile/list (reload persists), search +
  sort + filter + pin a workspace, confirm item counts; open `/admin/workspaces`
  as an admin and confirm the tenant-wide inventory with counts + last activity
  + Open links.

Grade: **A** — both surfaces fully built on real Cosmos, zero gates.
