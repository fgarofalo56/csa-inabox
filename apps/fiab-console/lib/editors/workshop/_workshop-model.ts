/**
 * _workshop-model — plain (non-'use client') persisted-state types for the
 * Workshop (Atelier) app builder, following the `_plan-model.ts` convention.
 * Extracted verbatim from workshop-app-builder.tsx so server-side consumers
 * (the publish BFF route, the workshop bundle codegen in _palantir-codegen.ts)
 * can import the Cosmos-persisted shapes without a server→client layering
 * inversion. The builder re-exports these, so existing importers are unchanged.
 *
 * All imports below are type-only (fully erased at compile time) — this module
 * stays free of React / Next at runtime.
 */

import type { LoomChartType } from '@/lib/components/charts/loom-chart';
import type { AtelierFilterOp } from '@/lib/editors/_family-utils';

// ───────────────────────── types (persisted in Cosmos item state) ─────────────────────────

export type WorkshopVarType = 'object-set-filter' | 'string' | 'number' | 'boolean' | 'date';

// ───────────────────────── pages + overlays (WS-4.5 multi-page) ─────────────────────────

/** A page is either a navigable top-level page or an overlay (drawer / modal). */
export type WorkshopPageKind = 'page' | 'overlay';
/** How an overlay page surfaces in Run mode. */
export type WorkshopOverlayStyle = 'drawer' | 'modal';

/**
 * A Workshop app page. `page`s appear in the app nav; `overlay`s stay hidden
 * until opened by an `open-overlay` event and render as a Fluent Drawer or
 * Dialog. Every widget carries a `pageId` binding it to exactly one page.
 */
export interface WorkshopPage {
  id: string;
  name: string;
  kind: WorkshopPageKind;
  /** overlay only — drawer (side sheet) or modal (dialog). Default 'drawer'. */
  overlayStyle?: WorkshopOverlayStyle;
}

// ───────────────────────── conditional visibility (WS-4.5) ─────────────────────────

/** Predicate ops for a widget's show/hide rule over app state (no freeform code). */
export type WorkshopVisibilityOp = 'eq' | 'ne' | 'empty' | 'notEmpty' | 'truthy' | 'falsy';

/**
 * A widget-visibility rule evaluated over a single app variable's live runtime
 * value. Absent → always visible. Wizard-authored (dropdowns), never freeform.
 */
export interface WorkshopVisibilityRule {
  variableId: string;
  op: WorkshopVisibilityOp;
  /** Comparison literal for eq / ne. */
  value?: string;
}

export interface WorkshopVariable {
  id: string;
  name: string;
  type: WorkshopVarType;
  /** object-set-filter: the ontology object type it filters. */
  entityType?: string;
  /** Scalar default value (string-encoded). */
  defaultValue?: string;
}

export type WorkshopWidgetKind = 'table' | 'chart' | 'metric' | 'filter' | 'form' | 'button' | 'text' | 'image' | 'link' | 'divider' | 'badge' | 'iframe' | 'heading' | 'progress' | 'spacer' | 'timestamp' | 'kpi-row' | 'gauge' | 'callout' | 'quote' | 'rating' | 'tag-list' | 'delta' | 'checklist' | 'avatar' | 'code-block' | 'key-value' | 'countdown' | 'stat-pair' | 'mini-table' | 'breadcrumb' | 'json-view' | 'tabs' | 'accordion' | 'sparkline' | 'video-embed' | 'map-embed' | 'object-view' | 'links' | 'map' | 'pivot' | 'timeline' | 'aip-copilot';

/** The B+ (WS-4.5) advanced widgets over real backends (AGE / Synapse / Copilot). */
export const ADVANCED_WIDGET_KINDS = ['object-view', 'links', 'map', 'pivot', 'timeline', 'aip-copilot'] as const;
export type WorkshopAdvancedKind = typeof ADVANCED_WIDGET_KINDS[number];
export function isAdvancedKind(kind: WorkshopWidgetKind): kind is WorkshopAdvancedKind {
  return (ADVANCED_WIDGET_KINDS as readonly string[]).includes(kind);
}

export interface WorkshopWidgetLayout { x: number; y: number; w: number; h: number }

export type WorkshopEventTrigger = 'click' | 'row-select' | 'page-load';
export type WorkshopEventEffect = 'set-variable' | 'clear-variable' | 'run-action' | 'refresh' | 'open-overlay' | 'close-overlay';
export type WorkshopAggFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface WorkshopEvent {
  id: string;
  trigger: WorkshopEventTrigger;
  effect: WorkshopEventEffect;
  /** set-variable / clear-variable target. */
  targetVariableId?: string;
  /** set-variable: scalar literal value. */
  value?: string;
  /** set-variable into an object-set-filter variable: the predicate column/op. */
  filterColumn?: string;
  filterOp?: AtelierFilterOp;
  /** row-select: which column of the selected row supplies the value. */
  selectionColumn?: string;
  /** run-action target. */
  actionEntityType?: string;
  actionKind?: 'create' | 'update' | 'delete';
  /** open-overlay: the overlay page to open (close-overlay ignores it). */
  targetPageId?: string;
}

