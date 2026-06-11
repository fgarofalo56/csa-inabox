# powerbi-workspace — parity with the Power BI service (app.powerbi.com)

> **rev — re-audited against Wave-8→11 code (2026-06-10), audit-T31.** Several
> top gaps are closed on the **Azure-native (no-Power-BI-dependency) path** per
> `no-fabric-dependency.md`: **PR #1068** in-place paginated-report embed +
> export (audit-T14); **PR #934** Model-view canvas (relationships + measures,
> no Power BI); **PR #980** Monaco DAX measure editor + format strings (XMLA/AAS
> persistence); **PR #984** semantic-model column editor (calc/data-category/
> format/summarize/sort-by/folder); **PR #969** Direct-Lake-shim wired into the
> semantic-model editor; **PR #1030** Semantic-Link read for Copilot. These are
> Loom-native tabular-layer surfaces over the warehouse/lakehouse — they work
> with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. **Grade B− → B.** Remaining honest
> gaps (kept ⚠️, genuinely Power-BI-tenant-bound and disclosed): workspace-ACL
> Manage-access, endorsement/sensitivity-label apply (no public REST), App
> publishing/capacity, gateway credential sign-in.


**Audited:** 2026-05-31 · **Auditor:** automated brutal-honesty pass (grounded in Microsoft Learn, not memory)
**rev.2 — corrected against current code (2026-05-31):** item governance shipped — **Manage access** on the real PBI workspace (GroupUsers), **Endorsement** (promote/certify), and **Gateway binding + data-source** management are now BUILT and wired into the SemanticModel + Report editors. Grade raised **C+ → B-**. Sensitivity labels remain honestly OMITTED (no public apply REST).
**Verdict:** **B- (functional, selectively production-grade; the largest governance gaps now closed; workspace list-page surface + lineage + sensitivity still missing).** Real Power BI / Fabric REST is genuinely wired across the whole content family (no mock arrays), which clears the no-vaporware bar for what is built. Still short of full "parity with the Power BI service workspace": the workspace list-page itself (the canonical Power BI content grid), lineage view, app publishing, subscribe, sensitivity labels, and report/dashboard *authoring* are missing or out-of-scope-by-design. Loom is a set of typed per-item editors plus a navigator tree — not a workspace surface.

## Source UI

- Power BI service workspace list page + Workspace settings: <https://learn.microsoft.com/power-bi/collaborate-share/service-create-the-new-workspaces>
- Roles / Manage access: <https://learn.microsoft.com/power-bi/collaborate-share/service-roles-new-workspaces>, <https://learn.microsoft.com/power-bi/collaborate-share/service-give-access-new-workspaces>
- Semantic model settings pane: <https://learn.microsoft.com/power-bi/connect-data/service-semantic-model-settings-pane>
- Endorsement (promote/certify): <https://learn.microsoft.com/power-bi/collaborate-share/service-endorse-content>
- Data lineage view: <https://learn.microsoft.com/power-bi/collaborate-share/service-data-lineage>
- Reports overview / quick-create: <https://learn.microsoft.com/power-bi/create-reports/power-bi-reports-overview>, <https://learn.microsoft.com/power-bi/create-reports/service-quick-create-report>
- Deployment pipelines: <https://learn.microsoft.com/fabric/cicd/deployment-pipelines/intro-to-deployment-pipelines>
- Sensitivity labels: <https://learn.microsoft.com/fabric/enterprise/powerbi/service-security-sensitivity-label-overview>
- Power BI REST: <https://learn.microsoft.com/rest/api/power-bi/> · Fabric REST: <https://learn.microsoft.com/rest/api/fabric/>

## Loom surfaces audited

