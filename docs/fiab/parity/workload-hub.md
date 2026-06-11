# workload-hub — parity with the Microsoft Fabric Workload hub

Source UI: https://learn.microsoft.com/fabric/fundamentals/fabric-home (Workload
hub), https://learn.microsoft.com/fabric/workload-development-kit/more-workloads-add,
https://learn.microsoft.com/fabric/fundamentals/fabric-terminology (workload list).

The Fabric Workload hub presents **workloads** (categories) with **My workloads**
/ **More workloads** tabs. Opening a workload shows its landing page listing
*"the item types the workload can create"*; selecting an item type creates it in
a workspace. Loom mirrors this **navigation + taxonomy** exactly, but resolves
each item type to an **Azure-native backend** via its per-slug editor/provisioner
(`lib/editors/registry`, `lib/install/provisioners/*`) — so create-by-workload
works with **no Fabric capacity bound** (`LOOM_DEFAULT_FABRIC_WORKSPACE` unset).

## Fabric feature inventory → Loom coverage

| Fabric capability | Loom coverage | Backend |
|---|---|---|
| Workload hub with My / More workloads tabs | ✅ `/workload-hub` — "My workloads" (core) + "More workloads" (optional accelerators) sections | Registry `lib/catalog/workload-hub.ts` + tenant overlay from `/api/workloads-catalog` (Cosmos) |
| Each workload shows a count of item types it can create | ✅ Tile meta "N item types you can create" + tooltip; **count derived from the real catalog** (`creatableItemTypes(group).length`), never hand-authored | `lib/catalog/fabric-item-types.ts` (~110 types) grouped by `WorkloadCategory` |
| Workload tile icon / brand | ✅ `itemVisual(representativeSlug)` — family-colored Fluent glyph from the shared visual registry | `lib/components/ui/item-type-visual.ts` |
| Opening a workload → landing page listing its item types | ✅ `/workload-hub/[workload]` — `TileGrid` of `ItemTile` per creatable type (icon + name + one-line description + "what it does") | `creatableItemTypes(group)` |
| Selecting an item type → create it | ✅ Tile click / "Create new" → `/items/[slug]/new`, the real create wizard dispatched by `getEditor(slug)` → Azure-native provisioner | `lib/editors/registry.ts`, `app/items/[type]/[id]/page.tsx` |
| See existing items of a type | ✅ Tile kebab "View existing" → `/workload-hub/[workload]/[type]` → `ItemsByTypePane` (real store) + "+ New" CTA pre-scoped to the workload category | `app/api/items/by-type` (Cosmos × workspaces join) |
| Compatible-with / Publisher-support panels | ⚠️ Out of scope for Loom (no third-party workload marketplace); the legacy `/workloads` catalog page lists CSA accelerators with publisher = CSA | `/api/workloads-catalog` |
| Preview tagging on item types | ✅ `Preview` / `UI only` badges on landing-page tiles from catalog `preview` / `noRestApi` | catalog flags |

Result: every interactive surface routes to a real backend (create wizard or
the `/api/items/by-type` store). No dead-end "open the first feature" shortcut,
no hand-authored counts, no Fabric dependency.

## Workload taxonomy (registry-derived)

Every `WorkloadCategory` in the item-type catalog maps to exactly one workload
group (asserted by `lib/catalog/__tests__/workload-hub.test.ts`), so the union of
all groups covers the catalog with no orphaned types and no drift:

| Workload (My = core) | Categories rolled up |
|---|---|
| Data Engineering | Data Engineering, Synapse Analytics, Azure Databricks, Azure Data Lake Analytics |
| Data Factory | Data Factory, Azure Data Factory |
| Data Warehouse | Data Warehouse |
| Databases | Databases, Azure SQL Database |
| Real-Time Intelligence | Real-Time Intelligence, Streaming analytics |
| Data Science | Data Science, Azure AI Foundry |
| Fabric IQ | Fabric IQ |
| Power BI | Power BI |
| Power Platform | Power Platform |
| Copilot Studio | Copilot Studio |
| APIs and functions | APIs and functions |
| AI & Agents | AI & Agents |
| Fabric Apps | Fabric Apps |
| Geoanalytics (More) | Azure Geoanalytics |
| Graph + Vector (More) | Azure Graph + Vector |
| Industry Solutions & Data Products (More) | CSA Data Products |

## Backend per control

- **Counts + tiles**: `lib/catalog/workload-hub.ts` over `FABRIC_ITEM_TYPES` — static authoritative catalog, no runtime dependency.
- **My/More partition**: registry `tier` + real `/api/workloads-catalog` (Cosmos) overlay promoting any accelerator the tenant enabled.
- **Create**: `/items/[slug]/new` → `getEditor(slug)` → Azure-native provisioner per slug.
- **Existing items**: `ItemsByTypePane` → `GET /api/items/by-type?types=<slug>` (Cosmos items × workspaces join, tenant-scoped).

## Infra / bicep sync

No new Azure resource, env var, Cosmos container, or role assignment — this is a
navigator over the existing item-type registry, `/api/items/by-type`, and
`/api/workloads-catalog`. The bootstrap `WORKLOADS` seed is now presentation-only
(My/More grouping for the legacy `/workloads` page); the hub's counts come from
the registry. Nothing to add to bicep.

## Verification

- `npx vitest run lib/catalog/__tests__/workload-hub.test.ts` — 9 passing (category→workload coverage, no orphans, no deprecated leaks, GA-before-preview sort, seed matcher).
- `npx tsc --noEmit` — new files clean (pre-existing makeStyles/griffel backlog excluded).
- Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset: every create target is an Azure-native editor route.