export interface WorkshopWidget {
  id: string;
  title: string;
  kind: WorkshopWidgetKind;
  layout?: WorkshopWidgetLayout;
  /** The page this widget lives on. Undefined → the app's first (default) page. */
  pageId?: string;
  /** Conditional visibility — hidden in Run mode when the rule fails (absent → always shown). */
  visibleWhen?: WorkshopVisibilityRule;
  /** ontology object type this widget binds to (table / chart / metric / filter / form). */
  entityType?: string;
  /** object-set-filter variables that constrain this widget's reads (data widgets). */
  appliesVariableIds?: string[];
  // chart
  chartType?: LoomChartType;
  groupBy?: string;
  aggFn?: WorkshopAggFn;
  aggColumn?: string;
  // metric
  metricFn?: WorkshopAggFn;
  metricColumn?: string;
  // filter
  filterColumn?: string;
  filterOp?: AtelierFilterOp;
  targetVariableId?: string;
  filterControl?: 'dropdown' | 'text';
  // form (real CRUD)
  formKind?: 'create' | 'update' | 'delete';
  // text
  text?: string;
  // image / iframe — the source URL (https only, enforced at render).
  src?: string;
  // link — the target URL (https only) shown as a styled anchor.
  href?: string;
  // badge — Fluent badge color name.
  badgeColor?: 'brand' | 'success' | 'warning' | 'danger' | 'informative';
  // progress — percent 0..100 (string-encoded; supports {{variable}}).
  progressValue?: string;
  // heading — visual level 1..3.
  headingLevel?: 1 | 2 | 3;
  // kpi-row — comma list of "Label=value" pairs; values support {{variable}}.
  kpiItems?: string;
  // gauge — value/min/max (string-encoded; value supports {{variable}}).
  gaugeValue?: string;
  gaugeMin?: string;
  gaugeMax?: string;
  // callout — Fluent MessageBar intent.
  calloutIntent?: 'info' | 'success' | 'warning' | 'error';
  // rating — value out of max stars (string-encoded; value supports {{variable}}).
  ratingValue?: string;
  ratingMax?: string;
  // tag-list — comma list of tags rendered as badges.
  tags?: string;
  // delta — current vs previous value; renders signed change with color.
  deltaValue?: string;
  deltaPrevious?: string;
  // checklist — newline list; lines starting "[x]" render checked.
  checklistItems?: string;
  // avatar — display name (initials derived) + optional caption.
  avatarName?: string;
  avatarCaption?: string;
  // code-block — monospace pre-formatted content.
  code?: string;
  // key-value — newline list of "Key: value" pairs; values support {{variable}}.
  keyValues?: string;
  // countdown — ISO date (yyyy-mm-dd) to count down to.
  countdownTo?: string;
  // stat-pair — two labeled stats side by side ("Label=value" each; {{variable}} ok).
  statLeft?: string;
  statRight?: string;
  // mini-table — first line = comma headers; following lines = comma rows.
  miniTable?: string;
  // breadcrumb — comma list of trail segments.
  crumbs?: string;
  // json-view — JSON text pretty-printed (or shown raw when invalid).
  json?: string;
  // tabs — "|"-separated "Title: content" entries rendered as a tab strip with
  // per-tab text content.
  tabItems?: string;
  // tabs — per-tab nested child widget ids, aligned with tabItems entries.
  // A nested widget renders INSIDE its tab pane in Run mode (full live body:
  // real reads, filters, buttons) instead of at the canvas top level. Tabs
  // widgets themselves are not nestable (no cycles).
  tabChildIds?: string[][];
  // accordion — newline "Title: body" entries (Fluent Accordion).
  accordionItems?: string;
  // sparkline — comma list of numbers rendered as a tiny inline line.
  sparkValues?: string;
  // video-embed / map-embed — https-only embed URL.
  embedUrl?: string;
  // ── WS-4.5 advanced widgets (object-view / links / map / pivot / timeline / aip-copilot) ──
  // object-view / links — a scalar/string variable whose live value is the
  // selected object's key (AGE vertex id) to drill into. Reuses entityType.
  keyVariableId?: string;
  // map — the row column carrying a geopoint/geoshape (lat,lon / {lat,lon} / GeoJSON).
  // Absent → the first geo-parseable column is auto-detected.
  geoColumn?: string;
  // pivot — rows grouped by pivotRowField × columns by pivotColField, cells aggregate.
  pivotRowField?: string;
  pivotColField?: string;
  pivotAggFn?: WorkshopAggFn;
  pivotAggColumn?: string;
  // timeline — the time column (X, ordered) + the label column shown per event.
  timeColumn?: string;
  labelColumn?: string;
  // aip-copilot — extra grounding context handed to the per-surface Copilot.
  copilotHint?: string;
  // button + table events
  events?: WorkshopEvent[];
}

