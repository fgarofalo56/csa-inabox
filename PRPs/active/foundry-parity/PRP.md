# PRP — Palantir Foundry FULL parity in Loom ("foundry-parity")

**Status:** ACTIVE (operator-requested 2026-07-16: "complete feature parity matrix and
mapping to everything Palantir Foundry offers … as good or better, grade A across all
aspects … using Azure + Microsoft + OSS, running only in Loom … out of the box day one
for any Azure cloud").
**Baseline already in Loom** (Weave epic + palantir editor family): ontology (Weave),
ontology-sdk, aip-logic, slate-app, loom-app (Workshop-class builder), workshop-app
editor, rayfin-app, digital-twin, release-environment, health-check, data-marketplace,
agent-flow, data-contract, DQ catalog, evaluation, activator, graph (ADX-native),
lineage, Purview governance, marketplace, Loom SDK, docs/migrations/palantir-foundry/
(20 docs incl. 65-feature Azure mapping).
**This PRP supersedes the migration-oriented mapping with a PRODUCT-parity matrix:**
every Foundry tool → the Loom surface that must exist and work, graded.

## Ground rules

- **Azure-native/OSS only on the default path** (`no-fabric-dependency`); identical
  capability in Commercial + Gov day one (Gov substitutes per the fabric-parity
  dual-cloud pattern: OSS UC, ADX, Synapse, AOAI-in-Gov, OSS tools on ACA).
- **Grade A per surface** = ui-parity inventory doc + ux-standards §7 checklist + real
  backend per control + browser E2E receipt + LearnPopover + docs page + walkthrough +
  branded icon (item-type-visual registry) + demo/sample content. "As good or better":
  where Loom already exceeds Foundry (canvas UX, Copilot depth, multi-cloud), that bar
  carries.
- Parity docs at `docs/fiab/parity/foundry-<slug>.md`; walkthroughs under
  `docs/fiab/tutorials/`; per-surface grades tracked in the matrix below.

## THE MATRIX — Foundry product inventory → Loom

Legend: **Loom surface** = item type/editor/page that answers it. **Status** seeded from
repo knowledge; Wave 0 audits every row live and re-grades (✅ built / η partial / ❌ missing).

### Pillar 1 — Data integration & engineering

| # | Foundry | What it is | Loom surface | Azure/OSS backend | Status |
|---|---|---|---|---|---|
| 1.1 | Datasets (transactional, versioned, branches) | Versioned data w/ time travel | lakehouse Tables + dataset views | Delta on ADLS (time travel, RESTORE) | η — expose version history/branch UX on lakehouse tables |
| 1.2 | Data Connection + Magritte connectors (200+) | Source connection mgmt | Linked Services + connectors catalog (70+) | ADF/Synapse linked services + Logic Apps connectors | η — connector catalog count + unified "Data Connection" hub page |
| 1.3 | Agent worker/proxy | On-prem access | SHIR (universalized) | Self-hosted IR, scale-to-0 | ✅ |
| 1.4 | Batch/CDC/streaming syncs | Ingest modes | data-pipeline Copy + mirrored-database (CDC) + eventstream | ADF copy / CDC / Event Hubs | ✅ |
| 1.5 | Media sets | Non-tabular data mgmt | lakehouse Files (+preview) | ADLS + preview/download | η — media-set semantics (typed collections, thumbnails, bulk tag) |
| 1.6 | Streams | First-class streaming datasets | eventstream + eventhouse | Event Hubs + ASA + ADX | ✅ |
| 1.7 | Pipeline Builder (visual batch+streaming, UDFs) | No-code pipeline canvas | data-pipeline canvas | Synapse/ADF pipelines; ASA for streaming | ✅ (verify UDF node + streaming mode) |
| 1.8 | Code Repositories (Transforms Py/Java/SQL, branch CI) | Repo-backed transforms | notebook + spark-job-definition + dbt + repos integration | Synapse Spark, dbt runner, GitHub | η — "transforms" project scaffold + branch-CI story in-product |
| 1.9 | Code Workspaces (hosted Jupyter/RStudio/VS Code) | Hosted IDEs | notebook editor (Monaco+pylsp) | Synapse Spark sessions; code-server on ACA (optional) | η — evaluate code-server item for full-IDE parity |
| 1.10 | Builds & schedules (job orchestration) | DAG builds, schedules | data-pipeline triggers + airflow-job + workspace-monitor | ADF triggers, Airflow, Monitor | ✅ |
| 1.11 | Data health / expectations / checks | Data quality gates | DQ catalog + data-contract + dbt tests | dbt tests / GE-style checks on Spark | η — check UX on datasets (freshness/schema/volume sentinels) |
| 1.12 | Data Lineage (Monocle) | Cross-platform lineage graph | /governance/lineage + Purview | Purview + Loom-native edge graph | η — column-level + cross-item completeness audit |
| 1.13 | Virtual tables | Zero-copy external | lakehouse-shortcut + mirrored-* | shortcuts, Synapse external tables | ✅ |
| 1.14 | Exports / external transforms | Push back out | publish-as-api + pipeline sinks + Delta Sharing | APIM, ADF sinks, Delta Sharing | ✅ |

### Pillar 2 — Ontology (the core moat — must be A+)

| # | Foundry | What it is | Loom surface | Azure/OSS backend | Status |
|---|---|---|---|---|---|
| 2.1 | Ontology Manager (object/link/action types, interfaces, shared props) | Semantic layer authoring | Weave ontology designer | Cosmos (ontology store) + ADX (instances) | η — interfaces + shared property types + type groups audit |
| 2.2 | Object storage/indexing (OSv2) | Scaled object instances, sync from datasets | ontology object sync | ADX tables + Cosmos + AI Search index | η — dataset→object sync pipelines UX + backfill status |
| 2.3 | Functions (on-object compute, derived props) | TS/Py functions over ontology | aip-logic + function items | Azure Functions / Container Apps + Loom fn runtime | η — function registry, versioning, derived-property binding |
| 2.4 | Actions (typed write-back + validation + side effects) | Governed edits | ontology action types | Loom action runtime → real backend writes + audit | η — action forms in apps, validation rules, webhooks/effects |
| 2.5 | OSDK (generated TS/Py/Java SDKs) | Type-safe app dev kit | ontology-sdk editor + Loom SDK | codegen service; npm/pip artifacts | η — generated-package pipeline E2E (download/publish) |
| 2.6 | Object Explorer | Search/filter/traverse objects, saved explorations | object explorer surface | AI Search + ADX + graph canvas | ✅ SHIPPED + E2E'd (#2195, search-fix #2197) — cross-type facets+search+traverse+saved over the AGE store; Explore tab. Live E2E rev 0000339: facets (Customer×2), traverse (real query), search returns matches. E2E caught a search bug (AGE-unsupported cypher → 0 rows), fixed to JS filtering (#2197) |
| 2.7 | Vertex (graph exploration/simulation) | Interactive object graph | graph item (gql-graph) + ontology overlay | ADX graph semantics | η — ontology-aware layer on graph canvas |
| 2.8 | Semantic search / OAG | Vector search over objects | ai-search-index + ontology embeddings | AI Search vectors + AOAI embeddings | η — one-click "embed ontology" + retrieval in agents |

### Pillar 3 — Analytics

| # | Foundry | What it is | Loom surface | Azure/OSS backend | Status |
|---|---|---|---|---|---|
| 3.1 | Contour (path-based point-and-click analysis) | Board-based dataset analysis | **NEW: analysis-board item** | Synapse serverless/ADX behind step DAG; each board step = query node | ❌ build (Loom's biggest analytics gap) |
| 3.2 | Quiver (object + time-series analysis, dashboards) | Object-centric cards/canvas | rayfin-app | ADX timeseries + ontology objects | η — audit vs Quiver card catalog (~30 card types) |
| 3.3 | Notepad (live-data documents) | Docs w/ embedded live queries/objects | **NEW: notepad item** | Loom-native doc model (Cosmos) + embedded query/visual blocks | ❌ build |
| 3.4 | Fusion (spreadsheets on live data) | Spreadsheet UX | **NEW: fusion-sheet item** | OSS sheet engine (e.g. Univer/Luckysheet) on ACA + Loom data binding | ❌ build (evaluate OSS; Excel-online embed is not all-clouds) |
| 3.5 | Map (geotemporal layers) | GIS app | map visual + GEO-1/2 program | Azure Maps + ADX geo + GeoAnalytics | η — dedicated map workspace surface |
| 3.6 | Time series (Codex) | Sensor/TS mgmt | eventhouse + kql-dashboard + rayfin | ADX native TS functions | ✅ |
| 3.7 | Reports/dashboards | BI surfaces | report designer + kql-dashboard + semantic-model | Loom-native renderer + AAS + optional PBI | ✅ |
| 3.8 | Notebooks/Code Workbook | Exploratory code | notebook item | Synapse Spark | ✅ |

### Pillar 4 — App building & automation

| # | Foundry | What it is | Loom surface | Azure/OSS backend | Status |
|---|---|---|---|---|---|
| 4.1 | Workshop (object-centric low-code apps) | Widget-based app builder | loom-app (+ workshop-app editor) | Loom app runtime (ACA) + ontology binding | η — widget catalog parity audit (~40 Workshop widgets), variables/events model |
| 4.2 | Slate (custom HTML/JS apps) | Pro-code dashboards | slate-app | Loom app runtime; sandboxed JS | η |
| 4.3 | Dev Console + OSDK apps | External app registration | developer platform + OBO + publish-as-api | Entra app reg + APIM + OSDK | η |
| 4.4 | Foundry Rules (Taurus) | No-code business rules | **NEW: rules item** (or DQ+activator composite) | Loom rules engine (JSON-logic/OSS rules on ACA) → actions | ❌ build |
| 4.5 | Automate (object monitors → effects) | Event-driven automation | activator + agent-flow | Monitor alerts, Logic Apps, Functions | η — object-condition monitors on ontology |
| 4.6 | Approvals | Human-in-the-loop gates | **NEW: approvals framework** (per-action) | Loom approvals service (Cosmos) + Teams/email via Logic Apps | ❌ build |
| 4.7 | Checkpoints (justifications) | Friction/justify sensitive ops | audit + MIP labels | Loom checkpoint middleware + audit log | ✅ SHIPPED + E2E'd (#2196, dialog-parity #2198) — per-action requiresJustification gate (HTTP 422 without a reason); reason recorded to Cosmos audit chain w/ actor+target+outcome; Checkpoints review table. Live E2E rev 0000339: gated action authored (badge shows both surfaces), run blocked without reason, ran with reason (real AGE vertex + recorded), review table shows actor/reason/outcome. E2E caught a two-surface gap (toggle missing in the Typed-model dialog), fixed #2198 |
| 4.8 | Machinery (process mining) | Process discovery | **evaluate**: PM4Py on Spark + dashboard | OSS pm4py; ADX for event logs | ❌ backlog (phase 2) |

### Pillar 5 — AI Platform (AIP)

| # | Foundry | What it is | Loom surface | Azure/OSS backend | Status |
|---|---|---|---|---|---|
| 5.1 | AIP Assist | Platform copilot | Loom Copilot (in-product) | AOAI + RAG corpus | ✅ (exceeds: gate resolution, per-surface) |
| 5.2 | AIP Agent Studio | Agents w/ ontology tools | agent-flow + data-agent | AI Foundry agents / MAF + Loom tools | η — ontology-tool binding (query objects, invoke actions) |
| 5.3 | AIP Logic | No-code LLM functions | aip-logic editor | AOAI + function runtime | η — audit blocks vs Logic's block set; publish-as-function |
| 5.4 | AIP Evals | Eval suites for functions/agents | evaluation item | Loom eval runner + AOAI | η — wire evals to aip-logic/agents CI |
| 5.5 | Modeling objectives / model mgmt | Train→stage→release w/ approvals | ml-model + automl + release-environment | AML registry / MLflow + approvals | η — staged-release flow + approvals hookup |
| 5.6 | External/bring-your-own models | Model catalog + adapters | model strategy (AIF-12 router) | AOAI, AI Foundry catalog, ONNX | ✅ |
| 5.7 | Vector/embedding infra | Semantic retrieval | ai-search-index | AI Search vectors | ✅ |

### Pillar 6 — Governance, security & platform ops

| # | Foundry | What it is | Loom surface | Azure/OSS backend | Status |
|---|---|---|---|---|---|
| 6.1 | Projects/Compass (folders, resource org) | Workspace/project tree | workspaces + domains + folders | Cosmos + workspace guard | ✅ |
| 6.2 | Multipass (identity, orgs, tokens) | IdP + service users + tokens | Entra + OBO + PAT story | Entra ID, managed identities | η — scoped service tokens UX |
| 6.3 | Granular permissions + Restricted Views | Mandatory + row-level security | permissions + access-policy wizard + RLS | Storage RBAC, SQL RLS, UC grants, OBO | η — row-policy authoring UX on datasets/objects |
| 6.4 | Markings & classifications | Data classification enforcement | MIP labels + Purview classifications | Purview + MIP | ✅ |
| 6.5 | Audit logs | Full audit trail | /admin/audit + item audit | Cosmos audit + LAW | ✅ |
| 6.6 | Resource mgmt (compute usage/credits) | Usage accounting | /admin/usage + chargeback + cost | Cost Mgmt + LAW usage | ✅ |
| 6.7 | Control Panel | Admin settings | /admin suite (23 pages) | — | ✅ |
| 6.8 | Apollo (upgrade orchestration) | Safe rolling upgrades | Updates + release trains + self-update | GH releases + ACA rolls + agent-pool builds | ✅ |
| 6.9 | Marketplace + packaged products (DevConsole packaging) | Install/ship products | marketplace + use-case apps + app bundles | Loom bundle format + provisioners | ✅ (exceeds: 21 one-click apps) |
| 6.10 | Data lifetime/retention + export controls | Retention, egress governance | **NEW: retention policies + export-control gates** | ADLS lifecycle, Purview DLP, policy middleware | ❌ build (thin v1: lifecycle policies UI + export audit) |

### Pillar 7 — Interop, APIs & developer experience

| # | Foundry | What it is | Loom surface | Azure/OSS backend | Status |
|---|---|---|---|---|---|
| 7.1 | REST API v2 + webhooks | Platform API | BR-OPENAPI + publish-as-api + webhooks | APIM + Loom BFF APIs | ✅ |
| 7.2 | CLI + SDKs | Automation | Loom SDK + Terraform + SCIM | — | ✅ |
| 7.3 | Git/CI integration | Branch-based dev | repos integration + gh-aca-runner | GitHub | η — in-product branch/PR UX for transforms |
| 7.4 | Docs/examples/walkthroughs | Learning surface | /learn hub + tutorials + LearnPopovers | — | η — Foundry-track: per-pillar walkthroughs w/ visuals |

**Tally: 18 ✅ · 24 η (partial — audit + close) · 9 ❌ (net-new builds: analysis-board
(Contour), notepad, fusion-sheet, object-explorer, rules engine, approvals, checkpoints,
retention/export controls, process mining[phase-2]).**

## Net-new object types to register (catalog category: “Foundry-class tools” inside csa-data-products / fabric-iq family)

`analysis-board`, `notepad`, `fusion-sheet`, `object-explorer` (page-level surface, not
item), `rules`, `approval-policy` (admin-level), plus `code-workspace` (optional
code-server). Each gets: manifest entry, branded icon (item-type-visual), Create card,
guided EmptyState, LearnPopover, provisioner (Azure-native), editor at ux-standards §7,
parity doc, tutorial with screenshots, demo seed content.

## Wave plan

- [ ] **W0 — Live parity audit (START HERE):** walk every matrix row against the live
      product (minted-session + browser), re-grade ✅/η/❌, produce
      `PRPs/active/foundry-parity/AUDIT.md` gap register with per-row missing-capability
      bullets. Deliverable feeds every later wave. (~1 session)
- [ ] **W1 — Ontology to A+:** close 2.1–2.8 gaps (interfaces, shared props, object sync
      UX, derived props, action effects/validation, OSDK package E2E, object explorer,
      Vertex overlay, ontology embeddings). Ontology is Foundry's moat — this wave is the
      program's center of gravity. (~2 sessions)
- [ ] **W2 — Contour-class analysis-board item:** path-based boards (filter/join/derive/
      pivot/chart steps) compiling to Synapse-serverless/ADX; save-as-dataset; export to
      report. Canvas per node-kit; step results grid w/ type badges. (~2 sessions)
- [ ] **W3 — Workshop/Slate/Quiver depth:** widget-catalog audit vs Workshop, variables/
      events, action forms; rayfin card parity; app-builder docs + 3 walkthrough apps. (~2 sessions)
- [ ] **W4 — Rules + Automate + Approvals + Checkpoints:** rules item (JSON-logic engine
      on ACA), ontology object monitors in activator, approvals framework on action
      types + sensitive admin ops, checkpoint middleware. (~1.5 sessions)
- [ ] **W5 — Notepad + Fusion:** live-data documents (block editor w/ embedded
      queries/visuals/objects); OSS spreadsheet engine evaluation (Univer first) + data
      binding; both all-clouds. (~2 sessions)
- [ ] **W6 — Data-eng tail:** dataset version/branch UX, media sets, data-health
      sentinels, Data Connection hub, transforms scaffold + branch CI, code-workspace
      decision. (~1.5 sessions)
- [ ] **W7 — AIP tail:** agent ontology-tools, aip-logic block parity, evals-in-CI,
      staged model releases w/ approvals. (~1 session)
- [ ] **W8 — Governance tail + all-clouds pass:** retention/export controls, row-policy
      authoring, scoped tokens; then full Gov browser pass of every new surface. (~1.5 sessions)
- [ ] **W9 — Docs/visuals/walkthrough sweep + final grading:** Foundry-track in /learn,
      per-pillar tutorials w/ screenshots, parity docs all zero-❌, final A-grade matrix
      published at docs/fiab/parity/foundry-index.md. (~1 session)

## Verification bar (every wave)

Per `no-vaporware`/`ui-parity`/`ux-baseline`: real backend per control, browser E2E
receipt per surface (Commercial + Gov for new items), parity doc zero-❌, §7 checklist,
screenshots in PR, demo seed data. Final claim "on par or better than Foundry" requires
the W0 audit re-run at W9 showing every row ✅ with grade A.
