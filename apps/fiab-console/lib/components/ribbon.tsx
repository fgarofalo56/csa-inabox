'use client';

/**
 * Ribbon — reusable Fabric-style ribbon. Tab strip on top, action
 * groups (label + button row) below. Used by every item editor.
 * Mirrors the Fabric "Home" + per-item additional toolbars described
 * in docs/fiab/fabric-feature-inventory.md §3.
 */

import { ReactNode, useState } from 'react';
import {
  Tab,
  TabList,
  Button,
  Divider,
  makeStyles,
  tokens,
  type ButtonProps,
} from '@fluentui/react-components';

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

export interface RibbonAction extends Omit<ButtonProps, 'children'> {
  label: string;
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
                  const { label, ...rest } = a;
                  return (
                    <Button key={ai} appearance="subtle" size="small" {...rest}>
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
