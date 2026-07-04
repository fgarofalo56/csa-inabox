'use client';

/**
 * AnalyticsPane — the "Analytics" right-rail tab of the Loom-native Report
 * Designer (Power BI report-authoring parity, wave 1).
 *
 * Power BI parity (ui-parity.md): PBI's Analytics pane lets the author drop
 * structured REFERENCE LINES onto a cartesian visual — Trend, Constant (X/Y),
 * Min, Max, Average, Median, and Percentile lines — each with its own color,
 * line style, and an optional data label. This pane reproduces that surface
 * one-for-one with the Loom theme: pick a line type, +Add, then name / color /
 * style / series. Wave 2 extends this SAME surface with three more PBI
 * Analytics families, each COMPUTED from the visual's real result rows and
 * drawn by LoomChart — no dead controls:
 *   • Error bars   — field / percent / value whiskers per category
 *   • Forecast     — linear or additive-seasonal projection + a confidence band
 *   • Symmetry     — the y=x diagonal split (scatter only)
 * Wave 5 finishes the surface — every remaining PBI Analytics row is now built
 * and drawn from the SAME real rows (no approximate-shape-with-a-caption):
 *   • X-Axis constant line — a constant line authored on the CATEGORY axis
 *     ({@link AnalyticsLine.axis} = 'x') resolves to a VERTICAL line, surfaced to
 *     LoomChart via {@link ComputedReferenceLine.orientation} = 'v'.
 *   • Anomaly detection — a REAL client-side rolling-mean / rolling-std z-score
 *     pass ({@link computeAnomalies}) flags out-of-band points and shades the
 *     rolling expected range; a per-definition `useAdx` switch opts into ADX
 *     `series_decompose_anomalies` only when a Kusto source is bound (an honest
 *     inline caption otherwise — never a dead control).
 *   • Shaded range — a translucent band between two structured numeric positions
 *     on the value ('y') or category ('x') axis ({@link computeShadedRanges}).
 * (The heavier ADX `series_decompose_forecast` server path stays the documented
 * follow-up in docs/fiab/parity/report-designer.md — the linear / seasonal
 * forecast above is fully functional without it.)
 *
 * no-freeform-config.md: every control is structured — a Dropdown of line
 * kinds, a numeric Input for the constant value / percentile (a VALUE, never a
 * typed DAX/JSON expression), a swatch picker, a style Dropdown, and a Switch.
 * The author never types a measure expression.
 *
 * no-vaporware.md: there are no dead controls. Each reference line is COMPUTED
 * from the visual's real result rows (the same rows LoomChart draws) by
 * {@link computeReferenceLines} and overlaid on the chart client-side. Min /
 * Max / Average / Median / Percentile / Trend are derived from the numeric
 * series; Constant is the author's typed numeric value. Nothing is "coming
 * soon".
 *
 * no-fabric-dependency.md: pure client-side math over rows that arrive from the
 * Azure-native report /query + wells-to-sql path. Nothing here reaches Fabric /
 * Power BI; the optional Power BI embed path is unaffected.
 *
 * web3-ui.md: Fluent UI v9 + Loom design tokens only (no hard-coded px/hex);
 * the swatch palette is imported from {@link ./format-pane} so what the author
 * picks here is exactly the brand color LoomChart paints, and the pane layout
 * mirrors the PBI Analytics pane (section header, add row, per-line cards).
 *
 * Persistence: this component is pure/controlled. It reads the selected
 * visual's {@link ReportAnalytics} (from `visual.config.analytics`) and emits
 * the next value via `onChange`; the host designer wires that to
 * `mutateVisual(id, v => ({ ...v, analytics }))`, which round-trips through
 * PUT /api/items/report/[id]/definition (additive — the read-only viewer and
 * the PBIR provisioner ignore an unknown `config.analytics`). No backend call
 * originates here; it is a client-side analytics surface.
 */

import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Button, Caption1, Divider, Dropdown, Input, Option, Slider, Switch, Text,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  DataTrending20Regular, Add20Regular, Delete20Regular, ColorRegular,
  LineHorizontal120Regular, ArrowBidirectionalUpDown20Regular,
  ArrowTrendingLines20Regular, ArrowSplit20Regular,
  Warning20Regular, Layer20Regular, DatabasePlugConnected20Regular,
} from '@fluentui/react-icons';
import { EmptyState } from '@/lib/components/empty-state';
import { LOOM_DATA_PALETTE } from './format-pane';

// ── Analytics model (persisted on visual.config.analytics) ───────────────────

/** A structured reference-line type — mirrors the PBI Analytics pane rows. */
export type AnalyticsLineKind =
  | 'trend' | 'constant' | 'min' | 'max' | 'average' | 'median' | 'percentile';

/** Stroke style for a reference line (PBI: Solid / Dashed / Dotted). */
export type AnalyticsLineStyle = 'solid' | 'dashed' | 'dotted';

/**
 * One structured reference line. Stored SPARSE on `visual.config.analytics`.
 * The author NEVER types an expression — `value`/`percentile` are numbers and
 * `measure` is a picked series name (a column header from the result rows).
 */
export interface AnalyticsLine {
  /** Stable client id. */
  id: string;
  /** Which statistic / line this is. */
  kind: AnalyticsLineKind;
  /**
   * Wave-5: which axis a CONSTANT line is constant ALONG. 'y' (default / absent)
   * is the historical horizontal value-axis line; 'x' makes a constant line a
   * VERTICAL category-axis line — {@link computeReferenceLines} maps it to
   * {@link ComputedReferenceLine.orientation} = 'v', and `value` is read as a
   * category-axis position. Ignored for non-constant kinds (which are always
   * horizontal value-axis statistics), so the field is additive + back-compatible.
   */
  axis?: 'x' | 'y';
  /**
   * Which numeric series the line is computed over (a result-column header). When
   * absent, the PRIMARY (first) numeric series is used — matching LoomChart.
   */
  measure?: string;
  /** Constant lines only: the typed numeric value (a value, not DAX). */
  value?: number;
  /** Percentile lines only: 0–100 (default 50). */
  percentile?: number;
  /** Line color — a Loom brand-palette swatch token (lock-step with LoomChart). */
  color: string;
  /** Stroke style. */
  style: AnalyticsLineStyle;
  /** Optional display name; falls back to the line-kind label. */
  label?: string;
  /** Show the data label next to the line. Default true. */
  showLabel: boolean;
}

/** Error-bar derivation mode (PBI: By field / Percentage / Value). */
export type ErrorBarMode = 'field' | 'percent' | 'value';

/**
 * One error-bar definition (PBI Analytics → Error bars). The whisker around
 * each category is derived structurally — NEVER a typed expression:
 *  - 'field':   `upperField`/`lowerField` are picked numeric-series names whose
 *               value at each category IS the upper / lower bound.
 *  - 'percent': ± `percent`% of each value.
 *  - 'value':   ± a fixed `value`.
 */
export interface AnalyticsErrorBar {
  /** Stable client id. */
  id: string;
  /** Numeric series the whiskers attach to (a result-column header); primary when absent. */
  measure?: string;
  /** How the bounds are derived. */
  mode: ErrorBarMode;
  /** field mode: picked upper-bound series (absolute value per category). */
  upperField?: string;
  /** field mode: picked lower-bound series (absolute value per category). */
  lowerField?: string;
  /** percent mode: ± this percent of each value (0–100). */
  percent?: number;
  /** value mode: ± this absolute amount. */
  value?: number;
  /** Whisker color — a Loom brand-palette swatch token. */
  color: string;
  /** Show the bound value labels. Default true. */
  showLabel: boolean;
}

/**
 * One forecast definition (PBI Analytics → Forecast). Pure client-side math
 * over the visual's result rows: a least-squares linear trend extended forward
 * `periods` points (seasonality 0), or an additive seasonal-naive projection
 * (seasonality = season length) — with a ± `confidence`% band. The heavier ADX
 * `series_decompose_forecast` stays the wave-3 plan (parity doc).
 */
export interface AnalyticsForecast {
  /** Stable client id. */
  id: string;
  /** Numeric series to forecast (a result-column header); primary when absent. */
  measure?: string;
  /** Points to project forward (1–60). */
  periods: number;
  /** 0 ⇒ linear trend; >0 ⇒ additive seasonal-naive with this season length. */
  seasonality?: number;
  /** Confidence band, 0–99 (default 95). */
  confidence?: number;
}

/**
 * Symmetry shading (PBI Analytics → Symmetry shading, SCATTER only). Shades the
 * upper / lower triangles split by the y=x diagonal so an author can spot which
 * points sit above / below parity.
 */
export interface AnalyticsSymmetry {
  /** Stable client id. */
  id: string;
  /** Whether the shading is drawn. */
  enabled: boolean;
  /** Diagonal / shading color — a Loom brand-palette swatch token. */
  color: string;
}

/**
 * One anomaly-detection definition (PBI Analytics → Find anomalies, wave-5). A
 * REAL computation — never an approximate shape with a caption: {@link
 * computeAnomalies} runs a trailing rolling-mean / rolling-std z-score over the
 * targeted numeric series, flags any point whose |z| exceeds a sensitivity-driven
 * threshold, and shades the rolling expected band. `useAdx` OPTS the detection
 * over to ADX `series_decompose_anomalies` — but ONLY when the report is bound to
 * a Kusto / ADX source; absent one the pane shows an honest inline caption and the
 * client computation is used (no dead control, per no-vaporware.md).
 */
export interface AnalyticsAnomaly {
  /** Stable client id. */
  id: string;
  /** Numeric series to scan (a result-column header); primary when absent. */
  measure?: string;
  /** Detection sensitivity, 0–100 (higher ⇒ flags more; ~100 ≈ 1.5σ, ~0 ≈ 3.5σ). */
  sensitivity: number;
  /** Flag-ring + band color — a Loom brand-palette swatch token. */
  color: string;
  /** Opt into ADX series_decompose_anomalies (only acts with a Kusto source bound). */
  useAdx?: boolean;
}

