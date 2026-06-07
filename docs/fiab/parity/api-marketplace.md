# api-marketplace — parity with the Azure API Management developer portal

Source UI: APIM **developer portal** (APIs gallery + product pages + "Try it"
console + user-profile subscriptions) and the Azure portal **APIs › Test**
console.
Learn:
<https://learn.microsoft.com/azure/api-management/developer-portal-overview>,
<https://learn.microsoft.com/azure/api-management/api-management-subscriptions>,
<https://learn.microsoft.com/azure/api-management/api-management-howto-add-products#access-to-product-apis>,
<https://learn.microsoft.com/rest/api/apimanagement/subscription/create-or-update>.

Backend APIM: `apim-csa-loom-eastus2` (override `LOOM_APIM_NAME` /
`LOOM_APIM_RG` / `LOOM_SUBSCRIPTION_ID`) via ARM REST against
`Microsoft.ApiManagement/service`, api-version `2024-06-01-preview`. The Loom
Console UAMI authenticates with `ChainedTokenCredential` and needs the
**API Management Service Contributor** role at the service scope
(`scripts/csa-loom/grant-apim-rbac.sh`).

## What this fixes

The page was `ItemsByTypePane(['apim-api','apim-product','apim-policy'])` — a
flat owned-items list with no consumer workflow. Operator verdict: *"the CSA
Loom API marketplace is garbage — can't do anything with it."* It's now a real
catalog/consumer surface over the published APIM inventory: discover → inspect
(operations + OpenAPI) → try a live gateway call → subscribe/request access →
reveal subscription keys.

## Azure (developer-portal) feature inventory → Loom coverage

