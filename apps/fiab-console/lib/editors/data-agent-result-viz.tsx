'use client';

/**
 * DataAgentResultViz — renders a data-agent tool's REAL query result
 * (columns + rows from lib/azure/data-agent-execute) as a beautiful, modern
 * "mini BI" card right in the chat: a KPI tile for single values, a chart for
 * label/numeric or time series, or a styled table — with a toggle to switch.
 *
 * Pure presentation over the rows the agent actually executed (task-008). No
 * mock data; when a source was gated, the caller renders the honest gate instead.
 */

import * as React from 'react';
import { useMemo, useState } from 'react';
import { Badge, Caption1, makeStyles, tokens, Button } from '@fluentui/react-components';
import {
  DataBarVertical20Regular, Table20Regular, NumberSymbol20Regular, DataLine20Regular,
} from '@fluentui/react-icons';
import { KqlChart, type KqlChartType } from '@/lib/components/monitor/kql-chart';

export interface VizTool {
  source: string;
  type?: string;
  executed?: boolean;
  rowCount?: number;
  columns?: string[];
  rows?: unknown[][];
}

const useStyles = makeStyles({
  card: {
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: `linear-gradient(160deg, ${tokens.colorNeutralBackground1}, ${tokens.colorNeutralBackground2})`,
    boxShadow: tokens.shadow4,
    overflow: 'hidden',
    marginTop: tokens.spacingVerticalS,
  },
  head: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    background: tokens.colorNeutralBackground3,
  },
  headTitle: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground1, fontSize: tokens.fontSizeBase200 },
  spacer: { flex: 1 },
  toggle: { display: 'inline-flex', gap: '2px' },
  body: { padding: tokens.spacingHorizontalM },
  // KPI
  kpiWrap: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalL },
  kpi: {
    display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '120px',
    padding: tokens.spacingHorizontalM, borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  kpiValue: {
    fontSize: '30px', lineHeight: '34px', fontWeight: tokens.fontWeightBold,
    color: tokens.colorBrandForeground1, fontVariantNumeric: 'tabular-nums',
  },
  kpiLabel: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, textTransform: 'uppercase', letterSpacing: '0.04em' },
  // table
  tableWrap: { overflowX: 'auto', maxHeight: '320px', overflowY: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%', fontSize: tokens.fontSizeBase200 },
  th: {
    textAlign: 'left', padding: '6px 12px 6px 0', position: 'sticky', top: 0,
    background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground3,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, whiteSpace: 'nowrap',
  },
  td: { padding: '5px 12px 5px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke3}`, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
});

type VizKind = 'kpi' | 'chart' | 'table';

function isNum(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string' && v.trim() !== '') return Number.isFinite(Number(v));
  return false;
}
function looksLikeTime(v: unknown): boolean {
  if (v instanceof Date) return true;
  if (typeof v !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(v) || !Number.isNaN(Date.parse(v)) && /[-:]/.test(v);
}
function fmt(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof v === 'string' && isNum(v)) return Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(v);
}

export function DataAgentResultViz({ tool }: { tool: VizTool }) {
  const styles = useStyles();
  const columns = tool.columns ?? [];
  const rows = tool.rows ?? [];

  const shape = useMemo(() => {
    const numericCols = columns.map((_, i) => i).filter((i) => rows.length > 0 && rows.every((r) => r[i] == null || isNum(r[i])) && rows.some((r) => isNum(r[i])));
    const firstColTime = rows.length > 1 && rows.every((r) => r[0] == null || looksLikeTime(r[0]));
    const singleValue = rows.length === 1 && numericCols.length >= 1 && columns.length <= 2;
    const chartable = numericCols.length >= 1 && columns.length >= 2 && rows.length >= 1 && rows.length <= 50 && numericCols[0] !== 0;
    return { numericCols, firstColTime, singleValue, chartable };
  }, [columns, rows]);

  const defaultKind: VizKind = shape.singleValue ? 'kpi' : shape.chartable ? 'chart' : 'table';
  const [kind, setKind] = useState<VizKind>(defaultKind);

  if (!columns.length || !rows.length) return null;

  const chartType: KqlChartType = shape.firstColTime ? 'timechart' : 'barchart';

  const TButton = ({ k, icon, label }: { k: VizKind; icon: React.ReactElement; label: string }) => (
    <Button
      size="small"
      appearance={kind === k ? 'primary' : 'subtle'}
      icon={icon}
      aria-pressed={kind === k}
      title={label}
      onClick={() => setKind(k)}
    />
  );

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <DataBarVertical20Regular style={{ color: tokens.colorBrandForeground1 }} aria-hidden />
        <span className={styles.headTitle}>{tool.source}</span>
        {tool.type && <Badge appearance="tint" size="small" color="brand">{tool.type}</Badge>}
        <Badge appearance="tint" size="small" color="success">{tool.rowCount ?? rows.length} row{(tool.rowCount ?? rows.length) === 1 ? '' : 's'}</Badge>
        <span className={styles.spacer} />
        <span className={styles.toggle}>
          {shape.singleValue && <TButton k="kpi" icon={<NumberSymbol20Regular />} label="KPI" />}
          {(shape.chartable || shape.firstColTime) && <TButton k="chart" icon={shape.firstColTime ? <DataLine20Regular /> : <DataBarVertical20Regular />} label="Chart" />}
          <TButton k="table" icon={<Table20Regular />} label="Table" />
        </span>
      </div>
      <div className={styles.body}>
        {kind === 'kpi' && (
          <div className={styles.kpiWrap}>
            {shape.numericCols.map((ci) => (
              <div key={ci} className={styles.kpi}>
                <span className={styles.kpiValue}>{fmt(rows[0][ci])}</span>
                <span className={styles.kpiLabel}>{columns[ci]}</span>
              </div>
            ))}
          </div>
        )}
        {kind === 'chart' && <KqlChart type={chartType} columns={columns} rows={rows} />}
        {kind === 'table' && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>{columns.map((c, ci) => <th key={ci} className={styles.th}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {rows.slice(0, 100).map((row, ri) => (
                  <tr key={ri}>{(Array.isArray(row) ? row : [row]).map((cell, ci) => <td key={ci} className={styles.td}>{fmt(cell)}</td>)}</tr>
                ))}
              </tbody>
            </table>
            {rows.length > 100 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Showing 100 of {tool.rowCount ?? rows.length}</Caption1>}
          </div>
        )}
      </div>
    </div>
  );
}
