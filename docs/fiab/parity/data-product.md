# data-product — parity with Microsoft Purview Unified Catalog data product

Source UI: Purview Unified Catalog → Data products
(https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage),
Unified Catalog REST (https://learn.microsoft.com/rest/api/purview/unified-catalog-api-overview),
glossary terms (https://learn.microsoft.com/purview/unified-catalog-glossary-terms-create-manage).

## Purview feature inventory

| # | Capability | Purview surface |
|---|------------|-----------------|
| 1 | Product details (name, description, type, owner/contacts, SLA/terms) | data product details |
| 2 | Governance domain assignment (businessDomainId) | domain picker |
| 3 | Datasets / data assets mapped to the product | "Add data assets" |
| 4 | Glossary terms linked | Related → Add glossary term |
| 5 | Classifications on assets | asset classifications |
| 6 | Publish to catalog (Draft → Published) | Publish |
| 6b | Unpublish → Set to draft / Set to expired (expired restricts consumer visibility) | Unpublish ▾ |
| 7 | Access policies (request workflow, time limit, approvers) | Manage policies |
| 8 | Lineage of mapped assets | lineage graph |
| 9 | Publish as a consumable API (Weave edge → APIM) | n/a in Purview; Loom "Thread" edge — Azure-native APIM exposure |

## Loom coverage

| # | Status | Notes |
|---|--------|-------|
| 1 | built ✅ | form (displayName/description/owner/SLA/certified) |
| 2 | built ✅ | **Governance domain Dropdown** — GET `/api/catalog/domains` resolves label→businessDomainId GUID (the Phase-2 gap called out in register-purview is now closed; the disabled SLA/Owner/Semantic-schema ribbon buttons are REMOVED) |
| 3 | built ✅ | **Two surfaces.** (a) Datasets tab: register NEW Atlas entities via POST `/api/catalog/register`. (b) **Data assets tab (F9): curate EXISTING physical assets** — domain-scoped Data Map search + multi-select Add, per-row Remove (blocked while a DQ rule runs), caution icon for assets deleted from the Data Map. GET/POST/DELETE `/api/data-products/[id]/assets`. See `docs/fiab/parity/data-product-assets.md`. |
| 4 | built ✅ | Glossary tab: list/create terms (`/api/catalog/glossary`) and link to the product asset |
| 5 | built ✅ | Classifications field on the register-asset form (Atlas `classifications[]`) |
| 6 | built ✅ | Register/Re-register with Purview → POST `/register-purview` → real `POST /datagovernance/catalog/dataProducts` (2026-03-20-preview). Body is now spec-compliant: REQUIRED `id` (uuid) is minted/round-tripped, `status: DRAFT` (uppercase enum), `contacts` as a `ContactsMap` (`{ owner: [{id, description}] }`, owner sent only when it's an AAD oid GUID). Returns 200 with `dataProductId` **only** on real success and persists it to Cosmos so the gate clears; 422 when `state.domain` is missing/not a GUID; honest 501 hint when Purview unprovisioned; 4xx/502 on upstream failure. No fake-200 no-op. |
| 6b | built ✅ | **F6 lifecycle ribbon group** (Publish / Unpublish ▾ → Set to draft / Set to expired) + status Badge (Draft/Published/Expired). POST `/api/data-products/[id]/status`. Publish is GUARDED server-side on the three Purview preconditions (≥1 asset, an active Access policy scoped to the product, a set governance domain) and returns **422 with the precise `preconditionFailed.reason`** (`no_assets` / `no_active_policy` / `domain_not_published`), surfaced verbatim in a MessageBar. Cosmos (`state.lifecycleStatus`) is the authoritative store — fully functional with **no** Fabric/Power BI/unified-catalog dependency. Set-to-expired removes the product from the consumer discovery catalog (`/api/governance/catalog` filters `lifecycleStatus === 'EXPIRED'`). Purview unified-catalog `PUT .../dataProducts/{id}` status push is best-effort (honest gate on the classic account). |
| 7 | built ✅ | Access policies tab → GET/POST `/api/governance/policies` (kind=Access) — time limit + approvers |
| 8 | built ✅ | Lineage tab → GET `/api/catalog/lineage?source=purview&id=<guid>` rendered as a node/edge list |
| 9 | built ✅ | **Publish as API** ribbon + toolbar button → dialog captures the backing query endpoint → POST `/api/items/data-product/[id]/publish-api` creates a real APIM API + published product + active subscription and returns the callable URL + subscription key. API ref (`apimApiId`/`apimProductId`/`apimSubscriptionId`/`apimGatewayUrl`) persists to Cosmos; honest 503 gate when APIM env vars are unset. Gateway URL read live from ARM (`getServiceInfo().gatewayUrl`) — cloud-correct for Commercial/GCC/GCC-High/DoD. |

## Backend per control

- Product → Cosmos `state` + `registerDataProduct` (Unified Catalog `POST /datagovernance/catalog/dataProducts`, api-version 2026-03-20-preview, scope `https://purview.azure.net/.default`)
- Domains → `listBusinessDomains`
- Datasets/classifications → `registerAtlasEntity`
- Glossary → `createAtlasGlossaryTerm` / `applyGlossaryTerm`
- Lineage → `getLineageSubgraph`
- Access policies → Cosmos tenant-settings policies doc
- Lifecycle (F6) → Cosmos `state.lifecycleStatus` via `updateOwnedItem`; preconditions read `state.datasets`, the governance policies doc (kind=Access, scope `data-product:{id}`), and `state.domain`; consumer-visibility enforced in `/api/governance/catalog`; best-effort Purview push via `updateDataProductStatus` (honest gate).
- Publish as API → `upsertApi` + `upsertProduct(state:published)` + `addApiToProduct` + `createSubscription(state:active)` + `getSubscriptionKeys` (ARM `Microsoft.ApiManagement/service`, api-version 2024-06-01-preview; Console UAMI "API Management Service Contributor"). Honest gate: `apimConfigGate()` → 503 MessageBar naming the missing env var + `apim.bicep`.
- Honest gate: Purview unprovisioned → structured 501 hint MessageBar (env var + bicep module + roles).

## F3 — owner details page (`DataProductDetailEditor`)

The `data-product` route now opens a **read-first owner details page** (Azure-native
parity with the Purview Unified Catalog data-product *details* view), backed by the
dedicated `dataproducts` Cosmos container (NO Fabric/Purview dependency on the
default path). The full owner edit form (`DataProductEditor`, documented above) is
reached from there via `?view=edit` on the same route — "Edit" opens it, "Manage
policies" opens it on the policies tab (`&tab=policies`).

| # | Details-page capability | Status | Backend |
|---|-------------------------|--------|---------|
| 1 | Sticky header: name, status badge (Draft/Published/Expired), Endorsed badge, owner avatars, Edit | built ✅ | `GET /api/data-products/[id]` → `dataproducts` container |
| 2 | Description + Use case cards | built ✅ | same GET (real Cosmos fields) |
| 3 | Governance grid (domain / update-frequency / status / type) | built ✅ | same GET |
| 4 | Owner contacts with **editable** label inputs | built ✅ | `PATCH /api/data-products/[id]` `{ ownerLabels }` → Cosmos replace |
| 5 | Subscribers count + paginated list | built ✅ | `GET /api/data-products/[id]/subscribers?page&pageSize` → `access-requests` (approved) |
| 6 | Terms-of-use + Documentation link lists | built ✅ | same GET |
| 7 | DQ score gauge (real computed score) | built ✅ | DQ rules doc `dq-rules:<tenantId>`; honest-gate MessageBar when no rules |
| 8 | Health-action cards | built ✅ | derived from real DQ posture; deep-link to Admin › Data Quality Rules |
| 9 | Custom Attributes with **show-empty toggle** | built ✅ | `customAttributes[]` filtered client-side (real `useMemo`, not CSS hide) |
| 10 | Data Observability tab | honest-gate ⚠️ | placeholder pending dm-T16; MessageBar names `LOOM_KUSTO_ENDPOINT` + ADX `AllDatabasesViewer` role |

Backend per control: read = `dataproductsContainer()` / `accessRequestsContainer()` /
`tenantSettingsContainer()` (all clouds, SDK path via Console UAMI — no Fabric host on
the default path). Owner-label write = `dataproductsContainer().item(id, governanceDomainId).replace()`.
DQ score = `round(enabledRules / totalRules * 100)`; `null` → honest-gate, never a
fabricated number (per `no-vaporware.md`).

The Cosmos containers (`dataproducts`, `access-requests`, `governance-domains`,
`attribute-groups`) are created lazily by `cosmos-client.ts` `createIfNotExists` —
the sanctioned Cosmos init step per `no-vaporware.md` (same mechanism as every other
console container), so a fresh environment needs no extra ARM/Bicep step beyond the
account+database and works with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
