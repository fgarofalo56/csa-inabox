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
 * Activator, Semantic model, Report, Dashboard, Paginated report,
 * Scorecard remain visual shells.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Spinner,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Select, Textarea,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular, Folder20Regular,
  Save20Regular, Add20Regular, Delete20Regular, ArrowSync20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

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
const EH_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'New', actions: [{ label: 'New KQL database' }, { label: 'New dashboard' }] },
    { label: 'Query', actions: [{ label: 'Query with code' }, { label: 'Get data' }] },
    { label: 'Manage', actions: [{ label: 'Data policies' }, { label: 'OneLake availability' }] },
  ]},
];

interface EventhouseState {
  ok: boolean;
  cluster?: string;
  defaultDatabase?: string;
  databases?: Array<{ name: string; prettyName?: string; persistentStorage?: string }>;
  error?: string;
}

export function EventhouseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [state, setState] = useState<EventhouseState | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/items/eventhouse/${id}`);
      const j = (await r.json()) as EventhouseState;
      setState(j);
    } catch (e: any) {
      setState({ ok: false, error: e?.message || String(e) });
    }
  }, [id]);

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

  return (
    <ItemEditorChrome item={item} id={id} ribbon={EH_RIBBON} main={
      <div className={s.pad}>
        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand">Eventhouse · shared cluster</Badge>
          <Caption1>{state?.cluster || 'loading…'}</Caption1>
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={load}>Refresh</Button>
          <Dialog open={dialogOpen} onOpenChange={(_, d) => setDialogOpen(d.open)}>
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
                    onChange={(_, d) => setNewName(d.value)}
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
            <Subtitle2>Databases ({state.databases?.length ?? 0})</Subtitle2>
            <div className={s.cardGrid}>
              {(state.databases || []).map((d) => (
                <div key={d.name} className={s.card}>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>KQL database</Caption1>
                  <div style={{ fontSize: 18, fontWeight: 600 }}>{d.name}</div>
                  {d.prettyName && d.prettyName !== d.name && <Caption1>{d.prettyName}</Caption1>}
                  {d.name === state.defaultDatabase && <Badge appearance="filled" color="brand" style={{ marginTop: 6 }}>default</Badge>}
                </div>
              ))}
              {(!state.databases || state.databases.length === 0) && (
                <Caption1>No databases yet. Click <strong>New KQL database</strong> to create one.</Caption1>
              )}
            </div>
          </>
        )}
      </div>
    } />
  );
}

// ----- KQL Database -----
const KQL_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'New', actions: [{ label: 'Table' }, { label: 'Materialized view' }, { label: 'Function' }, { label: 'Update policy' }, { label: 'Shortcut' }] },
    { label: 'Data', actions: [{ label: 'Get data' }, { label: 'Query with code' }] },
    { label: 'Manage', actions: [{ label: 'Data policies' }, { label: 'OneLake availability' }] },
  ]},
];

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

export function KqlDatabaseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [info, setInfo] = useState<KqlDbInfo | null>(null);
  const [kql, setKql] = useState(SAMPLE_KQL_DB);
  const [result, setResult] = useState<KqlResult | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
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

  return (
    <ItemEditorChrome item={item} id={id} ribbon={KQL_RIBBON}
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
          <textarea
            className={s.monaco}
            spellCheck={false}
            value={kql}
            onChange={(e) => setKql(e.target.value)}
            onKeyDown={(e) => { if (e.shiftKey && e.key === 'Enter') { e.preventDefault(); run(); } }}
            aria-label="KQL query editor"
          />
          <KqlResultsPanel result={result} loading={loading} />
        </div>
      }
    />
  );
}

// ----- KQL Queryset -----
const KQLQS_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Run', actions: [{ label: 'Run' }, { label: 'Cancel' }] },
    { label: 'Save', actions: [{ label: 'Save query' }, { label: 'Save to dashboard' }, { label: 'Set alert' }] },
  ]},
];

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

  const load = useCallback(async () => {
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

  const select = useCallback((idx: number) => {
    setSelectedIdx(idx); setDraft(queries[idx] || SAMPLE_QS); setDirty(false); setResult(null);
  }, [queries]);

  const addQuery = useCallback(() => {
    const next = [...queries, { title: `Query ${queries.length + 1}`, kql: '' }];
    setQueries(next); setSelectedIdx(next.length - 1); setDraft(next[next.length - 1]); setDirty(true);
  }, [queries]);

  const deleteQuery = useCallback((idx: number) => {
    const next = queries.filter((_, i) => i !== idx);
    setQueries(next);
    const newIdx = Math.max(0, idx - 1);
    setSelectedIdx(newIdx); setDraft(next[newIdx] || SAMPLE_QS); setDirty(true);
  }, [queries]);

  const saveAll = useCallback(async () => {
    setSaving(true);
    try {
      const updated = queries.map((q, i) => i === selectedIdx ? draft : q);
      const r = await fetch(`/api/items/kql-queryset/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queries: updated }),
      });
      const j = await r.json();
      if (j.ok) { setQueries(j.queries); setDirty(false); }
    } finally {
      setSaving(false);
    }
  }, [id, queries, selectedIdx, draft]);

  const run = useCallback(async () => {
    setLoading(true); setResult(null);
    try {
      const r = await fetch(`/api/items/kql-queryset/${id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kql: draft.kql, database: draft.database }),
      });
      setResult((await r.json()) as KqlResult);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setLoading(false);
    }
  }, [id, draft]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={KQLQS_RIBBON}
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
                    <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={(e) => { e.stopPropagation(); deleteQuery(i); }} aria-label="Delete query" />
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
            <Input value={draft.title} onChange={(_, d) => { setDraft({ ...draft, title: d.value }); setDirty(true); }} placeholder="Query title" style={{ minWidth: 220 }} />
            <Caption1>db: <strong>{draft.database || qs?.database || qs?.defaultDatabase || 'loomdb-default'}</strong></Caption1>
            {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
            <Button appearance="outline" icon={<Save20Regular />} disabled={saving || queries.length === 0} onClick={saveAll}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button appearance="primary" icon={<Play20Regular />} disabled={loading || !draft.kql.trim()} onClick={run} style={{ marginLeft: 'auto' }}>
              {loading ? 'Running…' : 'Run'}
            </Button>
          </div>
          {qs && !qs.ok && <MessageBar intent="error"><MessageBarBody>{qs.error}</MessageBarBody></MessageBar>}
          <textarea
            className={s.monaco}
            spellCheck={false}
            value={draft.kql}
            onChange={(e) => { setDraft({ ...draft, kql: e.target.value }); setDirty(true); }}
            onKeyDown={(e) => { if (e.shiftKey && e.key === 'Enter') { e.preventDefault(); run(); } }}
            aria-label="KQL query"
          />
          <KqlResultsPanel result={result} loading={loading} />
        </div>
      }
    />
  );
}

// ----- KQL Dashboard -----
const KQLD_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Edit', actions: [{ label: 'Add tile' }, { label: 'Add data source' }, { label: 'Parameters' }] },
    { label: 'View', actions: [{ label: 'Auto-refresh' }, { label: 'Time range' }, { label: 'Share' }] },
  ]},
];

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

export function KqlDashboardEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [state, setState] = useState<DashboardState | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');

  const load = useCallback(async (runTiles = false) => {
    try {
      const r = await fetch(`/api/items/kql-dashboard/${id}${runTiles ? '?run=1' : ''}`);
      const j = (await r.json()) as DashboardState;
      setState(j); setTiles(j.tiles || []); setDirty(false);
    } catch (e: any) {
      setState({ ok: false, error: e?.message || String(e) });
    }
  }, [id]);

  useEffect(() => { load(true); }, [load]);

  const addTile = useCallback(() => {
    const next: Tile[] = [...tiles, { title: `Tile ${tiles.length + 1}`, kql: 'print value = 1', viz: 'table' }];
    setTiles(next); setExpandedIdx(next.length - 1); setDirty(true);
  }, [tiles]);

  const deleteTile = useCallback((idx: number) => {
    setTiles(tiles.filter((_, i) => i !== idx)); setDirty(true);
    if (expandedIdx === idx) setExpandedIdx(null);
  }, [tiles, expandedIdx]);

  const updateTile = useCallback((idx: number, patch: Partial<Tile>) => {
    setTiles(tiles.map((t, i) => i === idx ? { ...t, ...patch } : t)); setDirty(true);
  }, [tiles]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const r = await fetch(`/api/items/kql-dashboard/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tiles: tiles.map(({ result, error, ...t }) => t) }),
      });
      const j = await r.json();
      if (j.ok) setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [id, tiles]);

  const openJson = useCallback(() => {
    setJsonText(JSON.stringify(tiles.map(({ result, error, ...t }) => t), null, 2));
    setJsonOpen(true);
  }, [tiles]);

  const applyJson = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      if (Array.isArray(parsed)) { setTiles(parsed); setDirty(true); setJsonOpen(false); }
    } catch { /* keep dialog open */ }
  }, [jsonText]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={KQLD_RIBBON} main={
      <div className={s.pad}>
        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand">KQL Dashboard</Badge>
          <Caption1>db: <strong>{state?.database || 'loomdb-default'}</strong> · {tiles.length} tiles</Caption1>
          {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
          <Button appearance="outline" icon={<Add20Regular />} onClick={addTile}>Add tile</Button>
          <Button appearance="outline" onClick={openJson}>Edit JSON</Button>
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => load(true)}>Re-run all</Button>
          <Button appearance="primary" icon={<Save20Regular />} onClick={save} disabled={saving || !dirty} style={{ marginLeft: 'auto' }}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>

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
                  <Input value={t.title} onChange={(_, d) => updateTile(i, { title: d.value })} placeholder="Title" />
                  <Select value={t.viz} onChange={(_, d) => updateTile(i, { viz: d.value as Tile['viz'] })}>
                    <option value="table">table</option>
                    <option value="line">line</option>
                    <option value="bar">bar</option>
                  </Select>
                  <Textarea
                    value={t.kql}
                    onChange={(_, d) => updateTile(i, { kql: d.value })}
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

        <Dialog open={jsonOpen} onOpenChange={(_, d) => setJsonOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Edit tiles JSON</DialogTitle>
              <DialogContent>
                <Textarea
                  value={jsonText}
                  onChange={(_, d) => setJsonText(d.value)}
                  rows={20}
                  style={{ width: '100%', fontFamily: 'Consolas, monospace', fontSize: 12 }}
                />
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setJsonOpen(false)}>Cancel</Button>
                <Button appearance="primary" onClick={applyJson}>Apply</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
    } />
  );
}

