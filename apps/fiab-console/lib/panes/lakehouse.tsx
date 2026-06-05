'use client';

import { useEffect, useState } from 'react';
import {
  Title2,
  Body1,
  Body1Strong,
  Caption1,
  Tree,
  TreeItem,
  TreeItemLayout,
  makeStyles,
  tokens,
  Select,
  Spinner,
  MessageBar,
  MessageBarBody,
  Tab,
  TabList,
} from '@fluentui/react-components';
import {
  FolderOpen24Regular,
  Table24Regular,
  Open24Regular,
} from '@fluentui/react-icons';
import { useQuery } from '@tanstack/react-query';

interface LakehouseItem { id: string; displayName: string; workspaceId?: string }
interface Table {
  schema: string;
  name: string;
  rowCount: number;
  sizeBytes: number;
  format: string;
  latestVersion: number;
  columns?: number;
  ddl?: string;
}

async function listLakehouses(): Promise<LakehouseItem[]> {
  const res = await fetch('/api/items/by-type?type=lakehouse');
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${res.status}`);
  return (j.items || []) as LakehouseItem[];
}

async function listTables(id: string): Promise<Table[]> {
  const res = await fetch(`/api/lakehouse/tables?id=${encodeURIComponent(id)}`);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${res.status}`);
  return (j.tables || []) as Table[];
}

const useStyles = makeStyles({
  root: { display: 'grid', gridTemplateColumns: '320px 1fr', gap: '24px', height: '100%' },
  panel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    padding: '16px',
  },
  header: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  meta: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: '8px 16px',
    fontSize: '13px',
    marginTop: '16px',
  },
  editorLink: {
    display: 'inline-flex', alignItems: 'center', gap: '6px',
    color: tokens.colorBrandForeground1, textDecoration: 'none', fontSize: '13px',
  },
});

export function LakehousePane() {
  const styles = useStyles();
  const [lakehouseId, setLakehouseId] = useState('');
  const [selected, setSelected] = useState<Table | null>(null);

  const lakehouses = useQuery({ queryKey: ['lakehouses'], queryFn: listLakehouses });
  // Auto-select the first lakehouse once the list loads.
  useEffect(() => {
    if (!lakehouseId && lakehouses.data && lakehouses.data.length > 0) {
      setLakehouseId(lakehouses.data[0].id);
    }
  }, [lakehouseId, lakehouses.data]);

  const tablesQ = useQuery({
    queryKey: ['lakehouse-tables', lakehouseId],
    queryFn: () => listTables(lakehouseId),
    enabled: !!lakehouseId,
  });
  const tables = tablesQ.data ?? [];

  const current = lakehouses.data?.find((l) => l.id === lakehouseId);

  return (
    <div>
      <div className={styles.header}>
        <Title2>Lakehouse</Title2>
        <div className={styles.spacer} />
        <Select
          value={lakehouseId}
          onChange={(_, d) => { setLakehouseId(d.value); setSelected(null); }}
          disabled={lakehouses.isLoading || (lakehouses.data?.length ?? 0) === 0}
          aria-label="Lakehouse"
        >
          {(lakehouses.data ?? []).map((l) => (
            <option key={l.id} value={l.id}>{l.displayName}</option>
          ))}
        </Select>
        {current && (
          <a className={styles.editorLink} href={`/items/lakehouse/${encodeURIComponent(current.id)}`}>
            <Open24Regular /> Open in full editor
          </a>
        )}
      </div>

      {lakehouses.isError && (
        <MessageBar intent="error"><MessageBarBody>Could not load lakehouses: {(lakehouses.error as Error)?.message}</MessageBarBody></MessageBar>
      )}
      {!lakehouses.isLoading && (lakehouses.data?.length ?? 0) === 0 && (
        <MessageBar intent="info"><MessageBarBody>No lakehouses in this tenant yet. Create one from the catalog (New → Lakehouse), then its Delta tables appear here.</MessageBarBody></MessageBar>
      )}

      <div className={styles.root}>
        <aside className={styles.panel}>
          <Body1Strong>Tables ({tables.length})</Body1Strong>
          {tablesQ.isLoading && <Spinner size="tiny" label="Loading tables…" />}
          {tablesQ.isError && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{(tablesQ.error as Error)?.message}</Caption1>}
          <Tree aria-label="Table explorer">
            {Object.entries(
              tables.reduce<Record<string, Table[]>>((acc, t) => {
                (acc[t.schema] ||= []).push(t);
                return acc;
              }, {}),
            ).map(([schema, ts]) => (
              <TreeItem itemType="branch" key={schema} value={schema}>
                <TreeItemLayout iconBefore={<FolderOpen24Regular />}>{schema}</TreeItemLayout>
                <Tree>
                  {ts.map((t) => (
                    <TreeItem itemType="leaf" key={t.name} value={`${schema}.${t.name}`} onClick={() => setSelected(t)}>
                      <TreeItemLayout iconBefore={<Table24Regular />}>{t.name}</TreeItemLayout>
                    </TreeItem>
                  ))}
                </Tree>
              </TreeItem>
            ))}
          </Tree>
        </aside>

        <section className={styles.panel}>
          {selected ? (
            <>
              <TabList defaultSelectedValue="properties">
                <Tab value="properties">Properties</Tab>
                <Tab value="schema">Schema</Tab>
              </TabList>
              <div className={styles.meta}>
                <Body1Strong>Name</Body1Strong><Body1>{selected.schema}.{selected.name}</Body1>
                <Body1Strong>Format</Body1Strong><Body1>{selected.format}</Body1>
                <Body1Strong>Rows (sample)</Body1Strong><Body1>{selected.rowCount.toLocaleString()}</Body1>
                {typeof selected.columns === 'number' && (<><Body1Strong>Columns</Body1Strong><Body1>{selected.columns}</Body1></>)}
                <Body1Strong>Latest version</Body1Strong><Body1>{selected.latestVersion}</Body1>
              </div>
              {selected.ddl && (
                <pre style={{ marginTop: 16, fontSize: 12, whiteSpace: 'pre-wrap', fontFamily: 'Cascadia Code, Consolas, monospace' }}>{selected.ddl}</pre>
              )}
            </>
          ) : (
            <Body1>Select a table to inspect, or open the lakehouse in the full editor for files, shortcuts, and SQL.</Body1>
          )}
        </section>
      </div>
    </div>
  );
}
