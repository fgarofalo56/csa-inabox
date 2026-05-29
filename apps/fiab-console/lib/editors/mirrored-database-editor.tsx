'use client';

/**
 * MirroredDatabaseEditor — Fabric-native Mirrored Database editor wired
 * to live Fabric REST. Lists existing mirrored databases, shows mirroring
 * status + per-table replication metrics, and supports start/stop.
 *
 * Create wizard captures: source type (Snowflake, AzureSqlDatabase,
 * AzureSqlMI, AzurePostgreSql, CosmosDb, SqlServer2025, MSSQL,
 * GenericMirror), server, database, and posts the minimal MirroredDatabase
 * definition (mirroring.json inline-base64).
 *
 * Auth gate: requires Console UAMI SP authorized in the Fabric tenant and
 * added to the target workspace. Underlying 401/403 surface verbatim.
 *
 * Backed by /api/loom/workspaces + /api/items/mirrored-database/**.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Input,
  Tree, TreeItem, TreeItemLayout, Select,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Delete20Regular, Play20Regular, Pause20Regular, Database20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const SOURCES = [
  { id: 'AzureSqlDatabase', name: 'Azure SQL Database' },
  { id: 'AzureSqlMI', name: 'Azure SQL Managed Instance' },
  { id: 'AzurePostgreSql', name: 'Azure Database for PostgreSQL' },
  { id: 'CosmosDb', name: 'Azure Cosmos DB' },
  { id: 'Snowflake', name: 'Snowflake' },
  { id: 'SqlServer2025', name: 'SQL Server 2025' },
  { id: 'MSSQL', name: 'SQL Server 2016-2022' },
  { id: 'GenericMirror', name: 'Open mirroring' },
];

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  treePad: { padding: 8 },
  tableWrap: { overflow: 'auto', maxHeight: 320, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 },
  card: { padding: 10, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, cursor: 'pointer', backgroundColor: tokens.colorNeutralBackground1 },
  cardActive: { borderColor: tokens.colorBrandStroke1, backgroundColor: tokens.colorBrandBackground2 },
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

function toB64(s: string): string {
  return typeof window === 'undefined' ? Buffer.from(s, 'utf-8').toString('base64')
    : btoa(unescape(encodeURIComponent(s)));
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

  // create wizard
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createSrc, setCreateSrc] = useState('AzureSqlDatabase');
  const [createServer, setCreateServer] = useState('');
  const [createDb, setCreateDb] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

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

  // Auto-pick the first workspace once loaded so "New mirror" / "Refresh list"
  // enable immediately (and the list fetch auto-selects the first mirror,
  // enabling Start / Stop / Status / Delete) instead of every button sitting
  // disabled behind a manual workspace pick. Matches the Eventstream/Activator
  // auto-pick pattern. Users can still switch via the picker.
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
      if (!j.ok) setActionMsg(`${action} failed: ${j.error}`);
      else { setActionMsg(`${action} accepted. Status: ${j.status?.status || 'unknown'}`); loadDetail(workspaceId, mirrorId); }
    } finally { setActing(false); }
  }, [workspaceId, mirrorId, loadDetail]);

  const create = useCallback(async () => {
    if (!workspaceId || !createName.trim()) return;
    setCreateBusy(true); setCreateErr(null);
    try {
      const mirroringDef = {
        properties: {
          source: { type: createSrc, typeProperties: { server: createServer, database: createDb } },
          target: { type: 'MountedRelationalDatabase', typeProperties: { format: 'Delta' } },
        },
      };
      const definition = {
        parts: [{ path: 'mirroring.json', payload: toB64(JSON.stringify(mirroringDef, null, 2)), payloadType: 'InlineBase64' }],
      };
      const r = await fetch(`/api/items/mirrored-database?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: createName.trim(), definition }),
      });
      const j = await r.json();
      if (!j.ok) { setCreateErr(j.error || 'create failed'); return; }
      setCreateOpen(false); setCreateName(''); setCreateServer(''); setCreateDb('');
      await loadList(workspaceId);
      if (j.mirroredDatabase?.id) setMirrorId(j.mirroredDatabase.id);
    } finally { setCreateBusy(false); }
  }, [workspaceId, createName, createSrc, createServer, createDb, loadList]);

  const del = useCallback(async () => {
    if (!workspaceId || !mirrorId) return;
    if (!confirm('Delete this mirrored database? This cannot be undone.')) return;
    await fetch(`/api/items/mirrored-database/${encodeURIComponent(mirrorId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
    setMirrorId(''); setDetail(null);
    await loadList(workspaceId);
  }, [workspaceId, mirrorId, loadList]);

  const status = detail?.status?.status as string | undefined;
  const tables = detail?.tables?.data as Array<any> | undefined;

  // Dynamic ribbon wired to the real handlers. The primary action is
  // "New mirror" — enabled as soon as a workspace is selected (it opens the
  // create dialog which POSTs a real Fabric MirroredDatabase). Start / Stop /
  // Status / Delete enable once a mirror is selected.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Item', actions: [
        { label: 'New mirror', onClick: workspaceId ? () => setCreateOpen(true) : undefined, disabled: !workspaceId,
          title: !workspaceId ? 'Select a workspace first' : undefined },
        { label: 'Delete', onClick: mirrorId ? del : undefined, disabled: !mirrorId },
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
  ], [workspaceId, mirrorId, acting, del, act, loadDetail, loadList]);

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
            <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="outline" icon={<Add20Regular />} disabled={!workspaceId}>New mirror</Button>
              </DialogTrigger>
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>Create mirrored database</DialogTitle>
                  <DialogContent>
                    <Caption1>displayName</Caption1>
                    <Input value={createName} onChange={(_, d) => setCreateName(d.value)} style={{ width: '100%' }} />
                    <Caption1 style={{ marginTop: 8 }}>Source type</Caption1>
                    <div className={s.grid}>
                      {SOURCES.map((src) => (
                        <div key={src.id} className={`${s.card} ${createSrc === src.id ? s.cardActive : ''}`} onClick={() => setCreateSrc(src.id)}>
                          <Body1 style={{ fontWeight: 600 }}>{src.name}</Body1>
                          <Caption1>{src.id}</Caption1>
                        </div>
                      ))}
                    </div>
                    <Caption1 style={{ marginTop: 8 }}>Server</Caption1>
                    <Input value={createServer} onChange={(_, d) => setCreateServer(d.value)} placeholder="server.database.windows.net" style={{ width: '100%' }} />
                    <Caption1 style={{ marginTop: 8 }}>Database</Caption1>
                    <Input value={createDb} onChange={(_, d) => setCreateDb(d.value)} placeholder="prod" style={{ width: '100%' }} />
                    {createErr && <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody>{createErr}</MessageBarBody></MessageBar>}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                    <Button appearance="primary" disabled={createBusy || !createName.trim()} onClick={create}>{createBusy ? 'Creating…' : 'Create'}</Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
            <Button appearance="primary" icon={<Play20Regular />} disabled={!mirrorId || acting} onClick={() => act('start')}>Start</Button>
            <Button appearance="outline" icon={<Pause20Regular />} disabled={!mirrorId || acting} onClick={() => act('stop')}>Stop</Button>
            <Button appearance="subtle" icon={<Delete20Regular />} disabled={!mirrorId} onClick={del}>Delete</Button>
          </div>

          {(ws.error || listErr) && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Fabric not reachable</MessageBarTitle>
                {ws.error || listErr}
                {(ws.hint || listHint) && <><br /><Caption1>{ws.hint || listHint}</Caption1></>}
              </MessageBarBody>
            </MessageBar>
          )}
          {!ws.loading && !ws.error && (ws.workspaces?.length ?? 0) === 0 && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>No workspaces yet</MessageBarTitle>
                Create a Fabric workspace first, then return here to mirror a database into it.
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
                  </TableRow></TableHeader>
                  <TableBody>
                    {(!tables || tables.length === 0) && (
                      <TableRow><TableCell colSpan={6}>No tables status yet. Start mirroring to begin replication.</TableCell></TableRow>
                    )}
                    {(tables || []).map((t, i) => (
                      <TableRow key={`${t.sourceSchemaName || ''}.${t.sourceTableName || i}`}>
                        <TableCell>{t.sourceSchemaName || '—'}</TableCell>
                        <TableCell>{t.sourceTableName || '—'}</TableCell>
                        <TableCell>{t.status || '—'}</TableCell>
                        <TableCell className={s.cell}>{t.metrics?.processedRows ?? '—'}</TableCell>
                        <TableCell className={s.cell}>{t.metrics?.processedBytes ?? '—'}</TableCell>
                        <TableCell className={s.cell}>{t.metrics?.lastSyncDateTime || '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>
      }
    />
  );
}
