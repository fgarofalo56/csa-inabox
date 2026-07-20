# Competitive Audit 02 — Palantir Foundry + AIP vs CSA Loom (Weave)

**Cluster:** Palantir Foundry + AIP (Ontology-first operational data/AI platform)
**Loom counterpart:** the **Weave** epic ("Palantir-parity-on-Azure, Ontology first") + the
`palantir/` and `phase4/` editor families, backed by the active
`PRPs/active/foundry-parity/` program (matrix + AUDIT).
**Date:** 2026-07-20 · **Author:** audit subagent · **Grounding:** live Palantir docs
(palantir.com/docs/foundry, 2026 announcements) + the repo (files cited inline).

> **Bottom line up front.** Loom has built the *widest* Foundry clone of any Azure-native
> product I can find: a typed Ontology (objects/links/actions/interfaces/shared-props/
> invariants) with real graph write-back, OSDK codegen + live REST/GraphQL, a Workshop-class
> app builder (32+ widgets), AIP-Logic typed block graph + tool-calling agents, Object
> Explorer, checkpoints/approvals/validation, Contour/Quiver/Notepad/Fusion analogs, and a
> Data-Connection/Pipeline-Builder/lineage spine. The *breadth* is A-grade. The gap is
> **depth and polish inside the moat surfaces** (Ontology object-views/derived-props/security,
> Workshop layout richness, AIP-Logic studio operationalization) and the **operational-loop
> maturity** (object-sync at scale, evals-in-CI, functions-on-objects registry) where Foundry
> has a decade of hardening. Overall today: **Loom ≈ B / B+ vs Foundry** — broader surface,
> shallower in the highest-value 20%.

---

## 1. Capability inventory — real Palantir Foundry + AIP (2026)

Foundry is a single closed platform organized (using Palantir's own framing, mirrored in the
Loom PRP) into pillars: data integration, **Ontology (the moat)**, analytics, app-building &
automation, **AIP (the AI platform)**, governance/security/ops, and interop/APIs. Below is the
surface-by-surface inventory, grounded in current docs.

### 1.1 Ontology (the core moat)
The semantic layer over all data — Foundry's defining asset.

- **Object types** — typed business entities backed by one or more datasets (RIDs). Each has:
  typed **properties** (base types below), primary key, **title key**, display metadata
  (singular/plural name, description, **icon**, **color**, **type groups**), lifecycle
  **status** (Active/Experimental/Deprecated), visibility (Prominent/Normal/Hidden),
  per-property **value + conditional formatting**, renderer hints, typeclasses, and an
  optional separate **edits-only datasource**.
- **Property base types** — string, boolean, byte, short, integer, long, float, double,
  decimal, date, timestamp, **array**, **struct**, **geopoint/geohash**, **geoshape**,
  **timeseries**, **attachment**, **media reference**, **marking**, **vector/embedding**,
  **cipher text**.
- **Link types** — named relationships (1:1 / 1:many / many:many), from/to object types,
  per-direction display names, backing FK column or join dataset.
- **Action types (write-back)** — create/modify/delete object + create/delete link, batched;
  **typed parameters** (incl. object reference, attachment, multi-select, struct, geohash) with
  prompts/defaults/required; **parameter validation** (allowed-values, range/regex, conditional
  visibility/requiredness, cross-parameter rules); **submission criteria**; **form layout**
  (ordered sections); **function-backed validation + side effects**; security (which groups may
  submit) + full **Ontology edits history / audit log**.
- **Shared property types** — define a property once, reuse across object types (the unit
  interfaces are declared against).
- **Interfaces** — abstract types declaring property + link + action **constraints**; object
  types **implement** them → polymorphic apps/SDKs.
- **Functions (on objects)** — TypeScript/Python functions over ontology objects; back derived
  properties, action validation, and side effects.
- **Derived properties** — computed from linked objects/functions (rollups/aggregations), not
  stored on the backing dataset.
- **Object views** — configurable per-type tabs/widgets rendering a single instance (overview,
  properties, linked objects, charts, map, timeseries).
- **Object storage v2 (OSv2)** — scaled object instance store; datasets **sync** into objects
  with backfill; indexing for search/filter.
- **Security** — type-level + property-level + **row-level** (restricted views, mandatory
  markings).
- **Ontology proposals / branches** — Git-like staged change + review before publish.

### 1.2 Data integration & engineering
- **Pipeline Builder** — visual, no-code batch **and** streaming pipeline authoring; transforms;
  embeddings/semantic-search nodes; UDFs.
- **Code Repositories** — Git-backed **Transforms** in Python/Java/SQL, branches, CI checks,
  code review.