| Loom file | Role |
| --- | --- |
| `apps/fiab-console/lib/azure/powerbi-client.ts` | Power BI + Fabric REST client (UAMI auth, ~40 real methods) — **the strong foundation** |
| `apps/fiab-console/lib/components/powerbi/powerbi-tree.tsx` | Workspace-content navigator tree (semantic models / reports / dashboards / dataflows) |
| `apps/fiab-console/app/api/powerbi/[group]/route.ts` | BFF: list/refresh/delete for datasets·reports·dashboards·dataflows |
| `apps/fiab-console/app/api/powerbi/workspaces/route.ts` | BFF: list real Power BI groups |
| `apps/fiab-console/lib/editors/phase3-editors.tsx` → `SemanticModelEditor`, `ReportLikeEditor`/`ReportEditor`/`PaginatedReportEditor`, `DashboardEditor`, `ScorecardEditor` | The per-item editors |
| `apps/fiab-console/app/api/items/{semantic-model,report,dashboard,scorecard,paginated-report}/**` | BFF for each editor — all real Power BI/Fabric REST |
| `apps/fiab-console/lib/components/powerbi/powerbi-governance.tsx` (rev.2) | `ManageAccessPanel` / `EndorsementControl` / `GatewayDatasourcesPanel` — item governance UI, wired into SemanticModelEditor (governance + access tabs) and ReportEditor (endorsement + access) |
| `apps/fiab-console/app/api/powerbi/{access,endorsement,datasources}/route.ts` (rev.2) | BFF: real workspace ACL (GroupUsers), endorsement promote/certify, gateway binding + datasource mapping — all real PBI/Fabric REST |
| `apps/fiab-console/lib/components/embed/powerbi-embed.tsx` | `powerbi-client-react` live embed renderer |
| `apps/fiab-console/lib/components/deployment/deployment-pipelines-pane.tsx` + `app/api/deployment-pipelines/**` | Fabric deployment pipelines (real Fabric REST) |
| `apps/fiab-console/app/api/workspaces/**` | **Loom-native** workspaces in Cosmos — NOT Power BI groups |

---

## Azure/Fabric feature inventory → Loom coverage

Legend: ✅ built (full 1:1 + real backend) · ⚠️ partial / honest-gate · ❌ MISSING

### A. Workspace surface (the Power BI service workspace list page)

| # | Power BI capability (grounded in Learn) | Loom status | Where / backend |
| --- | --- | --- | --- |
| A1 | List workspaces (groups) the principal can see | ✅ built | `/api/powerbi/workspaces` → `listWorkspaces()` GET /groups. Surfaced as a `WorkspacePicker` dropdown inside each editor. |
| A2 | Workspace **content list** page (all item types in one grid, sortable, with per-row More-options ⋯) | ⚠️ partial | `powerbi-tree.tsx` collapses 4 content types into a Fluent Tree with counts + inline actions. It is a left-rail tree, **not** the Power BI content grid (no columns: Type / Owner / Refreshed / Endorsement / Sensitivity / Next refresh; no sort; no multi-select). |
| A3 | Switch list **View → List / Lineage** | ❌ MISSING | No lineage view anywhere. |
| A4 | **Workspace settings** pane (name, description, image, contributor-can-update-app, OneDrive, license/capacity, Azure connections, system storage, Git integration, Spark, etc.) | ❌ MISSING | The *real* PBI workspace has no settings surface in Loom. (`workspace-settings-drawer.tsx` exists but targets Loom-native Cosmos workspaces, not PBI groups.) |
| A5 | **Manage access** / Roles on the real workspace (Admin/Member/Contributor/Viewer add/remove, groups, guests) | ✅ built (rev.2) | `ManageAccessPanel` (in SemanticModel `access` tab + Report editor) → `/api/powerbi/access` → real PBI REST **GroupUsers**: GET list / POST add / PUT update-role / DELETE remove, with User/Group/App principal types and the 4 roles. Distinct from the Cosmos Loom-native roles at `/api/workspaces/[id]/permissions`. Honest 401/403 SP-hint when the UAMI isn't a workspace Admin. |
| A6 | Create workspace / assign to capacity / delete / restore | ❌ MISSING | No PBI workspace lifecycle (PBI REST `Groups` POST/DELETE, AssignToCapacity) in the PBI surface. |
| A7 | **Publish app** from workspace / update app / manage app audience | ❌ MISSING | No app publishing (PBI REST is preview/limited, but the surface is absent). |
| A8 | Capacity / Premium / PPU diamond badges, license enforcement | ❌ MISSING | Workspace picker shows name only; `PbiWorkspace` carries `isOnDedicatedCapacity`/`capacityId` but the UI never renders capacity state. |
| A9 | OneDrive / SharePoint association | ❌ MISSING | — |

### B. Semantic model (dataset)

