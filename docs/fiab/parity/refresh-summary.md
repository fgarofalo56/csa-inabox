# refresh-summary — parity with Power BI dataset refresh history + schedule

Source UI: Power BI **Dataset → Refresh history** + **Scheduled refresh** settings
Reference: <https://learn.microsoft.com/rest/api/power-bi/datasets/get-refresh-history-in-group>
Run date: 2026-06-09

Loom surfaces:

- History BFF: `app/api/items/semantic-model/[id]/refreshes/route.ts`
- Schedule BFF: `app/api/items/semantic-model/[id]/refresh-schedule/route.ts`
- Client: `lib/azure/powerbi-client.ts` → `listRefreshHistory`,
  `getRefreshSchedule`, `patchRefreshSchedule`, `refreshDataset`, `takeOverDataset`

Refresh history + scheduling target the Power BI REST data plane. Per
`no-fabric-dependency.md`, Power BI is Fabric-family and strictly **opt-in**: the
semantic-model item's default backend is the Loom-native tabular layer (see
`semantic-model.md`), and this Power-BI refresh surface activates only when a
Power BI workspace is bound. When unbound, the surface honest-gates rather than
blocking. It does not require `LOOM_DEFAULT_FABRIC_WORKSPACE`.

## Fabric/Azure feature inventory (grounded in Learn)

1. Refresh history (status, start/end, type, error detail)
2. Trigger an on-demand refresh
3. View scheduled-refresh configuration
4. Edit schedule (enabled, days, times, timezone, failure notification)
5. Take over a dataset to manage its schedule

## Loom coverage

| Capability | Status | Backend |
|---|---|---|
| Refresh history (status, startTime, endTime, type, error) | ✅ Built | `GET …/refreshes?workspaceId=&top=25` → `listRefreshHistory()` → PBI REST `GET /groups/{ws}/datasets/{id}/refreshes` |
| On-demand refresh trigger | ✅ Built | `POST …/refresh` → `refreshDataset()` |
| Read scheduled-refresh config | ✅ Built | `GET …/refresh-schedule` → `getRefreshSchedule()` |
| Update schedule (enabled, days, times, timezone, failure notification) | ✅ Built | `PATCH …/refresh-schedule` → `patchRefreshSchedule()` → PBI REST `PATCH …/refreshSchedule` |
| 400 guard (enabled=true without day+time) | ✅ Built | route validates days (`VALID_DAYS` Set) + times (`TIME_RE` regex) |
| Take over dataset (fix ownership for schedule PATCH 400) | ✅ Built | `POST …/take-over` → `takeOverDataset()` |
| Honest gate when PBI SP not configured / workspace unbound | ⚠️ Honest gate | `powerbiConfigGate()` → 503 naming `LOOM_UAMI_CLIENT_ID` + SP authorization steps |

Zero ❌ rows. The single ⚠️ gate keeps the surface honest when no Power BI
workspace / SP is bound — consistent with Power BI being opt-in per
`no-fabric-dependency.md`. With a bound workspace, every control hits real PBI
REST, per `no-vaporware.md`.

## Backend per control

- **History** — `listRefreshHistory()` calls PBI REST `GET
  /groups/{ws}/datasets/{id}/refreshes?$top=N`.
- **On-demand** — `refreshDataset()` POSTs a refresh.
- **Schedule read/write** — `getRefreshSchedule()` / `patchRefreshSchedule()`;
  the PATCH route validates `days` against `VALID_DAYS` and each time against
  `TIME_RE` before calling REST, and refuses `enabled:true` without at least one
  day + time.
- **Take over** — `takeOverDataset()` resolves the 400 that PBI returns when the
  SP doesn't own the dataset, then the schedule PATCH succeeds.
- **Gate** — `powerbiConfigGate()` returns a 503 naming `LOOM_UAMI_CLIENT_ID` +
  the SP-authorization steps when Power BI isn't configured.

## Per-cloud notes

