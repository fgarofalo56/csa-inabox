'use client';

/**
 * Phase 3 editors — Real-Time Intelligence, Data Warehouse, Power BI.
 *
 * v2.1 KQL family (Eventhouse, KQL Database, KQL Queryset, KQL Dashboard,
 * Eventstream) are wired live against the shared Loom ADX cluster
 * (default `adx-csa-loom-shared` in `eastus2`, cloud-correct suffix) via the Console UAMI
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
import type { WarehouseContent, RollupMethod, StatusColor, StatusOperator, StatusMetricKind, StatusRule } from '@/lib/apps/content-bundles/types';
import {
  Subtitle2, Caption1, Badge, Button, Input, Spinner, Field, Link,
  Card, Divider,
  Tab, TabList, Dropdown, Option,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Tooltip,
  Dialog, DialogTrigger, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  Label, Select, Textarea, Switch, Checkbox, ProgressBar, SpinButton,
  makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular, Folder20Regular,
  Save20Regular, Add20Regular, Delete20Regular, ArrowSync20Regular, Stop20Regular,
  MathFormula20Regular, Table20Regular, DatabaseLink20Regular,
  Flowchart20Regular,
  Apps20Regular, List20Regular, Open20Regular,
  Sparkle16Regular, Info16Regular, Wrench16Regular,
  Warning20Regular, ErrorCircle20Regular, CheckmarkCircle20Regular, Info20Regular,
  DataBarVertical20Regular,
  ArrowImport20Regular,
  Eye20Regular, Form20Regular,
  ArrowMaximize20Regular, Pin20Regular, Flash20Regular, Sparkle20Regular,
  ArrowDownload20Regular, Copy20Regular, Edit20Regular,
} from '@fluentui/react-icons';
import { AdxDatabaseTree } from '@/lib/components/adx/adx-database-tree';
import { AdxRbacPanel } from '@/lib/components/adx/adx-rbac-panel';
import { AdxClusterEditor } from '@/lib/components/adx/adx-cluster-editor';
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
import { TimeSeriesChart } from '@/lib/components/adx/time-series-chart';
// Wave-3 Model-view extras (Azure-native by DEFAULT, no Fabric/Power BI required):
// what-if parameters, quick measures, calculated tables, and Q&A synonyms — each
// section owns its real BFF save flow + persists onto the owned item's state.model.
import { ItemEditorChrome } from './item-editor-chrome';
import { OpenInPbiDesktopButton } from './components/open-in-pbi-desktop-button';
import { NotConfiguredBar, type NotConfiguredHint } from '@/lib/components/admin-security/not-configured-bar';
import { EmptyState } from '@/lib/components/empty-state';
import type {
  RdlReportDefinition, RdlDataSource, RdlDataset, RdlTablix, RdlParameter,
  RdlField, RdlDataSourceType, RdlExportFormat,
} from '@/lib/azure/paginated-report-client';
import { WarehouseMonitoringTab } from './components/warehouse-monitoring';
import { NewItemCreateGate } from './new-item-gate';
import { openCopilotWithPersona } from '@/lib/components/copilot-pane';
import { StatsMaintenanceDialog } from './components/stats-maintenance-dialog';
import { SqlObjectScriptMenu, SqlRowCountBadge } from '@/lib/components/sql-object-script-menu';
import { sqlRowCount, loadSqlScript } from './sql-explorer-helpers';
import type { ScriptObjectType, ScriptMode } from '@/lib/azure/sql-object-scripting';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { useSqlTabs, SqlTabBar, getRunSql } from '@/lib/components/editor/sql-editor-kit';
import { registerSqlIntelliSense, createEmptyCache, type SqlSchemaCache } from '@/lib/components/editor/sql-intellisense';
import { WarehouseAlerts } from './components/warehouse-alerts';
import { WarehouseAcceleration } from './components/warehouse-acceleration';
import {
  useWarehouseCopilot,
  WarehouseCopilotActions,
  WarehouseCopilotPanels,
} from './warehouse-editor';
import { VisualQueryCanvas } from './components/visual-query-canvas';
import { PowerBIEmbedFrame } from '@/lib/components/embed/powerbi-embed';
import { ComputePicker } from '@/lib/components/compute-picker';
import { SqlSecurityPanel } from '@/lib/panes/sql-security-panel';
import { QueryParamsBar, substituteSynapse, type QueryParam } from './components/query-params';
import { ResultVisualize } from './components/result-visualize';
import { SqlMigrationWizard } from './sql-migration-wizard';
import {
  evalConditionalRules,
  CF_OPERATORS, CF_COLORS, CF_ICONS, CF_THEMES,
  type ConditionalRule, type CfCondition, type CfMatch,
  type CfColor, type CfIcon, type CfOperator, type CfTheme,
} from '@/lib/azure/kql-dashboard-model';

import { useStyles } from './phase3/styles';

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

/**
 * Serialise a Kusto result (columns + rows) to RFC-4180 CSV. Fields containing
 * a comma, quote, or newline are double-quoted with embedded quotes doubled;
 * null/undefined become empty cells; objects/arrays are JSON-stringified so a
 * dynamic column round-trips. Used by the KQL Dashboard tile export (download +
 * clipboard) — the same client-side result already rendered in the tile, so no
 * backend round-trip is needed.
 */
function kqlResultToCsv(columns: string[], rows: unknown[][]): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const header = columns.map(esc).join(',');
  const body = rows.map((r) => columns.map((_, c) => esc(r[c])).join(',')).join('\r\n');
  return rows.length ? `${header}\r\n${body}` : header;
}

