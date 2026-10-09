# PRP: Canvas stacked docks — StackedSplit primitive + first adoption (#3699 Phases 2-3)

| Field | Value |
|---|---|
| Status | DRAFT — ready to execute. Phase 1 (minimap toggle) shipped in PR #4951 |
| Created | 2026-10-05 |
| Decision source | Operator decision 2026-10-05: pick one epic, commit a real PRP, ship it — in response to a session review showing recent work was dominated by CI/tooling/dependency fixes rather than new capability |
| Parent issue | #3699 — "Canvas design surfaces: independently resizable stacked docks + hideable minimap (default for ALL canvases)" |
| Related rules | `.claude/rules/ux-baseline.md` (G1 live-browser verification, G3 resizable panels), `.claude/rules/web3-ui.md` (reuse shared primitives) |
| Deferred follow-ups (filed, not in this PRP's scope) | #4952 (pipeline-editor-core.tsx adoption), #4953 (databricks pipeline-editor.tsx adoption), #4954 (6 secondary surfaces — design, not implementation), #4955 (dedupe keyboard-resize logic — low priority), #4956 (mount shortcut dialog everywhere), #4957 (harden regression guard beyond grep) |

## 0. Summary

#3699 is an operator-requested UX platform primitive, quoted directly in the issue from live use of the pipeline builder: the bottom-of-canvas sections (Parameters, Variables, Activities, Settings, Output) need to be independently resizable and collapsible, with siblings reflowing automatically — not the current "drag the whole pane group" experience. Phase 1 (a hideable minimap across all 25 real canvas surfaces, with a document-level `M` shortcut) is **done and shipped** in PR #4951.

This PRP covers the two remaining committed phases:

- **Phase 2**: build the `StackedSplit` component — the N-pane, independently-resizable, collapsible primitive. No production adoption yet; validated against an isolated test harness.
- **Phase 3**: adopt it in **`data-pipeline-editor.tsx`'s Fabric-native path only** — the one pipeline canvas that actually has the bug as the operator described it (a 2-way split plus a separately-stacked output dock that don't reflow together today).

Everything else from the original issue's "adopt everywhere" ask is **deliberately deferred and already filed** as #4952-#4957, each with a one-line reason (see table above). Do not expand this PRP's scope to cover them — that was a decision made after actually inspecting each target's current code, not an oversight.

## 1. Goals and non-goals

