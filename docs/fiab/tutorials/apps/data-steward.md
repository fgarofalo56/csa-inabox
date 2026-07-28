# Data Steward Console — from install to a certified data product

Install `app-data-steward`, get **four curated data products** registered in Microsoft
Purview Unified Catalog, a **17-term business glossary**, and a **star-schema semantic
model with 12 pre-authored DAX measures**. The products land as **Promoted** — the
certify step is *your* governance sign-off, and doing it is the point of this tutorial.
**~25 minutes.**

!!! abstract "What you end up with"
    Two workspace items: `Steward-Certified Data Products` (data product) and
    `Steward Business Glossary Model` (semantic model). Purview registration is a real
    data-plane call, not a template.

## Prerequisites

| You need | Why | If it is missing |
| --- | --- | --- |
| A Loom workspace | Apps install into a workspace | [Tutorial 01 — First workspace](../01-first-workspace.md) |
| `LOOM_PURVIEW_UC_ENDPOINT` **or** `LOOM_PURVIEW_ACCOUNT` | The provisioner writes data products + glossary terms to the Unified Catalog data plane | Honest gate naming both variables |
| Console UAMI with catalog access on the Purview account | Token acquisition + writes | Verbatim `401`/`403` with the role to grant |
| A published governance domain (optional) | Products hang under a domain | The provisioner **auto-discovers** a published domain, and **auto-creates** `Loom Governance` if it can. Only if it cannot does it ask for the **Governance Domain Creator** role or a pinned `LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID` |

!!! note "The domain is not a hard gate"
    Resolution order: pinned `LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID` → auto-discover an
    existing published domain → auto-create a default one (`Loom Governance`, override
    with `LOOM_PURVIEW_DEFAULT_DOMAIN_NAME`). You only see a gate when all three fail.

## 1. Install the app

1. Left nav → **Apps** → **Data Steward Console** (`/apps/app-data-steward`).
2. **Install into workspace** → workspace, optional folder (e.g. `Governance`).
3. **Deploy artifacts to live Azure services** → **On**. **Compute** → **Shared**.
4. **Install** and watch the two-row provisioning report.

## 2. What gets provisioned

| Item | Provisioner | Real backend | Honest gate |
| --- | --- | --- | --- |
| `Steward-Certified Data Products` (`data-product`) | `dataProductProvisioner` | Purview Unified Catalog: creates the four data products + the glossary terms under the resolved governance domain | *"Purview Unified Catalog endpoint not configured. Set `LOOM_PURVIEW_UC_ENDPOINT` … OR set `LOOM_PURVIEW_ACCOUNT` …"* |
| `Steward Business Glossary Model` (`semantic-model`) | `semanticModelProvisioner` | TMSL model over the gold layer (Azure-native tabular; Fabric/Power BI opt-in only) | Names the missing target |

## 3. Seeded data

### Four data products — all **Promoted**, none Certified

| Product | Classification | Steward story |
| --- | --- | --- |
| **Customer 360** | Confidential | CRM master + transaction aggregates + support signals + marketing engagement; 4-hour refresh, SCD2 history retained 7 years |
| **Sales Summary (Daily)** | Internal | Customer × product × channel grain off `fact_sales`; revenue / margin / units / discount; month-end sign-off by Revenue Accounting |
| **Inventory Live Feed** | Internal | Near-real-time WMS snapshot via Event Hubs → KQL → 5-minute Delta aggregation; on-hand / in-transit / committed per SKU per warehouse; no PII |
| **Fraud Scores (Transaction-Level)** | Restricted | Per-transaction fraud probability + risk tier; BSA/AML and PCI consumers; CRITICAL tier fires an Activator alert |

They ship as `endorsement: 'promoted'` **on purpose**. Promotion means
*ready-for-review*; certification is a human governance act performed after you have
reviewed classification, lineage, and ownership. Pre-stamping "Certified" would be the
exact vaporware this platform forbids.

### 17 glossary terms

`Customer`, `Account`, `Transaction`, `SKU`, `MRR`, `ARR`, `NPS`, `CLV`, `Cohort`,
`Attribution`, `Funnel`, `Conversion`, `Churn`, `Retention`, `AOV`, `Risk Tier`,
`CTR Flag`. Each carries a precise, arguable definition — e.g. *Customer* is
explicitly distinguished from *Account* (the billing relationship), and *CTR Flag* is
tied to the USD $10,000 FinCEN threshold under 31 CFR 1010.311. These are the
definitions a steward defends in a review, not filler.

### The semantic model

