# UX Baseline Program — Every Loom Surface to Fabric Grade

> **Goal:** Bring **every CSA Loom UX surface** up to (or past) the live
> Microsoft Fabric baseline captured on 2026-07-09 — not just the 1:1-with-Fabric
> item editors, but *every* canvas, designer, wizard, explorer, hub, dialog, and
> admin page. Fabric is the baseline for **visual quality, functionality, and
> usability**; per the standing operator directive every Loom UX must **meet or
> exceed that grade**. Every backend named here is Azure-native or OSS-on-Azure,
> **bicep-synced**, works day-one in Azure Commercial **and** Azure Government,
> and carries **no hard Microsoft Fabric / Power BI dependency** (Fabric backends
> stay opt-in only, per `no-fabric-dependency.md`).
>
> Author: Loom UX-Baseline Program Architect · Date: 2026-07-09 · Status: **proposed**
>
> **Sources folded in:** the live Fabric UX capture
> `scratchpad/fabric-ux-observations.md` (the authoritative baseline — docked
> validating inspectors with red-dot tabs, ghost next-step nodes, draft/publish
> separation, type-badged live preview docks, entity/schema diagrams, right
> details panels with copyable URIs, guided multi-path empty states, categorized
> pickers, item-tab-strips + cross-surface toolbar links, command search,
> per-surface Copilot); the **authoritative surface inventory** (≈170 Loom
> surface rows graded A/B/C by *reading the merged code*, not names); the die-hard
> rules `no-vaporware.md`, `no-fabric-dependency.md`, `ui-parity.md`,
> `loom_no_freeform_config`, `loom_design_standards`; and the sibling
> `PRP-surface-max-enhancements.md` (the canvas *power* layer — undo/redo,
> co-authoring, new item types — which this PRP deliberately does **not**
> duplicate; it consumes that layer's shared kit).

---

## 1. Executive summary

I graded **≈170 Loom UX surface rows** against the live Fabric baseline by
reading the actually-merged code — every canvas-node file, editor shell, preview
dock, empty-state, properties panel, hub page, and admin page — with file-level
evidence, not by trusting names. The honest result is good news and a clear map.

**The just-merged node-kit v2 + pipeline (#1768) + eventstream (#1765) work is
genuinely A-grade and is now the best UX in the product** — colored
category-accent node headers, an inline node action bar, typed ports, a ghost
next-step node, a docked bottom inspector with **red validation-dot tabs**, a
real 4-path + Ask-Copilot guided empty-state launcher, and (eventstream) a docked
live **type-badged Data-preview / Authoring-errors** dock with draft/publish
separation. In spots this now **exceeds** Fabric (per-type glyph richness,
elevation/motion). These are the first true "A" surfaces this program has seen —
and they prove the whole baseline is achievable on Azure-native backends.

**Everything else clusters at two grades, with no true D/vaporware found** — the
no-vaporware enforcement over the past several waves has held. The gaps are
**UX-richness gaps versus Fabric, not stubs**:

- **≈73 B-grade surfaces.** Real Azure backends, honest MessageBar infra-gates,
  often very deep (2,000–5,000-line editors: lakehouse, eventhouse, semantic
  model, warehouse, unified-SQL, APIM, foundry, databricks). What they miss are
  the **specific cross-cutting bar items** the baseline calls out: no
  entity/schema **relationship-diagram** canvas (semantic-model, lakehouse,
  eventhouse, warehouse, unified-SQL all lack it); no right-side **details panel**
  with copyable Query-URI / MCP-URI + inline-editable policies; no **item-level
  tab-strip** cross-linking sibling RTI/ADF surfaces from the toolbar; no
  **closeable per-table preview tabs** with a timing status bar; no **command
  search**.
- **≈93 C-grade surfaces.** Thin single/dual-purpose navigator editors
  (linked-service, integration-runtime, the messaging namespaces, copy-job,
  airflow-job, event-schema-set, lakehouse-shortcut) and most admin/governance
  pages — functional real-REST CRUD with plain chrome, **no Copilot, no guided
  empty state, no diagram, no teaching UI**.

**The strategic bet: SHARED-FIRST.** The same ten missing bar items recur across
dozens of surfaces. Building them once as **ten shared components** — then
adopting them surface-by-surface — lifts the entire product far faster than
hand-crafting 166 editors. The A-grade node-kit already proves the pattern: it is
one shared file that made pipeline, mapping-dataflow, and eventstream A-grade at
once. This PRP extends that model to every remaining baseline bar item: a shared
**EntityDiagram**, **DetailsPanel**, **DockedInspector** (validation-dot
contract), **GuidedEmptyState**, **PreviewTable** (type badges + timing bar),
**TeachingToast**, **ExplorerTree** (context menu), **ItemTabStrip +
ToolbarCrossLinks**, **CommandSearch**, and the **node-kit v2 adoption kit**.

**Program shape.** UX-Wave 0 builds the shared library and runs the Fabric
**capture round 2** (seven un-captured Fabric surfaces the baseline doc flags).
UX-Waves 1–10 take the **93 C-grade surfaces** to baseline in subsystem-clustered
build waves. UX-Waves 11–13 run a lighter **adopt-shared sweep** over the 73
B-grade surfaces to add the specific missing bar items. The 5 A-grade surfaces
are codified as **reference exemplars** in the shared kit's docs so new surfaces
inherit the bar by default. Every item's acceptance is the **no-scaffold
standard**: a real-backend screenshot **and** a physical click-walk (DOM strings
≠ parity), with `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset**.

---

## 2. The baseline bar (derived from the live capture)

Every Loom surface is graded against this cross-cutting bar (from
`fabric-ux-observations.md` §§1–5, 40–52, 57). A surface is **A** when it meets or
exceeds every applicable row, **B** when the backend is real but ≥1 bar item is
missing, **C** when it is functional-but-plain (multiple bar items missing + no
teaching UI).

| # | Bar item | Fabric evidence | Shared component that delivers it |
|---|----------|-----------------|-----------------------------------|
| 1 | Rich node anatomy (colored header, inline action bar, typed ports, inline status) | Pipeline/eventstream nodes | **SC-1** node-kit v2 (built) |
| 2 | Ghost next-step node scaffolds the flow | Eventstream source→stream→ghost | **SC-1** (`GhostNextStepNode`, built) |
| 3 | Draft/publish separation + Undo/Redo | Eventstream Edit-mode banner | **SC-1** + power layer (`use-canvas-history`, built) |
| 4 | Docked bottom inspector with **red validation-dot tabs**, required-asterisks, Learn-more | Pipeline General/Source/… tabs | **SC-3** DockedInspector |
| 5 | Live **type-badged** data-preview dock + timing status bar | Eventstream Data-preview; Lakehouse "Succeeded (3s)·Cols·Rows" | **SC-5** PreviewTable |
| 6 | Guided empty state = multi-path launcher cards + Ask-Copilot | Pipeline 4-path; Eventstream 3-card | **SC-4** GuidedEmptyState |
| 7 | Categorized pickers with per-item icons + New badges | Activity/Transform menus | **SC-1** (category accents) |
| 8 | **Entity/schema relationship-diagram** view (Overview ⇄ Entity-diagram toggle) | Eventhouse, Lakehouse, Semantic model | **SC-10** EntityDiagram |
| 9 | Right **details panel**: copyable Query-URI / **MCP-URI** / conn-string + inline-edit policy pencils + Related-elements find-by-name | Eventhouse Database details | **SC-2** DetailsPanel |
| 10 | **Item-tab-strip** (Eventhouse\|Database) + **toolbar cross-links** to sibling surfaces | Eventhouse RTI toolbar | **SC-8** ItemTabStrip + ToolbarCrossLinks |
| 11 | **Command search** (Ctrl+Q / Alt+Q) in the ribbon | Dataflow Gen2 "Search (Alt+Q)" | **SC-9** CommandSearch |
| 12 | Teaching toasts/banners ("Analyze your data — notebook / SQL endpoint / eventhouse") | Lakehouse | **SC-6** TeachingToast |
| 13 | Typed-icon **explorer tree** with right-click context menu | ADF Factory Resources; Lakehouse Explorer; KQL tree | **SC-7** ExplorerTree |
| 14 | Per-surface **Copilot** entry | Every Fabric designer | **SC-1** Copilot bubble slot + existing `<CopilotBuilderPane>` |

---

## 3. Shared-first plan (SC-1 … SC-10) — build once, adopt everywhere

These ten components are UX-Wave 0. Each names its **target file** and the
**graded surfaces that consume it**. All are Fluent v9 + Loom tokens, theme-aware,
and reuse the existing canvas kit where one exists. None introduces a Fabric
dependency; each reads the item's **real** Azure backend schema/data.

### SC-1 — Canvas node-kit v2 adoption kit *(extend the A-grade kit)* — **P0 · M**
**Exists:** `apps/fiab-console/lib/components/canvas/canvas-node-kit.tsx` (+
`use-canvas-history.ts`, `canvas-clipboard.ts`, `canvas-align.ts`,
`canvas-power-toolbar.tsx`, `canvas-command-registry.ts`, `canvas-shortcut-dialog.tsx`).
**Work:** adopt the kit (colored-header nodes, inline action bar, typed ports,
`GhostNextStepNode`, right-rail, Copilot bubble slot, power toolbar) on the
canvases that still hand-roll nodes. **Consumers:** plan-editor,
phase4/ontology-editor (object/link model), phase4/graph-model-editor (schema
authoring), copilot-topic-canvas, airflow-job DAG view, foundry prompt-flow,
digital-twin graph, tapestry link-analysis canvas, databricks job task-graph,
mapping-dataflow (verify), workshop/slate builders. **No backend/bicep.**

### SC-2 — `<DetailsPanel>` (right item-details panel) — **P0 · M**
**New:** `apps/fiab-console/lib/components/shared/details-panel.tsx`. Right-docked
panel with: size/stat rows; **copyable URI rows** (Query URI, **MCP Server URI**,
connection string, OneLake path) with Copy buttons; **inline-editable policy
rows** (caching/retention/OneLake-availability — pencil → edit → PATCH real
backend); Related-elements list with find-by-name. **Consumers:** eventhouse,
kql-database, warehouse, unified-sql-database, cosmos-account, azure-sql-editors,
lakehouse, semantic-model, mirrored-database, ADX/kusto. **Backend:** real
data-plane reads + the item's existing policy PATCH routes.

### SC-3 — `<DockedInspector>` (validation-dot tab contract) — **P0 · M**
**New:** `apps/fiab-console/lib/components/shared/docked-inspector.tsx`,
generalizing `lib/components/pipeline/properties-panel.tsx`. Bottom-docked tabbed
inspector; each tab takes a `validationState` → **red superscript dot** when
required config is missing (errors visible pre-run); required-field asterisks;
per-field Learn-more slots. **Consumers:** mapping-dataflow, graph-model, plan,
ontology, activator, copilot-topic, databricks pipeline/job, foundry prompt-flow,
stream-analytics (input→query→output). Eventstream/pipeline already embody the
contract — refactor them onto the shared component to lock it as the reference.

### SC-4 — `<GuidedEmptyState>` (multi-path launcher cards) — **P0 · S**
**New:** `apps/fiab-console/lib/components/shared/guided-empty-state.tsx`,
generalizing `lib/components/pipeline/guided-empty-state.tsx` to an N-path
launcher (icon cards + **Ask Copilot** + **Learn more**). **Consumers:** every C
surface lacking a guided empty state — dataflow-gen2 (import cards), lakehouse
(empty DB "Get data"), eventhouse empty DB, notebook, all Wave-1 navigators,
foundry-playground, data-marketplace, connections, thread, the hubs.

### SC-5 — `<PreviewTable>` (type badges + timing status bar) — **P0 · M**
**New:** `apps/fiab-console/lib/components/shared/preview-table.tsx`,
generalizing `lib/components/eventstream/data-preview-dock.tsx`. Type-badged
column headers (Abc / 123 / latlong / bool / Json icons), row grid, **"Succeeded
(Xs) · Columns N · Rows N"** status bar, time-range picker + Refresh, search,
**closeable per-source tabs**. **Consumers:** lakehouse tables, warehouse,
kql-database, synapse-serverless-sql, unified-sql, cosmos, ai-enrichment sample
preview, copy-job preview, dataflow preview, geo dataset.

### SC-6 — `useTeachingToast` / `<TeachingBanner>` — **P1 · S**
**New:** `apps/fiab-console/lib/components/shared/teaching-toast.tsx`. Dismissible
teaching toast + info banner keyed per surface ("Analyze your data — explore in a
notebook, SQL analytics endpoint, or eventhouse endpoint") with localStorage
dismiss + a Learn-more link. **Consumers:** lakehouse, eventhouse, notebook,
warehouse, and every hub/launcher page.

### SC-7 — `<ExplorerTree>` (typed icons + context menu) — **P1 · M**
**New:** `apps/fiab-console/lib/components/shared/explorer-tree.tsx`, lifting the
right-click context-menu + typed-icon model out of
`lib/components/pipeline/factory-resources-tree.tsx`. **Consumers:**
synapse-workspace-tree, catalog/tree-browser, foundry AI-Search index tree,
lakehouse Explorer, cosmos container explorer, KQL left tree (System overview /
Databases / Monitoring). **Backend:** each tree's existing REST list calls.

### SC-8 — `<ItemTabStrip>` + `<ToolbarCrossLinks>` — **P1 · M**
**New:** `apps/fiab-console/lib/components/shared/item-tab-strip.tsx`. An
item-level tab strip (e.g. **Eventhouse | Database**, **Home | Materialized lake
views**) + a toolbar cross-link group linking sibling surfaces (Live view / Query
with code / Notebook / Real-Time Dashboard / Data Agent / Operations Agent /
OneLake). **Consumers:** eventhouse/kql-database, lakehouse, the RTI family,
warehouse ⇄ sql-analytics-endpoint, workspace items. **Routing only** — links to
existing routes.

### SC-9 — `<CommandSearch>` (Ctrl+Q / Alt+Q) — **P1 · S**
**New:** `apps/fiab-console/lib/components/shared/command-search.tsx`, built on
`lib/components/canvas/canvas-command-registry.ts`. A ribbon/title-bar command
search that surfaces every registered surface action. **Consumers:** every editor
ribbon (pipeline Ctrl+Q, dataflow-gen2 Alt+Q, notebook, report, warehouse). Reuses
the existing command palette; adds the visible in-ribbon search box + per-surface
registration.

### SC-10 — `<EntityDiagram>` (schema / relationship-diagram canvas) — **P0 · L**
**New:** `apps/fiab-console/lib/components/shared/entity-diagram.tsx`, built on
the node-kit. Renders tables as nodes with column lists + **typed join/relationship
lines**, an **Overview ⇄ Entity-diagram toggle**, auto-layout (ELK), and select-to-
inspect. **This is the single biggest recurring parity gap in the inventory.**
**Backend:** reads the item's **real** schema — Delta (lakehouse), TDS
(warehouse/unified-SQL), ADX `.show database schema` (eventhouse/kql-database),
TMSL relationships (semantic-model), CDC map (mirrored-database). **Consumers:**
semantic-model (the signature relationship canvas), lakehouse (entity diagram),
eventhouse/kql-database (entity diagram), warehouse (ER), unified-sql-database
(ER), cosmos, mirrored-database (source→CDC→Delta topology).

**SC target-file summary + reach**

| SC | New/extend file | # graded surfaces it lifts |
|----|-----------------|----------------------------|
| SC-1 node-kit v2 adoption | extend `components/canvas/canvas-node-kit.tsx` | ~12 canvases |
| SC-2 DetailsPanel | `components/shared/details-panel.tsx` | ~10 data items |
| SC-3 DockedInspector | `components/shared/docked-inspector.tsx` | ~10 canvases |
| SC-4 GuidedEmptyState | `components/shared/guided-empty-state.tsx` | ~30 surfaces |
| SC-5 PreviewTable | `components/shared/preview-table.tsx` | ~10 data items |
| SC-6 TeachingToast | `components/shared/teaching-toast.tsx` | ~15 surfaces |
| SC-7 ExplorerTree | `components/shared/explorer-tree.tsx` | ~7 trees |
| SC-8 ItemTabStrip/CrossLinks | `components/shared/item-tab-strip.tsx` | ~8 items |
| SC-9 CommandSearch | `components/shared/command-search.tsx` | every ribbon |
| SC-10 EntityDiagram | `components/shared/entity-diagram.tsx` | ~8 data items |

**CAP-R2 — Fabric capture round 2 (prerequisite task).** The baseline doc §53
flags seven **un-captured** Fabric surfaces. Their live walks are required before
the *final grading* of the Loom counterparts below. Owner: orchestrator/browser;
output: extend `scratchpad/fabric-ux-observations.md` with a PART 3.
- **Real-Time Dashboard** → blocks kql-dashboard final grade (UX-Wave 11).
- **Report editor** → confirms report-designer A-reference gaps (Analyze-in-Excel / export ribbon).
- **Semantic model view** → grounds SC-10 relationship-canvas parity (UX-Wave 11).
- **KQL Queryset** → blocks kql-queryset (UX-Wave 2).
- **Copy job** → blocks copy-job run-history gantt (UX-Wave 1).
- **Map** → blocks map-editor toolset (UX-Wave 5).
- **Task flows** → grounds the workspace task-flows band (informs UX-Wave 13 workspaces-list).

---

## 4. Program waves at a glance

| UX-Wave | Theme | Surfaces | Grade focus |
|---------|-------|----------|-------------|
| **U0** | Shared foundation (SC-1…10) + CAP-R2 | 11 items | Build the bar once |
| **U1** | Data-integration navigators | 9 | C → B/A |
| **U2** | Streaming, messaging & RTI thin surfaces | 6 | C → B/A |
| **U3** | Databases & migration tail | 4 | C → B/A |
| **U4** | AI / Foundry / Copilot tail | 9 | C → B/A |
| **U5** | Apps, Palantir & compute tail | 10 | C → B/A |
| **U6** | Governance pages | 9 | C → B/A |
| **U7** | Catalog, marketplace & data-product tail | 10 | C → B/A |
| **U8** | Admin: identity, security & platform | 10 | C → B/A |
| **U9** | Admin: data-governance, labeling & ops | 12 | C → B/A |
| **U10** | Hubs, launchers & shell pages | 14 | C → B/A |
| **U11** | B-sweep: canvases, RTI & modeling editors | 18 | B → A |
| **U12** | B-sweep: SQL / data / ML / Foundry / Palantir / apps | 27 | B → A |
| **U13** | B-sweep: catalog / marketplace / monitor / admin / hub pages | 27 | B → A |

**Totals:** **14 UX waves**, **181 work items** = 10 shared components + 1 capture
task + **170 per-surface items** (5 A-grade codified as reference, 72 B-grade
adopt-shared, 93 C-grade build).

**Standard acceptance (applies to every per-surface item — no-scaffold rule).**
With `LOOM_DEFAULT_FABRIC_WORKSPACE` **unset**, in a deployed console: (1) a
real-backend screenshot of the upgraded surface (the shared bar items rendered
with real data), and (2) a **physical** Playwright click-walk that exercises the
adopted controls end-to-end against the real Azure backend (open the guided empty
state → create/inspect → copy a URI → toggle a policy → preview real rows →
cross-link to a sibling), plus a per-surface parity note at
`docs/fiab/parity/<slug>.md` showing every bar row built ✅ or honest-gate ⚠️.
DOM presence alone fails the gate.

---

## 5. C-grade build waves (U1 … U10)

Each surface below is a work item. Columns: **file** (repo-relative under
`apps/fiab-console/`), **top gaps** (from the inventory), **adopts** (the shared
components that close them). Acceptance is the standard no-scaffold receipt above.

### UX-Wave 1 — Data-integration navigators  *(C cluster; ADF/Synapse sibling context)*
Thin real-REST wrappers with plain chrome, no Copilot/empty-state/diagram.

| ID | Surface | file (`lib/editors/…`) | Top gaps | Adopts |
|----|---------|------------------------|----------|--------|
| UX-101 | Linked service | `linked-service-editor.tsx` | No icon-rich connector gallery, plain wrapper | SC-4, SC-7, SC-9 |
| UX-102 | Integration runtime | `integration-runtime-editor.tsx` | Minimal chrome | SC-4, SC-2 (IR details/keys) |
| UX-103 | Copy job | `copy-job-editor.tsx` | No run-history gantt/throughput chart (needs CAP-R2) | SC-4, SC-5 (preview), SC-8 |
| UX-104 | Airflow job (DAG) | `airflow-job-editor.tsx` | No DAG graph canvas (Airflow is graph-first) | **SC-1**, SC-3 |
| UX-105 | Spark job definition | `spark-job-definition-editor.tsx` | No live Spark-UI (stages/executors) embed | SC-4, SC-5, SC-8 |
| UX-106 | Spark environment | `spark-environment-editor.tsx` | Config-only, plain | SC-4, SC-6 |
| UX-107 | Environment / dbt job | `phase2-misc-editors.tsx` | No dbt DAG/lineage graph | **SC-1**, SC-4 |
| UX-108 | Event schema set | `event-schema-set-editor.tsx` | No schema-registry compatibility diagram | SC-10, SC-4 |
| UX-109 | SQL analytics endpoint | `sql-analytics-endpoint-editor.tsx` | Read-only reuse, plain | SC-5, SC-7, SC-8, SC-10 |

### UX-Wave 2 — Streaming, messaging & RTI thin surfaces  *(C cluster)*

| ID | Surface | file (`lib/editors/…`) | Top gaps | Adopts |
|----|---------|------------------------|----------|--------|
| UX-201 | Lakehouse shortcut | `lakehouse-shortcut-editor.tsx` | No shortcut-target diagram, no Copilot | SC-4, SC-10 (target), SC-1 |
| UX-202 | KQL queryset | `phase3/kql-queryset-editor.tsx` | Plain query surface, thin Copilot (needs CAP-R2) | SC-5, SC-4, SC-8, Copilot |
| UX-203 | Stream Analytics job | `stream-analytics-editor.tsx` | No input→query→output streaming diagram | **SC-1**, SC-3, SC-5 |
| UX-204 | Event Hubs namespace | `event-hubs-namespace-editor.tsx` | Thin, no throughput/consumer-group visual | SC-4, SC-2, SC-5 |
| UX-205 | Service Bus namespace | `service-bus-namespace-editor.tsx` | Queue/topic list + metrics, plain | SC-4, SC-2, SC-7 |
| UX-206 | Event Grid topic | `event-grid-topic-editor.tsx` | Subscription list, no event-schema preview | SC-4, SC-5 |

### UX-Wave 3 — Databases & migration tail  *(C cluster; small wave)*

| ID | Surface | file (`lib/editors/…`) | Top gaps | Adopts |
|----|---------|------------------------|----------|--------|
| UX-301 | Lakebase (serverless PG) | `lakebase-editor.tsx` | No Copilot/diagram; branching/snapshot plain | SC-10, SC-2, SC-4, SC-5 |
| UX-302 | Cosmos DB account | `cosmos-account-editor.tsx` | No rich data-explorer canvas; tree+table only | SC-7, SC-5, SC-2, SC-4 |
| UX-303 | Datamart (deprecated) | `phase3/datamart-editor.tsx` | Intentionally thin; add honest guidance UI only | SC-4, SC-6 (migration banner) |
| UX-304 | SQL migration wizard | `sql-migration-wizard.tsx` | No assessment-report visualization | SC-5 (assessment grid), SC-4 |

### UX-Wave 4 — AI / Foundry / Copilot tail  *(C cluster)*

| ID | Surface | file (`lib/editors/…`) | Top gaps | Adopts |
|----|---------|------------------------|----------|--------|
| UX-401 | Foundry playground | `foundry-playground.tsx` | No sys-message / param sliders / comparison view; no Copilot signal | SC-4, SC-5, Copilot |
| UX-402 | AI Search index tree | `foundry-sub-editors.tsx` | Table-based, no typed schema tree | SC-7, SC-10, SC-5 |
| UX-403 | AI enrichment (AI fns) | `ai-enrichment-editor.tsx` | No live sample-row preview before batch | SC-5 (preview), SC-4 |
| UX-404 | AutoML | `automl-editor.tsx` | No leaderboard visualization | SC-5, SC-4 |
| UX-405 | Operations Agent | `phase4/operations-agent-editor.tsx` | No chat/rule canvas (see G3) | **SC-1** (rule canvas), SC-3, Copilot |
| UX-406 | Copilot topic canvas | `copilot-topic-canvas.tsx` | 356 lines — too thin for node-based topic authoring | **SC-1**, SC-3, SC-4 |
| UX-407 | GraphQL API | `phase4/graphql-api-editor.tsx` | No schema explorer / query playground | SC-7 (schema tree), SC-5 (playground) |
| UX-408 | User Data Function | `phase4/user-data-function-editor.tsx` | No inline test-invoke UI | SC-5 (invoke result), SC-4 |
| UX-409 | Variable library | `phase4/variable-library-editor.tsx` | No grouped variable-sets UI | SC-4, SC-7 |

### UX-Wave 5 — Apps, Palantir & compute tail  *(C cluster)*

| ID | Surface | file (`lib/editors/…`) | Top gaps | Adopts |
|----|---------|------------------------|----------|--------|
| UX-501 | Loom App | `loom-app-editor.tsx` | No app-builder canvas | **SC-1**, SC-4 |
| UX-502 | Loom App Runtime | `loom-app-runtime-editor.tsx` | Plain deploy/config form | SC-4, SC-5 (logs), SC-8 |
| UX-503 | Rayfin app | `rayfin-app-editor.tsx` | No Copilot/diagram | SC-4, **SC-1** |
| UX-504 | Logic App (Consumption) | `logic-app-editor.tsx` | 504 lines — needs a real WDL trigger/action visual designer | **SC-1**, SC-3, SC-4 |
| UX-505 | Ontology SDK | `palantir/ontology-sdk-editor.tsx` | Code-gen/config, plain | SC-4, SC-5 |
| UX-506 | AIP Logic | `palantir/aip-logic-editor.tsx` | No visual logic-block canvas; no Copilot | **SC-1**, SC-3, Copilot |
| UX-507 | Health check | `palantir/health-check-editor.tsx` | Rule list/dashboard, plain | SC-4, SC-5 |
| UX-508 | Release environment | `palantir/release-environment-editor.tsx` | No promotion-stage pipeline viz | **SC-1** (stage graph), SC-8 |
| UX-509 | Databricks cluster | `databricks/cluster-editor.tsx` | No live metrics chart | SC-5, SC-2, SC-4 |
| UX-510 | Map | `phase4/map-editor.tsx` | No layered-analysis / drawing tools (needs CAP-R2) | SC-4, SC-8, SC-6 |

### UX-Wave 6 — Governance pages  *(C cluster)*

| ID | Surface | file | Top gaps | Adopts |
|----|---------|------|----------|--------|
| UX-601 | Governance hub | `app/governance/page.tsx` | Card-launcher, not teaching-rich | SC-6, SC-4, SC-9 |
| UX-602 | Data quality | `app/governance/data-quality/page.tsx` | Rule list/results, plain | SC-5, SC-4 |
| UX-603 | MDM | `app/governance/mdm/page.tsx` | No golden-record diagram | SC-10, SC-4 |
| UX-604 | IRM (insider risk) | `app/governance/irm/page.tsx` | Case list/detail, plain | SC-5, SC-4 |
| UX-605 | Glossary | `app/governance/glossary/page.tsx` | No term-relationship graph | SC-10, SC-7 |
| UX-606 | Insights | `app/governance/insights/page.tsx` | Plain vs Purview Insights charting | SC-5, dataviz tiles |
| UX-607 | Workspace egress | `lib/governance/workspace-egress-pane.tsx` | Rule table, plain | SC-3 (rule inspector), SC-4 |
| UX-608 | Protection policies | `lib/governance/protection-policies-pane.tsx` | DLP preset library, plain visuals | SC-4, SC-3 |
| UX-609 | Access requests + inbox | `app/governance/access-requests/page.tsx` + `lib/editors/access-request-inbox.tsx` | Plain queue/approve table | SC-5, SC-6 |

### UX-Wave 7 — Catalog, marketplace & data-product tail  *(C cluster)*

| ID | Surface | file | Top gaps | Adopts |
|----|---------|------|----------|--------|
| UX-701 | Catalog tree browser | `lib/components/catalog/tree-browser.tsx` | No type-icon-rich Purview browse | **SC-7**, SC-5 |
| UX-702 | Catalog permission matrix | `lib/components/catalog/permission-matrix.tsx` | Grid ACL editor, plain | SC-3, SC-4 |
| UX-703 | Data product editors | `lib/editors/data-product-editors.tsx` | Instance editor plain | SC-4, SC-10 (ports) |
| UX-704 | Data product edit dialog | `lib/editors/data-product-edit-dialog.tsx` | Form dialog, no wizard steps | SC-4 (wizard) |
| UX-705 | Data Marketplace (consumer) | `lib/editors/data-marketplace.tsx` | No preview-before-subscribe panel | SC-2, SC-5, SC-4 |
| UX-706 | Share explorer | `lib/components/marketplace/share-explorer.tsx` | List/detail, plain | SC-5, SC-2 |
| UX-707 | My access | `lib/components/marketplace/my-access.tsx` | Simple grant list | SC-4, SC-5 |
| UX-708 | External share panel | `lib/dialogs/external-share-panel.tsx` | Basic list/manage | SC-4, SC-2 |
| UX-709 | Endorsement control | `lib/editors/endorsement-control.tsx` | Simple badge control (adequate — light touch) | SC-6 |
| UX-710 | Synapse workspace tree | `lib/components/pipeline/synapse-workspace-tree.tsx` | Not re-verified; plain tree | **SC-7** |

### UX-Wave 8 — Admin: identity, security & platform  *(C cluster; many thin wrappers)*

| ID | Surface | file (`app/admin/…`) | Top gaps | Adopts |
|----|---------|----------------------|----------|--------|
| UX-801 | Security | `security/page.tsx` | RBAC/security settings, plain | SC-4, SC-6 |
| UX-802 | Permissions | `permissions/page.tsx` | Grant matrix, plain | SC-3, SC-5 |
| UX-803 | Users | `users/page.tsx` | Directory table | SC-5, SC-7 |
| UX-804 | Tenant settings | `tenant-settings/page.tsx` | Settings form, plain | SC-4, SC-9 |
| UX-805 | Developer tokens | `developer/tokens/page.tsx` | 36-line wrapper | SC-4, SC-5 |
| UX-806 | Webhooks | `webhooks/page.tsx` | 34-line wrapper | SC-4, SC-5 |
| UX-807 | API management | `api-management/page.tsx` | Backend config list, plain | SC-5, SC-8 |
| UX-808 | Network | `network/page.tsx` | 21-line wrapper → topology canvas | **SC-1**/topology, SC-4 |
| UX-809 | Health | `health/page.tsx` | 21-line wrapper | SC-5, SC-6 |
| UX-810 | Org visuals | `org-visuals/page.tsx` | 23-line wrapper | SC-4, SC-5 |

### UX-Wave 9 — Admin: data-governance, labeling & ops  *(C cluster)*

| ID | Surface | file (`app/admin/…`) | Top gaps | Adopts |
|----|---------|----------------------|----------|--------|
| UX-901 | Domains | `domains/page.tsx` | Domain/subdomain tree+form, plain | **SC-7**, SC-4 |
| UX-902 | Classifications | `classifications/page.tsx` | No rule-testing preview | SC-5, SC-4 |
| UX-903 | Sensitivity labels | `sensitivity-labels/page.tsx` | Label list/form | SC-4, SC-6 |
| UX-904 | Batch labeling | `batch-labeling/page.tsx` | Bulk-apply form | SC-5, SC-4 |
| UX-905 | Attribute groups | `attribute-groups/page.tsx` | CRUD table | SC-5, SC-4 |
| UX-906 | Audit logs | `audit-logs/page.tsx` | Plain vs Purview Audit filter/export | SC-5, SC-9 |
| UX-907 | Updates | `updates/page.tsx` | Changelog list, plain | SC-4, SC-6 |
| UX-908 | Copilot agents config | `lib/components/admin/copilot-agents-config.tsx` | Config form, plain | SC-4, Copilot |
| UX-909 | Copilot usage | `copilot-usage/page.tsx` | Dashboard tiles, plain charts | SC-5, dataviz |
| UX-910 | Env config | `lib/components/admin/env-config-pane.tsx` | Key/value form | SC-4, SC-9 |
| UX-911 | Usage | `usage/page.tsx` | Usage tables, plain | SC-5, dataviz |
| UX-912 | Deploy planner | `deploy-planner/page.tsx` | 23-line wrapper (verify underlying) | SC-4, **SC-1**/topology |

### UX-Wave 10 — Hubs, launchers & shell pages  *(C cluster; the "front door")*

| ID | Surface | file (`app/…`) | Top gaps | Adopts |
|----|---------|----------------|----------|--------|
| UX-1001 | Scheduler | `scheduler/page.tsx` | No calendar view / trigger-wizard integration | SC-4, SC-5, SC-8 |
| UX-1002 | Thread | `thread/page.tsx` | Launcher/list, not a rich workspace | SC-4, SC-6, **SC-1** |
| UX-1003 | Workspace detail | `workspaces/[id]/page.tsx` | Thin detail wrapper | SC-8, SC-6, SC-7 |
| UX-1004 | Items generic shell | `items/[type]/[id]/page.tsx` | Fallback chrome — raise the floor | SC-4, SC-8, SC-6 |
| UX-1005 | Item permissions | `items/[type]/[id]/permissions/page.tsx` | Grant list/form | SC-3, SC-5 |
| UX-1006 | App detail | `apps/[id]/page.tsx` | Detail form, plain | SC-5, SC-8 |
| UX-1007 | Browse | `browse/page.tsx` | List/filter, plain | SC-7, SC-4 |
| UX-1008 | Connections | `connections/page.tsx` | No connector gallery w/ per-source icons | SC-4 (gallery), SC-7 |
| UX-1009 | Setup wizard | `setup/page.tsx` | Thin wrapper over workspace-create | SC-4 (wizard chrome) |
| UX-1010 | Org reports | `org-reports/page.tsx` | Thin launcher | SC-4, SC-5 |
| UX-1011 | Data products list | `data-products/page.tsx` | Card/list, plain | SC-4, SC-6 |
| UX-1012 | Experience hub | `experience/page.tsx` | Thin landing hub | SC-4, SC-6 |
| UX-1013 | Realtime hub | `realtime-hub/page.tsx` | Thin launcher | SC-8 (cross-links), SC-4 |
| UX-1014 | Workload hub | `workload-hub/page.tsx` | Card grid, functional | SC-4, SC-6 |

---

## 6. B-grade adopt-shared sweep (U11 … U13)

The B surfaces already have real backends and depth; the sweep **adds the
specific missing bar items** via the shared components. Lighter than a C build —
usually 1–3 shared adoptions per surface — but still gated on the no-scaffold
receipt (screenshot + click-walk of the newly-added bar item).

### UX-Wave 11 — canvases, RTI & modeling editors  *(the highest-value B lift: EntityDiagram + DetailsPanel land here)*

| ID | Surface | file | Adopt to close the gap |
|----|---------|------|------------------------|
| UX-1101 | Dataflow Gen2 | `dataflow-gen2-editor.tsx` | SC-9 (Alt+Q), SC-4 (import cards), ribbon density |
| UX-1102 | Notebook | `notebook-editor.tsx` | SC-7 (Data/Resources/Connections tabs), status-bar "Cell X of Y", Data Wrangler/VS Code buttons |
| UX-1103 | Synapse notebook | `synapse-notebook-editor.tsx` | SC-7, warm-pool/session polish parity |
| UX-1104 | Databricks notebook | `databricks/databricks-notebook-editor.tsx` | SC-7, cell ribbon |
| UX-1105 | Semantic model | `phase3/semantic-model-editor.tsx` | **SC-10** relationship canvas (signature gap), SC-2 |
| UX-1106 | Lakehouse explorer | `lakehouse/lakehouse-editor-shell.tsx` | **SC-10** entity diagram, **SC-5** closeable table tabs+timing, SC-6 teaching toast, SC-8 |
| UX-1107 | Materialized lake view | `materialized-lake-view-editor.tsx` | SC-10 (source-table lineage), SC-5 |
| UX-1108 | Eventhouse / KQL DB | `phase3/eventhouse-editor.tsx` | **SC-2** DB details (Query/MCP URI+policies), **SC-8** RTI cross-links + item-tab-strip, **SC-10** entity diagram |
| UX-1109 | KQL database (schema) | `phase3/kql-database-editor.tsx` | SC-2 (URI copy), SC-8 (RTI cross-links), SC-10 upgrade |
| UX-1110 | KQL dashboard | `phase3/kql-dashboard-editor.tsx` | cross-filter/param interaction depth (CAP-R2), SC-8 |
| UX-1111 | Warehouse | `phase3/warehouse-editor.tsx` | **SC-10** ER diagram, **SC-2** conn-string details, SC-7 object explorer |
| UX-1112 | Activator | `phase3/activator-editor.tsx` | **SC-1**/SC-3 card-based visual condition builder |
| UX-1113 | Digital Twin Builder | `digital-twin-builder-editor.tsx` | **SC-1** interactive twin graph canvas |
| UX-1114 | Ontology | `phase4/ontology-editor.tsx` | **SC-1**/SC-10 object/link relationship canvas |
| UX-1115 | Graph model | `phase4/graph-model-editor.tsx` | **SC-1** canvas-based schema authoring |
| UX-1116 | Tapestry | `tapestry-editor.tsx` | **SC-1** unified drag-to-pin link-analysis canvas |
| UX-1117 | Data Agent | `phase4/data-agent-editor.tsx` | trace/source-explanation canvas (SC-3 + Copilot transparency) |
| UX-1118 | Plan | `phase4/plan-editor.tsx` | **SC-1** node-kit adoption (colored headers/typed ports) |

### UX-Wave 12 — SQL / data / ML / Foundry / Palantir / apps editors

| ID | Surface | file (`lib/editors/…`) | Adopt to close the gap |
|----|---------|------------------------|------------------------|
| UX-1201 | ML model | `ml-model-editor.tsx` | version-lineage diagram (SC-10), SC-2 |
| UX-1202 | ML experiment | `ml-experiment-editor.tsx` | SC-5 run-comparison chart |
| UX-1203 | Mirrored database | `mirrored-database-editor.tsx` | **SC-10** source→CDC→Delta topology |
| UX-1204 | Mirrored Databricks | `mirrored-databricks-editor.tsx` | SC-10 topology |
| UX-1205 | Mounted ADF | `mounted-adf-editor.tsx` | SC-5 monitor/gantt, SC-8 |
| UX-1206 | Synapse serverless SQL | `synapse-serverless-sql-editor.tsx` | **SC-7** object explorer, SC-5, SC-10 |
| UX-1207 | Synapse dedicated SQL family | `synapse-sql-editors.tsx` | SC-10 ER, SC-2 |
| UX-1208 | Synapse Spark/pipeline family | `azure-services-editors.tsx` | SC-1 (plain CRUD editors), SC-4 |
| UX-1209 | Unified SQL database | `unified-sql-database-editor.tsx` | **SC-10** ER diagram, SC-2 conn details |
| UX-1210 | Azure SQL server / MI | `azure-sql-editors.tsx` | SC-10 topology, SC-2 |
| UX-1211 | Cosmos graph editors | `graph-editors.tsx` | visual graph-canvas for Gremlin/Cypher results (**SC-1**) |
| UX-1212 | GQL graph (ADX-native) | `graph-editors.tsx` | persistent visual graph canvas (SC-1) |
| UX-1213 | Geo editors | `geo-editors.tsx` | drawing/analysis toolset parity, SC-8 |
| UX-1214 | Foundry hub | `foundry-hub-editor.tsx` | SC-8 workspace framing, SC-4, Copilot depth |
| UX-1215 | Foundry sub-editors | `foundry-sub-editors.tsx` | **SC-1** prompt-flow DAG canvas, SC-7 index tree |
| UX-1216 | Copilot Studio editors | `copilot-studio-editors.tsx` | per-channel typed forms (DOC-6), analytics dataviz |
| UX-1217 | Power Platform editors | `powerplatform-editors.tsx` | **SC-1** Power Automate flow-designer canvas |
| UX-1218 | Cross-item Copilot | `cross-item-copilot-editor.tsx` | tool-call/reasoning-trace UI (SC-3 + CTS transparency) |
| UX-1219 | APIM editors | `apim-editors.tsx` | visual policy-fragment designer (SC-3), SC-5 try-it |
| UX-1220 | Data product detail | `data-product-detail.tsx` | contracts/lineage diagram (SC-10), SC-2 |
| UX-1221 | Data API Builder | `data-api-builder-editor.tsx` | SC-5 live REST/GraphQL try-it console |
| UX-1222 | Palantir Workshop | `workshop/workshop-app-builder.tsx` | drag-drop grid richness (SC-1), SC-4 |
| UX-1223 | Palantir Slate | `slate/slate-app-builder.tsx` | page/component tree depth (SC-7), SC-1 |
| UX-1224 | Databricks job | `databricks/job-editor.tsx` | **SC-1** task-graph node-kit |
| UX-1225 | Databricks pipeline (DLT) | `databricks/pipeline-editor.tsx` | DLT table/graph view depth (SC-5, SC-10) |
| UX-1226 | Databricks SQL warehouse | `databricks/sql-warehouse-editor.tsx` | SC-10 verify, SC-5 |
| UX-1227 | Databricks UC dialogs | `databricks/uc-dialogs.tsx` | **SC-10** UC lineage graph view |

### UX-Wave 13 — catalog / marketplace / monitor / admin / hub pages + dialogs

| ID | Surface | file | Adopt to close the gap |
|----|---------|------|------------------------|
| UX-1301 | Warehouse object explorer | `phase3/warehouse-editor.tsx` | **SC-7** typed schema tree (distinct from query canvas) |
| UX-1302 | Factory Resources tree | `lib/components/pipeline/factory-resources-tree.tsx` | verify SC-7 context-menu landed; icon fidelity |
| UX-1303 | Catalog federated search | `lib/components/catalog/federated-search.tsx` | saved-search + facet-refinement panel |
| UX-1304 | Catalog lineage canvas | `lib/components/catalog/lineage-canvas.tsx` | column-level lineage + impact highlighting (SC-10 upgrade) |
| UX-1305 | Catalog metastores | `app/catalog/metastores/page.tsx` | SC-6, SC-4 chrome lift |
| UX-1306 | Governance policies | `app/governance/policies/page.tsx` | **SC-3** visual policy condition-builder |
| UX-1307 | Governance lineage | `app/governance/lineage/page.tsx` | SC-10 chrome + impact panel polish |
| UX-1308 | Marketplace (unified) | `lib/components/marketplace/loom-marketplace.tsx` | unified search/filter across API+Data |
| UX-1309 | API Marketplace | `lib/components/marketplace/api-marketplace.tsx` | SC-5 "try-it" developer console |
| UX-1310 | Data shares | `lib/components/marketplace/data-shares.tsx` | SC-2, SC-4 chrome lift |
| UX-1311 | Monitor hub | `lib/components/monitor/monitor-pane.tsx` | unified single-pane correlated timeline |
| UX-1312 | OneLake browser | `app/onelake/page.tsx` | SC-10 entity diagram, SC-5 file preview depth |
| UX-1313 | Workspaces list | `app/workspaces/page.tsx` | Fabric columns (Status/Type/Task/Owner/Refreshed/Endorsement/Sensitivity) + folders + nested child tree + task-flows band (CAP-R2) |
| UX-1314 | Admin: MCP servers | `lib/components/admin/mcp-servers-panel.tsx` | SC-4, SC-6 chrome lift |
| UX-1315 | Admin: MCP catalog wizard | `lib/components/admin/mcp-catalog-wizard.tsx` | SC-4 wizard polish |
| UX-1316 | Admin: Scaling | `app/admin/scaling/page.tsx` | SC-5 capacity-utilization gauge (Capacity-Metrics parity) |
| UX-1317 | Admin: Capacity | `app/admin/capacity/page.tsx` | SC-5 burst/smoothing chart |
| UX-1318 | Admin: Chargeback | `app/admin/usage-chargeback/page.tsx` | chart-first dataviz |
| UX-1319 | Admin: Landing zones | `app/admin/landing-zones/page.tsx` | verify React-Flow topology post-merge; SC-1 |
| UX-1320 | Learn / Learning Hub | `app/learn/page.tsx` | structured curriculum + progress tracking |
| UX-1321 | Learning Hub Copilot | `lib/components/learn/learning-hub-copilot.tsx` | transparency parity (CTS) |
| UX-1322 | Copilot (in-product) | `app/copilot/page.tsx` | tool-call/reasoning-trace viz (CTS-01/02) |
| UX-1323 | Catalog shell | `lib/components/catalog/catalog-shell.tsx` | SC-9, SC-6 chrome |
| UX-1324 | Install App dialog | `lib/components/apps/install-app-dialog.tsx` | multi-step progress/receipt viz |
| UX-1325 | Share item dialog | `lib/dialogs/share-item-dialog.tsx` | permission-preview-before-share (SC-2) |
| UX-1326 | Apps hub | `app/apps/page.tsx` | per-app health/version dashboard |
| UX-1327 | Workspace create wizard | `lib/wizards/workspace-create.tsx` | SC-4 wizard polish; visual parity |

---

## 7. A-grade reference exemplars (codify — do not rebuild)

These five surfaces meet or exceed the baseline. Codify them as **reference
exemplars** in the shared kit's docs (`docs/fiab/parity/_reference-exemplars.md`)
so every new surface inherits the bar, and refactor each onto the shared
components where it currently owns a private copy (so the reference is the shared
component, not a fork).

| Surface | file | Why it is the reference | Residual (verify only) |
|---------|------|-------------------------|------------------------|
| Data pipeline | `lib/editors/pipeline-editor-core.tsx` | node-kit v2, docked validation-dot inspector, guided empty state, Factory tree | add SC-9 Ctrl+Q; full item-tab-strip |
| Mapping data flow | `lib/editors/mapping-dataflow-editor.tsx` | node-kit v2 transform picker | SC-9; per-item New badges |
| Eventstream | `lib/editors/phase3/eventstream-editor.tsx` | live type-badged preview dock, draft/publish, ghost nodes | ensure Azure-native "go live" is as prominent as the Fabric-labeled publish |
| Report designer | `lib/editors/report-designer.tsx` | 30+ panes, DAX, Copilot | confirm Analyze-in-Excel / export ribbon (CAP-R2) |
| New Item dialog | `lib/components/new-item-dialog.tsx` | categorized searchable create gallery | add per-card favorite/star toggle |

---

## 8. Wave slotting into the master plan

These 14 UX waves **interleave** with the remaining feature waves (11–20) in
`WAVES.md`. UX-Wave 0 (the shared foundation + CAP-R2) is a hard prerequisite for
every subsequent UX wave and slots **immediately, in parallel with feature Wave
11**. The C-build and B-sweep UX waves then interleave one-for-one so each build
session pairs a feature wave with a UX wave (builders share subsystem context —
e.g. the RTI feature wave pairs with the RTI UX sweep). See the WAVES.md addendum
for the exact interleave table and totals update.

**Ordering forces (in priority):**
1. **Shared-first.** U0 lands before any adopt-shared wave; the EntityDiagram
   (SC-10), DetailsPanel (SC-2), and DockedInspector (SC-3) unblock the most
   surfaces and are P0 inside U0.
2. **C before B.** C surfaces (functional-but-plain, worst user experience) are
   raised to the floor first (U1–U10); the B-sweep (U11–U13) is polish on already-
   good surfaces.
3. **Capture before final grade.** CAP-R2 must complete before the final grading
   of the seven surfaces it grounds (copy-job, kql-queryset, map, kql-dashboard,
   semantic-model relationship canvas, report ribbon, workspaces task-flows).

**Governing rules (die-hard):** every item is Azure-native by default (Fabric
opt-in only), bicep-synced where it touches infra, dual-cloud (Commercial + Gov),
Fluent v9 + Loom tokens, **no freeform JSON config** (wizards/dropdowns/canvas
only), and validated by the **no-scaffold** receipt (physical click-walk, not DOM
strings).

**Operator actions:** none new. Every shared component and surface upgrade reuses
already-provisioned Azure backends (Cosmos, AOAI, Synapse/TDS, ADX/Kusto, ADLS,
Purview, Azure Monitor, Maps). The EntityDiagram/PreviewTable/DetailsPanel read
existing data-plane schema/policy endpoints; no new resource, role, or spend is
introduced by this program.
