'use client';

import { useState } from 'react';
import { Body1, Button, Title3, makeStyles, tokens } from '@fluentui/react-components';
import { StackedSplit, type StackedSplitPersistedState } from '@/lib/components/shared/stacked-split';

const useStyles = makeStyles({
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalL,
    height: '100vh',
    boxSizing: 'border-box',
  },
  stage: {
    flex: 1,
    minHeight: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
    overflow: 'hidden',
  },
  pad: { padding: tokens.spacingHorizontalM },
  state: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'pre-wrap',
  },
});

const lines = (n: number, label: string) =>
  Array.from({ length: n }, (_, i) => <Body1 key={i} block>{label} line {i + 1}</Body1>);

export function StackedSplitDemo() {
  const s = useStyles();
  const [layout, setLayout] = useState<StackedSplitPersistedState | null>(null);
  return (
    <div className={s.page}>
      <Title3>StackedSplit harness</Title3>
      <Button size="small" onClick={() => { window.localStorage.removeItem('loom.stackedsplit.demo'); window.location.reload(); }}>
        Clear saved layout and reload
      </Button>
      <div className={s.stage}>
        <StackedSplit
          sizingKey="demo"
          onLayoutChange={setLayout}
          panes={[
            { id: 'canvas', role: 'canvas', title: 'Canvas', defaultFlex: 3, content: <div className={s.pad}>{lines(6, 'Canvas')}</div> },
            { id: 'validation', title: 'Validation', defaultFlex: 1, content: <div className={s.pad}>{lines(4, 'Validation')}</div> },
            { id: 'output', title: 'Run output', defaultFlex: 1, headerActions: <Button size="small" appearance="subtle">Clear</Button>, content: <div className={s.pad}>{lines(30, 'Output')}</div> },
            { id: 'inspector', title: 'Inspector', defaultFlex: 1, defaultCollapsed: true, content: <div className={s.pad}>{lines(3, 'Inspector')}</div> },
          ]}
        />
      </div>
      <div className={s.state}>{layout ? JSON.stringify(layout) : 'layout: (no change yet)'}</div>
    </div>
  );
}
