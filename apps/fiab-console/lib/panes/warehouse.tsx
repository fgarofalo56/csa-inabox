'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Title2,
  Body1,
  Caption1,
  makeStyles,
  tokens,
  Button,
  Tab,
  TabList,
  Spinner,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
} from '@fluentui/react-components';
import { Play24Filled, Flowchart24Regular } from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { setCopilotContext } from '@/lib/components/copilot-pane';
import { extractSqlTableNames } from '@/lib/azure/copilot-personas';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' },
  header: { display: 'flex', alignItems: 'center', gap: '12px' },
  actions: { display: 'flex', alignItems: 'center', gap: '8px' },
  spacer: { flex: 1 },
  editorWrap: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
  },
  resultsPane: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '12px',
    minHeight: '240px',
    overflow: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  plan: {
    fontFamily: 'Cascadia Code, Consolas, monospace',
    fontSize: '12px',
    whiteSpace: 'pre-wrap',
    overflow: 'auto',
    margin: 0,
  },
  meta: { color: tokens.colorNeutralForeground3 },
});

interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  durationMs?: number;
  executionMs?: number;
  engine?: string;
}

interface HistoryEntry {
  request_id: string;
  status: string;
  command: string;
  total_elapsed_time: number;
  submit_time: string;
  login_name: string;
}

type PaneTab = 'results' | 'explain' | 'history';

