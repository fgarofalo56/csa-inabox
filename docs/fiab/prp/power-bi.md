# PRP — Power BI / BI at full Microsoft-Fabric parity, Azure-native

> **Status:** Implementation-ready.
> **Owner experience:** CSA Loom › Power BI / BI.
> **Parity target:** Microsoft Fabric "Power BI / BI" workload — Semantic
> Models (all storage modes + refresh + DAX + calculation groups + RLS/OLS),
> Reports, Paginated Reports, Dashboards, Metrics / Scorecards, Datamarts
> (deprecated — migration-only), and Deployment Pipelines / ALM + Git
> integration.
> **Hard rule:** Per `.claude/rules/no-fabric-dependency.md`, **every feature in
> this PRP must be 100% functional on Azure-native backends by default, with a
> real Microsoft Fabric capacity / Power BI workspace UNSET.** Fabric / Power BI
> are opt-in only, selected via `LOOM_<ITEM>_BACKEND=fabric` (or
> `LOOM_BI_BACKEND=powerbi`) + a bound workspace. Never gate on
> `fabricWorkspaceId` / `powerBiWorkspaceId` without an Azure fallback in the
> same function. **Power BI counts as Fabric-family — a "real Power BI
> workspace" requirement is also a violation.** The Azure-native semantic-model
> / report / dashboard / scorecard path must NOT require a Power BI or Fabric
> workspace to function.
> Per `.claude/rules/no-vaporware.md`, **no stubs, no mock arrays, no
> `return []` placeholders** — each task lands real backend calls or an honest
> infra-gate MessageBar (Fluent `intent="warning"` naming the exact env var /
> role / resource to provision).
> Per `.claude/rules/ui-parity.md`, each surface gets a parity doc at
> `docs/fiab/parity/<slug>.md` and must match the source UI one-for-one — theme
> differs (Fluent v9 + Loom tokens), functionality does not.
> Per `.claude/rules/loom-no-freeform-config.md`, all config is
> dropdowns / wizards / WYSIWYG / canvas — the only freeform exception is a 1:1
> Power BI DAX expression editor and Power Query (M) editor, which are
> *authoring surfaces*, not config, and are allowed (Monaco with DAX/M language
> support).

---

## 1. Overview + Azure-native + OSS architecture (all 4 cloud types)

### 1.1 What this experience is

Microsoft Fabric's Power BI / BI workload is the analytics-and-reporting tier.
Its objects are:

- **Semantic model** — the tabular data model (tables, columns, measures,
  relationships, hierarchies, calculation groups, field parameters, RLS/OLS).
  Storage modes: **Import** (VertiPaq in-memory columnar), **DirectQuery**
  (live pass-through), **Composite** (mixed), **Dual** (context-dependent),
  **Direct Lake** (reads Delta/Parquet from OneLake via framing), and **Hybrid
  tables** (incremental Import + real-time DirectQuery partition). Has scheduled
  / on-demand / incremental refresh, enhanced-refresh REST, and XMLA endpoint.
- **Report** — interactive Power BI report (canvas, visuals, filters,
  bookmarks, drill-through, sync slicers) bound to a semantic model; embedded
  via the Power BI Embedded JS API.
- **Paginated report** — pixel-perfect RDL report (parameters, multi-page,
  export to PDF/Excel/Word).
- **Dashboard** — pinned-tile board over reports / Q&A / streaming tiles.
- **Metrics / Scorecard** — goals with current/target values, status rules,
  owners, check-ins, rollups, and connected metrics from a model.
- **Datamart** (deprecated) — self-service SQL warehouse + auto-generated
  model; **migration-only** in Loom (no new datamarts).
- **Deployment pipelines / ALM** — Dev → Test → Prod stages, compare,
  selective deploy, deployment rules, plus **Git integration** for items.

CSA Loom rebuilds all of these 1:1 on **Azure Analysis Services (AAS)** +
**ADLS Gen2 + Delta Lake** + **Azure Synapse (Serverless / Dedicated SQL)** +
**Azure SQL** + **Azure Data Explorer (ADX)** + **Cosmos DB** + a **Loom-native
report/dashboard/scorecard renderer**, with **no dependency on a real Fabric
capacity, OneLake, Power BI workspace, `api.fabric.microsoft.com`, or
`api.powerbi.com`** on the default path.

### 1.2 Azure-native + OSS backing services

