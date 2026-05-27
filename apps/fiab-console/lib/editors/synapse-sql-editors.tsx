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
  Subtitle2, Body1, Caption1, Badge, Button, Spinner,
  Tree, TreeItem, TreeItemLayout,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular, Pause20Regular,
  ArrowSync20Regular, Folder20Regular, Lightbulb20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { ComputePicker } from '@/lib/components/compute-picker';

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
  sqlNumber?: number;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
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
  return (
    <div className={s.resultBox}>
      <div className={s.resultMeta}>
        <Badge appearance="filled" color="success">{result.rowCount ?? rows.length} rows</Badge>
        <Caption1>· {result.executionMs} ms</Caption1>
        {result.truncated && <Badge appearance="outline" color="warning">truncated at 5,000</Badge>}
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

  // Ribbon — wired to inline `run` + clear-buffer. Other entries disabled with reason
  // so the surface is honest about what's available today (per .claude/rules/no-vaporware.md).
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Query', actions: [
        { label: 'New SQL query', onClick: () => { setSqlText(''); setResult(null); } },
        { label: loading ? 'Running…' : 'Run', onClick: !loading ? run : undefined, disabled: loading },
        { label: 'External tables', disabled: true, title: 'External tables — needs OPENROWSET/CREATE EXTERNAL TABLE BFF route (deferred)' },
      ]},
      { label: 'Cost', actions: [
        { label: 'Bytes processed', disabled: true, title: 'Bytes processed — needs cost telemetry BFF route (deferred)' },
        { label: 'Cost cap', disabled: true, title: 'Cost cap — needs sys.cost_cap policy BFF route (deferred)' },
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
          <MonacoTextarea
            value={sqlText}
            onChange={setSqlText}
            language="tsql"
            height={240}
            minHeight={200}
            ariaLabel="Serverless T-SQL editor"
          />
          <ResultsPanel result={result} loading={loading} />
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

  // Ribbon — wired to inline run / resume / pause / refreshState handlers; the rest
  // are honestly disabled until their BFF routes land (per no-vaporware rule).
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Query', actions: [
        { label: 'New SQL query', onClick: () => { setSqlText(''); setResult(null); } },
        { label: loading ? 'Running…' : 'Run', onClick: !loading && isOnline ? run : undefined, disabled: loading || !isOnline, title: !isOnline ? 'Resume the pool first' : undefined },
        { label: 'Estimate cost', disabled: true, title: 'Estimate cost — needs DMS query-cost BFF route (deferred)' },
      ]},
      { label: 'State', actions: [
        { label: resuming ? 'Resuming…' : 'Resume', onClick: !resuming && state === 'Paused' ? resume : undefined, disabled: resuming || state !== 'Paused', title: state !== 'Paused' ? 'Only available when pool is Paused' : undefined },
        { label: 'Pause', onClick: isOnline ? pause : undefined, disabled: !isOnline, title: !isOnline ? 'Only available when pool is Online' : undefined },
        { label: 'Refresh', onClick: () => { refreshState(); if (isOnline) refreshSchema(); } },
      ]},
      { label: 'Manage', actions: [
        { label: 'Permissions', disabled: true, title: 'Permissions — needs sys.database_principals BFF route (deferred)' },
        { label: 'Workload mgmt', disabled: true, title: 'Workload mgmt — needs sys.workload_management_workload_groups BFF route (deferred)' },
        { label: 'Geo backup', disabled: true, title: 'Geo backup — needs ARM restore-point BFF route (deferred)' },
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
        </div>
      }
    />
  );
}
