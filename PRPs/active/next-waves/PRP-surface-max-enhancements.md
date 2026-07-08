# Every Loom Surface to Max Capability — Designers, Canvases, Wizards, Apps, UX

> **Goal:** Take CSA Loom's *own* surfaces — the canvases, designers, wizards,
> editors, use-case apps, and cross-item intelligence — **past 100% of the
> Fabric baseline** and into the collaborative, agentic, self-explaining tier
> that Figma / Databricks / Palantir Foundry set. Every proposal here ships on
> an **Azure-native (or OSS-on-Azure) backend**, is **bicep-synced**, and works
> **day-one in Azure Commercial and Azure Government** with **no hard Microsoft
> Fabric / Power BI dependency** (Fabric backends remain opt-in only).
>
> Author: Loom Own-Surface Max-Capability Architect · Date: 2026-07-08 ·
> Status: **proposed**
>
> Sources consulted: direct code review of `apps/fiab-console/lib/**`
> (canvas/editor/catalog/apps subsystems, with file:line evidence per item);
> the die-hard rules `.claude/rules/no-vaporware.md`, `no-fabric-dependency.md`,
> `ui-parity.md`; the sibling `PRPs/active/fabric-parity/` effort (completeness
> vs. Fabric is tracked there — **this PRP deliberately does not duplicate it**);
> and grounding docs for each source-product UX pattern (Microsoft Learn, Azure
> Web PubSub / Durable Functions / Retail Prices API / Event Grid / Monitor,
> Yjs CRDT, Open Data Contract Standard).

---

## 1. Executive summary

Loom's own surfaces are **already far more mature than a "parity audit" would
assume**, and this PRP starts from that honest baseline. The report designer
(`lib/editors/report/*`, a 3,900+ line `report-designer.tsx`) already ships
bookmarks, conditional formatting, slicers, cross-visual interactions, themes,
what-if parameters, and real PDF/PPTX/PNG/XLSX/DOCX export. The pipeline canvas
(`lib/components/pipeline/canvas.tsx`) already has ELK auto-layout, ADF-parity
keyboard shortcuts, a template gallery, drill-in containers, and a MiniMap.
`canvas-node-kit.tsx` is a genuinely well-engineered shared visual system
(five-category accent model, framed containers, typed animated edges,
theme-aware tokens). The MCP catalog (2,298 lines) and its admin wizard are
deep. The Fabric IQ editors (`foundry-hub-editor` 1,990 lines, `rayfin-app-editor`
1,123 lines, `graph-model-editor` 912 lines) are **no longer "basic"** despite
the 06-30 memory note — they have had substantial work since.

So the strategic bet here is **not** "fill completeness holes." That is the
`fabric-parity` PRP's job. The bet is: **Loom has enough surface depth that the
next unit of value comes from cross-cutting capability layers that no single
editor owns** — the things that turn a deep tool into a *platform*. Direct grep
confirms these are genuinely absent today, not merely thin:

- **No undo/redo on any canvas.** `handleKeyDown` in `canvas.tsx` (lines
  326-353) maps I/O/F/A/N/Backspace/Shift+Arrows but no Ctrl+Z; a repo-wide
  grep for an action-history stack returns only a browser `confirm()` dialog.
  This is the single most-felt gap in any design tool and it is P0.
- **No copy/paste/duplicate node, no align/distribute, no shortcut
  discoverability overlay** — the canvas keyboard model is rich but incomplete
  and undiscoverable.
- **No real-time multi-user co-authoring** anywhere — no Yjs, no WebSocket, no
  Liveblocks, no presence layer in the entire app. Fabric and Databricks both
  co-author; Loom is single-editor.
- **No in-editor version-history / visual diff UI** despite a real 584-line
  `git-integration-client.ts` backend already wired to Azure DevOps.
- **No ambient/inline Copilot on canvases** — only side-panel chat.
- **No cross-catalog impact analysis** before a destructive edit/delete, even
  though `lineage-canvas.tsx` already renders the lineage graph.
- **No generalized agent-flow canvas** that chains multiple deployed MCP tools;
  the Copilot-Studio topic canvas is the only flow-graph over logic, and it is
  scoped to conversational topics, not reusable automation.

Beyond those cross-cutting layers, code review surfaced **five genuinely
new item types** no catalog category covers (data contract, data-quality rule
engine, synthetic data generator, incident/runbook, FinOps what-if simulator)
and **two app-lifecycle gaps** (no clone/fork of an installed use-case app, no
version-upgrade path) confirmed by empty greps against the install route and
bundle index.

Every backend named below is Azure-native or OSS-on-Azure. The two
collaboration items gate behind `LOOM_WEBPUBSUB_ENDPOINT` and silently fall back
to today's single-editor mode when unset — an **honest gate, not a dependency**,
per `no-vaporware.md`. Nothing here reaches `api.fabric.microsoft.com` or
`api.powerbi.com` on any default path.

---

## 2. Work items

