'use client';

/**
 * Synapse Serverless SQL editor — dedicated SQL-script surface for the
 * `synapse-serverless-sql-pool` item (the lakehouse-paired SQL analytics
 * endpoint, T1/F14). One-for-one with Synapse Studio's SQL-script editor:
 *
 *   - Object explorer (Views / Procs / TVFs / External tables / Data sources)
 *   - Monaco SQL editor with column + object IntelliSense (from sys.* catalog)
 *   - Connect-to (database) dropdown
 *   - Run / Run selection (Ctrl+Enter, Ctrl+S)
 *   - Results | Messages tabbed pane (real grid + PRINT/RAISERROR + DDL receipt)
 *   - DDL templates: CREATE OR ALTER VIEW / PROCEDURE / FUNCTION (iTVF)
 *
 * Azure-native by default — no Fabric/Power BI dependency. The backend is the
 * env-bound Synapse Serverless endpoint (LOOM_SYNAPSE_WORKSPACE); when unset
 * the surface still renders and shows an honest infra-gate MessageBar.
 *
 * Note on UDFs: Synapse Serverless SQL pool does NOT support scalar UDFs —
 * only inline / multi-statement table-valued functions. The "New function"
 * template emits an iTVF and says so, per ui-parity / no-vaporware honesty.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Button, Caption1, Spinner, Tooltip, Dropdown, Option, Label,
  Tab, TabList, Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Play20Regular, ArrowDownload20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import {
  SynapseServerlessSqlObjectExplorer,
  type ObjectsResponse,
} from '@/lib/components/synapse-sql-object-explorer';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, flex: 1 },
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  connect: { display: 'flex', gap: 8, alignItems: 'center' },
  editorWrap: { minHeight: 220 },
  resultBox: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 12, minHeight: 200, display: 'flex', flexDirection: 'column', gap: 8 },
  resultMeta: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  resultActions: { marginLeft: 'auto', display: 'flex', gap: 4 },
  tableWrap: { overflow: 'auto', maxHeight: 320, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
  messages: {
    fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap',
    backgroundColor: tokens.colorNeutralBackground3, borderRadius: 4, padding: 12,
    color: tokens.colorNeutralForeground2, maxHeight: 280, overflow: 'auto', margin: 0,
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
  `-- Synapse Serverless SQL — Azure-native analytics endpoint (no Fabric needed).\n`
  + `SELECT 1 AS smoke, SYSDATETIMEOFFSET() AS server_time, SUSER_NAME() AS upn;`;

// Custom objects on a lake database must live OUTSIDE [dbo] ([dbo] is reserved
// for Spark-managed lake tables). Templates default to [reports].
const TEMPLATE_VIEW =
  `CREATE OR ALTER VIEW [reports].[vw_new] AS\n`
  + `SELECT TOP 100 *\n`
  + `FROM OPENROWSET(\n`
  + `  BULK 'https://<account>.dfs.core.windows.net/<container>/<path>/**',\n`
  + `  FORMAT = 'PARQUET'\n`
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
  + `    FORMAT = 'PARQUET'\n`
  + `  ) AS rows;\n`
  + `END;`;

const TEMPLATE_FUNC =
  `-- Synapse Serverless supports inline table-valued functions (iTVF).\n`
  + `-- Scalar UDFs are NOT supported on the serverless SQL pool.\n`
  + `CREATE OR ALTER FUNCTION [reports].[fn_new](@minValue INT)\n`
  + `RETURNS TABLE\n`
  + `AS RETURN (\n`
  + `  SELECT *\n`
  + `  FROM OPENROWSET(\n`
  + `    BULK 'https://<account>.dfs.core.windows.net/<container>/<path>/**',\n`
  + `    FORMAT = 'PARQUET'\n`
  + `  ) AS rows\n`
  + `  WHERE rows.value >= @minValue\n`
  + `);`;

// T-SQL keywords surfaced as IntelliSense keyword completions (serverless-flavored).
const TSQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'JOIN', 'INNER JOIN',
  'LEFT JOIN', 'TOP', 'DISTINCT', 'WITH', 'AS', 'CREATE OR ALTER', 'VIEW', 'PROCEDURE',
  'FUNCTION', 'EXEC', 'OPENROWSET', 'BULK', 'FORMAT', 'EXTERNAL TABLE',
  'EXTERNAL DATA SOURCE', 'EXTERNAL FILE FORMAT', 'CETAS', 'RETURNS TABLE',
];

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

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

export function SynapseServerlessSqlEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [database, setDatabase] = useState('master');
  const [databases, setDatabases] = useState<string[]>([]);
  const [endpoint, setEndpoint] = useState<string>('');
  const [configured, setConfigured] = useState(true);
  const [sqlText, setSqlText] = useState(DEFAULT_SQL);
  const [objects, setObjects] = useState<ObjectsResponse | null>(null);
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [resultTab, setResultTab] = useState<'results' | 'messages'>('results');
  const [loading, setLoading] = useState(false);

  // Editor handle + objects ref so the (once-registered) Monaco completion
  // provider can read the latest catalog without re-registering on each render.
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const objectsRef = useRef<ObjectsResponse | null>(null);
  useEffect(() => { objectsRef.current = objects; }, [objects]);

  // ── Connect-to database list (master + user DBs) ──
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/items/synapse-serverless-sql-pool/${id}/schema`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setConfigured(!!j?.endpoint || !!j?.workspace);
        setEndpoint(j?.endpoint || '');
        setDatabases(['master', ...((j?.databases as string[]) || [])]);
      })
      .catch(() => { if (!cancelled) setConfigured(false); });
    return () => { cancelled = true; };
  }, [id]);

  // ── Object explorer + IntelliSense source ──
  const loadObjects = useCallback(async () => {
    setObjectsLoading(true);
    try {
      const r = await fetch(`/api/items/synapse-serverless-sql-pool/${id}/objects?database=${encodeURIComponent(database)}`);
      const j = (await r.json()) as ObjectsResponse;
      setObjects(j);
      if (j?.gated) setConfigured(false);
    } catch {
      setObjects(null);
    } finally {
      setObjectsLoading(false);
    }
  }, [id, database]);

  useEffect(() => { loadObjects(); }, [loadObjects]);

  // ── Run (full text or selection) ──
  const runText = useCallback(async (text: string) => {
    const sqlToRun = text.trim();
    if (!sqlToRun) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`/api/items/synapse-serverless-sql-pool/${id}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sqlToRun, database }),
      });
      const json = (await res.json()) as QueryResponse;
      setResult(json);
      // DDL or error → jump to Messages; SELECT with rows → Results.
      setResultTab(json.ok && !json.isDdl && (json.rows?.length ?? 0) >= 0 && (json.columns?.length ?? 0) > 0 ? 'results' : 'messages');
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
      setResultTab('messages');
    } finally {
      setLoading(false);
    }
  }, [id, database]);

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

  // Run a DDL string directly (DROP from the explorer), then refresh.
  const runDdl = useCallback(async (ddl: string) => {
    await runText(ddl);
  }, [runText]);

  // ── Monaco IntelliSense (column + object + keyword completions) ──
  const onEditorReady = useCallback((editor: any, monaco: any) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    // Ctrl+Enter / Ctrl+S → Run (Synapse Studio parity).
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
          // Columns (flattened across all objects) — deduped by name.
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
    // Dispose on unmount (Monaco editor onDidDispose).
    editor.onDidDispose?.(() => provider.dispose());
  }, [runText]);

  // Insert SQL into the editor at the cursor (or replace selection). Falls back
  // to replacing the whole buffer if the editor handle isn't ready yet.
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
      { label: 'New', actions: [
        { label: 'New view', onClick: () => newScript(TEMPLATE_VIEW) },
        { label: 'New procedure', onClick: () => newScript(TEMPLATE_PROC) },
        { label: 'New function', onClick: () => newScript(TEMPLATE_FUNC) },
      ]},
      { label: 'Cost', actions: [
        { label: 'Bytes processed', onClick: () => newScript(
          `-- Serverless bytes-processed cost telemetry.\n`
          + `SELECT type, data_processed_mb FROM sys.dm_external_data_processed;`,
        ) },
        { label: 'Cost cap', onClick: () => newScript(
          `-- View / set the serverless cost-control (bytes) policy.\n`
          + `SELECT * FROM sys.configurations WHERE name LIKE '%cost%' OR name LIKE '%limit%';\n`
          + `-- Set a daily cap (workspace admin): EXEC sp_set_data_processed_limit @type=N'daily', @limit_TB=1;`,
        ) },
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
                <MessageBarTitle>Synapse Serverless SQL endpoint not configured</MessageBarTitle>
                Set <strong>LOOM_SYNAPSE_WORKSPACE</strong> on the Console container app
                (admin-plane bicep deploys the Synapse workspace + Serverless endpoint).
                No Microsoft Fabric or Power BI workspace is required — this is the Azure-native default.
              </MessageBarBody>
            </MessageBar>
          )}
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Serverless</Badge>
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
            <Badge appearance="outline" color={endpoint ? 'success' : 'severe'}>
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
              ariaLabel="Serverless T-SQL editor"
              onReady={onEditorReady}
            />
          </div>

          <div className={s.resultBox}>
            <TabList selectedValue={resultTab} onTabSelect={(_, d) => setResultTab(d.value as 'results' | 'messages')} size="small">
              <Tab value="results">Results</Tab>
              <Tab value="messages">Messages{result?.messages?.length ? ` (${result.messages.length})` : ''}</Tab>
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
                  <MessageBarBody>
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
        </div>
      }
    />
  );
}

export default SynapseServerlessSqlEditor;
