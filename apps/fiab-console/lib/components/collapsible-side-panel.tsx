'use client';

/**
 * CollapsibleSidePanel — shared collapse/expand chrome for right-rail side
 * panels (Copilot, properties, assist) across every Loom design surface.
 *
 * Why this exists: side Copilot panes (Pipeline Copilot, SQL Copilot, Dataflow
 * Copilot, …) take a fixed slice of horizontal real estate. The operator wants
 * every one of them collapsible to a thin vertical rail that hands that width
 * back to the canvas/editor, with the state REMEMBERED per surface.
 *
 *   expanded  → the full pane + a small "collapse" chevron (top-right).
 *   collapsed → a thin vertical rail: an expand chevron + a section icon + a
 *               vertical "Copilot" label. Clicking the rail (or its button)
 *               re-expands the pane.
 *
 * Two integration shapes are exported so both the grid-based chokepoint
 * (ItemEditorChrome.rightPanel, which must resize its own grid column) and
 * flex-based custom layouts (Dataflow, SQL) share ONE visual language:
 *
 *   - `useCollapsibleState(key)` — localStorage-backed [collapsed, setCollapsed]
 *     (SSR-safe; supports the React updater form). Use when the parent owns the
 *     layout (e.g. ItemEditorChrome sizes its grid column from the state).
 *   - `CollapsedRail` / `CollapseToggle` — the rail + chevron primitives.
 *   - `CollapsibleSidePanel` — a self-contained wrapper (uncontrolled via
 *     `storageKey`, or controlled via `collapsed`/`onCollapsedChange`).
 *
 * Loom-tokenized (no raw px/hex beyond the rail's fixed width), accessible
 * (aria-expanded, focusable button, Enter/Space on the rail), and the width
 * transition is gated behind prefers-reduced-motion.
 */

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Button, Caption1, Tooltip, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import {
  PanelRightContract20Regular, PanelRightExpand20Regular,
  PanelLeftContract20Regular, PanelLeftExpand20Regular,
  Sparkle20Regular,
} from '@fluentui/react-icons';

/** Fixed width of the collapsed rail. Layout dimension (no spacing token fits). */
export const RAIL_WIDTH = '44px';

const STORE_PREFIX = 'loom.sidepanel.';

const useStyles = makeStyles({
  panel: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    height: '100%',
  },
  body: { flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' },
  toggle: { position: 'absolute', top: tokens.spacingVerticalXS, right: tokens.spacingHorizontalXS, zIndex: 2 },
  rail: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: tokens.spacingVerticalS,
    width: RAIL_WIDTH,
    minWidth: RAIL_WIDTH,
    height: '100%',
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationFaster,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
    '@media screen and (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  railLabel: {
    writingMode: 'vertical-rl',
    transform: 'rotate(180deg)',
    color: tokens.colorNeutralForeground2,
    letterSpacing: '0.06em',
    userSelect: 'none',
    whiteSpace: 'nowrap',
  },
  railIcon: { display: 'flex', color: tokens.colorBrandForeground1 },
});

/**
 * localStorage-backed collapse state. SSR-safe: the server (and first client
 * render) use `defaultCollapsed`, then a post-mount effect reconciles to the
 * persisted value — so there is no hydration mismatch. The setter accepts the
 * React updater form and persists the resolved value.
 */
export function useCollapsibleState(
  storageKey: string | undefined,
  defaultCollapsed = false,
): [boolean, (c: boolean | ((prev: boolean) => boolean)) => void] {
  const [collapsed, setCollapsedState] = useState(defaultCollapsed);

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return;
    try {
      const v = window.localStorage.getItem(STORE_PREFIX + storageKey);
      if (v === '1') setCollapsedState(true);
      else if (v === '0') setCollapsedState(false);
    } catch { /* private mode / disabled storage — fall back to in-session state */ }
  }, [storageKey]);

  const setCollapsed = useCallback((c: boolean | ((prev: boolean) => boolean)) => {
    setCollapsedState((prev) => {
      const next = typeof c === 'function' ? (c as (p: boolean) => boolean)(prev) : c;
      if (storageKey && typeof window !== 'undefined') {
        try { window.localStorage.setItem(STORE_PREFIX + storageKey, next ? '1' : '0'); } catch { /* ignore */ }
      }
      return next;
    });
  }, [storageKey]);

  return [collapsed, setCollapsed];
}

