'use client';

/**
 * Ribbon — reusable Fabric-style ribbon. Tab strip on top, action
 * groups (label + button row) below. Used by every item editor.
 * Mirrors the Fabric "Home" + per-item additional toolbars described
 * in docs/fiab/fabric-feature-inventory.md §3.
 */

import { useState, type ReactElement } from 'react';
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
  makeStyles,
  tokens,
  type ButtonProps,
} from '@fluentui/react-components';
import { ChevronDown16Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    overflow: 'hidden',
  },
  tabs: {
    paddingLeft: '8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  body: {
    display: 'flex',
    alignItems: 'stretch',
    padding: '8px',
    gap: '8px',
    minHeight: '64px',
  },
  group: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
    padding: '0 8px',
  },
  groupRow: { display: 'flex', alignItems: 'center', gap: '4px', flex: 1 },
  groupLabel: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
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

export interface RibbonAction extends Omit<ButtonProps, 'children'> {
  label: string;
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
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  return (
    <div className={styles.root}>
      <TabList
        className={styles.tabs}
        selectedValue={active}
        onTabSelect={(_, d) => setActive(d.value as string)}
        size="small"
      >
        {tabs.map((t) => (
          <Tab key={t.id} value={t.id}>{t.label}</Tab>
        ))}
      </TabList>
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
                      {...rest}
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
    </div>
  );
}
