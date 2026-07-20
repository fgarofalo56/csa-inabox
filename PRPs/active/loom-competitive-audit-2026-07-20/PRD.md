# CSA Loom — Burn-the-Box: The #1 Data + AI + Agents Platform

- **Date:** 2026-07-20
- **Author:** PI synthesis agent (competitive-audit deliverable)
- **Status:** Draft for PRP conversion
- **Scope:** Repository-wide build plan that (a) closes every graded parity gap vs Microsoft Fabric, Power BI, Palantir Foundry, Databricks, Azure AI Foundry, and the frontier agentic labs, AND (b) ships the burn-the-box differentiators only Loom can build.
- **Companion deliverables (same dir):** `PARITY-MATRIX.md` (graded, per-domain), `FINDINGS-REPORT.md` (gap register + vision), research `01`–`05`.
- **Primary path:** `E:\Repos\GitHub\csa-inabox\PRPs\active\loom-competitive-audit-2026-07-20\PRD.md`

---

## 1. Vision

**Competitors make the customer the integration layer between their products. Loom IS the integration layer.** Microsoft Fabric is seven separate experiences sharing a capacity; Databricks is a lakehouse + ML with bolted-on BI; Palantir Foundry is an ontology + pipelines without RTI/BI/warehouse at parity; the frontier labs reach data through connectors from *outside* the tenant. Loom is one console — 132 item types, 132 registered editors, 1,473 BFF routes, 370 Azure clients, 148 bicep modules — over Azure-native + OSS backends, **sovereign from Commercial to IL5, with no hard Microsoft Fabric dependency**.

**The goal of this PRD:** make Loom unambiguously the #1 platform by (1) closing the concentrated gaps that hold it at B+/A− against each competitor individually, and (2) shipping the integration-and-sovereignty differentiators that a single-product vendor structurally cannot ship.

## 2. Problem statement

Loom is a genuine **B+ / A−** against each competitor individually, but three problem classes cap it below "unambiguously #1":

1. **Whole-platform quality cap.** The model tier-router is a safe no-op without tier deployments, so every AI surface rides one default model regardless of orchestration.
2. **Concentrated parity holes.** Feature Store (D), Model Serving (C+), LLM fine-tuning (F), Direct Lake (D), OneLake shortcuts (C), report Format-pane (partial), ontology object views/derived-props (F), AIP-Logic studio depth, a frontier-grade agent-builder, A2A interop (F).
3. **UX + trust debt at scale.** 5 monolith editors + 8 aggregate modules, canvas-standard coverage on only ~11 surfaces, IA redirect-shims, and parity-doc drift under a 112-page × 132-editor × 1,473-route surface.

## 3. Goals and non-goals

### Goals
- Close every **P0/P1** gap in `FINDINGS-REPORT.md §2` to at-or-above the competitor grade, with real backends and browser-E2E receipts.
- Ship **≥ 8 of the 12 burn-the-box differentiators** (BTB-1…BTB-12) as production surfaces.
- Lift the composite grade from **B+/A−** to **A / A+** on every domain in `PARITY-MATRIX.md`.
- Retire the concentrated UX debt (monoliths, aggregates, canvas coverage, IA, parity-doc currency).

### Non-goals
- Re-architect the product into a new framework.
- Require a real Microsoft Fabric / Power BI / Palantir / Databricks capacity for any default path (`no-fabric-dependency`).
- Remove honest gates where a backend dependency is genuinely optional/unavailable.
- Match every long-tail competitor feature in one wave — breadth follows the P2 tail.

## 4. Product principles (die-hard rules — non-negotiable)

Every item in this PRD is bound by the repo's die-hard rules; a deliverable is not "done" until all apply:

