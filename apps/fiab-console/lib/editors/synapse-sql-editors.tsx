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
  Tree, TreeItem, TreeItemLayout,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular, Pause20Regular,
  ArrowSync20Regular, Folder20Regular, Lightbulb20Regular, ArrowDownload20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { ComputePicker } from '@/lib/components/compute-picker';
import { SqlSecurityPanel } from '@/lib/panes/sql-security-panel';

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

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ── Results export (CSV / JSON) — client-side, no extra route ──
function downloadBlob(filename: string, mime: string, data: string) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}
function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
function resultsToCsv(columns: string[], rows: unknown[][]): string {
  return [columns.map(csvEscape).join(','), ...rows.map((r) => columns.map((_, j) => csvEscape(r[j])).join(','))].join('\r\n');
}
function resultsToJson(columns: string[], rows: unknown[][]): string {
  return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, j) => [c, r[j] ?? null]))), null, 2);
}

function ResultsPanel({ result, loading }: { result: QueryResponse | null; loading: boolean }) {
  const s = useStyles();
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
            <Tooltip content="Download results as CSV" relationship="label">
              <Button size="small" appearance="subtle" icon={<ArrowDownload20Regular />}
                onClick={() => downloadBlob(`query-results-${stamp}.csv`, 'text/csv', resultsToCsv(columns, rows))}>CSV</Button>
            </Tooltip>
            <Tooltip content="Download results as JSON" relationship="label">
              <Button size="small" appearance="subtle" icon={<ArrowDownload20Regular />}
                onClick={() => downloadBlob(`query-results-${stamp}.json`, 'application/json', resultsToJson(columns, rows))}>JSON</Button>
            </Tooltip>
          </div>
        )}
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
  // v3.29: surface the shared ComputePicker so the Serverless surface shows
  // the same family-wide compute-target dropdown its sibling Dedicated +
  // Spark editors use. Serverless is always-on so we hide lifecycle controls
  // (start/stop) — the picker is read-only for the serverless kind today,
  // matching the existing ComputePicker semantics.
  const [computeId, setComputeId] = useState('');
  // SQL granular security (F11) — GRANT / column-GRANT / DDM wizards (Entra-only
  // TDS). RLS is gated off for Serverless by the panel (not supported there).
  const [secOpen, setSecOpen] = useState(false);

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
      const res = await fetch(`/api/items/synapse-serverless-sql-pool/${id}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sqlText, database }),
      });
      const json = (await res.json()) as QueryResponse;
      setResult(json);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setLoading(false);
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
        { label: loading ? 'Running…' : 'Run', onClick: !loading ? run : undefined, disabled: loading },
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
  ], [loading, run]);

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
          <MonacoTextarea
            value={sqlText}
            onChange={setSqlText}
            language="tsql"
            height={240}
            minHeight={200}
            ariaLabel="Serverless T-SQL editor"
          />
          <ResultsPanel result={result} loading={loading} />
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
  const pollRef = useRef<number | null>(null);
  // ComputePicker surfaces sibling Dedicated SQL pools so users can switch
  // between pools (multi-pool workspaces) and see lifecycle state at a
  // glance. The actual query still routes to the BFF's wired-in pool from
  // env — switching is read-only here for v2.x; v2.3 wires per-pool query.
  const [computeId, setComputeId] = useState('');
  // SQL granular security (F11) — GRANT / RLS / DDM wizards over TDS (Entra-only).
  const [secOpen, setSecOpen] = useState(false);

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
      const res = await fetch(`/api/items/synapse-dedicated-sql-pool/${id}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sqlText }),
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
  }, [id, sqlText, refreshState]);

  const state = poolState?.state || 'Unknown';
  const isOnline = state === 'Online';
  const schemaTree = useMemo(() => Object.entries(schema?.schemas || {}), [schema]);

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

  // Ribbon — every action is wired. State actions hit ARM/TDS routes; Query +
  // Manage actions load real DMV T-SQL into the editor so Run executes them via
  // the wired /query path (per ui-parity.md — no disabled "deferred" buttons).
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Query', actions: [
        { label: 'New SQL query', onClick: () => { setSqlText(''); setResult(null); } },
        { label: loading ? 'Running…' : 'Run', onClick: !loading && isOnline ? run : undefined, disabled: loading || !isOnline, title: !isOnline ? 'Resume the pool first' : undefined },
        // Real DMV — per-request resource class / cost estimate via the MPP DMVs.
        { label: 'Estimate cost', onClick: () => setSqlText(
          `-- Estimate query cost / resource consumption (MPP DMVs).\n`
          + `SELECT TOP 20 r.request_id, r.status, r.resource_class, r.command,\n`
          + `       r.total_elapsed_time, r.submit_time\n`
          + `FROM sys.dm_pdw_exec_requests r\n`
          + `ORDER BY r.submit_time DESC;`,
        ), disabled: !isOnline, title: !isOnline ? 'Resume the pool first' : undefined },
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
      ]},
      { label: 'Security', actions: [
        // Object/column GRANT, Row-Level Security and Dynamic Data Masking
        // wizards — real T-SQL over TDS (Entra-only) via /sql-security.
        { label: 'GRANT / RLS / masking', onClick: isOnline ? () => setSecOpen(true) : undefined, disabled: !isOnline, title: !isOnline ? 'Resume the pool first' : 'Object/column GRANT, Row-Level Security, Dynamic Data Masking' },
      ]},
    ]},
  ], [loading, isOnline, run, resuming, state, resume, pause, refreshState, refreshSchema]);

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
          <ResultsPanel result={result} loading={loading} />
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
        </div>
      }
    />
  );
}