/**
 * One shaded analytics range (PBI Analytics-style highlight band, wave-5). A
 * translucent rectangle drawn UNDER the marks between two STRUCTURED numeric
 * positions on the value axis (`axis:'y'`) or the category axis (`axis:'x'`).
 * Structured numeric inputs only (no-freeform-config); {@link computeShadedRanges}
 * passes it straight to LoomChart's `shadedRanges` prop.
 */
export interface AnalyticsShadedRange {
  /** Stable client id. */
  id: string;
  /** Range start (data space — a value when axis:'y', a category index when axis:'x'). */
  from: number;
  /** Range end (data space — same axis semantics as `from`). */
  to: number;
  /** Which axis the band spans: 'y' = value axis, 'x' = category axis. */
  axis: 'x' | 'y';
  /** Fill color — a Loom brand-palette swatch token. */
  color: string;
}

/**
 * The Analytics model attached to a visual. `lines` are the wave-1 reference
 * lines; `errorBars` / `forecast` / `symmetry` are the additive wave-2 families
 * (all OPTIONAL + sanitized — the read-only viewer + PBIR provisioner ignore
 * unknown keys, so persistence stays backward-compatible).
 */
export interface ReportAnalytics {
  lines: AnalyticsLine[];
  /** Error-bar overlays (PBI Analytics → Error bars). */
  errorBars?: AnalyticsErrorBar[];
  /** Forecast projections (PBI Analytics → Forecast). */
  forecast?: AnalyticsForecast[];
  /** Symmetry shading (scatter only — PBI Analytics → Symmetry shading). */
  symmetry?: AnalyticsSymmetry;
  /** Anomaly-detection overlays (wave-5 — PBI Analytics → Find anomalies). */
  anomalies?: AnalyticsAnomaly[];
  /** Shaded value/category range bands (wave-5). */
  shadedRanges?: AnalyticsShadedRange[];
}

// ── Line-kind catalogue (PBI Analytics pane rows) ────────────────────────────

export interface AnalyticsKindMeta {
  kind: AnalyticsLineKind;
  label: string;
  hint: string;
  /** Needs at least one numeric series in the result (everything but constant). */
  needsSeries: boolean;
}

/** The reference-line types offered in the "Add a line" dropdown. */
export const ANALYTICS_LINE_KINDS: AnalyticsKindMeta[] = [
  { kind: 'trend',      label: 'Trend line',      hint: 'Least-squares fit across the series',  needsSeries: true },
  { kind: 'constant',   label: 'Constant line',   hint: 'A fixed value you set',                needsSeries: false },
  { kind: 'min',        label: 'Min line',        hint: 'Minimum of the series',                needsSeries: true },
  { kind: 'max',        label: 'Max line',        hint: 'Maximum of the series',                needsSeries: true },
  { kind: 'average',    label: 'Average line',    hint: 'Mean of the series',                   needsSeries: true },
  { kind: 'median',     label: 'Median line',     hint: 'Middle value of the series',           needsSeries: true },
  { kind: 'percentile', label: 'Percentile line', hint: 'A percentile (0–100) of the series',   needsSeries: true },
];

const KIND_LABEL: Record<AnalyticsLineKind, string> = ANALYTICS_LINE_KINDS.reduce(
  (acc, k) => { acc[k.kind] = k.label; return acc; },
  {} as Record<AnalyticsLineKind, string>,
);

const LINE_STYLES: { id: AnalyticsLineStyle; label: string }[] = [
  { id: 'solid',  label: 'Solid' },
  { id: 'dashed', label: 'Dashed' },
  { id: 'dotted', label: 'Dotted' },
];

/** Axis a CONSTANT line is constant ALONG (PBI: X-Axis / Y-Axis constant line). */
const CONSTANT_AXES: { id: 'y' | 'x'; label: string }[] = [
  { id: 'y', label: 'Y-Axis (horizontal)' },
  { id: 'x', label: 'X-Axis (vertical)' },
];

// ── Where the Analytics pane is available (PBI: cartesian value-axis charts) ──
// SINGLE SOURCE OF TRUTH, shared with report-designer's canvas: the host only
// invokes computeReferenceLines() for these types AND LoomChart only overlays a
// reference line for these, so the surface a user can AUTHOR here is exactly the
// surface the chart COMPUTES + DRAWS. Matches format-pane's CARTESIAN_TYPES
// (combo / ribbon / waterfall render through LoomChart's column/bar geometry and
// carry an overlaid reference line just like the base cartesian charts).
// Pie/donut/card/table/matrix/slicer have no value axis → not available (PBI
// shows "not available for this visual").
export const CARTESIAN_VISUAL_TYPES: ReadonlySet<string> = new Set([
  'bar', 'column', 'line', 'area', 'scatter', 'combo', 'ribbon', 'waterfall',
]);

/** True when the selected visual type supports reference lines. */
export function isAnalyticsAvailable(visualType?: string | null): boolean {
  return !!visualType && CARTESIAN_VISUAL_TYPES.has(visualType);
}

// ── Numeric-series extraction (lock-step with LoomChart.parseRows) ────────────
// Identical category/numeric column detection to lib/components/charts/loom-chart
// so the series this pane offers (and computes over) are exactly the series the
// chart draws — a reference line lands on the right axis.

function isNumeric(v: unknown): v is number {
  if (v == null || v === '') return false;
  return !Number.isNaN(Number(v));
}

export interface NumericSeries { name: string; values: number[] }

/** Extract the numeric value series from result rows (category column excluded). */
export function numericSeriesFromRows(rows: Array<Record<string, unknown>>): NumericSeries[] {
  if (!rows || rows.length === 0) return [];
  const cols = Object.keys(rows[0]);
  if (cols.length === 0) return [];

  const firstNumericIdx = cols.findIndex((c) => rows.some((r) => isNumeric(r[c])));
  const labelCol = firstNumericIdx === 0
    ? cols[0]
    : (cols.find((c) => rows.some((r) => !isNumeric(r[c]) && r[c] != null)) ?? cols[0]);
  const numericCols = cols.filter((c) => c !== labelCol && rows.some((r) => isNumeric(r[c])));

  return numericCols.map((col) => ({
    name: col,
    values: rows.map((r) => (isNumeric(r[col]) ? Number(r[col]) : 0)),
  }));
}

/** The series names a per-line "Series" picker should offer for these rows. */
export function seriesNamesFromRows(rows: Array<Record<string, unknown>>): string[] {
  return numericSeriesFromRows(rows).map((s) => s.name);
}

// ── Statistics ────────────────────────────────────────────────────────────────

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : Number.NaN;
}

function median(v: number[]): number {
  if (!v.length) return Number.NaN;
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Type-7 (linear-interpolation) percentile; pct is 0–100. */
function percentileOf(v: number[], pct: number): number {
  if (!v.length) return Number.NaN;
  const s = [...v].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const p = Math.min(100, Math.max(0, pct)) / 100;
  const idx = p * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return s[lo] + (s[hi] - s[lo]) * frac;
}

/** Least-squares fit over (i, values[i]); returns the y at the first/last point. */
function trendEndpoints(v: number[]): { yStart: number; yEnd: number } {
  const n = v.length;
  if (n === 0) return { yStart: Number.NaN, yEnd: Number.NaN };
  if (n === 1) return { yStart: v[0], yEnd: v[0] };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += v[i]; sumXY += i * v[i]; sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) { const m = mean(v); return { yStart: m, yEnd: m }; }
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { yStart: intercept, yEnd: intercept + slope * (n - 1) };
}

/** Least-squares slope/intercept over (i, v[i]); pairs with {@link trendEndpoints}. */
function linearFit(v: number[]): { slope: number; intercept: number } {
  const n = v.length;
  if (n < 2) return { slope: 0, intercept: n ? v[0] : 0 };
  const ends = trendEndpoints(v);
  const slope = (ends.yEnd - ends.yStart) / (n - 1);
  return { slope, intercept: ends.yStart };
}

/**
 * Standard-normal quantile (probit) — Acklam's rational approximation. Used to
 * turn a forecast confidence % into the ±k·stderr band multiplier; |error| <
 * 1.15e-9 over the full range, which is far tighter than we need to shade a band.
 */
