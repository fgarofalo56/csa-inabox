# governance-irm — parity with Microsoft Purview Insider Risk Management (Lakehouse)

Fabric Build 2026 #35 — "IRM for Lakehouse indicators dashboard".

Source UI:
- Microsoft Purview Insider Risk Management — Activity explorer / Alerts dashboard
  (`learn.microsoft.com/purview/insider-risk-management-activities`)
- IRM policy indicators + cumulative-exfiltration detection
  (`learn.microsoft.com/purview/insider-risk-management-policies#cumulative-exfiltration-detection`)
- IRM risk-score boosters ("activity above the user's usual activity for that day")
  (`learn.microsoft.com/purview/insider-risk-management-settings-policy-indicators`)

## Why Azure-native (no Fabric / no Purview-IRM dependency)

Per `.claude/rules/no-fabric-dependency.md` the lakehouse default backend is
ADLS Gen2 + Delta — there is no OneLake/Fabric workspace to read IRM signals
from. This dashboard therefore computes insider-risk indicators over the data
Loom already collects:

| Signal source | Backend | Always available? |
|---------------|---------|-------------------|
| Loom audit log (actor / action / target) | Cosmos `audit-log` container | **Yes — primary** |
| App-access events | Azure Monitor / Log Analytics `AppTraces` (`queryLoomAppEvents`) | honest-gate on `LOOM_LOG_ANALYTICS_WORKSPACE_ID` |
| Lakehouse-load volume by submitter | Azure Monitor `ADFPipelineRun` / Synapse runs (`queryActivityFeed`) | honest-gate |
| Privileged control-plane ops | ARM Activity Log (`listActivityLog`) | best-effort |

With `LOOM_DEFAULT_FABRIC_WORKSPACE` unset and `LOOM_LOG_ANALYTICS_WORKSPACE_ID`
unset, the dashboard still renders and computes the two Cosmos-backed
indicators (unusual-volume, off-hours-access); the Monitor signals degrade to a
`gates.la` warning MessageBar naming the exact env var. No call to
`api.fabric.microsoft.com` / `api.powerbi.com` / OneLake on any path.

## Purview IRM feature inventory → Loom coverage

| Purview IRM capability | Loom coverage | Backend |
|------------------------|---------------|---------|
| Indicator catalog, **disabled by default**, operator opts in | ✅ `IRM_INDICATORS` typed catalog + per-indicator `Switch` toggles | tenant-settings `irm:<tenantId>` |
| Cumulative exfiltration detection (volume vs peer norm) | ✅ `unusual-volume` — per-actor exfil count vs mean + zσ | Cosmos audit log |
| Risk booster: activity above usual for the day (off-hours) | ✅ `off-hours-access` — events outside business hours + weekends, tz-aware | Cosmos audit log |
| Unusual privileged access | ✅ `privileged-access` — write/delete/role ops per caller | ARM Activity Log |
| Data-movement volume | ✅ `high-pipeline-volume` — pipeline/ingest runs per submitter | Log Analytics |
| Configurable thresholds (window, sensitivity) | ✅ structured `SpinButton`/`Dropdown`/`Switch` settings panel (no freeform JSON) | tenant-settings doc |
| Alerts dashboard with severity triage | ✅ severity-ranked indicators `LoomDataTable` + KPI stat cards | computed |
| User-risk leaderboard | ✅ "Top actors by risk" table (risk score, indicators, exfil/off-hours counts) | computed |
| Pseudonymization / privacy-by-design | ⚠️ actors shown as their audit-log identity (UPN/oid); pseudonymization is a follow-up | n/a |
| Analysis window selector | ✅ 7/14/30/60/90-day Dropdown | query param |

Zero ❌ on the core acceptance (unusual volume + off-hours over audit logs +
Monitor). Pseudonymization is noted as a future enhancement, not a stub.

## Backend per control

| Control | Calls |
|---------|-------|
| KPI cards + indicators table | `GET /api/governance/irm?days=N` → `computeIrmIndicators()` |
| Indicators & thresholds panel → Save | `POST /api/governance/irm` → `writeIrmThresholds()` (tenant-settings `irm:<tenantId>`) |
| Analysis window Dropdown | `GET /api/governance/irm?days=N` |
| Refresh | re-`GET` |

## Indicator math (deterministic; vitest-covered)

- **unusual-volume**: per-actor total of exfil-class verbs (`download/export/share/read/publish/copy/embed/print`); flag actors whose total `> mean + volumeZ·σ` and `>= minVolumeEvents`. Severity by z-score (≥3 high, ≥2 medium).
- **off-hours-access**: localize each event's timestamp to `timezone`; flag events with hour `< businessStart` or `>= businessEnd`, or on weekends when `flagWeekends`. Severity by count.
- **privileged-access**: ARM operations containing write/delete/action/role per caller; flag `>= privilegedMinEvents`.
- **high-pipeline-volume**: pipeline runs per human submitter (scheduled/manual triggers skipped); flag `>= pipelineMinRuns`.

Tests: `apps/fiab-console/lib/azure/__tests__/irm-client.test.ts` (17 cases).

## Bicep / bootstrap sync

No new Azure resource and no new env var. Reuses:
- the shared Log Analytics workspace already wired by
  `platform/fiab/bicep/modules/shared/diagnostic-settings.bicep`
  (`LOOM_LOG_ANALYTICS_WORKSPACE_ID`) and the UAMI's existing
  Monitoring Reader + Log Analytics Reader grants used by `monitor-client`;
- the existing Cosmos `audit-log` and `tenant-settings` containers.

The structured threshold doc `irm:<tenantId>` is created on first save via the
cosmos-client upsert (no migration needed) and is documented in
`docs/fiab/v3-tenant-bootstrap.md`.

## Verification

- tsc: `npx tsc --noEmit` — clean on `irm-client.ts`, the route, and the page.
- vitest: 17/17 pass (pure analyzers + catalog/threshold merge).
- Live: `GET /api/governance/irm` returns `{ ok, kpis, findings, topActors, indicators, thresholds, gates }`; with LAW unset, `gates.la` is populated and the Cosmos indicators still compute.
