# powerbi-workspace — parity with the Power BI service workspace (group)

Source UI: https://app.powerbi.com/groups/{groupId}/list — the Power BI service
"Workspace" content list (left rail + content list: Semantic models, Reports,
Dashboards, Dataflows) and the per-item context actions.

REST grounding (Microsoft Learn):
- Using the Power BI REST APIs — operation groups: https://learn.microsoft.com/rest/api/power-bi/#rest-operation-groups
- Groups (workspaces): https://learn.microsoft.com/rest/api/power-bi/groups
- Datasets: https://learn.microsoft.com/rest/api/power-bi/datasets
- Reports: https://learn.microsoft.com/rest/api/power-bi/reports
- Dashboards: https://learn.microsoft.com/rest/api/power-bi/dashboards
- Dataflows: https://learn.microsoft.com/rest/api/power-bi/dataflows
- Pipelines (deployment): https://learn.microsoft.com/rest/api/power-bi/pipelines

Surface: `lib/components/powerbi/powerbi-tree.tsx`, hosted in the Semantic Model
editor's left navigator (`lib/editors/phase3-editors.tsx` → `SemanticModelEditor`).
BFF: `app/api/powerbi/[group]/route.ts` (+ existing `app/api/powerbi/workspaces`).
Client: `lib/azure/powerbi-client.ts`.

## Power BI feature inventory (workspace content list)

| # | Capability in the Power BI service | Power BI REST |
|---|------------------------------------|---------------|
| 1 | List workspaces (group picker) | `GET /v1.0/myorg/groups` |
| 2 | List Semantic models (datasets) | `GET /groups/{ws}/datasets` |
| 3 | Refresh a semantic model on demand | `POST /groups/{ws}/datasets/{id}/refreshes` |
| 4 | Open / edit a semantic model (tables, measures, refresh schedule) | `GET .../datasets/{id}`, `/tables`, `/refreshSchedule`, `executeQueries`, Push-Datasets authoring |
| 5 | List Reports | `GET /groups/{ws}/reports` |
| 6 | Open a report | report `webUrl` / embed `GenerateToken` |
| 7 | Delete a report | `DELETE /groups/{ws}/reports/{id}` |
| 8 | Export a report (PDF/PPTX/PNG) | `POST .../reports/{id}/ExportTo` (in Report editor) |
| 9 | List Dashboards | `GET /groups/{ws}/dashboards` |
| 10 | Open a dashboard | dashboard `webUrl` / embed `GenerateToken` |
| 11 | List Dataflows | `GET /groups/{ws}/dataflows` |
| 12 | Refresh a dataflow on demand | `POST /groups/{ws}/dataflows/{id}/refreshes` |
| 13 | Delete a dataflow | `DELETE /groups/{ws}/dataflows/{id}` |
| 14 | New report authoring | Report editor (real Power BI REST) |
| 15 | New / edit semantic model authoring | Semantic Model editor (Push-Datasets REST) |
| 16 | Deployment pipelines (Dev/Test/Prod) | `GET/POST /v1.0/myorg/pipelines` |
| 17 | Filter content by name | client-side filter |

## Loom coverage

