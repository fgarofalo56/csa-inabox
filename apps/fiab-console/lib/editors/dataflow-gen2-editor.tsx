'use client';

/**
 * DataflowGen2Editor — Power Query Online clone: queries pane (left),
 * diagram view + data preview (center), applied steps (right), ribbon
 * with Home/Transform/Add column/View/Tools/Help tabs.
 */

import { useState } from 'react';
import {
  Subtitle2, Body1, Caption1,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Input, Button, makeStyles, tokens,
} from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const QUERIES = ['Orders', 'Customers', 'Products', 'dim_date'];
const STEPS = ['Source', 'Navigation', 'Promoted Headers', 'Changed Type', 'Filtered Rows (Active = true)', 'Added Custom Column (FullName)', 'Grouped Rows'];
const PREVIEW = [
  { OrderID: '10001', CustomerID: 'C-0042', Amount: '124.50', Active: 'true', FullName: 'Jane Q.' },
  { OrderID: '10002', CustomerID: 'C-1003', Amount: '89.95', Active: 'true', FullName: 'Bob R.' },
  { OrderID: '10003', CustomerID: 'C-2204', Amount: '212.10', Active: 'false', FullName: 'Sara T.' },
];

const useStyles = makeStyles({
  layout: { display: 'grid', gridTemplateColumns: '200px 1fr 260px', minHeight: '500px' },
  pane: { padding: '12px', borderRight: `1px solid ${tokens.colorNeutralStroke2}`, overflow: 'auto' },
  paneRight: { padding: '12px', borderLeft: `1px solid ${tokens.colorNeutralStroke2}`, overflow: 'auto' },
  center: { padding: '12px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' },
  queryItem: {
    padding: '6px 10px', borderRadius: '4px',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover, cursor: 'pointer' },
  },
  queryItemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontWeight: '600',
  },
  step: {
    padding: '6px 10px',
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    marginBottom: '4px',
    fontSize: '12px',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  globalSearch: { marginBottom: '8px' },
});

const RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Get data', actions: [{ label: 'Get data' }, { label: 'Recent sources' }, { label: 'Enter data' }] },
    { label: 'Query', actions: [{ label: 'New query' }, { label: 'Manage' }, { label: 'Refresh preview' }] },
    { label: 'Data destination', actions: [{ label: 'Lakehouse' }, { label: 'Warehouse' }, { label: 'KQL DB' }, { label: 'SQL DB' }] },
    { label: 'Publish', actions: [{ label: 'Save & run' }, { label: 'Publish' }] },
  ]},
  { id: 'transform', label: 'Transform', groups: [
    { label: 'Any column', actions: [{ label: 'Group by' }, { label: 'Use first row as headers' }, { label: 'Replace values' }, { label: 'Fill' }, { label: 'Pivot' }, { label: 'Unpivot' }] },
    { label: 'Text', actions: [{ label: 'Split column' }, { label: 'Trim' }, { label: 'Clean' }] },
    { label: 'Number', actions: [{ label: 'Standard' }, { label: 'Statistics' }, { label: 'Trigonometry' }] },
  ]},
  { id: 'add-column', label: 'Add column', groups: [
    { label: 'General', actions: [{ label: 'Custom column' }, { label: 'Conditional column' }, { label: 'Index column' }] },
    { label: 'From text', actions: [{ label: 'Format' }, { label: 'Extract' }] },
  ]},
  { id: 'view', label: 'View', groups: [
    { label: 'Layout', actions: [{ label: 'Diagram view' }, { label: 'Query settings' }, { label: 'Advanced editor' }] },
  ]},
];

interface Props { item: FabricItemType; id: string; }

export function DataflowGen2Editor({ item, id }: Props) {
  const styles = useStyles();
  const [activeQuery, setActiveQuery] = useState('Orders');
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={RIBBON}
      main={
        <div className={styles.layout}>
          <aside className={styles.pane} aria-label="Queries">
            <Subtitle2 style={{ marginBottom: 8 }}>Queries</Subtitle2>
            {QUERIES.map((q) => (
              <div
                key={q}
                className={`${styles.queryItem} ${q === activeQuery ? styles.queryItemActive : ''}`}
                onClick={() => setActiveQuery(q)}
              >{q}</div>
            ))}
          </aside>
          <div className={styles.center}>
            <Input className={styles.globalSearch} contentBefore={<Search20Regular />} placeholder="Search (Alt+Q)" />
            <Subtitle2>{activeQuery} · Data preview</Subtitle2>
            <Table aria-label="Data preview">
              <TableHeader>
                <TableRow>
                  {Object.keys(PREVIEW[0]).map((k) => <TableHeaderCell key={k}>{k}</TableHeaderCell>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {PREVIEW.map((r, i) => (
                  <TableRow key={i}>
                    {Object.values(r).map((v, j) => <TableCell key={j}>{v}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>3 rows · Column profiling on</Caption1>
          </div>
          <aside className={styles.paneRight} aria-label="Applied steps">
            <Subtitle2 style={{ marginBottom: 8 }}>Applied steps</Subtitle2>
            {STEPS.map((s) => <div key={s} className={styles.step}>{s}</div>)}
            <Button appearance="subtle" size="small" style={{ marginTop: 8 }}>+ Add step</Button>
          </aside>
        </div>
      }
    />
  );
}
