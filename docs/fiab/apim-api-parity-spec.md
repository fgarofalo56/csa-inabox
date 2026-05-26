# Loom APIM API Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent. "APIM API" = a single frontend API surface inside an Azure API Management service: design canvas (operations + schemas), frontend/backend wiring, settings (subscription, protocols, tags, products), policy editor entry point, test console, and revisions/versions lifecycle.

## Overview

An APIM API is the unit of API publication in Azure API Management. It binds a frontend contract (the operations consumers see) to a backend (the URL the gateway forwards to), with an attached policy XML that handles auth, transforms, rate limits, caching, and observability. Each API can be added to one or more Products (subscription bundles), versioned (breaking changes) and revisioned (non-breaking changes safe-swap), and tested directly from the portal via a built-in CORS-proxied test console. The Azure portal "Design" tab is the canvas — operation list on the left, request/response designer in the middle, settings/policy/test tabs across the top.

## UI components (Azure portal)

### Header chrome
- API display name + breadcrumb (APIM service → APIs → this API)
- Tabs: **Design** · **Settings** · **Test** · **Revisions** · **Change log**
- Revision selector dropdown (top-left of Design tab) — switches the working copy
- Frontend/backend toggle at top of Design
- Three-dot context menu: Add revision · Create version from revision · Make current · Take offline · Delete · Export

### Design tab (canvas)
- **Operations list** (left rail): grouped + searchable, each row showing HTTP verb badge + URL template + display name
- **+ Add operation** button → form with verb, display name, name, URL template, description
- **Frontend** sub-tabs per operation: Request (query/template/header params, body, examples) · Responses (status codes, schemas, representations)
- **Backend** sub-tabs per operation: Backend HTTP request (URL rewrite, query, headers, body), Backend HTTP response
- **Inbound / Outbound / Backend / On-error** policy zones — each with a code-view / form-view toggle and a "+ Add policy" snippet picker
- **OpenAPI** import/export buttons in the header (json/yaml, swagger/openapi 3.0/3.1, WSDL for SOAP, GraphQL SDL)

### Settings tab
- Display name · Name (id) · Description · Web service URL (backend base) · URL scheme (https/http/ws/wss)
- API URL suffix (path)
- Tags · Products (multi-select chips)
- Subscription required (toggle) · Subscription key header name · Subscription key query param name
- Gateways (which self-hosted/regional gateways serve this API)

### Test tab (test console)
- Operation picker (mirrors left rail)
- Auto-populated `Ocp-Apim-Subscription-Key` header (uses all-access subscription)
- Param fields generated from the schema
- Headers list with add/remove
- Request body editor (Monaco JSON/XML)
- **Send** button — calls APIM's CORS proxy by default; "Bypass CORS proxy" toggle for network-isolated services
- Response pane: status, headers, body (pretty/raw), trace toggle (Ocp-Apim-Trace) opening the full inspector

### Revisions tab
- Table of revisions (number, description, created, updated, is-current, is-online, URL suffix `;rev=N`)
- **+ Add revision** → fork the current API into a sandbox copy
- Per-row context menu: Make current (with optional change-log note posted to the developer portal) · Take offline · Delete · Create version from this revision

### Change log tab
- Public, developer-portal-visible list of change-log notes per make-current event

## What Loom has

- `apps/fiab-console/lib/editors/apim-editors.tsx` lines 82-293: `ApimApiEditor`
- Live ARM-REST wired via `lib/azure/apim-client.ts` (`Microsoft.ApiManagement/service/{name}/apis/{id}`, api-version `2024-06-01-preview`); UAMI auth (`LOOM_UAMI_CLIENT_ID`) with `DefaultAzureCredential` dev fallback, role: "API Management Service Contributor"
- BFF routes wired:
  - `GET/PUT/DELETE /api/items/apim-api/[id]` — upsert API metadata
  - `GET /api/items/apim-api/[id]/operations` — list operations
  - `GET /api/items/apim-api/[id]/spec?format=openapi+json` — export spec
- Form fields: `displayName`, `path`, `protocols[]` (https/http/ws/wss switches), `subscriptionRequired`, `serviceUrl`
- Left pane: operations Tree (read-only) with method + urlTemplate + displayName
- Read-only OpenAPI viewer pane with Copy + Refresh buttons
- Ribbon: Save · Reload · Edit OpenAPI (no handler) · Copy spec · Open policy editor (no handler)
- **Grade: B-** — real ARM CRUD on the API entity + real operations list + real spec export. No operation create/edit, no policy-zone editing in this view, no test console, no revisions UI.

