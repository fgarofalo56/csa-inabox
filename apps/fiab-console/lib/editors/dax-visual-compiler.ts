/**
 * DAX Visual compiler — Power-BI-style visual field wells → a single DAX
 * EVALUATE query that the dataset's query engine (Power BI `executeQueries`
 * REST, which works against any Power BI dataset regardless of its
 * loomSemanticBackend) can run to return the rows the visual renders.
 *
 * Pure, side-effect-free TypeScript. No React, no fetch. This is the DAX analog
 * of `visual-query-compiler.ts` (which compiles a canvas graph → SQL). The
 * report Visual Designer feeds a `VisualDef` in and gets a complete DAX string
 * out, which the BFF `/api/items/report/[id]/query` route executes.
 *
 * Parity target: the Power BI Desktop / Power BI Web visual gallery — bar /
 * column / line / area / combo / pie / donut / card / multi-row card / KPI /
 * table / matrix / map / filled-map / scatter / gauge / funnel / treemap /
 * slicer. Each visual maps its field wells (Axis, Legend, Values, …) onto a
 * SUMMARIZECOLUMNS / ROW / VALUES query exactly the way Power BI's engine does
 * when it renders that visual (visible in Desktop's Performance Analyzer →
 * "Copy query"). We surface the generated DAX as the per-visual receipt.
 *
 * Why this exists (no-freeform-config.md): operators build every visual through
 * guided field wells (column / measure pickers) + a Filters pane (column picker
 * + value list). The ONLY freeform slot is a filter's value list — the
 * explicitly-allowed 1:1 builder exception, mirroring the SQL visual-query
 * compiler's single WHERE slot. The DAX is never hand-edited; it is always
 * generated here so the visual config stays the single source of truth.
 *
 * Grounded in Microsoft Learn:
 *   - SUMMARIZECOLUMNS: learn.microsoft.com/dax/summarizecolumns-function-dax
 *   - TREATAS:          learn.microsoft.com/dax/treatas-function-dax
 *   - KEEPFILTERS:      learn.microsoft.com/dax/keepfilters-function-dax
 *   - ROLLUPADDISSUBTOTAL: learn.microsoft.com/dax/rollupaddissubtotal
 *   - executeQueries REST: learn.microsoft.com/rest/api/power-bi/datasets/execute-queries
 */

// ============================================================
// Visual model — shared with report-visual-designer.tsx, which builds a
// VisualDef from the Fields/Format/Filters panes. Kept here so the compiler has
// zero dependency on the React component file.
// ============================================================

export type DaxVisualType =
  | 'bar' | 'column' | 'line' | 'area' | 'combo'
  | 'pie' | 'donut'
  | 'card' | 'multi-row-card' | 'kpi'
  | 'table' | 'matrix'
  | 'map' | 'filled-map'
  | 'scatter'
  | 'gauge' | 'funnel' | 'treemap'
  | 'slicer';

/** All visual types in gallery order, with the field wells each exposes. */
export const VISUAL_CATALOG: ReadonlyArray<{
  type: DaxVisualType;
  label: string;
  /** Field-well labels shown in the Fields pane, mapped to a binding role. */
  wells: ReadonlyArray<{ role: VisualWellRole; label: string; multi: boolean }>;
}> = [
  { type: 'bar', label: 'Bar chart', wells: [w('category', 'Y axis', false), w('value', 'X axis (values)', true), w('legend', 'Legend', false)] },
  { type: 'column', label: 'Column chart', wells: [w('category', 'X axis', false), w('value', 'Y axis (values)', true), w('legend', 'Legend', false)] },
  { type: 'line', label: 'Line chart', wells: [w('category', 'X axis', false), w('value', 'Y axis (values)', true), w('legend', 'Legend', false)] },
  { type: 'area', label: 'Area chart', wells: [w('category', 'X axis', false), w('value', 'Y axis (values)', true), w('legend', 'Legend', false)] },
  { type: 'combo', label: 'Line and column', wells: [w('category', 'X axis', false), w('value', 'Column values', true), w('valueLine', 'Line values', true)] },
  { type: 'pie', label: 'Pie chart', wells: [w('category', 'Legend', false), w('value', 'Values', false)] },
  { type: 'donut', label: 'Donut chart', wells: [w('category', 'Legend', false), w('value', 'Values', false)] },
  { type: 'card', label: 'Card', wells: [w('value', 'Field', false)] },
  { type: 'multi-row-card', label: 'Multi-row card', wells: [w('value', 'Fields', true)] },
  { type: 'kpi', label: 'KPI', wells: [w('value', 'Indicator', false), w('target', 'Target goal', false), w('category', 'Trend axis', false)] },
  { type: 'table', label: 'Table', wells: [w('column', 'Columns', true), w('value', 'Values', true)] },
  { type: 'matrix', label: 'Matrix', wells: [w('category', 'Rows', true), w('matrixColumn', 'Columns', false), w('value', 'Values', true)] },
  { type: 'map', label: 'Map (bubble)', wells: [w('location', 'Location', false), w('value', 'Bubble size', false), w('legend', 'Legend', false)] },
  { type: 'filled-map', label: 'Filled map', wells: [w('location', 'Location', false), w('value', 'Color saturation', false)] },
  { type: 'scatter', label: 'Scatter chart', wells: [w('category', 'Details', false), w('value', 'X axis', false), w('valueLine', 'Y axis', false)] },
  { type: 'gauge', label: 'Gauge', wells: [w('value', 'Value', false), w('target', 'Target value', false)] },
  { type: 'funnel', label: 'Funnel', wells: [w('category', 'Group', false), w('value', 'Values', false)] },
  { type: 'treemap', label: 'Treemap', wells: [w('category', 'Group', false), w('value', 'Values', false), w('legend', 'Details', false)] },
  { type: 'slicer', label: 'Slicer', wells: [w('category', 'Field', false)] },
];

