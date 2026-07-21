'use client';

// helpers.tsx — pure utility functions for the report-designer.
// Has JSX (dataTypeGlyph / wellFieldGlyph) so this file uses .tsx + 'use client'.

import type { ReactElement } from 'react';
import {
  NumberSymbol16Regular, CalendarLtr16Regular, CheckboxChecked16Regular,
  TextT16Regular, MathFormula16Regular,
} from '@fluentui/react-icons';
import { tokens } from '@fluentui/react-components';
import { SCRIPT_TYPES } from './constants';
import type { VisualType, WellField, Wells, DVisual, FieldTable, WellName } from './types';

// ── Field-well helpers ────────────────────────────────────────────────────────

export function wellResultAlias(f: WellField): string {
  const agg = !f.aggregation || (f.aggregation as string) === 'None' ? 'Sum' : f.aggregation;
  return f.measure ? f.measure : `${agg} of ${f.column}`;
}

export function wellsFor(type: VisualType): { name: WellName; label: string }[] {
  switch (type) {
    case 'scriptVisual':
      return [{ name: 'values', label: 'Values' }];
    case 'smartNarrative':
    case 'qna':
      return [];
    case 'decompositionTree':
    case 'keyInfluencers':
      return [
        { name: 'values', label: 'Analyze' },
        { name: 'category', label: 'Explain by' },
      ];
    case 'card':
    case 'multiRowCard':
      return [{ name: 'values', label: 'Fields' }];
    case 'slicer':
      return [{ name: 'category', label: 'Field' }];
    case 'table':
      return [{ name: 'values', label: 'Columns' }];
    case 'matrix':
      return [
        { name: 'category', label: 'Rows' },
        { name: 'legend', label: 'Columns' },
        { name: 'values', label: 'Values' },
      ];
    case 'gauge':
    case 'kpi':
      return [
        { name: 'values', label: type === 'gauge' ? 'Value' : 'Indicator' },
        { name: 'target', label: 'Target' },
        { name: 'minimum', label: 'Minimum' },
        { name: 'maximum', label: 'Maximum' },
      ];
    case 'treemap':
      return [
        { name: 'category', label: 'Group' },
        { name: 'details', label: 'Details' },
        { name: 'values', label: 'Values' },
        { name: 'tooltips', label: 'Tooltips' },
      ];
    case 'funnel':
      return [
        { name: 'category', label: 'Category' },
        { name: 'values', label: 'Values' },
        { name: 'tooltips', label: 'Tooltips' },
      ];
    case 'waterfall':
      return [
        { name: 'category', label: 'Category' },
        { name: 'values', label: 'Y values' },
        { name: 'legend', label: 'Breakdown' },
        { name: 'smallMultiples', label: 'Small multiples' },
        { name: 'tooltips', label: 'Tooltips' },
      ];
    case 'combo':
      return [
        { name: 'category', label: 'Shared axis' },
        { name: 'values', label: 'Column values' },
        { name: 'secondaryValues', label: 'Line values' },
        { name: 'legend', label: 'Legend' },
        { name: 'smallMultiples', label: 'Small multiples' },
        { name: 'tooltips', label: 'Tooltips' },
      ];
    case 'ribbon':
      return [
        { name: 'category', label: 'Axis' },
        { name: 'values', label: 'Values' },
        { name: 'legend', label: 'Legend' },
        { name: 'smallMultiples', label: 'Small multiples' },
        { name: 'tooltips', label: 'Tooltips' },
      ];
    case 'scatter':
      return [
        { name: 'category', label: 'Details' },
        { name: 'values', label: 'X / Y values' },
        { name: 'size', label: 'Size' },
        { name: 'playAxis', label: 'Play axis' },
        { name: 'legend', label: 'Legend' },
      ];
    case 'map':
      return [
        { name: 'latitude', label: 'Latitude' },
        { name: 'longitude', label: 'Longitude' },
        { name: 'category', label: 'Location' },
        { name: 'size', label: 'Size' },
        { name: 'legend', label: 'Legend' },
      ];
    default:
      return [
        { name: 'category', label: 'Axis' },
        { name: 'values', label: 'Values' },
        { name: 'legend', label: 'Legend' },
        { name: 'smallMultiples', label: 'Small multiples' },
        { name: 'tooltips', label: 'Tooltips' },
      ];
  }
}

