# Loom vs Palantir Foundry — capability gap analysis

**Author:** CSA Loom core team
**Date:** 2026-07-13
**Status:** Living analysis. Supersedes the April-2026 gap rows in
`docs/migrations/palantir-foundry/feature-mapping-complete.md` where they
conflict (notably ontology write-back, which is now BUILT).

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
capability surface, maps it against what Loom ships **today** (code-verified,
not doc-only), ranks the gaps, and gives a phased build plan to meet-then-exceed
Foundry.

**Headline finding:** Loom is much further along than the migration docs imply.
The single biggest historical gap — a live, writable Ontology — is **closed**.
Loom now runs a real graph object store (Apache AGE on PostgreSQL Flexible
Server) with typed object types, link types, action types, interfaces, an Object
Explorer, a graph view, and real object/link/action **write-back** through
`lib/azure/weave-ontology-store.ts`. That was listed "out of scope / by design"
as recently as the April feature map. It isn't anymore.

What remains is not "catch up on primitives" — it's **polish, breadth, and three
genuine Foundry differentiators**: (1) **Scenarios / what-if branching** of the
ontology, (2) **Purpose-Based Access Control (PBAC)** as a first-class governance
primitive, and (3) **agent-as-function** composability (AIP Agent Studio →
publish agent → callable anywhere, evaluable, automatable).

