'use client';

/**
 * Ribbon — reusable Fabric-style ribbon. Tab strip on top, action
 * groups (label + button row) below. Used by every item editor.
 * Mirrors the Fabric "Home" + per-item additional toolbars described
 * in docs/fiab/fabric-feature-inventory.md §3.
 */

import { useState, useEffect, type ReactElement } from 'react';
import {
  Tab,
  TabList,
  Button,
  Divider,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Tooltip,
  makeStyles,
  tokens,
  type ButtonProps,
} from '@fluentui/react-components';
import { ChevronDown16Regular, ChevronUp16Regular } from '@fluentui/react-icons';

/** Persisted per-user ribbon density. Shared across every editor so the choice
 *  ("give me more canvas") sticks wherever you go. */
const RIBBON_COLLAPSE_KEY = 'loom.ribbon.collapsed';

const useStyles = makeStyles({
  root: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    overflow: 'hidden',
    boxShadow: tokens.shadow2,
  },
  // Header row holds the tab strip (left, grows) + the collapse toggle (right).
  header: {
    display: 'flex',
    alignItems: 'center',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    paddingRight: '4px',
  },
  tabs: {
    flex: 1,
    minWidth: 0,
    paddingLeft: '8px',
  },
  collapseBtn: { flexShrink: 0 },
  body: {
    display: 'flex',
    alignItems: 'stretch',
    flexWrap: 'wrap',
    padding: '10px 12px',
    columnGap: '4px',
    rowGap: '8px',
    minHeight: '60px',
  },
  group: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '4px',
    padding: '0 10px',
  },
  groupRow: { display: 'flex', alignItems: 'center', gap: '2px', flex: 1 },
  groupLabel: {
    fontSize: '10px',
    lineHeight: '12px',
    letterSpacing: '0.04em',
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    fontWeight: tokens.fontWeightSemibold,
  },
});

export interface RibbonDropdownItem {
  label: string;
  /** Real navigation / action handler. When omitted AND not disabled the
   *  item renders disabled with a "not wired" tooltip (honest, per
   *  no-vaporware.md). */
  onClick?: () => void;
  disabled?: boolean;
  /** Optional tooltip — used to explain why an item is grayed out. */
  title?: string;
  icon?: ReactElement;
}

export interface RibbonAction {
  label: string;
  /** Real action handler. When omitted AND not disabled, the button renders
   *  disabled with a "not wired" tooltip (honest, per no-vaporware.md). */
  onClick?: () => void;
  disabled?: boolean;
  /** Leading Fluent icon. */
  icon?: ReactElement;
  /** Optional tooltip — e.g. explains why an action is grayed out. */
  title?: string;
  appearance?: ButtonProps['appearance'];
  iconPosition?: 'before' | 'after';
  /** When present, the button renders as a split-style dropdown: a chevron
   *  opens a Fluent Menu of `dropdownItems` (mirrors Fabric's "Get data ▼" /
   *  "Analyze data ▼" ribbon menus). Backward-compatible — actions that only
   *  set label/onClick/disabled render as before. */
  dropdownItems?: RibbonDropdownItem[];
}

export interface RibbonGroup {
  label: string;
  actions: RibbonAction[];
}

export interface RibbonTab {
  id: string;
  label: string;
  groups: RibbonGroup[];
}

interface Props {
  tabs: RibbonTab[];
  defaultTabId?: string;
}

export function Ribbon({ tabs, defaultTabId }: Props) {
  const styles = useStyles();
  const [active, setActive] = useState(defaultTabId ?? tabs[0]?.id ?? '');
  // Collapsed = show only the tab strip, hiding the action body → reclaims
  // ~60px of vertical canvas/editor real estate. Persisted per-user across all
  // editors. Clicking a tab while collapsed re-expands (Office-ribbon behavior).
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(RIBBON_COLLAPSE_KEY) === '1'); } catch { /* SSR / no storage */ }
  }, []);
  const setCollapsedPersisted = (v: boolean) => {
    setCollapsed(v);
    try { localStorage.setItem(RIBBON_COLLAPSE_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  };
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <TabList
          className={styles.tabs}
          selectedValue={active}
          onTabSelect={(_, d) => { setActive(d.value as string); if (collapsed) setCollapsedPersisted(false); }}
          size="small"
        >
          {tabs.map((t) => (
            <Tab key={t.id} value={t.id}>{t.label}</Tab>
          ))}
        </TabList>
        <Tooltip
          relationship="label"
          content={collapsed ? 'Expand the ribbon' : 'Collapse the ribbon for more space'}
        >
          <Button
            className={styles.collapseBtn}
            appearance="subtle"
            size="small"
            aria-label={collapsed ? 'Expand ribbon' : 'Collapse ribbon'}
            aria-expanded={!collapsed}
            icon={collapsed ? <ChevronDown16Regular /> : <ChevronUp16Regular />}
            onClick={() => setCollapsedPersisted(!collapsed)}
          />
        </Tooltip>
      </div>
      {!collapsed && (
      <div className={styles.body}>
        {current?.groups.map((g, gi) => (
          <div key={gi} style={{ display: 'flex', alignItems: 'stretch' }}>
            <div className={styles.group}>
              <div className={styles.groupRow}>
                {g.actions.map((a, ai) => {
                  const { label, onClick, disabled, dropdownItems, ...rest } = a;
                  // Dropdown action: chevron opens a Fluent Menu. Each menu
                  // item must navigate to a real surface (no toasts / dead
                  // entries). Items with neither onClick nor disabled render
                  // disabled + "not wired" tooltip so the menu is honest.
                  if (dropdownItems?.length) {
                    return (
                      <Menu key={ai}>
                        <MenuTrigger disableButtonEnhancement>
                          <Button
                            appearance="subtle"
                            size="small"
                            disabled={disabled}
                            title={disabled ? (rest.title as string | undefined) : undefined}
                            icon={<ChevronDown16Regular />}
                            iconPosition="after"
                          >
                            {label}
                          </Button>
                        </MenuTrigger>
                        <MenuPopover>
                          <MenuList>
                            {dropdownItems.map((mi, di) => {
                              const miDead = !mi.onClick && !mi.disabled;
                              return (
                                <MenuItem
                                  key={di}
                                  icon={mi.icon}
                                  disabled={mi.disabled || miDead}
                                  onClick={miDead ? undefined : mi.onClick}
                                  title={
                                    mi.title ??
                                    (miDead ? `${mi.label} — not wired in this editor` : undefined)
                                  }
                                >
                                  {mi.label}
                                </MenuItem>
                              );
                            })}
                          </MenuList>
                        </MenuPopover>
                      </Menu>
                    );
                  }
                  // v2 validator finding: editors declared 74+ ribbon
                  // actions with only { label } and no onClick — they
                  // rendered as enabled buttons but did nothing
                  // ("BROKEN" in click-every-button Phase 4 reports).
                  // Per no-vaporware.md any action without a wired
                  // handler should disable + tooltip "not wired" so the
                  // surface is honest about what's available today.
                  const dead = !onClick && !disabled;
                  return (
                    <Button
                      key={ai}
                      appearance="subtle"
                      size="small"
                      onClick={onClick}
                      disabled={dead || disabled}
                      title={dead ? `${label} — not wired in this editor` : undefined}
                      icon={rest.icon}
                    >
                      {label}
                    </Button>
                  );
                })}
              </div>
              <div className={styles.groupLabel}>{g.label}</div>
            </div>
            {gi < (current?.groups.length ?? 0) - 1 && <Divider vertical />}
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
