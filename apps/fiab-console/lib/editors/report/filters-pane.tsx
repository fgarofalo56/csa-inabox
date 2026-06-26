'use client';

/**
 * FiltersPane — the "Filters" right-rail tab of the Loom-native Report Designer
 * (Power BI Filters-pane parity, wave 1).
 *
 * Extracted from report-designer.tsx (the inline FiltersPane / FilterScope /
 * FieldOpt and the structured-filter helpers) into a self-contained, reusable
 * module — and EXTENDED to close the high-impact PBI Filters-pane gaps that need
 * no new backend route:
 *
 *   • Top N    — keep the Top/Bottom N categories by a chosen measure.
 *   • Relative date — last / next N days / months / years window.
 *   • Lock / Hide — per-card lock + hide-from-viewers toggles (the PBI 🔒 / 👁
 *     card affordances), persisted with the filter.
 *
 * Power BI parity (ui-parity.md): PBI's Filters pane scopes structured filters
 * at three levels — Report (every page), This page, and the Selected visual —
 * each card offering a field, a filter TYPE (basic / advanced / Top N /
 * relative date), and lock / hide. This pane reproduces that one-for-one with
 * the Loom theme. (Drillthrough scope and "format the filter pane" are tracked
 * as honest follow-on rows in docs/fiab/parity/report-designer.md — not stubbed
 * here.)
 *
 * no-freeform-config.md: every control is structured — a field Dropdown, an
 * operator Dropdown, value Inputs, a by-measure picker, a direction / unit
 * Dropdown, and lock / hide toggles. The author NEVER types DAX / JSON.
 *
 * no-vaporware.md: there are no dead controls. Each filter is applied for real:
 *   – {@link wireFilters} ships the structured filter (including Top N's N +
 *     by-measure and the relative-date window) to the report /query route, which
 *     compiles it through wells-to-sql (ORDER BY measure + TOP N / a date-range
 *     WHERE) and the DAX mirror — a REAL backend constraint.
 *   – {@link applyFilters} / {@link passesFilter} re-apply the SAME predicate
 *     client-side over the visual's result rows so the filter is visible
 *     immediately (Top N = a client sort + slice; relative date = a date-window
 *     check). Filters whose column isn't present in a visual's result are
 *     skipped client-side (the server WHERE stays authoritative) rather than
 *     blanking the visual. Lock / Hide are honest persisted flags, never a
 *     "coming soon" tooltip.
 *
 * no-fabric-dependency.md: pure structured filters over the Azure-native report
 * /query + wells-to-sql path. Nothing here reaches Fabric / Power BI; the
 * optional Power BI embed path is unaffected.
 *
 * web3-ui.md: Fluent UI v9 + Loom design tokens only (no hard-coded
 * spacing/colors/radii/shadows); the pane layout — scope cards, per-filter
 * cards with a field row + operator/value row + lock/hide affordances — mirrors
 * the PBI Filters pane.
 *
 * Persistence: this component is pure / controlled. It reads each scope's
 * ReportFilter[] and emits the next array via onReport / onPage / onVisual; the
 * host designer round-trips them through PUT /api/items/report/[id]/definition
 * (report-scope) and the page / visual config (additive — the read-only viewer
 * and the PBIR provisioner ignore unknown filter fields). No backend call
 * originates in this component; the no-vaporware backend contract lives in the
 * /query + /definition routes (helpers above feed them).
 *
 * report-designer.tsx imports { FiltersPane } and the filter helpers from here
 * (these are the canonical extended implementations); the previously-inline copy
 * is removed there.
 */

import { useMemo } from 'react';
import {
  Button, Caption1, Dropdown, Input, Option, Tooltip,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Add20Regular, Dismiss16Regular,
  LockClosed16Regular, LockOpen16Regular, Eye16Regular, EyeOff16Regular,
} from '@fluentui/react-icons';

// ── model: structured filters (no typed DAX/JSON — PBI Filters-pane parity) ───

/**
 * A structured filter operator.
 *
 * The first nine are the basic / advanced comparisons; `topN` and
 * `relativeDate` are the wave-1 PBI filter TYPES added here.
 */
