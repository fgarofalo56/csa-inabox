# data-product-assets (F9) — parity with Purview "Add / remove data assets"

Source UI: Purview Unified Catalog → Data product → **Data assets** → "Add data assets"
(https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage),
backed by the classic Data Map Discovery query
(https://learn.microsoft.com/rest/api/purview/datamapdataplane/discovery/query)
and entity read
(https://learn.microsoft.com/rest/api/purview/datamapdataplane/entity).

The Loom surface is the **Data assets** tab of `DataProductEditor`
(`lib/editors/apim-editors.tsx`) plus the `AddDataAssetsPanel` dialog
(`lib/editors/components/add-data-assets-panel.tsx`). No Microsoft Fabric /
Power BI dependency — the Data Map is a standalone Azure service, so this works
with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset (per `.claude/rules/no-fabric-dependency.md`).

## Purview feature inventory

| # | Capability | Purview surface |
|---|------------|-----------------|
| 1 | Open an "Add data assets" panel from the product | Data assets → Add data assets |
| 2 | Keyword search over the Data Map, scoped to the product's governance domain | search box |
| 3 | Type filter chips (Table / View / File) | asset-type facets |
| 4 | Paginate results | pager |
| 5 | Multi-select assets + Add | checkboxes + Add |
| 6 | Attached-asset list on the product detail page | Data assets grid |
| 7 | Per-asset Remove (ellipsis / context action) | row "…" → Remove |
| 8 | Remove blocked while data-quality rules run against the asset | guarded action + tooltip |
| 9 | Caution icon for an asset deleted from the Data Map; Remove still available | warning glyph + Remove |
| 10 | Asset count gates Publish (≥1 required) | publish validation |

## Loom coverage

| # | Status | Notes |
|---|--------|-------|
| 1 | built ✅ | "Add assets" button (tab + ribbon Govern group) opens `AddDataAssetsPanel`. |
| 2 | built ✅ | GET `/api/data-products/[id]/assets?search=1&q=` → `searchDataMapAssets()` with `filter.collectionId = domainCollectionName(state.domain)` (the classic mirror of the governance domain). |
| 3 | built ✅ | All / Table / View / File `ToggleButton` chips → `filter.entityType` via `ENTITY_TYPE_CHIPS` (real Atlas typeNames). |
| 4 | built ✅ | Previous / Next pager → `offset`/`limit` on the Discovery query; `hasMore` from a full page. |
| 5 | built ✅ | Per-row `Checkbox` + "Add N selected" → POST `/api/data-products/[id]/assets` (dedup by guid). Already-attached rows show an "attached" badge and are disabled. |
| 6 | built ✅ | Data assets tab grid: GET `/api/data-products/[id]/assets` → `state.dataAssets[]` enriched with `deleted` / `dqRunning` flags. |
| 7 | built ✅ | Row `Menu` (ellipsis) → Remove → DELETE `/api/data-products/[id]/assets?guid=`. |
| 8 | built ✅ | Server re-checks the `dq-rules:<tenantId>` doc and returns 409 `{ blocked:true }` if an enabled rule's scope covers the asset; the menu item is disabled with a tooltip naming the rule. |
| 9 | built ✅ | `getAssetDetail(guid)` → null (404) flags `deleted`; a `Warning20Filled` caution icon + tooltip renders and Remove stays enabled (DQ block is bypassed once the asset is gone). |
| 10 | built ✅ (foundation) | GET returns `count`; refs persist to `state.dataAssets`. The T6 publish guard reads `state.dataAssets.length` (guard route lands with T6). |

Honest gate ⚠️: when `LOOM_PURVIEW_ACCOUNT` is unset the search route returns
HTTP 501 with the structured `PurviewNotConfiguredHint`; the panel renders a
Fluent `MessageBar intent="warning"` naming the env var / bicep module / roles
to grant. The full panel surface still renders (per `.claude/rules/no-vaporware.md`).

## Backend per control

- Search → `searchDataMapAssets()` → `POST {account}.purview.azure.{com|us}/datamap/api/search/query?api-version=2023-09-01` with a structured `filter` (`collectionId` + `entityType`/`or`).
- Deleted detection → `getAssetDetail(guid)` → `GET …/datamap/api/atlas/v2/entity/guid/{guid}` (null on 404 = deleted).
- Attach / list / remove → Cosmos `items` container via `loadOwnedItem` / `updateOwnedItem`; refs in `state.dataAssets[]`.
- DQ-rule block → `tenantSettingsContainer()` doc `dq-rules:<tenantId>` (same store as `/api/admin/data-quality-rules`).
- RBAC → Console UAMI Data Map **Data Reader** on the root collection, granted post-deploy by `consolePurviewRoleGrant` in `platform/fiab/bicep/modules/admin-plane/catalog.bicep` via `scripts/csa-loom/grant-purview-datamap-role.sh`. No new env var, no bicep change.
