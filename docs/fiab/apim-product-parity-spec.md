# Loom APIM Product Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent. "APIM Product" = a bundle of APIs published as a single subscribable offering in Azure API Management: APIs included, product-scoped policies, subscription model (open vs approval), groups (visibility), and developer-portal presentation.

## Overview

An APIM Product is the marketplace-facing unit in Azure API Management. It groups one or more frontend APIs under a single subscription key (or no key for "open" products), with optional admin approval before activation, optional usage quotas / throttling enforced by a product-scope policy, and visibility scoped to one or more Groups (Administrators, Developers, Guests, or custom Entra-backed groups). Each Product has a lifecycle state — `notPublished` (admin-only, draft) or `published` (visible in the developer portal). Consumers subscribe to a Product, not to individual APIs, which is the canonical "data product / API product" pattern in the CSA API-first reference architecture.

## UI components (Azure portal)

### Header chrome
- Product display name + breadcrumb (APIM service → Products → this product)
- Tabs (left rail): **Settings** · **APIs** · **Policies** · **Subscriptions** · **Access control** · **Change log**
- State badge: "Published" (green) or "Not published" (grey)
- Buttons: Save · Discard changes · Delete

### Settings tab
- Display name · Name (id) · Description (Markdown, shown in developer portal)
- **Published** toggle (notPublished ↔ published)
- **Requires subscription** toggle — when off, the product is "open" and needs no key
- **Requires approval** toggle — enabled only when subscription is required; turns subscription requests into a manual admin queue
- **Subscription count limit** — max number of subscriptions per developer (or unlimited)
- **Legal terms** — markdown shown at subscribe time; subscriber must accept

### APIs tab
- Searchable list of APIs already attached to this product (display name + version + path)
- **+ Add** button → multi-select dialog of all APIs in the service, filterable by tag / version-set
- Remove (×) button per row
- Drag-reorder for developer-portal display order

### Policies tab
- Single policy XML document scoped at product (applies to every API call routed through any API in this product)
- Inbound / Backend / Outbound / On-error zones with `<base />` inheritance from the global service-scope policy
- Code-view (Monaco XML) ↔ form-view toggle
- "+ Add policy" snippet picker (rate-limit-by-key, quota-by-key, validate-jwt, set-header, etc.)
- Test box that validates well-formed XML and known policy expression compilation

### Subscriptions tab
- Table of active subscriptions: id, name, owner (developer email), state (active/submitted/cancelled/expired/rejected/suspended), created, expires
- Row actions: Activate · Cancel · Suspend · Regenerate primary/secondary key · Show keys
- **+ Add subscription** to issue a key on behalf of a developer or app

### Access control tab
- Group bindings — which Groups can see this product in the developer portal (Administrators / Developers / Guests / custom Entra group)
- Multi-select chip picker

### Change log tab
- Optional admin notes appended on every Publish / Unpublish — visible in the developer portal

## What Loom has

- `apps/fiab-console/lib/editors/apim-editors.tsx` lines 316-416: `ApimProductEditor`
- Live ARM-REST wired via `lib/azure/apim-client.ts` (`Microsoft.ApiManagement/service/{name}/products/{id}`)
- BFF route: `GET/PUT /api/items/apim-product/[id]` — load / upsert product metadata; also `POST /api/items/apim-product` used by `DataProductEditor` for idempotent publish
- Form fields: `displayName`, `description`, `state` (`published` | `notPublished`), `subscriptionRequired`, `approvalRequired` (disabled when subscription off)
- Status badges in chrome: product name + state color (success green for published)
- Ribbon: Save · Reload · Publish · Unpublish (last two without explicit handlers — Save with `state=published` is the path)
- **Grade: B-** — real ARM CRUD on the product entity + correct dependency between subscription/approval toggles. No APIs membership UI, no product-scope policy in this editor (lives in ApimPolicyEditor at scope=product), no subscriptions list, no group access control, no subscription-count-limit / legal-terms fields, no change-log.

