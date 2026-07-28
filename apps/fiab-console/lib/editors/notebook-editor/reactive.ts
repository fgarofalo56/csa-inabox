'use client';

/**
 * N19a — reactive-notebook controller hook.
 *
 * Owns the reactive half of the notebook editor so `notebook-editor.tsx` stays
 * under its size ratchet: the live dependency DAG, the stale set, and the
 * reactive run loop that re-executes ONLY the invalidated downstream cells
 * after a cell is edited or run (Marimo semantics on Loom's existing per-cell
 * run path — it calls the editor's `runCell`, it never opens a second run
 * channel, so every execution still goes through the real Spark / Livy / AML
 * backend and its receipts).
 *
 * Reactive mode is user-controlled (default OFF, persisted per notebook in
 * localStorage) and additionally kill-switchable by an admin through the
 * FLAG0 runtime flag `n19a-reactive-notebook` (default-ON: the toggle is
 * available unless an admin explicitly turns the capability off).
 *
 * Staleness is tracked even when reactive AUTO-RUN is off, so the editor can
 * always show "this result no longer follows from the code" — the honest state
 * a notebook normally hides.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NotebookCell } from '@/lib/types/notebook-cell';
import {
  buildNotebookDag,
  staleAfterEdit,
  reactiveRunPlan,
  topoSort,
  type NotebookDag,
} from '@/lib/notebook/reactive-dag';

/** FLAG0 kill-switch id — registered in lib/admin/runtime-flags.ts. */
export const REACTIVE_NOTEBOOK_FLAG = 'n19a-reactive-notebook';

const LS_PREFIX = 'loom.notebook.reactive.';

function readPref(notebookId: string): boolean {
  if (!notebookId || typeof window === 'undefined') return false;
  try { return window.localStorage.getItem(LS_PREFIX + notebookId) === 'on'; } catch { return false; }
}

function writePref(notebookId: string, on: boolean): void {
  if (!notebookId || typeof window === 'undefined') return;
  try { window.localStorage.setItem(LS_PREFIX + notebookId, on ? 'on' : 'off'); } catch { /* private mode */ }
}

export interface ReactiveNotebookOptions {
  cells: NotebookCell[];
  notebookId: string;
  /** The editor's real per-cell run (dispatch + poll + patch output). */
  runCell: (cell: NotebookCell) => Promise<void>;
  /** Status line setter — the reactive loop narrates what it is running. */
  setRunMsg: (msg: string) => void;
  /** False when an admin has turned the capability off (FLAG0). */
  available: boolean;
}

export interface ReactiveNotebookApi {
  /** True when the user has reactive auto-run ON for this notebook. */
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** Live dependency graph over the notebook's code cells. */
  dag: NotebookDag;
  /** Cell ids whose last output no longer follows from the current sources. */
  stale: Set<string>;
  /** Stale cells in dependency order (a runnable plan). */
  stalePlan: string[];
  /** True while the reactive loop is executing a plan. */
  running: boolean;
  /** Call when a cell's SOURCE changed — marks it + its downstream stale. */
  onCellEdited: (cellId: string) => void;
  /** Run a cell, then (in reactive mode) its invalidated downstream, in order. */
  runReactive: (cell: NotebookCell) => Promise<void>;
  /** Run every currently-stale cell in dependency order (manual trigger). */
  runStale: () => Promise<void>;
  /** Clear staleness without running (user accepts the current outputs). */
  clearStale: () => void;
  /** Cells trapped in a dependency cycle — never auto-run. */
  cycleCells: Set<string>;
}

/**
 * Yield to the event loop so pending React state updates have flushed into
 * `cellsRef`. The reactive loop reads the LIVE cell list after every run (to
 * see the output `runCell` just patched in) and after every edit (to see the
 * source the user just typed); reading it in the same tick would see the
 * pre-update snapshot and either miss a failure or build the DAG from stale
 * sources.
 */