export function uid(prefix = 'v'): string {
  const r = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(16).slice(2, 10);
  return `${prefix}_${r}`;
}

export function fieldKey(f: WellField): string { return f.measure ? `m:${f.measure}` : `c:${f.table}.${f.column}`; }

export function fieldLabel(f: WellField): string {
  if (f.measure) return f.measure;
  const agg = f.aggregation ? `${f.aggregation} of ` : '';
  return `${agg}${f.column}`;
}

export function dataTypeGlyph(dataType?: string): ReactElement {
  const t = (dataType || '').toLowerCase();
  if (/int|double|decimal|number|numeric|float|money|real|currency/.test(t)) return <NumberSymbol16Regular />;
  if (/date|time/.test(t)) return <CalendarLtr16Regular />;
  if (/bool|bit/.test(t)) return <CheckboxChecked16Regular />;
  return <TextT16Regular />;
}

export function wellFieldDataType(tables: FieldTable[], f: WellField): string | undefined {
  if (f.measure || !f.column) return undefined;
  const t = tables.find((x) => x.name === f.table);
  return t?.columns.find((c) => c.name === f.column)?.dataType;
}

export function wellFieldGlyph(tables: FieldTable[], f: WellField): ReactElement {
  return f.measure ? <MathFormula16Regular /> : dataTypeGlyph(wellFieldDataType(tables, f));
}

export function parseFieldRef(field?: string): WellField | null {
  if (!field) return null;
  let m = /^'?([^'[]+?)'?\[([^\]]+)\]$/.exec(field.trim());
  if (m) return { uid: uid('f'), table: m[1].trim(), column: m[2].trim() };
  m = /^\[([^\]]+)\]$/.exec(field.trim());
  if (m) return { uid: uid('f'), measure: m[1].trim() };
  return null;
}

export function stripWell(a?: WellField[]): Array<Omit<WellField, 'uid'>> {
  return (a || []).map(({ uid: _u, ...rest }) => rest);
}

export function queryVisual(v: DVisual) {
  const w = v.wells;
  if (SCRIPT_TYPES.has(v.type)) {
    const vals = stripWell(w.values || []).map((f) => ({ ...f, aggregation: undefined }));
    const first = vals[0];
    const field = first?.measure
      ? `[${first.measure}]`
      : first?.column
        ? `${first.table ? `'${first.table.replace(/'/g, "''")}'` : ''}[${first.column}]`
        : undefined;
    return { type: 'table' as VisualType, field, wells: { category: [], values: vals, legend: [] } };
  }
  const cat = stripWell([
    ...(w.category || []), ...(w.playAxis || []), ...(w.latitude || []), ...(w.longitude || []),
  ]);
  const vals = stripWell([
    ...(w.values || []), ...(w.secondaryValues || []),
    ...(w.target || []), ...(w.minimum || []), ...(w.maximum || []),
    ...(w.size || []), ...(w.tooltips || []),
  ]);
  const leg = stripWell(w.legend || []);
  const trellisSmall = stripWell(w.smallMultiples || []);
  const trellisDetails = stripWell(w.details || []);
  const first = vals[0] || cat[0];
  const field = first?.measure
    ? `[${first.measure}]`
    : first?.column
      ? `${first.table ? `'${first.table.replace(/'/g, "''")}'` : ''}[${first.column}]`
      : undefined;
  return {
    type: v.type,
    field,
    wells: {
      category: cat, values: vals, legend: leg,
      smallMultiples: trellisSmall, details: trellisDetails,
    },
  };
}