1. **No-vaporware** (`no-vaporware.md`) — front-end + BFF route + real Azure backend; no mock arrays / `return []` / `useState(MOCK)`; honest MessageBar gates only.
2. **UI parity** (`ui-parity.md`) — feature-for-feature with the Azure/Fabric/Foundry source UI; a per-surface parity doc `docs/fiab/parity/<slug>.md` showing zero ❌.
3. **UX baseline G1/G2/G3** (`ux-baseline.md`) — **G1:** browser E2E with real data before "done" (tsc + vitest + DOM strings ≠ done); **G2:** zero day-one gates, every gate has an inline "Fix it" wizard + gate-registry entry + Admin gate page; **G3:** resizable `SplitPane` panels with persisted `sizingKey`. Plus node compactness (§9.4), badge-wrap (§9.5), clean first-open (§9.6).
4. **No-fabric-dependency** (`no-fabric-dependency.md`) — Azure-native backend is the DEFAULT; Fabric/PBI opt-in only via `LOOM_<ITEM>_BACKEND`.
5. **Web 3.0 UI** (`web3-ui.md`) — Fluent v9 + Loom tokens, shared primitives (`PageShell`/`TileGrid`/`EmptyState`/`honest-gate`), no hard-coded px/hex.
6. **Sovereign-by-default** — every new surface works Commercial + Gov (GCC/GCC-High/IL5) with OSS substitution where a service is unavailable; bicep-synced per `no-vaporware` §Bicep-sync.
7. **Docs are product** — parity doc + Learn drawer content + bicep sync land in the same PR as the feature.

## 5. Workstream map

Gap-closure (parity) and burn-the-box (net-new) run in parallel; net-new depends on specific gap-closures noted per item.

| WS | Name | Type | Primary competitor(s) closed |
|---|---|---|---|
| **WS-1** | Model Fabric Foundation (tier-router + serving + fine-tuning + eval/obs) | Parity + enables BTB-6 | AI Foundry, Databricks, frontier labs |
| **WS-2** | ML Platform Completion (Feature Store, Vector Search, AI/BI dashboards) | Parity + enables BTB-7 | Databricks |
| **WS-3** | Fabric/PBI Parity Holes (Direct Lake, OneLake shortcuts, Format-pane, Eventstream 2026, ADX grid) | Parity | Fabric, Power BI |
| **WS-4** | Foundry Moat Depth (object views, derived props, functions-on-objects, object security, OSv2 sync, Workshop, AIP-Logic studio, Object Explorer) | Parity + enables BTB-1 | Palantir Foundry |
| **WS-5** | Agentic Product Surface (agent-builder canvas, A2A, evals+obs product page, conversational code-interpreter, NL-everywhere) | Parity + enables BTB-4/9 | Frontier labs, Foundry Agent Service |
| **WS-6** | Ontology-Over-Everything (the substrate) | Burn-the-box BTB-1 | all — un-copyable |
| **WS-7** | Closed-Loop Model Fabric | Burn-the-box BTB-6 | all — un-copyable |
| **WS-8** | NL-to-Full-Estate + One-Canvas Authoring | Burn-the-box BTB-3, BTB-5 | all — un-copyable |
| **WS-9** | Sovereign Agent Mesh + MCP/A2A Hub | Burn-the-box BTB-4, BTB-9 | all — un-copyable |
| **WS-10** | Self-Driving Platform + Governance-as-Code + Time-Machine + Living Marketplace + Parity Autopilot | Burn-the-box BTB-2/8/10/11/12 | all — un-copyable |
| **WS-11** | UX Debt & Trust (monolith/aggregate decomposition, canvas coverage, IA, parity-doc currency, E2E receipts) | Refactor | operator UX baseline |

---

## 6. Workstreams — epics, items, acceptance

Every acceptance criterion below implies the WS-level definition of done in §8 (real backend, G1 browser-E2E receipt, G2 zero-gate + Fix-it, G3 SplitPane, parity doc zero-❌, bicep-synced, sovereign). Per-item criteria call out the surface-specific bar.

### WS-1 — Model Fabric Foundation

**1.1 Wire the model tier-router for real** *(P0-1, effort S, highest leverage)*
- **Problem:** `model-tier-router.ts` is a safe no-op without tier deployments; every copilot/agent/data-agent turn rides one default AOAI deployment, capping quality regardless of orchestration.
- **Deliverables:** default 3-tier config (mini / standard / **reasoning**) bound to the best AOAI reasoning deployment available per cloud (Commercial + Gov); `resolveTierForTurn` routes hard analytical/agentic turns to the strong tier; admin-tunable in `env-config`; gate-registry entry when no reasoning deployment exists (with Fix-it to deploy one).
- **Acceptance:** a hard analytical turn demonstrably routes to the reasoning tier (trace shows tier selection); no-op only when the admin opts out; browser-E2E on a copilot turn shows tier attribution; works in Gov with `*.openai.azure.us`.