- **Code Workspaces** — hosted Jupyter/RStudio/VS Code IDEs.
- **Data Connection + Magritte connectors (200+)** — source connection management; **agent
  worker/proxy** for on-prem; batch/CDC/streaming syncs; **virtual tables** (zero-copy).
- **Datasets** — transactional, **versioned with time travel**, branches.
- **Streams / Media sets** — first-class streaming datasets; non-tabular media collections
  (thumbnails, typed, bulk-tag).
- **Builds & schedules** — DAG builds, schedules, monitors; data health / **expectations /
  checks** (freshness, schema, volume gates).
- **Data Lineage (Monocle)** — cross-platform lineage graph, health, impact analysis, column-level.

### 1.3 Analytics
- **Contour** — path/board-based **point-and-click** analysis over datasets (ordered analysis
  steps: filter/join/derive/pivot/aggregate/chart).
- **Quiver** — object + **time-series** analysis notebook/canvas (~30 card types: TS plots,
  distribution, scatter, histogram, object cards, transform cards, map).
- **Notepad** — live-data documents with embedded queries/objects/visuals.
- **Fusion** — spreadsheets over live data (formulas over object/dataset cells).
- **Map** — geotemporal layers (GIS app).
- **Object Explorer** — search/filter/**facet**/**traverse** object sets; saved explorations;
  histograms.
- **Reports / dashboards / Notebooks (Code Workbook)**.

### 1.4 App building & automation
- **Workshop** — ontology-bound low-code **operational app builder**: pages, layout designer,
  **sections/tabs/overlays (drawer/modal)**, **loop/flow layouts**, a **~40-widget library**
  (object table/list/view, property list, links, chart families, pivot, gantt, timeline, map,
  metric, markdown, media/PDF/image-annotation, filter/dropdown/pickers, button/inline-action,
  AIP Analyst/Chatbot widgets, scenario manager, iframe/custom-OSDK), **typed variables** (object
  set, object-set-filter, scalars, scenario) with recompute modes, and **events → effects**
  (set/reset/recompute var, **run Action**, open/close overlay, switch page/tab, navigate to
  module/object-view with variable mapping, stream-LLM-into-variable, export), plus conditional
  visibility/formatting, Preview mode, Publish/share.
- **Slate** — pixel-perfect pro-code HTML/JS custom apps.
- **Dev Console + OSDK apps** — external app registration, OAuth clients, OSDK generation.
- **Foundry Rules (Taurus)** — no-code business-rules engine → actions.
- **Automate** — object monitors (condition on object set) → effects (event-driven automation).
- **Approvals** — human-in-the-loop gates on actions/ops.
- **Checkpoints** — friction/justification prompts on sensitive operations (recorded).
- **Machinery** — process mining/discovery.

### 1.5 AIP (the AI Platform)
- **AIP Logic** — no-code **typed LLM functions** over the ontology: 3-pane studio (Inputs /
  **Blocks** / Outputs · **Debugger** · Run panel). Typed inputs (16 types incl. object/object-set/
  model/media). **Block graph** with named typed outputs: create-variable, get-object-property,
  **Use LLM** (with **tools**: Apply-actions, Ontology-function, function tools), Apply-action,
  Execute-function, Transform, conditional/branch, iteration. Outputs = typed Value **or** the
  ontology edits made. Debugger shows CoT, per-block cards, tool-call logs, proposed edits. Run
  panel: run, **run history**, **unit tests**, **AIP Evals**, **automations**. Version history +
  diff; **Publish**; wrap published Logic **as an Action**; **Uses** tab (curl for external REST).
- **AIP Assist** — in-product platform copilot (help + do).
- **AIP Agent Studio** — build agents with ontology tools (the legacy AIP Agent widget was
  **deprecated April 2026** in favor of Agent Studio / Chatbot tooling).
- **AIP Analyst** (March 2026) — conversational analytics interface over the Ontology that can
  **execute Foundry actions** from a conversation; embeddable in Workshop.
- **AIP Evals** — eval suites (block-level + suite) for functions/agents.
- **Ontology MCP (OMCP)** — expose ontology objects/actions to external assistants/agents via MCP.
- **Modeling objectives / model management** — train → stage → release with approvals; model
  catalog; bring-your-own/external models; vector/embedding infra (semantic search / OAG).
- **AIP architecture** — secure connections to many LLMs, agent/automation building, continuous
  context into the ontology, AI dev toolchain, monitoring/ops for deployed agents.

### 1.6 Governance, security & platform ops
- **Projects/Compass** (folders, resource org), **Multipass** (identity/orgs/tokens),
  **granular permissions + Restricted Views** (mandatory + row-level), **markings &
  classifications**, **audit logs**, **resource management** (compute usage/credits),
  **Control Panel**, **Apollo** (upgrade orchestration), **Marketplace** (install/ship packaged
  products), **data lifetime/retention + export controls**.

