'use client';

/**
 * DockedInspector — the shared bottom-docked (or right-rail) tabbed inspector
 * shell, generalized from `lib/components/pipeline/properties-panel.tsx` (the
 * A-grade reference implementation, per PRP-ux-baseline-program §3, SC-3).
 *
 * It owns the Fabric "docked bottom inspector" contract (fabric-ux-observations
 * §4) so every editor gets it identically:
 *   • an accent-gradient header (icon chip + title + meta badges + Learn-more)
 *     that reads as the same object the user selected on the canvas;
 *   • a horizontal tab strip where each tab carries a RED SUPERSCRIPT
 *     VALIDATION DOT when its required config is missing — errors visible
 *     PRE-RUN, exactly like Fabric's pipeline General/Source/… tabs;
 *   • a scrollable body that renders the active tab's content;
 *   • a collapse toggle (dock layout) to reclaim canvas;
 *   • an EmptyState slot for the no-selection pane.
 *
 * Required-field asterisks come from Fluent `<Field required>` inside each tab's
 * content; per-field Learn-more slots are the caller's to render — this shell
 * provides the header-level Learn-more and the tab-level validation contract.
 *
 * Layout state (which tab is active) is CONTROLLED by the caller so each editor
 * keeps its own tab-reset semantics. Every colour / space / radius / shadow is a
 * Fluent v9 `tokens.*` value or a `--loom-accent-*` var via accent-tokens — no
 * raw px, no raw hex, no hardcoded shadow. This file has no default export.
 */

import type { ReactNode } from 'react';
import {
  Tab, TabList, Subtitle2, Button, Link, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Open16Regular, ChevronDown16Regular, ChevronUp16Regular, Cursor20Regular,
} from '@fluentui/react-icons';
import { accentTint, accentGradient } from './accent-tokens';
import { EmptyState } from '@/lib/components/empty-state';

