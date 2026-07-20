# Loom vs Palantir Foundry — capability gap analysis

**Author:** CSA Loom core team
**Date:** 2026-07-20 (originally 2026-07-13)
**Status:** Living analysis. Supersedes the April-2026 gap rows in
`docs/migrations/palantir-foundry/feature-mapping-complete.md` where they
conflict (notably ontology write-back, which is now BUILT).

!!! warning "Re-baselined 2026-07-20 from live receipts"
    This document was re-graded on **2026-07-20** against the shipped-and-verified
    receipts in `PRPs/active/foundry-parity/AUDIT.md` (PRs **#2195–#2242**, console
    revisions **0000339 → 0000353**). The 2026-07-13 edition of this file graded
    Object Explorer, Fusion, Contour, Notepad, checkpoints, approvals, rules, and
    retention/export as PARTIAL or MISSING — **all of those shipped and were
    browser/session-E2E'd in the 2026-07-19 drive**. If you are reading this to
    answer "does Loom have X vs Foundry", the tables below are the current truth;
    the AUDIT register is the receipt trail.

!!! info "Comparative positioning note"
    Descriptions of Palantir Foundry / AIP are derived from **publicly available
    Palantir documentation** (`palantir.com/docs/foundry`, `learn.palantir.com`)
    believed accurate at time of writing, for **general comparison only**. The
    vendor's official docs are authoritative and change over time. Where Foundry
    has a genuine advantage, we note it honestly.

---

## Executive summary

The operator's goal: **Loom should do everything Foundry can do — tying
everything together — and be better.** This analysis grounds Foundry's real
capability surface, maps it against what Loom ships **today** (code-verified AND
live-E2E-verified, not doc-only), ranks the residual gaps, and tracks the build
plan that has now largely landed.

