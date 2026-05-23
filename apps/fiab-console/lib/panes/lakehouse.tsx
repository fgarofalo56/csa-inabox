'use client';

import { useState } from 'react';
import {
  Title2,
  Body1,
  Tree,
  TreeItem,
  TreeItemLayout,
  makeStyles,
  tokens,
  Button,
  Tab,
  TabList,
} from '@fluentui/react-components';
import {
  FolderOpen24Regular,
  Table24Regular,
  Add24Regular,
  ArrowDownload24Regular,
} from '@fluentui/react-icons';
import { useQuery } from '@tanstack/react-query';

interface Table {
  schema: string;
  name: string;
  rowCount: number;
  sizeBytes: number;
  format: 'delta' | 'parquet' | 'iceberg';
  latestVersion: number;
}

async function listTables(): Promise<Table[]> {
  const res = await fetch('/api/lakehouse/tables');
  if (!res.ok) throw new Error('failed');
  return res.json();
}

const useStyles = makeStyles({
  root: { display: 'grid', gridTemplateColumns: '320px 1fr', gap: '24px', height: '100%' },
  panel: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    padding: '16px',
  },
  header: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' },
  spacer: { flex: 1 },
  meta: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: '8px 16px',
    fontSize: '13px',
    marginTop: '16px',
  },
});

export function LakehousePane() {
  const styles = useStyles();
  const [selected, setSelected] = useState<Table | null>(null);
  const { data: tables } = useQuery({ queryKey: ['tables'], queryFn: listTables });

  return (
    <div>
      <div className={styles.header}>
        <Title2>Lakehouse</Title2>
        <div className={styles.spacer} />
        <Button appearance="primary" icon={<Add24Regular />}>New table</Button>
        <Button icon={<ArrowDownload24Regular />}>Upload data</Button>
      </div>

      <div className={styles.root}>
        <aside className={styles.panel}>
          <Body1 weight="semibold">Tables ({tables?.length ?? 0})</Body1>
          <Tree aria-label="Table explorer">
            {Object.entries(
              (tables ?? []).reduce<Record<string, Table[]>>((acc, t) => {
                (acc[t.schema] ||= []).push(t);
                return acc;
              }, {}),
            ).map(([schema, ts]) => (
              <TreeItem itemType="branch" key={schema}>
                <TreeItemLayout iconBefore={<FolderOpen24Regular />}>{schema}</TreeItemLayout>
                <Tree>
                  {ts.map((t) => (
                    <TreeItem itemType="leaf" key={t.name} onClick={() => setSelected(t)}>
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
              <TabList defaultSelectedValue="data">
                <Tab value="data">Data</Tab>
                <Tab value="schema">Schema</Tab>
                <Tab value="history">History</Tab>
                <Tab value="properties">Properties</Tab>
              </TabList>
              <div className={styles.meta}>
                <Body1 weight="semibold">Name</Body1><Body1>{selected.schema}.{selected.name}</Body1>
                <Body1 weight="semibold">Format</Body1><Body1>{selected.format}</Body1>
                <Body1 weight="semibold">Rows</Body1><Body1>{selected.rowCount.toLocaleString()}</Body1>
                <Body1 weight="semibold">Size</Body1><Body1>{(selected.sizeBytes / 1024 / 1024).toFixed(2)} MB</Body1>
                <Body1 weight="semibold">Latest version</Body1><Body1>{selected.latestVersion}</Body1>
              </div>
            </>
          ) : (
            <Body1>Select a table to inspect.</Body1>
          )}
        </section>
      </div>
    </div>
  );
}
