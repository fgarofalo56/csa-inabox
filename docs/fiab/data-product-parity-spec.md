# Loom Data Product Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent. "Data Product" = the Microsoft Purview Unified Catalog construct (also surfaced through Fabric's OneLake Catalog) for a published, certified data asset with discovery, owner, access requests, lineage, tags, data dictionary, and usage analytics. Scoped to a Governance Domain. Lifecycle: Draft → Published → (Unpublished | Expired).

## Overview

A Purview Unified Catalog Data Product is the business-facing wrapper around one or more underlying data assets (Lakehouse tables, Warehouse views, KQL DBs, Mirrored DBs, Power BI semantic models, etc.). The owner curates a name, description, use case, audience, type (dataset/report/model/dashboard/master-data/operational/reference/other), governance domain, glossary terms, custom attributes, data assets included, and an access policy. After Purview's optional approval workflow, the data product becomes Published and visible to all users within the configured discoverability scope. Consumers browse the catalog, see the endorsement / certification badges, view lineage, request access (which triggers the access-policy workflow), and the platform tracks usage analytics per product. This is the only managed-discovery layer Microsoft ships for cross-Fabric data sharing.

## UI components (Purview portal + Fabric OneLake Catalog)

### Catalog browse (Unified Catalog landing)
- Search bar with full-text + filter pivots (governance domain, type, owner, endorsement, certification, sensitivity label, custom attribute)
- Grid / list toggle of data product cards
- Per-card chips: type, governance domain, owner avatar, endorsement badge (Promoted / Certified), Use case excerpt
- Faceted left nav by governance domain hierarchy

### Data product detail page
- Header: display name, governance domain breadcrumb, endorsement badge, last-updated timestamp
- Tabs: **Overview · Data assets · Lineage · Quality · Access policy · Subscriptions · Activity**
- Header buttons (owner/steward only): Edit · Publish / Unpublish · Manage policies · Delete

### Overview tab
- Description (rich text / Markdown)
- Use case (the "what this is for" narrative)
- Audience dropdown (e.g., Business users / Data analysts / Data scientists / Engineering)
- Owner + additional owners (Entra people picker)
- Glossary terms (linked from the same governance domain)
- Custom attributes (admin-defined schema per business concept)
- Tags (free-form + Fabric tags)
- Endorsement: **Mark as Endorsed** checkbox; Certified state set by data steward at publish time

### Data assets tab
- Table of attached assets: source platform (Fabric Lakehouse / Warehouse / KQL / Power BI / ADLS / S3 / etc.), asset name, asset type (table/view/file/report/model), qualified name, schema-link
- **+ Add asset** → asset picker that searches the Purview Data Map
- Per-asset data dictionary view: column name, data type, description, classification (PII / PHI / etc.), business glossary mapping
- Sample data preview (when permissions allow)

### Lineage tab
- Directed-graph view (upstream sources → this data product → downstream consumers)
- Per-node click → asset detail in Data Map
- Hop expansion (load on demand)

### Quality tab
- Data Quality scores per attached asset (Completeness, Uniqueness, Validity, Timeliness, etc.)
- Rule violations list + history
- Backed by Purview's Data Quality API for Unified Catalog (preview)

### Access policy tab
- Policy type: Auto-approve · Approval workflow (with named approvers) · Closed (no requests)
- Effective principals (Entra users/groups currently approved)
- Per-request audit trail
- "Request access" CTA visible to non-approved viewers; opens a form with justification

### Subscriptions tab
- Active subscriptions (who has approved access, expiry if time-bound)
- Pending requests queue (for stewards/owners)

### Activity / Usage analytics tab
- Views per day, unique viewers, access requests opened/approved/rejected, top queries, top consumers (Power BI semantic model usage, Fabric SQL endpoint hits)
- Backed by Purview Live View + Fabric capacity metrics

### Workflows
- "Catalog curation publish" workflow gates the Draft → Published transition with multi-approver routing (configured in Unified Catalog → Process automation → Workflows)
- Term-publish and access-subscription workflows are sibling artifacts

