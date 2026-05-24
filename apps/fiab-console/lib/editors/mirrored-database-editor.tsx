'use client';

/**
 * MirroredDatabaseEditor — connector wizard with the 8 source types
 * from mirrored-database-definition (Snowflake, AzureSqlDatabase,
 * AzureSqlMI, AzurePostgreSql, CosmosDb, SqlServer2025, MSSQL,
 * GenericMirror).
 */

import { useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button,
  Input,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const SOURCES = [
  { id: 'Snowflake', name: 'Snowflake', preview: false },
  { id: 'AzureSqlDatabase', name: 'Azure SQL Database', preview: false },
  { id: 'AzureSqlMI', name: 'Azure SQL Managed Instance', preview: true },
  { id: 'AzurePostgreSql', name: 'Azure Database for PostgreSQL', preview: true },
  { id: 'CosmosDb', name: 'Azure Cosmos DB', preview: true },
  { id: 'SqlServer2025', name: 'SQL Server 2025', preview: false },
  { id: 'MSSQL', name: 'SQL Server 2016-2022', preview: true },
  { id: 'GenericMirror', name: 'Open mirroring', preview: false },
];

const useStyles = makeStyles({
  wrap: { padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' },
  card: {
    padding: '14px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '6px',
    cursor: 'pointer',
    backgroundColor: tokens.colorNeutralBackground1,
    ':hover': { borderColor: tokens.colorBrandStroke1, boxShadow: tokens.shadow4 },
  },
  cardActive: { borderColor: tokens.colorBrandStroke1, backgroundColor: tokens.colorBrandBackground2 },
  formRow: { display: 'flex', gap: '12px', alignItems: 'flex-end' },
});

const RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Connection', actions: [{ label: 'Test connection' }, { label: 'Configure' }] },
    { label: 'Replication', actions: [{ label: 'Start' }, { label: 'Pause' }, { label: 'Stop' }, { label: 'Replication status' }] },
    { label: 'Tables', actions: [{ label: 'Add tables' }, { label: 'Remove tables' }] },
  ]},
];

interface Props { item: FabricItemType; id: string; }

export function MirroredDatabaseEditor({ item, id }: Props) {
  const styles = useStyles();
  const [src, setSrc] = useState<string>('AzureSqlDatabase');
  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={RIBBON}
      main={
        <div className={styles.wrap}>
          <Subtitle2>Step 1: Choose source type</Subtitle2>
          <div className={styles.grid}>
            {SOURCES.map((s) => (
              <div
                key={s.id}
                className={`${styles.card} ${s.id === src ? styles.cardActive : ''}`}
                onClick={() => setSrc(s.id)}
              >
                <Body1 style={{ fontWeight: 600 }}>{s.name}</Body1>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>type: {s.id}</Caption1>
                <div style={{ marginTop: 6 }}>
                  {s.preview && <Badge appearance="outline" color="warning">Preview</Badge>}
                </div>
              </div>
            ))}
          </div>
          <Subtitle2 style={{ marginTop: 16 }}>Step 2: Connection</Subtitle2>
          <div className={styles.formRow}>
            <div style={{ flex: 1 }}>
              <Caption1>Server</Caption1>
              <Input placeholder="server.database.windows.net" />
            </div>
            <div style={{ flex: 1 }}>
              <Caption1>Database</Caption1>
              <Input placeholder="prod" />
            </div>
            <Button appearance="primary">Test connection</Button>
          </div>
          <Subtitle2 style={{ marginTop: 16 }}>Step 3: Tables</Subtitle2>
          <Body1>Mirror all tables, or pick specific ones. New tables are auto-added to replication.</Body1>
          <div>
            <Badge appearance="filled">Mirror all data</Badge>
          </div>
        </div>
      }
    />
  );
}
