/**
 * useEditorState (R18) — unit coverage.
 *
 * Includes the REGRESSION test that reproduces the eager-eval snapshot gotcha
 * (memory `csa_loom_setstate_snapshot_eager_eval_gotcha`): an async save
 * handler that fires an unrelated setState (setStatus) BEFORE reading state
 * must still read the freshest committed doc. The legacy
 * `setState(prev => { snap = prev; return prev; })` trick silently read stale
 * in exactly that sequence (data-product create persisted an empty record);
 * `snapshot()` must not.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { useEditorState } from '../use-editor-state';

interface Doc {
  displayName: string;
  owner: string;
  description: string;
}

const EMPTY: Doc = { displayName: '', owner: '', description: '' };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useEditorState — snapshot safety (the eager-eval gotcha)', () => {
  it('REGRESSION: snapshot() is fresh even when another setState fired first in the same handler', async () => {
    // Harness mirrors the broken data-product save(): a status setState fires
    // BEFORE the state read. With the legacy trick this read EMPTY; with
    // snapshot() it must read the typed values.
    let captured: Doc | null = null;
    function Harness() {
      const s = useEditorState<Doc>(EMPTY);
      const [, setStatus] = useState<'idle' | 'saving'>('idle');
      const type = useCallback(
        () => s.set({ displayName: 'Revenue Insights Product', owner: 'fgarofalo' }),
        [s.set] // eslint-disable-line react-hooks/exhaustive-deps
      );
      const save = useCallback(async () => {
        setStatus('saving'); // pending update on the fiber — eager-eval now disabled
        captured = s.snapshot(); // must STILL be fresh
      }, [s.snapshot]); // eslint-disable-line react-hooks/exhaustive-deps
      return (
        <div>
          <button data-testid="type" onClick={type} />
          <button data-testid="save" onClick={() => void save()} />
        </div>
      );
    }
    const { getByTestId } = render(<Harness />);
    await act(async () => {
      getByTestId('type').click();
    });
    await act(async () => {
      getByTestId('save').click();
    });
    expect(captured).not.toBeNull();
    expect(captured!.displayName).toBe('Revenue Insights Product');
    expect(captured!.owner).toBe('fgarofalo');
  });

  it('snapshot() is fresh SYNCHRONOUSLY after set() within the same handler (no render in between)', () => {
    const { result } = renderHook(() => useEditorState<Doc>(EMPTY));
    act(() => {
      result.current.set({ displayName: 'immediate' });
      // read before React re-renders — the ref must already be current
      expect(result.current.snapshot().displayName).toBe('immediate');
    });
  });

  it('sequential set() calls in one handler compose (no lost updates)', () => {
    const { result } = renderHook(() => useEditorState<Doc>(EMPTY));
    act(() => {
      result.current.set({ displayName: 'a' });
      result.current.set({ owner: 'b' });
      result.current.set({ description: 'c' });
    });
    expect(result.current.doc).toEqual({ displayName: 'a', owner: 'b', description: 'c' });
    expect(result.current.snapshot()).toEqual(result.current.doc);
  });
});

describe('useEditorState — doc updates', () => {
  it('set() shallow-merges and doc is reactive', () => {
    const { result } = renderHook(() => useEditorState<Doc>(EMPTY));
    act(() => result.current.set({ owner: 'me' }));
    expect(result.current.doc).toEqual({ ...EMPTY, owner: 'me' });
  });

  it('replace() swaps the whole doc', () => {
    const { result } = renderHook(() => useEditorState<Doc>(EMPTY));
    const next: Doc = { displayName: 'x', owner: 'y', description: 'z' };
    act(() => result.current.replace(next));
    expect(result.current.doc).toBe(next);
    expect(result.current.ref.current).toBe(next);
  });
});

describe('useEditorState — dirty-tracking / draft-publish seam', () => {
  it('starts clean; flips dirty on set(); clears on markPublished()', () => {
    const { result } = renderHook(() => useEditorState<Doc>(EMPTY));
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.set({ displayName: 'draft' }));
    expect(result.current.isDirty).toBe(true);
    act(() => result.current.markPublished());
    expect(result.current.isDirty).toBe(false);
    // and dirties again relative to the NEW baseline
    act(() => result.current.set({ displayName: 'draft-2' }));
    expect(result.current.isDirty).toBe(true);
  });

  it('markPublished(serverDoc) adopts the acknowledged doc as committed + baseline', () => {
    const { result } = renderHook(() => useEditorState<Doc>(EMPTY));
    act(() => result.current.set({ displayName: 'local' }));
    const serverDoc: Doc = { displayName: 'local', owner: 'server-added', description: '' };
    act(() => result.current.markPublished(serverDoc));
    expect(result.current.doc).toBe(serverDoc);
    expect(result.current.snapshot()).toBe(serverDoc);
    expect(result.current.isDirty).toBe(false);
  });

  it('a set() that restores baseline values reads clean (structural equality, not reference)', () => {
    const { result } = renderHook(() => useEditorState<Doc>(EMPTY));
    act(() => result.current.set({ displayName: 'temp' }));
    expect(result.current.isDirty).toBe(true);
    act(() => result.current.set({ displayName: '' })); // back to baseline values
    expect(result.current.isDirty).toBe(false);
  });

  it('onDirtyChange fires on transitions only', () => {
    const onDirtyChange = vi.fn();
    const { result } = renderHook(() => useEditorState<Doc>(EMPTY, { onDirtyChange }));
    act(() => result.current.set({ displayName: 'a' }));
    act(() => result.current.set({ displayName: 'b' })); // still dirty — no second call
    expect(onDirtyChange).toHaveBeenCalledTimes(1);
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    act(() => result.current.markPublished());
    expect(onDirtyChange).toHaveBeenCalledTimes(2);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('honors a caller-supplied comparator', () => {
    const { result } = renderHook(() =>
      useEditorState<Doc>(EMPTY, {
        // only displayName matters for dirtiness
        isEqual: (a, b) => a.displayName === b.displayName,
      })
    );
    act(() => result.current.set({ owner: 'irrelevant' }));
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.set({ displayName: 'relevant' }));
    expect(result.current.isDirty).toBe(true);
  });
});

describe('useEditorState — undo/redo ring', () => {
  it('undo() steps back, redo() re-applies, flags track availability', () => {
    const { result } = renderHook(() => useEditorState<Doc>(EMPTY));
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);

    act(() => result.current.set({ displayName: 'v1' }));
    act(() => result.current.set({ displayName: 'v2' }));
    expect(result.current.canUndo).toBe(true);

    act(() => result.current.undo());
    expect(result.current.doc.displayName).toBe('v1');
    expect(result.current.snapshot().displayName).toBe('v1'); // ref stays in lockstep
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.undo());
    expect(result.current.doc.displayName).toBe('');
    expect(result.current.canUndo).toBe(false);

    act(() => result.current.redo());
    expect(result.current.doc.displayName).toBe('v1');
    act(() => result.current.redo());
    expect(result.current.doc.displayName).toBe('v2');
    expect(result.current.canRedo).toBe(false);
  });

  it('a new set() clears the redo ring (standard history semantics)', () => {
    const { result } = renderHook(() => useEditorState<Doc>(EMPTY));
    act(() => result.current.set({ displayName: 'v1' }));
    act(() => result.current.undo());
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.set({ displayName: 'divergent' }));
    expect(result.current.canRedo).toBe(false);
  });

  it('history is capped at historyLimit (ring buffer, oldest dropped)', () => {
    const { result } = renderHook(() => useEditorState<Doc>(EMPTY, { historyLimit: 3 }));
    act(() => {
      for (let i = 1; i <= 6; i++) result.current.set({ displayName: `v${i}` });
    });
    // only 3 undos available: v6 → v5 → v4 → v3, then exhausted
    act(() => result.current.undo());
    act(() => result.current.undo());
    act(() => result.current.undo());
    expect(result.current.doc.displayName).toBe('v3');
    expect(result.current.canUndo).toBe(false);
  });

  it('undo() with empty history is a safe no-op', () => {
    const { result } = renderHook(() => useEditorState<Doc>(EMPTY));
    act(() => result.current.undo());
    expect(result.current.doc).toEqual(EMPTY);
    act(() => result.current.redo());
    expect(result.current.doc).toEqual(EMPTY);
  });
});
