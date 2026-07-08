'use client';

/**
 * useCanvasHistory — the shared action-level undo/redo foundation for every
 * Loom design canvas (pipeline, dataflow, eventstream, graph-model). It is the
 * baseline every design tool (Figma, VS Code, ADF Studio) sets and which Loom
 * previously lacked entirely (PRP-surface-max-enhancements W1).
 *
 * DESIGN — snapshot history, host-owned application.
 * Loom canvases are *controlled*: the React-Flow node list is derived from a
 * parent-owned model (`activities[]`, a graph `state`, a dataflow definition),
 * and every mutation flows through a single `onChange`-style callback. So the
 * cleanest, host-agnostic history primitive is a **snapshot stack of that
 * model** rather than a per-node command log:
 *
 *   - The host calls `commit(nextModel)` on every genuine *user* mutation
 *     (add / remove / move / connect / config-change). That records the prior
 *     model onto the undo stack and clears the redo stack (branch truncation).
 *   - `undo()` / `redo()` return the model snapshot to apply and the host pushes
 *     it back into its own state via the same `onChange` path. Because the host
 *     applies it (rather than the hook mutating anything), there is exactly one
 *     source of truth and no double-apply.
 *   - The stack is bounded (default 100) — the oldest entry is dropped when the
 *     cap is exceeded, matching a typical editor's undo depth.
 *
 * The reducer core (`createHistory` / `historyCommit` / `historyUndo` /
 * `historyRedo`) is exported as pure functions so it is unit-tested without a
 * DOM (see __tests__/use-canvas-history.test.ts). The React hook is a thin,
 * re-rendering wrapper so toolbar buttons can reflect `canUndo` / `canRedo`.
 *
 * Backend: none. Undo state is transient client memory; the committed model
 * still persists through each editor's existing per-type save route. No Azure
 * resource, no bicep, identical in Commercial and Government.
 */

import { useCallback, useRef, useState } from 'react';

/** A past/present/future snapshot stack over an immutable model `S`. */
export interface HistoryState<S> {
  past: S[];
  present: S;
  future: S[];
}

/** Default bounded undo depth — one entry per committed user action. */
export const DEFAULT_HISTORY_LIMIT = 100;

/** Seed a fresh history whose only known state is `present`. */
export function createHistory<S>(present: S): HistoryState<S> {
  return { past: [], present, future: [] };
}

/**
 * Record `next` as the new present. Pushes the prior present onto `past`,
 * clears `future` (a new action truncates any redo branch), and caps `past`
 * to `limit` by dropping the oldest entries.
 */
export function historyCommit<S>(
  state: HistoryState<S>,
  next: S,
  limit: number = DEFAULT_HISTORY_LIMIT,
): HistoryState<S> {
  const grown = [...state.past, state.present];
  const past = grown.length > limit ? grown.slice(grown.length - limit) : grown;
  return { past, present: next, future: [] };
}

/** True when there is a prior state to undo to. */
export function canUndoState<S>(state: HistoryState<S>): boolean {
  return state.past.length > 0;
}

/** True when an undone state can be redone. */
export function canRedoState<S>(state: HistoryState<S>): boolean {
  return state.future.length > 0;
}

/** Step back one action. No-op (returns the same reference) at the oldest state. */
export function historyUndo<S>(state: HistoryState<S>): HistoryState<S> {
  if (state.past.length === 0) return state;
  const previous = state.past[state.past.length - 1];
  return {
    past: state.past.slice(0, -1),
    present: previous,
    future: [state.present, ...state.future],
  };
}

/** Step forward one action. No-op (returns the same reference) at the newest state. */
export function historyRedo<S>(state: HistoryState<S>): HistoryState<S> {
  if (state.future.length === 0) return state;
  const next = state.future[0];
  return {
    past: [...state.past, state.present],
    present: next,
    future: state.future.slice(1),
  };
}

export interface UseCanvasHistoryOptions {
  /** Bounded undo depth. Default 100. */
  limit?: number;
}

export interface CanvasHistoryApi<S> {
  /** Record a user mutation as the new present (clears redo, caps the stack). */
  commit: (next: S) => void;
  /** Step back; returns the model snapshot to apply, or null at the oldest state. */
  undo: () => S | null;
  /** Step forward; returns the model snapshot to apply, or null at the newest state. */
  redo: () => S | null;
  /** Rebase history onto `snapshot` without recording (e.g. external/initial load). */
  reset: (snapshot: S) => void;
  /** Whether an undo is available (drives toolbar disabled state). */
  canUndo: boolean;
  /** Whether a redo is available (drives toolbar disabled state). */
  canRedo: boolean;
}

/**
 * React binding over the pure reducer. `undo`/`redo` return the snapshot the
 * host should apply to its own model; the hook never mutates the host state.
 * A ref mirror keeps the stack synchronous so a `commit` immediately followed
 * by an `undo` in the same tick is coherent.
 */
export function useCanvasHistory<S>(initial: S, opts: UseCanvasHistoryOptions = {}): CanvasHistoryApi<S> {
  const limit = opts.limit ?? DEFAULT_HISTORY_LIMIT;
  const [state, setState] = useState<HistoryState<S>>(() => createHistory(initial));
  const ref = useRef(state);

  const write = useCallback((next: HistoryState<S>) => {
    ref.current = next;
    setState(next);
  }, []);

  const commit = useCallback((next: S) => {
    write(historyCommit(ref.current, next, limit));
  }, [limit, write]);

  const undo = useCallback((): S | null => {
    if (ref.current.past.length === 0) return null;
    const next = historyUndo(ref.current);
    write(next);
    return next.present;
  }, [write]);

  const redo = useCallback((): S | null => {
    if (ref.current.future.length === 0) return null;
    const next = historyRedo(ref.current);
    write(next);
    return next.present;
  }, [write]);

  const reset = useCallback((snapshot: S) => {
    write(createHistory(snapshot));
  }, [write]);

  return {
    commit,
    undo,
    redo,
    reset,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}
