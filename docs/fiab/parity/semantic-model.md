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

---

## Azure-native backend — Azure Analysis Services (AAS)

Per `.claude/rules/no-fabric-dependency.md` the **default** semantic-model
backend is **Azure Analysis Services**, not Power BI. Power BI is opt-in
(`LOOM_BI_BACKEND=powerbi`). When `NEXT_PUBLIC_LOOM_BI_BACKEND=aas` (bicep sets
this whenever `aas.bicep` is deployed) `SemanticModelEditor` renders the
`AasSemanticModelPanel`; the refresh routes dispatch to AAS by default
(`app/api/items/semantic-model/_lib/bi-backend.ts`).

Source UI: AAS server in the Azure portal + the async-refresh REST API —
https://learn.microsoft.com/analysis-services/azure-analysis-services/analysis-services-async-refresh

Client: `apps/fiab-console/lib/azure/aas-client.ts`
Endpoints: `cloud-endpoints.getAasSuffix()` / `aasScope()` (sovereign-aware).

| # | Capability | Status | Backend per control |
|---|---|---|---|
| 1 | Database list + select | built | ARM `GET …/servers/{name}/databases` (api 2017-08-01) → `aas-databases` route |
| 2 | Storage mode (Import / DirectQuery / Hybrid) | built | `properties.model.storageMode` from the same ARM call; Storage-mode tab badge |
| 3 | Refresh now (real refresh id) | built | AAS REST `POST …/models/{db}/refreshes` → refresh id from the `Location` header → `[id]/refresh` route |
| 4 | Refresh history (last 30 days) | built | AAS REST `GET …/models/{db}/refreshes` → `[id]/refreshes` route |
| 5 | Scheduled refresh (enable, days, times, tz, notify) | built | persisted as the `loom-refresh-schedule` ARM tag on the server (PATCH/GET `…/servers/{name}`) → `[id]/refresh-schedule` route |
| 6 | TMSL command (createOrReplace / alter / refresh) | built | XMLA `POST …/servers/{name}/xmla` (SOAP Execute) via `command(tmslJson)` |
| 7 | Storage-mode change | honest-disclosure | a model operation — use the XMLA endpoint (SSMS / Tabular Editor) or the REST `createOrReplace` TMSL command; the Storage-mode tab discloses this. No empty tab |

### Honest gates
- When `LOOM_AAS_SERVER_NAME` / `LOOM_AAS_REGION` (etc.) are unset the
  `aas-databases` route 503s with `{ ok:false, gate }` and the editor renders a
  Fluent `intent="warning"` MessageBar naming the exact env vars + the bicep
  module (`platform/fiab/bicep/modules/admin-plane/aas.bicep`). No Microsoft
  Fabric / Power BI workspace is ever required.

### Bicep + bootstrap sync
- `aas.bicep` provisions an AAS Standard (S1) server, adds the Console UAMI as
  server administrator (`app:{clientId}@{tenantId}`) for the refresh REST API,
  grants it Reader for ARM reads, and wires diagnostics to the LAW.
- `main.bicep` wires `LOOM_AAS_SERVER_NAME` / `LOOM_AAS_REGION` from the module
  outputs and sets `NEXT_PUBLIC_LOOM_BI_BACKEND` / `LOOM_BI_BACKEND` to `aas`.

### Per-cloud
| | Commercial / GCC | GCC-High / IL5 | DoD |
|--|--|--|--|
| AAS data-plane suffix | `asazure.windows.net` | `asazure.usgovcloudapi.net` | gov suffix (override `LOOM_AAS_DATA_PLANE_SUFFIX`) |
| AAS auth audience | `https://*.asazure.windows.net/.default` | `https://*.asazure.usgovcloudapi.net/.default` | derived from suffix |
| ARM base | `management.azure.com` | `management.usgovcloudapi.net` | `management.azure.microsoft.scloud` |

Tests: `lib/azure/__tests__/aas-endpoints.test.ts` (suffix + scope per cloud),
`lib/azure/__tests__/bi-backend-selector.test.ts` (backend dispatch).