const SAMPLE_SQL =
  '-- Fabric Warehouse parity — backed by the Synapse Dedicated SQL pool (no Microsoft Fabric required).\n' +
  'SELECT region, SUM(revenue) AS total_revenue\n' +
  'FROM gold.sales\n' +
  "WHERE order_date >= DATEADD(month, -3, GETUTCDATE())\n" +
  'GROUP BY region\n' +
  'ORDER BY total_revenue DESC;';

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function WarehousePane() {
  const styles = useStyles();
  const [sql, setSql] = useState(SAMPLE_SQL);
  const [activeTab, setActiveTab] = useState<PaneTab>('results');

  // Results tab state
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Explain plan tab state
  const [planXml, setPlanXml] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  // History tab state — real sys.dm_pdw_exec_requests rows from the live pool.
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // Feed the global Copilot pane warehouse-persona context so its suggested
  // prompts reference the real tables in the live SQL draft (e.g. "Preview
  // gold.sales") rather than generic placeholders.
  useEffect(() => {
    setCopilotContext({
      persona: 'warehouse',
      tableNames: extractSqlTableNames(sql),
      currentSqlSnippet: sql.slice(0, 200),
    });
  }, [sql]);

  const run = useCallback(async () => {
    setActiveTab('results');
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/warehouse/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        // Honest gate / SQL error message from the real Synapse backend.
        setError(j?.error || `HTTP ${res.status}`);
        return;
      }
      setResult(j as QueryResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [sql]);

  const explain = useCallback(async () => {
    setActiveTab('explain');
    setPlanning(true);
    setPlanError(null);
    setPlanXml(null);
    try {
      const res = await fetch('/api/warehouse/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        setPlanError(j?.error || `HTTP ${res.status}`);
        return;
      }
      setPlanXml((j?.planXml as string) || '');
    } catch (e) {
      setPlanError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanning(false);
    }
  }, [sql]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await fetch('/api/warehouse/history');
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        setHistoryError(j?.error || `HTTP ${res.status}`);
        setHistory(null);
        return;
      }
      // The DMV result comes back as { columns, rows } — map to typed objects.
      const cols: string[] = j?.columns || [];
      const rows: unknown[][] = j?.rows || [];
      const idx = (name: string) => cols.indexOf(name);
      const mapped: HistoryEntry[] = rows.map((r) => ({
        request_id: String(r[idx('request_id')] ?? ''),
        status: String(r[idx('status')] ?? ''),
        command: String(r[idx('command')] ?? ''),
        total_elapsed_time: Number(r[idx('total_elapsed_time')] ?? 0),
        submit_time: String(r[idx('submit_time')] ?? ''),
        login_name: String(r[idx('login_name')] ?? ''),
      }));
      setHistory(mapped);
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : String(e));
      setHistory(null);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // Lazy-load history the first time the tab is opened (and refreshable).
  useEffect(() => {
    if (activeTab === 'history' && history === null && !historyLoading && !historyError) {
      loadHistory();
    }
  }, [activeTab, history, historyLoading, historyError, loadHistory]);

  // Build LoomDataTable columns from the real result column names.
  const resultColumns: LoomColumn<{ __i: number; cells: unknown[] }>[] = useMemo(() => {
    if (!result) return [];
    return result.columns.map((c, ci) => ({
      key: `c${ci}`,
      label: c,
      getValue: (row) => formatCell(row.cells[ci]),
      render: (row) => formatCell(row.cells[ci]),
    }));
  }, [result]);

  const resultRows = useMemo(
    () => (result ? result.rows.slice(0, 500).map((cells, i) => ({ __i: i, cells })) : []),
    [result],
  );

  const historyColumns: LoomColumn<HistoryEntry>[] = useMemo(
    () => [
      { key: 'submit_time', label: 'Submitted', width: 180 },
      { key: 'status', label: 'Status', width: 110, filterType: 'select' },
      { key: 'login_name', label: 'User', width: 160 },
      { key: 'total_elapsed_time', label: 'Elapsed (ms)', width: 120, getValue: (r) => r.total_elapsed_time },
      { key: 'command', label: 'Command', width: 360 },
    ],
    [],
  );

  const durationMs = result ? result.durationMs ?? result.executionMs : undefined;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Title2>Warehouse</Title2>
        <div className={styles.spacer} />
        <div className={styles.actions}>
          <Button
            appearance="secondary"
            icon={<Flowchart24Regular />}
            onClick={explain}
            disabled={planning || running}
          >
            {planning ? 'Explaining…' : 'Explain plan'}
          </Button>
          <Button appearance="primary" icon={<Play24Filled />} onClick={run} disabled={running}>
            {running ? 'Running…' : 'Run query'}
          </Button>
        </div>
      </div>

      <div className={styles.editorWrap}>
        <MonacoTextarea
          value={sql}
          onChange={setSql}
          language="tsql"
          height={240}
          ariaLabel="Warehouse T-SQL editor"
        />
      </div>

      <TabList selectedValue={activeTab} onTabSelect={(_e, d) => setActiveTab(d.value as PaneTab)}>
        <Tab value="results">Results</Tab>
        <Tab value="explain">Explain plan</Tab>
        <Tab value="history">History</Tab>
      </TabList>

      <div className={styles.resultsPane}>
        {/* RESULTS */}
        {activeTab === 'results' && (
          <>
            {running && <Spinner label="Executing…" />}
            {error && (
              <MessageBar intent="error">
                <MessageBarBody>
                  <MessageBarTitle>Query failed</MessageBarTitle>
                  {error}
                </MessageBarBody>
              </MessageBar>
            )}
            {!running && !error && !result && (
              <Caption1 className={styles.meta}>
                Write T-SQL above and select Run query to execute it against the Synapse Dedicated SQL pool.
              </Caption1>
            )}
            {result && (
              <>
                <Body1 className={styles.meta}>
                  {result.rowCount.toLocaleString()} rows
                  {typeof durationMs === 'number' ? ` · ${durationMs} ms` : ''}
                  {result.engine ? ` · engine: ${result.engine}` : ''}
                </Body1>
                <LoomDataTable
                  columns={resultColumns}
                  rows={resultRows}
                  getRowId={(r) => String(r.__i)}
                  ariaLabel="Query results"
                  empty="Query returned no rows."
                />
              </>
            )}
          </>
        )}

        {/* EXPLAIN PLAN */}
        {activeTab === 'explain' && (
          <>
            {planning && <Spinner label="Generating execution plan…" />}
            {planError && (
              <MessageBar intent="error">
                <MessageBarBody>
                  <MessageBarTitle>Explain plan failed</MessageBarTitle>
                  {planError}
                </MessageBarBody>
              </MessageBar>
            )}
            {!planning && !planError && planXml === null && (
              <MessageBar intent="info">
                <MessageBarBody>
                  Select Explain plan to generate the estimated execution plan
                  (EXPLAIN WITH_RECOMMENDATIONS) for the current statement.
                </MessageBarBody>
              </MessageBar>
            )}
            {planXml !== null && planXml !== '' && <pre className={styles.plan}>{planXml}</pre>}
            {planXml === '' && !planning && !planError && (
              <Caption1 className={styles.meta}>The pool returned an empty plan for this statement.</Caption1>
            )}
          </>
        )}

        {/* HISTORY */}
        {activeTab === 'history' && (
          <>
            <div className={styles.header}>
              <Caption1 className={styles.meta}>Recent requests from sys.dm_pdw_exec_requests (last hour).</Caption1>
              <div className={styles.spacer} />
              <Button size="small" appearance="secondary" onClick={loadHistory} disabled={historyLoading}>
                {historyLoading ? 'Refreshing…' : 'Refresh'}
              </Button>
            </div>
            {historyError && (
              <MessageBar intent="error">
                <MessageBarBody>
                  <MessageBarTitle>Could not load history</MessageBarTitle>
                  {historyError}
                </MessageBarBody>
              </MessageBar>
            )}
            {!historyError && (
              <LoomDataTable
                columns={historyColumns}
                rows={history ?? []}
                getRowId={(r) => r.request_id}
                loading={historyLoading}
                ariaLabel="Warehouse query history"
                empty="No recent queries in the last hour."
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
