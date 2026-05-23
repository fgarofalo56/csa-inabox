'use client';

import { useState } from 'react';
import {
  Title2,
  Body1,
  makeStyles,
  tokens,
  Button,
  Dropdown,
  Option,
  Textarea,
  Tab,
  TabList,
  Badge,
} from '@fluentui/react-components';
import { CloudArrowUp24Regular, Play24Filled } from '@fluentui/react-icons';

type RefreshPolicy = 'partition' | 'full' | 'directquery-fallback' | 'composite';

interface TableRefreshConfig {
  table: string;
  policy: RefreshPolicy;
  lastRefresh?: string;
  latencyMs?: number;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '16px' },
  header: { display: 'flex', alignItems: 'center', gap: '12px' },
  spacer: { flex: 1 },
  policiesTable: { width: '100%', borderCollapse: 'collapse' },
  th: {
    textAlign: 'left',
    padding: '8px',
    backgroundColor: tokens.colorNeutralBackground2,
    fontWeight: '600',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  td: { padding: '8px', borderBottom: `1px solid ${tokens.colorNeutralStroke3}` },
  daxEditor: { fontFamily: 'Cascadia Code, Consolas, monospace', minHeight: '160px' },
});

const initialTables: TableRefreshConfig[] = [
  { table: 'gold.fact_sales', policy: 'partition', lastRefresh: '2026-05-22 14:03 UTC', latencyMs: 12_400 },
  { table: 'gold.dim_customer', policy: 'full', lastRefresh: '2026-05-22 06:00 UTC', latencyMs: 88_000 },
  { table: 'gold.fact_orders', policy: 'composite', lastRefresh: '2026-05-22 14:01 UTC', latencyMs: 18_900 },
];

export function SemanticModelPane() {
  const styles = useStyles();
  const [tables, setTables] = useState(initialTables);
  const [dax, setDax] = useState(
    'EVALUATE\n    SUMMARIZECOLUMNS(\n        \'dim_customer\'[region],\n        "Total Revenue",\n        [Revenue YTD]\n    )',
  );

  function updatePolicy(table: string, policy: RefreshPolicy) {
    setTables((t) => t.map((row) => (row.table === table ? { ...row, policy } : row)));
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Title2>Semantic Model</Title2>
        <Badge color="warning">Direct Lake parity — 5-30s honest gap</Badge>
        <div className={styles.spacer} />
        <Button appearance="primary" icon={<CloudArrowUp24Regular />}>
          Deploy
        </Button>
      </div>

      <TabList defaultSelectedValue="refresh">
        <Tab value="refresh">Refresh policies</Tab>
        <Tab value="dax">DAX editor</Tab>
        <Tab value="lineage">Lineage</Tab>
      </TabList>

      <table className={styles.policiesTable}>
        <thead>
          <tr>
            <th className={styles.th}>Table</th>
            <th className={styles.th}>Refresh policy</th>
            <th className={styles.th}>Last refresh</th>
            <th className={styles.th}>Latency</th>
          </tr>
        </thead>
        <tbody>
          {tables.map((row) => (
            <tr key={row.table}>
              <td className={styles.td}>{row.table}</td>
              <td className={styles.td}>
                <Dropdown
                  size="small"
                  value={row.policy}
                  selectedOptions={[row.policy]}
                  onOptionSelect={(_, d) =>
                    updatePolicy(row.table, d.optionValue as RefreshPolicy)
                  }
                >
                  <Option value="partition">Partition (5-30s)</Option>
                  <Option value="full">Full (minutes)</Option>
                  <Option value="directquery-fallback">DirectQuery fallback</Option>
                  <Option value="composite">Composite</Option>
                </Dropdown>
              </td>
              <td className={styles.td}>{row.lastRefresh}</td>
              <td className={styles.td}>{row.latencyMs?.toLocaleString()} ms</td>
            </tr>
          ))}
        </tbody>
      </table>

      <Body1 weight="semibold">DAX editor</Body1>
      <Textarea
        className={styles.daxEditor}
        value={dax}
        onChange={(_, d) => setDax(d.value)}
        rows={8}
        spellCheck={false}
      />
      <div>
        <Button appearance="primary" icon={<Play24Filled />}>
          Test query
        </Button>
      </div>
    </div>
  );
}