**Headline finding (2026-07-20):** Foundry parity is **substantially achieved
and receipt-verified.** The live, writable Ontology (Apache AGE on PostgreSQL
Flexible Server) has been extended with an instance-level **Object Explorer**
(#2195), **action validation rules** (#2200, HTTP-422-verified invariants
#2205), **approval workflows** (#2203), **checkpoint justification prompts**
(#2196/#2198), **retention/export controls** (#2204), and **lineage
side-effects** into Thread/Purview (#2202). The operational-app tier that was
graded MISSING on 2026-07-13 — **analysis-board (Contour analog), fusion-sheet
(Fusion spreadsheet write-back analog), and notepad** — shipped as full items
with real ADX/Cosmos backends and passed visual + session E2E (rev 0000347's
guided-pristine fix included). Workshop widgets grew 7 → 12 with per-tab
child-widget nesting (#2235); rayfin (Quiver analog) grew its card catalog
5 → **34** (#2237), exceeding Quiver's ~30-card bar. Live signed-in
side-by-sides against **both** portals graded Loom **≥ Fabric (A/A+)** and
**≥ Azure portal browse (A)**.

What remains is a short, honest residual list — not parity blockers:
(1) **Scenarios / what-if branching** of the ontology, (2) **Purpose-Based
Access Control** (markings exist; the "purpose" primitive is PARTIAL),
(3) **Vertex-style process mining / simulation** (DEFERRED by decision),
(4) agent-flow **ontology tools** + a publish-time **Evals gate**, and
(5) per-surface Foundry parity docs are still **sparse** relative to the
Fabric/Azure parity doc set.

Loom's structural advantages over Foundry are unchanged and now demonstrated:
**Azure-native with zero vendor lock-in, both clouds including Gov/IL5, no
proprietary object store tax, Fabric 1:1 parity, 131+ item types, and
Purview/Unity-Catalog governance** that Foundry has to reimplement in-platform.
The connective-tissue story ("tying everything together") exists as **Thread** —
Loom's cross-item Weave graph — spanning the whole catalog instead of one
object model, with a **seeded Enterprise Ontology** live for demos (real
`dbo.Customer` rows served through a workshop app tab, rev 0000353 receipt).

---

## Part 1 — Foundry capability inventory (grounded, cited)

Foundry organizes into eight capability domains. Genuine differentiators (things
that are hard to replicate and are Foundry's actual moat) are flagged **[MOAT]**.

### 1. Ontology (the core)
The decision-centric semantic layer that integrates data, logic, and actions as
**objects and links**. ([Ontology](https://www.palantir.com/explore/platforms/foundry/ontology/), [Platform overview](https://www.palantir.com/docs/foundry/platform-overview/overview))

- **Object Types** — schema for real-world entities; typed properties, title/primary keys, geo/timeseries/struct types.
- **Link Types** — typed relationships with cardinality (1:1, 1:many, many:many), FK- or join-backed.
- **Interfaces** — abstract types enabling polymorphism across object types.
- **Action Types** — state-changing operations (create/update/delete) with typed parameters, rules, and side effects. **[MOAT]** — the write-back surface.
- **Functions** — server-side TS/Python bound to the Ontology (function-backed properties, function-backed actions).
- **Object Views / Object Explorer** — search, browse, drill-down, and templated embedded analyses over live objects.
- **Ontology SDK (OSDK)** — auto-generated typed SDKs; the Ontology as an "operational bus" across apps. **[MOAT]**
- **Vertex** — system graphs, process visualization, scenario testing. **[MOAT]**
- **Phonograph object store** — sub-100 ms transactional object backend. **[MOAT]** (proprietary OLTP graph store)

### 2. Data integration
- **Pipeline Builder** — point-and-click ETL; back end auto-writes transform code; **LLM transform nodes** (classify, extract, embed). **[MOAT — the AIP-accelerated build UX]** ([Pipeline Builder AIP](https://www.palantir.com/docs/foundry/pipeline-builder/pipeline-builder-aip))
- **Code Repositories** — web IDE, Git, branches, PRs, CI/CD; Python/SQL/Java transforms.
- **Incremental computation** — process only changed rows/files.
- **Data Connection + Magritte** — 200+ connectors; **agent worker/proxy** for on-prem.
- **Streaming (Flink)**, **Media sets**, **Virtual Tables** (zero-copy), **Compute Modules** (BYO containers).

### 3. Model integration + AIP
([AIP features](https://www.palantir.com/docs/foundry/aip/aip-features), [AIP overview](https://www.palantir.com/docs/foundry/aip/overview))
- **AIP Logic** — no-code environment to build/test/deploy AI-powered **functions** grounded in Ontology data.
- **AIP Agent Studio / Chatbot Studio** — build agents powered by LLM + Ontology + docs + custom tools; **publish an agent as a Function** callable anywhere, evaluable in Evals, automatable. **[MOAT]** ([Agent Studio](https://www.palantir.com/docs/foundry/agent-studio/getting-started), [Agents as Functions](https://www.palantir.com/docs/foundry/agent-studio/agents-as-functions))
- **AIP Assist** — in-platform context-aware copilot.
- **AIP Evals** — test/benchmark LLM functions and prompts, monitor drift in production. **[MOAT — eval-in-the-loop]**
- **Language Model Service** — governed multi-provider LLM access; **Text-to-Embeddings**.
- **AIP Threads**, **Palantir MCP** / **Ontology MCP** — external AI systems get Ontology context.
- **Modeling Objectives / Model Adapters / Batch Deployment / AutoML** — full model lifecycle bound to the Ontology.

### 4. Operational apps
- **Workshop** — low/no-code Ontology-aware operational app builder (60+ widgets). **[MOAT]**
- **Slate** — custom HTML/CSS/JS app framework.
- **Quiver** — Ontology-aware object analysis with charts.
- **Contour** — point-and-click dataset analysis / dashboards.
- **Fusion** — spreadsheet with dataset write-back.
- **Notepad** — collaborative rich text with embedded charts/objects.
- **Object Views** — embed templated analyses in object context.

### 5. Actions + write-back
- **Action Types** — the ontology-editing operations (see §1).
- **Functions-backed actions**, **Webhooks**, **External Functions**.
- **Scenarios / sandboxing** — isolated what-if branches of the Ontology for simulation before commit. **[MOAT]**

### 6. Governance / security
([Markings](https://www.palantir.com/docs/foundry/security/markings), [Data Lineage](https://www.palantir.com/docs/foundry/data-lineage/overview), [Protecting sensitive data](https://www.palantir.com/docs/foundry/security/protecting-sensitive-data))
- **Markings** — mandatory access controls that **propagate along provenance/lineage** to all derived data. **[MOAT — propagation]**
- **Purpose-Based Access Control (PBAC)** — data usable only for its declared purpose. **[MOAT]**
- **Projects / Organizations** — security boundaries and multi-tenant silos.
- **Data Lineage app** — interactive end-to-end provenance; **"impact of a marking change"** analysis. **[MOAT — the app UX]**
- **Checkpoints** — justification prompts for sensitive access; **Audit logging**; **Row/column security**; **Encryption**.

### 7. DevOps / platform
- **Apollo** — continuous delivery, zero-downtime upgrades across environments. **[MOAT]**
- **Marketplace** — storefront to discover/install **packaged products** (bundles of pipelines + apps + models + ontology). **[MOAT — product packaging]**
- **Product packaging / Automatic upgrades**, **Projects/Resources model**, **Global branching**.

### 8. Automation (Rules / Automate)
- **Automate** — trigger-based automation (time, data-change, combined) that runs Ontology edits with **approval workflows**; can run published AIP Agents.
- **Rules** — author business logic directly in the platform.
- **Monitors / Health Checks / Notifications**.

---

## Part 2 — Loom coverage map (HAVE / PARTIAL / MISSING)

Code-verified against `apps/fiab-console` and **live-E2E-verified** per
`PRPs/active/foundry-parity/AUDIT.md` on 2026-07-20. Legend: ✅ HAVE ·
🟡 PARTIAL · ❌ MISSING.

### Ontology
| Foundry | Status | Where in Loom |
| --- | --- | --- |
| Object Types | ✅ | `lib/editors/ontology-model.ts` (19 base types incl. geopoint/timeseries/vector/struct/marking, **shared property groups** + `effectiveProperties()`), `lib/editors/phase4/ontology-editor.tsx` |
| Link Types | ✅ | same; 1:1/1:many/many:many, FK or join-table backed |
| Interfaces | ✅ | `ontology-model.ts` — contracts + conformance validation (by apiName + base type over effective schema) |
| Action Types (**write-back**) | ✅ | typed params + **validation rules E2E'd** (#2200, rev 0000340) + **object-type invariants** enforced at write (#2205 — HTTP 422 receipt) + **approval workflows** (#2203 — block→approve→re-run, one-shot consumed) + **lineage side-effects** emitLineage → Thread/Purview (#2202); executes on real Apache AGE via `lib/azure/weave-ontology-store.ts` → `/api/items/ontology/[id]/run-action`. External-webhook side effect intentionally deferred (freeform-URL rule) |
| Functions (server-side) | 🟡 | realized as AIP-Logic/Spindle LLM functions + user-data-functions with real `/bind-ontology`, `/deploy`, `/invoke` routes; **no TS/Python Ontology-Functions repo with function-backed properties** |
| Object Explorer (instances) | ✅ | **SHIPPED + E2E'd 2026-07 (#2195, search fix #2197)** — instance-level search/facet/traverse/saved explorations over the AGE store, alongside the Fabric-style item tree (`lib/components/object-explorer.tsx`) and live instance tables in `ontology-editor.tsx` |
| Graph view / Vertex | 🟡 | force-directed IS_A graph (`lib/components/graph/force-directed-graph`) + `tapestry-editor.tsx` (ADX make-graph link analysis + Azure Maps). **Process-mining / simulation Vertex canvas DEFERRED (decision)** |
| OSDK | ✅ | `lib/editors/palantir/ontology-sdk-editor.tsx` → typed TS/Python + `dab-config.json` (Data API Builder on ACA + APIM); **structured-model refactor #2128** |
| Object store | ✅ (analytics-grade) | schema→Cosmos; instances→Apache AGE/PostgreSQL with **store self-heal #2129** and a **seeded Enterprise Ontology** (live `dbo.Customer` mapping demo'd rev 0000353). **Not sub-100 ms OLTP** — for that pair with Cosmos/Azure SQL |

**Ontology verdict: parity achieved on the graded surface.** The write-back
core plus rules/approvals/checkpoints/explorer is real, backed, and E2E'd.
The `feature-mapping-complete.md` "ontology writeback — out of scope" gap and
the 07-13 "Object Explorer ❌" grade are both **obsolete**.

### Data integration
| Foundry | Status | Where in Loom |
| --- | --- | --- |
| Pipeline Builder (visual) | ✅ | `data-pipeline-editor.tsx` + `canvas-node-kit.tsx`; ~40+ activity catalog (160 type-entries incl. variants, `lib/components/pipeline/activity-catalog.ts`); ADF default / Fabric opt-in |
| Pipeline Builder **LLM nodes / AI-build** | 🟡 | Copilot build-assist exists; **not the "one-prompt-generates-the-pipeline" auto-codegen UX** |
| Mapping dataflow (Spark) | ✅ | `mapping-dataflow-editor.tsx` → Data Flow Script |
| Dataflow Gen2 (Power Query) | ✅ | `dataflow-gen2-editor.tsx` |
| Eventstream / streaming | ✅ | `phase3/eventstream-editor.tsx`; Event Hubs + Stream Analytics (Loom splits what Foundry merges — honest architectural parity) |
| Code Repositories / notebooks | ✅ | `notebook-editor.tsx`, `synapse-notebook-editor.tsx`, `databricks/*`, `spark-job-definition-editor.tsx` |
| Data Connection / connectors | ✅ | `/connections` — reusable KV-backed connections (ConnectionBuilder; consumed by mirroring, ADF/Synapse linked services, datasets); 70+ connectors |
| Agent worker (on-prem) | ✅ | scale-to-0 SHIRs |
| Dataset versioning | 🟡 | `lib/azure/delta-history.ts` (DESCRIBE HISTORY) powers clone/copy-into/snapshots; surfacing gap = version-history tab + restore on lakehouse Tables |
| Media sets / Virtual Tables | 🟡 | ADLS + Doc Intelligence + shortcuts exist; preview is metadata + download — **no unified "media set" item type / inline render** |
| Compute Modules (BYO container) | ✅ | ACA / AKS |

### Model integration + AIP
| Foundry | Status | Where in Loom |
| --- | --- | --- |
| AIP Logic (typed LLM function) | ✅ | `palantir/aip-logic-editor.tsx` (Spindle) → live Azure OpenAI via `chatGrounded`; real `/invoke`, `/deploy`, `/run-agent`, `/bind-ontology` routes |
| AIP Logic block depth | 🟡 | 6 block kinds (create-variable, get-object-property, use-llm, execute-function, transform, branch); **missing apply-action, semantic-search, loop/map, agent tool-call blocks** |
| AIP Agent Studio (build agent) | 🟡 | `phase4/operations-agent-editor.tsx`, `agent-flow-canvas.tsx`, `copilot-studio-editors.tsx`; Loom apps publish-as-API/-MCP shipped (loom-apps-parity PRP). **Residual: agent-flow has no ontology tools (query objects / invoke actions) and no "publish agent as Function + Evals gate" loop** |
| AIP Assist (in-platform copilot) | ✅ | `/copilot` RAG + `cross-item-copilot-editor.tsx` (32-tool orchestrator) + per-surface Copilot entries |
| AIP Evals | 🟡 | `foundry-sub-editors.tsx` Evaluation + `lib/foundry/agent-eval.ts` (see `docs/fiab/parity/foundry-evaluations.md`); **not wired as an eval-gate on agent/function publish** |
| Language Model Service (governed multi-provider) | ✅ | model-tier-router, model-availability-matrix, APIM policy fallback |
| Text-to-embeddings | ✅ | AI Search index + embeddings |
| AutoML / model lifecycle | ✅ | `automl-editor.tsx`, `ml-model-editor.tsx`, `ml-experiment-editor.tsx`, Modeling Objectives via AML |
| MCP (ontology context to external AI) | 🟡 | MCP catalog + deployable servers exist; **no dedicated "Ontology MCP server" exposing Loom objects/actions to external agents** |

### Operational apps
| Foundry | Status | Where in Loom |
| --- | --- | --- |
| Workshop | ✅ | `palantir/workshop-app-editor.tsx` (Atelier) + `workshop/workshop-app-builder.tsx`; ontology-bound, runs actions on Synapse SQL, hosts on ACA. Widget catalog **7 → 12** incl. **per-tab child-widget nesting** (#2235 — live rows rendered inside a tab pane, rev 0000353 receipt). Residual (tracked, non-blocking): further kinds toward Foundry's ~40 |
| Slate | ✅ | `palantir/slate-app-editor.tsx` → deterministic Azure SWA bundle (`docs/fiab/parity/slate-app.md`) |
| Quiver (object analysis) | ✅ | **rayfin** (`lib/editors/rayfin-app-model.ts`, `docs/fiab/parity/rayfin-app.md`) — card catalog **5 → 34** (batch-7 #2237, full Add-component palette visually verified live), exceeding Quiver's ~30-card bar |
| Contour (point-and-click) | ✅ | **analysis-board SHIPPED 2026-07-19** — full item (editor + registrations + backend routes) on real ADX/Cosmos, session-fetch E2E'd; guided-pristine G6 fix rev 0000347. `report-designer.tsx` covers the dashboard tier |
| Fusion (spreadsheet write-back) | ✅ | **fusion-sheet SHIPPED 2026-07-19** — full item, clean grid visually verified, real backend routes E2E'd |
| Notepad | ✅ | **notepad SHIPPED 2026-07-19** — full item, clean empty-state verified; embedded-object depth grows with usage |
| Object Views (embed) | 🟡 | Workshop binds objects and renders live object tables; **no reusable "object view" embeddable component library yet** |

### Actions + write-back + automation
| Foundry | Status | Where in Loom |
| --- | --- | --- |
| Action Types / write-back | ✅ | Ontology AGE write-back + validation rules + invariants (see Ontology table) |
| Activator (Reflex) | ✅ | `phase3/activator-editor.tsx` → Azure Monitor + Logic App callback |
| Webhooks / external functions | ✅ | `logic-app-editor.tsx`, `powerplatform-editors.tsx` |
| Rules engine | ✅ | **object-type invariants SHIPPED + E2E'd rev 0000342 (#2205)** — declared regex invariant → violating write = HTTP 422 |
| Approval workflows | ✅ | **SHIPPED + E2E'd rev 0000341 (#2203)** — block→approve→re-run-succeeds on a real vertex, one-shot approval consumed |
| Automate (unified trigger automation) | 🟡 | Logic Apps + Power Automate + Activator cover triggers; approvals/rules now native to actions; **no single "Ontology Automate" composition surface** |
| **Scenarios / what-if simulation** | ❌ | no scenario-branch/simulation editor — **genuine residual gap** (top of the remaining list) |

### Governance / security
| Foundry | Status | Where in Loom |
| --- | --- | --- |
| Markings / classification | ✅ | Purview: `purview-classification-sync.ts`, `label-policy-library.ts`, MIP client; 4 taxonomies |
| Marking **propagation along lineage** | 🟡 | Purview lineage + `label-propagation.ts`; **not the interactive "change a marking, see impact on all derived" analysis** |
| **Purpose-Based Access Control** | 🟡 | **PARTIAL — honest residual.** RBAC/ABAC + markings + policy store exist; the first-class **"purpose" primitive with purpose-scoped enforcement** is not built |
| Data Lineage app | ✅ | `unified-lineage.ts`, `lineage-canvas.tsx`, `lineage-graph.tsx`; Thread edges + ontology actions (#2202) emit Purview Atlas lineage |
| Audit | ✅ | tamper-evident hash-chained audit; Log Analytics; checkpoint audit chain (#2196) |
| Projects / Orgs boundary | ✅ | workspaces + Purview collections + RG/subscription |
| Checkpoints (justification) | ✅ | **SHIPPED + E2E'd (#2196, #2198)** — in-product justification prompts on sensitive ontology access with audit chain; Entra PIM still covers the Azure-resource tier |
| Retention / export controls | ✅ | **SHIPPED + E2E'd rev 0000341 (#2204)** — CSV/JSON export + real retention-reap, surfaced in the Checkpoints panel |
| Row/column security | ✅ enforcement / 🟡 authoring | RLS/CLS enforced via Synapse/PBI/SQL; **no in-product CREATE SECURITY POLICY authoring UX** (audit row 6.3) |

### DevOps / platform
| Foundry | Status | Where in Loom |
| --- | --- | --- |
| Apollo (zero-downtime CD) | ✅ | `palantir/release-environment-editor.tsx` (Shuttle) — real ARM deploy history + promotions; optional Azure Deployment Environments |
| Marketplace / product bundles | 🟡 | `/marketplace` (API+Data + Delta Sharing), `app-templates.ts`, 21 use-case apps, `.loomapp` export/import + golden templates (loom-apps-parity). **Not yet Foundry's "pipeline+app+model+ontology as one versioned, upgradeable product"** |
| Global branching | 🟡 | Git + workspaces; not coordinated cross-resource branching |
| Health checks | ✅ | `palantir/health-check-editor.tsx` → Azure Monitor scheduledQueryRules |
| Workspace task-flows | ✅ | `TaskFlowsPane` on every workspace (xyflow canvas, real Cosmos CRUD, step↔item links, Run flow, History) — live-verified 2026-07-20; closes the one "unique-to-Fabric/Foundry canvas" note |

### Thread (connective tissue — Loom's answer to Ontology-as-bus)
✅ **HAVE, and it is a genuine Loom advantage.** `lib/thread/thread-actions.ts`
(10 one-click Weave edges: analyze-in-notebook, add-data-agent-source,
build/analyze-in-powerbi, build-powerbi-model, publish-as-api, mirror-to-lakehouse,
etc.) + `lib/thread/thread-edges.ts` (persists every weave to Cosmos + emits
Purview Atlas Process lineage). Where Foundry ties everything to **one** object
model, Thread ties the full Loom catalog together with a lineage-recorded mesh —
and ontology action runs now emit into the same lineage plane (#2202).

---

## Part 3 — Residual gaps (re-ranked 2026-07-20)

The 2026-07-13 edition ranked 13 gaps. **Seven are now closed with receipts**
(Object Explorer, checkpoints, Fusion→fusion-sheet, Notepad, Contour→analysis-board,
Quiver→rayfin catalog, rules/approvals/retention). What remains:

| # | Gap | Type | Why it matters | Status / effort |
| --- | --- | --- | --- | --- |
| **1** | **Scenarios / what-if branching** of the ontology | MISSING | Foundry's signature "simulate before you commit" demo. No Loom analog. | Open · L |
| **2** | **Agent-flow ontology tools + publish-as-Function + Evals gate** | PARTIAL | Agents can't yet query objects / invoke actions (audit 5.2); evals exist but don't gate publish (5.4). Loom apps already publish as API/MCP — extend the loop to agents. | Open · M |
| **3** | **Purpose-Based Access Control (PBAC)** | PARTIAL | Foundry's federal/regulated moat. Markings + policy store exist; the "purpose" primitive with scoped enforcement does not. | Open (honest residual) · L |
| **4** | **Marking propagation + "impact of a marking change" analysis** | PARTIAL | The Data Lineage app's killer governance demo. Lineage is captured; interactive impact analysis isn't. | Open · M |
| **5** | **Vertex — process mining / simulation graph** | DEFERRED | System-of-systems process visualization; Tapestry covers link analysis. **Deferred by decision** — revisit with Scenarios (#1). | Deferred |
| **6** | **Ontology Functions** (server-side TS/Python, function-backed properties/actions) | PARTIAL | Completes ontology-as-logic beyond LLM functions; bind/deploy/invoke plumbing already exists. | Open · M |
| **7** | **Product packaging / Marketplace bundles** (pipeline+app+model+ontology as one versioned product) | PARTIAL | `.loomapp` + golden templates cover apps; the multi-resource versioned bundle story remains. | Open · M |
| **8** | **Pipeline Builder AI-codegen** (one prompt → generated pipeline) | PARTIAL | Foundry's flashiest build-UX demo. Loom has build-assist, not full auto-codegen. | Open · M |
| **9** | **Ontology MCP server** (expose Loom objects to external agents) | PARTIAL | The agentic-interop story. MCP catalog exists; ontology-serving MCP doesn't. | Open · M |
| 10 | AIP-Logic block depth (apply-action, semantic-search, loop, tool-call) | PARTIAL | Rounds out the Logic authoring surface. | Open · S–M |
| 11 | RLS **authoring** UX (CREATE SECURITY POLICY wizard) | PARTIAL | Enforcement is real; authoring is CLI/SQL-only today. | Open · S |
| 12 | Workshop widget kinds 12 → ~40 / Object-View component library | PARTIAL | Depth-of-catalog polish; tracked, non-blocking. | Open · rolling |
| 13 | **Per-surface Foundry parity docs** | DOCS | `docs/fiab/parity/` has 423 docs but only a handful of Foundry-slug docs (ontology, ontology-sdk, aip-logic, workshop-app, slate-app, rayfin-app, foundry-evaluations). New 07-19 items (analysis-board, fusion-sheet, notepad, object-explorer) need parity docs per `ui-parity.md`. | Open (honest residual) · S each |

---

## Part 4 — Build plan status (was "plan to exceed Foundry")

The four phases from the 07-13 edition, with landed/remaining status:

### Phase A — agentic + scenario gaps
1. **Scenarios / what-if branching** — **OPEN** (residual #1). Design stands:
   named branch of the AGE graph (copy-on-write subgraph or transaction-tagged
   overlay in `weave-ontology-store.ts`), scenario switcher in
   `ontology-editor.tsx`, "simulate action → diff → commit/discard" flow.
   **Beat Foundry:** persist scenarios as first-class Loom items with Thread
   lineage + cross-item scenarios (branch a pipeline + report alongside the
   ontology), which Foundry's object-only scenarios can't.
2. **Agent-as-Function loop** — **PARTIAL.** Loom apps publish-as-API/-MCP
   shipped (loom-apps-parity PRP complete); remaining: ontology tools inside
   agent-flow + `lib/foundry/agent-eval.ts` as a publish-time Evals gate.

### Phase B — Governance moat (federal differentiation)
3. **Purpose-Based Access Control** — **OPEN** (residual #3). Plan stands:
   `purpose` primitive in `lib/governance/policy-store.ts`, purpose-tagging UI,
   purpose-scoped enforcement in ontology + data-plane gates, implemented on
   **Purview + Entra + Unity Catalog** so it works in Gov/IL5.
4. **Marking-impact analysis** — **OPEN** (residual #4). Extend
   `label-propagation.ts` + `lineage-canvas.tsx` with the interactive
   "if I change this marking, every derived asset affected" view.
   *(Adjacent governance rows — checkpoints, retention/export, approvals,
   rules — all LANDED with receipts, see Part 2.)*

### Phase C — Ontology completeness + operational apps — **LARGELY LANDED**
5. **Ontology Functions** — OPEN (residual #6).
6. **Quiver/Contour object analysis** — **DONE**: rayfin card catalog → 34;
   analysis-board shipped as a net-new item.
7. **Vertex process graph** — **DEFERRED** (process mining; revisit with
   Scenarios).

### Phase D — Distribution + AI-build polish
8. **Product bundles + upgrades** — PARTIAL (`.loomapp` + templates landed;
   versioned multi-resource bundles open, residual #7).
9. **Pipeline AI-codegen** — OPEN (residual #8).
10. **Ontology MCP server** — OPEN (residual #9).

### Why Loom exceeds Foundry (now demonstrated, not aspirational)
- **No object-store tax / no lock-in** — AGE + Cosmos + Delta + Synapse are open
  and portable; Foundry's Phonograph/OSDK bind you to Palantir.
- **Both clouds incl. Gov/IL5** — every capability runs in Azure Government;
  Foundry's FedRAMP-High footprint is narrower and pricier.
- **Breadth** — Thread ties the full 131+-type catalog together; Foundry's bus
  is the single object model.
- **Fabric + Azure-native parity with live receipts** — signed-in side-by-sides
  graded Loom **≥ Fabric (A/A+)** on Home/item-lists/workspace and **≥ Azure
  portal (A)** on browse (AUDIT, 2026-07-19/20 passes).
- **Governance in the platform of record** — Purview + Entra + Unity Catalog
  instead of a proprietary marking engine, so governance spans the whole Azure
  estate, not just platform-resident data.

---

## Appendix — key source files (Loom, verified 2026-07-20)
- Ontology model + write-back: `apps/fiab-console/lib/editors/ontology-model.ts`, `lib/azure/weave-ontology-store.ts`, `lib/editors/phase4/ontology-editor.tsx`
- Governance-on-actions (07-19 drive): checkpoints/approvals/invariants/retention routes under `app/api/items/ontology/` (PRs #2195–#2219)
- Palantir-branded editors: `lib/editors/palantir/*` (workshop-app, slate-app, ontology-sdk, release-environment, health-check, aip-logic)
- Net-new 07-19 items: analysis-board, fusion-sheet, notepad (editors + registrations + backend routes)
- Thread connective tissue: `lib/thread/thread-actions.ts`, `lib/thread/thread-edges.ts`
- AIP/agents: `lib/editors/palantir/aip-logic-editor.tsx`, `lib/editors/phase4/operations-agent-editor.tsx`, `lib/foundry/agent-eval.ts`, `model-tier-router.ts`
- Governance: `lib/governance/*` (policy-store, label-propagation, dlp/label libraries), `lib/azure/purview-*.ts`, `unified-lineage.ts`
- Registries: `lib/editors/registry.ts`, `lib/catalog/item-types/*`
- **Receipt trail:** `PRPs/active/foundry-parity/AUDIT.md` (gap register + final receipts, PRs #2195–#2242, revs 0000339→0000353), `PRPs/active/foundry-parity/PRP.md`, `docs/fiab/parity/` (ontology.md, ontology-sdk.md, aip-logic.md, workshop-app.md, slate-app.md, rayfin-app.md, foundry-evaluations.md, palantir-migration-surfaces.md)

## Appendix — Foundry sources
- [Foundry platform overview](https://www.palantir.com/docs/foundry/platform-overview/overview)
- [Foundry Ontology](https://www.palantir.com/explore/platforms/foundry/ontology/)
- [AIP features](https://www.palantir.com/docs/foundry/aip/aip-features) · [AIP overview](https://www.palantir.com/docs/foundry/aip/overview)
- [AIP Agent Studio — getting started](https://www.palantir.com/docs/foundry/agent-studio/getting-started) · [Agents as Functions](https://www.palantir.com/docs/foundry/agent-studio/agents-as-functions)
- [Pipeline Builder AIP](https://www.palantir.com/docs/foundry/pipeline-builder/pipeline-builder-aip)
- [Markings](https://www.palantir.com/docs/foundry/security/markings) · [Data Lineage](https://www.palantir.com/docs/foundry/data-lineage/overview) · [Protecting sensitive data](https://www.palantir.com/docs/foundry/security/protecting-sensitive-data)
- Existing Loom docs: `docs/migrations/palantir-foundry/feature-mapping-complete.md` (65-feature map, April 2026)