| Concern | Azure-native DEFAULT | OSS component (optional) | Loom client / module |
|---|---|---|---|
| Tabular engine (Import) | **Azure Analysis Services (AAS) Standard** — VertiPaq + DAX, identical engine | `semantic-link` (DataFrame↔tabular), DuckDB (dev query) | `aas-client` (new), `synapse-sql-client` |
| TMSL / model authoring | **AAS XMLA management REST** (`/databases/{db}/command`, TMSL JSON) | TOM (Tabular Object Model, used in shim) | `aas-client`, `apps/fiab-direct-lake-shim/Tom/TomRefreshClient.cs` |
| DirectQuery source | **Synapse Serverless SQL** (ADLS/Delta), **Azure SQL / MI** (relational), **ADX** (Kusto) | Trino / Calcite (federation) | `synapse-sql-client`, `azure-sql` clients, `kusto-client` |
| Composite / Dual | **AAS composite model** (per-table `mode` in TMSL) | Trino multi-catalog | `aas-client` |
| Direct Lake (shim) | **ADLS Gen2 + Delta + AAS incremental-refresh** (5–30 s warm cache) + Synapse Serverless fallback | `delta-rs`, Apache Arrow Flight, `delta-spark` | `apps/fiab-direct-lake-shim/**`, `adls-client`, `aas-client` |
| Hybrid tables | **AAS incremental-refresh policy** + current-period DirectQuery partition | — | `aas-client` |
| Scheduled / enhanced refresh | **AAS REST** `/refreshes` + `PATCH /refreshSchedule`; trigger via **ADF**/**Functions timer** | — | `aas-client`, `synapse-dev-client`, `monitor-client` |
| Power Query (M) ingest | **ADF / Synapse Dataflow Gen2** → Delta in ADLS, then AAS model over it | Mashup-engine-equivalent transforms | `synapse-artifacts-client`, `adls-client` |
| Report rendering | **Loom-native report renderer** over the semantic layer (visuals = Loom chart model) | OSS Superset / Grafana (export, optional) | `report-model` (new), existing chart model |
| Paginated (RDL) rendering | **Loom-native RDL renderer** → PDF/Excel/Word | OSS: ReportLab / Apache POI for export | `paginated-report-renderer` (new) |
| Dashboard tiles | **Loom-native dashboard model** (tiles bind to model/report/streaming) | — | `dashboard-model` |
| Metrics / Scorecards | **Loom-native scorecard model in Cosmos** (goals, check-ins, rules) + values from AAS/Synapse query | — | `scorecard-model` (Cosmos) |
| Deployment pipelines / ALM | **Loom-native stages in Cosmos** + diff over serialized item defs; deploy = re-provision into target | — | `deployment-pipeline-model` |
| Git integration | **Azure DevOps Repos / GitHub** item serialization + commit/sync | `git` CLI | `git-integration-client` (new) |
| RLS / OLS | **AAS roles + row filters (DAX)** / object-level perms in TMSL | — | `aas-client` |
| Identity / RBAC | **Entra ID + Azure RBAC** (AAS `Administrator`/server admin, Synapse SQL roles, Storage Blob Data roles) | — | `arm-client`, `rbac-client` |
| Secrets (connection strings) | **Azure Key Vault** secretRef | — | `keyvault-client` |
| Item metadata / item store | **Cosmos DB** (Loom item index) | — | `cosmos-client` |

There is **no Fabric capacity and no OneLake** in the Azure-native path. The
"OneLake" / "Direct Lake" experience maps to Delta tables in an ADLS Gen2
account Loom owns; the Direct-Lake-Shim materializes a warm AAS cache from those
Delta files. The "Power BI workspace" concept maps to a **Loom workspace +
AAS server + Cosmos item index**; the "publish to workspace" action installs the
item into Loom's own catalog and provisions its AAS/ADLS backing.

### 1.3 Cloud portability matrix (the 4 cloud types)

| Backend | Commercial | GCC | GCC-High | IL5 / DoD | Endpoint difference |
|---|---|---|---|---|---|
| Azure Analysis Services | GA | GA (`usgovvirginia`,`usgovarizona`) | GA (`usgovarizona`) | ⚠ FedRAMP High; **confirm IL5 SRG** in target enclave — else substitute Synapse Serverless + columnstore as the tabular fallback | `asazure://<region>.asazure.windows.net` vs `asazure://<region>.asazure.usgovcloudapi.net` |
| Synapse Serverless SQL | GA | GA | GA | ⚠ FedRAMP High; confirm IL5 SRG | `<ws>-ondemand.sql.azuresynapse.net` vs `...sql.azuresynapse.usgovcloudapi.net` |
| Synapse Dedicated SQL pool | GA | GA | GA | verify region/SKU | ARM split as below |
| Azure SQL / MI | GA | GA | GA | GA (IL5-authorized scope) | `database.windows.net` vs `database.usgovcloudapi.net` |
| ADX (DQ target) | GA | GA | GA | GA | `kusto.windows.net` vs `kusto.usgovcloudapi.net` |
| ADLS Gen2 (Delta) | GA | GA | GA | use Blob+HNS fallback if ADLS unconfirmed | `dfs.core.windows.net` vs `dfs.core.usgovcloudapi.net` |
| Cosmos DB | GA | GA | GA | GA | `documents.azure.com` vs `documents.azure.us` |
| ADF / Synapse pipelines (refresh trigger) | GA | GA | GA | verify region | ARM split as below |
| Azure Monitor (refresh alerts) | GA | GA | GA | GA | `management.*` + `<region>.monitoring.azure.com` split |
| Key Vault | GA | GA | GA | GA | `vault.azure.net` vs `vault.usgovcloudapi.net` |
| ARM control plane | GA | GA | GA | GA | `management.azure.com` vs `management.usgovcloudapi.net` |
| **Fabric / Power BI (opt-in only)** | GA | limited | limited | **no F-SKU in Gov** → true Direct Lake unavailable; shim is the only path | `api.powerbi.com` / `api.fabric.microsoft.com` — **opt-in branch only** |

**SKU caveat:** AAS tiers (B/S/D) and Synapse SQL pool / Serverless tiers are
not all available in every Gov region. Every SKU/region/tier selector built
below MUST call ARM `ListSkus` / capability APIs and filter by region at
runtime — never a hard-coded SKU list.

**Implication for code:** every host must resolve via the existing
`cloud-endpoints` helper (add `getAasSuffix()`, `getSynapseSqlSuffix()`,
`getCosmosSuffix()` as needed; reuse `getArmEndpoint()`, `getDfsSuffix()`,
`getKeyVaultSuffix()`, `getKustoSuffix()`), **never hard-coded**. Any new client
routes through that helper and is covered by a cloud-matrix unit test.

### 1.4 Item-type topology in Loom

```
power-bi workspace (Loom workspace)        ← Loom workspace + AAS server + Cosmos index
 ├─ semantic-model (item)                  ← AAS tabular DB  (or DirectQuery / Direct-Lake-shim)
 │    ├─ tables / columns / measures       ← TMSL via AAS XMLA management REST
 │    ├─ relationships / hierarchies       ← TMSL relationships
 │    ├─ calculation groups / field params ← TMSL calc groups
 │    ├─ RLS / OLS roles                   ← AAS roles + DAX row filters
 │    ├─ refresh (sched/incremental/hybrid)← AAS /refreshes + refresh policy
 │    └─ storage mode (per table)          ← TMSL partition mode (import/dq/dual/directlake-shim)
 ├─ report (item)                          ← Loom report renderer over a semantic-model
 ├─ paginated-report (item)                ← Loom RDL renderer
 ├─ dashboard (item)                       ← Loom dashboard model (pinned tiles)
 ├─ scorecard (item)                       ← Loom scorecard model in Cosmos
 └─ deployment-pipeline (cross-workspace)  ← Loom stages (Dev/Test/Prod) + Git integration
```

---

## 2. Feature-by-feature parity table

Legend — **Loom status today** (per the 2026-06-06 audit):
✅ built · 🟡 partial · ⚠️ honest-gate · ❌ missing.

| # | Fabric / Power BI feature | Azure-native + OSS replacement | Loom status today | Work needed (task) |
|---|---|---|---|---|
| **Semantic models — storage modes** | | | | |
| 1 | Import (VertiPaq) | AAS Standard Import; refresh via REST | ✅ | hardening only (T1) |
| 2 | DirectQuery | AAS DQ → Synapse Serverless / Azure SQL / ADX | ✅ | T2 (source-binder polish) |
| 3 | Composite (mixed modes) | AAS composite (per-table TMSL `mode`) | ✅ | T3 |
| 4 | Dual | AAS partition `mode:"dual"` | ✅ | T3 |
| 5 | **Direct Lake** | ADLS Delta + AAS incremental warm-cache shim + Serverless fallback | 🟡 (shim exists; not wired into editor) | **T4, T5** |
| 6 | Hybrid tables (incr + DQ partition) | AAS incremental policy + current-period DQ partition | 🟡 | **T6** |
| **Semantic models — modeling** | | | | |
| 7 | Tables / calculated tables | TMSL tables + calculated (DAX) | ✅ | T7 |
| 8 | Columns (calc, data category, format, summarize, sort-by, display folder) | TMSL column props | 🟡 | **T7** |
| 9 | Relationships (M:1/1:1/M:M, x-filter dir, active/inactive) | TMSL relationships + diagram | ✅ | T8 (diagram view) |
| 10 | Hierarchies | TMSL hierarchies | 🟡 | **T8** |
| 11 | Measures (DAX) + format strings | TMSL measures; Monaco DAX editor | ✅ | T9 |
| 12 | Calculation groups + dynamic format strings | TMSL calculation groups | ❌ | **T10** |
| 13 | Field parameters | TMSL field-parameter calc table | ❌ | **T10** |
| 14 | RLS (row-level security, DAX filters) | AAS roles + row filters | 🟡 | **T11** |
| 15 | OLS (object-level security) | TMSL object permissions | ❌ | **T11** |
| 16 | Automatic aggregations | AAS aggregations table + altMaps | ❌ | **T12** |
| 17 | Power Query (M) / dataflow ingest | ADF / Synapse Dataflow Gen2 → Delta → AAS | 🟡 | **T13** |
| **Semantic models — refresh** | | | | |
| 18 | Scheduled refresh (freq, tz, notify) | AAS `PATCH /refreshSchedule` | ✅ | T1 |
| 19 | On-demand refresh + history | AAS `POST /refreshes` + list | ✅ | T1 |
| 20 | Incremental refresh (RangeStart/End, rolling window) | AAS incremental policy + ADF trigger | 🟡 | **T6** |
| 21 | Enhanced refresh REST (async, partition, commitMode) | AAS enhanced refresh REST | 🟡 | **T6** |
| 22 | XMLA endpoint (read/write) | AAS XMLA endpoint (native) | ✅ | T9 |
| **Reports** | | | | |
| 23 | Interactive report viewer | Loom report renderer / PBI embed (opt-in) | ✅ | T14 |
| 24 | Visuals (bar/line/card/table/matrix/map/etc.) | Loom chart model | 🟡 | **T15** |
| 25 | Filters / slicers / sync slicers | Loom filter engine | 🟡 | **T15** |
| 26 | Bookmarks / drill-through / drill-down | Loom report interactions | 🟡 | **T16** |
| 27 | Report theme / formatting pane | Loom Fluent formatting pane | 🟡 | **T16** |
| 28 | Subscriptions / export (PDF/PPTX/PNG) | Loom export (Functions render) | ❌ | **T17** |
| **Paginated reports** | | | | |
| 29 | RDL viewer + parameters | Loom RDL renderer | ✅ | T18 |
| 30 | Multi-page layout / tablix | Loom RDL layout engine | 🟡 | **T18** |
| 31 | Export PDF/Excel/Word | Functions render (ReportLab/POI) | ⚠️ | **T19** |
| 32 | Paginated authoring (designer) | Loom RDL designer | ⚠️ | **T19** |
| **Dashboards** | | | | |
| 33 | Pin tiles from report/model | Loom dashboard model | ✅ | T20 |
| 34 | Q&A / NL tile | Copilot build-assist edge | 🟡 | **T20** |
| 35 | Real-time / streaming tiles | EH/ADX-backed tile | 🟡 | **T20** |
| 36 | Tile drill / fullscreen / mobile | Loom dashboard interactions | ✅ | T20 |
| **Metrics / Scorecards** | | | | |
| 37 | Scorecard with goals/targets/status | Cosmos scorecard model | ✅ | T21 |
| 38 | Connected metrics (from model query) | AAS/Synapse query binding | 🟡 | **T21** |
| 39 | Check-ins / notes / history | Cosmos check-in records | ✅ | T21 |
| 40 | Rollups + status rules | Loom rule engine | 🟡 | **T22** |
| **Datamarts (deprecated)** | | | | |
| 41 | Datamart (SQL + auto-model) | **migration-only** → Synapse Serverless + AAS model | ❌ (intentional) | **T23** (migration assistant + honest "deprecated" banner) |
| **Deployment pipelines / ALM** | | | | |
| 42 | Dev/Test/Prod stages | Loom stages in Cosmos | ✅ | T24 |
| 43 | Compare / selective deploy | Loom diff over serialized defs | ✅ | T24 |
| 44 | Deployment rules (per-stage params) | Loom deployment rules | 🟡 | **T24** |
| 45 | Git integration (commit/sync items) | Azure DevOps / GitHub item serialize | ❌ | **T25** |
| **Cross-cutting** | | | | |
| 46 | Cloud-endpoint resolution + RBAC | `cloud-endpoints` + bicep roles | 🟡 | **T26** |
| 47 | Bicep + env sync | AAS/Synapse/ADLS modules + env list | 🟡 | **T27** |
| 48 | Per-surface parity docs | `docs/fiab/parity/*` | 🟡 | **T28** |

---

## 3. Azure / OSS services — full feature set + native UI to rebuild 1:1

### 3.1 Azure Analysis Services (AAS) — the tabular engine

AAS is the same VertiPaq + DAX engine as Power BI Premium / Fabric semantic
models, on a standalone Azure server. Rebuild these surfaces:

- **Model designer** (Power BI Desktop / web-modeling parity): tables grid,
  relationship diagram, measure/column editors (Monaco DAX), display folders,
  hierarchies, calculation-group editor, field-parameter wizard.
- **Storage mode** per table (Import / DirectQuery / Dual / Direct-Lake-shim).
- **Refresh** management: scheduled (days/times/tz/notify), on-demand,
  incremental-refresh policy editor (RangeStart/RangeEnd + rolling window),
  enhanced-refresh REST (async, partition-level, commitMode), refresh history.
- **Security**: RLS roles + DAX row filters + test-as-role; OLS object perms.
- **Connections / DirectQuery datasource** binder.
- REST: `/servers/{s}/databases`, `/databases/{db}/command` (TMSL),
  `/refreshes`, `/refreshSchedule`. XMLA endpoint `asazure://...`.

### 3.2 ADLS Gen2 + Delta + Direct-Lake-Shim — Direct Lake parity

The shim (`apps/fiab-direct-lake-shim/`, .NET 10) already implements warm-cache
materialization: Storage Event Grid → TOM partition refresh on an AAS Import
model (`Tom/TomRefreshClient.cs`, `Models/RefreshPolicy.cs`). Freshness
**5–30 s** (not sub-second). Rebuild in the Console:

- **Storage Mode = "Direct Lake (shim)"** option with: Delta source path (ADLS
  Gen2 URI, ARM-populated), freshness SLA picker (5 min / 15 min / 1 hr / on-
  change), per-table refresh-policy selector (partition / full / DQ-fallback /
  composite), and an honest MessageBar disclosing that true sub-second Direct
  Lake needs an F-SKU (unavailable in Gov).
- **DirectQuery fallback**: when the warm cache is stale, the shim/route falls
  back to a Synapse Serverless query over the same Delta files.

### 3.3 Synapse Serverless / Dedicated SQL + Azure SQL — DirectQuery sources

DirectQuery / Composite pass-through targets. Rebuild the **source connection
panel**: pick source type (Synapse Serverless / Dedicated / Azure SQL / ADX),
connection string from Key Vault secretRef, test-connection button, table
picker for the model. No data copied in DQ mode.

### 3.4 Loom-native report renderer — Power BI report parity

Rebuild the **report canvas**: visual gallery (bar, column, line, area, combo,
pie/donut, card, multi-row card, KPI, table, matrix, map/filled-map, scatter,
gauge, funnel, treemap, slicer), fields/format/filters panes, bookmarks pane,
drill-through targets, sync slicers, cross-highlight, page navigation, theme.
Every visual binds to a real DAX query against the AAS model
(`EVALUATE`/summarize). Export via Functions render.

### 3.5 Loom-native paginated (RDL) renderer

Rebuild the **paginated report**: parameter panel, multi-page tablix/table/
list/chart layout, page navigation, export to PDF/Excel/Word (Functions render
using ReportLab / Apache POI). Authoring designer: data-source + dataset (DAX/
SQL query), tablix layout, expressions.

### 3.6 Loom-native dashboard + scorecard models (Cosmos)

- **Dashboard**: pinned tiles (from report visual, model Q&A, or streaming),
  grid layout, tile drill, fullscreen, mobile layout. Q&A tile = Copilot edge
  → DAX. Streaming tile = EH/ADX query.
- **Scorecard**: goals with current/target/status, owners, due dates,
  check-ins (note + value + status + timestamp), connected metric (binds to a
  model DAX query that refreshes the current value), rollups (sum/avg/worst-
  child), status rules (threshold → status color), sub-goals.

### 3.7 Loom-native deployment pipelines + Git integration

- **Pipelines**: Dev → Test → Prod stages; each stage is a Loom workspace;
  compare = diff over serialized item definitions (TMSL / report JSON / RDL /
  scorecard JSON); selective deploy = re-provision chosen items into the next
  stage; deployment rules = per-stage parameter overrides (data-source swap,
  parameter values).
- **Git integration**: serialize each item to its canonical text form, commit /
  pull / sync against Azure DevOps Repos or GitHub via `git-integration-client`.

### 3.8 OSS components (optional, disclosed)

`semantic-link` (Python, MS-published) for DataFrame↔tabular; `delta-rs` /
Apache Arrow Flight (shim Delta reads, zero-copy transport); `delta-spark` for
large refresh; DuckDB (dev query); Superset / Grafana (optional report export);
ReportLab / Apache POI (paginated export). All optional and behind a disclosed
toggle — never on the default path silently.

---

## 4. Sequenced TASK LIST

Each task is one implementable unit. **No stubs, no mock arrays, no `return []`,
no hard-coded sample data.** Every BFF route validates the minted session and
returns `{ ok, data, error }` with correct HTTP status. Every UI surface either
shows real data or a Fluent `MessageBar intent="warning"` naming the exact
env var / role / resource to provision. SKU/region/resource pickers populate
from ARM / Resource Graph at runtime.

> Shared paths referenced below:
> - Editors: `apps/fiab-console/lib/editors/phase3-editors.tsx` (semantic-model,
>   report, scorecard, dashboard, paginated-report editor surfaces live here),
>   `apps/fiab-console/lib/panes/semantic-model.tsx`.
> - Provisioner: `apps/fiab-console/lib/install/provisioners/semantic-model.ts`.
> - Clients: `apps/fiab-console/lib/azure/aas-client.ts` (NEW),
>   `powerbi-client.ts` (opt-in path), `fabric-client.ts` (opt-in path),
>   `synapse-sql-client.ts`, `adls-client.ts`, `synapse-artifacts-client.ts`,
>   `cosmos-client.ts`, `keyvault-client.ts`, `arm-client.ts`, `rbac-client.ts`.
> - Direct-Lake-Shim: `apps/fiab-direct-lake-shim/src/LoomDirectLakeShim/**`
>   (`Tom/TomRefreshClient.cs`, `Models/RefreshPolicy.cs`, `Program.cs`).
> - API roots: `apps/fiab-console/app/api/items/{semantic-model,report,
>   paginated-report,dashboard,scorecard}/[id]/**` and `/route.ts`.
> - Deployment pipelines / Git: `apps/fiab-console/app/api/deployment-pipelines/**`,
>   `git-integration-client.ts` (NEW).
> - Bicep: `platform/fiab/bicep/modules/admin-plane/aas.bicep` (NEW),
>   `synapse-*.bicep`, `adls.bicep`; env list in
>   `platform/fiab/bicep/admin-plane/main.bicep`.
> - Cloud endpoints: `apps/fiab-console/lib/azure/cloud-endpoints.ts`.
> - Existing parity docs (authoritative inputs): `docs/fiab/parity/
>   {semantic-model,report,paginated-report,scorecard,dashboard,
>   deployment-pipelines,powerbi-workspace,fabric-scorecard,MASTER-SCORECARD}.md`,
>   and `docs/fiab/workloads/direct-lake-parity.md`.

### Phase A — Semantic-model engine on AAS (T1–T3)

**T1 — `aas-client` + Import-mode refresh hardening**
- Goal: a first-class AAS client; make Import storage mode + refresh fully
  Azure-native (default path), not Power-BI-REST-gated.
- Create: `apps/fiab-console/lib/azure/aas-client.ts` — methods: `listDatabases`,
  `getDatabase`, `command(tmslJson)`, `refresh(body)`, `getRefreshes`,
  `setRefreshSchedule`. Auth via Entra MI; host via `cloud-endpoints.getAasSuffix()`.
- Edit: `phase3-editors.tsx` SemanticModelEditor → Storage Mode tab (default
  Import), Refresh tab (Refresh now / Scheduled refresh / History) to call the
  AAS routes; keep `powerbi-client` only behind `LOOM_BI_BACKEND=powerbi`.
- Backend: `app/api/items/semantic-model/[id]/refresh/route.ts` (POST/GET) →
  `aas-client.refresh` / `getRefreshes`; `.../refresh-schedule/route.ts` (PATCH).
- Bicep/portability: new `aas.bicep` (AAS Standard server, MI admin); host via
  `cloud-endpoints`. Honest-gate MessageBar if `LOOM_AAS_SERVER_NAME` unset.
- UI: Fluent cards; days/times/tz multiselect; notify toggle; history grid.
- Acceptance: Fabric/PBI UNSET — create an AAS Import DB, set schedule
  (days/times/tz/notify) → AAS returns updated schedule; "Refresh now" returns a
  real refresh id; history grid shows it. Receipt = first 300 chars of each
  route body. No `return []`/`MOCK_`.

**T2 — DirectQuery source binder**
- Goal: DirectQuery storage mode against a live Azure source.
- Edit: `phase3-editors.tsx` SemanticModelEditor → when DQ selected, disable
  "Refresh now", show "Source connection" panel: source-type dropdown (Synapse
  Serverless / Dedicated / Azure SQL / ADX), KV secretRef picker, test-connection,
  table picker.
- Backend: `app/api/items/semantic-model/[id]/datasource/route.ts` (GET/PUT) →
  `aas-client.command` setting DQ partition source; test via `synapse-sql-client`/
  `kusto-client`.
- Portability: host via `cloud-endpoints`; KV secretRef. Honest-gate if
  `LOOM_DQ_SOURCE_CONNECTION_STRING`/KV secret missing.
- Acceptance: bind a real Synapse Serverless endpoint → a DAX query returns live
  rows with no data copied (`.show`/server state confirms DQ). Receipt attached.

**T3 — Composite + Dual (per-table storage mode)**
- Goal: per-table mode picker (Import / DirectQuery / Dual) in one model.
- Edit: SemanticModelEditor Tables tab → per-row storage-mode dropdown.
- Backend: same datasource/command route setting per-partition `mode` in TMSL.
- Acceptance: a model with one Import table + one DQ table + one Dual table
  provisions in AAS; cross-mode relationship resolves and a visual returns rows.
  Receipt = TMSL applied + query result first 300 chars.

### Phase B — Direct Lake + Hybrid (T4–T6)

**T4 — Direct-Lake-shim wiring into the Console**
- Goal: surface the existing shim as a real Storage Mode in the editor.
- Edit: `phase3-editors.tsx` Storage Mode = "Direct Lake (shim)": Delta source
  path (ADLS URI, ARM-populated), freshness SLA picker (5 min/15 min/1 hr/
  on-change), per-table refresh-policy selector (partition/full/DQ-fallback/
  composite — maps to `Models/RefreshPolicy.cs`).
- Backend: `app/api/items/semantic-model/[id]/direct-lake/route.ts` (GET/PUT) →
  configures the shim (Event Grid subscription + AAS warm-cache model via
  `aas-client`); reads shim status.
- Portability: ADLS path via `cloud-endpoints.getDfsSuffix()`; grant AAS MI
  `Storage Blob Data Reader` (bicep role). Honest MessageBar: "True Direct Lake
  sub-second freshness requires a Fabric F-SKU (unavailable in Gov). This shim
  achieves 5–30 s via AAS incremental refresh. Set
  `LOOM_DIRECT_LAKE_SHIM_ENABLED=true`."
- Acceptance: point at a real Delta table; write new Delta rows → warm AAS cache
  reflects them within the SLA; a DAX query returns the new rows. Receipt = before/
  after row count + shim run log.

**T5 — Direct Lake DirectQuery fallback**
- Goal: when warm cache is stale/unbuilt, fall back to Synapse Serverless over
  the same Delta files.
- Backend: `direct-lake/route.ts` query path → if cache stale, `synapse-sql-client`
  `OPENROWSET`/external table over the Delta path.
- Edit: editor shows a "Serving from: warm cache | fallback (Serverless)" badge.
- Acceptance: invalidate the cache → query still returns correct rows via
  Serverless fallback; badge shows fallback. Receipt attached.

**T6 — Hybrid tables + incremental / enhanced refresh**
- Goal: incremental-refresh policy + current-period DirectQuery partition.
- Edit: SemanticModelEditor Refresh tab → incremental-refresh policy editor
  (RangeStart/RangeEnd date params, rolling window, detect-changes column,
  "real-time DirectQuery partition for current period" toggle).
- Backend: `app/api/items/semantic-model/[id]/refresh-policy/route.ts` (GET/PUT)
  → `aas-client.command` setting refresh policy + partitions; enhanced refresh
  (`POST /refreshes` with `commitMode`, partition list, `applyRefreshPolicy`,
  `effectiveDate`); refresh trigger via ADF/Functions timer (`synapse-dev-client`).
- Acceptance: set keep-3y/refresh-10d + current-period DQ partition → AAS creates
  historical Import partitions + a live DQ partition; new source rows in the
  current period appear without a full refresh. Receipt = partition list + query.

### Phase C — Modeling completeness (T7–T13)

**T7 — Tables + columns (calc, data category, format, summarize, sort-by, folder)**
- Edit: SemanticModelEditor Tables tab → column editor with: calculated-column
  DAX (Monaco), data-category dropdown (Web/Image URL, Country, City, Lat, Long,
  Barcode…), format-string builder, summarize-by dropdown, sort-by-column,
  display-folder, hidden toggle; calculated-table (DAX) creator.
- Backend: `app/api/items/semantic-model/[id]/model/route.ts` (GET/PATCH) →
  `aas-client.command` TMSL updates.
- Acceptance: add a calculated column + set data category + format + display
  folder → TMSL reflects all; a report visual uses them. Receipt attached.

**T8 — Relationships diagram + hierarchies**
- Edit: SemanticModelEditor "Model view" tab on React Flow (`@xyflow/react`,
  reuse pipeline-canvas patterns): table nodes, relationship edges (M:1/1:1/M:M,
  cross-filter direction, active/inactive), create/edit/delete relationship from
  the canvas; hierarchy editor (drag columns into drill levels).
- Backend: model route reads `relationships` + writes TMSL relationships/hierarchies.
- Acceptance: draw a relationship + mark one inactive + build a 3-level hierarchy
  → TMSL reflects; `USERELATIONSHIP` works; hierarchy drills in a visual. Receipt.

**T9 — Measures + DAX editor + format strings**
- Edit: measure editor (Monaco with DAX language support — allowed authoring
  surface), per-measure format string + display folder; DAX validate/run.
- Backend: model route TMSL measure upsert; DAX run via `aas-client` query.
- Acceptance: create a measure with a dynamic format → evaluates correctly in a
  visual. Receipt attached.

**T10 — Calculation groups + field parameters**
- Edit: calculation-group editor (group name, precedence, calc items with DAX +
  dynamic format string); field-parameter wizard (pick measures/columns → builds
  the field-parameter calc table).
- Backend: model route TMSL `calculationGroups` + field-parameter table.
- Acceptance: a calc group switches measure aggregation in a visual; a field
  parameter swaps the visual's measure via a slicer. Receipt attached.

**T11 — RLS + OLS**
- Edit: Security tab → roles grid; per-role table row-filter DAX editor; OLS
  object-permission matrix (table/column → None/Read); "Test as role" preview.
- Backend: `app/api/items/semantic-model/[id]/roles/route.ts` (GET/PUT) →
  `aas-client.command` TMSL roles + row filters + object permissions; test-as-role
  query.
- Portability: AAS role membership via Entra; bicep grants. Acceptance: a user in
  a restricted role sees only filtered rows; an OLS-hidden column is inaccessible.
  Receipt = test-as-role query result.

**T12 — Automatic aggregations**
- Edit: Aggregations tab → define aggregation table + altMaps (group-by/summarize
  mappings to a detail table) with a guided builder.
- Backend: model route TMSL aggregation table + `alternateOf` mappings.
- Acceptance: a query that matches the aggregation hits the agg table (verified
  via server query plan); detail query falls through. Receipt attached.

**T13 — Power Query (M) / dataflow ingest**
- Edit: "Get data" wizard → source picker → Power Query (M) editor (Monaco, M
  language — allowed authoring surface) → materialize to Delta in ADLS via ADF /
  Synapse Dataflow Gen2, then build the AAS table over it.
- Backend: `app/api/items/semantic-model/[id]/ingest/route.ts` →
  `synapse-artifacts-client` (dataflow) + `adls-client` + `aas-client`.
- Acceptance: M transform runs → Delta lands in ADLS → AAS table queryable.
  Honest-gate if no ADF/Synapse workspace env. Receipt attached.

### Phase D — Reports (T14–T17)

**T14 — Report viewer (Loom-native default)**
- Edit: `phase3-editors.tsx` ReportEditor → Loom-native report renderer over the
  bound semantic model (DAX queries via `aas-client`); PBI embed only behind
  `LOOM_BI_BACKEND=powerbi`.
- Backend: `app/api/items/report/[id]/route.ts` (GET def) +
  `.../query/route.ts` (POST DAX → rows).
- Acceptance: open a report → visuals render real rows from AAS with PBI UNSET.
  Receipt attached.

**T15 — Visual gallery + fields/format/filters panes**
- Edit: visual gallery (bar/column/line/area/combo/pie/donut/card/multi-row card/
  KPI/table/matrix/map/filled-map/scatter/gauge/funnel/treemap/slicer); Fields,
  Format, Filters panes; each visual compiles fields → a DAX `EVALUATE`/
  `SUMMARIZECOLUMNS` query.
- Backend: report query route runs the compiled DAX.
- Acceptance: add each visual type bound to model fields → renders real data;
  format pane changes apply; page/visual/report filters apply. Receipt = per-visual
  query + screenshot.

**T16 — Bookmarks, drill-through, drill-down, theme**
- Edit: bookmarks pane (capture/apply state), drill-through target pages (carry
  filter context), drill-down/up on hierarchies, cross-highlight, report theme.
- Acceptance: a drill-through navigates carrying context; a bookmark restores
  state; theme applies. Receipt attached.

**T17 — Report export + subscriptions**
- Create: `app/api/items/report/[id]/export/route.ts` → Azure Functions render
  to PDF/PPTX/PNG; subscription scheduler (Functions timer + email via action
  group / Logic App).
- Acceptance: export produces a real PDF/PPTX/PNG of the report; a subscription
  delivers it on schedule. Honest-gate if render Function not deployed. Receipt =
  exported file + delivery log.

### Phase E — Paginated reports (T18–T19)

**T18 — RDL viewer + parameters + multi-page layout**
- Edit: `phase3-editors.tsx` PaginatedReportEditor → Loom RDL renderer:
  parameter panel, multi-page tablix/table/list/chart layout, page navigation.
- Backend: `app/api/items/paginated-report/[id]/render/route.ts` →
  `paginated-report-renderer` (dataset via DAX/SQL through `aas-client`/
  `synapse-sql-client`).
- Acceptance: a parameterized RDL renders multi-page with real data. Receipt.

**T19 — Paginated authoring + export PDF/Excel/Word**
- Edit: RDL designer (data source + dataset query, tablix layout, expressions);
  export buttons.
- Backend: export via Azure Functions render (ReportLab / Apache POI).
- Acceptance: author a tablix report, export to PDF + Excel + Word — all open
  correctly. Honest-gate if export Function not deployed. Receipt = three files.

### Phase F — Dashboards + scorecards (T20–T22)

**T20 — Dashboard tiles (pin / Q&A / streaming)**
- Edit: `phase3-editors.tsx` DashboardEditor → pin tile from a report visual or
  a model DAX query; Q&A tile (Copilot edge → DAX); streaming tile (EH/ADX
  query); grid layout, drill, fullscreen, mobile layout.
- Backend: `app/api/items/dashboard/[id]/route.ts` (def in Cosmos) +
  `.../tile-query/route.ts` (DAX/Kusto run).
- Acceptance: pin a visual + add a Q&A tile + add a streaming tile → all render
  real data; layout persists to Cosmos. Receipt attached.

**T21 — Scorecard goals + connected metrics + check-ins**
- Edit: `phase3-editors.tsx` ScorecardEditor → goals grid (current/target/status/
  owner/due), connected-metric binder (model DAX query → current value), sub-
  goals, check-in flyout (note + value + status).
- Backend: `app/api/items/scorecard/[id]/route.ts` (Cosmos) +
  `.../metric-value/route.ts` (runs the bound DAX via `aas-client`).
- Acceptance: a connected metric pulls a live value from AAS; a check-in is
  recorded with history. Receipt attached.

**T22 — Scorecard rollups + status rules**
- Edit: rollup config (sum/avg/worst-child) + status-rule builder (threshold →
  status color/icon).
- Backend: scorecard route computes rollups + applies rules.
- Acceptance: parent goal rolls up from children; status colors per real values.
  Receipt = screenshot + computed values.

### Phase G — Datamart migration + ALM + Git (T23–T25)

**T23 — Datamart migration assistant (deprecated)**
- Goal: no new datamarts; provide a migration path + honest "deprecated" banner.
- Create: `app/api/items/datamart/migrate/route.ts` → reads a datamart def and
  provisions a Synapse Serverless DB + AAS model equivalent.
- Edit: any datamart entry shows a Fluent `MessageBar intent="warning"`:
  "Datamarts are deprecated. Migrate to a Synapse Serverless warehouse + semantic
  model." with a "Migrate" button.
- Acceptance: migrate a sample datamart → a working Synapse Serverless DB + AAS
  model; original surfaced as deprecated, no create path. Receipt attached.

**T24 — Deployment pipelines (stages / compare / selective deploy / rules)**
- Edit: `app/api/deployment-pipelines/**` + a `/deployment-pipelines` page:
  Dev/Test/Prod stage cards; compare = diff over serialized item defs (TMSL /
  report JSON / RDL / scorecard JSON); selective deploy = re-provision chosen
  items into the next stage; deployment-rules editor (per-stage parameter / data-
  source overrides).
- Backend: serialize/diff/deploy through existing provisioners +
  `cosmos-client`.
- Acceptance: change a model in Dev → compare shows the diff → selective deploy
  to Test re-provisions it with the Test data-source rule applied. Receipt = diff
  + deployed item ids.

**T25 — Git integration (commit / pull / sync)**
- Create: `apps/fiab-console/lib/azure/git-integration-client.ts` — serialize
  each item to canonical text (TMSL / report JSON / RDL / scorecard JSON);
  commit/pull/sync against Azure DevOps Repos or GitHub.
- Edit: workspace "Source control" panel: connect repo, branch, status (changed
  items), commit, update, resolve conflicts.
- Backend: `app/api/git-integration/**` routes; secrets in KV.
- Acceptance: connect a real repo → commit a model change → it appears in the
  repo; pull a change → it applies to the Loom item. Honest-gate if no repo
  configured. Receipt = commit SHA + applied diff.

### Phase H — Cross-cutting (T26–T28)

**T26 — Cloud-endpoint + RBAC sweep**
- Goal: every new client/route uses `cloud-endpoints` (AAS/Synapse SQL/Cosmos/
  ARM/DFS/KV/Kusto suffixes); every new Azure dependency has a bicep role
  assignment and a cloud-matrix unit test.
- Acceptance: grep finds zero hard-coded `asazure.windows.net` /
  `sql.azuresynapse.net` / `database.windows.net` / `documents.azure.com` /
  `management.azure.com` outside `cloud-endpoints`; cloud-matrix tests pass for
  Commercial + GCC + GCC-High. **Also**: the no-fabric greps return zero hits on
  default paths (`api.fabric.microsoft.com` / `api.powerbi.com` /
  `onelake.dfs.fabric` only inside `LOOM_BI_BACKEND=powerbi`/`=fabric` branches).

**T27 — Bicep + env sync**
- Goal: new `aas.bicep` (AAS Standard server + MI admin), MI role assignments
  (Storage Blob Data Reader for Direct-Lake-shim, Synapse SQL roles for DQ,
  Cosmos data-contributor for item store); add BI env vars
  (`LOOM_AAS_SERVER_NAME`, `LOOM_DIRECT_LAKE_SHIM_ENABLED`,
  `LOOM_DQ_SOURCE_CONNECTION_STRING`, `LOOM_BI_BACKEND`, render-Function name)
  to `admin-plane/main.bicep` apps env list.
- Acceptance: `az deployment sub create -f platform/fiab/bicep/main.bicep
  -p params/commercial-full.bicepparam` + bootstrap produces a working BI stack
  (AAS + ADLS + Synapse + Cosmos + roles); bicep diff in PR.

**T28 — Per-surface parity docs**
- Goal: refresh `docs/fiab/parity/{semantic-model,report,paginated-report,
  scorecard,dashboard,deployment-pipelines,powerbi-workspace}.md` + add
  `direct-lake.md`, each with source-UI inventory, Loom coverage (✅/⚠️/❌), and
  backend-per-control table; update `docs/fiab/workloads/direct-lake-parity.md`
  to remove the v1 roadmap banner once T4–T6 land.
- Acceptance: zero ❌ rows and zero stub banners at experience close.

---

## 5. Claude Code DEV-LOOP per task

Run this loop for **each** numbered task until acceptance criteria pass. Use
worktree isolation (`worktree-feature`) so parallel tasks don't corrupt
`node_modules` (per the pnpm-worktree gotcha).

1. **Coding agent**
   - Read the task row + the referenced files; inventory the real Power BI /
     Fabric UI first via `microsoft_docs_search` / `microsoft_docs_fetch` (and
     the existing parity docs listed in §4).
   - Implement the BFF route(s) (real backend call, `{ok,data,error}`, correct
     status), the editor surface (Fluent v9 + Loom tokens; only DAX/M Monaco
     editors are allowed freeform), and any bicep/env/RBAC changes.
   - Forbidden: `return []`, `return {}`, `useState(MOCK…)`, dead buttons,
     hard-coded SKUs/hosts, default-path Fabric/Power BI gate, reading
     `fabricWorkspaceId`/`powerBiWorkspaceId` without an AAS/Azure fallback in
     the same function.

2. **Validation / test agent**
   - `pnpm -C apps/fiab-console tsc --noEmit` (zero errors).
   - `pnpm -C apps/fiab-console vitest run <area>` (unit tests for client + route,
     including a cloud-matrix test for any new endpoint suffix). For shim work,
     `dotnet test apps/fiab-direct-lake-shim`.
   - **Real-data E2E:** mint a session cookie; hit the new route(s); confirm a
     real Azure response (AAS refresh id / TMSL apply result, Synapse query rows,
     ADLS Delta listing, Cosmos doc, ARM resource id, Git commit SHA, or an
     honest-gate MessageBar). Capture first 300 chars of the body.
   - Run the grep guards:
     `grep -rE "(return \[\]|return \{\}|useState\(\[\{|MOCK_|SAMPLE_)" apps/fiab-console/lib/editors apps/fiab-console/app/api`
     and the no-fabric-dependency greps
     (`grep -rn "api.fabric.microsoft.com\|api.powerbi.com\|onelake.dfs.fabric\|fabricWorkspaceId\|powerBiWorkspaceId"`).
     Any hit on a default (non-opt-in) path → back to step 1.

3. **Docs agent**
   - Update the per-surface parity doc (T28) row(s) to ✅/⚠️ with the backend it
     calls; update `docs/fiab/workloads/direct-lake-parity.md` and any user docs
     (docs = source of truth). No clarifying-questions/side-convo content in
     product or docs.

4. **UAT agent**
   - Live browser walk (Playwright / claude-in-chrome): with
     `LOOM_DEFAULT_FABRIC_WORKSPACE` and any Power BI backend UNSET, open the
     surface, click **every** control the task added, confirm it performs the
     real operation (DOM strings ≠ parity). Side-by-side against the real Power
     BI / Fabric UI for the row. Screenshot + trace.
   - If any control is dead, empty, or only works with Fabric / Power BI bound →
     fail, return to step 1.

5. **Iterate** until: tsc clean, vitest (+ dotnet for shim) green, real-data E2E
   receipt captured, grep guards clean, parity doc updated, UAT walk passes. Then
   open the PR with the receipt (endpoint hit + real response body + screenshot/
   trace + bicep diff). Reviewer rejects any PR missing the receipt.

---

## 6. Definition of done (whole experience)

The Power BI / BI experience is **done** when, with a real Microsoft Fabric
capacity / Power BI workspace **UNSET** (`LOOM_DEFAULT_FABRIC_WORKSPACE` unset,
`LOOM_BI_BACKEND` unset/`aas`):

1. **Every row 1–48 is ✅ built or ⚠️ honest-gate** — zero 🟡 partials left as
   partial, zero ❌ missing, zero dead buttons, zero empty tabs.
2. **No default-path Fabric/Power BI dependency** — the no-fabric-dependency
   greps return zero hits outside explicit `LOOM_BI_BACKEND=powerbi`/`=fabric`
   opt-in branches; no calls to `api.fabric.microsoft.com` / `api.powerbi.com` /
   `onelake.dfs.fabric` on the default path; no `fabricWorkspaceId` /
   `powerBiWorkspaceId` read without an AAS/Azure fallback in the same function.
3. **No vaporware** — the vaporware greps (`return []`, `return {}`,
   `useState([{`, `MOCK_`, `SAMPLE_`) return zero hits in
   `apps/fiab-console/lib/editors` + `apps/fiab-console/app/api`; every honest
   gate is a Fluent MessageBar naming the exact env var / role / resource.
4. **Real backends verified** — each surface has a real-data E2E receipt: AAS
   refresh + TMSL apply, DirectQuery rows from Synapse/SQL/ADX, Direct-Lake-shim
   warm-cache + Serverless fallback, incremental/hybrid partitions, RLS/OLS test-
   as-role, report/dashboard/scorecard rendering real values, paginated export,
   deployment-pipeline diff+deploy, Git commit.
5. **Cloud portability** — all hosts resolve via `cloud-endpoints`; cloud-matrix
   unit tests pass for Commercial + GCC + GCC-High; SKU/region pickers filter via
   `ListSkus` at runtime; AAS IL5 caveat documented with the Synapse-Serverless
   substitution path.
6. **Bicep-synced** — `az deployment sub create -f platform/fiab/bicep/main.bicep
   -p params/commercial-full.bicepparam` + bootstrap produces a working BI stack
   (AAS + ADLS + Synapse + Cosmos) with every role grant and env var; bicep diff
   merged.
7. **Parity docs complete** — `docs/fiab/parity/*` for every BI surface show
   every inventory row ✅ or ⚠️, zero ❌, zero stub banners; the Direct Lake v1
   roadmap banner is removed.
8. **UAT green** — `pnpm uat` BI specs pass + a live side-by-side click-every-
   control walk confirms one-for-one behavior with the Power BI / Fabric UI.

Target grade: **A or A+** for every surface (production-grade + tested +
documented + bicep-synced) before the next major release.