| # | Item | Category | State | Priority | Effort |
|---|------|----------|-------|----------|--------|
| W1 | Action-level undo/redo on every canvas | Canvas UX layer | MISSING | **P0** | M |
| W2 | Copy/paste + duplicate-node on canvases | Canvas UX layer | MISSING | P1 | S |
| W3 | Multi-select align/distribute toolbar | Canvas UX layer | PARTIAL | P2 | S |
| W4 | Canvas comments / sticky-note annotations | Collaboration | MISSING | P1 | M |
| W5 | Real-time co-authoring (live cursors/presence) — canvases **and** notebooks | Collaboration | MISSING | P1 | XL |
| W6 | In-editor version-history timeline + visual diff | ALM / editor chrome | PARTIAL | P1 | L |
| W7 | Ambient/inline Copilot ghost-node suggestions on canvas | AI layer | MISSING | P2 | L |
| W8 | Cross-catalog impact analysis before delete/edit | Governance / catalog | MISSING | P1 | M |
| W9 | Generalized Agent Flow Designer (chains MCP tools) | New item type | PARTIAL | P1 | XL |
| W10 | Data Contract item type (schema + SLA + breaking-change gate) | New item type | MISSING | P1 | L |
| W11 | Data Quality Rule Engine item | New item type | MISSING | P1 | L |
| W12 | Synthetic Data Generator item | New item type | MISSING | P2 | M |
| W13 | Incident / Runbook item (Azure Monitor-tied) | New item type | MISSING | P2 | M |
| W14 | FinOps what-if capacity/cost simulator | Admin surface | PARTIAL | P2 | M |
| W15 | Use-case app clone/fork (re-run with new params) | App lifecycle | MISSING | P2 | M |
| W16 | Use-case app version-upgrade path | App lifecycle | MISSING | P3 | M |
| W17 | Report designer mobile/phone layout view | Report designer | MISSING | P3 | M |
| W18 | Marketplace listing analytics + subscriber SLA webhooks | Marketplace | PARTIAL | P2 | M |
| W19 | Cross-item "Explain this" Copilot (pipelines/notebooks/warehouses) | AI layer | PARTIAL | P2 | S |
| W20 | Canvas shortcut cheat-sheet / discoverability overlay ("?") | Canvas UX layer | MISSING | P3 | S |
| W21 | Command-palette coverage for canvas-scoped actions | UX / command palette | PARTIAL | P3 | S |
| W22 | Learning Hub interactive sandbox labs | Learning Hub | PARTIAL | P3 | L |

**Suggested wave grouping** (each wave is independently shippable and
build-gated):

- **Wave A — Canvas power layer (fast wins):** W1, W2, W3, W20, W21. One shared
  `useCanvasHistory` hook + clipboard + toolbar + overlay + palette wiring.
  Mostly client-side, zero-to-minimal backend, immediate UX payoff. Do first.
- **Wave B — Cross-item intelligence:** W6, W7, W8, W19. Reuse the single AOAI
  client and the existing lineage/git backends.
- **Wave C — Collaboration:** W4, W5, W22 (sandbox), and the notebook half of
  W5. Shared Web PubSub + Yjs foundation.
- **Wave D — New item types:** W9, W10, W11, W12, W13, W14. Each is a catalog
  registration + provisioner + editor.
- **Wave E — App & marketplace lifecycle:** W15, W16, W17, W18.

---

## 3. Work items in detail

Every editor/canvas UI must be **Fluent v9 + Loom tokens**, reuse
`canvas-node-kit.tsx` for any node/edge chrome, and use **wizards / dropdowns /
canvas — never a freeform JSON textarea** (per the no-freeform-config global
rule). Every new item type must be catalog-registered and bicep-synced.

---

### W1 — Action-level undo/redo (Ctrl+Z / Ctrl+Shift+Z) on every canvas — **P0 · M**

**Capability.** A command-pattern history stack so any canvas edit (add/move/
delete node, edit config, connect/disconnect edge) is reversible, matching the
baseline every design tool (Figma, VS Code, ADF Studio) sets.

**Source grounding.** ADF Studio canvas UX; VS Code / Figma undo model — the
universally-expected `Ctrl+Z` / `Ctrl+Shift+Z` contract.

**Current Loom state — MISSING.** `lib/components/pipeline/canvas.tsx`
`handleKeyDown` (lines 326-353) maps I/O/F/A/N/Backspace/Shift+Arrows but **no
Ctrl+Z**. Grep for an `undo|redo` history stack across `lib/components/pipeline`
and `lib/editors/notebook-editor.tsx` returns only a browser `confirm()` dialog
(`notebook-editor.tsx:1330`). There is no history model anywhere.

**Azure-first / OSS build.**
- *Client:* a new `useCanvasHistory` hook holding `past[]` / `future[]` stacks
  of `{nodes, edges, config}` snapshots, wired into `canvas.tsx`,
  `mapping-dataflow-designer.tsx`, `report/free-form-canvas.tsx`, and
  `phase4/graph-model-editor.tsx`. Snapshot on each committed mutation
  (debounced for drags via the existing `handleNodesChange` position-capture).
- *Keys:* bind `Ctrl+Z` / `Ctrl+Shift+Z` (+ `Cmd` on mac) in the existing
  `handleKeyDown`.
- *Backend:* **none.** Undo state is transient client memory; the committed
  state still PATCHes the item document through the existing per-type save
  route. No new Azure resource, no bicep.
- *Gov:* no cloud dependency → identical behavior in all clouds.

