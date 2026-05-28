'use client';

/**
 * Phase 3 editors — Real-Time Intelligence, Data Warehouse, Power BI.
 *
 * v2.1 KQL family (Eventhouse, KQL Database, KQL Queryset, KQL Dashboard,
 * Eventstream) are wired live against the shared Loom ADX cluster
 * `adx-csa-loom-shared.eastus2.kusto.windows.net` via the Console UAMI
 * (Kusto raw REST: /v1/rest/query + /v1/rest/mgmt, ARM for database
 * create). Eventstream persists pipeline config to Cosmos; runtime
 * wiring lands in v3.
 *
 * Warehouse is real-REST (Fabric Warehouse over Synapse Dedicated pool).
 *
 * v2.1 Power BI / Fabric family — Semantic model, Report, Dashboard,
 * Paginated report, Scorecard, and Activator — are now wired against
 * live Power BI REST (api.powerbi.com/v1.0/myorg) and Fabric REST
 * (api.fabric.microsoft.com/v1) via the Console UAMI. If the UAMI's SP
 * is not yet registered in the Power BI tenant or hasn't been added to
 * a workspace, the editors surface the underlying 401/403 verbatim with
 * a remediation hint — no mock data is shown.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Spinner, Field,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Label, Select, Textarea, Switch,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular, Folder20Regular,
  Save20Regular, Add20Regular, Delete20Regular, ArrowSync20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { PowerBIEmbedFrame } from '@/lib/components/embed/powerbi-embed';
import { ComputePicker } from '@/lib/components/compute-picker';
import {
  VisualDesigner as EventstreamVisualDesigner,
  type PipelineConfig as VisualPipelineConfig,
  type SourceNode as VisualSourceNode,
  type TransformNode as VisualTransformNode,
  type SinkNode as VisualSinkNode,
} from '@/lib/components/eventstream/visual-designer';

const useStyles = makeStyles({
  monaco: {
    width: '100%',
    minHeight: '180px',
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: '13px',
    padding: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  pad: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  toolbar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  card: {
    padding: '12px', border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '6px', backgroundColor: tokens.colorNeutralBackground1,
  },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' },
  tabBar: { padding: '8px 16px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  resultBox: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 12, minHeight: 180 },
  resultMeta: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 },
  tableWrap: { overflow: 'auto', maxHeight: 320, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
  treePad: { padding: 8 },
});

// ============================================================
// Shared KQL results panel
// ============================================================
interface KqlResult {
  ok: boolean;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  executionMs?: number;
  truncated?: boolean;
  error?: string;
  database?: string;
  mode?: 'query' | 'mgmt';
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function KqlResultsPanel({ result, loading }: { result: KqlResult | null; loading: boolean }) {
  const s = useStyles();
  if (loading) {
    return <div className={s.resultBox}><Spinner size="small" label="Executing KQL…" labelPosition="after" /></div>;
  }
  if (!result) {
    return <div className={s.resultBox}><Caption1>Click <strong>Run</strong> to execute. Results appear here.</Caption1></div>;
  }
  if (!result.ok) {
    return (
      <div className={s.resultBox}>
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Query failed</MessageBarTitle>
            {result.error || 'Unknown error'}
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }
  const rows = result.rows || [];
  const columns = result.columns || [];
  return (
    <div className={s.resultBox}>
      <div className={s.resultMeta}>
        <Badge appearance="filled" color="success">{result.rowCount ?? rows.length} rows</Badge>
        <Caption1>· {result.executionMs} ms</Caption1>
        {result.mode === 'mgmt' && <Badge appearance="outline">mgmt</Badge>}
        {result.truncated && <Badge appearance="outline" color="warning">truncated at 5,000</Badge>}
      </div>
      {rows.length === 0 ? (
        <Caption1>Query returned no rows.</Caption1>
      ) : (
        <div className={s.tableWrap}>
          <Table aria-label="KQL results" size="small">
            <TableHeader>
              <TableRow>{columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={i}>
                  {columns.map((_, j) => <TableCell key={j} className={s.cell}>{fmtCell(row[j])}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ----- Eventhouse -----
// Ribbon is built inside the editor via useMemo so actions have real
// onClick bindings (see no-vaporware.md: dead ribbons get disabled with
// a "not yet wired" tooltip rather than rendering enabled-but-broken).

interface EventhouseState {
  ok: boolean;
  cluster?: string;
  defaultDatabase?: string;
  databases?: Array<{ name: string; prettyName?: string; persistentStorage?: string }>;
  error?: string;
}

export function EventhouseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const router = useRouter();
  const [state, setState] = useState<EventhouseState | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedDb, setSelectedDb] = useState<string>('');
  const [getDataOpen, setGetDataOpen] = useState(false);
  const [getDataMode, setGetDataMode] = useState<'file' | 'eventhub' | 'onelake'>('file');
  const [getDataBusy, setGetDataBusy] = useState(false);
  const [getDataResult, setGetDataResult] = useState<{ ok?: boolean; error?: string; tableName?: string; rows?: number } | null>(null);
  const [getDataTable, setGetDataTable] = useState('');
  const [getDataFile, setGetDataFile] = useState<File | null>(null);
  const [getDataHubName, setGetDataHubName] = useState('');
  const [getDataConsumer, setGetDataConsumer] = useState('$Default');
  const [getDataOneLakePath, setGetDataOneLakePath] = useState('');
  const [policiesOpen, setPoliciesOpen] = useState(false);
  const [hotCacheDays, setHotCacheDays] = useState<number>(7);
  const [softDeleteDays, setSoftDeleteDays] = useState<number>(30);
  const [oneLakeEnabled, setOneLakeEnabled] = useState<boolean>(false);
  const [policiesBusy, setPoliciesBusy] = useState(false);
  const [policiesErr, setPoliciesErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Pre-save gate: /items/eventhouse/new fires this before any record exists.
    // Skip the fetch — the editor renders its "create database" flow instead.
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/eventhouse/${id}`);
      const j = (await r.json()) as EventhouseState;
      setState(j);
      if (j.ok && (j.databases?.length ?? 0) > 0 && !selectedDb) {
        setSelectedDb(j.defaultDatabase || j.databases![0].name);
      }
    } catch (e: any) {
      setState({ ok: false, error: e?.message || String(e) });
    }
  }, [id, selectedDb]);

  useEffect(() => { load(); }, [load]);

  const createDb = useCallback(async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setCreateErr(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/database`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setCreateErr(j.error || 'create failed'); }
      else { setNewName(''); setDialogOpen(false); load(); }
    } catch (e: any) {
      setCreateErr(e?.message || String(e));
    } finally {
      setCreating(false);
    }
  }, [id, newName, load]);

  // Open the KQL Database editor for a specific database in this eventhouse.
  // Mirrors Fabric's behavior: clicking a DB card or "Query with code" jumps
  // into the focused KQL editor for that database.
  const openKqlEditor = useCallback((dbName: string) => {
    if (!dbName) return;
    const qs = new URLSearchParams({ eventhouseId: id, database: dbName });
    router.push(`/items/kql-database/new?${qs.toString()}`);
  }, [id, router]);

  // Ingest a file (CSV / JSON / parquet) into a KQL table. Calls the
  // existing /api/items/eventhouse/{id}/ingest BFF route; honest error if
  // not yet provisioned.
  const onIngest = useCallback(async () => {
    if (!selectedDb || !getDataTable.trim()) {
      setGetDataResult({ ok: false, error: 'Database + table name required' }); return;
    }
    setGetDataBusy(true);
    setGetDataResult(null);
    try {
      if (getDataMode === 'file') {
        if (!getDataFile) { setGetDataResult({ ok: false, error: 'Pick a file first' }); return; }
        const fd = new FormData();
        fd.set('database', selectedDb);
        fd.set('table', getDataTable.trim());
        fd.set('file', getDataFile);
        const r = await fetch(`/api/items/eventhouse/${id}/ingest`, { method: 'POST', body: fd });
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
        setGetDataResult(j);
      } else if (getDataMode === 'eventhub') {
        const r = await fetch(`/api/items/eventhouse/${id}/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'eventhub', database: selectedDb, table: getDataTable.trim(),
            eventHubName: getDataHubName.trim(), consumerGroup: getDataConsumer.trim() || '$Default',
          }),
        });
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
        setGetDataResult(j);
      } else {
        const r = await fetch(`/api/items/eventhouse/${id}/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'onelake', database: selectedDb, table: getDataTable.trim(),
            oneLakePath: getDataOneLakePath.trim(),
          }),
        });
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
        setGetDataResult(j);
      }
    } catch (e: any) {
      setGetDataResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setGetDataBusy(false);
    }
  }, [id, selectedDb, getDataMode, getDataTable, getDataFile, getDataHubName, getDataConsumer, getDataOneLakePath]);

  // Apply per-database caching + retention policies via the .alter database
  // policy KQL management commands. Also flips the OneLake availability
  // mirroring toggle (Fabric-only feature — falls through to a structured
  // error MessageBar if the cluster isn't Fabric-managed).
  const applyPolicies = useCallback(async () => {
    if (!selectedDb) return;
    setPoliciesBusy(true);
    setPoliciesErr(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/policies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          database: selectedDb,
          hotCacheDays, softDeleteDays, oneLakeAvailability: oneLakeEnabled,
        }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) setPoliciesErr(j.error || 'policy apply failed');
      else { setPoliciesOpen(false); load(); }
    } catch (e: any) {
      setPoliciesErr(e?.message || String(e));
    } finally {
      setPoliciesBusy(false);
    }
  }, [id, selectedDb, hotCacheDays, softDeleteDays, oneLakeEnabled, load]);

  const hasDbs = (state?.databases?.length ?? 0) > 0;
  const dbCount = state?.databases?.length ?? 0;

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'New', actions: [
        { label: 'New KQL database', onClick: () => setDialogOpen(true) },
        { label: 'New dashboard', disabled: true, title: 'KQL dashboard creation not yet wired — use the KQL Dashboard editor' },
      ]},
      { label: 'Query', actions: [
        { label: 'Query with code', onClick: hasDbs && selectedDb ? () => openKqlEditor(selectedDb) : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs ? 'create a KQL database first' : !selectedDb ? 'select a database below' : undefined },
        { label: 'Get data', onClick: hasDbs ? () => setGetDataOpen(true) : undefined,
          disabled: !hasDbs, title: !hasDbs ? 'create a KQL database first' : undefined },
      ]},
      { label: 'Manage', actions: [
        { label: 'Data policies', onClick: hasDbs && selectedDb ? () => setPoliciesOpen(true) : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs ? 'create a KQL database first' : !selectedDb ? 'select a database below' : undefined },
        { label: 'OneLake availability', onClick: hasDbs && selectedDb ? () => { setOneLakeEnabled(true); setPoliciesOpen(true); } : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs || !selectedDb ? 'pick a database first' : undefined },
      ]},
      { label: 'Refresh', actions: [
        { label: 'Refresh', onClick: load },
      ]},
    ]},
  ], [hasDbs, selectedDb, openKqlEditor, load]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand">Eventhouse · shared cluster</Badge>
          <Caption1>{state?.cluster || 'loading…'}</Caption1>
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={load}>Refresh</Button>
          <Dialog open={dialogOpen} onOpenChange={(_: unknown, d: any) => setDialogOpen(d.open)}>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="primary" icon={<Add20Regular />} style={{ marginLeft: 'auto' }}>New KQL database</Button>
            </DialogTrigger>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Create KQL database</DialogTitle>
                <DialogContent>
                  <Caption1>Provisions a Microsoft.Kusto/clusters/databases resource via ARM. Hot cache = 7 days, soft-delete = 30 days.</Caption1>
                  <Input
                    placeholder="database-name"
                    value={newName}
                    onChange={(_: unknown, d: any) => setNewName(d.value)}
                    style={{ marginTop: 12, width: '100%' }}
                  />
                  {createErr && (
                    <MessageBar intent="error" style={{ marginTop: 12 }}>
                      <MessageBarBody>{createErr}</MessageBarBody>
                    </MessageBar>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setDialogOpen(false)}>Cancel</Button>
                  <Button appearance="primary" onClick={createDb} disabled={creating || !newName.trim()}>
                    {creating ? 'Creating…' : 'Create'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>

        {!state && <Spinner size="small" label="Loading cluster…" />}
        {state && !state.ok && (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Cluster unreachable</MessageBarTitle>
              {state.error || 'Unknown error'}
            </MessageBarBody>
          </MessageBar>
        )}
        {state?.ok && (
          <>
            <Subtitle2>Databases ({dbCount})</Subtitle2>
            <div className={s.cardGrid}>
              {(state.databases || []).map((d) => {
                const isSelected = selectedDb === d.name;
                return (
                  <div
                    key={d.name}
                    className={s.card}
                    onClick={() => setSelectedDb(d.name)}
                    onDoubleClick={() => openKqlEditor(d.name)}
                    role="button"
                    tabIndex={0}
                    style={{
                      cursor: 'pointer',
                      borderColor: isSelected ? tokens.colorBrandStroke1 : undefined,
                      borderWidth: isSelected ? 2 : undefined,
                      backgroundColor: isSelected ? tokens.colorNeutralBackground1Selected : undefined,
                    }}
                  >
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>KQL database</Caption1>
                    <div style={{ fontSize: 18, fontWeight: 600 }}>{d.name}</div>
                    {d.prettyName && d.prettyName !== d.name && <Caption1>{d.prettyName}</Caption1>}
                    <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                      {d.name === state.defaultDatabase && <Badge appearance="filled" color="brand">default</Badge>}
                      {isSelected && <Badge appearance="outline" color="informative">selected</Badge>}
                    </div>
                    <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                      <Button size="small" appearance="primary" onClick={(e) => { e.stopPropagation(); openKqlEditor(d.name); }}>
                        Query
                      </Button>
                      <Button size="small" appearance="outline" onClick={(e) => { e.stopPropagation(); setSelectedDb(d.name); setGetDataOpen(true); }}>
                        Get data
                      </Button>
                    </div>
                  </div>
                );
              })}
              {(!state.databases || state.databases.length === 0) && (
                <Caption1>No databases yet. Click <strong>New KQL database</strong> to create one.</Caption1>
              )}
            </div>

            {/* Get data dialog — file / event hub / OneLake */}
            <Dialog open={getDataOpen} onOpenChange={(_, d) => setGetDataOpen(d.open)}>
              <DialogSurface style={{ maxWidth: 520 }}>
                <DialogBody>
                  <DialogTitle>Get data into KQL</DialogTitle>
                  <DialogContent>
                    <Caption1>Target database: <strong>{selectedDb || '(none)'}</strong></Caption1>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                      <div>
                        <Label>Source</Label>
                        <Select value={getDataMode} onChange={(_, d) => setGetDataMode(d.value as any)}>
                          <option value="file">Upload file (CSV / JSON / Parquet)</option>
                          <option value="eventhub">Event Hub (streaming)</option>
                          <option value="onelake">OneLake / ADLS Gen2 path</option>
                        </Select>
                      </div>
                      <div>
                        <Label>Target table name</Label>
                        <Input value={getDataTable} onChange={(_, d) => setGetDataTable(d.value)} placeholder="raw_events" />
                      </div>
                      {getDataMode === 'file' && (
                        <div>
                          <Label>File</Label>
                          <input type="file" onChange={(e) => setGetDataFile(e.target.files?.[0] || null)} />
                          {getDataFile && (
                            <Caption1>{getDataFile.name} ({(getDataFile.size / 1024).toFixed(1)} KB)</Caption1>
                          )}
                        </div>
                      )}
                      {getDataMode === 'eventhub' && (
                        <>
                          <div>
                            <Label>Event Hub name</Label>
                            <Input value={getDataHubName} onChange={(_, d) => setGetDataHubName(d.value)} placeholder="orders-hub" />
                          </div>
                          <div>
                            <Label>Consumer group</Label>
                            <Input value={getDataConsumer} onChange={(_, d) => setGetDataConsumer(d.value)} placeholder="$Default" />
                          </div>
                        </>
                      )}
                      {getDataMode === 'onelake' && (
                        <div>
                          <Label>OneLake path</Label>
                          <Input value={getDataOneLakePath} onChange={(_, d) => setGetDataOneLakePath(d.value)} placeholder="abfss://bronze@account.dfs.core.windows.net/folder/" />
                        </div>
                      )}
                    </div>
                    {getDataResult && (
                      <MessageBar intent={getDataResult.ok ? 'success' : 'error'} style={{ marginTop: 12 }}>
                        <MessageBarBody>
                          {getDataResult.ok
                            ? `Ingested ${getDataResult.rows ?? '?'} rows into ${getDataResult.tableName || getDataTable}`
                            : getDataResult.error}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setGetDataOpen(false)}>Close</Button>
                    <Button appearance="primary" onClick={onIngest} disabled={getDataBusy || !selectedDb || !getDataTable.trim()}>
                      {getDataBusy ? 'Ingesting…' : 'Ingest'}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>

            {/* Data policies dialog — hot cache / soft delete / OneLake availability */}
            <Dialog open={policiesOpen} onOpenChange={(_, d) => setPoliciesOpen(d.open)}>
              <DialogSurface style={{ maxWidth: 500 }}>
                <DialogBody>
                  <DialogTitle>Data policies — {selectedDb}</DialogTitle>
                  <DialogContent>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div>
                        <Label>Hot cache (days)</Label>
                        <Input
                          type="number"
                          value={String(hotCacheDays)}
                          onChange={(_, d) => setHotCacheDays(Math.max(0, parseInt(d.value, 10) || 0))}
                        />
                        <Caption1>How many days of data live in SSD cache for sub-second queries.</Caption1>
                      </div>
                      <div>
                        <Label>Soft delete (days)</Label>
                        <Input
                          type="number"
                          value={String(softDeleteDays)}
                          onChange={(_, d) => setSoftDeleteDays(Math.max(1, parseInt(d.value, 10) || 1))}
                        />
                        <Caption1>How many days data is retained before automatic delete.</Caption1>
                      </div>
                      <div>
                        <Label>OneLake availability</Label>
                        <Switch
                          checked={oneLakeEnabled}
                          onChange={(_, d) => setOneLakeEnabled(!!d.checked)}
                          label={oneLakeEnabled ? 'Mirrored to OneLake' : 'Not mirrored'}
                        />
                        <Caption1>Fabric-managed eventhouses only. Mirrors KQL tables into OneLake as Delta for Spark/Power BI.</Caption1>
                      </div>
                    </div>
                    {policiesErr && (
                      <MessageBar intent="error" style={{ marginTop: 12 }}>
                        <MessageBarBody>{policiesErr}</MessageBarBody>
                      </MessageBar>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setPoliciesOpen(false)}>Cancel</Button>
                    <Button appearance="primary" onClick={applyPolicies} disabled={policiesBusy}>
                      {policiesBusy ? 'Applying…' : 'Apply'}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
          </>
        )}
      </div>
    } />
  );
}