// ----- Eventstream -----
const ES_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Source', actions: [{ label: 'Add source' }, { label: 'Sample data' }] },
    { label: 'Transform', actions: [{ label: 'Filter' }, { label: 'Aggregate' }, { label: 'Group by' }] },
    { label: 'Destination', actions: [{ label: 'Add destination' }] },
    { label: 'Publish', actions: [{ label: 'Save' }, { label: 'Publish' }] },
  ]},
];

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
  const [state, setState] = useState<EventstreamState | null>(null);
  const [cfgText, setCfgText] = useState(JSON.stringify(DEFAULT_ES_CFG, null, 2));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [parseErr, setParseErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/items/eventstream/${id}`);
      const j = (await r.json()) as EventstreamState;
      setState(j);
      const cfg = j.config && (j.config.source || j.config.sink || (j.config.transforms?.length ?? 0) > 0)
        ? j.config
        : DEFAULT_ES_CFG;
      setCfgText(JSON.stringify(cfg, null, 2));
      setDirty(false);
    } catch (e: any) {
      setState({ ok: false, error: e?.message || String(e) });
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async () => {
    setParseErr(null);
    let parsed: StreamCfg;
    try { parsed = JSON.parse(cfgText); }
    catch (e: any) { setParseErr(e?.message || 'invalid JSON'); return; }
    setSaving(true);
    try {
      const r = await fetch(`/api/items/eventstream/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: parsed }),
      });
      const j = await r.json();
      if (j.ok) setDirty(false);
    } finally {
      setSaving(false);
    }
  }, [id, cfgText]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ES_RIBBON} main={
      <div className={s.pad}>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>v2.1 — configuration only</MessageBarTitle>
            Pipeline metadata is persisted to Cosmos but the Event Hubs &rarr; Kusto ingestion runtime is not yet executing. Real runtime wiring lands in v3.
          </MessageBarBody>
        </MessageBar>

        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand">Eventstream</Badge>
          {state?.runtimeStatus && <Badge appearance="outline">{state.runtimeStatus}</Badge>}
          {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={load}>Reload</Button>
          <Button appearance="primary" icon={<Save20Regular />} onClick={save} disabled={saving} style={{ marginLeft: 'auto' }}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>

        {state && !state.ok && <MessageBar intent="error"><MessageBarBody>{state.error}</MessageBarBody></MessageBar>}
        {parseErr && <MessageBar intent="error"><MessageBarBody>JSON parse error: {parseErr}</MessageBarBody></MessageBar>}

        <Caption1>Edit the pipeline definition as JSON. Schema: <code>{`{ source, transforms[], sink }`}</code>.</Caption1>
        <textarea
          className={s.monaco}
          style={{ minHeight: 360 }}
          spellCheck={false}
          value={cfgText}
          onChange={(e) => { setCfgText(e.target.value); setDirty(true); }}
          aria-label="Eventstream JSON config"
        />
      </div>
    } />
  );
}

