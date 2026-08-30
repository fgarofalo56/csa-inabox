# usage-adoption — parity with Fabric Admin Feature usage and adoption

Source UI: Fabric Admin portal → **Usage metrics / Feature usage and adoption**
Reference: <https://learn.microsoft.com/fabric/admin/feature-usage-adoption>

| | |
|---|---|
| Original run date | 2026-06-09 (rev.5 cohort) |
| Re-verified | 2026-08-29 — **code + test only, NOT a live browser walk** (#3738) |

> **How this revision was produced, stated plainly.** The 2026-06-09 revision
> documented six capabilities and graded the page **A** with "zero ❌ rows, zero
> ⚠️ gates". Measured on 2026-08-29 the page is 751 lines
> (`app/admin/usage/page.tsx`) and ships five sections the doc never mentioned —
> a WINDOW selector, a FEATURE drill-through, Active users, Feature adoption and
> Open analytics — three of which are honest-gated, which by itself falsifies
> "zero ⚠️ gates". The inventory and coverage tables below were rebuilt from the
> current page and route.
>
> **This re-verification was NOT a live browser walk.** `ui-parity.md` and
> `ux-baseline.md` G1 require one before an A grade is claimed, and none was
> performed for this revision — no estate session was available to the author.
> The grade below reflects that, and the "Verification" section names exactly
> what is still owed.

Loom surfaces:

- Page: `/admin/usage` → `app/admin/usage/page.tsx`
- BFF: `app/api/admin/usage/route.ts`
- Embed BFF: `app/api/admin/usage/embed/route.ts`
- Log Analytics client: `lib/clients/usage-client.ts`

The Cosmos half is **Loom-native**: computed from the deployment's own Cosmos
`workspaces` + `items` + `audit-log` containers. There is **no dependency on real
Microsoft Fabric** — the surface renders with `LOOM_DEFAULT_FABRIC_WORKSPACE`
unset. The Log Analytics half is an Azure-native telemetry read, honest-gated on
`LOOM_LOG_ANALYTICS_WORKSPACE_ID`; when it is unset the Cosmos sections render
in full and the LA sections say exactly which env var is missing.

## Fabric/Azure feature inventory (grounded in Learn)

1. Tenant-wide usage KPIs (workspaces, items, active users)
2. Items by type
3. Items by workspace
4. Activity over time
5. Most-active items
6. Drill into an item
7. Reporting-window selection
8. Per-feature (capability) usage breakdown
9. Active-user trend over the window
10. Open the underlying usage dataset/report in an analytics tool

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Total workspaces / items / item-types / audit-events KPI cards | ✅ Built | `GET /api/admin/usage` → Cosmos `workspaces` + `items` + `audit-log` aggregates |
| Items-by-type bar chart | ✅ Built | `GROUP BY itemType` over the Cosmos `items` read |
| Items-by-workspace bar chart | ✅ Built | Cosmos `workspaces` ⋈ `items` |
| Daily-activity sparkline | ✅ Built | `audit-log` grouped by date over the selected window |
| Most-active-items table (sort / resize / filter) | ✅ Built | `LoomDataTable` over `topItems` from the API |
| Per-item deep-link | ✅ Built | `/items/<itemType>/<itemId>` link, rendered only when the row resolves to a catalog item |
| **WINDOW selector (7 / 14 / 30 d)** | ✅ Built | `?days=N`, clamped 1–90 in the route; drives BOTH backends |
| **FEATURE drill-through dropdown** | ✅ Built | `?feature=X`; narrows Feature adoption and restricts the most-active-items table to that feature's traffic |
| **Active users (daily-active-user trend)** | ⚠️ Honest gate | `fetchActiveUsersTrend` → Log Analytics `AppRequests`; gated on `LOOM_LOG_ANALYTICS_WORKSPACE_ID` with the exact var named inline |
| **Feature adoption (events + distinct users per route prefix)** | ⚠️ Honest gate | `fetchFeatureAdoption` → Log Analytics; same gate; bars are click-to-drill |
| **Most-active items enriched with LA request events** | ⚠️ Honest gate (degrades) | `fetchTopItemsFromLa` merged with the Cosmos audit counts; with LA unset the column is empty and the ranking is audit-only |
| **Open analytics (Power BI Embedded / Azure Managed Grafana)** | ⚠️ Honest gate | `GET /api/admin/usage/embed`; env-gated. Grafana is a LAUNCH, not an inline iframe — Managed Grafana sets `frame-ancestors` that block framing, and the page says so rather than rendering a broken frame |

Zero ❌ rows. **Three ⚠️ honest gates**, all on the same
`LOOM_LOG_ANALYTICS_WORKSPACE_ID` value plus the optional embed env — the
2026-06-09 claim of "zero ⚠️ gates" did not hold, and is corrected here.

## Known issues against this surface

| Issue | State |
|---|---|
| #3737 — Most-active-items rendered `—` for Type / Workspace on all 25 rows, because Unity Catalog governance audit rows (`unity:schema.list:…`, `unity:auth.token-exchange:…`), platform slugs (`loom`, `sql-lab`) and raw target GUIDs outranked every real item and none of them joins to a catalog item | Fixed in the route: the ranking is now restricted to ids that resolve to a catalog item, and the volume set aside is reported as `topItemsNonCatalog`. **Merged, not deployed** — no live re-verification yet. |
| #2792 — audit-log counters read the wrong partition and the wrong tenant scope | Fixed 2026-08-01, after the 2026-06-09 grade. That fix touched this exact route and should have invalidated the grade at the time; it did not. |

## Backend per control

- **KPIs** — `GET /api/admin/usage` counts `workspaces` and `items`, takes a
  distinct count of `itemType`, and counts `audit-log` rows inside the window.
- **Charts** — items-by-type is a `GROUP BY itemType` over the Cosmos items
  read; items-by-workspace joins `workspaces` + `items`; the activity sparkline
  groups `audit-log` rows by day over the selected window.
- **Most-active items** — Cosmos audit counts ⊕ Log Analytics request events,
  merged by item id, restricted to ids present in the Cosmos `items` catalog,
  ranked by `requestEvents + auditCount`, top 25, rendered in a
  sortable / resizable / filterable `LoomDataTable`.
- **Active users / Feature adoption** — `lib/clients/usage-client.ts` KQL against
  the Log Analytics workspace; both are awaited through `Promise.allSettled`, so
  an LA failure never blocks the Cosmos sections and is reported as `laError`.
- **Open analytics** — `GET /api/admin/usage/embed` resolves a Power BI Embedded
  report token (Commercial) or the Managed Grafana dashboard URL (Gov).
- **Caching** — the whole rollup goes through `getOrComputeCached` with a 5-minute
  SWR window (`LOOM_QUERY_CACHE_TTL_MS_USAGEROLLUP`); `?refresh=1` bypasses it.

## Per-cloud notes

| Cloud | Behaviour |
|---|---|
| Commercial | Cosmos sections identical everywhere. LA sections live when `LOOM_LOG_ANALYTICS_WORKSPACE_ID` is set. Open analytics resolves Power BI Embedded. |
| GCC / GCC-High / IL5 | Cosmos sections identical — cloud-agnostic. LA sections identical (Azure Monitor is GA in these boundaries). Open analytics resolves **Azure Managed Grafana** instead of Power BI, which is why the embed route is a launch rather than an iframe. |

**Untested boundary, named as untested:** neither this revision nor the
2026-06-09 one carries a Gov receipt for this page. Per `cloud-parity.md` the Gov
behaviour above is read from the code path, not observed.

## Bicep sync

- No new resource — the Cosmos half aggregates over existing `workspaces` /
  `items` / `audit-log` containers.
- `LOOM_LOG_ANALYTICS_WORKSPACE_ID` is wired by
  `modules/admin-plane/main.bicep` (`apps[]` env) and is the only value the LA
  sections need; the Console UAMI additionally needs Log Analytics Reader.
- The Open-analytics embed envs are optional and cost-material.

## Verification

Done for this revision:

- Code + route re-read against the live page (751 lines, 2026-08-29).
- `#3737` fix proven by a mutation test on the route: with the catalog filter
  removed the top row is `unity:schema.list:2026-08-01` with no `itemType`,
  reproducing the reported defect; with it in place every returned row carries
  `itemType` and `workspaceName`.

**Still owed before this page can be graded A again** (`ux-baseline.md` G1):

- A live in-browser walk on a tenant with real audit traffic: change the WINDOW,
  click a Feature-adoption bar to drill, confirm the most-active-items rows
  resolve Type + Workspace, and open an item from the table.
- The same walk with `LOOM_LOG_ANALYTICS_WORKSPACE_ID` UNSET, confirming the
  three gates render with their env var named and the Cosmos sections still work.
- A Gov receipt (Actions-run based, never local `az`).

Grade: **B — pending live re-verification.** The surface is production-grade and
entirely real-backend, but it carries three honest gates (so it was never "zero
gates"), a defect against it was open until this revision, and the G1 browser
receipt for the current code has not been produced. Restore **A** when the walk
above is attached.
