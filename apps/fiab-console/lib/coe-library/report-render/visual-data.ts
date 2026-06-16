/**
 * Aggregation / render-model builder for the CoE template viewer.
 *
 * `buildVisualData` turns one parsed {@link Visual} + the parsed {@link SampleData}
 * into a small, render-ready shape the SVG renderers consume. It mirrors how
 * Power BI would summarize each visual's projections over the model, using the
 * bundled SAMPLE data (clearly labelled as such in the UI).
 *
 * Measure resolution: when a projected Property matches a real sample column we
 * aggregate that column. When it does NOT (it's a DAX measure with no matching
 * column) we fall back to a documented aggregation heuristic over the first
 * numeric column — never inventing a value. If nothing resolves, the card shows
 * "—". The aggregate mode is inferred from the field name:
 *   /count|#|number of/i        → count of rows
 *   /avg|average|rate|%|score|level/i → average
 *   otherwise                   → sum
 *
 * Pure + dependency-free; unit-tested against the real coe-adoption-maturity and
 * cloud-cost-finops templates.
 */

import type { Field, Visual } from './pbir-parse';
import type { SampleData, SampleTable } from './tmdl-sample';

export type AggMode = 'sum' | 'avg' | 'count';

export interface CardData { kind: 'card'; label: string; value: string; raw: number | null; format: ValueFormat }
export interface BarsData { kind: 'bars'; title: string; orientation: 'vertical' | 'horizontal'; categories: { label: string; value: number }[]; format: ValueFormat }
export interface LineData { kind: 'line'; title: string; points: { label: string; value: number }[]; format: ValueFormat }
export interface PieData { kind: 'pie'; title: string; slices: { label: string; value: number }[]; format: ValueFormat }
export interface TableData { kind: 'table'; title: string; columns: string[]; rows: string[][] }
export interface UnsupportedData { kind: 'unsupported'; type: string; title: string }

export type VisualData = CardData | BarsData | LineData | PieData | TableData | UnsupportedData;

export type ValueFormat = 'number' | 'percent' | 'int';

const VERTICAL_BAR_TYPES = new Set([
  'clusteredColumnChart', 'columnChart', 'stackedColumnChart',
  'hundredPercentStackedColumnChart',
]);
const HORIZONTAL_BAR_TYPES = new Set([
  'barChart', 'clusteredBarChart', 'stackedBarChart', 'hundredPercentStackedBarChart',
]);
const LINE_TYPES = new Set(['lineChart', 'areaChart', 'stackedAreaChart', 'lineClusteredColumnComboChart']);
const PIE_TYPES = new Set(['pieChart', 'donutChart']);
const TABLE_TYPES = new Set(['tableEx', 'table', 'matrix', 'pivotTable']);

function inferMode(name: string): AggMode {
  if (/count|#|number of/i.test(name)) return 'count';
  if (/avg|average|rate|%|score|level/i.test(name)) return 'avg';
  return 'sum';
}

function inferFormat(name: string, mode: AggMode): ValueFormat {
  if (/%/.test(name)) return 'percent';
  if (mode === 'count') return 'int';
  return 'number';
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** First column whose values are numeric in the sample rows. */
function firstNumericColumn(table: SampleTable): string | null {
  for (const col of table.columns) {
    if (table.rows.some((r) => isNum(r[col]))) return col;
  }
  return null;
}

/** Resolve a projection Property to a real sample column (case-insensitive), else null. */
function resolveColumn(table: SampleTable, property: string): string | null {
  if (table.columns.includes(property)) return property;
  const lower = property.toLowerCase();
  const hit = table.columns.find((c) => c.toLowerCase() === lower);
  return hit || null;
}

function aggregate(values: number[], mode: AggMode): number {
  if (mode === 'count') return values.length;
  if (!values.length) return 0;
  const sum = values.reduce((a, b) => a + b, 0);
  return mode === 'avg' ? sum / values.length : sum;
}

/** Collect the numeric values for `field` across `table` rows (for a group subset). */
function valuesFor(table: SampleTable, field: Field, rows: Record<string, unknown>[]): { values: number[]; mode: AggMode } {
  const mode = inferMode(field.property);
  let col = resolveColumn(table, field.property);
  if (!col) col = firstNumericColumn(table); // measure → heuristic over first numeric column
  if (mode === 'count') {
    // count of rows (a non-numeric column still yields a row count)
    return { values: rows.map(() => 1), mode };
  }
  if (!col) return { values: [], mode };
  const values = rows.map((r) => r[col!]).filter(isNum) as number[];
  return { values, mode };
}

export function formatValue(value: number | null, format: ValueFormat): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (format === 'percent') {
    // Sample columns can be raw levels, not ratios; only render as % when it
    // actually looks like a 0–1 ratio so we never show an absurd 262%.
    if (value >= 0 && value <= 1.5) return `${(value * 100).toFixed(1)}%`;
    return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }
  if (format === 'int') return Math.round(value).toLocaleString();
  const abs = Math.abs(value);
  const digits = abs !== 0 && abs < 10 ? 1 : 0;
  return value.toLocaleString(undefined, { maximumFractionDigits: Math.max(digits, abs < 1 ? 2 : digits) });
}

/** Pick the primary value field for a single-value (card) visual. */
function primaryField(visual: Visual): Field | null {
  const order = ['Values', 'Y', 'Y2', 'Data', 'Value'];
  for (const role of order) if (visual.roles[role]?.length) return visual.roles[role][0];
  const first = Object.values(visual.roles)[0];
  return first?.[0] || null;
}

/** Category (axis) field for charts. */
function categoryField(visual: Visual): Field | null {
  const order = ['Category', 'Axis', 'X', 'Series'];
  for (const role of order) if (visual.roles[role]?.length) return visual.roles[role][0];
  return null;
}

/** Value (Y / measure) field for charts. */
function valueField(visual: Visual): Field | null {
  const order = ['Y', 'Values', 'Y2', 'Value'];
  for (const role of order) if (visual.roles[role]?.length) return visual.roles[role][0];
  return null;
}

function groupAggregate(
  table: SampleTable,
  catCol: string,
  vField: Field,
): { label: string; value: number }[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of table.rows) {
    const key = String(r[catCol] ?? '—');
    const arr = groups.get(key) || [];
    arr.push(r);
    groups.set(key, arr);
  }
  const out: { label: string; value: number }[] = [];
  for (const [label, rows] of groups) {
    const { values, mode } = valuesFor(table, vField, rows);
    out.push({ label, value: aggregate(values, mode) });
  }
  return out;
}