/** The thin collapsed rail — expand chevron + section icon + vertical label. */
export function CollapsedRail({
  onExpand, label = 'Copilot', icon, side = 'right', className,
}: {
  onExpand: () => void;
  label?: string;
  icon?: ReactNode;
  side?: 'left' | 'right';
  className?: string;
}) {
  const s = useStyles();
  const ExpandIcon = side === 'right' ? PanelRightExpand20Regular : PanelLeftExpand20Regular;
  return (
    <div
      className={mergeClasses(s.rail, className)}
      role="button"
      tabIndex={0}
      aria-expanded={false}
      aria-label={`Expand ${label} panel`}
      onClick={onExpand}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onExpand(); } }}
    >
      <Tooltip content={`Expand ${label} panel`} relationship="label">
        <Button
          appearance="subtle"
          size="small"
          icon={<ExpandIcon />}
          aria-label={`Expand ${label} panel`}
          onClick={(e) => { e.stopPropagation(); onExpand(); }}
        />
      </Tooltip>
      <span className={s.railIcon} aria-hidden>{icon ?? <Sparkle20Regular />}</span>
      <Caption1 className={s.railLabel} aria-hidden>{label}</Caption1>
    </div>
  );
}

/** The small "collapse" chevron shown over an expanded pane. */
export function CollapseToggle({
  onCollapse, label = 'Copilot', side = 'right', className, style,
}: {
  onCollapse: () => void;
  label?: string;
  side?: 'left' | 'right';
  className?: string;
  style?: CSSProperties;
}) {
  const ContractIcon = side === 'right' ? PanelRightContract20Regular : PanelLeftContract20Regular;
  return (
    <Tooltip content={`Collapse ${label} panel`} relationship="label">
      <Button
        className={className}
        style={style}
        appearance="subtle"
        size="small"
        icon={<ContractIcon />}
        aria-expanded
        aria-label={`Collapse ${label} panel`}
        onClick={onCollapse}
      />
    </Tooltip>
  );
}

/**
 * Self-contained collapsible side panel for flex layouts. Uncontrolled by
 * default (persists via `storageKey`); pass `collapsed` + `onCollapsedChange`
 * to control it from a parent.
 */
export function CollapsibleSidePanel({
  children, storageKey, label = 'Copilot', icon, side = 'right',
  defaultCollapsed = false, collapsed: collapsedProp, onCollapsedChange, className,
}: {
  children: ReactNode;
  storageKey?: string;
  label?: string;
  icon?: ReactNode;
  side?: 'left' | 'right';
  defaultCollapsed?: boolean;
  collapsed?: boolean;
  onCollapsedChange?: (c: boolean) => void;
  className?: string;
}) {
  const s = useStyles();
  const [internalCollapsed, setInternalCollapsed] = useCollapsibleState(storageKey, defaultCollapsed);
  const isControlled = collapsedProp !== undefined;
  const collapsed = isControlled ? collapsedProp : internalCollapsed;

  const setCollapsed = useCallback((c: boolean) => {
    if (!isControlled) setInternalCollapsed(c);
    onCollapsedChange?.(c);
  }, [isControlled, setInternalCollapsed, onCollapsedChange]);

  if (collapsed) {
    return <CollapsedRail onExpand={() => setCollapsed(false)} label={label} icon={icon} side={side} className={className} />;
  }
  return (
    <div className={mergeClasses(s.panel, className)}>
      <CollapseToggle className={s.toggle} onCollapse={() => setCollapsed(true)} label={label} side={side} />
      <div className={s.body}>{children}</div>
    </div>
  );
}
