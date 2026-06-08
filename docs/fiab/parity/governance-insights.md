# governance-insights — parity with Microsoft Purview Unified Catalog Data Health / OneLake Catalog Govern reports (F2)

**Source UI:** Microsoft Purview portal → **Unified Catalog → Health management
(insights & reports)** and Fabric **OneLake Catalog → Govern** posture/report
tiles. Grounded in Microsoft Learn:
- https://learn.microsoft.com/purview/unified-catalog-data-health-management
- https://learn.microsoft.com/purview/unified-catalog-reports
- https://learn.microsoft.com/fabric/governance/onelake-catalog-govern

**Loom surface:** `app/governance/insights/page.tsx` (+ `GovernanceShell`,
`LoomDataTable`).

## No-Fabric / no-Purview reality

Every KPI is computed live from the Cosmos catalog + audit log — **no Fabric, no
Power BI semantic model, no Purview**. Works with `LOOM_DEFAULT_FABRIC_WORKSPACE`
UNSET.

## Inventory → Loom coverage → backend per control

| Purview / Govern capability | Loom control | Backend per control | Status |
|---|---|---|---|
| Composite governance / compliance score | "compliance score" KPI card + bar | `GET /api/governance/insights` (`kpis.complianceScorePct`) → Cosmos composite | ✅ BUILT |
| Estate size (governed item count) | "total items" KPI | `/api/governance/insights` (`kpis.totalItems`) → Cosmos | ✅ BUILT |
| Sensitivity-label coverage % | "sensitivity coverage" KPI + bar | `/api/governance/insights` (`sensitiveCoveragePct`; `state.sensitivityLabel`) | ✅ BUILT |
| Classification coverage % | "classification coverage" KPI + bar | `/api/governance/insights` (`classificationCoveragePct`; `state.classifications`) | ✅ BUILT |
| Ownership coverage % | "ownership coverage" KPI + bar | `/api/governance/insights` (`ownershipCoveragePct`; `state.owner/ownerUpn/contact/steward`) | ✅ BUILT |
| Endorsement coverage % | "endorsement coverage" KPI + bar | `/api/governance/insights` (`endorsementCoveragePct`; `state.endorsement` Certified/Promoted / `state.certified`) | ✅ BUILT |
| Active-policy count | "active policies" KPI | `/api/governance/insights` (`activePolicies`) → Cosmos `tenant-settings` policies | ✅ BUILT |
| Audit volume (30d) | "audit events (30d)" KPI | `/api/governance/insights` (`auditEvents30d`) → Cosmos `audit-log` | ✅ BUILT |
| Coverage-by-asset-type report | "Coverage by item type" sortable/filterable `LoomDataTable` — Total / Sensitivity-labeled / Classified / Owned / Endorsed progress cells | `/api/governance/insights` (`coverage[]`) → Cosmos per-type rollup | ✅ BUILT |
| Policy-effectiveness report | "Policy effectiveness" `LoomDataTable` — Policy / Type / Scope / Status / Updated | `/api/governance/insights` (`policies[]`) → Cosmos `tenant-settings` policies | ✅ BUILT |
| Most-classified assets report | "Most classified items" table (item, classifications, count, open) | `/api/governance/insights` (`topClassified[]`) → Cosmos | ✅ BUILT |
| Refresh / recompute | "Refresh" re-runs the KPI computation | re-invokes `/api/governance/insights` | ✅ BUILT |

**Legend:** ✅ BUILT = real control + real backend today. No honest-gate-only and no MISSING rows — the
entire report is Azure-native Cosmos aggregation, no sample data.

## Grade

**A** — eight live KPIs + three sortable report tables, all derived from real
Cosmos catalog/audit aggregates; no Fabric/PBI/Purview dependency.