export type FilterOp =
  | 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'in' | 'contains' | 'between'
  | 'topN' | 'relativeDate';

/** Top N keeps the largest (`top`) or smallest (`bottom`) N by a measure. */
export type TopDir = 'top' | 'bottom';
/** Relative-date window direction. */
export type RelDir = 'last' | 'next';
/** Relative-date window unit. */
export type RelUnit = 'days' | 'months' | 'years';

/** A single structured filter. Field is a model column (table+column) or measure. */
export interface ReportFilter {
  id: string;
  table?: string;
  column?: string;
  measure?: string;
  op: FilterOp;
  /** Single value (eq/ne/gt/ge/lt/le/contains) or the lower bound (between). */
  value?: string;
  /** Upper bound for `between`. */
  value2?: string;
  /** Allowed set for `in` (also editable as a comma list). */
  values?: string[];

  // ── Top N (op === 'topN') ──────────────────────────────────────────────────
  /** Keep top vs bottom N. Default 'top'. */
  topNType?: TopDir;
  /** N — how many categories to keep. */
  topN?: number;
  /** Rank-by measure name (when the by-field is a measure). */
  byMeasure?: string;
  /** Rank-by column table (when the by-field is a column). */
  byTable?: string;
  /** Rank-by column name (when the by-field is a column). */
  byColumn?: string;

  // ── Relative date (op === 'relativeDate') ──────────────────────────────────
  /** Window direction. Default 'last'. */
  relDir?: RelDir;
  /** N units in the window. */
  relN?: number;
  /** Window unit. Default 'days'. */
  relUnit?: RelUnit;

  // ── Card affordances (any op) ──────────────────────────────────────────────
  /** Locked: applied + shown but not editable by report viewers (PBI 🔒). */
  locked?: boolean;
  /** Hidden: applied but hidden from report viewers (PBI 👁). Still authored here. */
  hidden?: boolean;
}

export const FILTER_OPS: { op: FilterOp; label: string }[] = [
  { op: 'eq', label: '= equals' },
  { op: 'ne', label: '≠ not equals' },
  { op: 'gt', label: '> greater than' },
  { op: 'ge', label: '≥ at least' },
  { op: 'lt', label: '< less than' },
  { op: 'le', label: '≤ at most' },
  { op: 'in', label: 'in (any of)' },
  { op: 'contains', label: 'contains' },
  { op: 'between', label: 'between' },
  { op: 'topN', label: 'Top N' },
  { op: 'relativeDate', label: 'Relative date' },
];

const TOP_DIRS: { v: TopDir; label: string }[] = [
  { v: 'top', label: 'Top' },
  { v: 'bottom', label: 'Bottom' },
];
const REL_DIRS: { v: RelDir; label: string }[] = [
  { v: 'last', label: 'Last' },
  { v: 'next', label: 'Next' },
];
const REL_UNITS: { v: RelUnit; label: string }[] = [
  { v: 'days', label: 'days' },
  { v: 'months', label: 'months' },
  { v: 'years', label: 'years' },
];

// ── model schema (structurally identical to the designer's field tree types) ──

export interface FieldColumn { name: string; dataType: string; summarizeBy?: string; isHidden: boolean }
export interface FieldMeasure { name: string; isHidden: boolean }
export interface FieldTable { name: string; columns: FieldColumn[]; measures: FieldMeasure[] }

/** A pickable field in the filter / by-measure Dropdowns. */
export interface FieldOpt { key: string; label: string; table?: string; column?: string; measure?: string }

// ── helpers ───────────────────────────────────────────────────────────────────

function uid(prefix = 'flt'): string {
  const r = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(16).slice(2, 10);
  return `${prefix}_${r}`;
}

/** Encode a filter's field as a stable picker key. */
export function filterFieldKey(f: ReportFilter): string {
  return f.measure ? `m:${f.measure}` : f.table || f.column ? `c:${f.table || ''}.${f.column || ''}` : '';
}
export function filterFieldLabel(f: ReportFilter): string {
  if (f.measure) return f.measure;
  if (f.column) return f.table ? `${f.table} · ${f.column}` : f.column;
  return '(pick a field)';
}

