# apim-service — parity with Azure API Management (portal service blade)

**Source UI:** Azure portal → API Management service instance
(left blade: Overview, APIs, Products, Subscriptions, Named values, Backends,
Gateways, Policies, Groups, Users, Certificates, Developer portal, Monitoring,
Diagnose and solve problems, Scale, Settings).
Grounded in Microsoft Learn:
- APIs / import / test console — https://learn.microsoft.com/azure/api-management/import-api-from-oas
- Subscriptions — https://learn.microsoft.com/azure/api-management/api-management-subscriptions
- Products — https://learn.microsoft.com/azure/api-management/api-management-howto-add-products
- Policies (form + code editor, scopes) — https://learn.microsoft.com/azure/api-management/set-edit-policies
- Versions / revisions — https://learn.microsoft.com/azure/api-management/api-management-versions , .../api-management-revisions
- Developer portal — https://learn.microsoft.com/azure/api-management/developer-portal-overview
- Monitoring / App Insights / diagnostics — https://learn.microsoft.com/azure/api-management/monitor-api-management , .../api-management-howto-app-insights , .../diagnose-solve-problems

**Loom surface under audit:**
- Navigator: `apps/fiab-console/lib/components/apim/apim-tree.tsx`
- Editors: `apps/fiab-console/lib/editors/apim-editors.tsx`
  (`ApimApiEditor`, `ApimProductEditor`, `ApimPolicyEditor`)
- Client (real ARM REST, `2024-06-01-preview`, UAMI via ChainedTokenCredential):
  `apps/fiab-console/lib/azure/apim-client.ts`
- BFF routes: `apps/fiab-console/app/api/apim/**`, `app/api/items/apim-*/**`

Legend: **built ✅** = full 1:1 + real backend · **partial ⚠️** = exists, incomplete/rough ·
**gated ⚠️** = honest infra-gate MessageBar only · **MISSING ❌** = not present.

---

## Azure/Fabric feature inventory → Loom coverage → Backend per control

### Service overview / lifecycle / scale

| Azure capability | Loom | Backend |
| --- | --- | --- |
| Service **Overview** blade (gateway URL, dev-portal URL, SKU, location, status, usage tiles) | **MISSING ❌** — no APIM service editor; navigator header is just a label | `getServiceInfo` / `getApimService` exist in client but unused by the navigator/editor |
| **Scale / pricing tier** (change SKU Developer/Basic/Standard/Premium/v2 + units) | **partial ⚠️** — exists only in a *separate* admin surface (`/api/admin/scaling/apim`), not in the APIM editor/navigator | `updateApimSku` / `getApimService` → real ARM PATCH (202 async) |
| **Activity log / locks / tags / IAM** on the service resource | **MISSING ❌** | none |
| **Diagnose and solve problems** | **MISSING ❌** | none |

### APIs

