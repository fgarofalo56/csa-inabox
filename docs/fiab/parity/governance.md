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
| Governance domains (create/edit/delete/list) | `/governance` domains + `/catalog/domains` | `/api/governance/domains` (+ `[domainId]`, `[domainId]/assignWorkspaces`) → `getDomainsStore()`: **Cosmos `governance-domains` CRUD (default)** + best-effort Purview classic-collection mirror (`createBusinessDomain`/`updateBusinessDomain`/`deleteBusinessDomain` → `/collections/{ref}`); opt-in Fabric Admin `/v1/admin/domains` via `LOOM_DOMAINS_BACKEND=fabric` | ✅ BUILT (F4 — Azure-native, no Fabric/Purview hard dependency) |
| Data products (list/detail/register) | data-product editor + `register-purview` | `registerDataProduct` (`/datagovernance/catalog/dataProducts`) | ⚠️ GATED |
| Glossary terms | admin Purview panel | `listGlossaryTerms` / `createGlossaryTerm` (`/catalog/api/atlas/v2/glossary`) | ⚠️ GATED |
| Data catalog (asset inventory) | `/governance/catalog` | `/api/governance/catalog` (Cosmos; merges Purview classifications when bound) | ✅ BUILT — click (or right-click) an asset → **detail drawer** (type, workspace, owner, classifications, sensitivity, **endorsement/certified**, rows, size, updated, description) with **Open in editor**, **View lineage**, and a real **Request access** action (`/api/catalog/request-access` → durable audit-log entry on the asset + requester notification; owner grants via Policies). |
| Classifications | `/governance/classifications` | `/api/governance/classifications` (Cosmos) | ✅ BUILT |
| Sensitivity labels (MIP) | `/governance/sensitivity` | `/api/governance/sensitivity` (Cosmos) | ✅ BUILT |
| Data Map — sources (register/list/delete) | `/governance/scans` | `/api/governance/scans` → `listDataSources` / `registerDataSource` / `deleteDataSource` (`/scan/datasources`) | ⚠️ GATED (Purview REST) |
| Data Map — scans + run history + trigger | `/governance/scans` (drawer) | `/api/governance/scans` → `listScansForSource` / `listScanRuns` / `triggerScanRun` | ⚠️ GATED |
| Lineage (column/asset graph) | `/governance/lineage` | `/api/governance/lineage` (Cosmos) + `getLineageSubgraph` (Atlas) when bound | ✅ BUILT |
| Access policies (DLP/masking/RLS/retention/access) | `/governance/policies` | `/api/governance/policies` (Cosmos, CRUD + toggle) | ✅ BUILT — **Access** grants are REAL Azure-native data-plane grants across three scopes: **ADLS container** (Storage RBAC), **warehouse** (Synapse dedicated SQL Entra DB user + db_datareader/writer/owner), **KQL database** (ADX `.add database` viewers/users/admins). Symmetric revoke on policy delete. workspace/item/collection still honest-`pending`. |
| **DLP policies + violations + tips (F22)** | `/governance/policies` (DLP card) + `/admin/security` DLP panel | `dlp-graph-client` (Graph) + `/api/governance/dlp/*` | ✅ BUILT — see DLP section below |
| Health management — insights & reports (coverage, DQ) | `/governance/insights` | `/api/governance/insights` (Cosmos KPIs) + `listDataQualityRules` when bound | ✅ BUILT — KPIs now cover **compliance score** (composite), sensitivity, classification, **ownership** (`state.owner`), **endorsement** (`state.endorsement` Certified/Promoted / `state.certified`), active policies, audit-30d; per-type coverage table adds Owned + Endorsed columns; a **policy-effectiveness** sortable table lists active policies (type/scope/status/updated). All derived live from Cosmos — no sample data. |
| Microsoft Purview portal launch + connection status | `/governance/purview` | `/api/governance/purview/status` probe + deep-link | ✅ BUILT |

**Legend:** ✅ BUILT = live against a real backend today. ⚠️ GATED = full UI
renders; the controls call live Purview REST and disable behind the honest
`PurviewGate` until `LOOM_PURVIEW_ACCOUNT` is set in this cloud.

## Backend per control

- `probePurview()` — cheap `GET /datagovernance/businessdomains` to classify
  reachability (live / cross_cloud / upstream_error / not_configured).
