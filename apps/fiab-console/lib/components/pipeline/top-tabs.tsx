'use client';

/**
 * TopTabs — the row above the canvas in Fabric's Data Pipeline editor:
 *   Pipeline  | Parameters | Variables | Settings | Output
 *
 * Pure presentation; parent owns selection and the per-tab content.
 */

import { ReactNode } from 'react';
import { Tab, TabList, makeStyles, tokens, Badge } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
    flex: 1, minHeight: 0,
  },
  tabs: {
    paddingLeft: tokens.spacingHorizontalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
  },
  body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
});

export type TopTabId = 'pipeline' | 'parameters' | 'variables' | 'settings' | 'output';

export interface TopTabsProps {
  active: TopTabId;
  onChange: (id: TopTabId) => void;
  counts?: Partial<Record<TopTabId, number>>;
  children: ReactNode;
}

const LABELS: Array<{ id: TopTabId; label: string }> = [
  { id: 'pipeline',  label: 'Pipeline' },
  { id: 'parameters',label: 'Parameters' },
  { id: 'variables', label: 'Variables' },
  { id: 'settings',  label: 'Settings' },
  { id: 'output',    label: 'Output' },
];

export function TopTabs({ active, onChange, counts, children }: TopTabsProps) {
  const s = useStyles();
  return (
    <div className={s.root}>
      <TabList
        className={s.tabs}
        selectedValue={active}
        onTabSelect={(_, d) => onChange(d.value as TopTabId)}
        size="small"
      >
        {LABELS.map((t) => {
          const n = counts?.[t.id];
          return (
            <Tab key={t.id} value={t.id}>
              {t.label}
              {typeof n === 'number' && n > 0 && (
                <Badge size="small" appearance="outline" style={{ marginLeft: tokens.spacingHorizontalSNudge }}>{n}</Badge>
              )}
            </Tab>
          );
        })}
      </TabList>
      <div className={s.body}>{children}</div>
    </div>
  );
}
