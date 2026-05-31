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
| 11 | Build a model (tables, columns, measures, relationships) | New semantic model / model authoring |

## Loom coverage

| # | Status | Notes |
|---|---|---|
| 1 | built | /api/items/semantic-model list (groupIds), auto-select first |
| 2 | built | Tables tab from GET /datasets/{id}/tables |
| 3 | built (NEW) | Relationships tab now renders real `GET /datasets/{id}/relationships` (listDatasetRelationships) — from/to table+column + cross-filter. Was a static "v2.2" stub |
| 4 | built | Measures tab — Monaco DAX editor + Validate via POST /measures (executeQueries DEFINE MEASURE probe). Persistence on imported models is XMLA-only, disclosed; push-dataset measures are written via the Build-model tab |
| 5 | built | Refresh dataset -> POST /semantic-model/[id]/refresh |
| 6 | built | Refresh history tab from GET /semantic-model/[id]/refreshes |
| 7 | built | Config tab — enable Switch, day buttons, times, timezone, notify; Apply -> PATCH /semantic-model/[id]/refresh-schedule (real PBI PATCH refreshSchedule) |
| 8 | built | Take over dataset -> POST /semantic-model/[id]/take-over (Default.TakeOver) |
| 9 | honest-gate | RLS role authoring is XMLA/Desktop only; warning MessageBar names LOOM_POWERBI_XMLA_ENDPOINT + Open in Power BI; surfaces isEffectiveIdentityRolesRequired |
| 10 | built | Open in Power BI from ribbon |
| 11 | built (NEW) | Build-model tab — add tables, typed columns (String/Int64/Double/Decimal/Boolean/DateTime), DAX measures, and relationships, then Create model -> POST /api/items/semantic-model/build -> createPushDataset (Power BI Push Datasets REST). Real model authoring without XMLA |

## Backend per control
- Build model -> POST /groups/{ws}/datasets (createPushDataset) + POST /datasets/{id}/tables/{name}/rows (postPushRows).
- Relationships -> GET /groups/{ws}/datasets/{id}/relationships (listDatasetRelationships).
- Schedule read/write -> GET / PATCH /groups/{ws}/datasets/{id}/refreshSchedule (getRefreshSchedule / patchRefreshSchedule).
- Take over -> POST /groups/{ws}/datasets/{id}/Default.TakeOver (takeOverDataset).
- Refresh -> POST /datasets/{id}/refreshes; history -> GET /datasets/{id}/refreshes.
- DAX validate -> POST /datasets/{id}/executeQueries.

## Honest gates
- Writing measures/tables INTO an imported or Direct Lake model requires the XMLA endpoint (Premium/Fabric capacity) or Power BI Desktop — disclosed via a MessageBar naming LOOM_POWERBI_XMLA_ENDPOINT. The push-dataset Build-model path IS the supported REST authoring route and works without XMLA.
- RLS role authoring is XMLA/Desktop only; disclosed via MessageBar. The surface still renders fully.

Grade: A — model building (push dataset), relationships read, scheduled-refresh edit, take-over, and DAX validate are all real REST; imported-model XMLA writes honestly gated. Tests: lib/azure/__tests__/powerbi-client-parity.test.ts, app/api/items/__tests__/model-builder-routes.test.ts, app/api/items/__tests__/powerbi-parity-routes.test.ts.