/** Trigger a browser download of `text` as `filename` (client-only; no-op SSR). */
function downloadTextFile(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Slugify a tile title into a safe-ish filename stem. */
function slugifyForFile(s: string): string {
  return (s || 'tile').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'tile';
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
      padding: tokens.spacingVerticalL, minHeight: 120, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
      background: deco?.bg ?? tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS }}>
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
    <div style={{ display: 'flex', gap: tokens.spacingVerticalM, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg width={240} height={240} viewBox="0 0 240 240" role="img" aria-label="pie chart">
        {arcs.map((a, i) => <path key={i} d={a.path} fill={a.color} stroke={tokens.colorNeutralBackground1} strokeWidth={1}
          style={onValueClick ? { cursor: 'pointer' } : undefined}
          onClick={onValueClick ? () => onValueClick(a.label) : undefined}><title>{`${a.label}: ${a.value.toLocaleString()}${onValueClick ? ' (click to drill through)' : ''}`}</title></path>)}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS }}>
        {arcs.map((a, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS }}>
            <span style={{ width: 10, height: 10, background: a.color, borderRadius: tokens.borderRadiusSmall, display: 'inline-block' }} />
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
      style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, background: tokens.colorNeutralBackground2 }}>
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
        style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, background: tokens.colorNeutralBackground1 }}>
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
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${kind} chart`} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, background: tokens.colorNeutralBackground1 }}>
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
    case 'line':
    case 'timechart':
      // Rich RTI time-series visual: legend search, pin & overlay, multi-panel,
      // Y-axis scaling, and a zoom range slider over the real ADX series. Drill-
      // through (single-value click) is not meaningful on a multi-series line,
      // so the timeSeries control surface is preferred when available; when
      // drill-through is wired the simpler clickable ResultChart is kept.
      if (!dtActive) {
        return <TimeSeriesChart columns={columns} rows={rows} columnTypes={result.columnTypes} />;
      }
      return <ResultChart columns={columns} rows={rows} kind={viz} onValueClick={chartClick} />;
    case 'bar':
    case 'column':
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
    <div style={{ maxHeight: 200, overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium }}>
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
                    <TableCell key={j} style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase100, whiteSpace: 'nowrap', backgroundColor: bg, color: fg }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingVerticalXS }}>
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

function KqlResultsPanel({ result, loading, itemId, itemType }: { result: KqlResult | null; loading: boolean; itemId?: string; itemType?: string }) {
  const s = useStyles();
  // F19 — sensitivity-label export protection. When this panel belongs to a
  // labeled item, gate CSV export through the real /export-check BFF route so a
  // protected label blocks the download (encryption can't survive CSV/TXT).
  const onExportCheck = useMemo(() => {
    if (!itemId || !itemType) return undefined;
    return async (): Promise<{ blocked: boolean; reason?: string }> => {
      try {
        const r = await fetch(`/api/items/${itemType}/${itemId}/export-check`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ format: 'csv' }),
        });
        const j = await r.json().catch(() => ({}));
        return { blocked: !!j?.blocked, reason: j?.reason };
      } catch {
        // Network/route failure must not silently block a legitimate export.
        return { blocked: false };
      }
    };
  }, [itemId, itemType]);
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
    return (
      <div className={s.resultBox}>
        <EmptyState
          icon={<Play20Regular />}
          title="No results yet"
          body="Run the query to execute it against the cluster — results, charts, and the | render visualization appear here."
        />
      </div>
    );
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
          <div style={{ marginLeft: 'auto', display: 'flex', gap: tokens.spacingVerticalXS, flexWrap: 'wrap' }} role="tablist" aria-label="Result view">
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
        <EmptyState
          icon={<DataBarVertical20Regular />}
          title="Query returned no rows"
          body="The query executed successfully but produced no rows. Adjust the time range or filters and run it again."
        />
      ) : viz !== 'table' ? (
        <TileVisual viz={viz} result={result} />
      ) : (
        <KustoResultsGrid
          columns={columns}
          columnTypes={result.columnTypes}
          rows={rows}
          totalRowCount={result.rowCount}
          exportName={`kql-${result.database || 'results'}`}
          onExportCheck={onExportCheck}
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL }}>
      {/* Section 1 — Throttle state */}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalM, flexWrap: 'wrap' }}>
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
              <div style={{ fontSize: tokens.fontSizeBase500, fontWeight: 600, color: pct !== undefined ? utilColor(pct) : undefined }}>{display}</div>
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
        <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS }}>
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
                        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS, minWidth: 120 }}>
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
      <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
        <Subtitle2>Ingestion capacity policy</Subtitle2>
        <Caption1>
          Caps total concurrent ingestion operations. Effective slots ={' '}
          <code>Minimum(ClusterMaximumConcurrentOperations, nodes × max(1, cores × CoreUtilizationCoefficient))</code>.
          Applied via <code>.alter-merge cluster policy capacity</code> — changes can take up to an hour to take effect.
          Microsoft recommends consulting support before changing capacity.
        </Caption1>
        <div style={{ display: 'flex', gap: tokens.spacingVerticalL, flexWrap: 'wrap' }}>
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
                ? <span style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, wordBreak: 'break-all' }}>
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
      <div className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
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
      padding: tokens.spacingVerticalL, minHeight: 92, border: `1px solid ${tokens.colorNeutralStroke2}`,
      borderRadius: tokens.borderRadiusLarge, background: tokens.colorNeutralBackground1, display: 'flex',
      flexDirection: 'column', gap: tokens.spacingVerticalXXS, boxShadow: tokens.shadow4,
    }}>
      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{label}</Caption1>
      <div style={{ fontSize: tokens.fontSizeBase600, fontWeight: 700, color: tokens.colorBrandForeground1, lineHeight: 1.15 }}>{value}</div>
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
          style={{ marginLeft: tokens.spacingHorizontalS }}
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: tokens.spacingVerticalM }}>
            <div className={s.card}>
              <Subtitle2>Top databases by query count</Subtitle2>
              <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS }}>
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
              <div className={s.tableWrap} style={{ marginTop: tokens.spacingVerticalS }}>
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
  // Workspace item record — used by "New dashboard" to resolve workspaceId so
  // the new kql-dashboard lands in the same workspace as this eventhouse. Reads
  // from the React Query cache page.tsx already seeded (same ['item','eventhouse',id]
  // key), so it does NOT fire an extra network request in normal use.
  const { data: itemRecord } = useQuery<WorkspaceItem>({
    queryKey: ['item', 'eventhouse', id],
    queryFn: () => getItem('eventhouse', id),
    enabled: !!(id && id !== 'new'),
    staleTime: 60_000,
  });
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
  // "New dashboard" dialog state — Fabric Eventhouse ribbon parity.
  const [newDashOpen, setNewDashOpen] = useState(false);
  const [newDashName, setNewDashName] = useState('');
  const [newDashBusy, setNewDashBusy] = useState(false);
  const [newDashErr, setNewDashErr] = useState<string | null>(null);

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

  /**
   * Create a kql-dashboard item in the same workspace as this eventhouse,
   * seed a starter tile + a data source bound to the current (or default)
   * KQL database, then navigate to the new dashboard. Mirrors Fabric's
   * Eventhouse "New dashboard" ribbon action (prompt for name → create
   * dashboard pre-wired to a KQL database data source → land on canvas).
   *
   * Azure-native: Cosmos item creation via POST /api/workspaces/<wsId>/items,
   * then PUT /api/items/kql-dashboard/<id> to seed the data source + tile.
   * Tiles execute against the shared ADX cluster. No Fabric REST involved,
   * works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
   */
  const createDashboard = useCallback(async () => {
    const wsId = itemRecord?.workspaceId;
    const dbName = selectedDb || state?.defaultDatabase || '';
    const displayName =
      newDashName.trim() || `${item.displayName ?? 'Eventhouse'} — Dashboard`;
    if (!wsId) {
      // No workspace context yet (item not loaded). Fall back to empty new-item flow.
      setNewDashOpen(false);
      router.push('/items/kql-dashboard/new');
      return;
    }
    setNewDashBusy(true);
    setNewDashErr(null);
    try {
      // Step 1: create the Cosmos record (POST /api/workspaces/<wsId>/items).
      const created = await createItem(wsId, { itemType: 'kql-dashboard', displayName });
      // Step 2: seed a data source bound to the current DB + a starter tile
      //         (PUT /api/items/kql-dashboard/<id>). The starter tile runs a
      //         real `print` against the ADX database so the dashboard opens
      //         non-empty and every control is immediately editable.
      if (dbName) {
        const dsId = crypto.randomUUID();
        const seedRes = await fetch(`/api/items/kql-dashboard/${created.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tiles: [{
              title: 'Getting started',
              kql: `print Note="Dashboard wired to the '${dbName}' KQL database. Edit this tile to query your tables."`,
              viz: 'table',
              dataSourceId: dsId,
            }],
            dataSources: [{ id: dsId, name: dbName, database: dbName }],
            parameters: [],
            baseQueries: [],
            timeRange: 'last-24h',
          }),
        });
        if (!seedRes.ok) {
          const j = await seedRes.json().catch(() => ({}));
          throw new Error(j?.error || `seed failed (HTTP ${seedRes.status})`);
        }
      }
      // Step 3: navigate. Receipt = user lands in the live KqlDashboardEditor.
      setNewDashOpen(false);
      router.push(`/items/kql-dashboard/${created.id}`);
    } catch (e: any) {
      setNewDashErr(e?.message || String(e));
    } finally {
      setNewDashBusy(false);
    }
  }, [itemRecord, state?.defaultDatabase, selectedDb, newDashName, item.displayName, router]);

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
        { label: 'New dashboard',
          onClick: () => { setNewDashName(''); setNewDashErr(null); setNewDashOpen(true); },
          title: 'Create a Real-Time Dashboard pre-wired to this eventhouse’s KQL database' },
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
                    style={{ marginTop: tokens.spacingVerticalM, width: '100%' }}
                  />
                  {createErr && (
                    <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
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
          <Dialog open={newDashOpen} onOpenChange={(_: unknown, d: any) => { if (!newDashBusy) setNewDashOpen(d.open); }}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>
                  <span style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS }}>
                    <DataBarVertical20Regular />
                    New Real-Time Dashboard
                  </span>
                </DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
                    <Caption1>
                      Creates a KQL dashboard in this workspace, pre-wired to the{' '}
                      <strong>{selectedDb || state?.defaultDatabase || 'default'}</strong> KQL
                      database as its data source. You can add tiles and change the data
                      source after creation.
                    </Caption1>
                    <Field
                      label="Dashboard name"
                      hint="Leave blank to use the suggested name."
                    >
                      <Input
                        autoFocus
                        placeholder={`${item.displayName ?? 'Eventhouse'} — Dashboard`}
                        value={newDashName}
                        disabled={newDashBusy}
                        onChange={(_: unknown, d: any) => setNewDashName(d.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !newDashBusy) { e.preventDefault(); void createDashboard(); }
                        }}
                        style={{ width: '100%' }}
                      />
                    </Field>
                    {newDashErr && (
                      <MessageBar intent="error">
                        <MessageBarBody>
                          <MessageBarTitle>Couldn’t create dashboard</MessageBarTitle>
                          {newDashErr}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                  </div>
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setNewDashOpen(false)} disabled={newDashBusy}>Cancel</Button>
                  <Button
                    appearance="primary"
                    icon={newDashBusy ? <Spinner size="tiny" /> : <Add20Regular />}
                    onClick={createDashboard}
                    disabled={newDashBusy}
                  >
                    {newDashBusy ? 'Creating…' : 'Create dashboard'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>

        {state?.ok && (
          <div className={s.tabBar}>
            <TabList selectedValue={activeTab} onTabSelect={(_: unknown, d: any) => setActiveTab(d.value as EhTab)}>
              <Tab value="overview" icon={<Info20Regular />}>System overview</Tab>
              <Tab value="databases" icon={<Database20Regular />}>Databases ({dbCount})</Tab>
              <Tab value="capacity" icon={<DataBarVertical20Regular />}>Capacity</Tab>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS}}>
              <Subtitle2>Databases ({dbCount})</Subtitle2>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: tokens.spacingVerticalXS}} role="group" aria-label="Database view">
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
                      <div style={{ fontSize: tokens.fontSizeBase400, fontWeight: 600 }}>{d.name}</div>
                      {d.prettyName && d.prettyName !== d.name && <Caption1>{d.prettyName}</Caption1>}
                      <div style={{ display: 'flex', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalXS, flexWrap: 'wrap', color: tokens.colorNeutralForeground3 }}>
                        {typeof d.totalSizeMb === 'number' && <Caption1>{fmtDbSize(d.totalSizeMb)}</Caption1>}
                        {typeof d.retentionDays === 'number' && <Caption1>ret {d.retentionDays}d</Caption1>}
                        {typeof d.tableCount === 'number' && <Caption1>{d.tableCount} {d.tableCount === 1 ? 'table' : 'tables'}</Caption1>}
                      </div>
                      <div style={{ display: 'flex', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
                        {d.name === state.defaultDatabase && <Badge appearance="filled" color="brand">default</Badge>}
                        {isSelected && <Badge appearance="outline" color="informative">selected</Badge>}
                      </div>
                      <div style={{ marginTop: tokens.spacingVerticalS, display: 'flex', gap: tokens.spacingVerticalXS, flexWrap: 'wrap' }}>
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
                            <Badge appearance="filled" color="brand" style={{ marginLeft: tokens.spacingHorizontalS }}>default</Badge>}
                        </TableCell>
                        <TableCell>{typeof d.tableCount === 'number' ? d.tableCount : '—'}</TableCell>
                        <TableCell>{fmtDbSize(d.totalSizeMb)}</TableCell>
                        <TableCell>{typeof d.retentionDays === 'number' ? `${d.retentionDays} days` : '—'}</TableCell>
                        <TableCell>{typeof d.hotCacheDays === 'number' ? `${d.hotCacheDays} days` : '—'}</TableCell>
                        <TableCell>
                          <div style={{ display: 'flex', gap: tokens.spacingVerticalXS}}>
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
                      <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
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
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM }}>
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
                            <div style={{ display: 'flex', gap: tokens.spacingVerticalS, flexWrap: 'wrap', alignItems: 'center' }}>
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
                      <div style={{ marginTop: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalS }}>
                        <Caption1><strong>Detected schema</strong>{schemaPreview.detectedFormat ? ` (${schemaPreview.detectedFormat})` : ''}</Caption1>
                        <div style={{ overflowX: 'auto', marginTop: tokens.spacingVerticalXS }}>
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
                      <MessageBar intent={getDataResult.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalM }}>
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
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
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
                      <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
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
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalM }}>
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
                          style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200}}
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
                      <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}>
                        <MessageBarBody>
                          <MessageBarTitle>Binding failed</MessageBarTitle>
                          {deltaResult.error}
                          {deltaResult.hint && <div style={{ marginTop: tokens.spacingVerticalS }}><Caption1>{deltaResult.hint}</Caption1></div>}
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {deltaResult?.ok && (
                      <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalM }}>
                        <MessageBarBody>
                          <MessageBarTitle>External table {deltaResult.externalTableName} bound</MessageBarTitle>
                          <div style={{ marginTop: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS}}>
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
                    <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS}}>
                      Configures a Kusto continuous-export job that writes Delta files to ADLS Gen2 on
                      each interval. The ADX cluster&rsquo;s system-assigned MI authenticates to storage
                      (impersonation — no SAS key). Requires <strong>Storage Blob Data Contributor</strong> on
                      the target account, provisioned by <code>adx-cluster.bicep</code> when
                      <code> LOOM_RTI_EXPORT_ADLS</code> is set.
                    </Caption1>

                    {/* Honest gate — fires when LOOM_RTI_EXPORT_ADLS is not set */}
                    {exportResult?.code === 'no_adls_config' && (
                      <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM}}>
                        <MessageBarBody>
                          <MessageBarTitle>ADLS export not configured</MessageBarTitle>
                          {exportResult.hint ||
                            'Set LOOM_RTI_EXPORT_ADLS to the storage account name and redeploy. ' +
                            'See adx-cluster.bicep (exportAdlsAccountName param).'}
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
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
                      <Spinner size="extra-small" label="Loading exports…" style={{ marginTop: tokens.spacingVerticalM}} />
                    )}
                    {continuousExports.length > 0 && (
                      <div style={{ marginTop: tokens.spacingVerticalL}}>
                        <Caption1 style={{ fontWeight: 600 }}>Active exports ({continuousExports.length})</Caption1>
                        {continuousExports.map((ce) => (
                          <div key={ce.name} style={{ fontSize: tokens.fontSizeBase200, marginTop: tokens.spacingVerticalXS, fontFamily: 'monospace' }}>
                            <strong>{ce.name}</strong>
                            {ce.externalTableName && ` → ${ce.externalTableName}`}
                            {ce.lastRunResult && (
                              <Caption1 style={{ marginLeft: tokens.spacingHorizontalS}}>{ce.lastRunResult}</Caption1>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Success receipt */}
                    {exportResult?.ok && (
                      <MessageBar intent="success" style={{ marginTop: tokens.spacingVerticalM}}>
                        <MessageBarBody>
                          <MessageBarTitle>Export configured</MessageBarTitle>
                          Delta files will land at <code>{exportResult.abfssPath}</code> every {exportInterval}.
                          Verify: <code>{exportResult.verify}</code>
                        </MessageBarBody>
                      </MessageBar>
                    )}

                    {/* Error (not the honest gate) */}
                    {exportResult && !exportResult.ok && exportResult.code !== 'no_adls_config' && (
                      <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM}}>
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
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
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
                              <div key={i} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', marginTop: tokens.spacingVerticalS}}>
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
                              style={{ marginTop: tokens.spacingVerticalS}}
                            >
                              Add condition
                            </Button>
                            <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>
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
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
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
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
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
                      <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalS}}>
                        Cluster SKU: <strong>{state.sku.name}</strong> ({state.sku.tier} tier
                        {typeof state.sku.capacity === 'number' ? `, ${state.sku.capacity} instance${state.sku.capacity === 1 ? '' : 's'}` : ''})
                      </Caption1>
                    )}
                    {isDevSku && (
                      <MessageBar intent="warning" style={{ marginBottom: tokens.spacingVerticalM}}>
                        <MessageBarBody>
                          <MessageBarTitle>Dev/Basic SKU — auto-scale not supported</MessageBarTitle>
                          Optimized auto-scale requires a Standard-tier ADX SKU
                          (e.g. <code>Standard_E2ads_v5</code>). This cluster is on{' '}
                          <strong>{state?.sku?.name}</strong> (Basic tier). Upgrade the
                          cluster SKU via Manage › Scale up, then return here.
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, opacity: isDevSku ? 0.5 : 1 }}>
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
                      <MessageBar intent={autoscaleResult.ok ? 'success' : 'error'} style={{ marginTop: tokens.spacingVerticalM}}>
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
  // ── KQL Copilot (NL2KQL / explain / fix) ──────────────────────────────
  // Persona-backed inline assist — POSTs to /api/items/kql-database/<id>/assist,
  // which grounds generation in the live ADX schema (KQL_COPILOT_PERSONA) and
  // calls real AOAI. Azure-native; no Fabric dependency.
  type AssistView = 'idle' | 'prompt' | 'loading' | 'suggestion' | 'explain-result';
  const [assistView, setAssistView] = useState<AssistView>('idle');
  const [assistPrompt, setAssistPrompt] = useState('');
  const [assistResult, setAssistResult] = useState<string | null>(null);
  const [assistError, setAssistError] = useState<string | null>(null);
  const lastModeRef = useRef<'generate' | 'explain' | 'fix'>('generate');
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

  // ── RBAC + cluster lifecycle + per-table RLS (this task) ────────────────
  // Manage-principals (RBAC) drawer-dialog, cluster lifecycle dialog, and the
  // per-table Row-Level Security dialog opened from the navigator shield.
  const [rbacOpen, setRbacOpen] = useState(false);
  const [clusterOpen, setClusterOpen] = useState(false);
  const [rlsTable, setRlsTable] = useState<string | null>(null);
  const [rlsEnabled, setRlsEnabled] = useState(false);
  const [rlsQuery, setRlsQuery] = useState('');
  const [rlsLoading, setRlsLoading] = useState(false);
  const [rlsBusy, setRlsBusy] = useState(false);
  const [rlsError, setRlsError] = useState<string | null>(null);
  const [rlsNotice, setRlsNotice] = useState<string | null>(null);

  const openRlsEditor = useCallback(async (tableName: string) => {
    setRlsTable(tableName); setRlsError(null); setRlsNotice(null);
    setRlsEnabled(false); setRlsQuery(''); setRlsLoading(true);
    try {
      const res = await fetch(`/api/adx/rls?id=${encodeURIComponent(id)}&table=${encodeURIComponent(tableName)}`);
      const body = await res.json().catch(() => ({}));
      if (body?.ok && body.policy) { setRlsEnabled(!!body.policy.isEnabled); setRlsQuery(body.policy.query || ''); }
      else if (!body?.ok && body?.error) setRlsError(body.error);
    } catch (e: any) {
      setRlsError(e?.message || String(e));
    } finally {
      setRlsLoading(false);
    }
  }, [id]);

  const submitRlsEditor = useCallback(async () => {
    if (!rlsTable) return;
    setRlsBusy(true); setRlsError(null); setRlsNotice(null);
    try {
      const res = await fetch(`/api/adx/rls?id=${encodeURIComponent(id)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ table: rlsTable, enabled: rlsEnabled, query: rlsQuery }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body?.ok) { setRlsError(body?.error || 'failed to set RLS policy'); setRlsBusy(false); return; }
      setRlsNotice(
        `RLS ${body.policy?.isEnabled ? 'enabled' : 'disabled'} on ${rlsTable}.` +
        (body.warning ? ` Warning: ${body.warning}` : ''),
      );
    } catch (e: any) {
      setRlsError(e?.message || String(e));
    } finally {
      setRlsBusy(false);
    }
  }, [id, rlsTable, rlsEnabled, rlsQuery]);

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

  // KQL Copilot edge — generate (NL2KQL) / explain (Markdown) / fix.
  const callAssist = useCallback(async (mode: 'generate' | 'explain' | 'fix') => {
    lastModeRef.current = mode;
    setAssistView('loading'); setAssistError(null);
    try {
      const r = await fetch(`/api/items/kql-database/${id}/assist`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode,
          kql,
          prompt: mode === 'generate' ? assistPrompt : undefined,
          errorText: mode === 'fix' ? (result && !result.ok ? result.error || '' : '') : undefined,
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
  }, [id, kql, assistPrompt, result]);

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
          { label: 'Manage principals (RBAC)', onClick: () => setRbacOpen(true), title: 'Add/remove database & table principals (Kusto .add/.drop principal commands)' },
          { label: 'Row-level security', onClick: () => { const first = info?.tables?.[0]?.name; if (first) openRlsEditor(first); }, disabled: isFollower || !(info?.tables && info.tables.length), title: isFollower ? roTitle : (!(info?.tables && info.tables.length) ? 'No tables yet — create a table first' : 'Author the RLS predicate per table (.alter table policy row_level_security)') },
          { label: 'Cluster lifecycle & scale', onClick: () => setClusterOpen(true), title: 'Stop/start/scale/delete the ADX cluster (ARM)' },
          { label: 'OneLake availability', disabled: true, title: 'OneLake mirroring requires Fabric-managed cluster (LOOM_KUSTO_FABRIC_MANAGED=true)' },
        ]},
      ]},
    ];
  }, [openWizard, openFnEditor, openDcWizard, openRlsEditor, info?.isFollower, info?.tables]);

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
              onEditRls={openRlsEditor}
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
            <OpenInPbiDesktopButton type="kql-database" id={id} name={info?.database} />
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
            style={{ marginBottom: tokens.spacingVerticalXS}}
          >
            <Tab value="query" icon={<Play20Regular />}>Query</Tab>
            <Tab value="diagram" icon={<Flowchart20Regular />}>Diagram</Tab>
          </TabList>

          {editorTab === 'query' && (
          <>
          <div className={s.toolbar}>
            <Tooltip content="Generate KQL from a description (NL2KQL, grounded in the live ADX schema)" relationship="label">
              <Button size="small" appearance="subtle" icon={<Sparkle16Regular />}
                disabled={assistView === 'loading' || !id || id === 'new'}
                onClick={() => { setAssistResult(null); setAssistError(null); setAssistView('prompt'); }}
                aria-label="Ask Copilot to generate KQL">Ask Copilot</Button>
            </Tooltip>
            <Tooltip content="Explain this query in Markdown" relationship="label">
              <Button size="small" appearance="subtle" icon={<Info16Regular />}
                disabled={!kql.trim() || assistView === 'loading' || !id || id === 'new'}
                onClick={() => callAssist('explain')}
                aria-label="Explain KQL">Explain</Button>
            </Tooltip>
            {result && !result.ok && result.error && (
              <Tooltip content="Fix the KQL error" relationship="label">
                <Button size="small" appearance="subtle" icon={<Wrench16Regular />}
                  disabled={assistView === 'loading' || !id || id === 'new'}
                  onClick={() => callAssist('fix')}
                  aria-label="Fix KQL error">
                  {assistView === 'loading' && lastModeRef.current === 'fix' ? 'Fixing…' : 'Fix'}
                </Button>
              </Tooltip>
            )}
          </div>
          <MonacoTextarea
            value={kql}
            onChange={setKql}
            language="kql"
            height={240}
            minHeight={180}
            ariaLabel="KQL query editor"
          />
          {/* NL prompt input — generate mode */}
          {assistView === 'prompt' && (
            <div className={s.assistBar}>
              <Input size="small" autoFocus style={{ flex: 1 }}
                placeholder="Describe the query (e.g. 'count events per hour for the last day')…"
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
            <MessageBar intent={assistView === 'explain-result' ? 'info' : 'success'} style={{ margin: `${tokens.spacingVerticalXS} 0 0` }}>
              <MessageBarBody>
                <pre className={s.assistResult}>{assistResult}</pre>
              </MessageBarBody>
              <MessageBarActions>
                {assistView === 'suggestion' && (
                  <>
                    <Button size="small" appearance="primary"
                      onClick={() => { setKql(assistResult); setAssistView('idle'); setAssistResult(null); setAssistPrompt(''); }}>
                      Apply
                    </Button>
                    <Button size="small" appearance="outline"
                      onClick={() => { setKql(assistResult); setAssistView('idle'); setAssistResult(null); setAssistPrompt(''); setTimeout(() => run(), 0); }}>
                      Apply &amp; Run
                    </Button>
                  </>
                )}
                <Button size="small" onClick={() => { setAssistView('idle'); setAssistResult(null); }}>Dismiss</Button>
              </MessageBarActions>
            </MessageBar>
          )}
          {/* Honest config gate / error */}
          {assistError && (
            <MessageBar intent="error" style={{ margin: `${tokens.spacingVerticalXS} 0 0` }}>
              <MessageBarBody>{assistError}</MessageBarBody>
              <MessageBarActions>
                <Button size="small" onClick={() => setAssistError(null)}>Dismiss</Button>
              </MessageBarActions>
            </MessageBar>
          )}
          <KqlResultsPanel result={result} loading={loading} itemId={id} itemType="kql-database" />

          {/* Starter schema + queries from the app-install template. Surfaced
              when the live ADX object isn't provisioned yet so a bundle-
              installed KQL database opens FULLY BUILT-OUT (tables + columns +
              sample rows + starter analyst queries) instead of empty. Once the
              tables/functions exist on the live cluster the navigator + Run
              hit the real backend; these template rows are clearly labeled. */}
          {info?.contentFallback && (
            <div style={{ marginTop: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
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
                  <Tree aria-label="Starter table schema" style={{ marginTop: tokens.spacingVerticalS}}>
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
                          <div style={{ overflowX: 'auto', margin: `${tokens.spacingVerticalXS} 0 ${tokens.spacingVerticalS} ${tokens.spacingHorizontalXXL}` }}>
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginTop: tokens.spacingVerticalS}}>
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
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
                          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS}}>
                            <Caption1>Existing data connections ({wizDcConnections.length})</Caption1>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingVerticalS}}>
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
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
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                        {fnParams.map((p, i) => (
                          <div key={i} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center' }}>
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
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
                      <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center' }}>
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
                        <Table size="extra-small" aria-label="Existing data connections" style={{ marginTop: tokens.spacingVerticalS}}>
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

          {/* RBAC — Manage principals (database + table scope) */}
          <Dialog open={rbacOpen} onOpenChange={(_, d) => setRbacOpen(d.open)}>
            <DialogSurface style={{ maxWidth: 720 }}>
              <DialogBody>
                <DialogTitle>Manage principals (RBAC) · {info?.database || 'KQL database'}</DialogTitle>
                <DialogContent>
                  <AdxRbacPanel
                    itemId={id}
                    database={info?.database}
                    tables={(info?.tables ?? []).map((t) => t.name)}
                  />
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setRbacOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Cluster lifecycle + scale (ARM) */}
          <Dialog open={clusterOpen} onOpenChange={(_, d) => setClusterOpen(d.open)}>
            <DialogSurface style={{ maxWidth: 720 }}>
              <DialogBody>
                <DialogTitle>ADX cluster — lifecycle &amp; scale</DialogTitle>
                <DialogContent>
                  <AdxClusterEditor onChanged={() => load()} />
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setClusterOpen(false)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* Row-Level Security — per table (.alter table policy row_level_security) */}
          <Dialog open={rlsTable !== null} onOpenChange={(_, d) => { if (!d.open) setRlsTable(null); }}>
            <DialogSurface style={{ maxWidth: 640 }}>
              <DialogBody>
                <DialogTitle>Row-level security · {rlsTable}</DialogTitle>
                <DialogContent>
                  {rlsLoading ? <Spinner size="tiny" label="Loading RLS policy…" /> : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
                      <MessageBar intent="info">
                        <MessageBarBody>
                          Sets <code>.alter table [&quot;{rlsTable}&quot;] policy row_level_security</code>.
                          The query is a KQL predicate (or a stored-function call) that filters rows for
                          the calling principal — e.g.{' '}
                          <code>{rlsTable} | where current_principal_is_member_of(&apos;aadgroup=analysts@contoso.com&apos;)</code>.
                          Requires Database / Table Admin.
                        </MessageBarBody>
                      </MessageBar>
                      <Switch
                        checked={rlsEnabled}
                        label={rlsEnabled ? 'RLS enabled' : 'RLS disabled'}
                        onChange={(_, d) => setRlsEnabled(!!d.checked)}
                      />
                      <Field label="RLS query (KQL predicate)" required={rlsEnabled}>
                        <Textarea
                          value={rlsQuery}
                          onChange={(_, d) => setRlsQuery(d.value)}
                          rows={5}
                          style={{ fontFamily: 'Consolas, monospace' }}
                          placeholder={`${rlsTable ?? 'T'} | where current_principal_is_member_of('aadgroup=analysts@contoso.com')`}
                        />
                      </Field>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                        Test without affecting users in the query editor with{' '}
                        <code>set query_force_row_level_security;</code>.
                      </Caption1>
                      {rlsNotice && <MessageBar intent="success"><MessageBarBody>{rlsNotice}</MessageBarBody></MessageBar>}
                      {rlsError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>RLS error</MessageBarTitle>{rlsError}</MessageBarBody></MessageBar>}
                    </div>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setRlsTable(null)} disabled={rlsBusy}>Close</Button>
                  <Button appearance="primary" onClick={submitRlsEditor} disabled={rlsBusy || rlsLoading || (rlsEnabled && !rlsQuery.trim())}>
                    {rlsBusy ? 'Applying…' : (rlsEnabled ? 'Enable RLS' : 'Disable RLS')}
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacingVerticalS}}>
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
            <MessageBar intent={assistView === 'explain-result' ? 'info' : 'success'} style={{ margin: `${tokens.spacingVerticalXS} 0 0` }}>
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
            <MessageBar intent="error" style={{ margin: `${tokens.spacingVerticalXS} 0 0` }}>
              <MessageBarBody>{assistError}</MessageBarBody>
              <MessageBarActions>
                <Button size="small" onClick={() => setAssistError(null)}>Dismiss</Button>
              </MessageBarActions>
            </MessageBar>
          )}
          <KqlResultsPanel result={result} loading={loading} itemId={id} itemType="kql-queryset" />

          <Dialog open={pinDlgOpen} onOpenChange={(_: unknown, d: any) => setPinDlgOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Save query to KQL Dashboard</DialogTitle>
                <DialogContent>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM}}>
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
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
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
                          style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200}}
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
                  <div style={{ marginTop: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
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
// explicit minimum interval + default rate). The ADX /v1/rest/query round-trip
// is 2–10s, so the tightest live cadences (5s/30s) are paired with an in-flight
// guard in the auto-refresh effect below: a tick is SKIPPED while the previous
// runAll() is still resolving, so a slow cluster can never pile up overlapping
// queries. Matches the Fabric Real-Time Dashboard continuous-refresh behavior.
const REFRESH_INTERVALS: { ms: number; label: string }[] = [
  { ms: 0,         label: 'Off' },
  { ms: 5_000,     label: '5 seconds' },
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

  const fieldRow: React.CSSProperties = { display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', flexWrap: 'wrap' };
  return (
    <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, background: tokens.colorNeutralBackground2 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
        <Caption1 style={{ fontWeight: 600 }}>Conditional formatting</Caption1>
        <div style={{ display: 'flex', gap: tokens.spacingVerticalXS}}>
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
        <div key={ri} style={{ border: `1px solid ${tokens.colorNeutralStroke3}`, borderRadius: tokens.borderRadiusMedium, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, background: tokens.colorNeutralBackground1 }}>
          <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'center', justifyContent: 'space-between' }}>
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
  // True while a runAll() ADX requery is in flight. Read synchronously inside
  // the auto-refresh interval so a tight cadence (5s/30s) skips a tick rather
  // than stacking overlapping /run round-trips against a slow cluster.
  const runInFlightRef = useRef(false);
  // Wall-clock of the last successful auto/manual refresh — surfaced in the
  // toolbar so the user can see the live cadence is actually firing.
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
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
  // AI tile generator (NL → KQL) — Fabric RTI "Copilot add a tile" parity.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [aiDataSourceId, setAiDataSourceId] = useState('');
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
    runInFlightRef.current = true;
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
      setLastRefreshedAt(Date.now());
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
    } finally {
      runInFlightRef.current = false;
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

  // AI tile generator: POST the NL prompt → server grounds on the live ADX
  // schema, asks AOAI for {title, kql, viz}, validates by executing the KQL,
  // and returns a ready tile (with its first-page result inlined). We append it
  // to the grid and open its editor so the operator can review/tweak. This is
  // the Fabric Real-Time Dashboard "Copilot — add a tile from a question" flow,
  // Azure-native (ADX + AOAI), no Fabric/Power BI on the path.
  const generateTile = useCallback(async () => {
    const prompt = aiPrompt.trim();
    if (!prompt) { setAiErr('Describe the tile you want (e.g. "errors per service over time").'); return; }
    setAiBusy(true); setAiErr(null); setAiNote(null);
    try {
      const r = await fetch(`/api/items/kql-dashboard/${id}/generate-tile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, dataSourceId: aiDataSourceId || undefined, timeRange }),
      });
      const ct = r.headers.get('content-type') || '';
      const j = ct.includes('application/json') ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
      if (!j.ok) { setAiErr(j.error || `generation failed (HTTP ${r.status})`); return; }
      const g = j.tile || {};
      const newTile: DashTile = {
        title: g.title || prompt.slice(0, 60),
        kql: g.kql || '',
        viz: (g.viz || 'table') as TileViz,
        dataSourceId: g.dataSourceId || undefined,
        database: g.database || undefined,
        w: g.w || 4,
        h: g.h || 2,
        result: g.result,
        error: j.validated ? undefined : (j.validationError || undefined),
      };
      let insertedIdx = 0;
      setTiles((prev) => { insertedIdx = prev.length; return [...prev, newTile]; });
      setDirty(true);
      setTileFlyoutIdx(insertedIdx);
      if (!j.schemaGrounded) {
        setAiNote('Generated without a live schema (the database returned no tables). Review the column names in the tile editor.');
      } else if (!j.validated) {
        setAiNote(`Tile added, but its KQL did not validate against ${j.resolvedDatabase}: ${j.validationError || 'unknown error'}. Edit it in the tile editor.`);
      }
      setAiOpen(false);
      setAiPrompt('');
    } catch (e: any) {
      setAiErr(e?.message || String(e));
    } finally {
      setAiBusy(false);
    }
  }, [aiPrompt, aiDataSourceId, id, timeRange]);

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

  // Export a tile's REAL result (the same Kusto rows already rendered) to CSV.
  // Fabric Real-Time Dashboard tiles expose an "Export to CSV" / "Copy to
  // clipboard" tile action; this is the 1:1. Pure client-side — the result is
  // already in memory, so no backend round-trip is needed.
  const exportTileCsv = useCallback((idx: number) => {
    const t = tiles[idx];
    const res = t?.result;
    if (!res?.ok || !Array.isArray(res.columns) || !Array.isArray(res.rows)) {
      setSaveErr('Run the tile first — there is no result to export yet.');
      return;
    }
    const csv = kqlResultToCsv(res.columns, res.rows);
    downloadTextFile(`${slugifyForFile(t.title)}.csv`, csv);
    setSaveErr(null);
    setSaveMsg(`Exported ${res.rows.length} row${res.rows.length === 1 ? '' : 's'} from “${t.title}” to CSV.`);
  }, [tiles]);

  const copyTileCsv = useCallback(async (idx: number) => {
    const t = tiles[idx];
    const res = t?.result;
    if (!res?.ok || !Array.isArray(res.columns) || !Array.isArray(res.rows)) {
      setSaveErr('Run the tile first — there is no result to copy yet.');
      return;
    }
    const csv = kqlResultToCsv(res.columns, res.rows);
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('Clipboard unavailable in this browser.');
      await navigator.clipboard.writeText(csv);
      setSaveErr(null);
      setSaveMsg(`Copied ${res.rows.length} row${res.rows.length === 1 ? '' : 's'} from “${t.title}” to the clipboard (CSV).`);
    } catch (e: any) {
      setSaveErr(`Could not copy to clipboard: ${e?.message || e}. Use Export CSV instead.`);
    }
  }, [tiles]);

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

  // Auto-refresh — re-run the live model (real ADX requery via /run) every N ms.
  // A tick is SKIPPED when the previous requery is still resolving so a tight
  // cadence (5s/30s) against a slow cluster can never pile up overlapping
  // queries — the next tick simply picks up once the in-flight run completes.
  useEffect(() => {
    if (!autoRefreshMs || autoRefreshMs <= 0) return;
    const t = setInterval(() => {
      if (runInFlightRef.current) return;
      runAll();
    }, autoRefreshMs);
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
        { label: 'Add tile with Copilot', onClick: () => { setAiErr(null); setAiNote(null); setAiOpen(true); } },
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
        <Button size="small" appearance="primary" icon={<Sparkle20Regular />} onClick={() => { setAiErr(null); setAiNote(null); setAiOpen(true); }}>Add tile with Copilot</Button>
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
        {autoRefreshMs > 0 && (
          <span
            className={s.livePill}
            role="status"
            aria-live="polite"
            title={`Auto-refreshing every ${refreshLabel(autoRefreshMs).replace(/^Auto-refresh:\s*/i, '')}`}
          >
            <span className={mergeClasses(s.liveDot, running && s.liveDotActive)} aria-hidden />
            <Caption1>
              {running
                ? 'Refreshing…'
                : lastRefreshedAt
                  ? `Live · updated ${new Date(lastRefreshedAt).toLocaleTimeString()}`
                  : 'Live · waiting for first refresh…'}
            </Caption1>
          </span>
        )}
        <Button size="small" appearance="primary" icon={<Save20Regular />} onClick={save} disabled={saving || !dirty} style={{ marginLeft: 'auto' }}>
          {saving ? 'Saving…' : 'Save (Ctrl+S)'}
        </Button>
      </div>

      {/* Parameter filter bar — Fabric renders selected dashboard params here. */}
      {params.length > 0 && (
        <div style={{ display: 'flex', gap: tokens.spacingVerticalM, flexWrap: 'wrap', alignItems: 'flex-end', padding: `${tokens.spacingVerticalXS} 0` }}>
          {params.map((p, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 160 }}>
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
                    style={{ minWidth: 160, padding: tokens.spacingVerticalXS, border: `1px solid ${tokens.colorNeutralStroke1}`, borderRadius: tokens.borderRadiusMedium, background: tokens.colorNeutralBackground1, color: tokens.colorNeutralForeground1 }}>
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
      {aiNote && (
        <MessageBar intent="warning">
          <MessageBarBody><MessageBarTitle>Copilot tile</MessageBarTitle>{aiNote}</MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => setAiNote(null)}>Dismiss</Button>
          </MessageBarActions>
        </MessageBar>
      )}
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: tokens.spacingVerticalM, gridAutoRows: 'minmax(120px, auto)' }}>
        {tiles.map((t, i) => {
          const span = Math.max(1, Math.min(12, t.w || 4));
          const rowSpan = Math.max(1, Math.min(8, t.h || 2));
          const dsName = t.dataSourceId ? (dataSources.find((d) => d.id === t.dataSourceId)?.name || t.dataSourceId) : (t.database || defaultDb);
          return (
            <div key={i} className={s.card} style={{ gridColumn: `span ${span}`, gridRow: `span ${rowSpan}`, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{t.viz.toUpperCase()} · {dsName}</Caption1>
                  <div style={{ fontSize: tokens.fontSizeBase300, fontWeight: 600 }}>{t.title}</div>
                </div>
                <div style={{ display: 'flex', gap: tokens.spacingVerticalXXS}}>
                  <Button size="small" appearance="subtle" icon={<Play20Regular />} onClick={() => runTile(i)} aria-label="Run tile" title="Run this tile" />
                  <Button
                    size="small" appearance="subtle" icon={<ArrowDownload20Regular />}
                    onClick={() => exportTileCsv(i)} disabled={!t.result?.ok}
                    aria-label="Export tile result to CSV"
                    title={t.result?.ok ? 'Export this tile’s result to CSV' : 'Run the tile first to enable export'} />
                  <Button
                    size="small" appearance="subtle" icon={<Copy20Regular />}
                    onClick={() => copyTileCsv(i)} disabled={!t.result?.ok}
                    aria-label="Copy tile result to clipboard"
                    title={t.result?.ok ? 'Copy this tile’s result (CSV) to the clipboard' : 'Run the tile first to enable copy'} />
                  <Button size="small" appearance="subtle" onClick={() => setTileFlyoutIdx(i)} aria-label="Edit tile">
                    Edit
                  </Button>
                  <Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={() => deleteTile(i)} aria-label="Delete tile" />
                </div>
              </div>

              {t.error && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{t.error}</MessageBarBody></MessageBar>}
              {t.result && t.result.ok && (
                <div style={{ marginTop: tokens.spacingVerticalS, flex: 1, minHeight: 0 }}>
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
              {!t.result && !t.error && <Caption1 style={{ marginTop: tokens.spacingVerticalS, color: tokens.colorNeutralForeground3 }}>Run the tile to see results.</Caption1>}
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
                  <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <div>
                      <Caption1>Title</Caption1>
                      <Input value={t.title} onChange={(_: unknown, d: any) => updateTile(i, { title: d.value })} placeholder="Title" aria-label="Tile title" />
                    </div>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
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
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
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
                      <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS }}>
                        <TileVisual viz={t.viz} result={t.result} conditionalRules={t.conditionalRules} />
                      </div>
                    )}

                    {/* Drill-through (Fabric: visual Interactions > Drillthrough).
                        Clicking a result value sets a dashboard parameter and
                        re-runs every tile (single-page cross-filter). */}
                    <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 8, marginTop: tokens.spacingVerticalXS}}>
                      <Caption1 style={{ fontWeight: 600 }}>Drill-through</Caption1>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginBottom: tokens.spacingVerticalXS}}>
                        Clicking a value in this tile injects it into a dashboard parameter and re-runs all tiles.
                      </Caption1>
                      {params.length === 0 ? (
                        <MessageBar intent="info">
                          <MessageBarBody>
                            Add at least one dashboard <strong>Parameter</strong> first — drill-through targets a parameter.
                          </MessageBarBody>
                        </MessageBar>
                      ) : (
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end', flexWrap: 'wrap' }}>
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
                        <Caption1 style={{ color: tokens.colorNeutralForeground3, display: 'block', marginTop: tokens.spacingVerticalXS}}>
                          Click a value in this tile → sets <code>{t.drillthrough.paramName}</code> to the value in column <code>{t.drillthrough.column}</code> and re-runs all tiles.
                        </Caption1>
                      )}
                    </div>

                    {/* Conditional formatting (Fabric RTD: color by condition / by value).
                        Applies to table + stat (card) visuals. */}
                    {(t.viz === 'table' || t.viz === 'stat') && (
                      <div style={{ borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 8, marginTop: tokens.spacingVerticalXS}}>
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalS}}>
                {baseQueries.map((q, idx) => (
                  <div key={q.id} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
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

      {/* AI tile generator dialog (NL → KQL) — Fabric RTI "Copilot add a tile" parity. */}
      <Dialog open={aiOpen} onOpenChange={(_: unknown, d: any) => { if (!aiBusy) setAiOpen(d.open); }}>
        <DialogSurface style={{ maxWidth: 640 }}>
          <DialogBody>
            <DialogTitle>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingVerticalS}}>
                <Sparkle20Regular /> Add a tile with Copilot
              </span>
            </DialogTitle>
            <DialogContent>
              <Caption1 style={{ display: 'block', marginBottom: tokens.spacingVerticalM, color: tokens.colorNeutralForeground3 }}>
                Describe the visualization you want in plain language. Copilot reads the live
                schema of <strong>{defaultDb}</strong>, writes the KQL, picks a chart type, and
                validates the query against Azure Data Explorer before adding the tile.
              </Caption1>
              <Field label="What should this tile show?">
                <Textarea
                  value={aiPrompt}
                  onChange={(_: unknown, d: any) => setAiPrompt(d.value)}
                  placeholder="e.g. Count of failed requests per service over time as a line chart"
                  rows={3}
                  disabled={aiBusy}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !aiBusy) { e.preventDefault(); generateTile(); }
                  }}
                />
              </Field>
              <Caption1 style={{ display: 'block', marginTop: tokens.spacingVerticalXS, color: tokens.colorNeutralForeground3 }}>
                Press <kbd style={{ fontFamily: tokens.fontFamilyMonospace }}>Ctrl</kbd>+<kbd style={{ fontFamily: tokens.fontFamilyMonospace }}>Enter</kbd> to generate.
              </Caption1>
              {dataSources.length > 0 && (
                <Field label="Data source (optional)" style={{ marginTop: tokens.spacingVerticalM}}>
                  <Select value={aiDataSourceId} onChange={(_: unknown, d: any) => setAiDataSourceId(d.value)} disabled={aiBusy}>
                    <option value="">Dashboard default ({defaultDb})</option>
                    {dataSources.map((ds) => <option key={ds.id} value={ds.id}>{ds.name} · {ds.database}</option>)}
                  </Select>
                </Field>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalM}}>
                <Caption1 style={{ color: tokens.colorNeutralForeground3, width: '100%' }}>Try:</Caption1>
                {[
                  'Total events in the last 24 hours',
                  'Top 10 error messages by count as a bar chart',
                  'Requests per minute over time',
                ].map((ex) => (
                  <Button
                    key={ex}
                    size="small"
                    appearance="outline"
                    shape="circular"
                    disabled={aiBusy}
                    onClick={() => setAiPrompt(ex)}
                  >
                    {ex}
                  </Button>
                ))}
              </div>
              {aiErr && (
                <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM}}>
                  <MessageBarBody><MessageBarTitle>Could not generate the tile</MessageBarTitle>{aiErr}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAiOpen(false)} disabled={aiBusy}>Cancel</Button>
              <Button appearance="primary" icon={aiBusy ? <Spinner size="tiny" /> : <Sparkle20Regular />} onClick={generateTile} disabled={aiBusy || !aiPrompt.trim()}>
                {aiBusy ? 'Generating…' : 'Generate tile'}
              </Button>
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginTop: tokens.spacingVerticalS}}>
                {dataSources.map((ds, idx) => (
                  <div key={ds.id} style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalS}}>
                {params.map((p, idx) => (
                  <div key={idx} style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
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
                    <div style={{ display: 'flex', gap: tokens.spacingVerticalS}}>
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
                        <Textarea value={p.query || ''} onChange={(_: unknown, d: any) => updateParam(idx, { query: d.value })} rows={2} style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200}} placeholder="StormEvents | distinct State" />
                        <div style={{ display: 'flex', gap: tokens.spacingVerticalS, alignItems: 'flex-end' }}>
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
                style={{ width: '100%', fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, marginTop: tokens.spacingVerticalS}}
                aria-label="Dashboard JSON model"
              />
              {jsonErr && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody><MessageBarTitle>JSON parse error</MessageBarTitle>{jsonErr}</MessageBarBody></MessageBar>}
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
              <div style={{ marginTop: tokens.spacingVerticalS, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS}}>
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

export { EventstreamEditor } from './phase3/eventstream-editor';

import { usePowerBiWorkspaces, WorkspacePicker } from './phase3/workspace-picker';

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

export { ActivatorEditor } from './phase3/activator-editor';

// ----- Warehouse -----
// Ribbon built inside the editor via useMemo so Run binds to the
// existing inline run handler; the rest stay disabled with reasons.

export { WarehouseEditor } from './phase3/warehouse-editor';

// ============================================================
// Semantic Model (Power BI dataset)
// ============================================================
// Ribbon built inside SemanticModelEditor via useMemo so Refresh binds
// to the existing inline refreshNow handler; the rest stay disabled.

export { SemanticModelEditor } from './phase3/semantic-model-editor';
export { ReportEditor } from './phase3/report-editor';
export type { ReportLite } from './phase3/report-editor';
export { PaginatedReportEditor } from './phase3/paginated-report-editor';

// ============================================================
// Dashboard (Power BI dashboard viewer + Loom-native tile canvas)
//
// Azure-native by default (no-fabric-dependency.md): the Loom canvas tab — pin
// a DAX tile, add a Copilot Q&A→DAX tile, add a streaming ADX/KQL tile, drag
// the grid, drill, fullscreen, mobile layout — works with NO Power BI / Fabric
// workspace bound (streaming tiles run on ADX; DAX tiles run on Azure Analysis
// Services when LOOM_SEMANTIC_BACKEND=analysis-services). Power BI embed + the
// "pin from a PBI dashboard" clone path are the opt-in Fabric-family surface.
// Layout + Loom tiles persist to Cosmos (pbi-dashboard-overlays) via
// PUT /api/items/dashboard/[id]; tiles execute via .../tile-query.
// ============================================================
import type { LoomTile, TileLayout, TileVizKind, LoomTileKind } from '@/lib/azure/dashboard-overlay';

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
  const [err, setErr] = useState<string | null>(null);
  const [embed, setEmbed] = useState<{ token: string; embedUrl: string; dashboardId: string } | null>(null);
  const [embedErr, setEmbedErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'canvas' | 'pbi'>('canvas');

  // ---- Loom overlay (Azure-native tiles + grid layout, persisted to Cosmos) --
  const [loomTiles, setLoomTiles] = useState<LoomTile[]>([]);
  const [layout, setLayout] = useState<Record<string, TileLayout>>({});
  const [loomResults, setLoomResults] = useState<Record<string, KqlResult>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [addDialog, setAddDialog] = useState<'pin' | 'qa' | 'streaming' | null>(null);
  const [fullscreenTile, setFullscreenTile] = useState<string | null>(null);

  // Responsive: collapse the 12-col grid to a single column on narrow viewports.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const onResize = () => setNarrow(typeof window !== 'undefined' && window.innerWidth < 720);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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

  // Load the Loom overlay (always — Azure-native, no PBI workspace required).
  const loadOverlay = useCallback(async (wsId: string, dId: string) => {
    try {
      const qs = wsId ? `?workspaceId=${encodeURIComponent(wsId)}` : '';
      const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dId || id)}${qs}`);
      const j = await r.json();
      if (j.ok) {
        if (wsId && dId) setTiles(j.tiles || []);
        setLoomTiles(j.overlay?.loomTiles || []);
        setLayout(j.overlay?.layout || {});
        setDirty(false);
      } else if (wsId) { setErr(j.error); }
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [id]);

  // Auto-pick the first Power BI workspace so the PBI list loads. The Loom
  // canvas does NOT depend on this — it loads its overlay by the Loom item id.
  useEffect(() => {
    if (!workspaceId && ws.workspaces && ws.workspaces.length > 0) setWorkspaceId(ws.workspaces[0].id);
  }, [workspaceId, ws.workspaces]);
  useEffect(() => { if (workspaceId) loadList(workspaceId); }, [workspaceId, loadList]);
  // Overlay loads against the Loom item id regardless of PBI selection.
  useEffect(() => { loadOverlay(workspaceId, dashId); }, [workspaceId, dashId, loadOverlay]);

  useEffect(() => {
    if (!workspaceId || !dashId || tab !== 'pbi') { return; }
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
  }, [workspaceId, dashId, tab]);

  // ---- Tile execution (real backend per tile kind) -------------------------
  const runLoomTile = useCallback(async (tile: LoomTile) => {
    setLoomResults((prev) => ({ ...prev, [tile.id]: { ok: true, rows: prev[tile.id]?.rows, columns: prev[tile.id]?.columns } as KqlResult }));
    try {
      const r = await fetch(`/api/items/dashboard/${encodeURIComponent(id)}/tile-query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: tile.kind,
          query: tile.query,
          workspaceId: tile.workspaceId,
          datasetId: tile.datasetId,
          database: tile.database,
        }),
      });
      const j = await r.json();
      setLoomResults((prev) => ({
        ...prev,
        [tile.id]: j.ok
          ? { ok: true, columns: j.columns || [], rows: j.rows || [], rowCount: j.rowCount, executionMs: j.executionMs, truncated: j.truncated }
          : { ok: false, error: j.hint ? `${j.error} — ${j.hint}` : j.error },
      }));
    } catch (e: any) {
      setLoomResults((prev) => ({ ...prev, [tile.id]: { ok: false, error: e?.message || String(e) } }));
    }
  }, [id]);

  // Run every tile once on load / when the tile set changes.
  useEffect(() => {
    loomTiles.forEach((t) => { if (!loomResults[t.id]) runLoomTile(t); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loomTiles]);

  // Auto-refresh streaming tiles on their configured interval.
  useEffect(() => {
    const timers = loomTiles
      .filter((t) => t.kind === 'streaming-adx' && t.autoRefreshMs && t.autoRefreshMs >= 5000)
      .map((t) => setInterval(() => runLoomTile(t), t.autoRefreshMs));
    return () => timers.forEach(clearInterval);
  }, [loomTiles, runLoomTile]);

  const saveOverlay = useCallback(async () => {
    setSaving(true); setSaveErr(null);
    try {
      const r = await fetch(`/api/items/dashboard/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pbiWorkspaceId: workspaceId, pbiDashboardId: dashId, loomTiles, layout }),
      });
      const j = await r.json();
      if (!j.ok) { setSaveErr(j.error || 'save failed'); return; }
      setDirty(false);
    } catch (e: any) { setSaveErr(e?.message || String(e)); }
    finally { setSaving(false); }
  }, [id, workspaceId, dashId, loomTiles, layout]);

  const addLoomTile = useCallback((tile: LoomTile) => {
    setLoomTiles((prev) => [...prev, tile]);
    setDirty(true);
    setAddDialog(null);
    runLoomTile(tile);
  }, [runLoomTile]);

  const removeLoomTile = useCallback((tileId: string) => {
    setLoomTiles((prev) => prev.filter((t) => t.id !== tileId));
    setLayout((prev) => { const n = { ...prev }; delete n[tileId]; return n; });
    setLoomResults((prev) => { const n = { ...prev }; delete n[tileId]; return n; });
    setDirty(true);
  }, []);

  // Auto-arrange: pack tiles left-to-right in a 12-col grid (3-wide default).
  const autoArrange = useCallback(() => {
    const next: Record<string, TileLayout> = {};
    let col = 0, row = 0;
    const place = (tileId: string, w: number, h: number) => {
      if (col + w > 12) { col = 0; row += 2; }
      next[tileId] = { col, row, w, h };
      col += w;
    };
    tiles.forEach((t) => place(t.id, t.colSpan || 3, t.rowSpan || 2));
    loomTiles.forEach((t) => place(t.id, t.w || 4, t.h || 2));
    setLayout(next);
    setDirty(true);
  }, [tiles, loomTiles]);

  const refreshDash = useCallback(() => {
    if (workspaceId) loadList(workspaceId);
    loadOverlay(workspaceId, dashId);
  }, [workspaceId, dashId, loadList, loadOverlay]);
  const openDashInPbi = useCallback(() => {
    if (selectedDash?.webUrl) window.open(selectedDash.webUrl, '_blank', 'noreferrer');
  }, [selectedDash?.webUrl]);

  const dashRibbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Add tile', actions: [
        { label: 'Pin from report', icon: <Pin20Regular />, onClick: () => setAddDialog('pin'), title: 'clone an already-pinned Power BI tile onto this dashboard' },
        { label: 'Q&A tile (Copilot → DAX)', icon: <Sparkle20Regular />, onClick: () => setAddDialog('qa'), title: 'ask a question in natural language → Copilot generates + runs DAX' },
        { label: 'Streaming tile (ADX/KQL)', icon: <Flash20Regular />, onClick: () => setAddDialog('streaming'), title: 'live tile over Azure Data Explorer — Azure-native, no Power BI needed' },
      ]},
      { label: 'Layout', actions: [
        { label: saving ? 'Saving…' : 'Save layout', icon: <Save20Regular />, onClick: dirty && !saving ? saveOverlay : undefined, disabled: !dirty || saving, title: dirty ? 'persist tiles + grid to Cosmos' : 'no unsaved changes' },
        { label: 'Auto-arrange', icon: <DataBarVertical20Regular />, onClick: (tiles.length + loomTiles.length) > 0 ? autoArrange : undefined, disabled: (tiles.length + loomTiles.length) === 0 },
      ]},
      { label: 'Metadata', actions: [
        { label: 'Refresh', icon: <ArrowSync20Regular />, onClick: refreshDash, title: 'reload tiles + overlay' },
        { label: 'Open in Power BI', icon: <Open20Regular />, onClick: selectedDash?.webUrl ? openDashInPbi : undefined, disabled: !selectedDash?.webUrl, title: !selectedDash?.webUrl ? 'select a Power BI dashboard first' : 'open Power BI Web to pin new visuals' },
      ]},
    ]},
  ], [dirty, saving, tiles.length, loomTiles.length, selectedDash?.webUrl, saveOverlay, autoArrange, refreshDash, openDashInPbi]);

  const span = (w?: number) => narrow ? '1 / -1' : `span ${Math.max(1, Math.min(12, w ?? 4))}`;
  const fsTile = loomTiles.find((t) => t.id === fullscreenTile);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={dashRibbon}
      leftPanel={
        <div className={s.treePad}>
          <Subtitle2 style={{ marginBottom: tokens.spacingVerticalS}}>Power BI dashboards</Subtitle2>
          {!workspaceId && <Caption1>Select a workspace to link a Power BI dashboard (optional).</Caption1>}
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
            <Badge appearance="filled" color="brand">Dashboard</Badge>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'canvas' | 'pbi')}>
              <Tab value="canvas">Tiles ({tiles.length + loomTiles.length})</Tab>
              <Tab value="pbi">Power BI view</Tab>
            </TabList>
            <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} {...ws} />
          </div>
          {err && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          {saveErr && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Save failed</MessageBarTitle>{saveErr}</MessageBarBody></MessageBar>}

          {tab === 'canvas' && (
            <>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Azure-native dashboard canvas</MessageBarTitle>
                  Streaming tiles run on <strong>Azure Data Explorer</strong> and Q&amp;A tiles run DAX on
                  Azure Analysis Services / Power BI — no Microsoft Fabric capacity required. Add tiles from the
                  ribbon, drag to arrange, then <strong>Save layout</strong> to persist to Cosmos.
                </MessageBarBody>
              </MessageBar>
              <div style={{
                display: 'grid',
                gridTemplateColumns: narrow ? '1fr' : 'repeat(12, 1fr)',
                gap: tokens.spacingVerticalM, paddingTop: 12,
              }}>
                {/* Pinned Power BI tiles (single-tile embed) */}
                {tiles.map((t) => {
                  const pos = layout[t.id];
                  return (
                    <div key={t.id} style={{
                      gridColumn: span(pos?.w ?? t.colSpan ?? 4),
                      border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusXLarge,
                      overflow: 'hidden', minHeight: 220, position: 'relative', background: tokens.colorNeutralBackground1,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
                        <Pin20Regular />
                        <Caption1 style={{ fontWeight: 600, flex: 1 }}>{t.title || t.subTitle || 'Power BI tile'}</Caption1>
                        {t.reportId && (
                          <Tooltip content="Drill to the source report in Power BI" relationship="label">
                            <Button size="small" appearance="subtle" icon={<Open20Regular />} onClick={() => {
                              if (!workspaceId || !t.reportId) return;
                              try { window.open(`https://app.powerbi.com/groups/${encodeURIComponent(workspaceId)}/reports/${encodeURIComponent(t.reportId)}`, '_blank', 'noreferrer'); } catch { /* popup */ }
                            }} />
                          </Tooltip>
                        )}
                      </div>
                      <PinnedPbiTile workspaceId={workspaceId} dashboardId={dashId} tile={t} />
                    </div>
                  );
                })}

                {/* Loom-native tiles (DAX / KQL / streaming) */}
                {loomTiles.map((t) => {
                  const pos = layout[t.id];
                  return (
                    <div key={t.id} style={{ gridColumn: span(pos?.w ?? t.w ?? 4), minWidth: 0 }}>
                      <LoomTileCard
                        tile={t}
                        result={loomResults[t.id]}
                        onRefresh={() => runLoomTile(t)}
                        onFullscreen={() => setFullscreenTile(t.id)}
                        onRemove={() => removeLoomTile(t.id)}
                      />
                    </div>
                  );
                })}

                {(tiles.length + loomTiles.length) === 0 && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                      No tiles yet. Use <strong>Add tile</strong> in the ribbon to pin a visual, add a Copilot Q&amp;A tile, or add a streaming ADX tile.
                    </Caption1>
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'pbi' && (
            <>
              <MessageBar intent="info">
                <MessageBarBody>
                  <MessageBarTitle>Power BI dashboard embed (read-only)</MessageBarTitle>
                  Authoring (pin visual, dashboard theme) lives in <strong>Power BI Web</strong>. This tab embeds
                  the selected Power BI dashboard. The opt-in path requires a Power BI workspace; the Loom canvas
                  tab is fully functional without one.
                </MessageBarBody>
              </MessageBar>
              {!workspaceId && <Caption1>Select a Power BI workspace to embed a dashboard.</Caption1>}
              {embedErr ? (
                <MessageBar intent="error">
                  <MessageBarBody>
                    <MessageBarTitle>Could not mint embed token</MessageBarTitle>
                    {embedErr}. Confirm the Console UAMI is added to this workspace and that "Service principals can use Fabric APIs" is enabled.
                  </MessageBarBody>
                </MessageBar>
              ) : embed ? (
                <PowerBIEmbedFrame embedType="dashboard" id={embed.dashboardId} embedUrl={embed.embedUrl} accessToken={embed.token} height={620} />
              ) : (
                dashId && <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Loading embed token…</Caption1>
              )}
            </>
          )}

          {/* ---- Fullscreen a Loom tile ---- */}
          <Dialog open={!!fsTile} onOpenChange={(_, d) => { if (!d.open) setFullscreenTile(null); }}>
            <DialogSurface style={{ maxWidth: '92vw', width: '92vw' }}>
              <DialogBody>
                <DialogTitle>{fsTile?.title}</DialogTitle>
                <DialogContent>
                  {fsTile && <LoomTileBody tile={fsTile} result={loomResults[fsTile.id]} large />}
                </DialogContent>
                <DialogActions>
                  {fsTile && <Button appearance="secondary" icon={<ArrowSync20Regular />} onClick={() => runLoomTile(fsTile)}>Refresh</Button>}
                  <Button appearance="primary" onClick={() => setFullscreenTile(null)}>Close</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          {/* ---- Add-tile dialogs ---- */}
          {addDialog === 'pin' && (
            <PinTileDialog
              dashboardItemId={id}
              workspaceId={workspaceId}
              dashboards={dashboards || []}
              selectedDashWebUrl={selectedDash?.webUrl}
              onClose={() => setAddDialog(null)}
              onPinned={() => { setAddDialog(null); refreshDash(); }}
            />
          )}
          {addDialog === 'qa' && (
            <QaTileDialog
              dashboardItemId={id}
              workspaceId={workspaceId}
              onClose={() => setAddDialog(null)}
              onAdd={addLoomTile}
            />
          )}
          {addDialog === 'streaming' && (
            <StreamingTileDialog
              dashboardItemId={id}
              onClose={() => setAddDialog(null)}
              onAdd={addLoomTile}
            />
          )}
        </div>
      }
    />
  );
}

