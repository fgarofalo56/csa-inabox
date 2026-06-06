# PRP — Data Products & API (Data Marketplace) at full Microsoft-Fabric parity, Azure-native

> **Status:** Implementation-ready.
> **Owner experience:** CSA Loom › Data Products & API (the "Data Marketplace" /
> data-product publishing + discovery + access-request experience).
> **Parity target:** Microsoft Fabric / **Microsoft Purview Unified Catalog**
> "Data products" experience — single + bulk data-product creation, the data
> product details page, edit/publish/expire/endorse lifecycle, access-policy
> management, asset + linked-resource curation, terms-of-use / documentation,
> deletion, and the consumer-facing discovery / "org data marketplace" with
> access requests.
> **Hard rule:** Per `.claude/rules/no-fabric-dependency.md`, **every feature in
> this PRP must be 100% functional on an Azure-native backend by default, with a
> real Microsoft Fabric capacity / Power BI workspace UNSET.** Fabric / the
> new `purview.microsoft.com` Unified Catalog portal is **opt-in only**; the
> default path must work in every cloud, including GCC / GCC-High / DoD IL5
> where Unified Catalog is **not yet available**.
> Per `.claude/rules/no-vaporware.md`, **no stubs, no mock arrays, no
> `return []` placeholders** — each task lands real backend calls or an honest
> infra-gate MessageBar naming the exact env var / role / resource.
> Per `.claude/rules/ui-parity.md`, each surface gets a parity doc
> (`docs/fiab/parity/data-marketplace.md`) and must match the source UI
> one-for-one (theme differs, functionality does not).

---

## 1. Overview + Azure-native + OSS architecture (all 4 cloud types)

### 1.1 What this experience is

Microsoft's **Data Products & API** experience (surfaced in Fabric and in the
new Microsoft **Purview Unified Catalog** at `purview.microsoft.com`) lets a
data-product **owner** package one or more governed data assets into a
publishable, discoverable **data product**, attach business metadata
(governance domain, use case, owners, custom attributes, glossary terms, OKRs,
terms-of-use, documentation), gate it behind a **multi-tier access policy**
(manager → privacy reviewer → access-request approver → access provider), and
**publish** it to an org **data marketplace** where **consumers** discover it,
view its details, and **request access**. It also covers the publish-as-API
edge (a data product backed by a queryable endpoint).

CSA Loom rebuilds this 1:1, with **two backends behind one identical UI**:

- **Default (all clouds): a Loom-native Azure metadata store** — a Cosmos DB
  data-product catalog + Azure AI Search index for discovery + Entra/Graph for
  owners/approvers + the existing classic Purview Data Map for the physical
  asset graph + Azure Storage RBAC for actual access provisioning. This path is
  **the default and works everywhere, with no Fabric and no Unified Catalog
  account.**
- **Opt-in (Commercial only): Microsoft Purview Unified Catalog REST API**
  (`/datagovernance/catalog/dataproducts`, api-version `2026-03-20-preview`),
  selected via `LOOM_DATAPRODUCTS_BACKEND=purview-unified` **and** a configured
  Unified Catalog account. The exact same Loom UI calls the Purview REST API
  instead of the Cosmos store.

The two backends are isolated behind a single `dataProductStore` interface so
the React surface never branches on backend; only the server-side adapter does.

### 1.2 Azure-native + OSS backing services

| Concern | Azure-native DEFAULT | Opt-in alternative | OSS component | Loom client / module |
|---|---|---|---|---|
| Data-product catalog (CRUD, lifecycle, attributes) | **Azure Cosmos DB** container `dataproducts` (+ `dataproduct-jobs`, `access-requests`) | Purview Unified Catalog REST `/datagovernance/catalog/dataproducts` | — | `cosmos-client`, `purview-unified-client` (new) |
| Discovery / search / browse | **Azure AI Search** index `loom-data-products` | Unified Catalog `/catalog/search/query` | — | `ai-search-client` |
| Governance domains | **Cosmos `governance-domains`** mirrored to classic Purview **collections** (existing pattern, `purview-client.ts:949`) | Unified Catalog `/governancedomains` | — | `purview-client`, `cosmos-client` |
| Physical data assets (the things a product wraps) | **Classic Purview Data Map** (Atlas entities) + Synapse/ADLS catalog | Unified Catalog `/dataassets` | Apache Atlas (concepts) | `purview-client`, `synapse-catalog-client` |
| Owners / approvers / reviewers (people pickers) | **Entra ID via Microsoft Graph** (`/users`, `/groups`) | same | — | `graph-client` |
| Access policy + actual provisioning | **Azure RBAC role assignments** on the backing Storage/SQL (existing access-policy wizard) + approval workflow rows in Cosmos | Unified Catalog access-policy API | — | `rbac-client`, `cosmos-client` |
| Custom attributes / attribute groups | **Cosmos `attribute-groups`** schema docs | Unified Catalog `/attributegroups` | — | `cosmos-client` |
| Glossary terms / CDEs | **Classic Purview glossary** (Atlas terms) | Unified Catalog `/glossaryterms`, `/criticalDataElements` | — | `purview-client` |
| OKRs | **Cosmos `okrs`** (Loom-native) | Unified Catalog `/okrs` | — | `cosmos-client` |
| Data-quality score | **Loom DQ rules over Synapse/ADLS** (existing) | Purview Data Quality API | Great Expectations (OSS, concepts) | `data-quality-client` |
| Data observability / lineage | **Classic Purview lineage** + **Azure Data Explorer** for health metrics | Purview Data Observability (Eventhouse) | — | `purview-client`, `kusto-client` |
| Bulk CSV import | **Azure Function / inline loop** writing Cosmos rows; staged in Blob | Unified Catalog `/dataproducts/import` | **Papa Parse** (browser-side CSV validation) | `cosmos-client`, `blob-client` |
| Publish-as-API edge | **Azure API Management** (existing Thread `publish-as-api`) | — | — | `apim-client` |
| Secrets | **Azure Key Vault** (secretRef) | — | — | `keyvault-client` |

### 1.3 Cloud portability matrix (the 4 cloud types)

