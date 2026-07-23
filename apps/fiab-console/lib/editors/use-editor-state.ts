/**
 * useEditorState — the shared editor-state store (loom-next-level R18).
 *
 * One hook that bakes in the correct editor-state patterns so no editor has
 * to re-derive them:
 *
 *  1. SNAPSHOT SAFETY. The `setState(prev => { snap = prev; return prev; })`
 *     read-after-write trick used historically across Loom editors only works
 *     via React's eager-evaluation bailout, which is DISABLED once the fiber
 *     already has a pending update. If any other setState fired earlier in the
 *     same handler AND the snapshot variable was initialized to a constant,
 *     the updater is deferred to render and the handler silently reads STALE
 *     state (data-product create persisted an empty record because of exactly
 *     this — memory `csa_loom_setstate_snapshot_eager_eval_gotcha`, fixed in
 *     d1034047 with a stateRef mirror). This hook makes the gotcha
 *     structurally impossible: `snapshot()` reads an always-fresh ref that is
 *     updated SYNCHRONOUSLY inside `set`/`replace` (not just per-render), so a
 *     handler that mutates then reads gets the freshest committed value no
 *     matter what other setStates fired first.
 *
 *  2. DIRTY-TRACKING. `isDirty` compares the current doc against the last
 *     `markPublished()` baseline (cheap shallow structural equality by
 *     default, caller-supplied comparator via `isEqual`). This is the
 *     draft/publish seam ux-baseline.md requires ("a surface silently
 *     save-on-editing a live topology needs draft/publish").
 *
 *  3. UNDO INTEGRATION POINTS. `undo`/`redo`/`canUndo`/`canRedo` over an
 *     internal history ring buffer. Editors with a canvas should wire these to
 *     the existing canvas undo/redo stack — the hook provides the state half,
 *     the canvas provides the command half. Do not reimplement either.
 *
 * Convention: docs/fiab/editor-state-convention.md (R19). New editors MUST use
 * this hook for their primary document state; existing editors adopt when
 * their save handlers are touched (R8–R12 decompositions).
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

export interface UseEditorStateOptions<TDoc> {
  /** Fires when `isDirty` transitions (false→true or true→false). */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * Structural comparator for dirty-tracking. Defaults to a shallow
   * own-enumerable-key comparison (`Object.is` per value) with an `Object.is`
   * fast path — correct for the flat-ish doc objects editors keep, cheap
   * enough to run per render. Supply a custom comparator for deep docs.
   */
  isEqual?: (a: TDoc, b: TDoc) => boolean;
  /** Undo ring capacity (committed states retained). Default 50. */
  historyLimit?: number;
}

export interface EditorStateApi<TDoc extends object> {
  /** Current committed doc (reactive — re-renders on change). */
  doc: TDoc;
  /**
   * ALWAYS-fresh mirror of the doc — the stateRef fix, built in. Updated
   * synchronously by `set`/`replace`/`undo`/`redo` and re-synced every render.
   * Prefer `snapshot()` in handlers; the raw ref is exposed for effect deps
   * and imperative integrations (e.g. canvas command stacks).
   */
  ref: MutableRefObject<TDoc>;
  /** Shallow-merge a patch into the doc; marks dirty; pushes undo history. */
  set: (patch: Partial<TDoc>) => void;
  /** Replace the whole doc; marks dirty; pushes undo history. */
  replace: (next: TDoc) => void;
  /**
   * Snapshot-safe read for async save handlers: returns the freshest
   * committed doc regardless of what other setStates fired earlier in the
   * handler. NEVER use the `setState(prev => { snap = prev; return prev; })`
   * trick — this is its structurally-safe replacement.
   */
  snapshot: () => TDoc;
  /** True when the doc differs from the last published baseline. */
  isDirty: boolean;
  /**
   * Clear dirty after a successful save/publish. Optionally pass the doc the
   * backend acknowledged (e.g. server-normalized) to make IT the baseline and
   * the committed doc.
   */
  markPublished: (published?: TDoc) => void;
  /** Step back one committed state. No-op when history is empty. */
  undo: () => void;
  /** Re-apply the last undone state. No-op when the redo ring is empty. */
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  const ka = Object.keys(a) as Array<keyof T>;
  const kb = Object.keys(b) as Array<keyof T>;
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!Object.is(a[k], b[k])) return false;
  }
  return true;
}

const DEFAULT_HISTORY_LIMIT = 50;

export function useEditorState<TDoc extends object>(
  initialDoc: TDoc,
  options: UseEditorStateOptions<TDoc> = {}
): EditorStateApi<TDoc> {
  const { onDirtyChange, isEqual = shallowEqual, historyLimit = DEFAULT_HISTORY_LIMIT } = options;

  const [doc, setDoc] = useState<TDoc>(initialDoc);
  const [publishedDoc, setPublishedDoc] = useState<TDoc>(initialDoc);

  // The stateRef mirror. Synchronously assigned inside every mutator AND
  // re-synced each render so external replaces (none today) cannot drift it.
  const ref = useRef<TDoc>(doc);
  ref.current = doc;

  // Undo/redo rings live in refs (mutating them never needs its own render —
  // every mutation below is paired with a setDoc that re-renders), plus a
  // version counter so canUndo/canRedo stay reactive even on Object.is-equal
  // doc transitions.
  const undoRing = useRef<TDoc[]>([]);
  const redoRing = useRef<TDoc[]>([]);
  const [, setHistoryVersion] = useState(0);
  const bumpHistory = useCallback(() => setHistoryVersion((v) => v + 1), []);

  const commit = useCallback(
    (next: TDoc) => {
      undoRing.current.push(ref.current);
      if (undoRing.current.length > historyLimit) undoRing.current.shift();
      redoRing.current = [];
      ref.current = next; // synchronous — snapshot() is fresh immediately
      setDoc(next);
      bumpHistory();
    },
    [historyLimit, bumpHistory]
  );

  const set = useCallback(
    (patch: Partial<TDoc>) => {
      commit({ ...ref.current, ...patch });
    },
    [commit]
  );

  const replace = useCallback((next: TDoc) => commit(next), [commit]);

  const snapshot = useCallback((): TDoc => ref.current, []);

  const undo = useCallback(() => {
    const prev = undoRing.current.pop();
    if (prev === undefined) return;
    redoRing.current.push(ref.current);
    ref.current = prev;
    setDoc(prev);
    bumpHistory();
  }, [bumpHistory]);

  const redo = useCallback(() => {
    const next = redoRing.current.pop();
    if (next === undefined) return;
    undoRing.current.push(ref.current);
    ref.current = next;
    setDoc(next);
    bumpHistory();
  }, [bumpHistory]);

  const markPublished = useCallback((published?: TDoc) => {
    const baseline = published ?? ref.current;
    if (published !== undefined) {
      ref.current = published;
      setDoc(published);
    }
    setPublishedDoc(baseline);
  }, []);

  const isDirty = useMemo(() => !isEqual(doc, publishedDoc), [doc, publishedDoc, isEqual]);

  // onDirtyChange fires on transitions only (not on mount, not per keystroke
  // while already dirty).
  const lastDirty = useRef(isDirty);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    if (lastDirty.current !== isDirty) {
      lastDirty.current = isDirty;
      onDirtyChangeRef.current?.(isDirty);
    }
  }, [isDirty]);

  return {
    doc,
    ref,
    set,
    replace,
    snapshot,
    isDirty,
    markPublished,
    undo,
    redo,
    canUndo: undoRing.current.length > 0,
    canRedo: redoRing.current.length > 0,
  };
}