| # | Power BI capability | Loom status | Where / backend |
| --- | --- | --- | --- |
| B1 | List semantic models in workspace | ✅ built | `SemanticModelEditor` + tree → `/api/items/semantic-model` & `/api/powerbi/datasets` → `listDatasets()` GET /datasets |
| B2 | View model metadata (owner, storage mode, refreshable) | ✅ built | `/api/items/semantic-model/[id]` → `getDataset()` |
| B3 | View **Tables** (columns + types + measures) | ✅ built | `listDatasetTables()` GET /datasets/{id}/tables; rendered in Tables tab |
| B4 | View **Relationships** | ✅ built | `listDatasetRelationships()` GET /datasets/{id}/relationships; Relationships tab |
| B5 | **Build a new model** (tables, typed columns, DAX measures, relationships) | ✅ built (push datasets only) | Build tab → `/api/items/semantic-model/build` → `createPushDataset()` POST /datasets. Real REST. **Honestly limited**: only push datasets; imported/Direct Lake authoring needs XMLA/Desktop (disclosed via MessageBar). |
| B6 | **Author/persist DAX measures** on existing model | ⚠️ partial (validate-only) | Measures tab validates DAX via `executeQueries` (real engine errors) but **cannot persist** — XMLA-only. Honestly disclosed via MessageBar. Power BI's own model-editing web UI persists measures; Loom does not. |
| B7 | **Refresh now** | ✅ built | `/api/items/semantic-model/[id]/refresh` → `refreshDataset()` POST /refreshes |
| B8 | **Refresh history** | ✅ built | `/refreshes` → `listRefreshHistory()` GET /refreshes |
| B9 | **Scheduled refresh** editor (enable, days, times, tz, notify) | ✅ built | Config tab → `/refresh-schedule` PATCH /refreshSchedule. Mirrors the PBI Scheduled-refresh pane. |
| B10 | **Take over** dataset | ✅ built | `/take-over` → `takeOverDataset()` POST Default.TakeOver |
| B11 | **Settings pane → About** (rename, description, image, connection string) | ❌ MISSING | PBI exposes name/description/image edit; Loom shows them read-only at best. |
| B12 | **Gateway & cloud connections** (bind to gateway, map data sources) | ✅ built (rev.2) | `GatewayDatasourcesPanel` (SemanticModel `governance` tab) → `/api/powerbi/datasources` → real PBI REST: GET Datasources + Get Bound Gateway Datasources + Discover Gateways; POST `action:'bind'` → **BindToGateway**, POST `action:'updateDatasources'` → **UpdateDatasources**. |
| B13 | **Data source credentials** (sign in, edit creds, privacy level, SSO) | ⚠️ partial (rev.2) | The datasources panel surfaces datasources + bound gateway datasources and supports UpdateDatasources connection-detail remapping; full credential sign-in / privacy-level / SSO editing (Update Datasource **credentials** REST) is not yet surfaced. |
| B14 | **Endorsement** (promote / certify / make discoverable) | ✅ built (rev.2) | `EndorsementControl` (SemanticModel `governance` tab + Report editor) → `/api/powerbi/endorsement`: GET reads via Fabric Items REST; PUT sets None/Promoted/Certified (certifiedBy required) via Power BI **Admin** REST. Honest admin-gate (Tenant.ReadWrite.All) when the SP isn't a Fabric admin. Dashboards excluded (not endorsable). |
| B15 | **Sensitivity label** (apply / downstream) | ❌ MISSING (honestly omitted) | No public apply REST for MIP sensitivity labels on PBI items — intentionally omitted rather than faked. |
| B16 | **Q&A** (on/off, featured questions, synonyms) | ❌ MISSING | — |
| B17 | **RLS roles** (create/edit DAX filters, assign members) | ⚠️ honest-gate | Config tab states RLS is XMLA/Desktop-only via MessageBar + "Open in Power BI". Member assignment via PBI REST is *not* attempted. |
| B18 | Data storage (large model format, OneLake integration), Query scale-out, Auto-aggregations, Query caching, M parameters | ❌ MISSING | None of the Performance / Data-storage settings groups. |
| B19 | **Push rows** into push table / streaming | ⚠️ partial (client only) | `postPushRows()` exists in the client but **no UI/route** drives it. |
| B20 | Delete semantic model | ⚠️ honest-gate | Tree/route return 501 — PBI user-scoped REST genuinely has no dataset DELETE. Honest. |
| B21 | Open in Power BI (deep link) | ✅ built | `openInPbi()` window.open to app.powerbi.com |
| B22 | Embed token issuance (for model exploration) | ⚠️ partial | `generateDatasetEmbedToken()` + `/embed-token` route exist; editor does not surface a dataset-explore embed. |

### C. Reports (Power BI + paginated)

