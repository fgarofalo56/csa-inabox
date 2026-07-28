# Canvas resize audit — every canvas surface in apps/fiab-console

Date: 2026-07-24 · Auditor: read-only research agent · Trigger: operator-reported bug
("the data-pipeline editor canvas cannot be resized at all")

All paths relative to `apps/fiab-console/` unless noted. Evidence is file:line at
repo HEAD (`93aae674`, branch `docs/reconcile-p2-verification`).

---

## 0. Executive summary

1. **The shared primitives are healthy.** `ResizableCanvasRegion` / `useResizableHeight`
   (`lib/components/canvas/resizable-canvas.tsx:102-305,416-467`) provide pointer-captured,
   rAF-coalesced, keyboard-accessible, `localStorage`-persisted height resize
   (`loom.canvasHeight.<key>`), and `SplitPane` (`lib/components/shared/split-pane.tsx`)
   provides persisted width dividers (`loom.splitpane.<key>`). 40+ canvas surfaces adopt them.
2. **Both pipeline canvases ARE wired for height resize** — the data-pipeline editor at
   `lib/editors/data-pipeline-editor.tsx:1467-1471` (key `adf-data-pipeline`) and the
   adf/synapse designer at `lib/components/pipeline/pipeline-designer.tsx:624-628`
   (key `pipeline-designer`). Statically, nothing removed the grip. The recent U3 (#2446,
   `3f618fe8`) and U9/U13 (#2523, `d713354e`) changes preserve the classic drag path
   (diff-verified below).
3. **Root cause of the operator report (highest-confidence): the grip is CLIPPED OUT OF
   VIEW with no scrollbar on the data-pipeline editor.** `TopTabs` clips its body with
   `overflow: hidden` (`lib/components/pipeline/top-tabs.tsx:20-21`) while every ancestor
   is `flex:1; minHeight:0` down from the chrome `mainPanel` — so when the canvas region's
   persisted height (+ 10px splitter + ≥240px config dock) exceeds the visible designer
   area, the region's bottom grip is simply cut off and **nothing scrolls to reach it**.
   The height clamp only tracks `window.innerHeight * 0.8` (`resizable-canvas.tsx:159-168`),
   NOT the actual available panel height, so a height persisted on a tall window (e.g. the
   834→714 U0-verified drag era, or any user drag) becomes unreachable on a shorter
   window/RDP session → "cannot be resized at all". Full chain in §2.
4. **Second real gap on the same surface (G3 violation): no in-editor WIDTH divider.**
   The data-pipeline editor's activity palette is a fixed 248–288px column
   (`data-pipeline-editor.tsx:112-119,1458-1460`; `lib/components/pipeline/palette.tsx:44`)
   — NOT SplitPane-wrapped, unlike the designer canvas which got
   `pipeline-designer.palette` in G3 #2390 (`pipeline-designer.tsx:639-648`). The canvas
   pane width inside the editor cannot be adjusted (only the chrome-level
   `data-pipeline.resources` / `data-pipeline.copilot` splits, `item-editor-chrome.tsx:313-345`
   via `splitKeyPrefix` at `data-pipeline-editor.tsx:1260`).
5. **UX-model mismatch amplifies the report:** the divider the user naturally grabs (the
   10px canvas↔config-dock splitter, `data-pipeline-editor.tsx:1498-1515`) resizes ONLY
   the dock — the canvas region is fixed-height (`flexShrink: 0`), so dragging that
   splitter never grows/shrinks the canvas, unlike ADF Studio where the canvas fills the
   remaining space. The actual canvas grip is a subtle 8px bar directly ABOVE it
   (`resizable-canvas.tsx:50,348`), trivially confused with the splitter.
6. **U9 canvas-fullscreen + U13 output dock (#2523) are merged but almost certainly not on
   the live estate yet** — live is `b4aac59b` per the Phase-4 roll; `d713354e` landed
   after. So the operator's report cannot be caused by U9/U13; conversely, the fullscreen
   column below is "merged, pending roll". One post-roll quirk found (§4, nested hosts).

---

## 1. The primitives (ground truth)

| Primitive | File | Mechanics | Persistence |
|---|---|---|---|
| `ResizableCanvasRegion` / `useResizableHeight` | `lib/components/canvas/resizable-canvas.tsx:102-305,416-467` | bottom grip, pointer capture, rAF DOM-direct drag, Arrow/Page/Home/End keys, ARIA separator; `flexShrink:0` region (U0 fix, :318); U3 `autoPx` auto-until-first-resize (:123-137) | `loom.canvasHeight.<storageKey>` (:54,151) |
| `SplitPane` | `lib/components/shared/split-pane.tsx` | horizontal/vertical persisted divider, collapse support | `loom.splitpane.<storageKey>` |
| `CanvasFullscreenHost` + `CanvasFullscreenRailButton` (U9, #2523) | `lib/components/canvas/canvas-fullscreen.tsx:151-259,274-293` | `display:contents` when windowed (:98-100, layout-neutral), fixed inset-0 overlay when maximized; Esc/F11; focus trap; FLAG0 `u9-canvas-fullscreen` | session-only by design |
| `ResizableCanvasRegion` embeds the fullscreen host | `resizable-canvas.tsx:416-422,437-449` | every region adopter inherits U9; grip hidden while maximized (:449) | — |

Diff-verified non-regressions:
- U3 `#2446` (`3f618fe8`): `autoPx` optional; with `autoPx` undefined the drag/commit path is
  behaviorally identical (`displayHeight = height`, endDrag always commits).
- U9 `#2523` (`d713354e`): windowed host wrapper is `display: contents` — the region div
  participates in the parent flex exactly as before; grip + handlers unchanged when
  `isFullscreen === false` (`resizable-canvas.tsx:439-465`).

---

## 2. The reported bug — data-pipeline editor deep dive

### 2.1 Two pipeline canvases (both confirmed)

| # | Canvas | Mount | Route/consumer |
|---|---|---|---|
| 1 | **data-pipeline editor canvas** — `PipelineCanvas` inside `ResizableCanvasRegion storageKey="adf-data-pipeline"` | `lib/editors/data-pipeline-editor.tsx:1467-1493` | item type `data-pipeline` (`lib/editors/registry.ts:64`); also geo pipelines (`lib/editors/geo-editors.tsx:962`) |
| 2 | **pipeline designer canvas** — `PipelineDesigner` (region `pipeline-designer` + `SplitPane pipeline-designer.palette`) | `lib/components/pipeline/pipeline-designer.tsx:624-868` | `adf-pipeline` / `synapse-pipeline` editors via `PipelineEditorCore` (`lib/editors/pipeline-editor-core.tsx:49,1102,1138`) |

Both share `PipelineCanvas` (`lib/components/pipeline/canvas.tsx`).

### 2.2 What the user gets today (canvas #1, the reported one)

- HEIGHT: ✅ wired — region grip, key `loom.canvasHeight.adf-data-pipeline`, default 460,
  min 300 (`data-pipeline-editor.tsx:1467-1471`).
- Config-dock height: ✅ separate custom divider (`startResize` :405-434; separator
  :1498-1515; key `loom.dockHeight.adf-data-pipeline` :242, floor 240 :236).
- WIDTH (canvas pane inside editor): ❌ palette column is fixed (`paletteCol`
  :112-119 — `flexShrink:0`, no width control; palette intrinsic 248–288px,
  `lib/components/pipeline/palette.tsx:44`). Only chrome-level splits exist
  (`data-pipeline.resources` / `data-pipeline.copilot`, `item-editor-chrome.tsx:317,335`).
- FULLSCREEN: merged in #2523 (`canvas.tsx:903-916` wraps `PipelineCanvas` in
  `CanvasFullscreenHost`; rail button via `CanvasRightRail`), **pending roll**.

### 2.3 Why "cannot be resized at all" — the clip chain (REAL-GAP)

Layout chain for the grip:

```
ItemEditorChrome mainPanel        overflow:auto, flex column          item-editor-chrome.tsx:98-107
└ editor shell                    flex:1, minHeight:0                 data-pipeline-editor.tsx:107-109
  └ TopTabs root                  flex:1, minHeight:0, **overflow:hidden**  top-tabs.tsx:14-21
    └ TopTabs body                flex:1, minHeight:0                 top-tabs.tsx:28
      └ designerRow               flex:1, **minHeight:560px**         data-pipeline-editor.tsx:127
        └ designerMain            flex:1, minHeight:0 (no scroll)     data-pipeline-editor.tsx:128
          ├ ResizableCanvasRegion height = persisted px, flexShrink:0 resizable-canvas.tsx:318,446
          │  └ [GRIP — bottom 8px of the region]                      resizable-canvas.tsx:449-464
          ├ dock splitter (10px)                                      data-pipeline-editor.tsx:1498
          └ configDock            flexShrink:0, minHeight:240px       data-pipeline-editor.tsx:154-160,1517
```

- The shell/TopTabs levels are all `flex:1; minHeight:0`, so `mainPanel` never overflows →
  **no scrollbar ever appears**; any excess is swallowed by `TopTabs root overflow:hidden`.
- The region is `flexShrink: 0` with an explicit pixel height, so when
  `regionHeight + 10 + dockHeight` exceeds the visible designer area, the splitter, dock,
  and — once `regionHeight` alone exceeds it — **the grip itself are clipped invisible and
  unreachable**.
- The only ceiling applied to a persisted height is 80% of `window.innerHeight`
  (`resizable-canvas.tsx:159-168,189-191`) — it does NOT account for the ribbon,
  breadcrumbs, topbar/workspace row, onboarding/info MessageBars (`data-pipeline-editor.tsx
  :1354-1390`), or the ≥240px dock below. A height persisted on a tall window (or simply
  dragged large once) leaves the grip permanently below the clip line on a shorter
  window — classic on RDP (operator works over RDP per memory). Result: *no visible grip,
  no scrollbar, canvas "cannot be resized at all"*.
- Recovery today requires deleting `localStorage['loom.canvasHeight.adf-data-pipeline']`
  or a taller window — nothing in-product.

Corroboration that the mechanic itself was fine on 07-22: U0's browser-verified drag
"data-pipeline editor canvas 834→714" (memory), and no commit between `3f618fe8` (07-22)
and the live roll `b4aac59b` touches these files other than U3
(`git log --since=2026-07-21 -- …/resizable-canvas.tsx …/data-pipeline-editor.tsx`:
only `093e0d4e` G3, `7b8edbc3` theme, `3f618fe8` U3, `d713354e` #2523-unrolled).

### 2.4 Secondary contributor — divider-model mismatch with ADF (REAL-GAP, UX)

In ADF Studio the canvas fills all space above the config dock and the ONE divider
reallocates space between them. In Loom the canvas height is independently fixed and the
dock divider only changes the dock (`data-pipeline-editor.tsx:1462-1466` documents this
deliberately). Dragging the obvious 10px splitter therefore *never resizes the canvas*,
and the real grip is a nearly identical 8px bar immediately above it — two adjacent
ns-resize bars, the prominent one of which doesn't touch the canvas. A user reporting
"the canvas cannot be resized" after dragging the visible divider is behaving exactly as
ADF trained them to.

### 2.5 Ruled out

- **U9/U13 (#2523)**: not rolled (live = `b4aac9b`-era `b4aac59b`; `d713354e` is newer);
  and the diff keeps the windowed DOM/pointer path identical.
- **U3 (#2446)**: classic (`autoPx` undefined) path preserved; pipeline passes no `autoPx`.
- **PipelineOutputDock covering the grip**: it renders BELOW the config dock and only when
  `outputDockOpen` (`data-pipeline-editor.tsx:1534-1545`), which is post-#2523 anyway.

---

## 3. Full inventory — every canvas surface

Legend: ✅ built · ⚠️ partial/qualified · ❌ missing · n/a (full-width surface; width owned
by page/chrome). "FS" = U9 fullscreen (all `ResizableCanvasRegion` adopters inherit the
host; the maximize BUTTON appears only where a `CanvasRightRail` renders inside — all of
it merged in #2523, **pending roll**). Keys are `loom.canvasHeight.*` (height) /
`loom.splitpane.*` (width) unless noted.

| # | Canvas | File (mount) | Height | Width | FS | Persisted keys | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | Data-pipeline editor canvas | `lib/editors/data-pipeline-editor.tsx:1467` | ✅ grip (but ⚠️ clips unreachable, §2.3) | ❌ palette fixed (:112,1458; palette.tsx:44); chrome splits only | ✅ rail (pending roll) | `adf-data-pipeline`; dock `loom.dockHeight.adf-data-pipeline` (:242); chrome `data-pipeline.resources/.copilot` | **REAL-GAP** (grip-clip + G3 width + divider model) |
| 2 | Pipeline designer canvas (adf/synapse) | `lib/components/pipeline/pipeline-designer.tsx:624` | ✅ | ✅ palette SplitPane :642 | ✅ rail (pending roll) | `pipeline-designer`, `pipeline-designer.palette` | ALREADY-BUILT |
| 3 | Pipeline output dock (U13) | `lib/components/pipeline/pipeline-output-dock.tsx:67` | ✅ | n/a | host only, no rail | `data-pipeline-output-dock` | ALREADY-BUILT (pending roll) |
| 4 | Mounted-ADF editor canvas | `lib/editors/mounted-adf-editor.tsx:1016` | ✅ | ✅ :1027,:1056 | ✅ rail | `mounted-adf`, `mounted-adf.palette`, `mounted-adf.inspector` | ALREADY-BUILT |
| 5 | Mapping-dataflow designer | `lib/components/pipeline/dataflow/mapping-dataflow-designer.tsx:1321` | ✅ | ✅ :1332 | ✅ rail | `mapping-dataflow`, `mapping-dataflow.inspector` | ALREADY-BUILT |
| 6 | Power Query host (dataflow-gen2, report Transform data) | `lib/components/pipeline/dataflow/power-query-host.tsx:570` | ✅ | ✅ :581,:635 | host only | `power-query-gen2`, `power-query.queries`, `power-query.steps` | ALREADY-BUILT |
| 7 | Eventstream visual designer | `lib/components/eventstream/visual-designer.tsx:683` | ✅ | ✅ :382-385 | ✅ rail | `eventstream`, `eventstream.inspector` | ALREADY-BUILT |
| 8 | Agent-flow canvas | `lib/editors/phase4/agent-flow-canvas.tsx:326` | ✅ | ✅ :317-320 | ✅ rail | `agent-flow-canvas`, `agent-flow.inspector` | ALREADY-BUILT |
| 9 | Task flows | `lib/panes/task-flows.tsx:475` | ✅ | n/a | ✅ rail | `task-flow` | ALREADY-BUILT |
| 10 | Lineage canvas (catalog, governance, thread, OneLake drawer, UC panel) | `lib/components/catalog/lineage-canvas.tsx:812` | ✅ | n/a | ✅ rail :935 | `catalog-lineage` | ALREADY-BUILT |
| 11 | Estate one-canvas | `lib/estate/one-canvas.tsx:307` | ✅ | ✅ :277,:299 | ✅ rail | `estate-one-canvas`, `.palette`, `.inspector` | ALREADY-BUILT |
| 12 | Assets graph canvas | `lib/components/assets/assets-canvas.tsx:507` | ✅ | ✅ :312-318 | ✅ rail | `sizingKey`∥`assets-graph-canvas`, `assets.graph-inspector` | ALREADY-BUILT |
| 13 | Transform model-DAG | `lib/components/transform/model-dag-canvas.tsx:363` | ✅ | ✅ :225 | ✅ rail | caller `sizingKey`, `transform.model-dag` | ALREADY-BUILT |
| 14 | Warp transform canvas | `lib/components/warp/warp-transform-canvas.tsx:668` | ✅ | ✅ (SplitPane in file) | ✅ rail | `warp-transform` | ALREADY-BUILT |
| 15 | dbt model graph | `lib/components/dbt/dbt-model-graph.tsx:263` | ✅ | n/a | ✅ rail | `dbt-model-graph` | ALREADY-BUILT |
| 16 | Visual query canvas | `lib/editors/components/visual-query-canvas.tsx:634` | ✅ | ✅ :618-621 | ✅ rail | `visual-query`, `visual-query.inspector` | ALREADY-BUILT |
| 17 | Gremlin graph canvas | `lib/editors/components/gremlin-graph-canvas.tsx:397` | ✅ | ✅ :405-408 | ✅ rail | `gremlin-graph`, `gremlin-graph.inspector` | ALREADY-BUILT |
| 18 | Semantic model view | `lib/editors/components/model-view-canvas.tsx:782` | ✅ | ⚠️ none in-file (chrome splits) | ✅ rail | `semantic-model-view` | ALREADY-BUILT |
| 19 | Graph-model schema canvas | `lib/editors/phase4/graph-model-editor.tsx:263` | ✅ | n/a | ✅ rail | `graph-model-schema` | ALREADY-BUILT |
| 20 | Ontology object view | `lib/editors/phase4/object-view-panel.tsx:384,394` | ✅ | ✅ :386-388 | host only | `object-view` (×2 mounts, mutually exclusive), `ontology-object-view` | ALREADY-BUILT |
| 21 | Digital-twin model canvas | `lib/editors/digital-twin-builder-editor.tsx:196` | ✅ | n/a | ✅ rail | `digital-twin-model` | ALREADY-BUILT |
| 22 | Domain designer | `lib/domains/domain-designer-canvas.tsx:646` | ✅ | n/a | ✅ rail | `domain-designer` | ALREADY-BUILT |
| 23 | Deploy planner | `lib/components/deploy-planner/deploy-planner-view.tsx:688` | ✅ | ✅ (SplitPane in file) | ✅ rail | `deploy-planner` | ALREADY-BUILT |
| 24 | Network topology | `lib/components/network/topology-canvas.tsx:808` | ✅ | n/a | ✅ rail | `network-topology` | ALREADY-BUILT |
| 25 | Full network topology | `lib/components/network/full-topology-canvas.tsx:495,516` | ✅ | n/a | ✅ rail | `full-network-topology` | ALREADY-BUILT |
| 26 | Landing zones canvas | `lib/panes/landing-zones-canvas.tsx:303` | ✅ | n/a | ✅ rail | `landing-zones` | ALREADY-BUILT |
| 27 | Setup deployment diagram | `lib/components/setup/deployment-diagram.tsx:261` | ✅ | n/a | ✅ rail | `setup-deployment-diagram` | ALREADY-BUILT |
| 28 | ADX schema diagram | `lib/components/adx/schema-diagram-canvas.tsx:435` | ✅ | n/a | ✅ rail | `adx-schema-diagram` | ALREADY-BUILT |
| 29 | Entity diagram (warehouse/lakehouse ER) | `lib/components/shared/entity-diagram.tsx:759` | ✅ | n/a | ✅ rail | `resizeStorageKey` ?? `entity-diagram.<kind>` (:688) | ALREADY-BUILT |
| 30 | Databricks DLT pipeline graph | `lib/editors/databricks/pipeline-editor.tsx:552` | ✅ | ✅ :546 | host only (no rail in file) | `databricks-dlt-pipeline`, `databricks-pipeline.inspector` | ALREADY-BUILT |
| 31 | Prompt-flow builder (SVG) | `lib/prompt-flow/flow-builder.tsx:228` | ✅ | ✅ (side panel SplitPane, :48-50) | host only | `prompt-flow` | ALREADY-BUILT |
| 32 | Power Automate flow builder | `lib/power-platform/flow-builder.tsx:1086` | ✅ | n/a | host only | `power-automate-flow` | ALREADY-BUILT |
| 33 | Agent mesh console | `lib/mesh/agent-mesh-console.tsx:195` | ✅ | ✅ :197 | host only | `agent-mesh`, `mesh-registry-run` | ALREADY-BUILT |
| 34 | KQL dashboard tile grid | `lib/editors/phase3/kql-dashboard-editor.tsx:1243` | ✅ | n/a (grid) | host only | `kql-dashboard-grid` | ALREADY-BUILT |
| 35 | Report designer free-form canvas | `lib/editors/report-designer.tsx:284` (+ `report/free-form-canvas.tsx:173` fitParent) | ✅ | ⚠️ pane rails in-editor | host only | `report-designer-canvas` | ALREADY-BUILT |
| 36 | Workshop app-builder canvas (edit + preview) | `lib/editors/workshop/workshop-app-builder.tsx:1630,1716` | ✅ | ✅ :1698 | host only | `workshop-app-canvas`, `workshop-app.inspector` | ALREADY-BUILT |
| 37 | Slate app-builder canvas (edit + preview) | `lib/editors/slate/slate-app-builder.tsx:1159,1241` | ✅ | ✅ :1218 | host only | `slate-app-canvas`, `slate-app.inspector` | ALREADY-BUILT |
| 38 | Geo map canvas (geojson) | `lib/editors/geo-editors.tsx:350` (+ `lib/components/graph/geojson-map.tsx:172`) | ✅ | n/a | host only | `geo-map` | ALREADY-BUILT |
| 39 | COE org-visuals builder (dialog) | `lib/coe-library/builder/visual-builder-dialog.tsx:335` | ✅ | n/a (dialog) | host only | `org-visuals-builder` | ALREADY-BUILT |
| 40 | Monaco editors (all SQL/KQL/code w/ `sizingKey`; U3 notebook cells) | `lib/components/editor/monaco-textarea.tsx:451`; `lib/components/notebook/code-cell.tsx:866-877` | ✅ (+`autoPx`) | n/a | host only (grip; no rail) | `monaco.<sizingKey>` (cells: `monaco.notebook.<cellId>`) | ALREADY-BUILT |
| 41 | Query↔results workspaces (U6) | `lib/editors/components/editor-results-split.tsx:144,150` | ✅ | ✅ (vertical split) | host only | `<editorKey>.results-workspace`, `<editorKey>.results-split` | ALREADY-BUILT |

Node/edge/layer files (`flow-activity-node`, `eventstream-flow-node`, `deploy-plan-nodes`,
`loom-bezier-edge`, `canvas-collab-*`, `canvas-node-kit`) render INSIDE the hosts above —
no independent sizing surface. Chrome-level width splits additionally exist on every
editor passing `splitKeyPrefix` (60+ editors, `item-editor-chrome.tsx:313-345`).

---

## 4. Post-roll watch item (from #2523, not the reported bug)

**Nested `CanvasFullscreenHost` double-wrap on the pipeline canvases.** #2523 wraps
`PipelineCanvas` itself in a host (`canvas.tsx:903-916`, rationale "no region") — but BOTH
pipeline mounts place `PipelineCanvas` INSIDE a `ResizableCanvasRegion`, which embeds its
own host (`resizable-canvas.tsx:416-422`). The `CanvasRightRail` inside the canvas binds
to the nearest (inner) host, so on maximize only the raw graph fills the overlay — the
palette, config dock, and the outer region (which keeps its persisted height + grip as
dead space behind the overlay) stay windowed, and the region's own `regionFullscreen`
branch (`resizable-canvas.tsx:442-449`) never activates. Cosmetic, but should be fixed
before this surface is called U9-done: `PipelineCanvas` should skip creating its own host
when `useCanvasFullscreen()` already returns a context (render children directly), or the
two pipeline mounts should pass a "no-host" prop.

Minor: the two `object-view` region mounts share `storageKey="object-view"`
(`object-view-panel.tsx:384,394`) — mutually-exclusive branches, so shared persistence is
harmless (flagging as reviewed, not a defect).

---

## 5. Fix list (exact primitive per ❌/⚠️)

P0 — data-pipeline editor (the operator report):
1. **Un-clip the grip (pick one, prefer a):**
   a. Clamp the region to the AVAILABLE container, not the window: give
      `useResizableHeight` a container-aware ceiling (ResizeObserver on
      `designerMain`, `data-pipeline-editor.tsx:128`) and re-clamp persisted heights
      against it (`resizable-canvas.tsx:159-191` is where the 80vh ceiling lives), or
   b. make the designer column scrollable: change `TopTabs` root `overflow:'hidden'`
      → `overflow:'hidden auto'`/`auto` on the body (`top-tabs.tsx:20,28`) so an
      oversized persisted height can always be scrolled to and dragged back.
2. **Adopt the ADF divider model:** let the canvas region fill remaining space
   (`flex:1, minHeight`) and make the SINGLE dock splitter reallocate canvas↔dock — i.e.
   replace the region+independent-dock stack with the shared **vertical `SplitPane`**
   (`primary="second"`, `storageKey="adf-data-pipeline.config-dock"`), matching G3's
   "shared SplitPane primitive with a persisted sizingKey" mandate (ux-baseline G3). This
   simultaneously removes the two-confusable-grips problem (§2.4).
3. **G3 width divider:** wrap the palette column in `SplitPane`
   (`primary="first"`, `storageKey="adf-data-pipeline.palette"`, defaults mirroring
   `pipeline-designer.tsx:639-648`) at `data-pipeline-editor.tsx:1457-1460`.
4. **G1 receipt:** browser E2E on the LIVE estate reproducing the operator's window size
   (short RDP viewport), asserting (i) grip visible at first paint with a large persisted
   `loom.canvasHeight.adf-data-pipeline`, (ii) paced drag commits, (iii) reload restores.
   Extend `e2e/u6-monaco-divider.spec.ts`-style paced-drag pattern (U0 lesson: CDP-fast
   drags false-fail SplitPane).

P1 — platform hardening (applies to all 41 surfaces):
5. Container-aware max clamp in `useResizableHeight` (fix 1a) — benefits every adopter,
   since ANY canvas inside a non-scrolling clipped ancestor can strand its grip the same
   way.
6. Fix the nested-host double-wrap on `PipelineCanvas` before the #2523 roll is declared
   U9-complete (§4).

P2 — nice-to-have:
7. Fullscreen affordance for canvas-like non-rail surfaces (report designer free-form
   canvas :35, KQL dashboard grid :34, workshop/slate app canvases :36-37) — the host is
   already embedded via the region; they only lack a maximize button because no
   `CanvasRightRail` renders inside.

---

## 6. Verdict classification summary

- **REAL-GAP (1):** data-pipeline editor canvas — grip clips unreachable with no scroll
  (viewport-dependent "cannot resize at all"), no in-editor width divider (G3), and a
  divider model that contradicts the ADF muscle-memory it emulates. Fixes P0.1–P0.4.
- **ALREADY-BUILT (40):** every other canvas surface has persisted height resize via the
  shared region; 17 also have persisted width SplitPanes; U9 fullscreen is merged for all
  region adopters (pending roll), with rail buttons on the 24 `CanvasRightRail` canvases.
- **OPERATOR-GATED (0):** none — no resize feature is env/flag-gated OFF (U3 and U9 flags
  are default-ON fail-open, `runtime-flags.ts`).
- **STALE-DOC (0)** in code; note the live estate (`b4aac59b`) predates #2523, so any doc
  claiming U9 fullscreen is live is premature until the next roll.
