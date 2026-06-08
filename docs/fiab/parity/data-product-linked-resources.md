# data-product-linked-resources — parity with Microsoft Purview Data Product "Linked resources"

Source UI: Microsoft Purview Unified Catalog → Data product → **Glossary terms**,
**OKRs**, and **Critical data elements** linked-resource sections.
- https://learn.microsoft.com/purview/concept-data-products
- https://learn.microsoft.com/purview/how-to-create-data-products
- https://learn.microsoft.com/purview/concept-critical-data-elements
- https://learn.microsoft.com/purview/concept-okr

CSA Loom surface: `data-product` editor → **Linked resources** tab
(`apps/fiab-console/lib/editors/components/linked-resources.tsx`).

This is the Azure-native default path. It works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
UNSET and requires no real Fabric/Power BI workspace. Glossary terms + CDEs come
from the **classic Purview Data Map** (`{account}.purview.azure.com` /
`.purview.azure.us` in Gov). OKRs are Loom-native Cosmos state (the unified-catalog
`/datagovernance` OKR plane only exists on a new unified-catalog account; OKRs are
modeled in the `okrs` Cosmos container instead, 1:1 on capability).

## Purview feature inventory

| # | Capability (real Purview UI) | Notes |
|---|------------------------------|-------|
| 1 | Browse the business glossary by glossary/domain | Multiple glossaries per account |
| 2 | Keyword-search glossary terms | Filter the term list as you type |
| 3 | Multi-select terms and attach to a data product | Bulk "Add" |
| 4 | View terms already linked to the data product | List with term name |
| 5 | Remove a linked term (per-row overflow menu) | Detach from the product |
| 6 | Add an OKR (objective + key result metric/target/status) | Objective + KR |
| 7 | View OKRs linked to the data product | Status indicator per OKR |
| 8 | Remove an OKR (per-row overflow menu) | |
| 9 | View Critical Data Elements derived from mapped assets | Read-only; sourced from asset classifications |
| 10 | CDEs update automatically as assets are mapped | No manual entry |

## Loom coverage

| # | Coverage | Backend |
|---|----------|---------|
| 1 | ✅ Glossary (domain) Dropdown | `GET /api/admin/security/purview/glossary?list=glossaries` → `listGlossaries()` → `GET /datamap/api/atlas/v2/glossary` |
| 2 | ✅ Keyword Input + Search | `GET /api/admin/security/purview/glossary?glossaryGuid&keyword` → `searchGlossaryTermsByKeyword()` |
| 3 | ✅ Checkbox multi-select + "Add N selected" | `POST /api/data-products/[id]/glossary-terms` (per term) |
| 4 | ✅ "Linked terms" table | `GET /api/data-products/[id]/glossary-terms` (from `state.glossaryLinks[]`) |
| 5 | ✅ ⋯ overflow → Remove | `DELETE /api/data-products/[id]/glossary-terms?termGuid` |
| 6 | ✅ Add OKR form (objective/metric/target/current/status enum) | `POST /api/data-products/[id]/okrs` → Cosmos `okrs` |
| 7 | ✅ OKR table with status Badge | `GET /api/data-products/[id]/okrs` |
| 8 | ✅ ⋯ overflow → Remove | `DELETE /api/data-products/[id]/okrs?okrId` |
| 9 | ✅ CDE read-only table | `GET /api/data-products/[id]/cdes` → `getAssetCdeClassifications()` per mapped asset |
| 10 | ✅ Auto-derived + Refresh; re-derives when Datasets tab maps an asset | `getAssetDetail()` `entity.classifications[]` filtered to `CDE.*` |

Honest gates (⚠️, full surface still renders):
- Glossary search + glossary list when `LOOM_PURVIEW_ACCOUNT` is unset → warning
  MessageBar naming the env var; already-linked terms remain manageable.
- CDE section when `LOOM_PURVIEW_ACCOUNT` is unset → info MessageBar (route returns
  `{ ok:true, cdes:[], gated:true }`, never a 5xx).

Zero ❌, zero stub banners.

## Backend per control

- **Glossary terms link** persists to `items` container `state.glossaryLinks[]`
  (Cosmos, via `updateOwnedItem`) AND, when the product is registered with Purview,
  best-effort `applyGlossaryTerm(termGuid, purviewDataProductId)` →
  `POST /datamap/api/atlas/v2/glossary/terms/{guid}/assignedEntities`.
- **OKRs** → Cosmos `okrs` container (PK `/dataProductId`), created at Console
  startup via `cosmos-client.ts` `ensure()` `createIfNotExists` (same pattern as
  every other Console runtime container — no separate bicep step required).
- **CDEs** → classic Data Map `GET /datamap/api/atlas/v2/entity/guid/{guid}`,
  `entity.classifications[]` filtered to typeNames starting with `CDE.`.

## Per-cloud

| Cloud | Glossary/CDEs (Purview) | OKRs (Cosmos) |
|-------|-------------------------|---------------|
| Commercial | `{account}.purview.azure.com` ✅ | ✅ |
| GCC | AzureCloud endpoints (= Commercial) ✅ | ✅ |
| GCC-High / Gov | `{account}.purview.azure.us` ✅ (host now `isGovCloud()`-aware in `purviewBase()`) | ✅ |
| IL5 | Purview unavailable → honest gate MessageBar | ✅ |
