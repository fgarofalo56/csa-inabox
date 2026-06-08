# data-product-attributes — parity with Microsoft Purview Unified Catalog data-product details (right rail)

Source UI: https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage
REST: `PUT {endpoint}/datagovernance/catalog/dataProducts/{dataProductId}?api-version=2026-03-20-preview`

Scope of this surface: the three inline, right-side attribute panels on the
data-product details page — **Update frequency (F5)**, **Terms of use (F11)**,
and **Documentation (F12)**. Built into `DataProductEditor`
(`lib/editors/apim-editors.tsx`) as the `rightPanel` of `ItemEditorChrome`.

## Azure/Fabric feature inventory (grounded in Learn)

| # | Capability in the Purview portal | REST field |
|---|---|---|
| 1 | "Update frequency" attribute, edited inline via a single-select. Portal labels: Daily / Weekly / Monthly / Quarterly / Annually / Ad hoc / Real-time. ("This indicator isn't currently automated.") | `updateFrequency` (`UpdateFrequencyEnum`: Hourly/Daily/Weekly/Monthly/Quarterly/Yearly — "Annually"→`Yearly`; "Ad hoc"/"Real-time" are portal display labels) |
| 2 | Edit opens an inline panel (no modal); selecting a value + Done applies it | — |
| 3 | "Terms of use" attribute — inline list of links with an **Add link** form | `termsOfUse: CatalogModelExternalLink[]` |
| 4 | Add-link form fields: friendly name, URL, and an optional **data asset scope** | `{ name, url, dataAssetId? }` |
| 5 | Each list entry has a trash/remove affordance (hover) | array delete |
| 6 | "Documentation" attribute — identical inline list + Add-link form + remove | `documentation: CatalogModelExternalLink[]` |
| 7 | Each mutation persists to the catalog (PUT) | full-replace PUT |

## Loom coverage

| # | Status | Notes |
|---|--------|-------|
| 1 | ✅ built | `SelectAttributePanel` renders all 7 labels (`UPDATE_FREQUENCIES`). |
| 2 | ✅ built | Inline edit with Done/Cancel; **dirty-check on close** — no PATCH when the value is unchanged. |
| 3 | ✅ built | `LinkListAttributePanel` (title "Terms of use"). |
| 4 | ✅ built | Form: friendly name (`label`), URL (validated via `new URL`), optional asset scope (`assetId`). |
| 5 | ✅ built | Trash button per row → `onRemove(index)` → PATCH of the trimmed array. |
| 6 | ✅ built | Second `LinkListAttributePanel` (title "Documentation"), same component. |
| 7 | ✅ built | Each mutation PATCHes; the panel shows a receipt (request body + response). |

Zero ❌, zero stub banners. The Loom internal model is `{ label, url, assetId? }`
and maps to Purview `{ name, url, dataAssetId? }`; "Annually" maps to the REST
`Yearly` member. These translations happen in the (opt-in) T18 Unified Catalog
adapter, not on the Azure-native default path.

## Backend per control

| Control | Backend |
|---|---|
| Update frequency select → Done | `PATCH /api/data-products/[id]` body `{ updateFrequency }` only — server merges into Cosmos `items.state` (partial merge, no clobber). |
| Terms of use Add / remove | `PATCH /api/data-products/[id]` body `{ termsOfUse: ExternalLink[] }` only. |
| Documentation Add / remove | `PATCH /api/data-products/[id]` body `{ documentation: ExternalLink[] }` only. |
| Reload | `GET /api/cosmos-items/data-product/[id]` (existing) projects `state` back into the editor, so saved attributes survive reload. |

## Azure-native default (no Fabric / Power BI dependency)

All three attributes persist to the Cosmos `items` container `state` blob — the
default path works with `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset** and no Purview
account. The Purview Unified Catalog REST (`PUT …/dataProducts/{id}`) is an
opt-in alternative the T18 adapter targets when `LOOM_DATAPRODUCTS_BACKEND`
selects it; it is never required for the panels to function. Per
`.claude/rules/no-fabric-dependency.md`.

## Bicep / bootstrap sync

No new Azure resource, env var, role assignment, or Cosmos container — the
attributes are new keys inside the existing `data-product` item's `state`,
stored in the already-provisioned `items` container. Nothing to add to
`platform/fiab/bicep/**` for this surface.

## Verification

- Unit: `lib/dataproducts/__tests__/attributes.test.ts` (8 tests) covers the
  frequency enum + external-link sanitiser (the validators guarding the Cosmos
  doc and the PATCH route).
- Functional: select a frequency → `PATCH {updateFrequency}` → reload shows it;
  add a terms-of-use link with asset scope → persists in the `state.termsOfUse`
  array (confirm via `GET /api/data-products/[id]`); trash removes it from the
  next GET. Each PATCH body + response is shown in the panel receipt.
