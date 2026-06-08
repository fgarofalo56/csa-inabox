# data-product-observability — parity with Microsoft Purview Data Estate Health + Fabric Data product observability

Source UI:
- Microsoft Purview "Data Quality" / "Data estate health" (DQ score, rule results) — https://learn.microsoft.com/purview/data-quality-overview
- Microsoft Purview Data Map lineage — https://learn.microsoft.com/purview/concept-data-lineage
- Azure Data Explorer health/KQL charts (`render`) — https://learn.microsoft.com/kusto/query/render-operator

This surface is the **Data Observability** tab + **Data quality score gauge** on the
`data-product` editor (`lib/editors/apim-editors.tsx` → `DataProductEditor`). It is
Azure-native with **NO Microsoft Fabric dependency** (`no-fabric-dependency.md`):
lineage = Purview **classic** Data Map Atlas API; health charts + DQ score =
**Azure Data Explorer** KQL. Power BI / Fabric are not required on any path.

## Azure/Purview feature inventory

| Capability | Source UI |
|---|---|
| Data-quality score (0–100) for a data product | Purview DQ "Quality score" |
| Per-rule DQ result breakdown (rule, check, scope, pass/fail) | Purview DQ rule run results |
| Re-run data-quality assessment on demand | Purview "Run" DQ scan |
| Data-health charts (freshness, volume, null-rate) | Purview DEH + ADX `render` |
| Lineage graph (upstream/downstream assets) | Purview Data Map lineage |
| Refresh lineage | Purview lineage refresh |
| Trigger a Data Map scan on a registered source | Purview Data Map "Scan now" |

## Loom coverage

| Inventory row | Status | Where |
|---|---|---|
| DQ score gauge (0–100, color by band) | ✅ built | `DqScoreGauge` (Overview toolbar) |
| Per-rule DQ breakdown table | ✅ built | `ObservabilityTabContent` → DQ rules table |
| Re-run DQ checks (health-action card) | ✅ built | `ActionCard action=rerun-dq-check` → `POST …/health-actions` → `computeDqScore` (live ADX KQL) |
| Data-health charts (reachability, ingestion 7d, freshness, null-rate) | ✅ built | `runHealthCharts` (live ADX `/v1/rest/query`, `render` hints) |
| Lineage graph (nodes + edges) | ✅ built | `getLineageSubgraph` (Purview classic Atlas lineage) |
| Refresh lineage (health-action card) | ✅ built | `ActionCard action=refresh-lineage` |
| Trigger Purview scan (source+scan dropdowns) | ✅ built | `TriggerScanCard` → `triggerScanRun` |
| ADX not configured | ⚠️ honest-gate | MessageBar naming `LOOM_KUSTO_CLUSTER_URI`; tab still renders, no fake charts |
| Purview not configured | ⚠️ honest-gate | MessageBar naming `LOOM_PURVIEW_ACCOUNT`; lineage section gated |

Zero ❌, zero stub banners.

## Backend per control

| Control | Backend |
|---|---|
| DQ score gauge / breakdown | `GET /api/data-products/[id]/observability` → `computeDqScore` → ADX `executeQuery` over the tenant's DQ rules (`tenantSettings` `dq-rules:<tenantId>`) |
| Health charts | same GET → `runHealthCharts` → ADX `executeQuery` (`POST /v1/rest/query`) |
| Lineage graph | same GET → `getLineageSubgraph` → Purview `/datamap/api/atlas/v2/lineage/{guid}` |
| Re-run DQ checks | `POST /api/data-products/[id]/health-actions {action:'rerun-dq-check'}` → `computeDqScore` |
| Refresh lineage | `POST …/health-actions {action:'refresh-lineage'}` → `getLineageSubgraph` |
| Trigger scan | `POST …/health-actions {action:'trigger-scan', source, scan}` → `triggerScanRun`; sources/scans listed via `GET /api/governance/scans` |

## Env / infra (already bicep-synced)

- `LOOM_KUSTO_CLUSTER_URI` — ADX cluster URI. Wired in `platform/fiab/bicep/modules/admin-plane/main.bicep` (from `adx-cluster.bicep` output or BYO cluster). Cloud-suffix-correct via `kustoClusterUri()` / Bicep `var kustoSuffix`.
- `LOOM_PURVIEW_ACCOUNT` — Purview account name. Wired in the same module.

No new env var, resource, or Cosmos container is introduced — the DQ rule store
(`dq-rules:<tenantId>` in `tenantSettings`) already exists from
`/api/admin/data-quality-rules`.