export type VisualWellRole =
  | 'category'      // group-by axis / legend / rows
  | 'legend'        // secondary group-by (series)
  | 'value'         // numeric measure / aggregated column
  | 'valueLine'     // second value set (combo line, scatter Y)
  | 'target'        // KPI / gauge target measure
  | 'column'        // table column (group-by, no aggregation)
  | 'matrixColumn'  // matrix column field (pivots client-side)
  | 'location';     // map geographic field

function w(role: VisualWellRole, label: string, multi: boolean) {
  return { role, label, multi };
}

export interface DaxFieldBinding {
  /** Fully-qualified: 'TableName'[ColumnName] or 'TableName'[MeasureName]. */
  ref: string;
  /** True when ref is a model measure (already aggregated, used as-is). */
  isMeasure?: boolean;
  /** Aggregation to wrap a plain column in when used as a value. */
  agg?: DaxAgg;
  /** Result-column header override (defaults to a readable name from ref). */
  alias?: string;
}

export type DaxAgg = 'SUM' | 'AVERAGE' | 'MIN' | 'MAX' | 'COUNT' | 'DISTINCTCOUNT';

export interface DaxFilterDef {
  /** Column reference: 'TableName'[ColumnName]. */
  column: string;
  /** Filter type — IN-list (Power BI "Basic" filter). */
  type: 'in';
  /** Values to keep. Strings are quoted; pure numbers are emitted bare. */
  values: string[];
}

export type LegendPosition = 'right' | 'top' | 'bottom' | 'left' | 'none';

export interface DaxFormatDef {
  title?: string;
  titleFontSize?: number;
  dataLabels?: boolean;
  legendPosition?: LegendPosition;
  xAxisTitle?: string;
  yAxisTitle?: string;
  /** Per-series colour overrides (hex). */
  colors?: string[];
}

export interface VisualDef {
  type: DaxVisualType;
  /** Group-by / axis / rows fields. */
  categoryFields: DaxFieldBinding[];
  /** Legend / series group-by fields (secondary axis grouping). */
  legendFields?: DaxFieldBinding[];
  /** Numeric value fields (measures or aggregated columns). */
  valueFields: DaxFieldBinding[];
  /** Second value set (combo line values, scatter Y, KPI target as value). */
  valueLineFields?: DaxFieldBinding[];
  /** Table "Columns" well — group-by fields with NO aggregation. */
  columnFields?: DaxFieldBinding[];
  /** Matrix "Columns" field (single) — group-by, pivoted client-side. */
  matrixColumnField?: DaxFieldBinding;
  /** KPI / gauge target measure. */
  targetField?: DaxFieldBinding;
  /** Map geographic location field. */
  locationField?: DaxFieldBinding;
  /** Visual-level filters. */
  visualFilters?: DaxFilterDef[];
  /** Page-level filters (applied on top of visual filters). */
  pageFilters?: DaxFilterDef[];
  /** Report-level filters (applied on top of page + visual filters). */
  reportFilters?: DaxFilterDef[];
  format?: DaxFormatDef;
  /** Raw-table row cap for non-aggregated table visuals. */
  rowLimit?: number;
}