/** Renders a single Loom tile result (table / chart / stat) with drill support. */
function LoomTileBody({ tile, result, large }: { tile: LoomTile; result?: KqlResult; large?: boolean }) {
  if (!result) return <Spinner size="tiny" label="Running…" />;
  if (!result.ok) {
    return (
      <MessageBar intent="warning">
        <MessageBarBody><MessageBarTitle>Tile gated</MessageBarTitle>{result.error}</MessageBarBody>
      </MessageBar>
    );
  }
  if (!result.rows || result.rows.length === 0) return <Caption1>No rows.</Caption1>;
  return (
    <div style={{ maxHeight: large ? '70vh' : 220, overflow: 'auto' }}>
      <TileVisual
        viz={(tile.viz as TileViz) || 'table'}
        result={result}
      />
    </div>
  );
}

/** Loom tile card: header (kind badge + actions) + body. */
function LoomTileCard({ tile, result, onRefresh, onFullscreen, onRemove }: {
  tile: LoomTile; result?: KqlResult;
  onRefresh: () => void; onFullscreen: () => void; onRemove: () => void;
}) {
  const kindLabel: Record<LoomTileKind, string> = { dax: 'DAX', kusto: 'KQL', 'streaming-adx': 'Streaming' };
  const kindIcon: Record<LoomTileKind, JSX.Element> = {
    dax: <Sparkle20Regular />, kusto: <Database20Regular />, 'streaming-adx': <Flash20Regular />,
  };
  return (
    <div style={{
      border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusXLarge,
      background: tokens.colorNeutralBackground1, minHeight: 220, display: 'flex', flexDirection: 'column',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS, padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
        {kindIcon[tile.kind]}
        <Caption1 style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tile.title}</Caption1>
        <Badge appearance="tint" size="small">{kindLabel[tile.kind]}</Badge>
        {tile.kind === 'streaming-adx' && tile.autoRefreshMs ? <Badge appearance="outline" size="small">{Math.round(tile.autoRefreshMs / 1000)}s</Badge> : null}
        <Tooltip content="Refresh" relationship="label"><Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={onRefresh} /></Tooltip>
        <Tooltip content="Fullscreen" relationship="label"><Button size="small" appearance="subtle" icon={<ArrowMaximize20Regular />} onClick={onFullscreen} /></Tooltip>
        <Tooltip content="Remove tile" relationship="label"><Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={onRemove} /></Tooltip>
      </div>
      <div style={{ padding: tokens.spacingVerticalM, flex: 1 }}>
        <LoomTileBody tile={tile} result={result} />
      </div>
    </div>
  );
}

/** Single Power BI tile embed (lazy: mints a tile token when scrolled into view). */
function PinnedPbiTile({ workspaceId, dashboardId, tile }: { workspaceId: string; dashboardId: string; tile: TileLite }) {
  const [tok, setTok] = useState<{ token: string; embedUrl: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaceId || !dashboardId || !tile.embedUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dashboardId)}/tile-embed-token`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId, tileId: tile.id }),
        });
        const j = await r.json();
        if (cancelled) return;
        if (j.ok && j.token) setTok({ token: j.token, embedUrl: tile.embedUrl! });
        else setErr(j.error || `HTTP ${r.status}`);
      } catch (e: any) { if (!cancelled) setErr(e?.message || String(e)); }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, dashboardId, tile.id, tile.embedUrl]);
  if (err) return <div style={{ padding: tokens.spacingVerticalM }}><Caption1 style={{ color: tokens.colorPaletteRedForeground1 }}>{err}</Caption1></div>;
  if (!tok) return <div style={{ padding: tokens.spacingVerticalM }}><Spinner size="tiny" label="Embedding tile…" /></div>;
  return <PowerBIEmbedFrame embedType="tile" id={tile.id} embedUrl={tok.embedUrl} accessToken={tok.token} height={180} />;
}

/** Pin (clone) an existing Power BI tile onto this dashboard. */
function PinTileDialog({ dashboardItemId, workspaceId, dashboards, selectedDashWebUrl, onClose, onPinned }: {
  dashboardItemId: string; workspaceId: string; dashboards: DashboardLite[];
  selectedDashWebUrl?: string; onClose: () => void; onPinned: () => void;
}) {
  const [sourceDash, setSourceDash] = useState('');
  const [srcTiles, setSrcTiles] = useState<TileLite[]>([]);
  const [tileId, setTileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaceId || !sourceDash) { setSrcTiles([]); return; }
    (async () => {
      try {
        const r = await fetch(`/api/items/dashboard/${encodeURIComponent(sourceDash)}?workspaceId=${encodeURIComponent(workspaceId)}`);
        const j = await r.json();
        setSrcTiles(j.ok ? (j.tiles || []) : []);
      } catch { setSrcTiles([]); }
    })();
  }, [workspaceId, sourceDash]);
  const pin = useCallback(async () => {
    if (!workspaceId || !sourceDash || !tileId) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dashboardItemId)}/pin`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, sourceDashboardId: sourceDash, tileId }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.hint ? `${j.error} — ${j.hint}` : j.error); return; }
      onPinned();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [dashboardItemId, workspaceId, sourceDash, tileId, onPinned]);
  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Pin a tile</DialogTitle>
          <DialogContent>
            <MessageBar intent="info">
              <MessageBarBody>
                Pinning a brand-new visual happens in <strong>Power BI Web</strong> (open a report → pin a visual to
                this dashboard). Below you can <strong>clone an already-pinned tile</strong> from another Power BI
                dashboard onto this one.
              </MessageBarBody>
              {selectedDashWebUrl && (
                <MessageBarActions>
                  <Button size="small" icon={<Open20Regular />} onClick={() => window.open(selectedDashWebUrl, '_blank', 'noreferrer')}>Open in Power BI</Button>
                </MessageBarActions>
              )}
            </MessageBar>
            {!workspaceId && <MessageBar intent="warning"><MessageBarBody>Select a Power BI workspace first (the clone API is a Power BI REST call).</MessageBarBody></MessageBar>}
            <Field label="Source dashboard" style={{ marginTop: tokens.spacingVerticalS}}>
              <Select value={sourceDash} onChange={(_, d) => { setSourceDash(d.value); setTileId(''); }}>
                <option value="">— choose —</option>
                {dashboards.map((d) => <option key={d.id} value={d.id}>{d.displayName}</option>)}
              </Select>
            </Field>
            <Field label="Tile to clone" style={{ marginTop: tokens.spacingVerticalS}}>
              <Select value={tileId} onChange={(_, d) => setTileId(d.value)} disabled={srcTiles.length === 0}>
                <option value="">{srcTiles.length === 0 ? '— pick a source dashboard with tiles —' : '— choose —'}</option>
                {srcTiles.map((t) => <option key={t.id} value={t.id}>{t.title || t.subTitle || t.id}</option>)}
              </Select>
            </Field>
            {err && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!workspaceId || !sourceDash || !tileId || busy} onClick={pin} icon={busy ? <Spinner size="tiny" /> : <Pin20Regular />}>Pin tile</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Q&A tile: Copilot generates DAX from a natural-language question, runs it. */
