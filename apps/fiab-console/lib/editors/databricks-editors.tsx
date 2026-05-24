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
  Tree, TreeItem, TreeItemLayout,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular, Stop20Regular,
  ArrowSync20Regular, Folder20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

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

const DBX_SQLW_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Query', actions: [{ label: 'New SQL query' }, { label: 'Run' }, { label: 'Query history' }] },
    { label: 'Warehouse', actions: [{ label: 'Start' }, { label: 'Stop' }, { label: 'Refresh' }] },
  ]},
];

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

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={DBX_SQLW_RIBBON}
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
          <textarea
            className={s.editor}
            spellCheck={false}
            value={sqlText}
            onChange={(e) => setSqlText(e.target.value)}
            aria-label="Databricks SQL editor"
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
        </div>
      }
    />
  );
}
