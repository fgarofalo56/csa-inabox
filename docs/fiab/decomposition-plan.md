# CSA Loom — Monolith Decomposition Plan (WS-E / E1)

**Status:** DESIGN ARTIFACT — planning only. **No editor is split in this PR.**
**Effective:** 2026-07-20. Owner: WS-E (Monolith Decomposition / Maintainability).
**Companion guard:** `scripts/ci/check-file-size.mjs` (WS-E E3) freezes each file
below at its current LOC so it cannot grow while decomposition is pending.

## Why plan-only (G1 rule)

The five targets are 3.5k–5.2k LOC live editors. A blind refactor that passes
`tsc` + `vitest` but is **not** browser-verified is a **G1 violation**
(`.claude/rules/ux-baseline.md` §9.1: "Browser E2E before done"). On 2026-07-15
a change that passed every CI gate hard-froze the renderer live (reverted in
#2079). No browser is available in the session that produced this plan, so the
actual extraction is deferred to a **browser-verified follow-up PR per editor**,
using the minted-session E2E harness (`docs/fiab/parity/<slug>.md` receipt +
click-walk of every tab/dialog with real data).

This document is the blueprint that follow-up executes against. Each section is
grounded in the real file structure (line ranges, tab lists, hook counts) as of
the LOC recorded in the E3 allowlist.

## Shared method (applies to all five)

1. **Create a per-editor folder** `lib/editors/<name>/` (lakehouse already has
   one) and keep the current file as the thin **shell**: layout chrome
   (`PageShell`/ribbon/`TabList`), routing between panes, and the top-level
   `useItem`/save wiring. Target shell ≤ ~600 LOC.
2. **One pane per tab.** Every `{tab === 'X' && (…)}` block becomes
   `<XPane … />` in `lib/editors/<name>/panes/x-pane.tsx`. The pane owns only
   its own state; cross-pane state stays in the shell and is passed as props or
   via a small editor context.
3. **Data hooks out.** Each pane's `clientFetch`/`useQuery` calls move into a
   colocated `use-x.ts` hook returning `{data, loading, error, actions}`. This
   is where the biggest `useState`/`useCallback` counts drain.
4. **Pure helpers → `.ts` util modules** (no JSX, no React) — trivially unit
   testable, and they lift LOC out of the shell with zero render risk.
5. **Dialogs → their own components** under `lib/editors/<name>/dialogs/`.
6. **Behavior parity is the gate**, not line count: the follow-up PR ships only
   when the minted-session E2E click-walk matches pre-refactor behavior tab for
   tab, dialog for dialog (`no-vaporware.md` real-data receipt).

Order of extraction within each editor: **pure helpers → dialogs → data hooks →
tab panes → shell** (lowest-risk first; each step is independently verifiable).

---

## 1. `lakehouse/lakehouse-editor-shell.tsx` — 5227 LOC

**Shape today:** a single `LakehouseEditor` function (lines 89–5227) with a
10-tab `TabList` (2637–2646) plus a nested security sub-tab strip
(object/table/column/row, 4303–4306). 165 `useState`, 76 `useCallback`, 15
`useEffect`, 56 fetch/query call-sites, 2 large dialogs.

**Tab render blocks (extraction seams, all `{tab === '…' && (…)}`):**

| Tab | Line | → target module | est. LOC |
|-----|------|-----------------|----------|
| security (+ RBAC/table/column/row sub-tabs) | 2650 | `panes/security-pane.tsx` + `use-lakehouse-security.ts` | ~450 |
| copilot | 2653 | `panes/copilot-pane.tsx` | ~120 |
| entity (diagram) | 2668 | `panes/entity-diagram-pane.tsx` | ~120 |
| files | 2675 | `panes/files-pane.tsx` + `use-lakehouse-files.ts` | ~280 |
| tables | 2954 | `panes/tables-pane.tsx` + `use-lakehouse-tables.ts` | ~350 |
| history | 3300 | `panes/history-pane.tsx` | ~130 |
| schemas | 3434 | `panes/schemas-pane.tsx` | ~80 |
| shortcuts | 3511 | `panes/shortcuts-pane.tsx` | ~170 |
| preview | 3681 | `panes/preview-pane.tsx` | ~80 |
| sql | 3759 | `panes/sql-pane.tsx` + `use-lakehouse-sql.ts` | ~110 |

**Dialogs:** shortcut wizard (3868–4149, 3 steps → `dialogs/shortcut-wizard.tsx`,
~280 LOC), sensitivity-label dialog (4154+ → `dialogs/label-dialog.tsx`, ~120).

**Helpers:** `renderTreeChildren` (2056) and `renderRefTreeChildren` (2116) →
`lib/editors/lakehouse/file-tree.tsx` (a `<LakehouseFileTree/>` component; these
two functions plus their state are ~300 LOC of the explorer).

**Target:** shell ~500 LOC (TabList + `OneLakeExplorer` tree + tab routing);
10 panes 80–450 each; 5 data hooks; 2 dialogs. Every pane < 500 LOC, shell < 600.

---

## 2. `report-designer.tsx` — 5135 LOC

**Shape today:** the file is *already* function-decomposed at module scope — the
work is mostly **moving** existing functions into files, which is lower risk than
carving a mega-component. Main `ReportDesigner` component: 2282–4862 (~2580 LOC).
Right-rail build panes switch on `rightTab` (11 values: build/format/analytics/
filters/interactions/bookmarks/selection/syncSlicers/whatIf/performance/copilot;
render at 4452 format, 4508 build, …). 62 `useState`, 57 `useCallback`.

**Already-standalone units to relocate (no logic change, just file moves):**

| Symbol | Line | → target module |
|--------|------|-----------------|
| `pageDims`, `wellResultAlias`, `wellsFor`, `uid`, `fieldKey`, `fieldLabel`, `dataTypeGlyph`, `wellFieldDataType`, `wellFieldGlyph`, `parseFieldRef`, `stripWell`, `queryVisual`, `wireWells`, `hasBinding`, `applyAlpha` | 341–891 | `report-designer/wells.ts` + `report-designer/visual-query.ts` (~550 LOC of pure helpers) |
| `PaneSection` | 1224 | `report-designer/ui/pane-section.tsx` |
| `MatrixPivotTable` | 1274 | `report-designer/visuals/matrix-pivot-table.tsx` |
| `VisualBody` | 1396 | `report-designer/visuals/visual-body.tsx` (~540 LOC — the largest single unit) |
| `TooltipPageContent` | 1938 | `report-designer/visuals/tooltip-page.tsx` |
| `cellIsNumeric`,`measureAggregates`,`splitCols`,`chartCategories`,`computeAnomalyOverlay` | 1983–2093 | `report-designer/visual-math.ts` (pure) |
| `BubblePlayBody` | 2093 | `report-designer/visuals/bubble-play.tsx` |
| `WellEditor` | 2186 | `report-designer/panels/well-editor.tsx` |
| `RenamePageItem`, `PageFormatPanel`, `ArrangeBar` | 4862–5135 | `report-designer/panels/` |

**Then** carve the 11 `rightTab` panes out of the main component into
`report-designer/panes/*`. **Target:** shell ~600 LOC (canvas host + page rail +
`rightTab` routing); visuals/ and panels/ each < 600; helpers pure and tested.

---

## 3. `phase3/semantic-model-editor.tsx` — 4576 LOC

**Shape today:** several panes are **already separate functions** in the file —
relocate first. Main editor `SemanticModelEditorInner` (1713–4576, ~2860 LOC)
has ~22 tabs (3109–3130: tables/relationships/model/entity/modeling/measures/
metrics/daxquery/health/copilot/prep-for-ai/calcGroups/fieldParams/build/
aggregations/refresh/datasource/incremental/config/security/direct-lake/
governance). 178 `useState` (highest of the five), 62 `useCallback`, 50 fetches.

**Already-standalone units to relocate:**

| Symbol | Line | → target module |
|--------|------|-----------------|
| `ColumnTypeIcon` | 186 | `semantic-model/ui/column-type-icon.tsx` |
| `AasSemanticModelPanel` | 206–553 | `semantic-model/panes/aas-panel.tsx` (~347) |
| `SemanticModelSecurityTab` | 553–832 | `semantic-model/panes/security-tab.tsx` (~280) |
| `SemanticModelCopilotPane` | 930–1202 | `semantic-model/panes/copilot-pane.tsx` (~270) |
| `SemanticModelPrepForAiPane` | 1213–1545 | `semantic-model/panes/prep-for-ai-pane.tsx` (~330) |
| `LoomNativeModelView` | 1545–1705 | `semantic-model/panes/model-view.tsx` |
| `describeOp`, `tableExposed`, `columnExposed` | 832,1202,1206 | `semantic-model/structure-ops.ts` (pure) |

**Then** split the 22-tab inner component: the modeling core (tables /
relationships / model view / entity diagram / measures / metrics / calc groups /
field params) into `semantic-model/panes/modeling/*`; the ops tabs (refresh /
incremental / datasource / aggregations / build / config / governance) into
`semantic-model/panes/ops/*`. The 178-`useState` count is the real problem: fold
per-tab state into each pane and lift only the shared model doc into a
`useSemanticModel()` reducer/context. **Target:** shell + context ~700 LOC;
each pane group < 800; no pane > 500.

---

## 4. `notebook-editor.tsx` — 3875 LOC

**Shape today:** cell rendering is **already componentized** (imports `CodeCell`,
`MarkdownCell`, `CellAdder` at lines 50–52), so the bulk is the **shell**: the
notebook/folder explorer tree, the compute/session panel, execution
orchestration, and **9 dialogs**. One `NotebookEditor` function (384–3815, ~3430
LOC). Module hooks already extracted: `useWorkspaces`, `useComputes`,
`useAmlConfigured`, `useMyCi`. 104 `useState`, 68 `useCallback`, 45 fetches. No
`TabList` (canvas UI).

**Extraction seams:**

| Unit | Lines | → target module | est. LOC |
|------|-------|-----------------|----------|
| Folder tree + DnD + folder CRUD (`openNbCreateFolder`, `submitNbFolderDialog`, `deleteNbFolder`, `moveNbToFolder`, `onNbDragStart/Over/Drop`) | 1013–1060 + tree JSX | `notebook/explorer-tree.tsx` + `use-nb-folders.ts` | ~400 |
| Cell list host + `patchCell` + insert helpers (`insertLakehouseUseCell`, 505, 2821…) | 505 + cell JSX | `notebook/cell-list.tsx` | ~500 |
| Compute/session panel + attach/config/new-CI | uses `useComputes`/`useMyCi` | `notebook/compute-panel.tsx` + `use-nb-session.ts` | ~450 |
| Execution/run-all orchestration (Livy/AML) | fetch cluster | `use-notebook-run.ts` | ~350 |
| 9 dialogs: folder (2719), folder-delete (2740), move (2762), create (3131), config-CI (3163), new-CI (3190), env-panel (3268), attach (3312), rename (3733) | as listed | `notebook/dialogs/*.tsx` (one file, ~500 total) | ~500 |
| `DriverLogPane` | 3815 | `notebook/driver-log-pane.tsx` |
| pure helpers (`cellRoutesToSpark`, `starterCells`, `splitKeep`, `decodePy`, `looksStreaming`, `isComputeRunning`, `isCiStopped`) | 208–332 | `notebook/notebook-utils.ts` (pure) |

**Target:** shell ~600 LOC (layout + explorer + cell-list host + run-bar);
compute panel, run hook, dialogs each < 500.

---

## 5. `apim-editors.tsx` — 3580 LOC (EASIEST — split by editor)

**Shape today:** this single file holds **four independent exported editors**
plus shared helpers. Unlike the others, no mega-component carving is needed —
just move each editor to its own file. Lowest-risk of the five.

| Editor / unit | Lines | Tabs | → target file | est. LOC |
|---------------|-------|------|---------------|----------|
| `ApimApiEditor` | 239–1197 | design/operations/test/revisions (768–771) | `apim/api-editor.tsx` | ~958 |
| `ApimProductEditor` | 1197–1771 | settings/apis/subs (1469–1471) | `apim/product-editor.tsx` | ~574 |
| `ApimPolicyEditor` | 1783–2102 | (policy XML) | `apim/policy-editor.tsx` | ~320 |
| `DataProductEditor` | 2303–3580 | 12 tabs (3121–3132) | `apim/data-product-editor.tsx` | ~1277 |
| shared: `useStyles`, `StatusBar`, `parseParams`, `parseResponses`, `paramsToText`, `responsesToText`, `repsToText`, `isWellFormedXml` | 105–239, 1771 | — | `apim/shared.ts` + `apim/status-bar.tsx` | ~200 |
| data-product helpers: `projectDataProductContent`, `parseOwnerString`, `useDataProductWorkspaces`, `useGovernanceDomains`, `PublishAsApiDialog` | 2102–2303 | — | `apim/data-product/*` | ~300 |

`DataProductEditor` (1277) is still > 1500-ceiling-safe but should further split
its 12 tabs into `apim/data-product/panes/*` in the same follow-up to land under
the 1500 warn line. Keep `apim-editors.tsx` as a barrel re-export for existing
importers (no call-site churn). **Target:** each of the four editors in its own
file, all < 1500 after the data-product pane split.

---

## Sequencing & acceptance (per follow-up PR)

- **One editor per PR**, in ascending risk: **apim → notebook → report-designer
  → semantic-model → lakehouse** (apim is pure file-splits; lakehouse has the
  most cross-tab shared state and the highest `useState`).
- Each PR: extract per the table above, keep a **barrel/shell** so importers are
  unchanged, run `tsc -p tsconfig.build.json`, `vitest run` on the editor's
  suite, then the **mandatory browser E2E** (minted session) clicking every tab
  and dialog against real data — attach the receipt (G1, `no-vaporware.md`).
- On merge, run `node scripts/ci/check-file-size.mjs --update-baseline` and paste
  the new (lower) ceilings so the E3 ratchet tightens and the decomposed file
  can never regrow to its old size.
- **Done** = each target < 1500 LOC (or a justified, allowlisted exception), new
  modules have focused unit tests, and the E2E receipt shows behavior parity.
