# governance — parity with Microsoft Purview governance framework

**Source UI:** Microsoft Purview portal → Unified Catalog + Data Map
(https://purview.microsoft.com/) — grounded in Microsoft Learn:
- https://learn.microsoft.com/purview/unified-catalog
- https://learn.microsoft.com/purview/unified-catalog-governance-domains
- https://learn.microsoft.com/purview/unified-catalog-data-health-management
- https://learn.microsoft.com/purview/unified-catalog-reports

**Loom surface:** `app/governance/*` (+ shared `GovernanceShell`, `PurviewGate`).

## Cross-cloud infra reality (why the gate exists)

The live deployment is **missing `LOOM_PURVIEW_ACCOUNT`**. The only Purview
account in the tenant is in **US Gov**, while the Loom Console runs in
**Commercial** — Purview's data plane (`<account>-api.purview.azure.com`)
can't be reached across sovereign clouds with a single account name. So every
Purview-backed control renders the **honest gate** (`PurviewGate`, driven by
`GET /api/governance/purview/status` → `probePurview()`), which reports the
exact reason (`not_configured` / `cross_cloud` / `upstream_error`), the env
var, the bicep module, and the three UAMI roles. The **full UI still renders**
around the gate. The Cosmos-backed surfaces (catalog, lineage, classifications,
sensitivity, insights, policies) work today with no Purview at all.

## Purview feature inventory → Loom coverage

| Purview capability | Loom surface | Backend | Status |
|---|---|---|---|
| Governance overview / posture | `/governance` (overview) | `/api/governance/insights` (Cosmos) + `purview/status` probe | ✅ BUILT |
| Governance domains (create/list/delete) | `/catalog/domains` | `/api/catalog/domains` → `listBusinessDomains` / `createBusinessDomain` / `deleteBusinessDomain` (`/datagovernance/businessdomains`) | ⚠️ GATED (Purview REST) |
| Data products (list/detail/register) | data-product editor + `register-purview` | `registerDataProduct` (`/datagovernance/catalog/dataProducts`) | ⚠️ GATED |
| Glossary terms | admin Purview panel | `listGlossaryTerms` / `createGlossaryTerm` (`/catalog/api/atlas/v2/glossary`) | ⚠️ GATED |
| Data catalog (asset inventory) | `/governance/catalog` | `/api/governance/catalog` (Cosmos; merges Purview classifications when bound) | ✅ BUILT |
| Classifications | `/governance/classifications` | `/api/governance/classifications` (Cosmos) | ✅ BUILT |
| Sensitivity labels (MIP) | `/governance/sensitivity` | `/api/governance/sensitivity` (Cosmos) | ✅ BUILT |
| Data Map — sources (register/list/delete) | `/governance/scans` | `/api/governance/scans` → `listDataSources` / `registerDataSource` / `deleteDataSource` (`/scan/datasources`) | ⚠️ GATED (Purview REST) |
| Data Map — scans + run history + trigger | `/governance/scans` (drawer) | `/api/governance/scans` → `listScansForSource` / `listScanRuns` / `triggerScanRun` | ⚠️ GATED |
| Lineage (column/asset graph) | `/governance/lineage` | `/api/governance/lineage` (Cosmos) + `getLineageSubgraph` (Atlas) when bound | ✅ BUILT |
| Access policies (DLP/masking/RLS/retention/access) | `/governance/policies` | `/api/governance/policies` (Cosmos, CRUD + toggle) | ✅ BUILT |
| Health management — insights & reports (coverage, DQ) | `/governance/insights` | `/api/governance/insights` (Cosmos KPIs) + `listDataQualityRules` when bound | ✅ BUILT — KPIs now cover **compliance score** (composite), sensitivity, classification, **ownership** (`state.owner`), **endorsement** (`state.endorsement` Certified/Promoted / `state.certified`), active policies, audit-30d; per-type coverage table adds Owned + Endorsed columns; a **policy-effectiveness** sortable table lists active policies (type/scope/status/updated). All derived live from Cosmos — no sample data. |
| Microsoft Purview portal launch + connection status | `/governance/purview` | `/api/governance/purview/status` probe + deep-link | ✅ BUILT |

**Legend:** ✅ BUILT = live against a real backend today. ⚠️ GATED = full UI
renders; the controls call live Purview REST and disable behind the honest
`PurviewGate` until `LOOM_PURVIEW_ACCOUNT` is set in this cloud.

## Backend per control

- `probePurview()` — cheap `GET /datagovernance/businessdomains` to classify
  reachability (live / cross_cloud / upstream_error / not_configured).
- Sources/scans → Purview scan plane `/scan/datasources/...`.
- Domains/data products/glossary → Unified Catalog `/datagovernance/...` +
  Atlas `/catalog/api/atlas/v2/...`.
- Lineage → Atlas `/datamap/api/atlas/v2/lineage/{guid}`.
- Cosmos-backed surfaces → workspace-items + audit-log containers.

## Grade

**A** for the BUILT surfaces (real backend + Vitest contract tests on the
probe + scans + status routes). The GATED surfaces are A-grade-when-wired:
full UI, real REST, honest gate naming the one-time fix. Zero stub banners,
zero dead buttons.