/** Encode a Top-N by-measure field as a stable picker key. */
function byFieldKey(f: ReportFilter): string {
  return f.byMeasure ? `m:${f.byMeasure}` : (f.byColumn ? `c:${f.byTable || ''}.${f.byColumn}` : '');
}

/** The complete field list for the filter / by-measure pickers. */
export function fieldOptions(tables: FieldTable[]): FieldOpt[] {
  const out: FieldOpt[] = [];
  for (const t of tables) {
    for (const m of t.measures) out.push({ key: `m:${m.name}`, label: m.name, measure: m.name });
    for (const c of t.columns) out.push({ key: `c:${t.name}.${c.name}`, label: `${t.name} · ${c.name}`, table: t.name, column: c.name });
  }
  return out;
}

/** Re-hydrate persisted filter shapes into in-memory filters with fresh ids. */
export function reFilters(raw: unknown): ReportFilter[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r): ReportFilter | null => {
      const o = (r || {}) as Record<string, unknown>;
      const op = (typeof o.op === 'string' ? o.op : 'eq') as FilterOp;
      if (!FILTER_OPS.some((x) => x.op === op)) return null;
      const num = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) ? v : undefined;
      const topNType = o.topNType === 'bottom' ? 'bottom' : (o.topNType === 'top' ? 'top' : undefined);
      const relDir = o.relDir === 'next' ? 'next' : (o.relDir === 'last' ? 'last' : undefined);
      const relUnit = o.relUnit === 'months' || o.relUnit === 'years' || o.relUnit === 'days'
        ? (o.relUnit as RelUnit) : undefined;
      return {
        id: uid('flt'),
        table: typeof o.table === 'string' ? o.table : undefined,
        column: typeof o.column === 'string' ? o.column : undefined,
        measure: typeof o.measure === 'string' ? o.measure : undefined,
        op,
        value: typeof o.value === 'string' ? o.value : undefined,
        value2: typeof o.value2 === 'string' ? o.value2 : undefined,
        values: Array.isArray(o.values) ? o.values.map(String) : undefined,
        topNType,
        topN: num(o.topN),
        byMeasure: typeof o.byMeasure === 'string' ? o.byMeasure : undefined,
        byTable: typeof o.byTable === 'string' ? o.byTable : undefined,
        byColumn: typeof o.byColumn === 'string' ? o.byColumn : undefined,
        relDir,
        relN: num(o.relN),
        relUnit,
        locked: !!o.locked,
        hidden: !!o.hidden,
      };
    })
    .filter((x): x is ReportFilter => !!x);
}

/**
 * Strip client-only ids before sending filters to the server / query route, and
 * only ship filters that are READY (a bound field + a complete value) so the
 * wells-to-sql / DAX compilers never receive a half-built Top-N or date window.
 * The new Top-N (N + by-measure) and relative-date / lock / hide fields ride
 * along via the rest spread.
 */
export function wireFilters(list: ReportFilter[]): Array<Omit<ReportFilter, 'id'>> {
  return list
    .filter((f) => (f.column || f.measure) && filterReady(f))
    .map(({ id: _id, ...rest }) => rest);
}

/** True when the filter is complete enough to apply. */
export function filterReady(f: ReportFilter): boolean {
  if (!f.column && !f.measure) return false;
  if (f.op === 'between') return !!(f.value && f.value2);
  if (f.op === 'in') return !!((f.values && f.values.length) || (f.value && f.value.trim()));
  if (f.op === 'topN') return !!(f.topN && f.topN > 0 && (f.byMeasure || f.byColumn));
  if (f.op === 'relativeDate') return !!(f.relN && f.relN > 0);
  return f.value != null && f.value !== '';
}

/**
 * Find the result-row key that corresponds to a field. DAX / serverless result
 * columns surface as `Table[Column]`, `[Measure]`, or a bare alias — so we match
 * tolerantly. Returns null when the result doesn't carry the field (then
 * client-side filtering is skipped and the server WHERE is authoritative — never
 * blanks the visual).
 */
