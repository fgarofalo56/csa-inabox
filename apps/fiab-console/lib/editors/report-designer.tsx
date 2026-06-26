'use client';

/**
 * ReportDesigner — the Loom-native interactive REPORT DESIGNER.
 *
 * Power BI report-authoring parity, Azure-native (no-fabric-dependency.md): the
 * default report editor is no longer a read-only viewer. You can CREATE and
 * design a report end-to-end against the bound Azure Analysis Services tabular
 * model — NO Power BI / Fabric workspace required.
 *
 * Layout mirrors the Power BI report canvas (ui-parity.md), Loom-themed:
 *   ├─ left   : Pages list  (add / rename / delete / select a page)
 *   ├─ center : report CANVAS — a grid of visuals; add via a visual-type
 *   │           gallery; select to edit; remove; resize (span) + reorder
 *   └─ right  : Visualizations + Fields pane — pick a visual type, drag/assign
 *               model columns & measures into wells (Axis/Category, Values,
 *               Legend), choose an aggregation (Sum/Avg/Count/Min/Max)
 *
 * Every visual LIVE-RENDERS real rows by POSTing its field wells to
 * /api/items/report/[id]/query (DAX SUMMARIZECOLUMNS over the AAS model — real
 * backend, no mock). Save persists the whole definition via PUT
 * /api/items/report/[id]/definition. The Fields tree is loaded from
 * /api/items/report/[id]/fields (real TMSCHEMA Discover). When no AAS model is
 * bound the surface still renders, with an honest Fluent gate naming the exact
 * binding to set (no-vaporware.md).
 *
 * no-freeform-config.md: visual type, fields, and aggregations are all
 * pickers / wells — there is never a typed-DAX or JSON box.
 *
 * The Power BI embed path (NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi → ReportLikeEditor)
 * is untouched; this is strictly the Azure-native default.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge, Button, Caption1, Dropdown, Option, Divider, Input, Field, Radio, RadioGroup,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, MenuGroup, MenuGroupHeader, MenuDivider,
  MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions,
  Dialog, DialogSurface, DialogBody, DialogTitle, DialogContent, DialogActions,
  Spinner, Subtitle2, Text, Title3, Tooltip,
  Tree, TreeItem, TreeItemLayout, TabList, Tab,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  makeStyles, tokens, mergeClasses,
} from '@fluentui/react-components';
import {
  Add20Regular, Delete20Regular, Save20Regular, ArrowSync20Regular, Edit20Regular,
  DataBarVerticalRegular, DataBarHorizontalRegular, DataLineRegular, DataAreaRegular,
  DataPieRegular, DataScatterRegular, Table20Regular, GridRegular, NumberSymbol20Regular,
  Filter20Regular, Dismiss16Regular, ChevronUp20Regular, ChevronDown20Regular, Sparkle20Regular,
  Database20Regular, CloudArrowUp20Regular, ColorRegular, ReOrderDotsVertical20Regular,
} from '@fluentui/react-icons';
import type { CSSProperties, ReactElement } from 'react';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { ItemEditorChrome } from './item-editor-chrome';
import { EmptyState } from '@/lib/components/empty-state';
import { LoomChart, type LoomChartType } from '@/lib/components/charts/loom-chart';
import { ReportPowerBiCopilot, type CopilotVisualSpec } from '@/lib/components/report/report-powerbi-copilot';
import { DataSourcePicker } from './report/data-source-picker';
import { FormatPane, type ReportVisualFormat, formatValue } from './report/format-pane';
import {
  type ReportDataSource, isBound, describeSource, fromLegacyState, parseDataSource,
} from './report/report-data-source';
import { useCanvasLayout } from './report/use-canvas-layout';

// ── Model ───────────────────────────────────────────────────────────────────

type VisualType =
  | 'table' | 'matrix' | 'card' | 'bar' | 'column' | 'line' | 'area' | 'pie' | 'donut' | 'scatter' | 'slicer';

type Agg = 'Sum' | 'Avg' | 'Count' | 'Min' | 'Max';
const AGGS: Agg[] = ['Sum', 'Avg', 'Count', 'Min', 'Max'];

type WellName = 'category' | 'values' | 'legend';

interface WellField {
  uid: string;
  table?: string;
  column?: string;
  measure?: string;
  aggregation?: Agg;
}
interface Wells { category: WellField[]; values: WellField[]; legend: WellField[] }
interface DVisual {
  id: string;
  type: VisualType;
  title: string;
  wells: Wells;
  /** column span on a 12-col canvas grid + a row-height hint */
  w: number;
  h: number;
  /** Structured visual formatting (FormatPane → visual.config.format). */
  format?: ReportVisualFormat;
  /** Filters scoped to this visual only. */
  filters?: ReportFilter[];
}
interface DPage { id: string; name: string; visuals: DVisual[]; filters?: ReportFilter[] }

// ── filters (structured — no typed DAX/JSON, ui-parity with the PBI Filters pane) ──

type FilterOp = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'in' | 'contains' | 'between';

/** A single structured filter. Field is a model column (table+column) or measure. */
interface ReportFilter {
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
}

const FILTER_OPS: { op: FilterOp; label: string }[] = [
  { op: 'eq', label: '= equals' },
  { op: 'ne', label: '≠ not equals' },
  { op: 'gt', label: '> greater than' },
  { op: 'ge', label: '≥ at least' },
  { op: 'lt', label: '< less than' },
  { op: 'le', label: '≤ at most' },
  { op: 'in', label: 'in (any of)' },
  { op: 'contains', label: 'contains' },
  { op: 'between', label: 'between' },
];

/** Encode a filter's field as a stable picker key. */
function filterFieldKey(f: ReportFilter): string {
  return f.measure ? `m:${f.measure}` : f.table || f.column ? `c:${f.table || ''}.${f.column || ''}` : '';
}
function filterFieldLabel(f: ReportFilter): string {
  if (f.measure) return f.measure;
  if (f.column) return f.table ? `${f.table} · ${f.column}` : f.column;
  return '(pick a field)';
}

/** Re-hydrate persisted filter shapes into in-memory filters with fresh ids. */
function reFilters(raw: unknown): ReportFilter[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r): ReportFilter | null => {
      const o = (r || {}) as Record<string, unknown>;
      const op = (typeof o.op === 'string' ? o.op : 'eq') as FilterOp;
      if (!FILTER_OPS.some((x) => x.op === op)) return null;
      return {
        id: uid('flt'),
        table: typeof o.table === 'string' ? o.table : undefined,
        column: typeof o.column === 'string' ? o.column : undefined,
        measure: typeof o.measure === 'string' ? o.measure : undefined,
        op,
        value: typeof o.value === 'string' ? o.value : undefined,
        value2: typeof o.value2 === 'string' ? o.value2 : undefined,
        values: Array.isArray(o.values) ? o.values.map(String) : undefined,
      };
    })
    .filter((x): x is ReportFilter => !!x);
}

/** Strip client-only ids before sending filters to the server / query route. */
function wireFilters(list: ReportFilter[]): Array<Omit<ReportFilter, 'id'>> {
  return list
    .filter((f) => (f.column || f.measure))
    .map(({ id: _id, ...rest }) => rest);
}

/** True when the filter is complete enough to apply. */
function filterReady(f: ReportFilter): boolean {
  if (!f.column && !f.measure) return false;
  if (f.op === 'between') return !!(f.value && f.value2);
  if (f.op === 'in') return !!((f.values && f.values.length) || (f.value && f.value.trim()));
  return f.value != null && f.value !== '';
}

/**
 * Find the result-row key that corresponds to a filter's field. DAX/serverless
 * result columns surface as `Table[Column]`, `[Measure]`, or a bare alias — so we
 * match tolerantly. Returns null when the visual's result doesn't carry the
 * filtered column (then client-side filtering is skipped and the server WHERE is
 * authoritative — never blanks the visual).
 */
function matchFilterKey(keys: string[], f: ReportFilter): string | null {
  const name = (f.measure || f.column || '').trim();
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (kl === lower) return k;
    if (kl.endsWith(`[${lower}]`)) return k;
    if (f.table && kl === `${f.table.toLowerCase()}[${lower}]`) return k;
  }
  return null;
}

function passesFilter(cell: unknown, f: ReportFilter): boolean {
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
    default: return true;
  }
}