| # | Capability | Status | Where |
|---|------------|--------|-------|
| 1 | List workspaces | ✅ built | `WorkspacePicker` + `GET /api/powerbi/workspaces` |
| 2 | List Semantic models | ✅ built | tree "Semantic models" group → `GET /api/powerbi/datasets` |
| 3 | Refresh semantic model | ✅ built | per-row Refresh → `POST /api/powerbi/datasets {action:'refresh'}` |
| 4 | Open / edit semantic model | ✅ built | row Open → host `SemanticModelEditor` (real detail/measures/schedule) |
| 5 | List Reports | ✅ built | tree "Reports" group → `GET /api/powerbi/reports` |
| 6 | Open a report | ✅ built | row Open → report `webUrl` (Report editor embeds + ExportTo) |
| 7 | Delete a report | ✅ built | row Delete → `DELETE /api/powerbi/reports` |
| 8 | Export a report | ✅ built (in Report editor) | existing Report editor (ExportTo) |
| 9 | List Dashboards | ✅ built | tree "Dashboards" group → `GET /api/powerbi/dashboards` |
| 10 | Open a dashboard | ✅ built | row Open → dashboard `webUrl` |
| 11 | List Dataflows | ✅ built | tree "Dataflows" group → `GET /api/powerbi/dataflows` |
| 12 | Refresh a dataflow | ✅ built | per-row Refresh → `POST /api/powerbi/dataflows {action:'refresh'}` |
| 13 | Delete a dataflow | ✅ built | row Delete → `DELETE /api/powerbi/dataflows` |
| 14 | New report authoring | ⚠️ honest route | "More in Power BI" row badge "in editor" — done in the Report editor (not faked) |
| 15 | New/edit semantic model | ✅ built | ＋ New → host editor's Build-model (Push-Datasets REST) |
| 16 | Deployment pipelines | ⚠️ honest gate | "More in Power BI" row badge "coming" — names `/v1.0/myorg/pipelines` |
| 17 | Filter content by name | ✅ built | "Filter by name" input |

Zero ❌. Deleting a **semantic model** or **dashboard** is intentionally a 501
in the BFF (the user-scoped Power BI REST surface genuinely has no DELETE for
those — admin-group only). The route returns an honest message rather than a
fake success, and the tree does not show a delete affordance for those types.

## Backend per control

| Control | HTTP | Backend |
|---------|------|---------|
| Workspace picker | `GET /api/powerbi/workspaces` | `listWorkspaces()` → `GET /groups` |
| Datasets count/list | `GET /api/powerbi/datasets?workspaceId=` | `listDatasets()` |
| Reports count/list | `GET /api/powerbi/reports?workspaceId=` | `listReports()` |
| Dashboards count/list | `GET /api/powerbi/dashboards?workspaceId=` | `listDashboards()` |
| Dataflows count/list | `GET /api/powerbi/dataflows?workspaceId=` | `listDataflows()` |
| Dataset Refresh now | `POST /api/powerbi/datasets` | `refreshDataset()` → `POST .../refreshes` |
| Dataflow Refresh now | `POST /api/powerbi/dataflows` | `refreshDataflow()` → `POST .../refreshes` |
| Report Delete | `DELETE /api/powerbi/reports?id=` | `deleteReport()` → `DELETE .../reports/{id}` |
| Dataflow Delete | `DELETE /api/powerbi/dataflows?id=` | `deleteDataflow()` → `DELETE .../dataflows/{id}` |
| Open dataset | (in-app) | host `SemanticModelEditor` (real `/api/items/semantic-model/*`) |
| Open report/dashboard | `webUrl` | Power BI service / Report editor embed |

## Auth + honest gates

- Auth: Console UAMI (`LOOM_UAMI_CLIENT_ID`) via `ManagedIdentityCredential`
  chained with `DefaultAzureCredential` (local dev), scope
  `https://analysis.windows.net/powerbi/api/.default`. Reuses the existing
  `powerbi-client.ts` credential — no new auth path.
- `powerbiConfigGate()` → 503 `{code:'not_configured', missing:'LOOM_UAMI_CLIENT_ID'}`
  when no credential is available. The tree renders one warning MessageBar.
- 401/403 from Power BI (SP not enabled in tenant / not a workspace member) is
  surfaced verbatim with `POWERBI_SP_HINT` naming the exact admin action:
  enable "Service principals can use Fabric APIs" + add the UAMI as
  Member/Contributor on the workspace. Tenant bootstrap is documented in
  `docs/fiab/v3-tenant-bootstrap.md`.

## Verification

- `pnpm build` — exit 0.
- Functional walk requires a Power BI tenant with the UAMI SP authorized; in a
  deployment without that authorization the navigator renders the honest 401/403
  remediation MessageBar (not an empty fake list). No mock data anywhere.