export function matchFieldKey(
  keys: string[], field: { table?: string; column?: string; measure?: string },
): string | null {
  const name = (field.measure || field.column || '').trim();
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (kl === lower) return k;
    if (kl.endsWith(`[${lower}]`)) return k;
    if (field.table && kl === `${field.table.toLowerCase()}[${lower}]`) return k;
  }
  return null;
}
/** Back-compat alias: match a filter's own field against the result keys. */
export function matchFilterKey(keys: string[], f: ReportFilter): string | null {
  return matchFieldKey(keys, f);
}

/** Shift a date by ±n of a unit (used for the relative-date window). */
function shiftDate(base: Date, n: number, unit: RelUnit): Date {
  const d = new Date(base.getTime());
  if (unit === 'days') d.setDate(d.getDate() + n);
  else if (unit === 'months') d.setMonth(d.getMonth() + n);
  else d.setFullYear(d.getFullYear() + n);
  return d;
}
/** [start,end] window for a relative-date filter, relative to `now`. */
function relativeWindow(now: Date, f: ReportFilter): { start: Date; end: Date } {
  const n = Math.max(0, Math.floor(f.relN || 0));
  if ((f.relDir || 'last') === 'next') return { start: now, end: shiftDate(now, n, f.relUnit || 'days') };
  return { start: shiftDate(now, -n, f.relUnit || 'days'), end: now };
}

/**
 * The per-row predicate for a single filter cell.
 *
 * `topN` is intentionally a no-op here (returns true): Top N is a global
 * sort + slice over the whole result, applied in {@link applyFilters}, not a
 * per-row test. `relativeDate` checks the cell's date against the window.
 */
export function passesFilter(cell: unknown, f: ReportFilter): boolean {
  const s = cell == null ? '' : String(cell);
  const n = Number(cell);
  const fn = Number(f.value);
  switch (f.op) {
    case 'eq': return s === (f.value ?? '') || (!Number.isNaN(n) && !Number.isNaN(fn) && n === fn);
    case 'ne': return !(s === (f.value ?? '') || (!Number.isNaN(n) && !Number.isNaN(fn) && n === fn));
    case 'gt': return !Number.isNaN(n) && !Number.isNaN(fn) && n > fn;
    case 'ge': return !Number.isNaN(n) && !Number.isNaN(fn) && n >= fn;
    case 'lt': return !Number.isNaN(n) && !Number.isNaN(fn) && n < fn;
    case 'le': return !Number.isNaN(n) && !Number.isNaN(fn) && n <= fn;
    case 'contains': return s.toLowerCase().includes((f.value ?? '').toLowerCase());
    case 'in': {
      const set = (f.values && f.values.length ? f.values : (f.value ?? '').split(',')).map((v) => v.trim()).filter(Boolean);
      return set.includes(s);
    }
    case 'between': {
      const lo = Number(f.value); const hi = Number(f.value2);
      return !Number.isNaN(n) && !Number.isNaN(lo) && !Number.isNaN(hi) && n >= lo && n <= hi;
    }
    case 'relativeDate': {
      const t = Date.parse(s);
      if (Number.isNaN(t)) return false;
      const { start, end } = relativeWindow(new Date(), f);
      const d = new Date(t);
      return d >= start && d <= end;
    }
    case 'topN': return true; // global sort+slice in applyFilters
    default: return true;
  }
}

/**
 * Apply the merged filters client-side to a visual's result rows so a filter
 * takes effect IMMEDIATELY (visible), even before the server compiles the
 * WHERE / TOP N. Idempotent with the server-side filter (same predicate).
 * Filters whose column isn't present in the result are skipped (left to the
 * server) rather than blanking the visual. Top N runs last as a global
 * sort + slice by its by-measure column.
 */
