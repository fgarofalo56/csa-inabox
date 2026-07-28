/**
 * N19a — reactive controller wiring (hook-level).
 *
 * The DAG math is covered by lib/notebook/__tests__/reactive-dag.test.ts; this
 * covers the CONTROLLER contract that the editor depends on: what goes stale on
 * an edit, what the reactive loop actually runs (and in what order), that it
 * stops on a failure, and that the admin kill switch wins over the user toggle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { NotebookCell } from '@/lib/types/notebook-cell';
import { useReactiveNotebook } from '../reactive';

function code(id: string, source: string): NotebookCell {
  return { id, type: 'code', lang: 'pyspark', source };
}

//  c1 (a) → c2 (b from a) → c3 (c from b)     c4 standalone
const CELLS: NotebookCell[] = [
  code('c1', 'a = 1'),
  code('c2', 'b = a + 1'),
  code('c3', 'c = b + 1'),
  code('c4', 'solo = 0'),
];

function setup(overrides: Partial<Parameters<typeof useReactiveNotebook>[0]> = {}) {
  const ran: string[] = [];
  const runCell = vi.fn(async (cell: NotebookCell) => { ran.push(cell.id); });
  const view = renderHook((props: { cells: NotebookCell[] }) => useReactiveNotebook({
    cells: props.cells,
    notebookId: 'nb-1',
    runCell,
    setRunMsg: () => undefined,
    available: true,
    ...overrides,
  }), { initialProps: { cells: CELLS } });
  return { ...view, ran, runCell };
}

beforeEach(() => {
  try { window.localStorage.clear(); } catch { /* jsdom without storage */ }
});

describe('useReactiveNotebook — availability + toggle', () => {
  it('starts with auto-run OFF (nothing re-runs behind the user)', () => {
    const { result } = setup();
    expect(result.current.enabled).toBe(false);
  });

  it('the user toggle turns auto-run on and persists it', () => {
    const { result } = setup();
    act(() => result.current.setEnabled(true));
    expect(result.current.enabled).toBe(true);
    expect(window.localStorage.getItem('loom.notebook.reactive.nb-1')).toBe('on');
  });

  it('the admin kill switch wins over the user toggle', () => {
    const { result } = setup({ available: false });
    act(() => result.current.setEnabled(true));
    expect(result.current.enabled).toBe(false);
  });
});

describe('useReactiveNotebook — staleness', () => {
  it('marks the edited cell and its downstream stale, in dependency order', async () => {
    const { result } = setup();
    act(() => result.current.onCellEdited('c1'));
    await waitFor(() => expect(result.current.stale.size).toBe(3));
    expect(result.current.stalePlan).toEqual(['c1', 'c2', 'c3']);
    expect(result.current.stale.has('c4')).toBe(false);
  });

  it('never marks upstream cells stale', async () => {
    const { result } = setup();
    act(() => result.current.onCellEdited('c3'));
    await waitFor(() => expect(result.current.stale.size).toBe(1));
    expect(result.current.stalePlan).toEqual(['c3']);
  });

  it('clearStale accepts the current outputs', async () => {
    const { result } = setup();
    act(() => result.current.onCellEdited('c1'));
    await waitFor(() => expect(result.current.stale.size).toBe(3));
    act(() => result.current.clearStale());
    expect(result.current.stale.size).toBe(0);
  });
});

describe('useReactiveNotebook — reactive run', () => {
  it('runs ONLY the edited cell when auto-run is off', async () => {
    const { result, ran } = setup();
    await act(async () => { await result.current.runReactive(CELLS[0]); });
    expect(ran).toEqual(['c1']);
  });

  it('cascades downstream in dependency order when auto-run is on', async () => {
    const { result, ran } = setup();
    act(() => result.current.setEnabled(true));
    await act(async () => { await result.current.runReactive(CELLS[0]); });
    expect(ran).toEqual(['c1', 'c2', 'c3']);
  });

  it('does not touch independent cells', async () => {
    const { result, ran } = setup();
    act(() => result.current.setEnabled(true));
    await act(async () => { await result.current.runReactive(CELLS[3]); });
    expect(ran).toEqual(['c4']);
  });

  it('stops the cascade when a cell fails', async () => {
    const ran: string[] = [];
    const failed = [...CELLS];
    const runCell = vi.fn(async (cell: NotebookCell) => {
      ran.push(cell.id);
      if (cell.id === 'c2') {
        const i = failed.findIndex((c) => c.id === 'c2');
        failed[i] = { ...failed[i], output: { status: 'error', ename: 'NameError', evalue: 'boom' } };
      }
    });
    const { result, rerender } = renderHook(
      (props: { cells: NotebookCell[] }) => useReactiveNotebook({
        cells: props.cells, notebookId: 'nb-2', runCell, setRunMsg: () => undefined, available: true,
      }),
      { initialProps: { cells: failed } },
    );
    act(() => result.current.setEnabled(true));
    await act(async () => {
      const p = result.current.runReactive(failed[0]);
      rerender({ cells: failed });
      await p;
    });
    expect(ran).toContain('c2');
    expect(ran).not.toContain('c3');
  });

  it('runStale runs every stale cell in dependency order', async () => {
    const { result, ran } = setup();
    act(() => result.current.onCellEdited('c1'));
    await waitFor(() => expect(result.current.stale.size).toBe(3));
    await act(async () => { await result.current.runStale(); });
    expect(ran).toEqual(['c1', 'c2', 'c3']);
  });

  it('never auto-runs a cell trapped in a dependency cycle', async () => {
    const cyclic = [code('x', 'p = q + 1'), code('y', 'q = p + 1'), code('z', 'r = 1')];
    const ran: string[] = [];
    const runCell = vi.fn(async (cell: NotebookCell) => { ran.push(cell.id); });
    const { result } = renderHook(() => useReactiveNotebook({
      cells: cyclic, notebookId: 'nb-3', runCell, setRunMsg: () => undefined, available: true,
    }));
    expect(result.current.cycleCells).toEqual(new Set(['x', 'y']));
    act(() => result.current.onCellEdited('x'));
    await waitFor(() => expect(result.current.stale.has('x')).toBe(true));
    await act(async () => { await result.current.runStale(); });
    expect(ran).toEqual([]);
  });
});