**1.2 Model Serving as a first-class item** *(P0-3, effort M)*
- **Problem:** `serving-endpoints/route.ts` is CRUD-only — no serving editor, traffic-split, or monitoring.
- **Deliverables:** a `model-serving-endpoint` item + editor over Databricks Mosaic Serving *and* Foundry managed online endpoints (Azure-native default); traffic-split, autoscale, provisioned-throughput config, invocation console, latency/error monitoring.
- **Acceptance:** create endpoint → split traffic 80/20 → invoke from the console → see live latency/error tiles, all against a real backend; honest-gate when no serving backend configured.

**1.3 LLM fine-tuning item** *(P0-4, effort M)*
- **Problem:** no fine-tuning surface (AutoML only).
- **Deliverables:** a `fine-tuning-job` item over AOAI/Foundry serverless + managed-compute FT, with training-data-eval + resulting-model-safety-eval gates (Foundry RAI); optional Mosaic FT when Databricks is the chosen backend.
- **Acceptance:** submit a FT job on real data → safety-eval gate runs → resulting model registers and is deployable via 1.2; browser-E2E receipt.

**1.4 Unified Agent Evals + Observability product page** *(P1-7, effort M)*
- **Problem:** eval/obs plumbing exists (`apps/copilot/evals/`, `foundry/evaluations`, `agentops.ts`, `ai-red-team`) but is scattered across routes, not a product surface.
- **Deliverables:** one Admin "Agent Quality" page — eval sets, LLM-judge scores, regression-vs-baseline, red-team results, per-agent trace timeline, cost/latency SLOs.
- **Acceptance:** an eval run + a red-team run + a live trace all render on one page with real data; drill-down to a failing turn.

**1.5 GenAI eval depth + observability span-tree** *(P1-10 + P1-11, effort M)*
- **Deliverables:** built-in evaluator library (groundedness/relevance/tool-call-accuracy/task-adherence) + `mlflow.evaluate`-style one-click judge + cluster-analysis of eval failures; full OTel span waterfall with token/latency/error rollups + continuous-eval alerts (Azure Monitor).
- **Acceptance:** one-click judge scores a data-agent output; a multi-tool agent turn renders as a span tree; a regression fires a Monitor alert.

### WS-2 — ML Platform Completion

**2.1 Feature Store** *(P0-2, effort L; foundation for BTB-7)*
- **Problem:** no feature-table authoring, PIT joins, or feature-lookup-at-serving (grade D).
- **Deliverables:** a `feature-table` item over UC feature tables + `online-tables` + Lakebase/pgvector for online serving; point-in-time join builder; feature-lookup-at-serving wired into 1.2; UC-governed.
- **Acceptance:** author a feature table → PIT-join to a training set → serve online with a feature lookup at inference, all real backend; Gov path via OSS-UC + pgvector.

**2.2 Managed Vector Search** *(P1-9, effort M)*
- **Deliverables:** make `vector-store` Delta-synced auto-indexed (incremental from a lakehouse/UC table) with reranking, rather than manual population.
- **Acceptance:** point at a Delta table → index auto-syncs incrementally → hybrid query + rerank returns results; no manual re-population.

**2.3 AI/BI dashboards** *(P1-8, effort M)*
- **Deliverables:** AI-authored visualization + one-click forecasting + key-driver analysis on the semantic-model/report path.
- **Acceptance:** "explain this metric" generates a forecast + key-driver viz over real rows.

### WS-3 — Fabric/PBI Parity Holes

**3.1 report-designer Wave-6 Format-pane** *(P0-7, effort M)*
- **Problem:** adapter (`loom-chart-format.ts`) + chrome (`visual-chrome.tsx`) built but unwired; per-axis/title/legend/effects cards MISSING — the biggest quality gap in the flagship PBI surface.
- **Deliverables:** wire the format-pane cards (per-axis/title/legend/effects/data-labels) to the VisualBody integration seam.
- **Acceptance:** every visual type's format-pane cards paint and persist against a live AAS model; parity doc `report-designer.md` Wave-6 shows zero ❌.