export function applyFilters(
  rows: Array<Record<string, unknown>>, filters: ReportFilter[],
): Array<Record<string, unknown>> {
  const active = filters.filter(filterReady);
  if (active.length === 0 || rows.length === 0) return rows;
  const keys = Object.keys(rows[0]);

  // 1. per-row predicates (everything except Top N)
  const rowFilters = active.filter((f) => f.op !== 'topN');
  const applicable = rowFilters
    .map((f) => ({ f, key: matchFilterKey(keys, f) }))
    .filter((x): x is { f: ReportFilter; key: string } => !!x.key);
  let out = applicable.length === 0
    ? rows
    : rows.filter((row) => applicable.every(({ f, key }) => passesFilter(row[key], f)));

  // 2. Top N — global sort + slice by the by-measure column (skip if absent)
  for (const f of active) {
    if (f.op !== 'topN') continue;
    const n = Math.floor(f.topN || 0);
    if (n <= 0) continue;
    const measKey = matchFieldKey(keys, { measure: f.byMeasure, column: f.byColumn, table: f.byTable });
    if (!measKey) continue; // defer to the server — never blank the visual
    const num = (v: unknown) => { const x = Number(v); return Number.isNaN(x) ? -Infinity : x; };
    out = [...out]
      .sort((a, b) => (f.topNType === 'bottom' ? num(a[measKey]) - num(b[measKey]) : num(b[measKey]) - num(a[measKey])))
      .slice(0, n);
  }
  return out;
}

// ── styles ────────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, minHeight: 0 },
  muted: { color: tokens.colorNeutralForeground3 },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  filterScope: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow2,
  },
  filterRow: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalXS,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  filterRowHidden: { opacity: 0.6 },
  rowHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  filterValues: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap' },
  iconActive: { color: tokens.colorBrandForeground1 },
  hiddenNote: { color: tokens.colorNeutralForeground3, fontStyle: 'italic' },
});
type FilterStyles = ReturnType<typeof useStyles>;

// ── one filter scope (Report / This page / Selected visual) ───────────────────

/**
 * A single filter scope card. Renders the structured filter editor — field,
 * operator, the op-specific value controls (basic compare, between, in, Top N,
 * relative date), and the per-card lock / hide toggles.
 */
