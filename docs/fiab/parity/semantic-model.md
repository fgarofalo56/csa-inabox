# semantic-model — parity with Power BI semantic model (dataset)

Source UI: Power BI dataset settings + model view — https://learn.microsoft.com/power-bi/connect-data/refresh-scheduled-refresh
REST: https://learn.microsoft.com/rest/api/power-bi/datasets
Editor: `apps/fiab-console/lib/editors/phase3-editors.tsx` -> `SemanticModelEditor`

## Power BI feature inventory

| # | Capability | Where in Power BI |
|---|---|---|
| 1 | Dataset list + select | Workspace content list |
| 2 | Tables + columns | Model view |
| 3 | Relationships | Model view |
| 4 | Measures (author DAX) | Model view -> New measure |
| 5 | Refresh now | Dataset -> Refresh now |
| 6 | Refresh history | Dataset settings -> Refresh history |
| 7 | Scheduled refresh (enable, days, times, tz, notify) | Dataset settings -> Scheduled refresh |
| 8 | Take over dataset | Dataset settings -> Take over |
| 9 | Row-level security (RLS) roles | Model -> Manage roles |
| 10 | Open in Power BI | More options |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | built | /api/items/semantic-model list (groupIds), auto-select first |
| 2 | built | Tables tab from GET /datasets/{id}/tables |
| 3 | honest-gate | Relationships tab — PBI REST exposes relationships only via XMLA/TMSL; documented inline, datasources fallback shown |
| 4 | built | Measures tab — Monaco DAX editor + Validate via POST /measures (executeQueries DEFINE MEASURE probe). Persistence is XMLA-only, disclosed |
| 5 | built | Refresh dataset -> POST /semantic-model/[id]/refresh |
| 6 | built | Refresh history tab from GET /semantic-model/[id]/refreshes |
| 7 | built | Config tab — enable Switch, day buttons, times, timezone, notify; Apply -> PATCH /semantic-model/[id]/refresh-schedule (real PBI PATCH refreshSchedule) |
| 8 | built | Take over dataset -> POST /semantic-model/[id]/take-over (Default.TakeOver) |
| 9 | honest-gate | RLS role authoring is XMLA/Desktop only; warning MessageBar names LOOM_POWERBI_XMLA_ENDPOINT + Open in Power BI; surfaces isEffectiveIdentityRolesRequired |
| 10 | built | Open in Power BI from ribbon |

## Backend per control
- Schedule read/write -> GET / PATCH /groups/{ws}/datasets/{id}/refreshSchedule (getRefreshSchedule / patchRefreshSchedule).
- Take over -> POST /groups/{ws}/datasets/{id}/Default.TakeOver (takeOverDataset).
- Refresh -> POST /datasets/{id}/refreshes; history -> GET /datasets/{id}/refreshes.
- DAX validate -> POST /datasets/{id}/executeQueries.

## Honest gates
- Relationships graph + measure persistence + RLS role authoring all require the XMLA endpoint (Premium/Fabric capacity) or Power BI Desktop. Each is disclosed via a warning MessageBar naming the exact endpoint/tool; the surface still renders fully.

Grade: A — scheduled-refresh edit + take-over are real REST writes; XMLA-only authoring is honestly gated. Tests in lib/azure/__tests__/powerbi-client-parity.test.ts + app/api/items/__tests__/powerbi-parity-routes.test.ts.
