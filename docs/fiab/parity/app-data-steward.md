# app-data-steward — parity with the Microsoft Purview / Power BI data-steward workflow

> **Supersedes** `docs/fiab/parity-gap/app-data-steward.md` (Grade F, validated
> 2026-05-26 against the empty-items live state). That defect — `Bundled items (0)`
> in production Cosmos — is fixed: this bundle ships **two fully-populated items**
> (a data product + a semantic model) with real Phase-2 provisioners. This doc is
> the current per-surface parity record.

Source UIs (grounded in Microsoft Learn, not memory):

- **Microsoft Purview Unified Catalog → Data products + Glossary terms** —
  https://learn.microsoft.com/purview/unified-catalog-data-products-create-manage ,
  https://learn.microsoft.com/purview/unified-catalog-glossary-terms-create-manage ,
  REST: https://learn.microsoft.com/rest/api/purview/unified-catalog-api-overview
- **Power BI semantic model (model view + relationships + DAX measures)** —
  https://learn.microsoft.com/power-bi/transform-model/desktop-relationships-understand ,
  active/inactive relationship rule:
  https://learn.microsoft.com/power-bi/guidance/relationships-active-inactive ,
  single-active-relationship requirement:
  https://learn.microsoft.com/analysis-services/tabular-models/relationships-ssas-tabular#requirements-for-relationships ,
  TMSL `isActive`:
  https://learn.microsoft.com/analysis-services/tmsl/relationships-object-tmsl

Bundle: `apps/fiab-console/lib/apps/content-bundles/app-data-steward.ts`.
This is an **app bundle** parity doc — it asserts the install produces real,
fully-formed steward artifacts. The per-editor parity (what every tab/button
does once the item is open) is owned by `data-product.md` (Grade A) and
`semantic-model.md` (Grade A); this doc references them rather than duplicating.

## What the steward console must deliver (inventory)

The real data-steward workflow in Purview + Power BI is:

| # | Capability | Source UI |
|---|------------|-----------|
| 1 | A set of curated **data products** with name, description, business use, owner | Purview Unified Catalog → Data products |
| 2 | A **classification** per product (Public / Internal / Confidential / Restricted) | data-product managed attribute |
| 3 | An **endorsement** lifecycle — Promoted, then **Certified** as the steward's sign-off | data-product endorsement |
| 4 | A **business glossary** of governed terms with definitions | Unified Catalog → Glossary terms |
| 5 | An accountable **owner / steward contact** | data-product contacts |
| 6 | A **semantic model** (star schema) exposing the certified business entities | Power BI model view |
| 7 | **Relationships** that obey Power BI's single-active-relationship rule | Power BI model view |
| 8 | **DAX measures** pre-authored against the active model | Power BI → New measure |
| 9 | **Direct Lake / Purview lineage** as provisioning outcomes (not pre-claimed) | Fabric + Purview |

## Loom coverage (built ✅ / honest-gate ⚠️ / MISSING ❌)