**Acceptance (real-backend receipt).** In a deployed console with
`LOOM_DEFAULT_FABRIC_WORKSPACE` unset: add three activities to a pipeline,
`Ctrl+Z` ×3 removes them in reverse order, `Ctrl+Shift+Z` ×3 restores them,
Save PATCHes the final `activities[]` to the real backend, reload shows the
persisted graph. Physical Playwright key events (not DOM-synthetic) confirm the
bindings. Same walk on the dataflow, report free-form, and graph-model canvases.

---

### W2 — Copy/paste + duplicate-node on canvases — **P1 · S**

**Capability.** `Ctrl+C` / `Ctrl+V` / `Ctrl+D` on selected node(s), matching
Figma / Miro / ADF Studio, so authors stop re-dragging every activity from the
palette.

**Current Loom state — MISSING.** The `canvas.tsx` keyboard map has no
`Ctrl+C/V/D` handler; each new activity must be dragged fresh.

**Azure-first / OSS build.** Serialize selected node(s) config to an in-memory
clipboard object on `Ctrl+C`; on `Ctrl+V` re-hydrate with a `+40/+40` position
offset and a name-suffix disambiguator; `Ctrl+D` duplicates in place. Pure
client change to `canvas.tsx` / `mapping-dataflow-designer.tsx`, feeding the
existing `activities[]` PATCH route. **Zero backend / bicep.** Cloud-agnostic.

**Acceptance.** Copy a configured Copy activity, paste it, confirm the pasted
node carries the same config (not a blank template) with a unique name, Save
persists both to the real backend, reload confirms.

---

### W3 — Multi-select align / distribute toolbar — **P2 · S**

**Capability.** Align-left/center/right + distribute-horizontal/vertical for a
multi-selection, matching ADF Studio / Figma.

**Current Loom state — PARTIAL.** React Flow's native rubber-band multi-select
is available, but `canvas.tsx` exposes no align/distribute actions; its top-right
`Panel` (lines 400-423) only hosts MiniMap/zoom controls.

**Azure-first / OSS build.** Add an align/distribute action group to the
existing `Panel`, computing new x/y from the selected nodes' bounding box and
writing back through the same `handleNodesChange` position-capture path.
**No backend / bicep.** Cloud-agnostic.

**Acceptance.** Select 4 mis-aligned nodes, click "align top" then "distribute
horizontally", verify equal spacing and shared top edge, Save persists the new
positions to the real item document.

---

### W4 — Canvas comments / sticky-note annotations — **P1 · M**

**Capability.** Free-floating notes and node-anchored comments for team review,
matching Miro / Figma / Databricks notebooks.

**Current Loom state — MISSING.** Grep for `annotation|sticky-note|CanvasComment`
across `lib/components` returns only an unrelated map-legend hit in
`azure-maps-canvas.tsx`.

**Azure-first / OSS build.**
- *UI:* a new `CanvasComment` node type in `canvas-node-kit.tsx`, rendered as a
  free-floating note anchored to an x/y or a node id, with author avatar +
  timestamp + resolve toggle. Fluent v9 + Loom tokens.
- *Backend:* persisted as a `comments[]` array on the item's **existing Cosmos
  document** (no new container) via the per-type save route; author/timestamp
  from the minted session. Unread badge via the existing notification/toast
  plumbing.
- *Bicep:* none (reuses the Cosmos items container).
- *Gov:* Cosmos is day-one in all clouds → no gate.

**Acceptance.** Two users (or one user, two sessions) add comments to a pipeline
canvas; both persist to Cosmos and survive reload; resolving a comment flips its
state in the real document; the unread badge fires through existing toasts.

---

### W5 — Real-time co-authoring: live cursors / presence on canvases and notebooks — **P1 · XL**

**Capability.** Multiple users editing one canvas or one notebook simultaneously,
with live cursors, presence avatars, and conflict-free node-position / property /
cell-buffer sync — the Figma / Databricks / Fabric co-authoring bar. (Folds in
the separately-surfaced notebook multi-cursor + cell-comment finding — same
foundation.)

**Current Loom state — MISSING.** Grep for `yjs|websocket|liveblocks|presence`
across `lib/` returns only unrelated hits (policy "presence" fields). No CRDT
doc, no WebSocket channel anywhere. `notebook-editor.tsx` (2,937 lines) is deep
on Monaco/LSP/execution but has no presence or comment layer.

**Azure-first / OSS build.**
- *Backend:* **Azure Web PubSub** (Azure-native, serverless WebSocket relay,
  GA in Commercial and Gov) as the presence/sync transport. **Yjs** (OSS,
  MIT-licensed CRDT) for conflict-free node-position/property-diff sync in
  `canvas.tsx` and for the Monaco cell buffers in `notebook-editor.tsx`. A thin
  BFF route mints Web PubSub client access tokens scoped to the item id
  (`{ok,data:{url},error}` shape).
- *Notebook comments:* per-cell comment threads stored alongside the notebook
  item's `cells[]` array in the existing Cosmos document (no new container).
- *Honest gate:* the whole feature is behind `LOOM_WEBPUBSUB_ENDPOINT`. **If
  unset, editors silently fall back to today's single-editor mode** — a Fluent
  MessageBar `intent="info"` on a "collaborators" affordance names the env var
  and links the bicep module, per `no-vaporware.md`. **This is never a hard
  dependency and never a Fabric one.**