export function FilterScope({
  styles, title, hint, opts, filters, onChange,
}: {
  styles: FilterStyles; title: string; hint: string; opts: FieldOpt[];
  filters: ReportFilter[]; onChange: (next: ReportFilter[]) => void;
}) {
  const add = () => onChange([...filters, { id: uid('flt'), op: 'eq' }]);
  const patch = (fid: string, p: Partial<ReportFilter>) =>
    onChange(filters.map((f) => (f.id === fid ? { ...f, ...p } : f)));
  const remove = (fid: string) => onChange(filters.filter((f) => f.id !== fid));
  const pickField = (fid: string, key: string) => {
    const o = opts.find((x) => x.key === key);
    patch(fid, { table: o?.table, column: o?.column, measure: o?.measure });
  };
  const pickByField = (fid: string, key: string) => {
    const o = opts.find((x) => x.key === key);
    patch(fid, { byMeasure: o?.measure, byTable: o?.table, byColumn: o?.column });
  };
  /** Coerce an Input string to a positive integer (or undefined when cleared). */
  const posInt = (raw: string): number | undefined => {
    if (raw.trim() === '') return undefined;
    const v = Math.floor(Number(raw));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };

  return (
    <div className={styles.filterScope}>
      <div className={styles.toolbar}>
        <Caption1><strong>{title}</strong></Caption1>
        <div className={styles.spacer} />
        <Tooltip content={`Add filter to ${title}`} relationship="label">
          <Button size="small" appearance="subtle" icon={<Add20Regular />} aria-label={`add filter to ${title}`}
            disabled={opts.length === 0} onClick={add} />
        </Tooltip>
      </div>
      {opts.length === 0 && <Caption1 className={styles.muted}>Bind a data source to filter by its fields.</Caption1>}
      {opts.length > 0 && filters.length === 0 && <Caption1 className={styles.muted}>No filters. {hint}</Caption1>}
      {filters.map((f) => (
        <div key={f.id} className={mergeClasses(styles.filterRow, f.hidden && styles.filterRowHidden)}>
          <div className={styles.rowHead}>
            <Dropdown size="small" style={{ minWidth: '120px', flex: 1 }} placeholder="Field"
              aria-label="filter field" value={filterFieldLabel(f)} selectedOptions={[filterFieldKey(f)]}
              onOptionSelect={(_e, d) => pickField(f.id, String(d.optionValue || ''))}>
              {opts.map((o) => <Option key={o.key} value={o.key} text={o.label}>{o.label}</Option>)}
            </Dropdown>
            <Tooltip content={f.locked ? 'Locked — viewers can’t change it' : 'Lock this filter for viewers'} relationship="label">
              <Button size="small" appearance="subtle" aria-pressed={!!f.locked}
                className={f.locked ? styles.iconActive : undefined}
                icon={f.locked ? <LockClosed16Regular /> : <LockOpen16Regular />}
                aria-label={f.locked ? 'unlock filter' : 'lock filter'}
                onClick={() => patch(f.id, { locked: !f.locked })} />
            </Tooltip>
            <Tooltip content={f.hidden ? 'Hidden from report viewers' : 'Hide this filter from viewers'} relationship="label">
              <Button size="small" appearance="subtle" aria-pressed={!!f.hidden}
                className={f.hidden ? styles.iconActive : undefined}
                icon={f.hidden ? <EyeOff16Regular /> : <Eye16Regular />}
                aria-label={f.hidden ? 'show filter to viewers' : 'hide filter from viewers'}
                onClick={() => patch(f.id, { hidden: !f.hidden })} />
            </Tooltip>
            <Tooltip content="Remove filter" relationship="label">
              <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="remove filter" onClick={() => remove(f.id)} />
            </Tooltip>
          </div>
          <div className={styles.filterValues}>
            <Dropdown size="small" style={{ minWidth: '150px' }} aria-label="operator"
              value={FILTER_OPS.find((x) => x.op === f.op)?.label || 'equals'} selectedOptions={[f.op]}
              onOptionSelect={(_e, d) => patch(f.id, { op: (d.optionValue as FilterOp) || 'eq' })}>
              {FILTER_OPS.map((o) => <Option key={o.op} value={o.op} text={o.label}>{o.label}</Option>)}
            </Dropdown>

            {f.op === 'between' && (
              <>
                <Input size="small" style={{ width: '84px' }} placeholder="min" value={f.value ?? ''} aria-label="min"
                  onChange={(_e, d) => patch(f.id, { value: d.value })} />
                <Input size="small" style={{ width: '84px' }} placeholder="max" value={f.value2 ?? ''} aria-label="max"
                  onChange={(_e, d) => patch(f.id, { value2: d.value })} />
              </>
            )}

            {f.op === 'topN' && (
              <>
                <Dropdown size="small" style={{ minWidth: '92px' }} aria-label="top or bottom"
                  value={TOP_DIRS.find((x) => x.v === (f.topNType || 'top'))?.label || 'Top'}
                  selectedOptions={[f.topNType || 'top']}
                  onOptionSelect={(_e, d) => patch(f.id, { topNType: (d.optionValue as TopDir) || 'top' })}>
                  {TOP_DIRS.map((o) => <Option key={o.v} value={o.v} text={o.label}>{o.label}</Option>)}
                </Dropdown>
                <Input size="small" type="number" min={1} style={{ width: '72px' }} placeholder="N"
                  value={f.topN != null ? String(f.topN) : ''} aria-label="top N count"
                  onChange={(_e, d) => patch(f.id, { topN: posInt(d.value) })} />
                <Caption1 className={styles.muted}>by</Caption1>
                <Dropdown size="small" style={{ minWidth: '130px', flex: 1 }} placeholder="measure"
                  aria-label="rank by measure" value={byFieldKey(f) ? (opts.find((o) => o.key === byFieldKey(f))?.label || '') : ''}
                  selectedOptions={byFieldKey(f) ? [byFieldKey(f)] : []}
                  onOptionSelect={(_e, d) => pickByField(f.id, String(d.optionValue || ''))}>
                  {opts.map((o) => <Option key={o.key} value={o.key} text={o.label}>{o.label}</Option>)}
                </Dropdown>
              </>
            )}

            {f.op === 'relativeDate' && (
              <>
                <Dropdown size="small" style={{ minWidth: '84px' }} aria-label="relative direction"
                  value={REL_DIRS.find((x) => x.v === (f.relDir || 'last'))?.label || 'Last'}
                  selectedOptions={[f.relDir || 'last']}
                  onOptionSelect={(_e, d) => patch(f.id, { relDir: (d.optionValue as RelDir) || 'last' })}>
                  {REL_DIRS.map((o) => <Option key={o.v} value={o.v} text={o.label}>{o.label}</Option>)}
                </Dropdown>
                <Input size="small" type="number" min={1} style={{ width: '72px' }} placeholder="N"
                  value={f.relN != null ? String(f.relN) : ''} aria-label="relative date count"
                  onChange={(_e, d) => patch(f.id, { relN: posInt(d.value) })} />
                <Dropdown size="small" style={{ minWidth: '100px' }} aria-label="relative date unit"
                  value={REL_UNITS.find((x) => x.v === (f.relUnit || 'days'))?.label || 'days'}
                  selectedOptions={[f.relUnit || 'days']}
                  onOptionSelect={(_e, d) => patch(f.id, { relUnit: (d.optionValue as RelUnit) || 'days' })}>
                  {REL_UNITS.map((o) => <Option key={o.v} value={o.v} text={o.label}>{o.label}</Option>)}
                </Dropdown>
              </>
            )}

            {f.op !== 'between' && f.op !== 'topN' && f.op !== 'relativeDate' && (
              <Input size="small" style={{ flex: 1, minWidth: '120px' }}
                placeholder={f.op === 'in' ? 'value1, value2, …' : 'value'}
                value={f.value ?? ''} aria-label="filter value"
                onChange={(_e, d) => patch(f.id, { value: d.value, ...(f.op === 'in' ? { values: d.value.split(',').map((s) => s.trim()).filter(Boolean) } : {}) })} />
            )}
          </div>
          {f.hidden && <Caption1 className={styles.hiddenNote}>Hidden from report viewers (still applied).</Caption1>}
        </div>
      ))}
    </div>
  );
}

