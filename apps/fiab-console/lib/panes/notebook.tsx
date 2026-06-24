'use client';

import { useState } from 'react';
import {
  Title2,
  makeStyles,
  tokens,
  Button,
  Textarea,
  Dropdown,
  Option,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Skeleton,
  SkeletonItem,
} from '@fluentui/react-components';
import { Add24Regular, Play24Filled, Delete24Regular, Open24Regular } from '@fluentui/react-icons';

interface Cell {
  id: string;
  kind: 'code' | 'markdown';
  language: 'python' | 'scala' | 'sql' | 'r';
  source: string;
  output?: string;
  running?: boolean;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  cell: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
    minWidth: 0,
  },
  cellHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexWrap: 'wrap',
  },
  cellSrc: {
    fontFamily: 'Cascadia Code, Consolas, monospace',
    border: 'none',
    width: '100%',
    padding: tokens.spacingVerticalM,
  },
  cellOut: {
    fontFamily: 'Cascadia Code, Consolas, monospace',
    fontSize: '13px',
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground3,
    borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    overflow: 'auto',
    maxWidth: '100%',
    maxHeight: '420px',
    margin: 0,
  },
  cellRunning: {
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground3,
    borderTop: `1px solid ${tokens.colorNeutralStroke3}`,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  cellError: {
    fontFamily: 'Cascadia Code, Consolas, monospace',
    fontSize: '13px',
    padding: tokens.spacingVerticalM,
    backgroundColor: tokens.colorStatusDangerBackground1,
    borderTop: `1px solid ${tokens.colorStatusDangerBorder1}`,
    color: tokens.colorStatusDangerForeground1,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    overflow: 'auto',
    maxWidth: '100%',
    maxHeight: '420px',
    margin: 0,
  },
});

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export function NotebookPane() {
  const styles = useStyles();
  const [cells, setCells] = useState<Cell[]>([
    {
      id: uid(),
      kind: 'code',
      language: 'python',
      source: '# Read bronze.orders into a Spark DataFrame\ndf = spark.read.table("bronze.orders")\ndf.show(5)',
    },
  ]);

  function addCell() {
    setCells((c) => [...c, { id: uid(), kind: 'code', language: 'python', source: '' }]);
  }

  function updateCell(id: string, patch: Partial<Cell>) {
    setCells((c) => c.map((cell) => (cell.id === id ? { ...cell, ...patch } : cell)));
  }

  function deleteCell(id: string) {
    setCells((c) => c.filter((cell) => cell.id !== id));
  }

  async function runCell(cell: Cell) {
    updateCell(cell.id, { running: true });
    try {
      const res = await fetch('/api/notebook/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: cell.language, source: cell.source }),
      });
      const data = await res.json().catch(() => ({}));
      // The generic scratchpad route honest-gates (501) and names the real
      // per-language compute route. Surface that clearly instead of a bare error.
      const out = data.output
        ?? (data.remediation
          ? `${data.error}\n\n${data.remediation.message}\n→ ${data.remediation.route}`
          : data.error)
        ?? `HTTP ${res.status}`;
      updateCell(cell.id, { output: out, running: false });
    } catch (e) {
      updateCell(cell.id, { output: String(e), running: false });
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Title2>Notebook</Title2>
        <div className={styles.spacer} />
        <Button appearance="primary" icon={<Add24Regular />} onClick={addCell}>
          Add cell
        </Button>
      </div>

      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Quick scratchpad</MessageBarTitle>
          This is a lightweight cell scratchpad. Cell execution routes to the compute that owns the
          language (Spark → Databricks/Synapse, SQL → warehouse, KQL → KQL database) — Run reports the
          exact route. For full kernel sessions, attached compute, and saved notebooks open a{' '}
          <a href="/items" style={{ color: tokens.colorBrandForeground1 }}>
            <Open24Regular style={{ verticalAlign: 'middle' }} /> Databricks/Synapse notebook
          </a>{' '}from the catalog.
        </MessageBarBody>
      </MessageBar>

      {cells.map((cell) => (
        <div key={cell.id} className={styles.cell}>
          <div className={styles.cellHeader}>
            <Dropdown
              size="small"
              value={cell.language}
              selectedOptions={[cell.language]}
              onOptionSelect={(_, d) =>
                updateCell(cell.id, { language: d.optionValue as Cell['language'] })
              }
            >
              <Option value="python">Python</Option>
              <Option value="scala">Scala</Option>
              <Option value="sql">SQL</Option>
              <Option value="r">R</Option>
            </Dropdown>
            <div style={{ flex: 1 }} />
            <Button
              size="small"
              icon={<Play24Filled />}
              appearance="primary"
              onClick={() => runCell(cell)}
              disabled={cell.running}
            >
              {cell.running ? 'Running...' : 'Run'}
            </Button>
            <Button
              size="small"
              icon={<Delete24Regular />}
              appearance="transparent"
              onClick={() => deleteCell(cell.id)}
              aria-label="Delete cell"
            />
          </div>
          <Textarea
            className={styles.cellSrc}
            value={cell.source}
            onChange={(_, d) => updateCell(cell.id, { source: d.value })}
            rows={6}
            spellCheck={false}
          />
          {cell.running ? (
            <div className={styles.cellRunning}>
              <Skeleton aria-label="Cell running…">
                <SkeletonItem shape="rectangle" style={{ width: '75%', height: 14 }} />
                <SkeletonItem shape="rectangle" style={{ width: '55%', height: 14 }} />
                <SkeletonItem shape="rectangle" style={{ width: '40%', height: 14 }} />
              </Skeleton>
            </div>
          ) : cell.output ? (
            cell.output.startsWith('Error') || cell.output.startsWith('HTTP 4') || cell.output.startsWith('HTTP 5')
              ? <pre className={styles.cellError}>{cell.output}</pre>
              : <pre className={styles.cellOut}>{cell.output}</pre>
          ) : null}
        </div>
      ))}
    </div>
  );
}
