'use client';

import { useState } from 'react';
import {
  Title2,
  Body1,
  makeStyles,
  tokens,
  Button,
  Textarea,
  Tab,
  TabList,
  Spinner,
} from '@fluentui/react-components';
import { Play24Filled, Save24Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' },
  header: { display: 'flex', alignItems: 'center', gap: '12px' },
  spacer: { flex: 1 },
  editor: {
    fontFamily: 'Cascadia Code, Consolas, monospace',
    minHeight: '180px',
  },
  results: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: '12px',
    borderRadius: '4px',
    minHeight: '240px',
    overflow: 'auto',
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
  th: {
    textAlign: 'left',
    padding: '6px 8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  td: { padding: '6px 8px', borderBottom: `1px solid ${tokens.colorNeutralStroke3}` },
});

interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  executionMs: number;
  engine: 'databricks-sql' | 'synapse-serverless';
}

export function WarehousePane() {
  const styles = useStyles();
  const [sql, setSql] = useState(
    "SELECT region, SUM(revenue) AS total_revenue\nFROM gold.sales\nWHERE order_date >= DATEADD(month, -3, CURRENT_DATE)\nGROUP BY region\nORDER BY total_revenue DESC",
  );
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/warehouse/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql }),
      });
      if (!res.ok) throw new Error(await res.text());
      setResult(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Title2>Warehouse</Title2>
        <div className={styles.spacer} />
        <Button appearance="primary" icon={<Play24Filled />} onClick={run} disabled={running}>
          {running ? 'Running...' : 'Run query'}
        </Button>
        <Button icon={<Save24Regular />}>Save</Button>
      </div>
      <Textarea
        className={styles.editor}
        value={sql}
        onChange={(_, d) => setSql(d.value)}
        rows={8}
        spellCheck={false}
      />
      <TabList defaultSelectedValue="results">
        <Tab value="results">Results</Tab>
        <Tab value="explain">Explain plan</Tab>
        <Tab value="history">History</Tab>
      </TabList>
      <div className={styles.results}>
        {running && <Spinner label="Executing..." />}
        {error && <Body1 style={{ color: tokens.colorPaletteRedForeground1 }}>{error}</Body1>}
        {result && (
          <>
            <Body1>
              {result.rowCount.toLocaleString()} rows · {result.executionMs} ms · engine: {result.engine}
            </Body1>
            <table className={styles.table}>
              <thead>
                <tr>
                  {result.columns.map((c) => (
                    <th key={c} className={styles.th}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.slice(0, 100).map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j} className={styles.td}>
                        {String(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
