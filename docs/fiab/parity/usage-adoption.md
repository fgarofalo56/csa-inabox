# usage-adoption — parity with Fabric Admin Feature usage and adoption

Source UI: Fabric Admin portal → **Usage metrics / Feature usage and adoption**
Reference: <https://learn.microsoft.com/fabric/admin/feature-usage-adoption>
Run date: 2026-06-09

Loom surfaces:

- Page: `/admin/usage` → `app/admin/usage/page.tsx`
- BFF: `app/api/admin/usage/route.ts`

Usage metrics are **Loom-native**: computed from the deployment's own Cosmos
`workspaces` + `items` + `audit-log` containers. There is **no dependency on real
Microsoft Fabric** — the surface renders with `LOOM_DEFAULT_FABRIC_WORKSPACE`
unset.

## Fabric/Azure feature inventory (grounded in Learn)

1. Tenant-wide usage KPIs (workspaces, items, active users)
2. Items by type
3. Items by workspace
4. Activity over time
5. Most-active items
6. Drill into an item

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Total workspaces / items / item-types / 30-day audit-events KPI cards | ✅ Built | `GET /api/admin/usage` → Cosmos `workspaces` + `items` + `audit-log` aggregates |
| Items-by-type bar chart | ✅ Built | `GROUP BY itemType` in Cosmos |
| Items-by-workspace bar chart | ✅ Built | JOIN `workspaces` + `items` |
| 30-day daily-activity sparkline | ✅ Built | `audit-log` `GROUP BY` date |
| Top-10 most-active items table (sort/resize/filter) | ✅ Built | `LoomDataTable` over `topItems` from the API |
| Per-item deep-link | ✅ Built | `Open16Regular` link |

Zero ❌ rows, zero ⚠️ gates — entirely Cosmos-backed Loom-native aggregates.

## Backend per control

- **KPIs** — `GET /api/admin/usage` runs count aggregates over `workspaces` and
  `items`, a distinct count of `itemType`, and a 30-day count over `audit-log`.
- **Charts** — items-by-type is a `GROUP BY itemType`; items-by-workspace joins
  `workspaces` + `items`; the activity sparkline groups `audit-log` rows by day
  over the trailing 30 days.
- **Top items** — most-active items ranked by activity, rendered in a
  sortable/resizable/filterable `LoomDataTable` with per-item deep-links.

## Per-cloud notes

| Cloud | Behaviour |
|---|---|
| Commercial / GCC / GCC-High / IL5 | Identical — Cosmos-backed, cloud-agnostic. |

## Bicep sync

- No new resource — aggregates over existing `workspaces` / `items` / `audit-log`
  containers.
- No new env var or role grant.

## Verification

- Default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- Live walk: create a few items and perform some admin actions to populate
  `audit-log`, open `/admin/usage`, confirm the KPI cards, items-by-type and
  items-by-workspace charts, the 30-day sparkline, and the top-10 table all
  reflect the real Cosmos data, and the per-item deep-link opens the item.

Grade: **A** — full usage dashboard on real Cosmos aggregates; zero gates.