- *Bicep:* new `Microsoft.SignalRService/webPubSub` module wired into the
  admin-plane orchestrator; `LOOM_WEBPUBSUB_ENDPOINT` added to the `apps[]` env
  list; Console UAMI granted the Web PubSub Service Owner role on the resource.
- *Gov:* Web PubSub is available in Azure Government; the same module deploys
  with the Gov ARM endpoints. No M365/Fabric coupling.

**Acceptance.** With `LOOM_WEBPUBSUB_ENDPOINT` set, two browser sessions open the
same pipeline canvas; moving a node in session A appears in session B within
~200ms with a live cursor and presence avatar; concurrent edits to different
nodes both persist (CRDT merge) with no lost update; Save writes the merged
graph to the real backend. Repeat on a notebook (concurrent cell edits +
per-cell comment). With the env var **unset**, the editor loads normally in
single-editor mode and shows the honest MessageBar — no error, no blank surface.

---

### W6 — In-editor version-history timeline + visual diff — **P1 · L**

**Capability.** A per-item panel listing prior versions with a side-by-side
config diff and restore — the Databricks Repos / Fabric Git-history experience,
in-editor.

**Current Loom state — PARTIAL.** `lib/clients/git-integration-client.ts` (584
lines) implements real ADO/git plumbing (`ADO_ZERO_OBJECT_ID` etc.), but grep
for `version-history|revision-history|diff-view` across `lib/` returns nothing —
no in-editor panel exposes prior versions or a config diff.

**Azure-first / OSS build.**
- *UI:* a `VersionHistoryPanel` mounted in `item-editor-chrome.tsx` listing
  commits from `git-integration-client.ts` (already wired to Azure DevOps
  repos), **plus Cosmos change-feed snapshots as a fallback** when no git repo
  is connected. Side-by-side JSON/config diff reuses the **Monaco diff editor
  already bundled** for notebook-lsp — no new dependency.
- *Backend:* Azure DevOps Repos REST (existing client) + Cosmos change feed
  (existing store). Restore = PATCH the item to the selected snapshot through
  the per-type save route.
- *Bicep:* none for the Cosmos path; the ADO path uses the already-documented
  git-integration config.
- *Gov:* Azure DevOps + Cosmos both available in Gov; change-feed fallback works
  with zero external dependency.

**Acceptance.** Open a warehouse/report/pipeline item, view ≥3 prior versions in
the panel (from ADO if connected, else Cosmos change feed), diff two versions in
the Monaco diff view, restore an older one, confirm the real backend now serves
the restored config on reload.

---

### W7 — Ambient / inline Copilot ghost-node suggestions on canvas — **P2 · L**

**Capability.** A dashed "ghost" next-step node the author accepts with Tab —
GitHub Copilot inline-suggestion / Databricks Assistant, applied to the canvas
(not just the side chat).

**Current Loom state — MISSING.** Grep for `ghost-text|inline-suggest|next-activity-suggest`
across `lib/copilot` and `lib/editors` returns nothing;
`cross-item-copilot-editor.tsx` and `dataflow-copilot-pane.tsx` are side-panel
chat, never inline-on-canvas.

**Azure-first / OSS build.** A `CanvasCopilotHint` overlay in
`canvas-node-kit.tsx` renders a dashed ghost `CanvasNode` preview at the natural
next-step position, driven by the **existing single `aoai-chat-client`** (per
the Phase-0 AOAI consolidation) reasoning over the current `activities[]`/`edges[]`
graph. Accept-with-Tab wires straight into the existing `onDropPaletteKey` path.
Backend = the one AOAI deployment already provisioned; **no new resource**. The
suggestion call is behind the same AOAI honest-gate every other Copilot surface
uses. Gov: uses the Gov AOAI deployment; no change.

**Acceptance.** On a pipeline with a Copy activity selected, a ghost "Validation"
or "Data flow" node appears at the next position sourced from a **real AOAI
completion** (network trace shows the AOAI call, not a canned array); Tab
materializes it as a configured node; Save persists it to the real backend.

---

### W8 — Cross-catalog impact analysis before delete/edit — **P1 · M**

**Capability.** A "what breaks downstream if I change/delete this" confirmation
listing consuming items by real id + name — Palantir Foundry impact analysis /
dbt exposures.

**Current Loom state — MISSING.** `lib/components/catalog/lineage-canvas.tsx`
renders lineage visually, but grep for `impact-analysis|what-breaks|downstream-impact`
returns nothing — no pre-delete/pre-edit warning surfaces consuming items.

**Azure-first / OSS build.** A `getDownstreamConsumers(itemId)` resolver over the
existing lineage graph store backing `lineage-canvas.tsx` (Cosmos lineage edges
+ Purview lineage), surfaced as a **blocking confirmation dialog** before any
destructive PATCH/DELETE on `/api/items/[type]/[id]`. The dialog lists consuming
pipelines/reports/semantic-models by real id + name, each a click-through link.
Backend = existing lineage store + Purview lineage client (both day-one).
Bicep: none. Gov: Purview + Cosmos available in Gov.

