# onelake-catalog-govern — parity with the Microsoft Fabric OneLake catalog **Govern** tab

Source UI: https://learn.microsoft.com/fabric/governance/onelake-catalog-govern
Loom surface: `apps/fiab-console/app/onelake/page.tsx` (page-level **Govern** pivot) →
`apps/fiab-console/lib/components/onelake/govern-view.tsx`
Backend: `apps/fiab-console/app/api/onelake/governance/route.ts`

The OneLake catalog in Fabric has two pivots — **Explore** (find/open items, already
shipped) and **Govern** (data-estate governance posture, this surface). The Govern tab
answers "how well-governed is the data in this tenant?" with score cards, a coverage
visual, an insights/classification breakdown, and an actionable "items needing
attention" list. Loom builds this 1:1 against **Azure-native** backends (Cosmos item
metadata + optional Microsoft Purview classic Data Map). No Microsoft Fabric, Power BI,
or OneLake-on-Fabric dependency — the score is computed with `LOOM_DEFAULT_FABRIC_WORKSPACE`
unset.

## Fabric feature inventory (grounded in Learn)

| # | Fabric Govern-tab capability | Notes |
|---|------------------------------|-------|
| 1 | **Governance score / health** — at-a-glance posture metrics for the data estate | Fabric surfaces label coverage, endorsement, sensitivity, ownership |
| 2 | **Sensitivity-label coverage** — % of items carrying a sensitivity label | |
| 3 | **Endorsement coverage** — % of items Certified/Promoted | |
| 4 | **Ownership coverage** — % of items with a known owner | |
| 5 | **Coverage visual** — donut/chart of labeled vs unlabeled | |
| 6 | **Classification / insights breakdown** — counts per classification across the estate | Fabric enriches via Purview scan classifications |
| 7 | **Items needing attention** — list of items missing governance metadata, deep-linked to the item so the steward can fix it | |
| 8 | **Purview enrichment** — scan-based classifications overlaid onto catalog items | Opt-in; not required for the base score |

## Loom coverage

| # | Capability | Status | Where |
|---|------------|--------|-------|
| 1 | Governance score (3 score cards) | built ✅ | `govern-view.tsx` `ScoreCard` ×3 |
| 2 | % Labeled | built ✅ | route `labeledPct` ← Cosmos `state.sensitivityLabel` |
| 3 | % Endorsed | built ✅ | route `endorsedPct` ← `state.endorsement` / `state.certified` |
| 4 | % With owner | built ✅ | route `ownedPct` ← `createdBy` |
| 5 | Label-coverage donut | built ✅ | `LabelDonut` (pure SVG `stroke-dasharray`) |
| 6 | Classification table (per-classification item counts) | built ✅ | `classificationTable` ← Cosmos `state.classifications` |
| 6b| Purview scan-hit overlay column | built ✅ (honest-gate ⚠️ when unset) | route `searchDataMapAssets` overlay; gate names `LOOM_PURVIEW_ACCOUNT` |
| 7 | Items needing attention + deep-links | built ✅ | `attention[]` → `router.push('/items/{type}/{id}')` |
| 8 | Purview enrichment (opt-in) | honest-gate ⚠️ | `MessageBar` naming `LOOM_PURVIEW_ACCOUNT` + `catalog.bicep` |
| — | F20 doc panel — one physical Delta read by Synapse SQL / Spark / ADX, no Power BI | built ✅ | `docPanel` section |

Zero ❌, zero stub banners. The only non-functional state is the honest Purview
infra-gate, and even then every score card, the donut, the Cosmos classification
counts, and the full attention list still render.

## Backend per control

| Control | Backend |
|---------|---------|
| Score cards / donut / attention | Cosmos `itemsContainer` + `workspacesContainer` (tenant-scoped to `session.claims.oid`) |
| Classification table (item counts) | Cosmos `state.classifications` |
| Classification table (scan-hit overlay) | Purview classic Data Map Discovery — `searchDataMapAssets({ entityTypes: ['fabric_lakehouse','azure_datalake_gen2_resource_set','azure_datalake_gen2_path'] })` |
| Purview gate | `isPurviewConfigured()` / typed `PurviewNotConfiguredError.hint` |
| Deep-links | `/items/{itemType}/{id}` (same nav as the Explore details `Open` button) |

## No-Fabric verification

`GET /api/onelake/governance` with `LOOM_DEFAULT_FABRIC_WORKSPACE` and
`LOOM_PURVIEW_ACCOUNT` both UNSET returns the full Cosmos-only score
(`labeledPct`/`endorsedPct`/`ownedPct`), the Cosmos classification table, the
deep-linked attention list, and a `purviewGate` hint naming `LOOM_PURVIEW_ACCOUNT`.
No `api.fabric.microsoft.com` / `api.powerbi.com` / `onelake.dfs.fabric` host is
reached on any path. Covered by `app/api/onelake/__tests__/governance.test.ts` (4/4).

## Bicep

No new infra. `LOOM_PURVIEW_ACCOUNT` is already wired from
`platform/fiab/bicep/modules/admin-plane/catalog.bicep` (output `purviewAccountName`)
through `admin-plane/main.bicep` apps[] env list. The route only reads the Data Map
(Discovery query) → the existing UAMI **Data Reader** grant on the root collection
(`scripts/csa-loom/grant-purview-datamap-role.sh`) is sufficient.