| # | Power BI capability | Loom status | Where / backend |
| --- | --- | --- | --- |
| C1 | List reports | ✅ built | `/api/items/report` → `listReports()` |
| C2 | Report metadata (type, datasetId, modified) | ✅ built | `getReport()` GET /reports/{id} |
| C3 | **Live embed viewer** (pages, filters pane, status bar) | ✅ built | `powerbi-embed.tsx` via `powerbi-client-react` + `/embed-token` → real GenerateToken |
| C4 | **Page navigation** | ✅ built | `/pages` → `getReportPages()`; drives `embed.setPage()` |
| C5 | **Bookmarks** (list, apply, capture, play slideshow) | ✅ built | `bookmarksManager` JS API — list/apply/capture/play wired |
| C6 | **View ↔ Edit mode toggle** | ✅ built | `embed.switchMode()` + edit-tier token re-mint |
| C7 | **Refresh visuals** | ✅ built | `embed.refresh()` |
| C8 | **Refresh underlying data** | ✅ built | `/api/items/report/[id]/refresh` resolves datasetId → real dataset refresh |
| C9 | **Export to PDF / PPTX / PNG** | ✅ built | `/export` drives async ExportTo (start→poll→download) — real REST, streams binary |
| C10 | Open in Power BI / Copy link | ✅ built | window.open + clipboard |
| C11 | **Visual authoring** (new page, new visual, format, filter pane edit, themes) | ❌ MISSING (by design) | Honestly disclosed: authoring is Power BI Desktop/Web. Power BI service *does* author in-browser; Loom does not. Counts as a real parity gap, disclosed not faked. |
| C12 | **Quick-create report** (paste/enter data, autogenerate visuals) | ❌ MISSING | — |
| C13 | **Clone / Save a copy** | ❌ MISSING | `cloneReport()` exists in client; no UI/route. |
| C14 | Delete report | ✅ built | tree DELETE → `deleteReport()` |
| C15 | **Subscribe** / manage subscriptions | ❌ MISSING | — |
| C16 | **Share** (item permissions, grant/revoke) | ⚠️ partial (rev.2) | Workspace-level access (Admin/Member/Contributor/Viewer) is built via `ManageAccessPanel` in the Report editor (real GroupUsers REST). Per-*item* report Share (Read/Build/Reshare grant) is not yet a separate surface. |
| C17 | Sensitivity label / endorsement on report | ⚠️ partial (rev.2) | **Endorsement** on reports is built (`EndorsementControl itemType="reports"` → `/api/powerbi/endorsement`, real Fabric/Admin REST). Sensitivity label remains ❌ (no public apply REST). |
| C18 | **Paginated report embed** | ⚠️ honest-gate | `PaginatedReportEditor` lists + opens out; embed needs `pbi-paginated` SDK — disclosed via MessageBar, not wired. |
| C19 | Analyze in Excel / Download .pbix | ❌ MISSING | — |

### D. Dashboards

| # | Power BI capability | Loom status | Where / backend |
| --- | --- | --- | --- |
| D1 | List dashboards | ✅ built | `/api/items/dashboard` → `listDashboards()` |
| D2 | **Live embed viewer** | ✅ built | `powerbi-embed.tsx` embedType=dashboard + `/embed-token` |
| D3 | **List tiles** + tile metadata | ✅ built | `/api/items/dashboard/[id]` → `listDashboardTiles()` |
| D4 | **Drill tile → report** | ✅ built | deep-link to app.powerbi.com report |
| D5 | **Pin / add tile**, edit layout, themes | ❌ MISSING (by design) | `addDashboardTile()` / `cloneDashboardTile()` exist in client; no UI. Authoring disclosed as Power BI Web. |
| D6 | Delete dashboard | ⚠️ honest-gate | 501 — PBI REST has no user-scoped dashboard DELETE. Honest. |
| D7 | Open in Power BI / Copy link | ✅ built | window.open + clipboard |
| D8 | Q&A tile / natural-language | ❌ MISSING | embed type `qna` declared but unused. |
| D9 | Subscribe / Share / sensitivity / endorsement | ❌ MISSING | — |

### E. Dataflows

| # | Power BI capability | Loom status | Where / backend |
| --- | --- | --- | --- |
| E1 | List dataflows | ✅ built | `/api/powerbi/dataflows` → `listDataflows()` |
| E2 | **Refresh now** | ✅ built | POST /dataflows/{id}/refreshes |
| E3 | Refresh history / transactions | ⚠️ partial | `listDataflowTransactions()` in client; tree doesn't render it. |
| E4 | Delete dataflow | ✅ built | DELETE → `deleteDataflow()` |
| E5 | **Edit dataflow (Power Query online editor)** | ❌ MISSING | The actual dataflow authoring surface is absent. (A separate `dataflow-gen2-editor.tsx` exists for Fabric Gen2; not part of this PBI tree.) |
| E6 | Endorsement / settings | ❌ MISSING | — |

