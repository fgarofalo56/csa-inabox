'use client';

/**
 * NotebookEditor — cell-based authoring with kernel selector + run
 * status. Cells are styled to look like Monaco but use textarea (no
 * Monaco dep). Each cell has output preview and run button per the
 * Fabric notebook anatomy.
 */

import { useState } from 'react';
import {
  Dropdown, Option,
  Button, Badge, Subtitle2, Body1, Caption1,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, Add20Regular, Delete20Regular, ArrowUp20Regular, ArrowDown20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const KERNELS = ['PySpark (Python)', 'Spark (Scala)', 'Spark SQL', 'SparkR', 'Python 3.11', 'Python 3.10'];

interface Cell {
  id: string;
  kind: 'code' | 'markdown';
  source: string;
  output?: string;
  status: 'idle' | 'running' | 'success' | 'error';
}

const STARTER_CELLS: Cell[] = [
  { id: 'c1', kind: 'markdown', source: '# Welcome to your new notebook\n\nThis notebook is attached to **PySpark (Python)** by default. Add a code cell below to start exploring your lakehouse.', status: 'idle' },
  { id: 'c2', kind: 'code', source: 'df = spark.read.table("fact_sales")\ndf.show(5)', status: 'success', output: '+----------+--------+-------+\n|order_id  |customer|amount |\n+----------+--------+-------+\n|10001     |C-0042  |124.50 |\n|10002     |C-1003  |89.95  |\n+----------+--------+-------+\nonly showing top 5 rows' },
  { id: 'c3', kind: 'code', source: 'df.groupBy("customer").count().orderBy("count", ascending=False).limit(10)', status: 'idle' },
];

const useStyles = makeStyles({
  toolbar: {
    padding: '8px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  cells: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' },
  cell: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  cellHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  src: {
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: '13px',
    padding: '12px',
    width: '100%',
    minHeight: '64px',
    border: 'none',
    outline: 'none',
    resize: 'vertical',
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
  output: {
    padding: '12px',
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: 'Consolas, monospace',
    fontSize: '12px',
    whiteSpace: 'pre',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  cellActions: { marginLeft: 'auto', display: 'flex', gap: '4px' },
});

const RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Run', actions: [{ label: 'Run all' }, { label: 'Run selected' }, { label: 'Stop' }] },
    { label: 'Insert', actions: [{ label: 'Code cell' }, { label: 'Markdown cell' }] },
    { label: 'Kernel', actions: [{ label: 'Restart' }, { label: 'Variables' }] },
    { label: 'Workspace', actions: [{ label: 'Add lakehouse' }, { label: 'Add environment' }] },
  ]},
  { id: 'view', label: 'View', groups: [
    { label: 'Layout', actions: [{ label: 'Variables explorer' }, { label: 'Session info' }, { label: 'Open in VS Code' }] },
  ]},
];

interface Props { item: FabricItemType; id: string; }

export function NotebookEditor({ item, id }: Props) {
  const styles = useStyles();
  const [cells, setCells] = useState<Cell[]>(STARTER_CELLS);
  const [kernel, setKernel] = useState<string>(KERNELS[0]);

  function runCell(cellId: string) {
    setCells((cs) => cs.map((c) => c.id === cellId ? { ...c, status: 'running' as const } : c));
    setTimeout(() => {
      setCells((cs) => cs.map((c) => c.id === cellId
        ? { ...c, status: 'success' as const, output: c.output ?? '[runtime mock] ran in 0.42s' }
        : c));
    }, 600);
  }
  function addCell(kind: 'code' | 'markdown') {
    setCells((cs) => [...cs, { id: `c${cs.length + 1}`, kind, source: '', status: 'idle' as const }]);
  }
  function deleteCell(cellId: string) {
    setCells((cs) => cs.filter((c) => c.id !== cellId));
  }

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={RIBBON}
      main={
        <>
          <div className={styles.toolbar}>
            <Caption1>Kernel:</Caption1>
            <Dropdown value={kernel} selectedOptions={[kernel]} onOptionSelect={(_, d) => setKernel(d.optionValue ?? kernel)}>
              {KERNELS.map((k) => <Option key={k} value={k}>{k}</Option>)}
            </Dropdown>
            <Badge appearance="outline" color="success">Session: idle</Badge>
            <Button appearance="primary" icon={<Play20Regular />} onClick={() => cells.forEach((c) => runCell(c.id))}>Run all</Button>
            <Button appearance="subtle" icon={<Add20Regular />} onClick={() => addCell('code')}>Code cell</Button>
            <Button appearance="subtle" onClick={() => addCell('markdown')}>+ Markdown</Button>
          </div>
          <div className={styles.cells}>
            {cells.map((c, i) => (
              <div key={c.id} className={styles.cell}>
                <div className={styles.cellHeader}>
                  <Caption1>[{i + 1}] {c.kind}</Caption1>
                  {c.status === 'running' && <Badge color="brand">Running…</Badge>}
                  {c.status === 'success' && <Badge color="success">Succeeded</Badge>}
                  {c.status === 'error' && <Badge color="danger">Failed</Badge>}
                  <div className={styles.cellActions}>
                    {c.kind === 'code' && (
                      <Button size="small" appearance="subtle" icon={<Play20Regular />} onClick={() => runCell(c.id)} aria-label="Run cell" />
                    )}
                    <Button size="small" appearance="subtle" icon={<ArrowUp20Regular />} aria-label="Move up" />
                    <Button size="small" appearance="subtle" icon={<ArrowDown20Regular />} aria-label="Move down" />
                    <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => deleteCell(c.id)} aria-label="Delete cell" />
                  </div>
                </div>
                <textarea
                  className={styles.src}
                  defaultValue={c.source}
                  spellCheck={false}
                  aria-label={`Cell ${i + 1} source`}
                />
                {c.output && <div className={styles.output}>{c.output}</div>}
              </div>
            ))}
          </div>
        </>
      }
    />
  );
}
