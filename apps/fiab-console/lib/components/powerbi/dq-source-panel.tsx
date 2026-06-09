'use client';

/**
 * DirectQuery source binder panel for the SemanticModelEditor.
 *
 * Surfaces the Azure-native DirectQuery storage mode (no-fabric-dependency.md):
 * pick a live Azure source family, test the connection, list its tables, choose
 * which to bind in DirectQuery mode, then push the binding to the Azure
 * Analysis Services model via TMSL. No data is copied — every DAX query against
 * a DQ partition generates a live query at the source.
 *
 * Every control calls the real BFF route
 * (/api/items/semantic-model/[id]/datasource); a 503 not_configured is rendered
 * as a Fluent MessageBar warning with the exact env var / role to provision,
 * and the full UI still renders (no-vaporware.md / ui-parity.md).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Button, Input, Field, Select, Badge, Spinner, Caption1, Subtitle2, Checkbox,
  Table, TableHeader, TableHeaderCell, TableRow, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  PlugConnected20Regular, Table20Regular, CloudArrowUp20Regular, ArrowSync20Regular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '14px' },
  row: { display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' },
  inline: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  hint: { color: tokens.colorNeutralForeground3 },
  tablesBox: {
    maxHeight: '240px', overflowY: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium, padding: '8px', display: 'flex', flexDirection: 'column', gap: '2px',
  },
});

const SOURCE_TYPES = [
  { value: 'synapse-serverless', label: 'Synapse Serverless SQL' },
  { value: 'synapse-dedicated', label: 'Synapse Dedicated SQL pool' },
  { value: 'azure-sql', label: 'Azure SQL Database' },
  { value: 'adx', label: 'Azure Data Explorer (Kusto)' },
] as const;

type DqSourceType = (typeof SOURCE_TYPES)[number]['value'];

interface DqConfig {
  sourceType: DqSourceType; server: string; database: string;
  secretRef?: string; tables: string[]; appliedAt?: string;
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

export function DqSourcePanel({
  datasetId, itemId, workspaceId, onApplied,
}: {
  datasetId: string; itemId: string; workspaceId: string; onApplied?: (config: DqConfig) => void;
}) {
  const s = useStyles();
  const [sourceType, setSourceType] = useState<DqSourceType>('synapse-serverless');
  const [server, setServer] = useState('');
  const [database, setDatabase] = useState('');
  const [secretRef, setSecretRef] = useState('');
  const [tables, setTables] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [applyMsg, setApplyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [gate, setGate] = useState<{ missing: string; detail: string } | null>(null);
  const [busy, setBusy] = useState<'test' | 'tables' | 'apply' | null>(null);
  const [config, setConfig] = useState<DqConfig | null>(null);

  const base = `/api/items/semantic-model/${encodeURIComponent(datasetId)}/datasource?workspaceId=${encodeURIComponent(workspaceId)}&itemId=${encodeURIComponent(itemId)}`;

  const applyGate = useCallback((body: any): boolean => {
    if (body?.code === 'not_configured' && body?.missing) { setGate({ missing: body.missing, detail: body.error || '' }); return true; }
    return false;
  }, []);

  // Hydrate from any previously-applied config persisted on the item.
  const loadConfig = useCallback(async () => {
    try {
      const body = await fetch(base).then(readJson);
      if (body?.ok && body.config) {
        const c = body.config as DqConfig;
        setConfig(c);
        setSourceType(c.sourceType); setServer(c.server || ''); setDatabase(c.database || '');
        setSecretRef(c.secretRef || ''); setSelected(Array.isArray(c.tables) ? c.tables : []);
      }
    } catch { /* silent — no prior config */ }
  }, [base]);

  useEffect(() => { if (datasetId && itemId) loadConfig(); }, [datasetId, itemId, loadConfig]);

  const call = useCallback(async (action: 'test' | 'tables' | 'apply', extra?: Record<string, unknown>) => {
    const body = await fetch(base, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, sourceType, server: server.trim(), database: database.trim(), secretRef: secretRef.trim() || undefined, ...extra }),
    }).then(readJson);
    return body;
  }, [base, sourceType, server, database, secretRef]);

  const testConnection = useCallback(async () => {
    setBusy('test'); setTestMsg(null); setGate(null);
    try {
      const body = await call('test');
      if (applyGate(body)) return;
      if (!body.ok) { setTestMsg({ ok: false, text: body.error || 'connection failed' }); return; }
      setTestMsg({ ok: true, text: `Connection OK — probe returned in ${body.executionMs ?? '?'} ms${body.endpoint ? ` (${body.endpoint})` : ''}.` });
    } catch (e: any) { setTestMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBusy(null); }
  }, [call, applyGate]);

  const listTables = useCallback(async () => {
    setBusy('tables'); setTestMsg(null); setGate(null);
    try {
      const body = await call('tables');
      if (applyGate(body)) return;
      if (!body.ok) { setTestMsg({ ok: false, text: body.error || 'failed to list tables' }); return; }
      const names: string[] = Array.isArray(body.tables) ? body.tables : [];
      setTables(names);
      setTestMsg({ ok: true, text: `${names.length} table(s) discovered.` });
    } catch (e: any) { setTestMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBusy(null); }
  }, [call, applyGate]);

  const applyBinding = useCallback(async () => {
    setBusy('apply'); setApplyMsg(null); setGate(null);
    try {
      const body = await call('apply', { tables: selected });
      if (applyGate(body)) return;
      if (!body.ok) { setApplyMsg({ ok: false, text: body.error || 'apply failed' }); return; }
      setConfig(body.config);
      setApplyMsg({ ok: true, text: `DirectQuery bound on ${selected.length} table(s)${body.persisted ? '' : ' (config not persisted — open as a Loom item to save)'}.` });
      onApplied?.(body.config);
    } catch (e: any) { setApplyMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBusy(null); }
  }, [call, selected, applyGate, onApplied]);

  const toggle = useCallback((t: string) => {
    setSelected((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]);
  }, []);

  const needsServer = sourceType === 'azure-sql';

  return (
    <div className={s.root}>
      <Subtitle2>DirectQuery source</Subtitle2>
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Live source, no data copied</MessageBarTitle>
          In DirectQuery mode the model holds no cached data — every DAX query runs a live query at the
          Azure source. Bind a source below and apply it to the Azure Analysis Services model. Refresh is
          disabled because there is nothing to import.
        </MessageBarBody>
      </MessageBar>

      {config?.appliedAt && (
        <div className={s.inline}>
          <Badge appearance="filled" color="success">DirectQuery bound</Badge>
          <Caption1 className={s.hint}>{config.sourceType} · {config.tables?.length ?? 0} table(s) · applied {new Date(config.appliedAt).toLocaleString()}</Caption1>
        </div>
      )}

      <div className={s.row}>
        <Field label="Source type" style={{ minWidth: 240 }}>
          <Select value={sourceType} onChange={(_, d) => { setSourceType(d.value as DqSourceType); setTables([]); }}>
            {SOURCE_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </Field>
        <Field label={needsServer ? 'Server FQDN (required)' : 'Server / cluster (optional — uses env-bound default)'} style={{ minWidth: 320 }}>
          <Input value={server} onChange={(_, d) => setServer(d.value)} placeholder={sourceType === 'adx' ? 'adx-cluster.eastus2.kusto.windows.net' : 'workspace-ondemand.sql.azuresynapse.net'} />
        </Field>
        <Field label={sourceType === 'adx' ? 'Database (optional)' : 'Database / pool (optional)'} style={{ minWidth: 200 }}>
          <Input value={database} onChange={(_, d) => setDatabase(d.value)} placeholder={sourceType === 'adx' ? 'loomdb-default' : 'master'} />
        </Field>
      </div>

      <div className={s.row}>
        <Field label="Key Vault secret ref (optional — blank = Console managed identity)" style={{ minWidth: 360 }}
          hint="Name of a Key Vault secret holding the source credential. Leave blank to authenticate with the Console UAMI.">
          <Input value={secretRef} onChange={(_, d) => setSecretRef(d.value)} placeholder="dq-source-conn" />
        </Field>
      </div>

      <div className={s.inline}>
        <Button appearance="outline" icon={<PlugConnected20Regular />} disabled={busy !== null || (needsServer && !server.trim())} onClick={testConnection}>
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </Button>
        <Button appearance="outline" icon={<Table20Regular />} disabled={busy !== null || (needsServer && !server.trim())} onClick={listTables}>
          {busy === 'tables' ? 'Listing…' : 'List tables'}
        </Button>
        {busy && <Spinner size="tiny" />}
      </div>

      {testMsg && <MessageBar intent={testMsg.ok ? 'success' : 'error'}><MessageBarBody>{testMsg.text}</MessageBarBody></MessageBar>}

      {tables.length > 0 && (
        <>
          <div className={s.inline}>
            <Caption1 style={{ fontWeight: 600 }}>Tables to bind in DirectQuery mode ({selected.length}/{tables.length})</Caption1>
            <Button size="small" appearance="subtle" onClick={() => setSelected([...tables])}>Select all</Button>
            <Button size="small" appearance="subtle" onClick={() => setSelected([])}>Clear</Button>
          </div>
          <div className={s.tablesBox}>
            {tables.map((t) => (
              <Checkbox key={t} label={t} checked={selected.includes(t)} onChange={() => toggle(t)} />
            ))}
          </div>
        </>
      )}

      <Subtitle2 style={{ marginTop: 8 }}>Apply to Analysis Services model</Subtitle2>
      <Caption1 className={s.hint}>
        Pushes TMSL (<code>createOrReplace</code> DataSource + DirectQuery partitions) to the AAS model via XMLA.
        The Console managed identity must be an Analysis Services server administrator on the bound server.
      </Caption1>

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Not configured</MessageBarTitle>
            {gate.detail || <>Set <code>{gate.missing}</code> to enable this action.</>}
          </MessageBarBody>
        </MessageBar>
      )}

      <div className={s.inline}>
        <Button appearance="primary" icon={<CloudArrowUp20Regular />} disabled={busy !== null || selected.length === 0} onClick={applyBinding}>
          {busy === 'apply' ? 'Applying…' : `Apply DirectQuery (${selected.length})`}
        </Button>
        <Button appearance="subtle" icon={<ArrowSync20Regular />} disabled={busy !== null} onClick={loadConfig}>Reload</Button>
      </div>

      {applyMsg && <MessageBar intent={applyMsg.ok ? 'success' : 'error'}><MessageBarBody>{applyMsg.text}</MessageBarBody></MessageBar>}
    </div>
  );
}