const PLACEHOLDER =
  '-- Add fields to the visual to generate its DAX query.\n' +
  '-- (Pick a category/axis field and at least one value, or a slicer field.)';

const HEADER =
  '-- Generated by the Loom Visual Designer. Edit the visual fields, format, and\n' +
  '-- filters in the designer panes — not this text. This is the query Power BI\n' +
  "-- runs to render the visual (Desktop Performance Analyzer → \"Copy query\").\n";

// ============================================================
// Reference + literal helpers
// ============================================================

/** Strip ' ' table wrapper + [..] column wrapper to a readable alias. */
export function refToAlias(ref: string): string {
  const m = ref.match(/\[([^\]]+)\]\s*$/);
  if (m) return m[1];
  return ref.replace(/^'?([^'[]+)'?/, '$1').trim() || ref;
}

/** True when a value list element should be emitted as a bare DAX number. */
function isNumericLiteral(v: string): boolean {
  return v.trim() !== '' && !Number.isNaN(Number(v));
}

/** Quote a filter value as a DAX string literal (or leave a number bare). */
function daxValue(v: string): string {
  if (isNumericLiteral(v)) return String(Number(v));
  return `"${v.replace(/"/g, '""')}"`;
}

/** Quote an alias as a DAX string literal for the SUMMARIZECOLUMNS header. */
function quoteAlias(a: string): string {
  return `"${a.replace(/"/g, '""')}"`;
}

/** Wrap a value-field binding into its DAX scalar expression. */
function valueExpr(b: DaxFieldBinding): string {
  if (b.isMeasure) return b.ref;
  const agg = b.agg || 'SUM';
  return `${agg}(${b.ref})`;
}

/**
 * Build the TREATAS filter args from every filter scope. Each IN-list filter
 * becomes `KEEPFILTERS(TREATAS({v1, v2}, 'T'[Col]))` — KEEPFILTERS preserves
 * SUMMARIZECOLUMNS' auto-exist filter context instead of replacing it
 * (learn.microsoft.com/dax/keepfilters-function-dax).
 */
function filterArgs(v: VisualDef): string[] {
  const all = [
    ...(v.reportFilters || []),
    ...(v.pageFilters || []),
    ...(v.visualFilters || []),
  ];
  return all
    .filter((f) => f.column && f.values && f.values.length > 0)
    .map((f) => {
      const vals = f.values.map(daxValue).join(', ');
      return `KEEPFILTERS(TREATAS({${vals}}, ${f.column}))`;
    });
}