## Gaps for parity

1. **Operation CRUD** — Loom can list operations but cannot create/edit/delete them; no per-operation `Microsoft.ApiManagement/service/apis/operations` PUT wired
2. **Request/response schema designer** — no UI for query/template/header params, request body schemas, response status codes & representations
3. **Frontend vs backend split per operation** — single flat view; APIM portal has explicit Frontend / Backend pivot with URL rewrites
4. **Inbound/Outbound/Backend/On-error policy zones inline** — Loom routes to a separate ApimPolicyEditor; portal exposes the four zones with form-view / code-view toggle on the Design canvas
5. **Test console** — no Send button, no CORS-proxy call, no request trace, no per-op param form generation
6. **Revisions tab** — no list, no "+ Add revision", no Make-current, no Take-offline, no change-log post; ARM endpoints `apis/{id};rev=N` and `apiReleases` unwired
7. **Versions UI** — no version-set picker, no "Create version from revision"
8. **OpenAPI import** — Loom only exports spec; portal lets you re-import to replace operations
9. **Products membership** — no UI to add this API to one or more Products (`Microsoft.ApiManagement/service/products/apis` PUT unwired)
10. **Tags** — `apis/{id}/tags` association not surfaced
11. **Gateways binding** — no self-hosted gateway picker
12. **Developer-portal change log** — no surface for the publicly visible change-log notes
13. **Backend resource picker** — no UI to bind to a registered `backends` entity (named backend with credentials, circuit breakers); free-text serviceUrl only

## Backend mapping

- **Primary backend = Azure APIM ARM REST** (already wired):
  - API entity: `PUT /subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.ApiManagement/service/{svc}/apis/{apiId}?api-version=2024-06-01-preview`
  - Operations: `PUT .../apis/{apiId}/operations/{operationId}`
  - Policy (API scope): `PUT .../apis/{apiId}/policies/policy` body `{ properties: { value: <xml>, format: 'xml' } }`
  - Operation policy: `PUT .../apis/{apiId}/operations/{operationId}/policies/policy`
  - Revisions: `PUT .../apis/{apiId};rev={n}` to create; `PUT .../apis/{apiId}/releases/{releaseId}` to make current with `notes`
  - Versions: `PUT .../apis/{apiId}` with `apiVersionSetId` + `apiVersion`; manage sets via `apiVersionSets/{setId}`
  - Spec import: `PUT .../apis/{apiId}?import=true` with `format: openapi+json-link | openapi+json | swagger-link-json | wsdl-link | graphql-link` and `value`
  - Products: `PUT .../products/{productId}/apis/{apiId}`
  - Tags: `PUT .../apis/{apiId}/tags/{tagId}`
- **Test console** = a Loom-side proxy that takes the editor's request, prepends the gateway hostname + `Ocp-Apim-Subscription-Key` from the all-access subscription (lookup `subscriptions/master/listSecrets`), forwards to APIM, and streams the response back. Trace can use the `Ocp-Apim-Trace: true` header + trace location follow-up.
- **All policy XML stays in the existing ApimPolicyEditor** — link both editors via a cross-link button so they share scope context.

## Required Azure resources

- **Azure APIM** instance (`apim-csa-loom-eastus2`, RG `rg-csa-loom-admin-eastus2`) — already provisioned in v1.9
- **UAMI `loom-console-uami`** — already provisioned with "API Management Service Contributor" via `scripts/csa-loom/grant-apim-rbac.sh`
- **App reg** (Entra) — only needed if the test console exercises OAuth-protected backend flows on behalf of the caller
- **Storage** — none required beyond existing Cosmos `items` for caching editor draft state
- **For Bicep parity** (no-vaporware rule): every change above must be reflected in `platform/fiab/bicep/modules/apim/*.bicep` — the apim module already deploys the service; revisions/operations are managed at runtime through ARM, not bicep

## Estimated effort

3-4 sessions for B+ parity:
- Session 1: Operation CRUD — operations PUT/DELETE route + side panel form (method, urlTemplate, params, request/response schemas) (3 h)
- Session 2: Test console — proxy route `/api/items/apim-api/[id]/operations/[opId]/test` + Monaco request editor + response pane with trace toggle (4 h)
- Session 3: Revisions tab — list/create/make-current/take-offline + change-log note input (3 h)
- Session 4: Products + tags membership pickers + OpenAPI import dialog (2 h)

A+ parity (visual policy-zone designer with form-view, gateway binding, backend resource picker, developer-portal change-log) adds ~2 more sessions; defer to v4.x once the trio (API/Product/Policy) editors all reach B+.
