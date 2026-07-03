# Eventstream — Parity gap (validator verdict 2026-05-26)

**Grade: D (multiple BLOCKERs)**

Validator: v2 4-phase live-browser + source-code review. Loom URL:
`https://<your-console-hostname>/items/eventstream/6ac04218-5bfc-47dd-b58b-df11e2bf4e80`

Loom screenshot: `temp/parity/eventstream-loom.png` (full-page, 19150 bytes, captured live).
Fabric reference screenshot: not capturable from this validator session (corporate
auth blocks Fabric portal from Playwright). Reference UX captured in
`docs/fiab/eventstream-parity-spec.md` from prior catalog phase.

## Phase 1 — Fabric reference (from spec)

Three-section visual designer: drag-and-drop canvas with **source → transform →
destination** nodes; right pane = configuration; bottom pane = test results.
Source picker = 18+ types (Event Hubs, Kafka, CDC family, Fabric workspace events,
Blob events, Sample data, Custom endpoint). Transform nodes = Filter, Aggregate,
GroupBy, Manage fields, Join, Union, Expand, SQL operator. Destination picker =
Lakehouse, Eventhouse, Activator, Custom endpoint, Derived stream, Spark Notebook.

## Phase 2 — Loom under test (live)

Single textarea displaying raw JSON config:

```json
{
  "source":   { "kind": "eventhub", "namespace": "", "name": "", "consumerGroup": "$Default" },
  "transforms": [],
  "sink":     { "kind": "kusto", "database": "loomdb-default", "table": "" }
}
```

Plus a warning MessageBar: *"v2.1 — configuration only. Pipeline metadata is
persisted to Cosmos but the Event Hubs → Kusto ingestion runtime is not yet
executing. Real runtime wiring lands in v3."*

Ribbon visible at top: Add source / Sample data / Filter / Aggregate / Group by /
Add destination / Save / Publish. **All ribbon group actions except `Save` resolve
to declarative spec entries only — the buttons render in the chrome but have no
click handler wired (verified by source: `EventstreamEditor` only binds `load`,
`save`; the ribbon definitions in `ES_RIBBON` are static labels). The only
working interactive controls on the body are the JSON textarea and the Save
button.**

Source confirmation: `apps/fiab-console/lib/editors/phase3-editors.tsx` lines
756-835. Editor body = `<textarea className={s.monaco}>` (cosmetic CSS class
named `monaco` but it's a vanilla textarea — NOT `@monaco-editor/react`).
No `react-flow` / `@xyflow/react` / `reactflow` in `apps/fiab-console/package.json`.
No SVG canvas. No drag-and-drop. No transform graph.

## Phase 3 — Side-by-side gap matrix

| Fabric element | Loom | Severity |
|---|---|---|
| Visual designer canvas (drag-and-drop source / transform / destination nodes) | **Missing** — JSON textarea only | **BLOCKER** |
| Source picker dialog with 18+ source types | Missing — JSON `source.kind` field | **BLOCKER** |
| Destination picker with 6 destination types | Missing — JSON `sink.kind` field | **BLOCKER** |
| Transform node palette (Filter, Aggregate, GroupBy, Manage fields, Join, Union, Expand, SQL) | Missing — append entries to `transforms[]` JSON | **BLOCKER** |
| Test-result preview pane (live event sampling) | Missing | **BLOCKER** |
| Authoring error validation (red-underline) | Missing | **MAJOR** |
| Pause/resume controls | Missing | **MAJOR** |
| Apache Kafka endpoint integration view | Missing | MAJOR |
| Schema management with Schema Registry | Missing | MAJOR |
| Honest "config-only" MessageBar | **Present** — Fluent warning bar with v3 note | (positive) |
| Save → persists to Cosmos | **Present** — `PUT /api/items/eventstream/{id}` returns 200 with config | (positive) |
| Ribbon tab "Home" with Source/Transform/Destination/Publish groups | Present but actions are no-ops | MAJOR |
| Monaco JSON editor with schema validation | Missing — plain textarea | MAJOR |

**Phase 4 — Functional click-every-button verification**

| Loom control | Result |
|---|---|
| `GET /api/items/eventstream/{id}` | 200 — returns `{ok:true, runtimeStatus:'config-only', config:{transforms:[]}}` |
| `PUT /api/items/eventstream/{id}` body=config | 200 — persists to Cosmos (verified via state machine) |
| Body textarea typing | Updates `cfgText` state; `JSON.parse` error caught on Save |
| **Save** button | Real fetch → 200, dirty cleared. **PRIMARY ACTION WORKS** |
| Ribbon: Add source / Sample data / Filter / Aggregate / Group by / Add destination / Publish | **No-op** — buttons render but no click handler bound. **BROKEN** (silently dead) |
| MessageBar "configuration only" | Rendered, accurate |
| No event-hub runtime to actually stream against | Honest gate — accepted per `no-vaporware.md` |

## Verdict

**D-grade**. Multiple Phase-3 BLOCKERs (no visual canvas, no source/destination
picker, no transform palette, no test-result pane). Phase-4 has silently dead
ribbon buttons (Add source/Filter/Aggregate/Group by/Add destination/Publish)
which is BROKEN per workflow contract.

Per `no-vaporware.md` and `no-scaffold-claims.md`: this is the **JSON-spec-only**
state the catalog spec called out — "Visual canvas: ❌ none. New React component
with react-flow or similar." That work has not been done. The JSON textarea is
honest in surfacing its limitation via MessageBar, which prevents an F (vaporware)
grade. But it cannot be called shipped, in parity, or A/B-grade.

## Required for ≥ B grade

1. Replace JSON textarea with `react-flow` (or `@xyflow/react`) drag-and-drop canvas.
2. Source picker dialog with the 11 external streaming sources + 7 CDC sources + 4 Fabric event sources + 9 data sources + custom endpoint (matches Fabric).
3. Destination picker dialog with the 6 destination types (Lakehouse, Eventhouse, Activator, Custom endpoint, Derived stream, Spark Notebook).
4. Transform node palette: each transform = right-pane config form with type-specific fields (Filter: predicate; Aggregate: window+func+field; etc).
5. Bind each ribbon button to its actual function. Buttons with no backend yet must show the honest "configure first" or "feature requires X" MessageBar inline.
6. Test-result pane that samples 10 events from the configured source.

Estimated effort to reach B: 3-4 focused sessions. To A: 5-6 sessions + bicep
to deploy Event Hubs namespace + Stream Analytics runtime.

## Evidence

- Live API calls executed in this validator run:
  - `GET /api/items/eventstream/6ac04218-…` → 200 (real Cosmos read)
  - `POST /api/workspaces/de489967-…/items` (created the test item) → 201
- Source code reviewed: `apps/fiab-console/lib/editors/phase3-editors.tsx` lines 726-835.
- Package check: no `react-flow*`, no `@xyflow*`, no `@monaco-editor/react`, no `@kusto/monaco-kusto`.
- Screenshot: `temp/parity/eventstream-loom.png`.