function normInv(p: number): number {
  if (p <= 0) return -6; if (p >= 1) return 6;
  const a = [-3.969683028665376e+1, 2.209460984245205e+2, -2.759285104469687e+2, 1.383577518672690e+2, -3.066479806614716e+1, 2.506628277459239e+0];
  const b = [-5.447609879822406e+1, 1.615858368580409e+2, -1.556989798598866e+2, 6.680131188771972e+1, -1.328068155288572e+1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e+0, -2.549732539343734e+0, 4.374664141464968e+0, 2.938163982698783e+0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e+0, 3.754408661907416e+0];
  const plow = 0.02425, phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    const q = p - 0.5; const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Two-sided z multiplier for a confidence % (0–99); 95 ⇒ ≈1.96. */
function zForConfidence(confidence: number): number {
  const c = Math.min(99, Math.max(0, confidence)) / 100;
  return normInv((1 + c) / 2);
}

// ── Computed overlay lines (consumed by LoomChart) ───────────────────────────

/**
 * A resolved reference line ready for the chart to overlay. Horizontal lines
 * (constant/min/max/average/median/percentile) carry a single `y`; the trend
 * line additionally carries `y2` (the y at the right edge) so the chart draws a
 * sloped segment — `y2` is undefined for horizontal lines.
 */
export interface ComputedReferenceLine {
  id: string;
  kind: AnalyticsLineKind;
  /** Value-axis position (data space) at the left edge / for horizontal lines. */
  y: number;
  /** Trend only: value-axis position at the right edge. Undefined ⇒ horizontal. */
  y2?: number;
  color: string;
  style: AnalyticsLineStyle;
  /** Resolved label (name + value) when `showLabel`; otherwise undefined. */
  label?: string;
  /**
   * Wave-5: which axis the line is constant ALONG. 'h' (default / undefined)
   * reproduces the historical value-axis line; 'v' marks an X-Axis constant line
   * (a VERTICAL category-axis line) — LoomChart honors this via its refLines
   * `orientation` prop. Only emitted for a constant line authored with axis:'x',
   * so existing horizontal lines are byte-identical (no `orientation` key).
   */
  orientation?: 'h' | 'v';
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'M';
  if (Math.abs(v) >= 1_000) return (v / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + 'K';
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Resolve the numeric series a line targets (named `measure`, else primary). */
function seriesFor(line: AnalyticsLine, all: NumericSeries[]): NumericSeries | null {
  if (all.length === 0) return null;
  if (line.measure) {
    const named = all.find((s) => s.name === line.measure);
    if (named) return named;
  }
  return all[0];
}

/**
 * Resolve a visual's structured {@link ReportAnalytics} into the concrete
 * overlay lines the chart draws, from its real result `rows` (the same rows
 * LoomChart renders). Min/Max/Average/Median/Percentile/Trend are computed from
 * the targeted numeric series; Constant uses the author's typed value. Lines
 * that can't resolve (no numeric series, or an unset constant) are dropped —
 * never drawn at a bogus position — so there is never a dead/ghost line.
 */
export function computeReferenceLines(
  rows: Array<Record<string, unknown>>,
  analytics?: ReportAnalytics | null,
): ComputedReferenceLine[] {
  const lines = analytics?.lines;
  if (!lines || lines.length === 0) return [];
  const all = numericSeriesFromRows(rows);

  const out: ComputedReferenceLine[] = [];
  for (const line of lines) {
    let y: number;
    let y2: number | undefined;

    if (line.kind === 'constant') {
      // A typed numeric value (no series required); skip until it's a real number.
      if (line.value == null || !Number.isFinite(Number(line.value))) continue;
      y = Number(line.value);
    } else {
      const series = seriesFor(line, all);
      if (!series || series.values.length === 0) continue; // honest: nothing to compute over
      const v = series.values;
      switch (line.kind) {
        case 'min':        y = Math.min(...v); break;
        case 'max':        y = Math.max(...v); break;
        case 'average':    y = mean(v); break;
        case 'median':     y = median(v); break;
        case 'percentile': y = percentileOf(v, line.percentile ?? 50); break;
        case 'trend': {
          const t = trendEndpoints(v);
          y = t.yStart; y2 = t.yEnd; break;
        }
        default: continue;
      }
    }

    if (!Number.isFinite(y)) continue;

    let label: string | undefined;
    if (line.showLabel) {
      const name = (line.label && line.label.trim()) || KIND_LABEL[line.kind];
      const shown = line.kind === 'trend' ? fmtNum(y2 ?? y) : fmtNum(y);
      label = `${name} · ${shown}`;
    }

    // Wave-5: a CONSTANT line authored on the category axis (axis:'x') is a
    // VERTICAL line — surface it via `orientation:'v'` so LoomChart draws it
    // across the value axis at the category-index position `y`. Every other line
    // stays horizontal (no `orientation` key ⇒ byte-identical to prior output).
    const orientation: 'v' | undefined =
      line.kind === 'constant' && line.axis === 'x' ? 'v' : undefined;

    out.push({ id: line.id, kind: line.kind, y, y2, color: line.color, style: line.style, label, ...(orientation ? { orientation } : {}) });
  }
  return out;
}

// ── Computed error bars / forecast / symmetry (consumed by LoomChart) ────────

/**
 * A resolved error-bar overlay: one whisker per category in DATA space (the
 * chart maps `low`/`high` through its value-axis scale and draws the whisker at
 * the category's `index` on the x-axis). Never carries a bogus point — only
 * categories whose center value is finite are included.
 */
export interface ComputedErrorBar {
  id: string;
  color: string;
  showLabel: boolean;
  points: Array<{ index: number; center: number; low: number; high: number }>;
}

/**
 * Resolve a visual's {@link ReportAnalytics.errorBars} into drawable whiskers
 * from its real result `rows`. Field mode reads picked bound series (absolute
 * per category, falling back to the center value when a bound series is unset —
 * a one-sided whisker, never a dead control); percent / value are derived from
 * each center value. Definitions that can't resolve a series are dropped.
 */
export function computeErrorBars(
  rows: Array<Record<string, unknown>>,
  analytics?: ReportAnalytics | null,
): ComputedErrorBar[] {
  const defs = analytics?.errorBars;
  if (!defs || defs.length === 0) return [];
  const all = numericSeriesFromRows(rows);
  if (all.length === 0) return [];

  const out: ComputedErrorBar[] = [];
  for (const eb of defs) {
    const base = eb.measure ? (all.find((s) => s.name === eb.measure) ?? all[0]) : all[0];
    if (!base || base.values.length === 0) continue;
    const upper = eb.upperField ? all.find((s) => s.name === eb.upperField) : undefined;
    const lower = eb.lowerField ? all.find((s) => s.name === eb.lowerField) : undefined;

    const points: ComputedErrorBar['points'] = [];
    for (let i = 0; i < base.values.length; i++) {
      const center = base.values[i];
      if (!Number.isFinite(center)) continue;
      let low: number; let high: number;
      if (eb.mode === 'field') {
        high = upper && Number.isFinite(upper.values[i]) ? upper.values[i] : center;
        low = lower && Number.isFinite(lower.values[i]) ? lower.values[i] : center;
      } else if (eb.mode === 'percent') {
        const d = Math.abs(center) * ((eb.percent ?? 0) / 100);
        low = center - d; high = center + d;
      } else {
        const d = Math.abs(eb.value ?? 0);
        low = center - d; high = center + d;
      }
      if (low > high) { const t = low; low = high; high = t; }
      points.push({ index: i, center, low, high });
    }
    if (points.length === 0) continue;
    out.push({ id: eb.id, color: eb.color, showLabel: eb.showLabel, points });
  }
  return out;
}

/**
 * A resolved forecast: the projected points BEYOND history (indices continue
 * past `historyEndIndex`) with a confidence band for the chart to draw as a
 * dashed continuation + shaded ribbon.
 */
export interface ComputedForecast {
  id: string;
  /** Index of the last historical point; forecast indices continue past this. */
  historyEndIndex: number;
  points: Array<{ index: number; y: number; lower: number; upper: number }>;
}

/**
 * Project a single {@link AnalyticsForecast} forward from the visual's real
 * result `rows`. seasonality 0 ⇒ a least-squares linear trend (reusing
 * {@link linearFit}); seasonality L ⇒ that trend plus the average per-season
 * residual (additive seasonal-naive). The band is ±z·stderr·√h where z comes
 * from the confidence % and stderr is the residual standard error — so it
 * widens with the forecast horizon, like PBI. Returns null when there isn't
 * enough history (< 2 points) to fit.
 */
export function computeForecast(
  rows: Array<Record<string, unknown>>,
  fc: AnalyticsForecast,
): ComputedForecast | null {
  const all = numericSeriesFromRows(rows);
  if (all.length === 0) return null;
  const series = fc.measure ? (all.find((s) => s.name === fc.measure) ?? all[0]) : all[0];
  const v = series?.values ?? [];
  const n = v.length;
  if (n < 2) return null;

  const { slope, intercept } = linearFit(v);
  const periods = Math.min(60, Math.max(1, Math.round(fc.periods)));
  const L = fc.seasonality && fc.seasonality > 0 ? Math.max(2, Math.floor(fc.seasonality)) : 0;

  // Per-season residual averages (additive seasonal component).
  let seasonal: number[] = [];
  if (L > 1 && n >= L) {
    const sum = new Array<number>(L).fill(0);
    const cnt = new Array<number>(L).fill(0);
    for (let i = 0; i < n; i++) {
      const resid = v[i] - (intercept + slope * i);
      sum[i % L] += resid; cnt[i % L] += 1;
    }
    seasonal = sum.map((s, idx) => (cnt[idx] ? s / cnt[idx] : 0));
  }

  // Residual standard error about the fitted (trend + seasonal) series.
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const fitted = intercept + slope * i + (L > 1 ? (seasonal[i % L] ?? 0) : 0);
    ss += (v[i] - fitted) ** 2;
  }
  const stderr = Math.sqrt(ss / Math.max(1, n - 2));
  const z = zForConfidence(fc.confidence ?? 95);

  const points: ComputedForecast['points'] = [];
  for (let j = 1; j <= periods; j++) {
    const k = (n - 1) + j;
    const y = intercept + slope * k + (L > 1 ? (seasonal[k % L] ?? 0) : 0);
    const band = z * stderr * Math.sqrt(j);
    points.push({ index: k, y, lower: y - band, upper: y + band });
  }
  return { id: fc.id, historyEndIndex: n - 1, points };
}

/**
 * A resolved symmetry-shading overlay: the y=x diagonal endpoints span the
 * combined x/y data range so the chart can shade the upper / lower triangles.
 */
export interface ComputedSymmetry {
  id: string;
  color: string;
  min: number;
  max: number;
}

/**
 * Resolve {@link ReportAnalytics.symmetry} from the visual's real result rows.
 * Returns the y=x diagonal extent (min/max of the combined numeric range) when
 * shading is enabled and there's a non-degenerate range; otherwise null (no
 * ghost overlay).
 */
export function computeSymmetry(
  rows: Array<Record<string, unknown>>,
  analytics?: ReportAnalytics | null,
): ComputedSymmetry | null {
  const sym = analytics?.symmetry;
  if (!sym || !sym.enabled) return null;
  const all = numericSeriesFromRows(rows);
  if (all.length === 0) return null;
  let min = Number.POSITIVE_INFINITY; let max = Number.NEGATIVE_INFINITY;
  for (const s of all) {
    for (const x of s.values) {
      if (!Number.isFinite(x)) continue;
      if (x < min) min = x;
      if (x > max) max = x;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return null;
  return { id: sym.id, color: sym.color, min, max };
}

// ── Computed anomalies / shaded ranges (consumed by LoomChart, wave-5) ────────

/** The category-label series for these rows (lock-step with {@link numericSeriesFromRows}
 *  and LoomChart.parseRows — the first non-numeric column, else the first column). */
export function categoryLabelsFromRows(rows: Array<Record<string, unknown>>): string[] {
  if (!rows || rows.length === 0) return [];
  const cols = Object.keys(rows[0]);
  if (cols.length === 0) return [];
  const firstNumericIdx = cols.findIndex((c) => rows.some((r) => isNumeric(r[c])));
  const labelCol = firstNumericIdx === 0
    ? cols[0]
    : (cols.find((c) => rows.some((r) => !isNumeric(r[c]) && r[c] != null)) ?? cols[0]);
  return rows.map((r) => (r[labelCol] == null ? '—' : String(r[labelCol])));
}

/**
 * A resolved anomaly overlay ready for LoomChart's `anomalies` prop: every
 * category position with its plotted value + an `isAnomaly` flag, plus the
 * rolling expected `band` (low..high) keyed by category label. Structurally a
 * superset of LoomChart's `ChartAnomalies` (adds an `id`), so the designer passes
 * it straight through.
 */
export interface ComputedAnomaly {
  id: string;
  points: Array<{ x: string | number; value: number; isAnomaly: boolean }>;
  band: Array<{ x: string | number; low: number; high: number }>;
  color: string;
}

/**
 * Resolve a visual's {@link ReportAnalytics.anomalies} into drawable overlays
 * from its real result `rows`. For each definition a TRAILING rolling window
 * (`window = clamp(round(n/8), 3, 24)`) yields a rolling mean + sample standard
 * deviation; a point is flagged when `|value − mean| / sd` exceeds a
 * sensitivity-driven z threshold (`3.5 − (sensitivity/100)·2` ⇒ ~1.5σ at 100,
 * ~3.5σ at 0). The expected `band` is `mean ± z·sd`. A real computation — no
 * approximate caption. Definitions that resolve no series (or flag nothing and
 * have no band) are dropped so there is never a ghost overlay. When `useAdx` is
 * set the host may instead post `series_decompose_anomalies` to a bound ADX
 * source; this client pass is the no-Kusto-source default.
 */
export function computeAnomalies(
  rows: Array<Record<string, unknown>>,
  analytics?: ReportAnalytics | null,
): ComputedAnomaly[] {
  const defs = analytics?.anomalies;
  if (!defs || defs.length === 0) return [];
  if (!rows || rows.length === 0) return [];
  const all = numericSeriesFromRows(rows);
  if (all.length === 0) return [];
  const cats = categoryLabelsFromRows(rows);

  const out: ComputedAnomaly[] = [];
  for (const def of defs) {
    const series = def.measure ? (all.find((s) => s.name === def.measure) ?? all[0]) : all[0];
    if (!series || series.values.length === 0) continue;
    const vals = series.values;
    const n = vals.length;
    const window = Math.min(24, Math.max(3, Math.round(n / 8)));
    const sens = Math.min(100, Math.max(0, Number(def.sensitivity ?? 50)));
    const zThreshold = 3.5 - (sens / 100) * 2.0;

    const points: ComputedAnomaly['points'] = [];
    const band: ComputedAnomaly['band'] = [];
    let flagged = 0;
    for (let i = 0; i < n; i++) {
      const win = vals.slice(Math.max(0, i - window + 1), i + 1).filter((v) => Number.isFinite(v));
      const m = win.length ? win.reduce((a, b) => a + b, 0) / win.length : 0;
      const variance = win.length > 1 ? win.reduce((a, b) => a + (b - m) ** 2, 0) / (win.length - 1) : 0;
      const sd = Math.sqrt(variance);
      const x = cats[i] ?? String(i);
      const v = vals[i];
      const isAnomaly = sd > 0 && Number.isFinite(v) && Math.abs((v - m) / sd) > zThreshold;
      if (isAnomaly) flagged += 1;
      points.push({ x, value: Number.isFinite(v) ? v : 0, isAnomaly });
      if (sd > 0) band.push({ x, low: m - zThreshold * sd, high: m + zThreshold * sd });
    }
    // Nothing to draw (flat series ⇒ no band, no flags) ⇒ drop, never a ghost overlay.
    if (band.length === 0 && flagged === 0) continue;
    out.push({ id: def.id, points, band, color: def.color });
  }
  return out;
}

/**
 * A resolved shaded range ready for LoomChart's `shadedRanges` prop. A structural
 * superset of LoomChart's `ChartShadedRange` (adds an `id`), so the designer passes
 * it straight through.
 */
export interface ComputedShadedRange {
  id: string;
  from: number;
  to: number;
  axis: 'x' | 'y';
  color: string;
}

/**
 * Resolve {@link ReportAnalytics.shadedRanges} into LoomChart shaded-range bands.
 * A pure pass-through of the author's STRUCTURED numeric inputs — ranges whose
 * `from`/`to` aren't finite are dropped so nothing draws at a bogus position.
 */
export function computeShadedRanges(
  analytics?: ReportAnalytics | null,
): ComputedShadedRange[] {
  const defs = analytics?.shadedRanges;
  if (!defs || defs.length === 0) return [];
  const out: ComputedShadedRange[] = [];
  for (const r of defs) {
    if (!Number.isFinite(r.from) || !Number.isFinite(r.to)) continue;
    out.push({ id: r.id, from: r.from, to: r.to, axis: r.axis === 'x' ? 'x' : 'y', color: r.color });
  }
  return out;
}

// ── Model helpers (parse / construct) ────────────────────────────────────────

/** An empty analytics model (no reference lines). */
export function emptyAnalytics(): ReportAnalytics {
  return { lines: [] };
}

/** True when a model has at least one reference line, error bar, forecast, active symmetry shading, anomaly, or shaded range. */
export function hasAnalytics(a?: ReportAnalytics | null): boolean {
  if (!a) return false;
  return (Array.isArray(a.lines) && a.lines.length > 0)
    || (Array.isArray(a.errorBars) && a.errorBars.length > 0)
    || (Array.isArray(a.forecast) && a.forecast.length > 0)
    || (!!a.symmetry && a.symmetry.enabled === true)
    || (Array.isArray(a.anomalies) && a.anomalies.length > 0)
    || (Array.isArray(a.shadedRanges) && a.shadedRanges.length > 0);
}

function uid(): string {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? `al_${crypto.randomUUID().slice(0, 8)}`
    : `al_${Math.random().toString(16).slice(2, 10)}`;
}

const KIND_SET = new Set<AnalyticsLineKind>(ANALYTICS_LINE_KINDS.map((k) => k.kind));
const STYLE_SET = new Set<AnalyticsLineStyle>(['solid', 'dashed', 'dotted']);
const ERRORBAR_MODE_SET = new Set<ErrorBarMode>(['field', 'percent', 'value']);

/** Coerce a wire value to a finite number, optionally clamped; undefined otherwise. */
function numOrUndef(x: unknown, lo?: number, hi?: number): number | undefined {
  if (typeof x !== 'number' || !Number.isFinite(x)) return undefined;
  let v = x;
  if (lo != null) v = Math.max(lo, v);
  if (hi != null) v = Math.min(hi, v);
  return v;
}

/** Defensively hydrate persisted error-bar definitions (unknown shapes dropped). */
function parseErrorBars(value: unknown): AnalyticsErrorBar[] {
  if (!Array.isArray(value)) return [];
  const out: AnalyticsErrorBar[] = [];
  for (const r of value) {
    const o = (r || {}) as Record<string, unknown>;
    const mode = o.mode as ErrorBarMode;
    if (!ERRORBAR_MODE_SET.has(mode)) continue;
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id : uid(),
      measure: typeof o.measure === 'string' && o.measure ? o.measure : undefined,
      mode,
      upperField: typeof o.upperField === 'string' && o.upperField ? o.upperField : undefined,
      lowerField: typeof o.lowerField === 'string' && o.lowerField ? o.lowerField : undefined,
      percent: numOrUndef(o.percent, 0, 100),
      value: numOrUndef(o.value),
      color: typeof o.color === 'string' && o.color ? o.color : LOOM_DATA_PALETTE[0].token,
      showLabel: o.showLabel !== false,
    });
  }
  return out;
}

/** Defensively hydrate persisted forecast definitions (unknown shapes dropped). */
function parseForecasts(value: unknown): AnalyticsForecast[] {
  if (!Array.isArray(value)) return [];
  const out: AnalyticsForecast[] = [];
  for (const r of value) {
    const o = (r || {}) as Record<string, unknown>;
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id : uid(),
      measure: typeof o.measure === 'string' && o.measure ? o.measure : undefined,
      periods: numOrUndef(o.periods, 1, 60) ?? 10,
      seasonality: numOrUndef(o.seasonality, 0),
      confidence: numOrUndef(o.confidence, 0, 99),
    });
  }
  return out;
}

