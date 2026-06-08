'use client';

/**
 * Synapse Dedicated + Serverless SQL editors — fully wired against the
 * Loom-deployed Synapse workspace via Container App MI + private endpoint
 * to *.sql.azuresynapse.net.
 *
 * Dedicated path:  ARM REST pause/resume + TDS query on workspace.sql.azuresynapse.net
 * Serverless path: TDS query on workspace-ondemand.sql.azuresynapse.net (no provisioning)
 *
 * No mock data, no stub responses. If the BFF returns an error we surface it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Spinner, Tooltip,
  Tab, TabList,
  Tree, TreeItem, TreeItemLayout,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Field, Input, Dropdown, Option, Switch,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular, Pause20Regular,
  ArrowSync20Regular, Folder20Regular, Lightbulb20Regular, ArrowDownload20Regular,
  Flowchart20Regular,
  DataBarVertical20Regular,
  TableAdd20Regular,
  Eye20Regular, Form20Regular, MathFormula20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { WarehouseMonitoringTab } from './components/warehouse-monitoring';
import { ConnectionDetailsPanel } from './components/connection-details';
import { ModelViewPanel } from './components/model-view-canvas';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { VisualQueryCanvas, type VqSourceTable } from './components/visual-query-canvas';
import { ComputePicker } from '@/lib/components/compute-picker';
import { SqlSecurityPanel } from '@/lib/panes/sql-security-panel';
import { SqlAccessModeSection } from '@/lib/panes/sql-access-mode-section';
import { QueryParamsBar, substituteSynapse, type QueryParam } from './components/query-params';
import { ResultVisualize } from './components/result-visualize';
import { SqlObjectScriptMenu, SqlRowCountBadge } from '@/lib/components/sql-object-script-menu';
import { sqlRowCount, loadSqlScript } from './sql-explorer-helpers';
import type { ScriptObjectType, ScriptMode } from '@/lib/azure/sql-object-scripting';
import { downloadBlob, resultsToCsv, resultsToJson } from './components/result-export';

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
  resultMeta: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' },
  resultActions: { marginLeft: 'auto', display: 'flex', gap: 4 },
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
  sqlNumber?: number;
}

// A row from sys.dm_pdw_exec_requests (Dedicated) / sys.dm_exec_requests
// (Serverless), shaped by the /query-history BFF route.
interface DmvEntry {
  request_id: string;
  status: string;
  query_text?: string;
  submit_time?: string;
  start_time?: string;
  end_time?: string;
  total_elapsed_time_ms?: number;
  resource_class?: string;
  label?: string;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ── Results export (CSV / JSON / Open-in-Excel) — serializers + blob
// download live in ./components/result-export (shared with Databricks +
// Warehouse). Open-in-Excel routes through the per-engine /iqy BFF route.
function ResultsPanel({
  result, loading, onOpenExcel,
}: {
  result: QueryResponse | null;
  loading: boolean;
  onOpenExcel?: () => void | Promise<void>;
}) {
  const s = useStyles();
  const [showViz, setShowViz] = useState(false);
  if (loading) {
    return (
      <div className={s.resultBox}>
        <Spinner size="small" label="Executing T-SQL…" labelPosition="after" />
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
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return (
    <div className={s.resultBox}>
      <div className={s.resultMeta}>
        <Badge appearance="filled" color="success">{result.rowCount ?? rows.length} rows</Badge>
        <Caption1>· {result.executionMs} ms</Caption1>
        {result.truncated && <Badge appearance="outline" color="warning">truncated at 5,000</Badge>}
        {rows.length > 0 && (
          <div className={s.resultActions}>
            <Tooltip content={showViz ? 'Hide chart' : 'Visualize results as a chart'} relationship="label">
              <Button size="small" appearance={showViz ? 'primary' : 'subtle'} icon={<DataBarVertical20Regular />}
                onClick={() => setShowViz((v) => !v)}>{showViz ? 'Hide chart' : 'Visualize'}</Button>
            </Tooltip>
            <Tooltip content="Download results as CSV" relationship="label">
              <Button size="small" appearance="subtle" icon={<ArrowDownload20Regular />}
                onClick={() => downloadBlob(`query-results-${stamp}.csv`, 'text/csv', resultsToCsv(columns, rows))}>CSV</Button>
            </Tooltip>
            <Tooltip content="Download results as JSON" relationship="label">
              <Button size="small" appearance="subtle" icon={<ArrowDownload20Regular />}
                onClick={() => downloadBlob(`query-results-${stamp}.json`, 'application/json', resultsToJson(columns, rows))}>JSON</Button>
            </Tooltip>
            {onOpenExcel && (
              <Tooltip content="Open in Excel (web query — refresh re-runs against the live endpoint)" relationship="label">
                <Button size="small" appearance="subtle" icon={<ArrowDownload20Regular />}
                  onClick={() => void onOpenExcel()}>Excel</Button>
              </Tooltip>
            )}
          </div>
        )}
      </div>
      {showViz && rows.length > 0 && <ResultVisualize columns={columns} rows={rows} />}
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

// ============================================================
// Serverless
// ============================================================

interface ServerlessSchema {
  ok: boolean;
  workspace?: string;
  endpoint?: string;
  databases?: string[];
  lake?: { bronze: string; silver: string; gold: string; landing: string };
  samples?: { title: string; sql: string }[];
}

export function SynapseServerlessSqlPoolEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [sqlText, setSqlText] = useState<string>(
    `-- Synapse Serverless SQL — runs against the Loom workspace endpoint.\nSELECT 1 AS smoke, SYSDATETIMEOFFSET() AS server_time, SUSER_NAME() AS upn;`,
  );
  const [database, setDatabase] = useState('master');
  const [schema, setSchema] = useState<ServerlessSchema | null>(null);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  // Query parameters auto-detected from {{name}} tokens in the editor.
  const [queryParams, setQueryParams] = useState<QueryParam[]>([]);
  // v3.29: surface the shared ComputePicker so the Serverless surface shows
  // the same family-wide compute-target dropdown its sibling Dedicated +
  // Spark editors use. Serverless is always-on so we hide lifecycle controls
  // (start/stop) — the picker is read-only for the serverless kind today,
  // matching the existing ComputePicker semantics.
  const [computeId, setComputeId] = useState('');
  // SQL granular security (F11) — GRANT / column-GRANT / DDM wizards (Entra-only
  // TDS). RLS is gated off for Serverless by the panel (not supported there).
  const [secOpen, setSecOpen] = useState(false);
  // Visual (no-code) query canvas — Power-Query diagram-view parity.
  const [vqOpen, setVqOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/items/synapse-serverless-sql-pool/${id}/schema`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setSchema(j); })
      .catch(() => { if (!cancelled) setSchema({ ok: false }); });
    return () => { cancelled = true; };
  }, [id]);

  const run = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      // Rewrite {{name}} → @name; values bound via req.input() — injection-safe.
      const statement = substituteSynapse(sqlText, queryParams);
      const res = await fetch(`/api/items/synapse-serverless-sql-pool/${id}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: statement, database, parameters: queryParams }),
      });
      const json = (await res.json()) as QueryResponse;
      setResult(json);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setLoading(false);
    }
  }, [id, sqlText, database, queryParams]);

  // Open-in-Excel — download a .iqy web-query for the current SQL + database.
  // Excel refreshes by POSTing back to the serverless /query route (real TDS).
  const openInExcel = useCallback(async () => {
    if (!sqlText.trim()) return;
    try {
      const r = await fetch(`/api/items/synapse-serverless-sql-pool/${id}/iqy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sqlText, database }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `loom-synapse-serverless-${id}.iqy`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    }
  }, [id, sqlText, database]);

  // Ctrl+S / Cmd+S → Run (SSMS / Azure Data Studio muscle memory). T-SQL text
  // is ephemeral query state, so the surfaced save action is Run.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!loading) run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loading, run]);

  // Ribbon — every action is wired. Query actions run through the wired /query
  // TDS path; the catalog actions load real DMV / OPENROWSET T-SQL into the
  // editor so the user can execute them immediately (per ui-parity.md — no
  // disabled "deferred" buttons).
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Query', actions: [
        { label: 'New SQL query', onClick: () => { setSqlText(''); setResult(null); } },
        { label: 'New visual query', onClick: () => setVqOpen(true), title: 'Build a query visually (Power Query diagram view) — no SQL required' },
        { label: loading ? 'Running…' : 'Run', onClick: !loading ? run : undefined, disabled: loading },
        { label: 'Open in Excel', onClick: sqlText.trim() && !loading ? openInExcel : undefined, disabled: !sqlText.trim() || loading, title: !sqlText.trim() ? 'Enter a query first' : 'Download a .iqy web-query — refresh in Excel to re-execute against the live endpoint' },
        // Loads a real sys.external_tables / OPENROWSET template; Run executes
        // it via the wired serverless /query path.
        { label: 'External tables', onClick: () => setSqlText(
          `-- External tables on Serverless SQL (OPENROWSET over ADLS).\n`
          + `-- List existing external tables, data sources and file formats:\n`
          + `SELECT s.name AS [schema], t.name AS external_table, ds.location AS data_source\n`
          + `FROM sys.external_tables t\n`
          + `JOIN sys.schemas s ON s.schema_id = t.schema_id\n`
          + `JOIN sys.external_data_sources ds ON ds.data_source_id = t.data_source_id;\n\n`
          + `-- Or query files directly without defining a table:\n`
          + `-- SELECT TOP 100 * FROM OPENROWSET(\n`
          + `--   BULK 'https://<account>.dfs.core.windows.net/<container>/<path>/*.parquet',\n`
          + `--   FORMAT = 'PARQUET') AS rows;`,
        ) },
      ]},
      { label: 'Cost', actions: [
        // Real DMV — bytes processed (current request / day / week / month).
        { label: 'Bytes processed', onClick: () => setSqlText(
          `-- Serverless bytes-processed cost telemetry.\n`
          + `SELECT type, data_processed_mb\n`
          + `FROM sys.dm_external_data_processed;`,
        ) },
        { label: 'Cost cap', onClick: () => setSqlText(
          `-- View / set the serverless cost-control (bytes) policy.\n`
          + `SELECT * FROM sys.configurations WHERE name LIKE '%cost%' OR name LIKE '%limit%';\n\n`
          + `-- Set a daily cap (workspace admin):\n`
          + `-- sp_set_data_processed_limit @type = N'daily', @limit_TB = 1;`,
        ) },
      ]},
      { label: 'Security', actions: [
        // Object/column GRANT + Dynamic Data Masking over the serverless
        // database (views). Real T-SQL via /sql-security (Entra-only TDS).
        { label: 'GRANT / masking', onClick: () => setSecOpen(true), title: 'Object/column GRANT and Dynamic Data Masking (RLS is not supported on Serverless)' },
      ]},
    ]},
  ], [loading, run, openInExcel, sqlText]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Tree aria-label="Serverless objects" defaultOpenItems={['databases', 'lake', 'samples']}>
            <TreeItem itemType="branch" value="databases">
              <TreeItemLayout iconBefore={<Database20Regular />}>Databases ({schema?.databases?.length ?? 0})</TreeItemLayout>
              <Tree>
                <TreeItem itemType="leaf" value="db-master" onClick={() => setDatabase('master')}>
                  <TreeItemLayout iconBefore={<Database20Regular />}>master {database === 'master' && '·'}</TreeItemLayout>
                </TreeItem>
                {(schema?.databases || []).map((d) => (
                  <TreeItem key={d} itemType="leaf" value={`db-${d}`} onClick={() => setDatabase(d)}>
                    <TreeItemLayout iconBefore={<Database20Regular />}>{d} {database === d && '·'}</TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
            <TreeItem itemType="branch" value="lake">
              <TreeItemLayout iconBefore={<Folder20Regular />}>Lake (OPENROWSET)</TreeItemLayout>
              <Tree>
                {schema?.lake && Object.entries(schema.lake).filter(([, v]) => v).map(([k, v]) => (
                  <TreeItem key={k} itemType="leaf" value={`lake-${k}`}>
                    <TreeItemLayout iconBefore={<DocumentTable20Regular />}>{k}</TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
            <TreeItem itemType="branch" value="samples">
              <TreeItemLayout iconBefore={<Lightbulb20Regular />}>Sample queries</TreeItemLayout>
              <Tree>
                {(schema?.samples || []).map((sm) => (
                  <TreeItem key={sm.title} itemType="leaf" value={`s-${sm.title}`} onClick={() => setSqlText(sm.sql)}>
                    <TreeItemLayout iconBefore={<Lightbulb20Regular />}>{sm.title}</TreeItemLayout>
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
            <Badge appearance="filled" color="brand">Serverless</Badge>
            <Badge appearance="outline" color={schema?.ok ? 'success' : 'severe'}>
              {schema?.endpoint || 'endpoint not configured'}
            </Badge>
            <Caption1>db: <strong>{database}</strong></Caption1>
            <Button appearance="primary" icon={<Play20Regular />} disabled={loading} onClick={run} style={{ marginLeft: 'auto' }}>
              Run
            </Button>
          </div>
          {/*
           * v3.29: shared ComputePicker for family consistency. Serverless is
           * always-on (no lifecycle), so we hide start/stop.
           */}
          <ComputePicker
            label="Serverless SQL endpoint"
            filter={['synapse-serverless-sql']}
            value={computeId}
            onChange={setComputeId}
            showLifecycle={false}
          />
          <SqlAccessModeSection itemId={id} itemType="synapse-serverless-sql-pool" />
          <MonacoTextarea
            value={sqlText}
            onChange={setSqlText}
            language="tsql"
            height={240}
            minHeight={200}
            ariaLabel="Serverless T-SQL editor"
          />
          <QueryParamsBar sql={sqlText} onChange={setQueryParams} showTypePicker={false} />
          <ResultsPanel result={result} loading={loading} onOpenExcel={sqlText.trim() ? openInExcel : undefined} />
          <Dialog open={secOpen} onOpenChange={(_, d) => setSecOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '980px', width: '94vw' }}>
              <DialogBody>
                <DialogTitle>SQL granular security — Serverless ({database})</DialogTitle>
                <DialogContent>
                  <SqlSecurityPanel itemType="synapse-serverless-sql-pool" itemId={id} database={database} />
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setSecOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
          <Dialog open={vqOpen} onOpenChange={(_, d) => setVqOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '1280px', width: '96vw' }}>
              <DialogBody>
                <DialogTitle>Visual query — Serverless ({database})</DialogTitle>
                <DialogContent>
                  <VisualQueryCanvas engine="synapse-serverless-sql-pool" id={id} dialect="tsql" database={database} sourceTables={[]} />
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setVqOpen(false)}>Close</Button>
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
// Dedicated
// ============================================================