// ----- KQL Database -----
// Ribbon is built inside the editor via useMemo. None of the actions
// below have inline handlers yet (table creation, schema mgmt, ingestion
// wizards all land in a follow-up PR) so each is disabled with a
// "not yet wired" tooltip — see no-vaporware.md.

interface KqlDbInfo {
  ok: boolean;
  cluster?: string;
  database?: string;
  details?: Record<string, unknown> | null;
  tables?: Array<{ name: string }>;
  tableCount?: number;
  error?: string;
}

const SAMPLE_KQL_DB = `// Welcome to KQL. Try a sample:
print smoke = "ok", server_time = now(), current_user = current_principal()`;

type KqlWizardKind = 'table' | 'mv' | 'function' | 'update-policy' | 'ingest';

export function KqlDatabaseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [info, setInfo] = useState<KqlDbInfo | null>(null);
  const [kql, setKql] = useState(SAMPLE_KQL_DB);
  const [result, setResult] = useState<KqlResult | null>(null);
  const [loading, setLoading] = useState(false);
  // Wizard dialog state — Fabric-parity create flows for table/MV/function/update-policy
  const [wizardKind, setWizardKind] = useState<KqlWizardKind | null>(null);
  const [wizName, setWizName] = useState('');
  const [wizSchema, setWizSchema] = useState('ts:datetime, tenant:string, value:long');
  const [wizSource, setWizSource] = useState(''); // table name (mv source / update policy source)
  const [wizQuery, setWizQuery] = useState(''); // MV query / function body / update policy query
  const [wizArgs, setWizArgs] = useState(''); // function arg list, e.g. "x:long"
  const [wizError, setWizError] = useState<string | null>(null);
  const [wizSubmitting, setWizSubmitting] = useState(false);
  const [wizSuccess, setWizSuccess] = useState<string | null>(null);
  // Ingest wizard
  const [wizIngestFile, setWizIngestFile] = useState<File | null>(null);

  const load = useCallback(async () => {
    // Pre-save gate: /items/kql-database/new fires this before any record exists.
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/kql-database/${id}`);
      const j = (await r.json()) as KqlDbInfo;
      setInfo(j);
    } catch (e: any) {
      setInfo({ ok: false, error: e?.message || String(e) });
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const run = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kql }),
      });
      setResult((await r.json()) as KqlResult);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setLoading(false);
    }
  }, [id, kql]);

  const sizeMb = useMemo(() => {
    const v = info?.details?.OriginalSize as number | undefined;
    return typeof v === 'number' ? (v / (1024 * 1024)).toFixed(1) : null;
  }, [info]);

  const openWizard = useCallback((k: KqlWizardKind) => {
    setWizardKind(k); setWizError(null); setWizSuccess(null);
    setWizName(''); setWizSchema('ts:datetime, tenant:string, value:long');
    setWizSource(''); setWizQuery(''); setWizArgs(''); setWizIngestFile(null);
  }, []);

  // Issue a `.create` mgmt command via the existing query route (POST is the
  // same; mgmt commands starting with `.` are auto-routed to /v1/rest/mgmt).
  const submitWizard = useCallback(async () => {
    if (!wizardKind) return;
    setWizError(null); setWizSuccess(null);
    if (wizardKind !== 'ingest' && !wizName.trim()) {
      setWizError('Name is required');
      return;
    }
    let mgmtCmd = '';
    switch (wizardKind) {
      case 'table':
        // Fabric parity: .create table TableName (col:type, col:type, …)
        mgmtCmd = `.create table ${wizName} (${wizSchema})`;
        break;
      case 'mv':
        if (!wizSource || !wizQuery) { setWizError('Source table + query required'); return; }
        // .create materialized-view NAME on table SRC { QUERY }
        mgmtCmd = `.create materialized-view ${wizName} on table ${wizSource} { ${wizQuery} }`;
        break;
      case 'function':
        // .create function NAME(args) { body }
        mgmtCmd = `.create-or-alter function with (folder = "Loom", docstring = "Created via CSA Loom") ${wizName}(${wizArgs}) { ${wizQuery} }`;
        break;
      case 'update-policy':
        if (!wizSource || !wizQuery) { setWizError('Source + transform query required'); return; }
        // .alter table TGT policy update @'[{"IsEnabled":true,"Source":"SRC","Query":"<KQL>","IsTransactional":false,"PropagateIngestionProperties":false}]'
        {
          const policyArr = [{ IsEnabled: true, Source: wizSource, Query: wizQuery, IsTransactional: false, PropagateIngestionProperties: false }];
          mgmtCmd = `.alter table ${wizName} policy update @'${JSON.stringify(policyArr)}'`;
        }
        break;
      case 'ingest': {
        if (!wizIngestFile) { setWizError('Choose a file to ingest'); return; }
        // Real ingest: POST multipart to /api/items/eventhouse/[id]/ingest is per-eventhouse;
        // for kql-database we accept a one-shot KQL `.ingest inline into table` for very small files.
        if (wizIngestFile.size > 5 * 1024 * 1024) { setWizError('File too large for inline ingest (5 MB max). Use a Get-data pipeline.'); return; }
        if (!wizSource) { setWizError('Target table required'); return; }
        const text = await wizIngestFile.text();
        // .ingest inline only supports CSV without header. Strip first line if user pasted CSV.
        const lines = text.split(/\r?\n/).filter(Boolean);
        if (lines.length > 0 && /[a-zA-Z]/.test(lines[0])) lines.shift(); // strip header
        const body = lines.join('\n');
        mgmtCmd = `.ingest inline into table ${wizSource} <|\n${body}`;
        break;
      }
    }
    setWizSubmitting(true);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kql: mgmtCmd }),
      });
      const j = await r.json();
      if (!j.ok) {
        setWizError(j.error || 'Command failed');
      } else {
        setWizSuccess(`Done. ${j.rowCount ?? 0} rows. Refreshing…`);
        await load();
        setTimeout(() => { setWizardKind(null); }, 600);
      }
    } catch (e: any) {
      setWizError(e?.message || String(e));
    } finally {
      setWizSubmitting(false);
    }
  }, [wizardKind, wizName, wizSchema, wizSource, wizQuery, wizArgs, wizIngestFile, id, load]);

  const ribbon: RibbonTab[] = useMemo(() => {
    return [
      { id: 'home', label: 'Home', groups: [
        { label: 'New', actions: [
          { label: 'Table', onClick: () => openWizard('table') },
          { label: 'Materialized view', onClick: () => openWizard('mv') },
          { label: 'Function', onClick: () => openWizard('function') },
          { label: 'Update policy', onClick: () => openWizard('update-policy') },
          { label: 'Shortcut', disabled: true, title: 'OneLake shortcut wizard requires Fabric onelake API consent — pending tenant bootstrap' },
        ]},
        { label: 'Data', actions: [
          { label: 'Get data', onClick: () => openWizard('ingest') },
          { label: 'Query with code', onClick: () => {
            // Already in code editor — focus the textarea.
            const el = document.querySelector('textarea[aria-label="KQL query editor"]') as HTMLTextAreaElement | null;
            el?.focus();
          } },
        ]},
        { label: 'Manage', actions: [
          { label: 'Data policies', onClick: () => { setKql('.show database policy caching\n.show database policy retention'); } },
          { label: 'OneLake availability', disabled: true, title: 'OneLake mirroring requires Fabric-managed cluster (LOOM_KUSTO_FABRIC_MANAGED=true)' },
        ]},
      ]},
    ];
  }, [openWizard]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Tree aria-label="KQL DB explorer" defaultOpenItems={['tables', 'info']}>
            <TreeItem itemType="branch" value="info">
              <TreeItemLayout iconBefore={<Database20Regular />}>{info?.database || 'database'}</TreeItemLayout>
              <Tree>
                {sizeMb && <TreeItem itemType="leaf" value="size"><TreeItemLayout>Size: {sizeMb} MB</TreeItemLayout></TreeItem>}
                {typeof info?.details?.HotCachePeriod === 'string' && (
                  <TreeItem itemType="leaf" value="hot"><TreeItemLayout>Hot cache: {String(info.details.HotCachePeriod)}</TreeItemLayout></TreeItem>
                )}
                {typeof info?.details?.SoftDeletePeriod === 'string' && (
                  <TreeItem itemType="leaf" value="soft"><TreeItemLayout>Soft-delete: {String(info.details.SoftDeletePeriod)}</TreeItemLayout></TreeItem>
                )}
              </Tree>
            </TreeItem>
            <TreeItem itemType="branch" value="tables">
              <TreeItemLayout iconBefore={<DocumentTable20Regular />}>Tables ({info?.tableCount ?? 0})</TreeItemLayout>
              <Tree>
                {(info?.tables || []).map((t) => (
                  <TreeItem
                    key={t.name}
                    itemType="leaf"
                    value={`t-${t.name}`}
                    onClick={() => setKql(`["${t.name}"]\n| take 100`)}
                  >
                    <TreeItemLayout iconBefore={<DocumentTable20Regular />}>{t.name}</TreeItemLayout>
                  </TreeItem>
                ))}
                {info?.ok && (info?.tableCount ?? 0) === 0 && (
                  <TreeItem itemType="leaf" value="none"><TreeItemLayout>No tables yet. Use <code>.create table</code>.</TreeItemLayout></TreeItem>
                )}
              </Tree>
            </TreeItem>
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">KQL Database</Badge>
            <Badge appearance="outline" color={info?.ok ? 'success' : 'severe'}>
              {info?.cluster || 'cluster not configured'}
            </Badge>
            <Caption1>db: <strong>{info?.database || '—'}</strong></Caption1>
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={load}>Refresh</Button>
            <Button appearance="primary" icon={<Play20Regular />} disabled={loading} onClick={run} style={{ marginLeft: 'auto' }}>
              {loading ? 'Running…' : 'Run (Shift+Enter)'}
            </Button>
          </div>
          {info && !info.ok && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Database unavailable</MessageBarTitle>
                {info.error || 'Unknown error'}
              </MessageBarBody>
            </MessageBar>
          )}
          <MonacoTextarea
            value={kql}
            onChange={setKql}
            language="kql"
            height={240}
            minHeight={180}
            ariaLabel="KQL query editor"
          />
          <KqlResultsPanel result={result} loading={loading} />

          <Dialog open={!!wizardKind} onOpenChange={(_: unknown, d: any) => { if (!d.open) setWizardKind(null); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>
                  {wizardKind === 'table' && 'New table (.create table)'}
                  {wizardKind === 'mv' && 'New materialized view (.create materialized-view)'}
                  {wizardKind === 'function' && 'New function (.create-or-alter function)'}
                  {wizardKind === 'update-policy' && 'New update policy (.alter table policy update)'}
                  {wizardKind === 'ingest' && 'Get data — inline ingest (.ingest inline into table)'}
                </DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {wizardKind === 'table' && (
                      <>
                        <Caption1>Table name</Caption1>
                        <Input value={wizName} onChange={(_: unknown, d: any) => setWizName(d.value)} placeholder="events" />
                        <Caption1>Schema (col:type, col:type, …)</Caption1>
                        <Textarea value={wizSchema} onChange={(_: unknown, d: any) => setWizSchema(d.value)} rows={3} style={{ fontFamily: 'Consolas, monospace' }} />
                      </>
                    )}
                    {wizardKind === 'mv' && (
                      <>
                        <Caption1>View name</Caption1>
                        <Input value={wizName} onChange={(_: unknown, d: any) => setWizName(d.value)} placeholder="events_daily" />
                        <Caption1>Source table</Caption1>
                        <Input value={wizSource} onChange={(_: unknown, d: any) => setWizSource(d.value)} placeholder="events" />
                        <Caption1>Query (one row per group key)</Caption1>
                        <Textarea value={wizQuery} onChange={(_: unknown, d: any) => setWizQuery(d.value)} rows={5} style={{ fontFamily: 'Consolas, monospace' }} placeholder="events | summarize cnt = count() by bin(ts, 1d)" />
                      </>
                    )}
                    {wizardKind === 'function' && (
                      <>
                        <Caption1>Function name</Caption1>
                        <Input value={wizName} onChange={(_: unknown, d: any) => setWizName(d.value)} placeholder="fn_recent_events" />
                        <Caption1>Argument list (e.g. <code>days:int</code>)</Caption1>
                        <Input value={wizArgs} onChange={(_: unknown, d: any) => setWizArgs(d.value)} placeholder="days:int" />
                        <Caption1>Body</Caption1>
                        <Textarea value={wizQuery} onChange={(_: unknown, d: any) => setWizQuery(d.value)} rows={5} style={{ fontFamily: 'Consolas, monospace' }} placeholder="events | where ts > ago(days*1d)" />
                      </>
                    )}
                    {wizardKind === 'update-policy' && (
                      <>
                        <Caption1>Target table (receives the transformed rows)</Caption1>
                        <Input value={wizName} onChange={(_: unknown, d: any) => setWizName(d.value)} placeholder="events_silver" />
                        <Caption1>Source table (incoming raw rows)</Caption1>
                        <Input value={wizSource} onChange={(_: unknown, d: any) => setWizSource(d.value)} placeholder="events_raw" />
                        <Caption1>Transform query</Caption1>
                        <Textarea value={wizQuery} onChange={(_: unknown, d: any) => setWizQuery(d.value)} rows={5} style={{ fontFamily: 'Consolas, monospace' }} placeholder="events_raw | extend ts = todatetime(timestamp)" />
                      </>
                    )}
                    {wizardKind === 'ingest' && (
                      <>
                        <Caption1>Target table</Caption1>
                        <Input value={wizSource} onChange={(_: unknown, d: any) => setWizSource(d.value)} placeholder="events" />
                        <Caption1>CSV file (≤5 MB)</Caption1>
                        <input
                          type="file"
                          accept=".csv,text/csv"
                          onChange={(e) => setWizIngestFile(e.target.files?.[0] || null)}
                        />
                        <Caption1>For larger files, use Eventhouse → Get data (configures Event Hub data-connection).</Caption1>
                      </>
                    )}
                    {wizError && <MessageBar intent="error"><MessageBarBody>{wizError}</MessageBarBody></MessageBar>}
                    {wizSuccess && <MessageBar intent="success"><MessageBarBody>{wizSuccess}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setWizardKind(null)} disabled={wizSubmitting}>Cancel</Button>
                  <Button appearance="primary" onClick={submitWizard} disabled={wizSubmitting}>{wizSubmitting ? 'Submitting…' : 'Create'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

// ----- KQL Queryset -----
// Ribbon built inside the editor via useMemo so Run/Save bind to the
// existing inline handlers; the rest stay disabled with reasons.

interface SavedQuery { title: string; kql: string; database?: string; }
interface QuerysetState {
  ok: boolean;
  database?: string;
  defaultDatabase?: string;
  queries?: SavedQuery[];
  error?: string;
}
const SAMPLE_QS: SavedQuery = { title: 'Smoke test', kql: 'print smoke = "ok", server_time = now()' };

export function KqlQuerysetEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [qs, setQs] = useState<QuerysetState | null>(null);
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [draft, setDraft] = useState<SavedQuery>(SAMPLE_QS);
  const [result, setResult] = useState<KqlResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  // Cancel-running-query support — abort the in-flight fetch so the UI
  // doesn't block on a slow KQL. The Kusto cluster keeps running the
  // query server-side until completion, but we drop the response per
  // KQL Queryset Fabric-parity behavior. Real per-request cancellation
  // via X-Cancel-Request-Id is logged as TODO; this is the same level
  // Fabric ships in 2026-Q1.
  const abortRef = useRef<AbortController | null>(null);
  // Save-to-dashboard + Set-alert dialog state
  const [pinDlgOpen, setPinDlgOpen] = useState(false);
  const [pinTitle, setPinTitle] = useState('');
  const [pinDashboardId, setPinDashboardId] = useState('');
  const [pinDashboards, setPinDashboards] = useState<Array<{ id: string; name: string }>>([]);
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [alertDlgOpen, setAlertDlgOpen] = useState(false);
  const [alertActivatorId, setAlertActivatorId] = useState('');
  const [alertName, setAlertName] = useState('');
  const [alertActivators, setAlertActivators] = useState<Array<{ id: string; name: string }>>([]);
  const [alertErr, setAlertErr] = useState<string | null>(null);
  const [alertBusy, setAlertBusy] = useState(false);

  const load = useCallback(async () => {
    // Pre-save gate: /items/kql-queryset/new fires this before any record exists.
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/kql-queryset/${id}`);
      const j = (await r.json()) as QuerysetState;
      setQs(j);
      const arr = j.queries || [];
      setQueries(arr);
      if (arr.length) { setSelectedIdx(0); setDraft(arr[0]); }
    } catch (e: any) {
      setQs({ ok: false, error: e?.message || String(e) });
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Phase 4.5: refuse to silently clobber unsaved edits. If the user
  // selects a different saved query while the current draft is dirty,
  // ask before overwriting. This was the implicit data-loss bug
  // (run-then-edit-then-select-another clobber).
  const select = useCallback((idx: number) => {
    if (dirty && idx !== selectedIdx) {
      const proceed = typeof window !== 'undefined'
        ? window.confirm('Discard unsaved changes to the current query?')
        : true;
      if (!proceed) return;
    }
    setSelectedIdx(idx); setDraft(queries[idx] || SAMPLE_QS); setDirty(false); setResult(null);
    setSaveErr(null); setSaveMsg(null);
  }, [queries, dirty, selectedIdx]);

  const addQuery = useCallback(() => {
    // Phase 4.5 — functional setQueries so back-to-back clicks before
    // re-render cannot drop entries. Carry the dirty draft of the
    // currently-selected query into the queries[] array before appending
    // — otherwise the new entry replaces the user's unsaved edit.
    setQueries((prev) => {
      const carried = prev.map((q, i) => i === selectedIdx ? draft : q);
      const next = [...carried, { title: `Query ${carried.length + 1}`, kql: '' }];
      setSelectedIdx(next.length - 1);
      setDraft(next[next.length - 1]);
      return next;
    });
    setDirty(true); setSaveMsg(null);
  }, [selectedIdx, draft]);

  const deleteQuery = useCallback((idx: number) => {
    // Phase 4.5 — functional setter so multiple deletes in flight don't
    // operate on a stale array.
    setQueries((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      const newIdx = Math.max(0, Math.min(idx - 1, next.length - 1));
      setSelectedIdx(newIdx);
      setDraft(next[newIdx] || SAMPLE_QS);
      return next;
    });
    setDirty(true); setSaveMsg(null);
  }, []);

  const saveAll = useCallback(async () => {
    setSaving(true); setSaveErr(null); setSaveMsg('Saving…');
    // Capture the queries snapshot WITH the current draft folded in at
    // click time. If a Run is in flight when save fires, runs only read
    // draft.kql — they never write back to queries[] — so the merge here
    // is the authoritative source.
    const updated = queries.map((q, i) => i === selectedIdx ? draft : q);
    try {
      const r = await fetch(`/api/items/kql-queryset/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queries: updated }),
      });
      const j = await r.json();
      if (!j.ok) {
        setSaveErr(j.error || 'save failed');
        setSaveMsg(`Save failed: ${j.error || 'unknown'}`);
        return;
      }
      // Server-confirmed queries. Adopt them, but preserve the user's
      // selected index — server may reorder/normalize but in practice the
      // PUT echoes back the same array we sent.
      const serverQueries: SavedQuery[] = j.queries || updated;
      setQueries(serverQueries);
      // Re-sync draft from the saved row so dirty=false is honest.
      const savedRow = serverQueries[selectedIdx] || serverQueries[0] || SAMPLE_QS;
      setDraft(savedRow);
      setDirty(false);
      setSaveMsg(`Saved at ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
      setSaveMsg(`Save failed: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  }, [id, queries, selectedIdx, draft]);

  // Ctrl+S / Cmd+S to save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && !saving && queries.length) saveAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, saving, queries.length, saveAll]);

  const run = useCallback(async () => {
    setLoading(true); setResult(null);
    // Pin the kql/database we're sending at click-time so any subsequent
    // edits the user makes mid-run cannot influence what was executed.
    const payload = { kql: draft.kql, database: draft.database };
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const r = await fetch(`/api/items/kql-queryset/${id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      setResult((await r.json()) as KqlResult);
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        setResult({ ok: false, error: 'Cancelled by user' });
      } else {
        setResult({ ok: false, error: e?.message || String(e) });
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [id, draft]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Pin to dashboard — list dashboards, then PUT the dashboard with a new tile.
  const openPinDialog = useCallback(async () => {
    setPinDlgOpen(true);
    setPinErr(null);
    setPinTitle(draft.title || 'Pinned from queryset');
    try {
      const r = await fetch('/api/items?type=kql-dashboard');
      const j = await r.json();
      const arr: Array<{ id: string; displayName?: string; name?: string }> = j?.items || j?.value || [];
      const dashboards = arr.map((d) => ({ id: d.id, name: d.displayName || d.name || d.id }));
      setPinDashboards(dashboards);
      if (dashboards[0]) setPinDashboardId(dashboards[0].id);
    } catch (e: any) {
      setPinErr(e?.message || String(e));
    }
  }, [draft.title]);

  const submitPin = useCallback(async () => {
    if (!pinDashboardId) { setPinErr('Choose a dashboard'); return; }
    if (!draft.kql.trim()) { setPinErr('Query is empty'); return; }
    setPinBusy(true); setPinErr(null);
    try {
      // Read current tiles + append; PUT the new array.
      const cur = await fetch(`/api/items/kql-dashboard/${pinDashboardId}`).then((r) => r.json());
      const tiles = Array.isArray(cur?.tiles) ? cur.tiles : [];
      tiles.push({ title: pinTitle || draft.title || 'Pinned tile', kql: draft.kql, viz: 'table', database: draft.database });
      const r = await fetch(`/api/items/kql-dashboard/${pinDashboardId}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tiles }),
      });
      const j = await r.json();
      if (!j.ok) { setPinErr(j.error || 'pin failed'); return; }
      setPinDlgOpen(false);
    } catch (e: any) {
      setPinErr(e?.message || String(e));
    } finally {
      setPinBusy(false);
    }
  }, [pinDashboardId, pinTitle, draft]);

  // Set alert (Activator rule from query). List activators, post rule.
  const openAlertDialog = useCallback(async () => {
    setAlertDlgOpen(true);
    setAlertErr(null);
    setAlertName(`alert-${(draft.title || 'queryset').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`);
    try {
      const r = await fetch('/api/items?type=activator');
      const j = await r.json();
      const arr: Array<{ id: string; displayName?: string; name?: string }> = j?.items || j?.value || [];
      const acts = arr.map((d) => ({ id: d.id, name: d.displayName || d.name || d.id }));
      setAlertActivators(acts);
      if (acts[0]) setAlertActivatorId(acts[0].id);
    } catch (e: any) {
      setAlertErr(e?.message || String(e));
    }
  }, [draft.title]);

  const submitAlert = useCallback(async () => {
    if (!alertActivatorId) { setAlertErr('Choose an Activator'); return; }
    if (!draft.kql.trim()) { setAlertErr('Query is empty'); return; }
    setAlertBusy(true); setAlertErr(null);
    try {
      const r = await fetch(`/api/items/activator/${alertActivatorId}/rules`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: alertName,
          trigger: { kind: 'kql', kql: draft.kql, database: draft.database },
          action: { kind: 'noop', note: 'Pinned from KQL Queryset — choose an action template in Activator' },
        }),
      });
      const j = await r.json();
      if (!j.ok) { setAlertErr(j.error || 'create-rule failed'); return; }
      setAlertDlgOpen(false);
    } catch (e: any) {
      setAlertErr(e?.message || String(e));
    } finally {
      setAlertBusy(false);
    }
  }, [alertActivatorId, alertName, draft]);

  const canRun = !loading && !!draft.kql.trim();
  const canSave = !saving && queries.length > 0 && dirty;
  const canPinAlert = !!draft.kql.trim();
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Run', actions: [
        { label: loading ? 'Running…' : 'Run', onClick: canRun ? run : undefined, disabled: !canRun },
        { label: 'Cancel', onClick: loading ? cancel : undefined, disabled: !loading },
      ]},
      { label: 'Save', actions: [
        { label: saving ? 'Saving…' : 'Save query', onClick: canSave ? saveAll : undefined, disabled: !canSave },
        { label: 'Save to dashboard', onClick: canPinAlert ? openPinDialog : undefined, disabled: !canPinAlert },
        { label: 'Set alert', onClick: canPinAlert ? openAlertDialog : undefined, disabled: !canPinAlert },
      ]},
    ]},
  ], [loading, canRun, run, cancel, saving, canSave, saveAll, canPinAlert, openPinDialog, openAlertDialog]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <Subtitle2>Queries</Subtitle2>
            <Button size="small" icon={<Add20Regular />} onClick={addQuery} appearance="subtle">New</Button>
          </div>
          <Tree aria-label="Saved queries">
            {queries.length === 0 && <Caption1>No queries yet. Click <strong>New</strong>.</Caption1>}
            {queries.map((q, i) => (
              <TreeItem key={i} itemType="leaf" value={`q-${i}`} onClick={() => select(i)}>
                <TreeItemLayout
                  iconBefore={<DocumentTable20Regular />}
                  aside={
                    <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={(e: any) => { e.stopPropagation(); deleteQuery(i); }} aria-label="Delete query" />
                  }
                >
                  {i === selectedIdx ? <strong>{q.title}</strong> : q.title}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Input value={draft.title} onChange={(_: unknown, d: any) => { setDraft({ ...draft, title: d.value }); setDirty(true); }} placeholder="Query title" style={{ minWidth: 220 }} />
            <Caption1>db: <strong>{draft.database || qs?.database || qs?.defaultDatabase || 'loomdb-default'}</strong></Caption1>
            {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
            <Button appearance="outline" icon={<Save20Regular />} disabled={saving || queries.length === 0 || !dirty} onClick={saveAll}>
              {saving ? 'Saving…' : 'Save (Ctrl+S)'}
            </Button>
            <Button appearance="primary" icon={<Play20Regular />} disabled={loading || !draft.kql.trim()} onClick={run} style={{ marginLeft: 'auto' }}>
              {loading ? 'Running…' : 'Run'}
            </Button>
          </div>
          {saveMsg && !saveErr && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{saveMsg}</Caption1>}
          {saveErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{saveErr}</MessageBarBody></MessageBar>}
          {qs && !qs.ok && <MessageBar intent="error"><MessageBarBody>{qs.error}</MessageBarBody></MessageBar>}
          <MonacoTextarea
            value={draft.kql}
            onChange={(v) => { setDraft({ ...draft, kql: v }); setDirty(true); }}
            language="kql"
            height={240}
            minHeight={180}
            ariaLabel="KQL query"
          />
          <KqlResultsPanel result={result} loading={loading} />

          <Dialog open={pinDlgOpen} onOpenChange={(_: unknown, d: any) => setPinDlgOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Save query to KQL Dashboard</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <Caption1>Tile title</Caption1>
                    <Input value={pinTitle} onChange={(_: unknown, d: any) => setPinTitle(d.value)} />
                    <Caption1>Dashboard</Caption1>
                    <Select value={pinDashboardId} onChange={(_: unknown, d: any) => setPinDashboardId(d.value)}>
                      <option value="">(select…)</option>
                      {pinDashboards.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </Select>
                    {pinErr && <MessageBar intent="error"><MessageBarBody>{pinErr}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setPinDlgOpen(false)} disabled={pinBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={submitPin} disabled={pinBusy}>{pinBusy ? 'Saving…' : 'Pin'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <Dialog open={alertDlgOpen} onOpenChange={(_: unknown, d: any) => setAlertDlgOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Create Activator rule from query</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <Caption1>Rule name</Caption1>
                    <Input value={alertName} onChange={(_: unknown, d: any) => setAlertName(d.value)} />
                    <Caption1>Activator</Caption1>
                    <Select value={alertActivatorId} onChange={(_: unknown, d: any) => setAlertActivatorId(d.value)}>
                      <option value="">(select…)</option>
                      {alertActivators.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </Select>
                    {alertErr && <MessageBar intent="error"><MessageBarBody>{alertErr}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setAlertDlgOpen(false)} disabled={alertBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={submitAlert} disabled={alertBusy}>{alertBusy ? 'Creating…' : 'Create rule'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

// ----- KQL Dashboard -----
// Ribbon built inside the editor via useMemo so Add tile binds to the
// existing inline addTile handler; the rest stay disabled with reasons.

interface Tile {
  title: string;
  kql: string;
  viz: 'table' | 'line' | 'bar';
  database?: string;
  result?: KqlResult;
  error?: string;
}

interface DashboardState {
  ok: boolean;
  database?: string;
  defaultDatabase?: string;
  tiles?: Tile[];
  error?: string;
}

type TimeRangeKey = 'last-15m' | 'last-1h' | 'last-24h' | 'last-7d' | 'last-30d' | 'all';

const TIME_RANGE_TO_KQL: Record<TimeRangeKey, string> = {
  'last-15m': 'ago(15m)',
  'last-1h':  'ago(1h)',
  'last-24h': 'ago(24h)',
  'last-7d':  'ago(7d)',
  'last-30d': 'ago(30d)',
  'all':      'datetime(1970-01-01)',
};

export function KqlDashboardEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [state, setState] = useState<DashboardState | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  // Auto-refresh — interval in ms; 0 = off. Persisted to state via PUT.
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  // Time range — passed to /run as a query param so the BFF can substitute
  // `_loomTimeFrom` placeholder in tile KQL when present.
  const [timeRange, setTimeRange] = useState<TimeRangeKey>('last-24h');
  // Dashboard params — k/v list of operator-supplied dashboard parameters,
  // surfaced in tile KQL as `_loomParam_<name>`.
  const [paramsOpen, setParamsOpen] = useState(false);
  const [paramRows, setParamRows] = useState<Array<{ key: string; value: string }>>([]);
  // Share dialog — copies the canonical URL + reminds the operator about RBAC.
  const [shareOpen, setShareOpen] = useState(false);

  const load = useCallback(async (runTiles = false) => {
    // Pre-save gate: /items/kql-dashboard/new fires this before any record exists.
    if (!id || id === 'new') return;
    const params = new URLSearchParams();
    if (runTiles) params.set('run', '1');
    if (runTiles) params.set('time', timeRange);
    for (const r of paramRows) {
      if (r.key.trim()) params.set(`param.${r.key.trim()}`, r.value);
    }
    const qs = params.toString();
    try {
      const r = await fetch(`/api/items/kql-dashboard/${id}${qs ? '?' + qs : ''}`);
      const j = (await r.json()) as DashboardState;
      setState(j); setTiles(j.tiles || []); setDirty(false);
    } catch (e: any) {
      setState({ ok: false, error: e?.message || String(e) });
    }
  }, [id, timeRange, paramRows]);

  useEffect(() => { load(true); }, [load]);

  const addTile = useCallback(() => {
    // Phase 4.5 — functional setter so rapid clicks each create a new tile.
    setTiles((prev) => {
      const next: Tile[] = [...prev, { title: `Tile ${prev.length + 1}`, kql: 'print value = 1', viz: 'table' }];
      setExpandedIdx(next.length - 1);
      return next;
    });
    setDirty(true);
  }, []);

  const deleteTile = useCallback((idx: number) => {
    setTiles((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
    setExpandedIdx((cur) => (cur === idx ? null : cur));
  }, []);

  const updateTile = useCallback((idx: number, patch: Partial<Tile>) => {
    // Phase 4.5 — functional setter prevents one keystroke from clobbering
    // another when the user types fast in the inline editor.
    setTiles((prev) => prev.map((t, i) => i === idx ? { ...t, ...patch } : t));
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    setSaving(true); setSaveErr(null); setSaveMsg('Saving…');
    // Pin tiles snapshot at click time. Strip runtime-only fields.
    const payload = tiles.map(({ result, error, ...t }) => t);
    try {
      const r = await fetch(`/api/items/kql-dashboard/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tiles: payload }),
      });
      const j = await r.json();
      if (j.ok) {
        setDirty(false);
        setSaveMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      } else {
        setSaveErr(j.error || 'save failed');
        setSaveMsg(`Save failed: ${j.error || 'unknown'}`);
      }
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
      setSaveMsg(`Save failed: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  }, [id, tiles]);

  // Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && !saving) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, saving, save]);

  const openJson = useCallback(() => {
    setJsonText(JSON.stringify(tiles.map(({ result, error, ...t }) => t), null, 2));
    setJsonErr(null);
    setJsonOpen(true);
  }, [tiles]);

  const applyJson = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      if (!Array.isArray(parsed)) {
        setJsonErr('JSON root must be an array of tiles');
        return;
      }
      setTiles(parsed); setDirty(true); setJsonOpen(false); setJsonErr(null);
    } catch (e: any) {
      setJsonErr(e?.message || 'invalid JSON');
    }
  }, [jsonText]);

  // Auto-refresh — when enabled, re-runs every tile every N ms.
  useEffect(() => {
    if (!autoRefreshMs || autoRefreshMs <= 0) return;
    const t = setInterval(() => { load(true); }, autoRefreshMs);
    return () => clearInterval(t);
  }, [autoRefreshMs, load]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Edit', actions: [
        { label: 'Add tile', onClick: addTile },
        { label: 'Add data source', disabled: true, title: 'multi-cluster data source picker pending — single Loom shared cluster only today' },
        { label: 'Parameters', onClick: () => setParamsOpen(true) },
      ]},
      { label: 'View', actions: [
        { label: autoRefreshMs ? `Auto-refresh: ${autoRefreshMs/1000}s (click to cycle)` : 'Auto-refresh: off', onClick: () => {
          // cycle: off → 15s → 30s → 60s → 300s → off
          const cycle = [0, 15000, 30000, 60000, 300000];
          const idx = cycle.indexOf(autoRefreshMs);
          setAutoRefreshMs(cycle[(idx + 1) % cycle.length]);
        } },
        { label: `Time: ${timeRange}`, onClick: () => {
          const order: TimeRangeKey[] = ['last-15m', 'last-1h', 'last-24h', 'last-7d', 'last-30d', 'all'];
          const i = order.indexOf(timeRange);
          setTimeRange(order[(i + 1) % order.length]);
          // After cycling, re-run with new time range.
          load(true);
        } },
        { label: 'Share', onClick: () => setShareOpen(true) },
      ]},
    ]},
  ], [addTile, autoRefreshMs, timeRange, load]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand">KQL Dashboard</Badge>
          <Caption1>db: <strong>{state?.database || 'loomdb-default'}</strong> · {tiles.length} tiles</Caption1>
          {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
          <Button appearance="outline" icon={<Add20Regular />} onClick={addTile}>Add tile</Button>
          <Button appearance="outline" onClick={openJson}>Edit JSON</Button>
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => load(true)}>Re-run all</Button>
          <Button appearance="primary" icon={<Save20Regular />} onClick={save} disabled={saving || !dirty} style={{ marginLeft: 'auto' }}>
            {saving ? 'Saving…' : 'Save (Ctrl+S)'}
          </Button>
        </div>

        {saveMsg && !saveErr && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{saveMsg}</Caption1>}
        {saveErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{saveErr}</MessageBarBody></MessageBar>}
        {state && !state.ok && <MessageBar intent="error"><MessageBarBody>{state.error}</MessageBarBody></MessageBar>}

        <div className={s.cardGrid}>
          {tiles.map((t, i) => (
            <div key={i} className={s.card}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{t.viz.toUpperCase()}</Caption1>
                <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => deleteTile(i)} aria-label="Delete tile" />
              </div>
              <div style={{ fontSize: 16, fontWeight: 600, marginTop: 4 }}>{t.title}</div>
              {t.error && <Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{t.error}</Caption1>}
              {t.result && t.result.ok && (
                <div style={{ marginTop: 8, maxHeight: 120, overflow: 'auto', fontSize: 11, fontFamily: 'Consolas, monospace' }}>
                  {(t.result.rows || []).slice(0, 5).map((row, ri) => (
                    <div key={ri}>{(row as unknown[]).map(fmtCell).join(' | ')}</div>
                  ))}
                  {(t.result.rowCount ?? 0) > 5 && <Caption1>+ {(t.result.rowCount ?? 0) - 5} more rows</Caption1>}
                </div>
              )}
              <Button size="small" appearance="subtle" onClick={() => setExpandedIdx(expandedIdx === i ? null : i)} style={{ marginTop: 8 }}>
                {expandedIdx === i ? 'Collapse' : 'Edit'}
              </Button>
              {expandedIdx === i && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <Input value={t.title} onChange={(_: unknown, d: any) => updateTile(i, { title: d.value })} placeholder="Title" />
                  <Select value={t.viz} onChange={(_: unknown, d: any) => updateTile(i, { viz: d.value as Tile['viz'] })}>
                    <option value="table">table</option>
                    <option value="line">line</option>
                    <option value="bar">bar</option>
                  </Select>
                  <Textarea
                    value={t.kql}
                    onChange={(_: unknown, d: any) => updateTile(i, { kql: d.value })}
                    placeholder="KQL"
                    style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}
                    rows={4}
                  />
                </div>
              )}
            </div>
          ))}
          {tiles.length === 0 && <Caption1>No tiles yet. Click <strong>Add tile</strong>.</Caption1>}
        </div>

        <Dialog open={jsonOpen} onOpenChange={(_: unknown, d: any) => setJsonOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Edit tiles JSON</DialogTitle>
              <DialogContent>
                <Textarea
                  value={jsonText}
                  onChange={(_: unknown, d: any) => { setJsonText(d.value); setJsonErr(null); }}
                  rows={20}
                  style={{ width: '100%', fontFamily: 'Consolas, monospace', fontSize: 12 }}
                />
                {jsonErr && <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody><MessageBarTitle>JSON parse error</MessageBarTitle>{jsonErr}</MessageBarBody></MessageBar>}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setJsonOpen(false)}>Cancel</Button>
                <Button appearance="primary" onClick={applyJson}>Apply</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        <Dialog open={paramsOpen} onOpenChange={(_: unknown, d: any) => setParamsOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Dashboard parameters</DialogTitle>
              <DialogContent>
                <Caption1>
                  Define parameters that the dashboard substitutes into tile KQL. Use{' '}
                  <code>_loomParam_&lt;name&gt;</code> in your KQL where you want the value.
                </Caption1>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                  {paramRows.map((row, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: 8 }}>
                      <Input
                        value={row.key}
                        placeholder="name (alphanumeric)"
                        onChange={(_: unknown, d: any) => setParamRows((rows) => rows.map((r, i) => i === idx ? { ...r, key: d.value } : r))}
                      />
                      <Input
                        value={row.value}
                        placeholder="value"
                        onChange={(_: unknown, d: any) => setParamRows((rows) => rows.map((r, i) => i === idx ? { ...r, value: d.value } : r))}
                      />
                      <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => setParamRows((rows) => rows.filter((_, i) => i !== idx))} aria-label="Remove parameter" />
                    </div>
                  ))}
                  <Button appearance="outline" icon={<Add20Regular />} onClick={() => setParamRows((rows) => [...rows, { key: '', value: '' }])}>
                    Add parameter
                  </Button>
                </div>
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setParamsOpen(false)}>Close</Button>
                <Button appearance="primary" onClick={() => { setParamsOpen(false); load(true); }}>Apply &amp; re-run</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        <Dialog open={shareOpen} onOpenChange={(_: unknown, d: any) => setShareOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Share dashboard</DialogTitle>
              <DialogContent>
                <Caption1>Anyone with access to this Loom item can view it. Permissions are managed via the workspace item ACL.</Caption1>
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Caption1>Canonical URL</Caption1>
                  <Input value={typeof window !== 'undefined' ? window.location.href : ''} readOnly />
                  <Button
                    appearance="outline"
                    onClick={() => {
                      if (typeof navigator !== 'undefined' && navigator.clipboard) {
                        navigator.clipboard.writeText(window.location.href).catch(() => {});
                      }
                    }}
                  >
                    Copy URL
                  </Button>
                  <Caption1>
                    To grant another user access, add them to this item via the workspace permissions
                    page (Loom RBAC). Tenant-wide sharing is not enabled in this deployment.
                  </Caption1>
                </div>
              </DialogContent>
              <DialogActions>
                <Button appearance="primary" onClick={() => setShareOpen(false)}>Close</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
    } />
  );
}

// ----- Eventstream -----
// Ribbon built inside the editor via useMemo so Save binds to the
// existing inline save handler; the rest stay disabled with reasons.

interface StreamCfg {
  source?: Record<string, any>;
  sink?: Record<string, any>;
  transforms?: Array<Record<string, any>>;
}

interface EventstreamState {
  ok: boolean;
  runtimeStatus?: string;
  runtimeNote?: string;
  config?: StreamCfg;
  error?: string;
}

const DEFAULT_ES_CFG: StreamCfg = {
  source: { kind: 'eventhub', namespace: '', name: '', consumerGroup: '$Default' },
  transforms: [],
  sink: { kind: 'kusto', database: 'loomdb-default', table: '' },
};

export function EventstreamEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const ws = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [state, setState] = useState<EventstreamState | null>(null);
  const [cfgText, setCfgText] = useState(JSON.stringify(DEFAULT_ES_CFG, null, 2));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'designer' | 'json'>('designer');

  // Visual designer ↔ JSON sync. Best-effort: when JSON parses we mirror
  // it into the designer; when the designer changes we re-serialize JSON.
  let parsedVisual: VisualPipelineConfig = {};
  try { parsedVisual = JSON.parse(cfgText) as VisualPipelineConfig; } catch { parsedVisual = {}; }

  const onDesignerChange = useCallback((next: VisualPipelineConfig) => {
    // Project back to the on-wire shape { source, transforms[], sink } that the BFF persists.
    const sources = Array.isArray(next.sources) ? next.sources : (next.source ? [next.source] : []);
    const sinks = Array.isArray(next.sinks) ? next.sinks : (next.sink ? [next.sink] : []);
    const projected: any = {
      source: sources[0] as VisualSourceNode | undefined,
      transforms: (next.transforms || []) as VisualTransformNode[],
      sink: sinks[0] as VisualSinkNode | undefined,
    };
    // Preserve multi-source/multi-sink if present so we don't lose data.
    if (sources.length > 1) projected.sources = sources;
    if (sinks.length > 1) projected.sinks = sinks;
    setCfgText(JSON.stringify(projected, null, 2));
    setDirty(true);
    setParseErr(null);
    setSaveErr(null);
  }, []);

  // Auto-pick the first workspace once loaded so the editor isn't blocked
  // on a manual click for the common single-workspace deployments. Users
  // can still switch via the picker below.
  useEffect(() => {
    if (!workspaceId && ws.workspaces && ws.workspaces.length > 0) {
      setWorkspaceId(ws.workspaces[0].id);
    }
  }, [workspaceId, ws.workspaces]);

  const load = useCallback(async () => {
    // Pre-save gate: /items/eventstream/new fires this before any record exists
    // (was returning 404 on the walkthrough validator). Skip the fetch so the
    // editor renders its default DEFAULT_ES_CFG until the user saves.
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/eventstream/${id}`);
      const j = (await r.json()) as EventstreamState;
      setState(j);
      const cfg = j.config && (j.config.source || j.config.sink || (j.config.transforms?.length ?? 0) > 0)
        ? j.config
        : DEFAULT_ES_CFG;
      setCfgText(JSON.stringify(cfg, null, 2));
      setDirty(false);
      setParseErr(null); setSaveErr(null); setSaveMsg(null);
    } catch (e: any) {
      setState({ ok: false, error: e?.message || String(e) });
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async () => {
    setParseErr(null); setSaveErr(null);
    let parsed: StreamCfg;
    try { parsed = JSON.parse(cfgText); }
    catch (e: any) {
      const m = e?.message || 'invalid JSON';
      setParseErr(m);
      setSaveMsg(`Cannot save: JSON parse error — ${m}`);
      return;
    }
    setSaving(true); setSaveMsg('Saving…');
    try {
      const r = await fetch(`/api/items/eventstream/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: parsed }),
      });
      const j = await r.json();
      if (j.ok) {
        setDirty(false);
        setSaveMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      } else {
        setSaveErr(j.error || 'save failed');
        setSaveMsg(`Save failed: ${j.error || 'unknown'}`);
      }
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
      setSaveMsg(`Save failed: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  }, [id, cfgText]);

  // Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && !saving) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, saving, save]);

  const canSave = !saving && dirty;

  // Ribbon-driven add/transform helpers. They mutate cfgText (the on-wire
  // shape) directly so the visual designer + Monaco JSON view stay in sync.
  const ribbonAdd = useCallback(
    (kind: 'source' | 'sink' | 'transform', preset?: Partial<VisualTransformNode>) => {
      let cur: VisualPipelineConfig = {};
      try { cur = JSON.parse(cfgText) as VisualPipelineConfig; } catch { cur = {}; }
      const sources = Array.isArray(cur.sources) ? cur.sources : (cur.source ? [cur.source] : []);
      const sinks = Array.isArray(cur.sinks) ? cur.sinks : (cur.sink ? [cur.sink] : []);
      const transforms = cur.transforms || [];
      if (kind === 'source') {
        sources.push({ kind: 'eventhub', name: `source-${sources.length + 1}`, namespace: '', consumerGroup: '$Default' });
      } else if (kind === 'sink') {
        sinks.push({ kind: 'kusto', name: `sink-${sinks.length + 1}`, database: 'loomdb-default', table: '' });
      } else {
        transforms.push({ kind: (preset?.kind as any) || 'filter', name: `transform-${transforms.length + 1}`, expression: preset?.expression || '' });
      }
      onDesignerChange({ sources, sinks, transforms });
      setActiveTab('designer');
    },
    [cfgText, onDesignerChange],
  );

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Source', actions: [
        { label: 'Add source', onClick: () => ribbonAdd('source') },
        { label: 'Sample data', onClick: () => {
            let cur: VisualPipelineConfig = {};
            try { cur = JSON.parse(cfgText) as VisualPipelineConfig; } catch { cur = {}; }
            const sources = Array.isArray(cur.sources) ? cur.sources : (cur.source ? [cur.source] : []);
            sources.push({ kind: 'sample', name: `sample-${sources.length + 1}` });
            onDesignerChange({ sources, sinks: cur.sinks || (cur.sink ? [cur.sink] : []), transforms: cur.transforms || [] });
            setActiveTab('designer');
          } },
      ]},
      { label: 'Transform', actions: [
        { label: 'Filter', onClick: () => ribbonAdd('transform', { kind: 'filter' }) },
        { label: 'Aggregate', onClick: () => ribbonAdd('transform', { kind: 'aggregate' }) },
        { label: 'Group by', onClick: () => ribbonAdd('transform', { kind: 'group-by' }) },
      ]},
      { label: 'Destination', actions: [
        { label: 'Add destination', onClick: () => ribbonAdd('sink') },
      ]},
      { label: 'Publish', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: canSave ? save : undefined, disabled: !canSave },
        { label: 'Publish', disabled: true, title: 'runtime publish/start gated by v3 Event Hubs → Kusto ingestion executor' },
      ]},
    ]},
  ], [saving, canSave, save, ribbonAdd, cfgText, onDesignerChange]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>v2.1 — configuration only</MessageBarTitle>
            Pipeline metadata is persisted to Cosmos but the Event Hubs &rarr; Kusto ingestion runtime is not yet executing. Real runtime wiring lands in v3.
          </MessageBarBody>
        </MessageBar>

        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand">Eventstream</Badge>
          <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
          {state?.runtimeStatus && <Badge appearance="outline">{state.runtimeStatus}</Badge>}
          {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={load}>Reload</Button>
          <Button appearance="primary" icon={<Save20Regular />} onClick={save} disabled={saving || !dirty} style={{ marginLeft: 'auto' }}>
            {saving ? 'Saving…' : 'Save (Ctrl+S)'}
          </Button>
        </div>

        {saveMsg && !saveErr && !parseErr && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{saveMsg}</Caption1>}
        {state && !state.ok && <MessageBar intent="error"><MessageBarBody>{state.error}</MessageBarBody></MessageBar>}
        {parseErr && (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>JSON parse error</MessageBarTitle>
              {parseErr}
            </MessageBarBody>
          </MessageBar>
        )}
        {saveErr && !parseErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{saveErr}</MessageBarBody></MessageBar>}

        <TabList selectedValue={activeTab} onTabSelect={(_: unknown, d: any) => setActiveTab((d.value as 'designer' | 'json') || 'designer')}>
          <Tab value="designer">Visual designer</Tab>
          <Tab value="json">JSON</Tab>
        </TabList>

        {activeTab === 'designer' && (
          <EventstreamVisualDesigner config={parsedVisual} onChange={onDesignerChange} />
        )}

        {activeTab === 'json' && (
          <>
            <Caption1>Edit the pipeline definition as JSON. Schema: <code>{`{ source, transforms[], sink }`}</code>.</Caption1>
            <MonacoTextarea
              value={cfgText}
              onChange={(v) => { setCfgText(v); setDirty(true); setParseErr(null); setSaveErr(null); }}
              language="json"
              height={360}
              minHeight={300}
              ariaLabel="Eventstream JSON config"
            />
          </>
        )}
      </div>
    } />
  );
}

