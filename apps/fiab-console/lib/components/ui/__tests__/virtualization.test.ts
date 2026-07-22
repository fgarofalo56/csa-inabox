/**
 * U10 — pure windowing-math tests for the virtualization primitives.
 * (The scroll engine itself is @tanstack/react-virtual; everything Loom owns
 * around it — cutoff, column math, row slicing, spacer spans, roving
 * keyboard model — is asserted here in node-env vitest.)
 */
import { describe, it, expect } from 'vitest';
import {
  VIRTUALIZATION_CUTOFF,
  shouldVirtualize,
  computeColumnCount,
  computeRowCount,
  rowSlice,
  moveRovingIndex,
  isRovingKey,
  windowSpan,
} from '@/lib/components/ui/virtualization';

describe('VIRTUALIZATION_CUTOFF (shared constant, round-3 operator decision)', () => {
  it('is exactly 200 and drives shouldVirtualize', () => {
    expect(VIRTUALIZATION_CUTOFF).toBe(200);
    expect(shouldVirtualize(200)).toBe(false); // at the cutoff → plain TileGrid
    expect(shouldVirtualize(201)).toBe(true);  // above it → windowed
    expect(shouldVirtualize(1437)).toBe(true); // the live /browse estate
  });

  it('the runtime kill-switch (FLAG0) forces the pre-U10 path', () => {
    expect(shouldVirtualize(1437, false)).toBe(false);
    expect(shouldVirtualize(1437, true)).toBe(true);
  });
});

describe('computeColumnCount — repeat(auto-fill, minmax(Npx, 1fr)) parity', () => {
  it('matches the auto-fill fit formula n·min + (n−1)·gap ≤ width', () => {
    // 3×260 + 2×16 = 812 fits in 812; a 4th column needs 1088.
    expect(computeColumnCount(812, 260, 16)).toBe(3);
    expect(computeColumnCount(811, 260, 16)).toBe(2);
    expect(computeColumnCount(1088, 260, 16)).toBe(4);
    expect(computeColumnCount(1087, 260, 16)).toBe(3);
  });

  it('never returns less than one column (pre-measurement first paint)', () => {
    expect(computeColumnCount(0, 260, 16)).toBe(1);
    expect(computeColumnCount(-5, 260, 16)).toBe(1);
    expect(computeColumnCount(NaN, 260, 16)).toBe(1);
    expect(computeColumnCount(100, 260, 16)).toBe(1); // narrower than one tile
  });
});

describe('computeRowCount + rowSlice — grid row windowing', () => {
  it('rows = ceil(items / columns)', () => {
    expect(computeRowCount(1437, 4)).toBe(360);
    expect(computeRowCount(8, 4)).toBe(2);
    expect(computeRowCount(9, 4)).toBe(3);
    expect(computeRowCount(0, 4)).toBe(0);
  });

  it('slices are contiguous, non-overlapping, and clamp the ragged last row', () => {
    // 10 items × 4 columns → rows [0..3], [4..7], [8..9]
    expect(rowSlice(10, 4, 0)).toEqual({ start: 0, end: 4 });
    expect(rowSlice(10, 4, 1)).toEqual({ start: 4, end: 8 });
    expect(rowSlice(10, 4, 2)).toEqual({ start: 8, end: 10 });
    // Past-the-end row renders nothing rather than clamping into real items.
    expect(rowSlice(10, 4, 3)).toEqual({ start: 10, end: 10 });
  });

  it('every item appears in exactly one row slice (1437 × 5 exhaustive)', () => {
    const items = 1437;
    const cols = 5;
    const seen: number[] = [];
    for (let r = 0; r < computeRowCount(items, cols); r++) {
      const { start, end } = rowSlice(items, cols, r);
      for (let i = start; i < end; i++) seen.push(i);
    }
    expect(seen.length).toBe(items);
    expect(seen[0]).toBe(0);
    expect(seen[items - 1]).toBe(items - 1);
    expect(new Set(seen).size).toBe(items);
  });
});

describe('windowSpan — spacer math around the materialized rows', () => {
  it('computes the window bounds and top/bottom pads', () => {
    const vRows = [
      { index: 10, start: 560, end: 616 },
      { index: 11, start: 616, end: 672 },
      { index: 12, start: 672, end: 728 },
    ];
    expect(windowSpan(vRows, 5600)).toEqual({
      firstRow: 10, lastRow: 12, padTop: 560, padBottom: 5600 - 728,
    });
  });

  it('an empty window pads the full height and renders zero rows', () => {
    expect(windowSpan([], 4200)).toEqual({ firstRow: 0, lastRow: -1, padTop: 0, padBottom: 4200 });
  });

  it('pads are never negative (measurement jitter clamps to 0)', () => {
    const span = windowSpan([{ index: 0, start: -2, end: 4300 }], 4200);
    expect(span.padTop).toBe(0);
    expect(span.padBottom).toBe(0);
  });
});

describe('moveRovingIndex — WAI-ARIA grid keyboard model', () => {
  const COLS = 4;
  const COUNT = 10; // grid: rows [0-3] [4-7] [8-9]

  it('Left/Right step ±1 and clamp at the collection edges', () => {
    expect(moveRovingIndex(5, 'ArrowRight', COLS, COUNT)).toBe(6);
    expect(moveRovingIndex(5, 'ArrowLeft', COLS, COUNT)).toBe(4);
    expect(moveRovingIndex(0, 'ArrowLeft', COLS, COUNT)).toBe(0);
    expect(moveRovingIndex(9, 'ArrowRight', COLS, COUNT)).toBe(9);
  });

  it('Up/Down move a full row and stay put at the top/bottom', () => {
    expect(moveRovingIndex(5, 'ArrowDown', COLS, COUNT)).toBe(9);
    expect(moveRovingIndex(5, 'ArrowUp', COLS, COUNT)).toBe(1);
    expect(moveRovingIndex(1, 'ArrowUp', COLS, COUNT)).toBe(1);   // already top row
    expect(moveRovingIndex(7, 'ArrowDown', COLS, COUNT)).toBe(7); // 7+4=11 > 9 → hold
  });

  it('Home/End jump to the first/last item', () => {
    expect(moveRovingIndex(5, 'Home', COLS, COUNT)).toBe(0);
    expect(moveRovingIndex(5, 'End', COLS, COUNT)).toBe(COUNT - 1);
  });

  it('columns=1 degrades to the list model (Up/Down = prev/next)', () => {
    expect(moveRovingIndex(3, 'ArrowDown', 1, 10)).toBe(4);
    expect(moveRovingIndex(3, 'ArrowUp', 1, 10)).toBe(2);
  });

  it('clamps an out-of-range current index and handles empty collections', () => {
    expect(moveRovingIndex(99, 'ArrowRight', COLS, COUNT)).toBe(COUNT - 1);
    expect(moveRovingIndex(-3, 'ArrowLeft', COLS, COUNT)).toBe(0);
    expect(moveRovingIndex(0, 'ArrowDown', COLS, 0)).toBe(-1);
  });

  it('isRovingKey admits exactly the six handled keys', () => {
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
      expect(isRovingKey(k)).toBe(true);
    }
    for (const k of ['Enter', ' ', 'Tab', 'PageDown', 'a']) {
      expect(isRovingKey(k)).toBe(false);
    }
  });
});
