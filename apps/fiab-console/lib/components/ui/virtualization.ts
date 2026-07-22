/**
 * virtualization — pure windowing math shared by `VirtualizedGrid`,
 * `VirtualizedList`, and `LoomDataTable`'s row-windowing mode (U10).
 *
 * Kept free of React/DOM so the math is unit-testable in node-env vitest
 * (the repo's component render harness is not part of the CI gate). The
 * scroll-driven range computation itself comes from `@tanstack/react-virtual`
 * (the ONE permitted virtualization dependency per the loom-next-level
 * round-3 decision — do NOT hand-roll or add another lib); this module owns
 * everything around it: the adoption cutoff, the CSS-grid column math that
 * mirrors `TileGrid`'s `repeat(auto-fill, minmax(Npx, 1fr))` template, the
 * row/slice mapping for grid windowing, and the roving-tabindex keyboard
 * navigation.
 */

/**
 * The shared adoption cutoff (round-3 operator decision — a CONSTANT, not
 * prose): collections at or below this render the plain `TileGrid` / full
 * table (small lists don't pay the windowing complexity); collections above
 * it window. Consumed by BOTH TileGrid guidance and the virtualized
 * primitives so every surface flips at the same size.
 */
export const VIRTUALIZATION_CUTOFF = 200;

/** True when a collection of `count` items should render windowed. */
export function shouldVirtualize(count: number, flagEnabled = true): boolean {
  return flagEnabled && count > VIRTUALIZATION_CUTOFF;
}

/**
 * Column count for a `repeat(auto-fill, minmax(minTileWidth px, 1fr))` grid:
 * n columns fit when `n·min + (n−1)·gap ≤ width` →
 * `n = floor((width + gap) / (min + gap))`, floored at 1 (a zero/unknown
 * width — first paint before measurement — renders a single column).
 */
export function computeColumnCount(containerWidth: number, minTileWidth: number, gapPx: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 1;
  const min = Math.max(1, minTileWidth);
  const gap = Math.max(0, gapPx);
  return Math.max(1, Math.floor((containerWidth + gap) / (min + gap)));
}

/** Number of grid rows needed for `itemCount` items across `columns`. */
export function computeRowCount(itemCount: number, columns: number): number {
  if (itemCount <= 0) return 0;
  return Math.ceil(itemCount / Math.max(1, columns));
}

/** The [start, end) item-index slice rendered by grid row `rowIndex`. */
export function rowSlice(
  itemCount: number,
  columns: number,
  rowIndex: number,
): { start: number; end: number } {
  const cols = Math.max(1, columns);
  const start = Math.max(0, rowIndex) * cols;
  return { start: Math.min(start, itemCount), end: Math.min(itemCount, start + cols) };
}

/** Keys the roving-tabindex handler consumes (all others pass through). */
export type RovingKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

export function isRovingKey(key: string): key is RovingKey {
  return (
    key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' ||
    key === 'ArrowDown' || key === 'Home' || key === 'End'
  );
}

/**
 * Roving-tabindex move over a `columns`-wide grid of `count` items
 * (WAI-ARIA grid pattern: one tab stop; arrows move the active cell).
 * Left/Right step ±1 clamped to the collection; Up/Down step ±columns but
 * never leave the collection; Home/End jump to the first/last item. For a
 * list, pass `columns = 1` (Up/Down become previous/next).
 */
export function moveRovingIndex(current: number, key: RovingKey, columns: number, count: number): number {
  if (count <= 0) return -1;
  const cols = Math.max(1, columns);
  const cur = Math.min(Math.max(0, current), count - 1);
  switch (key) {
    case 'ArrowLeft': return Math.max(0, cur - 1);
    case 'ArrowRight': return Math.min(count - 1, cur + 1);
    case 'ArrowUp': return cur - cols >= 0 ? cur - cols : cur;
    case 'ArrowDown': return cur + cols <= count - 1 ? cur + cols : cur;
    case 'Home': return 0;
    case 'End': return count - 1;
  }
}

/**
 * The window of ROWS to materialize plus the top/bottom spacer heights, from
 * a virtualizer's visible items. Pure so the spacer math is unit-tested
 * (an off-by-one here is exactly the class of bug that scrolls content under
 * the fold or double-renders a row).
 */
export function windowSpan(
  virtualRows: ReadonlyArray<{ index: number; start: number; end: number }>,
  totalSize: number,
): { firstRow: number; lastRow: number; padTop: number; padBottom: number } {
  if (virtualRows.length === 0) {
    return { firstRow: 0, lastRow: -1, padTop: 0, padBottom: Math.max(0, totalSize) };
  }
  const first = virtualRows[0];
  const last = virtualRows[virtualRows.length - 1];
  return {
    firstRow: first.index,
    lastRow: last.index,
    padTop: Math.max(0, first.start),
    padBottom: Math.max(0, totalSize - last.end),
  };
}
