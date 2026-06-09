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
import { useRouter } from 'next/navigation';
import {
  Subtitle2, Caption1, Badge, Button, Spinner, Select, Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Tree, TreeItem, TreeItemLayout,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Delete20Regular, Play20Regular, Pause20Regular, Database20Regular,
  PlugConnected20Regular, CheckmarkCircle16Filled, ShieldTask20Regular, DatabasePlug20Regular,
  Eye20Regular, Stop20Regular, ArrowCounterclockwise20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { OneLakeSecurityTab } from './components/onelake-security-tab';
import { OpenMirrorConfig } from './components/open-mirror-config';
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
  const router = useRouter();
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
  // Test-connection state.
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ intent: 'success' | 'error' | 'info'; text: string } | null>(null);
  // Paired Synapse Serverless SQL analytics endpoint (auto-created at install by
  // the mirror→synapse-serverless-sql-pool pairing rule, Azure-native default).
  const [sqlPaired, setSqlPaired] = useState<{ itemId: string; endpoint: string | null; database: string | null } | null>(null);
  const [sqlPairedLoading, setSqlPairedLoading] = useState(false);

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

  // Resolve the paired Serverless SQL analytics endpoint for the selected mirror.
  useEffect(() => {
    if (!workspaceId || !mirrorId) { setSqlPaired(null); return; }
    let cancelled = false;
    setSqlPairedLoading(true);
    fetch(`/api/items/mirrored-database/${encodeURIComponent(mirrorId)}/sql-endpoint?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.ok && j.provisioned && j.sqlItemId) setSqlPaired({ itemId: j.sqlItemId, endpoint: j.endpoint, database: j.database });
        else setSqlPaired(null);
      })
      .catch(() => { if (!cancelled) setSqlPaired(null); })
      .finally(() => { if (!cancelled) setSqlPairedLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, mirrorId]);

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
        { label: 'Start', onClick: mirrorId && !lifecycleBusy ? () => lifecycle('start') : undefined, disabled: !mirrorId || lifecycleBusy },
        { label: 'Stop', onClick: mirrorId && !lifecycleBusy ? () => setConfirmAction('stop') : undefined, disabled: !mirrorId || lifecycleBusy },
        { label: 'Restart', onClick: mirrorId && !lifecycleBusy ? () => setConfirmAction('restart') : undefined, disabled: !mirrorId || lifecycleBusy },
        { label: 'Monitor', onClick: workspaceId && mirrorId ? () => { setView('monitor'); void loadMonitor(); } : undefined, disabled: !workspaceId || !mirrorId },
      ]},
      { label: 'Analytics', actions: [
        { label: 'SQL analytics endpoint',
          onClick: sqlPaired ? () => router.push(`/items/synapse-serverless-sql-pool/${encodeURIComponent(sqlPaired.itemId)}${sqlPaired.database ? `?database=${encodeURIComponent(sqlPaired.database)}` : ''}`) : undefined,
          disabled: !sqlPaired,
          title: sqlPaired ? `Open the paired Serverless SQL endpoint${sqlPaired.endpoint ? ` (${sqlPaired.endpoint})` : ''}` : 'Install the mirror to provision its SQL analytics endpoint' },
      ]},
      { label: 'List', actions: [
        { label: 'Refresh list', onClick: workspaceId ? () => loadList(workspaceId) : undefined, disabled: !workspaceId },
      ]},
    ]},
  ], [workspaceId, mirrorId, detail, acting, testing, lifecycleBusy, del, act, lifecycle, loadDetail, loadList, loadMonitor, openNew, openEdit, testConnection, sqlPaired, router]);

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
            <Button appearance="outline" icon={<Add20Regular />} disabled={!workspaceId} onClick={openNew}>New mirror</Button>
            {mirrorId && detail && <Button appearance="outline" icon={<PlugConnected20Regular />} onClick={openEdit}>Edit</Button>}
            {mirrorId && detail && <Button appearance="outline" icon={<CheckmarkCircle16Filled />} disabled={testing} onClick={testConnection}>{testing ? 'Testing…' : 'Test connection'}</Button>}
            {sqlPaired && (
              <Button appearance="outline" icon={<DatabasePlug20Regular />}
                onClick={() => router.push(`/items/synapse-serverless-sql-pool/${encodeURIComponent(sqlPaired.itemId)}${sqlPaired.database ? `?database=${encodeURIComponent(sqlPaired.database)}` : ''}`)}
                title={sqlPaired.endpoint ? `Serverless SQL endpoint: ${sqlPaired.endpoint}` : 'Open the paired Serverless SQL analytics endpoint'}>
                SQL analytics endpoint
              </Button>
            )}
            {sqlPaired?.endpoint && (
              <Badge appearance="tint" color="success" title="Synapse Serverless SQL endpoint over the mirror Bronze">{sqlPaired.endpoint}</Badge>
            )}
            {mirrorId && !sqlPaired && !sqlPairedLoading && (
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                No SQL analytics endpoint paired yet — Install the mirror (Azure-native ADF-CDC) to auto-provision it.
              </Caption1>
            )}
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

          {/* Open mirroring (push Parquet → managed Delta) — only for the
              GenericMirror source. Azure-native: ADLS landing → Synapse Spark
              merge → managed Delta, no Microsoft Fabric. */}
          {mirrorId && workspaceId && detail?.source?.sourceType === 'GenericMirror' && (
            <OpenMirrorConfig
              mirrorId={mirrorId}
              workspaceId={workspaceId}
              tableName={detail?.source?.database || 'default'}
            />
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