function QaTileDialog({ dashboardItemId, workspaceId, onClose, onAdd }: {
  dashboardItemId: string; workspaceId: string; onClose: () => void; onAdd: (t: LoomTile) => void;
}) {
  const [datasets, setDatasets] = useState<{ id: string; name: string }[]>([]);
  const [datasetId, setDatasetId] = useState('');
  const [nl, setNl] = useState('');
  const [title, setTitle] = useState('');
  const [dax, setDax] = useState('');
  const [result, setResult] = useState<KqlResult | null>(null);
  const [viz, setViz] = useState<TileVizKind>('table');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const semanticBackend = (typeof process !== 'undefined' && (process.env.NEXT_PUBLIC_LOOM_SEMANTIC_BACKEND || '')) || '';
  const aasMode = semanticBackend.toLowerCase() === 'analysis-services';

  useEffect(() => {
    if (aasMode || !workspaceId) return;
    (async () => {
      try {
        const r = await fetch(`/api/items/semantic-model?workspaceId=${encodeURIComponent(workspaceId)}`);
        const j = await r.json();
        if (j.ok) setDatasets((j.datasets || []).filter((d: any) => d.id && d.name).map((d: any) => ({ id: d.id, name: d.name })));
      } catch { /* honest gate shown on run */ }
    })();
  }, [workspaceId, aasMode]);

  const ask = useCallback(async () => {
    if (!nl.trim()) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dashboardItemId)}/tile-query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'dax', nlPrompt: nl, workspaceId, datasetId: aasMode ? undefined : datasetId }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.hint ? `${j.error} — ${j.hint}` : j.error); return; }
      setDax(j.generatedQuery || '');
      setResult({ ok: true, columns: j.columns || [], rows: j.rows || [] });
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [dashboardItemId, nl, workspaceId, datasetId, aasMode]);

  const runEdited = useCallback(async () => {
    if (!dax.trim()) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dashboardItemId)}/tile-query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'dax', query: dax, workspaceId, datasetId: aasMode ? undefined : datasetId }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.hint ? `${j.error} — ${j.hint}` : j.error); return; }
      setResult({ ok: true, columns: j.columns || [], rows: j.rows || [] });
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [dashboardItemId, dax, workspaceId, datasetId, aasMode]);

  const add = useCallback(() => {
    onAdd({
      id: randomTileId(), kind: 'dax', title: title.trim() || nl.trim().slice(0, 60) || 'Q&A tile',
      query: dax, viz, workspaceId: aasMode ? undefined : workspaceId, datasetId: aasMode ? undefined : datasetId, w: 4, h: 2,
    });
  }, [onAdd, title, nl, dax, viz, workspaceId, datasetId, aasMode]);

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 720 }}>
        <DialogBody>
          <DialogTitle>Q&amp;A tile — Copilot → DAX</DialogTitle>
          <DialogContent>
            <MessageBar intent="info"><MessageBarBody>
              Ask in natural language; Copilot (Azure OpenAI) writes the DAX and runs it on
              {aasMode ? ' Azure Analysis Services' : ' the selected Power BI semantic model'}. Edit the DAX before adding if needed.
            </MessageBarBody></MessageBar>
            {!aasMode && (
              <Field label="Semantic model (dataset)" style={{ marginTop: tokens.spacingVerticalS}}>
                <Select value={datasetId} onChange={(_, d) => setDatasetId(d.value)}>
                  <option value="">{datasets.length === 0 ? '— select a Power BI workspace with datasets —' : '— choose —'}</option>
                  {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Question" style={{ marginTop: tokens.spacingVerticalS}}>
              <Textarea value={nl} onChange={(_, d) => setNl(d.value)} placeholder="e.g. Show total sales by region for the last 12 months" rows={2} />
            </Field>
            <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Sparkle20Regular />} disabled={!nl.trim() || busy} onClick={ask} style={{ marginTop: tokens.spacingVerticalS}}>Ask Copilot</Button>
            {dax && (
              <>
                <Field label="Generated DAX (editable)" style={{ marginTop: tokens.spacingVerticalM}}>
                  <Textarea value={dax} onChange={(_, d) => setDax(d.value)} rows={4} style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200}} />
                </Field>
                <Button appearance="secondary" icon={<Play20Regular />} onClick={runEdited} disabled={busy} style={{ marginTop: tokens.spacingVerticalS}}>Run DAX</Button>
              </>
            )}
            {err && <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            {result && result.ok && (
              <div style={{ marginTop: tokens.spacingVerticalM}}>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalS}}>
                  <Label>Visual</Label>
                  <Select value={viz} onChange={(_, d) => setViz(d.value as TileVizKind)}>
                    {(['table', 'stat', 'bar', 'column', 'line', 'pie'] as TileVizKind[]).map((v) => <option key={v} value={v}>{v}</option>)}
                  </Select>
                  <Field label="Tile title" style={{ flex: 1 }}>
                    <Input value={title} onChange={(_, d) => setTitle(d.value)} placeholder="optional" />
                  </Field>
                </div>
                <div style={{ border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, maxHeight: 240, overflow: 'auto' }}>
                  <TileVisual viz={viz as TileViz} result={result} />
                </div>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!result?.ok || !dax.trim()} onClick={add} icon={<Add20Regular />}>Add to dashboard</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** Streaming tile: live ADX/KQL query with auto-refresh. Azure-native. */