// ----- Activator -----
const ACT_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Rules', actions: [{ label: 'New rule' }, { label: 'Start' }, { label: 'Stop' }] },
    { label: 'Actions', actions: [{ label: 'Email' }, { label: 'Teams' }, { label: 'Run pipeline' }, { label: 'Run notebook' }, { label: 'Power Automate' }] },
  ]},
];
export function ActivatorEditor({ item, id }: { item: FabricItemType; id: string }) {
  return (
    <ItemEditorChrome item={item} id={id} ribbon={ACT_RIBBON}
      leftPanel={
        <Tree aria-label="Activator explorer" defaultOpenItems={['obj']}>
          <TreeItem itemType="branch" value="obj">
            <TreeItemLayout>Objects (3)</TreeItemLayout>
            <Tree>
              {['Freezer', 'DeliveryTruck', 'Package'].map((x) =>
                <TreeItem key={x} itemType="leaf"><TreeItemLayout>{x}</TreeItemLayout></TreeItem>)}
            </Tree>
          </TreeItem>
          <TreeItem itemType="branch" value="ev"><TreeItemLayout>Events (2)</TreeItemLayout></TreeItem>
          <TreeItem itemType="branch" value="pr"><TreeItemLayout>Properties (8)</TreeItemLayout></TreeItem>
          <TreeItem itemType="branch" value="ru"><TreeItemLayout>Rules (4)</TreeItemLayout></TreeItem>
        </Tree>
      }
      main={
        <div style={{ padding: 16 }}>
          <Subtitle2>Rule: Too hot for medicine</Subtitle2>
          <Body1 style={{ marginTop: 8 }}>Monitor <b>Package.Temperature</b> · Condition <b>is greater than 20 °C</b> · Action <b>Send Teams message to assigned technician</b></Body1>
          <Badge appearance="filled" color="success" style={{ marginTop: 12 }}>Active · last triggered 4 min ago</Badge>
        </div>
      }
    />
  );
}