interface PoolState {
  ok?: boolean;
  state: 'Online' | 'Paused' | 'Pausing' | 'Resuming' | 'Scaling' | 'Unknown';
  sku?: string;
  pool?: string;
  error?: string;
}

interface DedicatedSchema {
  ok: boolean;
  state?: string;
  sku?: string;
  pool?: string;
  message?: string;
  schemas?: Record<string, { table: string; rows: number }[]>;
  views?: { schema: string; name: string }[];
  procedures?: { schema: string; name: string }[];
  functions?: { schema: string; name: string; type: string }[];
  warnings?: string[];
}

function poolBadgeColor(state: string): 'success' | 'warning' | 'severe' | 'informative' {
  if (state === 'Online') return 'success';
  if (state === 'Resuming' || state === 'Pausing' || state === 'Scaling') return 'warning';
  if (state === 'Paused') return 'informative';
  return 'severe';
}

export function SynapseDedicatedSqlPoolEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [sqlText, setSqlText] = useState<string>(
    `-- Synapse Dedicated SQL pool — MPP T-SQL. Pool auto-pauses overnight; click Resume if Paused.\nSELECT 1 AS smoke, DB_NAME() AS db, SUSER_NAME() AS upn, SYSDATETIMEOFFSET() AS now_utc;`,
  );
  const [poolState, setPoolState] = useState<PoolState | null>(null);
  const [schema, setSchema] = useState<DedicatedSchema | null>(null);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [resuming, setResuming] = useState(false);
  // Query | Model — Loom-native Model view (relationships + measures), no Power BI.
  const [editorTab, setEditorTab] = useState<'query' | 'model' | 'monitoring'>('query');
  // Query parameters auto-detected from {{name}} tokens in the editor.
  const [queryParams, setQueryParams] = useState<QueryParam[]>([]);
  const pollRef = useRef<number | null>(null);
  // ComputePicker surfaces sibling Dedicated SQL pools so users can switch
  // between pools (multi-pool workspaces) and see lifecycle state at a
  // glance. The actual query still routes to the BFF's wired-in pool from
  // env — switching is read-only here for v2.x; v2.3 wires per-pool query.
  const [computeId, setComputeId] = useState('');
  // SQL granular security (F11) — GRANT / RLS / DDM wizards over TDS (Entra-only).
  const [secOpen, setSecOpen] = useState(false);
  // Connection details panel (server FQDN, JDBC URL, sqlcmd snippet).
  const [connOpen, setConnOpen] = useState(false);
  // Visual (no-code) query canvas — Power-Query diagram-view parity.
  const [vqOpen, setVqOpen] = useState(false);

  // Query history (DMV) — sys.dm_pdw_exec_requests, last 50 requests.
  const [qhOpen, setQhOpen] = useState(false);
  const [qhEntries, setQhEntries] = useState<DmvEntry[]>([]);
  const [qhBusy, setQhBusy] = useState(false);
  const [qhError, setQhError] = useState<string | null>(null);

  const loadQueryHistory = useCallback(async () => {
    setQhBusy(true); setQhError(null);
    try {
      const r = await fetch(`/api/items/synapse-dedicated-sql-pool/${id}/query-history`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setQhEntries((j.entries || []) as DmvEntry[]);
    } catch (e: any) { setQhError(e?.message || String(e)); }
    finally { setQhBusy(false); }
  }, [id]);

  const openQueryHistory = useCallback(() => {
    setQhOpen(true);
    void loadQueryHistory();
  }, [loadQueryHistory]);

  // ---- Save as table (CTAS) dialog — name/schema/distribution/index for MPP ----
  const [ctasOpen, setCtasOpen] = useState(false);
  const [ctasSchema, setCtasSchema] = useState('dbo');
  const [ctasName, setCtasName] = useState('');
  const [ctasDist, setCtasDist] = useState<'ROUND_ROBIN' | 'HASH' | 'REPLICATE'>('ROUND_ROBIN');
  const [ctasDistCol, setCtasDistCol] = useState('');
  const [ctasIndex, setCtasIndex] = useState<'CLUSTERED COLUMNSTORE INDEX' | 'HEAP' | 'CLUSTERED INDEX'>('CLUSTERED COLUMNSTORE INDEX');
  const [ctasIndexCol, setCtasIndexCol] = useState('');
  const [ctasBusy, setCtasBusy] = useState(false);
  const [ctasError, setCtasError] = useState<string | null>(null);
  const [ctasReceipt, setCtasReceipt] = useState<string | null>(null);

  // ---- Select into (full physical copy — no zero-copy clone on Dedicated) ----
  const [siOpen, setSiOpen] = useState(false);
  const [siSourceSchema, setSiSourceSchema] = useState('dbo');
  const [siSourceTable, setSiSourceTable] = useState('');
  const [siTargetSchema, setSiTargetSchema] = useState('dbo');
  const [siTargetTable, setSiTargetTable] = useState('');
  const [siBusy, setSiBusy] = useState(false);
  const [siError, setSiError] = useState<string | null>(null);
  const [siReceipt, setSiReceipt] = useState<string | null>(null);

  const refreshState = useCallback(async () => {
    const r = await fetch(`/api/items/synapse-dedicated-sql-pool/${id}/state`);
    const j = (await r.json()) as PoolState;
    setPoolState(j);
    return j;
  }, [id]);

  const refreshSchema = useCallback(async () => {
    const r = await fetch(`/api/items/synapse-dedicated-sql-pool/${id}/schema`);
    const j = (await r.json()) as DedicatedSchema;
    setSchema(j);
  }, [id]);

  useEffect(() => {
    refreshState().then((s2) => { if (s2?.state === 'Online') refreshSchema(); });
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [refreshState, refreshSchema]);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = window.setInterval(async () => {
      const st = await refreshState();
      if (st?.state === 'Online') {
        if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
        setResuming(false);
        refreshSchema();
      }
    }, 5_000);
  }, [refreshState, refreshSchema]);

  const resume = useCallback(async () => {
    setResuming(true);
    try {
      await fetch(`/api/items/synapse-dedicated-sql-pool/${id}/resume`, { method: 'POST' });
      startPolling();
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
      setResuming(false);
    }
  }, [id, startPolling]);

  const pause = useCallback(async () => {
    await fetch(`/api/items/synapse-dedicated-sql-pool/${id}/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause' }),
    });
    refreshState();
  }, [id, refreshState]);

  const run = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      // Rewrite {{name}} → @name; values bound via req.input() — injection-safe.
      const statement = substituteSynapse(sqlText, queryParams);
      const res = await fetch(`/api/items/synapse-dedicated-sql-pool/${id}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: statement, parameters: queryParams }),
      });
      const json = (await res.json()) as QueryResponse;
      if (res.status === 409 && json.state) {
        setResult({ ok: false, error: `Pool is ${json.state}. Click Resume.` });
        refreshState();
      } else {
        setResult(json);
      }
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setLoading(false);
    }
  }, [id, sqlText, queryParams, refreshState]);

  const state = poolState?.state || 'Unknown';
  const isOnline = state === 'Online';
  const schemaTree = useMemo(() => Object.entries(schema?.schemas || {}), [schema]);
  const vqSourceTables = useMemo<VqSourceTable[]>(
    () => schemaTree.flatMap(([sName, tables]) => tables.map((t) => ({ schema: sName, table: t.table }))),
    [schemaTree],
  );
  const views = schema?.views ?? [];
  const procedures = schema?.procedures ?? [];
  const functions = schema?.functions ?? [];

  // Script-out: load the real CREATE/ALTER/DROP into the editor buffer.
  const loadScript = useCallback(async (type: ScriptObjectType, objSchema: string, name: string, mode: ScriptMode) => {
    const r = await loadSqlScript('synapse-dedicated-sql-pool', id, { type, schema: objSchema, name, mode });
    if (r.ok && r.script != null) {
      setSqlText(r.script);
      setResult(null);
    } else {
      setResult({ ok: false, error: r.error || 'Could not script object' });
    }
  }, [id]);
  const countRows = useCallback(
    (objSchema: string, name: string) => sqlRowCount('synapse-dedicated-sql-pool', id, objSchema, name),
    [id],
  );

  // Ctrl+S / Cmd+S → Run when the pool is Online (SSMS muscle memory).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (isOnline && !loading) run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOnline, loading, run]);

  // ---- Save as table (CTAS) — distribution + index control over the editor SELECT ----
  const openCtas = useCallback(() => {
    setCtasName('');
    setCtasError(null);
    setCtasReceipt(null);
    setCtasOpen(true);
  }, []);

  const submitCtas = useCallback(async () => {
    if (!ctasName.trim()) { setCtasError('table name required'); return; }
    if (ctasDist === 'HASH' && !ctasDistCol.trim()) { setCtasError('HASH distribution requires a column'); return; }
    if (ctasIndex === 'CLUSTERED INDEX' && !ctasIndexCol.trim()) { setCtasError('CLUSTERED INDEX requires a column'); return; }
    const cleaned = sqlText.trim().replace(/;+\s*$/, '');
    if (!/^select\b/i.test(cleaned)) {
      setCtasError('CTAS requires the editor to contain a SELECT statement.');
      return;
    }
    setCtasBusy(true); setCtasError(null);
    try {
      const esc = (x: string) => x.replace(/]/g, ']]');
      const distClause =
        ctasDist === 'HASH' ? `DISTRIBUTION = HASH([${esc(ctasDistCol.trim())}])`
        : ctasDist === 'REPLICATE' ? 'DISTRIBUTION = REPLICATE'
        : 'DISTRIBUTION = ROUND_ROBIN';
      const indexClause =
        ctasIndex === 'HEAP' ? 'HEAP'
        : ctasIndex === 'CLUSTERED INDEX' ? `CLUSTERED INDEX ([${esc(ctasIndexCol.trim())}])`
        : 'CLUSTERED COLUMNSTORE INDEX';
      const ddl = [
        `CREATE TABLE [${esc(ctasSchema.trim() || 'dbo')}].[${esc(ctasName.trim())}]`,
        `WITH (${distClause}, ${indexClause})`,
        'AS',
        cleaned + ';',
      ].join('\n');
      const r = await fetch(`/api/items/synapse-dedicated-sql-pool/${id}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: ddl }),
      });
      const j = await r.json();
      if (!j.ok) { setCtasError(j.error || `HTTP ${r.status}`); return; }
      setCtasOpen(false);
      setCtasReceipt(`Table created: ${ctasSchema.trim() || 'dbo'}.${ctasName.trim()} (${j.executionMs}ms · ${distClause.replace('DISTRIBUTION = ', '')}). Queryable via TDS.`);
      refreshSchema();
    } catch (e: any) { setCtasError(e?.message || String(e)); }
    finally { setCtasBusy(false); }
  }, [id, sqlText, ctasSchema, ctasName, ctasDist, ctasDistCol, ctasIndex, ctasIndexCol, refreshSchema]);

  // ---- Select into — full physical copy (Dedicated has no zero-copy clone) ----
  const openSelectIntoForTable = useCallback((schemaName: string, tableName: string) => {
    setSiSourceSchema(schemaName);
    setSiSourceTable(tableName);
    setSiTargetSchema(schemaName);
    setSiTargetTable('');
    setSiError(null);
    setSiReceipt(null);
    setSiOpen(true);
  }, []);

  const submitSelectInto = useCallback(async () => {
    if (!siSourceTable.trim() || !siTargetTable.trim()) { setSiError('source and target table names required'); return; }
    setSiBusy(true); setSiError(null);
    try {
      const r = await fetch(`/api/items/synapse-dedicated-sql-pool/${id}/clone`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceSchema: siSourceSchema.trim() || 'dbo', sourceTable: siSourceTable.trim(), targetSchema: siTargetSchema.trim() || 'dbo', targetTable: siTargetTable.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setSiError(j.error || `HTTP ${r.status}`); return; }
      setSiOpen(false);
      setSiReceipt(`Table materialized: ${j.target} (${(j.recordsAffected ?? 0).toLocaleString()} rows copied · ${j.executionMs}ms). Full physical copy — not zero-copy.`);
      refreshSchema();
    } catch (e: any) { setSiError(e?.message || String(e)); }
    finally { setSiBusy(false); }
  }, [id, siSourceSchema, siSourceTable, siTargetSchema, siTargetTable, refreshSchema]);

  // Ribbon — every action is wired. State actions hit ARM/TDS routes; Query +
  // Manage actions load real DMV T-SQL into the editor so Run executes them via
  // the wired /query path (per ui-parity.md — no disabled "deferred" buttons).
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Query', actions: [
        { label: 'New SQL query', onClick: () => { setSqlText(''); setResult(null); } },
        { label: 'New visual query', onClick: () => setVqOpen(true), title: 'Build a query visually (Power Query diagram view) — no SQL required' },
        { label: loading ? 'Running…' : 'Run', onClick: !loading && isOnline ? run : undefined, disabled: loading || !isOnline, title: !isOnline ? 'Resume the pool first' : undefined },
        // Real DMV — per-request resource class / cost estimate via the MPP DMVs.
        { label: 'Estimate cost', onClick: () => setSqlText(
          `-- Estimate query cost / resource consumption (MPP DMVs).\n`
          + `SELECT TOP 20 r.request_id, r.status, r.resource_class, r.command,\n`
          + `       r.total_elapsed_time, r.submit_time\n`
          + `FROM sys.dm_pdw_exec_requests r\n`
          + `ORDER BY r.submit_time DESC;`,
        ), disabled: !isOnline, title: !isOnline ? 'Resume the pool first' : undefined },
        // Real DMV — distributed query history pane (sys.dm_pdw_exec_requests).
        { label: 'Query history', onClick: isOnline ? openQueryHistory : undefined, disabled: !isOnline, title: !isOnline ? 'Resume the pool first' : 'Recent requests from sys.dm_pdw_exec_requests' },
        { label: 'Save as table', onClick: isOnline && sqlText.trim() ? openCtas : undefined,
          disabled: !isOnline || !sqlText.trim(),
          title: !isOnline ? 'Resume the pool first' : !sqlText.trim() ? 'Enter a SELECT first' : 'CTAS — CREATE TABLE WITH (DISTRIBUTION, INDEX) AS SELECT …' },
      ]},
      { label: 'State', actions: [
        { label: resuming ? 'Resuming…' : 'Resume', onClick: !resuming && state === 'Paused' ? resume : undefined, disabled: resuming || state !== 'Paused', title: state !== 'Paused' ? 'Only available when pool is Paused' : undefined },
        { label: 'Pause', onClick: isOnline ? pause : undefined, disabled: !isOnline, title: !isOnline ? 'Only available when pool is Online' : undefined },
        { label: 'Refresh', onClick: () => { refreshState(); if (isOnline) refreshSchema(); } },
      ]},
      { label: 'Manage', actions: [
        // Real DMV — security principals & role membership.
        { label: 'Permissions', onClick: () => setSqlText(
          `-- Database principals and role membership.\n`
          + `SELECT p.name AS principal, p.type_desc, p.authentication_type_desc,\n`
          + `       ISNULL(r.name, '') AS member_of\n`
          + `FROM sys.database_principals p\n`
          + `LEFT JOIN sys.database_role_members m ON m.member_principal_id = p.principal_id\n`
          + `LEFT JOIN sys.database_principals r ON r.principal_id = m.role_principal_id\n`
          + `WHERE p.type IN ('S','U','G','X','R') ORDER BY p.type_desc, p.name;`,
        ), disabled: !isOnline, title: !isOnline ? 'Resume the pool first' : undefined },
        // Real DMV — workload management groups & classifiers.
        { label: 'Workload mgmt', onClick: () => setSqlText(
          `-- Workload management groups, classifiers and importance.\n`
          + `SELECT g.name AS workload_group, g.importance, g.min_percentage_resource,\n`
          + `       g.cap_percentage_resource, c.name AS classifier, c.member_name\n`
          + `FROM sys.workload_management_workload_groups g\n`
          + `LEFT JOIN sys.workload_management_workload_classifiers c\n`
          + `  ON c.group_name = g.name;`,
        ), disabled: !isOnline, title: !isOnline ? 'Resume the pool first' : undefined },
        // Real DMV — restore points / geo backup history.
        { label: 'Geo backup', onClick: () => setSqlText(
          `-- Restore points (basis for geo-restore) for this pool.\n`
          + `SELECT TOP 50 restore_point_type, restore_point_creation_date,\n`
          + `       restore_point_label\n`
          + `FROM sys.pdw_loader_backup_runs\n`
          + `ORDER BY restore_point_creation_date DESC;`,
        ), disabled: !isOnline, title: !isOnline ? 'Resume the pool first' : undefined },
        // Select into — full physical copy of a table (Dedicated has no zero-copy clone).
        { label: 'Select into', onClick: isOnline ? () => { setSiOpen(true); setSiError(null); setSiReceipt(null); } : undefined, disabled: !isOnline, title: !isOnline ? 'Resume the pool first' : 'Copy a table via SELECT INTO (full physical copy — Synapse Dedicated has no zero-copy clone)' },
      ]},
      { label: 'Security', actions: [
        // Object/column GRANT, Row-Level Security and Dynamic Data Masking
        // wizards — real T-SQL over TDS (Entra-only) via /sql-security.
        { label: 'GRANT / RLS / masking', onClick: isOnline ? () => setSecOpen(true) : undefined, disabled: !isOnline, title: !isOnline ? 'Resume the pool first' : 'Object/column GRANT, Row-Level Security, Dynamic Data Masking' },
      ]},
      { label: 'Connect', actions: [
        // Server FQDN, JDBC URL + sqlcmd snippet (copy). Env-derived — works
        // even while the pool is paused.
        { label: 'Connection details', onClick: () => setConnOpen(true), title: 'Server hostname, database, JDBC URL + sqlcmd snippet (copy)' },
      ]},
      { label: 'Modeling', actions: [
        // Loom-native Model view (table cards + relationship lines + measures), no Power BI.
        { label: 'Model view', onClick: () => setEditorTab('model') },
      ]},
    ]},
  ], [loading, isOnline, run, resuming, state, resume, pause, refreshState, refreshSchema, openQueryHistory, sqlText, openCtas]);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Tree aria-label="Dedicated SQL pool" defaultOpenItems={['schemas']}>
            <TreeItem itemType="branch" value="schemas">
              <TreeItemLayout iconBefore={<Database20Regular />}>
                Schemas ({schemaTree.length})
              </TreeItemLayout>
              <Tree>
                {!isOnline && (
                  <TreeItem itemType="leaf" value="paused">
                    <TreeItemLayout>Pool {state.toLowerCase()} — resume to browse</TreeItemLayout>
                  </TreeItem>
                )}
                {isOnline && schemaTree.length === 0 && (
                  <TreeItem itemType="leaf" value="empty">
                    <TreeItemLayout>No user tables yet. Create one with T-SQL on the right.</TreeItemLayout>
                  </TreeItem>
                )}
                {schemaTree.map(([schemaName, tables]) => (
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
                          <TreeItemLayout
                            iconBefore={<DocumentTable20Regular />}
                            actions={
                              <Tooltip content={`Select into (copy ${t.table})`} relationship="label">
                                <Button
                                  size="small" appearance="subtle" icon={<TableAdd20Regular />}
                                  aria-label={`Select into ${t.table}`}
                                  onClick={(e) => { e.stopPropagation(); openSelectIntoForTable(schemaName, t.table); }}
                                />
                              </Tooltip>
                            }
                          >
                            {t.table} <Caption1>· {t.rows.toLocaleString()} rows</Caption1>
                          </TreeItemLayout>
                        </TreeItem>
                      ))}
                    </Tree>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>

            {/* Views */}
            <TreeItem itemType="branch" value="views">
              <TreeItemLayout iconBefore={<Eye20Regular />}>Views ({views.length})</TreeItemLayout>
              <Tree>
                {!isOnline && (
                  <TreeItem itemType="leaf" value="v-paused"><TreeItemLayout>Pool {state.toLowerCase()} — resume to browse</TreeItemLayout></TreeItem>
                )}
                {isOnline && views.length === 0 && (
                  <TreeItem itemType="leaf" value="v-empty"><TreeItemLayout><Caption1>No views</Caption1></TreeItemLayout></TreeItem>
                )}
                {views.map((v) => (
                  <TreeItem key={`v-${v.schema}.${v.name}`} itemType="leaf" value={`v-${v.schema}.${v.name}`}
                    onClick={() => setSqlText(`SELECT TOP 100 * FROM [${v.schema}].[${v.name}];`)}>
                    <TreeItemLayout
                      iconBefore={<Eye20Regular />}
                      actions={<SqlObjectScriptMenu name={`${v.schema}.${v.name}`}
                        onScriptCreate={() => loadScript('view', v.schema, v.name, 'create')}
                        onScriptAlter={() => loadScript('view', v.schema, v.name, 'alter')}
                        onScriptDrop={() => loadScript('view', v.schema, v.name, 'drop')} />}
                    >
                      {v.schema}.{v.name}{' '}
                      <SqlRowCountBadge cacheKey={`v-${v.schema}.${v.name}`} load={() => countRows(v.schema, v.name)} />
                    </TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>

            {/* Stored procedures */}
            <TreeItem itemType="branch" value="procs">
              <TreeItemLayout iconBefore={<Form20Regular />}>Stored procedures ({procedures.length})</TreeItemLayout>
              <Tree>
                {!isOnline && (
                  <TreeItem itemType="leaf" value="p-paused"><TreeItemLayout>Pool {state.toLowerCase()} — resume to browse</TreeItemLayout></TreeItem>
                )}
                {isOnline && procedures.length === 0 && (
                  <TreeItem itemType="leaf" value="p-empty"><TreeItemLayout><Caption1>No procedures</Caption1></TreeItemLayout></TreeItem>
                )}
                {procedures.map((p) => (
                  <TreeItem key={`p-${p.schema}.${p.name}`} itemType="leaf" value={`p-${p.schema}.${p.name}`}
                    onClick={() => setSqlText(`EXEC [${p.schema}].[${p.name}];`)}>
                    <TreeItemLayout
                      iconBefore={<Form20Regular />}
                      actions={<SqlObjectScriptMenu name={`${p.schema}.${p.name}`}
                        onScriptCreate={() => loadScript('procedure', p.schema, p.name, 'create')}
                        onScriptAlter={() => loadScript('procedure', p.schema, p.name, 'alter')}
                        onScriptDrop={() => loadScript('procedure', p.schema, p.name, 'drop')} />}
                    >
                      {p.schema}.{p.name}
                    </TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>

            {/* Functions */}
            <TreeItem itemType="branch" value="funcs">
              <TreeItemLayout iconBefore={<MathFormula20Regular />}>Functions ({functions.length})</TreeItemLayout>
              <Tree>
                {!isOnline && (
                  <TreeItem itemType="leaf" value="f-paused"><TreeItemLayout>Pool {state.toLowerCase()} — resume to browse</TreeItemLayout></TreeItem>
                )}
                {isOnline && functions.length === 0 && (
                  <TreeItem itemType="leaf" value="f-empty"><TreeItemLayout><Caption1>No functions</Caption1></TreeItemLayout></TreeItem>
                )}
                {functions.map((f) => (
                  <TreeItem key={`f-${f.schema}.${f.name}`} itemType="leaf" value={`f-${f.schema}.${f.name}`}
                    onClick={() => setSqlText(
                      f.type === 'FN'
                        ? `SELECT [${f.schema}].[${f.name}]();`
                        : `SELECT TOP 100 * FROM [${f.schema}].[${f.name}]();`,
                    )}>
                    <TreeItemLayout
                      iconBefore={<MathFormula20Regular />}
                      actions={<SqlObjectScriptMenu name={`${f.schema}.${f.name}`}
                        onScriptCreate={() => loadScript('function', f.schema, f.name, 'create')}
                        onScriptAlter={() => loadScript('function', f.schema, f.name, 'alter')}
                        onScriptDrop={() => loadScript('function', f.schema, f.name, 'drop')} />}
                    >
                      {f.schema}.{f.name}{' '}
                      <Caption1>· {f.type === 'FN' ? 'scalar' : f.type === 'IF' ? 'inline TVF' : 'TVF'}</Caption1>
                    </TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <TabList selectedValue={editorTab} onTabSelect={(_, d) => setEditorTab(d.value as 'query' | 'model' | 'monitoring')}>
            <Tab value="query" icon={<Play20Regular />}>Query</Tab>
            <Tab value="model" icon={<Flowchart20Regular />}>Model</Tab>
            <Tab value="monitoring" icon={<DataBarVertical20Regular />}>Monitoring</Tab>
          </TabList>
          {editorTab === 'monitoring' && (
            <WarehouseMonitoringTab itemId={id} engine="synapse-dedicated-sql-pool" />
          )}
          {editorTab === 'model' && (
            <ModelViewPanel
              engine="synapse-dedicated-sql-pool"
              id={id}
              ready={isOnline}
              measureKind="tvf"
              notReadyMessage={isOnline ? undefined : 'Resume the pool to load tables and create relationships.'}
              onUseInQuery={(sql) => { setSqlText(sql); setResult(null); setEditorTab('query'); }}
            />
          )}
          {editorTab === 'query' && (
          <>
          <div className={s.toolbar}>
            <Badge appearance="filled" color={poolBadgeColor(state)}>{state}</Badge>
            <Badge appearance="outline">{poolState?.sku || 'DW—'}</Badge>
            <Badge appearance="outline">{poolState?.pool || 'pool not configured'}</Badge>
            {state === 'Paused' && (
              <Button appearance="primary" icon={<ArrowSync20Regular />} disabled={resuming} onClick={resume}>
                {resuming ? 'Resuming…' : 'Resume'}
              </Button>
            )}
            {isOnline && (
              <Button appearance="outline" icon={<Pause20Regular />} onClick={pause}>Pause</Button>
            )}
            <Button appearance="outline" onClick={() => { refreshState(); if (isOnline) refreshSchema(); }}>Refresh</Button>
            <Button
              appearance="primary"
              icon={<Play20Regular />}
              disabled={loading || !isOnline}
              onClick={run}
              style={{ marginLeft: 'auto' }}
            >
              Run
            </Button>
          </div>
          {/*
           * Surface sibling Dedicated SQL pools via the shared ComputePicker
           * so users can see/switch between pools and resume a paused one
           * directly. The query still targets the env-bound pool until v2.3.
           */}
          <ComputePicker
            label="Dedicated SQL pools"
            filter={['synapse-dedicated-sql']}
            value={computeId}
            onChange={setComputeId}
          />
          <SqlAccessModeSection itemId={id} itemType="synapse-dedicated-sql-pool" />
          {state === 'Resuming' && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Pool resuming</MessageBarTitle>
                Typically 1–2 minutes. Schema and Run light up automatically when the pool is Online.
              </MessageBarBody>
            </MessageBar>
          )}
          {state === 'Paused' && !resuming && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Pool paused (cost optimization)</MessageBarTitle>
                Auto-pause runs nightly. Click Resume to bring it Online (~1–2 min); queries cost compute while Online and storage only while Paused.
              </MessageBarBody>
            </MessageBar>
          )}
          <MonacoTextarea
            value={sqlText}
            onChange={setSqlText}
            language="tsql"
            height={240}
            minHeight={200}
            ariaLabel="Dedicated T-SQL editor"
          />
          <QueryParamsBar sql={sqlText} onChange={setQueryParams} showTypePicker={false} />
          <ResultsPanel result={result} loading={loading} />
          {ctasReceipt && (
            <MessageBar intent="success">
              <MessageBarBody><MessageBarTitle>Table created</MessageBarTitle>{ctasReceipt}</MessageBarBody>
            </MessageBar>
          )}
          {siReceipt && (
            <MessageBar intent="success">
              <MessageBarBody><MessageBarTitle>Table materialized</MessageBarTitle>{siReceipt}</MessageBarBody>
            </MessageBar>
          )}
          </>
          )}
          <Dialog open={secOpen} onOpenChange={(_, d) => setSecOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '980px', width: '94vw' }}>
              <DialogBody>
                <DialogTitle>SQL granular security — {poolState?.pool || 'Dedicated SQL pool'}</DialogTitle>
                <DialogContent>
                  <SqlSecurityPanel itemType="synapse-dedicated-sql-pool" itemId={id} />
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setSecOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <Dialog open={connOpen} onOpenChange={(_, d) => setConnOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '640px' }}>
              <DialogBody>
                <DialogTitle>Connection details — {poolState?.pool || 'Dedicated SQL pool'}</DialogTitle>
                <DialogContent>
                  <ConnectionDetailsPanel engine="synapse-dedicated-sql-pool" id={id} />
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setConnOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <Dialog open={vqOpen} onOpenChange={(_, d) => setVqOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '1280px', width: '96vw' }}>
              <DialogBody>
                <DialogTitle>Visual query — {poolState?.pool || 'Dedicated SQL pool'}</DialogTitle>
                <DialogContent>
                  <VisualQueryCanvas engine="synapse-dedicated-sql-pool" id={id} dialect="tsql" sourceTables={vqSourceTables} />
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setVqOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <Dialog open={qhOpen} onOpenChange={(_, d) => setQhOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '1080px', width: '95vw' }}>
              <DialogBody>
                <DialogTitle>Query history — {poolState?.pool || 'Dedicated SQL pool'}</DialogTitle>
                <DialogContent>
                  <Caption1 style={{ display: 'block', marginBottom: 8 }}>
                    Source: <code>sys.dm_pdw_exec_requests</code> — last 50 distributed requests (the DMV retains ~10,000 rows).
                  </Caption1>
                  {qhBusy && <Spinner size="tiny" label="Loading…" labelPosition="after" />}
                  {qhError && (
                    <MessageBar intent="error">
                      <MessageBarBody><MessageBarTitle>Failed</MessageBarTitle>{qhError}</MessageBarBody>
                    </MessageBar>
                  )}
                  <div className={s.tableWrap} style={{ maxHeight: '55vh' }}>
                    <Table aria-label="Query history" size="small">
                      <TableHeader>
                        <TableRow>
                          <TableHeaderCell>Request ID</TableHeaderCell>
                          <TableHeaderCell>Status</TableHeaderCell>
                          <TableHeaderCell>Submit time</TableHeaderCell>
                          <TableHeaderCell>Duration</TableHeaderCell>
                          <TableHeaderCell>Resource class</TableHeaderCell>
                          <TableHeaderCell>Query</TableHeaderCell>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {qhEntries.length === 0 && !qhBusy && (
                          <TableRow><TableCell colSpan={6}><Caption1>No requests found.</Caption1></TableCell></TableRow>
                        )}
                        {qhEntries.map((e) => (
                          <TableRow key={e.request_id}>
                            <TableCell className={s.cell}>{e.request_id}</TableCell>
                            <TableCell>
                              <Badge appearance="filled" color={
                                e.status === 'Completed' ? 'success'
                                : e.status === 'Failed' ? 'danger'
                                : e.status === 'Cancelled' ? 'warning'
                                : e.status === 'Running' ? 'brand'
                                : 'informative'
                              }>
                                {e.status}
                              </Badge>
                            </TableCell>
                            <TableCell className={s.cell}>{e.submit_time ? new Date(e.submit_time).toLocaleString() : '—'}</TableCell>
                            <TableCell className={s.cell}>{e.total_elapsed_time_ms != null ? `${(e.total_elapsed_time_ms / 1000).toFixed(1)}s` : '—'}</TableCell>
                            <TableCell className={s.cell}>{e.resource_class || '—'}</TableCell>
                            <TableCell style={{ maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              <code style={{ fontSize: 11 }}>{(e.query_text || '').slice(0, 200) || '—'}</code>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setQhOpen(false)}>Close</Button>
                  <Button appearance="subtle" onClick={() => loadQueryHistory()} disabled={qhBusy}>Refresh</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Save as table (CTAS — distribution + index control) */}
          <Dialog open={ctasOpen} onOpenChange={(_, d) => setCtasOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '620px' }}>
              <DialogBody>
                <DialogTitle>Save as table (CTAS — Synapse Dedicated)</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {ctasError && (
                      <MessageBar intent="error"><MessageBarBody><MessageBarTitle>CTAS failed</MessageBarTitle>{ctasError}</MessageBarBody></MessageBar>
                    )}
                    <Caption1>
                      Emits <code>CREATE TABLE [schema].[name] WITH (DISTRIBUTION = …, …INDEX) AS SELECT …</code>.
                      CTAS is the recommended way to create distributed tables on a Dedicated SQL pool — it runs in parallel and lets you choose the distribution + index strategy.
                    </Caption1>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Field label="Schema" required style={{ flex: 1 }}>
                        <Input value={ctasSchema} onChange={(_, d) => setCtasSchema(d.value)} placeholder="dbo" />
                      </Field>
                      <Field label="Table name" required style={{ flex: 2 }}>
                        <Input value={ctasName} onChange={(_, d) => setCtasName(d.value)} placeholder="orders_summary" />
                      </Field>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                      <Field label="Distribution" style={{ flex: 1 }}>
                        <Dropdown value={ctasDist} selectedOptions={[ctasDist]}
                          onOptionSelect={(_, d) => d.optionValue && setCtasDist(d.optionValue as 'ROUND_ROBIN' | 'HASH' | 'REPLICATE')}>
                          <Option value="ROUND_ROBIN" text="ROUND_ROBIN">ROUND_ROBIN (default)</Option>
                          <Option value="HASH" text="HASH">HASH — specify column</Option>
                          <Option value="REPLICATE" text="REPLICATE">REPLICATE (small tables)</Option>
                        </Dropdown>
                      </Field>
                      {ctasDist === 'HASH' && (
                        <Field label="Hash column" required style={{ flex: 1 }}>
                          <Input value={ctasDistCol} onChange={(_, d) => setCtasDistCol(d.value)} placeholder="customer_id" />
                        </Field>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                      <Field label="Index type" style={{ flex: 1 }}>
                        <Dropdown value={ctasIndex} selectedOptions={[ctasIndex]}
                          onOptionSelect={(_, d) => d.optionValue && setCtasIndex(d.optionValue as 'CLUSTERED COLUMNSTORE INDEX' | 'HEAP' | 'CLUSTERED INDEX')}>
                          <Option value="CLUSTERED COLUMNSTORE INDEX" text="CLUSTERED COLUMNSTORE INDEX">CLUSTERED COLUMNSTORE INDEX (default)</Option>
                          <Option value="HEAP" text="HEAP">HEAP</Option>
                          <Option value="CLUSTERED INDEX" text="CLUSTERED INDEX">CLUSTERED INDEX — specify column</Option>
                        </Dropdown>
                      </Field>
                      {ctasIndex === 'CLUSTERED INDEX' && (
                        <Field label="Index column" required style={{ flex: 1 }}>
                          <Input value={ctasIndexCol} onChange={(_, d) => setCtasIndexCol(d.value)} placeholder="order_date" />
                        </Field>
                      )}
                    </div>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setCtasOpen(false)} disabled={ctasBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={submitCtas}
                    disabled={ctasBusy || !ctasName.trim() || (ctasDist === 'HASH' && !ctasDistCol.trim()) || (ctasIndex === 'CLUSTERED INDEX' && !ctasIndexCol.trim())}>
                    {ctasBusy ? 'Creating…' : 'Create table'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Select into — full physical copy (no zero-copy clone on Dedicated) */}
          <Dialog open={siOpen} onOpenChange={(_, d) => setSiOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '540px' }}>
              <DialogBody>
                <DialogTitle>Select into (copy table)</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {siError && (
                      <MessageBar intent="error"><MessageBarBody><MessageBarTitle>SELECT INTO failed</MessageBarTitle>{siError}</MessageBarBody></MessageBar>
                    )}
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        <MessageBarTitle>No zero-copy clone on Synapse Dedicated</MessageBarTitle>
                        SELECT INTO performs a full physical data copy (ROUND_ROBIN distribution,
                        Clustered Columnstore Index). Every row is duplicated in storage. To choose
                        a specific distribution or index, use Save as table (CTAS) instead.
                      </MessageBarBody>
                    </MessageBar>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Field label="Source schema" style={{ flex: 1 }}>
                        <Input value={siSourceSchema} onChange={(_, d) => setSiSourceSchema(d.value)} />
                      </Field>
                      <Field label="Source table" required style={{ flex: 2 }}>
                        <Input value={siSourceTable} onChange={(_, d) => setSiSourceTable(d.value)} />
                      </Field>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Field label="Target schema" style={{ flex: 1 }}>
                        <Input value={siTargetSchema} onChange={(_, d) => setSiTargetSchema(d.value)} />
                      </Field>
                      <Field label="Target table" required style={{ flex: 2 }}>
                        <Input value={siTargetTable} onChange={(_, d) => setSiTargetTable(d.value)} placeholder="orders_copy" />
                      </Field>
                    </div>
                    <Caption1>
                      Emits <code>SELECT * INTO [{siTargetSchema}].[{siTargetTable}] FROM [{siSourceSchema}].[{siSourceTable}]</code>.
                      The target table must not already exist.
                    </Caption1>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setSiOpen(false)} disabled={siBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={submitSelectInto} disabled={siBusy || !siSourceTable.trim() || !siTargetTable.trim()}>
                    {siBusy ? 'Copying…' : 'Copy table (SELECT INTO)'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
          </>
          )}
        </div>
      }
    />
  );
}
