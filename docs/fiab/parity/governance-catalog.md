# governance-catalog — parity with Microsoft Purview Unified Catalog (Discovery) / Fabric OneLake Catalog Explore (F1)

**Source UI:** Microsoft Purview portal → **Unified Catalog → Data assets /
Discovery**, and Fabric **OneLake Catalog → Explore**. Grounded in Microsoft
Learn:
- https://learn.microsoft.com/purview/unified-catalog
- https://learn.microsoft.com/purview/unified-catalog-data-products-search
- https://learn.microsoft.com/fabric/governance/onelake-catalog-overview

**Loom surface:** `app/governance/catalog/page.tsx` (+ `GovernanceShell`,
`LoomDataTable`).

## No-Fabric / no-Purview reality

The catalog is a **real tenant data-asset inventory backed by Cosmos** — it
works with no Fabric workspace and no Purview account. When a Purview account is
bound, the response merges Purview-only classifications and flips the `source`
badge to `purview`; until then `source: cosmos` and the full grid still renders.

## Inventory → Loom coverage → backend per control

| Purview / OneLake-Explore capability | Loom control | Backend per control | Status |
|---|---|---|---|
| Asset inventory grid (Name / Type / Owner / Workspace / Sensitivity / Endorsement / Updated) | `LoomDataTable` columns: Name (+ Certified/Promoted endorsement badge), Type, Workspace, Owner, Classifications, Sensitivity, Size, Updated, Open | `GET /api/governance/catalog` → Cosmos `workspace-items` ⋈ `workspaces` (filtered to data item-types) | ✅ BUILT |
| Keyword search across assets | Search `Input` (`?q=`) — name / owner / classification / workspace | `GET /api/governance/catalog?q=` (Cosmos query) | ✅ BUILT |
| Faceted filter by asset type | Type filter chips with live counts (lakehouse / warehouse / semantic-model / KQL DB / mirrored / data-product / vector-store …) | `GET /api/governance/catalog?type=` | ✅ BUILT |
| Asset detail pane (description, classifications, owner, sensitivity, size, rows, updated) | Overlay `Drawer` with type/endorsement/sensitivity badges, description, metadata grid | `GET /api/governance/catalog` row payload (Cosmos `state`) | ✅ BUILT |
| Open asset in its editor | "Open in editor" → `/items/{type}/{id}` | client route into the item editor | ✅ BUILT |
| View asset lineage | "View lineage" → `/governance/lineage?focusId=` | hands off to lineage surface (Cosmos lineage graph) | ✅ BUILT |
| Request access to a discoverable asset | "Request access" form (permission dropdown Read/Write/Admin + justification) | `POST /api/catalog/request-access` → durable Cosmos audit-log entry on the asset + owner notification | ✅ BUILT |
| Endorsement (Certified / Promoted) surfacing | endorsement badge in grid + drawer | Cosmos `state.endorsement` / `state.certified` | ✅ BUILT |
| Sensitivity label surfacing | colour-coded sensitivity badge (Highly Confidential → danger) | Cosmos `state.sensitivityLabel` | ✅ BUILT |
| Purview-only classification enrichment | merged into each row's Classifications when bound | `getAssetDetail` / classification merge over `<account>.purview.azure.com` | ⚠️ honest-gate (Purview leg; grid renders fully on Cosmos default) |

**Legend:** ✅ BUILT = real control + real backend today. ⚠️ honest-gate = the
control renders and works on the Azure-native default; the Purview enrichment
leg activates only when `LOOM_PURVIEW_ACCOUNT` is bound in this cloud. No MISSING rows.

## Grade

**A** — every column, filter, drawer action and the Request-access POST hit a
real Cosmos route; the only gated path is optional Purview classification merge,
which never blocks the Azure-native inventory.