const useStyles = makeStyles({
  // Right-rail layout (legacy callers).
  root: {
    display: 'flex', flexDirection: 'column',
    width: '380px', minWidth: '320px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    overflow: 'hidden',
  },
  // Bottom-dock layout (ADF Studio / Fabric parity) — full width, fills the
  // resizable dock; the body scrolls internally so expand/collapse never grows
  // the dock or resizes the canvas above it.
  dockRoot: {
    display: 'flex', flexDirection: 'column',
    width: '100%', height: '100%', minHeight: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    overflow: 'hidden',
  },
  // Accent-gradient header (category-tinted; matches the canvas node header).
  header: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    paddingTop: tokens.spacingVerticalM, paddingBottom: tokens.spacingVerticalM,
    paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  headerTop: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0,
  },
  iconChip: {
    flexShrink: 0,
    width: '32px', height: '32px',
    borderRadius: tokens.borderRadiusMedium,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  headerTitleCol: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  headerMeta: {
    display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap',
  },
  learnRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  collapseBtn: { flexShrink: 0, marginLeft: 'auto' },
  // Tab strip — subtle background lane so it reads as a distinct band.
  tabStrip: {
    paddingLeft: tokens.spacingHorizontalS, paddingRight: tokens.spacingHorizontalS,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  // Tab label wrapper so the red validation dot can superscript it (Fabric parity).
  tabLabel: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
  tabDot: {
    position: 'absolute',
    top: '-3px', right: '-9px',
    minWidth: '8px', height: '8px',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorPaletteRedBackground3,
    border: `1px solid ${tokens.colorNeutralBackground1}`,
  },
  body: {
    paddingTop: tokens.spacingVerticalL, paddingBottom: tokens.spacingVerticalL,
    paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL,
    overflowY: 'auto', display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalM, flex: 1,
  },
});

/** One inspector tab. `content` is rendered only when the tab is active. */
export interface DockedInspectorTab {
  /** Stable id used for selection + the validation-dot aria hook. */
  id: string;
  /** Visible tab label. */
  label: ReactNode;
  /** Rendered in the scrollable body when this tab is the active tab. */
  content: ReactNode;
  /**
   * True → the tab carries a red superscript validation dot (required config
   * missing, visible pre-run). Fabric parity.
   */
  hasValidationIssue?: boolean;
  /** Count of unmet required fields — feeds the dot's accessible label. */
  issueCount?: number;
  /** Disable this tab (rendered but not selectable). */
  disabled?: boolean;
}

export interface DockedInspectorProps {
  /** 'rail' = right-side panel (legacy); 'dock' = bottom dock (Fabric parity). */
  layout?: 'rail' | 'dock';
  /** Header title (e.g. the selected object's name). */
  title: ReactNode;
  /** Icon chip glyph (accent-tinted). */
  icon?: ReactNode;
  /** Accent CSS var (e.g. LOOM_ACCENT.blue). Defaults to the brand stroke. */
  accent?: string;
  /** Meta-row slot under the title (type Badge, state chips, …). */
  badges?: ReactNode;
  /** Header Learn-more link target. Omit to hide the link. */
  learnMoreHref?: string;
  /** Learn-more label (default "Learn more"). */
  learnMoreLabel?: string;
  /** Slot below the header top row — infra-gate / warning MessageBars, etc. */
  headerExtra?: ReactNode;
  /** The tabs. Empty → the emptyState (or a default no-selection pane) shows. */
  tabs: DockedInspectorTab[];
  /** Controlled active tab id. */
  selectedTab: string;
  /** Fires with the newly-selected tab id. */
  onSelectTab: (id: string) => void;
  /** dock only — show the collapse toggle (default true in dock layout). */
  collapsible?: boolean;
  /** Rendered instead of tabs when `tabs` is empty (defaults to a no-selection EmptyState). */
  emptyState?: ReactNode;
  /** Controlled collapse (dock). Omit for internal uncontrolled behaviour is NOT supported — pass both. */
  collapsed?: boolean;
  /** Fires when the collapse toggle is clicked (dock). */
  onToggleCollapse?: () => void;
  /** Extra data-* / aria-* attributes merged onto the root (e.g. a UAT hook). */
  rootProps?: React.HTMLAttributes<HTMLDivElement>;
}

/**
 * DockedInspector. Fully controlled: pass `selectedTab` + `onSelectTab`, and for
 * a collapsible dock pass `collapsed` + `onToggleCollapse`.
 */
export function DockedInspector({
  layout = 'dock',
  title,
  icon,
  accent = tokens.colorBrandStroke1,
  badges,
  learnMoreHref,
  learnMoreLabel = 'Learn more',
  headerExtra,
  tabs,
  selectedTab,
  onSelectTab,
  collapsible,
  emptyState,
  collapsed = false,
  onToggleCollapse,
  rootProps,
}: DockedInspectorProps) {
  const s = useStyles();
  const rootClass = layout === 'dock' ? s.dockRoot : s.root;
  const showCollapse = layout === 'dock' && (collapsible ?? true) && !!onToggleCollapse;

  if (tabs.length === 0) {
    return (
      <div className={rootClass} {...rootProps}>
        {emptyState ?? (
          <EmptyState
            icon={<Cursor20Regular />}
            title="Nothing selected"
            body="Select an item to edit its properties — its tabs will appear here."
          />
        )}
      </div>
    );
  }

  const active = tabs.find((t) => t.id === selectedTab) ?? tabs[0];

  return (
    <div className={rootClass} {...rootProps}>
      <div className={s.header} style={{ background: accentGradient(accent) }}>
        <div className={s.headerTop}>
          {icon != null && (
            <span
              className={s.iconChip}
              style={{ background: accentTint(accent, 16), color: accent, border: `1px solid ${accentTint(accent, 28)}` }}
              aria-hidden="true"
            >
              {icon}
            </span>
          )}
          <div className={s.headerTitleCol}>
            <Subtitle2>{title}</Subtitle2>
            {(badges != null || learnMoreHref) && (
              <div className={s.headerMeta}>
                {badges}
                {learnMoreHref && (
                  <Link className={s.learnRow} href={learnMoreHref} target="_blank" rel="noopener noreferrer">
                    {learnMoreLabel} <Open16Regular />
                  </Link>
                )}
              </div>
            )}
          </div>
          {showCollapse && (
            <Tooltip content={collapsed ? 'Expand properties' : 'Collapse properties'} relationship="label">
              <Button
                className={s.collapseBtn}
                appearance="subtle"
                size="small"
                aria-label={collapsed ? 'Expand properties panel' : 'Collapse properties panel'}
                aria-expanded={!collapsed}
                icon={collapsed ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
                onClick={onToggleCollapse}
              />
            </Tooltip>
          )}
        </div>
        {headerExtra}
      </div>

      {!(layout === 'dock' && collapsed) && (
        <>
          <TabList
            selectedValue={active.id}
            onTabSelect={(_, d) => onSelectTab(d.value as string)}
            size="small"
            className={s.tabStrip}
          >
            {tabs.map((t) => (
              <Tab key={t.id} value={t.id} disabled={t.disabled}>
                <span className={s.tabLabel}>
                  {t.label}
                  {t.hasValidationIssue && (
                    <span
                      className={s.tabDot}
                      aria-label={t.issueCount
                        ? `${t.issueCount} required field${t.issueCount === 1 ? '' : 's'} to complete`
                        : 'has required fields to complete'}
                    />
                  )}
                </span>
              </Tab>
            ))}
          </TabList>

          <div className={s.body}>{active.content}</div>
        </>
      )}
    </div>
  );
}