// ----- Warehouse -----
const WH_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Query', actions: [{ label: 'New SQL query' }, { label: 'Run' }, { label: 'Save as table' }, { label: 'Open in Excel' }] },
    { label: 'Modeling', actions: [{ label: 'New measure' }, { label: 'Manage relationships' }] },
    { label: 'Manage', actions: [{ label: 'Permissions' }, { label: 'Source control' }] },
  ]},
];
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

  const loadSchema = useCallback(async () => {
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

  return (
    <ItemEditorChrome item={item} id={id} ribbon={WH_RIBBON}
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
                {schema.message || 'Open the Synapse Dedicated SQL pool editor and click Resume.'}
              </MessageBarBody>
            </MessageBar>
          )}
          <textarea
            className={s.monaco}
            spellCheck={false}
            value={sqlText}
            onChange={(e) => setSqlText(e.target.value)}
            aria-label="Warehouse T-SQL editor"
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
        </div>
      }
    />
  );
}

// ----- Semantic model -----
const SM_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Model', actions: [{ label: 'New measure' }, { label: 'New role' }, { label: 'New perspective' }] },
    { label: 'Source', actions: [{ label: 'Refresh' }, { label: 'Direct Lake' }, { label: 'Import' }] },
  ]},
];
export function SemanticModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [tab, setTab] = useState('tables');
  return (
    <ItemEditorChrome item={item} id={id} ribbon={SM_RIBBON} main={
      <>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
            <Tab value="tables">Tables</Tab>
            <Tab value="relationships">Relationships</Tab>
            <Tab value="measures">Measures (DAX)</Tab>
            <Tab value="roles">Roles (RLS)</Tab>
          </TabList>
        </div>
        <div className={s.pad}>
          {tab === 'tables' && (
            <Table aria-label="Tables">
              <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Columns</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {[['fact_sales', 'Fact', 12], ['dim_customer', 'Dimension', 24], ['dim_product', 'Dimension', 31], ['dim_date', 'Dimension', 9]].map(([n, t, c]) =>
                  <TableRow key={n as string}><TableCell>{n}</TableCell><TableCell>{t}</TableCell><TableCell>{c}</TableCell></TableRow>)}
              </TableBody>
            </Table>
          )}
          {tab === 'relationships' && (<Body1>4 active relationships · 1 inactive (role-playing dim_date.ship_date)</Body1>)}
          {tab === 'measures' && (
            <textarea className={s.monaco} defaultValue={`Total Revenue =\nCALCULATE(\n  SUM(fact_sales[Amount]),\n  REMOVEFILTERS(dim_date[IsHoliday])\n)`} spellCheck={false} aria-label="DAX measure" />
          )}
          {tab === 'roles' && (<Body1>2 roles defined: Sales (regional filter), Exec (all-access)</Body1>)}
        </div>
      </>
    } />
  );
}

