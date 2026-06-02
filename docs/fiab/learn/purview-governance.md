# Purview governance (classic Data Map)

Loom's governance and catalog surfaces — catalog browse/search, asset detail,
lineage, glossary, collections, and sources/scans — call the **classic
Microsoft Purview Data Map** data plane through the Console managed identity.
This guide walks the register → scan → classify → discover loop in the Loom UI,
one-for-one with the classic Purview governance portal.

## When to use it

- **Discover** what data exists across the estate and where it lives.
- **Classify** sensitive data (credit-card, national-ID, etc.) automatically
  during scans.
- **Trace lineage** from a report back through pipelines to source tables.
- **Curate** with a business glossary and organize sources into collections.

## Why classic Data Map

The Loom Purview client targets the API the ARM-provisioned account actually
exposes (host `{account}.purview.azure.com`, Atlas 2.2 / scanning data plane),
**not** the unified-catalog `-api` host that a classic account does not resolve.
See [Purview setup](../purview-setup.md) for the exact endpoints and token scope.

## Step-by-step: register, scan, classify, discover

1. **Register a source.** In the governance surface go to **Data Map → Data
   sources** and choose **New source** (e.g. ADLS Gen2, Azure SQL, Blob). Map it
   to a **collection** — this is where discovered metadata lands. Registering
   gives Purview the address of the source.
2. **Run a scan.** Select **New scan** under the source. Provide a meaningful
   name, choose a **credential** (prefer the Purview managed identity, then
   user-assigned MI, then service principal — least privilege), pick the
   **integration runtime**, and **Test connection**.
3. **Scope and rule set.** Optionally scope to specific folders/tables. Choose a
   **scan rule set** — the set of system + custom **classifications** the scan
   checks (credit card, passport, SWIFT, etc.). Create a new rule set inline if
   needed.
4. **Trigger.** Choose run-once or a schedule, then **Save and run**.
   Classifications are applied to **column** and **file** assets automatically
   (table assets get classifications via their columns; apply table-level ones
   manually). System rules require ≥ 8 distinct values in a column before
   matching.
5. **Discover.** Once ingestion completes, **search** the catalog by keyword,
   open an **asset detail** page to see schema + applied classifications, and
   open **lineage** to walk upstream/downstream (`direction=BOTH`).
6. **Curate.** Add **glossary** terms and align assets to friendly business
   terms; organize sources into **collections** for governance at the right
   scope.

## Honest infra gate

If `LOOM_PURVIEW_ACCOUNT` isn't set (or the Console UAMI lacks the Atlas/Graph
app-roles), the governance surface shows a `MessageBar` naming the account env
var and the bootstrap step that grants the roles. The catalog/lineage/scan UI
still renders so the workflow is visible.

## Tip

Keep classifications meaningful — unnecessary labels look noisy to consumers.
Configure the scan rule set once and correctly: editing a custom classification
or rule set triggers a **full** (costly) rescan.

## Learn more

- **MS Learn — [Microsoft Purview classic governance solutions](https://learn.microsoft.com/purview/legacy/governance-solutions-overview)**
- MS Learn — [Manage data sources (register & scan)](https://learn.microsoft.com/purview/data-map-data-sources-register-manage)
- MS Learn — [Scan data sources in Data Map](https://learn.microsoft.com/purview/data-map-scan-data-sources)
- MS Learn — [Automatically apply classifications](https://learn.microsoft.com/purview/data-map-classification-apply-auto)
- Loom — [Purview setup (all scenarios)](../purview-setup.md)
