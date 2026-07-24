'use client';

/**
 * N7b — Debezium CDC control plane (/cdc).
 *
 * A control plane OVER the Azure-native mirror engine: the dropdown-only
 * source-connector wizard writes the config the engine already consumes, and
 * the live monitor shows initial-snapshot % → streaming lag, the source-DDL
 * schema-change feed, and the N6 dead-letter list — all from real backends
 * (/api/cdc/connectors/**). No mock arrays; no Microsoft Fabric; Fluent v9 +
 * Loom tokens only, PageShell / Section / GuidedEmptyState primitives, every
 * badge row wraps. A freshly-created connector opens clean (no red banners).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Badge, Button, Caption1, Input, Select, Spinner, Subtitle2, Text, ProgressBar, Field,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle, Tab, TabList, Checkbox,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowSync20Regular, Play20Regular, Stop20Regular, Delete20Regular,
  DatabasePlugConnected20Regular, PlugConnected20Regular, PulseSquare20Regular,
  BranchCompare20Regular, ErrorCircle20Regular,
} from '@fluentui/react-icons';
import { PageShell } from '@/lib/components/page-shell';
import { Section } from '@/lib/components/ui/section';
import { GuidedEmptyState } from '@/lib/components/shared/guided-empty-state';
import { CDC_SOURCES, cdcSource, type CdcTableSpec } from '@/lib/cdc/connector-plane';

const useStyles = makeStyles({
  col: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  wsField: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '260px', maxWidth: '100%' },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  connBtn: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalS, borderRadius: tokens.borderRadiusMedium, width: '100%',
    textAlign: 'left', border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1, cursor: 'pointer',
  },
  // full `border` shorthand (not `borderColor` longhand) — griffel/makeStyles forbids
  // mixing the shorthand used in `connBtn` with a longhand override in the same call.
  connBtnActive: { border: `${tokens.strokeWidthThin} solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  tableWrap: { overflowX: 'auto', border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge },
  kpiRow: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  kpi: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: '160px',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge, boxShadow: tokens.shadow4,
    backgroundColor: tokens.colorNeutralBackground1, flex: 1,
  },
  progressWrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, minWidth: '220px', flex: 1 },
  wizardGrid: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  tablePick: { maxHeight: '220px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalS },
  feed: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  feedItem: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 },
  code: { fontFamily: tokens.fontFamilyMonospace, wordBreak: 'break-all' },
});

interface WorkspaceLite { id: string; name: string; }
interface ConnectorLite {
  id: string; displayName: string; kind: string; sourceType: string;
  server: string; database: string; syncMode?: string; mirroringStatus?: string; tableCount?: number;
}

function phaseColor(phase?: string): 'success' | 'warning' | 'informative' | 'severe' | 'brand' {
  switch (phase) {
    case 'streaming': return 'success';
    case 'snapshotting': return 'brand';
    case 'stopped': return 'informative';
    case 'error': return 'severe';
    default: return 'warning';
  }
}

const SYNC_MODES: Array<{ value: string; label: string }> = [
  { value: 'incremental', label: 'Incremental (snapshot, then change capture)' },
  { value: 'snapshot', label: 'Snapshot only (full re-read each run)' },
  { value: 'continuous', label: 'Continuous (ADF CDC / scheduled copy)' },
];

export function CdcControlPlane() {
  const s = useStyles();
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [connectors, setConnectors] = useState<ConnectorLite[] | null>(null);
  const [flagOff, setFlagOff] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [listErr, setListErr] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ intent: 'success' | 'error' | 'info' | 'warning'; text: string } | null>(null);
  const [acting, setActing] = useState(false);
  const [tab, setTab] = useState<'overview' | 'monitor'>('overview');

  // Monitor state.
  const [monitor, setMonitor] = useState<any | null>(null);
  const [monitorErr, setMonitorErr] = useState<string | null>(null);
  const [monitorLoading, setMonitorLoading] = useState(false);

  // Wizard state.
  const [wizardOpen, setWizardOpen] = useState(false);

  // ── loaders ──
  useEffect(() => {
    (async () => {
      try {
        const r = await clientFetch('/api/loom/workspaces');
        const j = await r.json();
        setWorkspaces(j.ok ? (j.workspaces || []) : []);
      } catch { setWorkspaces([]); }
    })();
  }, []);
  useEffect(() => {
    if (!workspaceId && workspaces && workspaces.length) setWorkspaceId(workspaces[0].id);
  }, [workspaceId, workspaces]);

  const loadList = useCallback(async (wsId: string) => {
    setListErr(null);
    try {
      const r = await clientFetch(`/api/cdc/connectors?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setConnectors([]); setListErr(j.error || 'failed'); return; }
      setFlagOff(!!j.flagOff);
      setConnectors(j.connectors || []);
      if ((j.connectors || []).length && !selectedId) setSelectedId(j.connectors[0].id);
    } catch (e: any) { setConnectors([]); setListErr(e?.message || String(e)); }
  }, [selectedId]);
  useEffect(() => { if (workspaceId) void loadList(workspaceId); }, [workspaceId, loadList]);

  const loadMonitor = useCallback(async () => {
    if (!workspaceId || !selectedId) return;
    setMonitorLoading(true); setMonitorErr(null);
    try {
      const r = await clientFetch(`/api/cdc/connectors/${encodeURIComponent(selectedId)}/monitor?workspaceId=${encodeURIComponent(workspaceId)}`);
      const j = await r.json();
      if (!j.ok) { setMonitorErr(j.error || 'monitor failed'); return; }
      setMonitor(j);
    } catch (e: any) { setMonitorErr(e?.message || String(e)); }
    finally { setMonitorLoading(false); }
  }, [workspaceId, selectedId]);
  useEffect(() => {
    if (tab !== 'monitor' || !selectedId) return;
    void loadMonitor();
    const t = setInterval(() => void loadMonitor(), 30_000);
    return () => clearInterval(t);
  }, [tab, selectedId, loadMonitor]);

  const act = useCallback(async (action: 'start' | 'stop') => {
    if (!workspaceId || !selectedId) return;
    setActing(true); setActionMsg(null);
    try {
      const r = await clientFetch(`/api/cdc/connectors/${encodeURIComponent(selectedId)}/state?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (j.gate) setActionMsg({ intent: 'warning', text: `${action}: ${j.gate.message}` });
      else if (!j.ok) setActionMsg({ intent: 'error', text: `${action} failed: ${j.error || 'unknown error'}` });
      else setActionMsg({ intent: 'success', text: `${action} accepted. Status: ${j.status?.mirroringStatus || 'unknown'}. ${j.note || ''}` });
      await loadList(workspaceId);
      if (tab === 'monitor') await loadMonitor();
    } finally { setActing(false); }
  }, [workspaceId, selectedId, loadList, loadMonitor, tab]);

  const del = useCallback(async () => {
    if (!workspaceId || !selectedId) return;
    if (!confirm('Remove this connector? Landed Bronze data is retained.')) return;
    await clientFetch(`/api/cdc/connectors/${encodeURIComponent(selectedId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' });
    setSelectedId(''); setMonitor(null);
    await loadList(workspaceId);
  }, [workspaceId, selectedId, loadList]);

  const selected = useMemo(() => (connectors || []).find((c) => c.id === selectedId), [connectors, selectedId]);

  const actions = (
    <div className={s.toolbar}>
      <div className={s.wsField}>
        <Caption1>Workspace</Caption1>
        <Select value={workspaceId} onChange={(_, d) => { setWorkspaceId(d.value); setSelectedId(''); }} disabled={!workspaces?.length}>
          {!workspaceId && <option value="">{workspaces === null ? 'Loading…' : 'Select a workspace'}</option>}
          {(workspaces || []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </Select>
      </div>
      <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={!workspaceId} onClick={() => workspaceId && loadList(workspaceId)}>Refresh</Button>
      <Button appearance="primary" icon={<Add20Regular />} disabled={!workspaceId} onClick={() => setWizardOpen(true)}>New connector</Button>
    </div>
  );

  return (
    <PageShell
      title="CDC connectors"
      subtitle="Debezium-style change-data-capture control plane over the Azure-native mirror engine — snapshot, stream, and quarantine into ADLS Bronze. No Microsoft Fabric."
      actions={actions}
    >
      <div className={s.col}>
        {flagOff && (
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>CDC control plane turned off</MessageBarTitle>
              An administrator disabled the <code>n7b-cdc-control-plane</code> runtime flag. Connectors that were already
              started keep replicating into ADLS Bronze; re-enable the flag in Admin → Runtime flags to manage them here.
            </MessageBarBody>
          </MessageBar>
        )}
        {listErr && <MessageBar intent="error"><MessageBarBody>{listErr}</MessageBarBody></MessageBar>}

        {!flagOff && connectors && connectors.length === 0 && !listErr && (
          <GuidedEmptyState
            title="Create your first CDC connector"
            heroIcon={DatabasePlugConnected20Regular}
            intro="Point a connector at a database and Loom snapshots it into ADLS Bronze, then streams every change — with N6 data-contract enforcement quarantining bad rows. Postgres and SQL Server run end-to-end today."
            paths={[
              { key: 'new', title: 'New source connector', body: 'Pick a source (SQL Server, PostgreSQL, MySQL, MongoDB, Oracle), choose tables, and Start.', icon: PlugConnected20Regular, onClick: () => setWizardOpen(true) },
            ]}
            columns={1}
          />
        )}

        {!flagOff && (connectors === null) && workspaceId && (
          <Spinner label="Loading connectors…" />
        )}

        {!flagOff && connectors && connectors.length > 0 && (
          <div className={s.row} style={{ alignItems: 'flex-start' }}>
            {/* connector list */}
            <div className={s.list} style={{ minWidth: '240px', maxWidth: '320px', flex: '0 0 auto' }}>
              {connectors.map((c) => {
                const def = cdcSource(c.kind);
                return (
                  <button
                    key={c.id}
                    className={`${s.connBtn} ${c.id === selectedId ? s.connBtnActive : ''}`}
                    onClick={() => { setSelectedId(c.id); setActionMsg(null); }}
                  >
                    <div className={s.row}>
                      <PlugConnected20Regular />
                      <Text weight="semibold">{c.displayName}</Text>
                    </div>
                    <div className={s.row}>
                      <Badge appearance="tint" color="brand" size="small">{def?.label || c.kind}</Badge>
                      <Badge appearance="outline" size="small" color={c.mirroringStatus === 'Running' ? 'success' : c.mirroringStatus === 'Stopped' ? 'informative' : c.mirroringStatus === 'Error' ? 'severe' : 'warning'}>
                        {c.mirroringStatus || 'NotStarted'}
                      </Badge>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* detail */}
            <div className={s.col} style={{ flex: 1, minWidth: '320px' }}>
              {selected && (
                <>
                  <div className={s.toolbar}>
                    <Button appearance="primary" icon={<Play20Regular />} disabled={acting} onClick={() => act('start')}>Start</Button>
                    <Button appearance="outline" icon={<Stop20Regular />} disabled={acting} onClick={() => act('stop')}>Stop</Button>
                    <Button appearance="subtle" icon={<Delete20Regular />} onClick={del}>Delete</Button>
                    {acting && <Spinner size="tiny" label="Working…" />}
                  </div>
                  {actionMsg && (
                    <MessageBar intent={actionMsg.intent}>
                      <MessageBarBody>{actionMsg.text}</MessageBarBody>
                    </MessageBar>
                  )}

                  <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'overview' | 'monitor')}>
                    <Tab value="overview" icon={<PlugConnected20Regular />}>Overview</Tab>
                    <Tab value="monitor" icon={<PulseSquare20Regular />}>Monitor</Tab>
                  </TabList>

                  {tab === 'overview' && (
                    <Section title="Source">
                      <div className={s.list}>
                        <div className={s.row}><Caption1>Source type</Caption1><Text>{cdcSource(selected.kind)?.label || selected.kind}</Text></div>
                        <div className={s.row}><Caption1>Host</Caption1><Text className={s.code}>{selected.server || '—'}</Text></div>
                        <div className={s.row}><Caption1>Database</Caption1><Text className={s.code}>{selected.database || '—'}</Text></div>
                        <div className={s.row}><Caption1>Sync mode</Caption1><Text>{selected.syncMode || 'incremental'}</Text></div>
                        <div className={s.row}><Caption1>Tables</Caption1><Text>{selected.tableCount ? `${selected.tableCount} selected` : 'all discovered'}</Text></div>
                        {!cdcSource(selected.kind)?.builtIn && (
                          <MessageBar intent="info">
                            <MessageBarBody>
                              {cdcSource(selected.kind)?.label} replicates via the Azure-native ADF copy runtime. Start surfaces the exact linked service to configure — no Microsoft Fabric.
                            </MessageBarBody>
                          </MessageBar>
                        )}
                      </div>
                    </Section>
                  )}

                  {tab === 'monitor' && (
                    <MonitorPanel monitor={monitor} loading={monitorLoading} err={monitorErr} onRefresh={loadMonitor} styles={s} />
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {wizardOpen && (
        <ConnectorWizard
          workspaceId={workspaceId}
          onClose={() => setWizardOpen(false)}
          onCreated={async (newId) => {
            setWizardOpen(false);
            if (workspaceId) await loadList(workspaceId);
            if (newId) { setSelectedId(newId); setTab('overview'); }
          }}
        />
      )}
    </PageShell>
  );
}

// ── Monitor panel ──
function MonitorPanel({ monitor, loading, err, onRefresh, styles: s }: {
  monitor: any | null; loading: boolean; err: string | null; onRefresh: () => void; styles: ReturnType<typeof useStyles>;
}) {
  const health = monitor?.health;
  const dead = monitor?.deadLetter;
  const schemaChanges: any[] = monitor?.schemaChanges || [];
  return (
    <div className={s.col}>
      <div className={s.toolbar}>
        <Badge appearance="filled" color="brand" icon={<PulseSquare20Regular />}>Connector monitor</Badge>
        <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={loading} onClick={onRefresh}>{loading ? 'Refreshing…' : 'Refresh'}</Button>
        {health && <Badge appearance="filled" color={phaseColor(health.phase)}>{health.phase}</Badge>}
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Auto-refresh every 30s</Caption1>
      </div>
      {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}

      {health && (
        <div className={s.kpiRow}>
          <div className={s.progressWrap}>
            <Caption1>Initial snapshot</Caption1>
            <ProgressBar value={health.snapshotPercent / 100} thickness="large" color={health.phase === 'error' ? 'error' : 'brand'} />
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{health.snapshotPercent}% · {health.tablesReplicated}/{health.tablesTotal} tables</Caption1>
          </div>
          <div className={s.kpi}>
            <Caption1>Streaming lag</Caption1>
            <Subtitle2>{health.streamingLagSeconds == null ? '—' : `${health.streamingLagSeconds}s`}</Subtitle2>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{health.phase === 'streaming' ? 'behind source' : 'not streaming yet'}</Caption1>
          </div>
          <div className={s.kpi}>
            <Caption1>Tables streaming</Caption1>
            <Subtitle2>{health.tablesStreaming}</Subtitle2>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>incremental mode</Caption1>
          </div>
          <div className={s.kpi}>
            <Caption1>Dead-letter rows</Caption1>
            <Subtitle2>{dead?.present ? dead.totalFiles : 0}</Subtitle2>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>quarantine files</Caption1>
          </div>
        </div>
      )}
      {health?.message && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{health.message}</Caption1>}

      {/* per-table replication */}
      <Section title="Tables">
        <div className={s.tableWrap}>
          <Table aria-label="Replication tables" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Table</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Mode</TableHeaderCell>
              <TableHeaderCell>Rows</TableHeaderCell>
              <TableHeaderCell>Last sync</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {(!monitor?.tables || monitor.tables.length === 0) && (
                <TableRow><TableCell colSpan={5}>No tables yet. Start the connector to begin replication.</TableCell></TableRow>
              )}
              {(monitor?.tables || []).map((t: any, i: number) => (
                <TableRow key={`${t.schema}.${t.table}.${i}`}>
                  <TableCell>{t.schema ? `${t.schema}.` : ''}{t.table}</TableCell>
                  <TableCell>
                    <Badge appearance="tint" size="small" color={t.status === 'replicated' ? 'success' : t.status === 'error' ? 'severe' : 'informative'}>{t.status || '—'}</Badge>
                  </TableCell>
                  <TableCell>{t.mode || '—'}</TableCell>
                  <TableCell>{typeof t.rows === 'number' ? t.rows : '—'}</TableCell>
                  <TableCell>{t.lastSync ? new Date(t.lastSync).toLocaleString() : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>

      {/* schema-change feed */}
      <Section title={<span><BranchCompare20Regular /> Schema changes</span>}>
        {schemaChanges.length === 0 ? (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No source-schema drift captured yet. Column/table changes appear here after each Start.</Caption1>
        ) : (
          <div className={s.feed}>
            {schemaChanges.slice(0, 50).map((e: any, i: number) => (
              <div key={i} className={s.feedItem}>
                <Badge appearance="outline" size="small" color={e.kind?.includes('removed') ? 'severe' : 'brand'}>{e.kind}</Badge>
                <Text>{e.detail}</Text>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{e.at ? new Date(e.at).toLocaleString() : ''}</Caption1>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* dead-letter */}
      <Section title={<span><ErrorCircle20Regular /> Dead letter (N6 quarantine)</span>}>
        {!dead?.present ? (
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{dead?.note || 'No quarantined rows — every replicated row conformed to its bound data contract (or none is bound).'}</Caption1>
        ) : (
          <div className={s.col}>
            <div className={s.row}>
              {(dead.datasets || []).map((d: any) => (
                <Badge key={d.dataset} appearance="tint" color="danger">{d.dataset}: {d.files} file{d.files === 1 ? '' : 's'}</Badge>
              ))}
            </div>
            <div className={s.tableWrap}>
              <Table aria-label="Dead-letter sample" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Dataset</TableHeaderCell>
                  <TableHeaderCell>Rejected at</TableHeaderCell>
                  <TableHeaderCell>Contract</TableHeaderCell>
                  <TableHeaderCell>Violations</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {(dead.sample || []).map((r: any, i: number) => (
                    <TableRow key={i}>
                      <TableCell>{r.dataset}</TableCell>
                      <TableCell>{r.rejectedAt ? new Date(r.rejectedAt).toLocaleString() : '—'}</TableCell>
                      <TableCell>{r.contractId ? `${r.contractId} v${r.contractVersion || '?'}` : '—'}</TableCell>
                      <TableCell><Caption1 className={s.code}>{r.violations ? JSON.stringify(r.violations).slice(0, 160) : '—'}</Caption1></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

// ── Wizard ──
function ConnectorWizard({ workspaceId, onClose, onCreated }: {
  workspaceId: string; onClose: () => void; onCreated: (id?: string) => void;
}) {
  const s = useStyles();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [displayName, setDisplayName] = useState('');
  const [kind, setKind] = useState('postgres');
  const [server, setServer] = useState('');
  const [database, setDatabase] = useState('');
  const [syncMode, setSyncMode] = useState('incremental');
  const [secretRef, setSecretRef] = useState('');
  const [tables, setTables] = useState<CdcTableSpec[]>([]);
  const [available, setAvailable] = useState<CdcTableSpec[] | null>(null);
  const [tablesGate, setTablesGate] = useState<string | null>(null);
  const [loadingTables, setLoadingTables] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const def = cdcSource(kind);

  const loadTables = useCallback(async () => {
    setLoadingTables(true); setTablesGate(null); setAvailable(null);
    try {
      const r = await clientFetch(`/api/cdc/connectors/source-tables?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, server, database }),
      });
      const j = await r.json();
      if (j.gate) { setTablesGate(j.error); setAvailable([]); }
      else if (!j.ok) { setTablesGate(j.error || 'could not enumerate tables'); setAvailable([]); }
      else setAvailable(j.tables || []);
    } catch (e: any) { setTablesGate(e?.message || String(e)); setAvailable([]); }
    finally { setLoadingTables(false); }
  }, [workspaceId, kind, server, database]);

  const toggleTable = (t: CdcTableSpec) => {
    setTables((prev) => {
      const key = `${t.schema}.${t.table}`;
      return prev.some((x) => `${x.schema}.${x.table}` === key)
        ? prev.filter((x) => `${x.schema}.${x.table}` !== key)
        : [...prev, t];
    });
  };

  const create = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const r = await clientFetch(`/api/cdc/connectors?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName, kind, server, database, syncMode, secretRef, tables }),
      });
      const j = await r.json();
      if (!j.ok) { setErr((j.errors && j.errors.join(' ')) || j.error || 'create failed'); return; }
      onCreated(j.connector?.id);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [workspaceId, displayName, kind, server, database, syncMode, secretRef, tables, onCreated]);

  const canNext0 = displayName.trim().length > 0 && !!def;
  const canNext1 = database.trim().length > 0 && (!!server.trim());

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>New CDC connector</DialogTitle>
          <DialogContent>
            <div className={s.wizardGrid}>
              {step === 0 && (
                <>
                  <Field label="Connector name" required>
                    <Input value={displayName} onChange={(_, d) => setDisplayName(d.value)} placeholder="e.g. Orders CDC" />
                  </Field>
                  <Field label="Source type" required hint={def?.hint}>
                    <Select value={kind} onChange={(_, d) => { setKind(d.value); setTables([]); setAvailable(null); }}>
                      {CDC_SOURCES.map((src) => (
                        <option key={src.kind} value={src.kind}>{src.label}{src.builtIn ? '' : ' (ADF copy)'}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Sync mode">
                    <Select value={syncMode} onChange={(_, d) => setSyncMode(d.value)}>
                      {SYNC_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </Select>
                  </Field>
                </>
              )}
              {step === 1 && (
                <>
                  <Field label={`Source host${def ? ` (default port ${def.defaultPort})` : ''}`} required>
                    <Input value={server} onChange={(_, d) => setServer(d.value)} placeholder="host.postgres.database.azure.com" />
                  </Field>
                  <Field label="Database" required>
                    <Input value={database} onChange={(_, d) => setDatabase(d.value)} placeholder="appdb" />
                  </Field>
                  <Field
                    label="Credential (Key Vault reference)"
                    hint="A Key Vault secret name or vault-secret URI — never an inline password. Leave empty for Entra-token sources (Postgres / SQL Server)."
                  >
                    <Input value={secretRef} onChange={(_, d) => setSecretRef(d.value)} placeholder="my-source-password  ·  https://kv.vault.azure.net/secrets/my-source-password" />
                  </Field>
                </>
              )}
              {step === 2 && (
                <>
                  <div className={s.row}>
                    <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={loadingTables || !database} onClick={loadTables}>
                      {loadingTables ? 'Loading…' : 'Load source tables'}
                    </Button>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Leave empty to replicate everything the engine discovers.</Caption1>
                  </div>
                  {tablesGate && <MessageBar intent="info"><MessageBarBody>{tablesGate}</MessageBarBody></MessageBar>}
                  {available && available.length > 0 && (
                    <div className={s.tablePick}>
                      {available.map((t) => {
                        const key = `${t.schema}.${t.table}`;
                        const checked = tables.some((x) => `${x.schema}.${x.table}` === key);
                        return (
                          <Checkbox key={key} checked={checked} onChange={() => toggleTable(t)} label={key} />
                        );
                      })}
                    </div>
                  )}
                  <Caption1>{tables.length ? `${tables.length} table(s) selected` : 'All tables'}</Caption1>
                  {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            {step > 0 && <Button appearance="outline" onClick={() => setStep((step - 1) as 0 | 1 | 2)}>Back</Button>}
            {step < 2 && <Button appearance="primary" disabled={step === 0 ? !canNext0 : !canNext1} onClick={() => setStep((step + 1) as 0 | 1 | 2)}>Next</Button>}
            {step === 2 && <Button appearance="primary" icon={<PlugConnected20Regular />} disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create connector'}</Button>}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
