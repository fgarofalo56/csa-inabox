# CSA Loom — Competitive Audit: Findings & Recommendations

- **Date:** 2026-07-20
- **Author:** Synthesis pass over audit research 01–05
- **Repo:** `E:\Repos\GitHub\csa-inabox`
- **Companion deliverables:** `PARITY-MATRIX.md` (graded, per-domain), `PRD.md` (buildable workstreams)
- **Grounding:** every claim below traces to a file-cited row in the five research sections or the repo's parity docs. Grades honor the repo rubric (`no-vaporware.md`).

---

## 1. Executive summary

**Where Loom stands today.** Against each competitor *individually*, Loom is a genuine **B+ / A−**: near-parity on Fabric's seven workloads and Power BI (all Azure-native, no hard Fabric dependency), the widest Palantir-Foundry clone on Azure, near-complete Unity Catalog + the full Azure-AI-Foundry gen-AI surface, and at/near parity on the frontier-agent primitives (MCP-native both directions, multi-agent, data agents, memory, evals, guardrails). No competitor is close to Loom's **breadth**: 132 item types, 132 registered editors, 1,473 BFF routes, 370 Azure clients, 148 bicep modules, sovereign from commercial to IL5.

**The thesis.** Every competitor makes the customer the integration layer between their products — Fabric is a suite of separate experiences sharing a capacity; Databricks is lakehouse + ML + bolted-on BI; Palantir is ontology + pipelines without RTI/BI/warehouse at parity; the frontier labs reach data through connectors from *outside* the tenant. **Loom IS the integration layer** — and the seams are one-click Weaves, one copilot, one compute currency (LCU), one governance plane, one sovereign push-button deploy. That integration, plus sovereignty, is the un-copyable moat: nine A+ rows in the parity matrix that a single-product vendor structurally cannot ship.

**What's holding the grade at B+ instead of A.** The gaps are concentrated and closable, not systemic:
- **Model quality is capped** because the tier-router (`model-tier-router.ts`) is a **safe no-op** without tier deployments — every turn rides one default AOAI deployment regardless of orchestration.
- **Three classic-ML-platform holes:** Feature Store (**D**), Model Serving (**C+**, CRUD-only), LLM fine-tuning (**F**).
- **Two Fabric/PBI parity holes:** Direct Lake (**D**, no Azure 1:1) and OneLake zero-copy shortcuts (**C**, engine unbuilt); plus report-designer Wave-6 Format-pane (built-but-unwired).
- **Foundry moat depth:** object views (**F**), derived properties (**F**), AIP-Logic studio (backend strong, studio thin), Workshop depth.
- **Agentic product-face:** A2A interop (**F**), a frontier-grade visual agent builder (**C**), and evals/observability as a *product surface* rather than scattered routes.
- **UX debt:** 5 monolith editors + 8 aggregate modules, canvas-standard coverage on only ~11 surfaces, IA redirect-shims, parity-doc drift — all under a very large surface that must uniformly hold the §7 checklist.

**The move.** Close the concentrated gaps (parity) *and* ship the burn-the-box differentiators that only Loom can build (integration + sovereignty as products). The PRD sequences both.

---

## 2. Consolidated gap register (ranked, deduped across all 5 sections)

Ranking: **P0** = blocks "as-good-or-better" on a headline surface or caps whole-platform quality · **P1** = at-par depth on a competed surface · **P2** = breadth/polish. Effort: **S** ≤ 1 wave · **M** = 1–2 waves · **L** = multi-wave. "Closes" = the competitor row it neutralizes.

### P0 — headline parity holes + whole-platform quality caps