| Backend | Commercial | GCC | GCC-High | DoD IL5/IL6 | Notes / endpoint difference |
|---|---|---|---|---|---|
| **Cosmos DB catalog (DEFAULT)** | GA | GA | GA | GA (FedRAMP High) | `documents.azure.com` vs `documents.azure.us`; this is why the default path is Cosmos — it covers **every** cloud |
| Azure AI Search (discovery) | GA | GA | GA | GA | `search.windows.net` vs `search.azure.us` |
| Classic Purview Data Map | GA | GA | GA | GA | metadata-policy roles, not ARM RBAC |
| Entra Graph (people pickers) | GA | GA | GA | GA | `graph.microsoft.com` vs `graph.microsoft.us` (Gov) / `dod-graph.microsoft.us` (DoD) |
| Azure RBAC provisioning | GA | GA | GA | GA | management-plane suffix split |
| Azure Data Explorer (observability) | GA | GA | GA | GA | `kusto.windows.net` vs `kusto.usgovcloudapi.net` |
| API Management (publish-as-API) | GA | GA | GA | GA | `azure-api.net` vs `azure-api.us` |
| **Purview Unified Catalog (OPT-IN)** | GA | ❌ **not supported** | ❌ **not supported** | ❌ **not supported** | `purview.microsoft.com` / `api.purview-service.microsoft.com`; doc: "Microsoft 365 GCC regions are not currently supported." No sovereign endpoint. |

**Implication for code (critical):** Unified Catalog is **Commercial-only and
opt-in**. Therefore the **Cosmos-backed Loom-native store is the default in all
four clouds** and the only path that can be assumed present. The Unified Catalog
adapter is selected **only** when `LOOM_DATAPRODUCTS_BACKEND=purview-unified`
**and** a Unified Catalog account is configured **and** the cloud is Commercial;
otherwise Loom silently uses Cosmos — **no gate, no "configure Purview" error on
the default path** (per `no-fabric-dependency.md`). Every host resolves via the
existing `cloud-endpoints` helper (`getCosmosSuffix()`, `getSearchSuffix()`,
`getGraphHost()`, `getKustoSuffix()`, `getApimSuffix()`), **never hard-coded**.

### 1.4 Item-type topology in Loom

```
data-product (item)                         ← Cosmos doc (DEFAULT) | Unified Catalog dataproduct (opt-in)
 ├─ governance-domain (ref)                  ← Cosmos doc ⇄ classic Purview collection
 ├─ dataAssets[]        (refs)               ← classic Purview Atlas entities / Synapse tables
 ├─ accessPolicy        (1:1)                ← Cosmos approval-tier doc + Azure RBAC on backing store
 ├─ access-request (item, consumer-created)  ← Cosmos doc, drives the approval workflow
 ├─ customAttributes[]  ← attribute-groups   ← Cosmos schema docs (or Unified Catalog attributegroups)
 ├─ glossaryTerms[] / okrs[] / CDEs[]         ← classic Purview glossary / Cosmos OKRs / Purview CDEs
 ├─ termsOfUse[] / documentation[]            ← Cosmos arrays {label,url,assetId?}
 └─ publishedApi (opt edge)                   ← APIM API (Thread publish-as-api)
data-marketplace (discovery surface)         ← Azure AI Search index over data-product docs
```

---

## 2. Feature-by-feature parity table

Legend — **Status today:** ✅ built · ⚠️ honest-gate (renders, partial backend, MessageBar) · 🔶 stub · ❌ missing.
Audit basis: `apps/fiab-console/lib/azure/purview-client.ts:916-931` honest-gates
`registerDataProduct` / `getDataProduct` / `listDataProducts` against the classic
Data Map account; the rest of the feature set is missing or blocked by those gates.