**Acceptance.** Delete a lakehouse table that a report and a pipeline consume;
the dialog lists both by real name/id (verified against the actual lineage
store, not a stub); cancel aborts the DELETE; confirm proceeds and the real
backend removes the item.

---

### W9 — Generalized Agent Flow Designer (chains deployed MCP tools) — **P1 · XL**

**Capability.** A canvas where each node invokes one MCP tool from the
already-provisioned catalog, with branching/looping and typed input/output
ports, runnable by any item type as reusable automation — n8n / LangGraph visual
builder, generalized beyond the Copilot-Studio topic canvas.

**Current Loom state — PARTIAL.** `lib/editors/copilot-topic-canvas.tsx` exists
but is scoped to Copilot Studio conversational topics; `lib/mcp/catalog.ts`
(2,298 lines) + `mcp-catalog-wizard.tsx` (614 lines) manage MCP server
*provisioning* but there is **no canvas that sequences/branches calls across
multiple deployed MCP servers** as a reusable automation.

**Azure-first / OSS build.**
- *New item type* `agent-flow`, catalog-registered, reusing `canvas-node-kit.tsx`
  node chrome. Each node = one MCP tool (picked from the provisioned catalog)
  with typed input/output ports drawn from the tool's schema; edges carry typed
  data; branch/loop nodes for control flow. **No freeform JSON** — tool inputs
  are dropdown/typed-field bound to the tool schema.
- *Execution:* a new **Azure Durable Functions** orchestration (Azure-native
  durable-execution engine) walks the graph, calling each MCP server's endpoint
  in sequence/parallel per the topology, with fan-out/fan-in for parallel
  branches. Each step logs to the item's **run-history the same way
  `pipeline-editor` already does**.
- *BFF:* `/api/items/agent-flow/[id]/run` starts the orchestration and streams
  status; `{ok,data,error}` shape.
- *Bicep:* Durable Functions app + task-hub storage module wired into the
  admin-plane orchestrator; `LOOM_AGENTFLOW_ORCHESTRATOR` env var; Console UAMI
  granted invoke rights. Honest gate if the orchestrator is not deployed.
- *Gov:* Durable Functions is GA in Gov; MCP servers are the already-Gov-vetted
  catalog set.

**Acceptance.** Build a 3-node flow (MS-Learn search → AOAI summarize →
write-to-lakehouse) over three real provisioned MCP servers; Run executes the
Durable orchestration end-to-end; run-history shows each step's real MCP
response (first 300 chars logged); the output lands in a real Delta table. With
the orchestrator env var unset, the editor renders with an honest gate.

---

### W10 — Data Contract item type (schema + SLA + breaking-change gate) — **P1 · L**

**Capability.** A first-class contract binding a dataset's schema + SLA, with a
CI-style breaking-change gate that blocks incompatible upstream changes and
marketplace publish — Open Data Contract Standard / dbt contracts pattern.

**Current Loom state — MISSING.** `apps/fiab-console/lib/catalog/item-types/`
has no `data-contract` slug across any category file; `csa-data-products.ts` has
only 4 items, none contract-shaped.

**Azure-first / OSS build.**
- *New item type* backed by a JSON-schema contract stored in the existing Cosmos
  items container. Authored via a **wizard** (columns, types, nullability, SLA
  freshness/volume targets) — not a raw JSON textarea.
- *Enforcement:* validated on every upstream lakehouse/warehouse schema change
  via a Synapse/ADF pipeline post-hook. **`schema-compat-validator.ts` already
  exists — extend it** to gate contract violations (added/removed/retyped
  columns vs. the contract).
- *UI:* a pass/fail badge on the data-product detail page; a breaking change
  **blocks marketplace publish**.
- *Bicep:* none new (reuses Cosmos + existing pipeline hooks).
- *Gov:* fully Azure-native; Synapse/ADF/Cosmos all day-one in Gov.

**Acceptance.** Define a contract on a lakehouse table; drop a required column
upstream; the extended `schema-compat-validator` flags a **real** breaking
change (verified against the actual table schema, not a stub); the detail-page
badge flips to fail; a marketplace publish attempt is blocked with the reason.

---

### W11 — Data Quality Rule Engine item — **P1 · L**

**Capability.** A standalone, schedulable, reusable rule set (not-null, range,
regex, referential, freshness, volume-anomaly) with a DQ scorecard — Great
Expectations / Databricks Lakehouse Monitoring pattern.

**Current Loom state — MISSING.** No `data-quality`/`dq-rule` slug in any
`lib/catalog/item-types/*.ts`; validation exists only as an ADF-style
`Validation` activity inside pipelines (`ACTIVITY_ICONS 'Validation'` in
`canvas-node-kit.tsx`), never as a reusable schedulable rule set.

**Azure-first / OSS build.**
- *New item type* storing **declarative rules** (authored via wizard/dropdowns,
  no freeform JSON) compiled to generated T-SQL / KQL / PySpark checks.
- *Execution:* runs via **Synapse Serverless SQL / ADX / Databricks jobs** on a
  schedule (reuse the existing scheduler). Results land in a **dedicated Cosmos
  container** feeding a DQ scorecard.
- *Visual:* the scorecard **reuses the existing `kql-dashboard` tile model** for
  its charts — no new viz stack.