**3.2 OneLake zero-copy shortcuts engine** *(P0-5, effort L)*
- **Problem:** honest-gate today; the Azure-native engine is a design doc.
- **Deliverables:** ADLS Gen2 + Synapse Serverless / Databricks UC external tables + Cosmos `lakehouse-shortcuts` registry (UAMI-backed); wires lakehouse federation + KQL/eventhouse shortcuts + mirrored-db landing.
- **Acceptance:** create a shortcut to an external ADLS/S3/UC location → query it zero-copy from the lakehouse SQL endpoint; no Fabric REST on the default path.

**3.3 Direct Lake substitute** *(P0-6, effort M)*
- **Deliverables:** AAS/tabular DirectQuery over Synapse Serverless external Delta + aggressive result caching + a "framing" refresh; marketed as the Direct-Lake parity.
- **Acceptance:** a semantic model over lake data answers at import-like latency with no manual refresh; parity doc closes the honest-gate with a real perf path (not a PBI-Desktop deferral).

**3.4 Eventstream 2026 features** *(P1-12, effort M)* — SQL operator, AI Skills (NL→eventstream), Business Events publisher. **Acceptance:** each new operator/skill runs against real Event Hubs + ASA.

**3.5 ADX results grid to A** *(P1-13, effort S)* — column stats, in-grid filter/search, CSV export polish. **Acceptance:** `adx-kusto.md` results-grid grade C+ → A with a browser-E2E receipt.

### WS-4 — Foundry Moat Depth

**4.1 Ontology object views + instance viewer** *(P0-8, effort M; foundation for BTB-1)*
- **Problem:** objects exist (AGE store) but there is no per-instance *object experience* (grade F).
- **Deliverables:** configurable per-object-type view (overview / properties / **linked objects** / timeseries chart / map) rendered from real AGE data.
- **Acceptance:** open an object instance → see its properties, linked objects (traversed from AGE), a timeseries, and a map, all real data; parity doc row Foundry-1.1-A8 F → A−.

**4.2 Derived properties + functions-on-objects registry** *(P1-2, effort L)*
- **Deliverables:** rollups/aggregations computed from linked objects + a function runtime (ACA/Azure Functions) referenced by action validation and derived props; a function registry with versioning.
- **Acceptance:** a derived property rolls up a linked-object aggregate live; an action validation calls a registered function.

**4.3 Ontology object-level security** *(P1-4, effort M)*
- **Deliverables:** Entra-group ACL enforced at `/objects` + `/run-action` (reuse the EH Phase-1 PDP/RLS pattern); row/property-level markings.
- **Acceptance:** a restricted group cannot read masked properties or submit gated actions; enforced server-side (403/422) + audited.

**4.4 Dataset→object sync (OSv2) at scale** *(P1-15, effort M)* — real sync pipeline + backfill progress + AI-Search index over instances. **Acceptance:** bind a dataset → backfill runs with visible progress → instances searchable.

**4.5 Workshop depth** *(P1-3, effort L)*
- **Deliverables:** multi-page, sections/overlays (drawer/modal), conditional visibility, real Publish (ACA+DAB+APIM), and the B+ widgets: object-view, links, map, pivot, timeline, AIP-copilot.
- **Acceptance:** build a 2-page app with an overlay + an object-view widget + an AIP-copilot widget → Publish to a live URL over real data.

**4.6 AIP-Logic → full Spindle Studio** *(P1-1, effort L)*
- **Deliverables:** 3-pane layout, debugger (per-block cards + CoT + tool logs + proposed edits), run history, unit tests + **evals wired to gate publish (evals-in-CI)**, version diff, publish-as-REST + Uses/curl, model/settings panel; **refresh the stale `aip-logic.md`**.
- **Acceptance:** author a typed Logic function → debug per-block → gate publish on an eval suite → publish as REST with a working curl; parity doc current.

**4.7 Object Explorer polish** *(P1-14, effort M)* — histograms/facet charts, property-type-aware filters, full-page mode. **Acceptance:** facet + histogram over real AGE instances.

### WS-5 — Agentic Product Surface

