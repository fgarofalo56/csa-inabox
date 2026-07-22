# WS-U — UI/UX Excellence (G3 completion, leader-gap parity, systemic hygiene)

Part of the master PRP **loom-next-level** (rev 2, pass 2). Author: pass-2 PRP
editor. Date: 2026-07-22.
Scope: `apps/fiab-console` front-end + the BFF/backend routes the two leader-gap
items require. Sources (read-only, this session):
`temp/audit-2026-07-22/darkfont-deep-sweep.md` (mechanism-class dark-font +
alignment audit) and `temp/audit-2026-07-22/canvas-parity-audit.md` (G3
resizability 37 PASS / 19 FAIL / 1 conditional + leader parity vs
ADF/Fabric/Power BI).

> **Conventions inherited from the master PRP:** PR-sized items with stable IDs;
> each lists goal, exact files, backend (per `no-vaporware.md`), env/gates (G2 +
> X2 `availability` where any env var is added — most WS-U items add none),
> acceptance incl. a **G1 browser receipt**, and a per-cloud line. **Pure
> front-end items here carry the master carve-out declaration "Per-cloud:
> cloud-neutral"** (extended to WS-U in the pass-2 master update); only U7, U8,
> and U13 touch real Azure backends and carry full per-cloud rows. G3 items use the
> existing primitives ONLY: `lib/components/canvas/resizable-canvas.tsx`
> (`ResizableCanvasRegion`, key `loom.canvasHeight.<k>`) and
> `lib/components/shared/split-pane.tsx` (`SplitPane`, key `loom.splitpane.<k>`)
> — hand-rolled resize handles are forbidden (ux-baseline G3). The U11 ratchet
> follows WS-R mechanics (`scripts/ci/_ratchet-count.mjs`, shrink-only baseline,
> `--update-baseline` regen).

## 0. Already FIXED — do NOT re-plan (merged/open PRs, 2026-07-22)

| PR | What it closed (from the two audits) |
|----|--------------------------------------|
| **#2382** | Class-1 UA-`ButtonText` fix on the 11 gallery/tile classes + `deploy-plan-nodes.tsx` glyphs (`readableAccent`) |
| **#2389** *(**OPEN as of 2026-07-22** — in flight, NOT merged; the scope in this row is do-not-re-plan ONLY while this PR is live. **If #2389 is abandoned/closed-unmerged, its 28 Class-1 sites + the `canvas-node-kit.tsx:344-350` Class-2 boundary + the new-item-dialog badge-wrap + the 3 grid overflows re-enter WS-U as a new item U14.**)* | The remaining **28 Class-1 sites** (wizards, list-row selection panels, option cards, Home shortcuts, canvas palettes, 21 files), the **Class-2 root-cause boundary** (`canvas-node-kit.tsx:344-350` / `item-type-icon.ts` — accent lifted through `readableAccent`, fixing the Estate One-Canvas glyph and `deploy-planner-view.tsx:878`), the `new-item-dialog.tsx:189` badge-wrap (5A), and the **3 hard grid overflows** (5B-hard: `visual-builder-dialog.tsx:50`, `foundry-agents.tsx:41`, `adx-rbac-panel.tsx:68`) |
| **#2390** | The **13 easy FAIL-W SplitPane inspector wraps** (canvas-parity audit items U1+U2: pipeline-designer, mapping-dataflow, power-query-host, mounted-adf inner panes, deploy-planner, one-canvas, visual-query, gremlin-graph, agent-flow, eventstream, prompt-flow, warp, visual-builder) — reference pattern `databricks/pipeline-editor.tsx` L546 |

WS-U covers the **remainder**: the medium/structural G3 work, the three
leader-gap builds, and the systemic hygiene the audits flagged as mechanical.
Item IDs below are renumbered — the audit's U1..U11 do NOT map 1:1 (audit U1/U2
shipped in #2390; audit U11 layout-presets deliberately excluded, see §4).

## Current-state grounding (verified by the audits — build ON these)

- `ResizableCanvasRegion` + `useResizableHeight` — pointer + full keyboard,
  ARIA separator, persists `loom.canvasHeight.<storageKey>`, tested.
- `SplitPane` — horizontal/vertical, keyboard, double-click reset, honors
  external `collapsed`, persists `loom.splitpane.<storageKey>`, tested.
