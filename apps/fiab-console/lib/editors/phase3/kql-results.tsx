'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Shared KQL results / visualization / conditional-formatting cluster —
 * extracted from phase3-editors.tsx (byte-for-byte move).
 *
 * This module owns the result model (KqlResult / KqlVisualization), the
 * dependency-free SVG visuals (StatCard, PieChart, MapVisual, ResultChart,
 * TileVisual, ConditionalTable) the ADX web UI / Fabric Real-Time Dashboard
 * exposes, the conditional-formatting render helpers, and the KqlResultsPanel
 * surface. It is shared by the KQL family editors (KQL Database, KQL Queryset,
 * KQL Dashboard) and the Power BI Dashboard editor. Every top-level member is
 * exported so the importing editors resolve it unchanged. Only ./styles
 * (useStyles), @/lib/azure/kql-dashboard-model, and the ADX components
 * (KustoResultsGrid, TimeSeriesChart) are imported — so it lifts out cleanly.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  Caption1, Badge, Button, Spinner,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  tokens,
} from '@fluentui/react-components';
import {
  Warning20Regular, ErrorCircle20Regular, CheckmarkCircle20Regular, Info20Regular,
  Play20Regular, DataBarVertical20Regular,
} from '@fluentui/react-icons';
import { KustoResultsGrid } from '@/lib/components/adx/kusto-results-grid';
import { TimeSeriesChart } from '@/lib/components/adx/time-series-chart';
import { EmptyState } from '@/lib/components/empty-state';
import {
  evalConditionalRules,
  type ConditionalRule, type CfMatch, type CfColor, type CfIcon,
} from '@/lib/azure/kql-dashboard-model';
import { useStyles } from './styles';

export interface KqlVisualization {
  Visualization?: string;
  Title?: string;
  [k: string]: unknown;
}

export interface KqlResult {
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
export function vizFromRender(name?: string): TileViz {
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

export function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ---- Conditional-formatting render helpers (Fabric RTD parity) ----
// Map a CfColor bucket to Fluent palette tokens (bg + readable fg). The model's
// pure evaluator returns the *semantic* color; the renderer owns the theme.
export const CF_COLOR_TOKENS: Record<CfColor, { bg: string; fg: string }> = {
  red: { bg: tokens.colorPaletteRedBackground2, fg: tokens.colorPaletteRedForeground2 },
  yellow: { bg: tokens.colorPaletteYellowBackground2, fg: tokens.colorPaletteYellowForeground2 },
  green: { bg: tokens.colorPaletteGreenBackground2, fg: tokens.colorPaletteGreenForeground2 },
  blue: { bg: tokens.colorPaletteBlueBackground2, fg: tokens.colorPaletteBlueForeground2 },
};

export function cfIconEl(icon: CfIcon | undefined): JSX.Element | null {
  switch (icon) {
    case 'warning': return <Warning20Regular />;
    case 'error': return <ErrorCircle20Regular />;
    case 'success': return <CheckmarkCircle20Regular />;
    case 'info': return <Info20Regular />;
    default: return null;
  }
}

/** Resolve a CfMatch into concrete CSS bg/fg + icon element + tag/hideText. */
export function cfDecoration(match: CfMatch): { bg: string; fg: string; icon: JSX.Element | null; tag?: string; hideText?: boolean; applyTo: 'cells' | 'row'; targetColumn?: string; cellColumns?: string[] } {
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
export function kqlResultToCsv(columns: string[], rows: unknown[][]): string {
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
export function downloadTextFile(filename: string, text: string, mime = 'text/csv;charset=utf-8'): void {
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
export function slugifyForFile(s: string): string {
  return (s || 'tile').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'tile';
}

/** Per-column numeric min/max across the result, for color-by-value auto-scale. */
export function computeColStats(columns: string[], rows: unknown[][]): Record<string, { min: number; max: number }> {
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
export type TileViz = 'table' | 'timechart' | 'line' | 'bar' | 'column' | 'pie' | 'stat' | 'map';

export const PIE_COLORS = [
  tokens.colorBrandBackground,
  tokens.colorPaletteGreenBackground3,
  tokens.colorPalettePurpleBackground2,
  tokens.colorPaletteYellowBackground3,
  tokens.colorPaletteRedBackground3,
  tokens.colorPaletteBlueBackground2,
  tokens.colorPaletteTealBackground2,
  tokens.colorPaletteMarigoldBackground3,
];

export function pickNumericCol(columns: string[], rows: unknown[][]): number {
  for (let c = 0; c < columns.length; c++) {
    if (rows.some((r) => typeof r[c] === 'number' || (!isNaN(Number(r[c])) && r[c] !== '' && r[c] !== null))) return c;
  }
  return -1;
}

/** Single big-number KPI card (ADX `card` / Fabric "stat" visual). */
export function StatCard({ columns, rows, conditionalRules }: { columns: string[]; rows: unknown[][]; conditionalRules?: ConditionalRule[] }) {
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
        <div style={{ fontSize: tokens.fontSizeHero900, fontWeight: 700, color: deco?.fg ?? tokens.colorBrandForeground1, lineHeight: 1.1 }}>{display}</div>
      </div>
      <Caption1 style={{ color: deco?.fg ?? tokens.colorNeutralForeground3 }}>{columns[cellIdx] || 'value'}</Caption1>
      {deco?.tag && <Caption1 style={{ color: deco.fg ?? tokens.colorNeutralForeground3, fontStyle: 'italic' }}>{deco.tag}</Caption1>}
    </div>
  );
}

/** Pie chart (ADX `piechart`). First category col + first numeric col. */
export function PieChart({ columns, rows, onValueClick }: { columns: string[]; rows: unknown[][]; onValueClick?: (label: string) => void }) {
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
export function MapVisual({ columns, rows }: { columns: string[]; rows: unknown[][] }) {
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
export function ResultChart({ columns, rows, kind, onValueClick }: { columns: string[]; rows: unknown[][]; kind: 'bar' | 'column' | 'line' | 'timechart'; onValueClick?: (label: string) => void }) {
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
export function TileVisual({
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
export function ConditionalTable({ columns, rows, conditionalRules, drillColumn, onDrill }: { columns: string[]; rows: unknown[][]; conditionalRules?: ConditionalRule[]; drillColumn?: string; onDrill?: (value: string) => void }) {
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
export const KQL_VIZ_CHOICES: { value: TileViz; label: string }[] = [
  { value: 'table', label: 'Table' },
  { value: 'timechart', label: 'Time chart' },
  { value: 'line', label: 'Line' },
  { value: 'column', label: 'Column' },
  { value: 'bar', label: 'Bar' },
  { value: 'pie', label: 'Pie' },
  { value: 'stat', label: 'Card' },
  { value: 'map', label: 'Map' },
];

export function KqlResultsPanel({ result, loading, itemId, itemType }: { result: KqlResult | null; loading: boolean; itemId?: string; itemType?: string }) {
  const s = useStyles();
  // F19 — sensitivity-label export protection. When this panel belongs to a
  // labeled item, gate CSV export through the real /export-check BFF route so a
  // protected label blocks the download (encryption can't survive CSV/TXT).
  const onExportCheck = useMemo(() => {
    if (!itemId || !itemType) return undefined;
    return async (): Promise<{ blocked: boolean; reason?: string }> => {
      try {
        const r = await clientFetch(`/api/items/${itemType}/${itemId}/export-check`, {
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