| # | Fabric / Purview feature | Azure-native backend (DEFAULT) | Loom UI | Portability | Status today | Work needed |
|---|---|---|---|---|---|---|
| F1 | Data Product Creation Wizard (single) | Cosmos `dataproducts` upsert (opt-in: `POST /datagovernance/catalog/dataproducts`) | 3-page wizard: Basic (name, ≤10k desc + counter, 12-enum Type, Audience multi-select, Owners Graph search), Business (domain picker, use case, Endorsed), Custom attributes (dynamic from attribute-groups); Create→draft page | Cosmos all clouds; Unified opt-in Comm | ⚠️ honest-gate (`registerDataProduct` throws) | **T1, T2** store + wizard |
| F2 | Bulk Import Data Products via CSV (preview) | Cosmos loop / Azure Function over Blob-staged CSV (opt-in: `/dataproducts/import` + `/jobs/{id}`) | Import flyout: download sample CSV, dropzone (.csv ≤1000 rows), Papa Parse client validation, Submit, Monitoring tab polling jobs every 5s (success/fail counts + error log) | Cosmos all; Unified opt-in Comm | ❌ missing | **T8** import flyout + job poll |
| F3 | Data Product Details Page (owner) | Cosmos read (opt-in: `GET /dataproducts/{id}`) + DQ + lineage | Full-page canvas: sticky header (name, status badge, owner avatars, actions), Details tab (desc/use-case/governance grid/owner contacts w/ custom labels/subscribers/terms/docs/DQ gauge/health actions), Custom Attributes w/ "show empty" toggle, Data Observability tab | Cosmos all; observability via ADX all | ⚠️ honest-gate (`getDataProduct` throws) | **T3** details page |
| F4 | Data Product Edit Dialog | Cosmos partial update (opt-in: `PATCH /dataproducts/{id}` per step) | 3-step modal matching Create; each step own Save (PATCH only that step's fields); debounced duplicate-name warning (non-blocking) | Cosmos all | ⚠️ honest-gate (depends on F3 read) | **T4** edit dialog |
| F5 | Update Frequency Selector | Cosmos field set (opt-in: `PATCH {updateFrequency}`) | Inline attribute panel `<Select>` (Daily/Weekly/Monthly/Quarterly/Annually/Ad hoc/Real-time); Save→PATCH; dirty-check on close | Cosmos all | ⚠️ honest-gate (blocked by PATCH) | **T5** inline attribute panels |
| F6 | Publish / Unpublish / Expire Controls | Cosmos status transition + guard checks (opt-in: `PATCH {status}`) | Toolbar: Publish (guarded by ≥1 asset + active policy + parent domain published), Unpublish dropdown (Set to draft / Set to expired); precondition errors surfaced | Cosmos all | ⚠️ honest-gate (blocked by PATCH) | **T6** lifecycle controls |
| F7 | Endorse Data Product | Cosmos `endorsed` flag (opt-in: `PATCH {endorsed}`) | Checkbox in Edit › Basic; Endorsed badge on detail header | Cosmos all | ⚠️ honest-gate | **T4** (within edit) |
| F8 | Manage Policies (Access Policy Config) | Cosmos approval-tier doc + **real Azure RBAC** on backing store (existing access-policy wizard) | Manage Policies dialog (product must be unpublished): purposes list + add-purpose, manager-approval toggle, privacy-review toggle, approvers (Graph users/groups), access provider picker; multi-tier sequence | Cosmos+RBAC all | ❌ missing | **T7** access-policy dialog |
| F9 | Add/Remove Data Assets | Classic Purview search (domain-scoped) + Cosmos asset refs | Add-assets panel: keyword search, type filter chips, pagination, multi-select, Add; per-asset ellipsis Remove (blocked if DQ rules running); caution icon for assets deleted in Data Map | Purview Data Map all | ❌ missing | **T9** asset curation |
| F10 | Linked Resources (Glossary Terms + OKRs + CDEs) | Classic Purview glossary + Cosmos OKRs; CDEs auto from Purview | Sections w/ + button → search popup (keyword + domain filter, multi-select, Add); ellipsis Remove; CDEs read-only auto-populated | Purview all; OKRs Cosmos all | ❌ missing | **T10** linked resources |
| F11 | Terms of Use Management | Cosmos `termsOfUse[]` `{label,url,assetId?}` (opt-in: PATCH array) | Inline panel: list, Add link form (friendly name + URL, optional asset scope), trash remove; multiple entries | Cosmos all | ❌ missing | **T5** (inline panels) |
| F12 | Documentation Management | Cosmos `documentation[]` (opt-in: PATCH array) | Identical inline panel pattern to F11 | Cosmos all | ❌ missing | **T5** (inline panels) |
| F13 | Delete Data Product | Cosmos delete + preconditions (opt-in: `DELETE /dataproducts/{id}`) | Precondition checklist (status Draft/Expired, asset/glossary/access-request counts), enable only when met, type-name-to-confirm dialog, route to list | Cosmos all | ❌ missing | **T11** delete + preconditions |
| F14 | Data Product Discovery / Browse (org marketplace) | Azure AI Search index over Cosmos docs (opt-in: `/catalog/search/query`) | Discovery: search bar (exact-match double-quote hint), left filter panel (domain/type/owner/terms/CDE checkboxes), results list w/ highlight tooltip, "Explore by governance domain" card grid (name + product count), "My data access" sub-tab (access-request status) | Search all clouds | ❌ missing | **T12** discovery surface |
| F15 | Data Product Details Page (consumer view) | Cosmos read (published-only projection) + access-request create | Read-only details + **Request access** flow: select purpose, optional justification, submit → drives F8 approval tiers; subscriber view after grant | Cosmos all | ❌ missing | **T13** consumer view + request |
| F16 | Access Request approval workflow | Cosmos `access-requests` + Graph approver resolution + Azure RBAC grant on approval | Approver inbox: pending requests, approve/deny per tier (manager→privacy→approver→provider), audit trail; on final approval, real RBAC role assignment on backing store | Cosmos+RBAC all | ❌ missing | **T14** approval workflow |
| F17 | Custom Attributes / Attribute Groups admin | Cosmos `attribute-groups` schema docs (opt-in: `/attributegroups`) | Attribute-group admin: define required/optional attributes per domain (string/number/enum/date), drives F1/F4 dynamic form | Cosmos all | ❌ missing | **T15** attribute-group admin |
| F18 | Governance Domain picker + browse | Cosmos `governance-domains` ⇄ classic Purview collections (existing mirror) | Domain `<Select>` in wizard; domain card grid in discovery; domain Details tab w/ bulk-job Monitoring | Purview+Cosmos all | ⚠️ partial (collection mirror exists) | **T2** (wire picker) + **T8** (monitoring) |
| F19 | Data Observability tab (preview) | Classic Purview lineage + **ADX** health metrics (KQL) | Lineage graph + data-health charts (KQL query results); honest-gate if ADX cluster unset | ADX + Purview all | ❌ missing | **T16** observability tab |
| F20 | Aggregate Data Quality score + Health actions | Loom DQ rules over Synapse/ADLS (opt-in: Purview DQ) | DQ score gauge + health-actions recommendation cards (each actionable) | DQ all clouds | ❌ missing | **T16** (DQ gauge + health) |
| F21 | Publish-as-API edge (data product → queryable API) | **Azure API Management** (existing Thread `publish-as-api`) | "Publish as API" action on a data product → APIM product/API + subscription keys; surfaced as a consumable endpoint | APIM all clouds | ⚠️ partial (Thread edge exists) | **T17** wire product→APIM |
| F22 | Purview Unified Catalog opt-in adapter | Purview Unified Catalog REST (`2026-03-20-preview`) | Same UI; backend swapped via env; Commercial-only | Comm only (opt-in) | ❌ missing | **T18** Unified adapter + Settings toggle |

---

## 3. Azure / OSS services — full feature set + native UI surfaces to rebuild 1:1

Per `ui-parity.md`, the team must **inventory the real UI first** (grounded in
Microsoft Learn via `microsoft_docs_search` / `microsoft_docs_fetch` and the live
`purview.microsoft.com` portal), then build it one-for-one.

### 3.1 Microsoft Purview Unified Catalog — Data products (the source UI to mirror)
- **Capabilities (inventory verbatim from the experience):** New data product
  wizard (Basic/Business/Custom attributes); bulk CSV import (≤1000, draft
  state, job monitoring); details page (description, use cases, domain, update
  frequency, status, owner contacts w/ custom labels, subscribers, terms of use,
  DQ score, health actions, documentation, custom attributes, Data observability
  tab); edit dialog (per-step Save, non-blocking duplicate-name warning);
  publish/unpublish(draft|expired); endorse; manage policies (purposes, manager
  approval, privacy review, approvers, access provider, multi-tier sequence);
  add/remove data assets (domain-scoped search, caution on deleted assets);
  linked resources (glossary terms, OKRs, auto-CDEs); terms of use + documentation
  link lists; delete (precondition-gated); discovery/marketplace (search, filters,
  domain card grid, my-data-access); request access.
- **Source surfaces to mirror:** `purview.microsoft.com` › Catalog management ›
  Data products; the consumer Data marketplace; the governance-domain Details ›
  Monitoring tab.
- **Loom mapping:** F1–F22 (this PRP is a 1:1 of this surface).
- **REST (opt-in only):** Unified Catalog REST `2026-03-20-preview` —
  `POST/GET/PATCH/DELETE /datagovernance/catalog/dataproducts`,
  `/dataproducts/import`, `/jobs/{id}`, `/governancedomains`, `/attributegroups`,
  `/search/query`, `/accesspolicies`, `/dataassets`, `/glossaryterms`, `/okrs`,
  `/criticalDataElements`, `/healthactions`.

### 3.2 Azure Cosmos DB (the DEFAULT catalog store)
- **Capabilities:** partitioned containers, point read/upsert/delete, SQL query
  with filters/paging, optimistic concurrency (ETag) for per-step PATCH, change
  feed (could drive search index updates), TTL (none here).
- **Containers this PRP adds:** `dataproducts` (pk `/governanceDomainId`),
  `dataproduct-jobs` (bulk-import status), `access-requests` (pk `/dataProductId`),
  `attribute-groups` (pk `/governanceDomainId`), `okrs` (pk `/governanceDomainId`).
- **Loom mapping:** F1, F2 (jobs), F3–F7, F11–F13, F15–F17.

### 3.3 Azure AI Search (discovery / marketplace)
- **Capabilities:** index schema with searchable/filterable/facetable fields;
  full-text + exact-phrase (quoted) queries; faceted navigation; highlighting;
  scoring profiles; index from Cosmos via indexer or push API.
- **Index `loom-data-products` fields:** id, name (searchable, highlight),
  description (searchable), type (filterable/facetable), governanceDomain
  (filterable/facetable), owners (filterable), glossaryTerms (filterable),
  cdes (filterable), status (filterable — published-only for consumers),
  endorsed (filterable).
- **Loom mapping:** F14 (discovery), F18 (domain card grid via facets).

### 3.4 Microsoft Graph (Entra ID) — people pickers
- **Capabilities:** `/users` + `/groups` search (`$search`/`$filter`), photos,
  group membership resolution for approver tiers.
- **Loom mapping:** Owners (F1/F4), approvers/reviewers/access provider (F8),
  approver inbox resolution (F16). Display **UPN**, store **OID**.

### 3.5 Azure RBAC + classic Purview Data Map + ADX
- **Azure RBAC:** real role assignments on the backing Storage/SQL when access is
  granted (F8 policy provisions, F16 final-approval grant) — reuses the existing
  access-policy wizard that already mints constrained Storage RBAC.
- **Classic Purview Data Map:** Atlas entity search (domain-scoped) for assets
  (F9), glossary terms + CDEs (F10), lineage (F19); domain ⇄ collection mirror
  already in `purview-client.ts`.
- **ADX (Kusto):** data-health KQL metrics for the observability tab (F19/F20).

### 3.6 Azure API Management (publish-as-API edge)
- **Capabilities:** products, APIs, subscriptions/keys, policies. Reused from the
  Thread `publish-as-api` edge to expose a data product as a consumable endpoint.
- **Loom mapping:** F21.

### 3.7 OSS — Papa Parse
- **Capabilities:** in-browser CSV parse + per-row/column validation before
  upload; surfaces column-error highlights for the bulk-import flyout.
- **Loom mapping:** F2 (client-side validation).

---

## 4. Sequenced TASK LIST

Each task is an independently shippable unit. **No stubs, no mock data, no
`return []`.** Each lands real backend calls or an honest infra-gate MessageBar
naming the exact env var / role / resource. Every task ends with a real-data E2E
receipt (per `no-vaporware.md`) and a parity-doc row update (per `ui-parity.md`).

Common conventions:
- BFF routes return `{ ok: boolean, data?, error? }` with correct HTTP codes.
- New hosts resolved via `cloud-endpoints` helper; covered by a cloud-matrix test.
- New env vars added to `apps[]` in `admin-plane/main.bicep`; new role grants
  added to the relevant Bicep module; new Cosmos containers created via the
  cosmos-client `createIfNotExists` init step; new clients use managed identity.
- **Default-path guard:** every route must work with `LOOM_DATAPRODUCTS_BACKEND`
  UNSET and no Unified Catalog account — i.e. against Cosmos.

---

### T1 — Foundation: `dataProductStore` interface + Cosmos adapter + replace honest-gates
- **Goal:** Define a single `DataProductStore` interface and a **Cosmos-backed
  default adapter**; replace the throwing `registerDataProduct` /
  `getDataProduct` / `listDataProducts` gates with real Cosmos CRUD.
- **Files:** add `apps/fiab-console/lib/dataproducts/store.ts` (interface +
  factory); add `apps/fiab-console/lib/dataproducts/cosmos-store.ts`; edit
  `apps/fiab-console/lib/azure/purview-client.ts:916-931` to delegate to the
  store (keep the Unified-Catalog throw **only** behind the opt-in adapter);
  register `data-product` item type in `lib/items/registry.ts`.
- **Backend/REST:** `cosmos-client` containers `dataproducts`,
  `governance-domains`, `attribute-groups`, `okrs`, `access-requests`,
  `dataproduct-jobs` (`createIfNotExists`); CRUD + ETag concurrency.
- **Bicep/portability:** add the six Cosmos containers to the Cosmos init step;
  env `LOOM_COSMOS_DB` (existing) + new `LOOM_DATAPRODUCTS_BACKEND` (default
  unset → Cosmos); `getCosmosSuffix()` for the host; cloud-matrix test.
- **UI surface:** none (plumbing).
- **Acceptance:** with `LOOM_DATAPRODUCTS_BACKEND` UNSET, `listDataProducts()`
  returns live Cosmos rows (empty store → honest `[]`, no fabricated data);
  `getDataProduct(id)` round-trips a written doc; receipt shows the live Cosmos
  response; cloud-matrix test passes for Comm + Gov Cosmos suffixes.

### T2 — Data Product Creation Wizard (single) (F1, wires F18 picker)
- **Goal:** 3-page wizard creating a real draft data product.
- **Files:** add `lib/editors/data-product-create-wizard.tsx`; add
  `app/api/data-products/route.ts` (POST); add `app/api/governance-domains/route.ts`
  (GET for picker); add `app/api/attribute-groups/route.ts` (GET by domain).
- **Backend/REST:** POST → `DataProductStore.create` (Cosmos upsert); domain
  picker → `governance-domains` (mirrored to classic Purview collections);
  attribute-groups → Cosmos schema docs; Owners search → `graph-client`.
- **Bicep/portability:** none beyond T1.
- **UI surface:** Page 1 Basic — name, description textarea w/ **10,000-char
  counter**, 12-item Type `<Select>` (Analytics model, Business system/Application,
  Dashboards/Reports, Dataset, Master and reference data, ML training data, ML
  testing data, Model types, Operational, Semantic model, Transactional data),
  Audience multi-select chips (8 enum values), Owners search-as-you-type. Page 2
  Business — Governance Domain `<Select>`, Use Case textarea, Endorsed checkbox.
  Page 3 Custom attributes — dynamic form from attribute-groups (required/optional).
  Create → routes to the draft details page (T3).
- **Acceptance:** with Fabric/Unified UNSET, completing the wizard writes a real
  Cosmos draft and lands on its details page; 12 Type values + 8 Audience values
  render from enums; Owners resolve via real Graph; char counter blocks >10,000;
  receipt shows POST response with the new id.

### T3 — Data Product Details Page (owner) (F3)
- **Goal:** Full-page canvas details view reading a real product.
- **Files:** add `lib/editors/data-product-detail.tsx`; add
  `app/api/data-products/[id]/route.ts` (GET).
- **Backend/REST:** `DataProductStore.get`; DQ score from `data-quality-client`;
  health actions from DQ engine; lineage placeholder deferred to T16 (tab present
  but its content is T16).
- **Bicep/portability:** none beyond T1.
- **UI surface:** sticky header (name, status badge, Endorsed badge if set, owner
  avatars, action buttons), Details tab (description card, use-case card,
  governance grid: domain/update-frequency/status pill, owner contacts w/
  editable label inputs, subscribers list w/ pagination, terms-of-use list,
  documentation list, DQ score gauge, health-action cards), Custom Attributes
  section w/ "Show attributes without a value" toggle, Data Observability tab
  (renders, content from T16).
- **Acceptance:** opening a real draft shows live fields from Cosmos; status
  badge reflects Draft/Published/Expired; "show empty" toggle hides/shows null
  attributes; DQ gauge shows a real computed score or honest-gate if DQ not
  configured; receipt shows GET response.

### T4 — Data Product Edit Dialog + Endorse (F4, F7)
- **Goal:** 3-step modal with independent per-step Save (partial PATCH) and
  Endorse checkbox.
- **Files:** add `lib/editors/data-product-edit-dialog.tsx`; add
  `app/api/data-products/[id]/route.ts` PATCH handler.
- **Backend/REST:** `DataProductStore.patch` (ETag, partial fields per step);
  debounced duplicate-name check via `DataProductStore.findByName`.
- **Bicep/portability:** none.
- **UI surface:** modal mirroring Create's 3 steps; each step has its own Save
  firing a PATCH with only that step's fields; Endorsed checkbox in Basic;
  non-blocking duplicate-name warning banner; step navigation without requiring
  prior save.
- **Acceptance:** editing Basic and saving PATCHes only Basic fields (verified by
  unchanged Business fields); duplicate name shows warning but still saves;
  toggling Endorsed sets the flag and the badge appears on the detail header;
  receipt shows the per-step PATCH body + response.

### T5 — Inline attribute panels: Update Frequency + Terms of Use + Documentation (F5, F11, F12)
- **Goal:** Three inline right-side attribute panels on the details page, each
  persisting via PATCH.
- **Files:** add `lib/editors/components/inline-attribute-panel.tsx` (shared);
  edit `lib/editors/data-product-detail.tsx`; reuse PATCH route.
- **Backend/REST:** `DataProductStore.patch` for `updateFrequency` (enum) and for
  `termsOfUse[]` / `documentation[]` arrays of `{label, url, assetId?}`.
- **Bicep/portability:** none.
- **UI surface:** Update Frequency `<Select>` (Daily/Weekly/Monthly/Quarterly/
  Annually/Ad hoc/Real-time) w/ Done + dirty-check; Terms-of-Use list w/ "Add
  link" inline form (friendly name + URL + optional asset scope) + trash remove;
  Documentation list identical pattern.
- **Acceptance:** selecting a frequency PATCHes and persists across reload;
  adding a terms-of-use link with an asset scope persists in the array; trash
  removes it; receipt shows each PATCH body + response.

### T6 — Publish / Unpublish / Expire lifecycle controls (F6)
- **Goal:** Toolbar lifecycle with real guard logic.
- **Files:** add `app/api/data-products/[id]/status/route.ts`; edit detail toolbar.
- **Backend/REST:** `DataProductStore.setStatus` validating: ≥1 data asset
  attached, an active access policy exists, parent governance domain is published
  — before allowing `Published`; otherwise returns a precise precondition error.
- **Bicep/portability:** none.
- **UI surface:** Publish button (primary, when Draft/Expired), Unpublish dropdown
  (Set to draft / Set to expired); pre-validate and disable Publish with a
  tooltip when preconditions unmet; surface server precondition errors in a
  MessageBar.
- **Acceptance:** publishing a product with no assets is blocked with the exact
  reason; after attaching an asset (T9) + a policy (T7) + a published domain,
  Publish succeeds and status flips to Published; Set-to-expired restricts
  visibility; receipt shows the guarded transitions.

### T7 — Manage Policies (access-policy configuration) (F8)
- **Goal:** Access-policy dialog wiring purposes + multi-tier approval + real
  Azure RBAC provisioning on the backing store.
- **Files:** add `lib/editors/components/manage-policies-dialog.tsx`; add
  `app/api/data-products/[id]/access-policy/route.ts` (GET/PUT); reuse the
  existing access-policy wizard's RBAC-grant code path.
- **Backend/REST:** Cosmos access-policy doc (purposes, tier toggles, approver
  OIDs, provider OID); `rbac-client` for actual constrained role assignment on
  the backing Storage/SQL when access is later granted (T16).
- **Bicep/portability:** Console UAMI must already hold constrained
  RBAC-Administrator (existing grant from the access-policy wizard); env
  documented; works all clouds.
- **UI surface:** dialog (product must be unpublished): allowed-purposes list +
  add-purpose inline form (name + description), manager-approval toggle,
  privacy-review toggle, Access request approvers (Graph users/groups search),
  access provider picker; multi-tier sequence preview (manager → privacy →
  approver → provider); warning when product is Published.
- **Acceptance:** saving a policy persists tiers + approvers in Cosmos; approvers
  resolve to real Entra principals (UPN shown); editing while Published is
  blocked with a MessageBar; receipt shows the policy GET/PUT.

### T8 — Bulk Import via CSV flyout + job monitoring (F2, F18 monitoring)
- **Goal:** Import flyout that bulk-creates draft products and a polled job
  monitor.
- **Files:** add `lib/editors/components/import-data-products-flyout.tsx`; add
  `app/api/data-products/import/route.ts` (POST multipart); add
  `app/api/data-products/import/template/route.ts` (GET sample CSV); add
  `app/api/data-products/jobs/[jobId]/route.ts` (GET status).
- **Backend/REST:** stage CSV in Blob; loop `DataProductStore.create` (or Azure
  Function for ≥N rows) writing a `dataproduct-jobs` status doc (success/fail
  counts + per-row errors); Papa Parse client-side pre-validation.
- **Bicep/portability:** Blob container for staging; `dataproduct-jobs` Cosmos
  container (T1); optional Azure Function module for large imports (honest-gate
  to inline loop if the Function isn't deployed).
- **UI surface:** flyout — Download sample CSV link, dropzone (.csv ≤1000 rows),
  Papa Parse column-error highlights, Submit; Monitoring tab polling job every 5s
  showing job id, started time, success/failure counts, downloadable error log.
- **Acceptance:** uploading a valid 3-row CSV creates 3 real draft products
  (visible in the list); an invalid row is reported in the error log without
  aborting valid rows; the monitor polls and shows live counts; receipt shows the
  import POST + a job GET.

### T9 — Add / Remove Data Assets (F9)
- **Goal:** Curate the physical assets a product wraps, via domain-scoped Purview
  search.
- **Files:** add `lib/editors/components/add-data-assets-panel.tsx`; add
  `app/api/data-products/[id]/assets/route.ts` (GET attached, POST add, DELETE
  remove); edit detail page assets section.
- **Backend/REST:** classic Purview Data Map search (`purview-client`) scoped to
  the product's governance-domain collection + the caller's Data Map access;
  store asset refs on the Cosmos doc; detect assets deleted in Data Map.
- **Bicep/portability:** UAMI Data Map Data Reader (existing metadata-policy
  grant); works all clouds.
- **UI surface:** Add-assets panel — keyword search, type filter chips
  (Table/View/File), pagination, multi-select checkboxes, Add; per-asset row on
  the detail page w/ ellipsis Remove (blocked + tooltip if DQ rules running);
  caution icon on assets deleted from Data Map w/ ellipsis Remove.
- **Acceptance:** searching returns real domain-scoped Data Map entities; adding
  attaches them (visible on the detail page and counted by T6's publish guard);
  removing a normal asset works; a deleted-in-DataMap asset shows the caution
  icon and is removable; receipt shows the search + add responses.

### T10 — Linked Resources: Glossary Terms + OKRs + CDEs (F10)
- **Goal:** Attach glossary terms and OKRs; surface auto-populated CDEs.
- **Files:** add `lib/editors/components/linked-resources.tsx`; add
  `app/api/data-products/[id]/glossary-terms/route.ts`,
  `.../okrs/route.ts`, `.../cdes/route.ts`.
- **Backend/REST:** classic Purview glossary search (terms + CDEs via
  `purview-client`); OKRs from Cosmos `okrs`; CDEs auto-derived when assets are
  mapped (read-only).
- **Bicep/portability:** Purview glossary read via Data Map role; `okrs` Cosmos
  container (T1).
- **UI surface:** Glossary Terms + OKRs sections each w/ + button → search popup
  (keyword + domain filter, multi-select, Add); ellipsis Remove on existing;
  CDEs section read-only, auto-populated, shown under Custom attributes.
- **Acceptance:** adding a real glossary term persists and renders; removing it
  works; an OKR adds/removes; CDEs appear automatically after T9 maps an asset
  carrying a CDE; receipt shows the term search + add.

### T11 — Delete Data Product with preconditions (F13)
- **Goal:** Precondition-gated destructive delete with type-name confirmation.
- **Files:** add `app/api/data-products/[id]/route.ts` DELETE handler + a
  preconditions GET; add `lib/editors/components/delete-data-product-dialog.tsx`.
- **Backend/REST:** `DataProductStore.delete`; precondition checks — status must
  be Draft or Expired, asset count, glossary-term count, open access-request
  count.
- **Bicep/portability:** none.
- **UI surface:** precondition checklist (each unmet condition shows a blocking
  message), Delete enabled only when all met, confirmation dialog requiring the
  product name typed exactly, route back to list on success.
- **Acceptance:** delete is blocked while Published or while open access requests
  exist, with the exact reason; once preconditions met, type-to-confirm deletes
  the real Cosmos doc and routes to the list; receipt shows the preconditions GET
  + DELETE.

### T12 — Discovery / org data marketplace (F14, F18 card grid)
- **Goal:** Consumer discovery surface backed by Azure AI Search.
- **Files:** add `lib/editors/data-marketplace.tsx`; add
  `app/api/data-products/search/route.ts` (POST query); add the
  `loom-data-products` index definition + Cosmos→Search push on create/patch/
  delete (hook into T1–T13 writes).
- **Backend/REST:** `ai-search-client` query (full-text + quoted exact match +
  facets + highlighting), filtered to `status = Published` for consumers; domain
  card grid from facet counts.
- **Bicep/portability:** AI Search service + index; env `LOOM_AI_SEARCH_SERVICE`
  (existing); `getSearchSuffix()`; honest-gate MessageBar if AI Search unset.
- **UI surface:** top search bar (exact-match double-quote hint), left filter
  panel (governance domain, type, owner, glossary terms, CDEs checkboxes),
  results list w/ hover search-highlight tooltip, "Explore by governance domain"
  card grid (domain name + live product count), "My data access" sub-tab
  (access-request status from T14).
- **Acceptance:** searching returns only Published products from the live index;
  a quoted phrase does exact match; facets filter results; domain cards show real
  counts; receipt shows the search POST response.

### T13 — Consumer details view + Request access (F15)
- **Goal:** Read-only consumer details + a Request-access flow that opens an
  approval workflow.
- **Files:** edit `lib/editors/data-product-detail.tsx` (consumer/read-only
  mode); add `lib/editors/components/request-access-dialog.tsx`; add
  `app/api/data-products/[id]/access-requests/route.ts` (POST create).
- **Backend/REST:** published-only projection of `DataProductStore.get`; create
  an `access-requests` Cosmos doc bound to a selected purpose; this drives T14.
- **Bicep/portability:** `access-requests` container (T1).
- **UI surface:** read-only details (no owner edit controls) + **Request access**
  button → dialog (select permitted purpose, optional justification, submit);
  post-grant subscriber view.
- **Acceptance:** a non-owner sees the read-only view of a Published product and
  can submit a request tied to a real purpose; the request appears in T12's "My
  data access" and the approver inbox (T14); receipt shows the request POST.

### T14 — Access-request approval workflow + RBAC grant (F16)
- **Goal:** Multi-tier approval inbox; final approval provisions real Azure RBAC.
- **Files:** add `lib/editors/access-request-inbox.tsx`; add
  `app/api/access-requests/route.ts` (GET inbox) +
  `app/api/access-requests/[id]/decision/route.ts` (POST approve/deny).
- **Backend/REST:** resolve approver tiers from the product's access policy (T7)
  via Graph; advance tier on approval (manager → privacy → approver → provider);
  on final approval, `rbac-client` assigns the constrained role on the backing
  store and marks the requester a subscriber; full audit trail in Cosmos.
- **Bicep/portability:** UAMI constrained RBAC-Administrator (existing);
  works all clouds.
- **UI surface:** approver inbox (pending requests filtered to the signed-in
  approver's tier), approve/deny per tier, audit trail timeline; requester sees
  status transitions in T12.
- **Acceptance:** a submitted request (T13) appears for the manager; approving
  advances it to the privacy tier, etc.; final approval creates a **real RBAC
  role assignment** on the backing Storage (verified via ARM read) and marks the
  requester a subscriber on the product; deny closes it with a reason; receipt
  shows the decision POST + the resulting role assignment.

### T15 — Custom Attributes / Attribute Groups admin (F17)
- **Goal:** Admin surface to define per-domain attribute schemas that drive the
  wizard/edit dynamic forms.
- **Files:** add `lib/editors/attribute-groups-admin.tsx`; add
  `app/api/attribute-groups/route.ts` (GET/POST/PATCH/DELETE).
- **Backend/REST:** Cosmos `attribute-groups` schema docs (attribute name, type
  string/number/enum/date, required flag, enum values, domain binding).
- **Bicep/portability:** `attribute-groups` container (T1).
- **UI surface:** per-domain list of attribute groups; create/edit attribute
  (name, type, required, enum values); reorder; this drives F1/F4 page 3.
- **Acceptance:** defining a required enum attribute makes it appear (and enforce
  required) in the Create wizard's Custom attributes page for that domain;
  editing the schema reflects in the wizard; receipt shows the schema CRUD.

### T16 — Data Observability tab + DQ score + Health actions (F19, F20)
- **Goal:** Lineage + data-health observability and the DQ gauge / health-action
  cards.
- **Files:** edit `lib/editors/data-product-detail.tsx` (observability tab + DQ
  gauge); add `app/api/data-products/[id]/observability/route.ts`;
  `.../health-actions/route.ts`.
- **Backend/REST:** classic Purview lineage (`purview-client`) for the lineage
  graph; **ADX** KQL queries (`kusto-client`) for data-health metrics; DQ score +
  health actions from `data-quality-client`.
- **Bicep/portability:** ADX cluster + env `LOOM_ADX_CLUSTER` (existing);
  `getKustoSuffix()`; honest-gate MessageBar naming the ADX env var when unset —
  the tab still renders.
- **UI surface:** Data Observability tab — lineage graph + data-health charts
  (KQL results); Details tab DQ score gauge + actionable health-action cards.
- **Acceptance:** with an ADX cluster configured, the tab renders live lineage +
  health charts; the DQ gauge shows a real score; a health-action card performs
  its action; with ADX unset, the tab shows an honest-gate MessageBar (no fake
  charts); receipt shows the observability + health GET.

### T17 — Publish-as-API edge (data product → APIM) (F21)
- **Goal:** Expose a published data product as a consumable API via the existing
  Thread `publish-as-api` edge.
- **Files:** edit `lib/editors/data-product-detail.tsx` (Publish-as-API action);
  add `app/api/data-products/[id]/publish-api/route.ts`; reuse the Thread
  `publish-as-api` / `apim-client` path.
- **Backend/REST:** create/update an APIM product + API + subscription for the
  data product's backing query endpoint; persist the API ref on the Cosmos doc.
- **Bicep/portability:** APIM instance + env (existing Thread infra);
  `getApimSuffix()`; honest-gate if APIM unset.
- **UI surface:** "Publish as API" action → confirms backing endpoint → creates
  APIM product/API → shows the consumable URL + subscription-key guidance on the
  detail page.
- **Acceptance:** publishing a data product as an API creates a real APIM API and
  returns a callable endpoint that serves the product's data with a subscription
  key; receipt shows the APIM create response + a live call to the new endpoint.

### T18 — Purview Unified Catalog opt-in adapter + Settings toggle (F22)
- **Goal:** A second `DataProductStore` adapter calling the Unified Catalog REST
  API, selected via env, **Commercial-only**, with the **identical** UI.
- **Files:** add `lib/dataproducts/purview-unified-store.ts`; add
  `lib/azure/purview-unified-client.ts`; edit `lib/dataproducts/store.ts` factory
  to choose the adapter from `LOOM_DATAPRODUCTS_BACKEND` + account presence +
  cloud == Commercial; add a Settings toggle surfacing the backend in use.
- **Backend/REST:** Unified Catalog `2026-03-20-preview` —
  `POST/GET/PATCH/DELETE /datagovernance/catalog/dataproducts`, `/import`,
  `/jobs/{id}`, `/governancedomains`, `/attributegroups`, `/search/query`,
  `/accesspolicies`, `/dataassets`, `/glossaryterms`, `/okrs`,
  `/criticalDataElements`, `/healthactions`. Host via `cloud-endpoints`
  (`api.purview-service.microsoft.com`, Commercial only).
- **Bicep/portability:** env `LOOM_DATAPRODUCTS_BACKEND=purview-unified` +
  `LOOM_PURVIEW_UNIFIED_ACCOUNT`; **must hard-refuse to select on GCC/GCC-High/
  IL5** (cloud check) and fall through to Cosmos silently; cloud-matrix test
  asserts the fall-through.
- **UI surface:** none new except a Settings read-only "Backend: Cosmos (default)
  | Purview Unified Catalog" indicator.
- **Acceptance:** with the env + a Commercial Unified account set, the **same**
  wizard/detail/lifecycle surfaces operate against the real Unified Catalog REST
  API (verified by a live `GET /dataproducts/{id}`); with the env set on a Gov
  cloud, Loom silently uses Cosmos and shows no Fabric/Unified gate; receipt shows
  both a Unified-Catalog live call (Comm) and the Gov fall-through.

---

## 5. Claude Code DEV-LOOP per task

Run this loop **per task**, iterating until acceptance criteria pass with **zero
stubs/placeholders/mocks**. Use an isolated worktree (`EnterWorktree`) per task so
parallel tasks don't corrupt `node_modules` (per the pnpm-worktree memory).

```
┌── 1. CODING AGENT ────────────────────────────────────────────────┐
│ - Read parity rules + the task's files. Inventory the real         │
│   Purview Unified Catalog / Fabric Data-products UI via            │
│   microsoft_docs_search/fetch (and the live purview.microsoft.com  │
│   portal) FIRST. Write the inventory into the parity doc.          │
│ - Implement BFF route (real Cosmos / Graph / Purview / Search /    │
│   RBAC / ADX / APIM call) + store adapter + UI surface.            │
│ - Add env var to admin-plane/main.bicep + Cosmos container init +  │
│   role grant to the module + cloud-endpoints suffix usage.         │
│   No return []/mock/useState(MOCK).                                │
│ - DEFAULT-PATH guard: route must work with                        │
│   LOOM_DATAPRODUCTS_BACKEND UNSET (Cosmos), no Unified account.    │
│ - Commit on a task branch.                                         │
└────────────────────────────────────────────────────────────────────┘
            │  hand off
┌── 2. VALIDATION / TEST AGENT ─────────────────────────────────────┐
│ - tsc:  pnpm --filter fiab-console exec tsc --noEmit               │
│ - build: pnpm --filter fiab-console build  (CI never ran this —    │
│          it is REQUIRED here per csa_loom_ci_gaps memory)          │
│ - unit: pnpm --filter fiab-console vitest run <task spec>          │
│         (gate render tests on build per vitest-harness memory)     │
│ - cloud-matrix test: Comm + GCC + GCC-High + IL5 suffixes; assert  │
│   Unified adapter REFUSES on Gov and falls through to Cosmos.      │
│ - REAL-DATA E2E: mint session cookie, hit the new /api/data-...    │
│   route with Fabric + LOOM_DATAPRODUCTS_BACKEND UNSET (Cosmos),    │
│   capture first 300 chars of the live response. For T18 also hit   │
│   the Unified path on Commercial.                                  │
│ - grep guard: no (return \[\]|return \{\}|MOCK_|SAMPLE_|TODO|      │
│   useState\(\[\{) in touched files.                                │
│ - On FAIL → revert task to coding agent with the failing output.   │
└────────────────────────────────────────────────────────────────────┘
            │  pass
┌── 3. DOCS AGENT ──────────────────────────────────────────────────┐
│ - Update docs/fiab/parity/data-marketplace.md: inventory row →     │
│   built ✅ / honest-gate ⚠️ + backend-per-control column.         │
│ - Update this PRP's status column for the feature row(s).         │
│ - Update the docs-site Data Products page (docs = source of truth, │
│   BLOCKING). No clarifying questions / side-convo in product docs. │
└────────────────────────────────────────────────────────────────────┘
            │
┌── 4. UAT AGENT ───────────────────────────────────────────────────┐
│ - pnpm uat (deep-functional spec) for the surface.                │
│ - Playwright (or claude-in-chrome): click EVERY control — wizard  │
│   pages, lifecycle buttons, policy tiers, asset search, import     │
│   flyout, discovery filters, request-access, approval inbox —      │
│   confirm each does what its label says (DOM strings ≠ parity).   │
│   Side-by-side vs the real Purview Unified Catalog UI.            │
│ - Capture screenshot/trace into the PR receipt.                   │
│ - On any ❌ or stub banner → back to coding agent.                 │
└────────────────────────────────────────────────────────────────────┘
            │  all green
        OPEN PR (with real-data E2E receipt + bicep diff + screenshot)
```

**Iteration rule:** a task is not "done" until agents 2 + 4 both pass with the
acceptance criteria verbatim, Fabric + Unified-Catalog UNSET (Cosmos default),
and the PR carries the no-vaporware receipt. Reviewers reject any PR missing the
receipt.

---

## 6. Definition of Done (whole experience)

The Data Products & API (Data Marketplace) experience is **done** when:

1. **Every parity row (F1–F22)** in §2 is **built ✅ or honest-gate ⚠️** —
   **zero 🔶 stubs, zero ❌ missing, zero empty tabs, zero disabled-with-tooltip
   actions, and the three throwing gates at `purview-client.ts:916-931` are
   replaced** by real Cosmos-backed behavior.
2. **Fabric-free + Unified-free by default:** with `LOOM_DEFAULT_FABRIC_WORKSPACE`,
   all `LOOM_<ITEM>_BACKEND=fabric`, and `LOOM_DATAPRODUCTS_BACKEND` UNSET, the
   entire experience installs and every surface executes its primary action
   against real Azure backends (Cosmos, AI Search, Graph, classic Purview Data
   Map, Azure RBAC, ADX, APIM). **No call to `api.fabric.microsoft.com` /
   `api.powerbi.com` / `api.purview-service.microsoft.com` on any default path.**
3. **Opt-in Unified Catalog isolated + Gov-safe:** the Unified Catalog adapter is
   reached **only** with `LOOM_DATAPRODUCTS_BACKEND=purview-unified` + an account
   + Commercial cloud; on GCC/GCC-High/IL5 the factory falls through to Cosmos
   **silently** (proven by a cloud-matrix test) with no Fabric/Unified gate shown.
4. **No vaporware:** `grep -rE "(return \[\]|return \{\}|useState\(\[\{|MOCK_|SAMPLE_|TODO|FIXME)"`
   over the touched editors + API routes returns no candidate violations; every
   BFF route calls a real backend or returns an honest-gate MessageBar naming the
   exact env var / role / resource.
5. **All 4 clouds:** every new host resolves via `cloud-endpoints`; cloud-matrix
   tests pass for Commercial + GCC + GCC-High + DoD IL5/IL6; honest MessageBars
   cover services not present in a given sovereign cloud (Unified Catalog
   everywhere but Commercial; ADX/observability where the cluster is unset).
6. **Bicep-synced:** `az deployment sub create -f platform/fiab/bicep/main.bicep
   -p params/commercial-full.bicepparam` + the bootstrap workflow deploys every
   resource, env var, role grant, and the six Cosmos containers
   (`dataproducts`, `dataproduct-jobs`, `access-requests`, `attribute-groups`,
   `okrs`, `governance-domains`) plus the `loom-data-products` AI Search index
   these tasks add — running feature set == deployed feature set (no drift).
7. **Parity docs:** `docs/fiab/parity/data-marketplace.md` has zero ❌ rows and a
   backend-per-control column; the docs site reflects the feature set.
8. **Tested:** each task carries vitest + real-data E2E + Playwright UAT evidence;
   `pnpm uat` green for the experience; quarterly teardown + one-button redeploy
   in a clean Commercial **and** Gov sub renders + executes every surface's
   primary action (Cosmos default) — target grade **A / A+** per the rubric.
