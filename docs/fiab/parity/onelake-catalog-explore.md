# onelake-catalog-explore — parity with the Microsoft Fabric OneLake catalog **Explore** tab

Source UI: https://learn.microsoft.com/fabric/governance/onelake-catalog-explore
Loom surface: `apps/fiab-console/app/onelake/page.tsx` (page-level **Explore** pivot) →
`apps/fiab-console/lib/panes/onelake-catalog.tsx`
Backend: `apps/fiab-console/app/api/onelake/catalog/route.ts`

The OneLake catalog in Fabric has two pivots — **Explore** (find / browse / open data
items across the tenant, this surface) and **Govern** (data-estate posture, see
`onelake-catalog-govern.md`). The Explore tab answers "what data exists and where, and
let me open it" with a domain selector, a workspace tree, a searchable item list, real
facet counts, and per-item ownership / endorsement / sensitivity. Loom builds this 1:1
against **Azure-native** backends — Azure AI Search (default, when deployed) or a Cosmos
fallback — with no Microsoft Fabric, Power BI, or OneLake-on-Fabric dependency. The list
renders with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.

## Fabric feature inventory (grounded in Learn)

| # | Fabric Explore-tab capability | Notes |
|---|-------------------------------|-------|
| 1 | **Domain selector** — scope the catalog to a governance domain | "All domains" + each domain |
| 2 | **Workspace tree** — browse items grouped by the workspaces the user can see | Sidebar tree, click to filter |
| 3 | **Workspace ownership** — the tree shows who owns / administers each workspace | |
| 4 | **Item list** — every data item (lakehouse, warehouse, KQL DB, …) the user can discover | |
| 5 | **Full-text search** — search items by name | |
| 6 | **Facets / filters** — refine by item type, endorsement, sensitivity, domain, with live counts | |
| 7 | **Per-item metadata** — owner, last-updated, endorsement (Certified/Promoted), sensitivity label | |
| 8 | **Open item** — click an item to open its editor / details | |
| 9 | **Tile + list views** — switch between a card grid and a sortable table | |
| 10 | **Discoverability** — only items the user is allowed to discover appear | |

## Loom coverage

| # | Capability | Status | Where |
|---|------------|--------|-------|
| 1 | Domain selector ("(All)" + live domains) | built ✅ | pane `Dropdown`; route `getDomainsStore().listDomains(oid)` |
| 2 | Workspace tree (live tenant workspaces) | built ✅ | pane `Tree`/`TreeItem`; route `workspacesContainer` (PK `/tenantId`) |
| 3 | Workspace ownership in the tree | built ✅ | route projects `c.createdBy` → `workspaces[].owner`; pane renders it in the `TreeItemLayout` `aside` slot |
| 4 | Item list | built ✅ | `LoomDataTable` ← route `items[]` |
| 5 | Full-text search | built ✅ (honest-gate ⚠️ on Cosmos fallback) | AI Search `searchGovernanceCatalog`; Cosmos fallback does substring filter + names `LOOM_AI_SEARCH_SERVICE` |
| 6 | Facets / filters with counts | built ✅ | AI Search real facets; Cosmos `buildCosmosLocalFacets()` |
| 7 | Per-item owner / updated / endorsement / sensitivity | built ✅ | `shapeSearchHit` / `shapeCosmosItem` |
| 8 | Open item | built ✅ | `router.push('/items/{itemType}/{id}')` |
| 9 | Tile + List view toggle | built ✅ | `ViewToggle` → `TileGrid` / `LoomDataTable` |
| 10 | Discoverability scoping | built ✅ | AI Search `callerWorkspaceIds` filter; Cosmos query scoped to the caller's workspace ids |

Zero ❌, zero stub banners. The only non-functional state is the honest AI-Search
infra-gate (`searchGate`), and even then the full workspace tree, domain selector, item
list (from Cosmos), and local facet counts still render.

## Backend per control

| Control | Backend |
|---------|---------|
| Domain selector | Cosmos `governance-domains` via `getDomainsStore().listDomains(oid)` |
| Workspace tree + owner | Cosmos `workspacesContainer` — single-partition read `WHERE c.tenantId = @t` with `partitionKey: oid`, projecting `c.id, c.name, c.domain, c.createdBy` |
| Item list (default) | Azure AI Search `loom-governance-items` index — `searchGovernanceCatalog()` |
| Item list (fallback) | Cosmos `itemsContainer` — **partition-scoped fan-out**: one single-partition read per workspace id (`WHERE c.workspaceId = @ws` + `partitionKey: wsId`) in `Promise.all`, NOT a cross-partition `ARRAY_CONTAINS` scan |
| Facets | AI Search facet buckets, or `buildCosmosLocalFacets()` over the Cosmos slice |
| Open item | `/items/{itemType}/{id}` |
| Fabric (opt-in only) | `listOneLakeWorkspaces()` + `listAllOneLakeItems()` behind `LOOM_CATALOG_BACKEND=fabric` + `assertFabricFamilyAvailable('fabric')` |

### Performance note — partition-safe item read

The Cosmos `items` container is partitioned by `/workspaceId`. The Explore fallback path
issues **N parallel single-partition reads** (one per workspace the caller can see) rather
than a single cross-partition `ARRAY_CONTAINS(@ws, c.workspaceId)` scan, so RU cost stays
flat as the tenant's workspace / item count grows. Per-workspace read failures are isolated
(a workspace the UAMI cannot enumerate never aborts the whole catalog).

## No-Fabric verification

`GET /api/onelake/catalog` with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET and
`LOOM_CATALOG_BACKEND` unset (or `azure`) returns the Cosmos workspace tree (with owners),
the live domain list, and the item list — from AI Search when `LOOM_AI_SEARCH_SERVICE` is
set, else from the Cosmos fallback with a `searchGate` hint. No `api.fabric.microsoft.com`
/ `api.powerbi.com` / `onelake.dfs.fabric` host is reached on the default path. Covered by
`app/api/onelake/__tests__/catalog.test.ts` (6/6), including the workspace-owner projection
and the no-duplicate guarantee of the per-workspace fan-out.

## Bicep

No new infra. `LOOM_AI_SEARCH_SERVICE`, `LOOM_CATALOG_BACKEND`, `LOOM_COSMOS_ENDPOINT`, and
`LOOM_COSMOS_DATABASE` are already wired from
`platform/fiab/bicep/modules/admin-plane/ai-search.bicep` (output `searchName`) and
`admin-plane/main.bicep` apps[] env list. The route reads only — the existing Console UAMI
**Cosmos DB Built-in Data Contributor** (account scope) + **Search Index Data Reader** (on
the AI Search service) grants are sufficient.