| Cloud | Power BI REST endpoint |
|---|---|
| Commercial | `api.powerbi.com` |
| GCC | `api.powerbigov.us` |
| GCC-High / IL5 | `api.powerbigov.us` / `api.high.powerbigov.us` — resolved via `cloud-endpoints.ts` |

Refresh + schedule are available across all clouds where a Power BI capacity is
bound; absent a binding the surface honest-gates everywhere.

## Bicep sync

- No new resource — Power BI is an opt-in tenant binding, not a Loom-deployed
  resource.
- `LOOM_UAMI_CLIENT_ID` is already in the `apps[]` env list; the Power BI SP
  authorization is a documented tenant bootstrap step
  (`docs/fiab/v3-tenant-bootstrap.md`), surfaced in-product as the honest gate.

## Verification

- Default path: with no Power BI workspace bound (and
  `LOOM_DEFAULT_FABRIC_WORKSPACE` unset), the surface shows the honest gate, not
  an error — the semantic-model item itself still works on the Loom-native
  tabular layer.
- Live walk (PBI bound): open a semantic model's Refresh tab, confirm the history
  grid populates from real PBI REST, trigger an on-demand refresh, edit the
  schedule (days + times + timezone), confirm the 400 guard rejects an empty
  schedule, and take over a dataset to fix an ownership 400.

Grade: **A** — full history + on-demand + schedule + take-over on real Power BI
REST; the only gate is the honest, opt-in Power-BI-not-bound state.

---

# refresh-summary — parity with Fabric Monitor hub → Refresh history / schedule

Source UI:
- Fabric Monitor hub — https://learn.microsoft.com/fabric/admin/monitoring-hub
- Pipeline/dataflow run monitoring + refresh schedule — https://learn.microsoft.com/azure/data-factory/monitor-visually
- LA tables: ADFPipelineRun — https://learn.microsoft.com/azure/azure-monitor/reference/tables/adfpipelinerun ·
  SynapseIntegrationPipelineRuns — https://learn.microsoft.com/azure/azure-monitor/reference/tables/synapseintegrationpipelineruns

Loom surface: Monitor page → **Refresh summary** tab (`/monitor?tab=refresh`).
Pane: `apps/fiab-console/lib/panes/refresh-summary.tsx`.
Route: `apps/fiab-console/app/api/admin/refresh-summary/route.ts`.

No-Fabric: Azure-native by default. Run history reads the Azure Data Factory /
Synapse run tables in **Log Analytics**; next-run reads **ADF triggers** (ARM).
Functions with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. No Fabric/Power BI host on
any path.

## Azure/Fabric feature inventory

| # | Capability (Fabric Monitor / refresh history) | Notes |
|---|----------------------------------------------|-------|
| 1 | Per-item refresh/run overview — one row per pipeline/dataflow | The "Refresh history" roll-up |
| 2 | Last run timestamp + status (Succeeded/Failed/InProgress/Queued/Cancelled) | From run tables |
| 3 | Run duration | Start→End |
| 4 | Error surfaced for failed runs | ErrorCode/ErrorMessage |
| 5 | Next scheduled run | From the item's trigger/refresh schedule |
| 6 | Recurrence cadence label (e.g. "Every 4 hours") | Schedule metadata |
| 7 | Filter by status | |
| 8 | Filter by workspace | |
| 9 | Filter by item name | |
| 10 | Time-window selector | Last 24h / 7d / 14d / 30d |
| 11 | Manual refresh of the view | |
| 12 | Sortable / resizable / filterable grid | Loom table standard |

## Loom coverage