export function wireWells(w: Wells) {
  return {
    category: stripWell(w.category),
    values: stripWell(w.values),
    legend: stripWell(w.legend),
    secondaryValues: stripWell(w.secondaryValues),
    target: stripWell(w.target),
    minimum: stripWell(w.minimum),
    maximum: stripWell(w.maximum),
    smallMultiples: stripWell(w.smallMultiples),
    tooltips: stripWell(w.tooltips),
    details: stripWell(w.details),
    size: stripWell(w.size),
    playAxis: stripWell(w.playAxis),
    latitude: stripWell(w.latitude),
    longitude: stripWell(w.longitude),
  };
}

export function hasBinding(v: DVisual): boolean {
  const w = v.wells;
  return [
    w.category, w.values, w.legend,
    w.secondaryValues, w.target, w.minimum, w.maximum, w.smallMultiples, w.tooltips, w.details,
    w.size, w.playAxis, w.latitude, w.longitude,
  ].reduce((n, a) => n + (a?.length || 0), 0) > 0;
}

export function applyAlpha(color?: string, transparency?: number): string | undefined {
  if (!color) return undefined;
  const t = Math.min(100, Math.max(0, transparency || 0));
  return t ? `color-mix(in srgb, ${color} ${100 - t}%, transparent)` : color;
}

// ── Visual-body render helpers ────────────────────────────────────────────────

export function cellIsNumeric(v: unknown): boolean {
  if (v == null || v === '') return false;
  return !Number.isNaN(Number(v));
}

export function measureAggregates(rows: Array<Record<string, unknown>>, cols: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) {
    let sum = 0;
    let sawNumeric = false;
    let firstNonNull: unknown;
    for (const r of rows) {
      const v = r[c];
      if (v == null || v === '') continue;
      if (firstNonNull === undefined) firstNonNull = v;
      if (cellIsNumeric(v)) { sum += Number(v); sawNumeric = true; }
    }
    out[c] = sawNumeric ? sum : firstNonNull;
  }
  return out;
}

export function splitCols(rows: Array<Record<string, unknown>>, cols: string[]): { cats: string[]; nums: string[] } {
  const nums = cols.filter((c) => rows.some((r) => cellIsNumeric(r[c])));
  const cats = cols.filter((c) => !nums.includes(c));
  return { cats, nums };
}

export function chartCategories(rows: Array<Record<string, unknown>>): string[] {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  if (!cols.length) return [];
  const firstNumericIdx = cols.findIndex((c) => rows.some((r) => cellIsNumeric(r[c])));
  const labelCol = firstNumericIdx === 0
    ? cols[0]
    : (cols.find((c) => rows.some((r) => !cellIsNumeric(r[c]) && r[c] != null)) ?? cols[0]);
  return rows.map((r) => (r[labelCol] == null ? '—' : String(r[labelCol])));
}

export function computeAnomalyOverlay(
  rows: Array<Record<string, unknown>>,
  defs: unknown[] | undefined,
  cats: string[],
): { points: Array<{ x: string | number; value: number; isAnomaly: boolean }>; band: Array<{ x: string | number; low: number; high: number }>; color: string } | undefined {
  if (!Array.isArray(defs) || defs.length === 0 || rows.length === 0) return undefined;
  const def = (defs[0] || {}) as { measure?: string; sensitivity?: number; color?: string };
  const { nums } = splitCols(rows, Object.keys(rows[0]));
  if (nums.length === 0) return undefined;
  const col = def.measure && nums.includes(def.measure) ? def.measure : nums[0];
  const vals = rows.map((r) => (cellIsNumeric(r[col]) ? Number(r[col]) : Number.NaN));
  const n = vals.length;
  const window = Math.min(24, Math.max(3, Math.round(n / 8)));
  const sens = Math.min(100, Math.max(0, Number(def.sensitivity ?? 50)));
  const zThreshold = 3.5 - (sens / 100) * 2.0;
  const color = typeof def.color === 'string' && def.color ? def.color : tokens.colorPaletteRedForeground1;

  const points: Array<{ x: string | number; value: number; isAnomaly: boolean }> = [];
  const band: Array<{ x: string | number; low: number; high: number }> = [];
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
  if (band.length === 0 && flagged === 0) return undefined;
  return { points, band, color };
}