Loom's structural advantages over Foundry: **Azure-native with zero vendor
lock-in, both clouds including Gov/IL5, no proprietary object store tax, Fabric
1:1 parity, 131 item types, and Purview/Unity-Catalog governance** that Foundry
has to reimplement in-platform. The connective-tissue story ("tying everything
together") already exists as **Thread** — Loom's cross-item Weave graph — which
is the analog of Foundry's Ontology-as-operational-bus, but spanning 131 item
types instead of one object model.

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

Code-verified against `apps/fiab-console` on 2026-07-13. **123 wired editors,
131 catalog item types.** Legend: ✅ HAVE · 🟡 PARTIAL · ❌ MISSING.

### Ontology
| Foundry | Status | Where in Loom |
| --- | --- | --- |
| Object Types | ✅ | `lib/editors/ontology-model.ts` (19 base types incl. geopoint/timeseries/vector/struct/marking), `lib/editors/phase4/ontology-editor.tsx` (2,495 LOC) |
| Link Types | ✅ | same; 1:1/1:many/many:many, FK or join-table backed |
| Interfaces | ✅ | `ontology-model.ts` — contracts + conformance validation |
| Action Types (**write-back**) | ✅ | typed params, `validateActionRun`; executes on real Apache AGE via `lib/azure/weave-ontology-store.ts` → `/api/items/ontology/[id]/run-action` |
| Functions (server-side) | 🟡 | realized as AIP-Logic/Spindle LLM functions + user-data-functions; **no TS/Python Ontology-Functions repo with function-backed properties** |
| Object Explorer | ✅ | live instance tables in `ontology-editor.tsx`; object/link write-back UI |
| Graph view / Vertex | 🟡 | force-directed IS_A graph (`lib/components/graph/force-directed-graph`) + `tapestry-editor.tsx` (ADX make-graph link analysis + Azure Maps). **No process/simulation Vertex canvas** |
| OSDK | ✅ | `lib/editors/palantir/ontology-sdk-editor.tsx` → typed TS/Python + `dab-config.json` (Data API Builder on ACA + APIM) |
| Object store | ✅ (analytics-grade) | schema→Cosmos; instances→Apache AGE/PostgreSQL. **Not sub-100 ms OLTP** — for that pair with Cosmos/Azure SQL |

**Ontology verdict: near-complete parity.** This is the "tie everything together"
core and it is real, backed, and write-back-capable. The `feature-mapping-complete.md`
"ontology writeback — out of scope" gap is **obsolete**.

### Data integration
| Foundry | Status | Where in Loom |
| --- | --- | --- |
| Pipeline Builder (visual) | ✅ | `data-pipeline-editor.tsx` + `canvas-node-kit.tsx`; ADF default / Fabric opt-in |
| Pipeline Builder **LLM nodes / AI-build** | 🟡 | Copilot build-assist exists; **not the "one-prompt-generates-the-pipeline" auto-codegen UX** |
| Mapping dataflow (Spark) | ✅ | `mapping-dataflow-editor.tsx` → Data Flow Script |
| Dataflow Gen2 (Power Query) | ✅ | `dataflow-gen2-editor.tsx` |
| Eventstream / streaming | ✅ | `phase3/eventstream-editor.tsx`; Event Hubs + Stream Analytics |
| Code Repositories / notebooks | ✅ | `notebook-editor.tsx`, `synapse-notebook-editor.tsx`, `databricks/*`, `spark-job-definition-editor.tsx` |
| Data Connection / connectors | ✅ | linked-service, integration-runtime editors; 70+ connectors |
| Agent worker (on-prem) | ✅ | scale-to-0 SHIRs |
| Media sets / Virtual Tables | 🟡 | ADLS + Doc Intelligence + shortcuts exist; **no unified "media set" item type** |
| Compute Modules (BYO container) | ✅ | ACA / AKS |

### Model integration + AIP
| Foundry | Status | Where in Loom |
| --- | --- | --- |
| AIP Logic (typed LLM function) | ✅ | `palantir/aip-logic-editor.tsx` (Spindle, 892 LOC) → live Azure OpenAI via `chatGrounded`; `/invoke`, `/deploy`, `/run-agent`, `/bind-ontology` |
| AIP Agent Studio (build agent) | 🟡 | `phase4/operations-agent-editor.tsx`, `agent-flow-canvas.tsx`, `copilot-studio-editors.tsx`; multi-tool orchestration. **Missing: "publish agent as a Function callable anywhere + evaluable + automatable"** |
| AIP Assist (in-platform copilot) | ✅ | `/copilot` RAG + `cross-item-copilot-editor.tsx` (32-tool orchestrator) |
| AIP Evals | 🟡 | `foundry-sub-editors.tsx` Evaluation + `lib/foundry/agent-eval.ts`; **not wired as eval-gate on agent/function publish** |
| Language Model Service (governed multi-provider) | ✅ | model-tier-router, model-availability-matrix, APIM policy fallback |
| Text-to-embeddings | ✅ | AI Search index + embeddings |
| AutoML / model lifecycle | ✅ | `automl-editor.tsx`, `ml-model-editor.tsx`, `ml-experiment-editor.tsx`, Modeling Objectives via AML |
| MCP (ontology context to external AI) | 🟡 | MCP catalog exists; **no "Ontology MCP server" exposing Loom objects to external agents** |

### Operational apps
| Foundry | Status | Where in Loom |
| --- | --- | --- |
| Workshop | ✅ | `palantir/workshop-app-editor.tsx` (Atelier) + `workshop/workshop-app-builder.tsx`; ontology-bound, runs actions on Synapse SQL, hosts on ACA |
| Slate | ✅ | `palantir/slate-app-editor.tsx` → deterministic Azure SWA bundle |
| Quiver (object analysis) | 🟡 | Power BI + report designer cover charts; **no Ontology-object-native point-and-click analysis surface** |
| Contour (point-and-click) | 🟡 | `report-designer.tsx` (5,017 LOC), dashboards; **not the Contour "analysis board" paradigm** |
| Fusion (spreadsheet write-back) | ❌ | no spreadsheet-with-writeback item; Excel/Analyze-in-Excel is the doc answer |
| Notepad | 🟡 | markdown docs backlog (task #36); no embedded-object rich-text yet |
| Object Views (embed) | 🟡 | Workshop binds objects; **no reusable "object view" embeddable component library** |

### Actions + write-back + automation
| Foundry | Status | Where in Loom |
| --- | --- | --- |
| Action Types / write-back | ✅ | Ontology AGE write-back (see above) |
| Activator (Reflex) | ✅ | `phase3/activator-editor.tsx` → Azure Monitor + Logic App callback |
| Webhooks / external functions | ✅ | `logic-app-editor.tsx`, `powerplatform-editors.tsx` |
| Automate (rules + approvals) | 🟡 | Logic Apps + Power Automate exist; **no unified Ontology-Automate with approval workflow tied to action types** |
| **Scenarios / what-if simulation** | ❌ | no scenario-branch/simulation editor — **genuine gap** |

### Governance / security
| Foundry | Status | Where in Loom |
| --- | --- | --- |
| Markings / classification | ✅ | Purview: `purview-classification-sync.ts`, `label-policy-library.ts`, MIP client; 4 taxonomies |
| Marking **propagation along lineage** | 🟡 | Purview lineage + `label-propagation.ts`; **not the "change a marking, see impact on all derived" interactive analysis** |
| **Purpose-Based Access Control** | ❌ | RBAC/ABAC + markings exist; **no "purpose" primitive** — genuine gap |
| Data Lineage app | ✅ | `unified-lineage.ts`, `lineage-canvas.tsx`, `lineage-graph.tsx`; Thread edges emit Purview Atlas lineage |
| Audit | ✅ | tamper-evident hash-chained audit; Log Analytics |
| Projects / Orgs boundary | ✅ | workspaces + Purview collections + RG/subscription |
| Checkpoints (justification) | 🟡 | Entra PIM is the doc answer; **not in-product justification prompt on sensitive access** |
| Row/column security | ✅ | RLS/CLS via Synapse/PBI/SQL |

### DevOps / platform
| Foundry | Status | Where in Loom |
| --- | --- | --- |
| Apollo (zero-downtime CD) | ✅ | `palantir/release-environment-editor.tsx` (Shuttle) — real ARM deploy history + promotions; optional Azure Deployment Environments |
| Marketplace / product bundles | 🟡 | `/marketplace` (API+Data + Delta Sharing), `app-templates.ts`, 21 use-case apps. **Not Foundry "package pipeline+app+model+ontology as one installable product with upgrades"** |
| Global branching | 🟡 | Git + workspaces; not coordinated cross-resource branching |
| Health checks | ✅ | `palantir/health-check-editor.tsx` → Azure Monitor scheduledQueryRules |

### Thread (connective tissue — Loom's answer to Ontology-as-bus)
✅ **HAVE, and it is a genuine Loom advantage.** `lib/thread/thread-actions.ts`
(10 one-click Weave edges: analyze-in-notebook, add-data-agent-source,
build/analyze-in-powerbi, build-powerbi-model, publish-as-api, mirror-to-lakehouse,
etc.) + `lib/thread/thread-edges.ts` (persists every weave to Cosmos + emits
Purview Atlas Process lineage). Where Foundry ties everything to **one** object
model, Thread ties **131 item types** together with a lineage-recorded mesh.

---

## Part 3 — Ranked gaps

Ranked by **demo-impact × strategic value** (closing the "do everything Foundry
does, and better" mandate). Score = how visible in a head-to-head demo + how much
it's a real Foundry moat.

| # | Gap | Type | Why it matters | Effort |
| --- | --- | --- | --- | --- |
| **1** | **Scenarios / what-if branching** of the ontology | MISSING | Foundry's signature "simulate before you commit" demo; the operational decision-making story. No Loom analog. | L |
| **2** | **AIP Agent Studio → publish agent as Function + Evals gate** | PARTIAL | The 2025 Foundry headline (agentic). Loom has the pieces (aip-logic, agent-flow, eval lib) but not the "build → publish → callable/automatable/evaluable everywhere" loop. | M |
| **3** | **Purpose-Based Access Control (PBAC)** | MISSING | Foundry's federal/regulated moat. Loom has markings but not "purpose." High strategic value for Gov. | L |
| **4** | **Marking propagation + "impact of a marking change" analysis** | PARTIAL | The Data Lineage app's killer governance demo. Loom captures lineage but doesn't do interactive impact analysis. | M |
| **5** | **Product packaging / Marketplace bundles** (pipeline+app+model+ontology as one installable, upgradeable product) | PARTIAL | Foundry Marketplace + Apollo upgrade story. Loom has templates + app installs but not versioned product bundles. | M |
| **6** | **Ontology Functions** (server-side TS/Python, function-backed properties/actions) | PARTIAL | Completes the ontology-as-logic layer beyond LLM functions. | M |
| **7** | **Quiver/Contour — object-native point-and-click analysis** | PARTIAL | Analyst-facing exploration over live objects (not just PBI over datasets). | M |
| **8** | **Pipeline Builder AI-codegen** (one prompt → generated pipeline) | PARTIAL | Foundry's flashiest build-UX demo. Loom has build-assist, not full auto-codegen. | M |
| **9** | **Vertex — process/simulation graph** | PARTIAL | System-of-systems visualization; Tapestry covers link analysis but not process simulation. | L |
| **10** | **Ontology MCP server** (expose Loom objects to external agents) | PARTIAL | The agentic-interop story; growing fast. Loom has MCP catalog but no ontology-serving MCP. | M |
| 11 | Fusion spreadsheet write-back | MISSING | Analyst quality-of-life; lower demo weight. | M |
| 12 | Notepad / embedded-object rich text | PARTIAL | Overlaps workspace-docs backlog (#36). | S |
| 13 | In-product checkpoint justification prompts | PARTIAL | Governance polish; PIM covers most. | S |

---

## Part 4 — Build plan to exceed Foundry

Sequenced into four phases. Each leverages a **Loom advantage** so we don't just
match Foundry — we beat it on openness, dual-cloud, and breadth. Every item obeys
the die-hard rules: Azure-native default, Fabric opt-in, real backend, no
vaporware, UX-baseline ≥ Fabric grade.

### Phase A — Close the two agentic + scenario gaps (highest demo impact)
1. **Scenarios / what-if branching** (gap #1). Model a scenario as a **named
   branch of the AGE graph** (copy-on-write subgraph or transaction-tagged
   overlay in `weave-ontology-store.ts`), a scenario switcher in
   `ontology-editor.tsx`, and a "simulate action → diff → commit/discard" flow.
   **Beat Foundry:** persist scenarios as first-class Loom items with Thread
   lineage + Purview provenance, and allow *cross-item* scenarios (branch a
   pipeline + a report alongside the ontology), which Foundry's object-only
   scenarios can't.
2. **Agent-as-Function loop** (gap #2). Add "Publish as Function" to
   `operations-agent-editor.tsx` / aip-logic so any agent becomes a callable
   item usable in Thread, Automate, and other editors; wire `lib/foundry/agent-eval.ts`
   as a **publish-time Evals gate**. **Beat Foundry:** the published function is
   also an **MCP tool** and an **APIM-governed REST endpoint** automatically
   (dual-cloud, no lock-in).

### Phase B — Governance moat (federal differentiation)
3. **Purpose-Based Access Control** (gap #3). Add a `purpose` primitive to the
   policy store (`lib/governance/policy-store.ts`), a purpose-tagging UI, and
   purpose-scoped query enforcement in the ontology + data-plane gates. **Beat
   Foundry:** implement on **Purview + Entra + Unity Catalog** so purpose travels
   into Azure-native services, not just an in-platform construct — and it works
   in Gov/IL5.
4. **Marking-impact analysis** (gap #4). Extend `label-propagation.ts` +
   `lineage-canvas.tsx` with an interactive "if I change this marking, here's
   every derived asset affected" view over the existing Purview lineage graph.

### Phase C — Ontology completeness + operational apps
5. **Ontology Functions** (gap #6): TS/Python user-data-functions bound to object
   types, function-backed computed properties, function-backed actions —
   deployed as ACA/Azure Functions, registered against the ontology.
6. **Quiver/Contour object analysis** (gap #7): an object-native point-and-click
   analysis surface reading the AGE store directly (charts, filters, aggregates
   over live objects), themed to Loom, distinct from dataset-level PBI.
7. **Vertex process graph** (gap #9): extend the force-directed / Tapestry canvas
   into process/simulation visualization tied to scenarios from Phase A.

### Phase D — Distribution + AI-build polish
8. **Product bundles + upgrades** (gap #5): a "Loom Product" packaging format
   (ontology + pipelines + apps + models + Thread edges) installable from
   `/marketplace` with versioning, atop the existing Shuttle/ARM promotion
   engine — Loom's Apollo analog, extended to app bundles.
9. **Pipeline AI-codegen** (gap #8): one-prompt → generated pipeline graph in
   `data-pipeline-editor.tsx`, emitting real ADF/Spark, using the model-tier
   router.
10. **Ontology MCP server** (gap #10): an MCP server (deployable from the MCP
    catalog) that exposes Loom object types/instances/actions as tools for
    external agents — the interop capstone.

### Why Loom exceeds Foundry when this lands
- **No object-store tax / no lock-in** — AGE + Cosmos + Delta + Synapse are open
  and portable; Foundry's Phonograph/OSDK bind you to Palantir.
- **Both clouds incl. Gov/IL5** — every capability runs in Azure Government;
  Foundry's FedRAMP-High footprint is narrower and pricier.
- **Breadth** — Thread ties **131 item types** together; Foundry's bus is the
  single object model. Loom's connective tissue is wider.
- **Fabric + Azure-native parity** — Loom users get Foundry-class operational
  apps *and* the full Fabric/Power BI/Synapse/Databricks/Purview estate in one
  pane; Foundry reimplements each of those in-house.
- **Governance in the platform of record** — Purview + Entra + Unity Catalog
  instead of a proprietary marking engine, so governance spans the whole Azure
  estate, not just Foundry-resident data.

---

## Appendix — key source files (Loom, code-verified 2026-07-13)
- Ontology model + write-back: `apps/fiab-console/lib/editors/ontology-model.ts`, `lib/azure/weave-ontology-store.ts`, `lib/editors/phase4/ontology-editor.tsx`
- Palantir-branded editors: `lib/editors/palantir/*` (workshop-app, slate-app, ontology-sdk, release-environment, health-check, aip-logic)
- Thread connective tissue: `lib/thread/thread-actions.ts`, `lib/thread/thread-edges.ts`
- AIP/agents: `lib/editors/palantir/aip-logic-editor.tsx`, `lib/editors/phase4/operations-agent-editor.tsx`, `lib/foundry/agent-eval.ts`, `model-tier-router.ts`
- Governance: `lib/governance/*` (policy-store, label-propagation, dlp/label libraries), `lib/azure/purview-*.ts`, `unified-lineage.ts`
- Registries: `lib/editors/registry.ts` (123 editors), `lib/catalog/item-types/*` (131 item types)

## Appendix — Foundry sources
- [Foundry platform overview](https://www.palantir.com/docs/foundry/platform-overview/overview)
- [Foundry Ontology](https://www.palantir.com/explore/platforms/foundry/ontology/)
- [AIP features](https://www.palantir.com/docs/foundry/aip/aip-features) · [AIP overview](https://www.palantir.com/docs/foundry/aip/overview)
- [AIP Agent Studio — getting started](https://www.palantir.com/docs/foundry/agent-studio/getting-started) · [Agents as Functions](https://www.palantir.com/docs/foundry/agent-studio/agents-as-functions)
- [Pipeline Builder AIP](https://www.palantir.com/docs/foundry/pipeline-builder/pipeline-builder-aip)
- [Markings](https://www.palantir.com/docs/foundry/security/markings) · [Data Lineage](https://www.palantir.com/docs/foundry/data-lineage/overview) · [Protecting sensitive data](https://www.palantir.com/docs/foundry/security/protecting-sensitive-data)
- Existing Loom docs: `docs/migrations/palantir-foundry/feature-mapping-complete.md` (65-feature map, April 2026)