**5.1 Visual agent-builder canvas at frontier polish** *(P1-5, effort L; foundation for BTB-4/5)*
- **Deliverables:** elevate `agent-flow-canvas.tsx` to drag agents + tools + MCP servers + ontology objects onto a canvas, wire handoffs, set guardrails/evals inline, publish as MCP/API.
- **Acceptance:** build a 3-agent flow with an MCP tool + an ontology-object tool + a handoff → run it end-to-end → publish as MCP; G3 SplitPane, canvas-node-kit compliant.

**5.2 A2A protocol support** *(P1-6, effort M; foundation for BTB-9)*
- **Deliverables:** A2A agent cards + task delegation; expose ontology objects/actions/OSDK endpoints as A2A tasks; egress via gov-safe profiles.
- **Acceptance:** an external ADK/Foundry agent delegates a task into Loom and receives a governed result; a Loom agent registers as an A2A agent card.

**5.3 Conversational code-interpreter** *(P2-11, effort M)* — in-chat ephemeral Python sandbox (Spark-serverless or ACA job) over governed lakehouse data with generated charts. **Acceptance:** "analyze this table" runs sandboxed Python → returns a chart, governed + audited.

**5.4 NL-"ask" affordance everywhere** *(P2-12, effort M)* — every table/report/dashboard/ontology object gets an "ask" backed by `data-agent-client.ts`. **Acceptance:** the same NL affordance answers on ≥ 5 surface kinds.

**5.5 Reasoning-mode data agents** *(P1-16, effort S; depends on 1.1)* — planner→execute→verify loop on the reasoning tier. **Acceptance:** a multi-hop question shows a plan then executes it.

### WS-6 — Ontology-Over-Everything (BTB-1)
- **Problem/Deliverables/Acceptance:** promote the ontology to the substrate every item binds to — ontology-binding annotations on every item's Cosmos state; an "ontology resolver" middleware rewriting SQL/KQL/DAX to ontology objects; a `bind-to-ontology` Weave on every `notebookAttachable` type; zero-copy binding over UC tables / OneLake shortcuts / PBI models. **Acceptance:** a lakehouse table, a KQL stream, and a semantic measure all resolve as typed instances of one ontology object; a copilot query grounds through the ontology graph; lineage + access policy resolve through the ontology. Depends on WS-4 (object views/security) + WS-3.2 (shortcuts for zero-copy bind).

### WS-7 — Closed-Loop Model Fabric (BTB-6)
- **Deliverables:** fuse `model-tier-router` (routing) + `agent-eval`/`red-team` (eval) + `serving-endpoints` (serving) + `agentops`/`copilot-slo` (obs) into a self-optimizing loop — continuous eval + red-team feed the tier-router weights and a serving traffic-split automatically (promote live-eval winners, demote regressions), logged to the gate registry + `admin/model-fabric` page. **Acceptance:** a model/prompt that wins live eval is auto-promoted in traffic-split; a regression is auto-demoted; every action audited. Depends on WS-1.1 + WS-1.2.

### WS-8 — NL-to-Full-Estate + One-Canvas Authoring (BTB-3, BTB-5)
- **8.1 NL-to-Full-Estate:** a planner over `copilot-orchestrator` emits a `plan-model` DAG of Weave actions from one prompt (create lakehouse → medallion → semantic model → report → API → data agent → governance) with dry-run + diff + approve; reuse `proposed-change`/`apply-change`. **Acceptance:** one prompt produces a reviewable plan that executes the full chain via the 13 Weave bridges. Depends on WS-1.1.
- **8.2 One-Canvas Cross-Workload Authoring:** typed cross-workload node registry over `canvas-node-kit` + React Flow; nodes = table/notebook/KQL/measure/ontology-object/model/agent/report; edges = ThreadActions; publish = a `plan-model`; G3 SplitPane shell. **Acceptance:** author + execute an ingest→transform→serve→visualize→publish topology on one canvas.

### WS-9 — Sovereign Agent Mesh + MCP/A2A Hub (BTB-4, BTB-9)
- **Deliverables:** extend `connected-agents.ts` + MAF into an agent-registry over Cosmos; per-agent MCP tool scoping via `data-agent-mcp`; policy check on every inter-agent call through `access-policy-client`; Tier-0 air-gap-safe tool catalog + Gov AOAI direct; combine with WS-5.2 A2A so external agents delegate in and Loom agents publish out. **Acceptance:** a governance agent + pipeline agent + BI agent complete a task entirely in-VNet with Purview/DLP enforcement, nothing leaving the boundary, in a Gov config. Depends on WS-5.1/5.2.