### F. Scorecards (Fabric metrics)

| # | Power BI capability | Loom status | Where / backend |
| --- | --- | --- | --- |
| F1 | List scorecards | ✅ built | `/api/items/scorecard` → `listScorecards()` (Fabric REST) |
| F2 | View goals (current/target) | ✅ built | `listScorecardGoals()` |
| F3 | **Add goal value** (manual check-in) | ✅ built | POST → `addScorecardGoalValue()` |
| F4 | Author goals / connections / hierarchy / status rules | ❌ MISSING (by design) | Disclosed as Power BI Web; preview REST. |
| F5 | Open in Power BI | ✅ built | window.open |

### G. Deployment pipelines (Fabric ALM)

| # | Power BI / Fabric capability | Loom status | Where / backend |
| --- | --- | --- | --- |
| G1 | List deployment pipelines | ✅ built | `/api/deployment-pipelines` → Fabric REST GET /deploymentPipelines |
| G2 | Show stages (Dev → Test → Prod) + assigned workspace | ✅ built | `/[id]/stages` |
| G3 | Show supported items per stage | ✅ built | `/[id]/stages/[stageId]/items` |
| G4 | **Deploy stage → next** (Deploy all OR selective + note) | ✅ built | `/[id]/deploy` → POST /deploy (long-running) |
| G5 | **Deployment history** + status | ✅ built | `/[id]/operations` |
| G6 | Infra (ARM/bicep) rollout history (bonus, not in PBI) | ✅ built | `/arm` → Microsoft.Resources/deployments |
| G7 | Create/assign pipeline, assign workspace to stage, compare/diff content | ❌ MISSING | Pipeline + stage lifecycle and the diff view are absent. |

### H. Cross-cutting (apply to every item type)

| # | Power BI capability | Loom status |
| --- | --- | --- |
| H1 | **Lineage view** (data sources → models → reports → dashboards graph) | ❌ MISSING |
| H2 | **Item-level permissions / Share** (grant Read/Build/Reshare) | ⚠️ partial (rev.2) — workspace-level **Manage access** (GroupUsers, 4 roles, User/Group/App) is built via `ManageAccessPanel`; per-item Read/Build/Reshare share grants are not yet a separate surface |
| H3 | **Subscriptions** | ❌ MISSING |
| H4 | **Sensitivity labels** | ❌ MISSING (honestly omitted — no public apply REST) |
| H5 | **Endorsement** (promote/certify) | ✅ built (rev.2) — `EndorsementControl` on semantic models + reports → `/api/powerbi/endorsement` (Fabric read / Admin write); dashboards excluded (not endorsable) |
| H6 | **Settings ⋯ context menu** per item (the canonical PBI affordance) | ❌ MISSING — Loom exposes per-item inline buttons, not the PBI ⋯ menu with Settings/Manage permissions/Lineage/Remove/Quick insights |
| H7 | **Search across workspace content** | ⚠️ partial — name filter only, per-editor |
| H8 | **Honest infra-gate** when UAMI/SP unauthorized | ✅ built — `powerbiConfigGate()` + verbatim 401/403 `POWERBI_SP_HINT` everywhere |
| H9 | Real backend wired (no mocks) | ✅ built — every list/action calls real Power BI/Fabric REST; no `return []` placeholders |

---

## Backend per control (summary)

Every Loom control above that is marked built/partial calls a **real** Power BI REST (`api.powerbi.com/v1.0/myorg`) or Fabric REST (`api.fabric.microsoft.com/v1`) endpoint through `powerbi-client.ts` / `fabric-client.ts` using the Console UAMI (`ManagedIdentityCredential` chained with `DefaultAzureCredential`). No mock arrays, no hard-coded sample data. When the UAMI SP isn't authorized in the PBI tenant or not a workspace member, the underlying 401/403 is surfaced verbatim with the exact remediation (enable "Service principals can use Fabric APIs" + add UAMI to the workspace). This is the no-vaporware floor and it is met for the built surfaces.

## Per-cloud notes

Power BI REST surfaces resolve their sovereign host via `cloud-endpoints.ts`; the **Fabric**-only surfaces (Scorecards, Deployment Pipelines, endorsement reads via Fabric Items REST) depend on Fabric, which is not offered in GCC.

