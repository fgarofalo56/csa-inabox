# Loom APIM Policy Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent. "APIM Policy" = the XML policy document attached to one of four scope levels in Azure API Management — Global (service), Product, API, or API Operation. Policies are the request/response pipeline: auth (validate-jwt, validate-azure-ad-token), throttling (rate-limit, quota), transforms (set-header, set-body, rewrite-uri, json-to-xml, xml-to-json), routing (set-backend-service, forward-request), caching, and observability.

## Overview

Every API call routed through APIM executes a policy document at four ordered scopes — Global → Product → API → Operation — with each child scope inheriting from its parent through the `&lt;base /&gt;` placeholder. Each scope's XML has four zones: `&lt;inbound&gt;` (before backend), `&lt;backend&gt;` (forward-request control), `&lt;outbound&gt;` (after backend), `&lt;on-error&gt;` (catch). The portal editor is a Monaco XML pane with a snippet picker on the right (Add policy → categorized list of all built-in policies with their parameter forms), policy expression intellisense (`@(context.User.Id)`-style), well-formedness validation on Save, and an integrated test runner that executes the policy against a simulated request and shows trace output.

## UI components (Azure portal)

### Scope navigation
- Policy editing is reached from four entry points, all rendering the same editor with different `scope` and target ids:
  - **Global**: APIM service → APIs → All APIs → Policies tab → "`</>` Policy code editor"
  - **Product**: Products → {product} → Policies tab
  - **API**: APIs → {api} → Design → Inbound/Backend/Outbound/On-error `&lt;/&gt;` buttons
  - **Operation**: APIs → {api} → Design → {operation} → Inbound/Backend/Outbound/On-error `&lt;/&gt;` buttons

### Editor chrome
- Tabs: **Code view** · **Form view** (limited — only some policies have a form representation)
- Header buttons: Save · Discard · **Calculate effective policy** (shows the merged XML after `&lt;base /&gt;` resolution from all parent scopes)
- Read-only mini-pane on top showing scope path (e.g., "API: orders-api → Operation: getOrderById")

### Monaco XML editor
- Syntax highlighting + bracket matching for XML
- Intellisense over the APIM policy schema (element names, attribute names, allowed children) — triggered by `&lt;` and Ctrl/Cmd+Space
- Intellisense over `@(...)` policy expressions — C# subset with `context.*`, `context.Request.*`, `context.Response.*`, `context.User.*`, `context.Variables[...]`, `context.Product.*`, `context.Api.*`, `context.Operation.*`
- Hover docs per element/attribute (pulled from the policy reference docs)
- Squiggle markers for invalid XML, unknown elements, and missing required attributes
- Ctrl+/ to toggle XML comments
- Auto-indent + format on save

### Snippet picker (right rail)
- Categorized list of every built-in policy:
  - **Access restriction**: rate-limit, rate-limit-by-key, quota, quota-by-key, ip-filter, validate-jwt, validate-azure-ad-token, validate-client-certificate, check-header
  - **Authentication**: authentication-basic, authentication-certificate, authentication-managed-identity
  - **Caching**: cache-lookup, cache-store, cache-remove-value, cache-lookup-value, cache-store-value
  - **Cross-domain**: cors, jsonp, cross-domain
  - **Dapr / GraphQL / SOAP** sub-groups
  - **Routing**: set-backend-service, forward-request, return-response, redirect-content-urls, rewrite-uri
  - **Transformation**: set-header, set-query-parameter, set-body, set-variable, set-method, set-status, json-to-xml, xml-to-json, find-and-replace
  - **Validation**: validate-content, validate-parameters, validate-headers, validate-status-code
  - **Observability**: trace, emit-metric, log-to-eventhub, mock-response
- Each snippet click → inserts XML stub at the caret with placeholders
- Per-snippet "Insert form…" dialog where supported (e.g., validate-jwt form with openid-config URL, audience, issuer, required claims)

### Test runner (calculate + test)
- "Calculate effective policy" merges all parent scopes through `&lt;base /&gt;` and shows the final document
- "Test" panel (only in Design tab integration for API/operation scopes) executes the policy against a mock or real request and renders the trace output (per-policy timing + variable state)

### Save behavior
- Server-side validation: APIM returns 4xx with the offending element/line if XML is malformed or references an unknown policy element
- Side-effect: policies are versioned at the scope level (no separate revision); changes are live immediately

## What Loom has

- `apps/fiab-console/lib/editors/apim-editors.tsx` lines 422-555: `ApimPolicyEditor`
- Live ARM-REST wired via `lib/azure/apim-client.ts` to:
  - Global scope: `Microsoft.ApiManagement/service/{name}/policies/policy`
  - API scope: `Microsoft.ApiManagement/service/{name}/apis/{aid}/policies/policy`
  - Product scope: `Microsoft.ApiManagement/service/{name}/products/{pid}/policies/policy`