/** Defensively hydrate persisted symmetry shading (fully-default/disabled → undefined). */
function parseSymmetry(value: unknown): AnalyticsSymmetry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const o = value as Record<string, unknown>;
  const enabled = o.enabled === true;
  const hasColor = typeof o.color === 'string' && !!o.color;
  if (!enabled && !hasColor) return undefined;
  return {
    id: typeof o.id === 'string' && o.id ? o.id : uid(),
    enabled,
    color: hasColor ? (o.color as string) : LOOM_DATA_PALETTE[2].token,
  };
}

/** Defensively hydrate persisted anomaly-detection definitions (unknown shapes dropped). */
function parseAnomalies(value: unknown): AnalyticsAnomaly[] {
  if (!Array.isArray(value)) return [];
  const out: AnalyticsAnomaly[] = [];
  for (const r of value) {
    const o = (r || {}) as Record<string, unknown>;
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id : uid(),
      measure: typeof o.measure === 'string' && o.measure ? o.measure : undefined,
      sensitivity: numOrUndef(o.sensitivity, 0, 100) ?? 50,
      color: typeof o.color === 'string' && o.color ? o.color : LOOM_DATA_PALETTE[4].token,
      useAdx: o.useAdx === true ? true : undefined,
    });
  }
  return out;
}