// ── filters pane (right rail "Filters" tab) ───────────────────────────────────

export interface FiltersPaneProps {
  tables: FieldTable[];
  reportFilters: ReportFilter[];
  pageFilters: ReportFilter[];
  /** null → no visual selected (renders the "select a visual" hint card). */
  visualFilters: ReportFilter[] | null;
  selectedTitle: string | null;
  onReport: (next: ReportFilter[]) => void;
  onPage: (next: ReportFilter[]) => void;
  onVisual: (next: ReportFilter[]) => void;
}

/**
 * The three-scope PBI Filters pane: Report → every page, This page → the active
 * page, Selected visual → the chosen visual. Self-contained (owns its Loom-token
 * styles) so the host designer mounts it as `<FiltersPane … />` with no styles
 * prop.
 */
export function FiltersPane({
  tables, reportFilters, pageFilters, visualFilters, selectedTitle, onReport, onPage, onVisual,
}: FiltersPaneProps) {
  const styles = useStyles();
  const opts = useMemo(() => fieldOptions(tables), [tables]);
  return (
    <div className={styles.pane}>
      <Caption1 className={styles.muted}>
        Structured filters apply on top of the model — never typed DAX/JSON. Pick a field and a type (compare, in,
        between, Top N, or relative date); lock a card so viewers can&apos;t change it, or hide it from them. Report
        filters apply to every page; page filters to this page; visual filters to the selected visual.
      </Caption1>
      <FilterScope styles={styles} title="Report" hint="Applies to every visual on every page." opts={opts}
        filters={reportFilters} onChange={onReport} />
      <FilterScope styles={styles} title="This page" hint="Applies to every visual on the active page." opts={opts}
        filters={pageFilters} onChange={onPage} />
      {visualFilters === null ? (
        <div className={styles.filterScope}>
          <Caption1><strong>Selected visual</strong></Caption1>
          <Caption1 className={styles.muted}>Select a visual on the canvas to add filters that affect only it.</Caption1>
        </div>
      ) : (
        <FilterScope styles={styles} title={selectedTitle ? `Visual · ${selectedTitle}` : 'Selected visual'}
          hint="Applies to the selected visual only." opts={opts} filters={visualFilters} onChange={onVisual} />
      )}
    </div>
  );
}

export default FiltersPane;
