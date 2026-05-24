'use client';

/**
 * LakehouseEditor — three top-level sections per the inventory:
 * Tables, Files, Shortcuts. Left panel shows the tree; main pane
 * shows table preview / file preview / shortcut details.
 */

import { useState } from 'react';
import {
  Tree, TreeItem, TreeItemLayout,
  Tab, TabList,
  Body1, Subtitle2, Caption1,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, Folder20Regular, Link20Regular, DocumentTable20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const SAMPLE_TABLES = [
  { name: 'fact_sales', rows: 1_240_133, columns: 12 },
  { name: 'dim_customer', rows: 18_402, columns: 24 },
  { name: 'dim_product', rows: 2_104, columns: 31 },
  { name: 'dim_date', rows: 3_650, columns: 9 },
];
const SAMPLE_FILES = [
  { name: 'raw/', kind: 'folder' },
  { name: 'staging/', kind: 'folder' },
  { name: 'sample_orders.csv', kind: 'file', size: '2.3 MB' },
  { name: 'product_catalog.parquet', kind: 'file', size: '14.7 MB' },
];
const SAMPLE_SHORTCUTS = [
  { name: 's3-archive', target: 'Amazon S3 → s3://archive-bucket/orders', type: 'External' },
  { name: 'sales-db', target: 'Mirrored database → AzureSqlDatabase', type: 'Internal' },
];

const useStyles = makeStyles({
  tabs: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, padding: '8px 8px 0' },
  content: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  rowHover: { ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover, cursor: 'pointer' } },
});

const RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'New', actions: [
      { label: 'New table shortcut' }, { label: 'New schema shortcut' }, { label: 'New shortcut' },
    ]},
    { label: 'Load', actions: [
      { label: 'Load to tables' }, { label: 'Get data' },
    ]},
    { label: 'Open', actions: [
      { label: 'Open in notebook' }, { label: 'SQL endpoint' }, { label: 'Analyze with…' },
    ]},
    { label: 'Manage', actions: [
      { label: 'Permissions' }, { label: 'Settings' },
    ]},
  ]},
  { id: 'view', label: 'View', groups: [
    { label: 'Show', actions: [{ label: 'Properties' }, { label: 'Lineage' }, { label: 'Refresh' }] },
  ]},
];

interface Props { item: FabricItemType; id: string; }

export function LakehouseEditor({ item, id }: Props) {
  const styles = useStyles();
  const [tab, setTab] = useState<string>('tables');
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={RIBBON}
      leftPanel={
        <Tree aria-label="Lakehouse explorer" defaultOpenItems={['tables', 'files']}>
          <TreeItem itemType="branch" value="tables">
            <TreeItemLayout iconBefore={<Database20Regular />}>Tables ({SAMPLE_TABLES.length})</TreeItemLayout>
            <Tree>
              {SAMPLE_TABLES.map((t) => (
                <TreeItem key={t.name} itemType="leaf">
                  <TreeItemLayout iconBefore={<DocumentTable20Regular />}>{t.name}</TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>
          <TreeItem itemType="branch" value="files">
            <TreeItemLayout iconBefore={<Folder20Regular />}>Files ({SAMPLE_FILES.length})</TreeItemLayout>
            <Tree>
              {SAMPLE_FILES.map((f) => (
                <TreeItem key={f.name} itemType="leaf">
                  <TreeItemLayout>{f.name}</TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>
          <TreeItem itemType="branch" value="shortcuts">
            <TreeItemLayout iconBefore={<Link20Regular />}>Shortcuts ({SAMPLE_SHORTCUTS.length})</TreeItemLayout>
            <Tree>
              {SAMPLE_SHORTCUTS.map((s) => (
                <TreeItem key={s.name} itemType="leaf">
                  <TreeItemLayout>{s.name}</TreeItemLayout>
                </TreeItem>
              ))}
            </Tree>
          </TreeItem>
        </Tree>
      }
      main={
        <>
          <div className={styles.tabs}>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
              <Tab value="tables">Tables</Tab>
              <Tab value="files">Files</Tab>
              <Tab value="shortcuts">Shortcuts</Tab>
              <Tab value="sql-endpoint">SQL analytics endpoint</Tab>
            </TabList>
          </div>
          <div className={styles.content}>
            {tab === 'tables' && (
              <Table aria-label="Tables in lakehouse">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Rows</TableHeaderCell>
                    <TableHeaderCell>Columns</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {SAMPLE_TABLES.map((t) => (
                    <TableRow key={t.name} className={styles.rowHover}>
                      <TableCell>{t.name}</TableCell>
                      <TableCell>{t.rows.toLocaleString()}</TableCell>
                      <TableCell>{t.columns}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {tab === 'files' && (
              <Table aria-label="Files in lakehouse">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Kind</TableHeaderCell>
                    <TableHeaderCell>Size</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {SAMPLE_FILES.map((f) => (
                    <TableRow key={f.name} className={styles.rowHover}>
                      <TableCell>{f.name}</TableCell>
                      <TableCell>{f.kind}</TableCell>
                      <TableCell>{(f as { size?: string }).size ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {tab === 'shortcuts' && (
              <Table aria-label="Shortcuts">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>Name</TableHeaderCell>
                    <TableHeaderCell>Target</TableHeaderCell>
                    <TableHeaderCell>Type</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {SAMPLE_SHORTCUTS.map((s) => (
                    <TableRow key={s.name} className={styles.rowHover}>
                      <TableCell>{s.name}</TableCell>
                      <TableCell>{s.target}</TableCell>
                      <TableCell>{s.type}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {tab === 'sql-endpoint' && (
              <>
                <Subtitle2>SQL analytics endpoint</Subtitle2>
                <Body1>Connection string</Body1>
                <Caption1 style={{ fontFamily: 'monospace' }}>
                  Server=tcp:loom-{id.substring(0, 6)}.sql.fabric.microsoft.com,1433;Database=lakehouse;Encrypt=True
                </Caption1>
              </>
            )}
          </div>
        </>
      }
    />
  );
}
