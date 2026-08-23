'use client';

/**
 * notebook-editor — the #3539 cell-hydration concern, extracted.
 *
 * THE DEFECT. `cells` was seeded with `starterCells()` — a generic
 * "# New notebook / Double-click to edit…" markdown cell plus a starter code
 * cell — and the cell list rendered it for the whole window between
 * `notebookId` resolving and `loadDetail` returning the notebook's real
 * content. An app-installed notebook therefore showed a generic empty-looking
 * notebook on open, and the user's reasonable conclusion was that the app
 * install had produced nothing.
 *
 * THE FIX IS TWO INDEPENDENT LAYERS, AND NEITHER COVERS FOR THE OTHER. An
 * earlier revision of the comment this docblock replaces claimed the render
 * gate was "the one the spec's mutation control breaks". That was measured
 * FALSE: reverting either layer ALONE shipped green against the spec as it
 * stood, and only both together went red.
 *
 *   LAYER 1 — `<CellsLoading/>` behind `cellsFor !== notebookId`. This is what
 *   keeps ANY cell list off the screen while hydration is in flight, so the
 *   placeholder cannot reach the screen on a healthy load.
 *
 *   LAYER 2 — `seedCells()`. This keeps fabricated content out of `cells` at
 *   all. It matters on its own whenever the gate legitimately opens over cells
 *   the load never replaced: `loadDetail` returns early on `!j.ok` WITHOUT
 *   calling `setCells`, and its `finally` sets `cellsFor` regardless, so a
 *   non-empty seed would present the generic starter notebook as if it WERE
 *   this notebook's content. It also keeps autosave from arming against seed
 *   content, since that hook is `enabled: … && cells.length > 0`.
 *
 * `__tests__/notebook-installed-content.test.tsx` guards the two layers as two
 * separate tests, one per layer, each measured red on its own mutation. Do not
 * collapse them, and do not delete one on the theory that the other covers it.
 */

import { Badge, Caption1, Select, Spinner, tokens } from '@fluentui/react-components';
import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';
import { AutosaveIndicator, type AutosaveStatus } from '../use-autosave';
import { starterCells } from './helpers';

/**
 * LAYER 2 — what `cells` starts as. A brand-new notebook gets the starter
 * cells (they ARE its content); a saved one starts EMPTY and is filled only by
 * a completed `loadDetail`.
 */
export function seedCells(id: string): NotebookCell[] {
  return id === 'new' ? starterCells() : [];
}

/** Which notebook `cells` were hydrated from, at mount. */
export function seedCellsFor(id: string): string | null {
  return id === 'new' ? 'new' : null;
}

/**
 * LAYER 1 — what the cell region shows while `loadDetail` is in flight. The
 * `data-notebook-cells-loading` hook is the spec's handle on this state.
 */
export function CellsLoading() {
  return (
    <div
      data-notebook-cells-loading
      style={{
        display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
        padding: tokens.spacingVerticalXXL, justifyContent: 'center',
      }}
    >
      <Spinner size="tiny" />
      <Caption1>Loading notebook…</Caption1>
    </div>
  );
}

/**
 * The cell region's header strip — the state summary the gate above reveals:
 * unsaved badge, autosave status, cell count, and the default-language picker.
 * Extracted alongside the gate it sits behind so the two read together (and so
 * `notebook-editor.tsx` stays under the monolith-creep ceiling).
 */
export function CellsHeader({
  dirty, autosaveStatus, cellCount, defaultLang, onDefaultLangChange,
}: {
  dirty: boolean;
  autosaveStatus: AutosaveStatus;
  cellCount: number;
  defaultLang: NotebookCellLang;
  onDefaultLangChange: (lang: NotebookCellLang) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS }}>
      {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
      <AutosaveIndicator status={autosaveStatus} />
      <Caption1>{cellCount} cell{cellCount === 1 ? '' : 's'} · default lang <code>{defaultLang}</code></Caption1>
      <div style={{ flex: 1 }} />
      <Select
        size="small"
        value={defaultLang}
        onChange={(_, d) => onDefaultLangChange(d.value as NotebookCellLang)}
        aria-label="Default cell language"
      >
        <option value="pyspark">PySpark (Python)</option>
        <option value="spark">Spark (Scala)</option>
        <option value="sparksql">Spark SQL</option>
        <option value="sparkr">SparkR (R)</option>
        <option value="python">Python</option>
        <option value="tsql">T-SQL</option>
      </Select>
    </div>
  );
}