/**
 * IDs of every widget claimed as a nested child by some tabs widget. Nested
 * widgets are hidden from the top-level canvas in Run mode (they render inside
 * their tab pane instead). Pure — shared by the builder and unit tests.
 */
export function nestedWidgetIds(widgets: WorkshopWidget[]): Set<string> {
  const ids = new Set<string>();
  for (const w of widgets) {
    if (w.kind !== 'tabs' || !w.tabChildIds) continue;
    for (const perTab of w.tabChildIds) {
      for (const cid of perTab || []) if (cid && cid !== w.id) ids.add(cid);
    }
  }
  // A tabs widget can never be nested (no cycles) — drop any stale claims.
  for (const w of widgets) if (w.kind === 'tabs') ids.delete(w.id);
  return ids;
}

// ───────────────────────── pages (WS-4.5) — pure resolution ─────────────────────────

const DEFAULT_PAGE_ID = 'page-1';

/**
 * Always-non-empty page list: seed a single default `page` when none persisted
 * (back-compat with pre-multi-page apps whose widgets have no pageId). Pure.
 */
export function resolvePages(pages?: WorkshopPage[]): WorkshopPage[] {
  const list = Array.isArray(pages) ? pages.filter((p) => p && p.id && p.name) : [];
  if (list.some((p) => p.kind === 'page')) return list;
  // No navigable page → prepend a synthesized default so nav always has a home.
  return [{ id: DEFAULT_PAGE_ID, name: 'Page 1', kind: 'page' }, ...list];
}

/** The id every un-bound (or dangling-pageId) widget falls back to — the first navigable page. */
export function defaultPageId(pages?: WorkshopPage[]): string {
  const resolved = resolvePages(pages);
  return (resolved.find((p) => p.kind === 'page') || resolved[0]).id;
}

/** Resolve a widget's effective page id (its own if it points at a real page, else the default). */
export function pageIdForWidget(w: WorkshopWidget, pages?: WorkshopPage[]): string {
  const resolved = resolvePages(pages);
  if (w.pageId && resolved.some((p) => p.id === w.pageId)) return w.pageId;
  return defaultPageId(pages);
}

/** Widgets that render on a given page id (honouring the default-page fallback). Pure. */
export function widgetsOnPage(widgets: WorkshopWidget[], pageId: string, pages?: WorkshopPage[]): WorkshopWidget[] {
  return widgets.filter((w) => pageIdForWidget(w, pages) === pageId);
}

// ───────────────────────── conditional visibility (WS-4.5) — pure eval ─────────────────────────

/** Canonicalise a runtime value (scalar string or predicate[] for object-set-filter). */
function visValue(raw: unknown): { str: string; empty: boolean } {
  if (Array.isArray(raw)) return { str: raw.map((p) => (p && typeof p === 'object' ? JSON.stringify(p) : String(p))).join(','), empty: raw.length === 0 };
  if (raw === null || raw === undefined) return { str: '', empty: true };
  const str = String(raw);
  return { str, empty: str === '' };
}

function isTruthy(v: { str: string; empty: boolean }): boolean {
  if (v.empty) return false;
  const low = v.str.trim().toLowerCase();
  return low !== 'false' && low !== '0' && low !== 'no' && low !== 'off';
}

/**
 * Evaluate a widget's visibility rule against the live runtime value of its
 * bound variable. Absent rule → visible. Missing variable value coerces to
 * empty. Pure — the builder AND the published bundle share this contract.
 */
export function evalVisibility(rule: WorkshopVisibilityRule | undefined, rawValue: unknown): boolean {
  if (!rule || !rule.variableId) return true;
  const v = visValue(rawValue);
  switch (rule.op) {
    case 'empty': return v.empty;
    case 'notEmpty': return !v.empty;
    case 'truthy': return isTruthy(v);
    case 'falsy': return !isTruthy(v);
    case 'ne': return v.str !== String(rule.value ?? '');
    case 'eq':
    default: return v.str === String(rule.value ?? '');
  }
}

// ───────────────────────── pivot + timeline (WS-4.5) — pure row shaping ─────────────────────────

export type WorkshopAggFnLite = WorkshopAggFn;