- *Bicep:* new Cosmos container (via cosmos-client `createIfNotExists` or a
  Cosmos init step) per the bicep-sync rule; wire into the scheduler.
- *Gov:* Synapse/ADX/Databricks/Cosmos all day-one in Gov.

**Acceptance.** Author a rule set (not-null + range + freshness) against a real
warehouse table; schedule it; a run generates + executes **real** T-SQL/KQL
against the live backend; results write to the DQ Cosmos container; the
scorecard tile renders real pass/fail counts (network trace shows the real
query, not a mock).

---

### W12 — Synthetic Data Generator item — **P2 · M**

**Capability.** Privacy-safe, schema-driven synthetic rows for DLP-safe demos
and load testing — generalizing the fixed-sample-data pattern.

**Current Loom state — MISSING.** No `synthetic-data` slug across
`item-types/*.ts`; `app-supercharge-*` bundles seed **fixed** sample datasets,
not schema-driven generation.

**Azure-first / OSS build.** A new item type that reads a lakehouse/warehouse
table's **real schema** (resolvable via the existing `schema-compat-validator.ts`
/ Synapse metadata clients) and generates statistically-similar synthetic rows
via an **Azure Function** using an OSS library (SDV / Faker-equivalent in
Python), writing output as a **new Delta table registered back into the same
lakehouse**. Row count / distribution / seed set via wizard. Bicep: the Azure
Function is admin-plane-deployed; env var + honest gate if absent. Gov:
Functions + ADLS/Delta day-one; OSS libs bundled in the image (license-checked).

**Acceptance.** Point the generator at a real 12-column customer table; generate
5,000 synthetic rows; confirm a **real** new Delta table appears in the lakehouse
with schema-matching, PII-free data (query the actual table); the run is logged.

---

### W13 — Incident / Runbook item (Azure Monitor-tied) — **P2 · M**

**Capability.** A structured incident + runbook + resolution audit trail
auto-created from Azure Monitor alerts — PagerDuty/Opsgenie runbook pattern,
Azure-native.

**Current Loom state — MISSING.** `admin/health` and the Activator
(monitor-client, per `no-fabric-dependency.md`) fire alerts, but no catalog item
captures a structured incident + runbook + resolution trail.

**Azure-first / OSS build.** A new item type: an incident record
**auto-created from an Azure Monitor action-group webhook** (Azure Function
ingest), with a linked runbook (ordered checklist + optional **Azure Automation
runbook** execution button), status transitions, and a post-incident-review
template. Stored in a new Cosmos container, surfaced on `admin/health`. Bicep:
action-group → Function webhook + Cosmos container + Automation account
reference; env vars. Gov: Azure Monitor + Automation + Functions day-one in Gov.

**Acceptance.** Fire a real Azure Monitor alert (or replay an action-group
webhook payload); an incident record auto-creates in Cosmos and appears on
`admin/health`; run the attached Automation runbook via the button (real
execution id returned); transition to resolved and confirm the audit trail
persists.

---

### W14 — FinOps what-if capacity/cost simulator — **P2 · M**

**Capability.** Interactive sliders projecting spend deltas for capacity/SKU
changes **before** committing an ARM update — forward-looking, unlike today's
historical-only chargeback.

**Current Loom state — PARTIAL.** `admin/usage-chargeback/page.tsx` and
`admin/capacity/page.tsx` report actual historical spend/usage (chargeback
shipped per the Enhancement-program memory), but grep for `what-if` scoped to
cost/capacity finds nothing — no forward simulator (the report designer's DAX
`what-if-pane.tsx` is unrelated).

**Azure-first / OSS build.** A new admin panel **reusing the report designer's
`what-if-pane.tsx` slider→live-recompute pattern** but bound to the **Azure
Retail Prices API** + current resource SKUs, projecting spend deltas for
capacity/SKU changes. No commit — read-only projection until the operator
explicitly triggers the existing ARM update path. Backend: Retail Prices API
(public, keyless) + existing capacity client. Bicep: none. Gov: use the Gov
Retail Prices endpoint / Gov price sheet; honest note if a SKU price is
unavailable in Gov.

**Acceptance.** On the capacity panel, drag a Synapse DWU / ADX SKU slider; the
projected monthly delta updates from a **real Retail Prices API** response
(network trace confirms), and no ARM change occurs until explicit commit.

---

### W15 — Use-case app clone/fork (re-run with new params) — **P2 · M**

**Capability.** Re-run an already-installed use-case app with new parameters
without reinstalling from scratch — Databricks/Fabric accelerator re-deploy
pattern.

**Current Loom state — MISSING.** Grep for `clone|fork|reinstall` across
`lib/apps/content-bundles/index.ts` and `app/api/apps/[id]/install/route.ts`
returns no matches — each of the 21+ bundle installs is a one-shot provision
keyed to the GLOBAL seed (per commit `1d90bb89`), with no parameterized re-run.

**Azure-first / OSS build.** A "Clone app" action on the installed-app detail
page re-invokes the same content-bundle provisioner (`lib/apps/content-bundles/*`)
with a **new instance-suffix** and operator-editable parameters (region, sizing,
naming prefix) collected via a **wizard**, reusing the existing async
install-jobs queue (`app/api/apps/install-jobs/[jobId]/route.ts`). Backend =
existing provisioner + job queue; idempotent create-if-not-exists already the
pattern. Bicep: none new. Gov: same provisioners already Gov day-one.