/** Defensively hydrate persisted shaded-range definitions (non-finite bounds dropped). */
function parseShadedRanges(value: unknown): AnalyticsShadedRange[] {
  if (!Array.isArray(value)) return [];
  const out: AnalyticsShadedRange[] = [];
  for (const r of value) {
    const o = (r || {}) as Record<string, unknown>;
    const from = numOrUndef(o.from);
    const to = numOrUndef(o.to);
    if (from == null || to == null) continue;
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id : uid(),
      from,
      to,
      axis: o.axis === 'x' ? 'x' : 'y',
      color: typeof o.color === 'string' && o.color ? o.color : LOOM_DATA_PALETTE[5].token,
    });
  }
  return out;
}

/**
 * Defensively parse a persisted/wire value into {@link ReportAnalytics} (it
 * arrives from Cosmos `visual.config.analytics` or a PUT body). Unknown shapes
 * yield an empty model so the pane degrades gracefully rather than throwing.
 * Wave-2 families (errorBars / forecast / symmetry) hydrate alongside `lines`;
 * each is optional and parsed independently, so a model with only error bars
 * (and no reference lines) round-trips intact.
 */
export function parseAnalytics(value: unknown): ReportAnalytics {
  if (!value || typeof value !== 'object') return emptyAnalytics();
  const obj = value as Record<string, unknown>;
  const raw = obj.lines;
  const lines: AnalyticsLine[] = [];
  for (const r of (Array.isArray(raw) ? raw : [])) {
    const o = (r || {}) as Record<string, unknown>;
    const kind = o.kind as AnalyticsLineKind;
    if (!KIND_SET.has(kind)) continue;
    const style = STYLE_SET.has(o.style as AnalyticsLineStyle) ? (o.style as AnalyticsLineStyle) : 'dashed';
    const color = typeof o.color === 'string' && o.color ? o.color : LOOM_DATA_PALETTE[0].token;
    lines.push({
      id: typeof o.id === 'string' && o.id ? o.id : uid(),
      kind,
      axis: o.axis === 'x' ? 'x' : undefined,
      measure: typeof o.measure === 'string' && o.measure ? o.measure : undefined,
      value: typeof o.value === 'number' && Number.isFinite(o.value) ? o.value : undefined,
      percentile: typeof o.percentile === 'number' && Number.isFinite(o.percentile)
        ? Math.min(100, Math.max(0, o.percentile)) : undefined,
      color,
      style,
      label: typeof o.label === 'string' && o.label ? o.label : undefined,
      showLabel: o.showLabel !== false,
    });
  }
  const model: ReportAnalytics = { lines };
  const errorBars = parseErrorBars(obj.errorBars);
  if (errorBars.length) model.errorBars = errorBars;
  const forecast = parseForecasts(obj.forecast);
  if (forecast.length) model.forecast = forecast;
  const symmetry = parseSymmetry(obj.symmetry);
  if (symmetry) model.symmetry = symmetry;
  const anomalies = parseAnomalies(obj.anomalies);
  if (anomalies.length) model.anomalies = anomalies;
  const shadedRanges = parseShadedRanges(obj.shadedRanges);
  if (shadedRanges.length) model.shadedRanges = shadedRanges;
  return model;
}

/** Construct a new reference line with sensible per-kind defaults. */
function newLine(kind: AnalyticsLineKind, index: number): AnalyticsLine {
  return {
    id: uid(),
    kind,
    color: LOOM_DATA_PALETTE[index % LOOM_DATA_PALETTE.length].token,
    style: 'dashed',
    showLabel: true,
    ...(kind === 'constant' ? { value: 0 } : {}),
    ...(kind === 'percentile' ? { percentile: 50 } : {}),
  };
}

/** Construct a new error-bar definition (defaults: ±10% of each value). */
function newErrorBar(index: number): AnalyticsErrorBar {
  return {
    id: uid(),
    mode: 'percent',
    percent: 10,
    color: LOOM_DATA_PALETTE[(index + 4) % LOOM_DATA_PALETTE.length].token,
    showLabel: true,
  };
}

/** Construct a new forecast definition (defaults: 10 linear periods, 95% band). */
function newForecast(): AnalyticsForecast {
  return { id: uid(), periods: 10, seasonality: 0, confidence: 95 };
}

/** Construct an enabled symmetry-shading definition. */
function newSymmetry(): AnalyticsSymmetry {
  return { id: uid(), enabled: true, color: LOOM_DATA_PALETTE[2].token };
}

/** Construct a new anomaly-detection definition (defaults: 50% sensitivity, client pass). */
function newAnomaly(): AnalyticsAnomaly {
  return { id: uid(), sensitivity: 50, color: LOOM_DATA_PALETTE[4].token };
}

/** Construct a new shaded-range definition (defaults: a value-axis 0–10 band). */
function newShadedRange(): AnalyticsShadedRange {
  return { id: uid(), from: 0, to: 10, axis: 'y', color: LOOM_DATA_PALETTE[5].token };
}

/** Prune a model to its sparse persisted shape (drop empty families). */
function pruneModel(m: ReportAnalytics): ReportAnalytics {
  const out: ReportAnalytics = { lines: m.lines ?? [] };
  if (m.errorBars && m.errorBars.length) out.errorBars = m.errorBars;
  if (m.forecast && m.forecast.length) out.forecast = m.forecast;
  if (m.symmetry) out.symmetry = m.symmetry;
  if (m.anomalies && m.anomalies.length) out.anomalies = m.anomalies;
  if (m.shadedRanges && m.shadedRanges.length) out.shadedRanges = m.shadedRanges;
  return out;
}

// ── styles (Fluent v9 + Loom tokens; matches format-pane.tsx) ────────────────

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minHeight: 0 },
  sectionHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground2,
  },
  addRow: { display: 'flex', alignItems: 'flex-end', gap: tokens.spacingHorizontalXS },
  addCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, flex: 1, minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  card: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  cardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  cardKind: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS,
    color: tokens.colorNeutralForeground2,
  },
  cardName: { flex: 1, minWidth: 0 },
  fieldRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  fieldCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0, flex: 1 },
  swatchGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(8, minmax(0, 1fr))',
    gap: tokens.spacingHorizontalXXS,
  },
  swatchBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: tokens.spacingVerticalXXS, minWidth: 0, cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    transitionProperty: 'border-color, box-shadow', transitionDuration: tokens.durationFaster,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  swatchBtnActive: { border: `2px solid ${tokens.colorBrandStroke1}`, boxShadow: tokens.shadow4 },
  swatchDot: {
    width: '16px', height: '16px', borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  muted: { color: tokens.colorNeutralForeground3 },
});

// ── Section header helper ─────────────────────────────────────────────────────

function SectionHead({ icon, label, styles }: { icon: ReactElement; label: string; styles: ReturnType<typeof useStyles> }) {
  return (
    <div className={styles.sectionHead}>
      {icon}
      <Caption1><strong>{label}</strong></Caption1>
    </div>
  );
}

// ── A single reference-line card ──────────────────────────────────────────────

const PRIMARY_SERIES = '__primary__';

function LineCard({
  line, index, seriesNames, styles, onChange, onRemove,
}: {
  line: AnalyticsLine;
  index: number;
  seriesNames: string[];
  styles: ReturnType<typeof useStyles>;
  onChange: (patch: Partial<AnalyticsLine>) => void;
  onRemove: () => void;
}): ReactElement {
  const baseId = useId();
  const meta = ANALYTICS_LINE_KINDS.find((k) => k.kind === line.kind);
  const showSeries = meta?.needsSeries && seriesNames.length > 1;
  const seriesValue = line.measure && seriesNames.includes(line.measure) ? line.measure : PRIMARY_SERIES;
  const styleLabel = LINE_STYLES.find((s) => s.id === line.style)?.label ?? 'Dashed';

  return (
    <div className={styles.card}>
      {/* head: kind + name + remove */}
      <div className={styles.cardHead}>
        <span className={styles.cardKind}>
          <LineHorizontal120Regular />
          <Caption1><strong>{KIND_LABEL[line.kind]}</strong></Caption1>
        </span>
        <span style={{ flex: 1 }} />
        <Button
          appearance="subtle"
          size="small"
          icon={<Delete20Regular />}
          aria-label={`Remove ${KIND_LABEL[line.kind]}`}
          title="Remove line"
          onClick={onRemove}
        />
      </div>

      {/* name */}
      <Input
        size="small"
        id={`${baseId}-name`}
        aria-label="Line name"
        placeholder={KIND_LABEL[line.kind]}
        value={line.label ?? ''}
        onChange={(_e, d) => onChange({ label: d.value })}
      />

      {/* constant value (numeric) + axis (Y horizontal / X vertical) */}
      {line.kind === 'constant' && (
        <>
          <div className={styles.fieldCol}>
            <Caption1 className={styles.muted}>Axis</Caption1>
            <Dropdown
              size="small"
              aria-label="Constant line axis"
              value={(CONSTANT_AXES.find((a) => a.id === (line.axis ?? 'y')) ?? CONSTANT_AXES[0]).label}
              selectedOptions={[line.axis ?? 'y']}
              onOptionSelect={(_e, d) => onChange({ axis: d.optionValue === 'x' ? 'x' : undefined })}
            >
              {CONSTANT_AXES.map((a) => (
                <Option key={a.id} value={a.id} text={a.label}>{a.label}</Option>
              ))}
            </Dropdown>
          </div>
          <div className={styles.fieldCol}>
            <Caption1 className={styles.muted}>
              {(line.axis ?? 'y') === 'x' ? 'Category position (index)' : 'Value'}
            </Caption1>
            <Input
              size="small"
              type="number"
              aria-label="Constant value"
              value={line.value == null ? '' : String(line.value)}
              onChange={(_e, d) => {
                const n = Number(d.value);
                onChange({ value: d.value === '' || Number.isNaN(n) ? undefined : n });
              }}
            />
          </div>
        </>
      )}

      {/* percentile (0–100) */}
      {line.kind === 'percentile' && (
        <div className={styles.fieldCol}>
          <Caption1 className={styles.muted}>Percentile (0–100)</Caption1>
          <Input
            size="small"
            type="number"
            min={0}
            max={100}
            aria-label="Percentile"
            value={line.percentile == null ? '' : String(line.percentile)}
            onChange={(_e, d) => {
              const n = Number(d.value);
              onChange({ percentile: d.value === '' || Number.isNaN(n) ? undefined : Math.min(100, Math.max(0, n)) });
            }}
          />
        </div>
      )}

      {/* series picker (only when multiple numeric series exist) */}
      {showSeries && (
        <div className={styles.fieldCol}>
          <Caption1 className={styles.muted}>Series</Caption1>
          <Dropdown
            size="small"
            aria-label="Series"
            value={seriesValue === PRIMARY_SERIES ? 'Primary series' : seriesValue}
            selectedOptions={[seriesValue]}
            onOptionSelect={(_e, d) =>
              onChange({ measure: d.optionValue === PRIMARY_SERIES ? undefined : (d.optionValue || undefined) })
            }
          >
            <Option value={PRIMARY_SERIES} text="Primary series">Primary series</Option>
            {seriesNames.map((s) => (
              <Option key={s} value={s} text={s}>{s}</Option>
            ))}
          </Dropdown>
        </div>
      )}

      {/* color swatches (lock-step with LoomChart palette) */}
      <div className={styles.fieldCol}>
        <Caption1 className={styles.muted}>Color</Caption1>
        <div className={styles.swatchGrid} role="radiogroup" aria-label="Line color">
          {LOOM_DATA_PALETTE.map((sw) => {
            const active = line.color === sw.token;
            return (
              <button
                key={sw.token}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={sw.label}
                title={sw.label}
                className={mergeClasses(styles.swatchBtn, active && styles.swatchBtnActive)}
                onClick={() => onChange({ color: sw.token })}
              >
                <span className={styles.swatchDot} style={{ backgroundColor: sw.token }} aria-hidden />
              </button>
            );
          })}
        </div>
      </div>

      {/* style + show label */}
      <div className={styles.fieldRow}>
        <div className={styles.fieldCol}>
          <Caption1 className={styles.muted}>Style</Caption1>
          <Dropdown
            size="small"
            aria-label="Line style"
            value={styleLabel}
            selectedOptions={[line.style]}
            onOptionSelect={(_e, d) => onChange({ style: (d.optionValue as AnalyticsLineStyle) || 'dashed' })}
          >
            {LINE_STYLES.map((s) => (
              <Option key={s.id} value={s.id} text={s.label}>{s.label}</Option>
            ))}
          </Dropdown>
        </div>
        <Switch
          label="Show label"
          checked={line.showLabel}
          onChange={(_e, d) => onChange({ showLabel: d.checked })}
        />
      </div>
    </div>
  );
}