## Gaps for parity

1. **APIs membership** — no UI to add/remove APIs in this product; `Microsoft.ApiManagement/service/products/{pid}/apis/{aid}` PUT/DELETE unwired
2. **Product-scope policy inline** — lives in a separate `ApimPolicyEditor` (scope=product); portal exposes it as a tab on the product itself
3. **Subscriptions list** — no surface; `Microsoft.ApiManagement/service/subscriptions?$filter=properties/scope eq '/products/{pid}'` unwired
4. **Per-subscription actions** — no activate / cancel / suspend / regenerate-key / show-keys
5. **Issue subscription on behalf of dev** — no "+ Add subscription" flow
6. **Group access control** — `products/{pid}/groups/{gid}` PUT/DELETE unwired; no group picker
7. **Subscription count limit** — `subscriptionsLimit` field not exposed
8. **Legal terms** — `terms` markdown field not exposed
9. **Drag-reorder of APIs** — N/A until APIs membership ships
10. **Change-log notes per publish event** — no append-only history
11. **Markdown preview** for description — Loom uses a plain `<textarea>`; portal renders Markdown in the developer portal preview
12. **Lifecycle confirm dialogs** — Publish/Unpublish currently happen silently on Save; portal asks for confirmation and lets the admin add a change-log note in the same flow

## Backend mapping

- **Primary backend = Azure APIM ARM REST** (already wired for the product entity):
  - Product entity: `PUT .../service/{svc}/products/{productId}?api-version=2024-06-01-preview` body `{ properties: { displayName, description, state, subscriptionRequired, approvalRequired, subscriptionsLimit, terms } }`
  - APIs membership: `PUT .../service/{svc}/products/{productId}/apis/{apiId}` (no body needed) / `DELETE` same path
  - Product policy: `PUT .../service/{svc}/products/{productId}/policies/policy` body `{ properties: { value: <xml>, format: 'xml' } }`
  - Subscriptions: `GET .../service/{svc}/subscriptions?$filter=properties/scope eq '/subscriptions/.../products/{productId}'`
  - Subscription actions: `POST .../subscriptions/{sid}/regeneratePrimaryKey`, `regenerateSecondaryKey`, `listSecrets`; state changes via `PATCH` on `properties.state`
  - Issue subscription: `PUT .../service/{svc}/subscriptions/{sid}` with `ownerId` (user) + `scope` (product resource id)
  - Groups: `PUT .../service/{svc}/products/{productId}/groups/{groupId}`
- **Markdown preview** can use the existing react-markdown helper used elsewhere in the console (no new dep needed).
- **Subscription owner picker** = APIM `users` collection (`GET .../service/{svc}/users`), filterable by name/email; tie into the existing Entra people-picker pattern from CopilotStudio editors for "on behalf of" workflows.

## Required Azure resources

- **Azure APIM** instance (already provisioned)
- **UAMI** with "API Management Service Contributor" (already granted)
- **Entra groups** (optional) — only if custom group access control is exercised; default Administrators/Developers/Guests work out of the box
- **No new bicep** — Product is a runtime entity managed through ARM, not a deployed resource. The `apim` bicep module deploys the service; products/subscriptions are user-data.

## Estimated effort

2-3 sessions for B+ parity:
- Session 1: APIs membership tab — multi-select dialog reusing the existing `GET /api/items/apim-api` list endpoint + PUT/DELETE wiring (2 h)
- Session 2: Subscriptions list + per-row actions (activate/cancel/suspend/regenerate-key) (3 h)
- Session 3: Group access control + subscription-count-limit + legal-terms markdown field + markdown preview (2 h)

A+ parity (publish/unpublish dialog with change-log note, issue-subscription-on-behalf-of flow, inline product-scope policy editor folded back into this editor) adds ~1 more session; defer until ApimApiEditor and ApimPolicyEditor both reach B+ so the trio can land together.
