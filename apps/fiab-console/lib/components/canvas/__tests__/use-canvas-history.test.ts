/**
 * Pure-reducer acceptance for the shared canvas undo/redo core (PRP W1). No
 * DOM — exercises push / undo / redo / cap / branch-truncation directly, the
 * behaviors every design tool's undo contract requires.
 */
import { describe, it, expect } from 'vitest';
import {
  createHistory, historyCommit, historyUndo, historyRedo,
  canUndoState, canRedoState, DEFAULT_HISTORY_LIMIT,
} from '../use-canvas-history';

describe('canvas history reducer', () => {
  it('seeds an empty past/future around the initial present', () => {
    const h = createHistory('a');
    expect(h.present).toBe('a');
    expect(canUndoState(h)).toBe(false);
    expect(canRedoState(h)).toBe(false);
  });

  it('commit pushes prior present onto past and clears future', () => {
    let h = createHistory('a');
    h = historyCommit(h, 'b');
    h = historyCommit(h, 'c');
    expect(h.present).toBe('c');
    expect(h.past).toEqual(['a', 'b']);
    expect(h.future).toEqual([]);
    expect(canUndoState(h)).toBe(true);
  });

  it('undo walks back through prior states in reverse order', () => {
    let h = createHistory('a');
    h = historyCommit(h, 'b');
    h = historyCommit(h, 'c');
    h = historyUndo(h);
    expect(h.present).toBe('b');
    h = historyUndo(h);
    expect(h.present).toBe('a');
    expect(canUndoState(h)).toBe(false);
  });

  it('redo restores undone states in forward order', () => {
    let h = createHistory('a');
    h = historyCommit(h, 'b');
    h = historyCommit(h, 'c');
    h = historyUndo(h);
    h = historyUndo(h); // back to 'a'
    h = historyRedo(h);
    expect(h.present).toBe('b');
    h = historyRedo(h);
    expect(h.present).toBe('c');
    expect(canRedoState(h)).toBe(false);
  });

  it('undo at the oldest state is a no-op (same reference)', () => {
    const h = createHistory('a');
    expect(historyUndo(h)).toBe(h);
  });

  it('redo at the newest state is a no-op (same reference)', () => {
    let h = createHistory('a');
    h = historyCommit(h, 'b');
    expect(historyRedo(h)).toBe(h);
  });

  it('a new commit after undo truncates the redo branch', () => {
    let h = createHistory('a');
    h = historyCommit(h, 'b');
    h = historyCommit(h, 'c');
    h = historyUndo(h);            // present 'b', future ['c']
    expect(h.future).toEqual(['c']);
    h = historyCommit(h, 'd');     // branch: future must be dropped
    expect(h.present).toBe('d');
    expect(h.future).toEqual([]);
    expect(canRedoState(h)).toBe(false);
    // 'c' is unreachable now; undo goes b -> a
    h = historyUndo(h);
    expect(h.present).toBe('b');
  });

  it('caps the past stack at the limit, dropping the oldest entries', () => {
    let h = createHistory(0);
    for (let i = 1; i <= 150; i += 1) h = historyCommit(h, i, 100);
    expect(h.present).toBe(150);
    expect(h.past.length).toBe(100);
    // oldest surviving undo target is 150-100 = 50
    expect(h.past[0]).toBe(50);
  });

  it('honors the default limit constant when none is passed', () => {
    let h = createHistory(0);
    for (let i = 1; i <= DEFAULT_HISTORY_LIMIT + 25; i += 1) h = historyCommit(h, i);
    expect(h.past.length).toBe(DEFAULT_HISTORY_LIMIT);
  });
});