Five tables — `DimCustomer`, `DimProduct`, `DimDate`, `FactSales`, `FactInventory` —
with 12 measures: `Total Sales`, `Total Margin`, `Gross Margin %`,
`Average Order Value`, `New Customers`, `Repeat Rate %`, `Sales YoY %`, `Sales MTD`,
`Sales YTD`, `On-Hand Units`, `Inventory Value`, `Stockout SKUs`.

!!! info "One active date relationship, on purpose"
    `FactSales` has two date roles (`OrderDateKey`, `ShipDateKey`), but Power BI /
    Tabular allows only one **active** relationship between two tables and the bundle
    schema carries no `isActive` flag. So the model declares exactly the active set:
    `FactSales[OrderDateKey] → DimDate[DateKey]`. `New Customers` is written against
    that single active relationship rather than `USERELATIONSHIP`, so the DAX stays
    internally consistent. `ShipDateKey` remains a queryable degenerate column; add the
    second (inactive) role relationship yourself in the model editor if you prefer the
    `USERELATIONSHIP` pattern.

## 4. First meaningful task — certify one product

This is the workflow the app exists for.

1. Open **`Steward-Certified Data Products`**. The header shows the product name, its
   status badge, an **Endorsed** badge when set, and the owner avatars. Tabs:
   **Details**, **Contract**, **Data Observability**, **Try it**.
2. Review before you sign off — this is the assessor-defensible order:
   - **Details** — owner (`Data Steward Team`), domain, description.
   - **Contract** — the shape consumers will bind to.
   - **Datasets** / **Glossary** (consumer view) — confirm each dataset's
     classification is right: `Fraud Scores` **must** be Restricted, `Customer 360`
     Confidential.
   - **Data Observability** — freshness / quality signals backing the SLA claim.
3. Click **Edit**. In the edit dialog set name/description/type/audience/owners and
   tick **"Endorsed — mark this data product as endorsed by the governance team."**
   The inline **Endorsed** badge previews the change. Save.
4. The header now carries the endorsement badge, and the change is written through to
   the Unified Catalog record.
5. Repeat only for products you have actually reviewed. Certifying all four in one
   click is how governance theatre starts.

### Then wire the shared definitions

Open **`Steward Business Glossary Model`** and check a measure, e.g.
`Gross Margin % = DIVIDE ( [Total Margin], [Total Sales] )`. This model is the "shared
business definitions" layer — when a downstream report disagrees with a steward's
number, this is the artifact you compare against. Point it at your own gold-layer
tables to make it real.

## 5. Verify it worked

- **Install dialog**: the data-product row is `created` and its step log names the
  Unified Catalog endpoint and the resolved governance domain.
- **Editor → Overview** (consumer view): **Catalog** reads
  `Registered <purviewDataProductId>` rather than "Not registered with the unified
  catalog". That id is the proof Purview accepted the write.
- **Purview portal**: the four products and the glossary terms appear under the
  governance domain.
- After step 4, the endorsement badge persists across a reload.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Row = `remediation`, "endpoint not configured" | Neither Purview variable set | Set `LOOM_PURVIEW_UC_ENDPOINT` (e.g. `https://api.purview-service.microsoft.com`) or `LOOM_PURVIEW_ACCOUNT`, restart the revision, **Retry** |
| "could not acquire an Entra token" | Console managed identity not configured | Confirm `LOOM_UAMI_CLIENT_ID` and that the identity has Catalog access on the Purview account |
| "No Purview governance domain bound, and Loom could not auto-provision one" | UAMI cannot create domains | Grant **Governance Domain Creator** (Unified Catalog → Catalog management → Roles), or create a published domain and pin `LOOM_PURVIEW_GOVERNANCE_DOMAIN_ID` |
| Overview shows "Not registered with the unified catalog" | Install ran with **Deploy artifacts** OFF, or the row gated | Re-run the install with deploy ON (idempotent) |
| Semantic-model row gated | No tabular target resolved | Set the model target for your deployment; the data-product half is unaffected |

## Cleanup

Delete both items, or the workspace. **Purview objects are real** — the data products
and glossary terms remain in the Unified Catalog; delete them there if you want them
gone.

## What's next

- [FedRAMP Compliance Tracker](fedramp-tracker.md) — the control-evidence half of the
  same governance story.
- [Data Governance & lineage accelerator](../../../learn/08-solutions/data-governance/lineage.md)
  — catalog, classification, and lineage end to end.
- [Tutorial 07 — Publish a marketplace data product](../07-marketplace-data-product.md)
  — take a certified product to consumers.
