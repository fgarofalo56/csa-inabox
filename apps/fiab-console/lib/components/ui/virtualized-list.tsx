'use client';

/**
 * VirtualizedList — windowed vertical list primitive (U10), the single-column
 * sibling of `VirtualizedGrid` for unbounded row collections (feeds, logs,
 * row-virtualized previews). Same adoption contract: at or below
 * `VIRTUALIZATION_CUTOFF` — or with the 'u10-browse-virtualization'
 * kill-switch OFF — every row renders plainly (the pre-U10 path); above it,
 * only the rows near the viewport are materialized via
 * `@tanstack/react-virtual`. WAI-ARIA listbox-style keyboard model: one tab
 * stop, Up/Down/Home/End move the active row (pure, unit-tested math in
 * `./virtualization`).
 */

import * as React from 'react';
import { makeStyles, tokens, mergeClasses } from '@fluentui/react-components';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  shouldVirtualize, isRovingKey, moveRovingIndex,
} from '@/lib/components/ui/virtualization';

export interface VirtualizedListProps<T> {
  items: readonly T[];
  /** Row renderer — the element rendered for each item. */
  renderRow: (item: T, index: number) => React.ReactNode;
  /** Stable key per item (defaults to the index). */
  getKey?: (item: T, index: number) => string | number;
  /** Kill-switch input (FLAG0). `false` forces the plain full render. */
  enabled?: boolean;
  /** Estimated row height (px) before measurement. Default 44. */
  estimateRowHeight?: number;
  /** Bounded viewport height for the windowed mode. Default '60vh'. */
  maxHeight?: string;
  ariaLabel?: string;
  className?: string;
}

const useStyles = makeStyles({
  plain: { display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0 },
  viewport: { overflowY: 'auto', width: '100%', minWidth: 0 },
  inner: { position: 'relative', width: '100%', minWidth: 0 },
  row: {
    minWidth: 0,
    width: '100%',
    boxSizing: 'border-box',
    outlineStyle: 'none',
    ':focus-visible': {
      outlineStyle: 'solid',
      outlineWidth: tokens.strokeWidthThick,
      outlineColor: tokens.colorStrokeFocus2,
      borderRadius: tokens.borderRadiusMedium,
    },
  },
});

export function VirtualizedList<T>(props: VirtualizedListProps<T>): React.ReactElement {
  const {
    items, renderRow, getKey, enabled = true,
    estimateRowHeight = 44, maxHeight = '60vh', ariaLabel, className,
  } = props;
  const styles = useStyles();
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const [focusIndex, setFocusIndex] = React.useState(0);
  const pendingFocus = React.useRef<number | null>(null);

  const windowed = shouldVirtualize(items.length, enabled);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: windowed ? items.length : 0,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => estimateRowHeight,
    overscan: 10,
  });

  React.useEffect(() => {
    if (pendingFocus.current == null) return;
    const idx = pendingFocus.current;
    const el = viewportRef.current?.querySelector<HTMLElement>(`[data-vlist-index="${idx}"]`);
    if (el) {
      pendingFocus.current = null;
      el.focus();
    }
  });

  if (!windowed) {
    return (
      <div className={mergeClasses(styles.plain, className)} role="list" aria-label={ariaLabel}>
        {items.map((it, i) => (
          <div role="listitem" key={getKey ? getKey(it, i) : i} style={{ minWidth: 0 }}>
            {renderRow(it, i)}
          </div>
        ))}
      </div>
    );
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!isRovingKey(e.key)) return;
    const target = e.target as HTMLElement | null;
    if (!target?.hasAttribute('data-vlist-index')) return;
    e.preventDefault();
    const next = moveRovingIndex(focusIndex, e.key, 1, items.length);
    if (next === focusIndex) return;
    setFocusIndex(next);
    pendingFocus.current = next;
    virtualizer.scrollToIndex(next, { align: 'auto' });
    const el = viewportRef.current?.querySelector<HTMLElement>(`[data-vlist-index="${next}"]`);
    if (el) {
      pendingFocus.current = null;
      el.focus();
    }
  };

  return (
    <div
      ref={viewportRef}
      className={mergeClasses(styles.viewport, className)}
      style={{ maxHeight }}
      role="grid"
      aria-label={ariaLabel ?? 'Item list'}
      aria-rowcount={items.length}
      aria-colcount={1}
      onKeyDown={onKeyDown}
    >
      <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vRow) => {
          const it = items[vRow.index];
          return (
            <div
              key={getKey ? getKey(it, vRow.index) : vRow.key}
              ref={virtualizer.measureElement}
              data-index={vRow.index}
              data-vlist-index={vRow.index}
              role="row"
              aria-rowindex={vRow.index + 1}
              className={styles.row}
              tabIndex={vRow.index === Math.min(focusIndex, items.length - 1) ? 0 : -1}
              onFocus={() => setFocusIndex(vRow.index)}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                transform: `translateY(${vRow.start}px)`,
              }}
            >
              {renderRow(it, vRow.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default VirtualizedList;