### Goals
- G1. A reusable `StackedSplit` component exists, is keyboard-accessible, persists its full layout (sizes + collapsed state) per surface, and is validated in isolation before any production file depends on it.
- G2. `data-pipeline-editor.tsx`'s Fabric-native canvas path (the `designerMain` block) adopts it, replacing the current nested-SplitPane-plus-separate-output-dock structure with one 3-pane stack where every pane resizes and collapses independently and siblings reflow.
- G3. A user with an existing persisted layout (the pre-#3699 `SplitPane`/`ResizableCanvasRegion` keys) gets a correct one-time migration into the new format — no silently-reset layout.
- G4. A cheap regression guard exists so a new canvas dock can't ship fixed-height again (best-effort; #4957 tracks hardening it further if needed).

### Non-goals (deferred, filed separately — do not pull these in)
- Adopting `StackedSplit` in `pipeline-editor-core.tsx` (#4952) or `databricks/pipeline-editor.tsx` (#4953) — both need their own design decision first (see those issues).
- Any dock content for the 6 secondary canvas surfaces that have no dock today at all (#4954) — that's new product design, not primitive adoption.
- Deduping `SplitPane`/`ResizableCanvasRegion`'s keyboard logic against the new `StackedSplit` implementation (#4955) — explicitly low-priority internal cleanup, not tied to shipping this feature.
- Mounting `CanvasShortcutDialog` everywhere (#4956).

## 2. Context — what Phase 1 already established, and what's still true

All of the following was verified directly against source during Phase 1's research (3 Explore agents + spot-checks against the live files) and remains valid as of PR #4951. **Re-verify line numbers before editing** — they will have drifted.

### `SplitPane` (`apps/fiab-console/lib/components/shared/split-pane.tsx`, ~314 lines)
Hand-rolled (no external library), Fluent v9 + raw Pointer Events. `children: [ReactNode, ReactNode]` — **hard 2-pane limit**, used as a flat 2-way split at ~60 call sites repo-wide; zero existing nesting to fake a 3rd pane. Props: `direction`, `defaultSize`, `minSize`/`maxSize`, `primary`, `storageKey` (persists ONE px number to `localStorage['loom.splitpane.<storageKey>']`, written on drag-end/keyboard-commit), `collapsed`/`collapsedSize` (collapse state is externally owned by the caller — `SplitPane` itself does not track it), `onSizeChange`. Keyboard: Arrow ±24px, PageUp/Down ±96px, Home/End to min/max; `role="separator"` with `aria-valuenow/min/max`. Reduced-motion: inline `@media (prefers-reduced-motion: reduce)` inside its own `makeStyles` block — this is the universal convention in this codebase; there is no shared `useReducedMotion` hook and you should not invent one.

### `ResizableCanvasRegion` (`apps/fiab-console/lib/components/canvas/resizable-canvas.tsx`, `useResizableHeight` ~line 243, exported fn ~line 635)
A SEPARATE, independently-reimplemented single-region height-resize primitive. Own `localStorage` key `loom.canvasHeight.<storageKey>`. Duplicates SplitPane's Arrow/PageUp-Down/Home/End convention via copy-pasted code, **plus an additional Shift+Arrow (±96px)** SplitPane does not have. Already consumed by the Databricks pipeline canvas and by `data-pipeline-editor.tsx`'s Output dock (see Phase 3 below). Do not retrofit this onto `StackedSplit` or vice versa in this PRP — that's #4955.

### `CollapsibleSidePanel` (`apps/fiab-console/lib/components/collapsible-side-panel.tsx`, 225 lines)
Exports `useCollapsibleState(storageKey?, defaultCollapsed=false): [boolean, setCollapsed]` (localStorage-backed, SSR-safe via a post-mount effect, accepts the updater-fn form) and the `CollapseToggle` chevron-button idiom. This is SIDE-rail-oriented (vertical rotated label for the collapsed state) — reuse the **hook shape and the chevron-button idiom**, not the visual chrome, which doesn't fit a horizontal bottom-dock header.

### `CanvasRightRail` / `CanvasRailPanel` (`apps/fiab-console/lib/components/canvas/canvas-node-kit.tsx`)
Now carries the Phase 1 minimap toggle (`minimapVisible`/`onToggleMinimap` props, `Map20Filled`/`Map20Regular` icon-swap). Not directly relevant to Phase 2/3's dock work, but it's the file every canvas host already imports from — if `StackedSplit` needs a shared "zoom controls aware of dock state" interaction later, this is where that would live.

### `pipeline-editor.tsx` is NOT a canvas
`apps/fiab-console/lib/editors/pipeline-editor.tsx` (320 lines) only exports `PipelineCopilotPane` — a chat/composer component used as the right-rail content by the other pipeline editors. The original issue's "4 pipeline canvases" is actually 2 real canvases (`data-pipeline-editor.tsx`'s native path, and `pipeline-editor-core.tsx`) plus this non-canvas file plus the structurally-different Databricks one. Don't go looking for a 4th canvas here.

## 3. Phase 2 — Build `StackedSplit`

**New file**: `apps/fiab-console/lib/components/shared/stacked-split.tsx`.

### Shape

```ts
interface StackedSplitPaneSpec {
  id: string;                 // stable key, used in persistence — NOT positional
  title: ReactNode;           // shown in header and in the collapsed strip
  content: ReactNode;
  role?: 'canvas' | 'dock';   // 'canvas' is the reflow sink/source of last resort
  minHeight?: number;         // px floor; suggest 120 for canvas, 80 for docks
  defaultFlex?: number;       // initial proportional weight
  collapsible?: boolean;      // default true for role:'dock', false for role:'canvas'
  defaultCollapsed?: boolean;
  headerActions?: ReactNode;  // e.g. an existing "open full tab" button some docks have
}

interface StackedSplitProps {
  direction?: 'vertical' | 'horizontal'; // vertical = stacked docks (the primary case)
  panes: StackedSplitPaneSpec[];         // N >= 2
  sizingKey: string;                     // ONE persisted key for the whole layout
  onLayoutChange?: (state: StackedSplitPersistedState) => void;
  className?: string;
}
```

### Persistence — a new format, new key namespace

`SplitPane`'s single-number-per-key scheme cannot represent N panes + collapse state. New format:

```ts
interface StackedSplitPersistedState {
  v: 1;                              // format version — bump if the shape ever changes
  shares: Record<string, number>;    // pane id -> flex share
  collapsed: Record<string, boolean>;// pane id -> collapsed
}
```

Stored as JSON under `loom.stackedsplit.<sizingKey>`. **Unknown/missing pane ids fall back to that pane's `defaultFlex`/`defaultCollapsed`** — required from day one, because #4952 (deferred) will eventually add panes to a surface this PRP's Phase 3 ships with fewer, and that must not corrupt or discard the persisted state for the panes that already existed.

### Reflow rule (decide now, do not leave to the implementer to improvise)
Growing one pane takes space from sibling `role:'dock'` panes that have room above their `minHeight`, proportional to their current share. Only once every dock sibling is at its floor does further growth take from the `role:'canvas'` pane, which has its own floor. This directly implements the issue's bullet "growing one pane takes space from siblings... the canvas, which has its own floor" — canvas is the pressure-release valve of last resort, not an equal sibling.

### Collapse semantics
Collapsing writes `collapsed[id]=true` **without touching `shares[id]`**, so re-expanding restores the exact prior size — mirrors `SplitPane`'s own `collapsed`/`collapsedSize` behavior (size is remembered, not reset to a default).

### Keyboard
Reuse `SplitPane`'s Arrow(±24)/PageUp-Down(±96)/Home/End convention on the resize divider, **and** adopt `ResizableCanvasRegion`'s additional Shift+Arrow(±96) — a real, confirmed divergence between the two existing primitives; pick the superset. Collapse/expand is Enter/Space **on the pane header's own chevron button** — a separate focusable element from the resize divider, so one control never does two unrelated things. New file `apps/fiab-console/lib/components/shared/resize-keyboard.ts` holds this logic, written fresh for `StackedSplit`'s own use (see non-goals — do not retrofit the two existing primitives onto it here).

### Reduced motion
Inline `@media (prefers-reduced-motion: reduce)` inside `StackedSplit`'s own `makeStyles`, matching every other component in this codebase. Do not add a shared hook.

### "Fit to content" (double-click a handle)
Cap at `min(measured scrollHeight, N% of available stack space)` — true intrinsic content height is undefined for a dock with a long virtualized list (e.g. a run-history output dock). Pick a concrete N (suggest 70%) and state it in a comment; don't leave it to be discovered as a bug later.

### Phase 2 acceptance criteria
- [ ] N panes resize independently by drag; siblings reflow per the rule above; nothing clips.
- [ ] Collapse/expand per pane, with size restored (not reset) on re-expand.
- [ ] Full layout (all shares + all collapsed flags) persists under one `sizingKey` across reload.
- [ ] Keyboard-operable: divider resize (Arrow/Shift+Arrow/PageUp-Down/Home/End) and header chevron toggle (Enter/Space).
- [ ] Respects `prefers-reduced-motion`.
- [ ] Double-click a handle fits that pane per the capped rule above.
- [ ] Demonstrated in an isolated test/demo harness — **not yet wired into any production file**.

### Phase 2 verification
Per `ux-baseline.md` G1, this still needs a real in-browser interaction walk — just against the isolated harness, not a shipped editor yet. Drag every handle, collapse every pane, reload and confirm persistence, test at narrow width, dark+light screenshots. `tsc`/`vitest` alone are not sufficient per this repo's own die-hard rule — write unit tests for the reflow/collapse math (pure-function-testable pieces) AND do the browser walk.

**Known environment gap from Phase 1**: the local dev server (`next dev`) fails to start in a fresh worktree on a pre-existing, unrelated error (`Module not found: 'crypto'` in `lib/perf/read-warmer.ts`, imported by `instrumentation.ts`). This blocked G1 verification for Phase 1 entirely. Before starting Phase 2's browser verification, either (a) fix that bootstrap issue first since it will block you identically, or (b) verify against the deployed Commercial console once PR #4951 has merged and rolled out (check `https://csa-loom.limitlessdata.ai/build-marker.txt` against `git log` to confirm the live build actually includes it before trusting that path).

## 4. Phase 3 — First real adoption: `data-pipeline-editor.tsx` (Fabric-native path only)

### What's there today (confirmed structure, re-verify line numbers — these are from the pre-#3699 tree)

In `apps/fiab-console/lib/editors/data-pipeline-editor.tsx`, inside the `topTab === 'pipeline'` block (~line 1398 at last check): an outer horizontal `SplitPane` (palette | `designerMain`) containing, inside `designerMain`, an **inner vertical `SplitPane`** (`storageKey="adf-data-pipeline.config-dock"`, canvas | `PropertiesPanel` dock) — plus a **separate, sibling, independently-conditional** `PipelineOutputDock` (own `ResizableCanvasRegion`, own storage key `data-pipeline-output-dock`, toggled by `outputDockOpen`) that is NOT tied into the same resize/reflow concept as the config dock. This is the literal bug: dragging the canvas/config-dock boundary doesn't account for the output dock, and neither pane is collapsible today (min/default/max sizes only).

### The fix
Replace the inner `SplitPane` + separate `PipelineOutputDock` with one 3-pane `StackedSplit`:
```
panes: [
  { id: 'canvas', role: 'canvas', content: <PipelineCanvas .../>, collapsible: false },
  { id: 'configDock', role: 'dock', content: <PropertiesPanel layout="dock" .../>, minHeight: 80 },
  { id: 'outputDock', role: 'dock', content: <PipelineOutputDock .../>, minHeight: 80, collapsed: !outputDockOpen },
]
sizingKey="data-pipeline.designer-stack"
```

**Scope strictly to this block** — the `designerMain`/`topTab === 'pipeline'` JSX and the `outputDockOpen` boolean plus a new `configDockCollapsed` boolean. Do **not** touch the ribbon, template gallery, or ADF/Synapse delegation branches elsewhere in this 1779-line file (those branches render `AdfPipelineEditor`/`SynapsePipelineEditor`, which are thin wrappers around `pipeline-editor-core.tsx` — out of scope per #4952).

### Migration — this file already has the exact pattern to reuse
`data-pipeline-editor.tsx` already performs a one-time key migration: `DOCK_SIZING_KEY = 'adf-data-pipeline.config-dock'`, `LEGACY_DOCK_STORAGE_KEY = 'loom.dockHeight.adf-data-pipeline'`, migrated near the top of the component (search for the migration comment referencing "A5" — it runs during the FIRST render, before the SplitPane child's own key is consulted). **Reuse that exact pattern** for both existing keys (`adf-data-pipeline.config-dock` and the Output dock's `ResizableCanvasRegion` key) feeding into the new `StackedSplitPersistedState` vector, once, so a user with either pre-existing value doesn't silently lose their layout.

### Phase 3 acceptance criteria
- [ ] Dragging the canvas/configDock boundary no longer drags the output dock along with it — all 3 panes resize independently with proportional sibling reflow.
- [ ] Collapsing any one pane returns its space to the others; re-expanding restores its prior size.
- [ ] A user with a pre-existing `adf-data-pipeline.config-dock` and/or `data-pipeline-output-dock` localStorage value gets a correct one-time migration (write a test that seeds both legacy keys, mounts the component, and asserts the new vector reflects them — mirroring whatever test already covers the A5 migration, if one exists).
- [ ] The canvas never shrinks below its floor even with both docks maxed.

### Phase 3 verification
Full G1 live walk per `ux-baseline.md`: drag each of the 2 handles, collapse each of the 3 panes, confirm the canvas floor, reload with and without a pre-existing legacy value present, narrow-width pass, dark+light screenshots. Same dev-server caveat as Phase 2 applies.

## 5. Guard (tail of Phase 3)

A cheap CI check: grep new/changed files under the canvas-host paths for a raw fixed-height dock pattern (a `<div>` with hard-coded height styling that renders dock-shaped content, or a hand-rolled resize handle that isn't `SplitPane`/`ResizableCanvasRegion`/`StackedSplit`). State explicitly in the guard's own header comment that this is best-effort pattern-matching, not a comprehensive guarantee — per this repo's `assertion-design.md`, an un-killable or partial-coverage check must be disclosed as such, not counted as full enforcement. #4957 tracks hardening it further if it proves insufficient in practice.

## 6. Validation gates

```bash
cd apps/fiab-console
NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit -p tsconfig.json   # filter for touched files; this repo's full tsc has large pre-existing unrelated baseline noise
npx next lint --file <each touched file>                                      # bare `next lint` with no --file args also works repo-wide but is slower
npx vitest run <new and touched test files>
```
Plus the G1 live-browser walks described per-phase above — not optional, per `ux-baseline.md`.

## 7. Critical files

- `apps/fiab-console/lib/components/shared/split-pane.tsx` — pattern source.
- `apps/fiab-console/lib/components/canvas/resizable-canvas.tsx` — pattern source, Shift+Arrow convention.
- `apps/fiab-console/lib/components/collapsible-side-panel.tsx` — `useCollapsibleState` hook shape and `CollapseToggle` idiom to reuse.
- New: `apps/fiab-console/lib/components/shared/stacked-split.tsx`, `apps/fiab-console/lib/components/shared/resize-keyboard.ts`.
- `apps/fiab-console/lib/editors/data-pipeline-editor.tsx` — Phase 3's sole adoption target, scoped to the `designerMain` block.
- `apps/fiab-console/lib/components/pipeline/properties-panel.tsx`, `apps/fiab-console/lib/components/pipeline/pipeline-output-dock.tsx` — only if their `layout="dock"` prop needs adjustment for the new collapsed-state model (check first; likely not needed since they already render into a sized container).

## 8. Definition of ready check

- [x] Goal and acceptance criteria are measurable (§1, §3, §4 each have explicit checklists).
- [x] Context is grounded in direct source inspection, not assumption (§2 cites exact files/line ranges as of Phase 1).
- [x] Non-goals are explicit and linked to filed issues, not silently absent (§1).
- [x] A known environment blocker (dev-server bootstrap) is named with a workaround, not left for the next session to rediscover (§3 verification note).
- [x] Validation gates are literal, runnable commands (§6).