| Cloud | Power BI REST host | Fabric REST (scorecards, pipelines, item endorsement reads) |
| --- | --- | --- |
| Commercial | `api.powerbi.com` | ✅ `api.fabric.microsoft.com` |
| GCC | `api.powerbigov.us` | ❌ **Fabric not available in GCC** — Section F (scorecards) live path + Section G (pipelines) Fabric tab show the honest 401/403 / infra-gate; the Loom-native + ARM paths still render |
| GCC-High / IL4 | `api.high.powerbigov.us` | ✅ Fabric available |
| DoD / IL5 | `api.mil.powerbigov.us` | ✅ Fabric available |

The built Power BI REST surfaces (Sections A5, B1–B14, C1–C10/C14, D1–D4/D7, E1–E4) work in every cloud with `LOOM_DEFAULT_FABRIC_WORKSPACE` unset. The ❌ rows below are **parity build backlog** (T28 — content grid, lineage, subscriptions, sensitivity, item ⋯ menu), not cloud-specific gaps; they are honestly disclosed, never faked.

## Scorecard / honest gap statement

Loom's Power BI work is a **vertical slice of real, working per-item editors**, not a reproduction of the Power BI service workspace. What exists is genuinely backed (B-grade for the SemanticModel editor and Report viewer in isolation; B for deployment pipelines). But measured against the rule's bar — *"whatever you can do in the Power BI service workspace UI you should be able to do in Loom"* — the coverage is partial:

- The **workspace surface itself** (content grid, settings, app publishing, capacity) is still largely absent (Section A mostly ❌) — **except Manage access (A5), now built** via real PBI GroupUsers REST.
- The **semantic-model settings pane** — the single richest PBI surface — is now ~45% covered (rev.2): refresh/schedule/takeover **+ gateway binding + datasource mapping + endorsement** built; data-source credentials partial; sensitivity, Q&A, scale-out, caching still ❌.
- **Cross-cutting governance** is now mixed (rev.2): **endorsement (H5) and workspace manage-access (A5/H2) built** across semantic model + report; lineage, per-item share, subscriptions, sensitivity remain ❌.

Several non-built items are *honestly disclosed* (visual authoring → Desktop, RLS → XMLA, paginated embed → SDK), which is allowed under no-vaporware — but the ui-parity rule still counts them as parity gaps, not "done." None are faked.

## Highest-value gaps to build next (parity order)

1. **Item ⋯ context menu → Settings / Manage permissions / Lineage** — the universal PBI affordance; unlocks B11–B16, C16, H2, H4–H6 at once.
2. ~~**Semantic-model settings: gateway binding + scheduled-refresh**~~ — **DONE (rev.2)**: BindToGateway / DiscoverGateways / Datasources / UpdateDatasources wired in `GatewayDatasourcesPanel`. Remaining: data-source **credential** sign-in / privacy-level / SSO.
3. **Endorsement (promote/certify)** — **DONE (rev.2)** across model + report. **Sensitivity label** remains ❌ (no public apply REST — honestly omitted).
4. ~~**Manage access on the real PBI workspace**~~ — **DONE (rev.2)**: `ManageAccessPanel` → real `GroupUsers` add/update/delete for the 4 roles + User/Group/App.
5. **Workspace content grid** (Type/Owner/Refreshed/Endorsement/Sensitivity columns, sort, ⋯) to replace the thin tree as the primary surface, + **Lineage view**.
6. **Report Share + Subscribe**, **Clone/Save-a-copy** (`cloneReport()` already in client), **dashboard Pin tile** (`addDashboardTile()`/`cloneDashboardTile()` already in client — wire the UI).
7. **Quick-create report** (paste data → push dataset → autogenerate) — the client already has push-dataset + executeQueries.

## Parity verdict

- **Grade: B- (rev.2)** — functional and genuinely backed for the built slice, now including the three richest governance gaps (manage-access, endorsement, gateway/datasource binding) wired to real PBI/Fabric REST. Still short of full feature-completeness vs the real Power BI service workspace: the canonical workspace content grid, lineage, app publishing, subscribe, sensitivity labels, and in-browser authoring are absent. Not B/A, because those first-class surfaces remain missing (not merely rough).
- **A-grade blocker:** the remaining ❌ in Sections A and H (content grid, lineage, subscriptions, sensitivity) plus semantic-model settings rows (B11 About-edit, B16 Q&A, B18 scale-out/caching) must be built or honest-gated. ~28 ❌ rows remain after rev.2.
