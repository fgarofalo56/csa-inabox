# data-product-consumer — parity with Purview Unified Catalog "data product" consumer view + request access

Source UI: Microsoft Purview Unified Catalog — data product details (consumer/read-only)
and "Request access" flow.
- https://learn.microsoft.com/purview/concept-data-products
- https://learn.microsoft.com/purview/how-to-request-access (request states: Pending, Approved, Declined, Completed)

This is the F15 consumer counterpart to the owner-side `data-product` editor
(`lib/editors/apim-editors.tsx`, `DataProductEditor`). It is **Azure/Cosmos-only**:
no Microsoft Fabric or Power BI workspace is required (per `no-fabric-dependency.md`).

## Azure/Purview feature inventory (consumer-facing)

| Capability | Purview Unified Catalog behavior |
|---|---|
| Discover a published data product | Browse catalog → open a data product the user does not own |
| Read-only details | Non-owner sees overview, datasets/data assets, glossary terms — no edit controls |
| Owner-edit controls hidden | Edit / publish / manage-policy actions are not shown to consumers |
| Request access | "Request access" opens a form bound to a **permitted purpose** (owner-defined usage purpose) |
| Permitted purpose selection | Dropdown lists only purposes the owner configured for this product (not freeform) |
| Justification | Optional free-text the requester supplies |
| Request lifecycle | Request created as **Pending**; owner approves/declines; completed once provisioned |
| My data access | Requester tracks their own requests + status |
| Approver inbox | Owner sees incoming requests for products they own |

## Loom coverage

| Inventory row | Status | Where |
|---|---|---|
| Discover/open a published product (non-owner) | built ✅ | `app/data-products/[id]/page.tsx`; governance catalog drawer "Open data product" button (`app/governance/catalog/page.tsx`) |
| Read-only details (overview/datasets/glossary) | built ✅ | `lib/editors/data-product-detail.tsx` (`DataProductDetailEditor`) — `Read-only` badge, no inputs / no Save |
| Owner-edit controls hidden | built ✅ | Detail view renders no ribbon/edit affordances; owner sees a "You own this product" badge and the Request-access CTA is disabled |
| Request access dialog | built ✅ | `lib/editors/components/request-access-dialog.tsx` (`RequestAccessDialog`) |
| Permitted-purpose dropdown (from owner policy) | built ✅ | `GET /api/data-products/[id]/policies` → Access-kind policies scoped `data-product:<id>` |
| Justification (optional) | built ✅ | dialog `Textarea` |
| Create Pending request | built ✅ | `POST /api/data-products/[id]/access-requests` → `access-requests` Cosmos doc, `status:'pending'` |
| My data access (T12) | built ✅ | `GET /api/data-products/[id]/access-requests` (caller's own); inline "My data access" tab in the detail view |
| Approver inbox data (T14) | built ✅ (data layer) | `GET /api/data-products/[id]/access-requests?role=approver` (owner-only, 403 otherwise). Dedicated owner-inbox page is the T14 surface. |
| No purposes configured | honest-gate ⚠️ | dialog shows a `MessageBar intent="warning"` and disables submit (owner must add an Access policy) |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---|---|
| Load product (read-only) | `GET /api/data-products/[id]` → Cosmos `items` (cross-partition id+itemType query; no owner gate) + `workspaces` to resolve `isOwner` |
| Permitted purposes | `GET /api/data-products/[id]/policies` → Cosmos `tenant-settings` `policies:<ownerOid>`, filtered to `kind:'Access'` + `scope:'data-product:<id>'` + `enabled` |
| Submit request | `POST /api/data-products/[id]/access-requests` → Cosmos `access-requests` (PK `/dataProductId`) `items.create` |
| My requests | `GET /api/data-products/[id]/access-requests` → Cosmos `access-requests` `WHERE c.dataProductId=@id AND c.requesterId=@oid` |
| Approver requests | `GET …?role=approver` → owner-verified, `WHERE c.dataProductId=@id` (single-partition) |

## No-Fabric / no-vaporware notes

- All state is in Cosmos; no `api.fabric.microsoft.com` / `api.powerbi.com` /
  `onelake.dfs.fabric` call on any path. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- The `access-requests` container is created lazily via `createIfNotExists` in
  `lib/azure/cosmos-client.ts` `ensure()` and listed in `KNOWN_CONTAINER_IDS` — no new
  Bicep param, env var, role assignment, or Azure resource is required.
- Tests: `app/api/data-products/__tests__/access-requests.test.ts` (13 cases — auth,
  validation, not-found, pending-write, purpose filtering, approver 403/owner-all).
