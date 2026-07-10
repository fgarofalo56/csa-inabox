'use client';

/**
 * SplitPane — shared resizable two-pane split container (R1).
 *
 * Why this exists: across Loom's editors the operator can toggle a side pane
 * (Factory Resources, Copilot) between "shown" and "collapsed to a rail", but
 * cannot ADJUST its width — unlike ADF Studio and Fabric, whose panes carry a
 * draggable splitter. This primitive gives every surface that Fabric-grade
 * draggable divider: a mouse/touch-draggable, keyboard-accessible separator
 * that resizes one pane, persists the chosen size per `storageKey`, and still
 * honors an external `collapsed` signal so existing minimize buttons keep
 * working unchanged.
 *
 * The divider sizes the PRIMARY pane (`primary`, default 'first'); the other
 * pane flexes to fill. Sizes are stored as px under
 * `loom.splitpane.<storageKey>` and restored on mount. A `%`/`px` string
 * `defaultSize` is resolved against the live container on mount.
 *
 * Tokenized (Fluent v9 + Loom tokens), SSR-safe (window/localStorage guarded),
 * and accessible (role="separator", arrow/Home/End resize, double-click reset).
 */

import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type ReactNode,
} from 'react';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';

const STORE_PREFIX = 'loom.splitpane.';
/** Fallback primary size when no default is resolvable (px). */
const FALLBACK_SIZE = 260;
/** Minimum a pane may shrink to when the caller gives no `minSize` (px). */
const DEFAULT_MIN = 120;
/** Room always reserved for the OTHER (flexing) pane when clamping (px). */
const OPPOSITE_MIN = 80;
/** Keyboard resize step per Arrow press (px). */
const KEY_STEP = 24;
/** Large step for PageUp/PageDown (px). */
const KEY_PAGE = 96;

type Direction = 'horizontal' | 'vertical';

export interface SplitPaneProps {
  /** 'horizontal' → panes side-by-side (vertical divider). 'vertical' → stacked. */
  direction: Direction;
  /** Exactly two children: [primary-or-first, secondary-or-second]. */
  children: [ReactNode, ReactNode];
  /** Initial primary-pane size. Number = px; string = '30%' or '240px'. */
  defaultSize?: number | string;
  /** Smallest the primary pane may be dragged (px). */
  minSize?: number;
  /** Largest the primary pane may be dragged (px). */
  maxSize?: number;
  /** Which pane the divider sizes. 'second' drags from the trailing edge. */
  primary?: 'first' | 'second';
  /** Persist the size to localStorage under `loom.splitpane.<storageKey>`. */
  storageKey?: string;
  /**
   * External collapse. When true the primary pane collapses (to `collapsedSize`
   * if given, else to its content width) and the divider is hidden — so the
   * caller's own minimize button + collapsed rail keep working. The stored size
   * is preserved and restored on expand.
   */
  collapsed?: boolean;
  /** Primary-pane size while collapsed (px). Omit to size the collapsed child to its content. */
  collapsedSize?: number;
  /** Fired (on drag end / keyboard / reset) with the committed primary size in px. */
  onSizeChange?: (size: number) => void;
  className?: string;
  /** Accessible label for the divider separator. */
  dividerLabel?: string;
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    width: '100%',
    height: '100%',
    minWidth: 0,
    minHeight: 0,
  },
  horizontal: { flexDirection: 'row' },
  vertical: { flexDirection: 'column' },
  pane: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    // The pane's single child (a docked card / tree / nested SplitPane) fills
    // the pane on both axes so height-bounded surfaces keep their sizing.
    '> *': { flexGrow: 1, flexShrink: 1, flexBasis: '0%', minWidth: 0, minHeight: 0 },
  },
  // The flexing (non-primary) pane fills the remaining space.
  fill: { flex: '1 1 0%' },
  // 6px hit area with a 1px visible line; brand highlight on hover/active/focus.
  divider: {
    position: 'relative',
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    touchAction: 'none',
    outlineStyle: 'none',
    // The visible hairline, centered in the hit area.
    '::before': {
      content: '""',
      position: 'absolute',
      backgroundColor: tokens.colorNeutralStroke2,
      transitionProperty: 'background-color',
      transitionDuration: tokens.durationFaster,
      transitionTimingFunction: tokens.curveEasyEase,
      '@media screen and (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
    },
    ':hover::before': { backgroundColor: tokens.colorBrandStroke1 },
    ':focus-visible::before': { backgroundColor: tokens.colorBrandStroke1 },
  },
  dividerActive: { '::before': { backgroundColor: tokens.colorBrandStroke1 } },
  dividerH: {
    width: '6px',
    cursor: 'col-resize',
    alignSelf: 'stretch',
    '::before': { top: 0, bottom: 0, width: '1px' },
  },
  dividerV: {
    height: '6px',
    cursor: 'row-resize',
    alignSelf: 'stretch',
    '::before': { left: 0, right: 0, height: '1px' },
  },
  // Small grip glyph so the divider reads as draggable (Fabric affordance).
  grip: {
    position: 'relative',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralStroke1,
    pointerEvents: 'none',
  },
  gripH: { width: '3px', height: '28px' },
  gripV: { height: '3px', width: '28px' },
});