// ----- Report / Dashboard / Paginated / Scorecard shells -----
function genericShell(title: string, body: string, ribbon: RibbonTab[]) {
  return function Shell({ item, id }: { item: FabricItemType; id: string }) {
    return (
      <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
        <div style={{ padding: 24, textAlign: 'center' }}>
          <Subtitle2>{title}</Subtitle2>
          <Body1 style={{ marginTop: 8, color: tokens.colorNeutralForeground3 }}>{body}</Body1>
        </div>
      } />
    );
  };
}
const REPORT_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [
  { label: 'Pages', actions: [{ label: 'New page' }, { label: 'Duplicate' }] },
  { label: 'Visuals', actions: [{ label: 'New visual' }, { label: 'Format' }, { label: 'Bookmark' }] },
  { label: 'Data', actions: [{ label: 'Refresh' }, { label: 'Filters' }] },
]}];
export const ReportEditor = genericShell('Power BI report canvas', 'Visual canvas, Visualizations / Fields / Filters panes, page tabs. Embedded Power BI iframe lands here in Phase 6.', REPORT_RIBBON);
export const DashboardEditor = genericShell('Power BI dashboard', 'Pin tiles from reports and Q&A. Tile grid renders here.', REPORT_RIBBON);
export const PaginatedReportEditor = genericShell('Paginated report', 'Pixel-perfect RDL report. Renderer placeholder + parameter bar.', REPORT_RIBBON);
export const ScorecardEditor = genericShell('Scorecard', 'KPI tree with targets, owners, status. Metadata-only — no Fabric REST API today.', REPORT_RIBBON);