export interface PivotResult {
  rowKeys: string[];
  colKeys: string[];
  /** cells[rowKey][colKey] = aggregated number (0 when no matching rows). */
  cells: Record<string, Record<string, number>>;
  /** Row totals keyed by rowKey (aggregation of that row across all columns). */
  rowTotals: Record<string, number>;
}

function aggregate(fn: WorkshopAggFn, values: number[], matchCount: number): number {
  if (fn === 'count') return matchCount;
  if (values.length === 0) return 0;
  if (fn === 'sum') return values.reduce((a, b) => a + b, 0);
  if (fn === 'avg') return values.reduce((a, b) => a + b, 0) / values.length;
  if (fn === 'min') return Math.min(...values);
  if (fn === 'max') return Math.max(...values);
  return 0;
}

/**
 * Pivot a run-action `list` grid (columns + rows) into a rowField × colField
 * matrix, aggregating `aggColumn` with `aggFn` (count ignores aggColumn). Pure —
 * no backend. Powers the Workshop Pivot widget over REAL Synapse rows.
 */
export function pivotShape(
  columns: string[], rows: unknown[][],
  rowField: string, colField: string, aggFn: WorkshopAggFn, aggColumn?: string,
): PivotResult {
  const ri = columns.indexOf(rowField);
  const ci = columns.indexOf(colField);
  const ai = aggColumn ? columns.indexOf(aggColumn) : -1;
  const empty: PivotResult = { rowKeys: [], colKeys: [], cells: {}, rowTotals: {} };
  if (ri < 0 || ci < 0) return empty;

  const rowKeySet: string[] = [];
  const colKeySet: string[] = [];
  const bucket: Record<string, Record<string, number[]>> = {};
  const bucketCount: Record<string, Record<string, number>> = {};

  for (const r of rows || []) {
    const rk = r[ri] === null || r[ri] === undefined ? '' : String(r[ri]);
    const ck = r[ci] === null || r[ci] === undefined ? '' : String(r[ci]);
    if (!rowKeySet.includes(rk)) rowKeySet.push(rk);
    if (!colKeySet.includes(ck)) colKeySet.push(ck);
    bucket[rk] ??= {}; bucketCount[rk] ??= {};
    bucket[rk][ck] ??= []; bucketCount[rk][ck] ??= 0;
    bucketCount[rk][ck]++;
    if (ai >= 0) { const n = Number(r[ai]); if (Number.isFinite(n)) bucket[rk][ck].push(n); }
  }

  rowKeySet.sort(); colKeySet.sort();
  const cells: Record<string, Record<string, number>> = {};
  const rowTotals: Record<string, number> = {};
  for (const rk of rowKeySet) {
    cells[rk] = {};
    const rowVals: number[] = []; let rowCount = 0;
    for (const ck of colKeySet) {
      const vals = bucket[rk]?.[ck] || [];
      const cnt = bucketCount[rk]?.[ck] || 0;
      cells[rk][ck] = aggregate(aggFn, vals, cnt);
      rowVals.push(...vals); rowCount += cnt;
    }
    rowTotals[rk] = aggregate(aggFn, rowVals, rowCount);
  }
  return { rowKeys: rowKeySet, colKeys: colKeySet, cells, rowTotals };
}

export interface TimelineEvent {
  /** Sort key — parsed epoch ms. */
  ms: number;
  /** Raw time cell (as displayed). */
  time: string;
  /** Event label (from labelColumn, else the row's first non-time cell). */
  label: string;
}

/** Parse a cell into epoch ms (ISO string, epoch number, or Date). Pure, dependency-free. */
function toMs(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  // Bare epoch (seconds or ms)?
  if (/^\d{10,13}$/.test(s)) { const n = Number(s); return s.length <= 10 ? n * 1000 : n; }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Shape a run-action `list` grid into a time-ordered event list for the Workshop
 * Timeline widget. Rows without a parseable time cell are dropped (honest — the
 * widget shows an empty state rather than a fake timeline). Pure.
 */
export function timelineShape(
  columns: string[], rows: unknown[][], timeColumn: string, labelColumn?: string,
): TimelineEvent[] {
  const ti = columns.indexOf(timeColumn);
  if (ti < 0) return [];
  const li = labelColumn ? columns.indexOf(labelColumn) : -1;
  const out: TimelineEvent[] = [];
  for (const r of rows || []) {
    const ms = toMs(r[ti]);
    if (ms === null) continue;
    const time = r[ti] === null || r[ti] === undefined ? '' : String(r[ti]);
    let label: string;
    if (li >= 0) label = r[li] === null || r[li] === undefined ? '' : String(r[li]);
    else {
      const other = columns.findIndex((_, i) => i !== ti);
      label = other >= 0 && r[other] !== null && r[other] !== undefined ? String(r[other]) : time;
    }
    out.push({ ms, time, label });
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}
