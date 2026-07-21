# estate-builder — parity with NL-to-Full-Estate + One-Canvas authoring (BTB-3 / BTB-5)

Source UI: none — this is a **burn-the-box** Loom differentiator (BTB-3
NL-to-Full-Estate, BTB-5 One-Canvas cross-workload authoring). Neither Microsoft
Fabric nor the Azure portal has a single surface that composes a whole data
estate from one prompt, or authors ingest→serve→visualize across every workload
on ONE canvas. Per `ux-baseline.md`, where Loom exceeds Fabric our richer bar is
the standard. This doc records that the surface is **real end-to-end**, not
vaporware.

## Capability inventory (the burn-the-box bar)

| # | Capability | Loom coverage | Backend per control |
|---|------------|---------------|---------------------|
| 1 | One NL prompt → reviewable estate plan | ✅ | `POST /api/estate/plan` → `planEstateFromPrompt` (AOAI, reasoning tier) |
| 2 | Plan routed to the reasoning tier (WS-1.1) | ✅ | `aoaiChatJson({ tier:'strong', taskClass:'reasoning' })` via `model-tier-router` |
| 3 | Plan is a DAG of REAL Weave bridges | ✅ | `estate-plan-model` nodes = `create` / `weave` over the 13 `THREAD_ACTIONS` |
| 4 | Dry-run + diff (creates nothing) | ✅ | `planDiff()` — ordered create/weave ops; `validatePlan()` gate |
| 5 | Approve → execute the full chain | ✅ | `POST /api/estate/execute` → `executeEstatePlan` runs the real thread routes + `createOwnedItem` |
| 6 | Chain threads created item ids downstream | ✅ | executor resolves each `fromNodeId`'s created item id as the next bridge's source |
| 7 | Honest failure (skip downstream of a failed step) | ✅ | executor marks the downstream subtree `skipped` — no phantom source |
| 8 | One-Canvas typed cross-workload nodes | ✅ | `one-canvas.tsx` palette: table/notebook/KQL/measure/ontology-object/model/agent/report |
| 9 | Edges = ThreadActions (Weave) | ✅ | connect A→B picks the bridge whose source accepts A and produces B |
| 10 | Publish = a plan-model | ✅ | `compilePlanFromCanvas()` → same `EstatePlan` the NL planner emits → same executor |
| 11 | Canvas standard: undo/redo, zoom rail, minimap, resizable (G3) | ✅ | `useCanvasHistory`, `CanvasRightRail`, `MiniMap`, `ResizableCanvasRegion` |
| 12 | canvas-node-kit compliant nodes | ✅ | `CanvasNode` + typed `CanvasPort`s via `getItemVisual` |
| 13 | Sovereign / no-Fabric-dependency | ✅ | every produced item is Azure-native (the bridges are Azure-native by default) |
| 14 | Honest gate when no reasoning model | ✅ | `NoAoaiDeploymentError` → 503 naming `LOOM_AOAI_STRONG_DEPLOYMENT` |

Zero ❌.

## Weave bridges the chain can execute (the 13)

`analyze-in-notebook`, `bind-to-ontology`, `add-data-agent-source`,
`build-loom-report` (+ `build-report-from-model`), `analyze-in-powerbi`,
`build-powerbi-model`, `publish-as-api`, `mirror-to-notebook`,
`mirror-to-lakehouse`, `analyze-with-dax`, `materialize-to-kql`,
`kql-query-to-dashboard-tile`, `promote-medallion` — invoked in-process as the
same user (the handler's `getSession()` reads the ambient cookie), so each hits
its real Azure backend.

## Verification

- Unit: `lib/estate/__tests__/*` — plan-model DAG (topo/validate/diff/compile),
  planner (NL→plan-model DAG parse), executor (create→weave chain + skip/fail).
- **Owed: browser-E2E receipt (Track-0)** — one prompt builds the full estate; a
  one-canvas topology executes end-to-end with real items in a workspace. To be
  attached against a live deployment.