// ============================================================
// Workspace pickers — two flavors, intentionally NOT interchangeable.
//
// 1. useWorkspaces() → Loom workspaces (Cosmos-backed catalog used by
//    Activator, Eventstream, KQL, Lakehouse, etc.). IDs are Loom UUIDs.
//
// 2. usePowerBiWorkspaces() → Power BI / Fabric groups (returned by the
//    Power BI REST API via the Console UAMI). IDs are Power BI groupIds.
//
// Power BI editors (Report, Paginated Report, Dashboard, Semantic Model,
// Scorecard, Dataflow) MUST use (2) because the embed-token / list / detail
// REST calls expect a Power BI groupId. Passing a Loom UUID returns 404
// PowerBIEntityNotFound. Keeping the two hooks separate makes the
// intentional distinction obvious at call sites.
// ============================================================
interface PbiWorkspaceLite { id: string; name: string; description?: string; }

function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<PbiWorkspaceLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setHint(null);
    try {
      const r = await fetch('/api/loom/workspaces');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed to list workspaces'); setHint(j.hint || null); setWorkspaces([]); }
      else { setWorkspaces(j.workspaces || []); }
    } catch (e: any) {
      setError(e?.message || String(e));
      setWorkspaces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { workspaces, error, hint, loading, reload: load };
}