| APIM developer-portal capability | Loom coverage | Backend (real REST) |
| --- | --- | --- |
| Browse API inventory (this APIM instance) | ✅ built — left rail tree (products → APIs) + "APIs not in a product" group | `GET .../apis` (`listApis`) via `/api/marketplace/catalog` |
| Browse products (managed groups of APIs) | ✅ built — products as expandable tree branches with state badge | `GET .../products` (`listProducts`) |
| Show which APIs belong to each product | ✅ built — per-product API children | `GET .../products/{id}/apis` (`listProductApis`) |
| Search / filter the inventory | ✅ built — search box filters products + APIs by name/path/description | client-side over the catalog payload |
| View API details (protocols, type, subscription-required, path) | ✅ built — detail header badges + Overview tab | shaped from `listApis` / catalog |
| View gateway base URL for an API | ✅ built — Overview shows `gatewayUrl/{path}` | `getServiceInfo` (`properties.gatewayUrl`) |
| View API operations | ✅ built — Operations tab (method, name, urlTemplate) + "Use" → Try it | `GET .../apis/{id}/operations` (`listOperations`) |
| View API definition / OpenAPI spec | ✅ built — OpenAPI tab (export + copy + refresh) | `GET .../apis/{id}?format=openapi+json&export=true` (`getApiSpec`) |
| Interactive **Try it** console (send a real call) | ✅ built — Try it tab: method + urlTemplate + headers + body → Send; renders status/headers/body | `POST /api/items/apim-api/{id}/test-call` → `testApiCall` (gateway + `Ocp-Apim-Subscription-Key` resolved server-side via `listSecrets`) |
| Subscribe to a **product** / request access | ✅ built — "Subscribe"/"Request access" button + confirm dialog; honors approval (submitted vs active) | `PUT .../subscriptions/{sid}` (`createSubscription`, scope = `/products/{id}`) via `POST /api/marketplace/subscriptions` |
| Subscribe to a **single API** / all-APIs scope | ✅ built — "Subscribe to this API" on the detail header (API scope) | `createSubscription` (scope = `/apis/{id}`; all-APIs supported by client) |
| View my subscriptions + their state | ✅ built — "My subscriptions" tab (name, scope, state badge, created) | `GET .../subscriptions` (`listSubscriptions`) |
| Reveal subscription keys (primary/secondary) | ✅ built — "Show keys" + copy; keys resolved server-side (never on GET) | `POST .../subscriptions/{sid}/listSecrets` (`getSubscriptionKeys`) via `/api/marketplace/subscriptions/{sid}/keys` |
| **Rename** a subscription | ✅ built — row menu → Rename dialog | `PATCH .../subscriptions/{sid}` (`updateSubscription`) via `/api/marketplace/subscriptions/{sid}` |
| **Suspend / activate** a subscription | ✅ built — row menu → state toggle | `PATCH .../subscriptions/{sid}` (state) |
| **Delete / cancel** a subscription | ✅ built — row menu → Delete (confirm) | `DELETE .../subscriptions/{sid}` (`deleteSubscription`) |
| **Regenerate** primary / secondary key | ✅ built — row menu + Use-API drawer | `POST .../subscriptions/{sid}/regenerate{Primary,Secondary}Key` via `/api/marketplace/subscriptions/{sid}/keys/regenerate` |
| **Use this API** (as a source for anything in Loom) | ✅ built — drawer with gateway base URL, key, copy-paste **cURL / Python / JavaScript** samples | client + `getSubscriptionKeys` |
| **Build a mini-app** on an API | ✅ built — wizard scaffolds a real Loom Notebook (Python client + the API's operations + a starter analysis cell), owned in a chosen workspace | `POST /api/marketplace/mini-app` → `createOwnedItem('notebook')` + `listOperations` |
| **Filter** APIs by access (open / subscription) | ✅ built — Access dropdown alongside search | client-side over the catalog payload |
| Refresh inventory / subscriptions | ✅ built — Refresh buttons re-fetch from APIM | re-calls the routes above |
| Infra-gate when APIM not provisioned | ⚠️ honest-gate — MessageBar `intent="warning"` names `LOOM_APIM_NAME` / `LOOM_SUBSCRIPTION_ID`, the RBAC role, and the bicep module; the full catalog UI shell still renders | `apimGate()` → 503 `{ gated:true, hint, bicepModule }` |

Not in scope for the consumer marketplace (these are the **publisher**/admin
surfaces, already built as their own editors in PR #455 and reached from the
APIs+Data-Products family — not duplicated here):

| Publisher capability | Where it lives in Loom |
| --- | --- |
| Create/edit/delete APIs, import OpenAPI, revisions/releases | `apim-api` editor (`/api/items/apim-api/**`) |
| Create/edit/publish products, add/remove APIs, terms | `apim-product` editor (`/api/items/apim-product/**`) |
| Author policies (service/api/product/operation scope) | `apim-policy` editor (`/api/items/apim-policy/**`) |
| Developer-portal branding / custom widgets / WordPress | n/a — Loom *is* the portal theme; not a consumer action |

Zero ❌ on the consumer inventory. Zero stub banners — the only non-functional
state is the documented APIM infra-gate.

## Backend per control

- Catalog (products + product-APIs + flat APIs + service): `GET /api/marketplace/catalog` → `listProducts` + `listProductApis` (fan-out) + `listApis` + `getServiceInfo`. `?published=1` restricts to `state==='published'`.
- Operations: `GET /api/items/apim-api/{id}/operations` → `listOperations`.
- OpenAPI spec: `GET /api/items/apim-api/{id}/spec` → `getApiSpec` (export=true).
- Try it: `POST /api/items/apim-api/{id}/test-call` → `testApiCall` (real gateway request; key attached server-side).
- Subscriptions list: `GET /api/marketplace/subscriptions` → `listSubscriptions`.
- Subscribe / request access: `POST /api/marketplace/subscriptions` → `createSubscription` (exactly one of `product` / `api` / `allApis`; `notify=true`; default state `submitted` → pending approval).
- Reveal keys: `POST /api/marketplace/subscriptions/{sid}/keys` → `getSubscriptionKeys` (`listSecrets`).

All routes validate the Loom session (`getSession` → 401) and run the
`apimGate` provisioning check (→ 503 `{gated:true}`) before any Azure call.

## Tests

- `app/api/marketplace/__tests__/marketplace-routes.test.ts` — 15 contract tests: auth 401, provisioning 503 gate (+ JSON content-type), subscribe 400 validation (no target / multiple targets), product & API subscribe delegation + 201, `?published=1` filtering, keys happy path + gate.
- `lib/azure/__tests__/apim-marketplace-client.test.ts` — 8 unit tests pinning `subscriptionScope` (absolute ARM id, URL-encoding), `slugSid`, and `createSubscription`'s `PUT .../subscriptions/{sid}?notify=true` body/URL contract.

## Bicep sync

No new Azure resource or env var: the marketplace reuses the existing APIM
service + the `LOOM_APIM_NAME` / `LOOM_APIM_RG` / `LOOM_SUBSCRIPTION_ID` /
`LOOM_UAMI_CLIENT_ID` env already wired for the `apim-*` editors, and the same
"API Management Service Contributor" UAMI role. The honest-gate names those
exact vars + `platform/fiab/bicep/modules/admin-plane/apim.bicep` when unset.