| Azure capability | Loom | Backend |
| --- | --- | --- |
| List all APIs in left tree | **built ✅** `apim-tree` APIs group, live count, filter | `listApis` → ARM GET `/apis` |
| Create blank / "Define a new API" (HTTP) | **built ✅** tree ＋New + editor new-API form (displayName, path, name, optional spec URL) | `upsertApi` → ARM PUT `/apis/{id}` |
| **Import** OpenAPI (inline JSON) | **built ✅** editor "Import from OpenAPI" + "Import API" dialogs (Monaco) | `/api/apim/import` + `upsertApi` `format=openapi+json` |
| Import OpenAPI by **link/URL** | **built ✅** | `format=openapi-link` |
| Import **WSDL** (SOAP) | **partial ⚠️** link-only ("wsdl-link"); no SOAP-to-REST toggle, no WSDL service/endpoint picker | `upsertApi` `format=wsdl-link` |
| Import **GraphQL** (schema link) | **partial ⚠️** link-only; no synthetic GraphQL, no resolver authoring | `format=graphql-link` |
| Import Azure OpenAI / WebSocket / gRPC / OData / App-Service/Function/Logic-App/Container-App tiles | **MISSING ❌** (only OpenAPI/WSDL/GraphQL paths) | — |
| Delete API | **built ✅** inline delete | `deleteApi` → ARM DELETE |
| **Settings** tab — displayName, path, protocols, service/base URL, subscription required | **built ✅** Design tab form | `upsertApi` PUT |
| Settings tab — **subscription key header/query param names** | **MISSING ❌** | — |
| Settings tab — **Diagnostics Logs / App Insights logger / sampling** | **MISSING ❌** | — |
| Settings tab — API **URL scheme**, **API type**, **products**, **gateways** assignment | **partial ⚠️** products assigned from the *product* editor; per-API gateway/url-scheme not exposed | — |
| **Design** tab — operations list | **partial ⚠️** read-only list (tree branch + editor test dropdown) | `listOperations` → ARM GET `/apis/{id}/operations` |
| **Operations authoring** — add/edit/delete operation, method, URL template, query/template/header params, request/response representations & schemas, example bodies | **MISSING ❌** (self-described "coming" row in tree); operations only arrive via imported spec | — |
| **OpenAPI spec** view (read-only) + **edit** (Monaco) + copy/refresh | **built ✅** | `getApiSpec` (ARM `format=openapi+json` export) + `upsertApi` |
| **Test console** (pick op, method/template/headers/body, Send through gateway; key injected server-side) | **built ✅** | `testApiCall` → resolves gateway URL + `master` listSecrets, real gateway HTTP call |
| Test console — **trace / request inspector** (Ocp-Apim-Trace) | **MISSING ❌** | — |
| **Revisions** — list, create, set current/release, change-log, online/offline | **partial ⚠️** list + create + release(make current); no "take offline", no "create version from revision", no per-revision edit | `listApiRevisions` / `createApiRevision` / `listApiReleases` / `createApiRelease` → real ARM |
| **Versions / version sets** — add version, scheme (segment/header/query), version-set view | **MISSING ❌** ("coming" row) | — |
| **All operations / per-operation policy** scope from Design tab | **partial ⚠️** reachable via Policy editor scope picker, but not from a per-operation Design surface | `upsertPolicy` operation scope |
| API **tags** | **MISSING ❌** | — |

### Products

| Azure capability | Loom | Backend |
| --- | --- | --- |
| List / create / delete products | **built ✅** tree + editor | `listProducts` / `upsertProduct` / `deleteProduct` |
| Settings — displayName, description, state, subscription required, approval required, **subscriptions count limit / per-user limit** | **partial ⚠️** all except the two subscription-count limits | `upsertProduct` PUT |
| **Publish / Unpublish** lifecycle | **built ✅** ribbon Publish/Unpublish | `upsertProduct` state flip |
| **APIs** in product — add / remove | **built ✅** APIs tab | `listProductApis` / `addApiToProduct` / `removeApiFromProduct` |
| **Subscriptions** to product — list | **built ✅** Subscriptions tab (read) | `listProductSubscriptions` |
| **Product policy** | **built ✅** ribbon → policy editor (product scope) | `getPolicy` / `upsertPolicy` `products/{id}` |
| Product **Access control (groups visibility)** | **MISSING ❌** | — |

### Subscriptions

| Azure capability | Loom | Backend |
| --- | --- | --- |
| List / create / delete subscriptions; scope all-APIs / product / single-API | **built ✅** navigator group + create dialog (created active) | `listSubscriptions` / `createSubscription` / `deleteSubscription` |
| **Show / regenerate** primary & secondary keys | **partial ⚠️** capability exists only in the *marketplace* surface (`/api/marketplace/subscriptions/[sid]/keys`), NOT on the APIM subscription rows; no regenerate | `getSubscriptionKeys` (listSecrets); regenerate not implemented |
| **Suspend / activate / cancel** subscription state transitions | **MISSING ❌** (only create-active + delete) | — |
| Assign subscription **owner (user)** | **MISSING ❌** | — |

### Named values

| Azure capability | Loom | Backend |
| --- | --- | --- |
| List / create / delete named values; plain + secret | **built ✅** navigator group + dialog | `listNamedValues` / `upsertNamedValue` / `deleteNamedValue` |
| **Reveal** secret value | **partial ⚠️** `getNamedValueSecret` exists in client but no UI reveal button | client only |
| **Edit** existing named value (value/tags) | **partial ⚠️** create is upsert, but no edit-in-place form | `upsertNamedValue` |
| **Key Vault**-backed named values (secret reference, identity, refresh) | **MISSING ❌** (inline value only) | — |
| Named-value **tags** | **MISSING ❌** in UI | client accepts tags |