function afterFlush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function useReactiveNotebook(opts: ReactiveNotebookOptions): ReactiveNotebookApi {
  const { cells, notebookId, runCell, setRunMsg, available } = opts;
  const [enabledRaw, setEnabledRaw] = useState(false);
  const [stale, setStale] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  // Latest cells, so the async run loop always dispatches the CURRENT source
  // (the same staleness hazard patchCell guards against in the editor).
  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  // Per-notebook preference; switching notebooks reloads it and drops staleness.
  useEffect(() => {
    setEnabledRaw(readPref(notebookId));
    setStale(new Set());
  }, [notebookId]);

  const enabled = available && enabledRaw;

  const setEnabled = useCallback((on: boolean) => {
    setEnabledRaw(on);
    writePref(notebookId, on);
  }, [notebookId]);

  const dag = useMemo(() => buildNotebookDag(cells), [cells]);

  const cycleCells = useMemo(() => new Set(dag.cycles.flat()), [dag]);

  const onCellEdited = useCallback((cellId: string) => {
    // Deferred: the caller edits and marks in the same handler, so the new
    // source is only in `cellsRef` after React flushes.
    void afterFlush().then(() => {
      setStale((prev) => new Set(staleAfterEdit(buildNotebookDag(cellsRef.current), [cellId], prev)));
    });
  }, []);

  const clearStale = useCallback(() => setStale(new Set()), []);

  const stalePlan = useMemo(
    () => topoSort(dag, dag.order.filter((id) => stale.has(id) && !cycleCells.has(id))),
    [dag, stale, cycleCells],
  );

  /** Execute an ordered list of cell ids through the editor's real run path. */
  const runPlan = useCallback(async (plan: string[], label: string) => {
    if (plan.length === 0) return;
    setRunning(true);
    try {
      for (let i = 0; i < plan.length; i++) {
        const id = plan[i];
        const cell = cellsRef.current.find((c) => c.id === id);
        if (!cell || cell.type !== 'code') continue;
        setRunMsg(`${label} ${i + 1}/${plan.length}: cell ${id.slice(0, 6)}…`);
        await runCell(cell);
        await afterFlush();
        // Stop the cascade on the first failure — running downstream cells on a
        // broken upstream would produce misleading results (and burn Spark time).
        const after = cellsRef.current.find((c) => c.id === id);
        if (after?.output?.status === 'error') {
          setRunMsg(`${label} stopped: cell ${id.slice(0, 6)} failed — fix it and re-run.`);
          return;
        }
        setStale((prev) => { const next = new Set(prev); next.delete(id); return next; });
      }
      setRunMsg(`${label} complete — ${plan.length} cell${plan.length === 1 ? '' : 's'}.`);
    } finally {
      setRunning(false);
    }
  }, [runCell, setRunMsg]);

  const runReactive = useCallback(async (cell: NotebookCell) => {
    await runCell(cell);
    await afterFlush();
    setStale((prev) => { const next = new Set(prev); next.delete(cell.id); return next; });
    if (!enabled) return;
    const current = cellsRef.current.find((c) => c.id === cell.id);
    if (current?.output?.status === 'error') return;
    const fresh = buildNotebookDag(cellsRef.current);
    const plan = reactiveRunPlan(fresh, cell.id);
    if (plan.length === 0) return;
    await runPlan(plan, 'Reactive re-run');
  }, [enabled, runCell, runPlan]);

  const runStale = useCallback(async () => {
    const fresh = buildNotebookDag(cellsRef.current);
    const plan = topoSort(fresh, fresh.order.filter((id) => stale.has(id) && !cycleCells.has(id)));
    await runPlan(plan, 'Run stale');
  }, [stale, cycleCells, runPlan]);

  // Memoized so consumers can list `reactive` in a useMemo dependency array
  // (the notebook ribbon does) without recomputing on every render.
  return useMemo(() => ({
    enabled, setEnabled, dag, stale, stalePlan, running,
    onCellEdited, runReactive, runStale, clearStale, cycleCells,
  }), [
    enabled, setEnabled, dag, stale, stalePlan, running,
    onCellEdited, runReactive, runStale, clearStale, cycleCells,
  ]);
}