| # | Capability | Status | Backend per control |
|---|-----------|--------|---------------------|
| 1 | Per-item overview (one row per pipeline) | ✅ built | LA KQL `ADFPipelineRun \| summarize arg_max(Start,*) by PipelineName` (+ `SynapseIntegrationPipelineRuns` when `LOOM_SYNAPSE_WORKSPACE` set) via `queryLogs()` |
| 2 | Last run + status badge | ✅ built | `Status` column from LA; `statusBadge()` colour map |
| 3 | Duration | ✅ built | `End - Start` → `fmtDuration()` |
| 4 | Failure error (badge tooltip) | ✅ built | `ErrorCode: ErrorMessage` joined; shown on the status cell `title` |
| 5 | Next scheduled run | ✅ built | `adf-client.listTriggers()` (ARM) → `computeNextRun()` projects next occurrence past now from `ScheduleTrigger.typeProperties.recurrence` |
| 6 | Recurrence label | ✅ built | `recurrenceDesc()` from `recurrence.frequency + interval` |
| 7 | Filter by status | ✅ built | `?status=` server-side filter + client `LoomColumn.filterType:'select'` |
| 8 | Filter by workspace | ✅ built | `?workspace=` server-side filter; options from Cosmos workspace enrichment |
| 9 | Filter by item name | ✅ built | `LoomColumn.filterType:'text'` on Item column |
| 10 | Time-window selector | ✅ built | `?days=` (1/7/14/30) → LA `timespan` |
| 11 | Manual refresh | ✅ built | `Refresh` button → re-fetch tick |
| 12 | Sortable/resizable/filterable grid | ✅ built | `LoomDataTable` |
| — | No Log Analytics configured | ⚠️ honest-gate | Route returns `gate:{missing:['LOOM_LOG_ANALYTICS_WORKSPACE_ID']}`; pane renders a Fluent `MessageBar intent="warning"` naming the env var |
| — | No ADF configured | ⚠️ honest-gate | `adfConfigGate()` → `adfConfigured:false`; run history still renders, next-run omitted with an `intent="info"` MessageBar naming `LOOM_SUBSCRIPTION_ID`/`LOOM_DLZ_RG`/`LOOM_ADF_NAME` |

Zero ❌. The only non-functional states are honest infra gates that still render
the full surface.

## Backend per control (summary)

- Run history → `lib/azure/monitor-client.ts` `queryLogs()` → Log Analytics
  query API `POST {LA_ENDPOINT}/v1/workspaces/{id}/query` (sovereign endpoint via
  `LOOM_LOG_ANALYTICS_ENDPOINT`).
- Next run → `lib/azure/adf-client.ts` `listTriggers()` → ARM
  `GET .../factories/{adf}/triggers` (sovereign ARM host via cloud-endpoints).
- Friendly names → Cosmos `itemsContainer()` + `workspacesContainer()`
  (best-effort; never blocks the response).

## RBAC (already granted — no new bicep)

- Monitoring Reader `43d0d8ad-25c7-4714-9337-8ba259a9fe05` (subscription) —
  `platform/fiab/bicep/modules/admin-plane/monitoring-reader-rbac.bicep`.
- Log Analytics Reader `73c42c96-874c-492b-b04d-ab87d138a893` (on the LAW) —
  `platform/fiab/bicep/modules/admin-plane/monitoring.bicep`.

F20 introduces no new env var, role, or Cosmos container, so the
`commercial-full` + bootstrap acceptance test is unchanged.

## Per-cloud

| | Commercial | GCC | GCC-High | IL5/DoD |
|--|-----------|-----|----------|---------|
| LA endpoint | `api.loganalytics.azure.com` | same | `api.loganalytics.us` (`LOOM_LOG_ANALYTICS_ENDPOINT`) | `api.loganalytics.us` |
| ARM (triggers) | `management.azure.com` | same | `management.usgovcloudapi.net` | `management.azure.microsoft.scloud` |
| `ADFPipelineRun` / `SynapseIntegrationPipelineRuns` | available | available | available | available |
| New bicep role | none | none | none | none |

## Verification

`node node_modules/vitest/vitest.mjs run app/api/admin/__tests__/refresh-summary.test.ts`
→ 10 passing (computeNextRun cadence projection, 401, honest LA gate, real
run-history shape with status + duration + next-run, status filter, ADF-absent
fallback). `tsc --noEmit` clean for all touched files.