// ── Shared structured pickers (color swatches + series dropdown) ─────────────

/** Brand-palette swatch picker (lock-step with LoomChart), reused by all cards. */
function ColorSwatches({ value, styles, onPick, label = 'Color' }: {
  value: string;
  styles: ReturnType<typeof useStyles>;
  onPick: (token: string) => void;
  label?: string;
}): ReactElement {
  return (
    <div className={styles.fieldCol}>
      <Caption1 className={styles.muted}>{label}</Caption1>
      <div className={styles.swatchGrid} role="radiogroup" aria-label={label}>
        {LOOM_DATA_PALETTE.map((sw) => {
          const active = value === sw.token;
          return (
            <button
              key={sw.token}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={sw.label}
              title={sw.label}
              className={mergeClasses(styles.swatchBtn, active && styles.swatchBtnActive)}
              onClick={() => onPick(sw.token)}
            >
              <span className={styles.swatchDot} style={{ backgroundColor: sw.token }} aria-hidden />
            </button>
          );
        })}
      </div>
    </div>
  );
}

const NONE_SERIES = '__none__';

/**
 * A structured numeric-series picker. `includePrimary` offers a "Primary series"
 * sentinel (→ undefined measure); `noneLabel` offers an explicit unset sentinel
 * (→ undefined) so a bound field can truthfully read "not set" — never a typed
 * column name.
 */
function SeriesPicker({
  label, value, seriesNames, styles, onChange,
  includePrimary = false, primaryLabel = 'Primary series', noneLabel,
}: {
  label: string;
  value?: string;
  seriesNames: string[];
  styles: ReturnType<typeof useStyles>;
  onChange: (name: string | undefined) => void;
  includePrimary?: boolean;
  primaryLabel?: string;
  noneLabel?: string;
}): ReactElement {
  const hasValue = !!value && seriesNames.includes(value);
  const fallback = includePrimary ? PRIMARY_SERIES : (noneLabel ? NONE_SERIES : (seriesNames[0] ?? ''));
  const selected = hasValue ? (value as string) : fallback;
  const shown = selected === PRIMARY_SERIES ? primaryLabel : (selected === NONE_SERIES ? (noneLabel as string) : selected);
  return (
    <div className={styles.fieldCol}>
      <Caption1 className={styles.muted}>{label}</Caption1>
      <Dropdown
        size="small"
        aria-label={label}
        value={shown}
        selectedOptions={[selected]}
        onOptionSelect={(_e, d) =>
          onChange(d.optionValue === PRIMARY_SERIES || d.optionValue === NONE_SERIES ? undefined : (d.optionValue || undefined))
        }
      >
        {includePrimary && <Option value={PRIMARY_SERIES} text={primaryLabel}>{primaryLabel}</Option>}
        {noneLabel && <Option value={NONE_SERIES} text={noneLabel}>{noneLabel}</Option>}
        {seriesNames.map((s) => (
          <Option key={s} value={s} text={s}>{s}</Option>
        ))}
      </Dropdown>
    </div>
  );
}

// ── Error-bar card (PBI Analytics → Error bars) ──────────────────────────────

const ERRORBAR_MODES: { id: ErrorBarMode; label: string }[] = [
  { id: 'percent', label: 'Percentage' },
  { id: 'value',   label: 'Value' },
  { id: 'field',   label: 'By field' },
];

function ErrorBarCard({
  bar, seriesNames, styles, onChange, onRemove,
}: {
  bar: AnalyticsErrorBar;
  seriesNames: string[];
  styles: ReturnType<typeof useStyles>;
  onChange: (patch: Partial<AnalyticsErrorBar>) => void;
  onRemove: () => void;
}): ReactElement {
  const modeLabel = ERRORBAR_MODES.find((m) => m.id === bar.mode)?.label ?? 'Percentage';
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardKind}>
          <ArrowBidirectionalUpDown20Regular />
          <Caption1><strong>Error bars</strong></Caption1>
        </span>
        <span style={{ flex: 1 }} />
        <Button
          appearance="subtle"
          size="small"
          icon={<Delete20Regular />}
          aria-label="Remove error bars"
          title="Remove error bars"
          onClick={onRemove}
        />
      </div>

      {seriesNames.length > 1 && (
        <SeriesPicker
          label="Apply to"
          value={bar.measure}
          seriesNames={seriesNames}
          styles={styles}
          includePrimary
          onChange={(name) => onChange({ measure: name })}
        />
      )}

      <div className={styles.fieldCol}>
        <Caption1 className={styles.muted}>Type</Caption1>
        <Dropdown
          size="small"
          aria-label="Error bar type"
          value={modeLabel}
          selectedOptions={[bar.mode]}
          onOptionSelect={(_e, d) => onChange({ mode: (d.optionValue as ErrorBarMode) || 'percent' })}
        >
          {ERRORBAR_MODES.map((m) => (
            <Option key={m.id} value={m.id} text={m.label}>{m.label}</Option>
          ))}
        </Dropdown>
      </div>

      {bar.mode === 'percent' && (
        <div className={styles.fieldCol}>
          <Caption1 className={styles.muted}>± Percentage (0–100)</Caption1>
          <Input
            size="small"
            type="number"
            min={0}
            max={100}
            aria-label="Error bar percentage"
            value={bar.percent == null ? '' : String(bar.percent)}
            onChange={(_e, d) => {
              const n = Number(d.value);
              onChange({ percent: d.value === '' || Number.isNaN(n) ? undefined : Math.min(100, Math.max(0, n)) });
            }}
          />
        </div>
      )}

      {bar.mode === 'value' && (
        <div className={styles.fieldCol}>
          <Caption1 className={styles.muted}>± Value</Caption1>
          <Input
            size="small"
            type="number"
            aria-label="Error bar value"
            value={bar.value == null ? '' : String(bar.value)}
            onChange={(_e, d) => {
              const n = Number(d.value);
              onChange({ value: d.value === '' || Number.isNaN(n) ? undefined : n });
            }}
          />
        </div>
      )}

      {bar.mode === 'field' && (
        seriesNames.length === 0 ? (
          <Caption1 className={styles.muted}>
            No additional numeric series to use as bounds — switch to Percentage or Value.
          </Caption1>
        ) : (
          <>
            <SeriesPicker
              label="Upper bound field"
              value={bar.upperField}
              seriesNames={seriesNames}
              styles={styles}
              noneLabel="Center (no upper)"
              onChange={(name) => onChange({ upperField: name })}
            />
            <SeriesPicker
              label="Lower bound field"
              value={bar.lowerField}
              seriesNames={seriesNames}
              styles={styles}
              noneLabel="Center (no lower)"
              onChange={(name) => onChange({ lowerField: name })}
            />
          </>
        )
      )}

      <ColorSwatches value={bar.color} styles={styles} onPick={(t) => onChange({ color: t })} />

      <Switch
        label="Show labels"
        checked={bar.showLabel}
        onChange={(_e, d) => onChange({ showLabel: d.checked })}
      />
    </div>
  );
}

// ── Forecast card (PBI Analytics → Forecast) ─────────────────────────────────

