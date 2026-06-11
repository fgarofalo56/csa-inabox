# workspaces — parity with Fabric Workspaces browser + admin inventory

Source UI: Fabric **Workspaces** flyout/list + Admin → **Workspaces**
Reference: <https://learn.microsoft.com/fabric/get-started/workspaces>
Run date: 2026-06-11

> **2026-06-11 redesign (audit-t109):** `/workspaces` was rebuilt on the shared
> Loom UI primitives — `Section`/`Toolbar`, `ViewToggle`, `TileGrid`+`ItemTile`,
> and `LoomDataTable` — replacing the page's ~50 hand-rolled `makeStyles` classes
> and three bespoke render functions. List view now gets per-column header sort,
> resizable columns, and the standard per-column filter row for free; tile view
> uses `ItemTile` with the kebab overflow menu (Open / Settings / Pin) and a
> footer badge row (item count, capacity, domain). All behaviour below is
> preserved. Two visual changes: tiles take their icon/colour from
> `itemVisual('workspace')` (a single neutral chip, matching `/browse`) rather
> than the old capacity/domain/none colour split — the capacity + domain signal
> now reads from the footer badges instead.

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
| Tile view + List view toggle (persisted) | ✅ Built | `ViewToggle` + `localStorage` `loom.workspaces.viewMode.v1` |
| Live search (debounced 150ms) across name + description | ✅ Built | `Toolbar` SearchBox → client filter |
| Sort: Name A-Z/Z-A, Created newest/oldest, Last accessed, Item count | ✅ Built | Toolbar Sort menu (tile order) + `LoomDataTable` header sort (list); persisted `loom.workspaces.sortMode.v1` |
| Filter: capacity (none/shared/dedicated), domain (dynamic), owner (Me/All) | ✅ Built | Toolbar Filter menu + chips; list view adds per-column filters |
| Pin toggle per workspace (pinned float to top) | ✅ Built | Kebab Pin/Unpin + `localStorage` `loom.workspaces.pinned.v1`; pinned render in their own `Section` |
| Per-workspace overflow menu (Open / Settings / Pin) | ✅ Built | `ItemTile.overflowMenu` (tile) + actions column (list) |
| Tile visuals + footer badges (item count / capacity / domain) | ✅ Built | `itemVisual('workspace')` + Fluent `Badge` footer row |
| Item-count aggregation | ✅ Built | `GET /api/workspaces?count=true` → Cosmos GROUP BY `workspaceId` |
| Admin multi-select + bulk delete (owned/test/all) | ✅ Built | `GET /api/workspaces/bulk-delete` probe + `bulkDeleteWorkspaces()`; select-mode renders tile checkboxes + a leading list column + select-all bulk bar |
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
