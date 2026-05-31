# apim-service — parity with Azure API Management (service)

**Source UI:** Azure portal → API Management service blade (APIs, Products, Named
values, Backends, Subscriptions, Gateways).
**Learn grounding:**
- ARM resource `Microsoft.ApiManagement/service` — https://learn.microsoft.com/azure/templates/microsoft.apimanagement/service
- `service/apis`, `service/apis/operations`, `service/products`, `service/namedValues`,
  `service/backends`, `service/subscriptions`, `service/gateways`, `service/policies`
- Named value contract (secret, value-not-on-GET, listValue): https://learn.microsoft.com/azure/templates/microsoft.apimanagement/service/namedvalues
- Backend contract (url + protocol required for Single): https://learn.microsoft.com/azure/templates/microsoft.apimanagement/service/backends

**ARM api-version used by the client:** `2024-06-01-preview` (`APIM_API` in `lib/azure/apim-client.ts`).
**Auth:** Loom UAMI via `ChainedTokenCredential(ManagedIdentityCredential{LOOM_UAMI_CLIENT_ID}, DefaultAzureCredential)`, scope `https://management.azure.com/.default`.
**Role required:** API Management Service Contributor on the APIM service.
**Honest infra-gate:** `apimConfigGate()` 503s naming `LOOM_SUBSCRIPTION_ID` (and `LOOM_APIM_NAME` / `LOOM_APIM_RG`) — the whole navigator + editor still render the gate MessageBar.

## Azure feature inventory → Loom coverage → backend per control

| Azure APIM capability | Loom coverage | Backend per control |
| --- | --- | --- |
| **APIs** — list with display name + path + sub-required | ✅ built (group with live count) | `GET /api/apim/apis` → `listApis()` → ARM `GET …/service/{svc}/apis` |
| Create API (name + path + display name + optional OpenAPI link) | ✅ built (＋New dialog) | `POST /api/apim/apis` → `upsertApi()` → ARM `PUT …/apis/{id}` (`format: openapi-link` when spec URL given) |
| Delete API | ✅ built (inline) | `DELETE /api/apim/apis?id=` → `deleteApi()` → ARM `DELETE …/apis/{id}` |
| Open API → full API editor (design/test/revisions/import) | ✅ built (select → `onOpenApi` → `/items/apim-api/{id}`) | existing `ApimApiEditor` + `/api/items/apim-api/*` |
| **API operations** — list per API | ✅ built (expand an API node) | `GET /api/apim/operations?apiId=` → `listOperations()` → ARM `GET …/apis/{id}/operations` |
| API operations authoring (add/edit params + per-op policy) | ⚠️ honest "coming" row | operations imported via OpenAPI today in the API editor; manual authoring deferred |
| **Products** — list with lifecycle state | ✅ built | `GET /api/apim/products` → `listProducts()` → ARM `GET …/products` |
| Create product (name + display name, draft) | ✅ built (＋New dialog) | `POST /api/apim/products` → `upsertProduct()` → ARM `PUT …/products/{id}` |
| Delete product (+ its subscriptions) | ✅ built (inline) | `DELETE /api/apim/products?id=` → `deleteProduct()` → ARM `DELETE …/products/{id}?deleteSubscriptions=true` |
| Open product → product editor (settings/APIs/subscriptions/publish) | ✅ built (select → `onOpenProduct`) | existing `ApimProductEditor` + `/api/items/apim-product/*` |
| **Named values** — list (secret flag, value for non-secret) | ✅ built | `GET /api/apim/named-values` → `listNamedValues()` → ARM `GET …/namedValues` |
| Create named value (name + value + secret toggle) | ✅ built (＋New dialog) | `POST /api/apim/named-values` → `upsertNamedValue()` → ARM `PUT …/namedValues/{id}` |
| Delete named value | ✅ built (inline) | `DELETE /api/apim/named-values?id=` → `deleteNamedValue()` → ARM `DELETE …/namedValues/{id}` (If-Match: *) |
| Reveal secret named value | ✅ client (`getNamedValueSecret` → `POST …/namedValues/{id}/listValue`) | route exposure deferred (tree shows `secret` badge) |
| Key Vault–backed named value | ⚠️ deferred | client passes `secret`/`value`; KV `secretIdentifier` form deferred |
| **Backends** — list with url + protocol | ✅ built | `GET /api/apim/backends` → `listBackends()` → ARM `GET …/backends` |
| Create backend (name + url + protocol + title) | ✅ built (＋New dialog) | `POST /api/apim/backends` → `upsertBackend()` → ARM `PUT …/backends/{id}` |
| Delete backend | ✅ built (inline) | `DELETE /api/apim/backends?id=` → `deleteBackend()` → ARM `DELETE …/backends/{id}` (If-Match: *) |
| Backend credentials / circuit breaker / TLS / pool | ⚠️ deferred | url+protocol+title+description wired; advanced contract fields deferred |
| **Subscriptions** — list with scope + state | ✅ built | `GET /api/apim/subscriptions` → `listSubscriptions()` → ARM `GET …/subscriptions` |
| Create subscription (name + scope: all APIs / product / API) | ✅ built (＋New dialog, active) | `POST /api/apim/subscriptions` → `createSubscription()` → ARM `PUT …/subscriptions/{sid}` |
| Delete subscription | ✅ built (inline) | `DELETE /api/apim/subscriptions?id=` → `deleteSubscription()` → ARM `DELETE …/subscriptions/{sid}` (If-Match: *) |
| Subscription keys (primary/secondary, regenerate) | ⚠️ deferred | client has `getSubscriptionKeys` (used by API test console); tree-level key reveal deferred |
| **Gateways** — list self-hosted gateways | ✅ built (read-only group) | `GET /api/apim/gateways` → `listGateways()` → ARM `GET …/gateways` |
| Register / provision a self-hosted gateway | ⚠️ honest read-only | gateway provisioning is a tenant/infra action (deploy gateway container + token); read-only here |
| **Policies** — global / API / product policy XML | ⚠️ honest "coming" row at tree | full XML editor lives in `ApimPolicyEditor` (`/items/apim-policy/...`); client `getPolicy`/`upsertPolicy` back it; tree-level scope picker deferred |
| OpenAPI import wizard (multi-step validate/map/preview) | ⚠️ honest "coming" row | ＋New API takes an OpenAPI link inline; API editor has full inline/link/WSDL/GraphQL import |
| Revisions & versions (version sets) | ⚠️ honest "coming" row | revisions wired in the API editor's Revisions tab (`/api/items/apim-api/{id}/revisions`); tree version-set view deferred |
| Filter resources by name | ✅ built (filter box across every group) | client-side filter |

## Deferred — all honest-gated (no fakes, no dead buttons)

Every deferred capability above is surfaced either as a Fluent `Badge` "coming"
row under **More (in the editor / coming)** with a tooltip naming where it
already lives, or as a read-only group (Gateways). Nothing renders a fake list
and no button is a dead stub. The four ⚠️ "coming" rows (policy XML editor at the
tree, API operations authoring, OpenAPI import wizard, revisions/versions) point
at the API/product/policy editors that implement them today.

## Grade

**B** — all six core groups (APIs/Products/Named values/Backends/Subscriptions +
read-only Gateways/Operations) list/create/delete against real ARM REST with an
honest infra-gate. Reaches **A/A+** when the deferred rows (tree-level policy
picker, operation authoring, import wizard, version sets) are built and
Vitest/Playwright cover the navigator.