/** De-dup + alias the value bindings into `"alias", expr` SUMMARIZECOLUMNS pairs. */
function valuePairs(bindings: DaxFieldBinding[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  bindings.forEach((b, i) => {
    if (!b.ref) return;
    let alias = b.alias || refToAlias(b.ref);
    while (seen.has(alias)) alias = `${alias}_${i}`;
    seen.add(alias);
    out.push(`${quoteAlias(alias)}, ${valueExpr(b)}`);
  });
  return out;
}

/** Group-by column refs, de-duplicated, preserving order. */
function groupCols(...lists: (DaxFieldBinding[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const b of list || []) {
      if (b?.ref && !seen.has(b.ref)) { seen.add(b.ref); out.push(b.ref); }
    }
  }
  return out;
}

// ============================================================
// SUMMARIZECOLUMNS assembler (the workhorse for most visual types)
// ============================================================

function summarizeColumns(groupRefs: string[], filters: string[], valuePairList: string[]): string {
  const args: string[] = [...groupRefs, ...filters, ...valuePairList];
  if (args.length === 0) return 'EVALUATE { BLANK() }';
  const indented = args.map((a) => `    ${a}`).join(',\n');
  return `EVALUATE\nSUMMARIZECOLUMNS(\n${indented}\n)`;
}

// ============================================================
// Public API
// ============================================================

/**
 * compileDaxQuery — turn a VisualDef into a runnable DAX EVALUATE query.
 * Returns a placeholder comment (no error) when the visual has no usable
 * fields, so the designer can show "add fields" rather than a syntax error.
 */
export function compileDaxQuery(v: VisualDef): string {
  const filters = filterArgs(v);

  switch (v.type) {
    // ── Slicer: distinct values of the field, no measures ──────────────────
    case 'slicer': {
      const col = v.categoryFields[0]?.ref;
      if (!col) return PLACEHOLDER;
      if (filters.length === 0) return `${HEADER}EVALUATE VALUES(${col})\nORDER BY ${col}`;
      // With filters, CALCULATETABLE narrows the distinct values.
      return `${HEADER}EVALUATE\nCALCULATETABLE(\n    VALUES(${col}),\n${filters.map((f) => `    ${f}`).join(',\n')}\n)\nORDER BY ${col}`;
    }

    // ── Card / KPI / Gauge: scalar aggregates as a single ROW ──────────────
    case 'card':
    case 'kpi':
    case 'gauge': {
      const vals: DaxFieldBinding[] = [];
      if (v.valueFields[0]) vals.push(v.valueFields[0]);
      if ((v.type === 'kpi' || v.type === 'gauge') && v.targetField) vals.push({ ...v.targetField, alias: v.targetField.alias || 'Target' });
      if (vals.length === 0) return PLACEHOLDER;
      // KPI with a trend axis is a categorical series, not a scalar — fall
      // through to SUMMARIZECOLUMNS so the trend line has rows.
      if (v.type === 'kpi' && v.categoryFields[0]?.ref) break;
      const rowArgs = vals.map((b) => `${quoteAlias(b.alias || refToAlias(b.ref))}, ${valueExpr(b)}`).join(', ');
      if (filters.length === 0) return `${HEADER}EVALUATE ROW(${rowArgs})`;
      return `${HEADER}EVALUATE\nCALCULATETABLE(\n    ROW(${rowArgs}),\n${filters.map((f) => `    ${f}`).join(',\n')}\n)`;
    }

    // ── Multi-row card: each measure value as its own row ──────────────────
    case 'multi-row-card': {
      if (v.categoryFields[0]?.ref) break; // grouped multi-row → SUMMARIZECOLUMNS
      const vals = v.valueFields.filter((b) => b.ref);
      if (vals.length === 0) return PLACEHOLDER;
      const rowArgs = vals.map((b) => `${quoteAlias(b.alias || refToAlias(b.ref))}, ${valueExpr(b)}`).join(', ');
      if (filters.length === 0) return `${HEADER}EVALUATE ROW(${rowArgs})`;
      return `${HEADER}EVALUATE\nCALCULATETABLE(\n    ROW(${rowArgs}),\n${filters.map((f) => `    ${f}`).join(',\n')}\n)`;
    }

    // ── Table: group-by columns + value aggregates, capped with TOPN ───────
    case 'table': {
      const cols = groupCols(v.columnFields, v.categoryFields);
      const valuePairList = valuePairs(v.valueFields);
      if (cols.length === 0 && valuePairList.length === 0) return PLACEHOLDER;
      const sc = summarizeColumns(cols, filters, valuePairList);
      const limit = v.rowLimit ?? 1000;
      // Wrap raw (no-aggregate) tables in TOPN to honour executeQueries limits.
      if (valuePairList.length === 0 && cols.length > 0) {
        const orderCol = cols[0];
        return `${HEADER}EVALUATE\nTOPN(${limit}, ${sc.replace(/^EVALUATE\n/, '')}, ${orderCol}, ASC)`;
      }
      return `${HEADER}${sc}`;
    }

    // ── Matrix: rows + (optional) columns field group-bys (client pivots) ──
    case 'matrix': {
      const cols = groupCols(v.categoryFields, v.matrixColumnField ? [v.matrixColumnField] : undefined);
      const valuePairList = valuePairs(v.valueFields);
      if (cols.length === 0 || valuePairList.length === 0) return PLACEHOLDER;
      return `${HEADER}${summarizeColumns(cols, filters, valuePairList)}`;
    }

    default:
      break;
  }

  // ── Default categorical visuals (bar/column/line/area/combo/pie/donut/
  //    scatter/funnel/treemap/map/filled-map and grouped card/kpi cases) ────
  const cols = groupCols(
    v.categoryFields,
    v.legendFields,
    v.locationField ? [v.locationField] : undefined,
  );
  const valuePairList = valuePairs([
    ...v.valueFields,
    ...(v.valueLineFields || []),
    ...(v.targetField && v.type === 'kpi' ? [{ ...v.targetField, alias: v.targetField.alias || 'Target' }] : []),
  ]);
  if (cols.length === 0 && valuePairList.length === 0) return PLACEHOLDER;
  if (valuePairList.length === 0) {
    // No measures → distinct categories (e.g. a map with only a location).
    if (cols.length === 1) return `${HEADER}EVALUATE VALUES(${cols[0]})`;
    return `${HEADER}${summarizeColumns(cols, filters, [])}`;
  }
  return `${HEADER}${summarizeColumns(cols, filters, valuePairList)}`;
}