function ForecastCard({
  fc, seriesNames, styles, onChange, onRemove,
}: {
  fc: AnalyticsForecast;
  seriesNames: string[];
  styles: ReturnType<typeof useStyles>;
  onChange: (patch: Partial<AnalyticsForecast>) => void;
  onRemove: () => void;
}): ReactElement {
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardKind}>
          <ArrowTrendingLines20Regular />
          <Caption1><strong>Forecast</strong></Caption1>
        </span>
        <span style={{ flex: 1 }} />
        <Button
          appearance="subtle"
          size="small"
          icon={<Delete20Regular />}
          aria-label="Remove forecast"
          title="Remove forecast"
          onClick={onRemove}
        />
      </div>

      {seriesNames.length > 1 && (
        <SeriesPicker
          label="Series"
          value={fc.measure}
          seriesNames={seriesNames}
          styles={styles}
          includePrimary
          onChange={(name) => onChange({ measure: name })}
        />
      )}

      <div className={styles.fieldRow}>
        <div className={styles.fieldCol}>
          <Caption1 className={styles.muted}>Forecast length (1–60)</Caption1>
          <Input
            size="small"
            type="number"
            min={1}
            max={60}
            aria-label="Forecast length"
            value={String(fc.periods)}
            onChange={(_e, d) => {
              const n = Number(d.value);
              if (d.value !== '' && Number.isFinite(n)) onChange({ periods: Math.min(60, Math.max(1, Math.round(n))) });
            }}
          />
        </div>
        <div className={styles.fieldCol}>
          <Caption1 className={styles.muted}>Seasonality (0 = none)</Caption1>
          <Input
            size="small"
            type="number"
            min={0}
            aria-label="Seasonality (season length)"
            value={fc.seasonality == null ? '' : String(fc.seasonality)}
            onChange={(_e, d) => {
              const n = Number(d.value);
              onChange({ seasonality: d.value === '' || Number.isNaN(n) ? undefined : Math.max(0, Math.floor(n)) });
            }}
          />
        </div>
      </div>

      <div className={styles.fieldCol}>
        <Caption1 className={styles.muted}>Confidence band (0–99)</Caption1>
        <Input
          size="small"
          type="number"
          min={0}
          max={99}
          aria-label="Confidence band"
          value={fc.confidence == null ? '' : String(fc.confidence)}
          onChange={(_e, d) => {
            const n = Number(d.value);
            onChange({ confidence: d.value === '' || Number.isNaN(n) ? undefined : Math.min(99, Math.max(0, n)) });
          }}
        />
      </div>

      <Caption1 className={styles.hint}>
        Least-squares linear trend when seasonality is 0; additive-seasonal projection otherwise.
        The confidence percentage sets the shaded band, which widens with the horizon.
      </Caption1>
    </div>
  );
}

// ── Symmetry-shading card (PBI Analytics → Symmetry shading, scatter only) ────

function SymmetryCard({
  symmetry, isScatter, styles, onChange,
}: {
  symmetry?: AnalyticsSymmetry;
  isScatter: boolean;
  styles: ReturnType<typeof useStyles>;
  onChange: (patch: Partial<AnalyticsSymmetry>) => void;
}): ReactElement {
  if (!isScatter) {
    // Honest informational note (NOT a dead control) — PBI shows symmetry only on scatter.
    return (
      <Caption1 className={styles.muted}>
        Symmetry shading is available for scatter charts. Switch the selected visual to a scatter
        chart to shade the upper / lower triangles split by the y=x diagonal.
      </Caption1>
    );
  }
  const enabled = symmetry?.enabled ?? false;
  const color = symmetry?.color ?? LOOM_DATA_PALETTE[2].token;
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardKind}>
          <ArrowSplit20Regular />
          <Caption1><strong>Symmetry shading</strong></Caption1>
        </span>
        <span style={{ flex: 1 }} />
        <Switch
          checked={enabled}
          aria-label="Enable symmetry shading"
          onChange={(_e, d) => onChange({ enabled: d.checked })}
        />
      </div>
      <Caption1 className={styles.muted}>
        Shade the upper / lower triangles split by the y=x diagonal to spot points above / below parity.
      </Caption1>
      {enabled && (
        <ColorSwatches value={color} styles={styles} onPick={(t) => onChange({ color: t })} />
      )}
    </div>
  );
}

// ── Anomaly-detection card (PBI Analytics → Find anomalies, scatter excluded) ──

function AnomalyCard({
  anomaly, seriesNames, adxAvailable, styles, onChange, onRemove,
}: {
  anomaly: AnalyticsAnomaly;
  seriesNames: string[];
  /** True when the report is bound to a Kusto / ADX source (enables the ADX path). */
  adxAvailable: boolean;
  styles: ReturnType<typeof useStyles>;
  onChange: (patch: Partial<AnalyticsAnomaly>) => void;
  onRemove: () => void;
}): ReactElement {
  const sens = Math.min(100, Math.max(0, anomaly.sensitivity ?? 50));
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardKind}>
          <Warning20Regular />
          <Caption1><strong>Anomaly detection</strong></Caption1>
        </span>
        <span style={{ flex: 1 }} />
        <Button
          appearance="subtle"
          size="small"
          icon={<Delete20Regular />}
          aria-label="Remove anomaly detection"
          title="Remove anomaly detection"
          onClick={onRemove}
        />
      </div>

      {seriesNames.length > 1 && (
        <SeriesPicker
          label="Scan series"
          value={anomaly.measure}
          seriesNames={seriesNames}
          styles={styles}
          includePrimary
          onChange={(name) => onChange({ measure: name })}
        />
      )}

      <div className={styles.fieldCol}>
        <Caption1 className={styles.muted}>Sensitivity — {sens} (higher flags more)</Caption1>
        <Slider
          min={0}
          max={100}
          step={1}
          value={sens}
          aria-label="Anomaly sensitivity"
          onChange={(_e, d) => onChange({ sensitivity: Math.min(100, Math.max(0, d.value)) })}
        />
      </div>

      <ColorSwatches value={anomaly.color} styles={styles} onPick={(t) => onChange({ color: t })} label="Marker color" />

      <Switch
        label="Use Azure Data Explorer (series_decompose_anomalies)"
        checked={anomaly.useAdx === true}
        onChange={(_e, d) => onChange({ useAdx: d.checked ? true : undefined })}
      />
      {anomaly.useAdx === true && !adxAvailable ? (
        <Caption1 className={styles.muted}>
          <DatabasePlugConnected20Regular style={{ verticalAlign: 'text-bottom', marginRight: tokens.spacingHorizontalXS }} />
          ADX path needs a Kusto-bound model. Bind an Azure Data Explorer source to run
          series_decompose_anomalies on the cluster — the in-browser rolling z-score computation is used until then.
        </Caption1>
      ) : (
        <Caption1 className={styles.hint}>
          {anomaly.useAdx === true
            ? 'Anomalies are detected on the bound ADX cluster via series_decompose_anomalies.'
            : 'A trailing rolling-mean / standard-deviation z-score over this visual’s real rows flags out-of-band points and shades the expected range.'}
        </Caption1>
      )}
    </div>
  );
}

// ── Shaded-range card (translucent value / category band) ─────────────────────

/** Axis a shaded range spans (value vs. category). */
const SHADED_AXES: { id: 'y' | 'x'; label: string }[] = [
  { id: 'y', label: 'Value axis' },
  { id: 'x', label: 'Category axis (index)' },
];

function ShadedRangeCard({
  range, styles, onChange, onRemove,
}: {
  range: AnalyticsShadedRange;
  styles: ReturnType<typeof useStyles>;
  onChange: (patch: Partial<AnalyticsShadedRange>) => void;
  onRemove: () => void;
}): ReactElement {
  const axisLabel = SHADED_AXES.find((a) => a.id === range.axis)?.label ?? 'Value axis';
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardKind}>
          <Layer20Regular />
          <Caption1><strong>Shaded range</strong></Caption1>
        </span>
        <span style={{ flex: 1 }} />
        <Button
          appearance="subtle"
          size="small"
          icon={<Delete20Regular />}
          aria-label="Remove shaded range"
          title="Remove shaded range"
          onClick={onRemove}
        />
      </div>

      <div className={styles.fieldCol}>
        <Caption1 className={styles.muted}>Axis</Caption1>
        <Dropdown
          size="small"
          aria-label="Shaded range axis"
          value={axisLabel}
          selectedOptions={[range.axis]}
          onOptionSelect={(_e, d) => onChange({ axis: d.optionValue === 'x' ? 'x' : 'y' })}
        >
          {SHADED_AXES.map((a) => (
            <Option key={a.id} value={a.id} text={a.label}>{a.label}</Option>
          ))}
        </Dropdown>
      </div>

      <div className={styles.fieldRow}>
        <div className={styles.fieldCol}>
          <Caption1 className={styles.muted}>From</Caption1>
          <Input
            size="small"
            type="number"
            aria-label="Shaded range from"
            value={String(range.from)}
            onChange={(_e, d) => {
              const n = Number(d.value);
              if (d.value !== '' && Number.isFinite(n)) onChange({ from: n });
            }}
          />
        </div>
        <div className={styles.fieldCol}>
          <Caption1 className={styles.muted}>To</Caption1>
          <Input
            size="small"
            type="number"
            aria-label="Shaded range to"
            value={String(range.to)}
            onChange={(_e, d) => {
              const n = Number(d.value);
              if (d.value !== '' && Number.isFinite(n)) onChange({ to: n });
            }}
          />
        </div>
      </div>

      <ColorSwatches value={range.color} styles={styles} onPick={(t) => onChange({ color: t })} />
    </div>
  );
}

// ── AnalyticsPane ─────────────────────────────────────────────────────────────

export interface AnalyticsPaneProps {
  /** Selected visual's type (bar/column/line/…). Null/undefined ⇒ no selection. */
  visualType?: string | null;
  /** Current (sparse) analytics model read from `visual.config.analytics`. */
  analytics?: ReportAnalytics | null;
  /**
   * Numeric series available in the selected visual's CURRENT result rows, for
   * the per-line "Series" picker. Host passes
   * `seriesNamesFromRows(visualRows[selected.id]?.rows)`; optional — when only
   * one (or zero) series exists the picker is hidden and the primary series is
   * used.
   */
  seriesNames?: string[];
  /**
   * True when the selected report/visual is bound to a Kusto / Azure Data Explorer
   * source. Drives the anomaly card's `useAdx` honest gate — when false and the
   * author toggles ADX on, an inline caption explains the client computation is
   * used instead (no dead control). Optional; defaults false.
   */
  adxAvailable?: boolean;
  /** Emit the next analytics model; host wires this to `mutateVisual`. */
  onChange: (next: ReportAnalytics) => void;
}