### Backends

| Azure capability | Loom | Backend |
| --- | --- | --- |
| List / create / delete backends; runtime URL, protocol (http/soap), title | **built ✅** navigator group + dialog | `listBackends` / `upsertBackend` / `deleteBackend` |
| Backend **credentials** (header/query/auth, client cert, authorization), **TLS validation**, **circuit breaker**, **load-balanced pool**, **resource-id** to an Azure resource | **MISSING ❌** | — |
| Edit existing backend | **partial ⚠️** upsert only, no edit form | `upsertBackend` |

### Policies

| Azure capability | Loom | Backend |
| --- | --- | --- |
| Policy XML editor at **global / product / API / operation** scope | **built ✅** `ApimPolicyEditor` scope picker (service/api/product/operation) | `getPolicy` / `upsertPolicy` real ARM at each scope |
| **Code editor** with snippet gallery | **built ✅** Monaco + 10 proven snippets (rate-limit, quota, validate-jwt, cors, ip-filter, set-header, set-backend, mock, cache) | client-side insert + ARM save |
| **Form-based / guided** policy editor ("+ Add policy" tiles) | **MISSING ❌** (XML-only; Azure offers guided forms) | — |
| **Calculate effective policy** (show inherited `base` resolution) | **MISSING ❌** | — |
| **Policy fragments** (reusable, include-fragment) | **MISSING ❌** | — |
| Well-formed XML validation before save | **built ✅** `isWellFormedXml` (DOMParser) | client |

### Gateways

| Azure capability | Loom | Backend |
| --- | --- | --- |
| List self-hosted gateways | **built ✅** read-only navigator group | `listGateways` → ARM GET `/gateways` |
| Create / configure / get-token / deploy self-hosted gateway | **MISSING ❌** | — |

### Surfaces with no Loom presence at all

| Azure blade | Loom | Backend |
| --- | --- | --- |
| **Developer portal** (managed portal designer, pages/widgets, publish, CSP, custom domain, self-host) | **MISSING ❌** | — |
| **Groups** (built-in + custom, members) | **MISSING ❌** | — |
| **Users** (developer accounts, invite, groups, subscriptions) | **MISSING ❌** | — |
| **Certificates / CA certificates / client certs** | **MISSING ❌** | — |
| **Monitoring** — Diagnostic settings, Analytics dashboard, Logs (KQL), Alerts, metrics | **MISSING ❌** | — |
| **Application Insights / Loggers / Diagnostics** entities | **MISSING ❌** | — |
| **Named-values → Key Vault**, **Managed identities**, **Protocols + ciphers**, **Custom domains**, **Networking / VNet**, **Workspaces**, **Notifications/Email templates**, **Repository (Git)**, **Backup/Restore**, **Deployment + infrastructure / regions (multi-region)** | **MISSING ❌** | — |

---

## Verdict

The three APIM editors + navigator are a **genuine, real-backend slice** of the APIM
service blade — every control listed as built ✅ calls real ARM REST through a UAMI,
with an honest 503 infra-gate when unconfigured (no mocks, no `return []`). The core
publisher loop (import → design → policy → product → subscription → test) works
end-to-end.

But it is **far from one-for-one with the full portal service blade.** Whole
first-class blades are absent (Developer portal, Users, Groups, Certificates,
Monitoring/diagnostics, Networking, Workspaces, Custom domains, Identities). Within
the blades that exist, the highest-impact gaps are: **operations authoring**
(operations are read-only / import-only), the **form-based policy editor + effective
policy + fragments**, **subscription key reveal/regenerate + state transitions in the
editor** (today only in the marketplace surface), **named-value secret reveal + Key
Vault references**, **backend credentials/circuit-breaker/pools**, and **version sets**.
The service **Overview** and **Scale** are not in this editor at all (scale lives in a
separate admin route).

**Grade: C** (functional but rough; broad portal-blade gaps, several read-only/upsert-only
surfaces, key cross-cutting blades missing). The build quality of what exists is B-grade;
the *parity breadth* drags the surface to C.