### WS-10 — Self-Driving + Governance-as-Code + Time-Machine + Living Marketplace + Parity Autopilot
- **10.1 LCU-Autopilot (BTB-2):** LCU telemetry → policy engine over gate/self-audit → `env-config` revision rolls as actuator → `admin/autopilot`. **Acceptance:** auto-pauses idle compute + files a self-executing FinOps recommendation on approval.
- **10.2 Governance-as-Code (BTB-8):** a `policy-as-code` DSL → per-backend compilers (extend the SQL DENY compiler to UC + Purview + ADX + API scopes) → reconcile loop → `admin/policy-code` page + `loom policy apply`. **Acceptance:** one policy set compiles to ≥ 4 backends in one pass + self-heals drift; works with no Databricks/Fabric capacity (OSS-UC).
- **10.3 Time-Machine (BTB-10):** a temporal coordinator resolving each backend's native time-travel to one `asOf` param; branch = shadow workspace; global time bar in `PageShell`. **Acceptance:** query ontology + report + pipeline output as of timestamp T.
- **10.4 Living Marketplace (BTB-11):** unify data/agent/MCP/app/ontology product types under one Cosmos `marketplace` schema; publish pipeline runs the existing gates as auto-certification; entitlement via access-governance; billing via LCU chargeback. **Acceptance:** publish an agent + an ontology as certified, subscribable products.
- **10.5 Parity Autopilot (BTB-12):** Playwright capture → vision-model diff vs the 423 parity docs → `plan-model` + `gh issue` filing on a schedule. **Acceptance:** a scheduled run auto-files a real gap with a proposed plan.

### WS-11 — UX Debt & Trust
- **11.1 Monolith decomposition** (`lakehouse-editor-shell` 5,227, `report-designer` 5,135, `semantic-model-editor` 4,576, `notebook-editor` 3,875, `apim-editors` 3,580) → < 1,500 LOC/module by bounded context + focused unit tests. **Acceptance:** each target below 1,500 LOC (or justified exception); behavior parity.
- **11.2 Aggregate module split** (foundry-sub / powerplatform / copilot-studio / azure-sql / azure-services / geo / graph / phase2-misc editors) → per-item files.
- **11.3 Canvas-standard coverage** — migrate hand-built topology views (`model-view-canvas.tsx`, `graph-editors.tsx`) to `canvas-node-kit` + `CanvasRightRail` + `SplitPane`. **Acceptance:** every topology surface passes the mandatory-canvas checklist.
- **11.4 IA consolidation** — resolve `governance/sensitivity|classifications|domains` redirect-shims into one route tree.
- **11.5 Parity-doc currency** — staleness detector (`scripts/ci/check-parity-doc-freshness.mjs`, doc→source map, `Reviewed-on`/`Validated-against` metadata) in `loom-guardrails.yml`; re-baseline priority docs incl. `aip-logic.md`.
- **11.6 Browser-E2E receipt sweep (G1)** *(P2-17)* — `loom-uat` receipts for code-complete "A" surfaces; standing gate. **Acceptance:** each "A per code+tests" surface gets a screenshot/trace receipt.

---

## 7. Sequencing / waves

