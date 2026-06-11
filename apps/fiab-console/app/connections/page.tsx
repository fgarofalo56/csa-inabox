'use client';

/**
 * /connections — Loom Connections: reusable, Key Vault-backed data-source
 * connections used by mirroring, ADF/Synapse linked services, and datasets.
 * Enter creds once → the secret lands in Key Vault (only a secretRef is stored).
 * Fluent v9 + Loom tokens; the shared LoomDataTable + the ConnectionBuilder dialog.
 */

import { clientFetch } from '@/lib/client-fetch';
import { useCallback, useEffect, useState } from 'react';
import {
  Title2, Body1, Caption1, Badge, Button, Spinner, MessageBar, MessageBarBody,
  MessageBarTitle, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  PlugConnected24Regular, Add20Regular, Delete20Regular, Key16Regular, ShieldKeyhole16Regular,
} from '@fluentui/react-icons';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { ConnectionBuilder, type ConnectionView } from '@/lib/components/connections/connection-builder';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, padding: tokens.spacingVerticalXXL, maxWidth: '1100px', margin: '0 auto', width: '100%' },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM },
  headIcon: { color: tokens.colorBrandForeground1 },
  intro: { color: tokens.colorNeutralForeground2, maxWidth: '780px' },
  bar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
});

const TYPE_LABEL: Record<string, string> = {
  'azure-sql': 'Azure SQL', 'synapse-dedicated': 'Synapse Dedicated', 'synapse-serverless': 'Synapse Serverless',
  'databricks-sql': 'Databricks SQL', 'postgres': 'PostgreSQL', 'storage-adls': 'ADLS / Storage', 'cosmos': 'Cosmos DB', 'generic-sql': 'SQL Server',
};
const METHOD_LABEL: Record<string, string> = {
  'entra-mi': 'Managed identity', 'sql-password': 'SQL password', 'connection-string': 'Connection string',
  'account-key': 'Account key', 'service-principal': 'Service principal',
};

export default function ConnectionsPage() {
  const s = useStyles();
  const [conns, setConns] = useState<ConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await clientFetch('/api/connections');
      const j = await r.json();
      if (!r.ok || j?.ok === false) { setError(j?.error || `HTTP ${r.status}`); setConns([]); return; }
      setConns(j.connections || []);
    } catch (e: any) { setError(e?.message || String(e)); setConns([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const remove = useCallback(async (id: string, name: string) => {
    if (!confirm(`Delete connection "${name}"? Its Key Vault secret is also removed.`)) return;
    setBusy(true);
    try {
      await clientFetch(`/api/connections?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      await load();
    } finally { setBusy(false); }
  }, [load]);

  const columns: LoomColumn<ConnectionView>[] = [
    { key: 'name', label: 'Name', sortable: true, filterable: true, getValue: (c) => c.name, render: (c) => <strong>{c.name}</strong> },
    { key: 'type', label: 'Type', sortable: true, filterable: true, getValue: (c) => TYPE_LABEL[c.type] || c.type, render: (c) => <Badge appearance="tint" color="brand" size="small">{TYPE_LABEL[c.type] || c.type}</Badge> },
    {
      key: 'authMethod', label: 'Auth', sortable: true, filterable: true, getValue: (c) => METHOD_LABEL[c.authMethod] || c.authMethod,
      render: (c) => (
        <span className={s.bar}>
          {c.hasSecret ? <Key16Regular /> : <ShieldKeyhole16Regular />}
          <Caption1>{METHOD_LABEL[c.authMethod] || c.authMethod}</Caption1>
          {c.hasSecret && <Badge appearance="outline" size="small" color="success">Key Vault</Badge>}
        </span>
      ),
    },
    { key: 'host', label: 'Host', sortable: true, filterable: true, getValue: (c) => c.host || '—', render: (c) => <code style={{ fontSize: 11 }}>{c.host || '—'}</code> },
    { key: 'database', label: 'Database', sortable: true, filterable: true, getValue: (c) => c.database || '—', render: (c) => c.database || '—' },
    {
      key: 'actions', label: '', sortable: false, filterable: false, width: 90,
      render: (c) => <Button size="small" appearance="subtle" icon={<Delete20Regular />} disabled={busy} onClick={() => remove(c.id, c.name)} aria-label={`Delete ${c.name}`} />,
    },
  ];

  return (
    <div className={s.root}>
      <div className={s.header}>
        <PlugConnected24Regular className={s.headIcon} />
        <Title2>Connections</Title2>
      </div>
      <Body1 className={s.intro}>
        Reusable, Key Vault-backed connections to your data sources. Enter credentials once — the secret is
        stored in Key Vault (only a reference is kept) and reused by mirroring, ADF / Synapse linked services,
        and datasets, so you never paste a password into item config.
      </Body1>

      <div className={s.bar}>
        <Button appearance="primary" icon={<Add20Regular />} onClick={() => setBuilderOpen(true)}>New connection</Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Could not load connections</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {conns == null ? (
        <Spinner label="Loading connections…" />
      ) : (
        <LoomDataTable<ConnectionView>
          columns={columns}
          rows={conns}
          getRowId={(c) => c.id}
          empty="No connections yet. Click “New connection” to create a Key Vault-backed connection."
        />
      )}

      <ConnectionBuilder open={builderOpen} onClose={() => setBuilderOpen(false)} onCreated={() => void load()} />
    </div>
  );
}