### 1.7 Interop, APIs & DX
- **REST API v2 + webhooks**, **CLI + SDKs**, **Git/CI integration** (branch-based dev),
  docs/examples/walkthroughs.

### 1.8 What's new in Foundry 2026 (currency — grade Loom against these too)
- **AIP Analyst** (Mar 2026) — conversational analytics over the Ontology; NL → queries →
  visualizations; executes Foundry actions from chat; embeddable in Workshop.
- **AIP Agent Studio** (Mar 2026) — visual agent builder (LLM reasoning + tool integration +
  human handoff); the legacy AIP Agent widget was deprecated Apr 2026.
- **Ontology MCP / OMCP** (Jul 2026 GA) — standard MCP protocol exposing the Ontology to external
  LLM clients; **agent scoped auth** (Jul 2026) for OSDK/OMCP/Palantir MCP.
- **SQL Studio** (May 2026 Beta → Jun 2026 GA) — dedicated SQL IDE over Ontology SQL + datasets;
  **Ontology SQL functions** (beta).
- **Global Branching** (May 2026 GA) — branch changes across pipelines/ontology globally.
- **Model Studio** (Feb 2026 GA) — ML training; **Modeling Objectives** framework.
- **Compute Modules** (Feb 2026) — deploy containerized custom logic against the ontology.
- **AIP Document Intelligence** (Feb 2026 GA) — OCR + LLM extraction from PDFs/images.
- **Sensitive Data Scanner** (Feb 2026) — detect + obfuscate PII via Cipher.
- **Core Object Views** (Feb 2026 GA) — optimized read patterns over ontology subsets;
  **multi-ontology lineage**.
- **Security policy testing** (Jun 2026) — test permission/row-policy changes before publish.

> **Loom currency check:** OMCP ↔ Loom's deployable MCP catalog (`iq-mcp.ts`) — close but not
> ontology-object-native yet. SQL Studio ↔ Loom's Synapse/ADX query surfaces (no unified
> "ontology SQL IDE"). Model Studio ↔ `ml-model`/automl (η). Document Intelligence ↔ no direct
> Loom analog (Azure Document Intelligence is available — a clean burn-the-box win). Sensitive
> Data Scanner ↔ Purview classifications + MIP (✅ arguably ahead). Global Branching ↔ **no Loom
> analog** (ontology proposals/branches are also missing — a compounding gap). Compute Modules ↔
> functions-on-objects (missing, see §4 P0-2).

### What makes Foundry hard to beat
1. **A decade-hardened Ontology** with object-views, derived properties, function-backed
   validation, and row/property-level security wired through *every* surface (apps, SDK, AIP).
2. **Tight operational loop** — Actions write back through governed, audited, human-gated flows;
   the same ontology powers apps, analysis, SDK, and agents with one permission model.
3. **Monocle lineage + Apollo** — cross-platform lineage and safe rolling upgrades at scale.
4. **Product cohesion** — one closed stack; no integration seams; consistent UX and security.

### Foundry's closed-stack limitations (Loom's opening)
- **Proprietary, single-vendor lock-in** — no Azure-native/OSS substitution; runs on Palantir's
  cloud/terms; expensive; hard to self-host in a sovereign/air-gapped tenant.
- **Closed data plane** — data lives in Foundry's datasets/OSv2; interop is via export/OSDK, not
  native lakehouse/warehouse the customer already owns.
- **No first-class Microsoft/Azure integration** — no native tie to Fabric/Power BI/Databricks/
  Synapse/Purview/Entra; you re-platform rather than layer onto existing Azure estate.
- **Opaque model layer** — you use Palantir's LLM plumbing, not your own Azure OpenAI/Foundry
  deployments, RAI policies, and model governance.

---

## 2. Loom's current equivalent (what's in the repo TODAY)

Loom's Foundry answer is the **Weave** epic + two editor families
(`apps/fiab-console/lib/editors/palantir/` and `.../phase4/`), all registered in
`apps/fiab-console/lib/editors/registry.ts` (verified — every item below resolves to a real
editor component). Catalog entries live in `apps/fiab-console/lib/catalog/item-types/fabric-iq.ts`
(category "Loom IQ" / "Loom Apps"). The active program is `PRPs/active/foundry-parity/` (PRP.md
matrix + AUDIT.md live-gap register).