| # | Gap | Closes | Loom surface | Grade→target | Effort | Impact |
|---|---|---|---|---|---|---|
| P0-1 | **Wire the model tier-router for real** (default 3-tier mini/standard/**reasoning**, route hard analytical/agentic turns to the strong tier). Today a no-op → caps *every* agent, copilot, and data-agent turn. Appears in §03 and §04. | Frontier labs, Foundry Model Router | `model-tier-router.ts`, `aoai-chat-client.ts` (`resolveTierForTurn`) | no-op → **A** | S | **Highest** — single biggest quality lever, lifts every AI surface at once |
| P0-2 | **Feature Store** (feature-table authoring, PIT joins, feature-lookup-at-serving) over UC feature tables + `online-tables` + Lakebase/pgvector | Databricks Feature Engineering | `unity-catalog/online-tables/route.ts` | **D → A** | L | High — biggest ML-platform gap |
| P0-3 | **Model Serving as a first-class item** (traffic-split, autoscale, provisioned-throughput, invocation console, latency/error monitoring) over Databricks serving *and* Foundry managed online endpoints | Databricks Mosaic Serving, Foundry endpoints | `serving-endpoints/route.ts`, `foundry-client.ts` | **C+ → A** | M | High |
| P0-4 | **LLM fine-tuning item** over AOAI/Foundry serverless + managed FT, with data-eval + model-safety-eval gates (RAI) | Databricks Mosaic FT, Foundry FT | — (AutoML only) | **F → B+** | M | High |
| P0-5 | **OneLake zero-copy shortcuts engine** (ADLS + Synapse Serverless / UC external tables + Cosmos `lakehouse-shortcuts` registry, UAMI-backed) — unblocks lakehouse federation + KQL/eventhouse shortcuts + mirrored-db landing | Fabric OneLake shortcuts | `lakehouse-shortcut-editor.tsx` | **C → A−** | L | High — core Fabric value story |
| P0-6 | **Direct Lake substitute** (AAS/tabular DirectQuery over Synapse Serverless external Delta + aggressive result caching + framing refresh), marketed as the parity | Power BI / Fabric Direct Lake | `semantic-model-direct-lake.md` | **D → B+** | M | High — the semantic-model perf story |
| P0-7 | **report-designer Wave-6 Format-pane cards** (per-axis/title/legend/effects) — adapter + chrome built but unwired; single biggest quality gap in the flagship PBI surface | Power BI report Format pane | `report-designer.tsx`, `lib/editors/report/format-pane.tsx` | partial → **A** | M | High |
| P0-8 | **Ontology object views + instance viewer** (overview / properties / linked objects / timeseries / map) from real AGE data — objects exist but there is no *object experience* | Palantir Object Views | — (`weave-ontology-store.ts` has data) | **F → A−** | M | High — the Foundry moat surface |

### P1 — at-par depth on competed surfaces

| # | Gap | Closes | Loom surface | Grade→target | Effort | Impact |
|---|---|---|---|---|---|---|
| P1-1 | **AIP-Logic → full Spindle Studio** (3-pane layout, debugger CoT/block-cards/tool-logs/proposed-edits, run history, unit tests, **evals-in-CI to gate publish**, version diff, publish-as-REST/Uses-curl). Backend strong; studio is the gap. Also refresh **stale** `aip-logic.md`. | Palantir AIP Logic | `palantir/aip-logic-editor.tsx` | **B+ → A** | L | High |
| P1-2 | **Ontology derived properties + functions-on-objects registry** (rollups over links + a function runtime referenced by action validation/derived props) | Palantir Functions / Compute Modules | — | **F/C → B+** | L | High — operational-loop value |
| P1-3 | **Workshop depth** (multi-page, sections/overlays, conditional visibility, real Publish=ACA+DAB+APIM, object-view/links/map/pivot/timeline/AIP-copilot widgets) | Palantir Workshop | `workshop/workshop-app-builder.tsx` | **B → A−** | L | High — the app that sells the ontology |
| P1-4 | **Ontology row/property-level security wired to objects & actions** (Entra-group ACL at `/objects` + `/run-action`, reuse EH Phase-1 PDP/RLS) | Palantir Restricted Views | — | **D → A−** | M | High — regulated-buyer table stakes |
| P1-5 | **Visual agent-builder canvas at frontier polish** (drag agents + tools + MCP + ontology objects, wire handoffs, inline guardrails/evals, publish as MCP/API) — OpenAI retiring theirs leaves an opening | OpenAI Agent Builder, Agentspace | `phase4/agent-flow-canvas.tsx` | **C → A−** | L | High |
| P1-6 | **A2A protocol support** (agent cards + task delegation) so Loom federates with external ADK/Foundry/Copilot-Studio agents — the only sovereign platform speaking *both* MCP + A2A | Google A2A | — | **F → B+** | M | Medium-High |
| P1-7 | **Unified Agent Evals + Observability product page** (eval sets, LLM-judge, regression vs baseline, red-team, per-agent trace timeline, cost/latency SLOs). Plumbing exists; needs a product face. | Foundry/OpenAI/Vertex evals+obs | `apps/copilot/evals/`, `foundry/evaluations`, `agentops.ts`, `ai-red-team` | **B → A** | M | High |
| P1-8 | **AI/BI dashboards** (AI-authored viz, one-click forecasting + key-driver analysis) on the semantic-model/report path | Databricks AI/BI + Genie dashboards | semantic model + report renderer | **B → A** | M | Medium-High |
| P1-9 | **Managed Vector Search** (Delta-synced auto-indexed, incremental, rerank) rather than manual population | Databricks Vector Search | `vector-store`, `ai-search-index` | **B → A** | M | Medium |
| P1-10 | **GenAI eval depth** (built-in evaluator library: groundedness/relevance/tool-call-accuracy/task-adherence + `mlflow.evaluate`-style one-click judge + cluster-analysis of eval failures) | Foundry Evaluations, Databricks Agent Eval | `evaluation`, `agent-eval.ts` | **B+ → A** | M | Medium |
| P1-11 | **Observability span-tree** (full OTel span waterfall + token/latency/error rollups + continuous-eval alerts) | Foundry observability, Vertex | `tracing`, `agentops.ts` | **B+ → A** | M | Medium |
| P1-12 | **Eventstream 2026 features** (SQL operator, AI Skills NL→eventstream, Business Events publisher) | Fabric Eventstream 2026 | `EventstreamEditor` | **A− → A** | M | Medium |
| P1-13 | **ADX results grid** (column stats, in-grid filter/search, CSV export polish) | Fabric RTI KQL grid | `adx/*` (`adx-kusto.md` self-grades C+) | **C+ → A** | S | Medium |
| P1-14 | **Object Explorer polish** (histograms/facet charts, property-type-aware filters, full-page mode) | Palantir Object Explorer | `phase4/object-explorer-panel.tsx` | **B+ → A** | M | Medium |
| P1-15 | **Dataset→object sync (OSv2) at scale + backfill status** + AI-Search index over instances | Palantir OSv2 | ontology `/bind` | **C → A−** | M | Medium |
| P1-16 | **Reasoning-mode for data agents** (planner→execute→verify loop on the reasoning tier for multi-hop questions) | Frontier data agents | `data-agent-client.ts` | — → **A−** | S | Medium (depends on P0-1) |

### P2 — breadth / polish / refactors

| # | Gap | Closes | Loom surface | Grade→target | Effort |
|---|---|---|---|---|---|
| P2-1 | Column-level lineage in `/governance/lineage` | Palantir Monocle, Databricks | `unified-lineage.ts` | **B → A−** | M |
| P2-2 | Connector breadth ~70 → 200+ | Fabric DF / Foundry Magritte | `linked-service-editor.tsx` | **B → A−** | L |
| P2-3 | Dataflow Gen2 AI Prompt Transform + inline Spark preview | Fabric Dataflow Gen2 2026 | `dataflow-gen2-editor.tsx` | **A− → A** | M |
| P2-4 | Ontology proposals/branches (staged model review) + Global Branching | Palantir proposals | — | **F → B** | M |
| P2-5 | Contour/Quiver/Fusion depth (more step types, save-as-dataset/export, live object-set into Fusion cells) | Palantir analytics | `analysis-board`, `rayfin-app`, `fusion-sheet` | **B/B− → A−** | M |
| P2-6 | Transforms project scaffold + branch/PR/CI UX | Palantir Code Repositories | notebook + repos | **B− → B+** | M |
| P2-7 | AIP Analyst embeddable widget (execute-ontology-action-from-chat, embeddable in Workshop) | Palantir AIP Analyst (Mar 2026) | data-agent + copilot | **C → B+** | M |
| P2-8 | Model catalog compare/benchmark UX (side-by-side eval on own data) | Foundry Models | `model-availability-matrix.ts` | **B+ → A** | M |
| P2-9 | Lakehouse Federation query UX + Lakeflow Connect managed-connector gallery | Databricks | `unity-catalog/connections` | **C → B+** | M |
| P2-10 | Loom-native Clean Room (Gov/OSS, no Databricks capacity) | Databricks Clean Rooms | `clean-rooms/route.ts` | **D → B** | L |
| P2-11 | Conversational code-interpreter (in-chat ephemeral Python sandbox over governed lakehouse) | ChatGPT ADA, Claude for Excel | notebook + Spark | **C → B+** | M |
| P2-12 | NL-"ask" affordance on *every* data surface (table/report/dashboard/ontology object) | Gemini embedded NL | `data-agent-client.ts` | — → **A−** | M |
| P2-13 | Autonomous data-engineering agent (goal→build/repair Synapse/ADF pipeline end-to-end) | BigQuery Data Engineering Agent | pipeline copilots, `operations-agent` | **C → B+** | L |
| P2-14 | AI Document Intelligence item (OCR + LLM extraction over Azure Document Intelligence) | Palantir Document Intelligence (Feb 2026) | — | **F → B** | M |
| P2-15 | Realtime / voice agent surface | OpenAI Realtime | — | **F → C** | M |
| P2-16 | Digital Twin Builder / RT Dashboard depth (tile-auth, auto-refresh, drill) | Fabric | `digital-twin-builder-editor.tsx`, `kql-dashboard-editor.tsx` | **B → A−** | M |
| P2-17 | Fresh **browser-E2E receipts** (G1) for code-complete "A" surfaces (warehouse, semantic-model, report-designer, eventstream, KQL, activator) via `loom-uat` | operator G1 bar | all "A per code+tests" surfaces | receipts | M (recurring) |

---

## 3. Design surfaces to refactor / redo (UX debt)

Grounded in §05 Part 2 (assessed against `.claude/rules/ux-baseline.md`, `web3-ui.md`, `ui-parity.md`, `docs/fiab/ux-standards.md` §7).

1. **Five monolith editors (3.9k–5.2k LOC single files)** — hardest to review, diff, and hold to the §7 checklist uniformly:
   - `editors/lakehouse/lakehouse-editor-shell.tsx` — **5,227**
   - `editors/report-designer.tsx` — **5,135**
   - `editors/phase3/semantic-model-editor.tsx` — **4,576**
   - `editors/notebook-editor.tsx` — **3,875**
   - `editors/apim-editors.tsx` — **3,580** (also an aggregate)
   Decompose by bounded context (UI sections / hooks / service adapters / validators), target < 1,500 LOC/module in phase 1, with focused unit tests. Follow the already-decomposed `phase3-editors.tsx`/`phase4-editors.tsx` (now 108/26 LOC shims) as the pattern.

2. **Eight aggregate editor modules bundling many editors in one file** — hard to code-split and to polish per-surface: `foundry-sub-editors.tsx` (3,272), `powerplatform-editors.tsx` (2,365), `copilot-studio-editors.tsx` (1,952), `azure-sql-editors.tsx` (1,875), `azure-services-editors.tsx` (1,617), `geo-editors.tsx` (1,225), `graph-editors.tsx` (1,196), `phase2-misc-editors.tsx` (969). Split each into per-item editor files.

3. **Canvas-standard coverage gap.** Only ~11 editors use `canvas-node-kit` and ~9 use React Flow, but `ux-baseline.md` makes the canvas layer (undo/redo, copy/paste, align, palette, `CanvasRightRail`, `SplitPane`) mandatory on *every* topology surface. Migrate the hand-built topology views (`model-view-canvas.tsx` at 1,356 LOC, `graph-editors.tsx` graph views) to the shared kit.

4. **IA redirect-shims split the information architecture.** `governance/sensitivity`, `/classifications`, `/domains` redirect to `/admin/*` — the same concept lives under two route trees. Consolidate to reduce navigation confusion.

5. **Scale-consistency risk.** 112 pages × 132 editors × 1,473 BFF routes is a very large surface for the §7 universal checklist (G1/G2/G3, node compactness §9.4, badge-wrap §9.5, clean first-open §9.6) to be uniformly true. Run a **systematic §7 sweep with per-surface browser-E2E receipts**, prioritizing the monoliths and non-kit canvases.

6. **Parity-doc drift.** 423 parity docs are a strength, but `ui-parity.md` requires zero ❌ and `aip-logic.md` is already **stale** (describes a pre-block-graph editor that no longer exists). Add a staleness detector (doc→source-file map, `Reviewed-on`/`Validated-against` metadata) and re-baseline priority docs.

**Net verdict (from §05):** Loom's *structural* UX assets — shared kit, gate registry, honest-gate, Learn drawers, token system — are ahead of any single competitor. The debt is **concentration and consistency**, not absence.

---

## 4. Burn-the-box vision — flagship differentiators

Synthesized from the net-new sections of all five docs. Each is buildable *only* because Loom already owns the whole surface; each is something a single-product vendor **structurally cannot** ship. These are the bets that move Loom from "parity-with-everyone" to "the #1 platform because it's all of them at once."

### BTB-1 · Ontology-Over-Everything (the Universal Semantic Fabric)
**What:** promote the Loom IQ ontology (15 `fabric-iq.ts` item types + `palantir/ontology-*` + AGE store) from "a workload" to the **substrate every other item binds to**. Every lakehouse table, warehouse column, KQL stream, semantic measure, ML feature, and API becomes a typed instance of an ontology object; queries, lineage, access policy, feature lookup, and copilot grounding all resolve through the ontology graph.
**Why no competitor:** Palantir has the ontology but not RTI/BI/warehouse at parity; Fabric/Databricks have the data but no ontology substrate. Only Loom has both under one metastore — *and* it can bind zero-copy over Databricks UC tables / OneLake shortcuts / PBI models the customer already owns, which Foundry (a closed data plane) structurally cannot.
**Build shape:** ontology-binding annotations on every item's Cosmos state; an "ontology resolver" middleware rewriting SQL/KQL/DAX to ontology objects; a `bind-to-ontology` Weave on every `notebookAttachable` type.

### BTB-2 · Self-Driving Data Platform (LCU-Autopilot)
**What:** turn the LCU capacity broker (`loom-capacity-broker`) into a closed-loop optimizer that *acts* — auto-pauses idle Synapse/Databricks, right-sizes Spark pools from historical LCU curves, pre-warms before scheduled pipelines, migrates a workload Databricks→Synapse→ADX when the LCU/$ ratio favors it, and files FinOps recommendations that execute on approval.
**Why no competitor:** Fabric capacity smooths inside Fabric only; nobody arbitrates compute *across* Synapse+Databricks+ADX+AML because nobody else owns all four.
**Build shape:** LCU telemetry → policy engine over the gate/self-audit infra → `env-config` revision rolls as the actuator → a new `admin/autopilot` page over `posture-aggregates`.

### BTB-3 · NL-to-Full-Estate ("describe the outcome, get the pipeline")
**What:** one NL prompt → the cross-item orchestrator authors the *entire* chain: create lakehouse → land + medallion-promote → build semantic model → generate report → publish API → wire a Data Agent → apply governance — as a single reviewable **plan** (`phase4/plan-editor.tsx` plan-model exists) that executes via the 13 Weave bridges with dry-run + diff + approve.
**Why no competitor:** requires one agent with tools spanning all workloads + one-click bridges between them. Loom already has 38+ tools + 13 bridges; the net-new is the *planner* that composes them. Depends on P0-1 (reasoning tier).
**Build shape:** planner over `copilot-orchestrator` emitting a `plan-model` DAG of Weave actions; reuse `proposed-change`/`apply-change`.

### BTB-4 · Sovereign Agent Mesh (in-VNet multi-agent, air-gap-safe)
**What:** a fleet of specialized data agents (one per domain/ontology object) collaborating on a task entirely inside the customer VNet — MAF orchestration (`apps/copilot-maf`) + the gov-safe MCP tier (32 catalogued, Tier-0 air-gap-safe) + Gov AOAI direct. A governance agent, a pipeline agent, and a BI agent negotiate a request with full Purview/DLP enforcement, and **nothing leaves the boundary**.
**Why no competitor:** no other platform runs a governed multi-agent mesh inside GCC-High/IL5 with a curated air-gap-safe tool catalog and one governance plane. Frontier labs literally cannot compete here.
**Build shape:** extend `connected-agents.ts` + MAF into an agent-registry over Cosmos; per-agent MCP tool scoping via `data-agent-mcp`; policy check on every inter-agent call through `access-policy-client`.

### BTB-5 · One-Canvas Cross-Workload Authoring (the Unified Studio Canvas)
**What:** a single canvas where a node can be a lakehouse table, a Spark notebook, a KQL stream, a semantic measure, an ontology object, an ML model, an agent, or a report — and edges are real Weave bridges. Author a *cross-workload* topology (ingest→transform→serve→visualize→publish) on one surface instead of five studios. Extends `canvas-node-kit` + React Flow (already the Loom-exceeds-Fabric layer).
**Why no competitor:** each competitor's canvas is single-workload (ADF pipeline, Databricks workflow, PBI model view). Loom owns all node types + the bridges between them.
**Build shape:** typed cross-workload node registry over the existing kit; edges = ThreadActions; publish = a `plan-model`; mandatory G3 `SplitPane` shell.

### BTB-6 · Closed-Loop Model Fabric (evaluate→route→serve→observe, self-optimizing)
**What:** fuse the pieces Loom already has separately — `model-tier-router` (routing), `agent-eval`/`red-team` (eval), `serving-endpoints` (serving), `agentops`/`copilot-slo` (observability) — into a self-optimizing loop: continuous eval + red-team results feed the tier-router and a serving traffic-split automatically (promote the model/prompt that wins live eval, demote regressions), all logged to the gate registry and surfaced on the Admin panel.
**Why no competitor:** Foundry has FAOS agent-optimizer and Databricks has Agent Evaluation, but neither closes the loop across routing + serving + governance in one product, cross-cloud, Gov-capable. Depends on P0-1/P0-3.
**Build shape:** eval results → tier-router weights + serving traffic-split actuator → gate registry log → `admin/model-fabric` page.

### BTB-7 · Feature-Store-Over-Ontology (governed features + agents reason over entities)
**What:** wire the new Feature Store (P0-2) and vector index directly to **ontology objects**, and let agents reason over the ontology + governed features + lineage together. Databricks Genie sees tables; a Loom agent sees *entities, their relationships, their features, and their governance*.
**Why no competitor:** an Ontology-native Genie/AgentBricks that a standalone Databricks or Foundry structurally cannot build (Databricks has no ontology; Foundry has no governed lakehouse feature store at parity).
**Build shape:** feature tables keyed by ontology object PK; feature lookup at serving joins via the ontology graph; agent tool `get_features_for_object`.

### BTB-8 · One Governance Spine across Data + ML + Agents (Governance-as-Code)
**What:** express access, RLS, sensitivity, DLP, residency, retention as one declarative policy set that **compiles** to every backend simultaneously — Synapse SQL DENY (`rls-compiler`/`access-policy-client` already do SQL), UC grants, Purview classifications, MIP labels, ADX RLS, API scopes — with a reconciler (`protection-policy-reconciler` exists) that continuously drift-checks and self-heals. Unify UC + Purview + gate registry so a fine-tuned model, a serving endpoint, a feature table, a vector index, *and* an agent are all securables under one ABAC + lineage graph.
**Why no competitor:** everyone's policy stops at their own store. Only Loom compiles one policy to Purview+UC+SQL+ADX+Graph in one pass, cross-cloud, with the OSS-UC fallback so it works with *no* Databricks/Fabric capacity.
**Build shape:** a `policy-as-code` DSL → per-backend compilers (extend the SQL one) → reconcile loop over gate/self-audit → `admin/policy-code` page + `loom policy apply` CLI verb.

### BTB-9 · MCP + A2A Sovereign Interop Hub
**What:** Loom is already MCP-native both directions (consume + publish `iq-mcp.ts`/`data-agent-mcp.ts`). Add A2A (P1-6). Then external ADK/Foundry/OpenAI agents delegate governed data tasks *into* Loom (where the data + governance are), and Loom agents publish as MCP tools / A2A agents to the outside — the **sovereign, in-tenant execution layer for the whole multi-vendor agent ecosystem**.
**Why no competitor:** the industry is standardizing on MCP (tools) + A2A (agents); no sovereign platform speaks both while owning a governed data plane.
**Build shape:** A2A agent cards over the agent-registry; expose ontology objects/actions/OSDK endpoints as A2A tasks; egress via the existing gov-safe profiles.

### BTB-10 · Time-Machine for the Whole Estate (Unified Point-in-Time + What-If)
**What:** one "as-of" slider across the *entire* platform — Delta time-travel + ADX materialized views + Cosmos change-feed + ontology versioning stitched into one point-in-time view, so you can query the ontology, a report, and a pipeline output all as they were at timestamp T, and run counterfactual "what-if" branches of the estate.
**Why no competitor:** each engine has its own history; nobody unifies Delta + ADX + ontology + BI into one temporal coordinate.
**Build shape:** a temporal coordinator resolving each backend's native time-travel to one `asOf` param; branch = shadow workspace (isolation + delete-cascade exist); UI = a global time bar in `PageShell`.

### BTB-11 · The Living Marketplace (auto-certified data/agent/app/ontology products)
**What:** extend the marketplace beyond data products to **agents, MCP servers, apps (`.loomapp`), and ontologies** as first-class subscribable products — each auto-certified on publish (governance scan + DQ + parity-doc + browser-E2E receipt gates run automatically), delivered via Delta Sharing + API + MCP.
**Why no competitor:** requires one publish surface across data+agent+app+ontology + one governance plane to certify them. Loom has the pieces (marketplace, Delta Sharing, `data-agent-mcp`, `.loomapp` export, gate registry).
**Build shape:** unify product types under one Cosmos `marketplace` schema; publish pipeline runs the existing gates as certification; entitlement via access-governance; billing via LCU chargeback.

### BTB-12 · Continuous Parity Autopilot (the platform audits itself)
**What:** a scheduled agent that captures the live Fabric/Azure/Foundry UI, diffs it against Loom's 423 parity docs, and **auto-files** gaps as backlog items with a proposed plan — turning `ui-parity.md`'s manual side-by-side into a self-running competitive radar that keeps Loom ahead as competitors ship.
**Why no competitor:** only makes sense for a product whose explicit design is "be one-for-one-or-better with everyone else."
**Build shape:** Playwright capture (harness exists) → vision-model diff vs parity docs → plan-model + `gh issue` filing; runs as a scheduled workflow.

---

## 5. Recommended next steps — roadmap

### 90-day plan (the "close the caps, prove the vision" quarter)

**Wave 1 (weeks 0–3) — quality caps + quick wins**
- **P0-1 wire the tier-router** (S, highest leverage — lifts every AI surface). Ship default mini/standard/reasoning config per cloud.
- **P0-7 report-designer Wave-6 Format-pane** (M — flagship PBI quality gap; adapter already built).
- **P1-13 ADX results grid** to A (S).
- Kick off **P2-17 browser-E2E receipt sweep** (recurring) via `loom-uat`.
- Start **UX debt**: decompose the 2 worst monoliths (`lakehouse-editor-shell`, `report-designer`) and add the parity-doc staleness detector; refresh stale `aip-logic.md`.

**Wave 2 (weeks 3–7) — Foundry moat + ML platform start**
- **P0-8 ontology object views + instance viewer** (M — the Foundry moat surface).
- **P0-3 Model Serving first-class item** (M).
- **P1-16 + BTB-3 seed:** reasoning-mode data-agent planner (S, depends on P0-1) → first slice of NL-to-Full-Estate.
- **P1-7 unified Agent Evals + Observability product page** (M — plumbing exists).
- Continue monolith decomposition (semantic-model, notebook, apim aggregate).

**Wave 3 (weeks 7–12) — parity holes + first burn-the-box**
- **P0-6 Direct Lake substitute** (M) and **P0-5 OneLake shortcuts engine** kickoff (L, spans into 6-month).
- **P0-2 Feature Store** kickoff (L) → immediately wire to ontology (**BTB-7** seed).
- **P1-1 AIP-Logic Spindle Studio** kickoff (L).
- **BTB-8 Governance-as-Code** first compiler (extend the SQL DENY compiler to UC + ADX).
- Canvas-standard coverage sweep on non-kit topology surfaces.

### 6-month plan (the "ship the moat as products" half)

- **Complete the L-effort P0s:** Feature Store (P0-2 → A, wired to ontology BTB-7), OneLake shortcuts engine (P0-5), LLM fine-tuning (P0-4).
- **Complete the Foundry moat depth:** derived properties + functions-on-objects (P1-2), Workshop depth (P1-3), ontology object-level security (P1-4), AIP-Logic Spindle Studio (P1-1) with evals-in-CI.
- **Ship the flagship burn-the-box bets in priority order:**
  1. **BTB-1 Ontology-Over-Everything** — the substrate everything binds to (unlocks BTB-7, BTB-10).
  2. **BTB-6 Closed-Loop Model Fabric** — after P0-1/P0-3 land, fuse route+eval+serve+observe.
  3. **BTB-3 NL-to-Full-Estate** — the planner over the 38 tools + 13 Weaves.
  4. **BTB-5 One-Canvas Cross-Workload Authoring** — the unified studio canvas.
  5. **BTB-4 Sovereign Agent Mesh** + **BTB-9 MCP+A2A hub** — the sovereign agentic story (add A2A, P1-6).
  6. **BTB-2 LCU-Autopilot** and **BTB-8 Governance-as-Code** — the self-driving + one-policy-everywhere plane.
- **Continuous:** **BTB-12 Parity Autopilot** as a scheduled workflow; **P2-17 E2E receipts** as a standing gate; parity-doc re-baseline; monolith/aggregate decomposition to completion.

**North-star sequencing principle:** land P0-1 first (it multiplies every AI surface), then the Foundry moat depth + ML-platform holes (they're the grade-limiting P0/P1s), then the burn-the-box differentiators *in dependency order* (Ontology-Over-Everything is the substrate the others compose over). Every item ships with a real backend, a browser-E2E receipt (G1), zero day-one gates with inline "Fix it" (G2), and resizable `SplitPane` panels (G3) — per the die-hard rules.