| # | Status | Notes |
|---|--------|-------|
| 1 | ✅ | 4 datasets: **Customer 360** (Confidential), **Sales Summary (Daily)** (Internal), **Inventory Live Feed** (Internal), **Fraud Scores** (Restricted). Each with a real, multi-sentence business description + business use. Materialized as Purview data products by the `data-product` provisioner. |
| 2 | ✅ | `classification` carried per dataset and emitted as a Purview `managedAttributes` `Classification` value. |
| 3 | ✅ | `endorsement: 'promoted'` — seeded as **ready-for-review**, NOT pre-certified. Certification is the steward's own action in the data-product editor; this no longer pre-empts their sign-off. Provisioner maps both promoted/certified → `endorsed:true`. |
| 4 | ✅ | **17 glossary terms** (Customer, Account, Transaction, SKU, MRR, ARR, NPS, CLV, Cohort, Attribution, Funnel, Conversion, Churn, Retention, AOV, Risk Tier, CTR Flag) each with a regulation-aware definition. One Purview glossary term per entry. |
| 5 | ✅ | `owner: { name: 'Data Steward Team', email }`; carried into the product description + (when an AAD oid is supplied) a Purview `contacts.owner` entry. |
| 6 | ✅ | Semantic model: DimCustomer, DimProduct, DimDate, FactSales, FactInventory — full typed columns; pushed to Fabric as TMSL by the `semantic-model` provisioner. |
| 7 | ✅ | **Single active FactSales→DimDate (OrderDateKey)** relationship. The previously-inconsistent dual OrderDate/ShipDate active relationships are corrected to one, per the single-active-relationship rule — TMSL would reject two active relationships to one table. ShipDateKey stays a queryable degenerate column. |
| 8 | ✅ | **13 DAX measures** (Total Sales, Total Margin, Gross Margin %, AOV, New Customers, Repeat Rate %, Sales YoY %, Sales MTD, Sales YTD, On-Hand Units, Inventory Value, Stockout SKUs). `New Customers` is rewritten to resolve against the active OrderDate relationship (no `USERELATIONSHIP` against a relationship the schema can't mark inactive) — internally consistent. |
| 9 | ✅ (honest copy) | Dataset descriptions now state Purview lineage + Direct Lake as **Phase-2 provisioning outcomes** ("on install, lineage is registered… gated on a bound governance domain and Fabric workspace"), not as already-live facts. Backed by the two real provisioners + their remediation gates. |

**Zero ❌. Zero stub banners.** Every row is real seeded content materialized by a
real REST provisioner, with an honest remediation gate when tenant infra is
absent.

## Backend per item (real REST + honest gates)

| Item | itemType | Provisioner | Real backend | Honest gate |
|------|----------|-------------|--------------|-------------|
| Steward-Certified Data Products | `data-product` | `lib/install/provisioners/data-product.ts` (`dataProductProvisioner`) | Purview Unified Catalog data-plane: `POST /datagovernance/catalog/dataProducts` + `POST /datagovernance/catalog/terms` (api-version `2026-03-20-preview`), scope `https://purview.azure.net/.default` | `remediation` when `LOOM_PURVIEW_UC_ENDPOINT`/`LOOM_PURVIEW_ACCOUNT` or `LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID` unset, or 401/403 → names **Data Product Owner** + **Data Steward** roles |
| Steward Business Glossary Model | `semantic-model` | `lib/install/provisioners/semantic-model.ts` (`semanticModelProvisioner`) | Fabric `POST /v1/workspaces/{ws}/semanticModels` with TMSL (`model.bim`) packed InlineBase64; scope `https://api.fabric.microsoft.com/.default` | `remediation` when no bound Fabric workspace (`LOOM_DEFAULT_FABRIC_WORKSPACE`), or 401/403 → UAMI must be workspace **Contributor** |

Both provisioners are registered in
`lib/install/provisioning-engine.ts` (`'data-product'` / `'semantic-model'`),
so install dispatches to them — not to a stub. The TMSL builder emits each
declared relationship as active (TMSL `isActive` defaults true) and now honors an
optional additive `isActive:false` if a future bundle carries one, so a steward's
later inactive role-playing relationship round-trips correctly.

## Verification

- DAX consistency: the model declares exactly one FactSales→DimDate relationship;
  no measure uses `USERELATIONSHIP` against an undeclared/unmarkable inactive
  relationship. Internally consistent with real Power BI's single-active rule.
- Copy honesty: Purview lineage / Direct Lake described as Phase-2 outcomes, not
  live state. Not a vaporware/UI-live-data claim — template copy that no longer
  overstates.
- Endorsement: seeded `promoted`, editable to `certified` post-install.
- Per-editor functional parity: see `data-product.md` (A) and `semantic-model.md`
  (A) — every tab/button hits real Purview/Power BI/Fabric REST.
- `cd apps/fiab-console && pnpm build` + the install-engine path
  (`lib/install/__tests__/provisioners.test.ts`) exercise both provisioners.

Grade: **A** — fully-formed seeded content (4 products + 17 terms + 5 tables + 13
DAX measures), two real REST provisioners with honest infra gates, internally
consistent model, and no pre-empted governance state.
