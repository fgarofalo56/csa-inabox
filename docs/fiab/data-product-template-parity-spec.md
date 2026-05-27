# Loom Data Product Template Editor — Fabric-parity spec

> Captured 2026-05-26 by catalog agent. Sources: Microsoft Learn — [Create and manage data products (Purview Unified Catalog)](https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage), [Sample setup for data governance](https://learn.microsoft.com/purview/data-governance-setup-sample), [Get started with Microsoft Purview data governance](https://learn.microsoft.com/purview/data-governance-get-started), [Use Microsoft Purview to govern Microsoft Fabric](https://learn.microsoft.com/fabric/governance/microsoft-purview-fabric), [OneLake catalog overview](https://learn.microsoft.com/fabric/governance/onelake-catalog-overview), [Store data in Microsoft Fabric](https://learn.microsoft.com/fabric/fundamentals/store-data), [Unified Catalog data product access policies](https://learn.microsoft.com/purview/unified-catalog-data-product-access-policies). Cross-checked against current Loom editor at `apps/fiab-console/lib/editors/data-product-editors.tsx::DataProductTemplateEditor`, the curated catalog in `apps/fiab-console/lib/catalog/data-product-templates.ts`, and the instantiate route at `app/api/items/data-product-template/[id]/instantiate/route.ts`.

## What it is

There is **no Microsoft service explicitly called "Data Product Template"**. The closest Microsoft concepts are:

1. **Microsoft Purview Unified Catalog data products** — a Purview-governed entry in a Governance Domain that bundles data assets, business context, and access policies. Created individually OR in bulk via CSV import (preview). Has a lifecycle: draft → published → expired. Required role: **Data Product Owner**.
2. **Fabric OneLake catalog** — the discovery surface inside Fabric where workspace items + data products are browsed.
3. **CSA-curated push-button templates** — a Loom-original concept (not a Microsoft product). A Loom template lists a set of component item types (lakehouse, pipeline, eventhouse, vector-store, etc.) and a one-click **Instantiate** flow that creates each as a real Loom item in a workspace, then links them under a parent `data-product-instance`. This editor is the **template author / catalog browser** for that pattern.

The Fabric-parity target is therefore the **Purview Unified Catalog data product creation + governance-domain UX** combined with Loom's existing curated push-button template gallery.

## UI components

### Page chrome
- Title bar: catalog name + saved-state indicator
- Top toolbar: **Browse library**, **+ New template**, **Import CSV** (bulk template authoring), **Refresh**

### Library grid (Browse mode)
- Card grid; each card shows:
  - Template display name
  - Category badge (Lakehouse / Streaming / Mesh / AI-RAG / IoT / Geospatial)
  - Estimated monthly cost (USD)
  - Description (1-2 lines)
  - Component count
  - **Endorsed** ribbon (when marked)
- Filters: category, cost band, owner, endorsement status
- Search box (over display name, description, component slugs)

### Template detail page (selected mode)
- **Basic details**: name, description (up to 10,000 chars per Purview), type (Master/Reference/Dataset/Operational/Analytics/Dashboard-Report), audience (optional), owner(s) — matching the Purview data product creation form
- **Business details**: governance domain assignment, use case (narrative of how a consumer applies the data), endorsement toggle (**Mark as Endorsed**)
- **Components table**: per-component row with label, item-type slug, description, default state (read-only JSON expander)
- **Custom attributes**: per-template custom-attribute editor (parity with Purview's Custom Attributes per-business-concept config)
- **Access policy preview**: shows the inherited governance-domain policy + any template-specific overrides (access-time limit, approval requirements, manager-approval flag, data-copy-attestation)
- **References / Learn links** rendered as a side panel

### Instantiate dialog (per template)
- **Target workspace** picker (queries Loom's `/api/workspaces` for the signed-in user's workspaces)
- **Instance display name** input
- **Override component defaults** expandable table (per-component, override any `defaultState` key) — currently absent in Loom
- **Pre-flight check**: required Azure resources for this template + RBAC the user must hold; renders a `MessageBar` listing any missing capabilities
- **Cost estimate banner**: rough USD/month from the template plus a "this is order-of-magnitude only" disclaimer
- **Spawn into workspace** button — primary action; disabled until workspace + name are set

### Template author / edit mode (admin-only)
- Same form fields as detail page but editable
- **Add component** dialog: item-type picker, label, description, `defaultState` JSON editor
- **Reorder components** drag-handle
- **Bulk import** flyout — download sample CSV, fill out per the documented Purview CSV schema, re-upload (templates land in draft state)
- **Publish** / **Unpublish (set to draft)** / **Set to expired** buttons mirroring the Purview state machine

### Governance domain context (left rail)
- Tree of Governance Domains (queried from Purview) → templates assigned to each domain
- Per-domain header: data-product-owner names, glossary terms inherited, default access policy summary

## What Loom has

The current `DataProductTemplateEditor` (`apps/fiab-console/lib/editors/data-product-editors.tsx`, lines 44-155) is partially functional:

- GET against `/api/items/data-product-template` returns the in-memory `CURATED_TEMPLATES` array (8 templates: modern-data-warehouse, lambda, kappa, medallion-on-databricks, iot-analytics, federated-mesh, rag-agent-platform, geospatial-pipeline) plus any custom workspace-scoped templates from Cosmos
- Library grid renders per-card with display name, category, est. cost, description, component count
- Click card → detail view with components table + back button
- Workspace + display-name inputs + **Instantiate in workspace** button POSTs to `/api/items/data-product-template/[id]/instantiate`
- Instantiate route walks `template.components[]` and calls `createOwnedItem` per component, then creates a parent `data-product-instance` linking them
- Result MessageBar shows created count + failure count
- Ribbon advertises **Browse**, **Refresh**, **Spawn into workspace** — partially wired
- Cosmos persistence of any custom (non-curated) template via the generic owned-item path
- Grade: **B (production-grade)** — the instantiate happy path actually runs end-to-end against real Loom items; this is the strongest of the seven editors in this batch

## Gaps for parity

1. **Purview governance-domain linkage absent** — Purview requires a data product to live inside a published governance domain; Loom templates have no domain field, no domain-tree left rail, no domain-publish gating.
2. **Data Product Owner RBAC absent** — Purview enforces the Data Product Owner role for create/edit/publish; Loom uses the generic owned-item ACL.
3. **Lifecycle state machine absent** — Purview has draft → published → expired with **Publish / Unpublish / Set to Draft / Set to Expired** actions; Loom templates are always "live".
4. **Bulk CSV import absent** — Purview ships sample CSV download + 1000-row max bulk import; Loom doesn't.
5. **Custom attributes absent** — Purview's per-business-concept custom attributes (admin-configurable) are not modeled.
6. **Access policy editor absent** — the Purview **Manage policies** flyout (access-time limit, approval requirements, manager approval, data-copy attestation) is missing. This is *the* high-value gap because access governance is the whole point of Purview data products.
7. **Endorsement toggle absent** — **Mark as Endorsed** is a one-click promotion in Purview; not in Loom.
8. **Override component defaults at instantiate-time absent** — the user gets workspace + name only; the component table is read-only. For real-world use, overriding a component's region, SKU, or path is essential.
9. **Pre-flight check absent** — no RBAC / capability check before spawning; instantiate either succeeds or returns per-component errors after partial provisioning.
10. **Description-length limit (10,000 chars per Purview) not enforced** — Loom templates take any length.
11. **Cost estimate is a static field** — Purview doesn't have this; Loom invented it. Should be relabeled "Indicative cost — confirm in Azure Cost Management" to avoid implying SLA-quality estimation.
12. **No "share to OneLake catalog" handoff** — when Loom spawns Fabric items (lakehouse, eventhouse, etc.), the spawned items should also surface in the OneLake catalog with the Purview sensitivity labels from the template; Loom currently does neither.
13. **No glossary-term linkage** — Purview data products link to glossary terms which inherit policies; Loom has no glossary surface.
14. **Audience field absent** — Purview's Audience dropdown is documented; Loom doesn't capture it.

## Backend mapping

| Loom surface | Backing service | Notes |
|---|---|---|
| Curated template catalog | In-memory `CURATED_TEMPLATES` array in `lib/catalog/data-product-templates.ts` | Already wired; add new templates by appending to the array |
| Custom template persistence | Cosmos `items` container, partition `data-product-template` | Already wired |
| Template instantiation | Existing `/api/items/data-product-template/[id]/instantiate` walks components and calls `createOwnedItem` per component slug | Each child item type already has its own bicep + BFF wiring |
| Governance-domain linkage | **Purview REST**: `GET /datagovernance/catalog/governanceDomains` + `POST /datagovernance/catalog/dataProducts` body `{governanceDomainId, ...}` | New `lib/azure/purview-catalog-client.ts` wrapper |
| Lifecycle state machine | Same Purview REST endpoints with `state: draft/published/expired` | Mirrors the documented Purview state |
| Bulk CSV import | Client-side CSV parser → loop calls to `POST /api/items/data-product-template` | No new backend endpoint |
| Access policy editor | **Purview REST**: `POST /datagovernance/catalog/dataProducts/{id}/accessPolicies` body matches the documented schema (access-time limit, approval-required, manager-approval, data-copy-attestation) | Pattern documented in [Unified Catalog data product access policies](https://learn.microsoft.com/purview/unified-catalog-data-product-access-policies) |
| OneLake catalog handoff | **Fabric Catalog REST**: `POST /v1/items/discover` (preview) to register a spawned item; or rely on Fabric's automatic catalog ingestion for items created in Fabric workspaces via the Fabric REST API | Loom already uses `fabric-client.ts` for workspace listing; extend with catalog endpoints |
| Endorsement | Purview REST + Fabric item endorsement (`/v1/workspaces/{ws}/items/{id}` PATCH `endorsementStatus: Promoted/Certified`) | Two separate writes; both already in the Fabric admin REST surface |
| Custom attributes | Purview REST `GET /datagovernance/catalog/customAttributes` for the schema + per-data-product values stored in the `customAttributes` field of the data product entity | Schema is admin-configured upstream |
| Glossary term linkage | Purview REST `/datagovernance/catalog/terms/{id}/relations` | Same client as above |

## Required Azure resources

- **Microsoft Purview account** (Loom already has one for governance scanning; needs the **Unified Catalog** experience enabled, which is the default for new accounts post-2024)
- **At least one published Governance Domain** in Purview (admin one-time bootstrap; document in `docs/fiab/v3-tenant-bootstrap.md`)
- **Data Product Owner role** assigned to the signed-in user on the target governance domain (required for create/publish per the documented permissions matrix)
- **Microsoft Fabric capacity** for the OneLake catalog surfacing
- **AAD app permissions**: `Purview.Read.All` + `Purview.ReadWrite.All` delegated; `Fabric.ReadWrite.All` for the catalog handoff
- **No new Azure resource** for the Loom-internal template catalog itself; the curated array lives in source and the custom templates live in the existing Loom Cosmos `items` container

## Estimated effort

- **Session N+1 (~3 hrs)** — governance-domain left-rail tree + Purview client wrapper + add `governanceDomainId` to the template state + bootstrap doc updates
- **Session N+2 (~3 hrs)** — lifecycle state machine (draft/published/expired) + Publish/Unpublish/Set-Expired buttons + Data Product Owner role check pre-flight
- **Session N+3 (~3 hrs)** — Access policy editor flyout (access-time limit, approval-required, manager-approval, data-copy-attestation) wiring the Purview REST POST
- **Session N+4 (~2 hrs)** — Override component defaults at instantiate-time + pre-flight RBAC / capability check + endorsement toggle
- **Session N+5 (~2 hrs)** — Bulk CSV import (parser + loop) + custom-attributes editor + audience + glossary-term linkage
- **Session N+6 (~2 hrs)** — OneLake catalog handoff for Fabric-resident spawned items + sensitivity label propagation
- **Session N+7 (~1 hr)** — relabel cost-estimate caveat; Vitest + Playwright end-to-end UAT: instantiate the `rag-agent-platform` template in a clean workspace and confirm all components surface in Purview + OneLake catalog

Total: **~16 hrs** across 7 sessions. Current grade: **B** (the strongest of the seven). Target: **A+** — this editor is high-leverage because every push-button data-product spawned from here surfaces all the other editor types covered in this catalog batch.
