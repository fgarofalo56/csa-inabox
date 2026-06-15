# unified-catalog — parity with Microsoft Purview Unified Catalog

**Source UI:** Microsoft Purview portal → Unified Catalog (Discovery +
Catalog management). Grounded in Microsoft Learn:
- https://learn.microsoft.com/purview/unified-catalog
- https://learn.microsoft.com/purview/unified-catalog-data-products
- https://learn.microsoft.com/purview/unified-catalog-enterprise-glossary
- https://learn.microsoft.com/purview/unified-catalog-data-products-search

**Loom surface:** `app/catalog/*` (+ shared `CatalogShell`).

## Cross-cloud infra reality

Same as governance: the Console is Commercial; the only Purview is in US Gov.
The Purview-backed tabs (Domains, Purview browse) render the honest
`PurviewGate` driven by `GET /api/governance/purview/status`. The Unity Catalog
and OneLake browse/search tabs do **not** need Purview and work today.

## Purview Unified Catalog inventory → Loom coverage

| Purview capability | Loom surface | Backend | Status |
|---|---|---|---|
| Federated search (by domain / product / keyword) | `/catalog` (Search) | `/api/catalog/search` → `searchPurview` (Atlas) + Unity + OneLake | ✅ BUILT (Purview leg ⚠️ GATED) |
| Browse — Unity Catalog tree | `/catalog/browse` (UC tab) | `/api/catalog/browse?source=unity-catalog` | ✅ BUILT |
| Browse — OneLake (Fabric) tree | `/catalog/browse` (OneLake tab) | `/api/catalog/browse?source=onelake` | ✅ BUILT |
| Browse — Purview domains tree | `/catalog/browse` (Purview tab) | `/api/catalog/browse?source=purview` (Atlas) | ⚠️ GATED |
| Governance domains (CRUD) | `/catalog/domains` | `/api/catalog/domains` (`/datagovernance/businessdomains`) | ⚠️ GATED |
| Data products (list/detail/register) | data-product editor + cross-source register | `registerDataProduct` / `registerAtlasEntity` | ⚠️ GATED |
| Glossary terms (Enterprise glossary) | admin Purview panel + `/api/catalog/glossary` | `listGlossaryTerms` / `createGlossaryTerm` | ⚠️ GATED |
| Permissions (Loom roles → Purview/UC/Fabric) | `/catalog/permissions` | `/api/catalog/permissions` | ✅ BUILT |
| Metastores (UC metastores, Purview accounts, OneLake) | `/catalog/metastores` | `/api/catalog/metastores` | ✅ BUILT |
| Federated lineage | `/catalog/lineage` | `/api/catalog/lineage` (+ Atlas when bound) | ✅ BUILT |
| Asset detail (description, columns, lineage) | `/catalog/[source]/[id]` | `/api/catalog/asset/[id]` (+ `getAssetDetail` Atlas) | ✅ BUILT (Purview leg ⚠️ GATED) |
| Register cross-source asset into Purview | catalog cross-source actions | `/api/catalog/register` → `registerAtlasEntity` | ⚠️ GATED |
| Shortcut creation (OneLake/UC) | catalog actions | `/api/catalog/shortcut` | ✅ BUILT |

## Backend per control

- Purview legs → `purview-client.ts` (`searchPurview`, `listBusinessDomains`,
  `registerAtlasEntity`, `getAssetDetail`, glossary helpers) over
  `<account>-api.purview.azure.com`.
- Unity Catalog legs → `unity-catalog-client.ts`.
- OneLake / Fabric legs → `onelake-catalog-client.ts` / `fabric-client.ts`.
- Connection state → `probePurview()` via `/api/governance/purview/status`.

### Unified-Catalog REST host (data-product CRUD, opt-in)

The data-product adapter (`purview-unified-store.ts` →
`purview-unified-client.ts`) speaks the **NEW** Unified Catalog data plane
(`/datagovernance/catalog/dataProducts`, api-version `2026-03-20-preview`),
which is served from the well-known **global** host
`https://api.purview-service.microsoft.com` (or a per-tenant
`https://{tenantId}-api.purview-service.microsoft.com`) — **NOT** the classic
`{account}.purview.azure.com` Data Map host (that host 404s on `/datagovernance`).
`admin-plane/main.bicep` therefore wires `LOOM_PURVIEW_UC_ENDPOINT` to
`https://api.purview-service.microsoft.com` on the **Commercial boundary only**
(previously it incorrectly hardcoded the classic host, which won over
`LOOM_PURVIEW_UNIFIED_ACCOUNT` and broke the opt-in backend). Token scope stays
`https://purview.azure.net/.default`. GCC / GCC-High / IL5 do not wire it — the
factory forces the Cosmos backend there.

## Grade

**A** for the BUILT (Unity/OneLake/permissions/metastores/lineage) surfaces.
The Purview legs are A-when-wired: full UI, real Atlas/Unified-Catalog REST,
honest `PurviewGate` (no raw JSON dump — fixed in this PR). Zero ❌, zero stub
banners.
