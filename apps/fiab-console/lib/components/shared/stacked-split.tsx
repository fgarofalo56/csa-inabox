'use client';

/**
 * StackedSplit — N resizable, individually collapsible panes in one stack
 * (#3699 Phase 2). Where SplitPane is strictly two panes, this lets a canvas
 * carry several docks (validation, run output, inspector…) that resize
 * independently without clipping each other.
 *
 * - Reflow: growing a pane takes from sibling `dock` panes first (down to
 *   their floors, proportional to size); only then from the `canvas` pane,
 *   which has its own floor. See `stacked-split-model.ts` (pure, unit-tested).
 * - Collapse: a header chevron button (separate tab stop from the divider)
 *   toggles a pane to its header strip WITHOUT touching its stored share, so
 *   expanding restores the exact prior size.
 * - Persistence: one key for the whole layout, `loom.stackedsplit.<sizingKey>`,
 *   keyed by pane id (never position).
 * - Dividers: role="separator", raw Pointer Events, keyboard per
 *   `resize-keyboard.ts`. Double-click fits the pane before the divider to
 *   its content, capped at 70% of the stack (FIT_MAX_FRACTION).
 *
 * A divider sizes the pane BEFORE it (above / left); dragging toward the
 * following pane grows it.
 */

import {
  Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactNode,
} from 'react';
import { Button, Caption1Strong, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ChevronDown20Regular, ChevronRight20Regular } from '@fluentui/react-icons';
import { resolveResizeKey } from './resize-keyboard';
import {
  STORE_PREFIX, defaultState, fitTarget, paneCollapsible, paneMin, paneRole, pxToShares,
  reflow, resolveState, serializeState, setCollapsed as setCollapsedModel,
  type ReflowItem, type ResolvedState, type StackedSplitPersistedState,
} from './stacked-split-model';

export type { StackedSplitPersistedState } from './stacked-split-model';

export interface StackedSplitPaneSpec {
  /** Stable key used in persistence — NOT positional. */
  id: string;
  /** Header + collapsed strip. */
  title: ReactNode;
  content: ReactNode;
  /** canvas = reflow source/sink of last resort. Default 'dock'. */
  role?: 'canvas' | 'dock';
  /** Floor in px (suggest 120 canvas, 80 docks; those are the defaults). */
  minHeight?: number;
  defaultFlex?: number;
  /** Default true for dock, false for canvas. */
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  headerActions?: ReactNode;
}

export interface StackedSplitProps {
  /** 'vertical' = stacked docks (primary); 'horizontal' = side by side. */
  direction?: 'vertical' | 'horizontal';
  /** N >= 2. */
  panes: StackedSplitPaneSpec[];
  /** ONE persisted key for the whole layout. */
  sizingKey: string;
  onLayoutChange?: (state: StackedSplitPersistedState) => void;
  className?: string;
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    width: '100%',
    height: '100%',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
  },
  vertical: { flexDirection: 'column' },
  horizontal: { flexDirection: 'row' },
  pane: {
    display: 'flex',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  paneV: { flexDirection: 'column' },
  paneH: { flexDirection: 'row' },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    flex: '0 0 auto',
    minWidth: 0,
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  headerCollapsedH: {
    flexDirection: 'column',
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    borderBottom: 'none',
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    height: '100%',
  },
  title: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  titleVertical: { writingMode: 'vertical-rl' },
  actions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flex: '0 0 auto' },
  body: { flex: '1 1 0%', minWidth: 0, minHeight: 0, overflow: 'auto' },
  // Natural-height wrapper: its scrollHeight is the content extent used by fit.
  inner: { minWidth: 0 },
  divider: {
    position: 'relative',
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    touchAction: 'none',
    outlineStyle: 'none',
    '::before': {
      content: '""',
      position: 'absolute',
      backgroundColor: tokens.colorNeutralStroke2,
      transitionProperty: 'background-color',
      transitionDuration: tokens.durationFaster,
      transitionTimingFunction: tokens.curveEasyEase,
      '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
    },
    ':hover::before': { backgroundColor: tokens.colorBrandStroke1 },
    ':focus-visible::before': { backgroundColor: tokens.colorBrandStroke1 },
  },
  dividerActive: { '::before': { backgroundColor: tokens.colorBrandStroke1 } },
  dividerV: {
    height: '6px',
    cursor: 'row-resize',
    alignSelf: 'stretch',
    '::before': { left: 0, right: 0, height: '1px' },
  },
  dividerH: {
    width: '6px',
    cursor: 'col-resize',
    alignSelf: 'stretch',
    '::before': { top: 0, bottom: 0, width: '1px' },
  },
  grip: {
    position: 'relative',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralStroke1,
    pointerEvents: 'none',
  },
  gripV: { height: '3px', width: '28px' },
  gripH: { width: '3px', height: '28px' },
});

