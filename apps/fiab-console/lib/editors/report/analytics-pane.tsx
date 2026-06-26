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
 * style / series. (Error bars, Forecast, Anomalies, and Symmetry shading are
 * tracked as honest follow-on rows in docs/fiab/parity/report-designer.md —
 * not stubbed here.)
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
  Button, Caption1, Divider, Dropdown, Input, Option, Switch, Text,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  DataTrending20Regular, Add20Regular, Delete20Regular, ColorRegular,
  LineHorizontal120Regular,
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

/** The Analytics model attached to a visual: an ordered list of reference lines. */
export interface ReportAnalytics {
  lines: AnalyticsLine[];
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

    out.push({ id: line.id, kind: line.kind, y, y2, color: line.color, style: line.style, label });
  }
  return out;
}

// ── Model helpers (parse / construct) ────────────────────────────────────────

/** An empty analytics model (no reference lines). */
export function emptyAnalytics(): ReportAnalytics {
  return { lines: [] };
}

/** True when a model has at least one reference line. */
export function hasAnalytics(a?: ReportAnalytics | null): boolean {
  return !!a && Array.isArray(a.lines) && a.lines.length > 0;
}

function uid(): string {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? `al_${crypto.randomUUID().slice(0, 8)}`
    : `al_${Math.random().toString(16).slice(2, 10)}`;
}

const KIND_SET = new Set<AnalyticsLineKind>(ANALYTICS_LINE_KINDS.map((k) => k.kind));
const STYLE_SET = new Set<AnalyticsLineStyle>(['solid', 'dashed', 'dotted']);

/**
 * Defensively parse a persisted/wire value into {@link ReportAnalytics} (it
 * arrives from Cosmos `visual.config.analytics` or a PUT body). Unknown shapes
 * yield an empty model so the pane degrades gracefully rather than throwing.
 */
export function parseAnalytics(value: unknown): ReportAnalytics {
  if (!value || typeof value !== 'object') return emptyAnalytics();
  const raw = (value as Record<string, unknown>).lines;
  if (!Array.isArray(raw)) return emptyAnalytics();
  const lines: AnalyticsLine[] = [];
  for (const r of raw) {
    const o = (r || {}) as Record<string, unknown>;
    const kind = o.kind as AnalyticsLineKind;
    if (!KIND_SET.has(kind)) continue;
    const style = STYLE_SET.has(o.style as AnalyticsLineStyle) ? (o.style as AnalyticsLineStyle) : 'dashed';
    const color = typeof o.color === 'string' && o.color ? o.color : LOOM_DATA_PALETTE[0].token;
    lines.push({
      id: typeof o.id === 'string' && o.id ? o.id : uid(),
      kind,
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
  return { lines };
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

      {/* constant value (numeric) */}
      {line.kind === 'constant' && (
        <div className={styles.fieldCol}>
          <Caption1 className={styles.muted}>Value</Caption1>
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
export function AnalyticsPane({ visualType, analytics, seriesNames, onChange }: AnalyticsPaneProps): ReactElement {
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
  const names = seriesNames ?? [];

  const commit = (next: AnalyticsLine[]) => onChange({ lines: next });
  const addLine = () => commit([...lines, newLine(pendingKind, lines.length)]);
  const patchLine = (id: string, patch: Partial<AnalyticsLine>) =>
    commit(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const removeLine = (id: string) => commit(lines.filter((l) => l.id !== id));

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
    </div>
  );
}

export default AnalyticsPane;