**Acceptance.** Clone an installed use-case app into a new instance-suffix with a
different region/prefix; the async job provisions **real** distinct Azure
resources (verify by resource name in the portal/ARG), leaving the original
untouched; the receipt shows the new resource ids.

---

### W16 — Use-case app version-upgrade path — **P3 · M**

**Capability.** Detect when a bundle's content changed after install and offer an
in-place update of only the changed steps — app-store update pattern.

**Current Loom state — MISSING.** Same empty grep as W15 — no version field
diffing between the installed snapshot and the current content-bundle definition
is surfaced anywhere.

**Azure-first / OSS build.** Stamp each content-bundle export with a **semantic
version**; on the installed-app detail page, diff the installed manifest against
the current bundle definition and offer an "Update available" action that
re-runs **only the changed provisioning steps** (idempotent create-if-not-exists
is already the per-bundle pattern). Backend = existing provisioners + a version
field on the installed manifest in Cosmos. Bicep: none. Gov: unchanged.

**Acceptance.** Bump a bundle's version and change one provisioning step; the
installed-app page shows "Update available"; running it re-provisions **only**
the changed step against the real backend (verify unchanged resources are
untouched); the installed manifest's version advances.

---

### W17 — Report designer mobile/phone layout view — **P3 · M**

**Capability.** A separate optimized per-report layout for narrow viewports,
like the Power BI Desktop mobile-layout designer (built Azure-native, **no Power
BI service dependency**).

**Current Loom state — MISSING.** Grep for `mobile-layout|phone-layout` across
`lib/editors/report/*` and `report-designer.tsx` returns nothing — only the
desktop `free-form-canvas.tsx` layout exists.

**Azure-first / OSS build.** Add a **second layout mode** to `free-form-canvas.tsx`
storing an alternate mobile visual arrangement (subset + reflow) in the **same
report item document**; render it via the existing report-viewer route when
accessed from a narrow viewport. No new backend, no Power BI. Bicep: none. Gov:
unchanged (Loom-native report renderer, no PBI).

**Acceptance.** Design a mobile layout for an existing report (drag a subset of
visuals into the phone frame); persist to the same item document; open the
report on a narrow viewport and confirm the **real** report-viewer serves the
mobile arrangement from the actual backend data.

---

### W18 — Marketplace listing analytics + subscriber SLA webhooks — **P2 · M**

**Capability.** Per-listing usage analytics for publishers + an SLA-breach
webhook to subscribers — Azure Marketplace publisher analytics / APIM subscriber
notifications.