- `lib/editors/item-editor-chrome.tsx` — `splitKeyPrefix` opt-in makes the
  Resources rail + Copilot rail `SplitPane`s; **report-designer is the one
  flagship caller that does NOT pass it**.
- `monaco-textarea.tsx` — `sizingKey` ⇒ Monaco wrapped in
  `ResizableCanvasRegion storageKey="monaco.<sizingKey>"`; all 11 SQL/KQL/graph
  editors use it. The uniform miss is the fixed `maxHeight:360` results grid.
- `TileGrid` (`lib/components/ui/tile-grid.tsx`) — the sanctioned card-grid
  primitive; 142 soft px-`minmax` grids across 112 files bypass it (5B-soft).
- `/browse` (`app/browse/page.tsx`) renders every item via
  `<TileGrid>{list.map(...)}` with **no windowing** — the confirmed
  renderer-freeze defect at 1437 items (bi-dx research T1.3; GuidedPickerRail
  freeze precedent 2026-07-15, revert #2079).

---

# AREA 0 — VERIFY FIRST (P0)

## U0 — In-browser drag+reload receipts on already-PASS canvases (resolve the operator contradiction)

**Goal:** the operator reports *"NO canvas areas anywhere in Loom are
user-adjustable"*; the code audit says 37 surfaces PASS with persisted grips.
Both cannot be true at runtime. Before any WS-U G3 item is declared done, prove
in a real browser whether the existing grips are **reachable and draggable
live** — or whether a clipping regression (bottom grip below the chrome fold,
z-order, overflow container) hides them.

**Files/paths:** no product code initially. `loom-ui-verify` Playwright project
(memory: publish-version E2E wiring) + minted-session harness. Sample ≥4
already-PASS surfaces spanning both primitives: `catalog-lineage` (height),
`deploy-planner` (height), `warehouse-editor` `monaco.warehouse.sql` (Monaco
height), `databricks/pipeline-editor` inspector (SplitPane width).

**Acceptance (this IS the receipt):** for each sampled surface — (a) locate the
`role="separator"` grip in the live DOM, (b) drag it ±150px, (c) assert the
`localStorage` key (`loom.canvasHeight.*` / `loom.splitpane.*` /
`monaco.*`) changed, (d) reload and assert the size restored, (e) dark+light
screenshots + a narrow-width pass. **If any grip is unreachable, file the
clipping regression as a P0 defect PR and fix it BEFORE U1–U6 proceed** (else
every subsequent receipt inherits the same blindness). Verdict recorded in the
PR: "grips live" or "regression found: <cause>".

**Per-cloud:** cloud-neutral (front-end verification). **Size: S.**

---

# AREA 1 — STRUCTURAL G3 COMPLETION (the 6 remaining FAIL surfaces + the systemic divider)

## U1 — Report designer full G3 (FAIL-H + FAIL-W, flagship)

**Goal:** the highest operator-visible G3 failure. Make the report canvas
height-resizable and the Build/Pages/Copilot panes width-resizable.

**Files:** `lib/editors/report-designer.tsx` (+ `report-designer/styles.ts`).
(1) Wrap `FreeFormCanvas` in
`ResizableCanvasRegion storageKey="report-designer-canvas"`; the absolute-
positioned page sizes from `pageDimsActive`, so a variable-height parent is
low-risk — verify. (2) Pass `splitKeyPrefix={item.slug}` to `ItemEditorChrome`
so the Resources + Copilot rails become `SplitPane`s (one-line). (3) The inner
Build/Pages panes get `SplitPane storageKey="report-designer.build"` /
`.pages`.

**Serialization (master list):** same-editor with U2 and WS-A A6–A9 (report
depth grows `visual-body.tsx`/`analytics-pane.tsx`/`loom-chart.tsx`) —
extend-then-decompose policy applies; U1 lands FIRST (pure layout wiring),
A6–A9 rebase onto it, U2 follows.

**Acceptance:** G1 receipt — drag canvas taller, drag Build pane wider, reload,
both persist from the correct keys; a real report renders + executes a visual
query in the resized canvas (no vaporware); dark+light shots, narrow pass.
**Runtime flag (round 3, FLAG0):** the new G3 layout registers a default-ON
`loom-runtime-flags` flag — OFF restores the pre-U1 fixed layout without a
roll (the report designer is the flagship user-visible surface; a live layout
regression must be flag-revertible in seconds).
**Per-cloud:** cloud-neutral. **Size: M.**

## U2 — Report designer aux panes (Power BI staples: Filters, Selection, Bookmarks, align/distribute, themes)

**Goal:** close the parity-audit's flagged Power BI feature-completeness gaps
beyond resize (canvas-parity §Part 2.4c): **Filters pane** (report/page/visual
scope, applied to real queries), **Selection pane** (z-order + show/hide),
**Bookmarks** (capture state incl. filters + selection, navigate), alignment /
distribute tools for selected visuals, and report **theme selection**.

**Files:** `lib/editors/report-designer.tsx` + `report-designer/*` siblings
(new `filters-pane.tsx`, `selection-pane.tsx`, `bookmarks-pane.tsx` — sibling
modules per the WS-R decomposition convention, NOT more LOC in the monolith;
stay under the file-size ratchet or `--update-baseline` with justification).
Filters compile into the existing semantic-layer query path (`visual-body`
query build) — real query deltas, not client-side hiding. Bookmarks persist in
the report definition (versioned on save, per the publish-version model).

**Acceptance:** G1 receipt — add a page-level filter, watch the visual's real
query change (network tab) and rows update; hide a visual via Selection;
capture + navigate a bookmark; reload — all persisted. Parity doc
`docs/fiab/parity/report-designer.md` rows for these five capabilities flip to
✅. **Runtime flag (round 3, FLAG0):** the aux panes register a default-ON
`loom-runtime-flags` flag (admin-killable without a roll).
**Per-cloud:** cloud-neutral (front-end + existing query path).
**Size: L.**

## U3 — Notebook per-cell resizable height (FAIL-H)

**Goal:** cells are `autoHeight`-only with a maximize toggle — no drag grip, no
persisted per-cell height (the operator's "notebook doesn't resize").

**Files:** `lib/editors/notebook-editor.tsx`,
`lib/components/notebook/code-cell.tsx`. Give each cell's `MonacoTextarea` a
per-cell `sizingKey="notebook.<cellId>"` (dropping `autoHeight` once a user
grabs the grip; auto until first drag so short cells stay compact), OR wrap
`CodeCell` in `ResizableCanvasRegion` — pick whichever keeps the maximize
toggle working. Keep output areas scrolling inside the sized cell.

**Serialization:** notebook editor is also an A14 collab-target — U3 lands
before/with the R8–R12 decomposition of the notebook editor per the master
spine; coordinate.

**Acceptance:** G1 receipt — drag one cell taller, run it against the real
Spark session (rows/plot render inside the resized cell), reload: that cell's
height restored, siblings unaffected. **Per-cloud:** cloud-neutral.
**Size: M.**

## U4 — Workshop + Slate app-builder canvas height (FAIL-H)

**Goal:** both app-builder canvases are content-sized
(`canvasHeight = max(540, contentBottom)` — `workshop-app-builder.tsx` L1372,
`slate-app-builder.tsx` L1029) with no user control; their inspectors already
use `SplitPane` (width OK).

**Files:** `lib/editors/workshop/workshop-app-builder.tsx`,
`lib/editors/slate/slate-app-builder.tsx`. Give the scroll viewport a
`ResizableCanvasRegion storageKey="workshop-app-canvas"` / `"slate-app-canvas"`
so the *visible* canvas height is user-set while content still scrolls
(audit-prescribed fix shape).

**Acceptance:** G1 receipt per builder — drag viewport height, place a widget,
reload, height + widget persist; dark+light; narrow pass. **Per-cloud:**
cloud-neutral. **Size: S–M.**

## U5 — Fixed-height stragglers: agent-mesh 68vh, KQL-dashboard region, object-view 620px, entity-diagram default

**Goal:** finish the FAIL-H/conditional tail in one PR.

**Files + fix shape:**
- `lib/mesh/agent-mesh-console.tsx` — fixed `height:68vh` (L49) → vertical
  `SplitPane` (registry/run split) or `ResizableCanvasRegion
  storageKey="agent-mesh"`.
- `lib/editors/phase3/kql-dashboard-editor.tsx` — wrap the 12-col tile grid
  region in `ResizableCanvasRegion storageKey="kql-dashboard-grid"` (per-tile
  corner-resize already matches Fabric RTD and stays; this satisfies the
  strict G3 letter on the region — audit's low-priority note).
- `lib/editors/phase4/object-view-panel.tsx` — container fixed `620px` (L47)
  → region (map/chart children keep their internal splits).
- `lib/components/shared/entity-diagram.tsx` — `resizeStorageKey` becomes
  defaulted (derive from caller surface id) so the CONDITIONAL verdict
  disappears; fix any caller currently omitting it.

**Acceptance:** G1 receipt per surface (drag + reload persistence), dark+light.
**Per-cloud:** cloud-neutral. **Size: M.**

## U6 — Query↔results split divider across all 11 Monaco editors (systemic gap #3)

**Goal:** no SQL/KQL/graph editor has a draggable divider between the query
editor and the results grid — results are a fixed `maxHeight:360` everywhere.
One shared change, eleven adopters.

**Files:** `lib/editors/lakehouse/panes/sql-pane.tsx`,
`lib/editors/phase3/warehouse-editor.tsx`, `phase3/kql-queryset-editor.tsx`,
`phase3/kql-database-editor.tsx`, `sql-database-editor.tsx`,
`unified-sql-database-editor.tsx`, `databricks/sql-warehouse-editor.tsx`,
`graph-editors.tsx` (4 language panes), plus the shared results renderers
(`results-panel.tsx` / `PreviewTable`). Insert a **vertical `SplitPane`**
between editor and results, `storageKey="<editor>.results-split"`, replacing
the fixed `maxHeight:360`; build the split ONCE as a small shared wrapper
(e.g. `lib/editors/components/editor-results-split.tsx`) so the 11 adoptions
are mechanical and future editors inherit it.

**Serialization:** these are the same editor files WS-A/WS-R touch
(warehouse/kql editors in R8–R12 scope) — land U6 before the decomposition of
any given editor or rebase per extend-then-decompose.

**Acceptance:** G1 receipt on ≥3 editors (one SQL, one KQL, one graph) — drag
the divider, run a REAL query (rows in the grid), reload, split restored; the
remaining 8 covered by the same automated drag+reload spec added to
`loom-ui-verify`. **Per-cloud:** cloud-neutral. **Size: M.**

---

# AREA 2 — LEADER-GAP BUILDS (the audits' BEHIND verdicts)

## U7 — Mapping-dataflow Debug mode: per-transform Data Preview + Inspect + column statistics + quick-actions (widest leader gap)

**Goal:** ADF Mapping Data Flow's signature authoring loop (Learn-confirmed in
the audit) is absent in Loom: Debug Mode with an **interactive data snapshot at
every transform node**, an **Inspect** pane (live in/out column metadata incl.
schema drift), **column statistics** (null %, frequency, min/max/stddev/
percentiles), and **quick-actions** (select a column in the preview →
Typecast/Modify/Remove auto-generates a Derived-Column/Select transform). This
is the single largest parity build in the audit — "the reason a data engineer
would still reach for ADF."

**Design (real backend, per no-vaporware):**
- **Debug session** = a pooled Spark session (reuse
  `lib/azure/spark-session-pool` — the same warm pool + reaper machinery from
  #1889; do NOT stand up a second pool) OR Synapse serverless for pure-SQL
  sources. Toggling "Debug" in the designer acquires a session scoped to the
  dataflow; the session TTL/reap rules of the pool apply unchanged.
- **BFF routes** (gate-envelope + route-toolkit per WS-R):
  `POST /api/items/dataflow/[id]/debug/session` (acquire/release),
  `POST .../debug/preview` (body: `{transformId, sampleSize}` → executes the
  dataflow **up to that transform** against a sampled source read, returns
  typed rows), `POST .../debug/stats` (per-column profile over the sample),
  `GET .../debug/schema` (in/out columns per transform, drift-flagged).
  Compilation: the designer's transform graph → Spark job (the same
  translation path the dataflow's run path uses — one compiler, two entry
  points; no parallel implementation).
- **UI** (`lib/components/pipeline/dataflow/mapping-dataflow-designer.tsx` +
  new sibling `dataflow-debug-panel.tsx`): Debug toggle in the ribbon (session
  state chip), a bottom **Data Preview** tab per selected transform (type-badged
  grid + timing status bar per ux-standards), **Inspect** tab (in/out schema,
  drift badges), **Statistics** tab (per-column profile cards + mini
  histograms via `loom-chart`), and preview-grid column context menu →
  quick-actions that insert the generated transform into the graph
  (draft/publish semantics — never mutates the published dataflow).

**Env/gates:** none new by default (pool + serverless already declared). If the
pool is unprovisioned the existing Spark gate renders with its Fix-it (G2) —
the designer surface still fully renders.

**Serialization:** `spark-session-pool` is on the master extend-vs-decompose
list (A11/A12 grow it) — serialize; designer file also grew in #2390 (SplitPane
wrap) — rebase.

**Acceptance:** G1 receipt — enable Debug, preview REAL rows at ≥2 transforms
of a seeded dataflow (Demo workspace data), open Statistics on a column and see
real profile numbers, apply a Typecast quick-action and see the generated
Derived-Column node appear + preview downstream of it; session released on
exit (pool receipt). Parity doc `docs/fiab/parity/mapping-dataflow.md` Debug
rows → ✅. **Per-cloud:** Commercial live receipt; GCC-High — Synapse
Spark/serverless GA, live receipt; IL5 note — in-VNet Spark pool, no external
egress, sampling stays in the customer lake. **Size: XL** (split into 3 PRs:
session+preview routes; Inspect+stats; quick-actions).

## U8 — KQL dashboard depth: parameters/filter bar, drillthrough, live refresh, pages, markdown tiles, alert wiring

**Goal:** close the Fabric Real-Time-Dashboard BEHIND list (Learn-confirmed in
the audit) on the Azure-native ADX path (`no-fabric-dependency`):
- **Parameters + filter bar** — dashboard-level typed parameters (string/
  datetime/dropdown-from-query), injected into tile KQL as declared query
  parameters, cross-filtering all tiles.
- **Drillthrough** — right-click a data point → navigate to a target page with
  the parameter set from the clicked value.
- **Live/auto refresh** — per-dashboard refresh interval + per-tile
  last-refresh timestamp; "live" tier = short-interval polling now, upgrade to
  push when the A14 collab push transport lands (cross-ref; do NOT build a
  parallel transport).
- **Pages** — multiple tile-container pages with a page strip.
- **Markdown tiles** — text/markdown tile type.
- **Alert from tile** — "Create alert" on a tile → Azure Monitor
  scheduled-query alert over the tile's KQL via `monitor-client` (the
  activator's Azure-native path), dispatched through the O1 alert-dispatch
  standard (`LOOM_ALERT_ACTION_GROUP_ID`).

**Files:** `lib/editors/phase3/kql-dashboard-editor.tsx` (+ new siblings
`kql-dashboard-parameters.tsx`, `kql-dashboard-page-strip.tsx` per
decomposition convention), `lib/azure/kql-dashboard-model.ts`, `kusto-client`
(query-parameter support), `monitor-client` (alert create — serialize per the
extend-vs-decompose list, WS-C also grows it).

**Acceptance:** G1 receipt — add a parameter, watch ≥2 tiles' REAL ADX queries
re-execute filtered; drillthrough from a datapoint to page 2 with the value
applied; auto-refresh ticks the per-tile timestamp; create an alert and show
the Azure Monitor rule id in the receipt. Parity doc
`docs/fiab/parity/kql-dashboard.md` rows → ✅/⚠. **Per-cloud:** Commercial
live; GCC-High — ADX + Monitor scheduled-query GA, live receipt; IL5 note —
ADX in-VNet, alerts to the in-boundary action group. **Size: L** (2 PRs:
parameters+pages+markdown; drillthrough+refresh+alerts).

## U9 — Canvas full-screen mode as a kit feature (puts Loom AHEAD)

**Goal:** neither ADF nor Fabric offers a true full-screen authoring canvas.
Add a maximize control to the shared kit so **every** xyflow canvas inherits it
at once.

**Files:** `lib/components/canvas/canvas-node-kit.tsx` / `CanvasRightRail` +
`lib/components/canvas/resizable-canvas.tsx`. Maximize expands the
`ResizableCanvasRegion` (or the canvas host) to the viewport
(position:fixed overlay, chrome hidden), Esc/F11 exits, focus-trapped +
keyboard-announced (a11y), state NOT persisted (session-scoped by design).

**Acceptance:** G1 receipt — maximize the pipeline canvas, edit + connect a
node while maximized, Esc restores with state intact; verified on ≥3 canvas
families (pipeline, eventstream, estate); axe-core pass in maximized state
(feeds the V3 ratchet, no regression). **Per-cloud:** cloud-neutral.
**Size: S–M.**

## U13 — Pipeline in-canvas Debug/Output monitoring overlay (ADF pipeline parity) *(NEW, round-2 gap review)*

**Goal:** match ADF's *pipeline* (orchestration, not dataflow) Debug loop — a
Debug run whose per-activity output (status, rows/duration, error,
input/output) renders as an **on-canvas overlay per activity node**, with an
eyeglass → run-monitoring detail, not just the existing bottom dock. Closes
canvas-parity audit Part 2 item #1(b) ("confirm Loom surfaces run receipts
on-canvas to equal depth") — the one BEHIND verdict U7 (mapping-dataflow) does
not cover.

**First verify current state:** the audit's verdict was "confirm," so if the
existing dock already renders per-activity run receipts on-canvas, **downgrade
this item to a parity-doc row instead of a build.**

**Files:** `lib/editors/data-pipeline-editor.tsx` +
`lib/components/pipeline/pipeline-designer.tsx` + a new
`pipeline-debug-overlay.tsx`; reuse the existing pipeline run-status client
(verify which — `adf-client`/`synapse-dev-client` run-output) — **no second
run path**.

**Acceptance:** G1 — Debug-run a seeded pipeline, see per-activity
status/rows/time on the node overlay + drill to run detail on real data;
parity doc `docs/fiab/parity/pipeline.md` row → ✅. **Per-cloud:**
Commercial + Gov live (ADF/Synapse GA), IL5 in-VNet. **Size: M.**
**Serialize:** pipeline designer (touched by #2390).

---

# AREA 3 — SYSTEMIC HYGIENE

## U10 — `/browse` virtualization via a shared `VirtualizedGrid` (P0 defect + scale primitive)

**Goal:** `/browse` freezes the renderer at 1437 items because
`app/browse/page.tsx` maps every item into `TileGrid` with no windowing
(confirmed defect; bi-dx research T1.3). Build the windowed primitive ONCE and
adopt it on every 1000+-item surface.

**Files:** new `lib/components/ui/virtualized-grid.tsx` (+
`virtualized-list.tsx`) — windowed rendering, keyboard nav + a11y
(roving tabindex, `aria-rowcount`), `minWidth:0`, same visual contract as
`TileGrid` (drop-in tile renderer prop), unit-tested. Adopt in: `/browse`
(pins + workspaces + items), catalog browse, marketplace, and the type-badged
data-preview grids (row-virtualized). Explicitly NOT a fork of `TileGrid` —
small collections keep `TileGrid`; the primitive is for unbounded lists.
**Round-3 clarifications (guess-risk + operator decision):** (a) the
OSS-virtualization question is DECIDED — **PERMIT `@tanstack/virtual` as the
single allowed virtualization dependency** (MIT, headless, small; vendorable
in-repo for IL5 per X-IL5 item 3/4 — no other virtualization lib may be
introduced); do not hand-roll the windowing math. (b) The **~200-item cutoff
is a shared exported constant** (e.g. `VIRTUALIZATION_CUTOFF = 200` consumed
by BOTH `TileGrid` guidance and `VirtualizedGrid`), not prose in a doc.

**Acceptance:** G1 receipt — `/browse` with the live 1400+-item estate scrolls
at 60fps-ish with no freeze (performance trace attached), narrow-width +
first-open passes; catalog + marketplace adoption receipts; vitest for
windowing math. **Runtime flag (round 3, FLAG0):** `/browse` virtualization
registers a default-ON `loom-runtime-flags` flag — OFF falls back to the
pre-U10 renderer without a roll (this is the exact GuidedPickerRail-class
surface FLAG0 exists for). **Per-cloud:** cloud-neutral. **Size: M.**

## U11 — px-grid → TileGrid/token sweep as a RATCHETED convention (142 sites / 112 files)

**Goal:** the 5B-soft class — `repeat(auto-fill, minmax(NNpx,1fr))` card grids
bypassing `TileGrid` — is a web3-ui violation at scale (142 occurrences, 112
files). Too big for one PR; exactly the shape WS-R ratchets solve.

**Mechanics (WS-R-consistent):** a new guard
`scripts/ci/check-px-grid.mjs` consuming the shared
`scripts/ci/_ratchet-count.mjs` helper (R3 builds it — U11 lands AFTER R3 or
builds the helper first if it wins the race; coordinate, don't duplicate):
pattern = px-`minmax` grid template literals in `apps/fiab-console/{lib,app}`,
baseline captured AT the measured count (142), **shrink-only**,
`--update-baseline` regen. Wired into the same CI job as the other count
ratchets. Migration then drains in batches (high-traffic clusters first, from
the audit: `new-item-dialog`, `data-product-detail`, `monitor-pane`,
realtime-hub views, governance pages, admin capacity/usage/users/readiness +
mcp-servers-panel, onelake views, foundry hub/playground, phase3 editors) —
each batch replaces with `<TileGrid minTileWidth={NNN}>` + token spacing and
ratchets the baseline down.

**Acceptance:** guard merged + enforced in CI at 142; first drain batch (≥20
sites) merged with baseline ≤122; per-batch G1 spot receipt (one touched
surface, narrow-width pass, dark+light). **This adds ratchet #13 to the
program inventory** (master updated). **Per-cloud:** cloud-neutral.
**Size: S (guard) + M×batches (drain).**

## U12 — new-item-dialog px/token cluster + dead-field cleanup (5E tail)

**Goal:** finish the audit's named hygiene tail: the `new-item-dialog.tsx`
hardcoded-px cluster (L166-189: `gap:'12px'`, `borderRadius:'6px'`,
`padding:'12px'`, `gap:'6px'`…) → `tokens.*`, its grid → `TileGrid` (counts
toward U11's baseline), the scattered `gap` literals the audit names
(`onelake/shortcut-wizard.tsx:133`, `panes/git-integration.tsx:60`,
`mounted-adf-editor.tsx:780` rail `minWidth:0` watch-item), and **delete the
dead `color`/`fg` fields in `lib/components/pipeline/activity-catalog.ts`**
(~40 entries, consumed nowhere — a latent dark-on-dark trap if ever wired; the
audit's recommended inoculation).

**Acceptance:** G1 receipt — new-item dialog opened, narrow-width pass (badge
row wrapped by #2389 — contingent on #2389 merging, see §0), visual parity
with siblings dark+light; grep
receipt showing zero remaining px literals in the named cluster; vitest still
green after the dead-field deletion (proves nothing consumed them).
**Runtime flag (round 3, FLAG0):** the restructured dialog registers a
default-ON `loom-runtime-flags` flag (admin-killable without a roll — the
dialog is on every user's create path).
**Per-cloud:** cloud-neutral. **Size: S.**

---

## 4. Deliberately excluded from WS-U (with reasons)

- **Canvas-parity audit U11 (named layout presets Compact/Balanced/Canvas-max):**
  polish beyond both the G3 letter and leader parity; U9 full-screen delivers
  the AHEAD claim at a fraction of the surface area. Revisit post-program.
- **Dark-font Class-1/-2/-5A/-5B-hard sites:** shipped in #2382/#2390
  (merged) and #2389 (**OPEN at review time**) — see §0; nothing re-planned.
  **The #2389 exclusions above are contingent on #2389 merging; tracked in F1
  of the round-2 audit.** "#2389 merged" is an explicit DONE precondition for
  WS-U's dark-font coverage claim (mirrored in the master's program
  verification); if #2389 is abandoned/closed-unmerged, its scope re-enters
  WS-U as a new item U14 per the §0 row.
- **Per-tile KQL-dashboard resize rework:** the audit judges the per-tile model
  correct (matches Fabric RTD); only the region wrapper (U5) is taken.

## 5. WS-U phase mapping (mirrored in the master spine)

- **Phase 0/1:** U0 (FIRST — gates the G3 receipts), U10 (P0 freeze defect).
- **Phase 1:** U1, U3, U4, U5, U6 (structural G3; serialize per-editor with
  WS-A/WS-R as noted).
- **Phase 2:** U2 (after U1 + with A6–A9 serialization), U7, U8, U9, U13
  (verify-current-dock-first; serialize with the pipeline designer).
- **Opportunistic (Phase 2/3):** U11 guard early + batched drain, U12.
