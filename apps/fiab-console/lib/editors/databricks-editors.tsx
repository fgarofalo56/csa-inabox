'use client';

/**
 * Databricks SQL Warehouse editor — fully wired against the Loom-deployed
 * Databricks workspace via Container App MI + AAD bearer tokens.
 *
 * - Lists real warehouses via /api/2.0/sql/warehouses
 * - Real Start/Stop via /start, /stop
 * - Real Unity Catalog browse (SHOW CATALOGS / SCHEMAS / TABLES)
 * - Real statement execution via /api/2.0/sql/statements with polling
 *
 * Modelled directly on synapse-sql-editors.tsx (Dedicated). No mocks.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Dropdown, Option,
  Input, Field, Switch,
  Tab, TabList,
  Tree, TreeItem, TreeItemLayout,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular, Stop20Regular,
  ArrowSync20Regular, Folder20Regular, Document20Regular,
  Save20Regular, Delete20Regular, Add20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { CodeCell } from '@/lib/components/notebook/code-cell';
import { MarkdownCell } from '@/lib/components/notebook/markdown-cell';
import { CellAdder } from '@/lib/components/notebook/cell-adder';
import type { NotebookCell, NotebookCellLang } from '@/lib/types/notebook-cell';
import { emptyCell } from '@/lib/types/notebook-cell';
import {
  parseSource, serializeCells, cellLangToCommandLanguage,
  type DbxBaseLanguage,
} from './databricks-notebook-source';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  editor: {
    width: '100%', minHeight: 200,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 13, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  resultBox: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 12, minHeight: 200 },
  resultMeta: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 },
  tableWrap: { overflow: 'auto', maxHeight: 360, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
  treePad: { padding: 8 },
  treeRow: {
    display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px', borderRadius: 4,
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  treeDelete: { opacity: 0, ':hover': { opacity: 1 } },
  cellList: { display: 'flex', flexDirection: 'column', gap: 0, minHeight: 0 },
  cellOutput: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderTop: 'none',
    borderRadius: '0 0 4px 4px', padding: 8, marginBottom: 4,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  cellPre: {
    fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap',
    margin: 0, maxHeight: 320, overflow: 'auto', color: tokens.colorNeutralForeground1,
  },
});

interface QueryResponse {
  ok: boolean;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  executionMs?: number;
  truncated?: boolean;
  error?: string;
  state?: string;
  code?: string;
}

interface Warehouse {
  id: string;
  name: string;
  state: string;
  cluster_size?: string;
  warehouse_type?: string;
  enable_serverless_compute?: boolean;
}

interface WarehouseState {
  ok?: boolean;
  state?: string;
  name?: string;
  cluster_size?: string;
  warehouse_type?: string;
  serverless?: boolean;
  error?: string;
}

interface SchemaResponse {
  ok: boolean;
  state?: string;
  catalogs?: string[];
  schemas?: string[];
  tables?: string[];
  message?: string;
  error?: string;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function stateColor(state?: string): 'success' | 'warning' | 'severe' | 'informative' {
  if (state === 'RUNNING') return 'success';
  if (state === 'STARTING' || state === 'STOPPING') return 'warning';
  if (state === 'STOPPED') return 'informative';
  return 'severe';
}

function ResultsPanel({ result, loading }: { result: QueryResponse | null; loading: boolean }) {
  const s = useStyles();
  if (loading) {
    return (
      <div className={s.resultBox}>
        <Spinner size="small" label="Executing SQL on warehouse…" labelPosition="after" />
      </div>
    );
  }
  if (!result) {
    return (
      <div className={s.resultBox}>
        <Caption1>Click <strong>Run</strong> to execute. Results appear here.</Caption1>
      </div>
    );
  }
  if (!result.ok) {
    return (
      <div className={s.resultBox}>
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Query failed</MessageBarTitle>
            {result.error || 'Unknown error'} {result.code && <Caption1>· {result.code}</Caption1>}
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
        {result.truncated && <Badge appearance="outline" color="warning">truncated</Badge>}
      </div>
      {rows.length === 0 ? (
        <Caption1>Query returned no rows.</Caption1>
      ) : (
        <div className={s.tableWrap}>
          <Table aria-label="Query results" size="small">
            <TableHeader>
              <TableRow>
                {columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={i}>
                  {columns.map((_, j) => (
                    <TableCell key={j} className={s.cell}>{formatCell(row[j])}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function DatabricksSqlWarehouseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();

  const [sqlText, setSqlText] = useState<string>(
    `-- Databricks SQL Warehouse — Unity Catalog.\n-- Click a table on the left to insert a SELECT.\nSELECT current_catalog() AS catalog, current_database() AS schema, current_user() AS upn;`,
  );
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState<string>('');
  const [warehouseState, setWarehouseState] = useState<WarehouseState | null>(null);
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [activeCatalog, setActiveCatalog] = useState<string | null>(null);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [activeSchema, setActiveSchema] = useState<string | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [warehousesError, setWarehousesError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  // ---- Initial: load warehouses, pick first, fetch state ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/warehouses`);
        const j = await r.json();
        if (cancelled) return;
        if (!j.ok) {
          setWarehousesError(j.error || `HTTP ${r.status}`);
          return;
        }
        const list = (j.warehouses || []) as Warehouse[];
        setWarehouses(list);
        if (list.length > 0 && !warehouseId) setWarehouseId(list[0].id);
      } catch (e: any) {
        if (!cancelled) setWarehousesError(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; if (pollRef.current) window.clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ---- State + catalogs whenever warehouse changes ----
  const refreshState = useCallback(async (): Promise<WarehouseState | null> => {
    if (!warehouseId) return null;
    const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/state?warehouseId=${encodeURIComponent(warehouseId)}`);
    const j = (await r.json()) as WarehouseState;
    setWarehouseState(j);
    return j;
  }, [id, warehouseId]);

  const refreshCatalogs = useCallback(async () => {
    if (!warehouseId) return;
    const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/schema?warehouseId=${encodeURIComponent(warehouseId)}`);
    const j = (await r.json()) as SchemaResponse;
    if (j.ok) setCatalogs(j.catalogs || []);
  }, [id, warehouseId]);

  useEffect(() => {
    if (!warehouseId) return;
    setActiveCatalog(null);
    setActiveSchema(null);
    setSchemas([]);
    setTables([]);
    refreshState().then((st) => { if (st?.state === 'RUNNING') refreshCatalogs(); });
  }, [warehouseId, refreshState, refreshCatalogs]);

  // ---- Schema drill-down ----
  const openCatalog = useCallback(async (cat: string) => {
    if (!warehouseId) return;
    setActiveCatalog(cat);
    setActiveSchema(null);
    setSchemas([]);
    setTables([]);
    const r = await fetch(
      `/api/items/databricks-sql-warehouse/${id}/schema?warehouseId=${encodeURIComponent(warehouseId)}&catalog=${encodeURIComponent(cat)}`,
    );
    const j = (await r.json()) as SchemaResponse;
    if (j.ok) setSchemas(j.schemas || []);
  }, [id, warehouseId]);

  const openSchema = useCallback(async (cat: string, sch: string) => {
    if (!warehouseId) return;
    setActiveSchema(sch);
    setTables([]);
    const r = await fetch(
      `/api/items/databricks-sql-warehouse/${id}/schema?warehouseId=${encodeURIComponent(warehouseId)}&catalog=${encodeURIComponent(cat)}&schema=${encodeURIComponent(sch)}`,
    );
    const j = (await r.json()) as SchemaResponse;
    if (j.ok) setTables(j.tables || []);
  }, [id, warehouseId]);

  // ---- Start / Stop with poll ----
  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = window.setInterval(async () => {
      const st = await refreshState();
      if (st?.state === 'RUNNING' || st?.state === 'STOPPED') {
        if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
        setStarting(false);
        if (st.state === 'RUNNING') refreshCatalogs();
      }
    }, 5_000);
  }, [refreshState, refreshCatalogs]);

  const start = useCallback(async () => {
    if (!warehouseId) return;
    setStarting(true);
    try {
      await fetch(`/api/items/databricks-sql-warehouse/${id}/start?warehouseId=${encodeURIComponent(warehouseId)}`, { method: 'POST' });
      startPolling();
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
      setStarting(false);
    }
  }, [id, warehouseId, startPolling]);

  const stop = useCallback(async () => {
    if (!warehouseId) return;
    await fetch(`/api/items/databricks-sql-warehouse/${id}/state?warehouseId=${encodeURIComponent(warehouseId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    });
    refreshState();
  }, [id, warehouseId, refreshState]);

  // ---- Run query ----
  const run = useCallback(async () => {
    if (!warehouseId) {
      setResult({ ok: false, error: 'No warehouse selected.' });
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`/api/items/databricks-sql-warehouse/${id}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sql: sqlText,
          warehouseId,
          catalog: activeCatalog || undefined,
          schema: activeSchema || undefined,
        }),
      });
      const json = (await res.json()) as QueryResponse;
      if (res.status === 409 && json.state) {
        setResult({ ok: false, error: `Warehouse is ${json.state}. Click Start.` });
        refreshState();
      } else {
        setResult(json);
      }
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setLoading(false);
    }
  }, [id, sqlText, warehouseId, activeCatalog, activeSchema, refreshState]);

  const state = warehouseState?.state || 'UNKNOWN';
  const isRunning = state === 'RUNNING';
  const selectedWarehouse = useMemo(
    () => warehouses.find((w) => w.id === warehouseId) || null,
    [warehouses, warehouseId],
  );

  const newSql = useCallback(() => {
    setSqlText('-- New SQL.\nSELECT current_catalog() AS catalog, current_database() AS schema;');
    setResult(null);
  }, []);

  // Query history dialog state — paginates /api/2.0/sql/history/queries
  interface QHEntry {
    query_id: string;
    status: string;
    query_text?: string;
    query_start_time_ms?: number;
    duration?: number;
    user_name?: string;
    rows_produced?: number;
    error_message?: string;
  }
  const [qhOpen, setQhOpen] = useState(false);
  const [qhEntries, setQhEntries] = useState<QHEntry[]>([]);
  const [qhBusy, setQhBusy] = useState(false);
  const [qhError, setQhError] = useState<string | null>(null);
  const [qhNext, setQhNext] = useState<string | null>(null);

  const loadQueryHistory = useCallback(async (append = false, pageToken?: string) => {
    setQhBusy(true); setQhError(null);
    try {
      const params = new URLSearchParams();
      if (warehouseId) params.set('warehouseId', warehouseId);
      params.set('maxResults', '50');
      if (pageToken) params.set('pageToken', pageToken);
      const r = await fetch(`/api/items/databricks-sql-warehouse/${id}/query-history?${params.toString()}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setQhEntries((prev) => append ? [...prev, ...(j.entries || [])] : (j.entries || []));
      setQhNext(j.nextPageToken || null);
    } catch (e: any) { setQhError(e?.message || String(e)); }
    finally { setQhBusy(false); }
  }, [id, warehouseId]);

  const openQueryHistory = useCallback(() => {
    setQhOpen(true);
    loadQueryHistory(false);
  }, [loadQueryHistory]);
  const refreshAll = useCallback(() => {
    refreshState().then((st) => { if (st?.state === 'RUNNING') refreshCatalogs(); });
  }, [refreshState, refreshCatalogs]);
  const canStart = !!warehouseId && !starting && (state === 'STOPPED' || state === 'STOPPING' || state === 'UNKNOWN');
  const canStop = !!warehouseId && isRunning;
  const canRun = !!warehouseId && isRunning && !loading;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Query', actions: [
        { label: 'New SQL query', onClick: newSql },
        { label: loading ? 'Running…' : 'Run', onClick: canRun ? run : undefined, disabled: !canRun },
        { label: 'Query history', onClick: warehouseId ? openQueryHistory : undefined, disabled: !warehouseId, title: !warehouseId ? 'Pick a warehouse first' : undefined },
      ]},
      { label: 'Warehouse', actions: [
        { label: starting ? 'Starting…' : 'Start', onClick: canStart ? start : undefined, disabled: !canStart },
        { label: 'Stop', onClick: canStop ? stop : undefined, disabled: !canStop },
        { label: 'Refresh', onClick: warehouseId ? refreshAll : undefined, disabled: !warehouseId },
      ]},
    ]},
  ], [newSql, loading, canRun, run, starting, canStart, start, canStop, stop, refreshAll, warehouseId, openQueryHistory]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Tree aria-label="Unity Catalog" defaultOpenItems={['catalogs']}>
            <TreeItem itemType="branch" value="catalogs">
              <TreeItemLayout iconBefore={<Database20Regular />}>
                Catalogs ({catalogs.length})
              </TreeItemLayout>
              <Tree>
                {!isRunning && (
                  <TreeItem itemType="leaf" value="stopped">
                    <TreeItemLayout>Warehouse {state.toLowerCase()} — start to browse</TreeItemLayout>
                  </TreeItem>
                )}
                {isRunning && catalogs.length === 0 && (
                  <TreeItem itemType="leaf" value="empty">
                    <TreeItemLayout>No catalogs visible to this principal.</TreeItemLayout>
                  </TreeItem>
                )}
                {catalogs.map((c) => (
                  <TreeItem
                    key={c}
                    itemType="branch"
                    value={`c-${c}`}
                    onClick={() => openCatalog(c)}
                  >
                    <TreeItemLayout iconBefore={<Folder20Regular />}>
                      {c} {activeCatalog === c && '·'}
                    </TreeItemLayout>
                    <Tree>
                      {activeCatalog === c && schemas.length === 0 && (
                        <TreeItem itemType="leaf" value={`c-${c}-empty`}>
                          <TreeItemLayout>(loading schemas…)</TreeItemLayout>
                        </TreeItem>
                      )}
                      {activeCatalog === c && schemas.map((sch) => (
                        <TreeItem
                          key={`${c}.${sch}`}
                          itemType="branch"
                          value={`s-${c}.${sch}`}
                          onClick={(e) => { e.stopPropagation(); openSchema(c, sch); }}
                        >
                          <TreeItemLayout iconBefore={<Folder20Regular />}>
                            {sch} {activeSchema === sch && '·'}
                          </TreeItemLayout>
                          <Tree>
                            {activeSchema === sch && tables.length === 0 && (
                              <TreeItem itemType="leaf" value={`t-${c}.${sch}-empty`}>
                                <TreeItemLayout>(no tables)</TreeItemLayout>
                              </TreeItem>
                            )}
                            {activeSchema === sch && tables.map((t) => (
                              <TreeItem
                                key={`${c}.${sch}.${t}`}
                                itemType="leaf"
                                value={`t-${c}.${sch}.${t}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSqlText(`SELECT * FROM \`${c}\`.\`${sch}\`.\`${t}\` LIMIT 100;`);
                                }}
                              >
                                <TreeItemLayout iconBefore={<DocumentTable20Regular />}>
                                  {t}
                                </TreeItemLayout>
                              </TreeItem>
                            ))}
                          </Tree>
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
          {warehousesError && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Could not list warehouses</MessageBarTitle>
                {warehousesError}
              </MessageBarBody>
            </MessageBar>
          )}
          <div className={s.toolbar}>
            <Dropdown
              aria-label="Warehouse"
              placeholder="Select warehouse"
              value={selectedWarehouse?.name || ''}
              selectedOptions={warehouseId ? [warehouseId] : []}
              onOptionSelect={(_, data) => { if (data.optionValue) setWarehouseId(data.optionValue); }}
              disabled={warehouses.length === 0}
              style={{ minWidth: 240 }}
            >
              {warehouses.map((w) => (
                <Option key={w.id} value={w.id} text={w.name}>
                  {w.name} {w.cluster_size ? `· ${w.cluster_size}` : ''}
                </Option>
              ))}
            </Dropdown>
            <Badge appearance="filled" color={stateColor(state)}>{state}</Badge>
            {warehouseState?.cluster_size && (
              <Badge appearance="outline">{warehouseState.cluster_size}</Badge>
            )}
            {warehouseState?.serverless && (
              <Badge appearance="outline" color="brand">Serverless</Badge>
            )}
            {(state === 'STOPPED' || state === 'STOPPING') && (
              <Button appearance="primary" icon={<Play20Regular />} disabled={starting || !warehouseId} onClick={start}>
                {starting ? 'Starting…' : 'Start'}
              </Button>
            )}
            {isRunning && (
              <Button appearance="outline" icon={<Stop20Regular />} onClick={stop}>Stop</Button>
            )}
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => {
              refreshState().then((st) => { if (st?.state === 'RUNNING') refreshCatalogs(); });
            }}>Refresh</Button>
            <Button
              appearance="primary"
              icon={<Play20Regular />}
              disabled={loading || !isRunning || !warehouseId}
              onClick={run}
              style={{ marginLeft: 'auto' }}
            >
              Run
            </Button>
          </div>
          {state === 'STARTING' && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Warehouse starting</MessageBarTitle>
                Typically 30–60 seconds on serverless, 2–5 min on classic. Run lights up when state is RUNNING.
              </MessageBarBody>
            </MessageBar>
          )}
          {state === 'STOPPED' && !starting && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Warehouse stopped</MessageBarTitle>
                Warehouses auto-stop after their idle window. Click Start to bring it RUNNING; storage is always charged, compute only while RUNNING.
              </MessageBarBody>
            </MessageBar>
          )}
          {activeCatalog && (
            <Caption1>
              Context: <strong>{activeCatalog}</strong>{activeSchema ? <> · <strong>{activeSchema}</strong></> : null}
            </Caption1>
          )}
          <MonacoTextarea
            value={sqlText}
            onChange={setSqlText}
            language="sql"
            height={260}
            minHeight={200}
            ariaLabel="Databricks SQL editor"
          />
          <ResultsPanel result={result} loading={loading} />
          {!warehousesError && warehouses.length === 0 && (
            <div>
              <Subtitle2>No SQL Warehouses found</Subtitle2>
              <Body1>
                The deployed Databricks workspace has no SQL Warehouses yet. Create one in the
                Databricks portal (SQL → Warehouses → Create) — Loom will pick it up automatically.
              </Body1>
            </div>
          )}

          <Dialog open={qhOpen} onOpenChange={(_, d) => setQhOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '1080px', width: '95vw' }}>
              <DialogBody>
                <DialogTitle>Query history — {selectedWarehouse?.name || warehouseId}</DialogTitle>
                <DialogContent>
                  {qhBusy && <Spinner size="tiny" label="Loading…" labelPosition="after" />}
                  {qhError && (
                    <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Failed</MessageBarTitle>{qhError}</MessageBarBody></MessageBar>
                  )}
                  <div style={{ overflow: 'auto', maxHeight: '60vh' }}>
                    <Table aria-label="Query history" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Status</TableHeaderCell>
                        <TableHeaderCell>Start</TableHeaderCell>
                        <TableHeaderCell>Duration</TableHeaderCell>
                        <TableHeaderCell>User</TableHeaderCell>
                        <TableHeaderCell>Rows</TableHeaderCell>
                        <TableHeaderCell>Query</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {qhEntries.length === 0 && !qhBusy && (
                          <TableRow><TableCell colSpan={6}><Caption1>No queries yet.</Caption1></TableCell></TableRow>
                        )}
                        {qhEntries.map((q) => (
                          <TableRow key={q.query_id}>
                            <TableCell>
                              <Badge appearance="filled" color={q.status === 'FINISHED' ? 'success' : q.status === 'FAILED' ? 'danger' : 'informative'}>
                                {q.status}
                              </Badge>
                            </TableCell>
                            <TableCell>{q.query_start_time_ms ? new Date(q.query_start_time_ms).toLocaleString() : '—'}</TableCell>
                            <TableCell>{q.duration != null ? `${(q.duration / 1000).toFixed(1)}s` : '—'}</TableCell>
                            <TableCell>{q.user_name || '—'}</TableCell>
                            <TableCell>{q.rows_produced ?? '—'}</TableCell>
                            <TableCell style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              <code style={{ fontSize: 11 }}>{q.query_text?.slice(0, 200) || (q.error_message ? `ERR: ${q.error_message}` : '—')}</code>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setQhOpen(false)} disabled={qhBusy}>Close</Button>
                  <Button appearance="subtle" onClick={() => loadQueryHistory(false)} disabled={qhBusy}>Refresh</Button>
                  <Button appearance="primary" onClick={() => loadQueryHistory(true, qhNext || undefined)} disabled={qhBusy || !qhNext}>
                    {qhNext ? 'Load more' : 'No more pages'}
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
// Shared helpers
// ============================================================

interface Cluster {
  cluster_id: string;
  cluster_name?: string;
  state?: string;
  spark_version?: string;
  node_type_id?: string;
  num_workers?: number;
  autoscale?: { min_workers?: number; max_workers?: number };
  autotermination_minutes?: number;
  state_message?: string;
  // v3.4 — Libraries + Init Scripts tabs surface these from the GET response.
  // Databricks GET /api/2.0/clusters/get returns init_scripts + spark_conf
  // inline on the cluster object; libraries are a separate REST call
  // (/api/2.0/libraries/cluster-status?cluster_id=...).
  spark_conf?: Record<string, string>;
  init_scripts?: Array<{
    workspace?: { destination?: string };
    volumes?: { destination?: string };
    dbfs?: { destination?: string };
    s3?: { destination?: string };
    abfss?: { destination?: string };
    gcs?: { destination?: string };
    file?: { destination?: string };
  }>;
  custom_tags?: Record<string, string>;
  data_security_mode?: string;
}

// Library object returned by /api/2.0/libraries/cluster-status — slim shape,
// just the fields the tab renders. Real response includes per-library
// install status (INSTALLED / PENDING / FAILED) and messages.
interface ClusterLibrary {
  status?: string;
  messages?: string[];
  library?: {
    pypi?: { package?: string; repo?: string };
    maven?: { coordinates?: string; repo?: string };
    cran?: { package?: string };
    jar?: string;
    egg?: string;
    whl?: string;
    requirements?: string;
  };
}

function clusterStateColor(s?: string): 'success' | 'warning' | 'severe' | 'informative' {
  if (s === 'RUNNING') return 'success';
  if (s === 'PENDING' || s === 'RESTARTING' || s === 'RESIZING') return 'warning';
  if (s === 'TERMINATED') return 'informative';
  return 'severe';
}

function runStateColor(s?: string): 'success' | 'warning' | 'severe' | 'informative' {
  if (s === 'SUCCESS') return 'success';
  if (s === 'FAILED' || s === 'TIMEDOUT' || s === 'CANCELED') return 'severe';
  if (s === 'RUNNING' || s === 'PENDING') return 'warning';
  return 'informative';
}

function fmtTime(ms?: number): string {
  if (!ms) return '—';
  try { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z'; }
  catch { return String(ms); }
}

function fmtDuration(ms?: number): string {
  if (!ms || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ============================================================
// Databricks Notebook editor — cell-based, Databricks-parity
//
// One-for-one with the real Databricks notebook surface:
//   - Workspace tree (browse / open / new / delete notebooks)
//   - Cluster picker + live cluster status badge
//   - Cell-based authoring: add code/markdown cells, reorder, delete,
//     duplicate, per-cell language (Python/SQL/Scala/R via %-magics),
//     Monaco editor per code cell, markdown render per md cell
//   - Run cell / Run all against a real cluster via the Databricks
//     Command Execution API (api/1.2). Real stdout / table / error per cell.
//   - Save -> serialises cells to Databricks SOURCE format and imports
//     them to the workspace (api/2.0/workspace/import).
//   - Open -> exports SOURCE (api/2.0/workspace/export) and parses to cells.
//
// Honest gates: if no cluster is RUNNING, the Run controls explain the exact
// action (start a cluster); if the workspace REST is not reachable the tree
// surfaces the precise error from the BFF.
// ============================================================

interface WorkspaceObject {
  object_type: string;
  path: string;
  language?: string;
}

interface RunRow {
  run_id: number;
  run_name?: string;
  state?: { life_cycle_state?: string; result_state?: string; state_message?: string };
  start_time?: number;
  execution_duration?: number;
  creator_user_name?: string;
}

interface CellResult {
  status: 'idle' | 'running' | 'ok' | 'error';
  resultType?: 'text' | 'table' | 'image' | 'error';
  text?: string;
  columns?: string[];
  rows?: unknown[][];
  image?: string;
  error?: string;
  cause?: string;
  truncated?: boolean;
  ms?: number;
}

// Map Databricks workspace object language -> notebook base language.
function detectBase(lang?: string): DbxBaseLanguage {
  const u = (lang || 'PYTHON').toUpperCase();
  if (u === 'SQL') return 'SQL';
  if (u === 'SCALA') return 'SCALA';
  if (u === 'R') return 'R';
  return 'PYTHON';
}

export function DatabricksNotebookEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();

  // ---- Workspace tree ----
  const [rootPath, setRootPath] = useState('/Workspace');
  const [tree, setTree] = useState<Record<string, WorkspaceObject[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/Workspace']));
  const [treeError, setTreeError] = useState<string | null>(null);

  // ---- Open notebook ----
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [baseLanguage, setBaseLanguage] = useState<DbxBaseLanguage>('PYTHON');
  const [loadingFile, setLoadingFile] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileMessage, setFileMessage] = useState<string | null>(null);

  // ---- Cells (the core of the editor) ----
  const [cells, setCells] = useState<NotebookCell[]>([emptyCell('code', 'python')]);
  const [origSerialized, setOrigSerialized] = useState<string>('');
  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const [cellResults, setCellResults] = useState<Record<string, CellResult>>({});

  // ---- Cluster + execution context ----
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [clusterId, setClusterId] = useState<string>('');
  const [clustersError, setClustersError] = useState<string | null>(null);
  // One execution context per (cluster, command-language) so REPL state
  // persists across cells of the same language. Keyed `${clusterId}:${lang}`.
  const contextsRef = useRef<Record<string, string>>({});
  const [runningAll, setRunningAll] = useState(false);

  const serialized = useMemo(() => serializeCells(cells, baseLanguage), [cells, baseLanguage]);
  const dirty = !!selectedPath && serialized !== origSerialized;

  // ---- Load tree + clusters on mount ----
  const loadDir = useCallback(async (path: string) => {
    try {
      const r = await fetch(`/api/items/databricks-notebook/list?path=${encodeURIComponent(path)}`);
      const j = await r.json();
      if (!j.ok) { setTreeError(j.error || `HTTP ${r.status}`); return; }
      setTreeError(null);
      setTree((t) => ({ ...t, [path]: (j.objects || []) as WorkspaceObject[] }));
    } catch (e: any) {
      setTreeError(e?.message || String(e));
    }
  }, []);

  const loadClusters = useCallback(async () => {
    try {
      const r = await fetch('/api/items/databricks-cluster');
      const j = await r.json();
      if (!j.ok) { setClustersError(j.error || `HTTP ${r.status}`); return; }
      setClustersError(null);
      const list = (j.clusters || []) as Cluster[];
      setClusters(list);
      setClusterId((prev) => {
        if (prev && list.some((c) => c.cluster_id === prev)) return prev;
        const running = list.find((c) => c.state === 'RUNNING');
        return running ? running.cluster_id : (list[0]?.cluster_id || '');
      });
    } catch (e: any) {
      setClustersError(e?.message || String(e));
    }
  }, []);

  useEffect(() => {
    void loadDir(rootPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);
  useEffect(() => { void loadClusters(); }, [loadClusters]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else { next.add(path); if (!tree[path]) void loadDir(path); }
      return next;
    });
  }, [tree, loadDir]);

  // ---- Open a notebook: export SOURCE, parse to cells ----
  const openNotebook = useCallback(async (path: string, lang?: string) => {
    setSelectedPath(path);
    setFileError(null);
    setFileMessage(null);
    setLoadingFile(true);
    setCellResults({});
    try {
      const r = await fetch(`/api/items/databricks-notebook/${id}?path=${encodeURIComponent(path)}`);
      const j = await r.json();
      if (!j.ok) { setFileError(j.error || `HTTP ${r.status}`); return; }
      const base = detectBase(lang || j.language);
      setBaseLanguage(base);
      const parsed = parseSource(j.content || '', base);
      setCells(parsed);
      setOrigSerialized(serializeCells(parsed, base));
      setActiveCellId(parsed[0]?.id || null);
    } catch (e: any) {
      setFileError(e?.message || String(e));
    } finally {
      setLoadingFile(false);
    }
  }, [id]);

  // ---- Save: serialise cells -> SOURCE -> workspace/import ----
  const save = useCallback(async () => {
    if (!selectedPath) return;
    setSavingFile(true);
    setFileError(null);
    setFileMessage(null);
    const snapshot = serializeCells(cells, baseLanguage);
    try {
      const r = await fetch(`/api/items/databricks-notebook/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: selectedPath, language: baseLanguage, content: snapshot }),
      });
      const j = await r.json();
      if (!j.ok) setFileError(j.error || `HTTP ${r.status}`);
      else {
        setOrigSerialized(snapshot);
        setFileMessage(`Saved to ${selectedPath} at ${new Date().toLocaleTimeString()}`);
      }
    } catch (e: any) {
      setFileError(e?.message || String(e));
    } finally {
      setSavingFile(false);
    }
  }, [id, selectedPath, baseLanguage, cells]);

  // Ctrl/Cmd+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (selectedPath && dirty && !savingFile) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedPath, dirty, savingFile, save]);

  // ---- New notebook in the workspace ----
  const newNotebook = useCallback(async () => {
    const suggested = `${rootPath.replace(/\/$/, '')}/loom-notebook-${Date.now()}`;
    const path = window.prompt('New notebook path', suggested);
    if (!path) return;
    setFileError(null); setFileMessage(null);
    const starter = [emptyCell('code', 'python')];
    const src = serializeCells(starter, 'PYTHON');
    try {
      const r = await fetch(`/api/items/databricks-notebook/${id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, language: 'PYTHON', content: src }),
      });
      const j = await r.json();
      if (!j.ok) { setFileError(j.error || `HTTP ${r.status}`); return; }
      setTree({}); void loadDir(rootPath);
      await openNotebook(path, 'PYTHON');
    } catch (e: any) { setFileError(e?.message || String(e)); }
  }, [id, rootPath, loadDir, openNotebook]);

  // ---- Delete a notebook from the tree ----
  const deleteObject = useCallback(async (path: string, isDir: boolean) => {
    if (!window.confirm(`Delete ${path}${isDir ? ' (and contents)' : ''}?`)) return;
    try {
      const qs = `path=${encodeURIComponent(path)}${isDir ? '&recursive=true' : ''}`;
      const r = await fetch(`/api/items/databricks-notebook/${id}?${qs}`, { method: 'DELETE' });
      const j = await r.json();
      if (!j.ok) { setTreeError(j.error || `HTTP ${r.status}`); return; }
      if (selectedPath === path) { setSelectedPath(null); setCells([emptyCell('code', 'python')]); }
      setTree({}); void loadDir(rootPath);
    } catch (e: any) { setTreeError(e?.message || String(e)); }
  }, [id, rootPath, loadDir, selectedPath]);

  // ---- Cell mutations ----
  const updateCell = useCallback((next: NotebookCell) => {
    setCells((cs) => cs.map((c) => (c.id === next.id ? next : c)));
  }, []);
  const addCell = useCallback((type: 'code' | 'markdown', afterId?: string) => {
    const fresh = emptyCell(type, type === 'code' ? 'python' : 'python');
    setCells((cs) => {
      if (!afterId) return [...cs, fresh];
      const idx = cs.findIndex((c) => c.id === afterId);
      if (idx < 0) return [...cs, fresh];
      const copy = cs.slice();
      copy.splice(idx + 1, 0, fresh);
      return copy;
    });
    setActiveCellId(fresh.id);
  }, []);
  const deleteCell = useCallback((cellId: string) => {
    setCells((cs) => (cs.length <= 1 ? cs : cs.filter((c) => c.id !== cellId)));
    setCellResults((r) => { const n = { ...r }; delete n[cellId]; return n; });
  }, []);
  const duplicateCell = useCallback((cellId: string) => {
    setCells((cs) => {
      const idx = cs.findIndex((c) => c.id === cellId);
      if (idx < 0) return cs;
      const src = cs[idx];
      const dup: NotebookCell = { ...src, id: emptyCell('code').id, output: undefined, executionCount: undefined };
      const copy = cs.slice();
      copy.splice(idx + 1, 0, dup);
      return copy;
    });
  }, []);
  const moveCell = useCallback((cellId: string, dir: -1 | 1) => {
    setCells((cs) => {
      const idx = cs.findIndex((c) => c.id === cellId);
      const j = idx + dir;
      if (idx < 0 || j < 0 || j >= cs.length) return cs;
      const copy = cs.slice();
      [copy[idx], copy[j]] = [copy[j], copy[idx]];
      return copy;
    });
  }, []);

  // ---- Execute a single cell against the cluster ----
  const selectedCluster = useMemo(
    () => clusters.find((c) => c.cluster_id === clusterId) || null,
    [clusters, clusterId],
  );
  const clusterRunning = selectedCluster?.state === 'RUNNING';

  const runCell = useCallback(async (cell: NotebookCell): Promise<void> => {
    if (cell.type === 'markdown') return; // markdown renders client-side
    if (!clusterId) {
      setCellResults((r) => ({ ...r, [cell.id]: { status: 'error', error: 'No cluster selected. Pick a cluster above.' } }));
      return;
    }
    const cmdLang = cellLangToCommandLanguage(cell.lang);
    const ctxKey = `${clusterId}:${cmdLang}`;
    const t0 = Date.now();
    setCellResults((r) => ({ ...r, [cell.id]: { status: 'running' } }));
    try {
      const res = await fetch(`/api/items/databricks-notebook/${id}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clusterId,
          language: cmdLang,
          command: cell.source,
          contextId: contextsRef.current[ctxKey] || undefined,
        }),
      });
      const j = await res.json();
      if (!j.ok) {
        setCellResults((r) => ({ ...r, [cell.id]: { status: 'error', error: j.error || `HTTP ${res.status}` } }));
        return;
      }
      // Cache the context id for REPL persistence across cells.
      if (j.contextId) contextsRef.current[ctxKey] = j.contextId;
      const ms = Date.now() - t0;
      if (j.resultType === 'error' || j.status === 'Error') {
        setCellResults((r) => ({ ...r, [cell.id]: { status: 'error', resultType: 'error', error: j.error, cause: j.cause, ms } }));
      } else {
        setCellResults((r) => ({
          ...r,
          [cell.id]: {
            status: 'ok',
            resultType: j.resultType,
            text: j.text,
            columns: j.columns,
            rows: j.rows,
            image: j.image,
            truncated: j.truncated,
            ms,
          },
        }));
      }
    } catch (e: any) {
      setCellResults((r) => ({ ...r, [cell.id]: { status: 'error', error: e?.message || String(e) } }));
    }
  }, [id, clusterId]);

  const runAll = useCallback(async () => {
    setRunningAll(true);
    try {
      for (const cell of cells) {
        if (cell.type === 'markdown') continue;
        if (!cell.source.trim()) continue;
        await runCell(cell);
        const res = cellResults[cell.id];
        // stop-on-error parity with Databricks "Run all"
        if (res?.status === 'error') break;
      }
    } finally {
      setRunningAll(false);
    }
  }, [cells, runCell, cellResults]);

  const clearOutputs = useCallback(() => setCellResults({}), []);

  // ---- Runs history (jobs runs/list) ----
  const [runs, setRuns] = useState<RunRow[]>([]);
  const loadRuns = useCallback(async () => {
    const r = await fetch(`/api/items/databricks-notebook/${id}/runs`);
    const j = await r.json();
    if (j.ok) setRuns(j.runs || []);
  }, [id]);
  const [runsOpen, setRunsOpen] = useState(false);
  const openRuns = useCallback(() => { setRunsOpen(true); void loadRuns(); }, [loadRuns]);

  // ---- Tree render ----
  const renderTree = (path: string, depth = 0): JSX.Element[] => {
    const items = tree[path] || [];
    return items.map((o) => {
      const isDir = o.object_type === 'DIRECTORY' || o.object_type === 'REPO';
      const isNb = o.object_type === 'NOTEBOOK';
      const isOpen = expanded.has(o.path);
      return (
        <div key={o.path} style={{ paddingLeft: depth * 12 }}>
          <div
            className={s.treeRow}
            style={{ background: selectedPath === o.path ? tokens.colorNeutralBackground2Selected : undefined }}
          >
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, cursor: 'pointer', minWidth: 0 }}
              onClick={() => isDir ? toggle(o.path) : isNb ? openNotebook(o.path, o.language) : undefined}
            >
              {isDir ? <Folder20Regular /> : isNb ? <Document20Regular /> : <DocumentTable20Regular />}
              <Caption1 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {o.path.split('/').pop() || o.path}
              </Caption1>
              {o.language && <Caption1 style={{ opacity: 0.6 }}>· {o.language}</Caption1>}
            </div>
            {(isNb || isDir) && (
              <Button
                size="small" appearance="subtle" icon={<Delete20Regular />}
                className={s.treeDelete}
                aria-label={`Delete ${o.path}`}
                onClick={(e) => { e.stopPropagation(); deleteObject(o.path, isDir); }}
              />
            )}
          </div>
          {isDir && isOpen && tree[o.path] !== undefined && renderTree(o.path, depth + 1)}
          {isDir && isOpen && tree[o.path] === undefined && (
            <div style={{ paddingLeft: (depth + 1) * 12 }}><Caption1>(loading…)</Caption1></div>
          )}
        </div>
      );
    });
  };

  const refreshTree = useCallback(() => { setTree({}); void loadDir(rootPath); }, [rootPath, loadDir]);
  const canRunAll = !!clusterId && !runningAll && cells.some((c) => c.type === 'code' && c.source.trim());

  const ribbonNb: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'File', actions: [
        { label: 'New notebook', onClick: newNotebook },
        { label: savingFile ? 'Saving…' : 'Save', onClick: selectedPath && dirty && !savingFile ? save : undefined, disabled: !selectedPath || !dirty || savingFile },
      ]},
      { label: 'Cells', actions: [
        { label: 'Add code cell', onClick: () => addCell('code', activeCellId || undefined) },
        { label: 'Add markdown', onClick: () => addCell('markdown', activeCellId || undefined) },
      ]},
      { label: 'Run', actions: [
        { label: runningAll ? 'Running all…' : 'Run all', onClick: canRunAll ? runAll : undefined, disabled: !canRunAll },
        { label: 'Clear outputs', onClick: clearOutputs },
        { label: 'View runs', onClick: openRuns },
      ]},
      { label: 'Workspace', actions: [
        { label: 'Refresh tree', onClick: refreshTree },
        { label: 'Refresh clusters', onClick: () => void loadClusters() },
      ]},
    ]},
  ], [newNotebook, savingFile, selectedPath, dirty, save, addCell, activeCellId, runningAll, canRunAll, runAll, clearOutputs, openRuns, refreshTree, loadClusters]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbonNb}
      leftPanel={
        <div className={s.treePad}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <Input
              value={rootPath}
              onChange={(_, d) => setRootPath(d.value || '/Workspace')}
              size="small"
              style={{ flex: 1 }}
            />
            <Button size="small" icon={<ArrowSync20Regular />} aria-label="Refresh tree" onClick={refreshTree} />
            <Button size="small" icon={<Add20Regular />} aria-label="New notebook" onClick={newNotebook} />
          </div>
          {treeError && (
            <MessageBar intent="error">
              <MessageBarBody><MessageBarTitle>Workspace error</MessageBarTitle>{treeError}</MessageBarBody>
            </MessageBar>
          )}
          {renderTree(rootPath)}
        </div>
      }
      main={
        <div className={s.pad}>
          {/* Toolbar: notebook id + base language + cluster + run-all */}
          <div className={s.toolbar}>
            <Caption1 style={{ fontWeight: 600 }}>{selectedPath || 'New notebook (unsaved)'}</Caption1>
            <Dropdown
              aria-label="Notebook language"
              value={baseLanguage}
              selectedOptions={[baseLanguage]}
              onOptionSelect={(_, d) => d.optionValue && setBaseLanguage(d.optionValue as DbxBaseLanguage)}
              size="small"
              style={{ width: 120 }}
            >
              <Option value="PYTHON">Python</Option>
              <Option value="SQL">SQL</Option>
              <Option value="SCALA">Scala</Option>
              <Option value="R">R</Option>
            </Dropdown>
            <Dropdown
              placeholder="Attach cluster"
              aria-label="Cluster"
              value={selectedCluster ? `${selectedCluster.cluster_name || selectedCluster.cluster_id} · ${selectedCluster.state}` : ''}
              selectedOptions={clusterId ? [clusterId] : []}
              onOptionSelect={(_, d) => d.optionValue && setClusterId(d.optionValue)}
              size="small"
              style={{ minWidth: 240 }}
              disabled={clusters.length === 0}
            >
              {clusters.map((c) => (
                <Option key={c.cluster_id} value={c.cluster_id} text={`${c.cluster_name || c.cluster_id} · ${c.state}`}>
                  {c.cluster_name || c.cluster_id} · {c.state}
                </Option>
              ))}
            </Dropdown>
            {selectedCluster && (
              <Badge appearance="filled" color={clusterStateColor(selectedCluster.state)}>
                {selectedCluster.state}
              </Badge>
            )}
            <Button
              appearance="primary"
              icon={<Play20Regular />}
              disabled={!canRunAll}
              onClick={runAll}
              style={{ marginLeft: 'auto' }}
            >
              {runningAll ? 'Running all…' : 'Run all'}
            </Button>
            <Button
              appearance="primary"
              icon={<Save20Regular />}
              disabled={!selectedPath || !dirty || savingFile}
              onClick={save}
            >
              {savingFile ? 'Saving…' : dirty ? 'Save *' : 'Save'}
            </Button>
          </div>

          {clustersError && (
            <MessageBar intent="error">
              <MessageBarBody><MessageBarTitle>Could not list clusters</MessageBarTitle>{clustersError}</MessageBarBody>
            </MessageBar>
          )}
          {!clustersError && clusters.length === 0 && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>No clusters in this workspace</MessageBarTitle>
                Create a cluster in the Databricks Cluster editor (or the Databricks portal: Compute → Create compute).
                Cells need an attached cluster to execute via the Command Execution API.
              </MessageBarBody>
            </MessageBar>
          )}
          {!clustersError && clusters.length > 0 && !clusterRunning && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Cluster is {selectedCluster?.state?.toLowerCase() || 'not running'}</MessageBarTitle>
                Start <strong>{selectedCluster?.cluster_name || clusterId}</strong> in the Databricks Cluster editor
                (Start), then return here. Cells run against a RUNNING cluster; submitting now will start one on demand and may take 2–5 min.
              </MessageBarBody>
            </MessageBar>
          )}
          {fileError && (
            <MessageBar intent="error"><MessageBarBody>
              <MessageBarTitle>Notebook error</MessageBarTitle>{fileError}
            </MessageBarBody></MessageBar>
          )}
          {fileMessage && (
            <MessageBar intent="success"><MessageBarBody>{fileMessage}</MessageBarBody></MessageBar>
          )}

          {/* Cell list */}
          {loadingFile ? (
            <Spinner size="small" label="Loading notebook source…" labelPosition="after" />
          ) : (
            <div className={s.cellList}>
              <CellAdder
                onAddCode={() => addCell('code', undefined)}
                onAddMarkdown={() => addCell('markdown', undefined)}
              />
              {cells.map((cell, i) => {
                const res = cellResults[cell.id];
                const cellNode = cell.type === 'markdown' ? (
                  <MarkdownCell
                    key={cell.id}
                    cell={cell}
                    active={activeCellId === cell.id}
                    onFocus={() => setActiveCellId(cell.id)}
                    onChange={updateCell}
                    onDelete={() => deleteCell(cell.id)}
                    onMoveUp={() => moveCell(cell.id, -1)}
                    onMoveDown={() => moveCell(cell.id, 1)}
                    onDuplicate={() => duplicateCell(cell.id)}
                    canMoveUp={i > 0}
                    canMoveDown={i < cells.length - 1}
                  />
                ) : (
                  <div key={cell.id}>
                    <CodeCell
                      cell={cell}
                      active={activeCellId === cell.id}
                      onFocus={() => setActiveCellId(cell.id)}
                      onChange={updateCell}
                      onRun={runCell}
                      onDelete={() => deleteCell(cell.id)}
                      onMoveUp={() => moveCell(cell.id, -1)}
                      onMoveDown={() => moveCell(cell.id, 1)}
                      onDuplicate={() => duplicateCell(cell.id)}
                      canMoveUp={i > 0}
                      canMoveDown={i < cells.length - 1}
                    />
                    <DbxCellOutput res={res} />
                  </div>
                );
                return (
                  <div key={`${cell.id}-wrap`}>
                    {cellNode}
                    <CellAdder
                      onAddCode={() => addCell('code', cell.id)}
                      onAddMarkdown={() => addCell('markdown', cell.id)}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {/* Runs history dialog */}
          <Dialog open={runsOpen} onOpenChange={(_, d) => setRunsOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '1080px', width: '95vw' }}>
              <DialogBody>
                <DialogTitle>Workspace runs</DialogTitle>
                <DialogContent>
                  <div className={s.tableWrap}>
                    <Table size="small" aria-label="Recent runs">
                      <TableHeader><TableRow>
                        <TableHeaderCell>run_id</TableHeaderCell>
                        <TableHeaderCell>Name</TableHeaderCell>
                        <TableHeaderCell>State</TableHeaderCell>
                        <TableHeaderCell>Start</TableHeaderCell>
                        <TableHeaderCell>Exec</TableHeaderCell>
                        <TableHeaderCell>Creator</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {runs.length === 0 && (
                          <TableRow><TableCell colSpan={6}><Caption1>No runs yet.</Caption1></TableCell></TableRow>
                        )}
                        {runs.map((r) => (
                          <TableRow key={r.run_id}>
                            <TableCell>{r.run_id}</TableCell>
                            <TableCell>{r.run_name || '—'}</TableCell>
                            <TableCell>
                              <Badge appearance="outline" color={runStateColor(r.state?.result_state)}>
                                {r.state?.life_cycle_state || '—'}{r.state?.result_state ? ` · ${r.state.result_state}` : ''}
                              </Badge>
                            </TableCell>
                            <TableCell>{fmtTime(r.start_time)}</TableCell>
                            <TableCell>{fmtDuration(r.execution_duration)}</TableCell>
                            <TableCell>{r.creator_user_name || '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setRunsOpen(false)}>Close</Button>
                  <Button appearance="primary" onClick={() => void loadRuns()}>Refresh</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

// Renders a single cell's Command Execution result: text / table / image / error.
function DbxCellOutput({ res }: { res?: CellResult }) {
  const s = useStyles();
  if (!res || res.status === 'idle') return null;
  if (res.status === 'running') {
    return (
      <div className={s.cellOutput}>
        <Spinner size="tiny" label="Running on cluster…" labelPosition="after" />
      </div>
    );
  }
  if (res.status === 'error') {
    return (
      <div className={s.cellOutput}>
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Command failed</MessageBarTitle>
            {res.error || 'Unknown error'}
          </MessageBarBody>
        </MessageBar>
        {res.cause && (
          <pre className={s.cellPre} style={{ color: tokens.colorPaletteRedForeground1 }}>{res.cause}</pre>
        )}
      </div>
    );
  }
  // ok
  return (
    <div className={s.cellOutput}>
      <div className={s.resultMeta}>
        <Badge appearance="filled" color="success">{res.resultType || 'text'}</Badge>
        {typeof res.ms === 'number' && <Caption1>· {res.ms} ms</Caption1>}
        {res.truncated && <Badge appearance="outline" color="warning">truncated</Badge>}
      </div>
      {res.resultType === 'table' ? (
        <div className={s.tableWrap}>
          <Table aria-label="Cell result" size="small">
            <TableHeader>
              <TableRow>
                {(res.columns || []).map((c, i) => <TableHeaderCell key={`${c}-${i}`}>{c}</TableHeaderCell>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(res.rows || []).map((row, i) => (
                <TableRow key={i}>
                  {(res.columns || []).map((_, j) => (
                    <TableCell key={j} className={s.cell}>{formatCell((row as unknown[])[j])}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : res.resultType === 'image' && res.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img alt="cell output" src={res.image.startsWith('data:') ? res.image : `data:image/png;base64,${res.image}`} style={{ maxWidth: '100%' }} />
      ) : (
        <pre className={s.cellPre}>{res.text || '(no output)'}</pre>
      )}
    </div>
  );
}


// ============================================================
// Databricks Job editor
// ============================================================

interface JobRow {
  job_id: number;
  settings?: {
    name?: string;
    schedule?: { quartz_cron_expression?: string; timezone_id?: string };
    tasks?: any[];
  };
  creator_user_name?: string;
}

interface JobTaskForm {
  task_key: string;
  notebook_path: string;
  cluster_id: string;
  depends_on: string;
}

export function DatabricksJobEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();

  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [jobId, setJobId] = useState<number | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [cron, setCron] = useState('0 0 2 * * ?');
  const [tz, setTz] = useState('UTC');
  const [scheduled, setScheduled] = useState(false);
  const [tasks, setTasks] = useState<JobTaskForm[]>([
    { task_key: 'main', notebook_path: '', cluster_id: '', depends_on: '' },
  ]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  // Phase 4.5 — dirty tracking so Save button gates correctly and Ctrl+S
  // is a no-op when there are no edits. Any field mutation flips dirty=true;
  // a successful save or selecting another job resets dirty=false.
  const [dirty, setDirty] = useState(false);

  const [runs, setRuns] = useState<RunRow[]>([]);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const r = await fetch('/api/items/databricks-job');
      const j = await r.json();
      if (!j.ok) { setListError(j.error || `HTTP ${r.status}`); return; }
      setJobs(j.jobs || []);
    } catch (e: any) { setListError(e?.message || String(e)); }
  }, []);

  useEffect(() => {
    void loadJobs();
    void (async () => {
      const r = await fetch('/api/items/databricks-cluster');
      const j = await r.json();
      if (j.ok) setClusters(j.clusters || []);
    })();
  }, [loadJobs]);

  const selectJob = useCallback(async (jid: number) => {
    setJobId(jid);
    setSaveError(null);
    setSaveMessage(null);
    try {
      const r = await fetch(`/api/items/databricks-job/${id}?jobId=${jid}`);
      const j = await r.json();
      if (!j.ok) { setSaveError(j.error || `HTTP ${r.status}`); return; }
      const job = j.job as JobRow;
      setName(job.settings?.name || '');
      const sch = job.settings?.schedule;
      setScheduled(!!sch);
      setCron(sch?.quartz_cron_expression || '0 0 2 * * ?');
      setTz(sch?.timezone_id || 'UTC');
      setTasks((job.settings?.tasks || []).map((t: any) => ({
        task_key: t.task_key || '',
        notebook_path: t.notebook_task?.notebook_path || '',
        cluster_id: t.existing_cluster_id || '',
        depends_on: (t.depends_on || []).map((d: any) => d.task_key).join(','),
      })) || [{ task_key: 'main', notebook_path: '', cluster_id: '', depends_on: '' }]);
      // load runs
      const rr = await fetch(`/api/items/databricks-job/${id}/runs?jobId=${jid}`);
      const rj = await rr.json();
      if (rj.ok) setRuns(rj.runs || []);
      // Selecting a job hydrates state from the server — clean by definition.
      setDirty(false);
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    }
  }, [id]);

  const buildSpec = useCallback(() => {
    const spec: any = {
      name: name || 'untitled-job',
      tasks: tasks.filter((t) => t.task_key && t.notebook_path && t.cluster_id).map((t) => ({
        task_key: t.task_key,
        existing_cluster_id: t.cluster_id,
        notebook_task: { notebook_path: t.notebook_path },
        ...(t.depends_on
          ? { depends_on: t.depends_on.split(',').map((s) => ({ task_key: s.trim() })).filter((d) => d.task_key) }
          : {}),
      })),
      max_concurrent_runs: 1,
    };
    if (scheduled && cron) {
      spec.schedule = { quartz_cron_expression: cron, timezone_id: tz, pause_status: 'UNPAUSED' };
    }
    return spec;
  }, [name, tasks, scheduled, cron, tz]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    // Phase 4.5 — build the spec from the freshest committed state via
    // buildSpec() before the await; if the user keeps typing during the
    // request, the dirty flag will stay true after a clean origSpec is
    // captured, prompting them to save again.
    const spec = buildSpec();
    try {
      if (jobId === null) {
        const r = await fetch('/api/items/databricks-job', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec }),
        });
        const j = await r.json();
        if (!j.ok) { setSaveError(j.error || `HTTP ${r.status}`); return; }
        setJobId(j.job_id);
        setSaveMessage(`Created job ${j.job_id} at ${new Date().toLocaleTimeString()}`);
        await loadJobs();
        setDirty(false);
      } else {
        const r = await fetch(`/api/items/databricks-job/${id}?jobId=${jobId}`, {
          method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec }),
        });
        const j = await r.json();
        if (!j.ok) { setSaveError(j.error || `HTTP ${r.status}`); return; }
        setSaveMessage(`Saved job ${jobId} at ${new Date().toLocaleTimeString()}`);
        setDirty(false);
      }
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [id, jobId, buildSpec, loadJobs]);

  const del = useCallback(async () => {
    if (jobId === null) return;
    if (!window.confirm(`Delete job ${jobId}?`)) return;
    await fetch(`/api/items/databricks-job/${id}?jobId=${jobId}`, { method: 'DELETE' });
    setJobId(null);
    setName('');
    setTasks([{ task_key: 'main', notebook_path: '', cluster_id: '', depends_on: '' }]);
    await loadJobs();
  }, [id, jobId, loadJobs]);

  const runNow = useCallback(async () => {
    if (jobId === null) return;
    setRunning(true);
    setRunError(null);
    try {
      const r = await fetch(`/api/items/databricks-job/${id}/run?jobId=${jobId}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) setRunError(j.error || `HTTP ${r.status}`);
      else {
        // refresh runs
        const rr = await fetch(`/api/items/databricks-job/${id}/runs?jobId=${jobId}`);
        const rj = await rr.json();
        if (rj.ok) setRuns(rj.runs || []);
      }
    } catch (e: any) {
      setRunError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  }, [id, jobId]);

  // Ctrl/Cmd+S to save the job spec when there are unsaved edits OR the
  // form is a brand-new job (jobId === null) the user is composing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!saving && (dirty || jobId === null)) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, dirty, jobId, save]);

  const viewRuns = useCallback(async () => {
    if (jobId === null) return;
    const rr = await fetch(`/api/items/databricks-job/${id}/runs?jobId=${jobId}`);
    const rj = await rr.json();
    if (rj.ok) setRuns(rj.runs || []);
  }, [id, jobId]);
  const canSaveJob = !saving && (dirty || jobId === null);
  const canRunNow = jobId !== null && !running;
  const canDeleteJob = jobId !== null;
  const ribbonJob: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Job', actions: [
        { label: saving ? 'Saving…' : jobId === null ? 'Create' : 'Save', onClick: canSaveJob ? save : undefined, disabled: !canSaveJob },
        { label: 'Delete', onClick: canDeleteJob ? del : undefined, disabled: !canDeleteJob },
      ]},
      { label: 'Run', actions: [
        { label: running ? 'Submitting…' : 'Run now', onClick: canRunNow ? runNow : undefined, disabled: !canRunNow },
        { label: 'View runs', onClick: jobId !== null ? viewRuns : undefined, disabled: jobId === null },
      ]},
    ]},
  ], [saving, jobId, canSaveJob, save, canDeleteJob, del, running, canRunNow, runNow, viewRuns]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbonJob}
      leftPanel={
        <div className={s.treePad}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <Subtitle2 style={{ flex: 1 }}>Jobs ({jobs.length})</Subtitle2>
            <Button size="small" icon={<Add20Regular />} onClick={() => {
              setJobId(null); setName(''); setSaveMessage(null); setSaveError(null);
              setTasks([{ task_key: 'main', notebook_path: '', cluster_id: '', depends_on: '' }]);
              setRuns([]);
              // Fresh blank form = no edits yet (Ctrl+S still works because
              // the keybinding accepts jobId === null as "creating").
              setDirty(false);
            }} />
            <Button size="small" icon={<ArrowSync20Regular />} onClick={loadJobs} />
          </div>
          {listError && (
            <MessageBar intent="error"><MessageBarBody>{listError}</MessageBarBody></MessageBar>
          )}
          {jobs.map((j) => (
            <div
              key={j.job_id}
              onClick={() => selectJob(j.job_id)}
              style={{
                padding: 6, cursor: 'pointer', borderRadius: 3,
                background: jobId === j.job_id ? tokens.colorNeutralBackground2Selected : undefined,
              }}
            >
              <Body1>{j.settings?.name || `job-${j.job_id}`}</Body1>
              <Caption1>id={j.job_id} · {j.settings?.tasks?.length || 0} task(s)</Caption1>
            </div>
          ))}
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            {dirty && jobId !== null && <Badge appearance="outline" color="warning">unsaved</Badge>}
            <Button
              appearance="primary"
              icon={<Save20Regular />}
              disabled={saving || (jobId !== null && !dirty)}
              onClick={save}
            >
              {saving ? 'Saving…' : jobId === null ? 'Create' : dirty ? 'Save *' : 'Save'}
            </Button>
            {jobId !== null && (
              <Button appearance="outline" icon={<Play20Regular />} disabled={running} onClick={runNow}>
                {running ? 'Submitting…' : 'Run now'}
              </Button>
            )}
            {jobId !== null && (
              <Button appearance="outline" icon={<Delete20Regular />} onClick={del}>Delete</Button>
            )}
          </div>
          {saveError && (
            <MessageBar intent="error"><MessageBarBody>
              <MessageBarTitle>Job save failed</MessageBarTitle>{saveError}
            </MessageBarBody></MessageBar>
          )}
          {runError && (
            <MessageBar intent="error"><MessageBarBody>
              <MessageBarTitle>Run failed</MessageBarTitle>{runError}
            </MessageBarBody></MessageBar>
          )}
          {saveMessage && (
            <MessageBar intent="success"><MessageBarBody>{saveMessage}</MessageBarBody></MessageBar>
          )}

          <Field label="Display name">
            <Input value={name} onChange={(_, d) => { setName(d.value); setDirty(true); }} />
          </Field>

          <Subtitle2>Schedule</Subtitle2>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Switch checked={scheduled} onChange={(_, d) => { setScheduled(!!d.checked); setDirty(true); }} label="Scheduled" />
            <Field label="Quartz cron"><Input value={cron} onChange={(_, d) => { setCron(d.value); setDirty(true); }} disabled={!scheduled} /></Field>
            <Field label="Timezone"><Input value={tz} onChange={(_, d) => { setTz(d.value); setDirty(true); }} disabled={!scheduled} /></Field>
          </div>

          <Subtitle2 style={{ marginTop: 8 }}>Tasks</Subtitle2>
          <div className={s.tableWrap}>
            <Table size="small" aria-label="Tasks">
              <TableHeader><TableRow>
                <TableHeaderCell>task_key</TableHeaderCell>
                <TableHeaderCell>Notebook path</TableHeaderCell>
                <TableHeaderCell>Cluster</TableHeaderCell>
                <TableHeaderCell>depends_on (csv)</TableHeaderCell>
                <TableHeaderCell></TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {tasks.map((t, i) => (
                  <TableRow key={i}>
                    <TableCell><Input size="small" value={t.task_key}
                      onChange={(_, d) => { setTasks((arr) => arr.map((x, j) => j === i ? { ...x, task_key: d.value } : x)); setDirty(true); }} /></TableCell>
                    <TableCell><Input size="small" value={t.notebook_path}
                      onChange={(_, d) => { setTasks((arr) => arr.map((x, j) => j === i ? { ...x, notebook_path: d.value } : x)); setDirty(true); }} /></TableCell>
                    <TableCell>
                      <Dropdown size="small"
                        value={clusters.find((c) => c.cluster_id === t.cluster_id)?.cluster_name || t.cluster_id}
                        selectedOptions={t.cluster_id ? [t.cluster_id] : []}
                        onOptionSelect={(_, d) => { if (d.optionValue) { setTasks((arr) =>
                          arr.map((x, j) => j === i ? { ...x, cluster_id: d.optionValue! } : x)); setDirty(true); } }}
                      >
                        {clusters.map((c) => (
                          <Option key={c.cluster_id} value={c.cluster_id} text={c.cluster_name || c.cluster_id}>
                            {c.cluster_name || c.cluster_id}
                          </Option>
                        ))}
                      </Dropdown>
                    </TableCell>
                    <TableCell><Input size="small" value={t.depends_on}
                      onChange={(_, d) => { setTasks((arr) => arr.map((x, j) => j === i ? { ...x, depends_on: d.value } : x)); setDirty(true); }} /></TableCell>
                    <TableCell>
                      <Button size="small" icon={<Delete20Regular />}
                        onClick={() => { setTasks((arr) => arr.filter((_, j) => j !== i)); setDirty(true); }} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Button size="small" icon={<Add20Regular />} appearance="outline"
            onClick={() => { setTasks((arr) => [...arr, { task_key: `task_${arr.length + 1}`, notebook_path: '', cluster_id: '', depends_on: '' }]); setDirty(true); }}>
            Add task
          </Button>

          {jobId !== null && (
            <>
              <Subtitle2 style={{ marginTop: 12 }}>Run history</Subtitle2>
              <div className={s.tableWrap}>
                <Table size="small" aria-label="Run history">
                  <TableHeader><TableRow>
                    <TableHeaderCell>run_id</TableHeaderCell>
                    <TableHeaderCell>State</TableHeaderCell>
                    <TableHeaderCell>Start</TableHeaderCell>
                    <TableHeaderCell>Exec</TableHeaderCell>
                    <TableHeaderCell>Creator</TableHeaderCell>
                  </TableRow></TableHeader>
                  <TableBody>
                    {runs.length === 0 && (
                      <TableRow><TableCell colSpan={5}><Caption1>No runs yet.</Caption1></TableCell></TableRow>
                    )}
                    {runs.map((r) => (
                      <TableRow key={r.run_id}>
                        <TableCell>{r.run_id}</TableCell>
                        <TableCell>
                          <Badge appearance="outline" color={runStateColor(r.state?.result_state)}>
                            {r.state?.life_cycle_state || '—'}{r.state?.result_state ? ` · ${r.state.result_state}` : ''}
                          </Badge>
                        </TableCell>
                        <TableCell>{fmtTime(r.start_time)}</TableCell>
                        <TableCell>{fmtDuration(r.execution_duration)}</TableCell>
                        <TableCell>{r.creator_user_name || '—'}</TableCell>
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

// ============================================================
// Databricks Cluster editor
// ============================================================

interface ClusterEvent {
  timestamp?: number;
  type?: string;
  details?: { reason?: { code?: string }; cause?: string; user?: string; current_num_workers?: number };
}

export function DatabricksClusterEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();

  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [clusterId, setClusterId] = useState<string | null>(null);
  const [cluster, setCluster] = useState<Cluster | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [nodeType, setNodeType] = useState('');
  const [sparkVersion, setSparkVersion] = useState('');
  const [autoscale, setAutoscale] = useState(true);
  const [minWorkers, setMinWorkers] = useState(2);
  const [maxWorkers, setMaxWorkers] = useState(8);
  const [numWorkers, setNumWorkers] = useState(2);
  const [autoterm, setAutoterm] = useState(60);

  const [nodeTypes, setNodeTypes] = useState<{ node_type_id: string; description?: string }[]>([]);
  const [sparkVersions, setSparkVersions] = useState<{ key: string; name: string }[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [stateBusy, setStateBusy] = useState(false);
  const [stateError, setStateError] = useState<string | null>(null);

  const [events, setEvents] = useState<ClusterEvent[]>([]);
  const [libraries, setLibraries] = useState<ClusterLibrary[]>([]);
  const [librariesErr, setLibrariesErr] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'config' | 'libraries' | 'init' | 'events'>('config');

  const loadClusters = useCallback(async () => {
    try {
      const r = await fetch('/api/items/databricks-cluster');
      const j = await r.json();
      if (!j.ok) { setListError(j.error || `HTTP ${r.status}`); return; }
      setClusters(j.clusters || []);
    } catch (e: any) { setListError(e?.message || String(e)); }
  }, []);

  useEffect(() => {
    void loadClusters();
    void (async () => {
      const r = await fetch('/api/items/databricks-cluster/options');
      const j = await r.json();
      if (j.ok) {
        setNodeTypes(j.nodeTypes || []);
        setSparkVersions(j.sparkVersions || []);
        if (!nodeType && j.nodeTypes?.[0]) setNodeType(j.nodeTypes[0].node_type_id);
        if (!sparkVersion && j.sparkVersions?.[0]) setSparkVersion(j.sparkVersions[0].key);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectCluster = useCallback(async (cid: string) => {
    setClusterId(cid);
    setSaveError(null);
    setStateError(null);
    setSaveMessage(null);
    try {
      const r = await fetch(`/api/items/databricks-cluster/${id}?clusterId=${encodeURIComponent(cid)}`);
      const j = await r.json();
      if (!j.ok) { setSaveError(j.error || `HTTP ${r.status}`); return; }
      const c = j.cluster as Cluster;
      setCluster(c);
      setName(c.cluster_name || '');
      setNodeType(c.node_type_id || '');
      setSparkVersion(c.spark_version || '');
      if (c.autoscale) {
        setAutoscale(true);
        setMinWorkers(c.autoscale.min_workers || 2);
        setMaxWorkers(c.autoscale.max_workers || 8);
      } else {
        setAutoscale(false);
        setNumWorkers(c.num_workers || 2);
      }
      setAutoterm(c.autotermination_minutes ?? 60);
      // events
      const er = await fetch(`/api/items/databricks-cluster/${id}/events?clusterId=${encodeURIComponent(cid)}&limit=50`);
      const ej = await er.json();
      if (ej.ok) setEvents(ej.events || []);
      // v3.4 — libraries (read-only). Renders in the Libraries tab.
      setLibrariesErr(null);
      try {
        const lr = await fetch(`/api/items/databricks-cluster/${id}/libraries?clusterId=${encodeURIComponent(cid)}`);
        const lj = await lr.json();
        if (lj.ok) setLibraries(lj.libraries || []);
        else { setLibraries([]); setLibrariesErr(lj.error || `HTTP ${lr.status}`); }
      } catch (le: any) { setLibrariesErr(le?.message || String(le)); }
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    }
  }, [id]);

  const buildSpec = useCallback(() => {
    const spec: any = {
      cluster_name: name || 'untitled-cluster',
      spark_version: sparkVersion,
      node_type_id: nodeType,
      autotermination_minutes: autoterm,
    };
    if (autoscale) spec.autoscale = { min_workers: minWorkers, max_workers: maxWorkers };
    else spec.num_workers = numWorkers;
    return spec;
  }, [name, sparkVersion, nodeType, autoscale, minWorkers, maxWorkers, numWorkers, autoterm]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    // Phase 4.5 — call buildSpec before the await so any in-flight typing
    // during the request lands in the next save, not silently dropped.
    const spec = buildSpec();
    try {
      if (!clusterId) {
        const r = await fetch('/api/items/databricks-cluster', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec }),
        });
        // Defensive parse — if the Container App / WAF returns HTML,
        // surface a useful message instead of throwing 'Unexpected
        // token <'.
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json().catch(() => null) : null;
        if (!j || !j.ok) {
          const rawErr = j?.error || (await r.text().catch(() => ''))?.slice(0, 240) || `HTTP ${r.status}`;
          // Specifically remediate the SCIM-entitlement gap. The cluster
          // editor's most common 403 is the Console UAMI lacking the
          // allow-cluster-create entitlement (see
          // platform/fiab/bicep/modules/landing-zone/databricks-scim-bootstrap.bicep
          // and docs/fiab/runbooks/databricks-cluster-create-permission.md).
          const looksLikePermDenied =
            /PERMISSION_DENIED/.test(rawErr) ||
            /not authorized to create clusters/i.test(rawErr) ||
            /allow-cluster-create/i.test(rawErr) ||
            r.status === 403;
          if (looksLikePermDenied) {
            setSaveError(
              "Databricks denied the create-cluster call (PERMISSION_DENIED). " +
              "The Loom Console UAMI was registered in the workspace without the " +
              "`allow-cluster-create` entitlement. Fix: re-run the SCIM bootstrap " +
              "deploymentScript via `azd up` (idempotent, takes ~2 min) — it now " +
              "PATCHes existing service principals with the full entitlement set " +
              "(workspace-access, databricks-sql-access, allow-cluster-create, " +
              "allow-instance-pool-create). Runbook: docs/fiab/runbooks/" +
              "databricks-cluster-create-permission.md"
            );
          } else {
            setSaveError(rawErr);
          }
          return;
        }
        setSaveMessage(`Created cluster ${j.cluster_id} at ${new Date().toLocaleTimeString()}`);
        await loadClusters();
        setClusterId(j.cluster_id);
        await selectCluster(j.cluster_id);
      } else {
        // edit not exposed at top-level path; surface info
        setSaveMessage('Cluster edit via REST is not yet wired in this editor — recreate to change spec.');
      }
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [clusterId, buildSpec, loadClusters, selectCluster]);

  const doState = useCallback(async (action: 'start' | 'stop' | 'restart') => {
    if (!clusterId) return;
    setStateBusy(true);
    setStateError(null);
    try {
      const r = await fetch(`/api/items/databricks-cluster/${id}/state?clusterId=${encodeURIComponent(clusterId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!j.ok) setStateError(j.error || `HTTP ${r.status}`);
      else {
        // refresh
        await selectCluster(clusterId);
        await loadClusters();
      }
    } catch (e: any) { setStateError(e?.message || String(e)); }
    finally { setStateBusy(false); }
  }, [id, clusterId, selectCluster, loadClusters]);

  const del = useCallback(async () => {
    if (!clusterId) return;
    if (!window.confirm(`Permanently delete cluster ${clusterId}?`)) return;
    await fetch(`/api/items/databricks-cluster/${id}?clusterId=${encodeURIComponent(clusterId)}&permanent=true`, { method: 'DELETE' });
    setClusterId(null);
    setCluster(null);
    await loadClusters();
  }, [id, clusterId, loadClusters]);

  // Ctrl/Cmd+S to save when not already busy. Only meaningful for the
  // create flow (clusterId === null); edit-after-create is gated by the
  // Databricks REST surface, but matching the family-wide muscle memory.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!saving && !clusterId) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saving, clusterId, save]);

  const state = cluster?.state || (clusterId ? 'UNKNOWN' : 'NEW');

  const canStartCluster = !!clusterId && !stateBusy && state !== 'RUNNING' && state !== 'PENDING';
  const canStopCluster = !!clusterId && !stateBusy && state !== 'TERMINATED' && state !== 'TERMINATING';
  const canRestartCluster = !!clusterId && !stateBusy && state === 'RUNNING';
  const ribbonCluster: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Cluster', actions: [
        { label: saving ? 'Saving…' : clusterId ? 'Save' : 'Create', onClick: saving ? undefined : save, disabled: saving },
        { label: 'Delete', onClick: clusterId ? del : undefined, disabled: !clusterId },
      ]},
      { label: 'State', actions: [
        { label: 'Start', onClick: canStartCluster ? () => doState('start') : undefined, disabled: !canStartCluster },
        { label: 'Stop', onClick: canStopCluster ? () => doState('stop') : undefined, disabled: !canStopCluster },
        { label: 'Restart', onClick: canRestartCluster ? () => doState('restart') : undefined, disabled: !canRestartCluster },
      ]},
    ]},
  ], [saving, clusterId, save, del, canStartCluster, canStopCluster, canRestartCluster, doState]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbonCluster}
      leftPanel={
        <div className={s.treePad}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <Subtitle2 style={{ flex: 1 }}>Clusters ({clusters.length})</Subtitle2>
            <Button size="small" icon={<Add20Regular />} onClick={() => {
              setClusterId(null); setCluster(null); setName(''); setEvents([]);
              setSaveMessage(null); setSaveError(null);
            }} />
            <Button size="small" icon={<ArrowSync20Regular />} onClick={loadClusters} />
          </div>
          {listError && (
            <MessageBar intent="error"><MessageBarBody>{listError}</MessageBarBody></MessageBar>
          )}
          {clusters.map((c) => (
            <div
              key={c.cluster_id}
              onClick={() => selectCluster(c.cluster_id)}
              style={{
                padding: 6, cursor: 'pointer', borderRadius: 3,
                background: clusterId === c.cluster_id ? tokens.colorNeutralBackground2Selected : undefined,
              }}
            >
              <Body1>{c.cluster_name || c.cluster_id}</Body1>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Badge appearance="filled" color={clusterStateColor(c.state)} size="small">{c.state || '?'}</Badge>
                <Caption1>{c.node_type_id || '—'}</Caption1>
              </div>
            </div>
          ))}
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color={clusterStateColor(state)}>{state}</Badge>
            {cluster?.state_message && <Caption1>{cluster.state_message}</Caption1>}
            <Button appearance="primary" icon={<Save20Regular />} disabled={saving} onClick={save}>
              {saving ? 'Saving…' : clusterId ? 'Save (recreate to change spec)' : 'Create'}
            </Button>
            {clusterId && (
              <>
                <Button appearance="outline" icon={<Play20Regular />}
                  disabled={stateBusy || state === 'RUNNING' || state === 'PENDING'}
                  onClick={() => doState('start')}>Start</Button>
                <Button appearance="outline" icon={<Stop20Regular />}
                  disabled={stateBusy || state === 'TERMINATED' || state === 'TERMINATING'}
                  onClick={() => doState('stop')}>Stop</Button>
                <Button appearance="outline" icon={<ArrowSync20Regular />}
                  disabled={stateBusy || state !== 'RUNNING'}
                  onClick={() => doState('restart')}>Restart</Button>
                <Button appearance="outline" icon={<Delete20Regular />} onClick={del}>Delete</Button>
              </>
            )}
          </div>

          {saveError && <MessageBar intent="error"><MessageBarBody>
            <MessageBarTitle>Save failed</MessageBarTitle>{saveError}
          </MessageBarBody></MessageBar>}
          {stateError && <MessageBar intent="error"><MessageBarBody>
            <MessageBarTitle>State change failed</MessageBarTitle>{stateError}
          </MessageBarBody></MessageBar>}
          {saveMessage && <MessageBar intent="success"><MessageBarBody>{saveMessage}</MessageBarBody></MessageBar>}

          <Field label="Cluster name">
            <Input value={name} onChange={(_, d) => setName(d.value)} disabled={!!clusterId} />
          </Field>
          <div style={{ display: 'flex', gap: 12 }}>
            <Field label="Node type" style={{ flex: 1 }}>
              <Dropdown
                value={nodeType}
                selectedOptions={nodeType ? [nodeType] : []}
                onOptionSelect={(_, d) => d.optionValue && setNodeType(d.optionValue)}
                disabled={!!clusterId}
              >
                {nodeTypes.slice(0, 80).map((n) => (
                  <Option key={n.node_type_id} value={n.node_type_id} text={n.node_type_id}>
                    {n.node_type_id}{n.description ? ` · ${n.description}` : ''}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label="Spark version" style={{ flex: 1 }}>
              <Dropdown
                value={sparkVersions.find((v) => v.key === sparkVersion)?.name || sparkVersion}
                selectedOptions={sparkVersion ? [sparkVersion] : []}
                onOptionSelect={(_, d) => d.optionValue && setSparkVersion(d.optionValue)}
                disabled={!!clusterId}
              >
                {sparkVersions.slice(0, 80).map((v) => (
                  <Option key={v.key} value={v.key} text={v.name}>{v.name}</Option>
                ))}
              </Dropdown>
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
            <Switch checked={autoscale} onChange={(_, d) => setAutoscale(!!d.checked)} label="Autoscale" disabled={!!clusterId} />
            {autoscale ? (
              <>
                <Field label="Min workers">
                  <Input type="number" value={String(minWorkers)} disabled={!!clusterId}
                    onChange={(_, d) => setMinWorkers(Number(d.value) || 1)} />
                </Field>
                <Field label="Max workers">
                  <Input type="number" value={String(maxWorkers)} disabled={!!clusterId}
                    onChange={(_, d) => setMaxWorkers(Number(d.value) || 1)} />
                </Field>
              </>
            ) : (
              <Field label="Workers">
                <Input type="number" value={String(numWorkers)} disabled={!!clusterId}
                  onChange={(_, d) => setNumWorkers(Number(d.value) || 1)} />
              </Field>
            )}
            <Field label="Autotermination (min)">
              <Input type="number" value={String(autoterm)} disabled={!!clusterId}
                onChange={(_, d) => setAutoterm(Number(d.value) || 0)} />
            </Field>
          </div>

          {clusterId && (
            <>
              <div style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, marginTop: 12 }}>
                <TabList selectedValue={detailTab} onTabSelect={(_, d) => setDetailTab(d.value as 'config' | 'libraries' | 'init' | 'events')}>
                  <Tab value="config">Spark config ({Object.keys(cluster?.spark_conf || {}).length})</Tab>
                  <Tab value="libraries">Libraries ({libraries.length})</Tab>
                  <Tab value="init">Init scripts ({(cluster?.init_scripts || []).length})</Tab>
                  <Tab value="events">Events ({events.length})</Tab>
                </TabList>
              </div>

              {detailTab === 'config' && (
                <>
                  {!cluster?.spark_conf || Object.keys(cluster.spark_conf).length === 0 ? (
                    <MessageBar intent="info"><MessageBarBody>No custom <code>spark_conf</code> keys on this cluster. Spark uses Databricks defaults.</MessageBarBody></MessageBar>
                  ) : (
                    <div className={s.tableWrap}>
                      <Table size="small" aria-label="Spark config">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Key</TableHeaderCell>
                          <TableHeaderCell>Value</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {Object.entries(cluster.spark_conf).map(([k, v]) => (
                            <TableRow key={k}>
                              <TableCell><code style={{ fontSize: 12 }}>{k}</code></TableCell>
                              <TableCell style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}>{v}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </>
              )}

              {detailTab === 'libraries' && (
                <>
                  {librariesErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Library list failed</MessageBarTitle>{librariesErr}</MessageBarBody></MessageBar>}
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <MessageBarTitle>Read-only library status</MessageBarTitle>
                      Install + uninstall is performed in the Databricks workspace UI — each non-public source
                      (private PyPI, ADO artifact feeds, JARs in protected blob containers) needs its own
                      credential dance. The Loom editor surfaces the per-library install state via
                      <code> /api/2.0/libraries/cluster-status</code>.
                    </MessageBarBody>
                  </MessageBar>
                  {libraries.length === 0 ? (
                    <Caption1>No libraries attached.</Caption1>
                  ) : (
                    <div className={s.tableWrap}>
                      <Table size="small" aria-label="Cluster libraries">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Type</TableHeaderCell>
                          <TableHeaderCell>Coordinates / package</TableHeaderCell>
                          <TableHeaderCell>Status</TableHeaderCell>
                          <TableHeaderCell>Messages</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {libraries.map((lib, i) => {
                            const l = lib.library || {};
                            const t = l.pypi ? 'pypi' : l.maven ? 'maven' : l.cran ? 'cran' : l.jar ? 'jar' : l.whl ? 'whl' : l.egg ? 'egg' : l.requirements ? 'requirements' : '?';
                            const coords = l.pypi?.package || l.maven?.coordinates || l.cran?.package || l.jar || l.whl || l.egg || l.requirements || '—';
                            return (
                              <TableRow key={i}>
                                <TableCell><Badge appearance="outline">{t}</Badge></TableCell>
                                <TableCell><code style={{ fontSize: 12 }}>{coords}</code></TableCell>
                                <TableCell><Badge appearance="filled" color={lib.status === 'INSTALLED' ? 'success' : lib.status === 'FAILED' ? 'danger' : 'warning'}>{lib.status || '—'}</Badge></TableCell>
                                <TableCell style={{ fontSize: 11 }}>{(lib.messages || []).join('; ') || '—'}</TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </>
              )}

              {detailTab === 'init' && (
                <>
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <MessageBarTitle>Read-only init script list</MessageBarTitle>
                      Init scripts run on every node when the cluster starts. Edit + reorder in the Databricks
                      workspace UI (Compute → cluster → Advanced options → Init scripts) — Loom surfaces the
                      configured list from <code>/api/2.0/clusters/get</code>.
                    </MessageBarBody>
                  </MessageBar>
                  {(cluster?.init_scripts || []).length === 0 ? (
                    <Caption1>No init scripts configured.</Caption1>
                  ) : (
                    <div className={s.tableWrap}>
                      <Table size="small" aria-label="Init scripts">
                        <TableHeader><TableRow>
                          <TableHeaderCell>Source</TableHeaderCell>
                          <TableHeaderCell>Destination</TableHeaderCell>
                        </TableRow></TableHeader>
                        <TableBody>
                          {(cluster?.init_scripts || []).map((script, i) => {
                            const src = script.workspace ? 'workspace' : script.volumes ? 'volumes' : script.dbfs ? 'dbfs' : script.abfss ? 'abfss' : script.s3 ? 's3' : script.gcs ? 'gcs' : script.file ? 'file' : '?';
                            const dest = script.workspace?.destination || script.volumes?.destination || script.dbfs?.destination || script.abfss?.destination || script.s3?.destination || script.gcs?.destination || script.file?.destination || '—';
                            return (
                              <TableRow key={i}>
                                <TableCell><Badge appearance="outline">{src}</Badge></TableCell>
                                <TableCell><code style={{ fontSize: 12 }}>{dest}</code></TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </>
              )}

              {detailTab === 'events' && (
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Cluster events">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Time</TableHeaderCell>
                      <TableHeaderCell>Type</TableHeaderCell>
                      <TableHeaderCell>Reason / cause</TableHeaderCell>
                      <TableHeaderCell>Workers</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {events.length === 0 && (
                        <TableRow><TableCell colSpan={4}><Caption1>No events.</Caption1></TableCell></TableRow>
                      )}
                      {events.map((e, i) => (
                        <TableRow key={i}>
                          <TableCell>{fmtTime(e.timestamp)}</TableCell>
                          <TableCell><Badge appearance="outline">{e.type || '—'}</Badge></TableCell>
                          <TableCell>{(e.details as any)?.reason?.code || (e.details as any)?.cause || '—'}</TableCell>
                          <TableCell>{(e.details as any)?.current_num_workers ?? '—'}</TableCell>
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