/**
 * The Analytics right-rail tab. Controlled + structured — every control maps to
 * a field of an {@link AnalyticsLine}. Renders the PBI add-a-line flow plus a
 * card per reference line, and degrades to a styled EmptyState when nothing is
 * selected or the visual has no value axis (PBI: "not available for this
 * visual").
 */
export function AnalyticsPane({ visualType, analytics, seriesNames, adxAvailable = false, onChange }: AnalyticsPaneProps): ReactElement {
  const styles = useStyles();
  const [pendingKind, setPendingKind] = useState<AnalyticsLineKind>('average');

  // Graceful no-selection / non-cartesian states (web3-ui: styled EmptyState).
  if (!visualType) {
    return (
      <EmptyState
        icon={<DataTrending20Regular />}
        title="No visual selected"
        body="Select a cartesian visual (column, bar, line, area, combo, ribbon, waterfall, or scatter) on the canvas to add trend, constant, average, and other reference lines."
      />
    );
  }
  if (!isAnalyticsAvailable(visualType)) {
    return (
      <EmptyState
        icon={<DataTrending20Regular />}
        title="Analytics not available for this visual"
        body="Reference lines apply to cartesian charts with a value axis — column, bar, line, area, combo, ribbon, waterfall, and scatter. Switch the selected visual to one of those to add Trend, Constant, Min, Max, Average, Median, or Percentile lines."
      />
    );
  }

  const lines = analytics?.lines ?? [];
  const errorBars = analytics?.errorBars ?? [];
  const forecasts = analytics?.forecast ?? [];
  const symmetry = analytics?.symmetry;
  const anomalies = analytics?.anomalies ?? [];
  const shadedRanges = analytics?.shadedRanges ?? [];
  const names = seriesNames ?? [];
  const isScatter = visualType === 'scatter';

  // All families round-trip through one onChange — pruneModel keeps the stored
  // shape sparse, and {@link parseAnalytics} hydrates each independently.
  const baseModel: ReportAnalytics = { lines, errorBars, forecast: forecasts, symmetry, anomalies, shadedRanges };
  const emit = (patch: Partial<ReportAnalytics>) => onChange(pruneModel({ ...baseModel, ...patch }));

  const addLine = () => emit({ lines: [...lines, newLine(pendingKind, lines.length)] });
  const patchLine = (id: string, patch: Partial<AnalyticsLine>) =>
    emit({ lines: lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  const removeLine = (id: string) => emit({ lines: lines.filter((l) => l.id !== id) });

  const addErrorBar = () => emit({ errorBars: [...errorBars, newErrorBar(errorBars.length)] });
  const patchErrorBar = (id: string, patch: Partial<AnalyticsErrorBar>) =>
    emit({ errorBars: errorBars.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
  const removeErrorBar = (id: string) => emit({ errorBars: errorBars.filter((b) => b.id !== id) });

  const addForecast = () => emit({ forecast: [...forecasts, newForecast()] });
  const patchForecast = (id: string, patch: Partial<AnalyticsForecast>) =>
    emit({ forecast: forecasts.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
  const removeForecast = (id: string) => emit({ forecast: forecasts.filter((f) => f.id !== id) });

  const addAnomaly = () => emit({ anomalies: [...anomalies, newAnomaly()] });
  const patchAnomaly = (id: string, patch: Partial<AnalyticsAnomaly>) =>
    emit({ anomalies: anomalies.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  const removeAnomaly = (id: string) => emit({ anomalies: anomalies.filter((a) => a.id !== id) });

  const addShadedRange = () => emit({ shadedRanges: [...shadedRanges, newShadedRange()] });
  const patchShadedRange = (id: string, patch: Partial<AnalyticsShadedRange>) =>
    emit({ shadedRanges: shadedRanges.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const removeShadedRange = (id: string) => emit({ shadedRanges: shadedRanges.filter((r) => r.id !== id) });

  const setSymmetry = (patch: Partial<AnalyticsSymmetry>) =>
    emit({ symmetry: { ...(symmetry ?? newSymmetry()), ...patch } });

  const pendingLabel = ANALYTICS_LINE_KINDS.find((k) => k.kind === pendingKind)?.label ?? 'Average line';

  return (
    <div className={styles.pane}>
      {/* ── Add a reference line ───────────────────────────────────────────── */}
      <div>
        <SectionHead icon={<DataTrending20Regular />} label="Reference lines" styles={styles} />
        <Caption1 className={styles.muted}>
          Add structured reference lines — computed from this visual&apos;s data and drawn over the chart.
        </Caption1>
      </div>
      <div className={styles.addRow}>
        <div className={styles.addCol}>
          <Caption1 className={styles.muted}>Line type</Caption1>
          <Dropdown
            size="small"
            aria-label="Reference line type"
            value={pendingLabel}
            selectedOptions={[pendingKind]}
            onOptionSelect={(_e, d) => setPendingKind((d.optionValue as AnalyticsLineKind) || 'average')}
          >
            {ANALYTICS_LINE_KINDS.map((k) => (
              <Option key={k.kind} value={k.kind} text={k.label}>{k.label}</Option>
            ))}
          </Dropdown>
        </div>
        <Button appearance="primary" size="small" icon={<Add20Regular />} onClick={addLine}>
          Add
        </Button>
      </div>
      <Caption1 className={styles.hint}>
        {ANALYTICS_LINE_KINDS.find((k) => k.kind === pendingKind)?.hint}
      </Caption1>

      <Divider />

      {/* ── Lines ──────────────────────────────────────────────────────────── */}
      {lines.length === 0 ? (
        <Text className={styles.muted} size={200}>
          No reference lines yet. Pick a line type and choose Add.
        </Text>
      ) : (
        <div className={styles.list}>
          {lines.map((line, i) => (
            <LineCard
              key={line.id}
              line={line}
              index={i}
              seriesNames={names}
              styles={styles}
              onChange={(patch) => patchLine(line.id, patch)}
              onRemove={() => removeLine(line.id)}
            />
          ))}
        </div>
      )}

      {/* ── Error bars ──────────────────────────────────────────────────────── */}
      <Divider />
      <div>
        <SectionHead icon={<ArrowBidirectionalUpDown20Regular />} label="Error bars" styles={styles} />
        <Caption1 className={styles.muted}>
          Whiskers around each value — by percentage, a fixed amount, or upper / lower bound fields.
        </Caption1>
      </div>
      <div className={styles.addRow}>
        <Button appearance="secondary" size="small" icon={<Add20Regular />} onClick={addErrorBar}>
          Add error bars
        </Button>
      </div>
      {errorBars.length > 0 && (
        <div className={styles.list}>
          {errorBars.map((bar) => (
            <ErrorBarCard
              key={bar.id}
              bar={bar}
              seriesNames={names}
              styles={styles}
              onChange={(patch) => patchErrorBar(bar.id, patch)}
              onRemove={() => removeErrorBar(bar.id)}
            />
          ))}
        </div>
      )}

      {/* ── Forecast ────────────────────────────────────────────────────────── */}
      <Divider />
      <div>
        <SectionHead icon={<ArrowTrendingLines20Regular />} label="Forecast" styles={styles} />
        <Caption1 className={styles.muted}>
          Project the series forward — a linear or seasonal trend with a confidence band.
        </Caption1>
      </div>
      <div className={styles.addRow}>
        <Button appearance="secondary" size="small" icon={<Add20Regular />} onClick={addForecast}>
          Add forecast
        </Button>
      </div>
      {forecasts.length > 0 && (
        <div className={styles.list}>
          {forecasts.map((fc) => (
            <ForecastCard
              key={fc.id}
              fc={fc}
              seriesNames={names}
              styles={styles}
              onChange={(patch) => patchForecast(fc.id, patch)}
              onRemove={() => removeForecast(fc.id)}
            />
          ))}
        </div>
      )}

      {/* ── Anomaly detection ───────────────────────────────────────────────── */}
      <Divider />
      <div>
        <SectionHead icon={<Warning20Regular />} label="Anomaly detection" styles={styles} />
        <Caption1 className={styles.muted}>
          Flag out-of-band points with a rolling z-score over this visual&apos;s data — or Azure Data Explorer when a Kusto source is bound.
        </Caption1>
      </div>
      <div className={styles.addRow}>
        <Button appearance="secondary" size="small" icon={<Add20Regular />} onClick={addAnomaly}>
          Add anomaly detection
        </Button>
      </div>
      {anomalies.length > 0 && (
        <div className={styles.list}>
          {anomalies.map((an) => (
            <AnomalyCard
              key={an.id}
              anomaly={an}
              seriesNames={names}
              adxAvailable={adxAvailable}
              styles={styles}
              onChange={(patch) => patchAnomaly(an.id, patch)}
              onRemove={() => removeAnomaly(an.id)}
            />
          ))}
        </div>
      )}

      {/* ── Shaded ranges ───────────────────────────────────────────────────── */}
      <Divider />
      <div>
        <SectionHead icon={<Layer20Regular />} label="Shaded ranges" styles={styles} />
        <Caption1 className={styles.muted}>
          Highlight a value or category band — a translucent rectangle drawn under the marks.
        </Caption1>
      </div>
      <div className={styles.addRow}>
        <Button appearance="secondary" size="small" icon={<Add20Regular />} onClick={addShadedRange}>
          Add shaded range
        </Button>
      </div>
      {shadedRanges.length > 0 && (
        <div className={styles.list}>
          {shadedRanges.map((r) => (
            <ShadedRangeCard
              key={r.id}
              range={r}
              styles={styles}
              onChange={(patch) => patchShadedRange(r.id, patch)}
              onRemove={() => removeShadedRange(r.id)}
            />
          ))}
        </div>
      )}

      {/* ── Symmetry shading (scatter only) ─────────────────────────────────── */}
      <Divider />
      <div>
        <SectionHead icon={<ArrowSplit20Regular />} label="Symmetry shading" styles={styles} />
      </div>
      <SymmetryCard symmetry={symmetry} isScatter={isScatter} styles={styles} onChange={setSymmetry} />
    </div>
  );
}

export default AnalyticsPane;
