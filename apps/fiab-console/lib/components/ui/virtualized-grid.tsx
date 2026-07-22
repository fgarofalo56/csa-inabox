'use client';

/**
 * VirtualizedGrid — the windowed sibling of `TileGrid` (U10).
 *
 * Same visual contract as TileGrid (`repeat(auto-fill, minmax(Npx, 1fr))`
 * columns, token gap, drop-in tile renderer prop) but only the rows near the
 * viewport are materialized, so a 1,400+-tile collection scrolls instead of
 * freezing the renderer (the confirmed /browse P0 defect). Windowing comes
 * from `@tanstack/react-virtual` (the ONE permitted virtualization
 * dependency); the column math, cutoff and keyboard model live in the pure,
 * unit-tested `./virtualization` module.
 *
 * Adoption contract:
 *   • `items.length ≤ VIRTUALIZATION_CUTOFF` OR `enabled={false}` (the
 *     'u10-browse-virtualization' runtime kill-switch) → renders a PLAIN
 *     `TileGrid` with every tile — byte-for-byte the pre-U10 path.
 *   • Above the cutoff with the flag on → windowed rows inside a bounded
 *     scroll viewport, WAI-ARIA grid semantics (`aria-rowcount`/`colcount`,
 *     roving tabindex, arrow/Home/End navigation), `minWidth:0` everywhere.
 */

import * as React from 'react';
import { makeStyles, tokens, mergeClasses } from '@fluentui/react-components';
import { useVirtualizer } from '@tanstack/react-virtual';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import {
  computeColumnCount, computeRowCount, rowSlice, shouldVirtualize,
  isRovingKey, moveRovingIndex,
} from '@/lib/components/ui/virtualization';

export interface VirtualizedGridProps<T> {
  items: readonly T[];
  /** Tile renderer — same element you would place inside `<TileGrid>`. */
  renderTile: (item: T, index: number) => React.ReactNode;
  /** Stable key per item (defaults to the index). */
  getKey?: (item: T, index: number) => string | number;
  /** Min tile width before wrapping — TileGrid's contract. Default 260. */
  minTileWidth?: number;
  /**
   * Kill-switch input (FLAG0 'u10-browse-virtualization'). `false` forces the
   * plain TileGrid path regardless of size — the pre-U10 renderer.
   */
  enabled?: boolean;
  /** Estimated row height (px) before measurement. Default 168. */
  estimateRowHeight?: number;
  /** Bounded viewport height for the windowed mode. Default '70vh'. */
  maxHeight?: string;
  ariaLabel?: string;
  className?: string;
}

/** Grid gap in px — MUST mirror TileGrid's `tokens.spacingHorizontalL` (16). */
const GRID_GAP_PX = 16;

const useStyles = makeStyles({
  viewport: {
    overflowY: 'auto',
    width: '100%',
    minWidth: 0,
    // Match TileGrid's breathing room so tiles never sit flush on an edge.
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
  },
  inner: { position: 'relative', width: '100%', minWidth: 0 },
  row: {
    display: 'grid',
    gap: tokens.spacingHorizontalL,
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    paddingBottom: tokens.spacingHorizontalL, // inter-row gap (rows are absolute)
  },
  cell: {
    minWidth: 0,
    outlineStyle: 'none',
    ':focus-visible': {
      outlineStyle: 'solid',
      outlineWidth: tokens.strokeWidthThick,
      outlineColor: tokens.colorStrokeFocus2,
      borderRadius: tokens.borderRadiusLarge,
    },
  },
});

export function VirtualizedGrid<T>(props: VirtualizedGridProps<T>): React.ReactElement {
  const {
    items, renderTile, getKey, minTileWidth = 260, enabled = true,
    estimateRowHeight = 168, maxHeight = '70vh', ariaLabel, className,
  } = props;
  const styles = useStyles();
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(0);
  const [focusIndex, setFocusIndex] = React.useState(0);
  const pendingFocus = React.useRef<number | null>(null);

  const windowed = shouldVirtualize(items.length, enabled);
  const columns = computeColumnCount(width, minTileWidth, GRID_GAP_PX);
  const rowCount = computeRowCount(items.length, columns);

  // Track the viewport width so the column count mirrors what auto-fill
  // would produce at this size (responsive parity with TileGrid).
  React.useEffect(() => {
    if (!windowed) return;
    const el = viewportRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [windowed]);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: windowed ? rowCount : 0,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => estimateRowHeight + GRID_GAP_PX,
    overscan: 4,
  });

  // After a keyboard move scrolled a not-yet-rendered row into range, land
  // focus on the target cell once it exists in the DOM.
  React.useEffect(() => {
    if (pendingFocus.current == null) return;
    const idx = pendingFocus.current;
    const el = viewportRef.current?.querySelector<HTMLElement>(`[data-vgrid-index="${idx}"]`);
    if (el) {
      pendingFocus.current = null;
      el.focus();
    }
  });

  if (!windowed) {
    // Pre-U10 path: the plain TileGrid render, identical DOM to before.
    return (
      <TileGrid minTileWidth={minTileWidth} className={className}>
        {items.map((it, i) => (
          <React.Fragment key={getKey ? getKey(it, i) : i}>{renderTile(it, i)}</React.Fragment>
        ))}
      </TileGrid>
    );
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!isRovingKey(e.key)) return;
    const target = e.target as HTMLElement | null;
    // Only steer when focus is on one of our roving cells — never hijack
    // arrow keys inside a tile's own inner controls (menus, inputs).
    if (!target?.hasAttribute('data-vgrid-index')) return;
    e.preventDefault();
    const next = moveRovingIndex(focusIndex, e.key, columns, items.length);
    if (next === focusIndex) return;
    setFocusIndex(next);
    pendingFocus.current = next;
    virtualizer.scrollToIndex(Math.floor(next / columns), { align: 'auto' });
    const el = viewportRef.current?.querySelector<HTMLElement>(`[data-vgrid-index="${next}"]`);
    if (el) {
      pendingFocus.current = null;
      el.focus();
    }
  };

  const vRows = virtualizer.getVirtualItems();

  return (
    <div
      ref={viewportRef}
      className={mergeClasses(styles.viewport, className)}
      style={{ maxHeight }}
      role="grid"
      aria-label={ariaLabel ?? 'Item grid'}
      aria-rowcount={rowCount}
      aria-colcount={columns}
      onKeyDown={onKeyDown}
    >
      <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
        {vRows.map((vRow) => {
          const { start, end } = rowSlice(items.length, columns, vRow.index);
          return (
            <div
              key={vRow.key}
              ref={virtualizer.measureElement}
              data-index={vRow.index}
              role="row"
              aria-rowindex={vRow.index + 1}
              className={styles.row}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                transform: `translateY(${vRow.start}px)`,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              }}
            >
              {items.slice(start, end).map((it, rel) => {
                const idx = start + rel;
                return (
                  <div
                    key={getKey ? getKey(it, idx) : idx}
                    role="gridcell"
                    aria-colindex={rel + 1}
                    className={styles.cell}
                    data-vgrid-index={idx}
                    tabIndex={idx === Math.min(focusIndex, items.length - 1) ? 0 : -1}
                    onFocus={() => setFocusIndex(idx)}
                  >
                    {renderTile(it, idx)}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default VirtualizedGrid;