/** Build the render model for a single visual against the sample tables. */
export function buildVisualData(visual: Visual, sample: SampleData): VisualData {
  const type = visual.type;

  // ---- card -------------------------------------------------------------
  if (type === 'card' || type === 'multiRowCard' || type === 'kpi' || type === 'gauge') {
    const field = primaryField(visual);
    const table = field ? sample[field.entity] : undefined;
    if (!field || !table) {
      return { kind: 'card', label: visual.title, value: '—', raw: null, format: 'number' };
    }
    const { values, mode } = valuesFor(table, field, table.rows);
    const format = inferFormat(field.property, mode);
    const raw = values.length || mode === 'count' ? aggregate(values, mode) : null;
    return { kind: 'card', label: visual.title, value: formatValue(raw, format), raw, format };
  }

  // ---- table / matrix ---------------------------------------------------
  if (TABLE_TYPES.has(type)) {
    const fields = Object.values(visual.roles).flat();
    if (!fields.length) return { kind: 'table', title: visual.title, columns: [], rows: [] };
    const entity = fields[0].entity;
    const table = sample[entity];
    if (!table) return { kind: 'table', title: visual.title, columns: fields.map((f) => f.property), rows: [] };
    const columns = fields.map((f) => f.property);
    const valueCols = fields.map((f) => resolveColumn(table, f.property) || firstNumericColumn(table));
    const rows = table.rows.slice(0, 50).map((r) =>
      valueCols.map((col, i) => {
        const v = col ? r[col] : null;
        if (isNum(v)) return formatValue(v, inferFormat(fields[i].property, 'sum'));
        return v == null ? '—' : String(v);
      }),
    );
    return { kind: 'table', title: visual.title, columns, rows };
  }

  // ---- charts (bars / line / pie) --------------------------------------
  const cat = categoryField(visual);
  const val = valueField(visual);
  if (cat && val) {
    const table = sample[cat.entity] || sample[val.entity];
    if (table) {
      const catCol = resolveColumn(table, cat.property) || cat.property;
      const data = groupAggregate(table, catCol, val);
      const format = inferFormat(val.property, inferMode(val.property));

      if (LINE_TYPES.has(type)) {
        const points = data.slice().sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
        return { kind: 'line', title: visual.title, points, format };
      }
      if (PIE_TYPES.has(type)) {
        return { kind: 'pie', title: visual.title, slices: data, format };
      }
      const orientation = HORIZONTAL_BAR_TYPES.has(type) ? 'horizontal' : 'vertical';
      if (VERTICAL_BAR_TYPES.has(type) || HORIZONTAL_BAR_TYPES.has(type)) {
        return { kind: 'bars', title: visual.title, orientation, categories: data, format };
      }
    }
  }

  // ---- honest unsupported tile -----------------------------------------
  return { kind: 'unsupported', type, title: visual.title };
}
