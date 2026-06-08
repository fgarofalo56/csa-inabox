'use client';

/**
 * MirroredDatabaseEditor — Azure-native Mirrored Database editor (no Microsoft
 * Fabric). Lists existing mirrored databases in a workspace, shows mirroring
 * status + per-table replication metrics, and supports New / Edit / Start /
 * Stop / Delete / Test connection.
 *
 * The New/Edit flow is the standalone {@link MirrorSourceWizard}: source picker
 * (Azure SQL DB/MI, SQL Server, Snowflake, Cosmos DB, PostgreSQL) → connection
 * (Key Vault-backed creds, never plaintext) → connectivity test → table
 * include/exclude picker → review/create. Start runs the real Azure-native
 * mirror engine (TDS/PG/Cosmos snapshot → ADLS Bronze CSV) or, when ADF CDC is
 * configured (LOOM_ADF_NAME + linked services), an ADF ChangeDataCapture →
 * ADLS Bronze **Delta**.
 *
 * Backed by /api/loom/workspaces + /api/items/mirrored-database/**.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Select, Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Tree, TreeItem, TreeItemLayout,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Delete20Regular, Play20Regular, Pause20Regular, Database20Regular,
  PlugConnected20Regular, CheckmarkCircle16Filled, ShieldTask20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { OneLakeSecurityTab } from './components/onelake-security-tab';
import { MirrorSourceWizard, type MirrorTableSpec } from './components/mirror-source-wizard';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  treePad: { padding: 8 },
  tableWrap: { overflow: 'auto', maxHeight: 320, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
});

interface WorkspaceLite { id: string; name: string; isOnDedicatedCapacity?: boolean; }
interface MirroredLite { id: string; displayName: string; description?: string; }

function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError(null); setHint(null);
    try {
      const r = await fetch('/api/loom/workspaces');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed'); setHint(j.hint || null); setWorkspaces([]); }
      else setWorkspaces(j.workspaces || []);
    } catch (e: any) { setError(e?.message || String(e)); setWorkspaces([]); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  return { workspaces, error, hint, loading };
}

function statusColor(status?: string): 'success' | 'warning' | 'severe' | 'informative' {
  if (!status) return 'severe';
  if (status === 'Running') return 'success';
  if (status === 'Initializing' || status === 'Stopping' || status === 'Initialized') return 'warning';
  if (status === 'Stopped') return 'informative';
  return 'severe';
}

interface Props { item: FabricItemType; id: string; }

export function MirroredDatabaseEditor({ item, id }: Props) {
  const s = useStyles();
  const ws = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [mirrors, setMirrors] = useState<MirroredLite[] | null>(null);
  const [mirrorId, setMirrorId] = useState('');
  const [detail, setDetail] = useState<any | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [listHint, setListHint] = useState<string | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  // Top-level view: the mirroring surface vs the OneLake Security (F7) tab.
  const [secView, setSecView] = useState<'mirror' | 'security'>('mirror');
  // Test-connection state.
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ intent: 'success' | 'error' | 'info'; text: string } | null>(null);

  // Wizard state — the create/edit flow lives in MirrorSourceWizard.
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [wizardInitial, setWizardInitial] = useState<
    { sourceType?: string; server?: string; database?: string; connectionId?: string; tables?: MirrorTableSpec[]; displayName?: string } | undefined
  >(undefined);

  const loadList = useCallback(async (wsId: string) => {
    setListErr(null); setListHint(null);
    try {
      const r = await fetch(`/api/items/mirrored-database?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setMirrors([]); setListErr(j.error); setListHint(j.hint); return; }
      setMirrors(j.mirroredDatabases || []);
      if ((j.mirroredDatabases || []).length && !mirrorId) setMirrorId(j.mirroredDatabases[0].id);
    } catch (e: any) { setMirrors([]); setListErr(e?.message || String(e)); }
  }, [mirrorId]);

  const loadDetail = useCallback(async (wsId: string, mId: string) => {
    setDetailErr(null); setActionMsg(null);
    try {
      const r = await fetch(`/api/items/mirrored-database/${encodeURIComponent(mId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDetailErr(j.error); return; }
      setDetail(j);
    } catch (e: any) { setDetailErr(e?.message || String(e)); }
  }, []);

  // Auto-pick the first workspace once loaded so the toolbar/ribbon actions
  // enable immediately (and the list fetch auto-selects the first mirror).
  useEffect(() => {
    if (!workspaceId && ws.workspaces && ws.workspaces.length > 0) setWorkspaceId(ws.workspaces[0].id);
  }, [workspaceId, ws.workspaces]);
  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && mirrorId) loadDetail(workspaceId, mirrorId); }, [workspaceId, mirrorId, loadDetail]);

  const act = useCallback(async (action: 'start' | 'stop') => {
    if (!workspaceId || !mirrorId) return;
    setActing(true); setActionMsg(null);
    try {
      const r = await fetch(`/api/items/mirrored-database/${encodeURIComponent(mirrorId)}/state?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!j.ok && !j.status) setActionMsg(`${action} failed: ${j.error || j.gate?.message || 'unknown error'}`);
      else {
        const receipt = j.cdcName ? ` ADF CDC: ${j.cdcName}.` : '';
        setActionMsg(`${action} accepted. Status: ${j.status?.mirroringStatus || 'unknown'}.${receipt}${j.gate ? ` ${j.gate.message}` : ''}`);
        loadDetail(workspaceId, mirrorId);
      }
    } finally { setActing(false); }
  }, [workspaceId, mirrorId, loadDetail]);

  // Open the wizard to CREATE a new mirror.
  const openNew = useCallback(() => {
    setEditing(false); setWizardInitial(undefined); setWizardOpen(true);
  }, []);

  // Open the wizard pre-filled to EDIT the selected mirror's config.
  const openEdit = useCallback(() => {
    const sc = (detail?.source || {}) as any;
    setEditing(true);
    setWizardInitial({
      sourceType: sc.sourceType || 'AzureSqlDatabase',
      server: sc.server || '',
      database: sc.database || '',
      connectionId: sc.connectionId || '',
      tables: Array.isArray(sc.tables) ? sc.tables : [],
      displayName: detail?.mirroredDatabase?.displayName || (mirrors || []).find((m) => m.id === mirrorId)?.displayName || '',
    });
    setWizardOpen(true);
  }, [detail, mirrors, mirrorId]);

  // Test the selected mirror's stored source connection (reuses /verify).
  const testConnection = useCallback(async () => {
    const sc = (detail?.source || {}) as any;
    if (!sc.server || !sc.database) { setTestMsg({ intent: 'error', text: 'This mirror has no source server/database set. Edit it first.' }); return; }
    setTesting(true); setTestMsg(null);
    try {
      const r = await fetch('/api/items/mirrored-database/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceType: sc.sourceType, server: sc.server, database: sc.database }),
      });
      const j = await r.json();
      if (j.ok && j.verified) setTestMsg({ intent: 'success', text: j.detail });
      else if (j.ok) setTestMsg({ intent: 'info', text: j.detail });
      else setTestMsg({ intent: 'error', text: j.hint ? `${j.error} — ${j.hint}` : (j.error || 'verification failed') });
    } catch (e: any) { setTestMsg({ intent: 'error', text: e?.message || String(e) }); }
    finally { setTesting(false); }
  }, [detail]);

  const del = useCallback(async () => {
    if (!workspaceId || !mirrorId) return;
    if (!confirm('Delete this mirrored database? This cannot be undone.')) return;
    await fetch(`/api/items/mirrored-database/${encodeURIComponent(mirrorId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
    setMirrorId(''); setDetail(null);
    await loadList(workspaceId);
  }, [workspaceId, mirrorId, loadList]);

  const status = detail?.status?.status as string | undefined;
  const tables = detail?.tables?.data as Array<any> | undefined;

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Item', actions: [
        { label: 'New mirror', onClick: workspaceId ? openNew : undefined, disabled: !workspaceId,
          title: !workspaceId ? 'Select a workspace first' : undefined },
        { label: 'Edit', onClick: mirrorId && detail ? openEdit : undefined, disabled: !mirrorId || !detail, title: 'Edit this mirror’s source config' },
        { label: 'Delete', onClick: mirrorId ? del : undefined, disabled: !mirrorId },
      ]},
      { label: 'Source', actions: [
        { label: 'Test connection', onClick: mirrorId && detail && !testing ? testConnection : undefined, disabled: !mirrorId || !detail || testing },
      ]},
      { label: 'Replication', actions: [
        { label: 'Start', onClick: mirrorId && !acting ? () => act('start') : undefined, disabled: !mirrorId || acting },
        { label: 'Stop', onClick: mirrorId && !acting ? () => act('stop') : undefined, disabled: !mirrorId || acting },
        { label: 'Status', onClick: workspaceId && mirrorId ? () => loadDetail(workspaceId, mirrorId) : undefined, disabled: !workspaceId || !mirrorId },
      ]},
      { label: 'List', actions: [
        { label: 'Refresh list', onClick: workspaceId ? () => loadList(workspaceId) : undefined, disabled: !workspaceId },
      ]},
    ]},
  ], [workspaceId, mirrorId, detail, acting, testing, del, act, loadDetail, loadList, openEdit, openNew, testConnection]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: 8 }}>Mirrored databases</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {workspaceId && mirrors === null && <Spinner size="tiny" label="Loading…" />}
          {mirrors && mirrors.length === 0 && !listErr && <Caption1>No mirrored databases.</Caption1>}
          <Tree aria-label="Mirrored databases">
            {(mirrors || []).map((m) => (
              <TreeItem key={m.id} itemType="leaf" value={m.id} onClick={() => setMirrorId(m.id)}>
                <TreeItemLayout iconBefore={<Database20Regular />}>
                  {mirrorId === m.id ? <strong>{m.displayName}</strong> : m.displayName}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <TabList selectedValue={secView} onTabSelect={(_, d) => setSecView(d.value as 'mirror' | 'security')}>
            <Tab value="mirror" icon={<Database20Regular />}>Mirroring</Tab>
            <Tab value="security" icon={<ShieldTask20Regular />}>Security</Tab>
          </TabList>
          {secView === 'security' && (
            <OneLakeSecurityTab itemId={id} itemType="mirrored-database" container="bronze" workspaceId={workspaceId || undefined} fabricItemId={mirrorId || undefined} />
          )}
          {secView === 'mirror' && (
          <>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Mirrored Database</Badge>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 280 }}>
              <Caption1>Workspace</Caption1>
              <Select value={workspaceId} onChange={(_, d) => setWorkspaceId(d.value)} disabled={ws.loading || (ws.workspaces?.length ?? 0) === 0}>
                {!workspaceId && <option value="">{ws.loading ? 'Loading workspaces…' : 'Select a workspace'}</option>}
                {(ws.workspaces || []).map((w) => (
                  <option key={w.id} value={w.id}>{w.name}{w.isOnDedicatedCapacity ? ' · F/P SKU' : ''}</option>
                ))}
              </Select>
            </div>
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh list</Button>
            <Button appearance="outline" icon={<Add20Regular />} disabled={!workspaceId} onClick={openNew}>New mirror</Button>
            {mirrorId && detail && <Button appearance="outline" icon={<PlugConnected20Regular />} onClick={openEdit}>Edit</Button>}
            {mirrorId && detail && <Button appearance="outline" icon={<CheckmarkCircle16Filled />} disabled={testing} onClick={testConnection}>{testing ? 'Testing…' : 'Test connection'}</Button>}
            <MirrorSourceWizard
              open={wizardOpen}
              editing={editing}
              workspaceId={workspaceId}
              mirrorId={editing ? mirrorId : undefined}
              initialSrc={wizardInitial}
              onClose={() => { setWizardOpen(false); setEditing(false); }}
              onCreated={async (newId) => {
                setWizardOpen(false); setEditing(false);
                if (workspaceId) await loadList(workspaceId);
                if (newId) setMirrorId(newId);
              }}
              onUpdated={async (mid) => {
                setWizardOpen(false); setEditing(false);
                if (workspaceId) await loadList(workspaceId);
                if (workspaceId && mid) loadDetail(workspaceId, mid);
              }}
            />
            <Button appearance="primary" icon={<Play20Regular />} disabled={!mirrorId || acting} onClick={() => act('start')}>Start</Button>
            <Button appearance="outline" icon={<Pause20Regular />} disabled={!mirrorId || acting} onClick={() => act('stop')}>Stop</Button>
            <Button appearance="subtle" icon={<Delete20Regular />} disabled={!mirrorId} onClick={del}>Delete</Button>
          </div>

          {(ws.error || listErr) && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Workspaces not reachable</MessageBarTitle>
                {ws.error || listErr}
                {(ws.hint || listHint) && <><br /><Caption1>{ws.hint || listHint}</Caption1></>}
              </MessageBarBody>
            </MessageBar>
          )}
          {!ws.loading && !ws.error && (ws.workspaces?.length ?? 0) === 0 && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>No workspaces yet</MessageBarTitle>
                Create a workspace first, then return here to mirror a database into it.
                <br />
                <Button appearance="primary" size="small" style={{ marginTop: 6 }}
                  onClick={() => { try { window.location.assign('/workspaces'); } catch { /* noop */ } }}>
                  Go to workspaces
                </Button>
              </MessageBarBody>
            </MessageBar>
          )}
          {detailErr && <MessageBar intent="error"><MessageBarBody>{detailErr}</MessageBarBody></MessageBar>}
          {actionMsg && <MessageBar intent="info"><MessageBarBody>{actionMsg}</MessageBarBody></MessageBar>}
          {testMsg && <MessageBar intent={testMsg.intent}><MessageBarBody><MessageBarTitle>Connection test</MessageBarTitle>{testMsg.text}</MessageBarBody></MessageBar>}
          {detail?.lastRun?.gate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Mirror not started</MessageBarTitle>
                {detail.lastRun.gate.message}
              </MessageBarBody>
            </MessageBar>
          )}
          {detail?.lastRun?.cdcName && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              ADF CDC: <code>{detail.lastRun.cdcName}</code> · landing <code>{detail.lastRun.basePath}</code>
            </Caption1>
          )}
          {detail?.source?.server && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Source: <strong>{detail.source.sourceType || 'SQL'}</strong> · <code>{detail.source.server}</code> / <code>{detail.source.database}</code>
              {detail.source.connectionId ? ' · Key Vault connection bound' : ''}
              {Array.isArray(detail.source.tables) && detail.source.tables.length ? ` · ${detail.source.tables.length} table(s) selected` : ''}
            </Caption1>
          )}

          {mirrorId && detail && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <Badge appearance="filled" color={statusColor(status)}>{status || 'Unknown'}</Badge>
                <Caption1>id: <code>{mirrorId.slice(0, 8)}</code></Caption1>
                {detail.status?.error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{detail.status.error}</Caption1>}
              </div>

              <Subtitle2>Tables replication ({tables?.length ?? 0})</Subtitle2>
              <div className={s.tableWrap}>
                <Table aria-label="Tables" size="small">
                  <TableHeader><TableRow>
                    <TableHeaderCell>Schema</TableHeaderCell>
                    <TableHeaderCell>Table</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Rows</TableHeaderCell>
                    <TableHeaderCell>Bytes</TableHeaderCell>
                    <TableHeaderCell>Last sync</TableHeaderCell>
                    <TableHeaderCell>Query</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {(!tables || tables.length === 0) && (
                      <TableRow><TableCell colSpan={7}>No tables status yet. Start mirroring to begin replication.</TableCell></TableRow>
                    )}
                    {(tables || []).map((t, i) => (
                      <TableRow key={`${t.sourceSchemaName || ''}.${t.sourceTableName || i}`}>
                        <TableCell>{t.sourceSchemaName || '—'}</TableCell>
                        <TableCell>{t.sourceTableName || '—'}</TableCell>
                        <TableCell>
                          {t.status || '—'}
                          {t.mode && (
                            <Badge
                              appearance="tint"
                              color={t.mode === 'incremental' ? 'success' : 'informative'}
                              size="small"
                              style={{ marginLeft: 6 }}
                              title={t.syncVersion != null ? `Change-tracking watermark: v${t.syncVersion}` : undefined}
                            >
                              {t.mode === 'incremental' ? 'Incremental' : 'Snapshot'}
                            </Badge>
                          )}
                          {t.note && <Caption1 style={{ display: 'block', color: tokens.colorNeutralForeground3 }}>{t.note}</Caption1>}
                          {t.error && <Caption1 style={{ display: 'block', color: tokens.colorPaletteRedForeground1 }}>{t.error}</Caption1>}
                        </TableCell>
                        <TableCell className={s.cell}>{t.metrics?.processedRows ?? '—'}{t.truncated ? ' (capped)' : ''}</TableCell>
                        <TableCell className={s.cell}>{t.metrics?.processedBytes ?? '—'}</TableCell>
                        <TableCell className={s.cell}>{t.metrics?.lastSyncDateTime || '—'}</TableCell>
                        <TableCell>
                          {t.openrowset
                            ? <Button size="small" appearance="subtle" onClick={() => { try { void navigator.clipboard.writeText(t.openrowset); setActionMsg(`Copied the Synapse Serverless query for ${t.sourceSchemaName}.${t.sourceTableName}. Paste it into a Synapse serverless SQL query.`); } catch { /* clipboard unavailable */ } }}>Copy SQL</Button>
                            : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
          </>
          )}
        </div>
      }
    />
  );
}
