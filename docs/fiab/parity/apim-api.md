# apim-api — parity with Azure API Management → APIs

Source UI: Azure portal → API Management → APIs (https://learn.microsoft.com/azure/api-management/),
REST: https://learn.microsoft.com/rest/api/apimanagement/

## Azure feature inventory (grounded in Learn)

| # | Capability | Azure surface |
|---|------------|---------------|
| 1 | Import API (OpenAPI / WSDL / GraphQL / blank) | + Add API wizard, `format`/`value` on PUT `/apis/{id}` |
| 2 | Edit settings (display name, path, protocols, service URL, subscription required) | API → Settings |
| 3 | Operations list (method + URL template) | API → Design |
| 4 | Test console — send request through gateway → response (status/headers/body) | API → Test, gateway + Ocp-Apim-Subscription-Key |
| 5 | OpenAPI spec view + edit | API → Design → OpenAPI editor; `export=true` |
| 6 | Revisions (list, create, make current/release with change log) | API → Revisions; `/apis/{id}/revisions`, `/releases` |
| 7 | Policies at API + operation scope | API → policy editor (deep-link to apim-policy) |

## Loom coverage

| # | Status | Notes |
|---|--------|-------|
| 1 | built ✅ | Import dialog: OpenAPI(JSON link/inline), WSDL link, GraphQL link → PUT with `format`/`value` |
| 2 | built ✅ | Form fields, PUT `/api/items/apim-api/[id]` |
| 3 | built ✅ | Left tree from `/operations` |
| 4 | built ✅ | Test console tab → POST `/api/items/apim-api/[id]/test-call` (real gateway call, key resolved server-side from `master` all-access sub) |
| 5 | built ✅ | Monaco OpenAPI editor dialog + read-only viewer |
| 6 | built ✅ | Revisions tab → GET/POST `/api/items/apim-api/[id]/revisions` (create + optional release) |
| 7 | built ✅ | "Open policy editor" ribbon deep-link (api + operation scope in apim-policy) |

## Backend per control

- Settings/import/spec → `upsertApi` (ARM PUT `/apis/{id}`)
- Operations → `listOperations`
- Test → `testApiCall` (gateway fetch + `getSubscriptionKeys('master')`)
- Revisions → `listApiRevisions` / `createApiRevision` / `createApiRelease`
- Honest gate: APIM unreachable → `BackendStateBar` with the ARM error (RBAC/role hint).
