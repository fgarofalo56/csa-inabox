# item-classifications — parity with Microsoft Purview asset Classifications

Source UI: Microsoft Purview Data Map → asset details → **Classifications** tab /
"Edit" → *"From the Classifications drop-down list, select one or more
classifications"* (Learn: `data-map-classification-apply-manual`,
`data-map-classification`). Classifications are explicitly **distinct from
sensitivity labels** in Purview.

This surface is the item-editor **Classifications** drawer (Tag icon in the item
side panel, next to Sensitivity label), available on every Loom item editor via
`ItemSidePanel`.

## Azure/Fabric feature inventory

| # | Capability (real Purview UI) | Notes |
|---|------------------------------|-------|
| 1 | Pick one or more classifications from a managed drop-down (never free-text) | Multiselect against the org's classification set |
| 2 | Classifications drawn from a defined taxonomy (system + custom classifications managed centrally) | Admin defines the standard set |
| 3 | View the classifications currently applied to the asset | Chips/list on the asset |
| 4 | Apply / persist the selection to the asset | Writes to the Data Map |
| 5 | Remove / clear applied classifications | |
| 6 | Selection feeds catalog reporting / insights (classification coverage) | Purview Insights → Classification |

## Loom coverage

| # | Capability | Status | How |
|---|-----------|--------|-----|
| 1 | Multiselect picker, no free-text | ✅ | `ClassificationPane` Fluent `<Dropdown multiselect>` bound to taxonomy; server rejects unknowns (`unknown_classification`). Data-product datasets free-text fallback removed. |
| 2 | Taxonomy-sourced options | ✅ | Reads `/api/governance/classification-types` (the #704 admin taxonomy, Cosmos `classification-types:<tid>`); honest deep-link to Governance → Classifications when empty |
| 3 | Show applied classifications | ✅ | Badge chips with taxonomy color swatch |
| 4 | Apply / persist | ✅ | `PUT /api/items/[type]/[id]/classifications` → `item.state.classifications` (Cosmos, authoritative every cloud) + audit row |
| 5 | Clear | ✅ | "Clear all" + empty-array PUT deletes `state.classifications` |
| 6 | Feeds catalog reporting | ✅ | `/api/governance/classifications`, `/api/governance/insights`, `/api/onelake/governance` already read `item.state.classifications` |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---------|---------|
| Taxonomy options | `GET /api/governance/classification-types` (Cosmos tenant-settings) |
| Current + load | `GET /api/items/[type]/[id]/classifications` (Cosmos item doc) |
| Save / Clear | `PUT /api/items/[type]/[id]/classifications` → Cosmos `state.classifications` + audit-log; best-effort Purview Atlas tag (`ensureClassificationDefs` + `addAssetClassification`, typedef `LOOM.CLASSIFICATION.<SLUG>`) |

## Per-cloud

- **Authoritative store is the Loom catalog (Cosmos) in every cloud** — no
  Microsoft Fabric / Power BI / real Purview dependency
  (`.claude/rules/no-fabric-dependency.md`). Works with
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset.
- Optional Atlas enrichment mirrors `./sensitivity` cloud matrix:
  Commercial/GCC `*.purview.azure.com`; GCC-High `*.purview.azure.us`; IL5
  Purview not deployed → Cosmos-only, `purviewStatus:'skipped:purview_not_configured'`,
  honest gate naming `LOOM_PURVIEW_ACCOUNT` (`.claude/rules/no-vaporware.md`).

## Bicep + bootstrap sync

No new infra. Reuses the existing Cosmos `tenant-settings` container (declared in
`platform/fiab/bicep/modules/landing-zone/cosmos.bicep`, auto-ensured at runtime
in `lib/azure/cosmos-client.ts`). Already in sync.