## What Loom has

- Two distinct editors registered in `apps/fiab-console/lib/editors/registry.ts`:
  - `data-product` → `DataProductEditor` (in `apim-editors.tsx` lines 568-627)
  - `data-product-template` + `data-product-instance` → `DataProductTemplateEditor` / `DataProductInstanceEditor` (in `data-product-editors.tsx`, real BFF wired to `/api/items/data-product-template/[slug]/instantiate`)
- **`data-product` editor (this spec's primary target)**:
  - Hardcoded sample state — `productId = 'customer-360'`, `displayName = 'Customer 360'`, owner badge `'alice@contoso'`, certification badge "Certified", and a fixed 6-item bundle grid (`'Dataset: silver_revenue (Delta)'`, etc.)
  - The only real backend call is the **Publish to APIM** button which `POST /api/items/apim-product` to create an APIM Product with the hardcoded id/displayName/description — this is real, but it's an APIM Product, not a Purview Data Product
  - No GET — nothing is loaded; the editor is the same regardless of `id`
- No BFF route at `/api/items/data-product` exists
- No `lib/azure/purview-client.ts` exists; the Unified Catalog Data Plane REST is unwired
- **Grade: F (Vaporware)** under `no-vaporware.md`: hardcoded `'alice@contoso'`, hardcoded bundle list, fixed `displayName`, fixed `description`, no read from any backend. Must be either gated with a MessageBar or rewritten end-to-end before next release.
- The sibling `data-product-template` editor is **B** — real curated template list + real instantiate-into-workspace POST.

## Gaps for parity

1. **VAPORWARE GATE FIRST** — per `no-vaporware.md`, replace the hardcoded `Customer 360` / `alice@contoso` / `Certified` / 6-item bundle with either real Purview-loaded state or a Fluent MessageBar `intent="warning"` listing the exact missing env vars (`LOOM_PURVIEW_ACCOUNT`, `LOOM_PURVIEW_DOMAIN_ID`) and the bicep module that would deploy Purview
2. **No GET** — wire `GET /api/items/data-product/[id]` to Purview Unified Catalog `dataProducts/{id}` and hydrate the form
3. **No PUT/PATCH** — wire upsert through Unified Catalog `dataProducts` create/update
4. **No governance-domain picker** — required field; needs `GET /governanceDomains` and a Dropdown
5. **No type field** — Dataset / Report / Model / Dashboard / Master Data / Operational / Reference / Other
6. **No audience field**
7. **No real owner picker** — replace `alice@contoso` badge with an Entra people-picker that writes to `owners[]`
8. **No glossary terms picker** — `GET /governanceDomains/{id}/glossaryTerms` + multi-select chips
9. **No custom attributes form** — admin-defined per domain
10. **No data assets attach** — `dataProducts/{id}/dataAssets` PUT/DELETE unwired; needs asset picker against the Purview Data Map
11. **No data dictionary view** — column-level schema render from each attached asset
12. **No lineage graph** — Purview lineage API exists (`/lineage/{guid}`); needs a graph renderer (re-use the React-Flow layer from `geo-editors`)
13. **No quality scores** — Data Quality API for Unified Catalog (Public Preview 2025-12) is unwired
14. **No access policy editor** — auto-approve / approval / closed + approvers + requesters surface
15. **No subscriptions list / pending requests queue**
16. **No usage analytics tab**
17. **No publish / unpublish lifecycle** — Loom's "Publish to APIM" is a side door that creates an APIM Product, not a Purview-published data product (these are different artifacts and shouldn't be conflated)
18. **No endorsement / certification model** — today it's a static "Certified" badge; needs to mirror Purview's two-state model
19. **No workflow integration** — Catalog Curation publish workflow approvals not surfaced
20. **No Fabric tags** — `tags` not exposed
21. **Bicep gap** — no `purview` module in `platform/fiab/bicep/modules/`; Purview account provisioning + role assignments (Data Curator, Data Reader, Data Product Owner) absent