/**
 * usePowerBiWorkspaces — list real Power BI groups (NOT Loom workspaces).
 *
 * Power BI's list/detail/embed-token REST APIs key on a `workspaceId` that
 * is a Power BI groupId. Passing a Loom Cosmos UUID to those endpoints
 * returns 404 PowerBIEntityNotFound. This hook is the dedicated source for
 * the Report / Paginated Report / Dashboard / Semantic Model / Scorecard /
 * Dataflow editors.
 */
function usePowerBiWorkspaces() {
  const [workspaces, setWorkspaces] = useState<PbiWorkspaceLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setHint(null);
    try {
      const r = await fetch('/api/powerbi/workspaces');
      const j = await r.json();
      if (!j.ok) {
        setError(j.error || 'failed to list Power BI workspaces');
        setHint(j.hint || null);
        setWorkspaces([]);
      } else {
        // Power BI returns name + capacity SKU; surface the capacity in a
        // separate description field so the picker can show it as a hint
        // without polluting the displayed name.
        setWorkspaces(
          (j.workspaces || []).map((w: any) => ({
            id: w.id,
            name: w.name || w.displayName || w.id,
            description: w.capacityType ? `${w.capacityType}${w.isOnDedicatedCapacity ? ' · dedicated' : ''}` : undefined,
          })),
        );
      }
    } catch (e: any) {
      setError(e?.message || String(e));
      setWorkspaces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { workspaces, error, hint, loading, reload: load };
}

function WorkspacePicker({
  value, onChange, error, hint, loading, workspaces,
}: {
  value: string; onChange: (id: string) => void;
  error: string | null; hint: string | null; loading: boolean;
  workspaces: PbiWorkspaceLite[] | null;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 280 }}>
      <Caption1>Workspace</Caption1>
      <Select value={value} onChange={(_: unknown, d: any) => onChange(d.value)} disabled={loading || (workspaces?.length ?? 0) === 0}>
        {!value && <option value="">{loading ? 'Loading workspaces…' : 'Select a workspace'}</option>}
        {(workspaces || []).map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </Select>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Workspaces not reachable</MessageBarTitle>
            {error}{hint ? <><br /><Caption1>{hint}</Caption1></> : null}
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

// ============================================================
// Power BI / Fabric editor shells — v2.1 live REST.
//
// IMPORTANT: All six editors below require the Console UAMI's service
// principal to be (a) registered in the Power BI tenant and (b) added to
// each target workspace. If either is missing, the editor surfaces the
// underlying 401/403 verbatim via MessageBar so the operator knows
// exactly what to fix. No mock data is shown when the call fails.
// ============================================================

// ----- Activator -----
// Ribbon built inside the editor via useMemo so New rule binds to the
// existing setRuleOpen handler; the rest stay disabled with reasons.

interface ActivatorLite {
  id: string; displayName: string; description?: string;
}
interface RuleLite {
  id: string; name: string;
  objectName?: string; propertyName?: string;
  condition?: { operator?: string; value?: unknown };
  action?: { kind?: string; config?: Record<string, unknown> };
  state?: string; lastTriggered?: string;
}

export function ActivatorEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const ws = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [activators, setActivators] = useState<ActivatorLite[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [rules, setRules] = useState<RuleLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [rulesErr, setRulesErr] = useState<string | null>(null);

  // create
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // new rule
  const [ruleOpen, setRuleOpen] = useState(false);
  const [ruleName, setRuleName] = useState('');
  const [ruleCondition, setRuleCondition] = useState('{ "operator": "GreaterThan", "value": 20 }');
  const [ruleAction, setRuleAction] = useState('{ "kind": "TeamsMessage", "config": {} }');
  const [ruleBusy, setRuleBusy] = useState(false);
  const [ruleErr, setRuleErr] = useState<string | null>(null);

  const loadList = useCallback(async (wsId: string) => {
    setLoading(true); setListErr(null);
    try {
      const r = await fetch(`/api/items/activator?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setActivators([]); setListErr(j.error); return; }
      setActivators(j.activators || []);
      // Use functional setSelectedId so we don't have to depend on
      // selectedId in this callback — keeps the workspace-change effect
      // from re-firing every time the user clicks a row.
      setSelectedId((prev) => prev || (j.activators?.[0]?.id ?? ''));
    } catch (e: any) {
      setActivators([]); setListErr(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);

  const loadRules = useCallback(async (wsId: string, actId: string) => {
    setRulesErr(null);
    try {
      const r = await fetch(`/api/items/activator/${encodeURIComponent(actId)}/rules?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setRules([]); setRulesErr(j.error); return; }
      setRules(j.rules || []);
    } catch (e: any) {
      setRules([]); setRulesErr(e?.message || String(e));
    }
  }, []);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && selectedId) loadRules(workspaceId, selectedId); }, [workspaceId, selectedId, loadRules]);

  const createReflex = useCallback(async () => {
    if (!createName.trim() || !workspaceId) return;
    setCreateBusy(true); setCreateErr(null);
    try {
      const r = await fetch(`/api/items/activator?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: createName.trim(), description: createDesc.trim() || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setCreateErr(j.error || 'create failed'); }
      else {
        setCreateOpen(false); setCreateName(''); setCreateDesc('');
        loadList(workspaceId);
      }
    } finally { setCreateBusy(false); }
  }, [createName, createDesc, workspaceId, loadList]);

  const addRule = useCallback(async () => {
    if (!ruleName.trim() || !workspaceId || !selectedId) return;
    setRuleBusy(true); setRuleErr(null);
    let condition: any; let action: any;
    try { condition = JSON.parse(ruleCondition); } catch (e: any) { setRuleErr(`condition JSON: ${e?.message}`); setRuleBusy(false); return; }
    try { action = JSON.parse(ruleAction); } catch (e: any) { setRuleErr(`action JSON: ${e?.message}`); setRuleBusy(false); return; }
    try {
      const r = await fetch(`/api/items/activator/${encodeURIComponent(selectedId)}/rules?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: ruleName.trim(), condition, action }),
      });
      const j = await r.json();
      if (!j.ok) { setRuleErr(j.error || 'add rule failed'); }
      else { setRuleOpen(false); setRuleName(''); loadRules(workspaceId, selectedId); }
    } finally { setRuleBusy(false); }
  }, [ruleName, ruleCondition, ruleAction, workspaceId, selectedId, loadRules]);

  const triggerNow = useCallback(async (ruleId: string) => {
    if (!workspaceId || !selectedId) return;
    const r = await fetch(`/api/items/activator/${encodeURIComponent(selectedId)}/rules?workspaceId=${encodeURIComponent(workspaceId)}&trigger=${encodeURIComponent(ruleId)}`, { method: 'POST' });
    const j = await r.json();
    if (!j.ok) setRulesErr(j.error || 'trigger failed');
    else loadRules(workspaceId, selectedId);
  }, [workspaceId, selectedId, loadRules]);

  const canNewRule = !!selectedId && !!workspaceId;

  // Start/Stop reflex — calls the new /start /stop routes which PATCH every
  // trigger on the reflex to Active/Stopped via Fabric REST.
  const [reflexBusy, setReflexBusy] = useState<'start' | 'stop' | null>(null);
  const [reflexMsg, setReflexMsg] = useState<string | null>(null);
  const startStop = useCallback(async (kind: 'start' | 'stop') => {
    if (!workspaceId || !selectedId) return;
    setReflexBusy(kind); setReflexMsg(null);
    try {
      const r = await fetch(`/api/items/activator/${encodeURIComponent(selectedId)}/${kind}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) setReflexMsg(`${kind} failed: ${j.error || 'unknown'}`);
      else setReflexMsg(`${kind === 'start' ? 'Started' : 'Stopped'} — ${j.updated} trigger(s) updated.`);
      await loadRules(workspaceId, selectedId);
    } catch (e: any) {
      setReflexMsg(`${kind} failed: ${e?.message || String(e)}`);
    } finally {
      setReflexBusy(null);
    }
  }, [workspaceId, selectedId, loadRules]);

  // Action template — pre-fill the New Rule dialog with the common shape.
  const openTemplate = useCallback((kind: 'Email' | 'Teams' | 'Pipeline' | 'Notebook' | 'PowerAutomate') => {
    const templates: Record<typeof kind, string> = {
      Email: JSON.stringify({ kind: 'Email', config: { to: 'alerts@example.com', subject: 'Loom alert', body: '{{eventValue}}' } }, null, 2),
      Teams: JSON.stringify({ kind: 'TeamsMessage', config: { webhookUrl: 'https://outlook.office.com/webhook/...', message: 'Loom alert: {{eventValue}}' } }, null, 2),
      Pipeline: JSON.stringify({ kind: 'AdfPipelineRun', config: { factory: 'adf-loom-default-eastus2', pipeline: 'pl_alert_handler', parameters: {} } }, null, 2),
      Notebook: JSON.stringify({ kind: 'NotebookRun', config: { workspaceId: workspaceId, notebookId: '<notebook-guid>', parameters: {} } }, null, 2),
      PowerAutomate: JSON.stringify({ kind: 'PowerAutomateFlow', config: { triggerUrl: 'https://prod-xx.westus.logic.azure.com/workflows/.../triggers/...' } }, null, 2),
    } as const;
    setRuleName(`alert-${kind.toLowerCase()}-${Date.now().toString(36)}`);
    setRuleAction(templates[kind]);
    setRuleOpen(true);
  }, [workspaceId]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Rules', actions: [
        { label: 'New rule', onClick: canNewRule ? () => setRuleOpen(true) : undefined, disabled: !canNewRule, title: !canNewRule ? 'select a workspace and reflex first' : undefined },
        { label: reflexBusy === 'start' ? 'Starting…' : 'Start', onClick: canNewRule && !reflexBusy ? () => startStop('start') : undefined, disabled: !canNewRule || !!reflexBusy },
        { label: reflexBusy === 'stop' ? 'Stopping…' : 'Stop', onClick: canNewRule && !reflexBusy ? () => startStop('stop') : undefined, disabled: !canNewRule || !!reflexBusy },
      ]},
      { label: 'Actions', actions: [
        { label: 'Email', onClick: canNewRule ? () => openTemplate('Email') : undefined, disabled: !canNewRule },
        { label: 'Teams', onClick: canNewRule ? () => openTemplate('Teams') : undefined, disabled: !canNewRule },
        { label: 'Run pipeline', onClick: canNewRule ? () => openTemplate('Pipeline') : undefined, disabled: !canNewRule },
        { label: 'Run notebook', onClick: canNewRule ? () => openTemplate('Notebook') : undefined, disabled: !canNewRule },
        { label: 'Power Automate', onClick: canNewRule ? () => openTemplate('PowerAutomate') : undefined, disabled: !canNewRule },
      ]},
    ]},
  ], [canNewRule, reflexBusy, startStop, openTemplate]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: 8 }}>Reflexes</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {workspaceId && loading && <Spinner size="tiny" label="Loading…" />}
          {activators && activators.length === 0 && !loading && <Caption1>No reflexes in this workspace.</Caption1>}
          <Tree aria-label="Reflex list">
            {(activators || []).map((a) => (
              <TreeItem key={a.id} itemType="leaf" value={a.id} onClick={() => setSelectedId(a.id)}>
                <TreeItemLayout>{selectedId === a.id ? <strong>{a.displayName}</strong> : a.displayName}</TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Activator (Reflex)</Badge>
            <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh</Button>
            <Dialog open={createOpen} onOpenChange={(_: unknown, d: any) => setCreateOpen(d.open)}>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="primary" icon={<Add20Regular />} disabled={!workspaceId} style={{ marginLeft: 'auto' }}>New reflex</Button>
              </DialogTrigger>
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>Create Activator (reflex)</DialogTitle>
                  <DialogContent>
                    <Input placeholder="displayName" value={createName} onChange={(_: unknown, d: any) => setCreateName(d.value)} style={{ width: '100%' }} />
                    <Input placeholder="description (optional)" value={createDesc} onChange={(_: unknown, d: any) => setCreateDesc(d.value)} style={{ width: '100%', marginTop: 8 }} />
                    {createErr && <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody>{createErr}</MessageBarBody></MessageBar>}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                    <Button appearance="primary" disabled={createBusy || !createName.trim()} onClick={createReflex}>{createBusy ? 'Creating…' : 'Create'}</Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
          </div>
          {listErr && <MessageBar intent="error"><MessageBarBody>{listErr}</MessageBarBody></MessageBar>}
          {reflexMsg && <MessageBar intent={reflexMsg.includes('failed') ? 'error' : 'success'}><MessageBarBody>{reflexMsg}</MessageBarBody></MessageBar>}

          {selectedId && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Subtitle2>Rules</Subtitle2>
                <Dialog open={ruleOpen} onOpenChange={(_: unknown, d: any) => setRuleOpen(d.open)}>
                  <DialogTrigger disableButtonEnhancement>
                    <Button size="small" appearance="outline" icon={<Add20Regular />}>New rule</Button>
                  </DialogTrigger>
                  <DialogSurface>
                    <DialogBody>
                      <DialogTitle>Add rule</DialogTitle>
                      <DialogContent>
                        <Input placeholder="rule name" value={ruleName} onChange={(_: unknown, d: any) => setRuleName(d.value)} style={{ width: '100%' }} />
                        <Caption1 style={{ marginTop: 8 }}>condition JSON</Caption1>
                        <Textarea value={ruleCondition} onChange={(_: unknown, d: any) => setRuleCondition(d.value)} rows={3} style={{ width: '100%', fontFamily: 'Consolas, monospace', fontSize: 12 }} />
                        <Caption1 style={{ marginTop: 8 }}>action JSON</Caption1>
                        <Textarea value={ruleAction} onChange={(_: unknown, d: any) => setRuleAction(d.value)} rows={3} style={{ width: '100%', fontFamily: 'Consolas, monospace', fontSize: 12 }} />
                        {ruleErr && <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody>{ruleErr}</MessageBarBody></MessageBar>}
                      </DialogContent>
                      <DialogActions>
                        <Button appearance="secondary" onClick={() => setRuleOpen(false)}>Cancel</Button>
                        <Button appearance="primary" disabled={ruleBusy || !ruleName.trim()} onClick={addRule}>{ruleBusy ? 'Adding…' : 'Add'}</Button>
                      </DialogActions>
                    </DialogBody>
                  </DialogSurface>
                </Dialog>
              </div>
              {rulesErr && <MessageBar intent="error"><MessageBarBody>{rulesErr}</MessageBarBody></MessageBar>}
              {rules.length === 0 ? (
                <Caption1>No rules on this reflex (or Rules preview API not enabled in this tenant).</Caption1>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Rules" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Object · Property</TableHeaderCell>
                      <TableHeaderCell>Condition</TableHeaderCell>
                      <TableHeaderCell>Action</TableHeaderCell>
                      <TableHeaderCell>State</TableHeaderCell>
                      <TableHeaderCell>Last triggered</TableHeaderCell>
                      <TableHeaderCell></TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {rules.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>{r.name}</TableCell>
                          <TableCell>{r.objectName || '—'} · {r.propertyName || '—'}</TableCell>
                          <TableCell className={s.cell}>{r.condition ? `${r.condition.operator} ${fmtCell(r.condition.value)}` : '—'}</TableCell>
                          <TableCell className={s.cell}>{r.action?.kind || '—'}</TableCell>
                          <TableCell>{r.state || '—'}</TableCell>
                          <TableCell className={s.cell}>{r.lastTriggered || '—'}</TableCell>
                          <TableCell>
                            <Button size="small" appearance="subtle" icon={<Play20Regular />} onClick={() => triggerNow(r.id)}>Trigger</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </div>
      }
    />
  );
}

// ----- Warehouse -----
// Ribbon built inside the editor via useMemo so Run binds to the
// existing inline run handler; the rest stay disabled with reasons.

interface WHQueryResult {
  ok: boolean;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  executionMs?: number;
  truncated?: boolean;
  error?: string;
  state?: string;
  code?: string;
  sqlNumber?: number;
  warehouse?: string;
}
interface WHSchemaResp {
  ok: boolean;
  state?: string;
  sku?: string;
  warehouse?: string;
  message?: string;
  schemas?: Record<string, { table: string; rows: number }[]>;
  error?: string;
}

const SAMPLE_SQL = `-- Fabric Warehouse (Loom-Gov: backed by Synapse Dedicated SQL pool)\nSELECT 1 AS smoke, DB_NAME() AS db, SUSER_NAME() AS upn, SYSDATETIMEOFFSET() AS now_utc;`;

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function WarehouseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [sqlText, setSqlText] = useState(SAMPLE_SQL);
  const [schema, setSchema] = useState<WHSchemaResp | null>(null);
  const [result, setResult] = useState<WHQueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  // Surface the underlying Synapse Dedicated SQL pool via ComputePicker so
  // users can Resume the pool when paused without leaving the Warehouse
  // editor. Selection is informational here — Warehouse query routes to the
  // wired-in pool — but the lifecycle controls (Resume / Pause) are wired.
  const [computeId, setComputeId] = useState('');

  const loadSchema = useCallback(async () => {
    // Pre-save gate: /items/warehouse/new fires this before any record exists
    // (was returning 409 on the walkthrough validator). Skip until saved.
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/warehouse/${encodeURIComponent(id)}/schema`);
      const j = (await r.json()) as WHSchemaResp;
      setSchema(j);
    } catch (e: any) {
      setSchema({ ok: false, error: e?.message || String(e) });
    }
  }, [id]);

  useEffect(() => { loadSchema(); }, [loadSchema]);

  const run = useCallback(async () => {
    setLoading(true); setResult(null);
    try {
      const r = await fetch(`/api/items/warehouse/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sqlText }),
      });
      const j = (await r.json()) as WHQueryResult;
      setResult(j);
      if (r.status === 409 && j.state) loadSchema();
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    } finally { setLoading(false); }
  }, [id, sqlText, loadSchema]);

  const schemaEntries = Object.entries(schema?.schemas || {});
  const ready = schema?.ok === true;

  const canRun = ready && !loading;

  // Save-as-table dialog state — CTAS helper.
  const [ctasOpen, setCtasOpen] = useState(false);
  const [ctasSchema, setCtasSchema] = useState('dbo');
  const [ctasTable, setCtasTable] = useState('');
  const [ctasBusy, setCtasBusy] = useState(false);
  const [ctasError, setCtasError] = useState<string | null>(null);

  const newSql = useCallback(() => {
    // Multi-tab is a future v3.x — for now "New SQL query" resets the
    // current tab to a fresh template, matching Fabric Warehouse's
    // single-tab UX inside the embedded editor.
    setSqlText(SAMPLE_SQL.replace(/SELECT 1 AS smoke[^;]*;/, 'SELECT TOP 100 * FROM INFORMATION_SCHEMA.TABLES;'));
    setResult(null);
  }, []);

  const openCtas = useCallback(() => {
    setCtasError(null);
    setCtasTable('');
    setCtasOpen(true);
  }, []);

  const submitCtas = useCallback(async () => {
    if (!ctasTable.trim()) { setCtasError('table name required'); return; }
    setCtasBusy(true); setCtasError(null);
    try {
      // Strip a trailing semicolon if present so we can wrap in CTAS.
      const cleaned = sqlText.trim().replace(/;+\s*$/, '');
      if (!/^select\b/i.test(cleaned)) {
        throw new Error('CTAS requires the current query to start with SELECT.');
      }
      const ddl = `CREATE TABLE [${ctasSchema.replace(/]/g, '')}].[${ctasTable.replace(/]/g, '')}] AS\n${cleaned};`;
      const r = await fetch(`/api/items/warehouse/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: ddl }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setCtasOpen(false);
      loadSchema();
    } catch (e: any) { setCtasError(e?.message || String(e)); }
    finally { setCtasBusy(false); }
  }, [id, sqlText, ctasSchema, ctasTable, loadSchema]);

  const openInExcel = useCallback(async () => {
    if (!sqlText.trim()) return;
    try {
      const r = await fetch(`/api/items/warehouse/${encodeURIComponent(id)}/iqy`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sqlText }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `loom-warehouse-${id}.iqy`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    }
  }, [id, sqlText]);
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Query', actions: [
        { label: 'New SQL query', onClick: newSql },
        { label: loading ? 'Running…' : 'Run', onClick: canRun ? run : undefined, disabled: !canRun, title: !ready ? 'warehouse compute is not ready' : undefined },
        { label: 'Save as table', onClick: canRun && sqlText.trim() ? openCtas : undefined, disabled: !canRun || !sqlText.trim(), title: !canRun ? 'warehouse compute is not ready' : (!sqlText.trim() ? 'enter a SELECT first' : undefined) },
        { label: 'Open in Excel', onClick: sqlText.trim() ? openInExcel : undefined, disabled: !sqlText.trim(), title: !sqlText.trim() ? 'enter a query first' : undefined },
      ]},
      { label: 'Modeling', actions: [
        { label: 'New measure', disabled: true, title: 'warehouse DAX measure editor not yet wired' },
        { label: 'Manage relationships', disabled: true, title: 'relationship designer not yet wired' },
      ]},
      { label: 'Manage', actions: [
        { label: 'Permissions', disabled: true, title: 'warehouse permissions editor not yet wired' },
        { label: 'Source control', disabled: true, title: 'git integration not yet wired' },
      ]},
    ]},
  ], [loading, canRun, ready, run, newSql, sqlText, openCtas, openInExcel]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div style={{ padding: 8 }}>
          <Tree aria-label="Warehouse explorer" defaultOpenItems={['schemas']}>
            <TreeItem itemType="branch" value="schemas">
              <TreeItemLayout iconBefore={<Database20Regular />}>
                Schemas ({schemaEntries.length})
              </TreeItemLayout>
              <Tree>
                {!ready && (
                  <TreeItem itemType="leaf" value="not-ready">
                    <TreeItemLayout>{schema?.message || 'Warehouse compute offline'}</TreeItemLayout>
                  </TreeItem>
                )}
                {ready && schemaEntries.length === 0 && (
                  <TreeItem itemType="leaf" value="empty">
                    <TreeItemLayout>No user tables yet. Create with T-SQL.</TreeItemLayout>
                  </TreeItem>
                )}
                {schemaEntries.map(([schemaName, tables]) => (
                  <TreeItem key={schemaName} itemType="branch" value={`s-${schemaName}`}>
                    <TreeItemLayout iconBefore={<Folder20Regular />}>{schemaName} ({tables.length})</TreeItemLayout>
                    <Tree>
                      {tables.map((t) => (
                        <TreeItem
                          key={t.table}
                          itemType="leaf"
                          value={`t-${schemaName}.${t.table}`}
                          onClick={() => setSqlText(`SELECT TOP 100 * FROM [${schemaName}].[${t.table}];`)}
                        >
                          <TreeItemLayout iconBefore={<DocumentTable20Regular />}>
                            {t.table} <Caption1>· {t.rows.toLocaleString()} rows</Caption1>
                          </TreeItemLayout>
                        </TreeItem>
                      ))}
                    </Tree>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color={ready ? 'success' : 'warning'}>{schema?.state || 'Unknown'}</Badge>
            <Badge appearance="outline">{schema?.warehouse || 'warehouse —'}</Badge>
            <Badge appearance="outline">{schema?.sku || 'DW—'}</Badge>
            <Button appearance="outline" onClick={loadSchema}>Refresh</Button>
            <Button appearance="primary" icon={<Play20Regular />} disabled={loading || !ready} onClick={run} style={{ marginLeft: 'auto' }}>Run</Button>
          </div>
          {schema && !ready && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Warehouse compute is {schema.state}</MessageBarTitle>
                {schema.message || 'Pick the Synapse Dedicated SQL pool below and click Resume.'}
              </MessageBarBody>
            </MessageBar>
          )}
          {/*
           * Compute picker so users can Resume the underlying Synapse
           * Dedicated SQL pool when paused, directly from the Warehouse
           * editor instead of round-tripping to the dedicated-pool editor.
           */}
          <ComputePicker
            label="Backing compute (Synapse Dedicated SQL)"
            filter={['synapse-dedicated-sql']}
            value={computeId}
            onChange={setComputeId}
          />
          <MonacoTextarea
            value={sqlText}
            onChange={setSqlText}
            language="tsql"
            height={260}
            minHeight={200}
            ariaLabel="Warehouse T-SQL editor"
          />
          {loading && <Spinner size="small" label="Executing T-SQL…" labelPosition="after" />}
          {result && !result.ok && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Query failed</MessageBarTitle>
                {result.error || 'Unknown error'} {result.code && <Caption1>· {result.code}</Caption1>}
              </MessageBarBody>
            </MessageBar>
          )}
          {result?.ok && (
            <>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <Badge appearance="filled" color="success">{result.rowCount ?? result.rows?.length ?? 0} rows</Badge>
                <Caption1>· {result.executionMs} ms</Caption1>
                {result.truncated && <Badge appearance="outline" color="warning">truncated at 5,000</Badge>}
              </div>
              {(result.rows?.length ?? 0) === 0 ? (
                <Caption1>Query returned no rows.</Caption1>
              ) : (
                <div style={{ overflow: 'auto', maxHeight: 360, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 }}>
                  <Table aria-label="Query results" size="small">
                    <TableHeader><TableRow>
                      {(result.columns || []).map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                    </TableRow></TableHeader>
                    <TableBody>
                      {(result.rows || []).map((row, i) => (
                        <TableRow key={i}>
                          {(result.columns || []).map((_, j) => (
                            <TableCell key={j} style={{ fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' }}>{formatCell(row[j])}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}

          <Dialog open={ctasOpen} onOpenChange={(_, d) => setCtasOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Save as table (CTAS)</DialogTitle>
                <DialogContent>
                  <Caption1>
                    Wraps the current query as <code>CREATE TABLE … AS SELECT …</code> and runs it
                    against the warehouse. Schema + table must not already exist.
                  </Caption1>
                  <Field label="Schema">
                    <Input value={ctasSchema} onChange={(_, d) => setCtasSchema(d.value)} placeholder="dbo" />
                  </Field>
                  <Field label="Table name" required>
                    <Input value={ctasTable} onChange={(_, d) => setCtasTable(d.value)} placeholder="orders_top100" />
                  </Field>
                  {ctasError && (
                    <MessageBar intent="error"><MessageBarBody><MessageBarTitle>CTAS failed</MessageBarTitle>{ctasError}</MessageBarBody></MessageBar>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setCtasOpen(false)} disabled={ctasBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={submitCtas} disabled={ctasBusy || !ctasTable.trim()}>
                    {ctasBusy ? 'Creating…' : 'Create table'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

// ============================================================
// Semantic Model (Power BI dataset)
// ============================================================
// Ribbon built inside SemanticModelEditor via useMemo so Refresh binds
// to the existing inline refreshNow handler; the rest stay disabled.

interface DatasetLite {
  id: string; name: string; configuredBy?: string; isRefreshable?: boolean; targetStorageMode?: string; createdDate?: string;
}
interface TableLite {
  name: string;
  columns?: Array<{ name: string; dataType?: string }>;
  measures?: Array<{ name: string; expression?: string }>;
}
interface RefreshLite {
  requestId?: string; refreshType?: string; startTime?: string; endTime?: string; status?: string; serviceExceptionJson?: string;
}

export function SemanticModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  // PBI editor — picker MUST surface Power BI groupIds (not Loom UUIDs)
  // or the embed-token / list calls return 404 PowerBIEntityNotFound.
  const ws = usePowerBiWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [datasets, setDatasets] = useState<DatasetLite[] | null>(null);
  const [datasetId, setDatasetId] = useState('');
  const [listErr, setListErr] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ dataset?: DatasetLite; tables?: TableLite[]; refreshSchedule?: any } | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState<RefreshLite[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'tables' | 'relationships' | 'measures' | 'refresh' | 'config'>('tables');

  const loadList = useCallback(async (wsId: string) => {
    setListErr(null);
    try {
      const r = await fetch(`/api/items/semantic-model?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDatasets([]); setListErr(j.error); return; }
      setDatasets(j.datasets || []);
      setDatasetId((prev) => prev || (j.datasets?.[0]?.id ?? ''));
    } catch (e: any) {
      setDatasets([]); setListErr(e?.message || String(e));
    }
  }, []);

  const loadDetail = useCallback(async (wsId: string, dsId: string) => {
    setDetailErr(null); setDetail(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(dsId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDetailErr(j.error); return; }
      setDetail({ dataset: j.dataset, tables: j.tables || [], refreshSchedule: j.refreshSchedule });
    } catch (e: any) { setDetailErr(e?.message || String(e)); }
  }, []);

  const loadRefreshes = useCallback(async (wsId: string, dsId: string) => {
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(dsId)}/refreshes?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (j.ok) setRefreshes(j.refreshes || []);
    } catch { /* silently keep last */ }
  }, []);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => {
    if (workspaceId && datasetId) { loadDetail(workspaceId, datasetId); loadRefreshes(workspaceId, datasetId); }
  }, [workspaceId, datasetId, loadDetail, loadRefreshes]);

  const refreshNow = useCallback(async () => {
    if (!workspaceId || !datasetId) return;
    setRefreshing(true); setRefreshErr(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/refresh?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) setRefreshErr(j.error || 'refresh failed');
      else { setTimeout(() => loadRefreshes(workspaceId, datasetId), 1500); }
    } finally { setRefreshing(false); }
  }, [workspaceId, datasetId, loadRefreshes]);

  const canRefresh = !!datasetId && !refreshing && detail?.dataset?.isRefreshable !== false;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Model', actions: [
        { label: 'New measure', disabled: true, title: 'DAX measure editor not yet wired' },
        { label: 'New role', disabled: true, title: 'RLS role editor not yet wired' },
        { label: 'New perspective', disabled: true, title: 'perspective editor not yet wired' },
      ]},
      { label: 'Source', actions: [
        { label: refreshing ? 'Queuing…' : 'Refresh', onClick: canRefresh ? refreshNow : undefined, disabled: !canRefresh, title: detail?.dataset?.isRefreshable === false ? 'dataset is not refreshable (push or DirectQuery without gateway)' : (!datasetId ? 'select a dataset first' : undefined) },
        { label: 'Direct Lake', disabled: true, title: 'Direct Lake storage-mode toggle not yet wired' },
        { label: 'Import', disabled: true, title: 'PBIX/TMSL import not yet wired' },
      ]},
    ]},
  ], [refreshing, canRefresh, refreshNow, datasetId, detail?.dataset?.isRefreshable]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: 8 }}>Datasets</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {datasets && datasets.length === 0 && <Caption1>No datasets in this workspace.</Caption1>}
          <Tree aria-label="Datasets">
            {(datasets || []).map((d) => (
              <TreeItem key={d.id} itemType="leaf" value={d.id} onClick={() => setDatasetId(d.id)}>
                <TreeItemLayout iconBefore={<Database20Regular />}>
                  {datasetId === d.id ? <strong>{d.name}</strong> : d.name}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <>
          <div className={s.pad}>
            <div className={s.toolbar}>
              <Badge appearance="filled" color="brand">Semantic model</Badge>
              <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
              <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh</Button>
              <Button
                appearance="primary"
                icon={<Play20Regular />}
                disabled={!datasetId || refreshing || detail?.dataset?.isRefreshable === false}
                onClick={refreshNow}
                title={detail?.dataset?.isRefreshable === false ? 'Dataset is not refreshable (e.g. push dataset or DirectQuery without gateway).' : undefined}
                style={{ marginLeft: 'auto' }}
              >
                {refreshing ? 'Queuing…' : 'Refresh dataset'}
              </Button>
            </div>
            {listErr && <MessageBar intent="error"><MessageBarBody>{listErr}</MessageBarBody></MessageBar>}
            {refreshErr && <MessageBar intent="error"><MessageBarBody>{refreshErr}</MessageBarBody></MessageBar>}
            {detailErr && <MessageBar intent="error"><MessageBarBody>{detailErr}</MessageBarBody></MessageBar>}
            {detail?.dataset && (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <Caption1>Owner: <strong>{detail.dataset.configuredBy || '—'}</strong></Caption1>
                <Caption1>Mode: <strong>{detail.dataset.targetStorageMode || '—'}</strong></Caption1>
                {detail.dataset.isRefreshable === false && <Badge appearance="outline" color="warning">not refreshable</Badge>}
              </div>
            )}
          </div>
          {datasetId && (
            <>
              <div className={s.tabBar}>
                <TabList selectedValue={tab} onTabSelect={(_: unknown, d: any) => setTab(d.value as any)}>
                  <Tab value="tables">Tables ({detail?.tables?.length ?? 0})</Tab>
                  <Tab value="relationships">Relationships</Tab>
                  <Tab value="measures">Measures (DAX)</Tab>
                  <Tab value="refresh">Refresh history ({refreshes.length})</Tab>
                  <Tab value="config">Configuration</Tab>
                </TabList>
              </div>
              <div className={s.pad}>
                {tab === 'tables' && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Tables" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Table</TableHeaderCell>
                        <TableHeaderCell>Columns</TableHeaderCell>
                        <TableHeaderCell>Measures</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {(detail?.tables || []).map((t) => (
                          <TableRow key={t.name}>
                            <TableCell>{t.name}</TableCell>
                            <TableCell className={s.cell}>{(t.columns || []).map((c) => `${c.name}:${c.dataType || '?'}`).join(', ') || '—'}</TableCell>
                            <TableCell className={s.cell}>{(t.measures || []).map((m) => m.name).join(', ') || '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                {tab === 'relationships' && (
                  <Body1>Power BI REST returns relationships only via the XMLA endpoint (TMSL). Click <strong>Refresh dataset</strong> to validate metadata; full TMSL graph rendering lands in v2.2.</Body1>
                )}
                {tab === 'measures' && (
                  <>
                    {(detail?.tables || []).flatMap((t) => (t.measures || []).map((m) => (
                      <div key={`${t.name}-${m.name}`} className={s.card} style={{ marginTop: 8 }}>
                        <Caption1>{t.name}</Caption1>
                        <div style={{ fontWeight: 600 }}>{m.name}</div>
                        <pre style={{ margin: 0, fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>{m.expression || '—'}</pre>
                      </div>
                    )))}
                    {((detail?.tables || []).flatMap((t) => t.measures || []).length === 0) && (
                      <Caption1>No DAX measures returned (or the dataset hasn't exposed its model definition).</Caption1>
                    )}
                  </>
                )}
                {tab === 'refresh' && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Refreshes" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Request ID</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Status</TableHeaderCell>
                        <TableHeaderCell>Start</TableHeaderCell>
                        <TableHeaderCell>End</TableHeaderCell>
                        <TableHeaderCell>Error</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {refreshes.length === 0 && <TableRow><TableCell colSpan={6}>No refresh history.</TableCell></TableRow>}
                        {refreshes.map((r, i) => (
                          <TableRow key={r.requestId || i}>
                            <TableCell className={s.cell}>{r.requestId?.slice(0, 8) || '—'}</TableCell>
                            <TableCell>{r.refreshType || '—'}</TableCell>
                            <TableCell>{r.status || '—'}</TableCell>
                            <TableCell className={s.cell}>{r.startTime || '—'}</TableCell>
                            <TableCell className={s.cell}>{r.endTime || '—'}</TableCell>
                            <TableCell className={s.cell}>{r.serviceExceptionJson || ''}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                {tab === 'config' && (
                  <>
                    <Caption1>Refresh schedule</Caption1>
                    <pre style={{ margin: 0, fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap', padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 }}>
                      {detail?.refreshSchedule ? JSON.stringify(detail.refreshSchedule, null, 2) : 'No schedule (manual refresh only).'}
                    </pre>
                  </>
                )}
              </div>
            </>
          )}
        </>
      }
    />
  );
}

// ============================================================
// Report (Power BI)
// ============================================================
// Shared disabled-only ribbon for DashboardEditor + ScorecardEditor —
// none of these actions have inline handlers yet. ReportEditor +
// PaginatedReportEditor each get their own ribbon built inside
// ReportLikeEditor (see useMemo there).
const REPORT_DASHBOARD_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [
  { label: 'Pages', actions: [
    { label: 'New page', disabled: true, title: 'visual page editor not yet wired' },
    { label: 'Duplicate', disabled: true, title: 'page duplicate not yet wired' },
  ]},
  { label: 'Visuals', actions: [
    { label: 'New visual', disabled: true, title: 'visual designer not yet wired' },
    { label: 'Format', disabled: true, title: 'visual format pane not yet wired' },
    { label: 'Bookmark', disabled: true, title: 'bookmarks not yet wired' },
  ]},
  { label: 'Data', actions: [
    { label: 'Refresh', disabled: true, title: 'inline refresh not yet wired — open in Power BI to refresh' },
    { label: 'Filters', disabled: true, title: 'filter pane toggle not yet wired' },
  ]},
]}];

interface ReportLite {
  id: string; name: string; embedUrl?: string; webUrl?: string; datasetId?: string;
  modifiedDateTime?: string; modifiedBy?: string; reportType?: string;
}

function ReportLikeEditor({
  item, id, kind, listPath, detailPathBase,
}: {
  item: FabricItemType; id: string; kind: 'report' | 'paginated';
  listPath: string; detailPathBase: string;
}) {
  const s = useStyles();
  // PBI editor — picker MUST surface Power BI groupIds (not Loom UUIDs)
  // or the embed-token / list calls return 404 PowerBIEntityNotFound.
  const ws = usePowerBiWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [reports, setReports] = useState<ReportLite[] | null>(null);
  const [reportId, setReportId] = useState('');
  const [report, setReport] = useState<ReportLite | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [embed, setEmbed] = useState<{ token: string; embedUrl: string; reportId: string } | null>(null);
  const [embedErr, setEmbedErr] = useState<string | null>(null);

  const loadList = useCallback(async (wsId: string) => {
    setErr(null);
    try {
      const r = await fetch(`${listPath}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setReports([]); setErr(j.error); return; }
      setReports(j.reports || []);
      setReportId((prev) => prev || (j.reports?.[0]?.id ?? ''));
    } catch (e: any) { setReports([]); setErr(e?.message || String(e)); }
  }, [listPath]);

  const loadDetail = useCallback(async (wsId: string, rId: string) => {
    try {
      const r = await fetch(`${detailPathBase}/${encodeURIComponent(rId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (j.ok) setReport(j.report);
      else setErr(j.error);
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [detailPathBase]);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && reportId) loadDetail(workspaceId, reportId); }, [workspaceId, reportId, loadDetail]);

  // Per-editor ribbon — Refresh re-loads the list + selected report
  // detail (closest honest binding given the PBI embed iframe doesn't
  // expose a reload hook through PowerBIEmbedFrame yet). Filters and
  // visual-design actions stay disabled with a "not yet wired" tooltip.
  const canRefresh = !!workspaceId;
  const refreshSelected = useCallback(() => {
    if (workspaceId) loadList(workspaceId);
    if (workspaceId && reportId) loadDetail(workspaceId, reportId);
  }, [workspaceId, reportId, loadList, loadDetail]);
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Pages', actions: [
        { label: 'New page', disabled: true, title: `${kind === 'paginated' ? 'paginated ' : ''}report page editor not yet wired` },
        { label: 'Duplicate', disabled: true, title: 'page duplicate not yet wired' },
      ]},
      { label: 'Visuals', actions: [
        { label: 'New visual', disabled: true, title: 'visual designer not yet wired' },
        { label: 'Format', disabled: true, title: 'visual format pane not yet wired' },
        { label: 'Bookmark', disabled: true, title: 'bookmarks not yet wired' },
      ]},
      { label: 'Data', actions: [
        { label: 'Refresh', onClick: canRefresh ? refreshSelected : undefined, disabled: !canRefresh, title: !canRefresh ? 'select a workspace first' : undefined },
        { label: 'Filters', disabled: true, title: 'filter pane toggle not yet wired (use the embed iframe filters pane)' },
      ]},
    ]},
  ], [kind, canRefresh, refreshSelected]);

  // Mint a per-report embed token whenever the selected report changes.
  // Paginated reports use a different SDK (`pbi-paginated`) that we don't
  // support yet, so skip token issuance for them.
  useEffect(() => {
    if (!workspaceId || !reportId || kind === 'paginated') { setEmbed(null); return; }
    let cancelled = false;
    (async () => {
      setEmbedErr(null);
      try {
        const r = await fetch(`/api/items/report/${encodeURIComponent(reportId)}/embed-token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId, accessLevel: 'View' }),
        });
        const j = await r.json();
        if (cancelled) return;
        if (j.ok && j.token && j.embedUrl) setEmbed({ token: j.token, embedUrl: j.embedUrl, reportId: j.reportId });
        else { setEmbedErr(j.error || `HTTP ${r.status}`); setEmbed(null); }
      } catch (e: any) {
        if (!cancelled) setEmbedErr(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, reportId, kind]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: 8 }}>{kind === 'paginated' ? 'Paginated reports' : 'Reports'}</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {reports && reports.length === 0 && <Caption1>No {kind === 'paginated' ? 'paginated ' : ''}reports in this workspace.</Caption1>}
          <Tree aria-label="Reports">
            {(reports || []).map((r) => (
              <TreeItem key={r.id} itemType="leaf" value={r.id} onClick={() => setReportId(r.id)}>
                <TreeItemLayout>{reportId === r.id ? <strong>{r.name}</strong> : r.name}</TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">{kind === 'paginated' ? 'Paginated report' : 'Power BI report'}</Badge>
            <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh</Button>
          </div>
          {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          {report && (
            <>
              <div className={s.card}>
                <Subtitle2>{report.name}</Subtitle2>
                <Caption1>type: {report.reportType || (kind === 'paginated' ? 'PaginatedReport' : 'PowerBIReport')} · datasetId: {report.datasetId || '—'}</Caption1>
                <Caption1>modified: {report.modifiedDateTime || '—'} by {report.modifiedBy || '—'}</Caption1>
                {report.webUrl && <Caption1><a href={report.webUrl} target="_blank" rel="noreferrer">Open in Power BI</a></Caption1>}
              </div>
              {kind === 'paginated' ? (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Paginated report embed not yet wired</MessageBarTitle>
                    Power BI Paginated Reports use the <code>pbi-paginated</code> SDK which is separate from the
                    standard powerbi-client. Use "Open in Power BI" above; an in-place embed lands in a follow-up PR.
                  </MessageBarBody>
                </MessageBar>
              ) : embedErr ? (
                <MessageBar intent="error">
                  <MessageBarBody>
                    <MessageBarTitle>Could not mint embed token</MessageBarTitle>
                    {embedErr}. Confirm the Console UAMI is added to this workspace (Member or above) and that the tenant setting
                    <strong> "Service principals can use Fabric APIs"</strong> is enabled with the UAMI's security group.
                  </MessageBarBody>
                </MessageBar>
              ) : embed ? (
                <PowerBIEmbedFrame
                  embedType="report"
                  id={embed.reportId}
                  embedUrl={embed.embedUrl}
                  accessToken={embed.token}
                  height={620}
                />
              ) : (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Loading embed token…</Caption1>
              )}
            </>
          )}
        </div>
      }
    />
  );
}

export function ReportEditor({ item, id }: { item: FabricItemType; id: string }) {
  return <ReportLikeEditor item={item} id={id} kind="report" listPath="/api/items/report" detailPathBase="/api/items/report" />;
}
export function PaginatedReportEditor({ item, id }: { item: FabricItemType; id: string }) {
  return <ReportLikeEditor item={item} id={id} kind="paginated" listPath="/api/items/paginated-report" detailPathBase="/api/items/paginated-report" />;
}

// ============================================================
// Dashboard (Power BI)
// ============================================================
interface DashboardLite { id: string; displayName: string; webUrl?: string; embedUrl?: string; isReadOnly?: boolean; }
interface TileLite { id: string; title?: string; subTitle?: string; reportId?: string; datasetId?: string; embedUrl?: string; rowSpan?: number; colSpan?: number; }

export function DashboardEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  // PBI editor — picker MUST surface Power BI groupIds (not Loom UUIDs)
  // or the embed-token / list calls return 404 PowerBIEntityNotFound.
  const ws = usePowerBiWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [dashboards, setDashboards] = useState<DashboardLite[] | null>(null);
  const [dashId, setDashId] = useState('');
  const [tiles, setTiles] = useState<TileLite[]>([]);
  const [selectedTile, setSelectedTile] = useState<TileLite | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [embed, setEmbed] = useState<{ token: string; embedUrl: string; dashboardId: string } | null>(null);
  const [embedErr, setEmbedErr] = useState<string | null>(null);

  const loadList = useCallback(async (wsId: string) => {
    setErr(null);
    try {
      const r = await fetch(`/api/items/dashboard?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDashboards([]); setErr(j.error); return; }
      setDashboards(j.dashboards || []);
      setDashId((prev) => prev || (j.dashboards?.[0]?.id ?? ''));
    } catch (e: any) { setDashboards([]); setErr(e?.message || String(e)); }
  }, []);

  const loadDetail = useCallback(async (wsId: string, dId: string) => {
    setSelectedTile(null);
    try {
      const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (j.ok) setTiles(j.tiles || []); else setErr(j.error);
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, []);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && dashId) loadDetail(workspaceId, dashId); }, [workspaceId, dashId, loadDetail]);

  useEffect(() => {
    if (!workspaceId || !dashId) { setEmbed(null); return; }
    let cancelled = false;
    (async () => {
      setEmbedErr(null);
      try {
        const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dashId)}/embed-token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        });
        const j = await r.json();
        if (cancelled) return;
        if (j.ok && j.token && j.embedUrl) setEmbed({ token: j.token, embedUrl: j.embedUrl, dashboardId: j.dashboardId });
        else { setEmbedErr(j.error || `HTTP ${r.status}`); setEmbed(null); }
      } catch (e: any) {
        if (!cancelled) setEmbedErr(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, dashId]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={REPORT_DASHBOARD_RIBBON}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: 8 }}>Dashboards</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {dashboards && dashboards.length === 0 && <Caption1>No dashboards in this workspace.</Caption1>}
          <Tree aria-label="Dashboards">
            {(dashboards || []).map((d) => (
              <TreeItem key={d.id} itemType="leaf" value={d.id} onClick={() => setDashId(d.id)}>
                <TreeItemLayout>{dashId === d.id ? <strong>{d.displayName}</strong> : d.displayName}</TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Power BI dashboard</Badge>
            <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh</Button>
          </div>
          {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          {embedErr ? (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Could not mint embed token</MessageBarTitle>
                {embedErr}. Confirm the Console UAMI is added to this workspace and that "Service principals can use Fabric APIs" is enabled.
              </MessageBarBody>
            </MessageBar>
          ) : embed ? (
            <PowerBIEmbedFrame
              embedType="dashboard"
              id={embed.dashboardId}
              embedUrl={embed.embedUrl}
              accessToken={embed.token}
              height={620}
            />
          ) : (
            dashId && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Loading embed token…</Caption1>
          )}
          <Subtitle2>Tiles ({tiles.length})</Subtitle2>
          <div className={s.cardGrid}>
            {tiles.map((t) => (
              <div key={t.id} className={s.card} style={{ cursor: 'pointer', borderColor: selectedTile?.id === t.id ? tokens.colorBrandStroke1 : undefined }} onClick={() => setSelectedTile(t)}>
                <Caption1>{t.subTitle || 'tile'}</Caption1>
                <div style={{ fontWeight: 600 }}>{t.title || t.id}</div>
                <Caption1>{t.rowSpan && t.colSpan ? `${t.colSpan}×${t.rowSpan}` : ''}</Caption1>
              </div>
            ))}
            {tiles.length === 0 && dashId && <Caption1>Dashboard has no tiles.</Caption1>}
          </div>
          {selectedTile && (
            <div className={s.card}>
              <Subtitle2>Tile detail</Subtitle2>
              <Caption1>id: <code>{selectedTile.id}</code></Caption1>
              <Caption1>reportId: <code>{selectedTile.reportId || '—'}</code></Caption1>
              <Caption1>datasetId: <code>{selectedTile.datasetId || '—'}</code></Caption1>
              <Caption1>embedUrl: <code style={{ fontSize: 11 }}>{selectedTile.embedUrl || '—'}</code></Caption1>
            </div>
          )}
        </div>
      }
    />
  );
}

// ============================================================
// Scorecard (Fabric)
// ============================================================
interface ScorecardLite { id: string; displayName: string; description?: string; }
interface GoalLite { id?: string; name?: string; description?: string; currentValue?: number; targetValue?: number; }

export function ScorecardEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  // PBI editor — picker MUST surface Power BI groupIds (not Loom UUIDs)
  // or the embed-token / list calls return 404 PowerBIEntityNotFound.
  const ws = usePowerBiWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [scorecards, setScorecards] = useState<ScorecardLite[] | null>(null);
  const [scorecardId, setScorecardId] = useState('');
  const [goals, setGoals] = useState<GoalLite[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [entryOpen, setEntryOpen] = useState<{ goalId: string } | null>(null);
  const [entryValue, setEntryValue] = useState('');
  const [entryTarget, setEntryTarget] = useState('');
  const [entryNote, setEntryNote] = useState('');
  const [entryBusy, setEntryBusy] = useState(false);
  const [entryErr, setEntryErr] = useState<string | null>(null);

  const loadList = useCallback(async (wsId: string) => {
    setErr(null);
    try {
      const r = await fetch(`/api/items/scorecard?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setScorecards([]); setErr(j.error); return; }
      setScorecards(j.scorecards || []);
      setScorecardId((prev) => prev || (j.scorecards?.[0]?.id ?? ''));
    } catch (e: any) { setScorecards([]); setErr(e?.message || String(e)); }
  }, []);

  const loadGoals = useCallback(async (wsId: string, scId: string) => {
    try {
      const r = await fetch(`/api/items/scorecard/${encodeURIComponent(scId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (j.ok) setGoals(j.goals || []); else setErr(j.error);
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, []);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && scorecardId) loadGoals(workspaceId, scorecardId); }, [workspaceId, scorecardId, loadGoals]);

  const submitValue = useCallback(async () => {
    if (!entryOpen || !workspaceId || !scorecardId) return;
    const value = Number(entryValue);
    if (!Number.isFinite(value)) { setEntryErr('numeric value required'); return; }
    setEntryBusy(true); setEntryErr(null);
    try {
      const r = await fetch(`/api/items/scorecard/${encodeURIComponent(scorecardId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goalId: entryOpen.goalId, value, targetValue: entryTarget ? Number(entryTarget) : undefined, noteText: entryNote || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setEntryErr(j.error || 'submit failed'); return; }
      setEntryOpen(null); setEntryValue(''); setEntryTarget(''); setEntryNote('');
      loadGoals(workspaceId, scorecardId);
    } finally { setEntryBusy(false); }
  }, [entryOpen, entryValue, entryTarget, entryNote, workspaceId, scorecardId, loadGoals]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={REPORT_DASHBOARD_RIBBON}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: 8 }}>Scorecards</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {scorecards && scorecards.length === 0 && <Caption1>No scorecards in this workspace.</Caption1>}
          <Tree aria-label="Scorecards">
            {(scorecards || []).map((sc) => (
              <TreeItem key={sc.id} itemType="leaf" value={sc.id} onClick={() => setScorecardId(sc.id)}>
                <TreeItemLayout>{scorecardId === sc.id ? <strong>{sc.displayName}</strong> : sc.displayName}</TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Scorecard</Badge>
            <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh</Button>
          </div>
          {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          {scorecardId && (
            <>
              <Subtitle2>Goals ({goals.length})</Subtitle2>
              {goals.length === 0 ? (
                <Caption1>No goals on this scorecard (or the Fabric scorecard preview API is not enabled in this tenant).</Caption1>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Goals" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Goal</TableHeaderCell>
                      <TableHeaderCell>Current</TableHeaderCell>
                      <TableHeaderCell>Target</TableHeaderCell>
                      <TableHeaderCell></TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {goals.map((g, i) => (
                        <TableRow key={g.id || i}>
                          <TableCell>{g.name || g.id || '—'}</TableCell>
                          <TableCell>{g.currentValue ?? '—'}</TableCell>
                          <TableCell>{g.targetValue ?? '—'}</TableCell>
                          <TableCell>
                            {g.id && <Button size="small" appearance="subtle" onClick={() => { setEntryOpen({ goalId: g.id! }); setEntryTarget(g.targetValue?.toString() || ''); }}>Add value</Button>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}

          <Dialog open={!!entryOpen} onOpenChange={(_: unknown, d: any) => { if (!d.open) setEntryOpen(null); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Add goal value</DialogTitle>
                <DialogContent>
                  <Caption1>value</Caption1>
                  <Input value={entryValue} onChange={(_: unknown, d: any) => setEntryValue(d.value)} type="number" style={{ width: '100%' }} />
                  <Caption1 style={{ marginTop: 8 }}>target (optional)</Caption1>
                  <Input value={entryTarget} onChange={(_: unknown, d: any) => setEntryTarget(d.value)} type="number" style={{ width: '100%' }} />
                  <Caption1 style={{ marginTop: 8 }}>note (optional)</Caption1>
                  <Input value={entryNote} onChange={(_: unknown, d: any) => setEntryNote(d.value)} style={{ width: '100%' }} />
                  {entryErr && <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody>{entryErr}</MessageBarBody></MessageBar>}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setEntryOpen(null)}>Cancel</Button>
                  <Button appearance="primary" disabled={entryBusy || !entryValue} onClick={submitValue}>{entryBusy ? 'Saving…' : 'Save'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}