/**
 * Apply the merged filters client-side to a visual's result rows so a filter
 * takes effect IMMEDIATELY (visible), even before the server compiles the WHERE.
 * Idempotent with a server-side filter (same predicate). Filters whose column
 * isn't present in the result are skipped (left to the server) rather than
 * blanking the visual.
 */
function applyFilters(rows: Array<Record<string, unknown>>, filters: ReportFilter[]): Array<Record<string, unknown>> {
  const active = filters.filter(filterReady);
  if (active.length === 0 || rows.length === 0) return rows;
  const keys = Object.keys(rows[0]);
  const applicable = active
    .map((f) => ({ f, key: matchFilterKey(keys, f) }))
    .filter((x): x is { f: ReportFilter; key: string } => !!x.key);
  if (applicable.length === 0) return rows;
  return rows.filter((row) => applicable.every(({ f, key }) => passesFilter(row[key], f)));
}

interface FieldColumn { name: string; dataType: string; summarizeBy?: string; isHidden: boolean }
interface FieldMeasure { name: string; isHidden: boolean }
interface FieldTable { name: string; columns: FieldColumn[]; measures: FieldMeasure[] }

interface VisualState { rows: Array<Record<string, unknown>>; loading: boolean; err: string | null }

// ── Visual catalogue (gallery) ───────────────────────────────────────────────

const VISUALS: { type: VisualType; label: string; icon: ReactElement }[] = [
  { type: 'table',   label: 'Table',          icon: <Table20Regular /> },
  { type: 'matrix',  label: 'Matrix',         icon: <GridRegular /> },
  { type: 'card',    label: 'Card / KPI',     icon: <NumberSymbol20Regular /> },
  { type: 'column',  label: 'Column chart',   icon: <DataBarVerticalRegular /> },
  { type: 'bar',     label: 'Bar chart',      icon: <DataBarHorizontalRegular /> },
  { type: 'line',    label: 'Line chart',     icon: <DataLineRegular /> },
  { type: 'area',    label: 'Area chart',     icon: <DataAreaRegular /> },
  { type: 'pie',     label: 'Pie chart',      icon: <DataPieRegular /> },
  { type: 'donut',   label: 'Donut chart',    icon: <DataPieRegular /> },
  { type: 'scatter', label: 'Scatter',        icon: <DataScatterRegular /> },
  { type: 'slicer',  label: 'Slicer',         icon: <Filter20Regular /> },
];
const CHART_TYPES = new Set<VisualType>(['bar', 'column', 'line', 'area', 'pie', 'donut', 'scatter']);

/** Which wells a given visual type exposes, with parity-correct labels. */
function wellsFor(type: VisualType): { name: WellName; label: string }[] {
  if (type === 'card') return [{ name: 'values', label: 'Fields' }];
  if (type === 'slicer') return [{ name: 'category', label: 'Field' }];
  if (type === 'table') return [{ name: 'values', label: 'Columns' }];
  if (type === 'matrix') return [
    { name: 'category', label: 'Rows' },
    { name: 'legend', label: 'Columns' },
    { name: 'values', label: 'Values' },
  ];
  // charts
  return [
    { name: 'category', label: type === 'scatter' ? 'Details' : 'Axis' },
    { name: 'values', label: 'Values' },
    { name: 'legend', label: 'Legend' },
  ];
}

// ── helpers ───────────────────────────────────────────────────────────────────

function uid(prefix = 'v'): string {
  const r = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(16).slice(2, 10);
  return `${prefix}_${r}`;
}
function fieldKey(f: WellField): string { return f.measure ? `m:${f.measure}` : `c:${f.table}.${f.column}`; }
function fieldLabel(f: WellField): string {
  if (f.measure) return f.measure;
  const agg = f.aggregation ? `${f.aggregation} of ` : '';
  return `${agg}${f.column}`;
}

/** Parse a stored single-`field` ('Table'[Col] / [Measure]) for back-compat. */
function parseFieldRef(field?: string): WellField | null {
  if (!field) return null;
  let m = /^'?([^'[]+?)'?\[([^\]]+)\]$/.exec(field.trim());
  if (m) return { uid: uid('f'), table: m[1].trim(), column: m[2].trim() };
  m = /^\[([^\]]+)\]$/.exec(field.trim());
  if (m) return { uid: uid('f'), measure: m[1].trim() };
  return null;
}

/** Build the wire `visual` payload the /query route understands (type + field + wells). */
function queryVisual(v: DVisual) {
  const strip = (a: WellField[]) => a.map(({ uid: _u, ...rest }) => rest);
  const cat = strip(v.wells.category);
  const vals = strip(v.wells.values);
  const first = vals[0] || cat[0];
  const field = first?.measure
    ? `[${first.measure}]`
    : first?.column
      ? `${first.table ? `'${first.table.replace(/'/g, "''")}'` : ''}[${first.column}]`
      : undefined;
  return {
    type: v.type,
    field,
    wells: { category: cat, values: vals, legend: strip(v.wells.legend) },
  };
}

/** True when a visual has at least one bound field (i.e. is runnable). */
function hasBinding(v: DVisual): boolean {
  return v.wells.category.length + v.wells.values.length + v.wells.legend.length > 0;
}

// ── styles ────────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM, minHeight: 0 },
  pageRow: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: tokens.spacingVerticalXS, borderRadius: tokens.borderRadiusMedium, cursor: 'pointer',
  },
  pageRowActive: { backgroundColor: tokens.colorNeutralBackground1Selected, fontWeight: tokens.fontWeightSemibold },
  pageRowName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  canvasWrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, padding: tokens.spacingVerticalL, minHeight: 0 },
  canvasGrid: { display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: tokens.spacingHorizontalM },
  vcard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    position: 'relative',
    padding: tokens.spacingVerticalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow4,
    transitionProperty: 'box-shadow, border-color', transitionDuration: tokens.durationFaster,
    minHeight: '180px',
    ':hover': { boxShadow: tokens.shadow16 },
  },
  vcardSel: { border: `1px solid ${tokens.colorBrandStroke1}`, boxShadow: tokens.shadow16 },
  vcardDragHandle: {
    display: 'inline-flex', alignItems: 'center', cursor: 'grab',
    color: tokens.colorNeutralForeground3, borderRadius: tokens.borderRadiusSmall,
    ':hover': { color: tokens.colorBrandForeground1, backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  vcardDragging: { opacity: 0.55 },
  vcardDropBefore: { boxShadow: `inset 3px 0 0 0 ${tokens.colorBrandStroke1}, ${tokens.shadow16}` },
  vcardDropAfter: { boxShadow: `inset -3px 0 0 0 ${tokens.colorBrandStroke1}, ${tokens.shadow16}` },
  vcardHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  vcardTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  vcardBody: { flex: 1, minWidth: 0, overflow: 'auto' },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  gallery: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: tokens.spacingHorizontalXS },
  galleryBtn: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingVerticalS, minWidth: 0,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1, cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  galleryBtnActive: { border: `1px solid ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  well: {
    border: `1px dashed ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalXS, minHeight: '44px', display: 'flex', flexDirection: 'column',
    gap: tokens.spacingVerticalXXS, backgroundColor: tokens.colorNeutralBackground2,
  },
  wellOver: { border: `1px dashed ${tokens.colorBrandStroke1}`, backgroundColor: tokens.colorBrandBackground2 },
  wellHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  token: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  tokenName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chip: {
    display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS, cursor: 'grab',
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  kpi: { fontSize: tokens.fontSizeHero800, fontWeight: tokens.fontWeightSemibold, lineHeight: tokens.lineHeightHero800 },
  muted: { color: tokens.colorNeutralForeground3 },
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
  filterValues: { display: 'flex', gap: tokens.spacingHorizontalXS, alignItems: 'center', flexWrap: 'wrap' },
  resizeHandle: {
    position: 'absolute', right: '2px', bottom: '2px', width: '14px', height: '14px',
    cursor: 'nwse-resize', borderRight: `2px solid ${tokens.colorNeutralStroke1}`,
    borderBottom: `2px solid ${tokens.colorNeutralStroke1}`, borderBottomRightRadius: tokens.borderRadiusSmall,
    opacity: 0.5,
    ':hover': {
      opacity: 1,
      borderRight: `2px solid ${tokens.colorBrandStroke1}`,
      borderBottom: `2px solid ${tokens.colorBrandStroke1}`,
    },
  },
});
type Styles = ReturnType<typeof useStyles>;