## Backend mapping

- **Primary backend = Microsoft Purview Unified Catalog Data Plane REST** (preview):
  - Base: `https://{purview-account}.purview.azure.com/`
  - Data products: `GET/POST/PATCH /datagovernance/catalog/dataProducts?api-version=2026-03-20-preview`
  - Governance domains: `GET /datagovernance/catalog/businessdomains`
  - Glossary terms: `GET /datagovernance/catalog/terms`
  - Data assets attach: `PUT /dataProducts/{id}/dataAssets/{assetId}`
  - Access policies: `/dataProducts/{id}/policies` collection
  - Data quality scores: `/dataquality/scores?dataProductId={id}` (preview from Dec 2025)
  - Auth: `https://purview.azure.net/.default` ARM-style scope; Loom UAMI needs **Data Curator** + **Data Product Owner** role at the governance-domain level (granted via Purview portal — there is no ARM RBAC for these roles)
- **Data Map lineage**: `GET /catalog/api/atlas/v2/lineage/{guid}` (Atlas 2.2)
- **Fabric OneLake Catalog publish** (alternative to Purview-only): the same Data Product surfaces in Fabric via the OneLake Catalog if the Purview account is wired to the Fabric tenant; no separate API
- **Workflows**: `/datagovernance/workflows` REST collection — list, get, approve/reject
- **Add `lib/azure/purview-client.ts`** mirroring the structure of `apim-client.ts` (ChainedTokenCredential, env-driven account name, error class with status + body, 404 → null)
- **Add `app/api/items/data-product/[id]/route.ts`** with GET/PUT/DELETE
- **Keep the existing `data-product-template` / `data-product-instance` editors as-is** — they solve a different problem (push-button CSA-curated bundles) and are already B-grade; do not merge

## Required Azure resources

- **Microsoft Purview account** — not currently in any FiaB bicep template; add `platform/fiab/bicep/modules/purview/purview.bicep` deploying `Microsoft.Purview/accounts` with managed identity + diagnostic settings + Atlas Kafka endpoint
- **Purview Data Curator + Data Product Owner roles** at the governance-domain level for the Loom UAMI — must be granted through the Purview portal because these are data-plane roles (no ARM RoleAssignment); document in `docs/fiab/v3-tenant-bootstrap.md` and add to `scripts/csa-loom/grant-purview-rbac.sh`
- **Governance domain** seeded by the bootstrap script (one per Loom deployment, named `csa-loom-default`) so the editor has a default `domainId`
- **Env vars added to `apps[]` in `admin-plane/main.bicep`**: `LOOM_PURVIEW_ACCOUNT`, `LOOM_PURVIEW_DOMAIN_ID`
- **App registration** with `Microsoft Purview` API permission (`UserProfile.Read`) for the access-request flow

## Estimated effort

5-6 sessions for B+ parity (and to clear the F-grade vaporware tag):
- Session 1: **Vaporware gate** — drop hardcoded state, add MessageBar listing missing env vars + link to bicep module (1 h)
- Session 2: `lib/azure/purview-client.ts` + `GET /api/items/data-product/[id]` + governance-domain Dropdown + basic Overview form (3 h)
- Session 3: PUT/PATCH + publish/unpublish lifecycle + endorsement toggle + Catalog-curation workflow surfacing (3 h)
- Session 4: Data assets attach tab with Purview Data Map picker + data dictionary render (4 h)
- Session 5: Lineage graph (React-Flow) + Access policy editor with approvers (4 h)
- Session 6: Bicep purview module + RBAC script + tenant-bootstrap doc updates (3 h)

A+ parity (subscriptions queue, usage analytics, data quality scores, Atlas-2.2-driven cross-cloud lineage, workflow approval UI) adds ~4 more sessions; defer to v4.x. This is the highest-impact unfinished editor in the catalog — once it's B+, the FiaB "Data sharing" pillar story closes.
