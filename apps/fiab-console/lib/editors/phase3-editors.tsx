'use client';

/**
 * Phase 3 editors — Real-Time Intelligence, Data Warehouse, Power BI.
 *
 * v2.1 KQL family (Eventhouse, KQL Database, KQL Queryset, KQL Dashboard,
 * Eventstream) are wired live against the shared Loom ADX cluster
 * `adx-csa-loom-shared.eastus2.kusto.windows.net` via the Console UAMI
 * (Kusto raw REST: /v1/rest/query + /v1/rest/mgmt, ARM for database
 * create). Eventstream persists pipeline config to Cosmos; runtime
 * wiring lands in v3.
 *
 * Warehouse is real-REST (Fabric Warehouse over Synapse Dedicated pool).
 *
 * v2.1 Power BI / Fabric family — Semantic model, Report, Dashboard,
 * Paginated report, Scorecard, and Activator — are now wired against
 * live Power BI REST (api.powerbi.com/v1.0/myorg) and Fabric REST
 * (api.fabric.microsoft.com/v1) via the Console UAMI. If the UAMI's SP
 * is not yet registered in the Power BI tenant or hasn't been added to
 * a workspace, the editors surface the underlying 401/403 verbatim with
 * a remediation hint — no mock data is shown.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { getItem, createItem, type WorkspaceItem } from '@/lib/api/workspaces';
import type { WarehouseContent } from '@/lib/apps/content-bundles/types';
import {
  Subtitle2, Caption1, Badge, Button, Input, Spinner, Field,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Tooltip,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Label, Select, Textarea, Switch, Checkbox, ProgressBar, SpinButton,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular, Folder20Regular,
  Save20Regular, Add20Regular, Delete20Regular, ArrowSync20Regular,
  MathFormula20Regular, Table20Regular, DatabaseLink20Regular,
  Flowchart20Regular,
  Apps20Regular, List20Regular, Open20Regular,
  Sparkle16Regular, Info16Regular, Wrench16Regular,
  Warning20Regular, ErrorCircle20Regular, CheckmarkCircle20Regular, Info20Regular,
} from '@fluentui/react-icons';
import { AdxDatabaseTree } from '@/lib/components/adx/adx-database-tree';
import { IngestionMappingWizardDialog } from '@/lib/components/adx/ingestion-mapping-wizard';
import {
  ColumnGridDesigner, toKustoSchema, parseKustoSchema, validateColumns,
  type ColumnDef,
} from '@/lib/components/adx/column-grid-designer';
import {
  SchemaDiagramCanvas,
  type SchemaGraphNode, type SchemaGraphEdge, type SchemaNodeKind,
} from '@/lib/components/adx/schema-diagram-canvas';
import { KustoResultsGrid } from '@/lib/components/adx/kusto-results-grid';
import { PowerBiTree } from '@/lib/components/powerbi/powerbi-tree';
import { ManageAccessPanel, EndorsementControl, GatewayDatasourcesPanel } from '@/lib/components/powerbi/powerbi-governance';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { PowerBIEmbedFrame } from '@/lib/components/embed/powerbi-embed';
import { ComputePicker } from '@/lib/components/compute-picker';
import {
  VisualDesigner as EventstreamVisualDesigner,
  type PipelineConfig as VisualPipelineConfig,
  type SourceNode as VisualSourceNode,
  type TransformNode as VisualTransformNode,
  type SinkNode as VisualSinkNode,
} from '@/lib/components/eventstream/visual-designer';
import { EventHubsNamespaceTree } from '@/lib/components/eventhubs/eventhubs-tree';
import {
  evalConditionalRules,
  CF_OPERATORS, CF_COLORS, CF_ICONS, CF_THEMES,
  type ConditionalRule, type CfCondition, type CfMatch,
  type CfColor, type CfIcon, type CfOperator, type CfTheme,
} from '@/lib/azure/kql-dashboard-model';

const useStyles = makeStyles({
  monaco: {
    width: '100%',
    minHeight: '180px',
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: '13px',
    padding: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  pad: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  toolbar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  card: {
    padding: '12px', border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '6px', backgroundColor: tokens.colorNeutralBackground1,
  },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' },
  tabBar: { padding: '8px 16px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  resultBox: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 12, minHeight: 180 },
  resultMeta: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 },
  tableWrap: { overflow: 'auto', maxHeight: 320, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
  treePad: { padding: 8 },
  assistBar: {
    display: 'flex', gap: '6px', padding: '4px 8px', alignItems: 'center',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  assistResult: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: '12px',
    whiteSpace: 'pre-wrap', margin: 0, overflowX: 'auto',
  },
});

// ============================================================
// Shared KQL results panel
// ============================================================
interface KqlVisualization {
  Visualization?: string;
  Title?: string;
  [k: string]: unknown;
}

interface KqlResult {
  ok: boolean;
  columns?: string[];
  columnTypes?: string[];
  rows?: unknown[][];
  rowCount?: number;
  executionMs?: number;
  truncated?: boolean;
  error?: string;
  database?: string;
  mode?: 'query' | 'mgmt';
  /** Parsed `| render` hint from the cluster (drives auto-chart selection). */
  visualization?: KqlVisualization;
}

/**
 * Map a Kusto `render` visualization name to a Loom TileViz. Mirrors the chart
 * family the ADX web UI auto-renders. Grounded in Learn (render operator
 * visualizations). Unknown/empty → 'table'.
 */
function vizFromRender(name?: string): TileViz {
  switch ((name || '').toLowerCase()) {
    case 'timechart': return 'timechart';
    case 'linechart': return 'line';
    case 'areachart': // area renders as a line series here
    case 'stackedareachart': return 'line';
    case 'columnchart': return 'column';
    case 'barchart': return 'bar';
    case 'piechart': return 'pie';
    case 'scatterchart': return 'map'; // geo scatter → point map; non-geo falls back below
    case 'card': return 'stat';
    default: return 'table';
  }
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---- Conditional-formatting render helpers (Fabric RTD parity) ----
// Map a CfColor bucket to Fluent palette tokens (bg + readable fg). The model's
// pure evaluator returns the *semantic* color; the renderer owns the theme.
const CF_COLOR_TOKENS: Record<CfColor, { bg: string; fg: string }> = {
  red: { bg: tokens.colorPaletteRedBackground2, fg: tokens.colorPaletteRedForeground2 },
  yellow: { bg: tokens.colorPaletteYellowBackground2, fg: tokens.colorPaletteYellowForeground2 },
  green: { bg: tokens.colorPaletteGreenBackground2, fg: tokens.colorPaletteGreenForeground2 },
  blue: { bg: tokens.colorPaletteBlueBackground2, fg: tokens.colorPaletteBlueForeground2 },
};

function cfIconEl(icon: CfIcon | undefined): JSX.Element | null {
  switch (icon) {
    case 'warning': return <Warning20Regular />;
    case 'error': return <ErrorCircle20Regular />;
    case 'success': return <CheckmarkCircle20Regular />;
    case 'info': return <Info20Regular />;
    default: return null;
  }
}

/** Resolve a CfMatch into concrete CSS bg/fg + icon element + tag/hideText. */
function cfDecoration(match: CfMatch): { bg: string; fg: string; icon: JSX.Element | null; tag?: string; hideText?: boolean; applyTo: 'cells' | 'row'; targetColumn?: string; cellColumns?: string[] } {
  let bg: string;
  let fg: string;
  if (match.bg) {
    // value-rule gradient (precomputed CSS)
    bg = match.bg;
    fg = match.fg || tokens.colorNeutralForeground1;
  } else {
    const t = CF_COLOR_TOKENS[match.color || 'red'];
    if (match.style === 'light') {
      bg = t.bg;
      fg = tokens.colorNeutralForeground1;
    } else {
      bg = t.bg;
      fg = t.fg;
    }
  }
  return { bg, fg, icon: cfIconEl(match.icon), tag: match.tag, hideText: match.hideText, applyTo: match.applyTo, targetColumn: match.targetColumn, cellColumns: match.cellColumns };
}

/** Per-column numeric min/max across the result, for color-by-value auto-scale. */
function computeColStats(columns: string[], rows: unknown[][]): Record<string, { min: number; max: number }> {
  const out: Record<string, { min: number; max: number }> = {};
  for (let c = 0; c < columns.length; c++) {
    let min = Infinity, max = -Infinity, seen = false;
    for (const r of rows) {
      const n = Number(r[c]);
      if (Number.isFinite(n) && r[c] !== '' && r[c] !== null) { seen = true; if (n < min) min = n; if (n > max) max = n; }
    }
    if (seen) out[columns[c]] = { min, max };
  }
  return out;
}

// Dashboard tile visual types — superset that matches the ADX `render`
// operator visualizations exposed by Fabric Real-Time Dashboards.
type TileViz = 'table' | 'timechart' | 'line' | 'bar' | 'column' | 'pie' | 'stat' | 'map';

const PIE_COLORS = [
  tokens.colorBrandBackground,
  tokens.colorPaletteGreenBackground3,
  tokens.colorPalettePurpleBackground2,
  tokens.colorPaletteYellowBackground3,
  tokens.colorPaletteRedBackground3,
  tokens.colorPaletteBlueBackground2,
  tokens.colorPaletteTealBackground2,
  tokens.colorPaletteMarigoldBackground3,
];

function pickNumericCol(columns: string[], rows: unknown[][]): number {
  for (let c = 0; c < columns.length; c++) {
    if (rows.some((r) => typeof r[c] === 'number' || (!isNaN(Number(r[c])) && r[c] !== '' && r[c] !== null))) return c;
  }
  return -1;
}

/** Single big-number KPI card (ADX `card` / Fabric "stat" visual). */
function StatCard({ columns, rows, conditionalRules }: { columns: string[]; rows: unknown[][]; conditionalRules?: ConditionalRule[] }) {
  const numericColIdx = pickNumericCol(columns, rows);
  const cellIdx = numericColIdx >= 0 ? numericColIdx : 0;
  const raw = rows[0]?.[cellIdx];
  const num = Number(raw);
  const display = Number.isFinite(num) && raw !== '' && raw !== null ? num.toLocaleString() : fmtCell(raw);
  // Conditional formatting decorates the whole card from the first row.
  const stats = useMemo(() => computeColStats(columns, rows), [columns, rows]);
  const match = evalConditionalRules(conditionalRules, rows[0] || [], columns, stats);
  const deco = match ? cfDecoration(match) : undefined;
  return (
    <div role="img" aria-label="stat card" style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      padding: 16, minHeight: 120, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6,
      background: deco?.bg ?? tokens.colorNeutralBackground1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {deco?.icon && <span style={{ display: 'inline-flex', color: deco.fg ?? tokens.colorBrandForeground1 }}>{deco.icon}</span>}
        <div style={{ fontSize: 40, fontWeight: 700, color: deco?.fg ?? tokens.colorBrandForeground1, lineHeight: 1.1 }}>{display}</div>
      </div>
      <Caption1 style={{ color: deco?.fg ?? tokens.colorNeutralForeground3 }}>{columns[cellIdx] || 'value'}</Caption1>
      {deco?.tag && <Caption1 style={{ color: deco.fg ?? tokens.colorNeutralForeground3, fontStyle: 'italic' }}>{deco.tag}</Caption1>}
    </div>
  );
}

/** Pie chart (ADX `piechart`). First category col + first numeric col. */
function PieChart({ columns, rows, onValueClick }: { columns: string[]; rows: unknown[][]; onValueClick?: (label: string) => void }) {
  const numericColIdx = pickNumericCol(columns, rows);
  if (numericColIdx < 0) return <Caption1>No numeric column to chart.</Caption1>;
  const labelColIdx = columns.findIndex((_, c) => c !== numericColIdx);
  const data = rows.slice(0, 12).map((r, i) => ({
    label: labelColIdx >= 0 ? fmtCell(r[labelColIdx]) : String(i + 1),
    value: Math.max(0, Number(r[numericColIdx]) || 0),
  }));
  const total = data.reduce((a, d) => a + d.value, 0) || 1;
  const cx = 120, cy = 120, r = 100;
  let acc = 0;
  const arcs = data.map((d, i) => {
    const start = (acc / total) * Math.PI * 2;
    acc += d.value;
    const end = (acc / total) * Math.PI * 2;
    const large = end - start > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.sin(start), y1 = cy - r * Math.cos(start);
    const x2 = cx + r * Math.sin(end), y2 = cy - r * Math.cos(end);
    return { path: `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`, color: PIE_COLORS[i % PIE_COLORS.length], ...d };
  });
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg width={240} height={240} viewBox="0 0 240 240" role="img" aria-label="pie chart">
        {arcs.map((a, i) => <path key={i} d={a.path} fill={a.color} stroke={tokens.colorNeutralBackground1} strokeWidth={1}
          style={onValueClick ? { cursor: 'pointer' } : undefined}
          onClick={onValueClick ? () => onValueClick(a.label) : undefined}><title>{`${a.label}: ${a.value.toLocaleString()}${onValueClick ? ' (click to drill through)' : ''}`}</title></path>)}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {arcs.map((a, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, background: a.color, borderRadius: 2, display: 'inline-block' }} />
            <Caption1>{a.label}: {a.value.toLocaleString()} ({Math.round((a.value / total) * 100)}%)</Caption1>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Point map (ADX geo `scatterchart` / Fabric map visual). Plots
 * latitude/longitude columns on an equirectangular projection. Honest: if no
 * lat/long columns are present it shows a clear message rather than an empty box.
 */
function MapVisual({ columns, rows }: { columns: string[]; rows: unknown[][] }) {
  const latIdx = columns.findIndex((c) => /lat(itude)?$/i.test(c));
  const lonIdx = columns.findIndex((c) => /^(lon|lng|long(itude)?)$/i.test(c));
  if (latIdx < 0 || lonIdx < 0) {
    return <Caption1>Map needs `latitude`/`longitude` columns (got: {columns.join(', ') || 'none'}).</Caption1>;
  }
  const W = 480, H = 240;
  const proj = (lat: number, lon: number) => ({ x: ((lon + 180) / 360) * W, y: ((90 - lat) / 180) * H });
  const pts = rows.slice(0, 500)
    .map((r) => ({ lat: Number(r[latIdx]), lon: Number(r[lonIdx]) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="point map"
      style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, background: tokens.colorNeutralBackground2 }}>
      <rect x={0} y={0} width={W} height={H} fill="none" stroke={tokens.colorNeutralStroke2} />
      {pts.map((p, i) => { const { x, y } = proj(p.lat, p.lon); return <circle key={i} cx={x} cy={y} r={3} fill={tokens.colorBrandBackground} opacity={0.75}><title>{`${p.lat}, ${p.lon}`}</title></circle>; })}
    </svg>
  );
}

/**
 * Lightweight dependency-free SVG chart for KQL/dashboard results.
 * Picks the first string-ish column as the X axis (category) and the first
 * numeric column as the Y series — same default ADX "Render" applies.
 * `kind`: 'bar' = horizontal bars, 'column' = vertical bars, 'line'/'timechart' = line.
 */
function ResultChart({ columns, rows, kind, onValueClick }: { columns: string[]; rows: unknown[][]; kind: 'bar' | 'column' | 'line' | 'timechart'; onValueClick?: (label: string) => void }) {
  const numericColIdx = useMemo(() => pickNumericCol(columns, rows), [columns, rows]);
  const labelColIdx = useMemo(() => {
    for (let c = 0; c < columns.length; c++) { if (c !== numericColIdx) return c; }
    return numericColIdx === 0 ? -1 : 0;
  }, [columns, numericColIdx]);

  if (numericColIdx < 0) {
    return <Caption1>No numeric column to chart. Switch to the table view.</Caption1>;
  }
  const isHorizontal = kind === 'bar';
  const isVerticalBars = kind === 'column';
  const isLine = kind === 'line' || kind === 'timechart';
  const data = rows.slice(0, 50).map((r, i) => ({
    label: labelColIdx >= 0 ? fmtCell(r[labelColIdx]) : String(i + 1),
    value: Number(r[numericColIdx]) || 0,
  }));
  const W = 640, H = 240, padL = 64, padB = 36, padT = 12, padR = 12;
  const maxV = Math.max(1, ...data.map((d) => d.value));
  const minV = Math.min(0, ...data.map((d) => d.value));
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const x = (i: number) => padL + (data.length <= 1 ? plotW / 2 : (i * plotW) / (data.length - 1));
  const xBar = (i: number) => padL + (i * plotW) / data.length;
  const y = (v: number) => padT + plotH - ((v - minV) / (maxV - minV || 1)) * plotH;
  const barW = Math.max(2, (plotW / data.length) * 0.7);

  // Horizontal bar layout (one row per category).
  if (isHorizontal) {
    const rowH = Math.max(10, Math.min(28, plotH / data.length));
    const xVal = (v: number) => padL + ((v - minV) / (maxV - minV || 1)) * plotW;
    return (
      <svg width="100%" viewBox={`0 0 ${W} ${Math.max(H, padT + data.length * rowH + padB)}`} role="img" aria-label="bar chart"
        style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, background: tokens.colorNeutralBackground1 }}>
        {data.map((d, i) => (
          <g key={i}>
            <rect x={padL} y={padT + i * rowH + 2} width={Math.max(0, xVal(d.value) - padL)} height={rowH - 4} fill={tokens.colorBrandBackground}
              style={onValueClick ? { cursor: 'pointer' } : undefined}
              onClick={onValueClick ? () => onValueClick(d.label) : undefined}>
              <title>{`${d.label}: ${d.value.toLocaleString()}${onValueClick ? ' (click to drill through)' : ''}`}</title>
            </rect>
            <text x={padL - 6} y={padT + i * rowH + rowH / 2 + 3} fontSize="9" textAnchor="end" fill={tokens.colorNeutralForeground3}>
              {d.label.length > 12 ? d.label.slice(0, 12) + '…' : d.label}
            </text>
          </g>
        ))}
      </svg>
    );
  }

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${kind} chart`} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, background: tokens.colorNeutralBackground1 }}>
      <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke={tokens.colorNeutralStroke2} />
      <line x1={padL} y1={padT} x2={padL} y2={padT + plotH} stroke={tokens.colorNeutralStroke2} />
      <text x={padL - 6} y={y(maxV)} fontSize="10" textAnchor="end" fill={tokens.colorNeutralForeground3}>{maxV.toLocaleString()}</text>
      <text x={padL - 6} y={y(minV)} fontSize="10" textAnchor="end" fill={tokens.colorNeutralForeground3}>{minV.toLocaleString()}</text>
      {isVerticalBars
        ? data.map((d, i) => (
            <rect key={i} x={xBar(i) + (plotW / data.length - barW) / 2} y={y(d.value)} width={barW}
              height={Math.max(0, padT + plotH - y(d.value))} fill={tokens.colorBrandBackground}
              style={onValueClick ? { cursor: 'pointer' } : undefined}
              onClick={onValueClick ? () => onValueClick(d.label) : undefined}>
              <title>{`${d.label}: ${d.value.toLocaleString()}${onValueClick ? ' (click to drill through)' : ''}`}</title>
            </rect>
          ))
        : (
          <polyline fill="none" stroke={tokens.colorBrandBackground} strokeWidth="2"
            points={data.map((d, i) => `${x(i)},${y(d.value)}`).join(' ')} />
        )}
      {isLine && data.map((d, i) => (
        <circle key={i} cx={x(i)} cy={y(d.value)} r="3" fill={tokens.colorBrandBackground}
          style={onValueClick ? { cursor: 'pointer' } : undefined}
          onClick={onValueClick ? () => onValueClick(d.label) : undefined}>
          <title>{`${d.label}: ${d.value.toLocaleString()}${onValueClick ? ' (click to drill through)' : ''}`}</title>
        </circle>
      ))}
      {data.map((d, i) => (
        (data.length <= 12 || i % Math.ceil(data.length / 12) === 0) && (
          <text key={`x${i}`} x={isVerticalBars ? xBar(i) + (plotW / data.length) / 2 : x(i)} y={H - padB + 16}
            fontSize="9" textAnchor="middle" fill={tokens.colorNeutralForeground3}>
            {d.label.length > 10 ? d.label.slice(0, 10) + '…' : d.label}
          </text>
        )
      ))}
    </svg>
  );
}

/** Render any tile result by its visual type — table / charts / stat / pie / map. */
function TileVisual({
  viz, result, conditionalRules, drillthrough, onDrillthrough,
}: {
  viz: TileViz;
  result: KqlResult;
  /** Per-tile conditional-formatting rules (table/stat cells). */
  conditionalRules?: ConditionalRule[];
  /** When set + the named column exists, data values become click targets. */
  drillthrough?: { column: string; paramName: string };
  /** Fired with (paramName, clickedValue) when a value is clicked. */
  onDrillthrough?: (paramName: string, value: string) => void;
}) {
  const columns = result.columns || [];
  const rows = result.rows || [];
  if (rows.length === 0) return <Caption1>No rows.</Caption1>;
  const dtActive = !!(drillthrough?.column && drillthrough?.paramName && onDrillthrough);
  const fire = (value: string) => { if (dtActive) onDrillthrough!(drillthrough!.paramName, value); };
  // Chart visuals key off the X-axis label (the first non-numeric column),
  // which is the natural drill-through dimension; the table keys off the
  // configured column explicitly.
  const chartClick = dtActive ? (label: string) => fire(label) : undefined;
  switch (viz) {
    case 'stat': {
      const cellIdx = pickNumericCol(columns, rows);
      const statVal = fmtCell(rows[0]?.[cellIdx >= 0 ? cellIdx : 0]);
      return (
        <div
          style={dtActive ? { cursor: 'pointer' } : undefined}
          onClick={dtActive ? () => fire(statVal) : undefined}
          title={dtActive ? `Drill through: ${drillthrough!.column} → ${drillthrough!.paramName}` : undefined}
        >
          <StatCard columns={columns} rows={rows} conditionalRules={conditionalRules} />
        </div>
      );
    }
    case 'pie':
      return <PieChart columns={columns} rows={rows} onValueClick={chartClick} />;
    case 'map':
      return <MapVisual columns={columns} rows={rows} />;
    case 'bar':
    case 'column':
    case 'line':
    case 'timechart':
      return <ResultChart columns={columns} rows={rows} kind={viz} onValueClick={chartClick} />;
    case 'table':
    default: {
      const dtCol = dtActive ? drillthrough!.column : undefined;
      return (
        <ConditionalTable
          columns={columns}
          rows={rows}
          conditionalRules={conditionalRules}
          drillColumn={dtCol}
          onDrill={dtActive ? (value) => fire(value) : undefined}
        />
      );
    }
  }
}

/**
 * Result table with conditional formatting applied per row/cell (Fabric RTD
 * "color by condition" / "color by value"). Without rules it renders exactly
 * like the prior plain table.
 */
function ConditionalTable({ columns, rows, conditionalRules, drillColumn, onDrill }: { columns: string[]; rows: unknown[][]; conditionalRules?: ConditionalRule[]; drillColumn?: string; onDrill?: (value: string) => void }) {
  const stats = useMemo(() => computeColStats(columns, rows), [columns, rows]);
  const hasRules = Array.isArray(conditionalRules) && conditionalRules.length > 0;
  const drillIdx = drillColumn && onDrill ? columns.findIndex((c) => c === drillColumn) : -1;
  const drillActive = drillIdx >= 0 && !!onDrill;
  return (
    <div style={{ maxHeight: 200, overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 }}>
      <Table aria-label="tile result" size="small">
        <TableHeader><TableRow>{columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
        <TableBody>
          {rows.slice(0, 100).map((row, i) => {
            const match = hasRules ? evalConditionalRules(conditionalRules, row, columns, stats) : undefined;
            const deco = match ? cfDecoration(match) : undefined;
            const rowBg = deco?.applyTo === 'row' ? deco.bg : undefined;
            const rowFg = deco?.applyTo === 'row' ? deco.fg : undefined;
            return (
              <TableRow
                key={i}
                style={{ ...(rowBg ? { backgroundColor: rowBg } : {}), ...(drillActive ? { cursor: 'pointer' } : {}) }}
                onClick={drillActive ? () => onDrill!(fmtCell(row[drillIdx])) : undefined}
                title={drillActive ? `Drill through: ${fmtCell(row[drillIdx])}` : undefined}
              >
                {columns.map((col, j) => {
                  const inCellTarget = deco && deco.applyTo === 'cells' && (
                    deco.targetColumn ? deco.targetColumn === col : (deco.cellColumns ? deco.cellColumns.includes(col) : true)
                  );
                  const cellMatch = inCellTarget ? deco : undefined;
                  const bg = cellMatch ? cellMatch.bg : rowBg;
                  const fg = cellMatch ? cellMatch.fg : rowFg;
                  const showIcon = !!cellMatch?.icon;
                  const hideText = cellMatch?.hideText;
                  return (
                    <TableCell key={j} style={{ fontFamily: 'Consolas, monospace', fontSize: 11, whiteSpace: 'nowrap', backgroundColor: bg, color: fg }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {showIcon && <span style={{ display: 'inline-flex', color: fg }}>{cellMatch!.icon}</span>}
                        {!hideText && fmtCell(row[j])}
                        {cellMatch?.tag && <span style={{ fontStyle: 'italic', opacity: 0.85 }}>{cellMatch.tag}</span>}
                      </span>
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

// Full chart family the ADX web UI exposes, plus Table. The picker switches the
// active visual; the cluster's `| render` hint chooses the default.
const KQL_VIZ_CHOICES: { value: TileViz; label: string }[] = [
  { value: 'table', label: 'Table' },
  { value: 'timechart', label: 'Time chart' },
  { value: 'line', label: 'Line' },
  { value: 'column', label: 'Column' },
  { value: 'bar', label: 'Bar' },
  { value: 'pie', label: 'Pie' },
  { value: 'stat', label: 'Card' },
  { value: 'map', label: 'Map' },
];

function KqlResultsPanel({ result, loading }: { result: KqlResult | null; loading: boolean }) {
  const s = useStyles();
  // Default visual follows the cluster's `| render` annotation; the user can
  // override with the chart picker. Re-derive whenever a new result arrives.
  const renderViz = vizFromRender(result?.visualization?.Visualization);
  const [viz, setViz] = useState<TileViz>('table');
  const [userPicked, setUserPicked] = useState(false);
  const lastKeyRef = useRef<string>('');
  useEffect(() => {
    if (!result?.ok) return;
    // A fresh result (new row count + first column + render hint) resets to the
    // render default so a `| render piechart` query opens as a pie, like ADX.
    const key = `${result.rowCount ?? 0}|${(result.columns || []).join(',')}|${result.visualization?.Visualization || ''}`;
    if (key !== lastKeyRef.current) {
      lastKeyRef.current = key;
      setViz(renderViz);
      setUserPicked(false);
    }
  }, [result, renderViz]);

  if (loading) {
    return <div className={s.resultBox}><Spinner size="small" label="Executing KQL…" labelPosition="after" /></div>;
  }
  if (!result) {
    return <div className={s.resultBox}><Caption1>Click <strong>Run</strong> to execute. Results appear here.</Caption1></div>;
  }
  if (!result.ok) {
    return (
      <div className={s.resultBox}>
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Query failed</MessageBarTitle>
            {result.error || 'Unknown error'}
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }
  const rows = result.rows || [];
  const columns = result.columns || [];
  const renderName = result.visualization?.Visualization;
  const vizTitle = result.visualization?.Title;
  return (
    <div className={s.resultBox}>
      <div className={s.resultMeta}>
        <Badge appearance="filled" color="success">{result.rowCount ?? rows.length} rows</Badge>
        <Caption1>· {result.executionMs} ms</Caption1>
        {result.mode === 'mgmt' && <Badge appearance="outline">mgmt</Badge>}
        {renderName && <Badge appearance="outline" color="brand" title="from the query's | render operator">render: {renderName}</Badge>}
        {result.truncated && <Badge appearance="outline" color="warning">truncated at 5,000</Badge>}
        {rows.length > 0 && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, flexWrap: 'wrap' }} role="tablist" aria-label="Result view">
            {KQL_VIZ_CHOICES.map((v) => (
              <Button key={v.value} size="small" appearance={viz === v.value ? 'primary' : 'subtle'}
                onClick={() => { setViz(v.value); setUserPicked(true); }} aria-pressed={viz === v.value}>
                {v.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      {vizTitle && viz !== 'table' && <Caption1 style={{ fontWeight: 600 }}>{vizTitle}</Caption1>}
      {!userPicked && renderName && viz !== 'table' && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Auto-rendered from <code>| render {renderName}</code>. Switch views above.
        </Caption1>
      )}
      {rows.length === 0 ? (
        <Caption1>Query returned no rows.</Caption1>
      ) : viz !== 'table' ? (
        <TileVisual viz={viz} result={result} />
      ) : (
        <KustoResultsGrid
          columns={columns}
          columnTypes={result.columnTypes}
          rows={rows}
          totalRowCount={result.rowCount}
          exportName={`kql-${result.database || 'results'}`}
        />
      )}
    </div>
  );
}

// ----- Eventhouse -----
// Ribbon is built inside the editor via useMemo so actions have real
// onClick bindings (see no-vaporware.md: dead ribbons get disabled with
// a "not yet wired" tooltip rather than rendering enabled-but-broken).

interface EventhouseDb {
  name: string;
  prettyName?: string;
  persistentStorage?: string;
  totalSizeMb?: number;
  retentionDays?: number;
  hotCacheDays?: number;
  tableCount?: number;
}

interface EventhouseState {
  ok: boolean;
  cluster?: string;
  defaultDatabase?: string;
  databases?: EventhouseDb[];
  sku?: { name: string; tier: string; capacity?: number };
  optimizedAutoscale?: {
    isEnabled: boolean;
    minimum: number;
    maximum: number;
    version: number;
  } | null;
  error?: string;
}

// ----- Eventhouse Capacity / throttle panel -----
// Azure-native default: the shared Azure Data Explorer cluster IS the
// eventhouse capacity backend (no Fabric / OneLake). Reads the live capacity
// policy + slot utilization from `.show cluster policy capacity` / `.show
// capacity`, layers Azure Monitor throttle metrics on top, and writes the
// ingestion capacity policy back via `.alter-merge cluster policy capacity`.
// See app/api/items/eventhouse/[id]/capacity/route.ts.

interface CapacitySlot {
  resource: string;
  total: number;
  consumed: number;
  remaining: number;
  origin: string;
}
interface CapacityMetricPoint { timeStamp: string; value: number | null }
interface CapacityMetric { name: string; unit: string; aggregation: string; points: CapacityMetricPoint[] }
interface CapacityResponse {
  ok: boolean;
  error?: string;
  configGate?: string;
  kustoClusterArmId?: string;
  capacityPolicy?: Record<string, any>;
  liveCapacity?: CapacitySlot[];
  metrics?: CapacityMetric[];
  metricsGate?: string;
}

/** Sum every point in a metric series (for Total-aggregated throttle counts). */
function metricSum(metrics: CapacityMetric[] | undefined, name: string): number | null {
  const m = metrics?.find((x) => x.name === name);
  if (!m) return null;
  let any = false;
  let total = 0;
  for (const p of m.points) {
    if (typeof p.value === 'number') { total += p.value; any = true; }
  }
  return any ? total : null;
}

/** Latest non-null point in a metric series (for util/CPU gauges). */
function metricLatest(metrics: CapacityMetric[] | undefined, name: string): number | null {
  const m = metrics?.find((x) => x.name === name);
  if (!m) return null;
  for (let i = m.points.length - 1; i >= 0; i--) {
    if (typeof m.points[i].value === 'number') return m.points[i].value as number;
  }
  return null;
}

function utilColor(pct: number): string {
  if (pct >= 90) return tokens.colorPaletteRedForeground1;
  if (pct >= 70) return tokens.colorPaletteDarkOrangeForeground1;
  return tokens.colorPaletteGreenForeground1;
}

export function EventhouseCapacityPanel({ id }: { id: string }) {
  const s = useStyles();
  const [data, setData] = useState<CapacityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Editable ingestion capacity policy fields.
  const [editMaxOps, setEditMaxOps] = useState<number>(512);
  const [editCoreCoeff, setEditCoreCoeff] = useState<number>(0.75);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ ok: boolean; applied?: string; effectivePolicy?: string; error?: string } | null>(null);

  const loadCapacity = useCallback(async () => {
    if (!id || id === 'new') return;
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/capacity`);
      const j = (await r.json()) as CapacityResponse;
      setData(j);
      const ing = j.capacityPolicy?.IngestionCapacity;
      if (ing) {
        if (typeof ing.ClusterMaximumConcurrentOperations === 'number') setEditMaxOps(ing.ClusterMaximumConcurrentOperations);
        if (typeof ing.CoreUtilizationCoefficient === 'number') setEditCoreCoeff(ing.CoreUtilizationCoefficient);
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadCapacity(); }, [loadCapacity]);

  const applyCapacityPolicy = useCallback(async () => {
    setApplying(true);
    setApplyResult(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/capacity`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          patch: {
            IngestionCapacity: {
              ClusterMaximumConcurrentOperations: Math.floor(editMaxOps),
              CoreUtilizationCoefficient: editCoreCoeff,
            },
          },
        }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      setApplyResult(j);
      if (j.ok) loadCapacity();
    } catch (e: any) {
      setApplyResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setApplying(false);
    }
  }, [id, editMaxOps, editCoreCoeff, loadCapacity]);

  if (loading && !data) return <Spinner size="small" label="Loading capacity policy…" />;
  if (err) {
    return (
      <MessageBar intent="error">
        <MessageBarBody><MessageBarTitle>Capacity unavailable</MessageBarTitle>{err}</MessageBarBody>
      </MessageBar>
    );
  }
  if (data && !data.ok) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody>
          <MessageBarTitle>Azure Data Explorer not configured</MessageBarTitle>
          {data.error || 'ADX cluster unreachable.'}
        </MessageBarBody>
      </MessageBar>
    );
  }
  if (!data) return null;

  const policy = data.capacityPolicy || {};
  const ingestion = (policy.IngestionCapacity || {}) as Record<string, any>;
  const exportCap = (policy.ExportCapacity || {}) as Record<string, any>;
  const slots = data.liveCapacity || [];
  const ingestionSlot = slots.find((x) => x.resource === 'ingestions');
  const throttledQueries = metricSum(data.metrics, 'TotalNumberOfThrottledQueries');
  const throttledCommands = metricSum(data.metrics, 'TotalNumberOfThrottledCommands');
  const ingestUtil = metricLatest(data.metrics, 'IngestionUtilization');
  const cacheUtil = metricLatest(data.metrics, 'CacheUtilizationFactor');
  const cpu = metricLatest(data.metrics, 'CPU');
  const concurrentQueries = metricLatest(data.metrics, 'TotalNumberOfConcurrentQueries');

  const throttleActive =
    (ingestionSlot?.remaining === 0) ||
    (typeof throttledQueries === 'number' && throttledQueries > 0) ||
    (typeof throttledCommands === 'number' && throttledCommands > 0);

  const gaugeCards: { label: string; value: number | null; pct?: boolean }[] = [
    { label: 'Ingestion utilization', value: ingestUtil, pct: true },
    { label: 'Cache utilization', value: cacheUtil, pct: true },
    { label: 'CPU', value: cpu, pct: true },
    { label: 'Concurrent queries', value: concurrentQueries },
    { label: 'Throttled queries (15m)', value: throttledQueries },
    { label: 'Throttled commands (15m)', value: throttledCommands },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Section 1 — Throttle state */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Subtitle2>Throttle state</Subtitle2>
        <Badge appearance="filled" color={throttleActive ? 'danger' : 'success'}>
          {throttleActive ? 'Throttled' : 'Healthy'}
        </Badge>
        <Button appearance="outline" size="small" icon={<ArrowSync20Regular />} onClick={loadCapacity}>Refresh</Button>
        {ingestionSlot && (
          <Caption1>
            Ingestion slots — consumed {ingestionSlot.consumed} / {ingestionSlot.total} ({ingestionSlot.remaining} remaining), origin {ingestionSlot.origin || 'n/a'}
          </Caption1>
        )}
      </div>

      {data.metricsGate && (
        <MessageBar intent="warning">
          <MessageBarBody><MessageBarTitle>Live metrics gated</MessageBarTitle>{data.metricsGate}</MessageBarBody>
        </MessageBar>
      )}

      {/* Live throttle / utilization gauges (Azure Monitor) */}
      <div className={s.cardGrid}>
        {gaugeCards.map((g) => {
          const has = typeof g.value === 'number';
          const display = !has ? '—' : g.pct ? `${Math.round(g.value as number)}%` : String(Math.round(g.value as number));
          const pct = g.pct && has ? Math.max(0, Math.min(100, g.value as number)) : undefined;
          return (
            <div key={g.label} className={s.card}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{g.label}</Caption1>
              <div style={{ fontSize: 22, fontWeight: 600, color: pct !== undefined ? utilColor(pct) : undefined }}>{display}</div>
              {pct !== undefined && (
                <ProgressBar value={pct / 100} thickness="large" color={pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'success'} />
              )}
            </div>
          );
        })}
      </div>

      {/* Section 2 — Capacity slots (.show capacity) */}
      <div>
        <Subtitle2>Capacity slots</Subtitle2>
        <Caption1 style={{ display: 'block', marginBottom: 8 }}>
          Live cluster slot utilization across every data-management operation type (from <code>.show capacity</code>).
        </Caption1>
        {slots.length === 0 && <Caption1>No capacity rows returned.</Caption1>}
        {slots.length > 0 && (
          <div className={s.tableWrap}>
            <Table size="small" aria-label="Cluster capacity slots">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Resource</TableHeaderCell>
                  <TableHeaderCell>Total</TableHeaderCell>
                  <TableHeaderCell>Consumed</TableHeaderCell>
                  <TableHeaderCell>Remaining</TableHeaderCell>
                  <TableHeaderCell>Utilization</TableHeaderCell>
                  <TableHeaderCell>Origin</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slots.map((slot) => {
                  const util = slot.total > 0 ? Math.round((slot.consumed / slot.total) * 100) : 0;
                  return (
                    <TableRow key={slot.resource}>
                      <TableCell>{slot.resource}</TableCell>
                      <TableCell>{slot.total}</TableCell>
                      <TableCell>{slot.consumed}</TableCell>
                      <TableCell>{slot.remaining}</TableCell>
                      <TableCell>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 120 }}>
                          <ProgressBar value={util / 100} color={util >= 90 ? 'error' : util >= 70 ? 'warning' : 'success'} style={{ flex: 1 }} />
                          <span style={{ color: utilColor(util) }}>{util}%</span>
                        </div>
                      </TableCell>
                      <TableCell>{slot.origin || '—'}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Section 3 — Ingestion capacity policy (editable) */}
      <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Subtitle2>Ingestion capacity policy</Subtitle2>
        <Caption1>
          Caps total concurrent ingestion operations. Effective slots ={' '}
          <code>Minimum(ClusterMaximumConcurrentOperations, nodes × max(1, cores × CoreUtilizationCoefficient))</code>.
          Applied via <code>.alter-merge cluster policy capacity</code> — changes can take up to an hour to take effect.
          Microsoft recommends consulting support before changing capacity.
        </Caption1>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Field label="ClusterMaximumConcurrentOperations" hint="Hard cap on concurrent ingestions (long).">
            <Input
              type="number"
              value={String(editMaxOps)}
              onChange={(_: unknown, d: any) => setEditMaxOps(Math.max(1, parseInt(d.value, 10) || 1))}
            />
          </Field>
          <Field label="CoreUtilizationCoefficient" hint="Fraction of cores used in the formula (0–1, real).">
            <Input
              type="number"
              step={0.05}
              min={0}
              max={1}
              value={String(editCoreCoeff)}
              onChange={(_: unknown, d: any) => {
                const n = parseFloat(d.value);
                setEditCoreCoeff(Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
              }}
            />
          </Field>
        </div>
        <div>
          <Button appearance="primary" icon={<Save20Regular />} onClick={applyCapacityPolicy} disabled={applying}>
            {applying ? 'Applying…' : 'Apply ingestion policy'}
          </Button>
        </div>
        {applyResult && (
          <MessageBar intent={applyResult.ok ? 'success' : 'error'}>
            <MessageBarBody>
              <MessageBarTitle>{applyResult.ok ? 'Capacity policy applied' : 'Apply failed'}</MessageBarTitle>
              {applyResult.ok
                ? <span style={{ fontFamily: 'Consolas, monospace', fontSize: 12, wordBreak: 'break-all' }}>
                    {applyResult.applied}
                    {applyResult.effectivePolicy ? ` → ${applyResult.effectivePolicy.slice(0, 300)}` : ''}
                  </span>
                : applyResult.error}
            </MessageBarBody>
          </MessageBar>
        )}
      </div>

      {/* Section 4 — Export capacity (read-only) */}
      <div className={s.card}>
        <Subtitle2>Export capacity</Subtitle2>
        <Caption1 style={{ display: 'block' }}>
          ClusterMaximumConcurrentOperations: <strong>{exportCap.ClusterMaximumConcurrentOperations ?? '—'}</strong>
          {'  ·  '}CoreUtilizationCoefficient: <strong>{exportCap.CoreUtilizationCoefficient ?? '—'}</strong>
        </Caption1>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          Read-only here. Use <code>.alter-merge cluster policy capacity</code> with an <code>ExportCapacity</code> patch to tune export concurrency.
        </Caption1>
      </div>

      {/* Section 5 — Per-DB CU% honest-gate */}
      <MessageBar intent="info">
        <MessageBarBody>
          <MessageBarTitle>Per-database CU% usage</MessageBarTitle>
          Per-database CU% is a Microsoft Fabric capacity-billing concept (F/P SKU) that does not exist on the
          Azure-native ADX backend — on the shared cluster, capacity is pooled at the cluster level. The Capacity
          slots table above shows cluster-wide slot utilization across all databases. Set
          <code> LOOM_KUSTO_FABRIC_MANAGED=true</code> only if you have opted into a Fabric-managed eventhouse.
        </MessageBarBody>
      </MessageBar>

      {/* Section 6 — Mission-critical exempt honest-gate */}
      <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Subtitle2>Mission-critical exempt</Subtitle2>
        <Switch checked={false} disabled label="Exempt from capacity throttling (not applicable to ADX)" />
        <MessageBar intent="warning">
          <MessageBarBody>
            Mission-critical exempt is a workspace-level Microsoft Fabric capacity setting (requires a Fabric F or P
            SKU). It has no equivalent in the Azure Data Explorer cluster capacity policy — the shared cluster has no
            exempt toggle. No action is required.
          </MessageBarBody>
        </MessageBar>
      </div>
    </div>
  );
}

/** Human-readable size from a megabyte count (KB / MB / GB / TB). */
function fmtDbSize(mb?: number): string {
  if (typeof mb !== 'number' || !Number.isFinite(mb)) return '—';
  if (mb < 1) return `${(mb * 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  if (gb < 1024) return `${gb.toFixed(1)} GB`;
  return `${(gb / 1024).toFixed(2)} TB`;
}

type EhTimespan = 'PT1H' | 'P1D' | 'P7D' | 'P30D';
type EhTab = 'overview' | 'databases' | 'capacity';

interface EhOverviewData {
  ok: boolean;
  cluster?: string;
  timespan?: string;
  diagnostics?: {
    isHealthy: boolean;
    isScaleOutRequired: boolean;
    machinesTotal: number;
    machinesOffline: number;
    extentsTotal: number;
    totalOriginalDataSizeBytes: number;
    totalExtentSizeBytes: number;
    ingestionsLoadFactor: number;
    ingestionsInProgress: number;
    ingestionsSuccessRate: number;
  } | null;
  capacity?: { ingestions: { total: number; consumed: number; remaining: number } } | null;
  databases?: Array<{
    name: string;
    totalOriginalSizeBytes: number | null;
    totalExtentSizeBytes: number | null;
    hotDataSizeBytes: number | null;
    rowCount: number | null;
  }>;
  topQueriedDbs?: Array<{ database: string; queryCount: number }>;
  topUsers?: Array<{ user: string; queryCount: number }>;
  monitor?: {
    ingestionLatencyAvgSec: number | null;
    queryDurationAvgMs: number | null;
    cpuAvgPct: number | null;
    ingestionUtilPct: number | null;
    ingestionVolumeTotalMb: number | null;
    throttledCommandsTotal: number | null;
    throttledQueriesTotal: number | null;
  } | null;
  monitorGate?: string;
  error?: string;
}

interface EhJournalEntry {
  event: string;
  eventTimestamp: string;
  database: string;
  entityName: string;
  updatedEntityName: string;
  changeCommand: string;
  principal: string;
}

/** Bytes → human GB/MB string for the storage tiles. */
function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

const EH_TIMESPAN_LABEL: Record<EhTimespan, string> = {
  PT1H: '1H', P1D: '1D', P7D: '7D', P30D: '30D',
};

/** Small labelled metric tile used across the overview storage + monitor rows. */
function EhStatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{
      padding: 14, minHeight: 92, border: `1px solid ${tokens.colorNeutralStroke2}`,
      borderRadius: 6, background: tokens.colorNeutralBackground1, display: 'flex',
      flexDirection: 'column', gap: 2,
    }}>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{label}</Caption1>
      <div style={{ fontSize: 26, fontWeight: 700, color: tokens.colorBrandForeground1, lineHeight: 1.15 }}>{value}</div>
      {hint && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{hint}</Caption1>}
    </div>
  );
}

/**
 * Eventhouse system-overview dashboard — Fabric RTI Eventhouse "system overview"
 * parity rendered over the live ADX cluster. State indicator, storage breakdown,
 * per-db storage bar chart, time-range filter, ingestion/throttle Monitor tiles,
 * top-queried/users grids, and the schema-change journal. All data comes from the
 * /overview + /journal BFF routes — no mocks.
 */
function EventhouseOverviewPanel({
  s, overview, journal, timespan, loading, err, onTimespan, onRefresh,
}: {
  s: ReturnType<typeof useStyles>;
  overview: EhOverviewData | null;
  journal: EhJournalEntry[] | null;
  timespan: EhTimespan;
  loading: boolean;
  err: string | null;
  onTimespan: (ts: EhTimespan) => void;
  onRefresh: () => void;
}) {
  const diag = overview?.diagnostics || null;
  const dbs = overview?.databases || [];
  const mon = overview?.monitor || null;
  const cap = overview?.capacity || null;

  const compressionRatio =
    diag && diag.totalExtentSizeBytes > 0
      ? diag.totalOriginalDataSizeBytes / diag.totalExtentSizeBytes
      : null;
  const hotTotalBytes = dbs.reduce((a, d) => a + (d.hotDataSizeBytes ?? 0), 0);

  const chartRows: unknown[][] = dbs
    .filter((d) => (d.totalExtentSizeBytes ?? 0) > 0)
    .sort((a, b) => (b.totalExtentSizeBytes ?? 0) - (a.totalExtentSizeBytes ?? 0))
    .slice(0, 20)
    .map((d) => [d.name, Math.round((d.totalExtentSizeBytes ?? 0) / 1024 / 1024)]);

  return (
    <div className={s.pad} style={{ paddingTop: 12 }}>
      {/* time-range filter strip */}
      <div className={s.toolbar}>
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Time range</Caption1>
        {(['PT1H', 'P1D', 'P7D', 'P30D'] as EhTimespan[]).map((ts) => (
          <Button
            key={ts}
            size="small"
            appearance={timespan === ts ? 'primary' : 'outline'}
            onClick={() => onTimespan(ts)}
          >
            {EH_TIMESPAN_LABEL[ts]}
          </Button>
        ))}
        <Button
          size="small"
          appearance="outline"
          icon={<ArrowSync20Regular />}
          onClick={onRefresh}
          disabled={loading}
          style={{ marginLeft: 8 }}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
        {diag && (
          <Badge
            appearance="filled"
            color={diag.isHealthy ? 'success' : 'danger'}
            style={{ marginLeft: 'auto' }}
          >
            {diag.isHealthy ? 'Healthy' : 'Unhealthy'}
          </Badge>
        )}
        {diag && (
          <Caption1>
            Nodes: {diag.machinesTotal} ({diag.machinesOffline} offline) · Extents: {diag.extentsTotal.toLocaleString()}
            {diag.isScaleOutRequired ? ' · scale-out recommended' : ''}
          </Caption1>
        )}
      </div>

      {loading && !overview && <Spinner size="small" label="Loading system overview…" />}
      {err && (
        <MessageBar intent="error">
          <MessageBarBody>{err}</MessageBarBody>
        </MessageBar>
      )}
      {overview && !overview.ok && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Overview unavailable</MessageBarTitle>
            {overview.error || 'Unknown error'}
          </MessageBarBody>
        </MessageBar>
      )}

      {overview?.ok && (
        <>
          {/* storage breakdown */}
          <Subtitle2>Storage</Subtitle2>
          <div className={s.cardGrid}>
            <EhStatTile
              label="Original (uncompressed)"
              value={fmtBytes(diag?.totalOriginalDataSizeBytes)}
            />
            <EhStatTile
              label="Compressed (on disk)"
              value={fmtBytes(diag?.totalExtentSizeBytes)}
              hint={compressionRatio ? `${compressionRatio.toFixed(1)}× compression` : undefined}
            />
            <EhStatTile
              label="Hot cache (SSD)"
              value={fmtBytes(hotTotalBytes)}
              hint="sum across databases"
            />
            <EhStatTile
              label="Ingestion capacity"
              value={cap ? `${cap.ingestions.consumed}/${cap.ingestions.total}` : '—'}
              hint={cap ? `${cap.ingestions.remaining} concurrent slots free` : 'concurrent ingestions'}
            />
          </div>

          {/* per-db storage bar chart */}
          <Subtitle2>Storage by database (compressed MB)</Subtitle2>
          <div className={s.card}>
            {chartRows.length > 0 ? (
              <ResultChart columns={['Database', 'Compressed (MB)']} rows={chartRows} kind="bar" />
            ) : (
              <Caption1>No per-database storage reported yet for this cluster.</Caption1>
            )}
          </div>

          {/* ingestion + Monitor tiles */}
          <Subtitle2>Ingestion &amp; query health ({EH_TIMESPAN_LABEL[timespan]})</Subtitle2>
          {overview.monitorGate ? (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Azure Monitor metrics gated</MessageBarTitle>
                {overview.monitorGate}
              </MessageBarBody>
            </MessageBar>
          ) : null}
          <div className={s.cardGrid}>
            <EhStatTile
              label="Ingestions in progress"
              value={diag ? diag.ingestionsInProgress.toLocaleString() : '—'}
              hint={diag ? `load factor ${diag.ingestionsLoadFactor}` : undefined}
            />
            <EhStatTile
              label="Ingestion success rate"
              value={diag ? `${diag.ingestionsSuccessRate}%` : '—'}
            />
            <EhStatTile
              label="Ingested volume"
              value={mon?.ingestionVolumeTotalMb != null ? `${mon.ingestionVolumeTotalMb.toLocaleString(undefined, { maximumFractionDigits: 1 })} MB` : '—'}
              hint="Azure Monitor · total"
            />
            <EhStatTile
              label="Ingest latency"
              value={mon?.ingestionLatencyAvgSec != null ? `${mon.ingestionLatencyAvgSec.toFixed(1)} s` : '—'}
              hint="Azure Monitor · avg"
            />
            <EhStatTile
              label="Query duration"
              value={mon?.queryDurationAvgMs != null ? `${Math.round(mon.queryDurationAvgMs).toLocaleString()} ms` : '—'}
              hint="Azure Monitor · avg"
            />
            <EhStatTile
              label="Throttled commands"
              value={mon?.throttledCommandsTotal != null ? mon.throttledCommandsTotal.toLocaleString() : '—'}
              hint={mon?.throttledQueriesTotal != null ? `${mon.throttledQueriesTotal.toLocaleString()} throttled queries` : 'Azure Monitor · total'}
            />
          </div>

          {/* top queried dbs + top users */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
            <div className={s.card}>
              <Subtitle2>Top databases by query count</Subtitle2>
              <div className={s.tableWrap} style={{ marginTop: 8 }}>
                <Table size="small" aria-label="Top queried databases">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Database</TableHeaderCell>
                      <TableHeaderCell>Queries</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(overview.topQueriedDbs || []).map((r, i) => (
                      <TableRow key={`${r.database}-${i}`}>
                        <TableCell className={s.cell}>{r.database || '(unknown)'}</TableCell>
                        <TableCell className={s.cell}>{r.queryCount.toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                    {(overview.topQueriedDbs || []).length === 0 && (
                      <TableRow><TableCell className={s.cell}>No queries in this window.</TableCell><TableCell /></TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
            <div className={s.card}>
              <Subtitle2>Top users by query count</Subtitle2>
              <div className={s.tableWrap} style={{ marginTop: 8 }}>
                <Table size="small" aria-label="Top users">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>User</TableHeaderCell>
                      <TableHeaderCell>Queries</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(overview.topUsers || []).map((r, i) => (
                      <TableRow key={`${r.user}-${i}`}>
                        <TableCell className={s.cell}>{r.user || '(unknown)'}</TableCell>
                        <TableCell className={s.cell}>{r.queryCount.toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                    {(overview.topUsers || []).length === 0 && (
                      <TableRow><TableCell className={s.cell}>No queries in this window.</TableCell><TableCell /></TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>

          {/* schema-change journal */}
          <Subtitle2>Schema-change log</Subtitle2>
          <div className={s.tableWrap}>
            <Table size="small" aria-label="Schema-change journal">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Timestamp</TableHeaderCell>
                  <TableHeaderCell>Event</TableHeaderCell>
                  <TableHeaderCell>Database</TableHeaderCell>
                  <TableHeaderCell>Entity</TableHeaderCell>
                  <TableHeaderCell>Change command</TableHeaderCell>
                  <TableHeaderCell>Principal</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(journal || []).slice(0, 50).map((j, i) => (
                  <TableRow key={`${j.eventTimestamp}-${i}`}>
                    <TableCell className={s.cell}>{j.eventTimestamp}</TableCell>
                    <TableCell className={s.cell}>{j.event}</TableCell>
                    <TableCell className={s.cell}>{j.database}</TableCell>
                    <TableCell className={s.cell}>{j.updatedEntityName || j.entityName}</TableCell>
                    <TableCell className={s.cell} title={j.changeCommand}>
                      {j.changeCommand.length > 60 ? `${j.changeCommand.slice(0, 60)}…` : j.changeCommand}
                    </TableCell>
                    <TableCell className={s.cell}>{j.principal}</TableCell>
                  </TableRow>
                ))}
                {(!journal || journal.length === 0) && (
                  <TableRow>
                    <TableCell className={s.cell}>No metadata changes recorded.</TableCell>
                    <TableCell /><TableCell /><TableCell /><TableCell /><TableCell />
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}

export function EventhouseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const router = useRouter();
  const [state, setState] = useState<EventhouseState | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedDb, setSelectedDb] = useState<string>('');
  const [getDataOpen, setGetDataOpen] = useState(false);
  const [getDataMode, setGetDataMode] = useState<'file' | 'eventhub' | 'onelake'>('file');
  const [getDataBusy, setGetDataBusy] = useState(false);
  const [getDataResult, setGetDataResult] = useState<{ ok?: boolean; error?: string; tableName?: string; rows?: number } | null>(null);
  const [getDataTable, setGetDataTable] = useState('');
  const [getDataFile, setGetDataFile] = useState<File | null>(null);
  const [getDataHubName, setGetDataHubName] = useState('');
  const [getDataConsumer, setGetDataConsumer] = useState('$Default');
  const [getDataOneLakePath, setGetDataOneLakePath] = useState('');
  const [getDataFormat, setGetDataFormat] = useState<'auto' | 'csv' | 'json' | 'multijson' | 'parquet'>('auto');
  // ARM-populated Event Hub pickers (from /api/eventhubs/{hubs,consumergroups}).
  const [ehHubs, setEhHubs] = useState<string[]>([]);
  const [ehHubsErr, setEhHubsErr] = useState<string | null>(null);
  const [ehHubsLoading, setEhHubsLoading] = useState(false);
  const [ehConsumerGroups, setEhConsumerGroups] = useState<string[]>(['$Default']);
  const [ehCgLoading, setEhCgLoading] = useState(false);
  // Loom medallion container quick-pick (from /api/loom/storage-paths).
  const [loomContainers, setLoomContainers] = useState<Array<{ label: string; url: string }>>([]);
  // Schema preview before commit.
  const [schemaPreview, setSchemaPreview] = useState<{ columns: string[]; sampleRows: string[][]; detectedFormat?: string; sampleRowCount?: number } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [policiesOpen, setPoliciesOpen] = useState(false);
  const [hotCacheDays, setHotCacheDays] = useState<number>(7);
  const [softDeleteDays, setSoftDeleteDays] = useState<number>(30);
  const [oneLakeEnabled, setOneLakeEnabled] = useState<boolean>(false);
  const [streamingEnabled, setStreamingEnabled] = useState<boolean>(false);
  const [policiesBusy, setPoliciesBusy] = useState(false);
  const [policiesErr, setPoliciesErr] = useState<string | null>(null);
  // Bind Delta source → ADX external table + query acceleration (lakehouse endpoint).
  const [deltaOpen, setDeltaOpen] = useState(false);
  const [deltaTableName, setDeltaTableName] = useState('');
  const [deltaAbfss, setDeltaAbfss] = useState('');
  const [deltaHotDays, setDeltaHotDays] = useState<number>(7);
  const [deltaKqlView, setDeltaKqlView] = useState<boolean>(true);
  const [deltaBusy, setDeltaBusy] = useState(false);
  const [deltaResult, setDeltaResult] = useState<{
    ok?: boolean; error?: string; hint?: string;
    externalTableName?: string; accelerationPolicy?: unknown;
    kqlViewName?: string; sampleQuery?: string;
    steps?: Array<{ step: string; ok: boolean; detail?: string }>;
  } | null>(null);
  // Purge dialog state — GDPR record erasure (ADX two-step .purge).
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeTableList, setPurgeTableList] = useState<Array<{ name: string }>>([]);
  const [purgeTable, setPurgeTable] = useState('');
  const [purgeColumns, setPurgeColumns] = useState<Array<{ name: string; type: string }>>([]);
  const [purgePredicates, setPurgePredicates] = useState<Array<{ column: string; op: string; value: string }>>([{ column: '', op: '==', value: '' }]);
  const [purgeStep, setPurgeStep] = useState<'idle' | 'verified' | 'done'>('idle');
  const [purgeVerifyResult, setPurgeVerifyResult] = useState<{ numRecordsToPurge: number; estimatedPurgeExecutionTime: string; verificationToken: string } | null>(null);
  const [purgeCommitResult, setPurgeCommitResult] = useState<{ operationId: string; state: string; postPurgeCount: number | null } | null>(null);
  const [purgeConfirmText, setPurgeConfirmText] = useState('');
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeErr, setPurgeErr] = useState<string | null>(null);
  // Databases browser: tile/list view toggle + delete confirmation flow.
  const [dbView, setDbView] = useState<'tile' | 'list'>('tile');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  // Cluster-level optimized auto-scale (ARM PATCH /clusters)
  const [autoscaleOpen, setAutoscaleOpen] = useState(false);
  const [autoscaleEnabled, setAutoscaleEnabled] = useState<boolean>(false);
  const [autoscaleMin, setAutoscaleMin] = useState<number>(2);
  const [autoscaleMax, setAutoscaleMax] = useState<number>(10);
  const [autoscaleBusy, setAutoscaleBusy] = useState(false);
  const [autoscaleResult, setAutoscaleResult] = useState<{ ok: boolean; msg: string; provisioningState?: string } | null>(null);

  // Overview tab — live system dashboard over the ADX cluster.
  const [activeTab, setActiveTab] = useState<EhTab>('overview');
  const [timespan, setTimespan] = useState<EhTimespan>('P1D');
  const [overview, setOverview] = useState<EhOverviewData | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewErr, setOverviewErr] = useState<string | null>(null);
  const [journal, setJournal] = useState<EhJournalEntry[] | null>(null);

  // Export to OneLake/ADLS dialog state (continuous-export → Delta on ADLS Gen2)
  const [exportOpen, setExportOpen] = useState(false);
  const [exportSourceTable, setExportSourceTable] = useState('');
  const [exportName, setExportName] = useState('');
  const [exportAdlsAccount, setExportAdlsAccount] = useState('');
  const [exportContainer, setExportContainer] = useState('bronze');
  const [exportPath, setExportPath] = useState('');
  const [exportInterval, setExportInterval] = useState('1h');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportResult, setExportResult] = useState<{
    ok?: boolean; code?: string; missing?: string; hint?: string;
    error?: string; abfssPath?: string; receipt?: string; verify?: string;
  } | null>(null);
  const [continuousExports, setContinuousExports] = useState<Array<{
    name: string; externalTableName?: string; lastRunResult?: string; isRunning?: boolean;
  }>>([]);
  const [exportContainers, setExportContainers] = useState<string[]>(['bronze', 'silver', 'gold', 'landing']);
  const [exportConfigAccount, setExportConfigAccount] = useState<string>('');
  const [exportsLoading, setExportsLoading] = useState(false);

  const load = useCallback(async () => {
    // Pre-save gate: /items/eventhouse/new fires this before any record exists.
    // Skip the fetch — the editor renders its "create database" flow instead.
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/eventhouse/${id}`);
      const j = (await r.json()) as EventhouseState;
      setState(j);
      // Seed the auto-scale dialog from live ARM cluster state.
      if (j.optimizedAutoscale) {
        setAutoscaleEnabled(j.optimizedAutoscale.isEnabled);
        setAutoscaleMin(j.optimizedAutoscale.minimum);
        setAutoscaleMax(j.optimizedAutoscale.maximum);
      }
      if (j.ok && (j.databases?.length ?? 0) > 0 && !selectedDb) {
        setSelectedDb(j.defaultDatabase || j.databases![0].name);
      }
    } catch (e: any) {
      setState({ ok: false, error: e?.message || String(e) });
    }
  }, [id, selectedDb]);

  useEffect(() => { load(); }, [load]);

  const createDb = useCallback(async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setCreateErr(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/database`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const j = await r.json();
      if (!j.ok) { setCreateErr(j.error || 'create failed'); }
      else { setNewName(''); setDialogOpen(false); load(); }
    } catch (e: any) {
      setCreateErr(e?.message || String(e));
    } finally {
      setCreating(false);
    }
  }, [id, newName, load]);

  // Open the KQL Database editor for a specific database in this eventhouse.
  // Mirrors Fabric's behavior: clicking a DB card or "Query with code" jumps
  // into the focused KQL editor for that database.
  const openKqlEditor = useCallback((dbName: string) => {
    if (!dbName) return;
    const qs = new URLSearchParams({ eventhouseId: id, database: dbName });
    router.push(`/items/kql-database/new?${qs.toString()}`);
  }, [id, router]);

  // Open the focused KQL editor for a database in a NEW browser tab — mirrors
  // Fabric's per-object "Open in new tab" affordance.
  const openKqlEditorNewTab = useCallback((dbName: string) => {
    if (!dbName) return;
    const qs = new URLSearchParams({ eventhouseId: id, database: dbName });
    window.open(`/items/kql-database/new?${qs.toString()}`, '_blank', 'noopener');
  }, [id]);

  // Delete a KQL database via ARM (Microsoft.Kusto/clusters/databases). After
  // a successful delete, re-load the cluster so the tile/row disappears.
  const deleteDb = useCallback(async (dbName: string) => {
    setDeleting(true);
    setDeleteErr(null);
    try {
      const r = await fetch(
        `/api/items/eventhouse/${id}/database?name=${encodeURIComponent(dbName)}`,
        { method: 'DELETE' },
      );
      const j = await r.json();
      if (!j.ok) { setDeleteErr(j.error || 'delete failed'); return; }
      setDeleteTarget(null);
      if (selectedDb === dbName) setSelectedDb('');
      load();
    } catch (e: any) {
      setDeleteErr(e?.message || String(e));
    } finally {
      setDeleting(false);
    }
  }, [id, selectedDb, load]);

  // Ingest a file (CSV / JSON / parquet) into a KQL table. Calls the
  // existing /api/items/eventhouse/{id}/ingest BFF route; honest error if
  // not yet provisioned.
  const onIngest = useCallback(async () => {
    if (!selectedDb || !getDataTable.trim()) {
      setGetDataResult({ ok: false, error: 'Database + table name required' }); return;
    }
    setGetDataBusy(true);
    setGetDataResult(null);
    try {
      if (getDataMode === 'file') {
        if (!getDataFile) { setGetDataResult({ ok: false, error: 'Pick a file first' }); return; }
        const fd = new FormData();
        fd.set('database', selectedDb);
        fd.set('table', getDataTable.trim());
        fd.set('file', getDataFile);
        const r = await fetch(`/api/items/eventhouse/${id}/ingest`, { method: 'POST', body: fd });
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
        setGetDataResult(j);
      } else if (getDataMode === 'eventhub') {
        const r = await fetch(`/api/items/eventhouse/${id}/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'eventhub', database: selectedDb, table: getDataTable.trim(),
            eventHubName: getDataHubName.trim(), consumerGroup: getDataConsumer.trim() || '$Default',
          }),
        });
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
        setGetDataResult(j);
      } else {
        const r = await fetch(`/api/items/eventhouse/${id}/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'onelake', database: selectedDb, table: getDataTable.trim(),
            oneLakePath: getDataOneLakePath.trim(), format: getDataFormat,
          }),
        });
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
        setGetDataResult(j);
      }
    } catch (e: any) {
      setGetDataResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setGetDataBusy(false);
    }
  }, [id, selectedDb, getDataMode, getDataTable, getDataFile, getDataHubName, getDataConsumer, getDataOneLakePath, getDataFormat]);

  // ---- Get-Data wizard: ARM-populated pickers + schema preview ----

  // Load the deployment's Event Hubs from real ARM (/api/eventhubs/hubs) when
  // the dialog opens in eventhub mode. Honest 503 gate is surfaced verbatim.
  useEffect(() => {
    if (!getDataOpen || getDataMode !== 'eventhub') return;
    let cancelled = false;
    setEhHubsLoading(true);
    setEhHubsErr(null);
    fetch('/api/eventhubs/hubs')
      .then((r) => r.json())
      .then((j: any) => {
        if (cancelled) return;
        if (j?.ok) setEhHubs((j.hubs as Array<{ name: string }>).map((h) => h.name).filter(Boolean));
        else if (j?.code === 'not_configured') setEhHubsErr(`Event Hubs namespace not configured — set ${j.missing}.`);
        else setEhHubsErr(j?.error || 'Failed to list event hubs');
      })
      .catch((e: any) => { if (!cancelled) setEhHubsErr(e?.message || String(e)); })
      .finally(() => { if (!cancelled) setEhHubsLoading(false); });
    return () => { cancelled = true; };
  }, [getDataOpen, getDataMode]);

  // Load consumer groups for the chosen hub (real ARM list).
  useEffect(() => {
    if (!getDataHubName) { setEhConsumerGroups(['$Default']); return; }
    let cancelled = false;
    setEhCgLoading(true);
    fetch(`/api/eventhubs/consumergroups?eventHub=${encodeURIComponent(getDataHubName)}`)
      .then((r) => r.json())
      .then((j: any) => {
        if (cancelled) return;
        if (j?.ok) {
          const names = (j.consumerGroups as Array<{ name: string }>).map((c) => c.name).filter(Boolean);
          setEhConsumerGroups(names.length ? names : ['$Default']);
        }
      })
      .catch(() => { /* keep the $Default fallback */ })
      .finally(() => { if (!cancelled) setEhCgLoading(false); });
    return () => { cancelled = true; };
  }, [getDataHubName]);

  // Load Loom medallion container roots for the ADLS quick-pick (env-sourced).
  useEffect(() => {
    if (!getDataOpen) return;
    let cancelled = false;
    fetch('/api/loom/storage-paths')
      .then((r) => r.json())
      .then((j: any) => { if (!cancelled && j?.ok) setLoomContainers(j.containers || []); })
      .catch(() => { /* quick-pick row simply stays hidden */ });
    return () => { cancelled = true; };
  }, [getDataOpen]);

  // Reset the picker/preview state whenever the source mode changes so a stale
  // schema from a previous source never lingers.
  useEffect(() => {
    setSchemaPreview(null);
    setPreviewErr(null);
    setGetDataResult(null);
  }, [getDataMode, getDataOpen]);

  // File mode: detect schema client-side from the first 16 KB (no round-trip).
  useEffect(() => {
    if (getDataMode !== 'file' || !getDataFile) { return; }
    const slice = getDataFile.slice(0, 16 * 1024);
    slice.text().then((text) => {
      try {
        const lower = (getDataFile.name || '').toLowerCase();
        const isJson = /\.(json|jsonl|ndjson)$/.test(lower) || text.trim().startsWith('[') || text.trim().startsWith('{');
        if (isJson) {
          const trimmed = text.trim();
          let rows: any[] = [];
          if (trimmed.startsWith('[')) {
            // tolerate truncation: parse leading complete objects
            try { rows = JSON.parse(trimmed); } catch { rows = []; }
          } else {
            rows = trimmed.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          }
          if (Array.isArray(rows) && rows.length) {
            const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r ?? {}))));
            const sampleRows = rows.slice(0, 5).map((r) => keys.map((k) => { const v = r?.[k]; return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); }));
            setSchemaPreview({ columns: keys, sampleRows, detectedFormat: 'json', sampleRowCount: rows.length });
            return;
          }
        }
        // CSV fallback
        const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
        if (lines.length && !/\n$/.test(text) && lines.length > 1) lines.pop();
        if (!lines.length) { setSchemaPreview(null); return; }
        const header = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim());
        const sampleRows = lines.slice(1, 6).map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '')));
        setSchemaPreview({ columns: header, sampleRows, detectedFormat: 'csv', sampleRowCount: Math.max(0, lines.length - 1) });
      } catch {
        setSchemaPreview(null);
      }
    }).catch(() => setSchemaPreview(null));
  }, [getDataMode, getDataFile]);

  // URL mode: peek the blob/ADLS object on the server (MI or SAS) and preview.
  const onPreview = useCallback(async () => {
    if (!getDataOneLakePath.trim()) return;
    setPreviewBusy(true);
    setPreviewErr(null);
    setSchemaPreview(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/ingest/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: getDataOneLakePath.trim(), format: getDataFormat }),
      });
      const j = await r.json();
      if (j?.ok) setSchemaPreview({ columns: j.columns, sampleRows: j.sampleRows, detectedFormat: j.detectedFormat, sampleRowCount: j.sampleRowCount });
      else setPreviewErr(j?.error || 'preview failed');
    } catch (e: any) {
      setPreviewErr(e?.message || String(e));
    } finally {
      setPreviewBusy(false);
    }
  }, [id, getDataOneLakePath, getDataFormat]);

  // Apply per-database caching + retention policies via the .alter database
  // policy KQL management commands.
  const applyPolicies = useCallback(async () => {
    if (!selectedDb) return;
    setPoliciesBusy(true);
    setPoliciesErr(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/policies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          database: selectedDb,
          hotCacheDays, softDeleteDays, oneLakeAvailability: oneLakeEnabled,
          enableStreamingIngest: streamingEnabled,
        }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) setPoliciesErr(j.error || 'policy apply failed');
      else { setPoliciesOpen(false); load(); }
    } catch (e: any) {
      setPoliciesErr(e?.message || String(e));
    } finally {
      setPoliciesBusy(false);
    }
  }, [id, selectedDb, hotCacheDays, softDeleteDays, oneLakeEnabled, streamingEnabled, load]);

  // Load active continuous-export jobs + the ADLS picker config (account +
  // visible containers) from the real backend (GET .../continuous-export).
  const loadExports = useCallback(async () => {
    if (!selectedDb) return;
    setExportsLoading(true);
    try {
      const r = await fetch(
        `/api/items/eventhouse/${id}/continuous-export?database=${encodeURIComponent(selectedDb)}`,
      );
      const j = await r.json();
      if (j.ok) {
        if (Array.isArray(j.exports)) setContinuousExports(j.exports);
        if (j.config?.containers?.length) setExportContainers(j.config.containers);
        if (typeof j.config?.adlsAccount === 'string') setExportConfigAccount(j.config.adlsAccount);
      }
    } catch { /* best-effort — gate surfaces on POST */ }
    finally { setExportsLoading(false); }
  }, [id, selectedDb]);

  // Create / replace a continuous Delta-export job to ADLS Gen2 (OneLake-style
  // availability via Azure-native ADX continuous-export — no Fabric workspace).
  const submitExport = useCallback(async () => {
    setExportBusy(true);
    setExportResult(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/continuous-export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          database:    selectedDb,
          sourceTable: exportSourceTable.trim(),
          exportName:  exportName.trim(),
          adlsAccount: exportAdlsAccount.trim() || undefined,
          container:   exportContainer,
          path:        exportPath.trim(),
          interval:    exportInterval,
        }),
      });
      const j = await r.json();
      setExportResult(j);
      if (j.ok) { void loadExports(); }
    } catch (e: any) {
      setExportResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setExportBusy(false);
    }
  }, [id, selectedDb, exportSourceTable, exportName, exportAdlsAccount,
      exportContainer, exportPath, exportInterval, loadExports]);

  // Cluster-level optimized auto-scale via ARM PATCH /clusters. Azure-native;
  // no Fabric workspace involved. Honest 422 gate on Dev/Basic SKUs.
  const applyAutoscale = useCallback(async () => {
    setAutoscaleBusy(true);
    setAutoscaleResult(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/policies`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          optimizedAutoscale: {
            isEnabled: autoscaleEnabled,
            minimum: autoscaleMin,
            maximum: autoscaleMax,
          },
        }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) {
        setAutoscaleResult({ ok: false, msg: j.error || 'Auto-scale update failed' });
      } else {
        setAutoscaleResult({
          ok: true,
          msg: 'Optimized auto-scale settings applied.',
          provisioningState: j.provisioningState,
        });
        load();
      }
    } catch (e: any) {
      setAutoscaleResult({ ok: false, msg: e?.message || String(e) });
    } finally {
      setAutoscaleBusy(false);
    }
  }, [id, autoscaleEnabled, autoscaleMin, autoscaleMax, load]);

  // Purge records (GDPR erasure) — ADX two-step .purge against the DM endpoint.
  // Open: load tables for the selected database (table picker source).
  const openPurgeDialog = useCallback(async () => {
    setPurgeOpen(true);
    setPurgeStep('idle');
    setPurgeVerifyResult(null);
    setPurgeCommitResult(null);
    setPurgeConfirmText('');
    setPurgeErr(null);
    setPurgeTable('');
    setPurgeColumns([]);
    setPurgePredicates([{ column: '', op: '==', value: '' }]);
    if (!selectedDb) return;
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/purge?database=${encodeURIComponent(selectedDb)}`);
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (j.ok) setPurgeTableList(j.tables || []);
      else setPurgeErr(j.error || 'failed to load tables');
    } catch (e: any) {
      setPurgeErr(e?.message || String(e));
    }
  }, [id, selectedDb]);

  // Table picked → load its columns (predicate-builder source).
  const onPurgeTableChange = useCallback(async (tableName: string) => {
    setPurgeTable(tableName);
    setPurgeColumns([]);
    if (!selectedDb || !tableName) return;
    try {
      const r = await fetch(
        `/api/items/eventhouse/${id}/purge?database=${encodeURIComponent(selectedDb)}&table=${encodeURIComponent(tableName)}`,
      );
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false };
      if (j.ok) setPurgeColumns(j.columns || []);
    } catch { /* non-blocking — predicate column can still be picked once reloaded */ }
  }, [id, selectedDb]);

  // Step 1 — verify: preview record count + obtain the verification token.
  const runPurgeVerify = useCallback(async () => {
    if (!selectedDb || !purgeTable) return;
    setPurgeBusy(true);
    setPurgeErr(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/purge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ database: selectedDb, table: purgeTable, predicates: purgePredicates, step: 'verify' }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) { setPurgeErr(j.error || 'verify failed'); return; }
      setPurgeVerifyResult({
        numRecordsToPurge: j.numRecordsToPurge,
        estimatedPurgeExecutionTime: j.estimatedPurgeExecutionTime,
        verificationToken: j.verificationToken,
      });
      setPurgeStep('verified');
    } catch (e: any) {
      setPurgeErr(e?.message || String(e));
    } finally {
      setPurgeBusy(false);
    }
  }, [id, selectedDb, purgeTable, purgePredicates]);

  // Step 2 — commit: irreversibly schedule the purge using the token + typed confirm.
  const runPurgeCommit = useCallback(async () => {
    if (!selectedDb || !purgeTable || !purgeVerifyResult?.verificationToken) return;
    if (purgeConfirmText !== 'PURGE') { setPurgeErr('Type PURGE exactly to confirm'); return; }
    setPurgeBusy(true);
    setPurgeErr(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/purge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          database: selectedDb, table: purgeTable, predicates: purgePredicates,
          step: 'commit', verificationToken: purgeVerifyResult.verificationToken,
        }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) { setPurgeErr(j.error || 'commit failed'); return; }
      setPurgeCommitResult({ operationId: j.operationId, state: j.state, postPurgeCount: j.postPurgeCount });
      setPurgeStep('done');
    } catch (e: any) {
      setPurgeErr(e?.message || String(e));
    } finally {
      setPurgeBusy(false);
    }
  }, [id, selectedDb, purgeTable, purgePredicates, purgeVerifyResult, purgeConfirmText]);

  // Bind an ADLS Gen2 Delta path to an ADX external table + query acceleration.
  // Real backend: .create-or-alter external table kind=delta /
  // .alter external table policy query_acceleration via the continuous-export
  // BFF route. Lakehouse/warehouse Delta becomes KQL-queryable within seconds —
  // no Fabric / OneLake dependency.
  const onBindDelta = useCallback(async () => {
    if (!selectedDb || !deltaTableName.trim() || !deltaAbfss.trim()) {
      setDeltaResult({ ok: false, error: 'Database, external table name, and ADLS abfss:// path are required' });
      return;
    }
    setDeltaBusy(true);
    setDeltaResult(null);
    try {
      const r = await fetch(`/api/items/eventhouse/${id}/continuous-export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          database: selectedDb,
          tableName: deltaTableName.trim(),
          abfssUri: deltaAbfss.trim(),
          hotDays: deltaHotDays,
          createKqlView: deltaKqlView,
        }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      setDeltaResult(j);
    } catch (e: any) {
      setDeltaResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setDeltaBusy(false);
    }
  }, [id, selectedDb, deltaTableName, deltaAbfss, deltaHotDays, deltaKqlView]);

  const hasDbs = (state?.databases?.length ?? 0) > 0;
  const dbCount = state?.databases?.length ?? 0;
  // Dev(No SLA)/Basic-tier SKUs reject optimizedAutoscale — drives the honest gate.
  const isDevSku = (state?.sku?.tier || '').toLowerCase() === 'basic'
    || (state?.sku?.name || '').toLowerCase().startsWith('dev(no sla)');

  // Load the live system-overview + schema-change journal for the current window.
  const loadOverview = useCallback(async () => {
    if (!id || id === 'new') return;
    setOverviewLoading(true);
    setOverviewErr(null);
    try {
      const [ovRes, jRes] = await Promise.all([
        fetch(`/api/items/eventhouse/${id}/overview?timespan=${timespan}`),
        fetch(`/api/items/eventhouse/${id}/journal?limit=50`),
      ]);
      const ov = (await ovRes.json()) as EhOverviewData;
      setOverview(ov);
      const jr = await jRes.json();
      if (jr?.ok) setJournal((jr.entries || []) as EhJournalEntry[]);
      else setJournal([]);
    } catch (e: any) {
      setOverviewErr(e?.message || String(e));
    } finally {
      setOverviewLoading(false);
    }
  }, [id, timespan]);

  useEffect(() => {
    if (activeTab === 'overview') loadOverview();
  }, [activeTab, loadOverview]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'New', actions: [
        { label: 'New KQL database', onClick: () => setDialogOpen(true) },
        { label: 'KQL database shortcut', disabled: true,
          title: 'ReadOnlyFollowing (shortcut) databases require a Fabric-managed eventhouse; the standalone ADX cluster hosts ReadWrite databases only' },
        { label: 'New dashboard', disabled: true, title: 'KQL dashboard creation not yet wired — use the KQL Dashboard editor' },
      ]},
      { label: 'Query', actions: [
        { label: 'Query with code', onClick: hasDbs && selectedDb ? () => openKqlEditor(selectedDb) : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs ? 'create a KQL database first' : !selectedDb ? 'select a database below' : undefined },
        { label: 'Get data', onClick: hasDbs ? () => setGetDataOpen(true) : undefined,
          disabled: !hasDbs, title: !hasDbs ? 'create a KQL database first' : undefined },
      ]},
      { label: 'Manage', actions: [
        { label: 'Data policies', onClick: hasDbs && selectedDb ? () => setPoliciesOpen(true) : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs ? 'create a KQL database first' : !selectedDb ? 'select a database below' : undefined },
        { label: 'Bind Delta source', onClick: hasDbs && selectedDb ? () => { setDeltaResult(null); setDeltaOpen(true); } : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs ? 'create a KQL database first' : !selectedDb ? 'select a database below' : undefined },
        { label: 'OneLake availability', onClick: hasDbs && selectedDb ? () => { setOneLakeEnabled(true); setPoliciesOpen(true); } : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs || !selectedDb ? 'pick a database first' : undefined },
        { label: 'Export to OneLake/ADLS',
          onClick: hasDbs && selectedDb
            ? () => { setExportResult(null); setExportOpen(true); void loadExports(); }
            : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs || !selectedDb
            ? 'pick a database first'
            : 'configure continuous Delta export to ADLS Gen2 / OneLake' },
        { label: 'Purge records (GDPR)', onClick: hasDbs && selectedDb ? openPurgeDialog : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs || !selectedDb
            ? 'select a database first'
            : 'Predicate-based GDPR erasure via ADX .purge (two-step verify→commit, irreversible)' },
        { label: 'Auto-scale', onClick: state?.ok ? () => { setAutoscaleResult(null); setAutoscaleOpen(true); } : undefined,
          disabled: !state?.ok,
          title: !state?.ok ? 'cluster must be reachable' : 'configure optimized auto-scale (min/max instances)' },
        { label: 'Streaming ingest', onClick: hasDbs && selectedDb ? () => { setStreamingEnabled(true); setPoliciesOpen(true); } : undefined,
          disabled: !hasDbs || !selectedDb,
          title: !hasDbs || !selectedDb ? 'pick a database first' : 'Enable/disable low-latency streaming ingestion on the cluster' },
        { label: 'Capacity & throttling', onClick: () => setActiveTab('capacity'),
          title: 'View capacity policy + live throttle metrics' },
      ]},
      { label: 'Refresh', actions: [
        { label: 'Refresh', onClick: load },
      ]},
    ]},
  ], [hasDbs, selectedDb, openKqlEditor, load, loadExports, openPurgeDialog, state?.ok]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand">Eventhouse · shared cluster</Badge>
          <Caption1>{state?.cluster || 'loading…'}</Caption1>
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={load}>Refresh</Button>
          <Dialog open={dialogOpen} onOpenChange={(_: unknown, d: any) => setDialogOpen(d.open)}>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="primary" icon={<Add20Regular />} style={{ marginLeft: 'auto' }}>New KQL database</Button>
            </DialogTrigger>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Create KQL database</DialogTitle>
                <DialogContent>
                  <Caption1>Provisions a Microsoft.Kusto/clusters/databases resource via ARM. Hot cache = 7 days, soft-delete = 30 days.</Caption1>
                  <Input
                    placeholder="database-name"
                    value={newName}
                    onChange={(_: unknown, d: any) => setNewName(d.value)}
                    style={{ marginTop: 12, width: '100%' }}
                  />
                  {createErr && (
                    <MessageBar intent="error" style={{ marginTop: 12 }}>
                      <MessageBarBody>{createErr}</MessageBarBody>
                    </MessageBar>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setDialogOpen(false)}>Cancel</Button>
                  <Button appearance="primary" onClick={createDb} disabled={creating || !newName.trim()}>
                    {creating ? 'Creating…' : 'Create'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
          <Button appearance="outline" icon={<Add20Regular />} disabled
            title="KQL database shortcut (ReadOnlyFollowing) requires a Fabric-managed eventhouse; the standalone ADX cluster hosts ReadWrite databases only">
            +Database shortcut
          </Button>
        </div>

        {state?.ok && (
          <div className={s.tabBar}>
            <TabList selectedValue={activeTab} onTabSelect={(_: unknown, d: any) => setActiveTab(d.value as EhTab)}>
              <Tab value="overview">System overview</Tab>
              <Tab value="databases">Databases ({dbCount})</Tab>
              <Tab value="capacity">Capacity</Tab>
            </TabList>
          </div>
        )}

        {state?.ok && activeTab === 'capacity' && <EventhouseCapacityPanel id={id} />}

        {!state && <Spinner size="small" label="Loading cluster…" />}
        {state && !state.ok && (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Cluster unreachable</MessageBarTitle>
              {state.error || 'Unknown error'}
            </MessageBarBody>
          </MessageBar>
        )}

        {state?.ok && activeTab === 'overview' && (
          <EventhouseOverviewPanel
            s={s}
            overview={overview}
            journal={journal}
            timespan={timespan}
            loading={overviewLoading}
            err={overviewErr}
            onTimespan={setTimespan}
            onRefresh={loadOverview}
          />
        )}

        {state?.ok && activeTab === 'databases' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Subtitle2>Databases ({dbCount})</Subtitle2>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }} role="group" aria-label="Database view">
                <Button
                  size="small"
                  appearance={dbView === 'tile' ? 'primary' : 'subtle'}
                  icon={<Apps20Regular />}
                  onClick={() => setDbView('tile')}
                  aria-pressed={dbView === 'tile'}
                  aria-label="Tile view"
                  title="Tile view"
                />
                <Button
                  size="small"
                  appearance={dbView === 'list' ? 'primary' : 'subtle'}
                  icon={<List20Regular />}
                  onClick={() => setDbView('list')}
                  aria-pressed={dbView === 'list'}
                  aria-label="List view"
                  title="List view"
                />
              </div>
            </div>

            {dbView === 'tile' && (
              <div className={s.cardGrid}>
                {(state.databases || []).map((d) => {
                  const isSelected = selectedDb === d.name;
                  return (
                    <div
                      key={d.name}
                      className={s.card}
                      onClick={() => setSelectedDb(d.name)}
                      onDoubleClick={() => openKqlEditor(d.name)}
                      role="button"
                      tabIndex={0}
                      style={{
                        cursor: 'pointer',
                        borderColor: isSelected ? tokens.colorBrandStroke1 : undefined,
                        borderWidth: isSelected ? 2 : undefined,
                        backgroundColor: isSelected ? tokens.colorNeutralBackground1Selected : undefined,
                      }}
                    >
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>KQL database</Caption1>
                      <div style={{ fontSize: 18, fontWeight: 600 }}>{d.name}</div>
                      {d.prettyName && d.prettyName !== d.name && <Caption1>{d.prettyName}</Caption1>}
                      <div style={{ display: 'flex', gap: 10, marginTop: 4, flexWrap: 'wrap', color: tokens.colorNeutralForeground3 }}>
                        {typeof d.totalSizeMb === 'number' && <Caption1>{fmtDbSize(d.totalSizeMb)}</Caption1>}
                        {typeof d.retentionDays === 'number' && <Caption1>ret {d.retentionDays}d</Caption1>}
                        {typeof d.tableCount === 'number' && <Caption1>{d.tableCount} {d.tableCount === 1 ? 'table' : 'tables'}</Caption1>}
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                        {d.name === state.defaultDatabase && <Badge appearance="filled" color="brand">default</Badge>}
                        {isSelected && <Badge appearance="outline" color="informative">selected</Badge>}
                      </div>
                      <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <Button size="small" appearance="primary" icon={<Play20Regular />}
                          onClick={(e) => { e.stopPropagation(); openKqlEditor(d.name); }}
                          title="Query data (this tab)">
                          Query
                        </Button>
                        <Button size="small" appearance="outline" icon={<Open20Regular />}
                          aria-label={`Open ${d.name} in new tab`}
                          onClick={(e) => { e.stopPropagation(); openKqlEditorNewTab(d.name); }}
                          title="Open in new tab" />
                        <Button size="small" appearance="outline"
                          onClick={(e) => { e.stopPropagation(); setSelectedDb(d.name); setGetDataOpen(true); }}
                          title="Get data">
                          Get data
                        </Button>
                        <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                          aria-label={`Delete ${d.name}`}
                          onClick={(e) => { e.stopPropagation(); setSelectedDb(d.name); setDeleteTarget(d.name); setDeleteErr(null); }}
                          title="Delete database" />
                      </div>
                    </div>
                  );
                })}
                {(!state.databases || state.databases.length === 0) && (
                  <Caption1>No databases yet. Click <strong>New KQL database</strong> to create one.</Caption1>
                )}
              </div>
            )}

            {dbView === 'list' && (
              <div className={s.tableWrap}>
                <Table aria-label="KQL databases" size="small">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Tables</TableHeaderCell>
                      <TableHeaderCell>Total size</TableHeaderCell>
                      <TableHeaderCell>Retention</TableHeaderCell>
                      <TableHeaderCell>Hot cache</TableHeaderCell>
                      <TableHeaderCell aria-label="Actions" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(state.databases || []).map((d) => (
                      <TableRow
                        key={d.name}
                        onClick={() => setSelectedDb(d.name)}
                        style={{
                          cursor: 'pointer',
                          backgroundColor: selectedDb === d.name ? tokens.colorNeutralBackground1Selected : undefined,
                        }}
                      >
                        <TableCell>
                          <span style={{ fontWeight: 600 }}>{d.name}</span>
                          {d.name === state.defaultDatabase &&
                            <Badge appearance="filled" color="brand" style={{ marginLeft: 6 }}>default</Badge>}
                        </TableCell>
                        <TableCell>{typeof d.tableCount === 'number' ? d.tableCount : '—'}</TableCell>
                        <TableCell>{fmtDbSize(d.totalSizeMb)}</TableCell>
                        <TableCell>{typeof d.retentionDays === 'number' ? `${d.retentionDays} days` : '—'}</TableCell>
                        <TableCell>{typeof d.hotCacheDays === 'number' ? `${d.hotCacheDays} days` : '—'}</TableCell>
                        <TableCell>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <Button size="small" appearance="primary" icon={<Play20Regular />}
                              aria-label={`Query ${d.name}`}
                              onClick={(e) => { e.stopPropagation(); openKqlEditor(d.name); }}
                              title="Query data" />
                            <Button size="small" appearance="outline" icon={<Open20Regular />}
                              aria-label={`Open ${d.name} in new tab`}
                              onClick={(e) => { e.stopPropagation(); openKqlEditorNewTab(d.name); }}
                              title="Open in new tab" />
                            <Button size="small" appearance="outline"
                              onClick={(e) => { e.stopPropagation(); setSelectedDb(d.name); setGetDataOpen(true); }}
                              title="Get data">
                              Get data
                            </Button>
                            <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                              aria-label={`Delete ${d.name}`}
                              onClick={(e) => { e.stopPropagation(); setSelectedDb(d.name); setDeleteTarget(d.name); setDeleteErr(null); }}
                              title="Delete database" />
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {(!state.databases || state.databases.length === 0) && (
                      <TableRow>
                        <TableCell colSpan={6}>
                          <Caption1>No databases yet. Click <strong>New KQL database</strong> to create one.</Caption1>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Delete confirmation */}
            <Dialog open={!!deleteTarget} onOpenChange={(_, d) => { if (!d.open) { setDeleteTarget(null); setDeleteErr(null); } }}>
              <DialogSurface style={{ maxWidth: 480 }}>
                <DialogBody>
                  <DialogTitle>Delete database?</DialogTitle>
                  <DialogContent>
                    <Caption1>
                      This permanently deletes <strong>{deleteTarget}</strong> and all of its tables from the
                      ADX cluster. This cannot be undone — an ARM DELETE is issued immediately.
                    </Caption1>
                    {deleteErr && (
                      <MessageBar intent="error" style={{ marginTop: 12 }}>
                        <MessageBarBody>{deleteErr}</MessageBarBody>
                      </MessageBar>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => { setDeleteTarget(null); setDeleteErr(null); }}>Cancel</Button>
                    <Button appearance="primary" icon={<Delete20Regular />}
                      style={{ backgroundColor: tokens.colorPaletteRedBackground3 }}
                      disabled={deleting || !deleteTarget}
                      onClick={() => deleteTarget && deleteDb(deleteTarget)}>
                      {deleting ? 'Deleting…' : 'Delete'}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>

            {/* Get data dialog — file / event hub / OneLake */}
            <Dialog open={getDataOpen} onOpenChange={(_, d) => setGetDataOpen(d.open)}>
              <DialogSurface style={{ maxWidth: 520 }}>
                <DialogBody>
                  <DialogTitle>Get data into KQL</DialogTitle>
                  <DialogContent>
                    <Caption1>Target database: <strong>{selectedDb || '(none)'}</strong></Caption1>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                      <div>
                        <Label>Source</Label>
                        <Select value={getDataMode} onChange={(_, d) => setGetDataMode(d.value as any)}>
                          <option value="file">Upload file (CSV / JSON / Parquet)</option>
                          <option value="eventhub">Event Hub (streaming)</option>
                          <option value="onelake">OneLake / ADLS Gen2 path</option>
                        </Select>
                      </div>
                      <div>
                        <Label>Target table name</Label>
                        <Input value={getDataTable} onChange={(_, d) => setGetDataTable(d.value)} placeholder="raw_events" />
                      </div>
                      {getDataMode === 'file' && (
                        <div>
                          <Label>File</Label>
                          <input type="file" aria-label="Data file to ingest (CSV, JSON, or Parquet)" onChange={(e) => setGetDataFile(e.target.files?.[0] || null)} />
                          {getDataFile && (
                            <Caption1>{getDataFile.name} ({(getDataFile.size / 1024).toFixed(1)} KB)</Caption1>
                          )}
                        </div>
                      )}
                      {getDataMode === 'eventhub' && (
                        <>
                          {ehHubsErr && (
                            <MessageBar intent="warning">
                              <MessageBarBody>{ehHubsErr}</MessageBarBody>
                            </MessageBar>
                          )}
                          <div>
                            <Label>Event Hub</Label>
                            {ehHubsLoading ? (
                              <Spinner size="tiny" label="Loading event hubs…" />
                            ) : (
                              <Select
                                value={getDataHubName}
                                onChange={(_, d) => { setGetDataHubName(d.value); setGetDataConsumer('$Default'); }}
                                disabled={!!ehHubsErr || ehHubs.length === 0}
                              >
                                <option value="">— select an event hub —</option>
                                {ehHubs.map((h) => <option key={h} value={h}>{h}</option>)}
                              </Select>
                            )}
                          </div>
                          <div>
                            <Label>Consumer group</Label>
                            {ehCgLoading ? (
                              <Spinner size="tiny" label="Loading consumer groups…" />
                            ) : (
                              <Select
                                value={getDataConsumer}
                                onChange={(_, d) => setGetDataConsumer(d.value)}
                                disabled={!getDataHubName}
                              >
                                {ehConsumerGroups.map((cg) => <option key={cg} value={cg}>{cg}</option>)}
                              </Select>
                            )}
                          </div>
                          {getDataHubName && (
                            <MessageBar intent="info">
                              <MessageBarBody>
                                Streaming connection <strong>{getDataHubName}</strong> / <strong>{getDataConsumer || '$Default'}</strong>.
                                Schema is inferred from the first arriving JSON events; rows land as the data connection warms up (typically &lt;60s).
                              </MessageBarBody>
                            </MessageBar>
                          )}
                        </>
                      )}
                      {getDataMode === 'onelake' && (
                        <>
                          <div>
                            <Label>Storage path (ADLS Gen2 abfss:// or Blob https:// with SAS)</Label>
                            <Input value={getDataOneLakePath} onChange={(_, d) => setGetDataOneLakePath(d.value)} placeholder="abfss://bronze@account.dfs.core.windows.net/folder/data.csv" />
                          </div>
                          {loomContainers.length > 0 && (
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                              <Caption1>Quick-pick:</Caption1>
                              {loomContainers.map((c) => (
                                <Button
                                  key={c.label}
                                  size="small"
                                  appearance="outline"
                                  onClick={() => setGetDataOneLakePath(c.url.endsWith('/') ? c.url : `${c.url}/`)}
                                >
                                  {c.label}
                                </Button>
                              ))}
                            </div>
                          )}
                          <div>
                            <Label>Format</Label>
                            <Select value={getDataFormat} onChange={(_, d) => setGetDataFormat(d.value as any)}>
                              <option value="auto">Auto-detect (from extension)</option>
                              <option value="csv">CSV</option>
                              <option value="json">JSON (one object per line)</option>
                              <option value="multijson">MultiJSON (array)</option>
                              <option value="parquet">Parquet</option>
                            </Select>
                          </div>
                          <div>
                            <Button
                              appearance="outline"
                              onClick={onPreview}
                              disabled={previewBusy || !getDataOneLakePath.trim()}
                            >
                              {previewBusy ? 'Previewing…' : 'Preview schema'}
                            </Button>
                          </div>
                          {previewErr && (
                            <MessageBar intent="warning">
                              <MessageBarBody>{previewErr}</MessageBarBody>
                            </MessageBar>
                          )}
                        </>
                      )}
                    </div>
                    {schemaPreview && schemaPreview.columns.length > 0 && (
                      <div style={{ marginTop: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, padding: 8 }}>
                        <Caption1><strong>Detected schema</strong>{schemaPreview.detectedFormat ? ` (${schemaPreview.detectedFormat})` : ''}</Caption1>
                        <div style={{ overflowX: 'auto', marginTop: 4 }}>
                          <Table size="small" aria-label="Detected schema preview">
                            <TableHeader>
                              <TableRow>
                                {schemaPreview.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {schemaPreview.sampleRows.slice(0, 3).map((row, i) => (
                                <TableRow key={i}>
                                  {schemaPreview.columns.map((_, j) => (
                                    <TableCell key={j} className={s.cell}>{String(row?.[j] ?? '')}</TableCell>
                                  ))}
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                        <Caption1>{schemaPreview.columns.length} columns detected · {schemaPreview.sampleRows.length} sample rows shown.</Caption1>
                      </div>
                    )}
                    {getDataResult && (
                      <MessageBar intent={getDataResult.ok ? 'success' : 'error'} style={{ marginTop: 12 }}>
                        <MessageBarBody>
                          {getDataResult.ok
                            ? `Ingested ${getDataResult.rows ?? '?'} rows into ${getDataResult.tableName || getDataTable}`
                            : getDataResult.error}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setGetDataOpen(false)}>Close</Button>
                    <Button appearance="primary" onClick={onIngest} disabled={getDataBusy || !selectedDb || !getDataTable.trim()}>
                      {getDataBusy ? 'Ingesting…' : 'Ingest'}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>

            {/* Data policies dialog — hot cache / soft delete / OneLake availability */}
            <Dialog open={policiesOpen} onOpenChange={(_, d) => setPoliciesOpen(d.open)}>
              <DialogSurface style={{ maxWidth: 500 }}>
                <DialogBody>
                  <DialogTitle>Data policies — {selectedDb}</DialogTitle>
                  <DialogContent>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div>
                        <Label>Hot cache (days)</Label>
                        <Input
                          type="number"
                          value={String(hotCacheDays)}
                          onChange={(_, d) => setHotCacheDays(Math.max(0, parseInt(d.value, 10) || 0))}
                        />
                        <Caption1>How many days of data live in SSD cache for sub-second queries.</Caption1>
                      </div>
                      <div>
                        <Label>Soft delete (days)</Label>
                        <Input
                          type="number"
                          value={String(softDeleteDays)}
                          onChange={(_, d) => setSoftDeleteDays(Math.max(1, parseInt(d.value, 10) || 1))}
                        />
                        <Caption1>How many days data is retained before automatic delete.</Caption1>
                      </div>
                      <div>
                        <Label>OneLake availability</Label>
                        <Switch
                          checked={oneLakeEnabled}
                          onChange={(_, d) => setOneLakeEnabled(!!d.checked)}
                          label={oneLakeEnabled ? 'Mirrored to OneLake' : 'Not mirrored'}
                        />
                        <Caption1>Fabric-managed eventhouses only. Mirrors KQL tables into OneLake as Delta for Spark/Power BI.</Caption1>
                      </div>
                      <div>
                        <Label>Enable streaming ingestion</Label>
                        <Switch
                          checked={streamingEnabled}
                          onChange={(_, d) => setStreamingEnabled(!!d.checked)}
                          label={streamingEnabled ? 'Enabled' : 'Disabled'}
                        />
                        <Caption1>
                          Cluster-level flag (ARM). Enables the low-latency (&lt;1s) ingest path
                          for Event Hub data connections and the <code>.ingest inline</code> command,
                          then turns on the database streaming-ingestion policy. Toggling triggers an
                          async cluster update; the cluster stays online. New Loom clusters ship with
                          this on by default.
                        </Caption1>
                      </div>
                    </div>
                    {policiesErr && (
                      <MessageBar intent="error" style={{ marginTop: 12 }}>
                        <MessageBarBody>{policiesErr}</MessageBarBody>
                      </MessageBar>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setPoliciesOpen(false)}>Cancel</Button>
                    <Button appearance="primary" onClick={applyPolicies} disabled={policiesBusy}>
                      {policiesBusy ? 'Applying…' : 'Apply'}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>


            {/* Bind Delta source — ADX external table over an ADLS Gen2 Delta path
                + query acceleration. The lakehouse/warehouse endpoint: Delta data
                becomes KQL-queryable within seconds, no copy, no Fabric. */}
            <Dialog open={deltaOpen} onOpenChange={(_, d) => { setDeltaOpen(d.open); if (!d.open) setDeltaResult(null); }}>
              <DialogSurface style={{ maxWidth: 560 }}>
                <DialogBody>
                  <DialogTitle>Bind Delta source to KQL external table</DialogTitle>
                  <DialogContent>
                    <Caption1>
                      Creates an ADX external table over an ADLS Gen2 Delta Lake path (lakehouse
                      Bronze/Silver/Gold or a warehouse Delta export) and applies a query
                      acceleration policy. The Delta data is queryable via KQL within seconds of
                      binding — no copy, no ingestion job. The ADX cluster managed identity must
                      hold Storage Blob Data Reader on the target ADLS account.
                    </Caption1>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                      <div>
                        <Label required>Target KQL database</Label>
                        <Select value={selectedDb} onChange={(_, d) => setSelectedDb(d.value)}>
                          {(state?.databases || []).map((db) => (
                            <option key={db.name} value={db.name}>{db.name}</option>
                          ))}
                        </Select>
                      </div>
                      <div>
                        <Label required>External table name</Label>
                        <Input value={deltaTableName} onChange={(_, d) => setDeltaTableName(d.value)} placeholder="bronze_orders_delta" />
                        <Caption1>KQL identifier: starts with a letter, alphanumeric + underscore only.</Caption1>
                      </div>
                      <div>
                        <Label required>ADLS Gen2 Delta path (abfss://)</Label>
                        <Input
                          value={deltaAbfss}
                          onChange={(_, d) => setDeltaAbfss(d.value)}
                          placeholder="abfss://bronze@account.dfs.core.windows.net/orders/"
                          style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }}
                        />
                        <Caption1>Root folder of the Delta table (the folder containing _delta_log).</Caption1>
                      </div>
                      <div>
                        <Label>Query acceleration hot window (days)</Label>
                        <Input
                          type="number"
                          value={String(deltaHotDays)}
                          onChange={(_, d) => setDeltaHotDays(Math.max(1, parseInt(d.value, 10) || 7))}
                        />
                        <Caption1>Delta files within this window are cached in ADX for sub-second queries (min 1 day).</Caption1>
                      </div>
                      <div>
                        <Switch
                          checked={deltaKqlView}
                          onChange={(_, d) => setDeltaKqlView(!!d.checked)}
                          label={deltaKqlView ? 'Create KQL view function (recommended)' : 'External table only'}
                        />
                        <Caption1>
                          Creates <code>{deltaTableName ? `${deltaTableName}_view()` : '<name>_view()'}</code> — a
                          stored function wrapping <code>external_table()</code> for clean KQL access.
                        </Caption1>
                      </div>
                    </div>

                    {deltaResult && !deltaResult.ok && (
                      <MessageBar intent="error" style={{ marginTop: 12 }}>
                        <MessageBarBody>
                          <MessageBarTitle>Binding failed</MessageBarTitle>
                          {deltaResult.error}
                          {deltaResult.hint && <div style={{ marginTop: 6 }}><Caption1>{deltaResult.hint}</Caption1></div>}
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {deltaResult?.ok && (
                      <MessageBar intent="success" style={{ marginTop: 12 }}>
                        <MessageBarBody>
                          <MessageBarTitle>External table {deltaResult.externalTableName} bound</MessageBarTitle>
                          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {deltaResult.kqlViewName && (
                              <Caption1>KQL view: <code>{deltaResult.kqlViewName}()</code></Caption1>
                            )}
                            {deltaResult.accelerationPolicy != null && (
                              <Caption1>Acceleration policy: <code>{JSON.stringify(deltaResult.accelerationPolicy)}</code></Caption1>
                            )}
                            {deltaResult.sampleQuery && (
                              <Caption1>Sample query: <code>{deltaResult.sampleQuery}</code></Caption1>
                            )}
                            {(deltaResult.steps || []).map((st, i) => (
                              <Caption1 key={i} style={{ color: st.ok ? tokens.colorStatusSuccessForeground1 : tokens.colorStatusWarningForeground1 }}>
                                {st.ok ? '✓' : '⚠'} {st.step}{st.detail ? `: ${st.detail}` : ''}
                              </Caption1>
                            ))}
                          </div>
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => { setDeltaOpen(false); setDeltaResult(null); }}>Close</Button>
                    <Button
                      appearance="primary"
                      onClick={onBindDelta}
                      disabled={deltaBusy || !selectedDb || !deltaTableName.trim() || !deltaAbfss.trim()}
                    >
                      {deltaBusy ? 'Binding…' : 'Bind Delta source'}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>

            {/* Export to OneLake/ADLS dialog — continuous Delta export via Kusto
                continuous-export (Azure-native; no Fabric workspace required). */}
            <Dialog open={exportOpen} onOpenChange={(_, d) => setExportOpen(d.open)}>
              <DialogSurface style={{ maxWidth: 560 }}>
                <DialogBody>
                  <DialogTitle>Export to OneLake / ADLS Gen2 (Delta)</DialogTitle>
                  <DialogContent>
                    <Caption1 style={{ display: 'block', marginBottom: 8 }}>
                      Configures a Kusto continuous-export job that writes Delta files to ADLS Gen2 on
                      each interval. The ADX cluster&rsquo;s system-assigned MI authenticates to storage
                      (impersonation — no SAS key). Requires <strong>Storage Blob Data Contributor</strong> on
                      the target account, provisioned by <code>adx-cluster.bicep</code> when
                      <code> LOOM_RTI_EXPORT_ADLS</code> is set.
                    </Caption1>

                    {/* Honest gate — fires when LOOM_RTI_EXPORT_ADLS is not set */}
                    {exportResult?.code === 'no_adls_config' && (
                      <MessageBar intent="warning" style={{ marginBottom: 12 }}>
                        <MessageBarBody>
                          <MessageBarTitle>ADLS export not configured</MessageBarTitle>
                          {exportResult.hint ||
                            'Set LOOM_RTI_EXPORT_ADLS to the storage account name and redeploy. ' +
                            'See adx-cluster.bicep (exportAdlsAccountName param).'}
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div>
                        <Label>Source table</Label>
                        <Input
                          value={exportSourceTable}
                          onChange={(_, d) => setExportSourceTable(d.value)}
                          placeholder="raw_events"
                        />
                        <Caption1>KQL fact table in <strong>{selectedDb}</strong>. New rows exported each interval.</Caption1>
                      </div>
                      <div>
                        <Label>Export name</Label>
                        <Input
                          value={exportName}
                          onChange={(_, d) => setExportName(d.value)}
                          placeholder={exportSourceTable ? `export_${exportSourceTable}_delta` : 'export_raw_events_delta'}
                        />
                        <Caption1>Unique continuous-export job name in this database (KQL identifier).</Caption1>
                      </div>
                      <div>
                        <Label>ADLS account</Label>
                        <Input
                          value={exportAdlsAccount}
                          onChange={(_, d) => setExportAdlsAccount(d.value)}
                          placeholder={exportConfigAccount
                            ? `${exportConfigAccount} (deployment default)`
                            : '(uses LOOM_RTI_EXPORT_ADLS when blank)'}
                        />
                        <Caption1>Storage account name. Leave blank to use the deployment default.</Caption1>
                      </div>
                      <div>
                        <Label>Container</Label>
                        <Select value={exportContainer} onChange={(_, d) => setExportContainer(d.value)}>
                          {exportContainers.map((c) => (
                            <option key={c} value={c}>{c}</option>
                          ))}
                        </Select>
                        <Caption1>ADLS Gen2 filesystem (populated from the deployment&rsquo;s storage account).</Caption1>
                      </div>
                      <div>
                        <Label>Path (inside container)</Label>
                        <Input
                          value={exportPath}
                          onChange={(_, d) => setExportPath(d.value)}
                          placeholder={`exports/${selectedDb}/${exportSourceTable || 'table'}`}
                        />
                        <Caption1>Root folder for the Delta table, e.g. <code>exports/raw_events</code>.</Caption1>
                      </div>
                      <div>
                        <Label>Export interval</Label>
                        <Select value={exportInterval} onChange={(_, d) => setExportInterval(d.value)}>
                          <option value="5m">5 minutes</option>
                          <option value="15m">15 minutes</option>
                          <option value="30m">30 minutes</option>
                          <option value="1h">1 hour (recommended)</option>
                          <option value="6h">6 hours</option>
                          <option value="24h">24 hours</option>
                        </Select>
                      </div>
                    </div>

                    {/* Active exports list */}
                    {exportsLoading && (
                      <Spinner size="extra-small" label="Loading exports…" style={{ marginTop: 12 }} />
                    )}
                    {continuousExports.length > 0 && (
                      <div style={{ marginTop: 16 }}>
                        <Caption1 style={{ fontWeight: 600 }}>Active exports ({continuousExports.length})</Caption1>
                        {continuousExports.map((ce) => (
                          <div key={ce.name} style={{ fontSize: 12, marginTop: 4, fontFamily: 'monospace' }}>
                            <strong>{ce.name}</strong>
                            {ce.externalTableName && ` → ${ce.externalTableName}`}
                            {ce.lastRunResult && (
                              <Caption1 style={{ marginLeft: 8 }}>{ce.lastRunResult}</Caption1>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Success receipt */}
                    {exportResult?.ok && (
                      <MessageBar intent="success" style={{ marginTop: 12 }}>
                        <MessageBarBody>
                          <MessageBarTitle>Export configured</MessageBarTitle>
                          Delta files will land at <code>{exportResult.abfssPath}</code> every {exportInterval}.
                          Verify: <code>{exportResult.verify}</code>
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {/* Error (not the honest gate) */}
                    {exportResult && !exportResult.ok && exportResult.code !== 'no_adls_config' && (
                      <MessageBar intent="error" style={{ marginTop: 12 }}>
                        <MessageBarBody>{exportResult.error}</MessageBarBody>
                      </MessageBar>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setExportOpen(false)}>Close</Button>
                    <Button
                      appearance="primary"
                      onClick={submitExport}
                      disabled={
                        exportBusy ||
                        !selectedDb ||
                        !exportSourceTable.trim() ||
                        !exportName.trim() ||
                        !exportContainer
                      }
                    >
                      {exportBusy ? 'Configuring…' : 'Create export'}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>

            {/* Purge records dialog — GDPR erasure via ADX two-step .purge */}
            <Dialog open={purgeOpen} onOpenChange={(_, d) => { if (!purgeBusy) setPurgeOpen(d.open); }}>
              <DialogSurface style={{ maxWidth: 620 }}>
                <DialogBody>
                  <DialogTitle>Purge records — {selectedDb}</DialogTitle>
                  <DialogContent>
                    {purgeStep === 'idle' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <MessageBar intent="warning">
                          <MessageBarBody>
                            <MessageBarTitle>Irreversible erasure</MessageBarTitle>
                            Purge permanently deletes matching records from storage (GDPR /
                            right-to-be-forgotten). It cannot be undone. Use only when required by a
                            privacy obligation. Requires Database Admin on the cluster.
                          </MessageBarBody>
                        </MessageBar>
                        <div>
                          <Label>Table</Label>
                          <Select value={purgeTable} onChange={(_, d) => onPurgeTableChange(d.value)} style={{ width: '100%' }}>
                            <option value="">— select a table —</option>
                            {purgeTableList.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                          </Select>
                        </div>
                        {purgeTable && (
                          <div>
                            <Label>Predicate — all conditions are joined with AND</Label>
                            {purgePredicates.map((pred, i) => (
                              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
                                <Select
                                  value={pred.column}
                                  onChange={(_, d) => setPurgePredicates((ps) => ps.map((p, j) => (j === i ? { ...p, column: d.value } : p)))}
                                  style={{ minWidth: 150 }}
                                >
                                  <option value="">— column —</option>
                                  {purgeColumns.length
                                    ? purgeColumns.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.type})</option>)
                                    : <option disabled>loading schema…</option>}
                                </Select>
                                <Select
                                  value={pred.op}
                                  onChange={(_, d) => setPurgePredicates((ps) => ps.map((p, j) => (j === i ? { ...p, op: d.value } : p)))}
                                  style={{ minWidth: 110 }}
                                >
                                  {(['==', '!=', '>', '<', '>=', '<=', 'contains', 'startswith'] as const).map((op) => (
                                    <option key={op} value={op}>{op}</option>
                                  ))}
                                </Select>
                                <Input
                                  value={pred.value}
                                  onChange={(_, d) => setPurgePredicates((ps) => ps.map((p, j) => (j === i ? { ...p, value: d.value } : p)))}
                                  placeholder="value"
                                  style={{ flex: 1 }}
                                />
                                {purgePredicates.length > 1 && (
                                  <Button
                                    size="small"
                                    appearance="subtle"
                                    icon={<Delete20Regular />}
                                    aria-label="Remove condition"
                                    onClick={() => setPurgePredicates((ps) => ps.filter((_, j) => j !== i))}
                                  />
                                )}
                              </div>
                            ))}
                            <Button
                              size="small"
                              appearance="outline"
                              icon={<Add20Regular />}
                              onClick={() => setPurgePredicates((ps) => [...ps, { column: '', op: '==', value: '' }])}
                              style={{ marginTop: 8 }}
                            >
                              Add condition
                            </Button>
                            <Caption1 style={{ display: 'block', marginTop: 8, color: tokens.colorNeutralForeground3 }}>
                              Predicate:{' '}
                              <code style={{ fontFamily: 'Consolas, monospace' }}>
                                where {purgePredicates.filter((p) => p.column && p.value).map((p) => `["${p.column}"] ${p.op} "${p.value}"`).join(' and ') || '(incomplete)'}
                              </code>
                            </Caption1>
                          </div>
                        )}
                        {purgeErr && <MessageBar intent="error"><MessageBarBody>{purgeErr}</MessageBarBody></MessageBar>}
                      </div>
                    )}

                    {purgeStep === 'verified' && purgeVerifyResult && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <MessageBar intent="warning">
                          <MessageBarBody>
                            <MessageBarTitle>Confirm purge</MessageBarTitle>
                            <strong>{purgeVerifyResult.numRecordsToPurge.toLocaleString()}</strong> record(s) in{' '}
                            <strong>{purgeTable}</strong> will be permanently erased. Estimated purge time:{' '}
                            {purgeVerifyResult.estimatedPurgeExecutionTime || 'unknown'}. This action cannot be undone.
                          </MessageBarBody>
                        </MessageBar>
                        <div>
                          <Label required>Type PURGE to confirm</Label>
                          <Input
                            value={purgeConfirmText}
                            onChange={(_, d) => setPurgeConfirmText(d.value)}
                            placeholder="PURGE"
                            style={{ width: '100%' }}
                          />
                        </div>
                        {purgeErr && <MessageBar intent="error"><MessageBarBody>{purgeErr}</MessageBarBody></MessageBar>}
                      </div>
                    )}

                    {purgeStep === 'done' && purgeCommitResult && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <MessageBar intent="success">
                          <MessageBarBody>
                            <MessageBarTitle>Purge scheduled</MessageBarTitle>
                            Operation ID:{' '}
                            <code style={{ fontFamily: 'Consolas, monospace' }}>{purgeCommitResult.operationId || '(pending)'}</code>.
                            State: {purgeCommitResult.state}. Post-purge match count:{' '}
                            {purgeCommitResult.postPurgeCount != null ? purgeCommitResult.postPurgeCount.toLocaleString() : '(checking…)'}.
                          </MessageBarBody>
                        </MessageBar>
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                          ADX purge runs in the background: Phase 1 (soft-delete; rows no longer visible)
                          completes in minutes to hours; Phase 2 (hard-delete from storage) follows within
                          5–30 days. Track status with{' '}
                          <code style={{ fontFamily: 'Consolas, monospace' }}>.show purges {purgeCommitResult.operationId}</code>{' '}
                          against the data-management endpoint.
                        </Caption1>
                      </div>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setPurgeOpen(false)} disabled={purgeBusy}>
                      {purgeStep === 'done' ? 'Close' : 'Cancel'}
                    </Button>
                    {purgeStep === 'idle' && (
                      <Button
                        appearance="primary"
                        onClick={runPurgeVerify}
                        disabled={purgeBusy || !purgeTable || purgePredicates.every((p) => !p.column || !p.value)}
                      >
                        {purgeBusy ? 'Verifying…' : 'Verify (preview records)'}
                      </Button>
                    )}
                    {purgeStep === 'verified' && (
                      <>
                        <Button appearance="outline" onClick={() => { setPurgeStep('idle'); setPurgeErr(null); }} disabled={purgeBusy}>
                          Back
                        </Button>
                        <Button
                          appearance="primary"
                          onClick={runPurgeCommit}
                          disabled={purgeBusy || purgeConfirmText !== 'PURGE'}
                        >
                          {purgeBusy ? 'Purging…' : 'Commit purge'}
                        </Button>
                      </>
                    )}
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>

            {/* Optimized auto-scale dialog — cluster-level ARM PATCH /clusters */}
            <Dialog open={autoscaleOpen} onOpenChange={(_, d) => setAutoscaleOpen(d.open)}>
              <DialogSurface style={{ maxWidth: 480 }}>
                <DialogBody>
                  <DialogTitle>Optimized auto-scale</DialogTitle>
                  <DialogContent>
                    {state?.sku && (
                      <Caption1 style={{ display: 'block', marginBottom: 8 }}>
                        Cluster SKU: <strong>{state.sku.name}</strong> ({state.sku.tier} tier
                        {typeof state.sku.capacity === 'number' ? `, ${state.sku.capacity} instance${state.sku.capacity === 1 ? '' : 's'}` : ''})
                      </Caption1>
                    )}
                    {isDevSku && (
                      <MessageBar intent="warning" style={{ marginBottom: 12 }}>
                        <MessageBarBody>
                          <MessageBarTitle>Dev/Basic SKU — auto-scale not supported</MessageBarTitle>
                          Optimized auto-scale requires a Standard-tier ADX SKU
                          (e.g. <code>Standard_E2ads_v5</code>). This cluster is on{' '}
                          <strong>{state?.sku?.name}</strong> (Basic tier). Upgrade the
                          cluster SKU via Manage › Scale up, then return here.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, opacity: isDevSku ? 0.5 : 1 }}>
                      <div>
                        <Switch
                          checked={autoscaleEnabled}
                          onChange={(_, d) => setAutoscaleEnabled(!!d.checked)}
                          label={autoscaleEnabled ? 'Optimized auto-scale enabled' : 'Optimized auto-scale disabled'}
                          disabled={isDevSku}
                        />
                        <Caption1>
                          ADX automatically scales instance count between the minimum and
                          maximum based on CPU, cache utilisation, and ingestion load.
                          Predictive + reactive — no custom rules needed.
                        </Caption1>
                      </div>
                      <div>
                        <Label>Minimum instances</Label>
                        <SpinButton
                          min={2}
                          max={autoscaleMax}
                          value={autoscaleMin}
                          onChange={(_, d) => {
                            const v = d.value ?? Number(d.displayValue);
                            if (Number.isFinite(v)) setAutoscaleMin(Math.max(2, Math.min(autoscaleMax, Number(v))));
                          }}
                          disabled={isDevSku || !autoscaleEnabled}
                        />
                        <Caption1>Cluster will never scale below this count (minimum 2).</Caption1>
                      </div>
                      <div>
                        <Label>Maximum instances</Label>
                        <SpinButton
                          min={autoscaleMin}
                          max={1000}
                          value={autoscaleMax}
                          onChange={(_, d) => {
                            const v = d.value ?? Number(d.displayValue);
                            if (Number.isFinite(v)) setAutoscaleMax(Math.max(autoscaleMin, Math.min(1000, Number(v))));
                          }}
                          disabled={isDevSku || !autoscaleEnabled}
                        />
                        <Caption1>Cluster will never scale above this count (maximum 1000).</Caption1>
                      </div>
                    </div>
                    {autoscaleResult && (
                      <MessageBar intent={autoscaleResult.ok ? 'success' : 'error'} style={{ marginTop: 12 }}>
                        <MessageBarBody>
                          {autoscaleResult.msg}
                          {autoscaleResult.provisioningState && (
                            <> — cluster state: <strong>{autoscaleResult.provisioningState}</strong></>
                          )}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setAutoscaleOpen(false)}>Close</Button>
                    <Button appearance="primary" onClick={applyAutoscale} disabled={autoscaleBusy || isDevSku}>
                      {autoscaleBusy ? 'Applying…' : 'Apply'}
                    </Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
          </>
        )}
      </div>
    } />
  );
}

// ----- KQL Database -----
// Ribbon is built inside the editor via useMemo. None of the actions
// below have inline handlers yet (table creation, schema mgmt, ingestion
// wizards all land in a follow-up PR) so each is disabled with a
// "not yet wired" tooltip — see no-vaporware.md.

interface KqlDbInfo {
  ok: boolean;
  cluster?: string;
  database?: string;
  details?: Record<string, unknown> | null;
  tables?: Array<{ name: string; fromContent?: boolean }>;
  tableCount?: number;
  functions?: Array<{ name: string; parameters?: string; fromContent?: boolean }>;
  functionCount?: number;
  materializedViews?: Array<{ name: string; sourceTable?: string }>;
  materializedViewCount?: number;
  // Content-derived projections surfaced when the live ADX object is absent
  // (bundle-installed KQL database not yet provisioned to the cluster). Lets
  // the editor open FULLY BUILT-OUT — schema + starter queries.
  schema?: Array<{ name: string; columns: Array<{ name: string; type: string }>; sample?: unknown[][]; live?: boolean }>;
  starterQueries?: Array<{ name: string; kql: string }>;
  contentFallback?: boolean;
  // Follower (database-shortcut) state — read-only replica of a leader cluster.
  isFollower?: boolean;
  followerLeaderCluster?: string | null;
  followerConfigName?: string | null;
  followerDatabaseName?: string | null;
  error?: string;
}

const SAMPLE_KQL_DB = `// Welcome to KQL. Try a sample:
print smoke = "ok", server_time = now(), current_user = current_principal()`;

// Functions are authored through the structured stored-function editor below
// (params grid + KQL body), so 'function' is intentionally NOT a generic
// wizard kind — it has its own dialog (openFnEditor / submitFnEditor).
type KqlWizardKind = 'table' | 'mv' | 'update-policy' | 'ingest' | 'data-connection' | 'alter-table' | 'drop-table' | 'follower';

const DEFAULT_TABLE_COLUMNS: ColumnDef[] = [
  { name: 'ts', type: 'datetime' },
  { name: 'tenant', type: 'string' },
  { name: 'value', type: 'long' },
];

/** A row from /api/azure/resources (IoT Hub / Event Hub namespace picker). */
interface DcSourceRow { id: string; name: string; resourceGroup?: string; subscriptionId?: string; location?: string }
/** A row from GET /api/items/kql-database/[id]/data-connections. */
interface DcConnectionRow { name?: string; kind?: string; tableName?: string; consumerGroup?: string; dataFormat?: string; provisioningState?: string; source?: string }

// ADX-supported data formats offered by the wizard. RAW is intentionally
// excluded — IoT Hub data connections do not support it (per ADX docs).
const DC_FORMATS = ['MULTIJSON', 'JSON', 'CSV', 'TSV', 'PSV', 'SCSV', 'SOHSV', 'TXT', 'TSVE', 'AVRO', 'APACHEAVRO', 'PARQUET', 'ORC', 'W3CLOGFILE'];

/**
 * Scalar parameter data types accepted in a KQL stored-function signature
 * (`paramName:paramType`). Mirrors the scalar types valid in `let` / function
 * signatures per the .create-or-alter function reference. Surfaced as a real
 * dropdown so the params grid never relies on free-typed type strings.
 */
const FN_PARAM_TYPES = [
  'string', 'long', 'int', 'real', 'double', 'decimal',
  'bool', 'datetime', 'timespan', 'dynamic', 'guid',
] as const;

type FnParam = { name: string; type: string };

/**
 * Parse a KQL function parameters string as returned by `.show functions`
 * (e.g. "(days:int, tenant:string)") into structured rows for the params grid.
 * A no-arg signature ("" or "()") yields [].
 */
function parseFnParams(raw: string | undefined): FnParam[] {
  if (!raw) return [];
  const inner = raw.replace(/^\(/, '').replace(/\)$/, '').trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((p) => {
      const [n, t] = p.split(':');
      return { name: (n || '').trim(), type: (t || 'string').trim() };
    })
    .filter((p) => p.name);
}

/** Serialize the params grid back into the `name:type, …` argument list. */
function serializeFnParams(params: FnParam[]): string {
  return params
    .filter((p) => p.name.trim())
    .map((p) => `${p.name.trim()}:${p.type || 'string'}`)
    .join(', ');
}

export function KqlDatabaseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [info, setInfo] = useState<KqlDbInfo | null>(null);
  const [kql, setKql] = useState(SAMPLE_KQL_DB);
  const [result, setResult] = useState<KqlResult | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumped after a ribbon-wizard create so the AdxDatabaseTree re-lists objects.
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  // Wizard dialog state — Fabric-parity create flows for table/MV/function/update-policy
  const [wizardKind, setWizardKind] = useState<KqlWizardKind | null>(null);
  const [wizName, setWizName] = useState('');
  const [wizSchema, setWizSchema] = useState('ts:datetime, tenant:string, value:long');
  // Visual column-grid state for the table create / alter schema designer.
  const [wizColumns, setWizColumns] = useState<ColumnDef[]>(DEFAULT_TABLE_COLUMNS);
  // For alter-table / drop-table: the target table name (read-only in the dialog).
  const [wizAlterTarget, setWizAlterTarget] = useState('');
  const [wizSource, setWizSource] = useState(''); // table name (mv source / update policy source)
  const [wizQuery, setWizQuery] = useState(''); // MV query / update policy query
  const [wizBackfill, setWizBackfill] = useState(false); // MV: .create async materialized-view with (backfill=true)
  // Live source-table picker for the MV wizard — fetched from /api/adx/tables.
  const [wizTables, setWizTables] = useState<string[]>([]);
  const [wizError, setWizError] = useState<string | null>(null);
  const [wizSubmitting, setWizSubmitting] = useState(false);
  const [wizSuccess, setWizSuccess] = useState<string | null>(null);
  // Ingest wizard
  const [wizIngestFile, setWizIngestFile] = useState<File | null>(null);
  const [wizIngestFormat, setWizIngestFormat] = useState('csv');
  const [wizIngestMapping, setWizIngestMapping] = useState('');
  // Ingestion mapping wizard (format selector + auto-detect column grid)
  const [mappingWizOpen, setMappingWizOpen] = useState(false);
  // Event Hub data-connection wizard
  const [wizDcHub, setWizDcHub] = useState('');
  const [wizDcConsumerGroup, setWizDcConsumerGroup] = useState('');
  const [wizDcFormat, setWizDcFormat] = useState('JSON');
  const [wizDcCompression, setWizDcCompression] = useState('None');
  const [wizDcTargetTable, setWizDcTargetTable] = useState('');
  const [wizDcMappingRule, setWizDcMappingRule] = useState('');
  const [wizDcHubs, setWizDcHubs] = useState<string[]>([]);
  const [wizDcGroups, setWizDcGroups] = useState<string[]>([]);
  const [wizDcTables, setWizDcTables] = useState<string[]>([]);
  const [wizDcConnections, setWizDcConnections] = useState<Array<{ name: string; properties?: any }>>([]);
  const [wizDcNamespace, setWizDcNamespace] = useState('');
  const [wizDcEhGate, setWizDcEhGate] = useState<string | null>(null);
  const [wizDcLoading, setWizDcLoading] = useState(false);
  // Update-policy wizard — table pickers + transform-function selector + transactional toggle
  const [wizTransactional, setWizTransactional] = useState(false);
  const [wizFn, setWizFn] = useState(''); // selected stored function; '' = use inline query
  const [upTables, setUpTables] = useState<string[]>([]);
  const [upFunctions, setUpFunctions] = useState<string[]>([]);
  const [upLoading, setUpLoading] = useState(false);
  // Query | Diagram tab — the Diagram tab is the React Flow entity diagram of
  // the live ADX database (tables / MVs / functions / shortcuts + dependency
  // edges), Fabric RTI schema-graph parity built on the Azure-native cluster.
  const [editorTab, setEditorTab] = useState<'query' | 'diagram'>('query');
  const [graphData, setGraphData] = useState<{ nodes: SchemaGraphNode[]; edges: SchemaGraphEdge[] } | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  // Delete-from-diagram confirmation dialog.
  const [deleteDlgOpen, setDeleteDlgOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; kind: SchemaNodeKind } | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Follower (database-shortcut) wizard
  const [wizLeaderResourceId, setWizLeaderResourceId] = useState('');
  const [wizLeaderUri, setWizLeaderUri] = useState('');
  const [wizFollowerDbName, setWizFollowerDbName] = useState('');
  const [wizPrincipalsKind, setWizPrincipalsKind] = useState<'Union' | 'Replace' | 'None'>('Union');
  // Detach-follower busy flag
  const [detaching, setDetaching] = useState(false);

  const router = useRouter();

  // The workspace item record (for workspaceId, needed by "Create dashboard").
  // Reads from the React Query cache page.tsx already populated (same key), so
  // it does NOT fire an extra network request in normal use.
  const { data: itemRecord } = useQuery<WorkspaceItem>({
    queryKey: ['item', 'kql-database', id],
    queryFn: () => getItem('kql-database', id),
    enabled: !!(id && id !== 'new'),
    staleTime: 60_000,
  });

  // ── Data-connection wizard (Event Hub / IoT Hub → ADX) ──────────────────
  // Azure-native parity for a Fabric Eventhouse data connection. Works with NO
  // Fabric workspace bound — streams device-to-cloud / event messages into a
  // target table via a real Microsoft.Kusto data connection.
  const [dcOpen, setDcOpen] = useState(false);
  const [dcKind, setDcKind] = useState<'iothub' | 'eventhub'>('iothub');
  const [dcSources, setDcSources] = useState<DcSourceRow[] | null>(null);
  const [dcSourcesErr, setDcSourcesErr] = useState<string | null>(null);
  const [dcSourcesLoading, setDcSourcesLoading] = useState(false);
  const [dcSelectedSourceId, setDcSelectedSourceId] = useState('');
  const [dcPolicies, setDcPolicies] = useState<{ name: string; rights?: string }[]>([]);
  const [dcPolicyNote, setDcPolicyNote] = useState<string | null>(null);
  const [dcPolicy, setDcPolicy] = useState('iothubowner');
  const [dcConsumerGroup, setDcConsumerGroup] = useState('$Default');
  const [dcFormat, setDcFormat] = useState('MULTIJSON');
  const [dcTable, setDcTable] = useState('');
  const [dcEhEntity, setDcEhEntity] = useState(''); // Event Hub entity name (eventhub kind only)
  const [dcBusy, setDcBusy] = useState(false);
  const [dcError, setDcError] = useState<string | null>(null);
  const [dcSuccess, setDcSuccess] = useState<string | null>(null);
  const [dcExisting, setDcExisting] = useState<DcConnectionRow[] | null>(null);

  // ---- Stored function editor (params grid + KQL body, /api/adx/functions) ----
  // Owned here so both the ribbon (New → Function) and the navigator's per-row
  // "Edit function" affordance open the same structured editor.
  const [fnDlgOpen, setFnDlgOpen] = useState(false);
  const [fnDlgMode, setFnDlgMode] = useState<'create' | 'edit'>('create');
  const [fnName, setFnName] = useState('');
  const [fnNameLocked, setFnNameLocked] = useState(false); // true in edit mode
  const [fnParams, setFnParams] = useState<FnParam[]>([]);
  const [fnBody, setFnBody] = useState('');
  const [fnErr, setFnErr] = useState<string | null>(null);
  const [fnBusy, setFnBusy] = useState(false);
  const [fnDeleteBusy, setFnDeleteBusy] = useState(false);
  const [fnReceipt, setFnReceipt] = useState<{ name: string; action: 'saved' | 'deleted'; rowCount?: number; ts: string } | null>(null);

  const load = useCallback(async () => {
    // Pre-save gate: /items/kql-database/new fires this before any record exists.
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/kql-database/${id}`);
      const j = (await r.json()) as KqlDbInfo;
      setInfo(j);
      // Re-list the navigator (ribbon wizards call load() after a create).
      setTreeRefreshKey((k) => k + 1);
    } catch (e: any) {
      setInfo({ ok: false, error: e?.message || String(e) });
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const run = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kql }),
      });
      setResult((await r.json()) as KqlResult);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    } finally {
      setLoading(false);
    }
  }, [id, kql]);

  // Shift+Enter runs the query (the "Run (Shift+Enter)" button label promises
  // this). Only fires when focus is inside the KQL editor surface so it never
  // hijacks the shortcut elsewhere on the page. Mirrors the Ctrl+S pattern
  // used by the Queryset / Dashboard / Eventstream editors.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.shiftKey) {
        const active = document.activeElement as HTMLElement | null;
        const inEditor = !!active?.closest?.('[aria-label="KQL query editor"]');
        if (inEditor && !loading && id && id !== 'new') {
          e.preventDefault();
          run();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loading, id, run]);

  /**
   * Create a kql-dashboard item in the same workspace as this kql-database,
   * seed its first tile with a `| take 100` for the given table, then navigate
   * to the new dashboard. Mirrors the ADX web UI / Fabric "Create dashboard"
   * table context-menu action. Azure-native: uses Cosmos item creation via
   * POST /api/workspaces/<id>/items + PUT /api/items/kql-dashboard/<id>.
   * No Fabric REST involved.
   */
  const createDashboardFromTable = useCallback(async (tableName: string) => {
    const wsId = itemRecord?.workspaceId;
    const kqlTile = `["${tableName}"]\n| take 100`;
    const displayName = `${tableName} — Dashboard`;
    if (!wsId) {
      // No workspace context yet (item not loaded). Fall back to empty new-item flow.
      router.push(`/items/kql-dashboard/new`);
      return;
    }
    try {
      // Step 1: create the Cosmos item (POST /api/workspaces/<wsId>/items).
      const created = await createItem(wsId, { itemType: 'kql-dashboard', displayName });
      // Step 2: seed the first tile (PUT /api/items/kql-dashboard/<id>).
      await fetch(`/api/items/kql-dashboard/${created.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tiles: [{ title: tableName, kql: kqlTile, viz: 'table' }],
          dataSources: [],
          parameters: [],
        }),
      });
      // Step 3: navigate. Receipt = user arrives at the working dashboard editor.
      router.push(`/items/kql-dashboard/${created.id}`);
    } catch {
      // Best-effort fallback: open new dashboard without pre-seeded tile.
      router.push(`/items/kql-dashboard/new`);
    }
  }, [itemRecord, router]);

  // Load Event Hub pickers (namespace, hubs, tables, existing connections) when
  // the data-connection wizard opens. Real ARM via the data-connections route.
  useEffect(() => {
    if (wizardKind !== 'data-connection' || !id || id === 'new') return;
    setWizDcLoading(true);
    setWizDcHubs([]); setWizDcGroups([]); setWizDcEhGate(null);
    fetch(`/api/items/kql-database/${id}/data-connections`)
      .then((r) => r.json())
      .then((j: any) => {
        if (j?.ok === false && j?.code === 'not_configured') {
          setWizDcEhGate((j.missing && (Array.isArray(j.missing) ? j.missing.join(', ') : j.missing)) || 'ADX cluster env');
          return;
        }
        setWizDcNamespace(j.namespace || '');
        setWizDcHubs(j.eventHubs || []);
        setWizDcTables(j.tables || []);
        setWizDcConnections(j.connections || []);
        setWizDcEhGate(j.ehNotConfigured || null);
      })
      .catch(() => { /* leave empty — the wizard surfaces the gate */ })
      .finally(() => setWizDcLoading(false));
  }, [wizardKind, id]);

  // Refresh the dedicated consumer-group list when the selected hub changes
  // (each ADX data connection needs its OWN consumer group, per Azure docs).
  useEffect(() => {
    if (wizardKind !== 'data-connection' || !wizDcHub || !id || id === 'new') return;
    setWizDcGroups([]);
    fetch(`/api/items/kql-database/${id}/data-connections?hub=${encodeURIComponent(wizDcHub)}`)
      .then((r) => r.json())
      .then((j: any) => setWizDcGroups(j.consumerGroups || []))
      .catch(() => { /* leave empty */ });
  }, [wizardKind, wizDcHub, id]);

  // Lazy-load the entity diagram graph from the live ADX schema. Only fires
  // for a saved database (id !== 'new'). Real backend: GET schema-graph →
  // .show database schema as json + .show materialized-views + .show functions.
  const loadGraph = useCallback(async () => {
    if (!id || id === 'new') return;
    setGraphLoading(true); setGraphError(null);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/schema-graph`);
      const j = await r.json();
      if (!j.ok) setGraphError(j.error || 'Schema graph failed');
      else setGraphData({ nodes: j.nodes || [], edges: j.edges || [] });
    } catch (e: any) {
      setGraphError(e?.message || String(e));
    } finally {
      setGraphLoading(false);
    }
  }, [id]);

  // Fetch the graph the first time the Diagram tab is opened (and after a
  // delete clears graphData). Narrow deps so it doesn't re-fetch on every
  // graphData change.
  useEffect(() => {
    if (editorTab === 'diagram' && !graphData && !graphLoading && id && id !== 'new') {
      loadGraph();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorTab, graphData, id]);

  // Drop a table / materialized-view / function from the diagram. Issues a real
  // `.drop ... ifexists` mgmt command via the existing /query route (mgmt
  // commands starting with `.` are auto-routed to /v1/rest/mgmt) against ADX.
  const deleteFromDiagram = useCallback(async () => {
    if (!deleteTarget) return;
    const { name, kind } = deleteTarget;
    const cmd =
      kind === 'table' ? `.drop table ["${name}"] ifexists`
      : kind === 'materialized-view' ? `.drop materialized-view ["${name}"] ifexists`
      : kind === 'function' ? `.drop function ["${name}"] ifexists`
      : kind === 'shortcut' ? `.drop external table ["${name}"]`
      : null;
    if (!cmd) { setDeleteError('This entity type cannot be deleted from the diagram.'); return; }
    setDeleteSubmitting(true); setDeleteError(null);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kql: cmd }),
      });
      const j = await r.json();
      if (!j.ok) { setDeleteError(j.error || 'Delete failed'); return; }
      setDeleteDlgOpen(false); setDeleteTarget(null);
      setGraphData(null); // force the Diagram tab to re-fetch
      await Promise.all([load(), loadGraph()]);
    } catch (e: any) {
      setDeleteError(e?.message || String(e));
    } finally {
      setDeleteSubmitting(false);
    }
  }, [deleteTarget, id, load, loadGraph]);

  const openWizard = useCallback((k: KqlWizardKind, preTable?: string) => {
    setWizardKind(k); setWizError(null); setWizSuccess(null);
    setWizName(''); setWizSchema('ts:datetime, tenant:string, value:long');
    setWizColumns(DEFAULT_TABLE_COLUMNS); setWizAlterTarget('');
    // preTable: when called from a tree "Get data" hover, pre-fill the target table.
    setWizSource(preTable || ''); setWizQuery(''); setWizIngestFile(null);
    setWizIngestFormat('csv'); setWizIngestMapping('');
    // Event Hub data-connection fields
    setWizDcHub(''); setWizDcConsumerGroup(''); setWizDcFormat('JSON');
    setWizDcCompression('None'); setWizDcTargetTable(''); setWizDcMappingRule('');
    setWizDcHubs([]); setWizDcGroups([]); setWizDcTables([]); setWizDcConnections([]);
    setWizDcNamespace(''); setWizDcEhGate(null);
    setWizBackfill(false);
    setWizTransactional(false); setWizFn(''); setUpTables([]); setUpFunctions([]);
    setWizLeaderResourceId(''); setWizLeaderUri(''); setWizFollowerDbName(''); setWizPrincipalsKind('Union');
    // MV + ingest + update-policy wizards need a live source-table picker —
    // pull the real table list off the bound ADX/Eventhouse cluster.
    if ((k === 'mv' || k === 'ingest' || k === 'update-policy') && id && id !== 'new') {
      setWizTables([]);
      fetch(`/api/adx/tables?id=${encodeURIComponent(id)}`)
        .then((r) => r.json())
        .then((j) => {
          if (j?.ok && Array.isArray(j.tables)) {
            setWizTables(j.tables.map((t: { name: string }) => t.name).filter(Boolean));
          }
        })
        .catch(() => { /* picker falls back to free-text via info.tables */ });
    }
  }, [id]);

  // When the update-policy wizard opens, populate the table pickers and the
  // transform-function selector from the live database (real .show tables /
  // .show functions via the existing ADX navigator routes). Best-effort: a
  // load failure leaves empty dropdowns; the user can still type a function
  // call into the inline-query box.
  useEffect(() => {
    if (wizardKind !== 'update-policy' || !id || id === 'new') return;
    let cancelled = false;
    setUpLoading(true);
    Promise.all([
      fetch(`/api/adx/tables?id=${id}`).then((r) => r.json()),
      fetch(`/api/adx/functions?id=${id}`).then((r) => r.json()),
    ]).then(([tj, fj]) => {
      if (cancelled) return;
      setUpTables(((tj.tables || []) as Array<{ name: string }>).map((t) => t.name));
      setUpFunctions(((fj.functions || []) as Array<{ name: string }>).map((f) => f.name));
    }).catch(() => { /* best-effort — leave dropdowns empty */ })
      .finally(() => { if (!cancelled) setUpLoading(false); });
    return () => { cancelled = true; };
  }, [wizardKind, id]);

  // Open the schema designer in ALTER mode for an existing table. Fetches the
  // current CSL schema so the grid pre-populates with the live columns; the
  // analyst then appends new columns (.alter-merge — additive, no data loss).
  const openAlterTable = useCallback(async (tableName: string) => {
    setWizardKind('alter-table'); setWizError(null); setWizSuccess(null);
    setWizAlterTarget(tableName); setWizColumns([]);
    try {
      const r = await fetch(`/api/adx/tables?id=${encodeURIComponent(id)}&schema=${encodeURIComponent(tableName)}`);
      const j = await r.json();
      if (j.ok && j.cslSchema) setWizColumns(parseKustoSchema(j.cslSchema));
    } catch {
      // Pre-population is best-effort — the analyst can still add columns.
    }
  }, [id]);

  const openDropTable = useCallback((tableName: string) => {
    setWizardKind('drop-table'); setWizError(null); setWizSuccess(null);
    setWizAlterTarget(tableName);
  }, []);

  // Submit the wizard. Table create / alter / drop go through the dedicated
  // `/api/adx/tables` route (POST/PATCH/DELETE → real .create / .alter-merge /
  // .drop control commands). The other object types issue a `.` mgmt command
  // via the query route (auto-routed to /v1/rest/mgmt). No mocks.
  const submitWizard = useCallback(async () => {
    if (!wizardKind) return;
    setWizError(null); setWizSuccess(null);

    // Event Hub data connection — ARM REST, NOT a `.create` mgmt command.
    if (wizardKind === 'data-connection') {
      if (wizDcEhGate) { setWizError(`Event Hubs not configured: set ${wizDcEhGate}`); return; }
      if (!wizDcHub) { setWizError('Event hub is required'); return; }
      if (!wizDcConsumerGroup) { setWizError('Consumer group is required'); return; }
      setWizSubmitting(true);
      try {
        const r = await fetch(`/api/items/kql-database/${id}/data-connections`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: wizName.trim() || undefined,
            eventHubName: wizDcHub,
            consumerGroup: wizDcConsumerGroup,
            tableName: wizDcTargetTable || undefined,
            mappingRuleName: wizDcMappingRule.trim() || undefined,
            dataFormat: wizDcFormat,
            compression: wizDcCompression,
          }),
        });
        const j = await r.json();
        if (!j.ok) {
          setWizError(j.error || (j.missing ? `Not configured: ${j.missing}` : 'Create failed'));
        } else {
          const st = j.connection?.properties?.provisioningState ?? 'Creating';
          setWizSuccess(`Data connection "${j.connection?.name}" created (state: ${st}). Streaming ingestion starts within seconds. Refreshing…`);
          await load();
          setTimeout(() => setWizardKind(null), 900);
        }
      } catch (e: any) {
        setWizError(e?.message || String(e));
      } finally {
        setWizSubmitting(false);
      }
      return;
    }

    // --- Table schema designer flows (dedicated ADX route) ---
    if (wizardKind === 'table' || wizardKind === 'alter-table' || wizardKind === 'drop-table') {
      const tablesRoute = `/api/adx/tables?id=${encodeURIComponent(id)}`;
      setWizSubmitting(true);
      try {
        let res: Response;
        let receipt = '';
        if (wizardKind === 'table') {
          if (!wizName.trim()) { setWizError('Table name is required'); setWizSubmitting(false); return; }
          const colErr = validateColumns(wizColumns);
          if (colErr) { setWizError(colErr); setWizSubmitting(false); return; }
          const schema = toKustoSchema(wizColumns);
          res = await fetch(tablesRoute, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: wizName.trim(), schema }),
          });
          receipt = `Table "${wizName.trim()}" created — .create table ["${wizName.trim()}"] (${schema}).`;
        } else if (wizardKind === 'alter-table') {
          const colErr = validateColumns(wizColumns);
          if (colErr) { setWizError(colErr); setWizSubmitting(false); return; }
          const schema = toKustoSchema(wizColumns);
          res = await fetch(tablesRoute, {
            method: 'PATCH', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: wizAlterTarget, schema }),
          });
          receipt = `Table "${wizAlterTarget}" altered — .alter-merge table ["${wizAlterTarget}"] (${schema}).`;
        } else {
          res = await fetch(`${tablesRoute}&name=${encodeURIComponent(wizAlterTarget)}`, { method: 'DELETE' });
          receipt = `Table "${wizAlterTarget}" dropped — .drop table ["${wizAlterTarget}"] ifexists.`;
        }
        const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
        if (!j.ok) {
          setWizError(j.error || 'Command failed');
        } else {
          setWizSuccess(`Done. ${receipt} Refreshing…`);
          await load();
          setTimeout(() => { setWizardKind(null); }, 800);
        }
      } catch (e: any) {
        setWizError(e?.message || String(e));
      } finally {
        setWizSubmitting(false);
      }
      return;
    }

    // Follower (database-shortcut) attach — does NOT issue a `.` mgmt command;
    // it PUTs an attachedDatabaseConfiguration via the dedicated ARM route.
    if (wizardKind === 'follower') {
      if (!wizLeaderResourceId.trim()) { setWizError('Leader cluster ARM resource ID is required'); return; }
      setWizSubmitting(true);
      try {
        const r = await fetch(`/api/items/kql-database/${id}/follower`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            leaderClusterResourceId: wizLeaderResourceId.trim(),
            leaderClusterUri: wizLeaderUri.trim(),
            databaseName: wizFollowerDbName.trim() || '*',
            principalsModificationKind: wizPrincipalsKind,
          }),
        });
        const j = await r.json();
        if (!j.ok) {
          setWizError(j.error || (Array.isArray(j.missing) ? `Not configured: ${j.missing.join(', ')}` : 'Attach failed'));
        } else {
          setWizSuccess(`Follower attach ${j.provisioningState} (config ${j.configName}). Refreshing…`);
          await load();
          setTimeout(() => { setWizardKind(null); }, 900);
        }
      } catch (e: any) {
        setWizError(e?.message || String(e));
      } finally {
        setWizSubmitting(false);
      }
      return;
    }

    if (wizardKind !== 'ingest' && !wizName.trim()) {
      setWizError('Name is required');
      return;
    }
    let mgmtCmd = '';
    switch (wizardKind) {
      case 'mv':
        if (!wizSource || !wizQuery) { setWizError('Source table + query required'); return; }
        // Materialized views go through the dedicated /api/adx/materialized-views
        // route so the backfill toggle maps to `.create async materialized-view
        // with (backfill=true)`. Short-circuit the generic /query path below.
        setWizSubmitting(true);
        try {
          const res = await fetch(`/api/adx/materialized-views?id=${encodeURIComponent(id)}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: wizName, sourceTable: wizSource, query: wizQuery, backfill: wizBackfill }),
          });
          const jj = await res.json();
          if (!jj.ok) {
            setWizError(jj.error || 'Command failed');
          } else {
            setWizSuccess(
              wizBackfill
                ? `Backfill started async (operation row returned). Track with .show materialized-views / .show operations. Refreshing…`
                : `Materialized view '${jj.name}' created. ${jj.rowCount ?? 0} rows. Refreshing…`,
            );
            await load();
            setTimeout(() => { setWizardKind(null); }, 600);
          }
        } catch (e: any) {
          setWizError(e?.message || String(e));
        } finally {
          setWizSubmitting(false);
        }
        return;
      case 'update-policy': {
        // Target table = wizName; source table = wizSource. Prefer a stored
        // function (wizFn) over the inline KQL query (wizQuery).
        if (!wizName.trim() || !wizSource.trim()) { setWizError('Target table and source table are required'); return; }
        const queryValue = wizFn ? `${wizFn}()` : wizQuery.trim();
        if (!queryValue) { setWizError('Transform function or inline KQL query is required'); return; }
        setWizSubmitting(true);
        try {
          // POST to the dedicated policies route (.alter table policy update),
          // NOT the generic query route — the route reads the policy back as a receipt.
          const r2 = await fetch(`/api/adx/policies?id=${id}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              targetTable: wizName.trim(),
              source: wizSource.trim(),
              query: queryValue,
              isTransactional: wizTransactional,
              propagateIngestionProperties: false,
            }),
          });
          const j2 = await r2.json();
          if (!j2.ok) { setWizError(j2.error || 'Command failed'); return; }
          const receipt = j2.policy?.raw ? ` Receipt: ${j2.policy.raw}` : '';
          setWizSuccess(`Update policy applied to ${j2.targetTable}.${receipt}`);
          await load();
          setTimeout(() => { setWizardKind(null); }, 2500);
        } catch (e: any) {
          setWizError(e?.message || String(e));
        } finally {
          setWizSubmitting(false);
        }
        return; // dedicated route handled the submit — skip the common mgmtCmd path
      }
      case 'ingest': {
        if (!wizIngestFile) { setWizError('Choose a file to ingest'); return; }
        if (!wizSource) { setWizError('Target table required'); return; }
        const fmt = wizIngestFormat;
        const mapRef = wizIngestMapping.trim();
        // Binary formats (Parquet/Avro/ORC) can't be ingested inline — surface
        // the real blob-ingest command template instead.
        if (['parquet', 'avro', 'orc'].includes(fmt)) {
          const blobCmd = [
            `// ${fmt.toUpperCase()} is a binary format — inline ingest is not supported.`,
            `// Ingest from blob storage using the mapping you created:`,
            `.ingest into table ["${wizSource}"] from @'https://<account>.blob.core.windows.net/<container>/<file>.${fmt}'`,
            mapRef
              ? `  with (format='${fmt}', ingestionMappingReference='${mapRef}')`
              : `  with (format='${fmt}')`,
          ].join('\n');
          setKql(blobCmd);
          setWizardKind(null);
          const el = document.querySelector('textarea[aria-label="KQL query editor"]') as HTMLTextAreaElement | null;
          el?.focus();
          return;
        }
        // Real inline ingest for small text files (CSV/TSV/PSV/JSON).
        if (wizIngestFile.size > 5 * 1024 * 1024) { setWizError('File too large for inline ingest (5 MB max). Use a Get-data pipeline or ingest from blob.'); return; }
        const text = await wizIngestFile.text();
        const lines = text.split(/\r?\n/).filter(Boolean);
        // For CSV-family identity ingest (no mapping reference) the header row would
        // be ingested as data — strip it. With an explicit mapping reference the
        // mapping addresses columns by Ordinal/Path so the header must also go.
        const csvFamily = ['csv', 'tsv', 'psv'].includes(fmt);
        if (csvFamily && lines.length > 0 && /[a-zA-Z]/.test(lines[0])) lines.shift();
        const body = lines.join('\n');
        const withClause = [
          `format='${fmt}'`,
          mapRef ? `ingestionMappingReference='${mapRef}'` : '',
        ].filter(Boolean).join(', ');
        mgmtCmd = `.ingest inline into table ["${wizSource}"] with (${withClause}) <|\n${body}`;
        break;
      }
    }
    setWizSubmitting(true);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kql: mgmtCmd }),
      });
      const j = await r.json();
      if (!j.ok) {
        setWizError(j.error || 'Command failed');
      } else {
        setWizSuccess(`Done. ${j.rowCount ?? 0} rows. Refreshing…`);
        await load();
        setTimeout(() => { setWizardKind(null); }, 600);
      }
    } catch (e: any) {
      setWizError(e?.message || String(e));
    } finally {
      setWizSubmitting(false);
    }
  }, [wizardKind, wizName, wizSchema, wizColumns, wizAlterTarget, wizSource, wizQuery, wizBackfill, wizIngestFile, wizIngestFormat, wizIngestMapping, wizFn, wizTransactional, wizLeaderResourceId, wizLeaderUri, wizFollowerDbName, wizPrincipalsKind, id, load,
      wizDcEhGate, wizDcHub, wizDcConsumerGroup, wizDcTargetTable, wizDcMappingRule, wizDcFormat, wizDcCompression]);

  // ---------------------------------------------------------------
  // Stored function editor (params grid + KQL body) — real control
  // commands via the dedicated /api/adx/functions BFF route
  // (.create-or-alter function / .drop function on /v1/rest/mgmt).
  // ---------------------------------------------------------------
  const openFnEditor = useCallback((fn?: { name: string; parameters?: string; body?: string }) => {
    setFnErr(null); setFnReceipt(null); setFnBusy(false); setFnDeleteBusy(false);
    if (fn) {
      setFnDlgMode('edit');
      setFnName(fn.name);
      setFnNameLocked(true);
      setFnParams(parseFnParams(fn.parameters));
      // .show functions returns the body wrapped in `{ … }`; strip the braces
      // for editing — createFunction re-wraps it on save.
      setFnBody((fn.body || '').replace(/^\s*\{/, '').replace(/\}\s*$/, '').trim());
    } else {
      setFnDlgMode('create');
      setFnName('');
      setFnNameLocked(false);
      setFnParams([]);
      setFnBody('');
    }
    setFnDlgOpen(true);
  }, []);

  const submitFnEditor = useCallback(async () => {
    if (!fnName.trim()) { setFnErr('Function name is required'); return; }
    if (!fnBody.trim()) { setFnErr('Body is required, e.g. "events | take 10"'); return; }
    setFnBusy(true); setFnErr(null); setFnReceipt(null);
    try {
      const res = await fetch(`/api/adx/functions?id=${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: fnName.trim(),
          args: serializeFnParams(fnParams),
          body: fnBody.trim(),
        }),
      });
      const j = await res.json();
      if (!j.ok) { setFnErr(j.error || `Save failed (HTTP ${res.status})`); return; }
      setFnReceipt({ name: fnName.trim(), action: 'saved', rowCount: j.rowCount, ts: new Date().toISOString() });
      setTreeRefreshKey((k) => k + 1);
      setFnNameLocked(true); // it now exists — re-saves are alters
      setFnDlgMode('edit');
    } catch (e: any) {
      setFnErr(e?.message || String(e));
    } finally {
      setFnBusy(false);
    }
  }, [id, fnName, fnParams, fnBody]);

  const deleteFnEditor = useCallback(async () => {
    if (!fnName.trim()) return;
    setFnDeleteBusy(true); setFnErr(null); setFnReceipt(null);
    try {
      const res = await fetch(
        `/api/adx/functions?id=${encodeURIComponent(id)}&name=${encodeURIComponent(fnName.trim())}`,
        { method: 'DELETE' },
      );
      const j = await res.json();
      if (!j.ok) { setFnErr(j.error || `Delete failed (HTTP ${res.status})`); return; }
      setFnReceipt({ name: fnName.trim(), action: 'deleted', ts: new Date().toISOString() });
      setTreeRefreshKey((k) => k + 1);
      setTimeout(() => setFnDlgOpen(false), 900);
    } catch (e: any) {
      setFnErr(e?.message || String(e));
    } finally {
      setFnDeleteBusy(false);
    }
  }, [id, fnName]);

  // Detach the follower configuration — restores read/write on the item.
  const detachFollower = useCallback(async () => {
    if (!info?.followerConfigName) return;
    setDetaching(true);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/follower?configName=${encodeURIComponent(info.followerConfigName)}`, {
        method: 'DELETE',
      });
      const j = await r.json();
      if (j.ok) await load();
    } finally {
      setDetaching(false);
    }
  }, [info?.followerConfigName, id, load]);

  // ── Data-connection wizard handlers ─────────────────────────────────────
  const ARM_TYPE_BY_KIND: Record<'iothub' | 'eventhub', string> = {
    iothub: 'Microsoft.Devices/IotHubs',
    eventhub: 'Microsoft.EventHub/namespaces',
  };

  // List the existing data connections on this database (real ARM REST).
  const loadDcExisting = useCallback(async () => {
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/kql-database/${id}/data-connections`);
      const j = await r.json();
      setDcExisting(j.ok ? (j.connections ?? []) : []);
    } catch {
      setDcExisting([]);
    }
  }, [id]);

  // Discover IoT Hubs / Event Hub namespaces via Resource Graph (per-user RBAC).
  const discoverDcSources = useCallback(async (kind: 'iothub' | 'eventhub') => {
    setDcSourcesLoading(true);
    setDcSources(null);
    setDcSourcesErr(null);
    setDcSelectedSourceId('');
    setDcPolicies([]);
    setDcPolicyNote(null);
    try {
      const r = await fetch(`/api/azure/resources?type=${encodeURIComponent(ARM_TYPE_BY_KIND[kind])}`);
      const j = await r.json();
      const rows: DcSourceRow[] = Array.isArray(j.resources) ? j.resources : [];
      if (!j.ok || rows.length === 0) {
        const noun = kind === 'iothub' ? 'IoT Hub (Microsoft.Devices/IotHubs)' : 'Event Hubs namespace (Microsoft.EventHub/namespaces)';
        setDcSourcesErr(
          j.error ||
          `No ${noun} found in the subscriptions visible to Loom. Provision the resource ` +
          `(or grant the Loom identity Reader access at the management-group scope) to enable this connection.`,
        );
        setDcSources([]);
      } else {
        setDcSources(rows);
      }
    } catch (e: any) {
      setDcSourcesErr(e?.message || String(e));
      setDcSources([]);
    } finally {
      setDcSourcesLoading(false);
    }
  }, []);

  const openDcWizard = useCallback(() => {
    setDcOpen(true);
    setDcKind('iothub');
    setDcError(null);
    setDcSuccess(null);
    setDcConsumerGroup('$Default');
    setDcFormat('MULTIJSON');
    setDcPolicy('iothubowner');
    setDcTable('');
    discoverDcSources('iothub');
    loadDcExisting();
  }, [discoverDcSources, loadDcExisting]);

  const onDcKindChange = useCallback((kind: 'iothub' | 'eventhub') => {
    setDcKind(kind);
    setDcError(null);
    setDcSuccess(null);
    setDcFormat(kind === 'iothub' ? 'MULTIJSON' : 'JSON');
    discoverDcSources(kind);
  }, [discoverDcSources]);

  // When an IoT Hub is picked, fetch its shared-access policy names.
  const onDcSourceChange = useCallback(async (sourceId: string) => {
    setDcSelectedSourceId(sourceId);
    setDcPolicies([]);
    setDcPolicyNote(null);
    if (dcKind !== 'iothub' || !sourceId) return;
    try {
      const r = await fetch(`/api/azure/iothub/policies?iotHubId=${encodeURIComponent(sourceId)}`);
      const j = await r.json();
      const list = (j.ok ? j.policies : j.fallback) ?? [];
      setDcPolicies(list);
      if (!j.ok && j.error) setDcPolicyNote(j.error);
      // Prefer a ServiceConnect policy for ADX ingestion.
      const preferred = list.find((p: any) => /service/i.test(p.name)) || list.find((p: any) => /iothubowner/i.test(p.name)) || list[0];
      if (preferred) setDcPolicy(preferred.name);
    } catch (e: any) {
      setDcPolicyNote(e?.message || String(e));
      setDcPolicies([{ name: 'iothubowner' }, { name: 'service' }]);
      setDcPolicy('iothubowner');
    }
  }, [dcKind]);

  const submitDc = useCallback(async () => {
    setDcError(null);
    setDcSuccess(null);
    if (!dcSelectedSourceId) { setDcError(dcKind === 'iothub' ? 'Select an IoT Hub' : 'Select an Event Hubs namespace'); return; }
    if (!dcTable.trim()) { setDcError('Target table is required'); return; }
    let payload: Record<string, unknown>;
    if (dcKind === 'iothub') {
      if (!dcPolicy) { setDcError('Select a shared access policy'); return; }
      payload = {
        kind: 'iothub',
        iotHubResourceId: dcSelectedSourceId,
        sharedAccessPolicyName: dcPolicy,
        consumerGroup: dcConsumerGroup || '$Default',
        dataFormat: dcFormat,
        tableName: dcTable.trim(),
      };
    } else {
      // Event Hub: the picker selects a NAMESPACE; the operator names the event
      // hub entity inside it. Compose the full eventhubs child resource id.
      if (!dcEhEntity.trim()) { setDcError('Event Hub entity name is required'); return; }
      payload = {
        kind: 'eventhub',
        eventHubResourceId: `${dcSelectedSourceId}/eventhubs/${dcEhEntity.trim()}`,
        consumerGroup: dcConsumerGroup || '$Default',
        dataFormat: dcFormat,
        tableName: dcTable.trim(),
      };
    }
    setDcBusy(true);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/data-connections`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (!j.ok) {
        setDcError(j.error || 'Failed to create data connection');
      } else {
        setDcSuccess(`Data connection "${j.connectionName}" — ${j.provisioningState || 'Creating'}. Device-to-cloud messages will land in ${dcTable.trim()}.`);
        await loadDcExisting();
      }
    } catch (e: any) {
      setDcError(e?.message || String(e));
    } finally {
      setDcBusy(false);
    }
  }, [dcKind, dcSelectedSourceId, dcPolicy, dcConsumerGroup, dcFormat, dcTable, dcEhEntity, id, loadDcExisting]);

  const deleteDc = useCallback(async (connectionName?: string) => {
    if (!connectionName) return;
    setDcBusy(true);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/data-connections`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionName }),
      });
      const j = await r.json();
      if (!j.ok) setDcError(j.error || 'Delete failed');
      else await loadDcExisting();
    } catch (e: any) {
      setDcError(e?.message || String(e));
    } finally {
      setDcBusy(false);
    }
  }, [id, loadDcExisting]);

  const ribbon: RibbonTab[] = useMemo(() => {
    const isFollower = !!info?.isFollower;
    const roTitle = 'Follower databases are read-only — write operations are blocked. Detach the follower to write.';
    return [
      { id: 'home', label: 'Home', groups: [
        { label: 'New', actions: [
          { label: 'Table', onClick: () => openWizard('table'), disabled: isFollower, title: isFollower ? roTitle : undefined },
          { label: 'Materialized view', onClick: () => openWizard('mv'), disabled: isFollower, title: isFollower ? roTitle : undefined },
          { label: 'Function', onClick: () => openFnEditor(), disabled: isFollower, title: isFollower ? roTitle : undefined },
          { label: 'Update policy', onClick: () => openWizard('update-policy'), disabled: isFollower, title: isFollower ? roTitle : undefined },
          { label: 'Ingestion mapping', onClick: () => setMappingWizOpen(true), disabled: isFollower, title: isFollower ? roTitle : undefined },
          { label: 'Shortcut (follower DB)',
            onClick: () => openWizard('follower'),
            disabled: isFollower,
            title: isFollower ? 'Already attached as a follower. Detach first to re-point.' : 'Attach a leader cluster database as a read-only follower (Azure-native database shortcut)' },
        ]},
        { label: 'Data', actions: [
          { label: 'Get data', onClick: () => openWizard('ingest'), disabled: isFollower, title: isFollower ? roTitle : undefined },
          { label: 'Data connections', onClick: () => openWizard('data-connection'), disabled: isFollower, title: isFollower ? roTitle : undefined },
          { label: 'Query with code', onClick: () => {
            // Already in code editor — focus the textarea.
            const el = document.querySelector('textarea[aria-label="KQL query editor"]') as HTMLTextAreaElement | null;
            el?.focus();
          } },
        ]},
        { label: 'Connections', actions: [
          { label: 'Add data connection', onClick: openDcWizard },
        ]},
        { label: 'Manage', actions: [
          { label: 'Data policies', onClick: () => { setKql('.show database policy caching\n.show database policy retention'); } },
          { label: 'OneLake availability', disabled: true, title: 'OneLake mirroring requires Fabric-managed cluster (LOOM_KUSTO_FABRIC_MANAGED=true)' },
        ]},
      ]},
    ];
  }, [openWizard, openFnEditor, openDcWizard, info?.isFollower]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        id && id !== 'new'
          ? (
            <AdxDatabaseTree
              itemId={id}
              refreshKey={treeRefreshKey}
              onAlterTable={openAlterTable}
              onDropTable={openDropTable}
              onOpenQuery={(q) => {
                setKql(q);
                const el = document.querySelector('textarea[aria-label="KQL query editor"]') as HTMLTextAreaElement | null;
                el?.focus();
              }}
              onEditFunction={(fn) => openFnEditor(fn)}
              onGetData={(tableName) => openWizard('ingest', tableName)}
              onCreateDashboard={createDashboardFromTable}
            />
          )
          : (
            <div className={s.treePad}>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Save the KQL database first</MessageBarTitle>
                  The object navigator (Tables, Functions, Materialized views, Ingestion mappings)
                  appears once this database is saved and bound to a Kusto database.
                </MessageBarBody>
              </MessageBar>
            </div>
          )
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">KQL Database</Badge>
            <Badge appearance="outline" color={info?.ok ? 'success' : 'severe'}>
              {info?.cluster || 'cluster not configured'}
            </Badge>
            <Caption1>db: <strong>{info?.database || '—'}</strong></Caption1>
            {info?.isFollower && (
              <Badge appearance="filled" color="warning" title="Attached read-only follower (database shortcut)">
                Read-only (follower)
              </Badge>
            )}
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={load}>Refresh</Button>
            {info?.isFollower && (
              <Button appearance="outline" icon={<Delete20Regular />} disabled={detaching} onClick={detachFollower}>
                {detaching ? 'Detaching…' : 'Detach follower'}
              </Button>
            )}
            <Button appearance="primary" icon={<Play20Regular />} disabled={loading} onClick={run} style={{ marginLeft: 'auto' }}>
              {loading ? 'Running…' : 'Run (Shift+Enter)'}
            </Button>
          </div>
          {info?.isFollower && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Read-only follower database</MessageBarTitle>
                This KQL database is attached as a follower of{' '}
                <strong>{info.followerLeaderCluster || 'a leader cluster'}</strong>
                {info.followerDatabaseName ? ` (database: ${info.followerDatabaseName})` : ''}.
                Data is synchronized from the leader in near-real-time. Write operations
                (ingest, create table, alter, drop, purge) are blocked — run queries against
                the follower, or write to the leader database directly. Use{' '}
                <strong>Detach follower</strong> to remove the shortcut and restore read/write.
              </MessageBarBody>
            </MessageBar>
          )}
          {info && !info.ok && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Database unavailable</MessageBarTitle>
                {info.error || 'Unknown error'}
              </MessageBarBody>
            </MessageBar>
          )}
          <TabList
            selectedValue={editorTab}
            onTabSelect={(_: unknown, d: any) => setEditorTab(d.value as 'query' | 'diagram')}
            style={{ marginBottom: 4 }}
          >
            <Tab value="query" icon={<Play20Regular />}>Query</Tab>
            <Tab value="diagram" icon={<Flowchart20Regular />}>Diagram</Tab>
          </TabList>

          {editorTab === 'query' && (
          <>
          <MonacoTextarea
            value={kql}
            onChange={setKql}
            language="kql"
            height={240}
            minHeight={180}
            ariaLabel="KQL query editor"
          />
          <KqlResultsPanel result={result} loading={loading} />

          {/* Starter schema + queries from the app-install template. Surfaced
              when the live ADX object isn't provisioned yet so a bundle-
              installed KQL database opens FULLY BUILT-OUT (tables + columns +
              sample rows + starter analyst queries) instead of empty. Once the
              tables/functions exist on the live cluster the navigator + Run
              hit the real backend; these template rows are clearly labeled. */}
          {info?.contentFallback && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>App template — schema & starter queries</MessageBarTitle>
                  This KQL database ships a starter schema and analyst queries from its app
                  bundle. Create the tables on the live cluster (New → Table, or run a
                  starter query that references them) to ingest data; until then these are
                  the template definitions.
                </MessageBarBody>
              </MessageBar>

              {Array.isArray(info.schema) && info.schema.length > 0 && (
                <div>
                  <Subtitle2>Tables ({info.schema.length})</Subtitle2>
                  <Tree aria-label="Starter table schema" style={{ marginTop: 6 }}>
                    {info.schema.map((t) => (
                      <TreeItem key={t.name} itemType="branch" value={`stbl-${t.name}`}>
                        <TreeItemLayout iconBefore={<DocumentTable20Regular />}>
                          {t.name}{' '}
                          <Caption1>({t.columns.length} cols)</Caption1>{' '}
                          <Badge size="small" appearance="tint" color={t.live ? 'success' : 'warning'}>
                            {t.live ? 'live' : 'template'}
                          </Badge>
                        </TreeItemLayout>
                        <Tree>
                          {t.columns.map((c) => (
                            <TreeItem key={c.name} itemType="leaf" value={`stcol-${t.name}-${c.name}`}>
                              <TreeItemLayout iconBefore={<Table20Regular />}>
                                {c.name} <Caption1>: {c.type}</Caption1>
                              </TreeItemLayout>
                            </TreeItem>
                          ))}
                        </Tree>
                        {Array.isArray(t.sample) && t.sample.length > 0 && (
                          <div style={{ overflowX: 'auto', margin: '4px 0 8px 24px' }}>
                            <Table size="extra-small" aria-label={`${t.name} sample rows`}>
                              <TableHeader>
                                <TableRow>
                                  {t.columns.map((c) => (
                                    <TableHeaderCell key={c.name}>{c.name}</TableHeaderCell>
                                  ))}
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {t.sample.slice(0, 5).map((row, ri) => (
                                  <TableRow key={ri}>
                                    {(Array.isArray(row) ? row : []).map((cell, ci) => (
                                      <TableCell key={ci}>{String(cell)}</TableCell>
                                    ))}
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        )}
                      </TreeItem>
                    ))}
                  </Tree>
                </div>
              )}

              {Array.isArray(info.starterQueries) && info.starterQueries.length > 0 && (
                <div>
                  <Subtitle2>Starter queries ({info.starterQueries.length})</Subtitle2>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                    {info.starterQueries.map((q) => (
                      <Button
                        key={q.name}
                        appearance="subtle"
                        icon={<Play20Regular />}
                        style={{ justifyContent: 'flex-start' }}
                        onClick={() => {
                          setKql(q.kql);
                          const el = document.querySelector('textarea[aria-label="KQL query editor"]') as HTMLTextAreaElement | null;
                          el?.focus();
                        }}
                      >
                        {q.name}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          </>
          )}

          {editorTab === 'diagram' && (
            id && id !== 'new'
              ? graphLoading
                ? <Spinner label="Loading entity diagram…" />
                : graphError
                  ? (
                    <MessageBar intent="error">
                      <MessageBarBody>
                        <MessageBarTitle>Entity diagram unavailable</MessageBarTitle>
                        {graphError}
                      </MessageBarBody>
                    </MessageBar>
                  )
                  : (
                    <SchemaDiagramCanvas
                      nodes={graphData?.nodes || []}
                      edges={graphData?.edges || []}
                      onQueryNode={(name, kind) => {
                        setKql(kind === 'function' ? `${name}()` : `["${name}"]\n| take 100`);
                        setEditorTab('query');
                      }}
                      onDeleteNode={(name, kind) => {
                        setDeleteTarget({ name, kind }); setDeleteError(null); setDeleteDlgOpen(true);
                      }}
                    />
                  )
              : (
                <MessageBar intent="info">
                  <MessageBarBody>
                    <MessageBarTitle>Save the KQL database first</MessageBarTitle>
                    The entity diagram appears once this database is saved and bound to a Kusto database.
                  </MessageBarBody>
                </MessageBar>
              )
          )}

          {/* Delete-from-diagram confirmation — issues a real .drop ... ifexists
              mgmt command against the live ADX cluster via the /query route. */}
          <Dialog open={deleteDlgOpen} onOpenChange={(_: unknown, d: any) => { if (!d.open) { setDeleteDlgOpen(false); setDeleteTarget(null); } }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Delete {deleteTarget?.kind} &quot;{deleteTarget?.name}&quot;?</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <Caption1>
                      Issues a <code>.drop {deleteTarget?.kind ?? ''} [&quot;{deleteTarget?.name ?? ''}&quot;]</code> management
                      command against the live ADX cluster. This cannot be undone.
                    </Caption1>
                    {deleteError && <MessageBar intent="error"><MessageBarBody>{deleteError}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" disabled={deleteSubmitting} onClick={() => { setDeleteDlgOpen(false); setDeleteTarget(null); }}>Cancel</Button>
                  <Button appearance="primary" disabled={deleteSubmitting} onClick={deleteFromDiagram}>
                    {deleteSubmitting ? 'Deleting…' : 'Delete'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <Dialog open={!!wizardKind} onOpenChange={(_: unknown, d: any) => { if (!d.open) setWizardKind(null); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>
                  {wizardKind === 'table' && 'New table (.create table)'}
                  {wizardKind === 'alter-table' && `Edit schema — ${wizAlterTarget} (.alter-merge table)`}
                  {wizardKind === 'drop-table' && `Drop table — ${wizAlterTarget}`}
                  {wizardKind === 'mv' && 'New materialized view (.create materialized-view)'}
                  {wizardKind === 'update-policy' && 'New update policy (.alter table policy update)'}
                  {wizardKind === 'ingest' && 'Get data — ingest a file (.ingest with format + mapping)'}
                  {wizardKind === 'data-connection' && 'New Event Hub data connection'}
                  {wizardKind === 'follower' && 'Database shortcut — attach follower (read-only)'}
                </DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {wizardKind === 'table' && (
                      <>
                        <Field label="Table name" required>
                          <Input value={wizName} onChange={(_: unknown, d: any) => setWizName(d.value)} placeholder="events" />
                        </Field>
                        <Field label="Columns">
                          <ColumnGridDesigner columns={wizColumns} onChange={setWizColumns} disabled={wizSubmitting} />
                        </Field>
                      </>
                    )}
                    {wizardKind === 'alter-table' && (
                      <>
                        <MessageBar intent="warning">
                          <MessageBarBody>
                            <MessageBarTitle>.alter-merge table — additive</MessageBarTitle>
                            New columns are appended to <strong>{wizAlterTarget}</strong>; existing
                            columns and their data are preserved. Removing a row here will NOT drop
                            that column (use .drop column separately). To rename or change a column
                            type, drop and recreate the column.
                          </MessageBarBody>
                        </MessageBar>
                        <Field label="Columns (existing + new)">
                          <ColumnGridDesigner
                            columns={wizColumns}
                            onChange={setWizColumns}
                            disabled={wizSubmitting}
                            emptyHint="Loading current columns… add new columns to append."
                          />
                        </Field>
                      </>
                    )}
                    {wizardKind === 'drop-table' && (
                      <MessageBar intent="error">
                        <MessageBarBody>
                          <MessageBarTitle>Drop table {wizAlterTarget}?</MessageBarTitle>
                          This permanently deletes <strong>{wizAlterTarget}</strong> and all its data.
                          The command issued is <code>.drop table [&quot;{wizAlterTarget}&quot;] ifexists</code>.
                          This cannot be undone.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {wizardKind === 'mv' && (() => {
                      // Source-table picker: live cluster tables preferred, fall
                      // back to the bound item's declared tables. De-duped.
                      const srcNames = Array.from(new Set([
                        ...wizTables,
                        ...((info?.tables || []).map((t) => t.name)),
                      ].filter(Boolean)));
                      return (
                      <>
                        <Caption1>View name</Caption1>
                        <Input value={wizName} onChange={(_: unknown, d: any) => setWizName(d.value)} placeholder="events_daily" />
                        <Caption1>Source table</Caption1>
                        {srcNames.length > 0 ? (
                          <Select value={wizSource} onChange={(_: unknown, d: any) => setWizSource(d.value)} aria-label="Source table">
                            <option value="">Select a source table…</option>
                            {srcNames.map((n) => <option key={n} value={n}>{n}</option>)}
                          </Select>
                        ) : (
                          <Input value={wizSource} onChange={(_: unknown, d: any) => setWizSource(d.value)} placeholder="events" />
                        )}
                        <Caption1>Aggregation query (must end in summarize — one row per group key)</Caption1>
                        <MonacoTextarea
                          value={wizQuery}
                          onChange={setWizQuery}
                          language="kql"
                          height={180}
                          ariaLabel="Materialized view KQL query"
                        />
                        <Switch
                          label="Backfill from existing data (.create async materialized-view with (backfill=true))"
                          checked={wizBackfill}
                          onChange={(_: unknown, d: any) => setWizBackfill(!!d.checked)}
                        />
                        {wizBackfill && (
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                            Runs asynchronously over the source table&apos;s existing records. Large tables may take minutes to hours; the view stays unavailable for query until the backfill completes. Track with <code>.show materialized-views</code> / <code>.show operations</code>.
                          </Caption1>
                        )}
                      </>
                      );
                    })()}
                    {wizardKind === 'update-policy' && (
                      <>
                        <Caption1>Target table (receives the transformed rows)</Caption1>
                        {upLoading
                          ? <Spinner size="tiny" label="Loading tables…" />
                          : (
                            <Select
                              value={wizName}
                              onChange={(_: unknown, d: any) => setWizName(d.value)}
                              aria-label="Target table"
                            >
                              <option value="">— select target table —</option>
                              {upTables.map((t) => <option key={t} value={t}>{t}</option>)}
                            </Select>
                          )}
                        <Caption1>Source table (incoming raw rows trigger the policy)</Caption1>
                        <Select
                          value={wizSource}
                          onChange={(_: unknown, d: any) => setWizSource(d.value)}
                          aria-label="Source table"
                          disabled={upLoading}
                        >
                          <option value="">— select source table —</option>
                          {upTables.map((t) => <option key={t} value={t}>{t}</option>)}
                        </Select>
                        <Caption1>Transform function (recommended — a stored KQL function)</Caption1>
                        <Select
                          value={wizFn}
                          onChange={(_: unknown, d: any) => { setWizFn(d.value); if (d.value) setWizQuery(''); }}
                          aria-label="Transform function"
                          disabled={upLoading}
                        >
                          <option value="">— none (use inline query below) —</option>
                          {upFunctions.map((f) => <option key={f} value={f}>{f}</option>)}
                        </Select>
                        {!wizFn && (
                          <>
                            <Caption1>Inline transform query (used when no function is selected)</Caption1>
                            <Textarea value={wizQuery} onChange={(_: unknown, d: any) => setWizQuery(d.value)} rows={4} style={{ fontFamily: 'Consolas, monospace' }} placeholder="events_raw | extend ts = todatetime(timestamp) | project-away rawField" />
                          </>
                        )}
                        <Switch
                          checked={wizTransactional}
                          onChange={(_: unknown, d: any) => setWizTransactional(!!d.checked)}
                          label={wizTransactional
                            ? 'Transactional (ingest fails if the transform fails — recommended for production)'
                            : 'Non-transactional (source table is updated even if the transform fails)'}
                        />
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                          Applies <code>.alter table {wizName || '«target»'} policy update</code>; the wizard reads
                          {' '}<code>.show table {wizName || '«target»'} policy update</code> back as the receipt.
                        </Caption1>
                      </>
                    )}
                    {wizardKind === 'ingest' && (
                      <>
                        <Caption1>Target table</Caption1>
                        <Input value={wizSource} onChange={(_: unknown, d: any) => setWizSource(d.value)} placeholder="events" />
                        <Caption1>Format</Caption1>
                        <Select value={wizIngestFormat} onChange={(_: unknown, d: any) => setWizIngestFormat(d.value)}>
                          {['csv', 'tsv', 'psv', 'json', 'parquet', 'avro', 'orc'].map((fmt) => (
                            <option key={fmt} value={fmt}>{fmt.toUpperCase()}</option>
                          ))}
                        </Select>
                        <Caption1>Ingestion mapping name (optional — blank uses the table&apos;s identity mapping)</Caption1>
                        <Input value={wizIngestMapping} onChange={(_: unknown, d: any) => setWizIngestMapping(d.value)} placeholder="EventMapping" />
                        <Caption1>
                          File ({['parquet', 'avro', 'orc'].includes(wizIngestFormat)
                            ? 'binary — generates a blob ingest command'
                            : '≤5 MB — inline ingest'})
                        </Caption1>
                        <input
                          type="file"
                          accept=".csv,.tsv,.psv,.json,.jsonl,.txt,.parquet,.avro,.orc"
                          aria-label="File to ingest"
                          onChange={(e) => setWizIngestFile(e.target.files?.[0] || null)}
                        />
                        <Caption1>
                          Create a named mapping first via Home → New → Ingestion mapping, then reference it here.
                          For continuous ingest use Eventhouse → Get data (Event Hub data-connection).
                        </Caption1>
                      </>
                    )}
                    {wizardKind === 'data-connection' && (
                      <>
                        {wizDcEhGate && (
                          <MessageBar intent="warning">
                            <MessageBarBody>
                              <MessageBarTitle>Event Hubs not configured</MessageBarTitle>
                              Set <code>{wizDcEhGate}</code> to enable the Event Hub picker. The cluster MI also needs
                              {' '}<code>Azure Event Hubs Data Receiver</code> on the namespace (granted by eventhubs.bicep).
                            </MessageBarBody>
                          </MessageBar>
                        )}
                        {wizDcConnections.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <Caption1>Existing data connections ({wizDcConnections.length})</Caption1>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {wizDcConnections.map((c) => (
                                <Badge key={c.name} appearance="outline" color="informative">
                                  {c.name}{c.properties?.provisioningState ? ` · ${c.properties.provisioningState}` : ''}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        <Field label="Connection name (auto-generated if blank)">
                          <Input value={wizName} onChange={(_: unknown, d: any) => setWizName(d.value)} placeholder={`loom-dc-${wizDcHub || 'hub'}`} />
                        </Field>
                        <Field label="Event Hubs namespace">
                          <Input value={wizDcNamespace || (wizDcLoading ? 'loading…' : '(not configured)')} readOnly />
                        </Field>
                        <Field label="Event hub">
                          <Select value={wizDcHub} onChange={(_: unknown, d: any) => { setWizDcHub(d.value); setWizDcConsumerGroup(''); }} disabled={!!wizDcEhGate}>
                            <option value="">— select hub —</option>
                            {wizDcHubs.map((h) => <option key={h} value={h}>{h}</option>)}
                          </Select>
                        </Field>
                        <Field label="Consumer group (must be dedicated — one per ADX connection)">
                          <Select value={wizDcConsumerGroup} onChange={(_: unknown, d: any) => setWizDcConsumerGroup(d.value)} disabled={!wizDcHub}>
                            <option value="">— select consumer group —</option>
                            {wizDcGroups.map((g) => <option key={g} value={g}>{g}</option>)}
                          </Select>
                        </Field>
                        <Field label="Data format">
                          <Select value={wizDcFormat} onChange={(_: unknown, d: any) => setWizDcFormat(d.value)}>
                            {['JSON', 'MULTIJSON', 'CSV', 'TSV', 'SCSV', 'PSV', 'AVRO', 'APACHEAVRO', 'PARQUET', 'ORC', 'RAW', 'TXT', 'W3CLOGFILE'].map((f) => <option key={f} value={f}>{f}</option>)}
                          </Select>
                        </Field>
                        <Field label="Compression">
                          <Select value={wizDcCompression} onChange={(_: unknown, d: any) => setWizDcCompression(d.value)}>
                            <option value="None">None</option>
                            <option value="GZip">GZip</option>
                          </Select>
                        </Field>
                        <Field label="Target table (optional — leave blank for per-event / dynamic routing)">
                          <Select value={wizDcTargetTable} onChange={(_: unknown, d: any) => setWizDcTargetTable(d.value)}>
                            <option value="">— none (per-event routing) —</option>
                            {wizDcTables.map((t) => <option key={t} value={t}>{t}</option>)}
                          </Select>
                        </Field>
                        <Field label="Ingestion mapping name (optional)">
                          <Input value={wizDcMappingRule} onChange={(_: unknown, d: any) => setWizDcMappingRule(d.value)} placeholder="myMapping" />
                        </Field>
                      </>
                    )}
                    {wizardKind === 'follower' && (
                      <>
                        <Caption1>Leader cluster ARM resource ID</Caption1>
                        <Input
                          value={wizLeaderResourceId}
                          onChange={(_: unknown, d: any) => setWizLeaderResourceId(d.value)}
                          placeholder="/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Kusto/clusters/{name}"
                          style={{ fontFamily: 'Consolas, monospace' }}
                        />
                        <Caption1>Leader cluster URI (optional, display only)</Caption1>
                        <Input
                          value={wizLeaderUri}
                          onChange={(_: unknown, d: any) => setWizLeaderUri(d.value)}
                          placeholder="https://mycluster.eastus2.kusto.windows.net"
                        />
                        <Caption1>Database to follow (leave blank or * to follow all leader databases)</Caption1>
                        <Input
                          value={wizFollowerDbName}
                          onChange={(_: unknown, d: any) => setWizFollowerDbName(d.value)}
                          placeholder="MyLeaderDb or *"
                        />
                        <Caption1>Principal modification kind</Caption1>
                        <Select
                          value={wizPrincipalsKind}
                          onChange={(_: unknown, d: any) => setWizPrincipalsKind(d.value as 'Union' | 'Replace' | 'None')}
                        >
                          <option value="Union">Union — leader principals + this cluster&apos;s principals</option>
                          <option value="Replace">Replace — follower principals only</option>
                          <option value="None">None — leader principals only</option>
                        </Select>
                        <MessageBar intent="info">
                          <MessageBarBody>
                            <MessageBarTitle>Prerequisites</MessageBarTitle>
                            The Loom managed identity must hold <strong>Contributor</strong> (or Azure
                            Kusto Contributor) on the <em>leader</em> cluster — granted out-of-band; the
                            follower cluster (this deployment) is already configured. Leader and follower
                            must be in the <strong>same Azure region</strong>. The follower is read-only:
                            queries return live leader data; writes are blocked.
                          </MessageBarBody>
                        </MessageBar>
                      </>
                    )}
                    {wizError && <MessageBar intent="error"><MessageBarBody>{wizError}</MessageBarBody></MessageBar>}
                    {wizSuccess && <MessageBar intent="success"><MessageBarBody>{wizSuccess}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setWizardKind(null)} disabled={wizSubmitting}>Cancel</Button>
                  <Button appearance="primary" onClick={submitWizard} disabled={wizSubmitting}>
                    {wizSubmitting ? 'Submitting…'
                      : wizardKind === 'drop-table' ? 'Drop table'
                      : wizardKind === 'alter-table' ? 'Apply (.alter-merge)'
                      : wizardKind === 'follower' ? 'Attach follower'
                      : 'Create'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* ---- Stored function editor (create / edit / delete) ---- */}
          <Dialog open={fnDlgOpen} onOpenChange={(_: unknown, d: any) => { if (!d.open) setFnDlgOpen(false); }}>
            <DialogSurface style={{ maxWidth: 720 }}>
              <DialogBody>
                <DialogTitle>
                  {fnDlgMode === 'create'
                    ? 'New function (.create-or-alter function)'
                    : `Edit function · ${fnName}`}
                </DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <Field label="Function name" required hint="Stored as a database-scoped KQL function (folder: Loom).">
                      <Input
                        value={fnName}
                        readOnly={fnNameLocked}
                        disabled={fnNameLocked}
                        onChange={(_: unknown, d: any) => setFnName(d.value)}
                        placeholder="fn_recent_events"
                        style={fnNameLocked ? { fontFamily: 'Consolas, monospace', fontWeight: 600 } : undefined}
                      />
                    </Field>

                    <Field label="Parameters" hint="Typed signature, e.g. days:int. Leave empty for a no-argument function.">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {fnParams.map((p, i) => (
                          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <Input
                              size="small"
                              placeholder="paramName"
                              value={p.name}
                              onChange={(_: unknown, d: any) => setFnParams((prev) => prev.map((x, xi) => (xi === i ? { ...x, name: d.value } : x)))}
                              style={{ flex: 1 }}
                              aria-label={`Parameter ${i + 1} name`}
                            />
                            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>:</Caption1>
                            <Select
                              size="small"
                              value={p.type}
                              onChange={(_: unknown, d: any) => setFnParams((prev) => prev.map((x, xi) => (xi === i ? { ...x, type: d.value } : x)))}
                              style={{ minWidth: 130 }}
                              aria-label={`Parameter ${i + 1} type`}
                            >
                              {FN_PARAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                            </Select>
                            <Button
                              size="small"
                              appearance="subtle"
                              icon={<Delete20Regular />}
                              onClick={() => setFnParams((prev) => prev.filter((_, xi) => xi !== i))}
                              aria-label={`Remove parameter ${i + 1}`}
                            />
                          </div>
                        ))}
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<Add20Regular />}
                          onClick={() => setFnParams((prev) => [...prev, { name: '', type: 'string' }])}
                          style={{ alignSelf: 'flex-start' }}
                        >
                          Add parameter
                        </Button>
                        {fnParams.length === 0 && (
                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                            No parameters — function takes no arguments.
                          </Caption1>
                        )}
                      </div>
                    </Field>

                    <Field label="Body (KQL)" required>
                      <MonacoTextarea
                        value={fnBody}
                        onChange={setFnBody}
                        language="kql"
                        height={220}
                        minHeight={140}
                        ariaLabel="Function body KQL editor"
                      />
                    </Field>

                    {fnReceipt && (
                      <MessageBar intent="success">
                        <MessageBarBody>
                          <MessageBarTitle>{fnReceipt.action === 'saved' ? 'Saved' : 'Deleted'}</MessageBarTitle>
                          Function <code>{fnReceipt.name}</code>{' '}
                          {fnReceipt.action === 'saved'
                            ? <>created/altered via <code>.create-or-alter function</code>{fnReceipt.rowCount !== undefined ? ` (${fnReceipt.rowCount} rows returned)` : ''}.</>
                            : <>dropped via <code>.drop function</code>.</>}
                          {' '}<Caption1>{fnReceipt.ts}</Caption1>
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {fnErr && (
                      <MessageBar intent="error">
                        <MessageBarBody><MessageBarTitle>Error</MessageBarTitle>{fnErr}</MessageBarBody>
                      </MessageBar>
                    )}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setFnDlgOpen(false)} disabled={fnBusy || fnDeleteBusy}>Close</Button>
                  {fnDlgMode === 'edit' && (
                    <Button
                      appearance="subtle"
                      icon={<Delete20Regular />}
                      disabled={fnBusy || fnDeleteBusy}
                      onClick={deleteFnEditor}
                      style={{ color: tokens.colorPaletteRedForeground1 }}
                    >
                      {fnDeleteBusy ? 'Deleting…' : 'Delete function'}
                    </Button>
                  )}
                  <Button appearance="primary" disabled={fnBusy || fnDeleteBusy} onClick={submitFnEditor}>
                    {fnBusy ? 'Saving…' : 'Save'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* ── Data-connection wizard (Event Hub / IoT Hub → ADX) ─────────── */}
          <Dialog open={dcOpen} onOpenChange={(_: unknown, d: any) => { if (!d.open) setDcOpen(false); }}>
            <DialogSurface style={{ maxWidth: 620 }}>
              <DialogBody>
                <DialogTitle>New data connection (Microsoft.Kusto/dataConnections)</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <Caption1>
                      Stream events into a table via a real ADX data connection. Azure-native — no Fabric
                      workspace required. The ADX cluster managed identity must be able to read the source’s
                      keys (IoT Hub Contributor for IoT Hub; Event Hubs Data Receiver for Event Hub).
                    </Caption1>

                    <Field label="Source type">
                      <Select
                        value={dcKind}
                        onChange={(_: unknown, d: any) => onDcKindChange(d.value as 'iothub' | 'eventhub')}
                      >
                        <option value="iothub">IoT Hub (device-to-cloud)</option>
                        <option value="eventhub">Event Hub</option>
                      </Select>
                    </Field>

                    {dcSourcesLoading && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <Spinner size="tiny" /> <Caption1>Discovering {dcKind === 'iothub' ? 'IoT Hubs' : 'Event Hubs namespaces'}…</Caption1>
                      </div>
                    )}

                    {/* Honest-gate: no source resource visible to Loom. */}
                    {!dcSourcesLoading && dcSourcesErr && (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>{dcKind === 'iothub' ? 'No IoT Hub available' : 'No Event Hubs namespace available'}</MessageBarTitle>
                          {dcSourcesErr}
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {!dcSourcesLoading && dcSources && dcSources.length > 0 && (
                      <Field label={dcKind === 'iothub' ? 'IoT Hub' : 'Event Hubs namespace'}>
                        <Select
                          value={dcSelectedSourceId}
                          onChange={(_: unknown, d: any) => onDcSourceChange(d.value)}
                        >
                          <option value="">— select —</option>
                          {dcSources.map((srcRow) => (
                            <option key={srcRow.id} value={srcRow.id}>
                              {srcRow.name}{srcRow.resourceGroup ? ` (${srcRow.resourceGroup})` : ''}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    )}

                    {/* Event Hub entity name (namespace picker selects the namespace only). */}
                    {dcKind === 'eventhub' && dcSelectedSourceId && (
                      <Field label="Event Hub entity name">
                        <Input value={dcEhEntity} onChange={(_: unknown, d: any) => setDcEhEntity(d.value)} placeholder="telemetry" />
                      </Field>
                    )}

                    {/* IoT Hub shared-access policy (ServiceConnect required for ADX). */}
                    {dcKind === 'iothub' && dcSelectedSourceId && (
                      <>
                        <Field label="Shared access policy">
                          <Select value={dcPolicy} onChange={(_: unknown, d: any) => setDcPolicy(d.value)}>
                            {dcPolicies.length === 0 && <option value="iothubowner">iothubowner</option>}
                            {dcPolicies.map((p) => (
                              <option key={p.name} value={p.name}>
                                {p.name}{/service|iothubowner/i.test(p.name) ? ' — recommended for ADX' : ''}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        {dcPolicyNote && (
                          <MessageBar intent="info"><MessageBarBody>{dcPolicyNote}</MessageBarBody></MessageBar>
                        )}
                      </>
                    )}

                    {dcSelectedSourceId && (
                      <>
                        <Field label="Consumer group">
                          <Input value={dcConsumerGroup} onChange={(_: unknown, d: any) => setDcConsumerGroup(d.value)} placeholder="$Default" />
                        </Field>
                        <Field label="Data format">
                          <Select value={dcFormat} onChange={(_: unknown, d: any) => setDcFormat(d.value)}>
                            {DC_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
                          </Select>
                        </Field>
                        <Field label="Target table">
                          <Input value={dcTable} onChange={(_: unknown, d: any) => setDcTable(d.value)} placeholder="DeviceEvents" />
                        </Field>
                      </>
                    )}

                    {dcError && <MessageBar intent="error"><MessageBarBody>{dcError}</MessageBarBody></MessageBar>}
                    {dcSuccess && <MessageBar intent="success"><MessageBarBody>{dcSuccess}</MessageBarBody></MessageBar>}

                    {/* Existing connections on this database (real ARM list). */}
                    {dcExisting && dcExisting.length > 0 && (
                      <div>
                        <Subtitle2>Existing connections ({dcExisting.length})</Subtitle2>
                        <Table size="extra-small" aria-label="Existing data connections" style={{ marginTop: 6 }}>
                          <TableHeader>
                            <TableRow>
                              <TableHeaderCell>Name</TableHeaderCell>
                              <TableHeaderCell>Kind</TableHeaderCell>
                              <TableHeaderCell>Table</TableHeaderCell>
                              <TableHeaderCell>State</TableHeaderCell>
                              <TableHeaderCell />
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {dcExisting.map((c) => (
                              <TableRow key={c.name}>
                                <TableCell>{c.name}</TableCell>
                                <TableCell>{c.kind}</TableCell>
                                <TableCell>{c.tableName}</TableCell>
                                <TableCell>{c.provisioningState}</TableCell>
                                <TableCell>
                                  <Button size="small" appearance="subtle" icon={<Delete20Regular />}
                                    disabled={dcBusy} onClick={() => deleteDc(c.name)} aria-label={`Delete ${c.name}`} />
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setDcOpen(false)} disabled={dcBusy}>Close</Button>
                  <Button appearance="primary" onClick={submitDc}
                    disabled={dcBusy || !dcSelectedSourceId || !dcTable.trim()}>
                    {dcBusy ? 'Creating…' : 'Create connection'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Ingestion mapping wizard — format selector + sample-file auto-detect grid */}
          <IngestionMappingWizardDialog
            itemId={id}
            tables={info?.tables ?? []}
            open={mappingWizOpen}
            onOpenChange={setMappingWizOpen}
            onCreated={(_name, _kind, _table, kqlSnippet) => {
              setMappingWizOpen(false);
              setTreeRefreshKey((k) => k + 1);
              setKql(kqlSnippet);
              const el = document.querySelector('textarea[aria-label="KQL query editor"]') as HTMLTextAreaElement | null;
              el?.focus();
            }}
          />
        </div>
      }
    />
  );
}

// ----- KQL Queryset -----
// Ribbon built inside the editor via useMemo so Run/Save bind to the
// existing inline handlers; the rest stay disabled with reasons.

type QuerySourceType = 'adx' | 'log-analytics' | 'app-insights';
interface SavedQuery { title: string; kql: string; database?: string; sourceType?: QuerySourceType; }
interface QuerysetState {
  ok: boolean;
  database?: string;
  defaultDatabase?: string;
  queries?: SavedQuery[];
  error?: string;
  // Cross-service source binder — carried from the GET response.
  laGate?: { missing: string } | null;
  laProxyUri?: string | null;
  laWorkspaceName?: string | null;
}
const SAMPLE_QS: SavedQuery = { title: 'Smoke test', kql: 'print smoke = "ok", server_time = now()' };

export function KqlQuerysetEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [qs, setQs] = useState<QuerysetState | null>(null);
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [draft, setDraft] = useState<SavedQuery>(SAMPLE_QS);
  const [result, setResult] = useState<KqlResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  // Cancel-running-query support — abort the in-flight fetch so the UI
  // doesn't block on a slow KQL. The Kusto cluster keeps running the
  // query server-side until completion, but we drop the response per
  // KQL Queryset Fabric-parity behavior. Real per-request cancellation
  // via X-Cancel-Request-Id is logged as TODO; this is the same level
  // Fabric ships in 2026-Q1.
  const abortRef = useRef<AbortController | null>(null);
  // Save-to-dashboard + Set-alert dialog state
  const [pinDlgOpen, setPinDlgOpen] = useState(false);
  const [pinTitle, setPinTitle] = useState('');
  const [pinDashboardId, setPinDashboardId] = useState('');
  const [pinDashboards, setPinDashboards] = useState<Array<{ id: string; name: string }>>([]);
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [alertDlgOpen, setAlertDlgOpen] = useState(false);
  const [alertActivatorId, setAlertActivatorId] = useState('');
  const [alertName, setAlertName] = useState('');
  const [alertActivators, setAlertActivators] = useState<Array<{ id: string; name: string }>>([]);
  const [alertErr, setAlertErr] = useState<string | null>(null);
  const [alertBusy, setAlertBusy] = useState(false);
  // Cross-service source binder — bind a Log Analytics / App Insights workspace
  // as the query source; federated queries run via the ADX cluster() proxy.
  const [srcDlgOpen, setSrcDlgOpen] = useState(false);
  const [draftSrcType, setDraftSrcType] = useState<QuerySourceType>('adx');
  // Share dialog — one-for-one with the ADX web UI / Fabric "Share" affordance:
  // copy the canonical item URL so a workspace member with view access can open
  // the same queryset. Loom RBAC governs who can actually open it.
  const [shareOpen, setShareOpen] = useState(false);
  // NL2KQL Copilot assist (generate / explain / fix) — inline build-assist over
  // the Loom AOAI deployment. State machine mirrors the Notebook assist edge.
  type AssistView = 'idle' | 'prompt' | 'loading' | 'suggestion' | 'explain-result';
  const [assistView, setAssistView] = useState<AssistView>('idle');
  const [assistPrompt, setAssistPrompt] = useState('');
  const [assistResult, setAssistResult] = useState<string | null>(null);
  const [assistError, setAssistError] = useState<string | null>(null);
  const lastModeRef = useRef<'generate' | 'explain' | 'fix'>('generate');

  const load = useCallback(async () => {
    // Pre-save gate: /items/kql-queryset/new fires this before any record exists.
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/kql-queryset/${id}`);
      const j = (await r.json()) as QuerysetState;
      setQs(j);
      const arr = j.queries || [];
      setQueries(arr);
      if (arr.length) { setSelectedIdx(0); setDraft(arr[0]); }
    } catch (e: any) {
      setQs({ ok: false, error: e?.message || String(e) });
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Phase 4.5: refuse to silently clobber unsaved edits. If the user
  // selects a different saved query while the current draft is dirty,
  // ask before overwriting. This was the implicit data-loss bug
  // (run-then-edit-then-select-another clobber).
  const select = useCallback((idx: number) => {
    if (dirty && idx !== selectedIdx) {
      const proceed = typeof window !== 'undefined'
        ? window.confirm('Discard unsaved changes to the current query?')
        : true;
      if (!proceed) return;
    }
    setSelectedIdx(idx); setDraft(queries[idx] || SAMPLE_QS); setDirty(false); setResult(null);
    setSaveErr(null); setSaveMsg(null);
  }, [queries, dirty, selectedIdx]);

  const addQuery = useCallback(() => {
    // Phase 4.5 — functional setQueries so back-to-back clicks before
    // re-render cannot drop entries. Carry the dirty draft of the
    // currently-selected query into the queries[] array before appending
    // — otherwise the new entry replaces the user's unsaved edit.
    setQueries((prev) => {
      const carried = prev.map((q, i) => i === selectedIdx ? draft : q);
      const next = [...carried, { title: `Query ${carried.length + 1}`, kql: '' }];
      setSelectedIdx(next.length - 1);
      setDraft(next[next.length - 1]);
      return next;
    });
    setDirty(true); setSaveMsg(null);
  }, [selectedIdx, draft]);

  const deleteQuery = useCallback((idx: number) => {
    // Phase 4.5 — functional setter so multiple deletes in flight don't
    // operate on a stale array.
    setQueries((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      const newIdx = Math.max(0, Math.min(idx - 1, next.length - 1));
      setSelectedIdx(newIdx);
      setDraft(next[newIdx] || SAMPLE_QS);
      return next;
    });
    setDirty(true); setSaveMsg(null);
  }, []);

  const saveAll = useCallback(async () => {
    setSaving(true); setSaveErr(null); setSaveMsg('Saving…');
    // Capture the queries snapshot WITH the current draft folded in at
    // click time. If a Run is in flight when save fires, runs only read
    // draft.kql — they never write back to queries[] — so the merge here
    // is the authoritative source.
    const updated = queries.map((q, i) => i === selectedIdx ? draft : q);
    try {
      const r = await fetch(`/api/items/kql-queryset/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queries: updated }),
      });
      const j = await r.json();
      if (!j.ok) {
        setSaveErr(j.error || 'save failed');
        setSaveMsg(`Save failed: ${j.error || 'unknown'}`);
        return;
      }
      // Server-confirmed queries. Adopt them, but preserve the user's
      // selected index — server may reorder/normalize but in practice the
      // PUT echoes back the same array we sent.
      const serverQueries: SavedQuery[] = j.queries || updated;
      setQueries(serverQueries);
      // Re-sync draft from the saved row so dirty=false is honest.
      const savedRow = serverQueries[selectedIdx] || serverQueries[0] || SAMPLE_QS;
      setDraft(savedRow);
      setDirty(false);
      setSaveMsg(`Saved at ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
      setSaveMsg(`Save failed: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  }, [id, queries, selectedIdx, draft]);

  // Ctrl+S / Cmd+S to save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && !saving && queries.length) saveAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, saving, queries.length, saveAll]);

  const run = useCallback(async () => {
    setLoading(true); setResult(null);
    // Pin the kql/database we're sending at click-time so any subsequent
    // edits the user makes mid-run cannot influence what was executed.
    const payload = { kql: draft.kql, database: draft.database, sourceType: draft.sourceType || 'adx' };
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const r = await fetch(`/api/items/kql-queryset/${id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      setResult((await r.json()) as KqlResult);
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        setResult({ ok: false, error: 'Cancelled by user' });
      } else {
        setResult({ ok: false, error: e?.message || String(e) });
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }, [id, draft]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Pin to dashboard — list dashboards, then PUT the dashboard with a new tile.
  const openPinDialog = useCallback(async () => {
    setPinDlgOpen(true);
    setPinErr(null);
    setPinTitle(draft.title || 'Pinned from queryset');
    try {
      const r = await fetch('/api/items?type=kql-dashboard');
      const j = await r.json();
      const arr: Array<{ id: string; displayName?: string; name?: string }> = j?.items || j?.value || [];
      const dashboards = arr.map((d) => ({ id: d.id, name: d.displayName || d.name || d.id }));
      setPinDashboards(dashboards);
      if (dashboards[0]) setPinDashboardId(dashboards[0].id);
    } catch (e: any) {
      setPinErr(e?.message || String(e));
    }
  }, [draft.title]);

  const submitPin = useCallback(async () => {
    if (!pinDashboardId) { setPinErr('Choose a dashboard'); return; }
    if (!draft.kql.trim()) { setPinErr('Query is empty'); return; }
    setPinBusy(true); setPinErr(null);
    try {
      // Read current tiles + append; PUT the new array.
      const cur = await fetch(`/api/items/kql-dashboard/${pinDashboardId}`).then((r) => r.json());
      const tiles = Array.isArray(cur?.tiles) ? cur.tiles : [];
      tiles.push({ title: pinTitle || draft.title || 'Pinned tile', kql: draft.kql, viz: 'table', database: draft.database });
      const r = await fetch(`/api/items/kql-dashboard/${pinDashboardId}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tiles }),
      });
      const j = await r.json();
      if (!j.ok) { setPinErr(j.error || 'pin failed'); return; }
      setPinDlgOpen(false);
    } catch (e: any) {
      setPinErr(e?.message || String(e));
    } finally {
      setPinBusy(false);
    }
  }, [pinDashboardId, pinTitle, draft]);

  // Set alert (Activator rule from query). List activators, post rule.
  const openAlertDialog = useCallback(async () => {
    setAlertDlgOpen(true);
    setAlertErr(null);
    setAlertName(`alert-${(draft.title || 'queryset').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`);
    try {
      const r = await fetch('/api/items?type=activator');
      const j = await r.json();
      const arr: Array<{ id: string; displayName?: string; name?: string }> = j?.items || j?.value || [];
      const acts = arr.map((d) => ({ id: d.id, name: d.displayName || d.name || d.id }));
      setAlertActivators(acts);
      if (acts[0]) setAlertActivatorId(acts[0].id);
    } catch (e: any) {
      setAlertErr(e?.message || String(e));
    }
  }, [draft.title]);

  const submitAlert = useCallback(async () => {
    if (!alertActivatorId) { setAlertErr('Choose an Activator'); return; }
    if (!draft.kql.trim()) { setAlertErr('Query is empty'); return; }
    setAlertBusy(true); setAlertErr(null);
    try {
      const r = await fetch(`/api/items/activator/${alertActivatorId}/rules`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: alertName,
          trigger: { kind: 'kql', kql: draft.kql, database: draft.database },
          action: { kind: 'noop', note: 'Pinned from KQL Queryset — choose an action template in Activator' },
        }),
      });
      const j = await r.json();
      if (!j.ok) { setAlertErr(j.error || 'create-rule failed'); return; }
      setAlertDlgOpen(false);
    } catch (e: any) {
      setAlertErr(e?.message || String(e));
    } finally {
      setAlertBusy(false);
    }
  }, [alertActivatorId, alertName, draft]);

  const callAssist = useCallback(async (mode: 'generate' | 'explain' | 'fix') => {
    lastModeRef.current = mode;
    setAssistView('loading'); setAssistError(null);
    try {
      const r = await fetch(`/api/items/kql-queryset/${id}/assist`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode,
          kql: draft.kql,
          prompt: mode === 'generate' ? assistPrompt : undefined,
          errorText: mode === 'fix' ? (result?.error || '') : undefined,
          database: draft.database || qs?.database || qs?.defaultDatabase,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setAssistView('idle');
        setAssistError(j?.code === 'no_aoai'
          ? `KQL Copilot not configured: ${j?.hint || 'Set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT.'}`
          : (j?.error || 'AI assist failed'));
        return;
      }
      setAssistResult(j.result);
      setAssistView(mode === 'explain' ? 'explain-result' : 'suggestion');
    } catch (e: any) {
      setAssistView('idle');
      setAssistError(e?.message || String(e));
    }
  }, [id, draft, assistPrompt, result, qs]);

  const canRun = !loading && !!draft.kql.trim();
  const canSave = !saving && queries.length > 0 && dirty;
  const canPinAlert = !!draft.kql.trim();
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Run', actions: [
        { label: loading ? 'Running…' : 'Run', onClick: canRun ? run : undefined, disabled: !canRun },
        { label: 'Cancel', onClick: loading ? cancel : undefined, disabled: !loading },
      ]},
      { label: 'Save', actions: [
        { label: saving ? 'Saving…' : 'Save query', onClick: canSave ? saveAll : undefined, disabled: !canSave },
        { label: 'Save to dashboard', onClick: canPinAlert ? openPinDialog : undefined, disabled: !canPinAlert },
        { label: 'Set alert', onClick: canPinAlert ? openAlertDialog : undefined, disabled: !canPinAlert },
      ]},
      { label: 'Share', actions: [
        { label: 'Copy link', onClick: () => setShareOpen(true) },
      ]},
    ]},
  ], [loading, canRun, run, cancel, saving, canSave, saveAll, canPinAlert, openPinDialog, openAlertDialog]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <Subtitle2>Queries</Subtitle2>
            <Button size="small" icon={<Add20Regular />} onClick={addQuery} appearance="subtle">New</Button>
          </div>
          <Tree aria-label="Saved queries">
            {queries.length === 0 && <Caption1>No queries yet. Click <strong>New</strong>.</Caption1>}
            {queries.map((q, i) => (
              <TreeItem key={i} itemType="leaf" value={`q-${i}`} onClick={() => select(i)}>
                <TreeItemLayout
                  iconBefore={<DocumentTable20Regular />}
                  aside={
                    <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={(e: any) => { e.stopPropagation(); deleteQuery(i); }} aria-label="Delete query" />
                  }
                >
                  {i === selectedIdx ? <strong>{q.title}</strong> : q.title}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Input value={draft.title} onChange={(_: unknown, d: any) => { setDraft({ ...draft, title: d.value }); setDirty(true); }} placeholder="Query title" style={{ minWidth: 220 }} />
            <Caption1>db: <strong>{draft.database || qs?.database || qs?.defaultDatabase || 'loomdb-default'}</strong></Caption1>
            <Button
              size="small"
              appearance="outline"
              icon={<DatabaseLink20Regular />}
              onClick={() => { setDraftSrcType(draft.sourceType || 'adx'); setSrcDlgOpen(true); }}
            >
              Source{draft.sourceType && draft.sourceType !== 'adx' ? ` (${draft.sourceType})` : ''}
            </Button>
            {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
            <Button appearance="outline" icon={<Save20Regular />} disabled={saving || queries.length === 0 || !dirty} onClick={saveAll}>
              {saving ? 'Saving…' : 'Save (Ctrl+S)'}
            </Button>
            <Tooltip content="Generate KQL from a description" relationship="label">
              <Button size="small" appearance="subtle" icon={<Sparkle16Regular />}
                disabled={assistView === 'loading'}
                onClick={() => { setAssistResult(null); setAssistError(null); setAssistView('prompt'); }}
                aria-label="Ask Copilot to generate KQL">Ask Copilot</Button>
            </Tooltip>
            <Tooltip content="Explain this query" relationship="label">
              <Button size="small" appearance="subtle" icon={<Info16Regular />}
                disabled={!draft.kql.trim() || assistView === 'loading'}
                onClick={() => callAssist('explain')}
                aria-label="Explain KQL">Explain</Button>
            </Tooltip>
            {result && !result.ok && result.error && (
              <Tooltip content="Fix the KQL error" relationship="label">
                <Button size="small" appearance="subtle" icon={<Wrench16Regular />}
                  disabled={assistView === 'loading'}
                  onClick={() => callAssist('fix')}
                  aria-label="Fix KQL error">
                  {assistView === 'loading' && lastModeRef.current === 'fix' ? 'Fixing…' : 'Fix'}
                </Button>
              </Tooltip>
            )}
            <Button appearance="primary" icon={<Play20Regular />} disabled={loading || !draft.kql.trim()} onClick={run} style={{ marginLeft: 'auto' }}>
              {loading ? 'Running…' : 'Run'}
            </Button>
          </div>
          {saveMsg && !saveErr && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{saveMsg}</Caption1>}
          {saveErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{saveErr}</MessageBarBody></MessageBar>}
          {qs && !qs.ok && <MessageBar intent="error"><MessageBarBody>{qs.error}</MessageBarBody></MessageBar>}
          <MonacoTextarea
            value={draft.kql}
            onChange={(v) => { setDraft({ ...draft, kql: v }); setDirty(true); }}
            language="kql"
            height={240}
            minHeight={180}
            ariaLabel="KQL query"
          />
          {/* NL prompt input — generate mode */}
          {assistView === 'prompt' && (
            <div className={s.assistBar}>
              <Input size="small" autoFocus style={{ flex: 1 }}
                placeholder="Describe the query (e.g. 'count events by source in the last hour')…"
                value={assistPrompt}
                onChange={(_: unknown, d: any) => setAssistPrompt(d.value)}
                onKeyDown={(e: any) => {
                  if (e.key === 'Enter' && assistPrompt.trim()) callAssist('generate');
                  if (e.key === 'Escape') setAssistView('idle');
                }}
                aria-label="AI KQL generation prompt" />
              <Button size="small" appearance="primary"
                disabled={!assistPrompt.trim()}
                onClick={() => callAssist('generate')}>Generate</Button>
              <Button size="small" onClick={() => { setAssistView('idle'); setAssistPrompt(''); }}>Cancel</Button>
            </div>
          )}
          {/* Loading spinner */}
          {assistView === 'loading' && (
            <div className={s.assistBar}>
              <Spinner size="tiny" labelPosition="after"
                label={lastModeRef.current === 'generate' ? 'Generating…' : lastModeRef.current === 'explain' ? 'Explaining…' : 'Fixing…'} />
            </div>
          )}
          {/* Suggestion / explanation result */}
          {(assistView === 'suggestion' || assistView === 'explain-result') && assistResult && (
            <MessageBar intent={assistView === 'explain-result' ? 'info' : 'success'} style={{ margin: '4px 0 0' }}>
              <MessageBarBody>
                <pre className={s.assistResult}>{assistResult}</pre>
              </MessageBarBody>
              <MessageBarActions>
                {assistView === 'suggestion' && (
                  <Button size="small" appearance="primary"
                    onClick={() => { setDraft({ ...draft, kql: assistResult }); setDirty(true); setAssistView('idle'); setAssistResult(null); setAssistPrompt(''); }}>
                    Apply
                  </Button>
                )}
                <Button size="small" onClick={() => { setAssistView('idle'); setAssistResult(null); }}>Dismiss</Button>
              </MessageBarActions>
            </MessageBar>
          )}
          {/* Honest config gate / error */}
          {assistError && (
            <MessageBar intent="error" style={{ margin: '4px 0 0' }}>
              <MessageBarBody>{assistError}</MessageBarBody>
              <MessageBarActions>
                <Button size="small" onClick={() => setAssistError(null)}>Dismiss</Button>
              </MessageBarActions>
            </MessageBar>
          )}
          <KqlResultsPanel result={result} loading={loading} />

          <Dialog open={pinDlgOpen} onOpenChange={(_: unknown, d: any) => setPinDlgOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Save query to KQL Dashboard</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <Caption1>Tile title</Caption1>
                    <Input value={pinTitle} onChange={(_: unknown, d: any) => setPinTitle(d.value)} />
                    <Caption1>Dashboard</Caption1>
                    <Select value={pinDashboardId} onChange={(_: unknown, d: any) => setPinDashboardId(d.value)}>
                      <option value="">(select…)</option>
                      {pinDashboards.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </Select>
                    {pinErr && <MessageBar intent="error"><MessageBarBody>{pinErr}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setPinDlgOpen(false)} disabled={pinBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={submitPin} disabled={pinBusy}>{pinBusy ? 'Saving…' : 'Pin'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <Dialog open={alertDlgOpen} onOpenChange={(_: unknown, d: any) => setAlertDlgOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Create Activator rule from query</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <Caption1>Rule name</Caption1>
                    <Input value={alertName} onChange={(_: unknown, d: any) => setAlertName(d.value)} />
                    <Caption1>Activator</Caption1>
                    <Select value={alertActivatorId} onChange={(_: unknown, d: any) => setAlertActivatorId(d.value)}>
                      <option value="">(select…)</option>
                      {alertActivators.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </Select>
                    {alertErr && <MessageBar intent="error"><MessageBarBody>{alertErr}</MessageBarBody></MessageBar>}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setAlertDlgOpen(false)} disabled={alertBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={submitAlert} disabled={alertBusy}>{alertBusy ? 'Creating…' : 'Create rule'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* ── Cross-service source binding dialog ── */}
          <Dialog open={srcDlgOpen} onOpenChange={(_: unknown, d: any) => setSrcDlgOpen(d.open)}>
            <DialogSurface style={{ maxWidth: 560 }}>
              <DialogBody>
                <DialogTitle>Bind query source</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <Caption1>
                      Select the data source for this query. Log Analytics and Application
                      Insights sources run as federated cross-cluster queries from the ADX
                      cluster using the KQL <code>cluster()</code> proxy — join them with ADX
                      tables via <code>union</code> or an explicit join.
                    </Caption1>

                    <Field label="Source type">
                      <Select
                        value={draftSrcType}
                        onChange={(_: unknown, d: any) => setDraftSrcType(d.value as QuerySourceType)}
                      >
                        <option value="adx">Azure Data Explorer (ADX) — default</option>
                        <option value="log-analytics">Log Analytics workspace</option>
                        <option value="app-insights">Application Insights</option>
                      </Select>
                    </Field>

                    {/* Honest gate: no LA workspace configured */}
                    {draftSrcType !== 'adx' && qs?.laGate && (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          <MessageBarTitle>No workspace configured</MessageBarTitle>
                          Set <code>{qs.laGate.missing}</code> in the container environment
                          (wired automatically when <code>adxEnabled = true</code> in{' '}
                          <code>platform/fiab/bicep/modules/admin-plane/main.bicep</code>). The
                          Console UAMI also needs Log Analytics Reader on the workspace
                          (granted by <code>monitoring.bicep</code> <code>consoleLaReader</code>).
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {/* Available: show the proxy URI and a copy-ready KQL snippet */}
                    {draftSrcType === 'log-analytics' && !qs?.laGate && qs?.laProxyUri && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <Caption1>Workspace: <strong>{qs.laWorkspaceName}</strong></Caption1>
                        <Caption1>Cross-cluster KQL snippet — paste into your query:</Caption1>
                        <Textarea
                          readOnly
                          value={
                            `// Join ADX + Log Analytics\n` +
                            `let LA = cluster('${qs.laProxyUri}').database('${qs.laWorkspaceName}');\n` +
                            `union MyAdxTable, LA.Heartbeat\n| take 10`
                          }
                          rows={5}
                          style={{ fontFamily: 'monospace', fontSize: 12 }}
                        />
                        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                          The UAMI holds Log Analytics Reader on this workspace. Queries run via
                          ADX <code>/v1/rest/query</code> — no separate token needed.
                        </Caption1>
                      </div>
                    )}

                    {draftSrcType === 'app-insights' && !qs?.laGate && qs?.laProxyUri && (
                      <Caption1>
                        Application Insights components in the same subscription are referenced
                        with{' '}
                        <code>cluster('https://adx.monitor.azure.com/subscriptions/.../providers/microsoft.insights/components/&lt;name&gt;').database('&lt;name&gt;')</code>.
                        Substitute the component resource ID, then <code>union</code> with ADX tables.
                      </Caption1>
                    )}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setSrcDlgOpen(false)}>Cancel</Button>
                  <Button
                    appearance="primary"
                    disabled={draftSrcType !== 'adx' && !!qs?.laGate}
                    onClick={() => {
                      setDraft({ ...draft, sourceType: draftSrcType === 'adx' ? undefined : draftSrcType });
                      setDirty(true);
                      setSrcDlgOpen(false);
                    }}
                  >
                    Bind
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <Dialog open={shareOpen} onOpenChange={(_: unknown, d: any) => setShareOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Share queryset</DialogTitle>
                <DialogContent>
                  <Caption1>Anyone with access to this Loom item can open it. Permissions are managed via the workspace item ACL (Loom RBAC).</Caption1>
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <Caption1>Canonical URL</Caption1>
                    <Input value={typeof window !== 'undefined' ? window.location.href : ''} readOnly aria-label="Queryset URL" />
                    <Button appearance="outline" onClick={() => { if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(window.location.href).catch(() => {}); }}>Copy URL</Button>
                    <Caption1>To grant another user access, add them to this item via the workspace permissions page. Tenant-wide sharing is not enabled in this deployment.</Caption1>
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="primary" onClick={() => setShareOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

// ----- KQL Dashboard (Fabric Real-Time Dashboard parity) -----
// A real dashboard builder: tile grid (add/remove/resize) where each tile has
// a KQL query bound to a data source + a visual type, rendering its REAL Kusto
// result; a data-sources panel; dashboard parameters (free-text / fixed /
// query-based / time range) substituted into tile KQL; per-dashboard
// auto-refresh + manual refresh; Save persists the full model to Cosmos.
// Backed by /api/items/kql-dashboard/[id] (GET ?run=1 / PUT) + /run + /param-values.

interface DashTile {
  title: string;
  kql: string;
  viz: TileViz;
  dataSourceId?: string;
  database?: string;
  w?: number; // grid column span 1..12
  h?: number; // grid row units 1..8
  conditionalRules?: ConditionalRule[];
  /** Drill-through: clicking a result value sets a dashboard parameter. */
  drillthrough?: { column: string; paramName: string };
  result?: KqlResult;
  error?: string;
}

interface DashDataSource { id: string; name: string; database: string; clusterUri?: string; }

/** A shared KQL snippet referenced by tiles via `$baseQuery('name')`. */
interface DashBaseQuery { id: string; name: string; kql: string; }

type DashParamType = 'freetext' | 'fixed' | 'multi' | 'query' | 'datasource' | 'duration';
type DashParamDataType = 'string' | 'long' | 'int' | 'real' | 'datetime' | 'bool';

interface DashParam {
  variableName: string;
  label?: string;
  type: DashParamType;
  dataType?: DashParamDataType;
  values?: string[];
  query?: string;
  dataSourceId?: string;
  value?: string | string[];
}

interface DashboardState {
  ok: boolean;
  database?: string;
  defaultDatabase?: string;
  tiles?: DashTile[];
  dataSources?: DashDataSource[];
  parameters?: DashParam[];
  baseQueries?: DashBaseQuery[];
  timeRange?: string;
  autoRefreshMs?: number;
  error?: string;
}

type TimeRangeKey = 'last-15m' | 'last-1h' | 'last-4h' | 'last-24h' | 'last-7d' | 'last-30d' | 'all';
const TIME_ORDER: TimeRangeKey[] = ['last-15m', 'last-1h', 'last-4h', 'last-24h', 'last-7d', 'last-30d', 'all'];

const TILE_VIZ_OPTIONS: TileViz[] = ['table', 'timechart', 'line', 'column', 'bar', 'pie', 'stat', 'map'];

// Auto-refresh interval choices (Fabric "Manage > Auto refresh" exposes an
// explicit minimum interval + default rate). Minimum is 30s — the ADX
// /v1/rest/query round-trip is 2–10s, so a tighter cadence risks query
// pile-up. Matches the Fabric provisioner's minInterval: '30s'.
const REFRESH_INTERVALS: { ms: number; label: string }[] = [
  { ms: 0,         label: 'Off' },
  { ms: 30_000,    label: '30 seconds' },
  { ms: 60_000,    label: '1 minute' },
  { ms: 300_000,   label: '5 minutes' },
  { ms: 1_800_000, label: '30 minutes' },
  { ms: 3_600_000, label: '1 hour' },
];

function refreshLabel(ms: number): string {
  const hit = REFRESH_INTERVALS.find((r) => r.ms === ms);
  if (!ms) return 'Auto-refresh: off';
  return `Auto-refresh: ${hit ? hit.label : `${ms / 1000}s`}`;
}

function genId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* noop */ }
  return 'ds-' + Math.random().toString(36).slice(2, 10);
}

const CF_COLOR_LABELS: Record<CfColor, string> = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue' };
const CF_ICON_LABELS: Record<CfIcon, string> = { warning: 'Warning', error: 'Error', success: 'Success', info: 'Info' };
const CF_THEME_LABELS: Record<CfTheme, string> = {
  'traffic-lights': 'Traffic lights', cold: 'Cold', warm: 'Warm', blue: 'Blue', red: 'Red', yellow: 'Yellow',
};

/** A column field — Select when the live result has columns, else a free Input. */
function CfColumnField({ value, columns, onChange, label }: { value: string; columns: string[]; onChange: (v: string) => void; label: string }) {
  if (columns.length > 0) {
    return (
      <Select size="small" value={value} aria-label={label} onChange={(_: unknown, d: any) => onChange(d.value)}>
        {!columns.includes(value) && <option value={value}>{value || '(pick column)'}</option>}
        {columns.map((c) => <option key={c} value={c}>{c}</option>)}
      </Select>
    );
  }
  return <Input size="small" value={value} aria-label={label} placeholder="column name" onChange={(_: unknown, d: any) => onChange(d.value)} />;
}

/**
 * Per-tile conditional-formatting rule editor (Fabric Real-Time Dashboard
 * parity). Supports "Color by condition" (threshold → color/icon/tag, AND-ed
 * conditions, cells-or-row) and table-only "Color by value" (gradient theme).
 * Every field is a dropdown / typed Input — no freeform JSON (operator
 * no-freeform-config mandate). Rules apply client-side at render time.
 */
function ConditionalFormattingEditor({ viz, rules, columns, onChange }: {
  viz: 'table' | 'stat';
  rules: ConditionalRule[];
  columns: string[];
  onChange: (rules: ConditionalRule[]) => void;
}) {
  const isTable = viz === 'table';
  const update = (idx: number, patch: Partial<ConditionalRule>) =>
    onChange(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const removeRule = (idx: number) => onChange(rules.filter((_, i) => i !== idx));
  const addRule = (type: 'condition' | 'value') => {
    const col = columns[0] || '';
    const base: ConditionalRule = type === 'condition'
      ? { type, color: 'red', colorStyle: 'bold', applyTo: 'cells', conditions: [{ column: col, operator: '>', value: '' }] }
      : { type, theme: 'traffic-lights', column: col, applyTo: 'cells' };
    onChange([...rules, base]);
  };
  const updateCond = (ri: number, ci: number, patch: Partial<CfCondition>) =>
    onChange(rules.map((r, i) => (i === ri ? { ...r, conditions: (r.conditions || []).map((c, j) => (j === ci ? { ...c, ...patch } : c)) } : r)));
  const addCond = (ri: number) =>
    onChange(rules.map((r, i) => (i === ri ? { ...r, conditions: [...(r.conditions || []), { column: columns[0] || '', operator: '>', value: '' }] } : r)));
  const removeCond = (ri: number, ci: number) =>
    onChange(rules.map((r, i) => (i === ri ? { ...r, conditions: (r.conditions || []).filter((_, j) => j !== ci) } : r)));

  const fieldRow: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' };
  return (
    <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column', gap: 8, background: tokens.colorNeutralBackground2 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <Caption1 style={{ fontWeight: 600 }}>Conditional formatting</Caption1>
        <div style={{ display: 'flex', gap: 4 }}>
          <Button size="small" icon={<Add20Regular />} onClick={() => addRule('condition')}>Color by condition</Button>
          {isTable && <Button size="small" icon={<Add20Regular />} onClick={() => addRule('value')}>Color by value</Button>}
        </div>
      </div>
      {columns.length === 0 && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Run the tile first to pick columns from its real result. You can still type column names below.</Caption1>
      )}
      {rules.length === 0 && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>No rules — cells render unstyled. Add a rule to color cells by a data threshold.</Caption1>
      )}
      {rules.map((rule, ri) => (
        <div key={ri} style={{ border: `1px solid ${tokens.colorNeutralStroke3}`, borderRadius: 4, padding: 8, display: 'flex', flexDirection: 'column', gap: 6, background: tokens.colorNeutralBackground1 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'space-between' }}>
            <Badge appearance="outline" color={rule.type === 'value' ? 'informative' : 'brand'}>{rule.type === 'value' ? 'Color by value' : 'Color by condition'}</Badge>
            <Input size="small" style={{ flex: 1 }} value={rule.name || ''} placeholder={`Rule ${ri + 1} name (optional)`} aria-label={`Rule ${ri + 1} name`} onChange={(_: unknown, d: any) => update(ri, { name: d.value || undefined })} />
            <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Delete rule ${ri + 1}`} onClick={() => removeRule(ri)} />
          </div>

          {rule.type === 'condition' ? (
            <>
              {(rule.conditions || []).map((cond, ci) => (
                <div key={ci} style={fieldRow}>
                  {ci > 0 && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>AND</Caption1>}
                  <div style={{ minWidth: 130 }}>
                    <CfColumnField label={`Rule ${ri + 1} condition ${ci + 1} column`} value={cond.column} columns={columns} onChange={(v) => updateCond(ri, ci, { column: v })} />
                  </div>
                  <Select size="small" value={cond.operator} aria-label={`Rule ${ri + 1} condition ${ci + 1} operator`} onChange={(_: unknown, d: any) => updateCond(ri, ci, { operator: d.value as CfOperator })}>
                    {CF_OPERATORS.map((op) => <option key={op} value={op}>{op}</option>)}
                  </Select>
                  <Input
                    size="small"
                    style={{ width: 110 }}
                    value={cond.value || ''}
                    aria-label={`Rule ${ri + 1} condition ${ci + 1} value`}
                    placeholder="value"
                    disabled={cond.operator === 'is empty' || cond.operator === 'is not empty'}
                    onChange={(_: unknown, d: any) => updateCond(ri, ci, { value: d.value })}
                  />
                  {(rule.conditions || []).length > 1 && (
                    <Button size="small" appearance="subtle" icon={<Delete20Regular />} aria-label={`Remove condition ${ci + 1}`} onClick={() => removeCond(ri, ci)} />
                  )}
                </div>
              ))}
              <div>
                <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={() => addCond(ri)}>Add condition</Button>
              </div>
              <div style={fieldRow}>
                <Label size="small">Color</Label>
                <Select size="small" value={rule.color || 'red'} aria-label={`Rule ${ri + 1} color`} onChange={(_: unknown, d: any) => update(ri, { color: d.value as CfColor })}>
                  {CF_COLORS.map((c) => <option key={c} value={c}>{CF_COLOR_LABELS[c]}</option>)}
                </Select>
                <Label size="small">Style</Label>
                <Select size="small" value={rule.colorStyle || 'bold'} aria-label={`Rule ${ri + 1} style`} onChange={(_: unknown, d: any) => update(ri, { colorStyle: d.value as 'bold' | 'light' })}>
                  <option value="bold">Bold</option>
                  <option value="light">Light</option>
                </Select>
                <Label size="small">Icon</Label>
                <Select size="small" value={rule.icon || ''} aria-label={`Rule ${ri + 1} icon`} onChange={(_: unknown, d: any) => update(ri, { icon: (d.value || undefined) as CfIcon | undefined })}>
                  <option value="">None</option>
                  {CF_ICONS.map((ic) => <option key={ic} value={ic}>{CF_ICON_LABELS[ic]}</option>)}
                </Select>
                <Label size="small">Tag</Label>
                <Input size="small" style={{ width: 110 }} value={rule.tag || ''} placeholder="optional" aria-label={`Rule ${ri + 1} tag`} onChange={(_: unknown, d: any) => update(ri, { tag: d.value || undefined })} />
              </div>
            </>
          ) : (
            <div style={fieldRow}>
              <Label size="small">Column</Label>
              <div style={{ minWidth: 130 }}>
                <CfColumnField label={`Rule ${ri + 1} value column`} value={rule.column || ''} columns={columns} onChange={(v) => update(ri, { column: v })} />
              </div>
              <Label size="small">Theme</Label>
              <Select size="small" value={rule.theme || 'traffic-lights'} aria-label={`Rule ${ri + 1} theme`} onChange={(_: unknown, d: any) => update(ri, { theme: d.value as CfTheme })}>
                {CF_THEMES.map((th) => <option key={th} value={th}>{CF_THEME_LABELS[th]}</option>)}
              </Select>
              <Label size="small">Min</Label>
              <Input size="small" type="number" style={{ width: 80 }} value={rule.minValue ?? '' as any} placeholder="auto" aria-label={`Rule ${ri + 1} min`} onChange={(_: unknown, d: any) => update(ri, { minValue: d.value === '' ? undefined : Number(d.value) })} />
              <Label size="small">Max</Label>
              <Input size="small" type="number" style={{ width: 80 }} value={rule.maxValue ?? '' as any} placeholder="auto" aria-label={`Rule ${ri + 1} max`} onChange={(_: unknown, d: any) => update(ri, { maxValue: d.value === '' ? undefined : Number(d.value) })} />
              <Switch label="Reverse" checked={!!rule.reverseColors} aria-label={`Rule ${ri + 1} reverse colors`} onChange={(_: unknown, d: any) => update(ri, { reverseColors: d.checked || undefined })} />
            </div>
          )}

          {isTable && (
            <div style={fieldRow}>
              <Label size="small">Apply to</Label>
              <Select size="small" value={rule.applyTo || 'cells'} aria-label={`Rule ${ri + 1} apply to`} onChange={(_: unknown, d: any) => update(ri, { applyTo: d.value as 'cells' | 'row' })}>
                <option value="cells">Matched cells</option>
                <option value="row">Entire row</option>
              </Select>
              {(rule.applyTo || 'cells') === 'cells' && (
                <>
                  <Label size="small">Target column</Label>
                  <Select size="small" value={rule.targetColumn || ''} aria-label={`Rule ${ri + 1} target column`} onChange={(_: unknown, d: any) => update(ri, { targetColumn: d.value || undefined })}>
                    <option value="">{rule.type === 'value' ? '(graded column)' : '(all conditioned columns)'}</option>
                    {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                  <Switch label="Hide text" checked={!!rule.hideText} aria-label={`Rule ${ri + 1} hide text`} onChange={(_: unknown, d: any) => update(ri, { hideText: d.checked || undefined })} />
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function KqlDashboardEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [state, setState] = useState<DashboardState | null>(null);
  const [tiles, setTiles] = useState<DashTile[]>([]);
  const [dataSources, setDataSources] = useState<DashDataSource[]>([]);
  const [params, setParams] = useState<DashParam[]>([]);
  const [baseQueries, setBaseQueries] = useState<DashBaseQuery[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  // Index of the tile whose edit flyout (Dialog) is open, or null. Mirrors the
  // Fabric Real-Time Dashboard "tile editing window" — a single side panel that
  // edits one tile at a time, rather than expanding the card inline.
  const [tileFlyoutIdx, setTileFlyoutIdx] = useState<number | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const [timeRange, setTimeRange] = useState<TimeRangeKey>('last-24h');
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [baseQueriesOpen, setBaseQueriesOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Query-based param value caches: variableName → string[]
  const [paramValueCache, setParamValueCache] = useState<Record<string, string[]>>({});
  // Real KQL databases on the shared Loom ADX cluster — populates the data
  // source database dropdown so binding a source defaults to a deployed DB
  // instead of a blank free-text box (operator no-freeform mandate).
  const [clusterDbs, setClusterDbs] = useState<string[]>([]);

  const defaultDb = state?.database || state?.defaultDatabase || 'loomdb-default';

  // Build the live model the /run + /param-values + PUT routes consume.
  const buildModel = useCallback(() => ({
    tiles: tiles.map(({ result, error, ...t }) => t),
    dataSources,
    parameters: params,
    baseQueries,
    timeRange,
    autoRefreshMs,
  }), [tiles, dataSources, params, baseQueries, timeRange, autoRefreshMs]);

  // Load the saved model (GET). When runTiles, GET ?run=1 executes every tile.
  const load = useCallback(async (runTiles = false) => {
    if (!id || id === 'new') return;
    const sp = new URLSearchParams();
    if (runTiles) { sp.set('run', '1'); sp.set('time', timeRange); }
    for (const p of params) {
      if (!p.variableName) continue;
      if (Array.isArray(p.value)) p.value.forEach((v) => sp.append(`param.${p.variableName}`, v));
      else if (p.value !== undefined && p.value !== '') sp.set(`param.${p.variableName}`, String(p.value));
    }
    const qs = sp.toString();
    try {
      const r = await fetch(`/api/items/kql-dashboard/${id}${qs ? '?' + qs : ''}`);
      const ct = r.headers.get('content-type') || '';
      const j: DashboardState = ct.includes('application/json')
        ? await r.json()
        : { ok: false, error: `HTTP ${r.status}` };
      setState(j);
      if (j.ok) {
        setTiles(j.tiles || []);
        setDataSources(j.dataSources || []);
        setParams(j.parameters || []);
        setBaseQueries(j.baseQueries || []);
        if (typeof j.autoRefreshMs === 'number') setAutoRefreshMs(j.autoRefreshMs);
        if (j.timeRange && TIME_ORDER.includes(j.timeRange as TimeRangeKey)) setTimeRange(j.timeRange as TimeRangeKey);
        setDirty(false);
      }
    } catch (e: any) {
      setState({ ok: false, error: e?.message || String(e) });
    }
  }, [id, timeRange, params]);

  // Run the CURRENT (possibly unsaved) builder model live via POST /run.
  const runAll = useCallback(async () => {
    if (tiles.length === 0) return;
    setRunning(true); setSaveErr(null);
    try {
      const r = await fetch(`/api/items/kql-dashboard/${id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildModel()),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) { setSaveErr(j.error || `run failed (HTTP ${r.status})`); return; }
      // Merge results back onto tiles by index (order preserved by /run).
      setTiles((prev) => prev.map((t, i) => ({
        ...t,
        result: j.tiles?.[i]?.result,
        error: j.tiles?.[i]?.error,
      })));
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  }, [id, tiles.length, buildModel]);

  // Initial load: fetch the saved model, then run it live so tiles render real data.
  useEffect(() => { load(false); /* eslint-disable-next-line */ }, [id]);
  useEffect(() => { if (state?.ok && tiles.length > 0) runAll(); /* eslint-disable-next-line */ }, [state?.ok]);

  // Fetch the real KQL databases on the shared cluster once, so data-source
  // binding is a dropdown of deployed databases (not a blank text box). Best
  // effort: if the cluster is unreachable the dialog falls back to free text.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/items/eventhouse/cluster');
        const ct = r.headers.get('content-type') || '';
        const j = ct.includes('application/json') ? await r.json() : { ok: false };
        if (!cancelled && j.ok && Array.isArray(j.databases)) {
          setClusterDbs(j.databases.map((d: { name: string }) => d.name).filter(Boolean));
        }
      } catch { /* dropdown falls back to free text */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const addTile = useCallback(() => {
    setTiles((prev) => {
      const next: DashTile[] = [...prev, {
        title: `Tile ${prev.length + 1}`,
        kql: `// KQL for this tile. Use parameters (_startTime, _endTime, or your own _vars).\nprint value = 1`,
        viz: 'table', w: 4, h: 2,
      }];
      setTileFlyoutIdx(next.length - 1);
      return next;
    });
    setDirty(true);
  }, []);

  const deleteTile = useCallback((idx: number) => {
    if (typeof window !== 'undefined' && !window.confirm('Delete this tile? This cannot be undone until you reload without saving.')) return;
    setTiles((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
    setTileFlyoutIdx((cur) => (cur === idx ? null : cur !== null && cur > idx ? cur - 1 : cur));
  }, []);

  const updateTile = useCallback((idx: number, patch: Partial<DashTile>) => {
    setTiles((prev) => prev.map((t, i) => i === idx ? { ...t, ...patch } : t));
    setDirty(true);
  }, []);

  // Run a single tile live (the tile-editor "Run" button — Fabric parity).
  const runTile = useCallback(async (idx: number) => {
    const t = tiles[idx];
    if (!t) return;
    updateTile(idx, { error: undefined });
    try {
      const r = await fetch(`/api/items/kql-dashboard/${id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...buildModel(), tiles: [{ title: t.title, kql: t.kql, viz: t.viz, dataSourceId: t.dataSourceId, database: t.database }] }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) { updateTile(idx, { error: j.error || `run failed (HTTP ${r.status})`, result: undefined }); return; }
      updateTile(idx, { result: j.tiles?.[0]?.result, error: j.tiles?.[0]?.error });
    } catch (e: any) {
      updateTile(idx, { error: e?.message || String(e) });
    }
  }, [id, tiles, buildModel, updateTile]);

  // Re-run ONLY the tiles whose KQL body references the given parameter
  // variable name (selective dependent-tile re-run, like Fabric re-evaluating
  // just the tiles a changed filter feeds). `duration` params affect every
  // tile that uses the synthetic _startTime/_endTime tokens, so those re-run
  // the whole dashboard via runAll.
  const runDependentTiles = useCallback((varName: string) => {
    if (!varName) return;
    const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${esc}\\b`);
    tiles.forEach((t, idx) => {
      if (re.test(t.kql)) runTile(idx);
    });
  }, [tiles, runTile]);

  const save = useCallback(async () => {
    setSaving(true); setSaveErr(null); setSaveMsg('Saving…');
    try {
      const r = await fetch(`/api/items/kql-dashboard/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildModel()),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (j.ok) {
        setDirty(false);
        setSaveMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      } else {
        setSaveErr(j.error || 'save failed');
        setSaveMsg(`Save failed: ${j.error || 'unknown'}`);
      }
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
      setSaveMsg(`Save failed: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  }, [id, buildModel]);

  // Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && !saving) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, saving, save]);

  // Auto-refresh — re-run the live model every N ms.
  useEffect(() => {
    if (!autoRefreshMs || autoRefreshMs <= 0) return;
    const t = setInterval(() => { runAll(); }, autoRefreshMs);
    return () => clearInterval(t);
  }, [autoRefreshMs, runAll]);

  // --- Data sources ---
  const addDataSource = useCallback(() => {
    // Default to a real deployed database (prefer the cluster default) rather
    // than a blank box — operator no-freeform mandate.
    const seedDb = clusterDbs.includes(defaultDb) ? defaultDb : (clusterDbs[0] || defaultDb);
    setDataSources((prev) => [...prev, { id: genId(), name: `Source ${prev.length + 1}`, database: seedDb }]);
    setDirty(true);
  }, [defaultDb, clusterDbs]);
  const updateDataSource = useCallback((idx: number, patch: Partial<DashDataSource>) => {
    setDataSources((prev) => prev.map((d, i) => i === idx ? { ...d, ...patch } : d));
    setDirty(true);
  }, []);
  const removeDataSource = useCallback((idx: number) => {
    setDataSources((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }, []);

  // --- Parameters ---
  const addParam = useCallback(() => {
    setParams((prev) => [...prev, { variableName: `_param${prev.length + 1}`, label: `Parameter ${prev.length + 1}`, type: 'freetext', dataType: 'string', value: '' }]);
    setDirty(true);
  }, []);
  const updateParam = useCallback((idx: number, patch: Partial<DashParam>) => {
    setParams((prev) => prev.map((p, i) => i === idx ? { ...p, ...patch } : p));
    setDirty(true);
  }, []);
  const removeParam = useCallback((idx: number) => {
    setParams((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }, []);

  // --- Base queries (shared KQL snippets referenced via $baseQuery('name')) ---
  const addBaseQuery = useCallback(() => {
    setBaseQueries((prev) => [...prev, { id: genId(), name: `Query${prev.length + 1}`, kql: '// Shared KQL — referenced from a tile as $baseQuery(\'Query1\')\nStormEvents | where StartTime > _startTime' }]);
    setDirty(true);
  }, []);
  const updateBaseQuery = useCallback((idx: number, patch: Partial<DashBaseQuery>) => {
    setBaseQueries((prev) => prev.map((q, i) => i === idx ? { ...q, ...patch } : q));
    setDirty(true);
  }, []);
  const removeBaseQuery = useCallback((idx: number) => {
    setBaseQueries((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  }, []);

  // Resolve a query-based parameter's dropdown values from the real cluster.
  const loadParamValues = useCallback(async (p: DashParam) => {
    if (p.type !== 'query' || !p.query?.trim()) return;
    try {
      const r = await fetch(`/api/items/kql-dashboard/${id}/param-values`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: p.query, dataSourceId: p.dataSourceId, dataSources }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false };
      if (j.ok) setParamValueCache((prev) => ({ ...prev, [p.variableName]: j.values || [] }));
    } catch { /* surfaced lazily; dropdown just stays empty */ }
  }, [id, dataSources]);

  const openJson = useCallback(() => {
    setJsonText(JSON.stringify(buildModel(), null, 2));
    setJsonErr(null);
    setJsonOpen(true);
  }, [buildModel]);

  const applyJson = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      const model = Array.isArray(parsed) ? { tiles: parsed } : parsed;
      if (Array.isArray(model.tiles)) setTiles(model.tiles);
      if (Array.isArray(model.dataSources)) setDataSources(model.dataSources);
      if (Array.isArray(model.parameters)) setParams(model.parameters);
      if (Array.isArray(model.baseQueries)) setBaseQueries(model.baseQueries);
      if (typeof model.timeRange === 'string' && TIME_ORDER.includes(model.timeRange)) setTimeRange(model.timeRange);
      setDirty(true); setJsonOpen(false); setJsonErr(null);
    } catch (e: any) {
      setJsonErr(e?.message || 'invalid JSON');
    }
  }, [jsonText]);

  const cycleTime = useCallback(() => {
    const i = TIME_ORDER.indexOf(timeRange);
    const next = TIME_ORDER[(i + 1) % TIME_ORDER.length];
    setTimeRange(next);
    setTimeout(() => runAll(), 0);
  }, [timeRange, runAll]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Edit', actions: [
        { label: 'Add tile', onClick: addTile },
        { label: 'Data sources', onClick: () => setSourcesOpen(true) },
        { label: 'Parameters', onClick: () => setParamsOpen(true) },
        { label: 'Base queries', onClick: () => setBaseQueriesOpen(true) },
        { label: 'Edit JSON', onClick: openJson },
      ]},
      { label: 'View', actions: [
        { label: running ? 'Refreshing…' : 'Refresh all', onClick: running ? undefined : runAll, disabled: running },
        // The interval is authored via the toolbar <Select>; the ribbon shows
        // current state (a one-state cycle button was undiscoverable).
        { label: refreshLabel(autoRefreshMs), onClick: undefined, disabled: true },
        { label: `Time: ${timeRange}`, onClick: cycleTime },
      ]},
      { label: 'Manage', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: saving ? undefined : save, disabled: saving },
        { label: 'Share', onClick: () => setShareOpen(true) },
      ]},
    ]},
  ], [addTile, openJson, running, runAll, autoRefreshMs, timeRange, cycleTime, saving, save]);

  const main = (
    <div className={s.pad}>
      <div className={s.toolbar}>
        <Badge appearance="filled" color="brand">Real-Time Dashboard</Badge>
        <Caption1>db: <strong>{defaultDb}</strong> · {tiles.length} tiles · {dataSources.length} sources · {params.length} params</Caption1>
        {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
        <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={addTile}>Add tile</Button>
        <Button size="small" appearance="outline" icon={<Database20Regular />} onClick={() => setSourcesOpen(true)}>Data sources</Button>
        <Button size="small" appearance="outline" icon={<MathFormula20Regular />} onClick={() => setParamsOpen(true)}>Parameters</Button>
        <Button size="small" appearance="outline" onClick={() => setBaseQueriesOpen(true)}>Base queries</Button>
        <Button size="small" appearance="outline" onClick={openJson}>Edit JSON</Button>
        <Button size="small" appearance="outline" icon={<ArrowSync20Regular />} onClick={runAll} disabled={running}>{running ? 'Refreshing…' : 'Refresh all'}</Button>
        <Select
          size="small"
          aria-label="Auto-refresh interval"
          value={String(autoRefreshMs)}
          onChange={(_: unknown, d: any) => { setAutoRefreshMs(Number(d.value) || 0); setDirty(true); }}
          style={{ minWidth: 150 }}
        >
          {REFRESH_INTERVALS.map(({ ms, label }) => (
            <option key={ms} value={String(ms)}>
              {ms === 0 ? 'Auto-refresh: off' : `Auto-refresh: every ${label}`}
            </option>
          ))}
        </Select>
        <Button size="small" appearance="primary" icon={<Save20Regular />} onClick={save} disabled={saving || !dirty} style={{ marginLeft: 'auto' }}>
          {saving ? 'Saving…' : 'Save (Ctrl+S)'}
        </Button>
      </div>

      {/* Parameter filter bar — Fabric renders selected dashboard params here. */}
      {params.length > 0 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', padding: '4px 0' }}>
          {params.map((p, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 160 }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{p.label || p.variableName}</Caption1>
              {p.type === 'fixed' || p.type === 'datasource' ? (
                <Select value={(p.value as string) || ''}
                  onChange={(_: unknown, d: any) => { updateParam(i, { value: d.value }); setTimeout(() => runDependentTiles(p.variableName), 0); }}>
                  <option value="">(all)</option>
                  {(p.type === 'datasource' ? dataSources.map((d) => d.name) : (p.values || [])).map((v) => <option key={v} value={v}>{v}</option>)}
                </Select>
              ) : p.type === 'query' ? (
                <Select value={(p.value as string) || ''}
                  onFocus={() => { if (!paramValueCache[p.variableName]) loadParamValues(p); }}
                  onChange={(_: unknown, d: any) => { updateParam(i, { value: d.value }); setTimeout(() => runDependentTiles(p.variableName), 0); }}>
                  <option value="">(all)</option>
                  {(paramValueCache[p.variableName] || []).map((v) => <option key={v} value={v}>{v}</option>)}
                </Select>
              ) : p.type === 'duration' ? (
                // Time-range picker — matches the Fabric "Duration" param type.
                // Changing it sets the global time range (which drives the
                // synthetic _startTime/_endTime tokens) and re-runs every tile.
                <Select value={(p.value as string) || timeRange}
                  onChange={(_: unknown, d: any) => {
                    updateParam(i, { value: d.value });
                    if (TIME_ORDER.includes(d.value as TimeRangeKey)) setTimeRange(d.value as TimeRangeKey);
                    setTimeout(() => runAll(), 0);
                  }}>
                  {TIME_ORDER.map((k) => <option key={k} value={k}>{k}</option>)}
                </Select>
              ) : p.type === 'multi' ? (
                p.values && p.values.length > 0 ? (
                  // Fixed-value multi-select — native <select multiple> backed
                  // by the param's allowed values list.
                  <select
                    multiple
                    size={Math.min(p.values.length, 5)}
                    value={Array.isArray(p.value) ? (p.value as string[]) : []}
                    onChange={(e) => updateParam(i, { value: Array.from(e.target.selectedOptions).map((o) => o.value) })}
                    onBlur={() => runDependentTiles(p.variableName)}
                    aria-label={p.label || p.variableName}
                    style={{ minWidth: 160, padding: 4, border: `1px solid ${tokens.colorNeutralStroke1}`, borderRadius: 4, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}>
                    {p.values.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                ) : (
                  <Input placeholder="comma,separated,values"
                    value={Array.isArray(p.value) ? p.value.join(',') : ''}
                    onChange={(_: unknown, d: any) => updateParam(i, { value: d.value.split(',').map((x: string) => x.trim()).filter(Boolean) })}
                    onBlur={() => runDependentTiles(p.variableName)} />
                )
              ) : (
                <Input value={Array.isArray(p.value) ? '' : (p.value || '')}
                  onChange={(_: unknown, d: any) => updateParam(i, { value: d.value })}
                  onBlur={() => runDependentTiles(p.variableName)} />
              )}
            </div>
          ))}
          <Button size="small" appearance="primary" icon={<Play20Regular />} onClick={runAll} disabled={running}>Apply</Button>
        </div>
      )}

      {saveMsg && !saveErr && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{saveMsg}</Caption1>}
      {saveErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Error</MessageBarTitle>{saveErr}</MessageBarBody></MessageBar>}
      {state && !state.ok && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Dashboard data source not ready</MessageBarTitle>
            {state.error || 'unknown'} — the dashboard still renders; bind tiles to a KQL database
            (via Data sources) on the Loom shared ADX cluster. If no Eventhouse / KQL DB is provisioned,
            create one in the Eventhouse editor first (ARM Microsoft.Kusto/clusters/databases).
          </MessageBarBody>
        </MessageBar>
      )}

      {/* Tile grid — 12-col CSS grid; each tile spans its w/h. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 12, gridAutoRows: 'minmax(120px, auto)' }}>
        {tiles.map((t, i) => {
          const span = Math.max(1, Math.min(12, t.w || 4));
          const rowSpan = Math.max(1, Math.min(8, t.h || 2));
          const dsName = t.dataSourceId ? (dataSources.find((d) => d.id === t.dataSourceId)?.name || t.dataSourceId) : (t.database || defaultDb);
          return (
            <div key={i} className={s.card} style={{ gridColumn: `span ${span}`, gridRow: `span ${rowSpan}`, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{t.viz.toUpperCase()} · {dsName}</Caption1>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{t.title}</div>
                </div>
                <div style={{ display: 'flex', gap: 2 }}>
                  <Button size="small" appearance="subtle" icon={<Play20Regular />} onClick={() => runTile(i)} aria-label="Run tile" title="Run this tile" />
                  <Button size="small" appearance="subtle" onClick={() => setTileFlyoutIdx(i)} aria-label="Edit tile">
                    Edit
                  </Button>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => deleteTile(i)} aria-label="Delete tile" />
                </div>
              </div>

              {t.error && <MessageBar intent="error" style={{ marginTop: 6 }}><MessageBarBody>{t.error}</MessageBarBody></MessageBar>}
              {t.result && t.result.ok && (
                <div style={{ marginTop: 8, flex: 1, minHeight: 0 }}>
                  <TileVisual
                    viz={t.viz}
                    result={t.result}
                    conditionalRules={t.conditionalRules}
                    drillthrough={t.drillthrough}
                    onDrillthrough={t.drillthrough ? (paramName, value) => {
                      // Inject the clicked value into the target parameter, then
                      // re-run every tile so the dashboard cross-filters — the
                      // single-page Loom equivalent of Fabric drill-through.
                      setParams((prev) => prev.map((p) => p.variableName === paramName ? { ...p, value } : p));
                      setTimeout(() => runAll(), 0);
                    } : undefined}
                  />
                  {/* Stable, machine-readable first-row snapshot — the
                      before/after receipt target for the param-change E2E. */}
                  <span data-testid="tile-result-row" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                    {JSON.stringify(t.result.rows?.[0] ?? [])}
                  </span>
                </div>
              )}
              {!t.result && !t.error && <Caption1 style={{ marginTop: 8, color: tokens.colorNeutralForeground3 }}>Run the tile to see results.</Caption1>}
            </div>
          );
        })}
        {tiles.length === 0 && <Caption1 style={{ gridColumn: 'span 12' }}>No tiles yet. Click <strong>Add tile</strong> to start building.</Caption1>}
      </div>

      {/* Tile edit flyout — Fabric "tile editing window": one Dialog edits the
          tile at tileFlyoutIdx (title, visual, data source, geometry, KQL),
          runs it live, and renders the real result inline before Apply. */}
      <Dialog open={tileFlyoutIdx !== null} onOpenChange={(_: unknown, d: any) => { if (!d.open) setTileFlyoutIdx(null); }}>
        <DialogSurface style={{ maxWidth: 760 }}>
          <DialogBody>
            <DialogTitle>Edit tile</DialogTitle>
            <DialogContent>
              {tileFlyoutIdx !== null && tiles[tileFlyoutIdx] && (() => {
                const i = tileFlyoutIdx;
                const t = tiles[i];
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div>
                      <Caption1>Title</Caption1>
                      <Input value={t.title} onChange={(_: unknown, d: any) => updateTile(i, { title: d.value })} placeholder="Title" aria-label="Tile title" />
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <div style={{ flex: 1, minWidth: 140 }}>
                        <Caption1>Visual</Caption1>
                        <Select value={t.viz} onChange={(_: unknown, d: any) => updateTile(i, { viz: d.value as TileViz })} aria-label="Tile visual type">
                          {TILE_VIZ_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                        </Select>
                      </div>
                      <div style={{ flex: 1, minWidth: 140 }}>
                        <Caption1>Data source</Caption1>
                        <Select value={t.dataSourceId || ''} onChange={(_: unknown, d: any) => updateTile(i, { dataSourceId: d.value || undefined })} aria-label="Tile data source">
                          <option value="">{`(dashboard default: ${defaultDb})`}</option>
                          {dataSources.map((ds) => <option key={ds.id} value={ds.id}>{ds.name} → {ds.database}</option>)}
                        </Select>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <div style={{ flex: 1 }}>
                        <Caption1>Width (1–12)</Caption1>
                        <Input type="number" value={String(t.w || 4)} onChange={(_: unknown, d: any) => updateTile(i, { w: Math.max(1, Math.min(12, parseInt(d.value, 10) || 4)) })} aria-label="Tile width" />
                      </div>
                      <div style={{ flex: 1 }}>
                        <Caption1>Height (1–8)</Caption1>
                        <Input type="number" value={String(t.h || 2)} onChange={(_: unknown, d: any) => updateTile(i, { h: Math.max(1, Math.min(8, parseInt(d.value, 10) || 2)) })} aria-label="Tile height" />
                      </div>
                    </div>
                    <Caption1>KQL query{baseQueries.length > 0 ? ' — reference a base query as $baseQuery(\'name\')' : ''}</Caption1>
                    <MonacoTextarea
                      value={t.kql}
                      onChange={(v) => updateTile(i, { kql: v })}
                      language="kql"
                      height={220}
                      minHeight={180}
                      ariaLabel={`Tile ${i + 1} KQL`}
                    />
                    <Button size="small" appearance="primary" icon={<Play20Regular />} onClick={() => runTile(i)}>Run tile</Button>
                    {t.error && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Query failed</MessageBarTitle>{t.error}</MessageBarBody></MessageBar>}
                    {t.result && t.result.ok && (
                      <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: 8 }}>
                        <TileVisual viz={t.viz} result={t.result} conditionalRules={t.conditionalRules} />
                      </div>
                    )}

                    {/* Drill-through (Fabric: visual Interactions > Drillthrough).
                        Clicking a result value sets a dashboard parameter and
                        re-runs every tile (single-page cross-filter). */}
                    <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 8, marginTop: 4 }}>
                      <Caption1 style={{ fontWeight: 600 }}>Drill-through</Caption1>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginBottom: 4 }}>
                        Clicking a value in this tile injects it into a dashboard parameter and re-runs all tiles.
                      </Caption1>
                      {params.length === 0 ? (
                        <MessageBar intent="info">
                          <MessageBarBody>
                            Add at least one dashboard <strong>Parameter</strong> first — drill-through targets a parameter.
                          </MessageBarBody>
                        </MessageBar>
                      ) : (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                          <div style={{ flex: 1, minWidth: 140 }}>
                            <Caption1>Column (from query result)</Caption1>
                            {t.result?.ok && (t.result.columns?.length ?? 0) > 0 ? (
                              <Select
                                value={t.drillthrough?.column || ''}
                                aria-label="Drillthrough column"
                                onChange={(_: unknown, d: any) => {
                                  const column = d.value;
                                  const paramName = t.drillthrough?.paramName || '';
                                  updateTile(i, {
                                    drillthrough: column.trim() || paramName ? { column, paramName } : undefined,
                                  });
                                }}
                              >
                                <option value="">(none)</option>
                                {(t.result.columns || []).map((c) => (
                                  <option key={c} value={c}>{c}</option>
                                ))}
                              </Select>
                            ) : (
                              <Input
                                value={t.drillthrough?.column || ''}
                                placeholder="Run the tile to pick a column"
                                aria-label="Drillthrough column"
                                onChange={(_: unknown, d: any) => {
                                  const column = d.value;
                                  const paramName = t.drillthrough?.paramName || '';
                                  updateTile(i, {
                                    drillthrough: column.trim() || paramName ? { column, paramName } : undefined,
                                  });
                                }}
                              />
                            )}
                          </div>
                          <div style={{ flex: 1, minWidth: 140 }}>
                            <Caption1>Target parameter</Caption1>
                            <Select
                              value={t.drillthrough?.paramName || ''}
                              aria-label="Drillthrough target parameter"
                              onChange={(_: unknown, d: any) => {
                                const paramName = d.value;
                                const column = t.drillthrough?.column || '';
                                updateTile(i, {
                                  drillthrough: column.trim() || paramName ? { column, paramName } : undefined,
                                });
                              }}
                            >
                              <option value="">(none — disable drill-through)</option>
                              {params.map((p) => (
                                <option key={p.variableName} value={p.variableName}>{p.label || p.variableName}</option>
                              ))}
                            </Select>
                          </div>
                        </div>
                      )}
                      {t.drillthrough?.column && t.drillthrough?.paramName && (
                        <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: 4 }}>
                          Click a value in this tile → sets <code>{t.drillthrough.paramName}</code> to the value in column <code>{t.drillthrough.column}</code> and re-runs all tiles.
                        </Caption1>
                      )}
                    </div>

                    {/* Conditional formatting (Fabric RTD: color by condition / by value).
                        Applies to table + stat (card) visuals. */}
                    {(t.viz === 'table' || t.viz === 'stat') && (
                      <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 8, marginTop: 4 }}>
                        <ConditionalFormattingEditor
                          viz={t.viz}
                          rules={t.conditionalRules || []}
                          columns={t.result?.columns || []}
                          onChange={(rules) => updateTile(i, { conditionalRules: rules.length ? rules : undefined })}
                        />
                      </div>
                    )}
                  </div>
                );
              })()}
            </DialogContent>
            <DialogActions>
              {tileFlyoutIdx !== null && (
                <Button appearance="secondary" icon={<Delete20Regular />} onClick={() => deleteTile(tileFlyoutIdx)}>Delete tile</Button>
              )}
              <Button appearance="primary" onClick={() => setTileFlyoutIdx(null)}>Apply</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Base queries dialog — shared KQL snippets referenced via $baseQuery('name') */}
      <Dialog open={baseQueriesOpen} onOpenChange={(_: unknown, d: any) => setBaseQueriesOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 640 }}>
          <DialogBody>
            <DialogTitle>Base queries</DialogTitle>
            <DialogContent>
              <Caption1>
                Define shared KQL snippets once and reference them from any tile with
                <code> $baseQuery('name')</code>. At run time the snippet is inlined as a
                parenthesised sub-query, so a common filter or projection backs many tiles
                without copy-paste (Fabric Real-Time Dashboard base-query parity).
              </Caption1>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
                {baseQueries.map((q, idx) => (
                  <div key={q.id} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                      <div style={{ flex: 1 }}>
                        <Caption1>Name (referenced as $baseQuery('…'))</Caption1>
                        <Input value={q.name} onChange={(_: unknown, d: any) => updateBaseQuery(idx, { name: d.value })} placeholder="Filtered" aria-label="Base query name" />
                      </div>
                      <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => removeBaseQuery(idx)} aria-label="Remove base query" />
                    </div>
                    <Caption1>KQL</Caption1>
                    <MonacoTextarea
                      value={q.kql}
                      onChange={(v) => updateBaseQuery(idx, { kql: v })}
                      language="kql"
                      height={120}
                      minHeight={90}
                      ariaLabel={`Base query ${idx + 1} KQL`}
                    />
                  </div>
                ))}
                {baseQueries.length === 0 && <Caption1>No base queries yet. Add one to share a KQL snippet across tiles.</Caption1>}
                <Button appearance="outline" icon={<Add20Regular />} onClick={addBaseQuery}>Add base query</Button>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setBaseQueriesOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Data sources dialog */}
      <Dialog open={sourcesOpen} onOpenChange={(_: unknown, d: any) => setSourcesOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 620 }}>
          <DialogBody>
            <DialogTitle>Data sources</DialogTitle>
            <DialogContent>
              <Caption1>Bind the dashboard to one or more KQL databases on the Loom shared ADX cluster. Tiles select a source; query-based parameters can run against a source.</Caption1>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                {dataSources.map((ds, idx) => (
                  <div key={ds.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <div style={{ flex: 1 }}>
                      <Caption1>Name</Caption1>
                      <Input value={ds.name} onChange={(_: unknown, d: any) => updateDataSource(idx, { name: d.value })} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <Caption1>KQL database</Caption1>
                      {clusterDbs.length > 0 ? (
                        <Select
                          value={clusterDbs.includes(ds.database) ? ds.database : '__custom__'}
                          onChange={(_: unknown, d: any) => { if (d.value !== '__custom__') updateDataSource(idx, { database: d.value }); }}
                          aria-label="KQL database"
                        >
                          {clusterDbs.map((db) => <option key={db} value={db}>{db}</option>)}
                          <option value="__custom__">Other (type below)…</option>
                        </Select>
                      ) : null}
                      {(clusterDbs.length === 0 || !clusterDbs.includes(ds.database)) && (
                        <Input value={ds.database} onChange={(_: unknown, d: any) => updateDataSource(idx, { database: d.value })} placeholder="loomdb-default" aria-label="KQL database (custom)" style={{ marginTop: clusterDbs.length > 0 ? 4 : 0 }} />
                      )}
                    </div>
                    <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => removeDataSource(idx)} aria-label="Remove data source" />
                  </div>
                ))}
                {dataSources.length === 0 && <Caption1>No explicit data sources — tiles use the dashboard default database <strong>{defaultDb}</strong>.</Caption1>}
                <Button appearance="outline" icon={<Add20Regular />} onClick={addDataSource}>Add data source</Button>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setSourcesOpen(false)}>Done</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Parameters dialog — free-text / fixed / multi / query / datasource / duration */}
      <Dialog open={paramsOpen} onOpenChange={(_: unknown, d: any) => setParamsOpen(d.open)}>
        <DialogSurface style={{ maxWidth: 720 }}>
          <DialogBody>
            <DialogTitle>Dashboard parameters</DialogTitle>
            <DialogContent>
              <Caption1>
                Parameters substitute into tile KQL by their variable name (Fabric convention, e.g. <code>_eventType</code>).
                Time range exposes <code>_startTime</code>/<code>_endTime</code>; <code>_loomTimeFrom</code> is also supported.
                <code> multi</code> renders as <code>dynamic([...])</code> for <code>x in (_var)</code> filters.
              </Caption1>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
                {params.map((p, idx) => (
                  <div key={idx} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <div style={{ flex: 1 }}>
                        <Caption1>Variable name</Caption1>
                        <Input value={p.variableName} onChange={(_: unknown, d: any) => updateParam(idx, { variableName: d.value })} placeholder="_eventType" />
                      </div>
                      <div style={{ flex: 1 }}>
                        <Caption1>Label</Caption1>
                        <Input value={p.label || ''} onChange={(_: unknown, d: any) => updateParam(idx, { label: d.value })} />
                      </div>
                      <Button appearance="subtle" icon={<Delete20Regular />} onClick={() => removeParam(idx)} aria-label="Remove parameter" />
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <div style={{ flex: 1 }}>
                        <Caption1>Type</Caption1>
                        <Select value={p.type} onChange={(_: unknown, d: any) => updateParam(idx, { type: d.value as DashParamType })}>
                          <option value="freetext">Free text</option>
                          <option value="fixed">Fixed values (single)</option>
                          <option value="multi">Multi-select</option>
                          <option value="query">Query-based</option>
                          <option value="datasource">Data source</option>
                          <option value="duration">Duration (time range)</option>
                        </Select>
                      </div>
                      <div style={{ flex: 1 }}>
                        <Caption1>Data type</Caption1>
                        <Select value={p.dataType || 'string'} onChange={(_: unknown, d: any) => updateParam(idx, { dataType: d.value as DashParamDataType })}>
                          <option value="string">string</option>
                          <option value="long">long</option>
                          <option value="int">int</option>
                          <option value="real">real</option>
                          <option value="datetime">datetime</option>
                          <option value="bool">bool</option>
                        </Select>
                      </div>
                    </div>
                    {(p.type === 'fixed' || p.type === 'multi') && (
                      <div>
                        <Caption1>Allowed values (comma-separated)</Caption1>
                        <Input value={(p.values || []).join(',')} onChange={(_: unknown, d: any) => updateParam(idx, { values: d.value.split(',').map((x: string) => x.trim()).filter(Boolean) })} />
                      </div>
                    )}
                    {p.type === 'query' && (
                      <>
                        <Caption1>Values query (returns one column)</Caption1>
                        <Textarea value={p.query || ''} onChange={(_: unknown, d: any) => updateParam(idx, { query: d.value })} rows={2} style={{ fontFamily: 'Consolas, monospace', fontSize: 12 }} placeholder="StormEvents | distinct State" />
                        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                          <div style={{ flex: 1 }}>
                            <Caption1>Run against source</Caption1>
                            <Select value={p.dataSourceId || ''} onChange={(_: unknown, d: any) => updateParam(idx, { dataSourceId: d.value || undefined })}>
                              <option value="">{`(default: ${defaultDb})`}</option>
                              {dataSources.map((ds) => <option key={ds.id} value={ds.id}>{ds.name}</option>)}
                            </Select>
                          </div>
                          <Button size="small" appearance="outline" onClick={() => loadParamValues(p)}>Preview values</Button>
                        </div>
                        {paramValueCache[p.variableName] && <Caption1>{paramValueCache[p.variableName].length} values loaded.</Caption1>}
                      </>
                    )}
                  </div>
                ))}
                <Button appearance="outline" icon={<Add20Regular />} onClick={addParam}>Add parameter</Button>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setParamsOpen(false)}>Close</Button>
              <Button appearance="primary" onClick={() => { setParamsOpen(false); runAll(); }}>Apply &amp; re-run</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Edit JSON model dialog */}
      <Dialog open={jsonOpen} onOpenChange={(_: unknown, d: any) => setJsonOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Edit dashboard model (JSON)</DialogTitle>
            <DialogContent>
              <Caption1>Full model: <code>{`{ tiles, dataSources, parameters, timeRange }`}</code>. An array root is accepted as just the tiles.</Caption1>
              <Textarea
                value={jsonText}
                onChange={(_: unknown, d: any) => { setJsonText(d.value); setJsonErr(null); }}
                rows={20}
                style={{ width: '100%', fontFamily: 'Consolas, monospace', fontSize: 12, marginTop: 8 }}
                aria-label="Dashboard JSON model"
              />
              {jsonErr && <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody><MessageBarTitle>JSON parse error</MessageBarTitle>{jsonErr}</MessageBarBody></MessageBar>}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setJsonOpen(false)}>Cancel</Button>
              <Button appearance="primary" onClick={applyJson}>Apply</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Share dialog */}
      <Dialog open={shareOpen} onOpenChange={(_: unknown, d: any) => setShareOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Share dashboard</DialogTitle>
            <DialogContent>
              <Caption1>Anyone with access to this Loom item can view it. Permissions are managed via the workspace item ACL.</Caption1>
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Caption1>Canonical URL</Caption1>
                <Input value={typeof window !== 'undefined' ? window.location.href : ''} readOnly />
                <Button appearance="outline" onClick={() => { if (typeof navigator !== 'undefined' && navigator.clipboard) navigator.clipboard.writeText(window.location.href).catch(() => {}); }}>Copy URL</Button>
                <Caption1>To grant another user access, add them to this item via the workspace permissions page (Loom RBAC). Tenant-wide sharing is not enabled in this deployment.</Caption1>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={() => setShareOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );

  // On /new there is no Cosmos record yet, so Save (PUT) / Run (POST) would
  // 404/operate without persistence. Mirror the Eventstream/Activator pattern:
  // an ENABLED create surface mints a Cosmos kql-dashboard item, then routes to
  // this live editor where Add tile + Run + Save + parameters all work against
  // the real Kusto cluster + Cosmos.
  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="New Real-Time Dashboard"
        intro="A Real-Time (KQL) Dashboard is a collection of tiles — each a KQL query bound to a KQL database, rendered as a table, time chart, bar/column, pie, stat card, or map. Bind data sources, add dashboard parameters (free-text, fixed, query-based, time range) that substitute into tile KQL, set auto-refresh, and Save. Create it, then build tiles that run live against the Loom shared ADX cluster." />
    );
  }

  return <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={main} />;
}

// ----- Eventstream -----
// Ribbon built inside the editor via useMemo so Save binds to the
// existing inline save handler; the rest stay disabled with reasons.

interface StreamCfg {
  source?: Record<string, any>;
  sink?: Record<string, any>;
  transforms?: Array<Record<string, any>>;
}

interface EventstreamState {
  ok: boolean;
  runtimeStatus?: string;
  runtimeNote?: string;
  config?: StreamCfg;
  asaJobName?: string | null;
  error?: string;
}

const DEFAULT_ES_CFG: StreamCfg = {
  source: { kind: 'eventhub', namespace: '', name: '', consumerGroup: '$Default' },
  transforms: [],
  sink: { kind: 'kusto', database: 'loomdb-default', table: '' },
};

export function EventstreamEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const ws = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [state, setState] = useState<EventstreamState | null>(null);
  const [cfgText, setCfgText] = useState(JSON.stringify(DEFAULT_ES_CFG, null, 2));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'designer' | 'json'>('designer');
  // Publish-to-Fabric dialog state. Publishing creates/updates a REAL
  // Fabric Eventstream item via the definition REST API.
  const [publishOpen, setPublishOpen] = useState(false);
  const [fabricWsId, setFabricWsId] = useState('');
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishErr, setPublishErr] = useState<string | null>(null);
  const [publishHint, setPublishHint] = useState<string | null>(null);
  const [publishMsg, setPublishMsg] = useState<string | null>(null);
  const [publishedId, setPublishedId] = useState<string | null>(null);
  // Push-to-ASA: materialize the saved destination nodes as real Azure Stream
  // Analytics outputs (KQL DB → ADX, Lakehouse → ADLS Gen2 Blob, Event Hub,
  // Activator → Event Hub). The target ASA job is named here and persisted.
  const [asaJobName, setAsaJobName] = useState(
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_LOOM_ASA_JOB_NAME) || '',
  );
  const [asaSyncBusy, setAsaSyncBusy] = useState(false);
  const [asaSyncErr, setAsaSyncErr] = useState<string | null>(null);
  const [asaSyncHint, setAsaSyncHint] = useState<string | null>(null);
  const [asaSyncMsg, setAsaSyncMsg] = useState<string | null>(null);
  const [asaOutputs, setAsaOutputs] = useState<Array<{ name: string; type: string; id: string }>>([]);
  // Provision-to-Azure (Azure-native default: Event Hubs + Stream Analytics).
  // Maps the saved canvas topology onto real ARM resources — no Fabric needed.
  const [provisionBusy, setProvisionBusy] = useState(false);
  const [provisionResult, setProvisionResult] = useState<{ ehId?: string; asaJobId?: string | null; steps?: string[]; partial?: boolean; hint?: string | null } | null>(null);
  const [provisionErr, setProvisionErr] = useState<string | null>(null);
  const [provisionHint, setProvisionHint] = useState<string | null>(null);

  // Visual designer ↔ JSON sync. Best-effort: when JSON parses we mirror
  // it into the designer; when the designer changes we re-serialize JSON.
  let parsedVisual: VisualPipelineConfig = {};
  try { parsedVisual = JSON.parse(cfgText) as VisualPipelineConfig; } catch { parsedVisual = {}; }

  const onDesignerChange = useCallback((next: VisualPipelineConfig) => {
    // Project back to the on-wire shape { source, transforms[], sink } that the BFF persists.
    const sources = Array.isArray(next.sources) ? next.sources : (next.source ? [next.source] : []);
    const sinks = Array.isArray(next.sinks) ? next.sinks : (next.sink ? [next.sink] : []);
    const projected: any = {
      source: sources[0] as VisualSourceNode | undefined,
      transforms: (next.transforms || []) as VisualTransformNode[],
      sink: sinks[0] as VisualSinkNode | undefined,
    };
    // Preserve multi-source/multi-sink if present so we don't lose data.
    if (sources.length > 1) projected.sources = sources;
    if (sinks.length > 1) projected.sinks = sinks;
    setCfgText(JSON.stringify(projected, null, 2));
    setDirty(true);
    setParseErr(null);
    setSaveErr(null);
  }, []);

  // Auto-pick the first workspace once loaded so the editor isn't blocked
  // on a manual click for the common single-workspace deployments. Users
  // can still switch via the picker below.
  useEffect(() => {
    if (!workspaceId && ws.workspaces && ws.workspaces.length > 0) {
      setWorkspaceId(ws.workspaces[0].id);
    }
  }, [workspaceId, ws.workspaces]);

  const load = useCallback(async () => {
    // Pre-save gate: /items/eventstream/new fires this before any record exists
    // (was returning 404 on the walkthrough validator). Skip the fetch so the
    // editor renders its default DEFAULT_ES_CFG until the user saves.
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/eventstream/${id}`);
      const j = (await r.json()) as EventstreamState & { fabricEventstreamId?: string | null };
      setState(j);
      if (j.fabricEventstreamId) setPublishedId(j.fabricEventstreamId);
      if (j.asaJobName) setAsaJobName(j.asaJobName);
      const cfg = j.config && (j.config.source || j.config.sink || (j.config.transforms?.length ?? 0) > 0)
        ? j.config
        : DEFAULT_ES_CFG;
      setCfgText(JSON.stringify(cfg, null, 2));
      setDirty(false);
      setParseErr(null); setSaveErr(null); setSaveMsg(null);
    } catch (e: any) {
      setState({ ok: false, error: e?.message || String(e) });
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async () => {
    setParseErr(null); setSaveErr(null);
    let parsed: StreamCfg;
    try { parsed = JSON.parse(cfgText); }
    catch (e: any) {
      const m = e?.message || 'invalid JSON';
      setParseErr(m);
      setSaveMsg(`Cannot save: JSON parse error — ${m}`);
      return;
    }
    setSaving(true); setSaveMsg('Saving…');
    try {
      const r = await fetch(`/api/items/eventstream/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: parsed }),
      });
      const j = await r.json();
      if (j.ok) {
        setDirty(false);
        setSaveMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      } else {
        setSaveErr(j.error || 'save failed');
        setSaveMsg(`Save failed: ${j.error || 'unknown'}`);
      }
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
      setSaveMsg(`Save failed: ${e?.message || e}`);
    } finally {
      setSaving(false);
    }
  }, [id, cfgText]);

  // Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && !saving) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, saving, save]);

  // Publish the saved pipeline to a REAL Fabric Eventstream item. Saves
  // first if there are unsaved edits, then POSTs to the publish route.
  const doPublish = useCallback(async () => {
    if (!fabricWsId.trim()) { setPublishErr('Fabric workspace ID is required'); return; }
    setPublishBusy(true); setPublishErr(null); setPublishHint(null); setPublishMsg(null);
    try {
      if (dirty) { await save(); }
      const r = await fetch(`/api/items/eventstream/${id}/publish?fabricWorkspaceId=${encodeURIComponent(fabricWsId.trim())}`, {
        method: 'POST',
      });
      const j = await r.json();
      if (!j.ok) {
        setPublishErr(j.error || 'publish failed');
        setPublishHint(j.hint || null);
        return;
      }
      setPublishedId(j.fabricEventstreamId || null);
      setPublishMsg(
        j.accepted
          ? 'Publish accepted by Fabric (provisioning asynchronously). The Eventstream item will appear in the Fabric workspace shortly.'
          : `Published to Fabric Eventstream${j.fabricEventstreamId ? ` (${j.fabricEventstreamId})` : ''}.`,
      );
      load();
    } catch (e: any) {
      setPublishErr(e?.message || String(e));
    } finally {
      setPublishBusy(false);
    }
  }, [fabricWsId, dirty, save, id, load]);

  // Pull the LIVE topology back from the published Fabric Eventstream item
  // (real getDefinition REST), decode it, and load it into the designer. This
  // closes the round-trip: design → publish → pull-back-and-edit.
  const [pullBusy, setPullBusy] = useState(false);
  const pullFromFabric = useCallback(async () => {
    setPullBusy(true); setSaveErr(null); setSaveMsg('Pulling live topology from Fabric…');
    try {
      const qs = fabricWsId.trim() ? `?fabricWorkspaceId=${encodeURIComponent(fabricWsId.trim())}` : '';
      const r = await fetch(`/api/items/eventstream/${id}/definition${qs}`);
      const j = await r.json();
      if (!j.ok) {
        setSaveErr(j.error || `HTTP ${r.status}`);
        setSaveMsg(j.hint ? `${j.error} — ${j.hint}` : (j.error || 'pull failed'));
        return;
      }
      setCfgText(JSON.stringify(j.config, null, 2));
      setDirty(true);
      setActiveTab('designer');
      setSaveMsg('Pulled the live Fabric topology into the designer. Save to persist locally.');
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
    } finally {
      setPullBusy(false);
    }
  }, [id, fabricWsId]);

  const canSave = !saving && dirty;

  // Push the saved destination nodes to a real ASA job as outputs. Saves first
  // if there are unsaved edits so the route reads the latest topology.
  const pushToAsa = useCallback(async () => {
    if (!asaJobName.trim()) { setAsaSyncErr('ASA job name is required'); return; }
    setAsaSyncBusy(true); setAsaSyncErr(null); setAsaSyncHint(null); setAsaSyncMsg(null);
    try {
      if (dirty) { await save(); }
      const r = await fetch(`/api/items/eventstream/${id}/asa-sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ asaJobName: asaJobName.trim() }),
      });
      const j = await r.json();
      if (!j.ok) {
        setAsaSyncErr(j.error || `HTTP ${r.status}`);
        setAsaSyncHint(j.hint || null);
        setAsaOutputs([]);
        return;
      }
      setAsaOutputs(j.outputs || []);
      const n = (j.outputs || []).length;
      const skippedNote = (j.skipped || []).length ? ` (${j.skipped.length} skipped)` : '';
      setAsaSyncMsg(
        n
          ? `Created ${n} ASA output${n === 1 ? '' : 's'} on job "${j.asaJobName}"${skippedNote}. Start the job in the Stream Analytics editor to land transformed events.`
          : `No external outputs were created${skippedNote}. Add a KQL Database, Lakehouse, or Event Hub destination.`,
      );
    } catch (e: any) {
      setAsaSyncErr(e?.message || String(e));
    } finally {
      setAsaSyncBusy(false);
    }
  }, [asaJobName, dirty, save, id]);

  // Provision the saved canvas topology onto the Azure-native backend: an
  // Event Hub (transport) + a Stream Analytics job (transform) when transforms
  // exist. Returns the ARM resource IDs of both as the receipt. No Fabric.
  const doProvision = useCallback(async () => {
    setProvisionBusy(true); setProvisionErr(null); setProvisionHint(null); setProvisionResult(null);
    try {
      // Persist the current canvas first so the route reads the latest topology.
      await save();
      const r = await fetch(`/api/items/eventstream/${id}/provision`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) {
        setProvisionErr(j.error || `HTTP ${r.status}`);
        setProvisionHint(j.hint || null);
        return;
      }
      setProvisionResult({ ehId: j.ehId, asaJobId: j.asaJobId, steps: j.steps, partial: j.partial, hint: j.hint });
      load();
    } catch (e: any) {
      setProvisionErr(e?.message || String(e));
    } finally {
      setProvisionBusy(false);
    }
  }, [save, id, load]);

  // Ribbon-driven add/transform helpers. They mutate cfgText (the on-wire
  // shape) directly so the visual designer + Monaco JSON view stay in sync.
  const ribbonAdd = useCallback(
    (kind: 'source' | 'sink' | 'transform', preset?: Record<string, any>) => {
      let cur: VisualPipelineConfig = {};
      try { cur = JSON.parse(cfgText) as VisualPipelineConfig; } catch { cur = {}; }
      const sources = Array.isArray(cur.sources) ? cur.sources : (cur.source ? [cur.source] : []);
      const sinks = Array.isArray(cur.sinks) ? cur.sinks : (cur.sink ? [cur.sink] : []);
      const transforms = cur.transforms || [];
      if (kind === 'source') {
        sources.push({ kind: 'eventhub', name: `source-${sources.length + 1}`, namespace: '', consumerGroup: '$Default' });
      } else if (kind === 'sink') {
        const sinkKind = (preset?.kind as any) || 'kusto';
        const base: Record<string, any> = { kind: sinkKind, name: `sink-${sinks.length + 1}` };
        if (sinkKind === 'kusto') { base.database = 'loomdb-default'; base.table = ''; }
        if (sinkKind === 'lakehouse') { base.container = ''; base.pathPattern = 'events/{date}/{time}'; }
        sinks.push({ ...base, ...preset });
      } else {
        transforms.push({ kind: (preset?.kind as any) || 'filter', name: `transform-${transforms.length + 1}`, expression: preset?.expression || '' });
      }
      onDesignerChange({ sources, sinks, transforms });
      setActiveTab('designer');
    },
    [cfgText, onDesignerChange],
  );

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Source', actions: [
        { label: 'Add source', onClick: () => ribbonAdd('source') },
        { label: 'Sample data', onClick: () => {
            let cur: VisualPipelineConfig = {};
            try { cur = JSON.parse(cfgText) as VisualPipelineConfig; } catch { cur = {}; }
            const sources = Array.isArray(cur.sources) ? cur.sources : (cur.source ? [cur.source] : []);
            sources.push({ kind: 'sample', name: `sample-${sources.length + 1}` });
            onDesignerChange({ sources, sinks: cur.sinks || (cur.sink ? [cur.sink] : []), transforms: cur.transforms || [] });
            setActiveTab('designer');
          } },
      ]},
      { label: 'Transform', actions: [
        { label: 'Filter', onClick: () => ribbonAdd('transform', { kind: 'filter' }) },
        { label: 'Aggregate', onClick: () => ribbonAdd('transform', { kind: 'aggregate' }) },
        { label: 'Group by', onClick: () => ribbonAdd('transform', { kind: 'group-by' }) },
      ]},
      { label: 'Destination', actions: [
        { label: 'KQL Database', onClick: () => ribbonAdd('sink', { kind: 'kusto' }) },
        { label: 'Lakehouse (ADLS)', onClick: () => ribbonAdd('sink', { kind: 'lakehouse' }) },
        { label: 'Event Hub', onClick: () => ribbonAdd('sink', { kind: 'eventhub' }) },
        { label: 'Activator', onClick: () => ribbonAdd('sink', { kind: 'reflex' }) },
      ]},
      { label: 'Publish', actions: [
        { label: saving ? 'Saving…' : 'Save', onClick: canSave ? save : undefined, disabled: !canSave },
        { label: asaSyncBusy ? 'Pushing…' : 'Push to ASA', onClick: !asaSyncBusy && asaJobName.trim() ? pushToAsa : undefined,
          disabled: asaSyncBusy || !asaJobName.trim(),
          title: asaJobName.trim() ? 'Create ASA outputs for each destination (real ARM PUT)' : 'Enter an ASA job name first' },
        { label: provisionBusy ? 'Provisioning…' : 'Provision to Azure', onClick: provisionBusy ? undefined : doProvision, disabled: provisionBusy,
          title: 'Create an Event Hub (transport) + Stream Analytics job (transform) from the canvas topology — Azure-native, no Fabric required' },
        { label: 'Publish to Fabric', onClick: () => setPublishOpen(true) },
        { label: pullBusy ? 'Pulling…' : 'Pull from Fabric', onClick: pullBusy ? undefined : pullFromFabric, disabled: pullBusy,
          title: 'Reload the live topology from the published Fabric Eventstream (getDefinition REST)' },
      ]},
    ]},
  ], [saving, canSave, save, ribbonAdd, cfgText, onDesignerChange, pullBusy, pullFromFabric, asaSyncBusy, asaJobName, pushToAsa, provisionBusy, doProvision]);

  // On /new there is no Cosmos record yet, so Save (PUT) would 404 — the
  // designer rendered but couldn't persist (the "wonky / not functional"
  // verdict). Mirror the Activator pattern: an ENABLED create surface mints a
  // Cosmos eventstream item and routes to the live editor below, where Save +
  // Publish-to-Fabric + Pull-from-Fabric all work against the real backend.
  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="New eventstream"
        intro="An Eventstream is a streaming topology: sources (Event Hubs, IoT Hub, Kafka, sample data) → operators (filter, aggregate, group-by, join) → destinations (Eventhouse/KQL, Lakehouse, Activator, custom endpoint). Create it, then design the topology on the visual canvas and Publish to Fabric to create the live Eventstream item via the Fabric definition REST API." />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        // Azure Event Hubs namespace navigator (parity wave 5): the underlying
        // Azure service that feeds Fabric Eventstream sources. Typed groups for
        // Event hubs / Consumer groups (per hub) / Schema groups / Authorization
        // rules / Networking / Geo-recovery with live counts, ＋New, filter, and
        // inline delete — all on real Microsoft.EventHub ARM REST. Picking an
        // event hub copies its name for use as an Eventstream source.
        <EventHubsNamespaceTree
          onSelectEventHub={(eh) => {
            if (typeof navigator !== 'undefined' && navigator.clipboard) {
              void navigator.clipboard.writeText(eh).catch(() => { /* clipboard may be blocked */ });
            }
          }}
        />
      }
      main={
      <div className={s.pad}>
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Design here, publish to Fabric</MessageBarTitle>
            Design the topology below — it is saved to Cosmos as you edit. <strong>Publish to Fabric</strong>
            {' '}creates (or updates) a real Fabric Eventstream item via the Fabric definition REST API
            ({' '}<code>POST /workspaces/&#123;ws&#125;/eventstreams</code>). After publishing, activate the
            stream&apos;s nodes in the Fabric portal (the per-node Activate/Deactivate toggle is portal-only —
            it is not exposed in the public Fabric REST surface).
          </MessageBarBody>
        </MessageBar>

        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand">Eventstream</Badge>
          <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
          {state?.runtimeStatus && <Badge appearance="outline">{state.runtimeStatus}</Badge>}
          {publishedId && <Badge appearance="filled" color="success">published</Badge>}
          {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
          <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={load}>Reload</Button>
          {publishedId && (
            <Button appearance="outline" onClick={pullFromFabric} disabled={pullBusy}>
              {pullBusy ? 'Pulling…' : 'Pull from Fabric'}
            </Button>
          )}
          <Button appearance="outline" onClick={doProvision} disabled={provisionBusy} style={{ marginLeft: 'auto' }}>
            {provisionBusy ? 'Provisioning…' : 'Provision to Azure'}
          </Button>
          <Button appearance="outline" onClick={() => setPublishOpen(true)}>Publish to Fabric</Button>
          <Button appearance="primary" icon={<Save20Regular />} onClick={save} disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save (Ctrl+S)'}
          </Button>
        </div>

        {/* Destination → Azure Stream Analytics outputs. Materialize each saved
            destination node (KQL DB → ADX, Lakehouse → ADLS Gen2, Event Hub,
            Activator → Event Hub) as a real ASA output via ARM. */}
        <div className={s.toolbar}>
          <Field label="ASA job" style={{ minWidth: 240 }}>
            <Input
              value={asaJobName}
              onChange={(_: unknown, d: any) => setAsaJobName(d.value)}
              placeholder="asa-loom-default-eastus2"
            />
          </Field>
          <Button
            appearance="primary"
            onClick={pushToAsa}
            disabled={asaSyncBusy || !asaJobName.trim()}
            style={{ alignSelf: 'flex-end' }}
          >
            {asaSyncBusy ? 'Pushing…' : 'Push destinations to ASA'}
          </Button>
          <Caption1 style={{ color: tokens.colorNeutralForeground3, alignSelf: 'flex-end' }}>
            Creates one ASA output per destination, then start the job in the Stream Analytics editor.
          </Caption1>
        </div>

        {asaSyncErr && (
          <MessageBar intent={asaSyncHint ? 'warning' : 'error'}>
            <MessageBarBody>
              <MessageBarTitle>{asaSyncHint ? 'Stream Analytics not configured' : 'Push to ASA failed'}</MessageBarTitle>
              {asaSyncErr}{asaSyncHint ? <><br /><Caption1>{asaSyncHint}</Caption1></> : null}
            </MessageBarBody>
          </MessageBar>
        )}
        {asaSyncMsg && !asaSyncErr && (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>Destinations pushed to ASA</MessageBarTitle>
              {asaSyncMsg}
              {asaOutputs.length > 0 && (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {asaOutputs.map((o) => (
                    <li key={o.name}><code>{o.name}</code> → {o.type}</li>
                  ))}
                </ul>
              )}
            </MessageBarBody>
          </MessageBar>
        )}

        <Dialog open={publishOpen} onOpenChange={(_: unknown, d: any) => setPublishOpen(d.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Publish to Fabric Eventstream</DialogTitle>
              <DialogContent>
                <Caption1>
                  Publishes this pipeline as a real Fabric Eventstream item. Enter the target
                  Fabric workspace GUID (app.fabric.microsoft.com &rarr; workspace &rarr; Settings).
                  The Console UAMI must be a Contributor (or higher) on that workspace and the tenant
                  must have &quot;Service principals can use Fabric APIs&quot; enabled.
                </Caption1>
                <Field label="Fabric workspace ID" required style={{ marginTop: 12 }}>
                  <Input
                    value={fabricWsId}
                    onChange={(_: unknown, d: any) => setFabricWsId(d.value)}
                    placeholder="00000000-0000-0000-0000-000000000000"
                  />
                </Field>
                {publishErr && (
                  <MessageBar intent="error" style={{ marginTop: 12 }}>
                    <MessageBarBody>
                      <MessageBarTitle>Publish failed</MessageBarTitle>
                      {publishErr}{publishHint ? <><br /><Caption1>{publishHint}</Caption1></> : null}
                    </MessageBarBody>
                  </MessageBar>
                )}
                {publishMsg && !publishErr && (
                  <MessageBar intent="success" style={{ marginTop: 12 }}>
                    <MessageBarBody>{publishMsg}</MessageBarBody>
                  </MessageBar>
                )}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setPublishOpen(false)} disabled={publishBusy}>Close</Button>
                <Button appearance="primary" onClick={doPublish} disabled={publishBusy || !fabricWsId.trim()}>
                  {publishBusy ? 'Publishing…' : 'Publish'}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>

        {saveMsg && !saveErr && !parseErr && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{saveMsg}</Caption1>}
        {state && !state.ok && <MessageBar intent="error"><MessageBarBody>{state.error}</MessageBarBody></MessageBar>}
        {parseErr && (
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>JSON parse error</MessageBarTitle>
              {parseErr}
            </MessageBarBody>
          </MessageBar>
        )}
        {saveErr && !parseErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{saveErr}</MessageBarBody></MessageBar>}

        {provisionErr && (
          <MessageBar intent={provisionHint ? 'warning' : 'error'}>
            <MessageBarBody>
              <MessageBarTitle>Provision to Azure failed</MessageBarTitle>
              {provisionErr}
              {provisionHint && <><br /><Caption1>{provisionHint}</Caption1></>}
            </MessageBarBody>
          </MessageBar>
        )}
        {provisionResult && (
          <MessageBar intent={provisionResult.partial ? 'warning' : 'success'}>
            <MessageBarBody>
              <MessageBarTitle>{provisionResult.partial ? 'Provisioned (partial)' : 'Provisioned to Azure'}</MessageBarTitle>
              {provisionResult.ehId && <>Event Hub: <code>{provisionResult.ehId}</code><br /></>}
              {provisionResult.asaJobId
                ? <>Stream Analytics job: <code>{provisionResult.asaJobId}</code><br /></>
                : <Caption1>No Stream Analytics job (no transforms, or transform not available in this cloud).<br /></Caption1>}
              {provisionResult.hint && <Caption1>{provisionResult.hint}</Caption1>}
            </MessageBarBody>
          </MessageBar>
        )}

        <TabList selectedValue={activeTab} onTabSelect={(_: unknown, d: any) => setActiveTab((d.value as 'designer' | 'json') || 'designer')}>
          <Tab value="designer">Visual designer</Tab>
          <Tab value="json">JSON</Tab>
        </TabList>

        {activeTab === 'designer' && (
          <EventstreamVisualDesigner config={parsedVisual} onChange={onDesignerChange} itemId={id} />
        )}

        {activeTab === 'json' && (
          <>
            <Caption1>Edit the pipeline definition as JSON. Schema: <code>{`{ source, transforms[], sink }`}</code>.</Caption1>
            <MonacoTextarea
              value={cfgText}
              onChange={(v) => { setCfgText(v); setDirty(true); setParseErr(null); setSaveErr(null); }}
              language="json"
              height={360}
              minHeight={300}
              ariaLabel="Eventstream JSON config"
            />
          </>
        )}
      </div>
    } />
  );
}

// ============================================================
// Workspace pickers — two flavors, intentionally NOT interchangeable.
//
// 1. useWorkspaces() → Loom workspaces (Cosmos-backed catalog used by
//    Activator, Eventstream, KQL, Lakehouse, etc.). IDs are Loom UUIDs.
//
// 2. usePowerBiWorkspaces() → Power BI / Fabric groups (returned by the
//    Power BI REST API via the Console UAMI). IDs are Power BI groupIds.
//
// Power BI editors (Report, Paginated Report, Dashboard, Semantic Model,
// Scorecard, Dataflow) MUST use (2) because the embed-token / list / detail
// REST calls expect a Power BI groupId. Passing a Loom UUID returns 404
// PowerBIEntityNotFound. Keeping the two hooks separate makes the
// intentional distinction obvious at call sites.
// ============================================================
interface PbiWorkspaceLite { id: string; name: string; description?: string; }

function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<PbiWorkspaceLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setHint(null);
    try {
      const r = await fetch('/api/loom/workspaces');
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed to list workspaces'); setHint(j.hint || null); setWorkspaces([]); }
      else { setWorkspaces(j.workspaces || []); }
    } catch (e: any) {
      setError(e?.message || String(e));
      setWorkspaces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { workspaces, error, hint, loading, reload: load };
}

/**
 * usePowerBiWorkspaces — list real Power BI groups (NOT Loom workspaces).
 *
 * Power BI's list/detail/embed-token REST APIs key on a `workspaceId` that
 * is a Power BI groupId. Passing a Loom Cosmos UUID to those endpoints
 * returns 404 PowerBIEntityNotFound. This hook is the dedicated source for
 * the Report / Paginated Report / Dashboard / Semantic Model / Scorecard /
 * Dataflow editors.
 */
function usePowerBiWorkspaces() {
  const [workspaces, setWorkspaces] = useState<PbiWorkspaceLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(null); setHint(null);
    try {
      const r = await fetch('/api/powerbi/workspaces');
      const j = await r.json();
      if (!j.ok) {
        setError(j.error || 'failed to list Power BI workspaces');
        setHint(j.hint || null);
        setWorkspaces([]);
      } else {
        // Power BI returns name + capacity SKU; surface the capacity in a
        // separate description field so the picker can show it as a hint
        // without polluting the displayed name.
        setWorkspaces(
          (j.workspaces || []).map((w: any) => ({
            id: w.id,
            name: w.name || w.displayName || w.id,
            description: w.capacityType ? `${w.capacityType}${w.isOnDedicatedCapacity ? ' · dedicated' : ''}` : undefined,
          })),
        );
      }
    } catch (e: any) {
      setError(e?.message || String(e));
      setWorkspaces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { workspaces, error, hint, loading, reload: load };
}

function WorkspacePicker({
  value, onChange, error, hint, loading, workspaces,
}: {
  value: string; onChange: (id: string) => void;
  error: string | null; hint: string | null; loading: boolean;
  workspaces: PbiWorkspaceLite[] | null;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 280 }}>
      <Caption1>Workspace</Caption1>
      <Select value={value} onChange={(_: unknown, d: any) => onChange(d.value)} disabled={loading || (workspaces?.length ?? 0) === 0}>
        {!value && <option value="">{loading ? 'Loading workspaces…' : 'Select a workspace'}</option>}
        {(workspaces || []).map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </Select>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Workspaces not reachable</MessageBarTitle>
            {error}{hint ? <><br /><Caption1>{hint}</Caption1></> : null}
          </MessageBarBody>
        </MessageBar>
      )}
      {!loading && !error && (workspaces?.length ?? 0) === 0 && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>No Power BI workspaces</MessageBarTitle>
            The Console service principal can&apos;t see any Power BI workspaces. Create one (or get added to one) in Power BI, then Refresh.
            <br />
            <Button appearance="primary" size="small" style={{ marginTop: 6 }}
              onClick={() => { try { window.open('https://app.powerbi.com/groups/me/list', '_blank', 'noreferrer'); } catch { /* popup blocked */ } }}>
              Open Power BI
            </Button>
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

// ============================================================
// Power BI / Fabric editor shells — v2.1 live REST.
//
// IMPORTANT: All six editors below require the Console UAMI's service
// principal to be (a) registered in the Power BI tenant and (b) added to
// each target workspace. If either is missing, the editor surfaces the
// underlying 401/403 verbatim via MessageBar so the operator knows
// exactly what to fix. No mock data is shown when the call fails.
// ============================================================

// ----- Activator -----
// Ribbon built inside the editor via useMemo so New rule binds to the
// existing setRuleOpen handler; the rest stay disabled with reasons.

interface ActivatorLite {
  id: string; displayName: string; description?: string;
}
interface RuleLite {
  id: string; name: string;
  objectName?: string; propertyName?: string;
  condition?: { operator?: string; value?: unknown };
  action?: { kind?: string; config?: Record<string, unknown> };
  state?: string; lastTriggered?: string;
  // Azure Monitor (default) fields — MonitorRuleRecord shape.
  query?: string;
  severity?: number;
  evaluationFrequency?: string;
  windowSize?: string;
  azureRuleName?: string;
  backend?: 'azure-monitor' | 'fabric';
  actionGroupId?: string;
  actionGroupReceivers?: { emails: number; sms: number; webhooks: number; logicApps: number };
}

export function ActivatorEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const ws = useWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [activators, setActivators] = useState<ActivatorLite[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [rules, setRules] = useState<RuleLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [rulesErr, setRulesErr] = useState<string | null>(null);

  // create
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // new rule
  const [ruleOpen, setRuleOpen] = useState(false);
  const [ruleName, setRuleName] = useState('');
  // Rule wizard (no JSON): condition (property/operator/value) + action (kind + target/message).
  const [condProperty, setCondProperty] = useState('');
  const [condOperator, setCondOperator] = useState('GreaterThan');
  const [condValue, setCondValue] = useState('20');
  const [actKind, setActKind] = useState<'TeamsMessage' | 'Email' | 'Webhook' | 'SMS' | 'LogicApp' | 'AdfPipelineRun' | 'NotebookRun' | 'PowerAutomateFlow'>('TeamsMessage');
  const [actTarget, setActTarget] = useState('');
  const [actMessage, setActMessage] = useState('Loom alert: {{eventValue}}');
  // SMS + Logic App receiver fields (Azure Monitor action-group receivers).
  const [actCountryCode, setActCountryCode] = useState('1');
  const [actPhone, setActPhone] = useState('');
  const [actLogicAppResourceId, setActLogicAppResourceId] = useState('');
  const [actLogicAppCallbackUrl, setActLogicAppCallbackUrl] = useState('');
  const [actLogicAppTrigger, setActLogicAppTrigger] = useState('manual');
  const [fetchingCallback, setFetchingCallback] = useState(false);
  const [callbackErr, setCallbackErr] = useState<string | null>(null);
  // Pick-existing action group flow.
  const [agList, setAgList] = useState<{ id: string; name: string; shortName: string; emailCount: number; smsCount: number; webhookCount: number; logicAppCount: number }[]>([]);
  const [useExistingAg, setUseExistingAg] = useState(false);
  const [existingAgId, setExistingAgId] = useState('');
  const [agBusy, setAgBusy] = useState<string | null>(null);
  const [agMsg, setAgMsg] = useState<string | null>(null);
  const [ruleBusy, setRuleBusy] = useState(false);
  const [ruleErr, setRuleErr] = useState<string | null>(null);
  // ── Azure Monitor scheduled-query wizard (DEFAULT backend) ──
  // Data source: a raw KQL query (Log Analytics) OR an Event Hub whose data is
  // ingested into LA (the alert query then targets the hub's table).
  const [sourceType, setSourceType] = useState<'kql' | 'eventhub'>('kql');
  const [kqlQuery, setKqlQuery] = useState('');
  const [sourceTable, setSourceTable] = useState('');
  const [selectedHub, setSelectedHub] = useState('');
  // Evaluation cadence (ISO-8601).
  const [evalFreq, setEvalFreq] = useState('PT5M');
  const [winSize, setWinSize] = useState('PT5M');
  // Severity 0 (critical) – 4 (verbose); Warning is the portal default.
  const [severity, setSeverity] = useState(2);
  // Trigger-now result for inline feedback (rows + fired).
  const [triggerResult, setTriggerResult] = useState<{ ruleId: string; fired: boolean; count: number } | null>(null);

  const loadList = useCallback(async (wsId: string) => {
    setLoading(true); setListErr(null);
    try {
      const r = await fetch(`/api/items/activator?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setActivators([]); setListErr(j.error); return; }
      setActivators(j.activators || []);
      // Use functional setSelectedId so we don't have to depend on
      // selectedId in this callback — keeps the workspace-change effect
      // from re-firing every time the user clicks a row.
      setSelectedId((prev) => prev || (j.activators?.[0]?.id ?? ''));
    } catch (e: any) {
      setActivators([]); setListErr(e?.message || String(e));
    } finally { setLoading(false); }
  }, []);

  const loadRules = useCallback(async (wsId: string, actId: string) => {
    setRulesErr(null);
    try {
      const r = await fetch(`/api/items/activator/${encodeURIComponent(actId)}/rules?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setRules([]); setRulesErr(j.error); return; }
      setRules(j.rules || []);
    } catch (e: any) {
      setRules([]); setRulesErr(e?.message || String(e));
    }
  }, []);

  // Auto-pick the first workspace once loaded so the editor isn't blocked on a
  // manual click for the common single-workspace deployments (matches the
  // Eventstream editor). After NewItemCreateGate routes here post-create, this
  // makes the Start/Stop/New rule/action-template ribbon reachable immediately.
  useEffect(() => {
    if (!workspaceId && ws.workspaces && ws.workspaces.length > 0) {
      setWorkspaceId(ws.workspaces[0].id);
    }
  }, [workspaceId, ws.workspaces]);

  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && selectedId) loadRules(workspaceId, selectedId); }, [workspaceId, selectedId, loadRules]);

  const createReflex = useCallback(async () => {
    if (!createName.trim() || !workspaceId) return;
    setCreateBusy(true); setCreateErr(null);
    try {
      const r = await fetch(`/api/items/activator?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName: createName.trim(), description: createDesc.trim() || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setCreateErr(j.error || 'create failed'); }
      else {
        setCreateOpen(false); setCreateName(''); setCreateDesc('');
        loadList(workspaceId);
      }
    } finally { setCreateBusy(false); }
  }, [createName, createDesc, workspaceId, loadList]);

  const addRule = useCallback(async () => {
    if (!ruleName.trim() || !workspaceId || !selectedId) return;
    setRuleBusy(true); setRuleErr(null);
    // Build the structured condition + action from the wizard fields (no JSON).
    const condition = {
      ...(condProperty.trim() ? { property: condProperty.trim() } : {}),
      operator: condOperator,
      value: condValue.trim() === '' ? null : (Number.isNaN(Number(condValue)) ? condValue.trim() : Number(condValue)),
    };
    const cfgByKind: Record<string, Record<string, string>> = {
      TeamsMessage: { webhookUrl: actTarget, message: actMessage },
      Email: { to: actTarget, subject: actMessage },
      Webhook: { url: actTarget },
      SMS: { countryCode: actCountryCode, phoneNumber: actPhone },
      LogicApp: { logicAppResourceId: actLogicAppResourceId, callbackUrl: actLogicAppCallbackUrl },
      AdfPipelineRun: { pipeline: actTarget },
      NotebookRun: { notebookId: actTarget },
      PowerAutomateFlow: { triggerUrl: actTarget },
    };
    const action = { kind: actKind, config: cfgByKind[actKind] || {} };
    // The data-source picker decides what the Azure Monitor scheduled-query
    // rule evaluates: a raw KQL query wins (verbatim), otherwise the condition
    // builder composes KQL against the chosen source table (Event Hub-derived
    // when the Event Hub source is selected).
    const body: Record<string, unknown> = {
      name: ruleName.trim(),
      condition,
      action,
      severity,
      evaluationFrequency: evalFreq,
      windowSize: winSize,
      ...(useExistingAg && existingAgId ? { existingActionGroupId: existingAgId } : {}),
    };
    if (sourceType === 'kql' && kqlQuery.trim()) {
      body.query = kqlQuery.trim();
      if (sourceTable.trim()) body.sourceTable = sourceTable.trim();
    } else if (sourceType === 'eventhub' && selectedHub) {
      body.sourceTable = sourceTable.trim() || `${selectedHub}_CL`;
    } else if (sourceTable.trim()) {
      body.sourceTable = sourceTable.trim();
    }
    try {
      const r = await fetch(`/api/items/activator/${encodeURIComponent(selectedId)}/rules?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) { setRuleErr(j.error || j.gate?.remediation || 'add rule failed'); }
      else { setRuleOpen(false); setRuleName(''); setKqlQuery(''); loadRules(workspaceId, selectedId); }
    } finally { setRuleBusy(false); }
  }, [ruleName, condProperty, condOperator, condValue, actKind, actTarget, actMessage, actCountryCode, actPhone, actLogicAppResourceId, actLogicAppCallbackUrl, sourceType, kqlQuery, sourceTable, selectedHub, severity, evalFreq, winSize, useExistingAg, existingAgId, workspaceId, selectedId, loadRules]);

  const triggerNow = useCallback(async (ruleId: string) => {
    if (!workspaceId || !selectedId) return;
    setTriggerResult(null);
    const r = await fetch(`/api/items/activator/${encodeURIComponent(selectedId)}/rules?workspaceId=${encodeURIComponent(workspaceId)}&trigger=${encodeURIComponent(ruleId)}`, { method: 'POST' });
    const j = await r.json();
    if (!j.ok) { setRulesErr(j.error || j.gate?.remediation || 'trigger failed'); return; }
    // Azure-native trigger = run the rule's KQL now; report rows + whether it fired.
    setTriggerResult({ ruleId, fired: !!j.fired, count: typeof j.count === 'number' ? j.count : (Array.isArray(j.rows) ? j.rows.length : 0) });
    loadRules(workspaceId, selectedId);
  }, [workspaceId, selectedId, loadRules]);

  const canNewRule = !!selectedId && !!workspaceId;

  // Load existing action groups for the pick-existing flow (non-fatal on error
  // — the create-new path still works without the list).
  const loadActionGroups = useCallback(async () => {
    try {
      const r = await fetch('/api/monitor/action-groups');
      const j = await r.json();
      if (j.ok) setAgList(j.actionGroups || []);
    } catch { /* non-fatal: pick-existing simply has no options */ }
  }, []);
  useEffect(() => { if (workspaceId) loadActionGroups(); }, [workspaceId, loadActionGroups]);

  // Resolve a Logic App trigger's callback URL from ARM (so the receiver can be
  // invoked when the alert fires) and populate the field.
  const fetchCallbackUrl = useCallback(async () => {
    if (!actLogicAppResourceId.trim()) { setCallbackErr('Enter the Logic App resource id first.'); return; }
    setFetchingCallback(true); setCallbackErr(null);
    try {
      const r = await fetch('/api/monitor/logic-app-callback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowResourceId: actLogicAppResourceId.trim(), triggerName: actLogicAppTrigger.trim() || undefined }),
      });
      const j = await r.json();
      if (!j.ok) setCallbackErr(j.gate?.remediation || j.error || 'failed to resolve callback URL');
      else setActLogicAppCallbackUrl(j.callbackUrl || '');
    } catch (e: any) {
      setCallbackErr(e?.message || String(e));
    } finally { setFetchingCallback(false); }
  }, [actLogicAppResourceId, actLogicAppTrigger]);

  // Fire a REAL test notification through an action group's receivers (the
  // webhook receiver logs the Common Alert Schema payload — the acceptance test).
  const testNotification = useCallback(async (actionGroupId: string) => {
    setAgBusy(actionGroupId); setAgMsg(null); setRulesErr(null);
    try {
      const r = await fetch('/api/monitor/action-groups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _action: 'test', actionGroupId }),
      });
      const j = await r.json();
      if (!j.ok) setAgMsg(`Test failed: ${j.gate?.remediation || j.error || 'unknown'}`);
      else {
        const rc = j.result?.receivers || {};
        setAgMsg(`Test notification sent — ${rc.emails || 0} email · ${rc.sms || 0} SMS · ${rc.webhooks || 0} webhook · ${rc.logicApps || 0} Logic App receiver(s).`);
      }
    } catch (e: any) {
      setAgMsg(`Test failed: ${e?.message || String(e)}`);
    } finally { setAgBusy(null); }
  }, []);

  // Start/Stop reflex — calls the new /start /stop routes which PATCH every
  // trigger on the reflex to Active/Stopped via Fabric REST.
  const [reflexBusy, setReflexBusy] = useState<'start' | 'stop' | null>(null);
  const [reflexMsg, setReflexMsg] = useState<string | null>(null);
  const startStop = useCallback(async (kind: 'start' | 'stop') => {
    if (!workspaceId || !selectedId) return;
    setReflexBusy(kind); setReflexMsg(null);
    try {
      const r = await fetch(`/api/items/activator/${encodeURIComponent(selectedId)}/${kind}?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) setReflexMsg(`${kind} failed: ${j.error || 'unknown'}`);
      else setReflexMsg(`${kind === 'start' ? 'Started' : 'Stopped'} — ${j.updated} trigger(s) updated.`);
      await loadRules(workspaceId, selectedId);
    } catch (e: any) {
      setReflexMsg(`${kind} failed: ${e?.message || String(e)}`);
    } finally {
      setReflexBusy(null);
    }
  }, [workspaceId, selectedId, loadRules]);

  // Action template — pre-select the action kind + a sensible target/message in
  // the wizard (no JSON). The user refines via the dropdowns/inputs.
  const openTemplate = useCallback((kind: 'Email' | 'SMS' | 'Teams' | 'Webhook' | 'LogicApp' | 'Pipeline' | 'Notebook' | 'PowerAutomate') => {
    const map = {
      Email: { k: 'Email' as const, t: 'alerts@example.com', m: 'Loom alert' },
      SMS: { k: 'SMS' as const, t: '', m: '' },
      Teams: { k: 'TeamsMessage' as const, t: 'https://outlook.office.com/webhook/...', m: 'Loom alert: {{eventValue}}' },
      Webhook: { k: 'Webhook' as const, t: 'https://your-endpoint.example.com/hook', m: '' },
      LogicApp: { k: 'LogicApp' as const, t: '', m: '' },
      Pipeline: { k: 'AdfPipelineRun' as const, t: 'pl_alert_handler', m: '' },
      Notebook: { k: 'NotebookRun' as const, t: '', m: '' },
      PowerAutomate: { k: 'PowerAutomateFlow' as const, t: 'https://prod-xx.logic.azure.com/workflows/.../triggers/...', m: '' },
    };
    const sel = map[kind];
    setRuleName(`alert-${kind.toLowerCase()}-${Date.now().toString(36)}`);
    setActKind(sel.k); setActTarget(sel.t); setActMessage(sel.m);
    setRuleOpen(true);
  }, []);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Rules', actions: [
        { label: 'New rule', onClick: canNewRule ? () => setRuleOpen(true) : undefined, disabled: !canNewRule, title: !canNewRule ? 'select a workspace and reflex first' : undefined },
        { label: reflexBusy === 'start' ? 'Starting…' : 'Start', onClick: canNewRule && !reflexBusy ? () => startStop('start') : undefined, disabled: !canNewRule || !!reflexBusy },
        { label: reflexBusy === 'stop' ? 'Stopping…' : 'Stop', onClick: canNewRule && !reflexBusy ? () => startStop('stop') : undefined, disabled: !canNewRule || !!reflexBusy },
      ]},
      { label: 'Actions', actions: [
        { label: 'Email', onClick: canNewRule ? () => openTemplate('Email') : undefined, disabled: !canNewRule },
        { label: 'SMS', onClick: canNewRule ? () => openTemplate('SMS') : undefined, disabled: !canNewRule },
        { label: 'Teams', onClick: canNewRule ? () => openTemplate('Teams') : undefined, disabled: !canNewRule },
        { label: 'Webhook', onClick: canNewRule ? () => openTemplate('Webhook') : undefined, disabled: !canNewRule },
        { label: 'Logic App', onClick: canNewRule ? () => openTemplate('LogicApp') : undefined, disabled: !canNewRule },
        { label: 'Run pipeline', onClick: canNewRule ? () => openTemplate('Pipeline') : undefined, disabled: !canNewRule },
        { label: 'Run notebook', onClick: canNewRule ? () => openTemplate('Notebook') : undefined, disabled: !canNewRule },
        { label: 'Power Automate', onClick: canNewRule ? () => openTemplate('PowerAutomate') : undefined, disabled: !canNewRule },
      ]},
    ]},
  ], [canNewRule, reflexBusy, startStop, openTemplate]);

  // On /new there is no reflex selected yet, so every rule/action button is
  // gated. Mirror the PR #438 NewItemGate pattern: show an ENABLED create
  // surface that mints a Cosmos activator item and routes to the live editor
  // below, where the real Fabric-backed Start/Stop/rule/action handlers work.
  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="New reflex"
        intro="An Activator (Reflex) watches a KQL query or an Event Hub and runs actions — Email, Teams, a pipeline, a notebook, or a Power Automate flow — when a rule's condition fires. Create it, then add rules. The default backend is Azure Monitor: each rule becomes a real Microsoft.Insights scheduled-query alert rule — no Microsoft Fabric required." />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: 8 }}>Reflexes</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {workspaceId && loading && <Spinner size="tiny" label="Loading…" />}
          {activators && activators.length === 0 && !loading && <Caption1>No reflexes in this workspace.</Caption1>}
          <Tree aria-label="Reflex list">
            {(activators || []).map((a) => (
              <TreeItem key={a.id} itemType="leaf" value={a.id} onClick={() => setSelectedId(a.id)}>
                <TreeItemLayout>{selectedId === a.id ? <strong>{a.displayName}</strong> : a.displayName}</TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Activator (Reflex)</Badge>
            <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh</Button>
            <Dialog open={createOpen} onOpenChange={(_: unknown, d: any) => setCreateOpen(d.open)}>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="primary" icon={<Add20Regular />} disabled={!workspaceId} style={{ marginLeft: 'auto' }}>New reflex</Button>
              </DialogTrigger>
              <DialogSurface>
                <DialogBody>
                  <DialogTitle>Create Activator (reflex)</DialogTitle>
                  <DialogContent>
                    <Input placeholder="displayName" value={createName} onChange={(_: unknown, d: any) => setCreateName(d.value)} style={{ width: '100%' }} />
                    <Input placeholder="description (optional)" value={createDesc} onChange={(_: unknown, d: any) => setCreateDesc(d.value)} style={{ width: '100%', marginTop: 8 }} />
                    {createErr && <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody>{createErr}</MessageBarBody></MessageBar>}
                  </DialogContent>
                  <DialogActions>
                    <Button appearance="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                    <Button appearance="primary" disabled={createBusy || !createName.trim()} onClick={createReflex}>{createBusy ? 'Creating…' : 'Create'}</Button>
                  </DialogActions>
                </DialogBody>
              </DialogSurface>
            </Dialog>
          </div>
          {listErr && <MessageBar intent="error"><MessageBarBody>{listErr}</MessageBarBody></MessageBar>}
          {reflexMsg && <MessageBar intent={reflexMsg.includes('failed') ? 'error' : 'success'}><MessageBarBody>{reflexMsg}</MessageBarBody></MessageBar>}

          {selectedId && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Subtitle2>Rules</Subtitle2>
                <Dialog open={ruleOpen} onOpenChange={(_: unknown, d: any) => setRuleOpen(d.open)}>
                  <DialogTrigger disableButtonEnhancement>
                    <Button size="small" appearance="outline" icon={<Add20Regular />}>New rule</Button>
                  </DialogTrigger>
                  <DialogSurface style={{ maxWidth: 760 }}>
                    <DialogBody>
                      <DialogTitle>Add rule</DialogTitle>
                      <DialogContent>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                          <Field label="Rule name" required>
                            <Input placeholder="e.g. Latency SLA breach" value={ruleName} onChange={(_: unknown, d: any) => setRuleName(d.value)} />
                          </Field>

                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>DATA SOURCE</Caption1>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <Field label="Source type" style={{ width: 240 }}>
                              <Select value={sourceType} onChange={(_: unknown, d: any) => setSourceType(d.value as 'kql' | 'eventhub')}>
                                <option value="kql">KQL query (Log Analytics)</option>
                                <option value="eventhub">Event Hub</option>
                              </Select>
                            </Field>
                            <Field label="Source table (KQL table the condition targets)" style={{ flex: 1 }}>
                              <Input placeholder="e.g. AppEvents_CL" value={sourceTable} onChange={(_: unknown, d: any) => setSourceTable(d.value)} />
                            </Field>
                          </div>
                          {sourceType === 'kql' && (
                            <Field label="KQL query" hint="Verbatim query — alert fires when it returns ≥ 1 row. Leave empty to use the condition builder below.">
                              <MonacoTextarea value={kqlQuery} onChange={setKqlQuery} language="kql" className={s.monaco} ariaLabel="Alert KQL query" />
                            </Field>
                          )}
                          {sourceType === 'eventhub' && (
                            <>
                              <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4, maxHeight: 220, overflow: 'auto' }}>
                                <EventHubsNamespaceTree onSelectEventHub={(hub) => { setSelectedHub(hub); setSourceTable(`${hub}_CL`); }} />
                              </div>
                              {selectedHub && (
                                <>
                                  <Caption1>Event hub selected: <strong>{selectedHub}</strong> → source table <code>{sourceTable || `${selectedHub}_CL`}</code></Caption1>
                                  <MessageBar intent="warning">
                                    <MessageBarBody>
                                      Data from this Event Hub must flow into Log Analytics (via a data collection rule or an ADX data connection) before this alert can fire. The scheduled-query rule targets table <code>{sourceTable || `${selectedHub}_CL`}</code>.
                                    </MessageBarBody>
                                  </MessageBar>
                                </>
                              )}
                            </>
                          )}

                          {!(sourceType === 'kql' && kqlQuery.trim()) && (
                            <>
                              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>WHEN — condition</Caption1>
                              <div style={{ display: 'flex', gap: 8 }}>
                                <Field label="Property" style={{ flex: 1 }}>
                                  <Input placeholder="e.g. latency_ms" value={condProperty} onChange={(_: unknown, d: any) => setCondProperty(d.value)} />
                                </Field>
                                <Field label="Operator" style={{ width: 180 }}>
                                  <Select value={condOperator} onChange={(_: unknown, d: any) => setCondOperator(d.value)}>
                                    {['GreaterThan', 'GreaterThanOrEqual', 'LessThan', 'LessThanOrEqual', 'Equals', 'NotEquals', 'BecomesTrue', 'ChangesTo'].map((o) => <option key={o} value={o}>{o}</option>)}
                                  </Select>
                                </Field>
                                <Field label="Value" style={{ width: 120 }}>
                                  <Input placeholder="20" value={condValue} onChange={(_: unknown, d: any) => setCondValue(d.value)} />
                                </Field>
                              </div>
                            </>
                          )}

                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>THEN — action</Caption1>
                          <Checkbox
                            label="Attach an existing action group (skip building a new one)"
                            checked={useExistingAg}
                            disabled={agList.length === 0}
                            onChange={(_: unknown, d: any) => setUseExistingAg(!!d.checked)}
                          />
                          {useExistingAg ? (
                            <Field label="Action group" hint="Pick a Microsoft.Insights/actionGroups resource in the Loom alert resource group.">
                              <Select value={existingAgId} onChange={(_: unknown, d: any) => setExistingAgId(d.value)}>
                                <option value="">— select an action group —</option>
                                {agList.map((ag) => (
                                  <option key={ag.id} value={ag.id}>
                                    {ag.name} ({ag.emailCount}✉ {ag.smsCount}☎ {ag.webhookCount}🔗 {ag.logicAppCount}⚙)
                                  </option>
                                ))}
                              </Select>
                            </Field>
                          ) : (
                          <>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <Field label="Do" style={{ width: 200 }}>
                              <Select value={actKind} onChange={(_: unknown, d: any) => setActKind(d.value)}>
                                <option value="TeamsMessage">Post to Teams</option>
                                <option value="Email">Send email</option>
                                <option value="SMS">Send SMS</option>
                                <option value="Webhook">Call webhook</option>
                                <option value="LogicApp">Trigger Logic App</option>
                                <option value="AdfPipelineRun">Run a pipeline</option>
                                <option value="NotebookRun">Run a notebook</option>
                                <option value="PowerAutomateFlow">Trigger Power Automate</option>
                              </Select>
                            </Field>
                            {(actKind !== 'SMS' && actKind !== 'LogicApp') && (
                              <Field label={
                                actKind === 'TeamsMessage' ? 'Teams webhook URL' :
                                actKind === 'Email' ? 'To address' :
                                actKind === 'Webhook' ? 'Webhook URL' :
                                actKind === 'AdfPipelineRun' ? 'Pipeline name' :
                                actKind === 'NotebookRun' ? 'Notebook id' : 'Flow trigger URL'
                              } style={{ flex: 1 }}>
                                <Input value={actTarget} onChange={(_: unknown, d: any) => setActTarget(d.value)} />
                              </Field>
                            )}
                          </div>
                          {(actKind === 'TeamsMessage' || actKind === 'Email') && (
                            <Field label={actKind === 'Email' ? 'Subject' : 'Message'}>
                              <Input value={actMessage} onChange={(_: unknown, d: any) => setActMessage(d.value)} />
                            </Field>
                          )}
                          {actKind === 'SMS' && (
                            <div style={{ display: 'flex', gap: 8 }}>
                              <Field label="Country code" style={{ width: 140 }} hint="e.g. 1 for US">
                                <Input value={actCountryCode} onChange={(_: unknown, d: any) => setActCountryCode(d.value)} />
                              </Field>
                              <Field label="Phone number" style={{ flex: 1 }}>
                                <Input placeholder="5551234567" value={actPhone} onChange={(_: unknown, d: any) => setActPhone(d.value)} />
                              </Field>
                            </div>
                          )}
                          {actKind === 'LogicApp' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              <Field label="Logic App resource id" hint="Microsoft.Logic/workflows resource id (Consumption workflow with an HTTP trigger).">
                                <Input placeholder="/subscriptions/.../providers/Microsoft.Logic/workflows/wf-alert" value={actLogicAppResourceId} onChange={(_: unknown, d: any) => setActLogicAppResourceId(d.value)} />
                              </Field>
                              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                                <Field label="Trigger name" style={{ width: 160 }}>
                                  <Input value={actLogicAppTrigger} onChange={(_: unknown, d: any) => setActLogicAppTrigger(d.value)} />
                                </Field>
                                <Button appearance="secondary" disabled={fetchingCallback || !actLogicAppResourceId.trim()} onClick={fetchCallbackUrl}>
                                  {fetchingCallback ? 'Resolving…' : 'Fetch callback URL from ARM'}
                                </Button>
                              </div>
                              <Field label="Trigger callback URL" hint="Auto-filled by 'Fetch callback URL', or paste a listCallbackUrl SAS URL.">
                                <Input value={actLogicAppCallbackUrl} onChange={(_: unknown, d: any) => setActLogicAppCallbackUrl(d.value)} />
                              </Field>
                              {callbackErr && <MessageBar intent="warning"><MessageBarBody>{callbackErr}</MessageBarBody></MessageBar>}
                            </div>
                          )}
                          </>
                          )}

                          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>EVALUATION</Caption1>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <Field label="Evaluation frequency" style={{ width: 200 }}>
                              <Select value={evalFreq} onChange={(_: unknown, d: any) => setEvalFreq(d.value)}>
                                {['PT1M', 'PT5M', 'PT15M', 'PT30M', 'PT1H', 'PT6H'].map((f) => <option key={f} value={f}>{f}</option>)}
                              </Select>
                            </Field>
                            <Field label="Window size (≥ frequency)" style={{ width: 200 }}>
                              <Select value={winSize} onChange={(_: unknown, d: any) => setWinSize(d.value)}>
                                {['PT5M', 'PT10M', 'PT15M', 'PT30M', 'PT1H', 'P1D'].map((w) => <option key={w} value={w}>{w}</option>)}
                              </Select>
                            </Field>
                            <Field label="Severity" style={{ width: 200 }}>
                              <Select value={String(severity)} onChange={(_: unknown, d: any) => setSeverity(Number(d.value))}>
                                <option value="0">0 — Critical</option>
                                <option value="1">1 — Error</option>
                                <option value="2">2 — Warning (default)</option>
                                <option value="3">3 — Informational</option>
                                <option value="4">4 — Verbose</option>
                              </Select>
                            </Field>
                          </div>

                          <Caption1 style={{ fontFamily: 'Consolas, monospace', color: tokens.colorBrandForeground1 }}>
                            {sourceType === 'kql' && kqlQuery.trim()
                              ? `KQL: ${kqlQuery.trim().slice(0, 80)}${kqlQuery.trim().length > 80 ? '…' : ''} → ${useExistingAg ? 'existing action group' : actKind} · sev${severity} · eval ${evalFreq} / win ${winSize}`
                              : `${condProperty || (sourceTable || '<table>')} ${condOperator} ${condValue || '<value>'} → ${useExistingAg ? 'existing action group' : actKind} · sev${severity} · eval ${evalFreq} / win ${winSize}`}
                          </Caption1>
                          {ruleErr && <MessageBar intent="error"><MessageBarBody>{ruleErr}</MessageBarBody></MessageBar>}
                        </div>
                      </DialogContent>
                      <DialogActions>
                        <Button appearance="secondary" onClick={() => setRuleOpen(false)}>Cancel</Button>
                        <Button appearance="primary" disabled={ruleBusy || !ruleName.trim()} onClick={addRule}>{ruleBusy ? 'Adding…' : 'Add'}</Button>
                      </DialogActions>
                    </DialogBody>
                  </DialogSurface>
                </Dialog>
              </div>
              {rulesErr && <MessageBar intent="error"><MessageBarBody>{rulesErr}</MessageBarBody></MessageBar>}
              {triggerResult && (
                <MessageBar intent={triggerResult.fired ? 'success' : 'info'}>
                  <MessageBarBody>
                    Trigger '{triggerResult.ruleId}': {triggerResult.count} row(s) — {triggerResult.fired ? 'FIRED (the alert condition was met)' : 'no rows, would not fire'}.
                  </MessageBarBody>
                </MessageBar>
              )}
              {rules.length === 0 ? (
                <Caption1>No rules on this reflex yet. Click “New rule” to create an Azure Monitor scheduled-query alert.</Caption1>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Rules" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Name</TableHeaderCell>
                      <TableHeaderCell>Backend</TableHeaderCell>
                      <TableHeaderCell>Query / Condition</TableHeaderCell>
                      <TableHeaderCell>Sev</TableHeaderCell>
                      <TableHeaderCell>Freq / Window</TableHeaderCell>
                      <TableHeaderCell>Action</TableHeaderCell>
                      <TableHeaderCell>Action group</TableHeaderCell>
                      <TableHeaderCell>State</TableHeaderCell>
                      <TableHeaderCell></TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {rules.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>{r.name}</TableCell>
                          <TableCell><Badge size="small" appearance="tint" color={r.backend === 'fabric' ? 'warning' : 'brand'}>{r.backend === 'fabric' ? 'Fabric' : 'Azure Monitor'}</Badge></TableCell>
                          <TableCell className={s.cell}>
                            {r.query
                              ? r.query.replace(/\s+/g, ' ').slice(0, 60) + (r.query.length > 60 ? '…' : '')
                              : (r.condition ? `${r.condition.operator || ''} ${fmtCell(r.condition.value)}`.trim() : '—')}
                          </TableCell>
                          <TableCell>{typeof r.severity === 'number' ? r.severity : '—'}</TableCell>
                          <TableCell className={s.cell}>{(r.evaluationFrequency || '—')} / {(r.windowSize || '—')}</TableCell>
                          <TableCell className={s.cell}>{r.action?.kind || '—'}</TableCell>
                          <TableCell className={s.cell} title={r.actionGroupId || ''}>
                            {r.actionGroupId ? (r.actionGroupId.split('/').pop() || r.actionGroupId) : '—'}
                          </TableCell>
                          <TableCell>{r.state || '—'}</TableCell>
                          <TableCell>
                            <Button size="small" appearance="subtle" icon={<Play20Regular />} onClick={() => triggerNow(r.id)}>Trigger</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* Action groups — resolved Microsoft.Insights/actionGroups per rule,
                  with a real "Test notification" button that fires the group's
                  receivers (webhook receiver logs the Common Alert Schema payload). */}
              {rules.some((r) => r.actionGroupId) && (
                <div style={{ marginTop: 16 }}>
                  <Subtitle2>Action groups</Subtitle2>
                  {agMsg && <MessageBar intent={agMsg.startsWith('Test failed') ? 'error' : 'success'} style={{ marginTop: 8 }}><MessageBarBody>{agMsg}</MessageBarBody></MessageBar>}
                  <div className={s.tableWrap} style={{ marginTop: 8 }}>
                    <Table aria-label="Action groups" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Rule</TableHeaderCell>
                        <TableHeaderCell>Action group ARM id</TableHeaderCell>
                        <TableHeaderCell>Receivers</TableHeaderCell>
                        <TableHeaderCell></TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {rules.filter((r) => r.actionGroupId).map((r) => {
                          const rc = r.actionGroupReceivers;
                          return (
                            <TableRow key={`ag-${r.id}`}>
                              <TableCell>{r.name}</TableCell>
                              <TableCell className={s.cell}>{r.actionGroupId}</TableCell>
                              <TableCell className={s.cell}>
                                {rc ? `${rc.emails}✉ ${rc.sms}☎ ${rc.webhooks}🔗 ${rc.logicApps}⚙` : '—'}
                              </TableCell>
                              <TableCell>
                                <Button size="small" appearance="subtle" disabled={agBusy === r.actionGroupId} onClick={() => testNotification(r.actionGroupId!)}>
                                  {agBusy === r.actionGroupId ? 'Sending…' : 'Test notification'}
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      }
    />
  );
}

// ----- Warehouse -----
// Ribbon built inside the editor via useMemo so Run binds to the
// existing inline run handler; the rest stay disabled with reasons.

interface WHQueryResult {
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
  warehouse?: string;
}
interface WHSchemaResp {
  ok: boolean;
  state?: string;
  sku?: string;
  warehouse?: string;
  message?: string;
  schemas?: Record<string, { table: string; rows: number }[]>;
  error?: string;
}

const SAMPLE_SQL = `-- Fabric Warehouse (Loom-Gov: backed by Synapse Dedicated SQL pool)\nSELECT 1 AS smoke, DB_NAME() AS db, SUSER_NAME() AS upn, SYSDATETIMEOFFSET() AS now_utc;`;

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function WarehouseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const isNew = id === 'new';
  // Bundle-installed warehouses stamp their rich definition (DDL, dbt models,
  // starter queries) into the Cosmos item's state.content (WarehouseContent).
  // The live Synapse Dedicated pool may be Paused / not-yet-provisioned, in
  // which case /schema 409s and the explorer renders empty. Read the persisted
  // content from the React Query cache the host page primes at
  // ['item','warehouse',id] so the editor opens FULLY built-out — showing the
  // DDL, dbt medallion models, and starter queries — even before the live
  // warehouse exists. Run / Save-as-table still hit the live backend.
  const itemQ = useQuery<WorkspaceItem>({
    queryKey: ['item', 'warehouse', id],
    queryFn: () => getItem('warehouse', id),
    enabled: !isNew,
  });
  const content = (itemQ.data?.state as any)?.content as WarehouseContent | undefined;
  const bundleContent = content?.kind === 'warehouse' ? content : undefined;
  const starterQueries = bundleContent?.starterQueries ?? [];
  const dbtModels = bundleContent?.dbtModels ?? [];
  const hasBundle = !!bundleContent && (!!bundleContent.ddl || starterQueries.length > 0 || dbtModels.length > 0);

  const [sqlText, setSqlText] = useState(SAMPLE_SQL);
  const [schema, setSchema] = useState<WHSchemaResp | null>(null);
  const [result, setResult] = useState<WHQueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  // Seed the SQL editor with the bundle DDL once, when the live warehouse has
  // no tables to show — so the surface lands populated instead of on a smoke
  // test. The user can Run it (creates the schema) against the live compute.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !bundleContent?.ddl) return;
    if (sqlText !== SAMPLE_SQL) return;
    setSqlText(`-- Starter DDL from the installed app bundle.\n-- Run against the warehouse compute to provision these tables.\n\n${bundleContent.ddl}`);
    seededRef.current = true;
  }, [bundleContent, sqlText]);
  // Surface the underlying Synapse Dedicated SQL pool via ComputePicker so
  // users can Resume the pool when paused without leaving the Warehouse
  // editor. Selection is informational here — Warehouse query routes to the
  // wired-in pool — but the lifecycle controls (Resume / Pause) are wired.
  const [computeId, setComputeId] = useState('');

  const loadSchema = useCallback(async () => {
    // Pre-save gate: /items/warehouse/new fires this before any record exists
    // (was returning 409 on the walkthrough validator). Skip until saved.
    if (!id || id === 'new') return;
    try {
      const r = await fetch(`/api/items/warehouse/${encodeURIComponent(id)}/schema`);
      const j = (await r.json()) as WHSchemaResp;
      setSchema(j);
    } catch (e: any) {
      setSchema({ ok: false, error: e?.message || String(e) });
    }
  }, [id]);

  useEffect(() => { loadSchema(); }, [loadSchema]);

  const run = useCallback(async () => {
    setLoading(true); setResult(null);
    try {
      const r = await fetch(`/api/items/warehouse/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sqlText }),
      });
      const j = (await r.json()) as WHQueryResult;
      setResult(j);
      if (r.status === 409 && j.state) loadSchema();
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    } finally { setLoading(false); }
  }, [id, sqlText, loadSchema]);

  const schemaEntries = Object.entries(schema?.schemas || {});
  const ready = schema?.ok === true;

  const canRun = ready && !loading;

  // Save-as-table dialog state — CTAS helper.
  const [ctasOpen, setCtasOpen] = useState(false);
  const [ctasSchema, setCtasSchema] = useState('dbo');
  const [ctasTable, setCtasTable] = useState('');
  const [ctasBusy, setCtasBusy] = useState(false);
  const [ctasError, setCtasError] = useState<string | null>(null);

  const newSql = useCallback(() => {
    // Multi-tab is a future v3.x — for now "New SQL query" resets the
    // current tab to a fresh template, matching Fabric Warehouse's
    // single-tab UX inside the embedded editor.
    setSqlText(SAMPLE_SQL.replace(/SELECT 1 AS smoke[^;]*;/, 'SELECT TOP 100 * FROM INFORMATION_SCHEMA.TABLES;'));
    setResult(null);
  }, []);

  const openCtas = useCallback(() => {
    setCtasError(null);
    setCtasTable('');
    setCtasOpen(true);
  }, []);

  const submitCtas = useCallback(async () => {
    if (!ctasTable.trim()) { setCtasError('table name required'); return; }
    setCtasBusy(true); setCtasError(null);
    try {
      // Strip a trailing semicolon if present so we can wrap in CTAS.
      const cleaned = sqlText.trim().replace(/;+\s*$/, '');
      if (!/^select\b/i.test(cleaned)) {
        throw new Error('CTAS requires the current query to start with SELECT.');
      }
      const ddl = `CREATE TABLE [${ctasSchema.replace(/]/g, '')}].[${ctasTable.replace(/]/g, '')}] AS\n${cleaned};`;
      const r = await fetch(`/api/items/warehouse/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: ddl }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setCtasOpen(false);
      loadSchema();
    } catch (e: any) { setCtasError(e?.message || String(e)); }
    finally { setCtasBusy(false); }
  }, [id, sqlText, ctasSchema, ctasTable, loadSchema]);

  const openInExcel = useCallback(async () => {
    if (!sqlText.trim()) return;
    try {
      const r = await fetch(`/api/items/warehouse/${encodeURIComponent(id)}/iqy`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sqlText }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `loom-warehouse-${id}.iqy`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || String(e) });
    }
  }, [id, sqlText]);
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Query', actions: [
        { label: 'New SQL query', onClick: newSql },
        { label: loading ? 'Running…' : 'Run', onClick: canRun ? run : undefined, disabled: !canRun, title: !ready ? 'warehouse compute is not ready' : undefined },
        { label: 'Save as table', onClick: canRun && sqlText.trim() ? openCtas : undefined, disabled: !canRun || !sqlText.trim(), title: !canRun ? 'warehouse compute is not ready' : (!sqlText.trim() ? 'enter a SELECT first' : undefined) },
        { label: 'Open in Excel', onClick: sqlText.trim() ? openInExcel : undefined, disabled: !sqlText.trim(), title: !sqlText.trim() ? 'enter a query first' : undefined },
      ]},
      { label: 'Modeling', actions: [
        // Model view: a warehouse "measure" is a persisted scalar/inline TVF.
        // Loads a real CREATE FUNCTION template the user runs via the wired
        // /query path. Run executes it against the warehouse compute.
        { label: 'New measure', onClick: canRun ? () => { setSqlText(
          `-- Model view — define a reusable measure as an inline table-valued function.\n`
          + `CREATE FUNCTION dbo.fn_TotalSales()\n`
          + `RETURNS TABLE AS RETURN (\n`
          + `  SELECT SUM(Amount) AS TotalSales FROM dbo.Sales\n`
          + `);`,
        ); setResult(null); } : undefined, disabled: !canRun, title: !ready ? 'warehouse compute is not ready' : undefined },
        // Real DMV — table relationships (foreign keys) that drive Model view.
        { label: 'Manage relationships', onClick: canRun ? () => { setSqlText(
          `-- Model view — table relationships (foreign keys).\n`
          + `SELECT fk.name AS relationship,\n`
          + `       OBJECT_NAME(fk.parent_object_id) AS from_table,\n`
          + `       OBJECT_NAME(fk.referenced_object_id) AS to_table\n`
          + `FROM sys.foreign_keys fk;`,
        ); setResult(null); } : undefined, disabled: !canRun, title: !ready ? 'warehouse compute is not ready' : undefined },
      ]},
      { label: 'Manage', actions: [
        // Real DMV — database principals & role membership.
        { label: 'Permissions', onClick: canRun ? () => { setSqlText(
          `-- Warehouse permissions — principals and role membership.\n`
          + `SELECT p.name AS principal, p.type_desc, ISNULL(r.name, '') AS member_of\n`
          + `FROM sys.database_principals p\n`
          + `LEFT JOIN sys.database_role_members m ON m.member_principal_id = p.principal_id\n`
          + `LEFT JOIN sys.database_principals r ON r.principal_id = m.role_principal_id\n`
          + `WHERE p.type IN ('S','U','G','X','R') ORDER BY p.type_desc, p.name;`,
        ); setResult(null); } : undefined, disabled: !canRun, title: !ready ? 'warehouse compute is not ready' : undefined },
        // Source control lives at the workspace level in Fabric — open the
        // workspace Git settings (honest navigation, not a stub).
        { label: 'Source control', onClick: () => window.open('https://learn.microsoft.com/fabric/data-warehouse/source-control', '_blank'), title: 'Warehouse Git integration — managed at the workspace level' },
      ]},
    ]},
  ], [loading, canRun, ready, run, newSql, sqlText, openCtas, openInExcel]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div style={{ padding: 8 }}>
          <Tree aria-label="Warehouse explorer" defaultOpenItems={['schemas', 'starter', 'starter-queries', 'dbt-models']}>
            {hasBundle && (
              <TreeItem itemType="branch" value="starter">
                <TreeItemLayout iconBefore={<Database20Regular />}>
                  Starter content (app bundle)
                </TreeItemLayout>
                <Tree>
                  {bundleContent?.ddl && (
                    <TreeItem
                      itemType="leaf"
                      value="starter-ddl"
                      onClick={() => { setSqlText(`-- Starter DDL from the installed app bundle.\n-- Run against the warehouse compute to provision these tables.\n\n${bundleContent.ddl}`); setResult(null); }}
                    >
                      <TreeItemLayout iconBefore={<DocumentTable20Regular />}>DDL — schema script</TreeItemLayout>
                    </TreeItem>
                  )}
                  {dbtModels.length > 0 && (
                    <TreeItem itemType="branch" value="dbt-models">
                      <TreeItemLayout iconBefore={<Folder20Regular />}>dbt models ({dbtModels.length})</TreeItemLayout>
                      <Tree>
                        {dbtModels.map((m, i) => (
                          <TreeItem
                            key={`${m.layer}.${m.name}.${i}`}
                            itemType="leaf"
                            value={`dbt-${m.layer}-${m.name}-${i}`}
                            onClick={() => { setSqlText(`-- dbt model [${m.layer}] ${m.name}\n\n${m.sql}`); setResult(null); }}
                          >
                            <TreeItemLayout iconBefore={<DocumentTable20Regular />}>
                              {m.name} <Caption1>· {m.layer}</Caption1>
                            </TreeItemLayout>
                          </TreeItem>
                        ))}
                      </Tree>
                    </TreeItem>
                  )}
                  {starterQueries.length > 0 && (
                    <TreeItem itemType="branch" value="starter-queries">
                      <TreeItemLayout iconBefore={<Folder20Regular />}>Starter queries ({starterQueries.length})</TreeItemLayout>
                      <Tree>
                        {starterQueries.map((qy, i) => (
                          <TreeItem
                            key={`${qy.name}-${i}`}
                            itemType="leaf"
                            value={`sq-${qy.name}-${i}`}
                            onClick={() => { setSqlText(qy.sql); setResult(null); }}
                          >
                            <TreeItemLayout iconBefore={<Play20Regular />}>{qy.name}</TreeItemLayout>
                          </TreeItem>
                        ))}
                      </Tree>
                    </TreeItem>
                  )}
                </Tree>
              </TreeItem>
            )}
            <TreeItem itemType="branch" value="schemas">
              <TreeItemLayout iconBefore={<Database20Regular />}>
                Schemas ({schemaEntries.length})
              </TreeItemLayout>
              <Tree>
                {!ready && (
                  <TreeItem itemType="leaf" value="not-ready">
                    <TreeItemLayout>{schema?.message || 'Warehouse compute offline'}</TreeItemLayout>
                  </TreeItem>
                )}
                {ready && schemaEntries.length === 0 && (
                  <TreeItem itemType="leaf" value="empty">
                    <TreeItemLayout>No user tables yet. Create with T-SQL.</TreeItemLayout>
                  </TreeItem>
                )}
                {schemaEntries.map(([schemaName, tables]) => (
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
            <Badge appearance="filled" color={ready ? 'success' : 'warning'}>{schema?.state || 'Unknown'}</Badge>
            <Badge appearance="outline">{schema?.warehouse || 'warehouse —'}</Badge>
            <Badge appearance="outline">{schema?.sku || 'DW—'}</Badge>
            <Button appearance="outline" onClick={loadSchema}>Refresh</Button>
            <Button appearance="primary" icon={<Play20Regular />} disabled={loading || !ready} onClick={run} style={{ marginLeft: 'auto' }}>Run</Button>
          </div>
          {schema && !ready && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Warehouse compute is {schema.state}</MessageBarTitle>
                {schema.message || 'Pick the Synapse Dedicated SQL pool below and click Resume.'}
                {hasBundle && ' This warehouse was installed from an app bundle — its starter DDL, dbt models, and queries are listed in the explorer on the left. Resume the pool, then Run the DDL to provision them.'}
              </MessageBarBody>
            </MessageBar>
          )}
          {/*
           * Compute picker so users can Resume the underlying Synapse
           * Dedicated SQL pool when paused, directly from the Warehouse
           * editor instead of round-tripping to the dedicated-pool editor.
           */}
          <ComputePicker
            label="Backing compute (Synapse Dedicated SQL)"
            filter={['synapse-dedicated-sql']}
            value={computeId}
            onChange={setComputeId}
          />
          <MonacoTextarea
            value={sqlText}
            onChange={setSqlText}
            language="tsql"
            height={260}
            minHeight={200}
            ariaLabel="Warehouse T-SQL editor"
          />
          {loading && <Spinner size="small" label="Executing T-SQL…" labelPosition="after" />}
          {result && !result.ok && (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Query failed</MessageBarTitle>
                {result.error || 'Unknown error'} {result.code && <Caption1>· {result.code}</Caption1>}
              </MessageBarBody>
            </MessageBar>
          )}
          {result?.ok && (
            <>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <Badge appearance="filled" color="success">{result.rowCount ?? result.rows?.length ?? 0} rows</Badge>
                <Caption1>· {result.executionMs} ms</Caption1>
                {result.truncated && <Badge appearance="outline" color="warning">truncated at 5,000</Badge>}
              </div>
              {(result.rows?.length ?? 0) === 0 ? (
                <Caption1>Query returned no rows.</Caption1>
              ) : (
                <div style={{ overflow: 'auto', maxHeight: 360, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 }}>
                  <Table aria-label="Query results" size="small">
                    <TableHeader><TableRow>
                      {(result.columns || []).map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                    </TableRow></TableHeader>
                    <TableBody>
                      {(result.rows || []).map((row, i) => (
                        <TableRow key={i}>
                          {(result.columns || []).map((_, j) => (
                            <TableCell key={j} style={{ fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' }}>{formatCell(row[j])}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}

          <Dialog open={ctasOpen} onOpenChange={(_, d) => setCtasOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Save as table (CTAS)</DialogTitle>
                <DialogContent>
                  <Caption1>
                    Wraps the current query as <code>CREATE TABLE … AS SELECT …</code> and runs it
                    against the warehouse. Schema + table must not already exist.
                  </Caption1>
                  <Field label="Schema">
                    <Input value={ctasSchema} onChange={(_, d) => setCtasSchema(d.value)} placeholder="dbo" />
                  </Field>
                  <Field label="Table name" required>
                    <Input value={ctasTable} onChange={(_, d) => setCtasTable(d.value)} placeholder="orders_top100" />
                  </Field>
                  {ctasError && (
                    <MessageBar intent="error"><MessageBarBody><MessageBarTitle>CTAS failed</MessageBarTitle>{ctasError}</MessageBarBody></MessageBar>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setCtasOpen(false)} disabled={ctasBusy}>Cancel</Button>
                  <Button appearance="primary" onClick={submitCtas} disabled={ctasBusy || !ctasTable.trim()}>
                    {ctasBusy ? 'Creating…' : 'Create table'}
                  </Button>
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
// Semantic Model (Power BI dataset)
// ============================================================
// Ribbon built inside SemanticModelEditor via useMemo so Refresh binds
// to the existing inline refreshNow handler; the rest stay disabled.

interface DatasetLite {
  id: string; name: string; configuredBy?: string; isRefreshable?: boolean; targetStorageMode?: string; createdDate?: string;
  isEffectiveIdentityRolesRequired?: boolean;
}
interface TableLite {
  name: string;
  columns?: Array<{ name: string; dataType?: string }>;
  measures?: Array<{ name: string; expression?: string }>;
}
interface RefreshLite {
  requestId?: string; refreshType?: string; startTime?: string; endTime?: string; status?: string; serviceExceptionJson?: string;
}

export function SemanticModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  // PBI editor — picker MUST surface Power BI groupIds (not Loom UUIDs)
  // or the embed-token / list calls return 404 PowerBIEntityNotFound.
  const ws = usePowerBiWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [datasets, setDatasets] = useState<DatasetLite[] | null>(null);
  const [datasetId, setDatasetId] = useState('');
  const [listErr, setListErr] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ dataset?: DatasetLite; tables?: TableLite[]; refreshSchedule?: any } | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState<RefreshLite[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);
  const [relationships, setRelationships] = useState<Array<{ name?: string; fromTable?: string; fromColumn?: string; toTable?: string; toColumn?: string; crossFilteringBehavior?: string }>>([]);
  const [tab, setTab] = useState<'tables' | 'relationships' | 'measures' | 'build' | 'refresh' | 'config' | 'access' | 'governance' | 'embed'>('tables');
  // Power BI is opt-in (no-fabric-dependency.md): the editor renders Loom-native
  // tabular metadata by default and only exposes Power BI actions/embed when the
  // Console identity actually has Power BI workspace access.
  const powerBiConfigured = !!(ws.workspaces && ws.workspaces.length > 0 && !ws.error);

  // --- Model builder (real Power BI push-dataset authoring) ---------------
  // Builds a NEW semantic model with tables/typed-columns/measures/relationships
  // via POST /api/items/semantic-model/build → Power BI Push Datasets REST.
  const PBI_COL_TYPES = ['String', 'Int64', 'Double', 'Decimal', 'Boolean', 'DateTime'] as const;
  type BuilderColumn = { name: string; dataType: typeof PBI_COL_TYPES[number] };
  type BuilderMeasure = { name: string; expression: string };
  type BuilderTable = { name: string; columns: BuilderColumn[]; measures: BuilderMeasure[] };
  type BuilderRel = { name: string; fromTable: string; fromColumn: string; toTable: string; toColumn: string; crossFilteringBehavior: 'OneDirection' | 'BothDirections' };
  const [bModelName, setBModelName] = useState('');
  const [bTables, setBTables] = useState<BuilderTable[]>([
    { name: 'Sales', columns: [{ name: 'OrderId', dataType: 'Int64' }, { name: 'Amount', dataType: 'Double' }, { name: 'OrderDate', dataType: 'DateTime' }], measures: [{ name: 'TotalSales', expression: 'SUM(Sales[Amount])' }] },
  ]);
  const [bRels, setBRels] = useState<BuilderRel[]>([]);
  const [bBusy, setBBusy] = useState(false);
  const [bMsg, setBMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // DAX measure validator — name + table dropdown + Monaco DAX editor + Test
  // button. Persistence is XMLA-only (Premium / Fabric capacity feature) so
  // we honestly surface that via MessageBar instead of pretending to Save.
  const [measureName, setMeasureName] = useState('');
  const [measureTable, setMeasureTable] = useState('');
  const [daxExpr, setDaxExpr] = useState('SUM(\'Sales\'[Amount])');
  const [daxBusy, setDaxBusy] = useState(false);
  const [daxResult, setDaxResult] = useState<{ ok: boolean; value?: unknown; error?: string } | null>(null);

  // Scheduled-refresh editor (config tab) — mirrors the Power BI service
  // "Scheduled refresh" pane. Writes via PATCH /datasets/{id}/refreshSchedule.
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const [schedEnabled, setSchedEnabled] = useState(false);
  const [schedDays, setSchedDays] = useState<string[]>([]);
  const [schedTimes, setSchedTimes] = useState<string>('07:00');
  const [schedTz, setSchedTz] = useState('UTC');
  const [schedNotify, setSchedNotify] = useState<'MailOnFailure' | 'NoNotification'>('NoNotification');
  const [schedBusy, setSchedBusy] = useState(false);
  const [schedMsg, setSchedMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [takeoverBusy, setTakeoverBusy] = useState(false);

  const loadList = useCallback(async (wsId: string) => {
    setListErr(null);
    try {
      const r = await fetch(`/api/items/semantic-model?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDatasets([]); setListErr(j.error); return; }
      setDatasets(j.datasets || []);
      setDatasetId((prev) => prev || (j.datasets?.[0]?.id ?? ''));
    } catch (e: any) {
      setDatasets([]); setListErr(e?.message || String(e));
    }
  }, []);

  const loadDetail = useCallback(async (wsId: string, dsId: string) => {
    setDetailErr(null); setDetail(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(dsId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDetailErr(j.error); return; }
      setDetail({ dataset: j.dataset, tables: j.tables || [], refreshSchedule: j.refreshSchedule });
      setRelationships(Array.isArray(j.relationships) ? j.relationships : []);
    } catch (e: any) { setDetailErr(e?.message || String(e)); }
  }, []);

  const loadRefreshes = useCallback(async (wsId: string, dsId: string) => {
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(dsId)}/refreshes?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (j.ok) setRefreshes(j.refreshes || []);
    } catch { /* silently keep last */ }
  }, []);

  // Auto-pick the first Power BI workspace once loaded so the list fetch fires
  // and the first dataset auto-selects — enabling New measure / Refresh / Open
  // immediately instead of leaving them disabled behind a manual pick. Matches
  // the Eventstream/Activator auto-pick pattern. Users can still switch.
  useEffect(() => {
    if (!workspaceId && ws.workspaces && ws.workspaces.length > 0) setWorkspaceId(ws.workspaces[0].id);
  }, [workspaceId, ws.workspaces]);
  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => {
    if (workspaceId && datasetId) { loadDetail(workspaceId, datasetId); loadRefreshes(workspaceId, datasetId); }
  }, [workspaceId, datasetId, loadDetail, loadRefreshes]);

  const refreshNow = useCallback(async () => {
    if (!workspaceId || !datasetId) return;
    setRefreshing(true); setRefreshErr(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/refresh?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) setRefreshErr(j.error || 'refresh failed');
      else { setTimeout(() => loadRefreshes(workspaceId, datasetId), 1500); }
    } finally { setRefreshing(false); }
  }, [workspaceId, datasetId, loadRefreshes]);

  // Hydrate the scheduled-refresh form from the live schedule whenever the
  // selected dataset's detail loads.
  useEffect(() => {
    const sch = detail?.refreshSchedule;
    setSchedMsg(null);
    if (sch && typeof sch === 'object') {
      setSchedEnabled(!!sch.enabled);
      setSchedDays(Array.isArray(sch.days) ? sch.days : []);
      setSchedTimes(Array.isArray(sch.times) && sch.times.length ? sch.times.join(', ') : '07:00');
      setSchedTz(sch.localTimeZoneId || 'UTC');
      setSchedNotify(sch.notifyOption === 'MailOnFailure' ? 'MailOnFailure' : 'NoNotification');
    } else {
      setSchedEnabled(false); setSchedDays([]); setSchedTimes('07:00'); setSchedTz('UTC'); setSchedNotify('NoNotification');
    }
  }, [detail?.refreshSchedule, datasetId]);

  const toggleSchedDay = useCallback((day: string) => {
    setSchedDays((prev) => prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]);
  }, []);

  const saveSchedule = useCallback(async () => {
    if (!workspaceId || !datasetId) return;
    setSchedBusy(true); setSchedMsg(null);
    const times = schedTimes.split(',').map((t) => t.trim()).filter(Boolean);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/refresh-schedule?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: schedEnabled, days: schedDays, times, localTimeZoneId: schedTz, notifyOption: schedNotify }),
      });
      const j = await r.json();
      if (!j.ok) { setSchedMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setSchedMsg({ ok: true, text: 'Scheduled refresh updated.' });
      setDetail((prev) => prev ? { ...prev, refreshSchedule: j.schedule } : prev);
    } catch (e: any) { setSchedMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setSchedBusy(false); }
  }, [workspaceId, datasetId, schedEnabled, schedDays, schedTimes, schedTz, schedNotify]);

  const takeOver = useCallback(async () => {
    if (!workspaceId || !datasetId) return;
    setTakeoverBusy(true); setSchedMsg(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/take-over?workspaceId=${encodeURIComponent(workspaceId)}`, { method: 'POST' });
      const j = await r.json();
      if (!j.ok) { setSchedMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setSchedMsg({ ok: true, text: 'Dataset taken over by the Console identity. You can now edit the schedule.' });
      loadDetail(workspaceId, datasetId);
    } catch (e: any) { setSchedMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setTakeoverBusy(false); }
  }, [workspaceId, datasetId, loadDetail]);

  // Validate a candidate DAX measure expression server-side via the Power
  // BI executeQueries REST endpoint. The route compiles via DEFINE MEASURE
  // and evaluates a probe row — invalid DAX returns the engine's real
  // error message (not a mocked "looks good"). Persistence requires XMLA.
  const validateDax = useCallback(async () => {
    if (!workspaceId || !datasetId || !measureName.trim() || !measureTable.trim() || !daxExpr.trim()) return;
    setDaxBusy(true); setDaxResult(null);
    try {
      const r = await fetch(`/api/items/semantic-model/${encodeURIComponent(datasetId)}/measures?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ measureName: measureName.trim(), tableName: measureTable.trim(), daxExpression: daxExpr }),
      });
      const j = await r.json();
      if (!j.ok) { setDaxResult({ ok: false, error: j.error || `HTTP ${r.status}` }); return; }
      const row = j?.probe?.rows?.[0] || {};
      const v = Object.values(row)[0];
      setDaxResult({ ok: true, value: v });
    } catch (e: any) { setDaxResult({ ok: false, error: e?.message || String(e) }); }
    finally { setDaxBusy(false); }
  }, [workspaceId, datasetId, measureName, measureTable, daxExpr]);

  const focusNewMeasure = useCallback(() => {
    setTab('measures');
    if (!measureTable && detail?.tables?.[0]?.name) setMeasureTable(detail.tables[0].name);
    if (!measureName) setMeasureName('MyMeasure');
  }, [measureTable, measureName, detail?.tables]);

  // Build a REAL new semantic model (push dataset) via the Power BI Push
  // Datasets REST API. After a successful build we refresh the dataset list
  // and select the new model so the user lands in its detail view.
  const buildModel = useCallback(async () => {
    if (!workspaceId || !bModelName.trim() || bTables.length === 0) return;
    setBBusy(true); setBMsg(null);
    try {
      const r = await fetch(`/api/items/semantic-model/build?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: bModelName.trim(),
          tables: bTables.map((t) => ({
            name: t.name.trim(),
            columns: t.columns.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), dataType: c.dataType })),
            measures: t.measures.filter((m) => m.name.trim() && m.expression.trim()).map((m) => ({ name: m.name.trim(), expression: m.expression.trim() })),
          })),
          relationships: bRels.filter((rl) => rl.fromTable && rl.fromColumn && rl.toTable && rl.toColumn),
        }),
      });
      const j = await r.json();
      if (!j.ok) { setBMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setBMsg({ ok: true, text: `Created semantic model "${j.name}" (id ${String(j.datasetId).slice(0, 8)}…). Reloading workspace…` });
      await loadList(workspaceId);
      if (j.datasetId) { setDatasetId(j.datasetId); setTab('tables'); }
    } catch (e: any) { setBMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setBBusy(false); }
  }, [workspaceId, bModelName, bTables, bRels, loadList]);

  const focusBuild = useCallback(() => {
    setTab('build');
    if (!bModelName) setBModelName('My semantic model');
  }, [bModelName]);

  const canRefresh = !!datasetId && !refreshing && detail?.dataset?.isRefreshable !== false;
  const openInPbi = useCallback(() => {
    if (workspaceId && datasetId) {
      window.open(`https://app.powerbi.com/groups/${encodeURIComponent(workspaceId)}/datasets/${encodeURIComponent(datasetId)}/details`, '_blank', 'noreferrer');
    }
  }, [workspaceId, datasetId]);
  // Only real, working actions. Authoring that genuinely requires the XMLA
  // endpoint / Power BI Desktop (RLS roles, perspectives, Direct Lake toggle,
  // TMSL import) is NOT shown as a dead button — it's documented in the
  // Measures-tab MessageBar instead. See no-vaporware.md.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Model', actions: [
        { label: 'Build model', onClick: workspaceId ? focusBuild : undefined, disabled: !workspaceId, title: !workspaceId ? 'select a workspace first' : 'Create a new semantic model with tables, columns, measures & relationships via Power BI REST (push dataset)' },
      ]},
      { label: 'Measures', actions: [
        { label: 'New measure (DAX)', onClick: datasetId ? focusNewMeasure : undefined, disabled: !datasetId, title: !datasetId ? 'select a dataset first' : 'Open the Measures tab to author + validate DAX against the live model' },
      ]},
      { label: 'Source', actions: [
        { label: refreshing ? 'Queuing…' : 'Refresh', onClick: canRefresh ? refreshNow : undefined, disabled: !canRefresh, title: detail?.dataset?.isRefreshable === false ? 'dataset is not refreshable (push or DirectQuery without gateway)' : (!datasetId ? 'select a dataset first' : undefined) },
      ]},
      { label: 'Open', actions: [
        { label: 'Open in Power BI', onClick: datasetId ? openInPbi : undefined, disabled: !datasetId, title: !datasetId ? 'select a dataset first' : 'opens the dataset in Power BI — author RLS roles, perspectives & Direct Lake there' },
      ]},
    ]},
  ], [refreshing, canRefresh, refreshNow, datasetId, detail?.dataset?.isRefreshable, focusNewMeasure, openInPbi, workspaceId, focusBuild]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <PowerBiTree
          workspaceId={workspaceId}
          selectedDatasetId={datasetId}
          onOpenDataset={(dsId) => { setDatasetId(dsId); setTab('tables'); }}
          onNewDataset={focusBuild}
          onOpenReport={(r) => { if (r.webUrl) { try { window.open(r.webUrl, '_blank', 'noreferrer'); } catch { /* popup blocked */ } } }}
          onOpenDashboard={(d) => { if (d.webUrl) { try { window.open(d.webUrl, '_blank', 'noreferrer'); } catch { /* popup blocked */ } } }}
        />
      }
      main={
        <>
          <div className={s.pad}>
            <div className={s.toolbar}>
              <Badge appearance="filled" color="brand">Semantic model</Badge>
              {powerBiConfigured && (
                <>
                  <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
                  <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh</Button>
                </>
              )}
              <Button appearance="outline" icon={<Add20Regular />} onClick={focusBuild} disabled={!powerBiConfigured || !workspaceId} title={!powerBiConfigured ? 'Power BI embed is opt-in; workspace not configured' : 'Build a new semantic model (push dataset) via Power BI REST'} style={{ marginLeft: 'auto' }}>Build model</Button>
              <Button
                appearance="primary"
                icon={<Play20Regular />}
                disabled={!datasetId || refreshing || detail?.dataset?.isRefreshable === false || !powerBiConfigured}
                onClick={refreshNow}
                title={!powerBiConfigured ? 'Power BI embed is opt-in; workspace not configured' : (detail?.dataset?.isRefreshable === false ? 'Dataset is not refreshable (e.g. push dataset or DirectQuery without gateway).' : undefined)}
              >
                {refreshing ? 'Queuing…' : 'Refresh dataset'}
              </Button>
            </div>
            {listErr && <MessageBar intent="error"><MessageBarBody>{listErr}</MessageBarBody></MessageBar>}
            {refreshErr && <MessageBar intent="error"><MessageBarBody>{refreshErr}</MessageBarBody></MessageBar>}
            {detailErr && <MessageBar intent="error"><MessageBarBody>{detailErr}</MessageBarBody></MessageBar>}
            {!powerBiConfigured && (
              <MessageBar intent="info" style={{ marginBottom: 12 }}>
                <MessageBarBody>
                  <MessageBarTitle>Power BI embed is opt-in</MessageBarTitle>
                  The Console identity isn&rsquo;t registered in Power BI / not in any workspace. This editor shows Loom-native table, relationship, and measure (DAX) metadata. To enable Build model / Refresh / the Power BI Embed tab, register the Console UAMI in your Power BI tenant and add it to a workspace. <a href="https://learn.microsoft.com/power-bi/admin/service-principal-api-considerations" target="_blank" rel="noreferrer">Power BI service principal setup</a>.
                </MessageBarBody>
              </MessageBar>
            )}
            {detail?.dataset && (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <Caption1>Owner: <strong>{detail.dataset.configuredBy || '—'}</strong></Caption1>
                <Caption1>Mode: <strong>{detail.dataset.targetStorageMode || '—'}</strong></Caption1>
                {detail.dataset.isRefreshable === false && <Badge appearance="outline" color="warning">not refreshable</Badge>}
              </div>
            )}
          </div>
          {(datasetId || tab === 'build') && (
            <>
              <div className={s.tabBar}>
                <TabList selectedValue={tab} onTabSelect={(_: unknown, d: any) => setTab(d.value as any)}>
                  <Tab value="tables">Tables ({detail?.tables?.length ?? 0})</Tab>
                  <Tab value="relationships">Relationships ({relationships.length})</Tab>
                  <Tab value="measures">Measures (DAX)</Tab>
                  <Tab value="build">Build model</Tab>
                  <Tab value="refresh">Refresh history ({refreshes.length})</Tab>
                  <Tab value="config">Configuration</Tab>
                  <Tab value="governance">Gateway &amp; endorsement</Tab>
                  <Tab value="access">Manage access</Tab>
                  {powerBiConfigured && <Tab value="embed">Power BI Embed</Tab>}
                </TabList>
              </div>
              <div className={s.pad}>
                {tab === 'tables' && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Tables" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Table</TableHeaderCell>
                        <TableHeaderCell>Columns</TableHeaderCell>
                        <TableHeaderCell>Measures</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {(detail?.tables || []).map((t) => (
                          <TableRow key={t.name}>
                            <TableCell>{t.name}</TableCell>
                            <TableCell className={s.cell}>{(t.columns || []).map((c) => `${c.name}:${c.dataType || '?'}`).join(', ') || '—'}</TableCell>
                            <TableCell className={s.cell}>{(t.measures || []).map((m) => m.name).join(', ') || '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                {tab === 'relationships' && (
                  <>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      Table relationships from <code>GET /datasets/{'{'}id{'}'}/relationships</code> (Power BI REST). Editing relationships
                      on an imported model requires XMLA / Desktop; push datasets accept relationships at create time via the <strong>Build model</strong> tab.
                    </Caption1>
                    {relationships.length === 0 ? (
                      <Caption1 style={{ marginTop: 8 }}>No relationships returned for this model.</Caption1>
                    ) : (
                      <div className={s.tableWrap} style={{ marginTop: 8 }}>
                        <Table aria-label="Relationships" size="small">
                          <TableHeader><TableRow>
                            <TableHeaderCell>Name</TableHeaderCell>
                            <TableHeaderCell>From</TableHeaderCell>
                            <TableHeaderCell>To</TableHeaderCell>
                            <TableHeaderCell>Cross-filter</TableHeaderCell>
                          </TableRow></TableHeader>
                          <TableBody>
                            {relationships.map((r, i) => (
                              <TableRow key={r.name || i}>
                                <TableCell>{r.name || '—'}</TableCell>
                                <TableCell className={s.cell}>{r.fromTable}[{r.fromColumn}]</TableCell>
                                <TableCell className={s.cell}>{r.toTable}[{r.toColumn}]</TableCell>
                                <TableCell>{r.crossFilteringBehavior || '—'}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </>
                )}
                {tab === 'build' && (
                  <>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        <MessageBarTitle>Build a semantic model (push dataset)</MessageBarTitle>
                        Define tables, typed columns, DAX measures, and relationships, then <strong>Create model</strong> —
                        this calls the Power BI <code>POST /groups/{'{'}ws{'}'}/datasets</code> push-dataset REST API to author a
                        real semantic model. Imported / Direct Lake model edits still require the XMLA endpoint
                        (<code>LOOM_POWERBI_XMLA_ENDPOINT</code>) or Power BI Desktop.
                      </MessageBarBody>
                    </MessageBar>
                    <Field label="Model name" required style={{ maxWidth: 420, marginTop: 8 }}>
                      <Input value={bModelName} onChange={(_, d) => setBModelName(d.value)} placeholder="My semantic model" />
                    </Field>
                    {bTables.map((t, ti) => (
                      <div key={ti} className={s.card} style={{ marginTop: 8 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <Field label="Table" style={{ minWidth: 220 }}>
                            <Input value={t.name} onChange={(_, d) => setBTables((p) => p.map((x, i) => i === ti ? { ...x, name: d.value } : x))} />
                          </Field>
                          <Button appearance="subtle" icon={<Delete20Regular />} aria-label="Remove table"
                            onClick={() => setBTables((p) => p.filter((_, i) => i !== ti))} style={{ marginTop: 22 }} />
                        </div>
                        <Caption1 style={{ marginTop: 6 }}>Columns</Caption1>
                        {t.columns.map((c, ci) => (
                          <div key={ci} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                            <Input value={c.name} placeholder="column" onChange={(_, d) => setBTables((p) => p.map((x, i) => i === ti ? { ...x, columns: x.columns.map((y, j) => j === ci ? { ...y, name: d.value } : y) } : x))} />
                            <Select value={c.dataType} onChange={(_, d) => setBTables((p) => p.map((x, i) => i === ti ? { ...x, columns: x.columns.map((y, j) => j === ci ? { ...y, dataType: d.value as BuilderColumn['dataType'] } : y) } : x))}>
                              {PBI_COL_TYPES.map((tp) => <option key={tp} value={tp}>{tp}</option>)}
                            </Select>
                            <Button appearance="subtle" icon={<Delete20Regular />} aria-label="Remove column"
                              onClick={() => setBTables((p) => p.map((x, i) => i === ti ? { ...x, columns: x.columns.filter((_, j) => j !== ci) } : x))} />
                          </div>
                        ))}
                        <Button size="small" appearance="outline" icon={<Add20Regular />} style={{ marginTop: 4 }}
                          onClick={() => setBTables((p) => p.map((x, i) => i === ti ? { ...x, columns: [...x.columns, { name: '', dataType: 'String' }] } : x))}>Add column</Button>
                        <Caption1 style={{ marginTop: 8 }}>Measures (DAX)</Caption1>
                        {t.measures.map((m, mi) => (
                          <div key={mi} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                            <Input value={m.name} placeholder="MeasureName" onChange={(_, d) => setBTables((p) => p.map((x, i) => i === ti ? { ...x, measures: x.measures.map((y, j) => j === mi ? { ...y, name: d.value } : y) } : x))} />
                            <Input value={m.expression} placeholder="SUM(Sales[Amount])" style={{ flex: 1, fontFamily: 'Consolas, monospace' }} onChange={(_, d) => setBTables((p) => p.map((x, i) => i === ti ? { ...x, measures: x.measures.map((y, j) => j === mi ? { ...y, expression: d.value } : y) } : x))} />
                            <Button appearance="subtle" icon={<Delete20Regular />} aria-label="Remove measure"
                              onClick={() => setBTables((p) => p.map((x, i) => i === ti ? { ...x, measures: x.measures.filter((_, j) => j !== mi) } : x))} />
                          </div>
                        ))}
                        <Button size="small" appearance="outline" icon={<Add20Regular />} style={{ marginTop: 4 }}
                          onClick={() => setBTables((p) => p.map((x, i) => i === ti ? { ...x, measures: [...x.measures, { name: '', expression: '' }] } : x))}>Add measure</Button>
                      </div>
                    ))}
                    <Button appearance="outline" icon={<Add20Regular />} style={{ marginTop: 8 }}
                      onClick={() => setBTables((p) => [...p, { name: `Table${p.length + 1}`, columns: [{ name: 'Id', dataType: 'Int64' }], measures: [] }])}>Add table</Button>

                    <Subtitle2 style={{ marginTop: 16 }}>Relationships</Subtitle2>
                    {bRels.map((rl, ri) => (
                      <div key={ri} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                        <Input value={rl.fromTable} placeholder="fromTable" onChange={(_, d) => setBRels((p) => p.map((x, i) => i === ri ? { ...x, fromTable: d.value } : x))} style={{ width: 140 }} />
                        <Input value={rl.fromColumn} placeholder="fromColumn" onChange={(_, d) => setBRels((p) => p.map((x, i) => i === ri ? { ...x, fromColumn: d.value } : x))} style={{ width: 140 }} />
                        <ArrowSync20Regular />
                        <Input value={rl.toTable} placeholder="toTable" onChange={(_, d) => setBRels((p) => p.map((x, i) => i === ri ? { ...x, toTable: d.value } : x))} style={{ width: 140 }} />
                        <Input value={rl.toColumn} placeholder="toColumn" onChange={(_, d) => setBRels((p) => p.map((x, i) => i === ri ? { ...x, toColumn: d.value } : x))} style={{ width: 140 }} />
                        <Button appearance="subtle" icon={<Delete20Regular />} aria-label="Remove relationship" onClick={() => setBRels((p) => p.filter((_, i) => i !== ri))} />
                      </div>
                    ))}
                    <Button size="small" appearance="outline" icon={<Add20Regular />} style={{ marginTop: 4 }}
                      onClick={() => setBRels((p) => [...p, { name: `rel-${p.length + 1}`, fromTable: '', fromColumn: '', toTable: '', toColumn: '', crossFilteringBehavior: 'OneDirection' }])}>Add relationship</Button>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16 }}>
                      <Button appearance="primary" icon={<Save20Regular />} disabled={bBusy || !workspaceId || !bModelName.trim()} onClick={buildModel}>
                        {bBusy ? 'Creating…' : 'Create model'}
                      </Button>
                      {!workspaceId && <Caption1>Select a workspace first.</Caption1>}
                    </div>
                    {bMsg && <MessageBar intent={bMsg.ok ? 'success' : 'error'} style={{ marginTop: 8 }}><MessageBarBody>{bMsg.text}</MessageBarBody></MessageBar>}
                  </>
                )}
                {tab === 'measures' && (
                  <>
                    <MessageBar intent="info">
                      <MessageBarBody>
                        <MessageBarTitle>DAX measure validator (no persistence)</MessageBarTitle>
                        Author + validate a candidate DAX expression server-side via Power BI <code>executeQueries</code>.
                        Persistence into the model requires the <strong>XMLA endpoint</strong> (Premium / Fabric capacity)
                        or Power BI Desktop / Tabular Editor. The validator surfaces the engine's real syntax + semantic
                        errors so you can iterate before opening the model in Desktop.
                      </MessageBarBody>
                    </MessageBar>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
                      <Field label="Table" style={{ minWidth: 200 }}>
                        <Select value={measureTable} onChange={(_, d) => setMeasureTable(d.value)}>
                          <option value="">(select a table)</option>
                          {(detail?.tables || []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                        </Select>
                      </Field>
                      <Field label="Measure name" style={{ minWidth: 200 }}>
                        <Input value={measureName} onChange={(_, d) => setMeasureName(d.value)} placeholder="TotalSales" />
                      </Field>
                    </div>
                    <Caption1 style={{ marginTop: 8 }}>DAX expression</Caption1>
                    <MonacoTextarea
                      value={daxExpr}
                      onChange={setDaxExpr}
                      language="sql"
                      height={140}
                      minHeight={100}
                      ariaLabel="DAX expression editor"
                    />
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                      <Button
                        appearance="primary"
                        icon={<Play20Regular />}
                        disabled={daxBusy || !workspaceId || !datasetId || !measureName.trim() || !measureTable.trim() || !daxExpr.trim()}
                        onClick={validateDax}
                      >
                        {daxBusy ? 'Validating…' : 'Validate DAX'}
                      </Button>
                      {daxResult?.ok && (
                        <Badge appearance="filled" color="success">valid · probe value: <code style={{ marginLeft: 4 }}>{daxResult.value === null || daxResult.value === undefined ? 'NULL' : String(daxResult.value)}</code></Badge>
                      )}
                    </div>
                    {daxResult && !daxResult.ok && (
                      <MessageBar intent="error" style={{ marginTop: 8 }}>
                        <MessageBarBody>
                          <MessageBarTitle>DAX validation failed</MessageBarTitle>
                          {daxResult.error}
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    <Subtitle2 style={{ marginTop: 16 }}>Existing measures</Subtitle2>
                    {(detail?.tables || []).flatMap((t) => (t.measures || []).map((m) => (
                      <div key={`${t.name}-${m.name}`} className={s.card} style={{ marginTop: 8 }}>
                        <Caption1>{t.name}</Caption1>
                        <div style={{ fontWeight: 600 }}>{m.name}</div>
                        <pre style={{ margin: 0, fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>{m.expression || '—'}</pre>
                      </div>
                    )))}
                    {((detail?.tables || []).flatMap((t) => t.measures || []).length === 0) && (
                      <Caption1>No DAX measures returned (or the dataset hasn't exposed its model definition).</Caption1>
                    )}
                  </>
                )}
                {tab === 'refresh' && (
                  <div className={s.tableWrap}>
                    <Table aria-label="Refreshes" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Request ID</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>Status</TableHeaderCell>
                        <TableHeaderCell>Start</TableHeaderCell>
                        <TableHeaderCell>End</TableHeaderCell>
                        <TableHeaderCell>Error</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {refreshes.length === 0 && <TableRow><TableCell colSpan={6}>No refresh history.</TableCell></TableRow>}
                        {refreshes.map((r, i) => (
                          <TableRow key={r.requestId || i}>
                            <TableCell className={s.cell}>{r.requestId?.slice(0, 8) || '—'}</TableCell>
                            <TableCell>{r.refreshType || '—'}</TableCell>
                            <TableCell>{r.status || '—'}</TableCell>
                            <TableCell className={s.cell}>{r.startTime || '—'}</TableCell>
                            <TableCell className={s.cell}>{r.endTime || '—'}</TableCell>
                            <TableCell className={s.cell}>{r.serviceExceptionJson || ''}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
                {tab === 'config' && (
                  <>
                    <Subtitle2>Scheduled refresh</Subtitle2>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      Mirrors the Power BI service Scheduled refresh pane. Writes via PATCH /datasets/{'{'}id{'}'}/refreshSchedule.
                    </Caption1>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10, maxWidth: 560 }}>
                      <Switch label="Keep your data up to date (enable scheduled refresh)" checked={schedEnabled} onChange={(_, d) => setSchedEnabled(d.checked)} />
                      <div>
                        <Caption1>Refresh days</Caption1>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                          {DAYS.map((day) => (
                            <Button key={day} size="small" appearance={schedDays.includes(day) ? 'primary' : 'outline'} onClick={() => toggleSchedDay(day)}>{day.slice(0, 3)}</Button>
                          ))}
                        </div>
                      </div>
                      <Field label="Time(s) — HH:MM on :00 or :30, comma-separated">
                        <Input value={schedTimes} onChange={(_, d) => setSchedTimes(d.value)} placeholder="07:00, 12:30" />
                      </Field>
                      <Field label="Time zone (PBI id)">
                        <Input value={schedTz} onChange={(_, d) => setSchedTz(d.value)} placeholder="UTC" />
                      </Field>
                      <Field label="On failure">
                        <Select value={schedNotify} onChange={(_, d) => setSchedNotify(d.value as 'MailOnFailure' | 'NoNotification')}>
                          <option value="NoNotification">No notification</option>
                          <option value="MailOnFailure">Email the dataset owner on failure</option>
                        </Select>
                      </Field>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <Button appearance="primary" icon={<Save20Regular />} disabled={schedBusy} onClick={saveSchedule}>{schedBusy ? 'Saving…' : 'Apply'}</Button>
                        <Button appearance="outline" disabled={takeoverBusy} onClick={takeOver} title="Take ownership of the dataset (needed if you are not the owner) before editing the schedule">{takeoverBusy ? 'Taking over…' : 'Take over dataset'}</Button>
                      </div>
                      {schedMsg && <MessageBar intent={schedMsg.ok ? 'success' : 'error'}><MessageBarBody>{schedMsg.text}</MessageBarBody></MessageBar>}
                    </div>

                    <Subtitle2 style={{ marginTop: 20 }}>Row-level security (RLS) roles</Subtitle2>
                    <MessageBar intent="warning" style={{ marginTop: 6 }}>
                      <MessageBarBody>
                        <MessageBarTitle>RLS role authoring is XMLA / Desktop only</MessageBarTitle>
                        The Power BI REST API does not expose create/edit of RLS roles or their DAX filters — roles are defined
                        through the <strong>XMLA endpoint</strong> (Premium / Fabric capacity; set <code>LOOM_POWERBI_XMLA_ENDPOINT</code>
                        and use Tabular Editor / a TMSL deploy) or <strong>Power BI Desktop</strong>. Member assignment to existing
                        roles is done in the service. Use <strong>Open in Power BI</strong> above to manage RLS.
                        {detail?.dataset?.isEffectiveIdentityRolesRequired
                          ? ' This dataset requires effective-identity roles for embedding.'
                          : ''}
                      </MessageBarBody>
                    </MessageBar>
                  </>
                )}
                {tab === 'governance' && datasetId && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                    <EndorsementControl workspaceId={workspaceId} itemId={datasetId} itemType="datasets" />
                    <GatewayDatasourcesPanel workspaceId={workspaceId} datasetId={datasetId} />
                  </div>
                )}
                {tab === 'access' && (
                  <ManageAccessPanel workspaceId={workspaceId} />
                )}
                {tab === 'embed' && powerBiConfigured && (
                  <MessageBar intent="info">
                    <MessageBarBody>
                      <MessageBarTitle>Power BI embedding for semantic models</MessageBarTitle>
                      Browse the model metadata and author DAX in the Tables, Relationships, and Measures tabs above. Power BI live-query / external-tool embedding is configured here when a workspace is bound.
                    </MessageBarBody>
                  </MessageBar>
                )}
              </div>
            </>
          )}
        </>
      }
    />
  );
}

// ============================================================
// Report (Power BI)
// ============================================================
// Power BI authoring (visuals, bookmarks, page editor) is out-of-scope for
// the Loom Console — Power BI Desktop / Power BI Web are the supported
// authoring surfaces. The Loom editor is a metadata + embed-viewer + open-
// in-Desktop launcher. Each editor (Report, Dashboard, Scorecard) builds
// an honest inline ribbon (no decorative disabled buttons) below.

interface ReportLite {
  id: string; name: string; embedUrl?: string; webUrl?: string; datasetId?: string;
  modifiedDateTime?: string; modifiedBy?: string; reportType?: string;
}

function ReportLikeEditor({
  item, id, kind, listPath, detailPathBase,
}: {
  item: FabricItemType; id: string; kind: 'report' | 'paginated';
  listPath: string; detailPathBase: string;
}) {
  const s = useStyles();
  // PBI editor — picker MUST surface Power BI groupIds (not Loom UUIDs)
  // or the embed-token / list calls return 404 PowerBIEntityNotFound.
  const ws = usePowerBiWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [reports, setReports] = useState<ReportLite[] | null>(null);
  const [reportId, setReportId] = useState('');
  const [report, setReport] = useState<ReportLite | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [embed, setEmbed] = useState<{ token: string; embedUrl: string; reportId: string } | null>(null);
  const [embedErr, setEmbedErr] = useState<string | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [exportBusy, setExportBusy] = useState<'PDF' | 'PPTX' | 'PNG' | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);
  // Report viewer state — pages, bookmarks, view/edit mode, live embed handle.
  const [pages, setPages] = useState<Array<{ name: string; displayName?: string }>>([]);
  const [activePage, setActivePage] = useState<string>('');
  const [bookmarks, setBookmarks] = useState<Array<{ name: string; displayName: string }>>([]);
  const [editMode, setEditMode] = useState(false);
  const [viewerErr, setViewerErr] = useState<string | null>(null);
  const embedRef = useRef<any>(null);
  // Power BI is opt-in (no-fabric-dependency.md): render Loom-native report
  // metadata by default; expose embed/refresh/export only when configured.
  const powerBiConfigured = !!(ws.workspaces && ws.workspaces.length > 0 && !ws.error);

  const loadList = useCallback(async (wsId: string) => {
    setErr(null);
    try {
      const r = await fetch(`${listPath}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setReports([]); setErr(j.error); return; }
      setReports(j.reports || []);
      setReportId((prev) => prev || (j.reports?.[0]?.id ?? ''));
    } catch (e: any) { setReports([]); setErr(e?.message || String(e)); }
  }, [listPath]);

  const loadDetail = useCallback(async (wsId: string, rId: string) => {
    try {
      const r = await fetch(`${detailPathBase}/${encodeURIComponent(rId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (j.ok) setReport(j.report);
      else setErr(j.error);
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [detailPathBase]);

  // Auto-pick the first Power BI workspace so the list loads and the first
  // report auto-selects — embed/refresh/export enable on load instead of
  // sitting behind a manual workspace pick.
  useEffect(() => {
    if (!workspaceId && ws.workspaces && ws.workspaces.length > 0) setWorkspaceId(ws.workspaces[0].id);
  }, [workspaceId, ws.workspaces]);
  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && reportId) loadDetail(workspaceId, reportId); }, [workspaceId, reportId, loadDetail]);

  // Per-editor ribbon. Authoring (new page / new visual / bookmarks /
  // format / filters) is out-of-scope: Power BI Desktop is the authoring
  // surface, the Loom editor is metadata + embed + launcher. Every action
  // in this ribbon wires to a real handler. See no-vaporware.md.
  const canRefresh = !!workspaceId;
  const refreshSelected = useCallback(() => {
    if (workspaceId) loadList(workspaceId);
    if (workspaceId && reportId) loadDetail(workspaceId, reportId);
  }, [workspaceId, reportId, loadList, loadDetail]);
  const openInDesktop = useCallback(() => {
    if (!report?.webUrl) return;
    try { window.open(report.webUrl, '_blank', 'noreferrer'); } catch { /* popup blocked */ }
  }, [report?.webUrl]);
  const copyReportLink = useCallback(async () => {
    if (!report?.webUrl) return;
    try { await navigator.clipboard.writeText(report.webUrl); } catch { /* ignore */ }
  }, [report?.webUrl]);

  // Refresh the report's underlying semantic model (a report has no data of
  // its own). Hits POST /api/items/report/{id}/refresh which resolves the
  // datasetId and queues a real Power BI dataset refresh. Paginated/RDL
  // reports may not have a refreshable dataset — the route says so honestly.
  const refreshData = useCallback(async () => {
    if (!workspaceId || !reportId) return;
    setRefreshBusy(true); setRefreshMsg(null);
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(reportId)}/refresh`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      const j = await r.json();
      setRefreshMsg(j.ok ? { ok: true, text: 'Dataset refresh queued.' } : { ok: false, text: j.error || `HTTP ${r.status}` });
    } catch (e: any) { setRefreshMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setRefreshBusy(false); }
  }, [workspaceId, reportId]);

  // Export the report to PDF/PPTX via the real Power BI async ExportTo job.
  // The BFF drives start->poll->download and streams the binary back, which
  // we save via an object URL. Paginated reports use a different export SDK,
  // so export is offered for standard PBI reports only.
  const exportReport = useCallback(async (format: 'PDF' | 'PPTX' | 'PNG') => {
    if (!workspaceId || !reportId) return;
    setExportBusy(format); setExportErr(null);
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(reportId)}/export`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, format }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setExportErr(j.error || `export failed (HTTP ${r.status})`);
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${report?.name || 'report'}.${format.toLowerCase()}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e: any) { setExportErr(e?.message || String(e)); }
    finally { setExportBusy(null); }
  }, [workspaceId, reportId, report?.name]);

  // Load the report's pages so the viewer can render a Pages list and the
  // embed can setPage(). Real REST: GET /reports/{id}/pages.
  useEffect(() => {
    if (!workspaceId || !reportId || kind === 'paginated') { setPages([]); setActivePage(''); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/items/report/${encodeURIComponent(reportId)}/pages?workspaceId=${encodeURIComponent(workspaceId)}`);
        const j = await r.json();
        if (cancelled) return;
        if (j.ok) { setPages(j.pages || []); setActivePage((j.pages?.[0]?.name) || ''); }
        else setPages([]);
      } catch { if (!cancelled) setPages([]); }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, reportId, kind]);

  // Pages / bookmarks / refresh-visuals / view-mode all drive the live embed
  // via the powerbi-client report JS API (the same API the Power BI service
  // viewer toolbar uses). embedRef is set by PowerBIEmbedFrame.onEmbedded.
  const gotoPage = useCallback(async (name: string) => {
    setActivePage(name); setViewerErr(null);
    try { await embedRef.current?.setPage?.(name); }
    catch (e: any) { setViewerErr(e?.message || String(e)); }
  }, []);

  const refreshVisuals = useCallback(async () => {
    setViewerErr(null);
    try { await embedRef.current?.refresh?.(); }
    catch (e: any) { setViewerErr(e?.message || String(e)); }
  }, []);

  const reloadBookmarks = useCallback(async () => {
    setViewerErr(null);
    try {
      const list = await embedRef.current?.bookmarksManager?.getBookmarks?.();
      setBookmarks((list || []).map((b: any) => ({ name: b.name, displayName: b.displayName })));
    } catch (e: any) { setViewerErr(e?.message || String(e)); }
  }, []);

  const applyBookmark = useCallback(async (name: string) => {
    setViewerErr(null);
    try { await embedRef.current?.bookmarksManager?.apply?.(name); }
    catch (e: any) { setViewerErr(e?.message || String(e)); }
  }, []);

  // Bookmark slideshow — drives bookmarksManager.play (the Power BI web
  // viewer "View → Bookmarks → View" slideshow). On = cycle bookmarks; Off =
  // stop. Real powerbi-client API; surfaces engine errors verbatim.
  const [slideshow, setSlideshow] = useState(false);
  const toggleSlideshow = useCallback(async () => {
    const next = !slideshow;
    setSlideshow(next); setViewerErr(null);
    try {
      // models.BookmarksPlayMode: On = 0, Off = 1.
      await embedRef.current?.bookmarksManager?.play?.(next ? 0 : 1);
    } catch (e: any) { setViewerErr(e?.message || String(e)); setSlideshow(!next); }
  }, [slideshow]);

  const captureBookmark = useCallback(async () => {
    setViewerErr(null);
    try {
      // Capture the current visual/filter state as a personal (transient)
      // bookmark and apply it; surfaced in the in-session bookmarks list.
      const captured = await embedRef.current?.bookmarksManager?.capture?.();
      if (captured) {
        await embedRef.current?.bookmarksManager?.applyState?.(captured.state);
        setBookmarks((prev) => [
          ...prev,
          { name: captured.name || `capture-${prev.length + 1}`, displayName: `Captured ${new Date().toLocaleTimeString()}` },
        ]);
      }
    } catch (e: any) { setViewerErr(e?.message || String(e)); }
  }, []);

  const toggleEditMode = useCallback(async () => {
    const next = !editMode;
    setEditMode(next); setViewerErr(null);
    try { await embedRef.current?.switchMode?.(next ? 'edit' : 'view'); }
    catch (e: any) { setViewerErr(e?.message || String(e)); }
  }, [editMode]);

  // Mirror the active page when the user navigates inside the embed.
  const onEmbedded = useCallback((embed: any) => {
    embedRef.current = embed;
    try {
      embed?.on?.('loaded', () => { reloadBookmarks(); });
      embed?.on?.('pageChanged', (ev: any) => {
        const name = ev?.detail?.newPage?.name;
        if (name) setActivePage(name);
      });
    } catch { /* event wiring best-effort */ }
  }, [reloadBookmarks]);

  const hasReport = !!reportId;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Open', actions: [
        { label: kind === 'paginated' ? 'Open paginated report' : 'Open in Power BI', onClick: report?.webUrl ? openInDesktop : undefined, disabled: !report?.webUrl, title: !report?.webUrl ? 'select a report first' : 'opens Power BI Web — use Edit there to author' },
        { label: 'Copy link', onClick: report?.webUrl ? copyReportLink : undefined, disabled: !report?.webUrl, title: !report?.webUrl ? 'select a report first' : 'copy the workspace URL to clipboard' },
      ]},
      { label: 'Data', actions: [
        { label: refreshBusy ? 'Refreshing…' : 'Refresh data', onClick: hasReport && !refreshBusy ? refreshData : undefined, disabled: !hasReport || refreshBusy, title: !hasReport ? 'select a report first' : 'queue a refresh of the report’s underlying semantic model' },
        { label: 'Reload metadata', onClick: canRefresh ? refreshSelected : undefined, disabled: !canRefresh, title: !canRefresh ? 'select a workspace first' : 'reload list + selected report metadata' },
      ]},
      ...(kind === 'paginated' ? [] : [{ label: 'Export', actions: [
        { label: exportBusy === 'PDF' ? 'Exporting…' : 'Export PDF', onClick: hasReport && !exportBusy ? () => exportReport('PDF') : undefined, disabled: !hasReport || !!exportBusy, title: !hasReport ? 'select a report first' : 'export the report to PDF via Power BI REST' },
        { label: exportBusy === 'PPTX' ? 'Exporting…' : 'Export PPTX', onClick: hasReport && !exportBusy ? () => exportReport('PPTX') : undefined, disabled: !hasReport || !!exportBusy, title: !hasReport ? 'select a report first' : 'export the report to PowerPoint via Power BI REST' },
        { label: exportBusy === 'PNG' ? 'Exporting…' : 'Export PNG', onClick: hasReport && !exportBusy ? () => exportReport('PNG') : undefined, disabled: !hasReport || !!exportBusy, title: !hasReport ? 'select a report first' : 'export the report to PNG via Power BI REST' },
      ]}]),
      ...(kind === 'paginated' ? [] : [{ label: 'View', actions: [
        { label: 'Refresh visuals', onClick: hasReport ? refreshVisuals : undefined, disabled: !hasReport, title: !hasReport ? 'select a report first' : 'reload the embedded report visuals (report.refresh)' },
        { label: editMode ? 'Switch to View' : 'Switch to Edit', onClick: hasReport ? toggleEditMode : undefined, disabled: !hasReport, title: !hasReport ? 'select a report first' : 'toggle the embedded report between View and Edit modes' },
        { label: 'Capture bookmark', onClick: hasReport ? captureBookmark : undefined, disabled: !hasReport, title: !hasReport ? 'select a report first' : 'capture the current visual + filter state as a personal bookmark' },
        { label: slideshow ? 'Stop slideshow' : 'Play bookmarks', onClick: hasReport ? toggleSlideshow : undefined, disabled: !hasReport, title: !hasReport ? 'select a report first' : 'play the report bookmarks as a slideshow (bookmarksManager.play)' },
      ]}]),
    ]},
  ], [kind, canRefresh, refreshSelected, openInDesktop, copyReportLink, report?.webUrl, hasReport, refreshBusy, refreshData, exportBusy, exportReport, refreshVisuals, editMode, toggleEditMode, captureBookmark, slideshow, toggleSlideshow]);

  // Mint a per-report embed token whenever the selected report changes.
  // Paginated reports use a different SDK (`pbi-paginated`) that we don't
  // support yet, so skip token issuance for them.
  useEffect(() => {
    if (!workspaceId || !reportId || kind === 'paginated') { setEmbed(null); return; }
    let cancelled = false;
    (async () => {
      setEmbedErr(null);
      try {
        const r = await fetch(`/api/items/report/${encodeURIComponent(reportId)}/embed-token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId, accessLevel: editMode ? 'Edit' : 'View' }),
        });
        const j = await r.json();
        if (cancelled) return;
        if (j.ok && j.token && j.embedUrl) setEmbed({ token: j.token, embedUrl: j.embedUrl, reportId: j.reportId });
        else { setEmbedErr(j.error || `HTTP ${r.status}`); setEmbed(null); }
      } catch (e: any) {
        if (!cancelled) setEmbedErr(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, reportId, kind, editMode]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: 8 }}>{kind === 'paginated' ? 'Paginated reports' : 'Reports'}</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {reports && reports.length === 0 && <Caption1>No {kind === 'paginated' ? 'paginated ' : ''}reports in this workspace.</Caption1>}
          <Tree aria-label="Reports">
            {(reports || []).map((r) => (
              <TreeItem key={r.id} itemType="leaf" value={r.id} onClick={() => setReportId(r.id)}>
                <TreeItemLayout>{reportId === r.id ? <strong>{r.name}</strong> : r.name}</TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">{kind === 'paginated' ? 'Paginated report' : 'Power BI report'}</Badge>
            {powerBiConfigured && (
              <>
                <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
                <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Reload</Button>
              </>
            )}
            {report?.webUrl && <Button appearance="outline" onClick={openInDesktop}>Open in Power BI</Button>}
            <Button appearance="primary" icon={refreshBusy ? <Spinner size="tiny" /> : <ArrowSync20Regular />} onClick={refreshData} disabled={!reportId || refreshBusy || !powerBiConfigured} title={!powerBiConfigured ? 'Power BI embed is opt-in; workspace not configured' : undefined}>{refreshBusy ? 'Refreshing…' : 'Refresh data'}</Button>
            {kind !== 'paginated' && powerBiConfigured && (
              <>
                <Button appearance="outline" onClick={() => exportReport('PDF')} disabled={!reportId || !!exportBusy}>{exportBusy === 'PDF' ? 'Exporting…' : 'Export PDF'}</Button>
                <Button appearance="outline" onClick={() => exportReport('PPTX')} disabled={!reportId || !!exportBusy}>{exportBusy === 'PPTX' ? 'Exporting…' : 'Export PPTX'}</Button>
                <Button appearance="outline" onClick={() => exportReport('PNG')} disabled={!reportId || !!exportBusy}>{exportBusy === 'PNG' ? 'Exporting…' : 'Export PNG'}</Button>
                <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={refreshVisuals} disabled={!reportId}>Refresh visuals</Button>
                <Switch label={editMode ? 'Edit mode' : 'View mode'} checked={editMode} onChange={toggleEditMode} disabled={!reportId} />
              </>
            )}
          </div>
          {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          {refreshMsg && <MessageBar intent={refreshMsg.ok ? 'success' : 'error'}><MessageBarBody>{refreshMsg.text}</MessageBarBody></MessageBar>}
          {exportErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Export failed</MessageBarTitle>{exportErr}</MessageBarBody></MessageBar>}
          {!powerBiConfigured && (
            <MessageBar intent="info" style={{ marginBottom: 12 }}>
              <MessageBarBody>
                <MessageBarTitle>Power BI embed is opt-in</MessageBarTitle>
                The Console identity isn&rsquo;t registered in Power BI / not in any workspace. This editor shows report metadata. To enable embedding, dataset refresh, export, and the visual viewer, register the Console UAMI in your Power BI tenant and add it to a workspace. <a href="https://learn.microsoft.com/power-bi/admin/service-principal-api-considerations" target="_blank" rel="noreferrer">Power BI service principal setup</a>.
              </MessageBarBody>
            </MessageBar>
          )}
          {powerBiConfigured && (
            <MessageBar intent="info">
              <MessageBarBody>
                <MessageBarTitle>Visual authoring happens in Power BI Desktop</MessageBarTitle>
                Visuals, pages, bookmarks and the filter pane are authored in <strong>Power BI Desktop</strong> (and the
                Power BI Web editor) — that is by design, not a gap. This pane embeds the live {kind === 'paginated' ? 'paginated ' : ''}report,
                {kind === 'paginated' ? ' links out to Power BI,' : ' triggers a dataset refresh, and exports to PDF/PPTX —'} all against the real
                Power BI REST API. Use <strong>Open in Power BI</strong> to author.
              </MessageBarBody>
            </MessageBar>
          )}
          {report && (
            <>
              <div className={s.card}>
                <Subtitle2>{report.name}</Subtitle2>
                <Caption1>type: {report.reportType || (kind === 'paginated' ? 'PaginatedReport' : 'PowerBIReport')} · datasetId: {report.datasetId || '—'}</Caption1>
                <Caption1>modified: {report.modifiedDateTime || '—'} by {report.modifiedBy || '—'}</Caption1>
                {report.webUrl && <Caption1><a href={report.webUrl} target="_blank" rel="noreferrer">Open in Power BI</a></Caption1>}
              </div>
              {kind !== 'paginated' && reportId && (
                <div className={s.card} style={{ marginTop: 8 }}>
                  <EndorsementControl workspaceId={workspaceId} itemId={reportId} itemType="reports" />
                </div>
              )}
              <div className={s.card} style={{ marginTop: 8 }}>
                <ManageAccessPanel workspaceId={workspaceId} />
              </div>
              {!powerBiConfigured ? (
                <div className={s.card}>
                  <Subtitle2 style={{ marginBottom: 12 }}>Report metadata (Loom-native view)</Subtitle2>
                  <Caption1 style={{ marginBottom: 8, display: 'block' }}>To embed the live report and enable refresh/export, configure Power BI workspace access above.</Caption1>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div><strong>Name:</strong> {report?.name || '—'}</div>
                    <div><strong>Type:</strong> {report?.reportType || (kind === 'paginated' ? 'PaginatedReport' : 'PowerBIReport')}</div>
                    <div><strong>Dataset ID:</strong> {report?.datasetId || '—'}</div>
                    {report?.webUrl && <div><strong>Web URL:</strong> <a href={report.webUrl} target="_blank" rel="noreferrer">{report.webUrl}</a></div>}
                  </div>
                </div>
              ) : kind === 'paginated' ? (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Paginated report embed not yet wired</MessageBarTitle>
                    Power BI Paginated Reports use the <code>pbi-paginated</code> SDK which is separate from the
                    standard powerbi-client. Use "Open in Power BI" above; an in-place embed lands in a follow-up PR.
                  </MessageBarBody>
                </MessageBar>
              ) : embedErr ? (
                <MessageBar intent="error">
                  <MessageBarBody>
                    <MessageBarTitle>Could not mint embed token</MessageBarTitle>
                    {embedErr}. Confirm the Console UAMI is added to this workspace (Member or above) and that the tenant setting
                    <strong> "Service principals can use Fabric APIs"</strong> is enabled with the UAMI's security group.
                  </MessageBarBody>
                </MessageBar>
              ) : embed ? (
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ width: 220, flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div className={s.card}>
                      <Subtitle2 style={{ marginBottom: 6 }}>Pages ({pages.length})</Subtitle2>
                      {pages.length === 0 && <Caption1>No pages reported.</Caption1>}
                      <Tree aria-label="Report pages">
                        {pages.map((p) => (
                          <TreeItem key={p.name} itemType="leaf" value={p.name} onClick={() => gotoPage(p.name)}>
                            <TreeItemLayout>{activePage === p.name ? <strong>{p.displayName || p.name}</strong> : (p.displayName || p.name)}</TreeItemLayout>
                          </TreeItem>
                        ))}
                      </Tree>
                    </div>
                    <div className={s.card}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <Subtitle2>Bookmarks ({bookmarks.length})</Subtitle2>
                        <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={reloadBookmarks} title="reload report bookmarks" />
                      </div>
                      {bookmarks.length === 0 && <Caption1>No bookmarks. Use Capture bookmark.</Caption1>}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {bookmarks.map((b) => (
                          <Button key={b.name} size="small" appearance="subtle" onClick={() => applyBookmark(b.name)} style={{ justifyContent: 'flex-start' }}>{b.displayName || b.name}</Button>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        <Button size="small" appearance="outline" icon={<Add20Regular />} onClick={captureBookmark}>Capture</Button>
                        <Button size="small" appearance={slideshow ? 'primary' : 'outline'} icon={<Play20Regular />} onClick={toggleSlideshow}>{slideshow ? 'Stop' : 'Play'}</Button>
                      </div>
                    </div>
                  </div>
                  <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    {viewerErr && <MessageBar intent="error" style={{ marginBottom: 8 }}><MessageBarBody>{viewerErr}</MessageBarBody></MessageBar>}
                    <PowerBIEmbedFrame
                      embedType="report"
                      id={embed.reportId}
                      embedUrl={embed.embedUrl}
                      accessToken={embed.token}
                      height={620}
                      edit={editMode}
                      pageName={activePage || undefined}
                      onEmbedded={onEmbedded}
                    />
                  </div>
                </div>
              ) : (
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Loading embed token…</Caption1>
              )}
            </>
          )}
        </div>
      }
    />
  );
}

export function ReportEditor({ item, id }: { item: FabricItemType; id: string }) {
  return <ReportLikeEditor item={item} id={id} kind="report" listPath="/api/items/report" detailPathBase="/api/items/report" />;
}
export function PaginatedReportEditor({ item, id }: { item: FabricItemType; id: string }) {
  return <ReportLikeEditor item={item} id={id} kind="paginated" listPath="/api/items/paginated-report" detailPathBase="/api/items/paginated-report" />;
}

// ============================================================
// Dashboard (Power BI)
// ============================================================
interface DashboardLite { id: string; displayName: string; webUrl?: string; embedUrl?: string; isReadOnly?: boolean; }
interface TileLite { id: string; title?: string; subTitle?: string; reportId?: string; datasetId?: string; embedUrl?: string; rowSpan?: number; colSpan?: number; }

export function DashboardEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  // PBI editor — picker MUST surface Power BI groupIds (not Loom UUIDs)
  // or the embed-token / list calls return 404 PowerBIEntityNotFound.
  const ws = usePowerBiWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [dashboards, setDashboards] = useState<DashboardLite[] | null>(null);
  const [dashId, setDashId] = useState('');
  const [tiles, setTiles] = useState<TileLite[]>([]);
  const [selectedTile, setSelectedTile] = useState<TileLite | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [embed, setEmbed] = useState<{ token: string; embedUrl: string; dashboardId: string } | null>(null);
  const [embedErr, setEmbedErr] = useState<string | null>(null);

  const selectedDash = (dashboards || []).find((d) => d.id === dashId);

  const loadList = useCallback(async (wsId: string) => {
    setErr(null);
    try {
      const r = await fetch(`/api/items/dashboard?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setDashboards([]); setErr(j.error); return; }
      setDashboards(j.dashboards || []);
      setDashId((prev) => prev || (j.dashboards?.[0]?.id ?? ''));
    } catch (e: any) { setDashboards([]); setErr(e?.message || String(e)); }
  }, []);

  const loadDetail = useCallback(async (wsId: string, dId: string) => {
    setSelectedTile(null);
    try {
      const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (j.ok) setTiles(j.tiles || []); else setErr(j.error);
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, []);

  // Auto-pick the first Power BI workspace so the list loads and the first
  // dashboard auto-selects — embed enables on load instead of behind a pick.
  useEffect(() => {
    if (!workspaceId && ws.workspaces && ws.workspaces.length > 0) setWorkspaceId(ws.workspaces[0].id);
  }, [workspaceId, ws.workspaces]);
  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && dashId) loadDetail(workspaceId, dashId); }, [workspaceId, dashId, loadDetail]);

  useEffect(() => {
    if (!workspaceId || !dashId) { setEmbed(null); return; }
    let cancelled = false;
    (async () => {
      setEmbedErr(null);
      try {
        const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dashId)}/embed-token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        });
        const j = await r.json();
        if (cancelled) return;
        if (j.ok && j.token && j.embedUrl) setEmbed({ token: j.token, embedUrl: j.embedUrl, dashboardId: j.dashboardId });
        else { setEmbedErr(j.error || `HTTP ${r.status}`); setEmbed(null); }
      } catch (e: any) {
        if (!cancelled) setEmbedErr(e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, dashId]);

  const refreshDash = useCallback(() => {
    if (workspaceId) loadList(workspaceId);
    if (workspaceId && dashId) loadDetail(workspaceId, dashId);
  }, [workspaceId, dashId, loadList, loadDetail]);
  const openDashInPbi = useCallback(() => {
    if (selectedDash?.webUrl) window.open(selectedDash.webUrl, '_blank', 'noreferrer');
  }, [selectedDash?.webUrl]);
  const copyDashLink = useCallback(async () => {
    if (selectedDash?.webUrl) { try { await navigator.clipboard.writeText(selectedDash.webUrl); } catch { /* ignore */ } }
  }, [selectedDash?.webUrl]);
  const dashRibbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Open', actions: [
        { label: 'Open in Power BI', onClick: selectedDash?.webUrl ? openDashInPbi : undefined, disabled: !selectedDash?.webUrl, title: !selectedDash?.webUrl ? 'select a dashboard first' : 'opens Power BI Web — use Edit there to author' },
        { label: 'Copy link', onClick: selectedDash?.webUrl ? copyDashLink : undefined, disabled: !selectedDash?.webUrl, title: !selectedDash?.webUrl ? 'select a dashboard first' : 'copy the dashboard URL to clipboard' },
      ]},
      { label: 'Metadata', actions: [
        { label: 'Refresh', onClick: workspaceId ? refreshDash : undefined, disabled: !workspaceId, title: !workspaceId ? 'select a workspace first' : 'reload list + selected dashboard tiles' },
      ]},
    ]},
  ], [selectedDash?.webUrl, workspaceId, openDashInPbi, copyDashLink, refreshDash]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={dashRibbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: 8 }}>Dashboards</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {dashboards && dashboards.length === 0 && <Caption1>No dashboards in this workspace.</Caption1>}
          <Tree aria-label="Dashboards">
            {(dashboards || []).map((d) => (
              <TreeItem key={d.id} itemType="leaf" value={d.id} onClick={() => setDashId(d.id)}>
                <TreeItemLayout>{dashId === d.id ? <strong>{d.displayName}</strong> : d.displayName}</TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Power BI dashboard</Badge>
            <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh</Button>
            {selectedDash?.webUrl && <Button appearance="primary" onClick={openDashInPbi} style={{ marginLeft: 'auto' }}>Open in Power BI</Button>}
          </div>
          {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Loom is a metadata + viewer surface for Power BI dashboards</MessageBarTitle>
              Authoring (pin visual, new tile, dashboard theme) lives in <strong>Power BI Web</strong>. The Loom
              editor lists dashboards, shows tile metadata, refreshes the cache, and embeds the dashboard read-only
              for preview. Use <strong>Open in Power BI</strong> to author or pin new tiles.
            </MessageBarBody>
          </MessageBar>
          {embedErr ? (
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>Could not mint embed token</MessageBarTitle>
                {embedErr}. Confirm the Console UAMI is added to this workspace and that "Service principals can use Fabric APIs" is enabled.
              </MessageBarBody>
            </MessageBar>
          ) : embed ? (
            <PowerBIEmbedFrame
              embedType="dashboard"
              id={embed.dashboardId}
              embedUrl={embed.embedUrl}
              accessToken={embed.token}
              height={620}
            />
          ) : (
            dashId && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Loading embed token…</Caption1>
          )}
          <Subtitle2>Tiles ({tiles.length})</Subtitle2>
          <div className={s.cardGrid}>
            {tiles.map((t) => (
              <div key={t.id} className={s.card} style={{ cursor: 'pointer', borderColor: selectedTile?.id === t.id ? tokens.colorBrandStroke1 : undefined }} onClick={() => setSelectedTile(t)}>
                <Caption1>{t.subTitle || 'tile'}</Caption1>
                <div style={{ fontWeight: 600 }}>{t.title || t.id}</div>
                <Caption1>{t.rowSpan && t.colSpan ? `${t.colSpan}×${t.rowSpan}` : ''}</Caption1>
              </div>
            ))}
            {tiles.length === 0 && dashId && <Caption1>Dashboard has no tiles.</Caption1>}
          </div>
          {selectedTile && (
            <div className={s.card}>
              <Subtitle2>Tile detail</Subtitle2>
              <Caption1>id: <code>{selectedTile.id}</code></Caption1>
              <Caption1>reportId: <code>{selectedTile.reportId || '—'}</code></Caption1>
              <Caption1>datasetId: <code>{selectedTile.datasetId || '—'}</code></Caption1>
              <Caption1>embedUrl: <code style={{ fontSize: 11 }}>{selectedTile.embedUrl || '—'}</code></Caption1>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Button
                  size="small"
                  appearance="primary"
                  disabled={!selectedTile.reportId || !workspaceId}
                  title={selectedTile.reportId ? 'open the report this tile drills to in Power BI' : 'this tile is not backed by a report'}
                  onClick={() => {
                    if (!selectedTile.reportId || !workspaceId) return;
                    const url = `https://app.powerbi.com/groups/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(selectedTile.reportId)}`;
                    try { window.open(url, '_blank', 'noreferrer'); } catch { /* popup blocked */ }
                  }}
                >
                  Drill to report
                </Button>
              </div>
            </div>
          )}
        </div>
      }
    />
  );
}

// ============================================================
// Scorecard (Fabric)
// ============================================================
interface ScorecardLite { id: string; displayName: string; description?: string; }
interface GoalLite { id?: string; name?: string; description?: string; currentValue?: number; targetValue?: number; }

export function ScorecardEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  // PBI editor — picker MUST surface Power BI groupIds (not Loom UUIDs)
  // or the embed-token / list calls return 404 PowerBIEntityNotFound.
  const ws = usePowerBiWorkspaces();
  const [workspaceId, setWorkspaceId] = useState('');
  const [scorecards, setScorecards] = useState<ScorecardLite[] | null>(null);
  const [scorecardId, setScorecardId] = useState('');
  const [goals, setGoals] = useState<GoalLite[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [entryOpen, setEntryOpen] = useState<{ goalId: string } | null>(null);
  const [entryValue, setEntryValue] = useState('');
  const [entryTarget, setEntryTarget] = useState('');
  const [entryNote, setEntryNote] = useState('');
  const [entryBusy, setEntryBusy] = useState(false);
  const [entryErr, setEntryErr] = useState<string | null>(null);

  const loadList = useCallback(async (wsId: string) => {
    setErr(null);
    try {
      const r = await fetch(`/api/items/scorecard?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (!j.ok) { setScorecards([]); setErr(j.error); return; }
      setScorecards(j.scorecards || []);
      setScorecardId((prev) => prev || (j.scorecards?.[0]?.id ?? ''));
    } catch (e: any) { setScorecards([]); setErr(e?.message || String(e)); }
  }, []);

  const loadGoals = useCallback(async (wsId: string, scId: string) => {
    try {
      const r = await fetch(`/api/items/scorecard/${encodeURIComponent(scId)}?workspaceId=${encodeURIComponent(wsId)}`);
      const j = await r.json();
      if (j.ok) setGoals(j.goals || []); else setErr(j.error);
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, []);

  // Auto-pick the first Power BI workspace so the list loads and the first
  // scorecard auto-selects — Open in Power BI / Refresh enable on load.
  useEffect(() => {
    if (!workspaceId && ws.workspaces && ws.workspaces.length > 0) setWorkspaceId(ws.workspaces[0].id);
  }, [workspaceId, ws.workspaces]);
  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  useEffect(() => { if (workspaceId && scorecardId) loadGoals(workspaceId, scorecardId); }, [workspaceId, scorecardId, loadGoals]);

  const submitValue = useCallback(async () => {
    if (!entryOpen || !workspaceId || !scorecardId) return;
    const value = Number(entryValue);
    if (!Number.isFinite(value)) { setEntryErr('numeric value required'); return; }
    setEntryBusy(true); setEntryErr(null);
    try {
      const r = await fetch(`/api/items/scorecard/${encodeURIComponent(scorecardId)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goalId: entryOpen.goalId, value, targetValue: entryTarget ? Number(entryTarget) : undefined, noteText: entryNote || undefined }),
      });
      const j = await r.json();
      if (!j.ok) { setEntryErr(j.error || 'submit failed'); return; }
      setEntryOpen(null); setEntryValue(''); setEntryTarget(''); setEntryNote('');
      loadGoals(workspaceId, scorecardId);
    } finally { setEntryBusy(false); }
  }, [entryOpen, entryValue, entryTarget, entryNote, workspaceId, scorecardId, loadGoals]);

  const refreshScorecard = useCallback(() => {
    if (workspaceId) loadList(workspaceId);
    if (workspaceId && scorecardId) loadGoals(workspaceId, scorecardId);
  }, [workspaceId, scorecardId, loadList, loadGoals]);
  const openScorecardInPbi = useCallback(() => {
    if (workspaceId && scorecardId) {
      const url = `https://app.powerbi.com/groups/${encodeURIComponent(workspaceId)}/scorecards/${encodeURIComponent(scorecardId)}`;
      window.open(url, '_blank', 'noreferrer');
    }
  }, [workspaceId, scorecardId]);
  const scRibbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Open', actions: [
        { label: 'Open in Power BI', onClick: scorecardId ? openScorecardInPbi : undefined, disabled: !scorecardId, title: !scorecardId ? 'select a scorecard first' : 'opens Power BI Web — Fabric scorecard authoring lives there' },
      ]},
      { label: 'Metadata', actions: [
        { label: 'Refresh', onClick: workspaceId ? refreshScorecard : undefined, disabled: !workspaceId, title: !workspaceId ? 'select a workspace first' : 'reload list + selected scorecard goals' },
      ]},
    ]},
  ], [scorecardId, workspaceId, openScorecardInPbi, refreshScorecard]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={scRibbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: 8 }}>Scorecards</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace.</Caption1>}
          {scorecards && scorecards.length === 0 && <Caption1>No scorecards in this workspace.</Caption1>}
          <Tree aria-label="Scorecards">
            {(scorecards || []).map((sc) => (
              <TreeItem key={sc.id} itemType="leaf" value={sc.id} onClick={() => setScorecardId(sc.id)}>
                <TreeItemLayout>{scorecardId === sc.id ? <strong>{sc.displayName}</strong> : sc.displayName}</TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Badge appearance="filled" color="brand">Scorecard</Badge>
            <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
            <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => workspaceId && loadList(workspaceId)} disabled={!workspaceId}>Refresh</Button>
            {scorecardId && <Button appearance="primary" onClick={openScorecardInPbi} style={{ marginLeft: 'auto' }}>Open in Power BI</Button>}
          </div>
          {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Fabric Scorecard preview surface</MessageBarTitle>
              Scorecard authoring (goals, connections, hierarchy, status rules) lives in <strong>Power BI Web</strong>.
              The Loom editor lists scorecards in the workspace, surfaces goals + current/target values, and lets
              you record a goal value via the inline <em>Add value</em> dialog (Fabric scorecards REST is preview).
              Use <strong>Open in Power BI</strong> to author.
            </MessageBarBody>
          </MessageBar>
          {scorecardId && (
            <>
              <Subtitle2>Goals ({goals.length})</Subtitle2>
              {goals.length === 0 ? (
                <Caption1>No goals on this scorecard (or the Fabric scorecard preview API is not enabled in this tenant).</Caption1>
              ) : (
                <div className={s.tableWrap}>
                  <Table aria-label="Goals" size="small">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Goal</TableHeaderCell>
                      <TableHeaderCell>Current</TableHeaderCell>
                      <TableHeaderCell>Target</TableHeaderCell>
                      <TableHeaderCell></TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {goals.map((g, i) => (
                        <TableRow key={g.id || i}>
                          <TableCell>{g.name || g.id || '—'}</TableCell>
                          <TableCell>{g.currentValue ?? '—'}</TableCell>
                          <TableCell>{g.targetValue ?? '—'}</TableCell>
                          <TableCell>
                            {g.id && <Button size="small" appearance="subtle" onClick={() => { setEntryOpen({ goalId: g.id! }); setEntryTarget(g.targetValue?.toString() || ''); }}>Add value</Button>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}

          <Dialog open={!!entryOpen} onOpenChange={(_: unknown, d: any) => { if (!d.open) setEntryOpen(null); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Add goal value</DialogTitle>
                <DialogContent>
                  <Caption1>value</Caption1>
                  <Input value={entryValue} onChange={(_: unknown, d: any) => setEntryValue(d.value)} type="number" style={{ width: '100%' }} />
                  <Caption1 style={{ marginTop: 8 }}>target (optional)</Caption1>
                  <Input value={entryTarget} onChange={(_: unknown, d: any) => setEntryTarget(d.value)} type="number" style={{ width: '100%' }} />
                  <Caption1 style={{ marginTop: 8 }}>note (optional)</Caption1>
                  <Input value={entryNote} onChange={(_: unknown, d: any) => setEntryNote(d.value)} style={{ width: '100%' }} />
                  {entryErr && <MessageBar intent="error" style={{ marginTop: 8 }}><MessageBarBody>{entryErr}</MessageBarBody></MessageBar>}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setEntryOpen(null)}>Cancel</Button>
                  <Button appearance="primary" disabled={entryBusy || !entryValue} onClick={submitValue}>{entryBusy ? 'Saving…' : 'Save'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}