// ── visual render ─────────────────────────────────────────────────────────────

function VisualBody({ visual, state, styles, filters }: { visual: DVisual; state?: VisualState; styles: Styles; filters?: ReportFilter[] }) {
  if (!hasBinding(visual)) {
    return <Caption1 className={styles.muted}>Add a field from the Fields pane to render this {visual.type}.</Caption1>;
  }
  if (!state || state.loading) return <Spinner size="tiny" label="Querying model…" />;
  if (state.err) return <MessageBar intent="error"><MessageBarBody>{state.err}</MessageBarBody></MessageBar>;
  const fmt = visual.format;
  const nf = fmt?.numberFormat;
  // Apply the merged report/page/visual filters client-side so they take effect
  // immediately (visible) — idempotent with the server-side WHERE/FILTER.
  const rows = applyFilters(state.rows, filters || []);
  if (state.rows.length === 0) return <Caption1 className={styles.muted}>No rows returned.</Caption1>;
  if (rows.length === 0) return <Caption1 className={styles.muted}>No rows match the current filters.</Caption1>;
  const cols = Object.keys(rows[0]);

  if (visual.type === 'card') {
    const val = Object.values(rows[0])[0];
    return <div className={styles.kpi}>{formatValue(val, nf)}</div>;
  }

  if (visual.type === 'slicer') {
    const col = cols[0];
    return (
      <Dropdown placeholder={`Filter by ${col}`} aria-label={`slicer ${col}`}>
        {rows.slice(0, 200).map((r, i) => (
          <Option key={i} text={String(r[col] ?? '—')}>{String(r[col] ?? '—')}</Option>
        ))}
      </Dropdown>
    );
  }

  if (CHART_TYPES.has(visual.type)) {
    const hasNumeric = visual.type === 'scatter'
      || rows.some((r) => Object.values(r).some((v) => v != null && v !== '' && !Number.isNaN(Number(v))));
    if (hasNumeric) {
      // The Format pane's lead data color (a Loom brand-palette token) is applied
      // by overriding the Fluent brand CSS variable LoomChart's series-1 reads
      // (tokens.colorBrandForeground1 === var(--colorBrandForeground1)). What you
      // pick in Format → Data colors is what the chart paints.
      const lead = fmt?.dataColors?.[0];
      const wrapStyle = lead ? ({ '--colorBrandForeground1': lead } as unknown as CSSProperties) : undefined;
      return (
        <div style={wrapStyle}>
          <LoomChart type={visual.type as LoomChartType} rows={rows} height={200} />
        </div>
      );
    }
  }

  // table / matrix / non-numeric fallback
  return (
    <Table size="small">
      <TableHeader><TableRow>{cols.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
      <TableBody>
        {rows.slice(0, 100).map((row, ri) => (
          <TableRow key={ri}>{cols.map((c) => <TableCell key={c}>{formatValue(row[c], nf)}</TableCell>)}</TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── well editor (right pane) ────────────────────────────────────────────────

function WellEditor({
  visual, well, label, tables, styles, onAdd, onRemove, onAgg, onDrop,
}: {
  visual: DVisual; well: WellName; label: string; tables: FieldTable[]; styles: Styles;
  onAdd: (well: WellName, f: WellField) => void;
  onRemove: (well: WellName, uid: string) => void;
  onAgg: (well: WellName, uid: string, agg: Agg) => void;
  onDrop: (well: WellName, payload: WellField) => void;
}) {
  const [over, setOver] = useState(false);
  const items = visual.wells[well];
  return (
    <div className={styles.section}>
      <div className={styles.wellHead}>
        <Caption1><strong>{label}</strong></Caption1>
        <div className={styles.spacer} />
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Button size="small" appearance="subtle" icon={<Add20Regular />} aria-label={`add field to ${label}`} />
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {tables.length === 0 && <MenuItem disabled>No model fields loaded</MenuItem>}
              {tables.map((t) => (
                <MenuGroup key={t.name}>
                  <MenuGroupHeader>{t.name}</MenuGroupHeader>
                  {t.measures.map((m) => (
                    <MenuItem key={`m:${m.name}`} icon={<NumberSymbol20Regular />}
                      onClick={() => onAdd(well, { uid: uid('f'), measure: m.name })}>{m.name}</MenuItem>
                  ))}
                  {t.columns.map((c) => (
                    <MenuItem key={`c:${c.name}`}
                      onClick={() => onAdd(well, { uid: uid('f'), table: t.name, column: c.name, aggregation: well === 'values' ? 'Sum' : undefined })}>{c.name}</MenuItem>
                  ))}
                  <MenuDivider />
                </MenuGroup>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
      </div>
      <div
        className={mergeClasses(styles.well, over && styles.wellOver)}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault(); setOver(false);
          try {
            const p = JSON.parse(e.dataTransfer.getData('application/json')) as WellField;
            if (p && (p.column || p.measure)) onDrop(well, { ...p, uid: uid('f'), aggregation: well === 'values' && p.column ? (p.aggregation || 'Sum') : p.aggregation });
          } catch { /* ignore non-field drops */ }
        }}
      >
        {items.length === 0 && <Caption1 className={styles.muted}>Drop a field here</Caption1>}
        {items.map((f) => (
          <div key={f.uid} className={styles.token}>
            <span className={styles.tokenName}>{fieldLabel(f)}</span>
            {well === 'values' && f.column && (
              <Dropdown size="small" value={f.aggregation || 'Sum'} selectedOptions={[f.aggregation || 'Sum']}
                aria-label="aggregation" style={{ minWidth: '92px' }}
                onOptionSelect={(_e, d) => onAgg(well, f.uid, (d.optionValue as Agg) || 'Sum')}>
                {AGGS.map((a) => <Option key={a} value={a}>{a}</Option>)}
              </Dropdown>
            )}
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />}
              aria-label={`remove ${fieldLabel(f)}`} onClick={() => onRemove(well, f.uid)} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── filters pane (right rail tab) ────────────────────────────────────────────

interface FieldOpt { key: string; label: string; table?: string; column?: string; measure?: string }

function fieldOptions(tables: FieldTable[]): FieldOpt[] {
  const out: FieldOpt[] = [];
  for (const t of tables) {
    for (const m of t.measures) out.push({ key: `m:${m.name}`, label: m.name, measure: m.name });
    for (const c of t.columns) out.push({ key: `c:${t.name}.${c.name}`, label: `${t.name} · ${c.name}`, table: t.name, column: c.name });
  }
  return out;
}

/** One filter scope (Report / This page / Selected visual). */
function FilterScope({
  styles, title, hint, opts, filters, onChange,
}: {
  styles: Styles; title: string; hint: string; opts: FieldOpt[];
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
  return (
    <div className={styles.filterScope}>
      <div className={styles.toolbar}>
        <Caption1><strong>{title}</strong></Caption1>
        <div className={styles.spacer} />
        <Button size="small" appearance="subtle" icon={<Add20Regular />} aria-label={`add filter to ${title}`}
          disabled={opts.length === 0} onClick={add} />
      </div>
      {opts.length === 0 && <Caption1 className={styles.muted}>Bind a data source to filter by its fields.</Caption1>}
      {opts.length > 0 && filters.length === 0 && <Caption1 className={styles.muted}>No filters. {hint}</Caption1>}
      {filters.map((f) => (
        <div key={f.id} className={styles.filterRow}>
          <div className={styles.toolbar}>
            <Dropdown size="small" style={{ minWidth: '120px', flex: 1 }} placeholder="Field"
              aria-label="filter field" value={filterFieldLabel(f)} selectedOptions={[filterFieldKey(f)]}
              onOptionSelect={(_e, d) => pickField(f.id, String(d.optionValue || ''))}>
              {opts.map((o) => <Option key={o.key} value={o.key} text={o.label}>{o.label}</Option>)}
            </Dropdown>
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="remove filter" onClick={() => remove(f.id)} />
          </div>
          <div className={styles.filterValues}>
            <Dropdown size="small" style={{ minWidth: '130px' }} aria-label="operator"
              value={FILTER_OPS.find((x) => x.op === f.op)?.label || 'equals'} selectedOptions={[f.op]}
              onOptionSelect={(_e, d) => patch(f.id, { op: (d.optionValue as FilterOp) || 'eq' })}>
              {FILTER_OPS.map((o) => <Option key={o.op} value={o.op} text={o.label}>{o.label}</Option>)}
            </Dropdown>
            {f.op === 'between' ? (
              <>
                <Input size="small" style={{ width: '84px' }} placeholder="min" value={f.value ?? ''} aria-label="min"
                  onChange={(_e, d) => patch(f.id, { value: d.value })} />
                <Input size="small" style={{ width: '84px' }} placeholder="max" value={f.value2 ?? ''} aria-label="max"
                  onChange={(_e, d) => patch(f.id, { value2: d.value })} />
              </>
            ) : (
              <Input size="small" style={{ flex: 1, minWidth: '120px' }}
                placeholder={f.op === 'in' ? 'value1, value2, …' : 'value'}
                value={f.value ?? ''} aria-label="filter value"
                onChange={(_e, d) => patch(f.id, { value: d.value, ...(f.op === 'in' ? { values: d.value.split(',').map((s) => s.trim()).filter(Boolean) } : {}) })} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function FiltersPane({
  styles, tables, reportFilters, pageFilters, visualFilters, selectedTitle, onReport, onPage, onVisual,
}: {
  styles: Styles; tables: FieldTable[];
  reportFilters: ReportFilter[]; pageFilters: ReportFilter[]; visualFilters: ReportFilter[] | null;
  selectedTitle: string | null;
  onReport: (next: ReportFilter[]) => void;
  onPage: (next: ReportFilter[]) => void;
  onVisual: (next: ReportFilter[]) => void;
}) {
  const opts = useMemo(() => fieldOptions(tables), [tables]);
  return (
    <div className={styles.pane} style={{ padding: 0 }}>
      <Caption1 className={styles.muted}>
        Structured filters apply on top of the model — never typed DAX/JSON. Report filters apply to every page;
        page filters to this page; visual filters to the selected visual.
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

// ── main ────────────────────────────────────────────────────────────────────

export function ReportDesigner({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  const router = useRouter();

  const isNew = id === 'new';

  const [pages, setPages] = useState<DPage[]>([]);
  const [activePage, setActivePage] = useState(0);
  const [selectedVisual, setSelectedVisual] = useState<string | null>(null);
  /** Right rail mode: Build (visualizations + fields), Format, Filters, or the Power BI Copilot. */
  const [rightTab, setRightTab] = useState<'build' | 'format' | 'filters' | 'copilot'>('build');
  const [reportName, setReportName] = useState('');

  // Report DATA SOURCE (semantic-model default · direct-query · AAS). Replaces the
  // old AAS-only binding; back-compat falls through to {kind:'aas'} from item state.
  const [dataSource, setDataSource] = useState<ReportDataSource | null>(null);
  const [dsOpen, setDsOpen] = useState(false);
  const [dsSaving, setDsSaving] = useState(false);
  const [dsNote, setDsNote] = useState<{ ok: boolean; text: string } | null>(null);

  // Report-scope filters (page-scope live on the page; visual-scope on the visual).
  const [reportFilters, setReportFilters] = useState<ReportFilter[]>([]);

  // Publish (Azure-native Org gallery default · Power BI opt-in).
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishTarget, setPublishTarget] = useState<'org' | 'powerbi'>('org');
  const [publishMsg, setPublishMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [tables, setTables] = useState<FieldTable[]>([]);
  const [fieldsErr, setFieldsErr] = useState<string | null>(null);
  const [fieldsLoading, setFieldsLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // First-save "Create report" (id === 'new'): a brand-new report has no Cosmos
  // record, so PUT …/report/new/definition 404s (loadContentBackedItem('new')
  // returns null — there is no create path on that route). On the first Save we
  // mint the real item via the generic create route, persist the in-memory
  // pages/visuals + chosen data source against the new id, then open the live
  // editor. Mirrors the NewItemCreateGate flow (workspace + name → real Cosmos
  // write → /items/report/<id>), kept Azure-native (no Power BI/Fabric).
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [createWsId, setCreateWsId] = useState('');
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[] | null>(null);
  const [wsErr, setWsErr] = useState<string | null>(null);
  const [visualRows, setVisualRows] = useState<Record<string, VisualState>>({});
  const gridRef = useRef<HTMLDivElement | null>(null);

  const pbiPublishEnabled = (process.env.NEXT_PUBLIC_LOOM_BI_BACKEND || '').toLowerCase() === 'powerbi';
  const bound = isBound(dataSource);

  // ── load definition ────────────────────────────────────────────────────────
  const loadDetail = useCallback(async () => {
    // Brand-new report has no persisted Cosmos item yet (id === 'new'): don't
    // fetch /api/items/report/new (404). Start with one empty page — the user
    // picks a data source, lays out pages/visuals, and Save creates the real item.
    if (id === 'new') {
      setPages([{ id: uid('p'), name: 'Page 1', visuals: [] }]);
      setActivePage(0); setReportName(''); setDataSource(null); setReportFilters([]);
      setDirty(false); setLoadErr(null); setLoading(false);
      return;
    }
    setLoading(true); setLoadErr(null);
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) { setLoadErr(j.error || `HTTP ${r.status}`); return; }
      setReportName(j.report?.name || '');

      // Resolve the data source: an explicit state.dataSource (read via the v2
      // /data-source route when present) wins; otherwise fall back to the legacy
      // AAS binding so already-saved reports keep working unchanged.
      let ds: ReportDataSource | null = null;
      try {
        const dr = await fetch(`/api/items/report/${encodeURIComponent(id)}/data-source`);
        if (dr.ok) { const dj = await dr.json(); if (dj?.ok) ds = parseDataSource(dj.dataSource); }
      } catch { /* route may not be present yet — fall through to legacy below */ }
      if (!ds) ds = fromLegacyState({ aasServer: j.aasServer ?? undefined, aasDatabase: j.aasDatabase ?? undefined });
      setDataSource(ds);
      setReportFilters(reFilters(j.reportFilters));

      const dpages: DPage[] = (j.pages || []).map((p: any, pi: number): DPage => ({
        id: uid('p'),
        name: p.displayName || p.name || `Page ${pi + 1}`,
        filters: reFilters(p.filters),
        visuals: (p.visuals || []).map((v: any): DVisual => {
          const cfgWells = v.config?.wells;
          const reUid = (a: any[]): WellField[] => (Array.isArray(a) ? a : []).map((f) => ({ uid: uid('f'), ...f }));
          let wells: Wells;
          if (cfgWells) {
            wells = { category: reUid(cfgWells.category), values: reUid(cfgWells.values), legend: reUid(cfgWells.legend) };
          } else {
            // Back-compat: seed a single well from the legacy `field` string.
            const parsed = parseFieldRef(v.field);
            const into: WellName = parsed?.measure ? 'values' : 'category';
            wells = { category: [], values: [], legend: [] };
            if (parsed) wells[into] = [parsed.measure ? parsed : { ...parsed, aggregation: undefined }];
          }
          return {
            id: uid('v'),
            type: (v.type as VisualType) || 'table',
            title: v.title || '',
            wells,
            w: Math.min(12, Math.max(1, Number(v.config?.layout?.w) || 6)),
            h: Math.max(1, Number(v.config?.layout?.h) || 4),
            format: (v.config?.format as ReportVisualFormat | undefined) || undefined,
            filters: reFilters(v.config?.filters),
          };
        }),
      }));
      setPages(dpages.length ? dpages : [{ id: uid('p'), name: 'Page 1', visuals: [] }]);
      setActivePage(0);
      setDirty(false);
    } catch (e: any) { setLoadErr(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [id]);

  // ── load fields (model schema) ───────────────────────────────────────────────
  const loadFields = useCallback(async () => {
    // New report (id === 'new') has no item to read a model from yet — skip the
    // fetch (avoids /api/items/report/new/fields 404). The AAS-bind gate already
    // explains that fields appear once the report is saved + a model is bound.
    if (id === 'new') {
      setTables([]); setFieldsErr(null); setFieldsLoading(false);
      return;
    }
    setFieldsLoading(true); setFieldsErr(null);
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}/fields`);
      const j = await r.json();
      if (j.ok) { setTables(j.tables || []); }
      else { setTables([]); setFieldsErr(j.error || `HTTP ${r.status}`); }
    } catch (e: any) { setTables([]); setFieldsErr(e?.message || String(e)); }
    finally { setFieldsLoading(false); }
  }, [id]);

  useEffect(() => { loadDetail(); loadFields(); }, [loadDetail, loadFields]);

  const page = pages[activePage];
  const selected = useMemo(
    () => (page?.visuals || []).find((v) => v.id === selectedVisual) || null,
    [page, selectedVisual],
  );

  // ── live render: query each visual on the active page ─────────────────────────
  // `scopeFilters` = report + page filters; the visual's own filters are merged in
  // here. The merged set is sent to the route (forward-compatible WHERE/FILTER) AND
  // re-applied client-side in VisualBody so a filter is visible immediately.
  const runVisual = useCallback(async (v: DVisual, scopeFilters: ReportFilter[] = []) => {
    if (!hasBinding(v)) return;
    const applicable = [...scopeFilters, ...(v.filters || [])];
    setVisualRows((p) => ({ ...p, [v.id]: { rows: p[v.id]?.rows || [], loading: true, err: null } }));
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}/query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visual: queryVisual(v), filters: wireFilters(applicable), dataSource }),
      });
      const j = await r.json();
      if (j.ok) setVisualRows((p) => ({ ...p, [v.id]: { rows: j.rows || [], loading: false, err: null } }));
      else setVisualRows((p) => ({ ...p, [v.id]: { rows: [], loading: false, err: j.error || `HTTP ${r.status}` } }));
    } catch (e: any) {
      setVisualRows((p) => ({ ...p, [v.id]: { rows: [], loading: false, err: e?.message || String(e) } }));
    }
  }, [id, dataSource]);

  // Re-query a visual whenever its binding signature or applicable filters change.
  const bindingSig = (v: DVisual) => `${v.type}|${JSON.stringify(queryVisual(v).wells)}|${JSON.stringify(v.filters || [])}`;
  useEffect(() => {
    if (!bound || !page) return;
    const scope = [...reportFilters, ...(page.filters || [])];
    page.visuals.forEach((v) => { if (hasBinding(v)) runVisual(v, scope); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bound, activePage, page?.visuals.map(bindingSig).join('~'), JSON.stringify(reportFilters), JSON.stringify(page?.filters || [])]);

  // ── mutation helpers ─────────────────────────────────────────────────────────
  const mutatePage = useCallback((fn: (p: DPage) => DPage) => {
    setPages((prev) => prev.map((p, i) => (i === activePage ? fn(p) : p)));
    setDirty(true);
  }, [activePage]);

  const mutateVisual = useCallback((vid: string, fn: (v: DVisual) => DVisual) => {
    mutatePage((p) => ({ ...p, visuals: p.visuals.map((v) => (v.id === vid ? fn(v) : v)) }));
  }, [mutatePage]);

  const addVisual = useCallback((type: VisualType) => {
    const v: DVisual = { id: uid('v'), type, title: VISUALS.find((x) => x.type === type)?.label || type, wells: { category: [], values: [], legend: [] }, w: type === 'card' ? 3 : 6, h: 4 };
    mutatePage((p) => ({ ...p, visuals: [...p.visuals, v] }));
    setSelectedVisual(v.id);
  }, [mutatePage]);

  const removeVisual = useCallback((vid: string) => {
    mutatePage((p) => ({ ...p, visuals: p.visuals.filter((v) => v.id !== vid) }));
    if (selectedVisual === vid) setSelectedVisual(null);
  }, [mutatePage, selectedVisual]);

  const moveVisual = useCallback((vid: string, dir: -1 | 1) => {
    mutatePage((p) => {
      const idx = p.visuals.findIndex((v) => v.id === vid);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= p.visuals.length) return p;
      const next = [...p.visuals];
      const [moved] = next.splice(idx, 1);
      next.splice(to, 0, moved);
      return { ...p, visuals: next };
    });
  }, [mutatePage]);

  // Direct-manipulation canvas (useCanvasLayout): drag the header grip to
  // REPOSITION a visual (HTML5 reorder + grid repack) and drag the corner grip
  // to RESIZE its column span / row-height (the grip is an ARIA slider with
  // arrow-key resize). w/h (+ additive x/y on reorder) already round-trip
  // through /definition `layout`, so this is wiring, not new persistence.
  // Move-left/right + S/M/L/XL stay as keyboard fallbacks. rowUnitPx:40 matches
  // the card render's `v.h * 40` so the vertical drag feels 1:1 with layout.
  const canvas = useCanvasLayout<DVisual, DPage>({
    visuals: page?.visuals ?? [],
    mutateVisual,
    mutatePage,
    rowUnitPx: 40,
  });

  const addToWell = useCallback((vid: string, well: WellName, f: WellField) => {
    mutateVisual(vid, (v) => {
      if (v.wells[well].some((x) => fieldKey(x) === fieldKey(f))) return v;
      // single-field wells (card uses many values; slicer/category single)
      const single = well === 'category' && (v.type === 'slicer');
      const cur = single ? [] : v.wells[well];
      return { ...v, wells: { ...v.wells, [well]: [...cur, f] } };
    });
  }, [mutateVisual]);
  const removeFromWell = useCallback((vid: string, well: WellName, fuid: string) => {
    mutateVisual(vid, (v) => ({ ...v, wells: { ...v.wells, [well]: v.wells[well].filter((x) => x.uid !== fuid) } }));
  }, [mutateVisual]);
  const setAgg = useCallback((vid: string, well: WellName, fuid: string, agg: Agg) => {
    mutateVisual(vid, (v) => ({ ...v, wells: { ...v.wells, [well]: v.wells[well].map((x) => (x.uid === fuid ? { ...x, aggregation: agg } : x)) } }));
  }, [mutateVisual]);

  // ── pages ──────────────────────────────────────────────────────────────────
  const addPage = () => {
    setPages((prev) => {
      const np: DPage = { id: uid('p'), name: `Page ${prev.length + 1}`, visuals: [] };
      setActivePage(prev.length);
      return [...prev, np];
    });
    setDirty(true);
  };
  const renamePage = (pid: string, name: string) => {
    setPages((prev) => prev.map((p) => (p.id === pid ? { ...p, name } : p)));
    setDirty(true);
  };
  const deletePage = (pid: string) => {
    setPages((prev) => {
      const next = prev.filter((p) => p.id !== pid);
      const safe = next.length ? next : [{ id: uid('p'), name: 'Page 1', visuals: [] }];
      setActivePage((ap) => Math.max(0, Math.min(ap, safe.length - 1)));
      return safe;
    });
    setDirty(true);
  };

  // ── Power BI Copilot actions (applied to the SAME in-memory designer state) ──
  // The Copilot pane proposes structured specs (never DAX); the user approves and
  // these handlers add the visual / page to the active page. The visual then
  // live-renders via …/query and persists on the existing Save (PUT …/definition).
  const applyCopilotVisual = useCallback((spec: CopilotVisualSpec) => {
    const reUid = (a?: Array<{ table?: string; column?: string; measure?: string; aggregation?: Agg }>): WellField[] =>
      (a || []).map((f) => ({ uid: uid('f'), ...f }));
    const v: DVisual = {
      id: uid('v'),
      type: spec.type,
      title: spec.title || VISUALS.find((x) => x.type === spec.type)?.label || spec.type,
      wells: {
        category: reUid(spec.wells?.category),
        values: reUid(spec.wells?.values),
        legend: reUid(spec.wells?.legend),
      },
      w: spec.w && spec.w >= 2 ? Math.min(12, spec.w) : (spec.type === 'card' ? 3 : 6),
      h: spec.h && spec.h >= 1 ? spec.h : 4,
    };
    mutatePage((p) => ({ ...p, visuals: [...p.visuals, v] }));
    setSelectedVisual(v.id);
  }, [mutatePage]);

  const addCopilotPage = useCallback((name?: string) => {
    setPages((prev) => {
      const np: DPage = { id: uid('p'), name: (name || '').trim() || `Page ${prev.length + 1}`, visuals: [] };
      setActivePage(prev.length);
      return [...prev, np];
    });
    setDirty(true);
  }, []);

  // ── save ─────────────────────────────────────────────────────────────────────
  // Build the wire `/definition` body from the in-memory designer model (shared
  // by the existing-item Save and the first-save create flow). dataSource is
  // ignored by …/definition (owned by …/data-source) but kept for completeness.
  const buildDefinitionBody = useCallback(() => ({
    pages: pages.map((p) => ({
      name: p.name,
      filters: wireFilters(p.filters || []),
      visuals: p.visuals.map((v) => ({
        visualType: v.type,
        title: v.title,
        wells: queryVisual(v).wells,
        layout: { x: 0, y: 0, w: v.w, h: v.h },
        format: v.format,
        filters: wireFilters(v.filters || []),
      })),
    })),
    reportFilters: wireFilters(reportFilters),
    dataSource,
  }), [pages, reportFilters, dataSource]);

  const save = useCallback(async () => {
    // Brand-new report: route Save to the create-then-redirect flow (the
    // /definition route has no create path for id === 'new').
    if (isNew) {
      setCreateErr(null);
      setCreateName((prev) => prev || reportName.trim() || 'Untitled report');
      setCreateOpen(true);
      return;
    }
    setSaveBusy(true); setSaveMsg(null);
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}/definition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildDefinitionBody()),
      });
      const j = await r.json();
      if (j.ok) { setDirty(false); setSaveMsg({ ok: true, text: `Saved ${j.pageCount} page(s), ${j.visualCount} visual(s).` }); }
      else setSaveMsg({ ok: false, text: j.error || `HTTP ${r.status}` });
    } catch (e: any) { setSaveMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setSaveBusy(false); }
  }, [isNew, id, reportName, buildDefinitionBody]);

  // ── first-save create: mint the real item, persist layout + data source, open it ──
  // Lazily load the caller's workspaces when the create dialog opens (the report
  // needs a home workspace, just like every other focused editor's /new gate).
  useEffect(() => {
    if (!createOpen || workspaces !== null) return;
    (async () => {
      try {
        const r = await fetch('/api/loom/workspaces');
        const j = await r.json();
        if (j.ok) {
          const list = (j.workspaces || []) as { id: string; name: string }[];
          setWorkspaces(list);
          setCreateWsId((prev) => prev || list[0]?.id || '');
        } else { setWorkspaces([]); setWsErr(j.error || `HTTP ${r.status}`); }
      } catch (e: any) { setWorkspaces([]); setWsErr(e?.message || String(e)); }
    })();
  }, [createOpen, workspaces]);

  const createNewReport = useCallback(async () => {
    const name = createName.trim() || reportName.trim() || 'Untitled report';
    if (!createWsId) { setCreateErr('Select a workspace for the new report.'); return; }
    setCreateBusy(true); setCreateErr(null);
    try {
      // 1. Mint the real Cosmos `report` item (generic create route).
      const cr = await fetch('/api/cosmos-items/report', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: createWsId, displayName: name }),
      });
      const cj = await cr.json().catch(() => ({} as any));
      if (!cr.ok || !cj?.ok || !cj.item?.id) throw new Error(cj?.error || `Could not create the report (HTTP ${cr.status}).`);
      const newId: string = cj.item.id;

      // 2. Persist the designed pages/visuals/filters against the new id.
      const dr = await fetch(`/api/items/report/${encodeURIComponent(newId)}/definition`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(buildDefinitionBody()),
      });
      const dj = await dr.json().catch(() => ({} as any));
      if (!dr.ok || !dj?.ok) throw new Error(dj?.error || `Saving the report layout failed (HTTP ${dr.status}).`);

      // 3. Persist the chosen data source if one was bound in-session. Non-fatal:
      //    a validation reject shouldn't strand the created report — the live
      //    editor will show its honest "pick a data source" gate.
      if (isBound(dataSource) && dataSource) {
        await fetch(`/api/items/report/${encodeURIComponent(newId)}/data-source`, {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataSource }),
        }).catch(() => { /* swallow — re-pickable in the live editor */ });
      }

      // 4. Open the live editor (full Save / Publish / fields now wired to a real id).
      setDirty(false);
      router.push(`/items/report/${encodeURIComponent(newId)}`);
      // intentionally leave createBusy=true while we navigate away
    } catch (e: any) {
      setCreateErr(e?.message || String(e)); setCreateBusy(false);
    }
  }, [createName, reportName, createWsId, buildDefinitionBody, dataSource, router]);


  // ── data source: persist the chosen source (PUT …/data-source) ────────────────
  // The picker hands us the chosen ReportDataSource; we persist it on the report
  // item's state.dataSource. For a not-yet-saved report (id === 'new') the source
  // is held in session and committed on first Save. If the v2 data-source route
  // isn't present we keep the selection active for the session and say so (honest
  // gate, no silent no-op) — the default AAS source already drives /fields + /query.
  const applyDataSource = useCallback(async (ds: ReportDataSource) => {
    if (id === 'new') {
      setDataSource(ds); setDsOpen(false); setDirty(true);
      setDsNote({ ok: true, text: `Data source set (${describeSource(ds)}). Save the report to persist it.` });
      return;
    }
    setDsSaving(true); setDsNote(null);
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}/data-source`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataSource: ds }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.ok) {
        setDataSource(parseDataSource(j.dataSource) ?? ds);
        setDsNote({ ok: true, text: `Data source saved (${describeSource(ds)}).` });
      } else {
        setDataSource(ds);
        setDsNote({ ok: false, text: j?.error || `Selection active for this session (data-source route returned HTTP ${r.status}).` });
      }
    } catch (e: any) {
      setDataSource(ds);
      setDsNote({ ok: false, text: `Selection active for this session (${e?.message || String(e)}).` });
    } finally {
      setDsSaving(false); setDsOpen(false); loadFields();
    }
  }, [id, loadFields]);

  // ── publish ───────────────────────────────────────────────────────────────────
  // Default target is the Azure-native Organization gallery (Cosmos snapshot);
  // Power BI is opt-in (NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi + a workspace). Either
  // way we POST to the canonical publish route and surface its real response or an
  // honest gate naming the missing target — never a silent success.
  const doPublish = useCallback(async () => {
    setPublishBusy(true); setPublishMsg(null);
    try {
      const r = await fetch(`/api/items/report/${encodeURIComponent(id)}/publish`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: publishTarget }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j?.ok) {
        setPublishMsg({ ok: true, text: j.message || (publishTarget === 'powerbi'
          ? 'Published to the Power BI workspace.'
          : 'Published to the Organization gallery (/org-reports).') });
      } else {
        setPublishMsg({ ok: false, text: j?.error || `Publishing requires the report publish route / target to be configured (HTTP ${r.status}).` });
      }
    } catch (e: any) { setPublishMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setPublishBusy(false); }
  }, [id, publishTarget]);

  // ── ribbon ───────────────────────────────────────────────────────────────────
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Report', actions: [
        { label: isNew ? 'Create report' : (saveBusy ? 'Saving…' : 'Save'), icon: <Save20Regular />, onClick: save, disabled: saveBusy || (!isNew && !dirty), title: isNew ? 'Name and create this report' : 'persist the whole report definition' },
        { label: 'Refresh', icon: <ArrowSync20Regular />, onClick: () => { loadDetail(); loadFields(); }, title: 'reload definition + model fields' },
      ]},
      { label: 'Data', actions: [
        { label: 'Data source', icon: <Database20Regular />, onClick: () => setDsOpen(true), title: `Bind data — ${describeSource(dataSource)}` },
        { label: 'Publish', icon: <CloudArrowUp20Regular />, onClick: () => { setPublishMsg(null); setPublishOpen(true); }, disabled: isNew, title: isNew ? 'Save the report before publishing' : 'Publish to the Organization gallery' },
      ]},
      { label: 'Insert', actions: [
        { label: 'New page', icon: <Add20Regular />, onClick: addPage, title: 'add a report page' },
      ]},
    ]},
  ], [save, saveBusy, dirty, loadDetail, loadFields, dataSource, id, isNew]);

  // ── left: pages ──────────────────────────────────────────────────────────────
  const leftPanel = (
    <div className={styles.pane}>
      <div className={styles.toolbar}>
        <Subtitle2>Pages</Subtitle2>
        <div className={styles.spacer} />
        <Tooltip content="Add page" relationship="label">
          <Button size="small" appearance="subtle" icon={<Add20Regular />} onClick={addPage} />
        </Tooltip>
      </div>
      {pages.map((p, i) => (
        <div key={p.id} className={mergeClasses(styles.pageRow, i === activePage && styles.pageRowActive)}
          onClick={() => { setActivePage(i); setSelectedVisual(null); }}>
          <Text className={styles.pageRowName}>{p.name}</Text>
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button size="small" appearance="subtle" icon={<Edit20Regular />} aria-label="page actions" onClick={(e) => e.stopPropagation()} />
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <RenamePageItem name={p.name} onRename={(n) => renamePage(p.id, n)} />
                <MenuItem icon={<Delete20Regular />} onClick={() => deletePage(p.id)}>Delete page</MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      ))}
      {pages.length === 0 && <Caption1 className={styles.muted}>No pages.</Caption1>}
    </div>
  );

  // ── center: canvas ───────────────────────────────────────────────────────────
  const main = (
    <div className={styles.canvasWrap}>
      <div className={styles.toolbar}>
        <Badge appearance="filled" color="brand">Report · Loom-native · {describeSource(dataSource)}</Badge>
        {reportName && <Subtitle2>{reportName}{page ? ` — ${page.name}` : ''}</Subtitle2>}
        <div className={styles.spacer} />
        {dirty && <Badge appearance="tint" color="warning">Unsaved</Badge>}
        <Button appearance="primary" icon={<Save20Regular />} disabled={saveBusy || (!isNew && !dirty)} onClick={save}>
          {isNew ? 'Create report' : (saveBusy ? 'Saving…' : 'Save')}
        </Button>
      </div>

      {loadErr && <MessageBar intent="error"><MessageBarBody>{loadErr}</MessageBarBody></MessageBar>}
      {saveMsg && <MessageBar intent={saveMsg.ok ? 'success' : 'error'}><MessageBarBody>{saveMsg.text}</MessageBarBody></MessageBar>}
      {dsNote && <MessageBar intent={dsNote.ok ? 'success' : 'warning'}><MessageBarBody>{dsNote.text}</MessageBarBody></MessageBar>}
      {!bound && !loading && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Choose a data source</MessageBarTitle>
            This report isn&apos;t bound to data yet. Click <strong>Data source</strong> to bind a Loom <strong>semantic model</strong>
            {' '}(Azure-native — Synapse / lakehouse, no Power BI or Fabric required), build one from a SQL query, or bind an
            {' '}Azure Analysis Services tabular model. You can lay out pages and visuals now; they render once a source is bound.
          </MessageBarBody>
          <MessageBarActions>
            <Button size="small" appearance="primary" icon={<Database20Regular />} onClick={() => setDsOpen(true)}>Data source</Button>
          </MessageBarActions>
        </MessageBar>
      )}

      {loading && <Spinner label="Loading report…" />}

      {!loading && page && page.visuals.length === 0 && (
        <EmptyState
          icon={<DataBarVerticalRegular />}
          title="Design your first visual"
          body="Pick a visualization from the Visualizations pane on the right, then drag model fields into its wells. Every visual renders live against the bound data source."
        />
      )}

      {!loading && page && page.visuals.length > 0 && (
        <div className={styles.canvasGrid} ref={gridRef}>
          {page.visuals.map((v, i) => {
            const fmt = v.format;
            const showTitle = fmt?.showTitle !== false;
            const titleText = (fmt?.titleText && fmt.titleText.trim()) || v.title || '(untitled)';
            const merged = [...reportFilters, ...(page.filters || []), ...(v.filters || [])];
            return (
            <div key={v.id}
              className={mergeClasses(
                styles.vcard,
                selectedVisual === v.id && styles.vcardSel,
                canvas.draggingId === v.id && styles.vcardDragging,
                canvas.dropIndicator?.id === v.id && canvas.dropIndicator.side === 'before' && styles.vcardDropBefore,
                canvas.dropIndicator?.id === v.id && canvas.dropIndicator.side === 'after' && styles.vcardDropAfter,
              )}
              style={{ gridColumn: `span ${Math.min(12, Math.max(2, v.w))}`, minHeight: `${Math.max(180, v.h * 40)}px` }}
              onClick={() => setSelectedVisual(v.id)}
              {...canvas.getDropTargetProps(v)}>
              <div className={styles.vcardHead}>
                <span className={styles.vcardDragHandle} title="Drag to reposition" {...canvas.getDragHandleProps(v)}>
                  <ReOrderDotsVertical20Regular />
                </span>
                <Badge appearance="tint" size="small">{VISUALS.find((x) => x.type === v.type)?.label || v.type}</Badge>
                {showTitle
                  ? <Text className={styles.vcardTitle} weight="semibold">{titleText}</Text>
                  : <div className={styles.spacer} />}
                <Tooltip content="Move left" relationship="label"><Button size="small" appearance="subtle" icon={<ChevronUp20Regular />} onClick={(e) => { e.stopPropagation(); moveVisual(v.id, -1); }} disabled={i === 0} /></Tooltip>
                <Tooltip content="Move right" relationship="label"><Button size="small" appearance="subtle" icon={<ChevronDown20Regular />} onClick={(e) => { e.stopPropagation(); moveVisual(v.id, 1); }} disabled={i === page.visuals.length - 1} /></Tooltip>
                <Tooltip content="Remove visual" relationship="label"><Button size="small" appearance="subtle" icon={<Delete20Regular />} onClick={(e) => { e.stopPropagation(); removeVisual(v.id); }} /></Tooltip>
              </div>
              <div className={styles.vcardBody}>
                <VisualBody visual={v} state={visualRows[v.id]} styles={styles} filters={merged} />
              </div>
              <div className={styles.resizeHandle} title="Drag to resize, or focus and use arrow keys"
                {...canvas.getResizeHandleProps(v)} />
            </div>
            );
          })}
        </div>
      )}
    </div>
  );

  // ── right: visualizations + fields ──────────────────────────────────────────
  const sizes: { label: string; w: number }[] = [
    { label: 'S', w: 3 }, { label: 'M', w: 6 }, { label: 'L', w: 9 }, { label: 'XL', w: 12 },
  ];
  const rightPanel = (
    <div className={styles.pane}>
      <TabList selectedValue={rightTab} onTabSelect={(_e, d) => setRightTab(d.value as 'build' | 'format' | 'filters' | 'copilot')} size="small">
        <Tab value="build" icon={<DataBarVerticalRegular />}>Build</Tab>
        <Tab value="format" icon={<ColorRegular />}>Format</Tab>
        <Tab value="filters" icon={<Filter20Regular />}>Filters</Tab>
        <Tab value="copilot" icon={<Sparkle20Regular />}>Power BI Copilot</Tab>
      </TabList>
      {rightTab === 'copilot' && (
        <ReportPowerBiCopilot
          reportId={id}
          tables={tables}
          pageIndex={activePage}
          pageName={page?.name || ''}
          visualCount={page?.visuals.length || 0}
          onApplyVisual={applyCopilotVisual}
          onAddPage={addCopilotPage}
        />
      )}
      {rightTab === 'format' && (
        <FormatPane
          visualType={selected?.type ?? null}
          format={selected?.format}
          onChange={(f) => { if (selected) mutateVisual(selected.id, (v) => ({ ...v, format: f })); }}
        />
      )}
      {rightTab === 'filters' && (
        <FiltersPane
          styles={styles}
          tables={tables}
          reportFilters={reportFilters}
          pageFilters={page?.filters || []}
          visualFilters={selected ? (selected.filters || []) : null}
          selectedTitle={selected?.title || null}
          onReport={(next) => { setReportFilters(next); setDirty(true); }}
          onPage={(next) => mutatePage((p) => ({ ...p, filters: next }))}
          onVisual={(next) => { if (selected) mutateVisual(selected.id, (v) => ({ ...v, filters: next })); }}
        />
      )}
      {rightTab === 'build' && (
      <>
      <Title3>Visualizations</Title3>
      <div className={styles.gallery}>
        {VISUALS.map((vt) => (
          <button key={vt.type} type="button"
            className={mergeClasses(styles.galleryBtn, selected?.type === vt.type && styles.galleryBtnActive)}
            onClick={() => (selected ? mutateVisual(selected.id, (v) => ({ ...v, type: vt.type })) : addVisual(vt.type))}
            title={selected ? `change to ${vt.label}` : `add a ${vt.label}`}>
            {vt.icon}
            <Caption1>{vt.label}</Caption1>
          </button>
        ))}
      </div>

      <Divider />

      {!selected && <Caption1 className={styles.muted}>Select a visual on the canvas, or click a visualization above to add one, then assign fields.</Caption1>}

      {selected && (
        <>
          <div className={styles.section}>
            <Caption1><strong>Title</strong></Caption1>
            <Input size="small" value={selected.title}
              onChange={(_e, d) => mutateVisual(selected.id, (v) => ({ ...v, title: d.value }))} />
          </div>
          <div className={styles.section}>
            <Caption1><strong>Size</strong></Caption1>
            <div className={styles.toolbar}>
              {sizes.map((s) => (
                <Button key={s.label} size="small" appearance={selected.w === s.w ? 'primary' : 'outline'}
                  onClick={() => mutateVisual(selected.id, (v) => ({ ...v, w: s.w }))}>{s.label}</Button>
              ))}
            </div>
          </div>

          {wellsFor(selected.type).map((w) => (
            <WellEditor key={w.name} visual={selected} well={w.name} label={w.label} tables={tables} styles={styles}
              onAdd={(well, f) => addToWell(selected.id, well, f)}
              onRemove={(well, fuid) => removeFromWell(selected.id, well, fuid)}
              onAgg={(well, fuid, agg) => setAgg(selected.id, well, fuid, agg)}
              onDrop={(well, f) => addToWell(selected.id, well, f)} />
          ))}
        </>
      )}

      <Divider />

      <div className={styles.toolbar}>
        <Title3>Fields</Title3>
        <div className={styles.spacer} />
        <Tooltip content="Reload model fields" relationship="label">
          <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={loadFields} />
        </Tooltip>
      </div>
      {fieldsLoading && <Spinner size="tiny" label="Reading model…" />}
      {fieldsErr && !fieldsLoading && (
        <MessageBar intent="warning"><MessageBarBody>{fieldsErr}</MessageBarBody></MessageBar>
      )}
      {!fieldsLoading && tables.length > 0 && (
        <Tree aria-label="Model fields">
          {tables.map((t) => (
            <TreeItem key={t.name} itemType="branch" value={t.name}>
              <TreeItemLayout>{t.name}</TreeItemLayout>
              <Tree>
                {t.measures.map((m) => (
                  <TreeItem key={`m:${m.name}`} itemType="leaf" value={`m:${t.name}.${m.name}`}>
                    <TreeItemLayout iconBefore={<NumberSymbol20Regular />}>
                      <span className={styles.chip} draggable
                        onDragStart={(e) => e.dataTransfer.setData('application/json', JSON.stringify({ measure: m.name }))}>
                        {m.name}
                      </span>
                    </TreeItemLayout>
                  </TreeItem>
                ))}
                {t.columns.map((c) => (
                  <TreeItem key={`c:${c.name}`} itemType="leaf" value={`c:${t.name}.${c.name}`}>
                    <TreeItemLayout>
                      <span className={styles.chip} draggable
                        onDragStart={(e) => e.dataTransfer.setData('application/json', JSON.stringify({ table: t.name, column: c.name }))}>
                        {c.name}
                      </span>
                    </TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          ))}
        </Tree>
      )}
      {!fieldsLoading && tables.length === 0 && !fieldsErr && (
        <Caption1 className={styles.muted}>No model fields. Bind a data source (ribbon → Data source) to populate the Fields tree.</Caption1>
      )}
      </>
      )}
    </div>
  );

  return (
    <>
      <ItemEditorChrome item={item} id={id} ribbon={ribbon}
        leftPanel={leftPanel} main={main} rightPanel={rightPanel} rightPanelLabel="Build" />

      {/* Data source picker (semantic-model default · direct-query · AAS) */}
      <DataSourcePicker
        open={dsOpen}
        reportId={id}
        value={dataSource}
        onChange={applyDataSource}
        onDismiss={() => setDsOpen(false)}
        saving={dsSaving}
      />

      {/* First-save: name + workspace → mint the real item, then open it (id==='new') */}
      <Dialog open={createOpen} onOpenChange={(_e, d) => { if (!createBusy) setCreateOpen(d.open); }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Create report</DialogTitle>
            <DialogContent>
              <div className={styles.section}>
                <Caption1 className={styles.muted}>
                  Saves this report to a workspace so its full Save / Publish / data-source actions run against a
                  real item. Your current pages, visuals, filters{isBound(dataSource) ? ', and data source' : ''} are
                  carried over.
                </Caption1>
                {wsErr && (
                  <MessageBar intent="warning"><MessageBarBody>
                    <MessageBarTitle>Workspaces not reachable</MessageBarTitle>{wsErr}
                  </MessageBarBody></MessageBar>
                )}
                {workspaces !== null && workspaces.length === 0 && !wsErr && (
                  <MessageBar intent="warning"><MessageBarBody>
                    <MessageBarTitle>No workspaces yet</MessageBarTitle>
                    Create a workspace first (Home → New workspace), then return to create this report.
                  </MessageBarBody></MessageBar>
                )}
                <Field label="Name">
                  <Input value={createName} placeholder="Untitled report"
                    onChange={(_e, d) => setCreateName(d.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && createWsId && !createBusy) createNewReport(); }} />
                </Field>
                <Field label="Workspace">
                  <Dropdown
                    placeholder={workspaces === null ? 'Loading workspaces…' : (workspaces.length ? 'Select a workspace' : 'No workspaces available')}
                    disabled={workspaces === null || workspaces.length === 0}
                    value={(workspaces || []).find((w) => w.id === createWsId)?.name || ''}
                    selectedOptions={createWsId ? [createWsId] : []}
                    onOptionSelect={(_e, d) => setCreateWsId(d.optionValue || '')}>
                    {(workspaces || []).map((w) => <Option key={w.id} value={w.id}>{w.name}</Option>)}
                  </Dropdown>
                </Field>
                {createErr && (
                  <MessageBar intent="error"><MessageBarBody>
                    <MessageBarTitle>Create failed</MessageBarTitle>{createErr}
                  </MessageBarBody></MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" disabled={createBusy} onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button appearance="primary" icon={createBusy ? <Spinner size="tiny" /> : <Save20Regular />}
                disabled={createBusy || !createWsId} onClick={createNewReport}>
                {createBusy ? 'Creating…' : 'Create report'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Publish — Azure-native Org gallery default · Power BI opt-in */}
      <Dialog open={publishOpen} onOpenChange={(_e, d) => setPublishOpen(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Publish report</DialogTitle>
            <DialogContent>
              <div className={styles.section}>
                <Caption1 className={styles.muted}>
                  Publish a snapshot so colleagues can view it. The default is the Azure-native
                  Organization gallery (<code>/org-reports</code>) — no Power BI or Fabric required.
                </Caption1>
                <Field label="Target">
                  <RadioGroup value={publishTarget} onChange={(_e, d) => setPublishTarget(d.value as 'org' | 'powerbi')}>
                    <Radio value="org" label="Organization gallery (Azure-native, default)" />
                    <Radio value="powerbi" disabled={!pbiPublishEnabled}
                      label={pbiPublishEnabled ? 'Power BI workspace (opt-in)' : 'Power BI workspace — set NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi to enable'} />
                  </RadioGroup>
                </Field>
                {publishMsg && (
                  <MessageBar intent={publishMsg.ok ? 'success' : 'warning'}>
                    <MessageBarBody>{publishMsg.text}</MessageBarBody>
                  </MessageBar>
                )}
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setPublishOpen(false)}>Close</Button>
              <Button appearance="primary" icon={publishBusy ? <Spinner size="tiny" /> : <CloudArrowUp20Regular />}
                disabled={publishBusy} onClick={doPublish}>
                {publishBusy ? 'Publishing…' : 'Publish'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

/** Inline rename control rendered inside the page's action menu. */
function RenamePageItem({ name, onRename }: { name: string; onRename: (n: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(name);
  if (!editing) {
    return <MenuItem icon={<Edit20Regular />} persistOnClick onClick={(e) => { e?.preventDefault?.(); setVal(name); setEditing(true); }}>Rename page</MenuItem>;
  }
  return (
    <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS, padding: tokens.spacingVerticalXS }}>
      <Input size="small" value={val} autoFocus onClick={(e) => e.stopPropagation()}
        onChange={(_e, d) => setVal(d.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { onRename(val.trim() || name); setEditing(false); } }} />
      <Button size="small" appearance="primary" onClick={() => { onRename(val.trim() || name); setEditing(false); }}>OK</Button>
    </div>
  );
}

export default ReportDesigner;
