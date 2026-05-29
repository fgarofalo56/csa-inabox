# apim-product — parity with Azure API Management → Products

Source UI: Azure portal → API Management → Products (https://learn.microsoft.com/azure/api-management/api-management-howto-add-products)

## Azure feature inventory

| # | Capability | Azure surface |
|---|------------|---------------|
| 1 | Settings (display name, description, state, subscription/approval flags) | Product → Settings |
| 2 | Publish / Unpublish lifecycle | Product → state=published/notPublished |
| 3 | APIs in product (add / remove) | Product → APIs; `/products/{id}/apis/{aid}` |
| 4 | Subscriptions (list product subscribers) | Product → Subscriptions; `/products/{id}/subscriptions` |
| 5 | Policies at product scope | Product → Policies (deep-link to apim-policy) |

## Loom coverage

| # | Status | Notes |
|---|--------|-------|
| 1 | built ✅ | Form + PUT `/api/items/apim-product/[id]` |
| 2 | built ✅ | Publish/Unpublish ribbon + toolbar |
| 3 | built ✅ | APIs tab: GET/POST/DELETE `/api/items/apim-product/[id]/apis` (add from all-APIs picker, remove inline) |
| 4 | built ✅ | Subscriptions tab: GET `/api/items/apim-product/[id]/subscriptions` |
| 5 | built ✅ | "Product policy" ribbon deep-link to apim-policy (product scope) |

## Backend per control

- Settings/lifecycle → `upsertProduct`
- APIs → `listProductApis` / `addApiToProduct` / `removeApiFromProduct` / `listApis`
- Subscriptions → `listProductSubscriptions`
- Honest gate: APIM unreachable → `BackendStateBar`.