function resolveDefaultSize(defaultSize: number | string | undefined, totalPx: number): number {
  if (typeof defaultSize === 'number') return defaultSize;
  if (typeof defaultSize === 'string') {
    const t = defaultSize.trim();
    if (t.endsWith('%')) {
      const pct = parseFloat(t);
      if (!Number.isNaN(pct) && totalPx > 0) return (pct / 100) * totalPx;
    }
    const px = parseFloat(t);
    if (!Number.isNaN(px)) return px;
  }
  return FALLBACK_SIZE;
}

export function SplitPane({
  direction, children, defaultSize, minSize, maxSize, primary = 'first',
  storageKey, collapsed = false, collapsedSize, onSizeChange, className, dividerLabel,
}: SplitPaneProps) {
  const s = useStyles();
  const isH = direction === 'horizontal';
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<number>(() => (typeof defaultSize === 'number' ? defaultSize : FALLBACK_SIZE));
  const [dragging, setDragging] = useState(false);
  // Drag anchor: pointer coordinate + primary size captured at pointer-down.
  const dragStart = useRef<{ pos: number; size: number }>({ pos: 0, size: 0 });

  const containerExtent = useCallback((): number => {
    const el = containerRef.current;
    if (!el) return 0;
    return isH ? el.clientWidth : el.clientHeight;
  }, [isH]);

  const clamp = useCallback((raw: number): number => {
    const total = containerExtent();
    const min = minSize ?? DEFAULT_MIN;
    let max = maxSize ?? Number.POSITIVE_INFINITY;
    if (total > 0) max = Math.min(max, total - OPPOSITE_MIN);
    if (max < min) max = min;
    return Math.max(min, Math.min(raw, max));
  }, [containerExtent, minSize, maxSize]);

  const commit = useCallback((next: number) => {
    const clamped = clamp(next);
    setSize(clamped);
    if (storageKey && typeof window !== 'undefined') {
      try { window.localStorage.setItem(STORE_PREFIX + storageKey, String(Math.round(clamped))); } catch { /* storage disabled */ }
    }
    onSizeChange?.(clamped);
    return clamped;
  }, [clamp, storageKey, onSizeChange]);

  // Resolve the initial size once the container is measurable: persisted value
  // wins, else the (possibly %) default. Runs after layout so the container has
  // real dimensions; SSR renders the numeric fallback with no hydration jump.
  useLayoutEffect(() => {
    let initial: number | null = null;
    if (storageKey && typeof window !== 'undefined') {
      try {
        const v = window.localStorage.getItem(STORE_PREFIX + storageKey);
        if (v != null && v !== '' && !Number.isNaN(Number(v))) initial = Number(v);
      } catch { /* storage disabled */ }
    }
    if (initial == null) initial = resolveDefaultSize(defaultSize, containerExtent());
    setSize(clamp(initial));
    // Intentionally run only on mount / storageKey change — later prop changes
    // shouldn't stomp a size the user has dragged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // Keep the size within bounds when the container is resized (window resize).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setSize((prev) => clamp(prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  const deltaSign = primary === 'first' ? 1 : -1;

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (collapsed) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragStart.current = { pos: isH ? e.clientX : e.clientY, size };
    setDragging(true);
  }, [collapsed, isH, size]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const cur = isH ? e.clientX : e.clientY;
    const delta = (cur - dragStart.current.pos) * deltaSign;
    setSize(clamp(dragStart.current.size + delta));
  }, [dragging, isH, deltaSign, clamp]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    setDragging(false);
    commit(size);
  }, [dragging, size, commit]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (collapsed) return;
    // Forward = grow the coordinate (right / down); map to primary via deltaSign.
    const forward = isH ? 'ArrowRight' : 'ArrowDown';
    const backward = isH ? 'ArrowLeft' : 'ArrowUp';
    let next: number | null = null;
    if (e.key === forward) next = size + KEY_STEP * deltaSign;
    else if (e.key === backward) next = size - KEY_STEP * deltaSign;
    else if (e.key === 'PageUp') next = size + KEY_PAGE * deltaSign;
    else if (e.key === 'PageDown') next = size - KEY_PAGE * deltaSign;
    else if (e.key === 'Home') next = minSize ?? DEFAULT_MIN;
    else if (e.key === 'End') next = clamp(Number.POSITIVE_INFINITY);
    if (next == null) return;
    e.preventDefault();
    commit(next);
  }, [collapsed, isH, size, deltaSign, minSize, clamp, commit]);

  const resetToDefault = useCallback(() => {
    commit(resolveDefaultSize(defaultSize, containerExtent()));
  }, [commit, defaultSize, containerExtent]);

  // Primary-pane flex basis: collapsed → content (or collapsedSize); else the
  // resolved px. `flexBasis`/`width` are layout props, not spacing — not tokened.
  const basis = collapsed
    ? (collapsedSize != null ? `${collapsedSize}px` : 'auto')
    : `${Math.round(size)}px`;
  const primaryStyle: CSSProperties = { flex: `0 0 ${basis}` };

  const [first, second] = children;
  const primaryChild = primary === 'first' ? first : second;
  const flexChild = primary === 'first' ? second : first;

  const primaryPane = <div className={s.pane} style={primaryStyle}>{primaryChild}</div>;
  const flexPane = <div className={mergeClasses(s.pane, s.fill)}>{flexChild}</div>;

  const divider = collapsed ? null : (
    <div
      className={mergeClasses(s.divider, isH ? s.dividerH : s.dividerV, dragging && s.dividerActive)}
      role="separator"
      tabIndex={0}
      aria-orientation={isH ? 'vertical' : 'horizontal'}
      aria-label={dividerLabel ?? 'Resize panel'}
      aria-valuenow={Math.round(size)}
      aria-valuemin={minSize ?? DEFAULT_MIN}
      aria-valuemax={maxSize ?? undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={resetToDefault}
    >
      <span className={mergeClasses(s.grip, isH ? s.gripH : s.gripV)} aria-hidden />
    </div>
  );

  // Lay panes + divider in visual order (primary keeps its first/second side).
  const ordered = primary === 'first'
    ? <>{primaryPane}{divider}{flexPane}</>
    : <>{flexPane}{divider}{primaryPane}</>;

  return (
    <div ref={containerRef} className={mergeClasses(s.root, isH ? s.horizontal : s.vertical, className)}>
      {ordered}
    </div>
  );
}

export default SplitPane;
