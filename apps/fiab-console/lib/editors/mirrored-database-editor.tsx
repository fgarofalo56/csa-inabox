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
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Input, Field, Dropdown, Option, Divider, Checkbox,
  Tree, TreeItem, TreeItemLayout, Select, Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Delete20Regular, Play20Regular, Pause20Regular, Database20Regular,
  PlugConnected20Regular, Key16Regular, CheckmarkCircle16Filled, ShieldTask20Regular,
  Eye20Regular, Stop20Regular, ArrowCounterclockwise20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { OneLakeSecurityTab } from './components/onelake-security-tab';
import { ConnectionBuilder, type ConnectionView } from '@/lib/components/connections/connection-builder';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

/**
 * Mirroring source types → display name, an accent color, and the Loom
 * Connection types that can back them. Each gets its own card in the wizard.
 */
const SOURCES: { id: string; name: string; accent: string; connTypes: string[] }[] = [
  { id: 'AzureSqlDatabase', name: 'Azure SQL Database', accent: '#0078d4', connTypes: ['azure-sql', 'generic-sql'] },
  { id: 'AzureSqlMI', name: 'Azure SQL Managed Instance', accent: '#0063b1', connTypes: ['azure-sql', 'generic-sql'] },
  { id: 'AzurePostgreSql', name: 'Azure Database for PostgreSQL', accent: '#336791', connTypes: ['postgres'] },
  { id: 'CosmosDb', name: 'Azure Cosmos DB', accent: '#3999c6', connTypes: ['cosmos'] },
  { id: 'Snowflake', name: 'Snowflake', accent: '#29b5e8', connTypes: ['generic-sql', 'connection-string' as string] },
  { id: 'SqlServer2025', name: 'SQL Server 2025', accent: '#a4262c', connTypes: ['generic-sql'] },
  { id: 'MSSQL', name: 'SQL Server 2016-2022', accent: '#a4262c', connTypes: ['generic-sql'] },
  { id: 'GenericMirror', name: 'Open mirroring', accent: '#5c2d91', connTypes: ['azure-sql', 'postgres', 'cosmos', 'storage-adls', 'generic-sql'] },
];

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  treePad: { padding: 8 },
  tableWrap: { overflow: 'auto', maxHeight: 320, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: tokens.spacingHorizontalS },
  // Web-3.0 source cards: left accent bar, icon tile, hover lift, selected ring.
  card: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge, cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderLeftWidth: '4px',
    backgroundColor: tokens.colorNeutralBackground1,
    transitionProperty: 'transform, box-shadow', transitionDuration: tokens.durationFaster,
    ':hover': { transform: 'translateY(-2px)', boxShadow: tokens.shadow8 },
  },
  cardActive: { outline: `2px solid ${tokens.colorBrandStroke1}`, outlineOffset: '-1px', backgroundColor: tokens.colorBrandBackground2 },
  cardIcon: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '34px', height: '34px', flexShrink: 0, borderRadius: tokens.borderRadiusMedium, color: '#fff' },
  wizard: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: '560px', maxWidth: '640px' },
  stepHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  stepNum: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '22px', height: '22px', borderRadius: '50%', backgroundColor: tokens.colorBrandBackground, color: tokens.colorNeutralForegroundOnBrand, fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold },
  connRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  summary: { display: 'grid', gridTemplateColumns: '110px 1fr', rowGap: tokens.spacingVerticalXS, columnGap: tokens.spacingHorizontalM, padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground2 },
  sumKey: { color: tokens.colorNeutralForeground3 },
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
  // Top-level view: the mirroring surface, the Monitor (status/rows/last-sync)
  // tab, or the OneLake Security (F7) tab.
  const [view, setView] = useState<'mirror' | 'monitor' | 'security'>('mirror');
  // Monitor tab — auto-refreshing per-table replication status (real backend).
  const [monitorData, setMonitorData] = useState<any | null>(null);
  const [monitorErr, setMonitorErr] = useState<string | null>(null);
  const [monitorLoading, setMonitorLoading] = useState(false);
  // Lifecycle (Stop/Start/Restart) — confirm dialog + before/after receipt.
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleMsg, setLifecycleMsg] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<'stop' | 'restart' | null>(null);
  // Edit-existing-mirror + Test-connection state.
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ intent: 'success' | 'error' | 'info'; text: string } | null>(null);

  // create wizard
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createSrc, setCreateSrc] = useState('AzureSqlDatabase');
  const [createServer, setCreateServer] = useState('');
  const [createDb, setCreateDb] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [verify, setVerify] = useState<{ status: 'idle' | 'busy' | 'ok' | 'warn' | 'err'; msg?: string }>({ status: 'idle' });
  // Loom Connections (Key Vault-backed creds) for the wizard's auth step.
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [connId, setConnId] = useState('');
  const [connBuilderOpen, setConnBuilderOpen] = useState(false);
  // Table/container selection (optional subset; empty = mirror everything).
  const [availTables, setAvailTables] = useState<{ schema: string; table: string }[] | null>(null);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tablesMsg, setTablesMsg] = useState<string | null>(null);
  const [selTables, setSelTables] = useState<Set<string>>(new Set());
  const tkey = (t: { schema: string; table: string }) => `${t.schema}.${t.table}`;
  const loadSourceTables = useCallback(async () => {
    if (!createServer.trim() && createSrc !== 'CosmosDb') { setTablesMsg('Enter the server/host and database first.'); return; }
    if (!createDb.trim()) { setTablesMsg('Enter the database first.'); return; }
    setTablesLoading(true); setTablesMsg(null); setAvailTables(null);
    try {
      const r = await fetch('/api/items/mirrored-database/source-tables', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceType: createSrc, server: createServer.trim(), database: createDb.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setTablesMsg(j.error || 'Could not list tables.'); setAvailTables([]); return; }
      setAvailTables(j.tables || []);
      if (!(j.tables || []).length) setTablesMsg('No tables found.');
    } catch (e: any) { setTablesMsg(e?.message || String(e)); setAvailTables([]); }
    finally { setTablesLoading(false); }
  }, [createSrc, createServer, createDb]);
  const srcDef = useMemo(() => SOURCES.find((x) => x.id === createSrc) || SOURCES[0], [createSrc]);
  const loadConnections = useCallback(async () => {
    try {
      const r = await fetch('/api/connections');
      const j = await r.json();
      if (j.ok) setConnections(j.connections || []);
    } catch { /* honest empty */ }
  }, []);
  useEffect(() => { if (createOpen) void loadConnections(); }, [createOpen, loadConnections]);
  // Compatible connections for the chosen source type.
  const compatibleConns = useMemo(
    () => connections.filter((c) => srcDef.connTypes.includes(c.type)),
    [connections, srcDef],
  );
  const pickedConn = useMemo(() => connections.find((c) => c.id === connId) || null, [connections, connId]);
  // When a connection is picked, prefill server/database from it.
  useEffect(() => {
    if (pickedConn) {
      if (pickedConn.host) setCreateServer(pickedConn.host);
      if (pickedConn.database) setCreateDb(pickedConn.database);
    }
  }, [pickedConn]);
  const runVerify = useCallback(async () => {
    if (!createServer.trim() || !createDb.trim()) { setVerify({ status: 'err', msg: 'Enter the server and database first.' }); return; }
    setVerify({ status: 'busy' });
    try {
      const r = await fetch('/api/items/mirrored-database/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceType: createSrc, server: createServer.trim(), database: createDb.trim() }),
      });
      const j = await r.json();
      if (j.ok && j.verified) setVerify({ status: 'ok', msg: j.detail });
      else if (j.ok) setVerify({ status: 'warn', msg: j.detail });
      else setVerify({ status: 'err', msg: j.hint ? `${j.error} — ${j.hint}` : (j.error || 'verification failed') });
    } catch (e: any) { setVerify({ status: 'err', msg: e?.message || String(e) }); }
  }, [createSrc, createServer, createDb]);

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

  // Monitor tab — pull the real per-table replication snapshot (status, true row
  // counts, last-sync, ADLS landing probe, ADF run telemetry). GET, no side effects.
  const loadMonitor = useCallback(async () => {
    if (!workspaceId || !mirrorId) return;
    setMonitorLoading(true); setMonitorErr(null);
    try {
      const r = await fetch(`/api/items/mirrored-database/${encodeURIComponent(mirrorId)}/monitor?workspaceId=${encodeURIComponent(workspaceId)}`);
      const j = await r.json();
      if (!j.ok) { setMonitorErr(j.error || 'monitor failed'); return; }
      setMonitorData(j);
    } catch (e: any) { setMonitorErr(e?.message || String(e)); }
    finally { setMonitorLoading(false); }
  }, [workspaceId, mirrorId]);

  // Auto-refresh the Monitor grid every 30 s while the Monitor tab is open.
  useEffect(() => {
    if (view !== 'monitor' || !workspaceId || !mirrorId) return;
    void loadMonitor();
    const t = setInterval(() => void loadMonitor(), 30_000);
    return () => clearInterval(t);
  }, [view, workspaceId, mirrorId, loadMonitor]);

  // Lifecycle control — stop / start / restart with a before/after receipt.
  const lifecycle = useCallback(async (action: 'stop' | 'start' | 'restart') => {
    if (!workspaceId || !mirrorId) return;
    setLifecycleBusy(true); setLifecycleMsg(null);
    try {
      const r = await fetch(
        `/api/items/mirrored-database/${encodeURIComponent(mirrorId)}/lifecycle?workspaceId=${encodeURIComponent(workspaceId)}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) },
      );
      const j = await r.json();
      if (!j.ok) { setLifecycleMsg(`${action} ${j.gate ? 'gated' : 'failed'}: ${j.gate?.message || j.error}`); await loadMonitor(); return; }
      setLifecycleMsg(`${action} accepted. Status: before=${j.before?.mirroringStatus} → after=${j.after?.mirroringStatus}${j.adfLastRun ? ` · ADF run ${j.adfLastRun.status}` : ''}`);
      await loadMonitor();
      void loadDetail(workspaceId, mirrorId);
    } catch (e: any) { setLifecycleMsg(e?.message || String(e)); }
    finally { setLifecycleBusy(false); }
  }, [workspaceId, mirrorId, loadMonitor, loadDetail]);

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
      // connectionId binds the Key Vault-backed creds so the source accepts the
      // connection (avoids the Entra-token-only "Login failed" error). server /
      // database are persisted flat so the mirror engine can read them on Start.
      const payload = {
        displayName: createName.trim(), definition, sourceType: createSrc,
        server: createServer.trim(), database: createDb.trim(),
        connectionId: connId || undefined,
        // Selected subset (empty = mirror everything the engine discovers).
        tables: (availTables || []).filter((t) => selTables.has(tkey(t))),
      };
      // Edit an existing mirror (PATCH) vs. create a new one (POST).
      const r = editing && mirrorId
        ? await fetch(`/api/items/mirrored-database/${encodeURIComponent(mirrorId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
            method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
          })
        : await fetch(`/api/items/mirrored-database?workspaceId=${encodeURIComponent(workspaceId)}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
          });
      const j = await r.json();
      if (!j.ok) { setCreateErr(j.error || (editing ? 'save failed' : 'create failed')); return; }
      setCreateOpen(false); setEditing(false); setCreateName(''); setCreateServer(''); setCreateDb(''); setConnId('');
      await loadList(workspaceId);
      const newId = j.mirroredDatabase?.id;
      if (newId) setMirrorId(newId);
      if (editing && workspaceId && mirrorId) loadDetail(workspaceId, mirrorId);
    } finally { setCreateBusy(false); }
  }, [workspaceId, createName, createSrc, createServer, createDb, connId, editing, mirrorId, availTables, selTables, loadList, loadDetail]);

  // Open the wizard pre-filled to EDIT the selected mirror's config.
  const openEdit = useCallback(() => {
    const sc = (detail?.source || {}) as any;
    setEditing(true);
    setCreateName(detail?.mirroredDatabase?.displayName || (mirrors || []).find((m) => m.id === mirrorId)?.displayName || '');
    setCreateSrc(sc.sourceType || 'AzureSqlDatabase');
    setCreateServer(sc.server || '');
    setCreateDb(sc.database || '');
    setConnId(sc.connectionId || '');
    setCreateErr(null);
    // Prefill the stored table subset so re-loading shows them checked.
    const stored = Array.isArray(sc.tables) ? sc.tables : [];
    setSelTables(new Set(stored.map((t: any) => `${t.schema}.${t.table}`)));
    setAvailTables(null); setTablesMsg(null);
    setCreateOpen(true);
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

  // Dynamic ribbon wired to the real handlers. The primary action is
  // "New mirror" — enabled as soon as a workspace is selected (it opens the
  // create dialog which POSTs a real Fabric MirroredDatabase). Start / Stop /
  // Status / Delete enable once a mirror is selected.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Item', actions: [
        { label: 'New mirror', onClick: workspaceId ? () => { setEditing(false); setCreateOpen(true); } : undefined, disabled: !workspaceId,
          title: !workspaceId ? 'Select a workspace first' : undefined },
        { label: 'Edit', onClick: mirrorId && detail ? openEdit : undefined, disabled: !mirrorId || !detail, title: 'Edit this mirror’s source config' },
        { label: 'Delete', onClick: mirrorId ? del : undefined, disabled: !mirrorId },
      ]},
      { label: 'Source', actions: [
        { label: 'Test connection', onClick: mirrorId && detail && !testing ? testConnection : undefined, disabled: !mirrorId || !detail || testing },
      ]},
      { label: 'Replication', actions: [
        { label: 'Start', onClick: mirrorId && !lifecycleBusy ? () => lifecycle('start') : undefined, disabled: !mirrorId || lifecycleBusy },
        { label: 'Stop', onClick: mirrorId && !lifecycleBusy ? () => setConfirmAction('stop') : undefined, disabled: !mirrorId || lifecycleBusy },
        { label: 'Restart', onClick: mirrorId && !lifecycleBusy ? () => setConfirmAction('restart') : undefined, disabled: !mirrorId || lifecycleBusy },
        { label: 'Monitor', onClick: workspaceId && mirrorId ? () => { setView('monitor'); void loadMonitor(); } : undefined, disabled: !workspaceId || !mirrorId },
      ]},
      { label: 'List', actions: [
        { label: 'Refresh list', onClick: workspaceId ? () => loadList(workspaceId) : undefined, disabled: !workspaceId },
      ]},
    ]},
  ], [workspaceId, mirrorId, detail, acting, testing, lifecycleBusy, del, act, lifecycle, loadDetail, loadList, loadMonitor, openEdit, testConnection]);

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
          <TabList selectedValue={view} onTabSelect={(_, d) => setView(d.value as 'mirror' | 'monitor' | 'security')}>
            <Tab value="mirror" icon={<Database20Regular />}>Mirroring</Tab>
            <Tab value="monitor" icon={<Eye20Regular />}>Monitor</Tab>
            <Tab value="security" icon={<ShieldTask20Regular />}>Security</Tab>
          </TabList>
          {view === 'security' && (
            <OneLakeSecurityTab itemId={id} itemType="mirrored-database" container="bronze" workspaceId={workspaceId || undefined} fabricItemId={mirrorId || undefined} />
          )}
          {view === 'monitor' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className={s.toolbar}>
                <Badge appearance="filled" color="brand">Replication monitor</Badge>
                <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={monitorLoading || !mirrorId} onClick={() => void loadMonitor()}>
                  {monitorLoading ? 'Refreshing…' : 'Refresh'}
                </Button>
                {monitorData?.mirroringStatus && (
                  <Badge appearance="filled" color={statusColor(monitorData.mirroringStatus)}>{monitorData.mirroringStatus}</Badge>
                )}
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Auto-refresh every 30 s</Caption1>
                {lifecycleBusy && <Spinner size="tiny" label="Working…" />}
              </div>

              {/* Lifecycle controls — Stop/Start/Restart with confirm for the destructive ones. */}
              <div className={s.toolbar}>
                <Button appearance="primary" icon={<Play20Regular />} disabled={!mirrorId || lifecycleBusy} onClick={() => void lifecycle('start')}>Start</Button>
                <Button appearance="outline" icon={<Stop20Regular />} disabled={!mirrorId || lifecycleBusy} onClick={() => setConfirmAction('stop')}>Stop</Button>
                <Button appearance="outline" icon={<ArrowCounterclockwise20Regular />} disabled={!mirrorId || lifecycleBusy} onClick={() => setConfirmAction('restart')}>Restart</Button>
              </div>

              {/* ADF pipeline-run telemetry bar (provisioner-backed Bronze-copy pipeline). */}
              {monitorData?.adfLastRun && (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                  ADF pipeline <strong>{monitorData.adfLastRun.pipelineName}</strong> · last run <strong>{monitorData.adfLastRun.status}</strong>
                  {monitorData.adfLastRun.runStart ? ` · started ${new Date(monitorData.adfLastRun.runStart).toLocaleString()}` : ''}
                  {monitorData.adfLastRun.durationMs != null ? ` · ${Math.round(monitorData.adfLastRun.durationMs / 1000)}s` : ''}
                </Caption1>
              )}

              {/* Confirm dialog — Stop or Restart. */}
              <Dialog open={!!confirmAction} onOpenChange={(_, d) => { if (!d.open) setConfirmAction(null); }}>
                <DialogSurface>
                  <DialogBody>
                    <DialogTitle>Confirm {confirmAction}</DialogTitle>
                    <DialogContent>
                      {confirmAction === 'stop' && 'Stop replication? Landed data and change-tracking watermarks remain. New source changes will not replicate until you Start. Start to resume.'}
                      {confirmAction === 'restart' && 'Restart replication? All per-table change-tracking watermarks are cleared, so every table is re-snapshotted from scratch on the next run.'}
                    </DialogContent>
                    <DialogActions>
                      <Button appearance="secondary" onClick={() => setConfirmAction(null)}>Cancel</Button>
                      <Button appearance="primary" disabled={lifecycleBusy}
                        onClick={() => { const a = confirmAction!; setConfirmAction(null); void lifecycle(a); }}>
                        {confirmAction === 'stop' ? 'Stop' : 'Restart'}
                      </Button>
                    </DialogActions>
                  </DialogBody>
                </DialogSurface>
              </Dialog>

              {lifecycleMsg && <MessageBar intent="info"><MessageBarBody>{lifecycleMsg}</MessageBarBody></MessageBar>}
              {monitorErr && <MessageBar intent="error"><MessageBarBody>{monitorErr}</MessageBarBody></MessageBar>}
              {!mirrorId && <Caption1>Select a mirrored database from the left panel to view monitor data.</Caption1>}

              {/* Per-table replication monitor grid (real backend). */}
              {monitorData?.tables && (
                <div className={s.tableWrap}>
                  <Table aria-label="Replication monitor" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Table</TableHeaderCell>
                      <TableHeaderCell>Status</TableHeaderCell>
                      <TableHeaderCell>Rows</TableHeaderCell>
                      <TableHeaderCell>Landing files</TableHeaderCell>
                      <TableHeaderCell>Last sync</TableHeaderCell>
                      <TableHeaderCell>Error / Note</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {(monitorData.tables as any[]).length === 0 && (
                        <TableRow><TableCell colSpan={6}>No tables yet. Start mirroring to populate this view.</TableCell></TableRow>
                      )}
                      {(monitorData.tables as any[]).map((t: any, i: number) => (
                        <TableRow key={`${t.schema}.${t.table}.${i}`}>
                          <TableCell className={s.cell}>{t.schema}.{t.table}</TableCell>
                          <TableCell>
                            <Badge appearance="tint" size="small"
                              color={t.status === 'Replicated' ? 'success' : t.status === 'Error' ? 'severe' : 'informative'}>
                              {t.status}
                            </Badge>
                            {t.mode && (
                              <Badge appearance="outline" size="small" style={{ marginLeft: 6 }}
                                color={t.mode === 'incremental' ? 'success' : 'informative'}>
                                {t.mode === 'incremental' ? 'Incremental' : 'Snapshot'}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className={s.cell}>{typeof t.rows === 'number' ? t.rows : '—'}</TableCell>
                          <TableCell className={s.cell}>
                            {t.landingFiles != null ? `${t.landingFiles} file${t.landingFiles === 1 ? '' : 's'}` : '—'}
                            {t.landingBytes != null ? ` (${Math.round(t.landingBytes / 1024)} KB)` : ''}
                          </TableCell>
                          <TableCell className={s.cell}>{t.lastSync ? new Date(t.lastSync).toLocaleString() : '—'}</TableCell>
                          <TableCell>
                            {t.error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{t.error}</Caption1>}
                            {t.note && !t.error && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{t.note}</Caption1>}
                            {!t.error && !t.note && '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {monitorData?.note && (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{monitorData.note}</Caption1>
              )}
            </div>
          )}
          {view === 'mirror' && (
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
            <Button appearance="outline" icon={<Add20Regular />} disabled={!workspaceId} onClick={() => { setEditing(false); setCreateName(''); setCreateServer(''); setCreateDb(''); setConnId(''); setCreateErr(null); setAvailTables(null); setSelTables(new Set()); setTablesMsg(null); setCreateOpen(true); }}>New mirror</Button>
            {mirrorId && detail && <Button appearance="outline" icon={<PlugConnected20Regular />} onClick={openEdit}>Edit</Button>}
            {mirrorId && detail && <Button appearance="outline" icon={<CheckmarkCircle16Filled />} disabled={testing} onClick={testConnection}>{testing ? 'Testing…' : 'Test connection'}</Button>}
            <Dialog open={createOpen} onOpenChange={(_, d) => { setCreateOpen(d.open); if (!d.open) setEditing(false); }}>
              <DialogSurface style={{ maxWidth: '680px' }}>
                <DialogBody>
                  <DialogTitle><span className={s.connRow}><Database20Regular /> {editing ? 'Edit mirrored database' : 'Create mirrored database'}</span></DialogTitle>
                  <DialogContent>
                    <div className={s.wizard}>
                      {/* Step 1 — source type (icon cards) */}
                      <div>
                        <div className={s.stepHead}><span className={s.stepNum}>1</span><Subtitle2>Choose a source</Subtitle2></div>
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Each source mirrors into ADLS Bronze Delta — no Fabric capacity required.</Caption1>
                        <div className={s.grid} style={{ marginTop: 8 }}>
                          {SOURCES.map((src) => (
                            <div key={src.id} className={`${s.card} ${createSrc === src.id ? s.cardActive : ''}`}
                              style={{ borderLeftColor: src.accent }}
                              onClick={() => { setCreateSrc(src.id); setConnId(''); setAvailTables(null); setSelTables(new Set()); setTablesMsg(null); }} role="button" tabIndex={0}>
                              <span className={s.cardIcon} style={{ backgroundColor: src.accent }}><Database20Regular /></span>
                              <span><Body1 style={{ fontWeight: 600, display: 'block' }}>{src.name}</Body1></span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <Divider />

                      {/* Step 2 — connection (Key Vault-backed auth) */}
                      <div>
                        <div className={s.stepHead}><span className={s.stepNum}>2</span><Subtitle2>Connection &amp; authentication</Subtitle2></div>
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                          Pick a saved connection or create one. Credentials are stored in Key Vault — choose SQL password /
                          connection string / service principal so the source accepts the login (no “token-identified principal” errors).
                        </Caption1>
                        <div className={s.connRow} style={{ marginTop: 8 }}>
                          <Field style={{ flex: 1 }}>
                            <Dropdown placeholder={compatibleConns.length ? 'Select a connection' : 'No saved connections for this source'}
                              value={pickedConn ? pickedConn.name : ''} selectedOptions={connId ? [connId] : []}
                              onOptionSelect={(_, d) => setConnId(d.optionValue || '')}>
                              {compatibleConns.map((c) => (
                                <Option key={c.id} value={c.id} text={c.name}>
                                  {c.name} · {c.authMethod}{c.hasSecret ? ' · Key Vault' : ''}
                                </Option>
                              ))}
                            </Dropdown>
                          </Field>
                          <Button appearance="outline" icon={<PlugConnected20Regular />} onClick={() => setConnBuilderOpen(true)}>New connection</Button>
                        </div>
                        {pickedConn && (
                          <div className={s.connRow} style={{ marginTop: 6 }}>
                            {pickedConn.hasSecret ? <Key16Regular /> : <CheckmarkCircle16Filled style={{ color: tokens.colorPaletteGreenForeground1 }} />}
                            <Caption1>Auth: <strong>{pickedConn.authMethod}</strong>{pickedConn.hasSecret ? ' (secret in Key Vault)' : ''}</Caption1>
                          </div>
                        )}
                        {/* Manual server/db (used when no connection, or to confirm) */}
                        <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
                          <Field label="Server / host" style={{ flex: 1 }}>
                            <Input value={createServer} onChange={(_, d) => setCreateServer(d.value)} placeholder="server.database.windows.net" disabled={!!pickedConn?.host} />
                          </Field>
                          <Field label="Database" style={{ flex: 1 }}>
                            <Input value={createDb} onChange={(_, d) => { setCreateDb(d.value); setVerify({ status: 'idle' }); }} placeholder="prod" disabled={!!pickedConn?.database} />
                          </Field>
                        </div>
                        <div style={{ marginTop: 10 }}>
                          <Button size="small" appearance="outline" icon={<CheckmarkCircle16Filled />} disabled={verify.status === 'busy'} onClick={runVerify}>
                            {verify.status === 'busy' ? 'Verifying…' : 'Verify connection'}
                          </Button>
                        </div>
                        {verify.status === 'ok' && <MessageBar intent="success" style={{ marginTop: 8 }}><MessageBarBody>{verify.msg}</MessageBarBody></MessageBar>}
                        {verify.status === 'warn' && <MessageBar intent="info" style={{ marginTop: 8 }}><MessageBarBody>{verify.msg}</MessageBarBody></MessageBar>}
                        {verify.status === 'err' && <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody>{verify.msg}</MessageBarBody></MessageBar>}
                      </div>

                      <Divider />

                      {/* Step 3 — tables to mirror (optional subset) */}
                      <div>
                        <div className={s.stepHead}><span className={s.stepNum}>3</span><Subtitle2>Tables to mirror</Subtitle2></div>
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                          Optional — leave all unchecked to mirror <strong>every</strong> table the engine discovers. Or load + pick a subset.
                        </Caption1>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                          <Button size="small" appearance="outline" icon={<ArrowSync20Regular />} disabled={tablesLoading} onClick={loadSourceTables}>
                            {tablesLoading ? 'Loading…' : 'Load tables'}
                          </Button>
                          {availTables && availTables.length > 0 && (
                            <>
                              <Caption1>{selTables.size} of {availTables.length} selected</Caption1>
                              <Button size="small" appearance="subtle" onClick={() => setSelTables(new Set(availTables.map(tkey)))}>All</Button>
                              <Button size="small" appearance="subtle" onClick={() => setSelTables(new Set())}>None</Button>
                            </>
                          )}
                        </div>
                        {tablesMsg && <Caption1 style={{ display: 'block', marginTop: 6, color: tokens.colorNeutralForeground3 }}>{tablesMsg}</Caption1>}
                        {availTables && availTables.length > 0 && (
                          <div className={s.tableWrap} style={{ maxHeight: 180, marginTop: 8 }}>
                            <Table size="small" aria-label="Source tables">
                              <TableBody>
                                {availTables.map((t) => {
                                  const k = tkey(t);
                                  return (
                                    <TableRow key={k}>
                                      <TableCell style={{ width: 36 }}>
                                        <Checkbox checked={selTables.has(k)} onChange={(_, d) => setSelTables((prev) => { const n = new Set(prev); if (d.checked) n.add(k); else n.delete(k); return n; })} />
                                      </TableCell>
                                      <TableCell className={s.cell}>{t.schema}.{t.table}</TableCell>
                                    </TableRow>
                                  );
                                })}
                              </TableBody>
                            </Table>
                          </div>
                        )}
                      </div>

                      <Divider />

                      {/* Step 4 — name + review */}
                      <div>
                        <div className={s.stepHead}><span className={s.stepNum}>4</span><Subtitle2>Name &amp; create</Subtitle2></div>
                        <Field label="Name" required style={{ marginTop: 8 }}>
                          <Input value={createName} onChange={(_, d) => setCreateName(d.value)} placeholder="prod-sales-mirror" />
                        </Field>
                        <div className={s.summary} style={{ marginTop: 10 }}>
                          <span className={s.sumKey}>Source</span><span>{srcDef.name}</span>
                          <span className={s.sumKey}>Connection</span><span>{pickedConn ? `${pickedConn.name} (${pickedConn.authMethod})` : 'manual / managed identity'}</span>
                          <span className={s.sumKey}>Server</span><span><code>{createServer || '—'}</code></span>
                          <span className={s.sumKey}>Database</span><span><code>{createDb || '—'}</code></span>
                          <span className={s.sumKey}>Target</span><span>ADLS Bronze Delta</span>
                        </div>
                        {createErr && <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody>{createErr}</MessageBarBody></MessageBar>}
                      </div>
                    </div>
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => { setCreateOpen(false); setEditing(false); }}>Cancel</Button>
                    <Button appearance="primary" icon={<Add20Regular />} disabled={createBusy || !createName.trim()} onClick={create}>
                      {createBusy ? (editing ? 'Saving…' : 'Creating…') : (editing ? 'Save changes' : 'Create mirror')}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
            <ConnectionBuilder open={connBuilderOpen} onClose={() => setConnBuilderOpen(false)}
              onCreated={(c) => { setConnections((prev) => [...prev.filter((x) => x.id !== c.id), c]); setConnId(c.id); }} />
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
          {testMsg && <MessageBar intent={testMsg.intent}><MessageBarBody><MessageBarTitle>Connection test</MessageBarTitle>{testMsg.text}</MessageBarBody></MessageBar>}
          {detail?.lastRun?.gate && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Mirror not started</MessageBarTitle>
                {detail.lastRun.gate.message}
              </MessageBarBody>
            </MessageBar>
          )}
          {detail?.source?.server && (
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              Source: <strong>{detail.source.sourceType || 'SQL'}</strong> · <code>{detail.source.server}</code> / <code>{detail.source.database}</code>
              {detail.source.connectionId ? ' · Key Vault connection bound' : ''}
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