**Current Loom state — PARTIAL.** `lib/editors/data-marketplace.tsx` + the
data-product editors handle subscribe/access flows (Marketplace PR #1578), but
grep for `subscri.*analytic|listing.*analytic|webhook` in marketplace files
finds no per-listing analytics dashboard or SLA-breach webhook.

**Azure-first / OSS build.** A **publisher analytics tab** on the data-product
detail page backed by **App Insights custom events already emitted** on each
Delta Sharing / API access (extend, don't rebuild) — access counts, top
subscribers, freshness. Plus an **Azure Event Grid** subscription that fires a
webhook to the subscriber's registered endpoint on SLA breach (freshness/volume)
**detected by the W11 DQ rule engine**. Bicep: Event Grid topic + subscription
module; App Insights already deployed. Gov: App Insights + Event Grid day-one in
Gov.

**Acceptance.** Access a shared data product several times; the publisher
analytics tab shows **real** access counts from App Insights (verified against
the actual telemetry); trip an SLA freshness breach and confirm a webhook POST
fires to a registered test endpoint via Event Grid (delivery logged).

---

### W19 — Cross-item "Explain this" Copilot — **P2 · S**

**Capability.** A plain-English "explain what this does" action on pipelines,
notebooks, and warehouses — generalizing the report's smart-narrative/Q&A layer.

**Current Loom state — PARTIAL.** `lib/editors/report/ai-visuals/smart-narrative.tsx`
and `qa.tsx` give reports a narrative/Q&A layer; grep for equivalent "explain"
actions in `pipeline-editor.tsx`, `notebook-editor.tsx`, `warehouse-editor.tsx`
finds none.

**Azure-first / OSS build.** Add an "Explain this pipeline/notebook/warehouse
schema" action to `item-editor-chrome.tsx` that sends the item's structured
config (`activities[]` / `cells[]` / schema) to the **existing single
`aoai-chat-client`** and renders a plain-English summary + risk callouts,
mirroring `smart-narrative.tsx`. Backend = the one AOAI deployment; no new
resource. Bicep: none. Gov: Gov AOAI deployment; behind the standard AOAI
honest-gate.

**Acceptance.** Click "Explain" on a real multi-activity pipeline; a **real
AOAI** completion (network trace confirms) renders a plain-English summary and
risk notes; repeat on a notebook and a warehouse schema.

---

### W20 — Canvas shortcut cheat-sheet / discoverability overlay — **P3 · S**

**Capability.** A `?`-key overlay surfacing the rich keyboard map that already
exists but is documented only in code comments — Figma's `?` shortcuts overlay.

**Current Loom state — MISSING.** `canvas.tsx`'s keyboard map
(I/O/F/A/N/Backspace/Shift+Arrows, documented only in comments at lines 326-332)
has no in-UI overlay — a real discoverability gap given the shortcuts already
work.

**Azure-first / OSS build.** A `?`-key handler in `canvas.tsx` opening a Fluent
`Dialog` listing the existing shortcut map (pure documentation of built
behavior, plus the new W1/W2/W3 shortcuts). Client-only; no backend/bicep;
cloud-agnostic.

**Acceptance.** Press `?` on any canvas; a Fluent dialog lists every working
shortcut; each listed key actually performs its action when pressed (verified
by physical Playwright key events).

---

### W21 — Command-palette coverage for canvas-scoped actions — **P3 · S**

**Capability.** Make canvas actions (add activity X, auto-align, toggle nested
preview) searchable from the existing `Cmd/Ctrl+K` palette — VS Code command
palette.

**Current Loom state — PARTIAL.** `lib/components/command-palette.tsx` exists and
is wired into `app-shell.tsx` / `nav-items.ts`, but canvas-scoped actions are
keyboard-shortcut-only per `canvas.tsx`'s local `handleKeyDown`, invisible to
the global palette.

**Azure-first / OSS build.** Register **context-scoped command sets** with the
existing `command-palette.tsx` registry when a canvas-backed editor is focused,
so power users can search "auto align", "toggle nested preview", etc. Pure
client wiring; no backend/bicep; cloud-agnostic.

**Acceptance.** With a pipeline canvas focused, `Ctrl+K` → type "align" surfaces
the align command; invoking it performs the real canvas action; the commands
de-register when the canvas loses focus.

---

### W22 — Learning Hub interactive sandbox labs — **P3 · L**

**Capability.** A "Start sandbox" button that provisions a time-boxed, scoped,
disposable Loom workspace so a learner completes a tutorial hands-on —
Microsoft Learn sandbox / Databricks Academy labs.

**Current Loom state — PARTIAL.** `app/learn/page.tsx` + `step-walkthrough.tsx` +
`notebook-gallery-card.tsx` give guided reading/import flows (Learning Hub
memory), but no ephemeral sandboxed workspace provisioning exists.

**Azure-first / OSS build.** A "Start sandbox" button provisions a **time-boxed
(TTL) scoped resource group** with the minimum services a given tutorial needs,
using the **existing bicep modules parameterized smaller**, auto-deleted after N
hours via an **Azure Automation runbook or Logic App** teardown timer. Backend =
existing provisioners + a teardown scheduler. Bicep: reuse existing modules +
add the TTL teardown automation. Gov: same modules already Gov day-one; TTL
teardown via Gov Automation.

**Acceptance.** Click "Start sandbox" on a tutorial; a **real** scoped resource
group provisions the minimal services (verify in ARG); complete a step against
the live sandbox; confirm the TTL automation tears the resource group down after
the window (deletion logged).

---

## 4. Cross-cutting acceptance & guardrails

- **No-vaporware receipt per item.** Every W-item PR attaches the endpoint hit,
  a real response body (first 300 chars), a browser screenshot / Playwright
  trace of the surface, and a bicep diff if infra changed. Reviewers reject any
  PR lacking the receipt.
- **No hard Fabric/Power BI dependency, ever.** No default path in any item may
  reach `api.fabric.microsoft.com`, `api.powerbi.com`, or
  `onelake.dfs.fabric.microsoft.com`. Fabric backends stay opt-in behind
  `LOOM_<ITEM>_BACKEND=fabric` + a bound workspace. W5/W9 gate on **Azure**
  services (Web PubSub / Durable Functions) — honest infra gates, not Fabric
  ones. Verify each PR with the `no-fabric-dependency.md` grep set.
- **No freeform JSON config.** New item authoring (W9 tool inputs, W10 contract
  schema, W11 rules, W12 generation params, W15 clone params) is
  wizard/dropdown/canvas-bound to a schema — never a raw JSON textarea. Only the
  1:1 ADF/Synapse expression builders are exempt.
- **Fluent v9 + Loom tokens + canvas-node-kit.** Every new node/edge/overlay
  (W1-W9, W20) reuses `canvas-node-kit.tsx` chrome and Loom design tokens.
- **Bicep-synced.** W5, W9, W11, W13, W18, W22 add Azure resources/env vars/role
  assignments — each lands in `platform/fiab/bicep/modules/**` + the `apps[]`
  env list + the resource's role-assignment block, and the from-scratch
  `az deployment sub create` acceptance test must still pass in Commercial and
  Gov.
- **Gov parity day-one.** Every named backend (Web PubSub, Durable Functions,
  Retail Prices API, Event Grid, Azure Monitor/Automation, App Insights,
  Synapse/ADX/Databricks/Cosmos/Purview) is GA in Azure Government. Items with a
  Gov caveat (Retail Prices Gov price sheet) show an honest note, never a block.
- **Physical verification, not DOM strings.** Per the no-scaffold rule, every
  interactive claim is verified with real Playwright input (physical key/click
  events) and a side-by-side against the source-product behavior — DOM presence
  is not parity.