- BFF route: `GET/PUT /api/items/apim-policy/[id]?scope=service|api|product&apiId=...&productId=...`
- Form fields: scope dropdown (service / api / product), conditional apiId or productId Input, value (XML)
- Default `&lt;policies&gt;` template seeded with commented-out validate-jwt + active rate-limit calls=120/60s
- Client-side `DOMParser` well-formed-XML validation before Save (`isWellFormedXml` guard)
- Monaco XML editor (`MonacoTextarea` with `language="xml"`, self-hosted Monaco assets per `scripts/copy-monaco-assets.mjs`) — bracket matching, syntax highlighting, Ctrl+S save, dirty-flag tracking
- Ribbon: Save · Reload · Validate XML (`isWellFormedXml` invoked client-side; SSR-safe fallback unit-tested at `__tests__/apim-xml-validation.test.ts`) · Global / API / Product / Operation scope buttons all wired with real handlers
- Operation scope (`apis/{aid}/operations/{oid}/policies/policy`) wired for read+upsert via `apim-client.ts` (v3.27)
- **Grade: B** — real ARM CRUD across all four scopes (Global / API / Product / Operation), Monaco XML editor, client-side well-formed-XML guard before Save, sensible default policy template, accurate ribbon wiring, dirty-flag prevents stale-keystroke clobber on async PUT (Phase 4.5). Lifted from C by v3.27 (Operation scope) + v3.28 (Monaco). Remaining gaps (snippet picker, expression IntelliSense, effective-policy calculator, test runner) are tracked below and don't block production use.

## Gaps for parity

1. **Operation scope** — `apis/{aid}/operations/{oid}/policies/policy` unwired; operation-scope policies are critical for endpoint-specific auth/throttling and currently unreachable
2. **Monaco XML editor** replaces `&lt;textarea&gt;` — needs syntax highlighting, bracket matching, auto-indent
3. **APIM policy XML intellisense** — element/attribute autocomplete from the policy schema (the OpenAPI schema for APIM policies is published; can be ingested into Monaco LSP)
4. **Policy expression intellisense** — `@(...)` C# expressions with `context.*` IntelliSense
5. **Snippet picker right rail** — categorized list of all built-in policies with insert-as-XML
6. **Form-view per snippet** — at minimum for the high-traffic policies (validate-jwt, rate-limit, set-header, cors, mock-response)
7. **Calculate effective policy** — recursive `&lt;base /&gt;` resolution from parent scopes; needs Loom to fetch all four scopes server-side and merge
8. **Test runner** — execute the policy against a simulated request, render trace per policy
9. **Server-side validation surfacing** — Loom currently surfaces the APIM error message but doesn't map it to a line/column in the editor; Monaco markers would fix this
10. **Scope path breadcrumb** — read-only header showing where you are (helps when navigating from an API/operation context)
11. **Policy reference docs hover** — link out to learn.microsoft.com policy reference per element on hover
12. **Default templates per scope** — Global vs Product vs API vs Operation each have different sensible defaults; today all four share one template
13. **`&lt;base /&gt;` lint** — Azure built-in policy requires every zone include `&lt;base /&gt;` to inherit; surface as a warning when missing

## Backend mapping

- **Primary backend = Azure APIM ARM REST** (already wired for service / API / Product):
  - Global: `PUT /service/{svc}/policies/policy?api-version=2024-06-01-preview` body `{ properties: { value: &lt;xml&gt;, format: 'xml' } }`
  - API: `PUT /service/{svc}/apis/{apiId}/policies/policy`
  - Operation: `PUT /service/{svc}/apis/{apiId}/operations/{operationId}/policies/policy` (UNWIRED — add to `lib/azure/apim-client.ts` `getPolicy`/`upsertPolicy` with a fourth scope kind)
  - Product: `PUT /service/{svc}/products/{productId}/policies/policy`
- **Format options**: `xml` (default) or `rawxml` (treats `&` as literal, not escape) or `xml-link`/`rawxml-link` (fetch from URL)
- **Effective policy calc**: no server-side ARM endpoint — Loom must `GET` all parent-scope policies and string-substitute `&lt;base /&gt;` in each zone (inbound/backend/outbound/on-error) walking up: operation → api → product (any product the op's API belongs to — choose one) → global
- **Schema for Monaco intellisense**: APIM publishes the policy XSD at `https://management.azure.com/...` (or use the public docs JSON). Cache locally in `lib/azure/apim-policy-schema.json` and feed into Monaco via the `monaco-yaml`-style XML language service
- **Test runner**: simplest path is to issue a real request to the gateway with `Ocp-Apim-Trace: true` and follow the `trace-location` header; alternative is APIM's preview `/policies/policy/$validateAndExecute` operation (not GA yet)

## Required Azure resources

- **Azure APIM** instance (already provisioned)
- **UAMI** with "API Management Service Contributor" (already granted)
- **Optional**: an Application Insights workspace if Loom surfaces the trace output natively — APIM already pipes traces there via the diagnostic setting
- **No new bicep** — policy XML is runtime data managed through ARM

## Estimated effort

3 sessions for B+ parity:
- Session 1: Add Operation scope to `apim-client` + BFF route; add scope=operation to the editor with API + Operation pickers (2 h)
- Session 2: Swap `&lt;textarea&gt;` for `@monaco-editor/react` with XML language + bracket pair colorization + format-on-save (2 h)
- Session 3: Snippet picker right rail with the top-20 built-in policies + form-view dialogs for validate-jwt / rate-limit / cors / set-header (4 h)

A+ parity (full intellisense from the policy XSD, `@(...)` expression intellisense, effective-policy calculator, test runner with trace) adds ~3 more sessions; this is the right time to invest because the policy editor is the highest-value surface in the APIM trio for governance / FedCiv compliance use cases.
