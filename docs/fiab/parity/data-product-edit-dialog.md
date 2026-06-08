# data-product-edit-dialog — parity with Microsoft Purview "Edit data product" (Data Marketplace F4, F7)

Source UI:
- Purview Unified Catalog — data products: https://learn.microsoft.com/purview/unified-catalog-data-products
- Edit a data product: https://learn.microsoft.com/purview/how-to-data-product-edit
- Endorse a data product: https://learn.microsoft.com/purview/unified-catalog-data-products#endorsement

The Purview "Edit data product" experience is a 3-step modal that mirrors the
Create wizard — **Basic**, **Business**, and **Custom attributes** — where each
step has its own Save that persists only that step's fields. The Basic step
carries the **Endorsed** checkbox (F7), and the name field shows a non-blocking
duplicate-name warning that never prevents saving.

## Source feature inventory

| # | Capability | Source behaviour |
|---|------------|------------------|
| 1 | 3-step modal (Basic / Business / Custom attributes) | mirrors the Create wizard; step nav without forcing a save |
| 2 | Per-step Save | each step's Save persists ONLY that step's fields |
| 3 | Basic › Name | free text; **non-blocking** duplicate-name warning |
| 4 | Basic › Description | ≤10,000-char rich text |
| 5 | Basic › Type | 12-value enum Select |
| 6 | Basic › Audience | multi-select (8 enum values) |
| 7 | Basic › Owners | people picker (free-text emails in Loom T4; Graph picker in T17) |
| 8 | Basic › **Endorsed** checkbox (F7) | sets the `endorsed` flag; Endorsed badge on the detail header |
| 9 | Business › Governance domain | domain picker |
| 10 | Business › Use case | free text |
| 11 | Custom attributes | dynamic typed form from the domain's attribute groups |
| 12 | Optimistic concurrency | a stale edit cannot clobber a concurrent write |

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | 3-step modal | built ✅ | `DataProductEditDialog` — Fluent v9 `Dialog`; clickable step `Badge`s + Back/Next, no forced save |
| 2 | Per-step Save | built ✅ | `saveStep(which)` → `pickStepFields(which, state)` builds a body with ONLY that step's keys; one PATCH per step |
| 3 | Non-blocking duplicate-name warning | built ✅ | 500 ms debounce → `GET /api/data-products?name=&excludeId=`; warning `MessageBar` rendered, Save never disabled by it |
| 4 | Description | built ✅ | `Textarea` `maxLength={10000}` |
| 5 | Type | built ✅ | `Select` over `DATA_PRODUCT_TYPES` (12 values) |
| 6 | Audience | built ✅ | multiselect `Dropdown` over `DATA_PRODUCT_AUDIENCES` (8 values) |
| 7 | Owners | built ✅ | comma-separated emails (Entra Graph people picker deferred to T17) |
| 8 | **Endorsed checkbox (F7)** | built ✅ | `Checkbox` → `endorsed`; inline Endorsed `Badge` preview; `onSaved` mirrors the flag to the `DataProductEditor` header badge |
| 9 | Governance domain | built ✅ | `Dropdown` populated from real `GET /api/admin/domains` |
| 10 | Use case | built ✅ | `Textarea` |
| 11 | Custom attributes | honest-gate ⚠️ | typed form when `customAttributes` exist; otherwise an `intent="info"` MessageBar pointing to Admin › Attribute Groups (attribute-group admin = T15) |
| 12 | Optimistic concurrency | built ✅ | ETag read on open → `If-Match` on every PATCH → Cosmos 412 → HTTP 409 → "Document changed elsewhere" MessageBar |

Zero ❌. No stub banners (row 11 is an honest infra-gate per `no-vaporware.md`).

## Backend per control

| Control | Backend |
|---------|---------|
| Load on open | `GET /api/data-products/[id]` → `CosmosDataProductStore.get` (cross-partition point read); ETag returned as the `ETag` response header |
| Per-step Save | `PATCH /api/data-products/[id]` (`If-Match: <etag>`) → `CosmosDataProductStore.patch` → Cosmos `item().replace()` with `accessCondition { type:'IfMatch', condition }` |
| Duplicate-name check | `GET /api/data-products?name=&excludeId=` → `CosmosDataProductStore.findByName` (case-insensitive, excludes self) |
| Governance-domain picker | `GET /api/admin/domains` → Cosmos `tenant-settings` domains doc |

## Azure-native default (no Fabric dependency)

All paths use the Azure Cosmos DB `dataproducts` container (PK
`/governanceDomainId`), created lazily in `cosmos-client.ts` `ensure()` via
`createIfNotExists`. No `fabricWorkspaceId`, no `api.fabric.microsoft.com` /
`api.powerbi.com`, no Purview Unified Catalog call on the default path. The
Purview Unified Catalog backend is reserved as a future opt-in
(`LOOM_DATAPRODUCTS_BACKEND=purview-unified`, commercial only) and is never a
gate. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset in every cloud
(Commercial / GCC / GCC-High / IL5). No new Azure resource, env var, role
assignment, or bicep change — the container is code-owned like every other
Loom container.

## Optimistic concurrency (Cosmos OCC)

Grounded in the Cosmos OCC docs (`RequestOptions.accessCondition`): Cosmos
stamps a server-generated `_etag` on every write. The dialog reads it on open
and sends it as `If-Match` on each PATCH; a concurrent write changes the
`_etag`, so the stale PATCH gets HTTP 412, which `CosmosDataProductStore.patch`
maps to `ETagConflictError` and the route returns HTTP 409 — the lost update is
blocked, not silently applied.

## Verification

- `lib/dataproducts/__tests__/store.test.ts` — pure-logic tests: each step's
  PATCH body contains ONLY that step's keys (Basic has no `useCase` /
  `governanceDomainId` / `customAttributes`); `mergeDataProductPatch` preserves
  unchanged Business fields when saving Basic; identity/system fields are never
  overwritten; `updatedAt` bumps; endorsed toggles persist. (Validated via
  Node native type-strip in the isolated worktree; runs under vitest in CI.)
- Manual E2E (per `no-vaporware.md`): seed a `dataproducts` doc, open the editor
  → Edit → change name (warning fires after 500 ms) → Save Basic → PATCH body =
  `{name,description,type,audience,owners,endorsed}` only; switch to Business →
  Save → PATCH body = `{governanceDomainId,useCase}` only; toggle Endorsed →
  Save Basic → `{...,endorsed:true}` → Endorsed badge on the header; concurrent
  edit in a second tab → next Save → HTTP 409 conflict banner.
