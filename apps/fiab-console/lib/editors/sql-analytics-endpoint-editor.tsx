'use client';

/**
 * SqlAnalyticsEndpointEditor — standalone editor for the first-class
 * `sql-analytics-endpoint` catalog item: the read-only T-SQL analyst
 * consumption surface auto-attachable to a lakehouse / warehouse / mirror.
 *
 * Azure-native parity (no Microsoft Fabric / Power BI): the endpoint is Azure
 * Synapse SERVERLESS SQL querying the Delta / Parquet that lives in ADLS Gen2.
 * This editor REUSES the serverless SQL editor patterns + primitives
 * (SynapseServerlessSqlObjectExplorer, MonacoTextarea, result-export,
 * ConnectionDetailsPanel, ItemEditorChrome) but targets the item's OWN BFF
 * namespace — /api/items/sql-analytics-endpoint/[id]/{schema,objects,query} —
 * which re-exports the real serverless TDS handlers (synapse-sql-client). No
 * mocks (no-vaporware.md); when LOOM_SYNAPSE_WORKSPACE is unset the surface
 * still renders and shows an honest infra-gate.
 *
 * Supports SELECT, CREATE OR ALTER VIEW / PROCEDURE / inline-TVF, and
 * object-level + row-level security grants (serverless does NOT support scalar
 * UDFs — the function template emits an iTVF and says so). Fluent v9 + Loom
 * tokens only (web3-ui.md).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Badge, Button, Caption1, Spinner, Tooltip, Dropdown, Option, Label,
  Tab, TabList, Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Play20Regular, ArrowDownload20Regular,
  Table20Regular, TextBulletListSquare20Regular, Server16Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { ConnectionDetailsPanel } from './components/connection-details';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import {
  SynapseServerlessSqlObjectExplorer,
  type ObjectsResponse,
} from '@/lib/components/synapse-sql-object-explorer';
import { downloadBlob, resultsToCsv, resultsToJson } from './components/result-export';

const useStyles = makeStyles({
  pad: { padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
  connect: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', minWidth: 0 },
  endpointBadge: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  errorText: { overflowWrap: 'anywhere', wordBreak: 'break-word' },
  editorWrap: { minHeight: '220px' },
  resultBox: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalM, minHeight: '200px', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  resultMeta: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', flexWrap: 'wrap' },
  resultActions: { marginLeft: 'auto', display: 'flex', gap: tokens.spacingHorizontalXS },
  tableWrap: { overflow: 'auto', maxHeight: '320px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  cell: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap' },
  messages: {
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere', wordBreak: 'break-word',
    backgroundColor: tokens.colorNeutralBackground3, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalM,
    color: tokens.colorNeutralForeground2, maxHeight: '280px', overflow: 'auto', margin: 0,
  },
});

interface QueryResponse {
  ok: boolean;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  executionMs?: number;
  truncated?: boolean;
  messages?: string[];
  recordsAffected?: number;
  isDdl?: boolean;
  error?: string;
  code?: string;
  sqlNumber?: number;
}

const DEFAULT_SQL =
  `-- SQL analytics endpoint — read-only T-SQL over the lake (Azure-native serverless; no Fabric).\n`
  + `SELECT 1 AS smoke, SYSDATETIMEOFFSET() AS server_time, SUSER_NAME() AS upn;`;

// Custom objects on a lake database live OUTSIDE [dbo] ([dbo] is reserved for
// Spark-managed lake tables). Consumption objects default to [reports].
const TEMPLATE_VIEW =
  `CREATE OR ALTER VIEW [reports].[vw_new] AS\n`
  + `SELECT TOP 100 *\n`
  + `FROM OPENROWSET(\n`
  + `  BULK 'https://<account>.dfs.core.windows.net/<container>/<path>/**',\n`
  + `  FORMAT = 'DELTA'\n`
  + `) AS rows;`;

const TEMPLATE_PROC =
  `CREATE OR ALTER PROCEDURE [reports].[sp_new]\n`
  + `  @top INT = 100\n`
  + `AS\n`
  + `BEGIN\n`
  + `  SET NOCOUNT ON;\n`
  + `  SELECT TOP (@top) *\n`
  + `  FROM OPENROWSET(\n`
  + `    BULK 'https://<account>.dfs.core.windows.net/<container>/<path>/**',\n`
  + `    FORMAT = 'DELTA'\n`
  + `  ) AS rows;\n`
  + `END;`;

const TEMPLATE_FUNC =
  `-- Serverless supports inline table-valued functions (iTVF) — NOT scalar UDFs.\n`
  + `CREATE OR ALTER FUNCTION [reports].[fn_new](@minValue INT)\n`
  + `RETURNS TABLE\n`
  + `AS RETURN (\n`
  + `  SELECT *\n`
  + `  FROM OPENROWSET(\n`
  + `    BULK 'https://<account>.dfs.core.windows.net/<container>/<path>/**',\n`
  + `    FORMAT = 'DELTA'\n`
  + `  ) AS rows\n`
  + `  WHERE rows.value >= @minValue\n`
  + `);`;

// Object-level grant — give an analyst read on a consumption view (least-privilege).
const TEMPLATE_GRANT =
  `-- Object-level grant: read-only access to a consumption view.\n`
  + `GRANT SELECT ON OBJECT::[reports].[vw_new] TO [analyst_role];\n`
  + `-- DENY overrides GRANT: DENY SELECT ON OBJECT::[reports].[vw_internal] TO [analyst_role];`;

// Row-level security — predicate function + security policy over a consumption view.
const TEMPLATE_RLS =
  `-- Row-level security: filter rows by the caller's identity.\n`
  + `CREATE OR ALTER FUNCTION [reports].[fn_rls_predicate](@tenant SYSNAME)\n`
  + `RETURNS TABLE WITH SCHEMABINDING\n`
  + `AS RETURN SELECT 1 AS allowed WHERE @tenant = SUSER_SNAME() OR IS_ROLEMEMBER('db_owner') = 1;\n`
  + `GO\n`
  + `CREATE SECURITY POLICY [reports].[rls_policy]\n`
  + `ADD FILTER PREDICATE [reports].[fn_rls_predicate]([tenant]) ON [reports].[vw_new]\n`
  + `WITH (STATE = ON);`;

const TSQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'JOIN', 'INNER JOIN',
  'LEFT JOIN', 'TOP', 'DISTINCT', 'WITH', 'AS', 'CREATE OR ALTER', 'VIEW', 'PROCEDURE',
  'FUNCTION', 'EXEC', 'OPENROWSET', 'BULK', 'FORMAT', 'EXTERNAL TABLE',
  'EXTERNAL DATA SOURCE', 'EXTERNAL FILE FORMAT', 'CETAS', 'RETURNS TABLE',
  'GRANT', 'DENY', 'REVOKE', 'SECURITY POLICY', 'FILTER PREDICATE',
];

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function SqlAnalyticsEndpointEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  // The item's OWN BFF namespace — re-exports the real serverless TDS handlers.
  const apiBase = `/api/items/sql-analytics-endpoint/${id}`;

  // A paired editor (e.g. opened from a lakehouse "SQL analytics endpoint" link)
  // may pass ?database=<db> to land directly on that attached database.
  const searchParams = useSearchParams();
  const initialDb = searchParams?.get('database') || 'master';
  const [database, setDatabase] = useState(initialDb);
  const [databases, setDatabases] = useState<string[]>([]);
  const [endpoint, setEndpoint] = useState<string>('');
  const [configured, setConfigured] = useState(true);
  const [sqlText, setSqlText] = useState(DEFAULT_SQL);
  const [objects, setObjects] = useState<ObjectsResponse | null>(null);
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [resultTab, setResultTab] = useState<'results' | 'messages'>('results');
  const [loading, setLoading] = useState(false);
  const [connOpen, setConnOpen] = useState(false);

  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const objectsRef = useRef<ObjectsResponse | null>(null);
  useEffect(() => { objectsRef.current = objects; }, [objects]);

  // Connect-to database list (master + attached user DBs).
  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/schema`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setConfigured(!!j?.endpoint || !!j?.workspace);
        setEndpoint(j?.endpoint || '');
        setDatabases(['master', ...((j?.databases as string[]) || [])]);
      })
      .catch(() => { if (!cancelled) setConfigured(false); });
    return () => { cancelled = true; };
  }, [apiBase]);

  // Object explorer + IntelliSense source.
  const loadObjects = useCallback(async () => {
    setObjectsLoading(true);
    try {
      const r = await fetch(`${apiBase}/objects?database=${encodeURIComponent(database)}`);
      const j = (await r.json()) as ObjectsResponse;
      setObjects(j);
      if (j?.gated) setConfigured(false);
    } catch {
      setObjects(null);
    } finally {
      setObjectsLoading(false);
    }
  }, [apiBase, database]);

  useEffect(() => { loadObjects(); }, [loadObjects]);

  const runText = useCallback(async (text: string) => {
    const sqlToRun = text.trim();
    if (!sqlToRun) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`${apiBase}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sqlToRun, database }),
      });
      const json = (await res.json()) as QueryResponse;
      setResult(json);
      setResultTab(json.ok && !json.isDdl && (json.columns?.length ?? 0) > 0 ? 'results' : 'messages');
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
      setResultTab('messages');
    } finally {
      setLoading(false);
    }
  }, [apiBase, database]);

  const run = useCallback(() => runText(sqlText), [runText, sqlText]);

  const runSelection = useCallback(() => {
    const ed = editorRef.current;
    const sel = ed?.getModel()?.getValueInRange(ed.getSelection());
    runText(sel && sel.trim() ? sel : sqlText);
  }, [runText, sqlText]);

  // After a successful DDL, refresh the object tree + IntelliSense source.
  useEffect(() => {
    if (result?.ok && result.isDdl) loadObjects();
  }, [result, loadObjects]);

  const runDdl = useCallback(async (ddl: string) => { await runText(ddl); }, [runText]);

  const onEditorReady = useCallback((editor: any, monaco: any) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      const sel = editor.getModel()?.getValueInRange(editor.getSelection());
      runText(sel && sel.trim() ? sel : editor.getValue());
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      runText(editor.getValue());
    });

    const provider = monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: [' ', '.', '\n', '('],
      provideCompletionItems: () => {
        const obj = objectsRef.current;
        const suggestions: any[] = [];
        TSQL_KEYWORDS.forEach((kw) => suggestions.push({
          label: kw, kind: monaco.languages.CompletionItemKind.Keyword, insertText: kw,
        }));
        if (obj) {
          obj.views?.forEach((v) => suggestions.push({
            label: `[${v.schema}].[${v.name}]`, kind: monaco.languages.CompletionItemKind.Module,
            insertText: `[${v.schema}].[${v.name}]`, detail: 'View',
          }));
          obj.externalTables?.forEach((t) => suggestions.push({
            label: `[${t.schema}].[${t.name}]`, kind: monaco.languages.CompletionItemKind.Class,
            insertText: `[${t.schema}].[${t.name}]`, detail: `External table — ${t.dataSource || 'OPENROWSET'}`,
          }));
          obj.functions?.forEach((f) => suggestions.push({
            label: `[${f.schema}].[${f.name}]`, kind: monaco.languages.CompletionItemKind.Function,
            insertText: `[${f.schema}].[${f.name}]`, detail: f.type === 'IF' ? 'Inline TVF' : 'Table-valued function',
          }));
          obj.procedures?.forEach((p) => suggestions.push({
            label: `[${p.schema}].[${p.name}]`, kind: monaco.languages.CompletionItemKind.Method,
            insertText: `[${p.schema}].[${p.name}]`, detail: 'Stored procedure',
          }));
          const seen = new Set<string>();
          Object.entries(obj.columns || {}).forEach(([objName, cols]) =>
            cols.forEach((c) => {
              const key = `${c.name}|${objName}`;
              if (seen.has(key)) return;
              seen.add(key);
              suggestions.push({
                label: c.name, kind: monaco.languages.CompletionItemKind.Field,
                insertText: c.name, detail: `${c.dataType} — ${objName}`,
              });
            }),
          );
        }
        return { suggestions };
      },
    });
    editor.onDidDispose?.(() => provider.dispose());
  }, [runText]);

  const insertSql = useCallback((sql: string) => {
    const ed = editorRef.current;
    if (ed) {
      const sel = ed.getSelection();
      ed.executeEdits('explorer-insert', [{ range: sel, text: sql, forceMoveMarkers: true }]);
      ed.focus();
    } else {
      setSqlText(sql);
    }
  }, []);

  const loadDefinition = useCallback((sql: string) => {
    setSqlText(sql);
    editorRef.current?.setValue?.(sql);
  }, []);

  const newScript = useCallback((sql: string) => {
    setSqlText(sql);
    editorRef.current?.setValue?.(sql);
  }, []);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Query', actions: [
        { label: 'New SQL script', onClick: () => newScript('') },
        { label: loading ? 'Running…' : 'Run', onClick: !loading ? run : undefined, disabled: loading },
        { label: 'Run selection', onClick: !loading ? runSelection : undefined, disabled: loading },
      ]},
      { label: 'Objects', actions: [
        { label: objectsLoading ? 'Refreshing…' : 'Refresh objects', onClick: !objectsLoading ? loadObjects : undefined, disabled: objectsLoading },
      ]},
      { label: 'Connect', actions: [
        { label: 'Connection details', onClick: () => setConnOpen(true), title: 'Serverless endpoint FQDN, database, JDBC URL + sqlcmd snippet' },
      ]},
      { label: 'New', actions: [
        { label: 'New view', onClick: () => newScript(TEMPLATE_VIEW) },
        { label: 'New procedure', onClick: () => newScript(TEMPLATE_PROC) },
        { label: 'New function', onClick: () => newScript(TEMPLATE_FUNC) },
      ]},
      { label: 'Security', actions: [
        { label: 'Grant access', onClick: () => newScript(TEMPLATE_GRANT), title: 'Object-level GRANT / DENY on a consumption view' },
        { label: 'Row-level security', onClick: () => newScript(TEMPLATE_RLS), title: 'Predicate function + security policy (row-level security)' },
      ]},
    ]},
  ], [loading, run, runSelection, objectsLoading, loadObjects, newScript]);

  const rows = result?.rows || [];
  const columns = result?.columns || [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ribbon}
      leftPanel={
        <SynapseServerlessSqlObjectExplorer
          database={database}
          objects={objects}
          loading={objectsLoading}
          onRefresh={loadObjects}
          onInsertSql={insertSql}
          onLoadDefinition={loadDefinition}
          onRunDdl={runDdl}
        />
      }
      main={
        <div className={s.pad}>
          {!configured && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>SQL analytics endpoint not configured</MessageBarTitle>
                Set <strong>LOOM_SYNAPSE_WORKSPACE</strong> on the Console container app
                (admin-plane bicep deploys the Synapse workspace + Serverless endpoint).
                No Microsoft Fabric or Power BI workspace is required — this is the Azure-native default.
              </MessageBarBody>
            </MessageBar>
          )}
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand" icon={<Server16Regular />}>SQL analytics endpoint</Badge>
            <div className={s.connect}>
              <Label size="small" htmlFor="connect-db">Connect to</Label>
              <Dropdown
                id="connect-db"
                size="small"
                value={database}
                selectedOptions={[database]}
                onOptionSelect={(_, d) => { if (d.optionValue) setDatabase(d.optionValue); }}
                style={{ minWidth: 180 }}
              >
                {databases.map((db) => <Option key={db} value={db}>{db}</Option>)}
              </Dropdown>
            </div>
            <Badge appearance="outline" color={endpoint ? 'success' : 'severe'}
              className={s.endpointBadge} title={endpoint || 'endpoint not configured'}>
              {endpoint || 'endpoint not configured'}
            </Badge>
            <Button appearance="primary" icon={<Play20Regular />} disabled={loading} onClick={run} style={{ marginLeft: 'auto' }}>
              Run
            </Button>
          </div>

          <div className={s.editorWrap}>
            <MonacoTextarea
              value={sqlText}
              onChange={setSqlText}
              language="tsql"
              height={260}
              minHeight={220}
              autoHeight
              maxHeight={640}
              ariaLabel="SQL analytics endpoint T-SQL editor"
              onReady={onEditorReady}
            />
          </div>

          <div className={s.resultBox}>
            <TabList selectedValue={resultTab} onTabSelect={(_, d) => setResultTab(d.value as 'results' | 'messages')} size="small">
              <Tab value="results" icon={<Table20Regular />}>Results</Tab>
              <Tab value="messages" icon={<TextBulletListSquare20Regular />}>Messages{result?.messages?.length ? ` (${result.messages.length})` : ''}</Tab>
            </TabList>

            {loading && <Spinner size="small" label="Executing T-SQL…" labelPosition="after" />}

            {!loading && resultTab === 'results' && (
              !result ? (
                <Caption1>Click <strong>Run</strong> (or Ctrl+Enter) to execute. Results appear here.</Caption1>
              ) : !result.ok ? (
                <Caption1>Query failed — see the <strong>Messages</strong> tab.</Caption1>
              ) : result.isDdl || columns.length === 0 ? (
                <Caption1>Command(s) completed — see the <strong>Messages</strong> tab.</Caption1>
              ) : (
                <>
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
                          <TableRow>{columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow>
                        </TableHeader>
                        <TableBody>
                          {rows.map((row, i) => (
                            <TableRow key={i}>
                              {columns.map((_, j) => <TableCell key={j} className={s.cell}>{formatCell(row[j])}</TableCell>)}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </>
              )
            )}

            {!loading && resultTab === 'messages' && (
              !result ? (
                <Caption1>Messages (PRINT, RAISERROR, DDL receipts and errors) appear here after you Run.</Caption1>
              ) : !result.ok ? (
                <MessageBar intent="error">
                  <MessageBarBody className={s.errorText}>
                    <MessageBarTitle>Query failed{result.sqlNumber ? ` (Msg ${result.sqlNumber})` : ''}</MessageBarTitle>
                    {result.error || 'Unknown error'}{result.code ? ` · ${result.code}` : ''}
                  </MessageBarBody>
                </MessageBar>
              ) : (
                <pre className={s.messages}>
                  {[
                    ...(result.messages || []),
                    result.isDdl || columns.length === 0
                      ? `Command(s) completed successfully.${result.recordsAffected ? ` (${result.recordsAffected} rows affected)` : ''}`
                      : `(${result.rowCount ?? rows.length} row(s) returned)`,
                    `Completed in ${result.executionMs} ms.`,
                  ].filter(Boolean).join('\n')}
                </pre>
              )
            )}
          </div>

          <Dialog open={connOpen} onOpenChange={(_, d) => setConnOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '640px' }}>
              <DialogBody>
                <DialogTitle>Connection details — SQL analytics endpoint</DialogTitle>
                <DialogContent>
                  <ConnectionDetailsPanel
                    engine="synapse-serverless-sql-pool"
                    id={id}
                    database={database}
                  />
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setConnOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

export default SqlAnalyticsEndpointEditor;