### 2.1 Ontology → **Weave**
- **Typed model** — `apps/fiab-console/lib/editors/ontology-model.ts` is a full typed schema:
  `OntoObjectType` (properties, PK, titleKey, status, color, icon, groups, parent/IS-A,
  datasource, **implements[]**, **sharedPropertyGroups[]**, **invariants[]**), `OntoLinkType`
  (cardinality, FK/join), `OntoActionType` (typed `parameters[]`, **requiresJustification**,
  **submissionCriteria**, **emitLineage**, **requiresApproval**), `OntoInterface`,
  `OntoSharedPropertyGroup`. Base-type set is a curated 1:1 of Foundry's (20 types incl. geopoint/
  geoshape/timeseries/attachment/mediaReference/marking/vector/struct). Interface conformance +
  effective-property merge + submission-criteria/invariant evaluators are all implemented and
  unit-tested (`__tests__/ontology-submission-criteria.test.ts`).
- **Editor** — `phase4/ontology-editor.tsx` (`OntologyEditor`): typed Object/Link/Action-type
  designer (no freeform JSON for the model), datasource binding, Activator triggers, graph-model
  materialization.
- **Instance write-back** — `apps/fiab-console/lib/azure/weave-ontology-store.ts`: real graph
  store over **Apache AGE on Azure Database for PostgreSQL Flexible Server** — object instances =
  AGE vertices, links = edges, actions = ACID cypher transactions. Injection-guarded; honest gate
  (`weaveGate()`); self-healing AGE bootstrap. **This is real write-back, no mocks.**
- **Object Explorer** — `phase4/object-explorer-panel.tsx` + `apps/fiab-console/lib/azure/
  weave-explore.ts`: cross-type facets, search, link traversal, saved explorations over the AGE
  store (`/api/items/ontology/[id]/explore`). Shipped + E2E'd (PRP rows 2.6).

### 2.2 OSDK → **Ontology SDK** (`ontology-sdk`)
- `palantir/ontology-sdk-editor.tsx`: bind ontology → scope selector (objects/links/actions) →
  generate typed **TypeScript + Python** clients + `dab-config.json` + typed `applyCreate/Update/
  Delete` actions → **live "Try it" REST(OData)+GraphQL explorer** against a real **Microsoft
  Data API Builder** runtime on Azure Container Apps → **Publish to APIM**. Codegen in
  `_palantir-codegen.ts` (unit-tested). Parity doc `docs/fiab/parity/ontology-sdk.md`.

### 2.3 AIP Logic → **Spindle (Spindle Studio)** (`aip-logic`)
- `palantir/aip-logic-editor.tsx`: **typed input system** (16 types incl. object/object-set/
  model/media reference — full AIP parity), a **real typed BLOCK GRAPH** (`create-variable`,
  `get-object-property`, `use-llm`, `apply-action`, `execute-function`, `transform`, `branch`)
  where each block emits a named typed output later blocks reference — no freeform JSON. `use-llm`
  blocks carry **tools** (`apply-action` / `ontology-function` / `execute-function`). Runs against
  **live Azure OpenAI** as deterministic **Logic** or multi-step **tool-calling Agent** (reuses
  the production copilot orchestrator + full Loom data-tool registry); per-step run trace. Can
  **publish as an Azure AI Foundry Agent Service agent** (opt-in, Gov-gated honest 501). Ontology
  grounding runs real Synapse/ADX queries. **NOTE: the code is well ahead of its parity doc**
  (`docs/fiab/parity/aip-logic.md` still describes a "flat stacked" pre-block-graph editor — stale).

### 2.4 Workshop → **Atelier** (`workshop-app`) + **Slate** (`slate-app`)
- `workshop/workshop-app-builder.tsx` + `_workshop-model.ts`: drag-resize widget/layout canvas
  persisted to Cosmos; **32+ widget kinds** (table, chart×6, metric/kpi-row/stat-pair/delta/gauge/
  rating, filter, form=real CRUD, text/heading/quote, image/iframe, divider/spacer/breadcrumb,
  badge/tag-list/callout/checklist, avatar, key-value/mini-table/json-view/code-block, timestamp/
  countdown/progress, **tabs with full per-tab child-widget nesting**, accordion, sparkline);
  **typed variables** (object-set-filter/string/number/boolean/date) → parameterized Synapse
  `WHERE`; **event→effect wiring** (click/row-select/page-load → set/clear-var, run-action,
  refresh); live **Preview** reading real Synapse T-SQL; injection-safe CRUD write-back with
  Thread lineage edges. `slate-app` is a **backed template** that instantiates a real
  data-api-builder + workshop-app pair and can publish to Azure Static Web Apps.

### 2.5 Analytics (Contour / Quiver / Notepad / Fusion)
- **Contour → `analysis-board`** (`phase4/analysis-board-editor.tsx`): ordered typed transform
  steps (filter/select/derive/aggregate/sort/limit/distinct) compiling to real **KQL over Azure
  Data Explorer**; live results grid.