- **Governance domains (F4)** → `lib/azure/domains-client.ts` `getDomainsStore()`.
  DEFAULT (`LOOM_DOMAINS_BACKEND` unset/`cosmos`): one doc per domain in the
  Cosmos `governance-domains` container (PK `/tenantId`), mirrored best-effort
  to a Purview **classic Data Map collection** (`PUT /collections/{ref}`, api
  `2019-11-01-preview`) when `LOOM_PURVIEW_ACCOUNT` is set + the UAMI holds
  Collection Admin. `assignWorkspaces` patches each `workspaces` doc's `domain`
  field. **Works with NO Fabric workspace and NO Purview account** — the mirror
  is non-fatal. OPT-IN (`LOOM_DOMAINS_BACKEND=fabric`, Commercial/GCC only —
  the BFF throws `DomainsBackendGateError` at `LOOM_CLOUD_TIER=IL5`): Fabric
  Admin `POST/PATCH/DELETE /v1/admin/domains` + `/assignWorkspaces`. Every
  mutation writes a `governance-domain.*` event to the Cosmos `audit-log`
  container (Purview Audit categories do not cover collection CRUD).
  Domain gallery images load from `LOOM_DOMAIN_IMAGES_URL` (catalog.bicep blob,
  Storage Blob Data Reader on the Console UAMI).
- Sources/scans → Purview scan plane `/scan/datasources/...`.
- Domains/data products/glossary → Unified Catalog `/datagovernance/...` +
  Atlas `/catalog/api/atlas/v2/...`.
- Lineage → Atlas `/datamap/api/atlas/v2/lineage/{guid}`.
- Cosmos-backed surfaces → workspace-items + audit-log containers.

## Data loss prevention (F22) — DLP policies + violations + tips

**Source UI:** Microsoft Purview compliance portal → Data loss prevention
(policies, alerts, activity explorer / DLPRuleMatch, policy tips, restrict
access) — grounded in Microsoft Learn (`/graph/deployments`,
`/graph/api/resources/security-api-overview`) and the live Purview portal.

**Loom surfaces:** the `/governance/policies` **DLP card** (everyday view) and
the `/admin/security` **DLP panel** Violations sub-tab (power-user view).

| Purview DLP capability | Loom coverage | Backend per control |
|---|---|---|
| DLP policy list + rules | ✅ BUILT (Commercial/GCC) · ⚠️ honest-gate in GCC-High/IL5 | `listDlpPolicies` / `listDlpRules` → `GET /beta/security/dataLossPreventionPolicies` |
| Per-item violations list | ✅ BUILT (all clouds) | `listDlpViolations` → `GET /v1.0/security/alerts_v2` (shaped per item from evidence) |
| Last-scan timestamp | ✅ BUILT | `dlp-meta:<tenant>` Cosmos doc `lastScannedAt` (stamped on each violations refresh) |
| Trigger scan | ⚠️ honest-gate (no Graph REST trigger exists) | `triggerScan` → typed 501 + `Start-Scan` / Purview portal "Scan now" link; request timestamp recorded |
| Per-item policy-tip badges | ✅ BUILT | DLP rows badge `N tips` (best-effort name match vs. violations) / `monitored`; Access rows badge `restricted` |
| Restrict access (revoke) | ✅ BUILT (real RBAC/data-plane) | `POST /api/governance/dlp/restrict` → ADLS Storage-RBAC revoke (ARM read-back confirmed) · warehouse/KQL inverse grant; writes `policies` + `dlp-meta` (item-permissions) |
| DoD / Gov honest-gate | ✅ BUILT | `MessageBar` when `graphDlpPolicyApiAvailable()===false`; names the gap + `compliance.microsoft.us` |

**National-cloud reality (grounded in Learn `/graph/deployments`):** the `/beta`
DLP *policy* segment is not exposed on the US Gov (`graph.microsoft.us`) or DoD
(`dod-graph.microsoft.us`) Graph roots, so policy list/rules honest-gate there
while violations (`alerts_v2`, GA on all roots) and restrict-access RBAC keep
working. `cloud-endpoints.graphBase()`/`graphScope()` pick the correct root from
`AZURE_CLOUD` / `LOOM_CLOUD_BOUNDARY` (wired by `admin-plane/main.bicep`).

**No-vaporware notes:** there is **no public Graph REST API** to trigger the
Purview Information Protection scanner or read its status — both surface honest
gates with the exact `Start-Scan` / `Get-ScanStatus` cmdlet + portal link rather
than a faked response. Violations are mapped only from real `alerts_v2` evidence
(never synthesized). Restrict-access performs a real ARM role-assignment DELETE
and re-reads ARM to confirm the principal no longer holds the role.

## Grade

**A** for the BUILT surfaces (real backend + Vitest contract tests on the
probe + scans + status routes). The GATED surfaces are A-grade-when-wired:
full UI, real REST, honest gate naming the one-time fix. Zero stub banners,
zero dead buttons.
