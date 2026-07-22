# Appendix — Power BI in Fabric → CSA Loom parity (deep dive)

**Domain:** `power-bi` (semantic models / datasets · refresh & Direct Lake · datamarts ·
dashboards · scorecards & metrics · dataflows · Q&A/NL · deployment).
**Scope boundary:** the **report / paginated-report / report-designer** parity pass runs
**separately** (see `docs/fiab/parity/report-designer.md`, `report.md`, `paginated-report.md`,
`report-builder-100-backlog.md`, task #26/#27/#30). This appendix covers the **model /
dataset / refresh / Direct-Lake / datamart / scorecard / dataflow / Q&A** side and only
*references* the report surface where a model capability lights it up.

**Loom maturity for this domain: STRONG.** Loom already ships, against real Azure backends
with **no Fabric/Power BI service required on the default path**: push-dataset + AAS-native
model authoring; AAS-native RLS/OLS role designer with live *test-as-role*; calculation-group
+ field-parameter builders (loom-native / AAS / Fabric persistence); incremental-refresh
policy + partition discovery over AAS XMLA; Direct Lake (Synapse Serverless default + warm-cache
shim); Dataflow Gen2 (ADF WranglingDataFlow); scorecards with status-rule + rollup overlay and
check-ins; a Q&A AI-visual (AOAI text→structured wells→SQL over the Loom semantic model); and
deployment-pipelines + git-integration surfaces. The honest gaps below are therefore **narrow
and deep**, not foundational — they cluster on (a) **day-one provisioning of the tabular
engine** so the rich AAS-backed surfaces are LIVE instead of env-gated, (b) a few **advanced
model features** (linguistic schema, manage-aggregations, Analyze-in-Excel/XMLA advertise), and
(c) **connected-metrics live binding + alert delivery**.

---

## 1. Capability inventory (grounded in Microsoft Learn)

Legend for "Loom": ✅ built · ⚠️ stubbed/partial or env-gated · ❌ missing.

### 1.1 Semantic model (tabular) — modeling surface

| # | Fabric/Power BI capability | How it actually works (architecture / item model / API) | Learn | Loom |
|---|----------------------------|----------------------------------------------------------|-------|------|
| 1 | Semantic model item (Import / DirectQuery / Direct Lake / Composite) | TOM tabular model (TMDL/TMSL) hosted in the VertiPaq engine on Fabric capacity; CRUD via Fabric `semanticModel` REST; query via XMLA / `executeQueries`. | fabric/data-warehouse/semantic-models | ✅ |
| 2 | Create model from lakehouse/warehouse (New semantic model) | Picks Delta tables → Direct Lake model; "Open data model" web modeling. | fabric/data-warehouse/create-semantic-model | ✅ |
| 3 | Tables / columns / data types / display folders / hierarchies | Model metadata (TMDL); web-modeling Model view. | power-bi/transform-model | ✅ |
| 4 | Relationships (1:M, M:1, M:M, active/inactive, cross-filter dir) | Model relationships drive filter propagation. | power-bi/transform-model | ✅ |
| 5 | Measures (DAX), implicit-measure discouragement | Explicit DAX measures; `DiscourageImplicitMeasures`. | dax / transform-model | ✅ |
| 6 | Calculation groups (items, precedence, dynamic format strings) | `calculationGroup` table w/ `calculationItems` using `SELECTEDMEASURE()`; precedence merges items; OLS/RLS not allowed *on* the group. | analysis-services/.../calculation-groups | ✅ (AAS/loom/Fabric persist) |
| 7 | Field parameters (NAMEOF calc table → slicer swaps measure/column) | Generated calc table; report slicer rebinds visual field. | power-bi/create-reports/power-bi-field-parameters | ✅ |
| 8 | What-if parameters (generate-series calc table + slicer) | `GENERATESERIES` calc table + single-select slicer bound to a measure. | power-bi/transform-model/desktop-what-if | ⚠️ partial |
| 9 | Grouping & binning columns | Group/bin calc columns. | power-bi/create-reports/desktop-grouping-and-binning | ⚠️ |
| 10 | Row-level security (RLS) — static + dynamic roles, DAX filters | `roles[].tablePermissions[].filterExpression` (DAX bool); dynamic via `USERPRINCIPALNAME()`; viewers only. | fabric/security/service-admin-row-level-security | ✅ |
| 11 | Object-level security (OLS) — hide table/column | `metadataPermission='none'` on table/column. | fabric/security/service-admin-object-level-security | ✅ |
| 12 | Test as role / View as | XMLA `EffectiveUserName` + `Roles` impersonation probe. | power-bi/guidance/rls-guidance | ✅ |
| 13 | Manage aggregations (agg table awareness for composite) | Agg table mapped to detail table; auto-redirect of group-by queries. | power-bi/transform-model/aggregations-advanced | ❌ |
| 14 | Per-table storage mode (Import / DirectQuery / Dual) | Composite model storage modes; Dual avoids RLS/hybrid penalties. | power-bi/transform-model/desktop-storage-mode | ⚠️ |
| 15 | Linguistic schema / synonyms / phrasings / hide-from-Q&A / row labels | `.lsdl.yaml` schema fed to the NL engine; improves Q&A + Copilot grounding. | power-bi/natural-language/q-and-a-tooling-advanced | ❌ |
| 16 | TMDL / TMSL definition + XMLA read-write endpoint | TMDL source format; XMLA endpoint for SSMS/Tabular Editor/TOM/AMO. | analysis-services/tmdl/tmdl-overview | ✅ (AAS XMLA) |
| 17 | Semantic Link (notebook TOM / `sempy`) | Python access to model metadata + DAX from notebooks. | fabric/data-science/semantic-link-power-bi | ✅ |
| 18 | Endorsement (Promoted / Certified) + sensitivity label | Workspace governance flag + Purview MIP label on the dataset. | power-bi/collaborate-share/service-endorse-content | ⚠️ |
| 19 | Analyze in Excel / 3rd-party XMLA connectivity | ODC → Excel PivotTable on the model via XMLA; Tableau/etc via XMLA. | power-bi/connect-data/semantic-models-third-party | ❌ |

### 1.2 Refresh, Direct Lake, datamart

| # | Capability | Architecture | Learn | Loom |
|---|-----------|--------------|-------|------|
| 20 | Scheduled refresh (Import) — days/times/tz/notify | `refreshSchedule` PATCH; ≤48/day in service. | power-bi/connect-data/refresh-data | ✅ |
| 21 | Enhanced/async refresh (table+partition, retry, cancel) | `POST datasets/{id}/refreshes` async API. | power-bi/connect-data/asynchronous-refresh | ✅ (AAS `/refreshes`) |
| 22 | Refresh history | `GET .../refreshes`. | — | ✅ |
| 23 | Incremental refresh policy (RangeStart/RangeEnd, store/refresh window) | Policy generates date partitions on first refresh; rolling window. | power-bi/connect-data/incremental-refresh-overview | ✅ |
| 24 | Real-time hybrid (DirectQuery partition appended to incremental table) | Hybrid table: import historical + DQ leading partition; Dual related dims. | power-bi/connect-data/incremental-refresh-xmla | ⚠️ partial |
| 25 | Partition manager (view/refresh single partition, bootstrap) | XMLA `TMSCHEMA_PARTITIONS` + TMSL refresh per-partition; SSMS/Tabular Editor. | power-bi/connect-data/incremental-refresh-xmla | ⚠️ (discover ✅, per-partition UI ⚠️) |
| 26 | Direct Lake storage mode + DirectQuery fallback + framing | Reads Delta/Parquet straight into VertiPaq; framing = metadata-only refresh; falls back to DQ on guardrail/RLS/view. | fabric/fundamentals/direct-lake-overview | ✅ (Synapse Serverless default + warm shim) |
| 27 | Large semantic model storage format | >1GB models; required before first IR refresh. | power-bi/enterprise/service-premium-large-models | ⚠️ (opt-in only) |
| 28 | Datamart (auto SQL store + auto model) — **deprecated** | Was: Power Query → auto Azure SQL + auto model + SQL endpoint. MS deprecated → DB + model. | power-bi/transform-model/datamarts/datamarts-overview | ✅ (migration-only) |

### 1.3 Dashboards, scorecards & metrics

| # | Capability | Architecture | Learn | Loom |
|---|-----------|--------------|-------|------|
| 29 | Dashboard (single-page, multi-model, pinned tiles) | Tiles pinned from report visuals/Q&A; entry-point to reports. | power-bi/create-reports/service-dashboards | ✅ |
| 30 | Pin live tile / pin report page | Pinned visual or live page tile. | power-bi/create-reports/service-dashboard-pin-live-tile-from-report | ✅ |
| 31 | Data alerts on dashboard tiles (gauge/KPI/card) | Threshold rules on refreshed numeric tiles → notification/email; ≤250 alerts. | power-bi/create-reports/service-set-data-alerts | ⚠️ (Azure Monitor map) |
| 32 | Activator alerts on report visuals | Fabric Activator rule on a visual measure. | fabric/real-time-intelligence/data-activator/activator-get-data-power-bi | ✅ (Activator=Azure Monitor) |
| 33 | Scorecards + manual goals (current/target/status/notes/dates) | Scorecard item + a backing metrics semantic model in the workspace. | power-bi/create-reports/service-goals-create | ✅ |
| 34 | Connected metrics (goal bound to a report visual / measure) | Goal value auto-checks-in on the connected dataset refresh. | power-bi/create-reports/service-goals-create-connected | ⚠️ partial |
| 35 | Automated status rules (value / %-of-target / date) | Rules recompute status on each scorecard refresh. | power-bi/create-reports/service-metrics-status-rules | ✅ (overlay) |
| 36 | Check-in history + notes + follow (Teams/email) | Manual/auto check-ins; follow → alerts. | power-bi/create-reports/service-metrics-follow | ⚠️ (history ✅, delivery ⚠️) |
| 37 | Rollup / cascading hierarchy (sub-goals) | Parent/child rollup; heatmap (hierarchies retiring Apr-2026). | power-bi/create-reports/service-goals-get-started-hierarchies | ✅ (rollup overlay) |

### 1.4 Dataflows, Q&A/Copilot, deployment

| # | Capability | Architecture | Learn | Loom |
|---|-----------|--------------|-------|------|
| 38 | Dataflow Gen2 (Power Query Online, 300+ transforms, multi-destination) | Mashup/Spark engine → staging lakehouse+warehouse → destination; CI/CD by default. | fabric/data-factory/dataflows-gen2-overview | ✅ (ADF WranglingDataFlow) |
| 39 | Dataflow Gen1 (legacy, ADLS/CDM, computed/linked tables) | Power Query → CDM folders in ADLS; computed tables (Premium). | power-query/dataflows/overview | ✅ (covered by Gen2 surface) |
| 40 | Dataflow data preview (inline rows) | Mashup eval preview. | — | ⚠️ honest-gate (no inline ADF eval) |
| 41 | Q&A natural-language visual (ask-data → visual) | NL engine over model + linguistic schema; "turn into visual". | power-bi/natural-language/q-and-a-intro | ✅ (AOAI→wells→SQL) |
| 42 | Copilot for Power BI — DAX queries, measure descriptions, narratives, report build | AOAI grounded in model metadata; DAX parser post-validates. | power-bi/create-reports/copilot-introduction | ✅ (report/model Copilot) |
| 43 | Git integration (PBIP/TMDL source format) | Workspace ↔ Git repo; semantic model + report as folders. | fabric/cicd/git-integration | ✅ |
| 44 | Deployment pipelines (dev/test/prod stages + deployment rules) | Stage workspaces; data-source/parameter deployment rules; compare/diff. | fabric/cicd/deployment-pipelines | ✅ (Loom stages) |
| 45 | Workspace / capacity model | Fabric capacity (F-SKU) hosts workspaces; Pro/PPU for PBI. | fabric/enterprise/licenses | ✅ (Loom workspace = Cosmos) |

**Enumerated capability count: 45 distinct capabilities** (≈60 sub-controls). Sources at end.

---

## 2. Loom coverage summary

| Area | Built ✅ | Stubbed/partial ⚠️ | Missing ❌ |
|------|---------|---------------------|-----------|
| Model authoring | tables, columns, relationships, measures, calc groups, field params, RLS, OLS, test-as-role, TMDL/TMSL, semantic link | what-if params, per-table storage mode, grouping/binning, endorsement | manage-aggregations, linguistic schema, Analyze-in-Excel/XMLA advertise |
| Refresh / Direct Lake | scheduled, enhanced async, history, IR policy, partition discover, Direct Lake (Serverless default + shim) | hybrid real-time DQ partition, per-partition refresh UI, large-model format | — |
| Datamart | deprecation banner + migrate to Synapse Serverless + AAS | — | — |
| Dashboards/scorecards | dashboard, tiles, drill, scorecard list/goals/check-in, status rules, rollup | connected metrics live bind, alert delivery (Teams/email), tile data alerts | — |
| Dataflows | Gen2 full PQ surface, run, destinations | inline data preview (honest-gate) | — |
| Q&A / Copilot | Q&A visual, model+report Copilot, DAX gen, measure descriptions | — | linguistic-schema/synonyms editor feeding NL |
| Deployment | git integration, deployment pipelines/stages | data-source/parameter deployment rules | — |

**The dominant systemic finding:** the richest model surfaces (RLS test-as-role, calc-group
*live* write, IR partitions, XMLA connectivity, endorsement reads) are coded against **Azure
Analysis Services via env (`LOOM_AAS_SERVER` / `LOOM_AAS_XMLA_ENDPOINT` / `LOOM_SEMANTIC_BACKEND`)**
and otherwise fall back to **loom-native Cosmos content** that can persist definitions but cannot
execute live XMLA. Per **day-one-on / no-gates**, the platform must **provision the tabular engine
day-one** (bicep), not leave it as an honest env-gate. That is gap **G1** and unblocks the ⚠️ rows.

---

## 3. Gap build specs

Each gap: architecture-in-words · Web-5.0 UI · BFF API · Azure services + real backend per
control · bicep/deploy · day-one config · Commercial vs Government · acceptance.

### G1 (P0) — Day-one tabular engine (un-gate the AAS-backed model surfaces)

**Problem.** RLS test-as-role, calc-group live write, incremental-refresh partition refresh,
XMLA connectivity, and endorsement all *exist* but are env-gated on an AAS server the platform
never deploys, so out-of-the-box they degrade to loom-native (no live XMLA). Violates day-one-on.

**Architecture (Azure-native default).**
- **Commercial:** deploy an **Azure Analysis Services** server (`Microsoft.AnalysisServices/servers`,
  SKU `S0` scale-to-pause; `asAdministrators` = the deploy SP + Console UAMI where supported) **day-one**
  in the admin/landing-zone bicep. Wire `LOOM_AAS_SERVER` / `LOOM_AAS_XMLA_ENDPOINT` /
  `LOOM_AAS_CLIENT_ID` (+ KV secretRef `LOOM_AAS_CLIENT_SECRET`) into the console `apps[]` env
  automatically. `LOOM_SEMANTIC_BACKEND` default flips from `loom-native` to `analysis-services`
  when the server resolves.
- **Durable Loom-native engine (always present, also the Gov default):** a **DAX→T-SQL semantic
  engine** over **Synapse Serverless/Dedicated** — the model's measures/relationships compile to
  parameterized SQL; **RLS = Synapse `CREATE SECURITY POLICY` + `FILTER PREDICATE`**; OLS = column
  GRANT/DENY; "test-as-role" = run the SQL under the impersonated predicate. This is the substitute
  where AAS is absent and the long-term durable path (AAS is on a retirement track).
- **AAS retirement note:** AAS is GA today but slated for retirement; treat AAS as the *fast tabular
  accelerator* and the Loom-native DAX→Synapse engine as the *durable default*. Both ship; selection
  is automatic by capability (true VertiPaq features → AAS when present, else SQL-compiled).

**Web-5.0 UI.** No new editor — a **"Semantic engine" status chip** in the model ribbon (Fluent
`Badge`: "Live tabular (AAS)" / "SQL-compiled (Synapse)" / honest-gate only if BOTH unprovisioned)
and an **Admin → Semantic Engine** card in the platform admin shell (provision/pause/scale AAS,
view XMLA endpoint, health) — all dropdowns/toggles, no freeform.

**BFF API.** `GET/POST /api/admin/semantic-engine` (status, provision, pause/resume, scale) →
ARM on the AAS server; existing model routes unchanged (they already prefer AAS when env present).

**Azure services + real backend.** AAS (ARM + XMLA), Synapse Serverless (TDS), Key Vault (SP secret),
Managed Identity. Every control = real ARM/TDS/XMLA call.

**Bicep/deploy.** New `platform/fiab/bicep/modules/admin-plane/analysis-services.bicep` (server +
firewall/PE + diag settings → Log Analytics); KV secret for the AAS SP; env wiring in
`admin-plane/main.bicep` `apps[]`; pause/resume runbook in `scripts/csa-loom/`.

**Day-one config.** Provisioned + `analysis-services` backend ENABLED by default; admin can DISABLE
(falls to SQL-compiled). No user action to get live RLS/calc-groups/partitions.

**Commercial vs Government.**
- Commercial: AAS GA in most regions; XMLA scope `*.asazure.windows.net` / `analysis.windows.net`.
- **Gov (GCC / GCC-High / DoD IL4-5):** AAS regional availability is **limited/absent in high side**
  → **Loom-native DAX→Synapse engine is the Gov default** (no AAS dependency); XMLA scope
  `analysis.usgovcloudapi.net` only where an AAS Gov region exists; Synapse + private-only
  networking; AOAI-independent. OSS option for true tabular in Gov: **DuckDB/Mosaic-style columnar
  cache on ACA** behind the same DAX→SQL compiler (no managed VertiPaq exists OSS).

**Acceptance.** With **no `LOOM_AAS_*` env preset by the operator**, a freshly-deployed Commercial
sub shows the model RLS tab running a real *test-as-role* probe (filtered rows) and a calc-group
*live* write returning a TMSL receipt; a Gov deploy shows the same via SQL security policies. Both
with `LOOM_DEFAULT_FABRIC_WORKSPACE` UNSET.

---

### G2 (P1) — Linguistic schema / synonyms editor (NL + Copilot grounding)

**Problem.** The Q&A visual and Copilot work, but there is no surface to author **synonyms,
phrasings, hide-from-Q&A, row labels** — the metadata that materially improves NL accuracy. Q&A's
`.lsdl.yaml` is the source-product analog.

**Architecture.** A **model "Q&A / Copilot optimization" tab**: synonyms per table/column/measure,
phrasings (subject-verb-object relationships), hide-from-NL flags, row-label designation, and
measure descriptions (Copilot can draft). Stored in Cosmos `state.content.linguistics` and **injected
into the grounding prompt** of the shared `copilot-orchestrator` + the `/ai-visual` (Q&A) route, and
written as model annotations (TMDL `annotation`) when AAS/Fabric backend is selected.

**Web-5.0 UI.** WYSIWYG grid (no YAML hand-editing): per-field rows with a synonym `TagPicker`,
a phrasing builder (3 dropdowns: noun → verb → noun), hide toggle, "row label" radio, and a
"Copilot: suggest synonyms/descriptions" button. Only the optional advanced "view as YAML" is a
read-only export (1:1 source-format surface).

**BFF API.** `GET/PUT /api/items/semantic-model/[id]/linguistics` (Cosmos) + read by the Q&A and
Copilot routes; `POST .../linguistics/suggest` → AOAI draft.

**Azure services.** Cosmos (store), AOAI (suggest), AAS/Fabric (optional annotation write).

**Bicep/deploy.** No new infra (Cosmos + AOAI already day-one). Add `linguistics` to the model
content schema.

**Day-one.** Tab visible + functional on every model; synonyms auto-seeded from column display
names. Disable per-tenant via governance flag.

**Commercial vs Gov.** Identical; Gov uses Gov AOAI deployment + Gov Cosmos. Where Gov AOAI model
unavailable, the editor still saves synonyms (grounding still applied deterministically); only the
"suggest" button honest-gates.

**Acceptance.** Adding synonym "revenue"→`Sales[Amount]` makes the Q&A visual answer "show revenue
by region" correctly where it previously failed; receipt = the rendered chart + the grounding
payload echo.

---

### G3 (P1) — Connected metrics (live bind) + status-rule auto-refresh + alert delivery

**Problem.** Scorecard authoring overlay (status rules, rollup, manual check-in) is built, but a
goal **bound to a live measure** that auto-checks-in on dataset refresh, and **alert delivery to
Teams/email** on status change, are partial.

**Architecture.** A goal can bind to `{semanticModelId, measure, filter}`. On the model's refresh
completion (or a scheduled poll), a **connected-metric evaluator** runs the measure via the same
DAX→AAS/Synapse path, writes a check-in value, recomputes status from the rules, and — on status
change/threshold — emits an alert via **Azure Monitor action group** (email) and a **Logic App /
Teams Incoming Webhook** (Teams), mirroring "follow your metrics". Maps to the no-fabric canonical:
Activator → Azure Monitor.

**Web-5.0 UI.** In the scorecard editor: goal "Connect to data" dialog (model dropdown → measure
dropdown → optional filter builder); "Auto check-in" toggle + cadence; "Follow / notify" toggle →
channel picker (Email / Teams). No freeform.

**BFF API.** `POST /api/items/scorecard/[id]/connect-metric`, `POST .../evaluate` (run now),
`POST .../follow` (action-group + webhook subscribe). Evaluator also runnable from the model
refresh hook.

**Azure services.** AAS/Synapse (measure eval), Azure Monitor action groups (email), Logic App or
Teams webhook (Teams), Cosmos (check-in history). Real calls, no mocks.

**Bicep/deploy.** Action-group module + optional Logic App connector in `admin-plane`; env for the
Teams webhook secret (KV). Scheduler = existing Loom refresh hook / a timer ACA job.

**Day-one.** Connected-metric eval ENABLED; alert channels provisioned (email action group day-one;
Teams webhook optional). Disable per scorecard.

**Commercial vs Gov.** Azure Monitor action groups available both clouds (Gov endpoints `.us`).
Teams webhook works in GCC; in GCC-High validate Teams connector availability, else email-only.

**Acceptance.** A goal bound to `Total Sales` auto-checks-in the real measure value after a model
refresh and emails on breaching target — receipt = check-in row + Monitor alert history.

---

### G4 (P2) — Manage aggregations + per-table storage mode (Dual) designer

**Problem.** Composite-model **aggregation tables** (group-by redirection) and **per-table storage
mode** (Import/DirectQuery/**Dual**) are not authorable; both are core composite/Direct-Lake-fallback
perf features.

**Architecture.** Aggregations = a detail-grain table + an agg table with a **mapping** (agg column →
detail column + summarization); the engine redirects matching group-by queries to the agg. In
Loom-native, compile to a **materialized agg view in Synapse** + a router in the DAX→SQL layer; in
AAS, write the `alternateOf` aggregation metadata via TMSL. Storage mode = per-table TMSL `mode`
(`import`/`directQuery`/`dual`); Dual recommended for dims related to hybrid tables.

**Web-5.0 UI.** Model "Aggregations" tab: pick agg table → grid mapping rows (agg col → detail col →
summarization dropdown) + precedence; per-table **storage-mode `Select`** in the Tables tab with a
guidance `Caption1`. Backed by live TMSL/Synapse.

**BFF API.** `PUT /api/items/semantic-model/[id]/aggregations`, `PUT .../storage-mode`.

**Azure services.** AAS (TMSL) / Synapse (materialized view + router). Cosmos for loom-native.

**Bicep/deploy.** None new (uses AAS/Synapse from G1).

**Day-one.** Tabs present + functional; no agg defined by default (opt-in per model). 

**Commercial vs Gov.** Identical; Gov uses Synapse materialized views (no AAS dependency).

**Acceptance.** Defining an agg over a fact table makes a `SUM by Year` query read the agg
(receipt = query plan/SQL showing the agg table) instead of the detail grain.

---

### G5 (P2) — Analyze in Excel / XMLA connectivity advertise + endorsement & sensitivity

**Problem.** No surface advertises the **XMLA endpoint / Analyze-in-Excel** for third-party + Excel
consumption, and **endorsement (Promoted/Certified) + sensitivity label** are Fabric-only reads
rather than an Azure-native set.

**Architecture.**
- **Connectivity:** surface the AAS XMLA endpoint connection string + a generated **`.odc`** (Office
  Data Connection) file so Excel opens a live PivotTable on the model via XMLA; same string for
  Tableau/DAX Studio. Pure metadata + a download.
- **Endorsement/label (Azure-native):** store endorsement on the **Loom governance catalog** item
  (Promoted/Certified + certifier + date) and apply a **Microsoft Purview / MIP sensitivity label**
  to the dataset's catalog entry — not a Fabric read.

**Web-5.0 UI.** Model "Connect / Share" panel: copy-able XMLA string + "Download Excel connection
(.odc)" + "Analyze in Excel"; an **Endorsement** control (radio Promoted/Certified + certifier) and
a **Sensitivity** label dropdown — wired to the governance catalog + Purview.

**BFF API.** `GET /api/items/semantic-model/[id]/connect` (string + odc), `PUT .../endorsement`,
`PUT .../sensitivity`.

**Azure services.** AAS XMLA (endpoint), Loom governance catalog (Cosmos), Purview/MIP (label).

**Bicep/deploy.** None new; Purview already day-one in governance modules.

**Day-one.** Connect panel functional whenever G1 engine present; endorsement/sensitivity always
functional (catalog + Purview). 

**Commercial vs Gov.** XMLA scope per cloud; Purview labels available both (Gov `.us`); where Purview
classification API limited in GCC-High, fall back to the Loom catalog flag (disclosed).

**Acceptance.** Downloading the `.odc` and opening in Excel yields a live PivotTable on the model;
marking Certified shows the badge in the catalog and a Purview label on the asset.

---

## 4. Cross-cutting compliance check

- **No hard Fabric/Power BI dependency:** every gap's default path is AAS (opt-in family? — AAS is
  **Azure-native PaaS, not Fabric**, so allowed as default) or the **Loom-native DAX→Synapse engine**;
  Fabric/Power BI XMLA stays opt-in. No `api.fabric`/`api.powerbi`/`onelake` on default paths.
- **Day-one ON:** G1 deploys the engine in bicep; G2/G3/G5 ride existing day-one Cosmos/AOAI/Monitor/
  Purview; all ENABLED by default, operator-disable only.
- **Dual cloud:** each gap names Commercial vs Gov endpoints, AAS-absence substitute (DAX→Synapse /
  DuckDB-on-ACA), Gov AOAI/Monitor/Purview `.us`, private-only networking, IL4/5 notes.
- **Web-5.0 + no-freeform:** all authoring via dropdowns/wizards/grids/pickers; the only freeform is
  the 1:1 DAX/M expression surfaces (Monaco) and read-only YAML/TMDL export.
- **Real backend per control:** every control above maps to a real ARM/TDS/XMLA/AOAI/Monitor/Cosmos
  call; no mock arrays.

## 5. Sources (Microsoft Learn)

- fabric/data-warehouse/semantic-models · create-semantic-model
- fabric/fundamentals/direct-lake-overview · direct-lake-power-bi-desktop · store-data
- power-bi/connect-data/service-dataset-modes-understand · semantic-models-third-party
- power-bi/transform-model/calculation-groups · power-bi-field-parameters · desktop-what-if · aggregations-advanced · desktop-storage-mode
- analysis-services/tabular-models/calculation-groups · object-level-security · roles-ssas-tabular · tmdl/tmdl-overview · tom
- fabric/security/service-admin-row-level-security · service-admin-object-level-security
- power-bi/guidance/rls-guidance
- power-bi/connect-data/incremental-refresh-overview · incremental-refresh-xmla · asynchronous-refresh · refresh-data
- fabric/enterprise/powerbi/service-premium-connect-tools
- power-bi/transform-model/datamarts/datamarts-overview
- power-bi/create-reports/service-dashboards · service-set-data-alerts · service-goals-introduction · service-goals-create · service-goals-create-connected · service-metrics-status-rules · service-metrics-follow · service-goals-get-started-hierarchies
- power-bi/explore-reports/end-user-dashboards · business-user-set-alerts
- fabric/data-factory/dataflows-gen2-overview · pricing-dataflows-gen2 · cicd-pipelines
- power-query/dataflows/overview · create-use · computed-tables · power-query-online-limits
- power-bi/natural-language/q-and-a-tooling-advanced · q-and-a-tooling-intro · q-and-a-best-practices · q-and-a-tooling-teach-q-and-a
- power-bi/create-reports/copilot-introduction · copilot-reports-overview · copilot-semantic-models · copilot-integration · copilot-evaluate-data
- fabric/cicd/git-integration/intro-to-git-integration · deployment-pipelines/intro-to-deployment-pipelines · best-practices-cicd
- power-bi/developer/projects/projects-overview · projects-build-pipelines · projects-deploy-fabric-cicd
- power-bi/paginated-reports/* (report pass — referenced only)
