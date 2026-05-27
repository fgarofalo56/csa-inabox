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
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { PowerBIEmbedFrame } from '@/lib/components/embed/powerbi-embed';

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
          <MonacoTextarea
            value={kql}
            onChange={setKql}
            language="kql"
            height={240}
            minHeight={180}
            ariaLabel="KQL query editor"
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
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

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
    try {
      const r = await fetch(`/api/items/kql-queryset/${id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
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
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState<string | null>(null);

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
                  onChange={(_, d) => { setJsonText(d.value); setJsonErr(null); }}
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
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

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

        <Caption1>Edit the pipeline definition as JSON. Schema: <code>{`{ source, transforms[], sink }`}</code>.</Caption1>
        <MonacoTextarea
          value={cfgText}
          onChange={(v) => { setCfgText(v); setDirty(true); setParseErr(null); setSaveErr(null); }}
          language="json"
          height={360}
          minHeight={300}
          ariaLabel="Eventstream JSON config"
        />
      </div>
    } />
  );
}

// ============================================================
// Shared Loom workspace picker (formerly used /api/powerbi/workspaces which
// confusingly suffixed every workspace name with the capacity SKU label;
// Activator + other Fabric RTI editors weren't Power BI workspaces at all).
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
      <Select value={value} onChange={(_, d) => onChange(d.value)} disabled={loading || (workspaces?.length ?? 0) === 0}>
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
const ACT_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Rules', actions: [{ label: 'New rule' }, { label: 'Start' }, { label: 'Stop' }] },
    { label: 'Actions', actions: [{ label: 'Email' }, { label: 'Teams' }, { label: 'Run pipeline' }, { label: 'Run notebook' }, { label: 'Power Automate' }] },
  ]},
];

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

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ACT_RIBBON}
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
            <Dialog open={createOpen} onOpenChange={(_, d) => setCreateOpen(d.open)}>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="primary" icon={<Add20Regular />} disabled={!workspaceId} style={{ marginLeft: 'auto' }}>New reflex</Button>
              </DialogTrigger>
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>Create Activator (reflex)</DialogTitle>
                  <DialogContent>
                    <Input placeholder="displayName" value={createName} onChange={(_, d) => setCreateName(d.value)} style={{ width: '100%' }} />
                    <Input placeholder="description (optional)" value={createDesc} onChange={(_, d) => setCreateDesc(d.value)} style={{ width: '100%', marginTop: 8 }} />
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

          {selectedId && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Subtitle2>Rules</Subtitle2>
                <Dialog open={ruleOpen} onOpenChange={(_, d) => setRuleOpen(d.open)}>
                  <DialogTrigger disableButtonEnhancement>
                    <Button size="small" appearance="outline" icon={<Add20Regular />}>New rule</Button>
                  </DialogTrigger>
                  <DialogSurface>
                    <DialogBody>
                      <DialogTitle>Add rule</DialogTitle>
                      <DialogContent>
                        <Input placeholder="rule name" value={ruleName} onChange={(_, d) => setRuleName(d.value)} style={{ width: '100%' }} />
                        <Caption1 style={{ marginTop: 8 }}>condition JSON</Caption1>
                        <Textarea value={ruleCondition} onChange={(_, d) => setRuleCondition(d.value)} rows={3} style={{ width: '100%', fontFamily: 'Consolas, monospace', fontSize: 12 }} />
                        <Caption1 style={{ marginTop: 8 }}>action JSON</Caption1>
                        <Textarea value={ruleAction} onChange={(_, d) => setRuleAction(d.value)} rows={3} style={{ width: '100%', fontFamily: 'Consolas, monospace', fontSize: 12 }} />
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
        </div>
      }
    />
  );
}

// ============================================================
// Semantic Model (Power BI dataset)
// ============================================================
const SM_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Model', actions: [{ label: 'New measure' }, { label: 'New role' }, { label: 'New perspective' }] },
    { label: 'Source', actions: [{ label: 'Refresh' }, { label: 'Direct Lake' }, { label: 'Import' }] },
  ]},
];

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
  const ws = useWorkspaces();
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

  return (
    <ItemEditorChrome item={item} id={id} ribbon={SM_RIBBON}
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
                <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)}>
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
const REPORT_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [
  { label: 'Pages', actions: [{ label: 'New page' }, { label: 'Duplicate' }] },
  { label: 'Visuals', actions: [{ label: 'New visual' }, { label: 'Format' }, { label: 'Bookmark' }] },
  { label: 'Data', actions: [{ label: 'Refresh' }, { label: 'Filters' }] },
]}];

interface ReportLite {
  id: string; name: string; embedUrl?: string; webUrl?: string; datasetId?: string;
  modifiedDateTime?: string; modifiedBy?: string; reportType?: string;
}

function ReportLikeEditor({
  item, id, kind, ribbon, listPath, detailPathBase,
}: {
  item: FabricItemType; id: string; kind: 'report' | 'paginated';
  ribbon: RibbonTab[]; listPath: string; detailPathBase: string;
}) {
  const s = useStyles();
  const ws = useWorkspaces();
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
  return <ReportLikeEditor item={item} id={id} kind="report" ribbon={REPORT_RIBBON} listPath="/api/items/report" detailPathBase="/api/items/report" />;
}
export function PaginatedReportEditor({ item, id }: { item: FabricItemType; id: string }) {
  return <ReportLikeEditor item={item} id={id} kind="paginated" ribbon={REPORT_RIBBON} listPath="/api/items/paginated-report" detailPathBase="/api/items/paginated-report" />;
}

// ============================================================
// Dashboard (Power BI)
// ============================================================
interface DashboardLite { id: string; displayName: string; webUrl?: string; embedUrl?: string; isReadOnly?: boolean; }
interface TileLite { id: string; title?: string; subTitle?: string; reportId?: string; datasetId?: string; embedUrl?: string; rowSpan?: number; colSpan?: number; }

export function DashboardEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const ws = useWorkspaces();
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
    <ItemEditorChrome item={item} id={id} ribbon={REPORT_RIBBON}
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
  const ws = useWorkspaces();
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
    <ItemEditorChrome item={item} id={id} ribbon={REPORT_RIBBON}
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

          <Dialog open={!!entryOpen} onOpenChange={(_, d) => { if (!d.open) setEntryOpen(null); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Add goal value</DialogTitle>
                <DialogContent>
                  <Caption1>value</Caption1>
                  <Input value={entryValue} onChange={(_, d) => setEntryValue(d.value)} type="number" style={{ width: '100%' }} />
                  <Caption1 style={{ marginTop: 8 }}>target (optional)</Caption1>
                  <Input value={entryTarget} onChange={(_, d) => setEntryTarget(d.value)} type="number" style={{ width: '100%' }} />
                  <Caption1 style={{ marginTop: 8 }}>note (optional)</Caption1>
                  <Input value={entryNote} onChange={(_, d) => setEntryNote(d.value)} style={{ width: '100%' }} />
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