interface DragSnapshot {
  index: number;
  startPos: number;
  items: ReflowItem[];
  targetId: string;
  recipientId: string;
}

export function StackedSplit({
  direction = 'vertical', panes, sizingKey, onLayoutChange, className,
}: StackedSplitProps) {
  const s = useStyles();
  const isH = direction === 'horizontal';
  const storeKey = STORE_PREFIX + sizingKey;

  const [state, setState] = useState<StackedSplitPersistedState>(() => defaultState(panes));
  const stateRef = useRef(state);
  stateRef.current = state;
  const extrasRef = useRef<ResolvedState['extras']>({ shares: {}, collapsed: {} });
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const onChangeRef = useRef(onLayoutChange);
  onChangeRef.current = onLayoutChange;

  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const drag = useRef<DragSnapshot | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const paneEls = useRef<Record<string, HTMLElement | null>>({});
  const headerEls = useRef<Record<string, HTMLDivElement | null>>({});
  const innerEls = useRef<Record<string, HTMLDivElement | null>>({});

  // Stable signature so a fresh `panes` array each render doesn't re-run effects.
  const paneSig = useMemo(
    () => panes.map((p) => `${p.id}:${p.defaultFlex ?? ''}:${p.defaultCollapsed ? 1 : 0}`).join('|'),
    [panes],
  );

  // SSR-safe: first render uses defaults; the persisted layout loads post-mount.
  useEffect(() => {
    let raw: string | null = null;
    if (typeof window !== 'undefined') {
      try { raw = window.localStorage.getItem(storeKey); } catch { /* storage disabled */ }
    }
    const resolved = resolveState(panesRef.current, raw);
    extrasRef.current = resolved.extras;
    setState(resolved.state);
  }, [storeKey, paneSig]);

  const persist = useCallback((next: StackedSplitPersistedState) => {
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(storeKey, serializeState(next, extrasRef.current)); } catch { /* storage disabled */ }
    }
    onChangeRef.current?.(next);
  }, [storeKey]);

  const extent = useCallback((el: HTMLElement | null | undefined): number =>
    !el ? 0 : isH ? el.offsetWidth : el.offsetHeight, [isH]);

  const expanded = panes.filter((p) => !state.collapsed[p.id]);

  const measureItems = useCallback((): ReflowItem[] =>
    panesRef.current
      .filter((p) => !stateRef.current.collapsed[p.id])
      .map((p) => ({ id: p.id, role: paneRole(p), min: paneMin(p), px: extent(paneEls.current[p.id]) })),
  [extent]);

  // Track rendered sizes for aria-valuenow / valuemax.
  useLayoutEffect(() => {
    const measure = () => {
      const next: Record<string, number> = {};
      for (const p of panesRef.current) next[p.id] = Math.round(extent(paneEls.current[p.id]));
      setSizes((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined' || !rootRef.current) return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(rootRef.current);
    return () => ro.disconnect();
  }, [state, paneSig, extent]);

  const applyPx = useCallback((px: Record<string, number>, commit: boolean) => {
    const cur = stateRef.current;
    const next: StackedSplitPersistedState = {
      ...cur,
      shares: { ...cur.shares, ...pxToShares(px, cur.shares) },
    };
    stateRef.current = next;
    setState(next);
    if (commit) persist(next);
  }, [persist]);

  const neighbours = (index: number): string | null => {
    for (let j = index + 1; j < panes.length; j += 1) if (!state.collapsed[panes[j].id]) return panes[j].id;
    return null;
  };

  const resizeTo = useCallback((targetId: string, recipientId: string, desired: number, commit: boolean) => {
    const items = measureItems();
    applyPx(reflow(items, targetId, desired, recipientId), commit);
  }, [measureItems, applyPx]);

  const onPointerDown = (index: number, e: React.PointerEvent<HTMLDivElement>) => {
    const recipientId = neighbours(index);
    if (!recipientId) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = {
      index, startPos: isH ? e.clientX : e.clientY, items: measureItems(),
      targetId: panes[index].id, recipientId,
    };
    setDragIndex(index);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const delta = (isH ? e.clientX : e.clientY) - d.startPos;
    const start = d.items.find((i) => i.id === d.targetId)?.px ?? 0;
    applyPx(reflow(d.items, d.targetId, start + delta, d.recipientId), false);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    drag.current = null;
    setDragIndex(null);
    persist(stateRef.current);
  };

  const onKeyDown = (index: number, e: React.KeyboardEvent<HTMLDivElement>) => {
    const recipientId = neighbours(index);
    const action = resolveResizeKey(e, direction);
    if (!recipientId || !action) return;
    e.preventDefault();
    const spec = panes[index];
    const cur = extent(paneEls.current[spec.id]);
    let desired: number;
    if (action.kind === 'delta') desired = cur + action.px;
    else desired = action.edge === 'min' ? paneMin(spec) : Number.POSITIVE_INFINITY;
    resizeTo(spec.id, recipientId, desired, true);
  };

  const onDoubleClick = (index: number) => {
    const recipientId = neighbours(index);
    if (!recipientId) return;
    const spec = panes[index];
    const inner = innerEls.current[spec.id];
    if (!inner) return;
    const content = extent(headerEls.current[spec.id]) + (isH ? inner.scrollWidth : inner.scrollHeight);
    const available = measureItems().reduce((a, i) => a + i.px, 0);
    resizeTo(spec.id, recipientId, fitTarget(content, available, paneMin(spec)), true);
  };

  const toggle = (id: string) => {
    const next = setCollapsedModel(stateRef.current, id, !stateRef.current.collapsed[id]);
    stateRef.current = next;
    setState(next);
    persist(next);
  };

  const labelOf = (p: StackedSplitPaneSpec): string => (typeof p.title === 'string' ? p.title : p.id);

  return (
    <div ref={rootRef} className={mergeClasses(s.root, isH ? s.horizontal : s.vertical, className)}>
      {panes.map((p, i) => {
        const isCollapsed = !!state.collapsed[p.id];
        const collapsible = paneCollapsible(p);
        const min = paneMin(p);
        const paneStyle: CSSProperties = isCollapsed
          ? { flex: '0 0 auto' }
          : { flex: `${state.shares[p.id] ?? 1} 1 0px`, ...(isH ? { minWidth: min } : { minHeight: min }) };
        const hasDivider = !isCollapsed && neighbours(i) !== null;
        const valueNow = sizes[p.id] ?? 0;
        const others = expanded.filter((x) => x.id !== p.id);
        const maxNow = valueNow + others.reduce((a, o) => a + Math.max(0, (sizes[o.id] ?? 0) - paneMin(o)), 0);
        const label = labelOf(p);
        return (
          <Fragment key={p.id}>
            <section
              ref={(el) => { paneEls.current[p.id] = el; }}
              className={mergeClasses(s.pane, isH ? s.paneH : s.paneV)}
              style={paneStyle}
              aria-label={label}
              data-pane-id={p.id}
              data-collapsed={isCollapsed ? 'true' : 'false'}
            >
              <div
                ref={(el) => { headerEls.current[p.id] = el; }}
                className={mergeClasses(s.header, isCollapsed && isH && s.headerCollapsedH)}
              >
                {collapsible && (
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={isCollapsed ? <ChevronRight20Regular /> : <ChevronDown20Regular />}
                    aria-expanded={!isCollapsed}
                    aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${label} panel`}
                    onClick={() => toggle(p.id)}
                  />
                )}
                <Caption1Strong className={mergeClasses(s.title, isCollapsed && isH && s.titleVertical)}>
                  {p.title}
                </Caption1Strong>
                {!isCollapsed && p.headerActions && <div className={s.actions}>{p.headerActions}</div>}
              </div>
              {!isCollapsed && (
                <div className={s.body}>
                  <div ref={(el) => { innerEls.current[p.id] = el; }} className={s.inner}>{p.content}</div>
                </div>
              )}
            </section>
            {hasDivider && (
              <div
                className={mergeClasses(s.divider, isH ? s.dividerH : s.dividerV, dragIndex === i && s.dividerActive)}
                role="separator"
                tabIndex={0}
                aria-orientation={isH ? 'vertical' : 'horizontal'}
                aria-label={`Resize ${label}`}
                aria-valuenow={valueNow}
                aria-valuemin={min}
                aria-valuemax={Math.round(maxNow)}
                onPointerDown={(e) => onPointerDown(i, e)}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={(e) => onKeyDown(i, e)}
                onDoubleClick={() => onDoubleClick(i)}
              >
                <span className={mergeClasses(s.grip, isH ? s.gripH : s.gripV)} aria-hidden />
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

export default StackedSplit;