function StreamingTileDialog({ dashboardItemId, onClose, onAdd }: {
  dashboardItemId: string; onClose: () => void; onAdd: (t: LoomTile) => void;
}) {
  const [kql, setKql] = useState('');
  const [database, setDatabase] = useState('');
  const [title, setTitle] = useState('');
  const [refreshSec, setRefreshSec] = useState(30);
  const [viz, setViz] = useState<TileVizKind>('timechart');
  const [result, setResult] = useState<KqlResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const test = useCallback(async () => {
    if (!kql.trim()) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await fetch(`/api/items/dashboard/${encodeURIComponent(dashboardItemId)}/tile-query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'streaming-adx', query: kql, database }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.hint ? `${j.error} — ${j.hint}` : j.error); return; }
      setResult({ ok: true, columns: j.columns || [], rows: j.rows || [] });
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [dashboardItemId, kql, database]);

  const add = useCallback(() => {
    onAdd({
      id: randomTileId(), kind: 'streaming-adx', title: title.trim() || 'Streaming tile',
      query: kql, database: database.trim() || undefined, viz,
      autoRefreshMs: Math.max(5, Math.min(300, refreshSec)) * 1000, w: 6, h: 2,
    });
  }, [onAdd, title, kql, database, viz, refreshSec]);

  return (
    <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}>
      <DialogSurface style={{ maxWidth: 720 }}>
        <DialogBody>
          <DialogTitle>Streaming tile — Azure Data Explorer (KQL)</DialogTitle>
          <DialogContent>
            <MessageBar intent="info"><MessageBarBody>
              Event Hub AMQP receive is not exposed via the Loom HTTPS-only data plane. Instead, query the
              <strong> ADX table</strong> that the Event Hub data connection ingests into — the tile auto-refreshes on
              your interval. Fully Azure-native (no Power BI / Fabric).
            </MessageBarBody></MessageBar>
            <Field label="KQL query" style={{ marginTop: tokens.spacingVerticalS}}>
              <Textarea value={kql} onChange={(_, d) => setKql(d.value)} rows={4}
                placeholder={'Events\n| where Timestamp > ago(1h)\n| summarize count() by bin(Timestamp, 1m)\n| render timechart'}
                style={{ fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200}} />
            </Field>
            <div style={{ display: 'flex', gap: tokens.spacingVerticalM, marginTop: tokens.spacingVerticalS, flexWrap: 'wrap' }}>
              <Field label="Database (blank = default)">
                <Input value={database} onChange={(_, d) => setDatabase(d.value)} placeholder="ADX database" />
              </Field>
              <Field label="Auto-refresh (seconds)">
                <SpinButton value={refreshSec} min={5} max={300} onChange={(_, d) => setRefreshSec(Number(d.value ?? d.displayValue ?? 30) || 30)} />
              </Field>
              <Field label="Visual">
                <Select value={viz} onChange={(_, d) => setViz(d.value as TileVizKind)}>
                  {(['timechart', 'line', 'column', 'bar', 'table', 'stat', 'pie'] as TileVizKind[]).map((v) => <option key={v} value={v}>{v}</option>)}
                </Select>
              </Field>
              <Field label="Tile title" style={{ flex: 1 }}>
                <Input value={title} onChange={(_, d) => setTitle(d.value)} placeholder="optional" />
              </Field>
            </div>
            <Button appearance="secondary" icon={busy ? <Spinner size="tiny" /> : <Play20Regular />} onClick={test} disabled={!kql.trim() || busy} style={{ marginTop: tokens.spacingVerticalS}}>Test query</Button>
            {err && <MessageBar intent="warning" style={{ marginTop: tokens.spacingVerticalS}}><MessageBarBody>{err}</MessageBarBody></MessageBar>}
            {result?.ok && (
              <div style={{ marginTop: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalS, maxHeight: 240, overflow: 'auto' }}>
                <TileVisual viz={viz as TileViz} result={result} />
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancel</Button>
            <Button appearance="primary" disabled={!kql.trim()} onClick={add} icon={<Add20Regular />}>Add tile</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function randomTileId(): string {
  try { return (globalThis.crypto as Crypto).randomUUID(); }
  catch { return `tile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
}

// ============================================================
// Scorecard (Fabric)
// ============================================================
export { ScorecardEditor } from './phase3/scorecard-editor';

// ============================================================
// Datamart (DEPRECATED) — migration assistant
// ============================================================
//
// Power BI datamarts are deprecated. There is NO create path: id === 'new'
// renders a permanent deprecation notice with no authoring surface. An existing
// datamart shows a Fluent MessageBar intent="warning" with a Migrate button
// that POSTs /api/items/datamart/migrate — provisioning a Synapse Serverless
// database + an Azure Analysis Services server (real backends, no Fabric).
// Once migrated, the receipt (Synapse DB, AAS server, AAS connection URI) is
// surfaced from the Cosmos item's state.migration.

export { DatamartEditor } from './phase3/datamart-editor';