- **Quiver → `rayfin-app`** (`rayfin-app-editor.tsx`): object + time-series card canvas over
  ADX/ontology; **34 card kinds** (per AUDIT.md batch-7).
- **Notepad → `notepad`** (`phase4/notepad-editor.tsx`): live-data document, heading/text/**KQL
  query** blocks running inline against ADX.
- **Fusion → `fusion-sheet`** (`phase4/fusion-sheet-editor.tsx`): A1 spreadsheet with a
  Loom-native formula engine (SUM/AVG/MIN/MAX/COUNT/IF/ROUND/ABS/CONCAT, ranges, cycle detection).
- **Map → `map`** (`phase4/map-editor.tsx`): geospatial over Lakehouse/KQL/Ontology + Azure Maps.

### 2.6 Vertex / digital twin → `digital-twin` + `graph-model`
- `digital-twin-model.ts` + `digital-twin-builder-editor.tsx`: entity/relationship twin
  materialized on ADX (`make-graph`/`graph-match`). `phase4/graph-model-editor.tsx` = GQL/openCypher
  graph over ADX (the "graph = ADX" pattern).

### 2.7 Automation / rules / governance
- **Checkpoints** (justifications), **approvals** (one-shot), **validation rules** (submission
  criteria), **object invariants** (Foundry Rules-class) — all shipped + E2E'd on the ontology
  model + AGE write-back (`action-approval-store.ts`, `action-justification-store.ts`,
  `audit-retention.ts`). **Health check** (`health-check`) = real Azure Monitor scheduled-query
  alerts (Foundry data-health/expectations). **Release environment** (`release-environment`) =
  Apollo-class promotion over ARM deployment history + Azure Deployment Environments.
- **Data Connection / Pipeline Builder / Lineage** — `/connections` (reusable KV-backed
  connections), the `pipeline-editor` React-Flow canvas with a ~40-activity catalog
  (`lib/components/pipeline/activity-catalog.ts`), and `/governance/lineage` + Purview + **Thread**
  edges. Foundry-parity PRP grades these ✅/η.

### 2.8 Program state (from `PRPs/active/foundry-parity/`)
The PRP matrix tallies **18 ✅ · 24 η (partial) · 9 ❌ net-new** across ~55 Foundry capabilities.
The AUDIT.md "Final receipt" records the 2026-07-19 drive shipping the governance suite (object
explorer, checkpoints, full action validation, approvals, object invariants, retention/export)
and the greenfield analytics items (analysis-board, fusion-sheet, notepad) with live browser/
session E2E receipts, plus live Fabric + Azure-portal side-by-sides grading Loom **≥ Fabric/Azure**
for home/browse/workspace views.

---

## 3. Graded parity matrix

Grades reflect **what the code does today** (A+ = as-good-or-better than Foundry & production-
tested; A = on par; B = solid core, depth gaps; C = thin/core-only; D = stub; F = missing/
vaporware). "File" cites the primary surface.

| Foundry capability | Loom surface (file) | Grade | Gap |
|---|---|---|---|
| **Ontology — object/link/action types (typed model)** | `ontology-model.ts`, `phase4/ontology-editor.tsx` | **A−** | Typed model matches Foundry incl. interfaces, shared props, invariants; UI depth for icon/groups/visibility partial |
| **Ontology — property base types** | `ontology-model.ts` (`ONTO_BASE_TYPES`, 20) | **A** | 1:1 with Foundry base types (incl. vector/marking/timeseries/struct) |
| **Ontology — interfaces + shared property types** | `ontology-model.ts` (conformance, effective props) | **B+** | Model + conformance validation shipped; authoring UX depth unverified vs Foundry |
| **Ontology — action write-back** | `weave-ontology-store.ts` (AGE) | **A−** | Real ACID graph write-back; create/run forms still partly freeform JSON |
| **Ontology — validation rules / submission criteria** | `ontology-model.ts` (`evaluateSubmissionCriteria`) | **A** | Server-enforced (422), E2E'd; no cross-parameter/conditional-visibility rules |
| **Ontology — invariants (Foundry Rules on objects)** | `ontology-model.ts` (`evaluateObjectInvariants`) | **A−** | Enforced on instance write; operator set matches |
| **Ontology — object views** | — | **F** | MISSING — no configurable per-instance view (overview/linked/timeseries/map) |
| **Ontology — derived properties** | — | **F** | MISSING — no rollup/computed-from-link properties |
| **Ontology — granular/row/property security** | — | **D** | MISSING as ontology feature (platform RLS/RBAC exists elsewhere; not wired to objects) |
| **Ontology — dataset→object sync (OSv2) + backfill** | ontology `/bind` (Cosmos) | **C** | Binding exists; no scaled sync pipeline/backfill status |
| **Ontology — proposals/branches** | — | **F** | MISSING — no staged-model review/approve |
| **Object Explorer** | `phase4/object-explorer-panel.tsx`, `weave-explore.ts` | **B+** | Facets/search/traverse/saved shipped + E2E'd; no histograms, thinner than Foundry |
| **OSDK (typed SDK generation)** | `palantir/ontology-sdk-editor.tsx`, `_palantir-codegen.ts` | **A−** | TS+Py + DAB REST/GraphQL + APIM publish + live Try-it; Java/OpenAPI export + package pipeline (npm/pip) not E2E'd |
| **Functions on objects** | `aip-logic` (partial) | **C** | No function registry/versioning/derived-property binding |
| **Pipeline Builder (visual batch)** | `pipeline-editor*.tsx`, `activity-catalog.ts` | **A−** | ~40 activities on canvas; ADF/Synapse-backed. UDF-node + streaming-mode verification pending |
| **Pipeline Builder (streaming/embeddings nodes)** | `eventstream` + ASA | **B** | Loom splits streaming into eventstream by design; embeddings/semantic-search node not a first-class pipeline node |
| **Code Repositories (Transforms Py/Java/SQL + branch CI)** | notebook + spark-job-def + repos + gh-aca-runner | **B−** | Building blocks exist; no in-product "transforms project" scaffold + branch/PR/CI UX |
| **Code Workspaces (hosted IDEs)** | notebook (Monaco+pylsp) | **C+** | Notebook editor; no full hosted VS Code/RStudio (code-server candidate) |
| **Data Connection + connectors (200+)** | `/connections`, ADF linked services | **B** | Reusable connection hub + ~70 connectors vs Foundry 200+; unified "Data Connection" page thin |
| **Datasets — versioning/time-travel/branches** | `delta-history.ts` (Delta) | **B** | Delta time-travel/RESTORE in backend; version-history/branch UX not surfaced on lakehouse Tables |
| **Data Lineage (Monocle)** | `/governance/lineage`, Purview, Thread edges | **B** | Cross-item lineage; **column-level** completeness gap |
| **Contour (point-and-click analysis)** | `phase4/analysis-board-editor.tsx` | **B** | Step-DAG → KQL/ADX shipped; fewer step types + no save-as-dataset/export-to-report vs Contour |
| **Quiver (object + TS analysis)** | `rayfin-app-editor.tsx` | **B−** | 34 cards vs ~30 families covered; canvas depth thinner |
| **Notepad (live-data docs)** | `phase4/notepad-editor.tsx` | **B** | Heading/text/KQL blocks; no embedded objects/visuals beyond KQL grid |
| **Fusion (spreadsheets on live data)** | `phase4/fusion-sheet-editor.tsx` | **B−** | Loom-native formula engine; fewer functions + no live object-set binding into cells |
| **Workshop (low-code app builder)** | `workshop/workshop-app-builder.tsx` | **B** | 32+ widgets, typed vars, events, live Preview, real CRUD; **MISSING multi-page, sections, overlays, loop layouts, real publish, object-view/links/map/pivot/gantt/timeline/AIP/scenario widgets, conditional visibility** |
| **Slate (pro-code apps)** | `palantir/slate-app-editor.tsx` | **B−** | Backed template → DAB+workshop pair + SWA publish; not pixel-perfect pro-code canvas |
| **Foundry Rules (Taurus)** | ontology invariants + `activator` | **B−** | Object invariants cover the on-object case; no standalone no-code cross-entity rules item |
| **Automate (object monitors → effects)** | `activator`, `health-check`, `agent-flow` | **B** | Azure Monitor rules + Activator; object-condition monitors on ontology thin |
| **Approvals (human-in-the-loop)** | `action-approval-store.ts` | **A−** | One-shot approval gate on actions, E2E'd; no Teams/email routing UX |
| **Checkpoints (justifications)** | `action-justification-store.ts` | **A** | Per-action justification → audit chain, E2E'd |
| **AIP Logic (typed LLM functions)** | `palantir/aip-logic-editor.tsx` | **B+** | Full typed inputs + real block graph + tools + Logic/Agent runtime on live AOAI. **MISSING: 3-pane studio, debugger CoT/block-cards, run history, unit tests, evals, version diff, publish-as-REST/Uses-curl, model/settings panel, token metrics** |
| **AIP Assist (platform copilot)** | Loom in-product Copilot | **A** | Exceeds in gate-resolution + per-surface grounding |
| **AIP Agent Studio (agents w/ ontology tools)** | `agent-flow` + `data-agent` + aip-logic agent mode | **B** | Tool-calling agents exist; ontology-tool binding (query objects / invoke actions) partial |
| **AIP Evals** | `evaluation` item | **C+** | Standalone evals; NOT wired to gate aip-logic/agent publish (no evals-in-CI) |
| **AIP Analyst (conversational analytics + run actions)** | data-agent + copilot | **C** | Conversational Q&A over data exists; execute-ontology-action-from-chat not a first-class embeddable widget |
| **Ontology MCP (OMCP)** | `iq-mcp.ts`, MCP library | **B** | Loom has a deployable MCP catalog; ontology-object/action MCP exposure not the polished OMCP |
| **Modeling objectives / model mgmt** | `ml-model`, automl, `release-environment` | **B** | Registry + staged release building blocks; approvals-hooked staged flow η |
| **Vector/embedding infra (semantic search)** | `ai-search-index` | **A−** | AI Search vectors + AOAI embeddings; one-click "embed ontology" η |
| **Vertex (graph exploration/sim)** | `digital-twin`, `graph-model` (ADX) | **B** | Real graph over ADX; ontology-aware interactive overlay + simulation thin |
| **Governance/security/audit/marketplace/Apollo** | /admin suite, marketplace, updates | **A−** | Deep Azure-native governance; exceeds on 21 one-click apps; Foundry-Rings/Apollo parity ✅ |
| **Retention / export controls** | `audit-retention.ts` | **A−** | CSV/JSON export + real retention-reap, E2E'd |
| **REST API v2 + webhooks / CLI / SDKs** | publish-as-api, Loom SDK, APIM | **A** | Full API + SDK + Terraform + SCIM |

---

## 4. Gaps & recommendations (prioritized — operator bar: as-good-or-better)

### P0 — Deepen the moat (Ontology + AIP Logic + Workshop are where Foundry wins)
1. **Ontology object views + instance viewer.** The single biggest missing Foundry surface.
   Build a configurable per-object-type view (overview / properties / **linked objects** /
   timeseries chart / map) rendered from real AGE data. Without this, Loom has objects but no
   *object experience*. (Foundry 1.1-A8; grade F → target A−.)
2. **Ontology derived properties + functions-on-objects registry.** Rollups over links + a
   function runtime (ACA/Azure Functions) referenced by action validation and derived props.
   This unlocks the operational-loop value Foundry monetizes. (2.3; grade C/F.)
3. **AIP Logic → full Spindle Studio.** The backend is strong; the *studio* is the gap. Ship the
   3-pane layout, **debugger** (per-block cards + CoT + tool logs + proposed edits), **run
   history**, **unit tests + evals**, **version diff**, **publish-as-REST + Uses/curl**, and a
   model/settings panel. Wire **AIP Evals to gate publish** (evals-in-CI) — Foundry's key
   governance-of-AI story. (5.3/5.4; B+ → A.) Also: **refresh the stale `aip-logic.md` parity
   doc** — it describes a pre-block-graph editor that no longer exists.
4. **Workshop depth.** Add multi-page, **sections/overlays (drawer/modal)**, **conditional
   visibility**, real **Publish** (ACA+DAB+APIM), and the high-value B+ widgets: **object-view,
   links, map, pivot, timeline, and an AIP copilot widget** (Azure OpenAI). This is the app that
   sells the ontology. (4.1; B → A−.)

### P1 — Operational-loop maturity
5. **Ontology row/property-level security wired to objects & actions.** Enforce Entra-group ACL
   at `/objects` and `/run-action` (reuse the EH Phase-1 PDP/RLS pattern). Foundry's Restricted
   Views are table stakes for regulated buyers — and a natural Loom advantage via Entra. (2.x/6.3.)
6. **Dataset→object sync (OSv2) at scale + backfill status.** Move from item-level bind to a real
   sync pipeline with backfill progress and an AI-Search index over instances. (2.2.)
7. **Object Explorer polish** — histograms/facet charts, property-type-aware filters, and a
   full-page explorer mode; close to Foundry's exploration depth. (2.6.)
8. **Column-level lineage** in `/governance/lineage` (Monocle parity). (1.12.)

### P2 — Breadth completeness
9. **Ontology proposals/branches** (staged model review). (2.1.)
10. **Contour/Quiver/Fusion depth** — more analysis step types + save-as-dataset/export-to-report;
    live object-set binding into Fusion cells. (3.1/3.2/3.4.)
11. **Transforms project scaffold + branch/PR/CI UX** for Code Repositories parity. (1.8.)
12. **AIP Analyst embeddable widget** — conversational analytics that executes ontology actions
    from chat, embeddable in Workshop. (5.x; matches Foundry's March-2026 headline feature.)

---

## 5. Burn-the-box ideas (where Loom EXCEEDS Foundry by being Azure-native + open)

Foundry is a closed data plane on Palantir's cloud. Loom's structural advantage is that the
**ontology sits over the customer's existing Azure/OSS estate** — data Foundry would make you
re-platform. Lean into what a closed vendor *cannot* do:

1. **One ontology over Fabric + Power BI + Databricks + Synapse + ADX + Cosmos + AI Search —
   zero-copy.** Foundry must ingest into its own datasets/OSv2. Loom's object types already bind
   to ADLS Delta / Synapse SQL and materialize graph instances into AGE/ADX. Make the ontology a
   **federated semantic layer** over *whatever the customer already owns* (Databricks Unity
   Catalog tables, Fabric OneLake shortcuts, Power BI semantic models) without moving data.
   Foundry structurally can't — its moat is also its cage.
2. **Bring-your-own governed AI.** AIP is Palantir's LLM plumbing. Loom runs on the customer's
   **Azure OpenAI + AI Foundry** deployments with *their* RAI content-filter policies, model
   governance, private endpoints, and **sovereign/Gov-cloud** support. Loom already ships in
   **Azure Government** with OSS substitutions (UC, ADX, Synapse, AOAI-in-Gov) — a market Foundry
   serves only via bespoke deployments. Ship "ontology + agents in an air-gapped tenant, day one."
3. **Ontology-native MCP + open interop.** Expose every object type, action, and OSDK endpoint as
   **MCP tools + OpenAPI + Delta Sharing** so *any* external agent (Copilot, Claude, custom) can
   query objects and invoke governed actions. Foundry's OMCP is nascent and closed; Loom can make
   the ontology the **open agent-grounding layer for the whole Azure estate** — building on the
   existing deployable MCP catalog (`iq-mcp.ts`).
4. **Actions that write back to real Azure services, not a Foundry dataset.** Loom actions already
   execute as ACID graph transactions *and* can drive Synapse T-SQL CRUD, Azure Monitor alerts,
   Logic Apps, and Foundry Agent Service. Make ontology actions **orchestrate the customer's live
   Azure resources** (provision, remediate, notify) under one audited, human-gated model — an
   operational plane Foundry can only reach through connectors.
5. **Cost + openness.** No per-seat Foundry licensing; runs on the customer's Azure commitment;
   every backend is Azure-native or OSS and swappable. For price-sensitive/regulated buyers this
   is the entire pitch — pair it with the **21 one-click use-case apps** Loom already ships
   (Foundry has no equivalent turnkey catalog).
6. **Fabric/Power BI as an *opt-in accelerant*, not a dependency.** Because Loom is Fabric-optional
   (`no-fabric-dependency`), it can *offer* DirectLake/OneLake/Power-BI paths where a customer has
   Fabric, while never requiring it. Foundry can't ride Microsoft's BI stack at all. Position Loom
   as "Foundry's ontology + operational apps, but native to Microsoft's data platform."

---

## Sources
- Palantir docs — AIP overview, AIP Logic, AIP capabilities, AIP architecture:
  https://www.palantir.com/docs/foundry/aip · /docs/foundry/logic ·
  /docs/foundry/platform-overview/aip-capabilities · /docs/foundry/architecture-center/aip-architecture
- Palantir announcements — March 2026 (AIP Analyst), April 2026 (AIP Agent widget deprecation):
  https://www.palantir.com/docs/foundry/announcements/2026-03 · /announcements/2026-04
- Palantir Ontology / Workshop / OSDK concepts docs (cited inline in the Loom parity docs):
  ontology-manager, object-link-types, action-types, interfaces, shared-property, workshop/concepts-*,
  ontology-sdk/overview; Ontology MCP sample-architecture.
- Loom repo (files cited inline): `apps/fiab-console/lib/editors/ontology-model.ts`,
  `.../azure/weave-ontology-store.ts`, `.../azure/weave-explore.ts`,
  `.../editors/palantir/{ontology-sdk,aip-logic,slate-app,workshop-app,release-environment,health-check}-editor.tsx`,
  `.../editors/workshop/{workshop-app-builder,_workshop-model}.ts(x)`,
  `.../editors/phase4/{ontology,object-explorer-panel,analysis-board,fusion-sheet,notepad,map,graph-model}-editor.tsx`,
  `.../editors/{digital-twin-model,rayfin-app-editor,registry}.ts(x)`,
  `.../catalog/item-types/fabric-iq.ts`, `PRPs/active/foundry-parity/{PRP,AUDIT}.md`,
  `docs/fiab/parity/{ontology,workshop-app,aip-logic,ontology-sdk,pipelines,foundry-account}.md`.
