/**
 * @vitest-environment jsdom
 *
 * U3 — notebook per-cell resize keying + explosion guard.
 *
 * Contract (ws-ui-excellence.md U3): each code cell's Monaco editor persists a
 * USER-chosen height under `loom.canvasHeight.monaco.notebook.<cellId>` — a key
 * is only created on the first real resize gesture (auto-until-first-drag), and
 * the notebook editor prunes a cell's key when the cell is deleted, so per-cell
 * keys can never accumulate beyond the cells that still exist.
 */
import { describe, it, expect, vi } from 'vitest';

// code-cell.tsx imports the runtime-flag hook (react-query); mock it so this
// pure-helper test doesn't need a QueryClientProvider in module scope.
vi.mock('@/lib/components/ui/use-runtime-flag', () => ({ useRuntimeFlag: () => true }));

import { notebookCellSizingKey, pruneCellHeightKey } from '../code-cell';

describe('U3 per-cell sizing keys', () => {
  it('keys follow the spec scheme notebook.<cellId> (full localStorage key under loom.canvasHeight.monaco.)', () => {
    expect(notebookCellSizingKey('abc-123')).toBe('notebook.abc-123');
  });

  it('pruneCellHeightKey removes exactly the deleted cell key and leaves siblings', () => {
    window.localStorage.setItem('loom.canvasHeight.monaco.notebook.cell-a', '360');
    window.localStorage.setItem('loom.canvasHeight.monaco.notebook.cell-b', '480');
    window.localStorage.setItem('loom.canvasHeight.monaco.warehouse.sql', '260');

    pruneCellHeightKey('cell-a');

    expect(window.localStorage.getItem('loom.canvasHeight.monaco.notebook.cell-a')).toBeNull();
    expect(window.localStorage.getItem('loom.canvasHeight.monaco.notebook.cell-b')).toBe('480');
    expect(window.localStorage.getItem('loom.canvasHeight.monaco.warehouse.sql')).toBe('260');

    window.localStorage.clear();
  });

  it('pruning a never-resized cell is a no-op (no throw)', () => {
    expect(() => pruneCellHeightKey('never-resized')).not.toThrow();
  });
});