| Wave | Weeks | Contents |
|---|---|---|
| **W1** | 0–3 | WS-1.1 (tier-router), WS-3.1 (Format-pane), WS-3.5 (ADX grid), WS-11.1 (2 worst monoliths), WS-11.5 (staleness detector + `aip-logic.md`), start WS-11.6 receipts |
| **W2** | 3–7 | WS-4.1 (object views), WS-1.2 (Model Serving), WS-1.4 (Agent Quality page), WS-5.5 (reasoning data agents), continue WS-11.1/11.2 |
| **W3** | 7–12 | WS-3.3 (Direct Lake), WS-3.2 kickoff (shortcuts), WS-2.1 kickoff (Feature Store → BTB-7 seed), WS-4.6 kickoff (Spindle Studio), WS-10.2 first compiler, WS-11.3 canvas coverage |
| **W4** | 12–18 | Complete WS-2.1, WS-3.2, WS-1.3 (fine-tuning); WS-4.2/4.3/4.5 (moat depth); **WS-6 Ontology-Over-Everything**; WS-7 Closed-Loop Model Fabric |
| **W5** | 18–26 | WS-8 (NL-to-Full-Estate + One-Canvas); WS-5.1/5.2 (agent builder + A2A); **WS-9 Sovereign Agent Mesh + MCP/A2A hub** |
| **W6** | continuous | WS-10 (Autopilot / Governance-as-Code / Time-Machine / Living Marketplace / Parity Autopilot); WS-11.6 as a standing gate; P2 tail |

**Dependency spine:** WS-1.1 first (multiplies every AI surface) → WS-4 moat depth + WS-2/WS-3 holes (grade-limiting) → WS-6 Ontology-Over-Everything (the substrate BTB-7/BTB-10 compose over) → WS-7/8/9 → WS-10.

## 8. Definition of done (per item and per program)

**Per item:** (1) real Azure backend called, no mocks; (2) **G1** browser-E2E receipt with real data (screenshot/trace) in the PR; (3) **G2** zero day-one gate — any unavoidable gate has an inline Fix-it wizard + gate-registry entry + Admin gate page; (4) **G3** resizable `SplitPane` where a canvas/graph/query pane exists; (5) node compactness + badge-wrap + clean first-open; (6) parity doc `docs/fiab/parity/<slug>.md` updated to zero ❌; (7) Learn-drawer content; (8) bicep-synced (new resource/env/role/container/tenant-config per `no-vaporware §Bicep-sync`); (9) works Commercial + Gov (OSS substitution where needed); (10) unit + (where applicable) `pnpm uat` coverage.

**Per program:** composite grade in `PARITY-MATRIX.md` reaches **A / A+** on every domain; ≥ 8 of 12 BTB differentiators shipped as production surfaces; zero P0 gaps open; UX debt (monoliths/aggregates/canvas/IA/parity-doc) retired or explicitly deferred with a tracked ticket; a clean from-scratch two-phase deploy (Commercial + Gov) passes with every touched surface rendering + executing or showing a documented honest-gate.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Large refactors (WS-11) regress behavior | Behavior-parity unit tests before decomposition; incremental, one monolith at a time |
| Tier-router change (WS-1.1) shifts cost/latency across all surfaces | Ship behind admin config default; cost-estimate + SLO guardrails; canary on one surface first |
| Feature Store / OneLake shortcuts (L-effort) slip | Kick off in W3, buffer into W4; ship the honest-gate improvement first |
| Burn-the-box items depend on gap-closures | Enforce the dependency spine in §7; WS-6 gated on WS-4 |
| Gov parity for new surfaces | Sovereign-by-default in the per-item DoD; OSS-UC/ADX/AOAI-in-Gov substitution required at design time |
| Scale — 132 editors × §7 checklist | WS-11.6 standing E2E gate + WS-10.5 Parity Autopilot to keep the surface honest |

## 10. Suggested PRP slicing

1. **PRP-Model-Fabric** (WS-1) — 2. **PRP-ML-Platform** (WS-2) — 3. **PRP-Fabric-PBI-Holes** (WS-3) — 4. **PRP-Foundry-Moat** (WS-4) — 5. **PRP-Agentic-Surface** (WS-5) — 6. **PRP-Ontology-Substrate** (WS-6) — 7. **PRP-Closed-Loop** (WS-7) — 8. **PRP-NL-Estate-Canvas** (WS-8) — 9. **PRP-Sovereign-Mesh** (WS-9) — 10. **PRP-Self-Driving-Platform** (WS-10) — 11. **PRP-UX-Debt-Trust** (WS-11).

---

*This PRD is concrete enough to hand to build agents: each WS item names its Loom surface file(s), the competitor row it closes (`PARITY-MATRIX.md`), its P-rank/effort (`FINDINGS-REPORT.md §2`), and acceptance criteria bound to the die-hard rules. Ship parity and burn-the-box in parallel; land WS-1.1 first.*
