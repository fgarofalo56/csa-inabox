# data-product-create-wizard — parity with Microsoft Purview Unified Catalog "New data product"

Source UI:
- Create a single data product (portal walkthrough): https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage#create-a-single-data-product
- Data Products – Create (REST, 2026-03-20-preview): https://learn.microsoft.com/rest/api/purview/purview-unified-catalog/data-products/create
- Custom business-concept attributes: https://learn.microsoft.com/purview/unified-catalog-attributes-business-concept
- Governance domains: https://learn.microsoft.com/purview/unified-catalog-governance-domains

Loom surface: `/data-products/new` (`lib/data-products/data-product-create-wizard.tsx`),
receipt at `/data-products/[id]`, list at `/data-products`.

## Purview/Azure feature inventory (every capability)

The real "New data product" flow is a 3-page wizard ending in a **Draft** on the
data product's details page.

| # | Capability | Page |
|---|------------|------|
| 1 | **Name** (required, unique-warning) | Basic |
| 2 | **Description** — business narrative, **limited to 10,000 characters** | Basic |
| 3 | **Type** dropdown — `CatalogModelDataProductTypeEnum` (14 API values) | Basic |
| 4 | **Audience** dropdown (optional, multi) — `AudienceEnum` (8 values) | Basic |
| 5 | **Owner(s)** — directory people picker | Basic |
| 6 | **Governance domain** picker (the domain that owns the product) | Business |
| 7 | **Use case** (business use) textarea | Business |
| 8 | **Mark as Endorsed** checkbox | Business |
| 9 | **Custom attributes** — dynamic per-domain attribute groups, each attribute typed (Text / Single choice / Multiple choice / Date / Boolean / Integer / Double / Rich text); required attributes block completion | Custom attributes |
| 10 | **Create** → lands on the new product's **details page** in **Draft** state | — |
| 11 | Draft visibility note: invisible to others until assets + access policy + publish | Details |

## Loom coverage

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | Name | ✅ built | `Field` + `Input`, required to advance |
| 2 | Description + 10,000 char counter | ✅ built | Live counter; **blocks Next when > 10,000**; API also rejects (400) |
| 3 | Type (14 enum values) | ✅ built | `DATA_PRODUCT_TYPES` from real API enum; POSTs exact value |
| 4 | Audience (8 enum values, multi) | ✅ built | `DATA_PRODUCT_AUDIENCES`; multiselect `Dropdown` |
| 5 | Owners search-as-you-type | ✅ built | Debounced → `/api/admin/permissions/principals` (real Microsoft Graph); ≥1 required; oid carried into Purview `contacts.owner[].id` |
| 6 | Governance domain picker | ✅ built | `/api/governance-domains`: Purview UC business domains when configured, else Loom Cosmos domains (honest source banner) |
| 7 | Use case | ✅ built | `Textarea` → `state.useCase` / Purview `businessUse` |
| 8 | Endorsed | ✅ built | `Checkbox` → `state.endorsed` / Purview `endorsed` |
| 9 | Custom attributes dynamic form | ✅ built | `/api/attribute-groups` schema → typed inputs per `fieldType`; required block Create |
| 10 | Create → details page, Draft | ✅ built | POST `/api/data-products` → `router.push('/data-products/<id>')`; status DRAFT |
| 11 | Draft visibility note | ✅ built | Info MessageBar on details |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Create (all pages) | `POST /api/data-products` → `createOwnedItem('data-product', { state })` → real Cosmos `items` doc, `state.status='DRAFT'` |
| Purview registration (additive) | `POST {UC endpoint}/datagovernance/catalog/dataProducts` (audience `https://purview.azure.net/.default`); skipped with honest hint when UC endpoint unset or domain isn't a UC GUID |
| Owners search | `GET /api/admin/permissions/principals` → Microsoft Graph `/users` (UAMI app token) |
| Governance domains | `GET /api/governance-domains` → Purview UC `/businessdomains` (PUBLISHED) or Cosmos `domains:<tenantId>` |
| Custom attributes schema | `GET /api/attribute-groups` → Cosmos `attribute-groups:<tenantId>` |
| Details / receipt | `GET /api/cosmos-items/data-product/<id>` → real Cosmos record (shows new id + Purview registration outcome) |

## Azure-native default (no Fabric, no Purview required)

With `LOOM_DEFAULT_FABRIC_WORKSPACE` unset and **no** Purview account bound:
- The wizard fully renders and **creates the draft in Loom's Cosmos store**.
- Governance domains come from the Loom-local Cosmos list.
- Purview registration is skipped with an honest hint on the receipt — never a gate.

Purview Unified Catalog is **opt-in** via `LOOM_PURVIEW_UC_ENDPOINT` /
`LOOM_PURVIEW_ACCOUNT` (wired in `admin-plane/main.bicep`). The UC API is
Commercial-only today; GCC/GCC-High/IL5 fall back to the Cosmos domain list
automatically.

## Verification

- `vitest run lib/catalog/__tests__/data-product-enums.test.ts` — 14 types, 8 audiences, 10,000 limit, validators.
- Manual: complete the wizard with Purview unset → draft created in Cosmos, redirect to `/data-products/<id>`, receipt shows the new id; a 10,001-char description blocks Next and is rejected by the API (400); owner search returns live Graph results.
