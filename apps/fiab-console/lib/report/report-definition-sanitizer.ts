/**
 * Pure, side-effect-free validation + sanitization helpers for the report
 * definition PUT route (app/api/items/report/[id]/definition/route.ts).
 *
 * Extracted VERBATIM from that route in a behavior-preserving refactor: the
 * const whitelists (VISUAL_TYPES / AGGS / FILTER_OPS / ...), the MAX_ size
 * clamps, and the whole sanitize / clamp / num helper family. No request/network/db
 * access — these only shape + bound the designer payload before it is
 * persisted to the report item's state.content. Logic, clamp bounds, and Set
 * members are unchanged; only the module boundary moved.
 */

import type { ReportContent } from '@/lib/apps/content-bundles/types';
import { escapeSqlLiteral } from '@/lib/sql/quoting';

/**
 * Visual types the renderer + DAX/SQL synthesizer support. The first 11 are the
 * shipped vocabulary; the rest are the wave-1 Power BI-parity additions. New
 * visuals fold their extra wells into the existing category/values/legend arrays
 * the /query route already compiles (secondary-values/target/min/max/tooltips →
 * extra value aggregates; small-multiples → an extra group column), so each
 * returns REAL aggregated rows with no new backend route.
 */
const VISUAL_TYPES = new Set([
  'table', 'matrix', 'card', 'bar', 'column', 'line', 'area', 'pie', 'donut', 'scatter', 'slicer',
  // ── wave-1 visual gallery additions ────────────────────────────────────────
  'combo', 'ribbon', 'waterfall', 'funnel', 'gauge', 'kpi', 'treemap', 'multiRowCard',
  // ── wave-2 visual gallery additions ────────────────────────────────────────
  // `bubble` is scatter + a third (size) measure; `map` renders an HONEST
  // Azure-Maps gate client-side (no dead control) — both still round-trip here
  // and fold their plotted wells into the existing /query category/values arrays.
  'map', 'bubble',
  // ── wave-3 AI visual gallery additions ──────────────────────────────────────
  // The designer's AI visuals (report-designer.tsx AI_TYPES) MUST be whitelisted
  // here or `buildDefinitionBody`'s `visualType: v.type` gets coerced to 'table'
  // (line below), silently destroying a saved Smart narrative / Q&A /
  // Decomposition tree / Key influencers on reload (reportPagesFromContent →
  // v.type). `smartNarrative`/`qna` drive the REAL AOAI orchestrator;
  // `decompositionTree`/`keyInfluencers` run REAL /query SQL over their wells.
  // Round-tripping the type is SAFE for the other readers: the read-only viewer
  // and PBIR provisioner ignore unknown types, and the loom-native renderer
  // already falls back to a table for any type it doesn't recognize.
  'smartNarrative', 'qna', 'decompositionTree', 'keyInfluencers',
  // ── wave-4 script visual ────────────────────────────────────────────────────
  // The R / Python script visual. Like the wave-3 AI types above, it MUST be
  // whitelisted here or `buildDefinitionBody`'s `visualType: 'scriptVisual'` is
  // coerced to 'table' (line below) — and the designer's read path keys the
  // saved script config on `v.type === 'scriptVisual'`, so a coerced type would
  // SILENTLY drop the persisted language + script on reload (no-vaporware:
  // persistence must be real). Round-tripping the type is SAFE for the other
  // readers: the read-only viewer + PBIR provisioner ignore unknown types, and
  // the loom-native renderer falls back to a table for any type it doesn't know.
  'scriptVisual',
]);
const AGGS = new Set(['Sum', 'Avg', 'Count', 'Min', 'Max', 'None']);

/**
 * Additive wave-1 field wells (beyond the base category/values/legend). Persisted
 * under `config.wells.<name>` ONLY when non-empty, so legacy readers (viewer /
 * PBIR provisioner) and pre-wave bundles are unaffected. The designer's
 * queryVisual() folds these into the base arrays before hitting /query, so the
 * SQL/DAX compilers need no change; they ride along here purely for round-trip.
 */
const EXTRA_WELL_NAMES = [
  'secondaryValues', 'target', 'minimum', 'maximum', 'smallMultiples', 'tooltips', 'details',
  // ── wave-2 additive wells ──────────────────────────────────────────────────
  // `size` → bubble radius (scatter 3rd measure); `playAxis` → animation frame
  // category; `latitude`/`longitude` → map location. Each is persisted only when
  // non-empty; queryVisual() folds the PLOTTED ones (size/lat/long as value or
  // category aggregates) so the SQL/DAX compilers still need no change.
  'size', 'playAxis', 'latitude', 'longitude',
] as const;

// ── structured-extras whitelists (no-freeform-config.md) ──────────────────────

/**
 * Structured filter operators — mirror `FilterOp` in the report designer's
 * Filters pane. The first nine are the basic/advanced comparisons; `topN` and
 * `relativeDate` are the wave-1 PBI filter TYPES.
 */
type FilterOp =
  | 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'in' | 'contains' | 'between'
  | 'topN' | 'relativeDate';
const FILTER_OPS = new Set<FilterOp>([
  'eq', 'ne', 'gt', 'ge', 'lt', 'le', 'in', 'contains', 'between', 'topN', 'relativeDate',
]);

/** Top N direction / relative-date window enums (Filters pane). */
type TopDir = 'top' | 'bottom';
type RelDir = 'last' | 'next';
type RelUnit = 'days' | 'months' | 'years' | 'minutes' | 'hours';
const REL_UNITS = new Set<RelUnit>(['days', 'months', 'years', 'minutes', 'hours']);

/** Format-pane scalar enums — mirror `LegendPosition` / `NumberFormatPreset`. */
type LegendPosition = 'top' | 'bottom' | 'left' | 'right';
type NumberFormatPreset = 'general' | 'whole' | 'decimal' | 'percent' | 'currency' | 'thousands';
const LEGEND_POSITIONS = new Set<LegendPosition>(['top', 'bottom', 'left', 'right']);
const NUMBER_FORMATS = new Set<NumberFormatPreset>([
  'general', 'whole', 'decimal', 'percent', 'currency', 'thousands',
]);

/** Format-pane wave-1 enums — mirror format-pane.tsx. */
type DataLabelPosition = 'auto' | 'inside' | 'outside' | 'above' | 'below';
type StylePreset = 'default' | 'minimal' | 'bold' | 'condensed' | 'accent';
const DATA_LABEL_POSITIONS = new Set<DataLabelPosition>(['auto', 'inside', 'outside', 'above', 'below']);
const STYLE_PRESETS = new Set<StylePreset>(['default', 'minimal', 'bold', 'condensed', 'accent']);

/** Conditional-formatting enums — mirror conditional-format.tsx. */
type CondMode = 'rules' | 'colorScale' | 'dataBars' | 'icons';
type CondOp = 'gt' | 'ge' | 'lt' | 'le' | 'eq' | 'ne' | 'between';
type CondIconSet = 'arrows' | 'triangles' | 'trafficLights' | 'ratings' | 'flags';
type CondApplyTo = 'background' | 'text';
const COND_OPS = new Set<CondOp>(['gt', 'ge', 'lt', 'le', 'eq', 'ne', 'between']);
const COND_ICON_SETS = new Set<CondIconSet>(['arrows', 'triangles', 'trafficLights', 'ratings', 'flags']);

/** Analytics reference-line enums — mirror analytics-pane.tsx. */
type AnalyticsLineKind = 'trend' | 'constant' | 'min' | 'max' | 'average' | 'median' | 'percentile';
type AnalyticsLineStyle = 'solid' | 'dashed' | 'dotted';
const ANALYTICS_KINDS = new Set<AnalyticsLineKind>([
  'trend', 'constant', 'min', 'max', 'average', 'median', 'percentile',
]);
const ANALYTICS_STYLES = new Set<AnalyticsLineStyle>(['solid', 'dashed', 'dotted']);

/**
 * Wave-2 analytics enums — mirror analytics-pane.tsx. Error-bar `mode` selects
 * how the +/- bounds are sourced: from explicit upper/lower FIELDS, a PERCENT of
 * the measure, or a constant VALUE. Forecast + symmetry-shading carry no enum of
 * their own (numeric/boolean only).
 */
type ErrorBarMode = 'field' | 'percent' | 'value';
const ERROR_BAR_MODES = new Set<ErrorBarMode>(['field', 'percent', 'value']);

/** Page canvas type / interaction mode enums — mirror the page-options + interactions panes. */
type CanvasType = '16:9' | '4:3' | 'letter' | 'tooltip' | 'custom';
type InteractionMode = 'filter' | 'highlight' | 'none';
const CANVAS_TYPES = new Set<CanvasType>(['16:9', '4:3', 'letter', 'tooltip', 'custom']);
const INTERACTION_MODES = new Set<InteractionMode>(['filter', 'highlight', 'none']);

/** Bookmark capture scope — mirror bookmarks-pane.tsx. */
type BookmarkScope = 'allPages' | 'selectedVisuals';
const BOOKMARK_SCOPES = new Set<BookmarkScope>(['allPages', 'selectedVisuals']);

// Light clamps so a hostile/oversized payload can't bloat the Cosmos item.
const MAX_STR = 2000;          // filter value / title text
const MAX_VALUES = 1000;       // `in` set size
const MAX_FILTERS = 200;       // filters per scope
const MAX_COLORS = 32;         // data-color swatches
const MAX_COLOR_STR = 64;      // single swatch / color-token string length
const MAX_WELL_FIELDS = 64;    // fields per well
const MAX_COND_RULES = 64;     // conditional-format rules per visual
const MAX_COND_THRESH = 64;    // thresholds per rules-mode rule
const MAX_ANALYTICS_LINES = 64; // reference lines per visual
const MAX_INTERACTION_KEYS = 500; // source / target entries in the matrix
const MAX_KEY_STR = 200;       // visual-id key length in the matrix
// ── wave-2 clamps ─────────────────────────────────────────────────────────────
const MAX_DRILLTHROUGH_FIELDS = 16;  // fields in a page's drillthrough well
const MAX_BOOKMARKS = 64;            // bookmarks per report
const MAX_BOOKMARK_PAGES = 200;      // pageId-keyed filter buckets in a bookmark
const MAX_OBJECT_KEYS = 1000;        // selection / visibility / z-order map size
const MAX_GROUP_STR = 200;           // groupId length (Selection-pane group)
// ── wave-4 clamp ──────────────────────────────────────────────────────────────
const MAX_SCRIPT = 200_000;          // script-visual code body (mirrors the runner's 200 KB cap)

/** A single structured filter, post-`wireFilters` (no client-only id). */
interface PersistedFilter {
  table?: string;
  column?: string;
  measure?: string;
  op: FilterOp;
  value?: string;
  value2?: string;
  values?: string[];
  // ── Top N (op === 'topN') ──
  topNType?: TopDir;
  topN?: number;
  byMeasure?: string;
  byTable?: string;
  byColumn?: string;
  // ── Relative date (op === 'relativeDate') ──
  relDir?: RelDir;
  relN?: number;
  relUnit?: RelUnit;
  // ── card affordances (any op) ──
  locked?: boolean;
  hidden?: boolean;
  // ── Wave-8 card affordances (any op) ──
  displayName?: string;
  exclude?: boolean;
}

/** A conditional-format by-value threshold (mode==='rules'). */
interface PersistedCondThreshold {
  op: CondOp;
  value: number;
  value2?: number;
  color?: string;
}
/** One conditional-format rule bound to a single field. */
interface PersistedCondRule {
  field: { table?: string; column?: string; measure?: string };
  mode: CondMode;
  rules?: PersistedCondThreshold[];
  colorScale?: { min?: string; mid?: string; max?: string };
  dataBars?: { positive?: string; negative?: string };
  icons?: CondIconSet;
  applyTo?: CondApplyTo;
}
interface PersistedConditionalFormat { rules: PersistedCondRule[] }

/** Structured, fully-optional per-visual format (mirror of ReportVisualFormat). */
interface PersistedFormat {
  titleText?: string;
  showTitle?: boolean;
  dataColors?: string[];
  showXAxis?: boolean;
  showYAxis?: boolean;
  showLegend?: boolean;
  legendPosition?: LegendPosition;
  numberFormat?: NumberFormatPreset;
  // ── wave-1 additions (all optional/sparse) ──
  dataLabels?: { show?: boolean; position?: DataLabelPosition };
  totalLabels?: { show?: boolean };
  background?: { color?: string; transparency?: number };
  border?: { show?: boolean; color?: string; radius?: number };
  shadow?: { show?: boolean };
  plotArea?: { transparency?: number };
  general?: { width?: number; height?: number; lockAspect?: boolean; altText?: string };
  stylePreset?: StylePreset;
  conditionalFormat?: PersistedConditionalFormat;
}

/** One structured analytics reference line (mirror of AnalyticsLine). */
interface PersistedAnalyticsLine {
  id?: string;
  kind: AnalyticsLineKind;
  measure?: string;
  value?: number;
  percentile?: number;
  color?: string;
  style?: AnalyticsLineStyle;
  label?: string;
  showLabel?: boolean;
}
/**
 * Wave-2 analytics members. Error bars draw +/- bounds per plotted point; the
 * client computes them over the SAME `/query` result series (field → from two
 * extra value wells, percent → ±n% of the measure, value → a constant ±). A
 * forecast extends the series with Loom-native exponential smoothing (no model
 * round-trip). Symmetry shading tints above/below the y=x line on a scatter.
 */
interface PersistedErrorBar {
  id?: string;
  mode: ErrorBarMode;
  measure?: string;
  upperField?: string;
  lowerField?: string;
  percent?: number;
  value?: number;
  color?: string;
}
interface PersistedForecast {
  periods?: number;
  seasonality?: number;
  confidence?: number;
}
interface PersistedSymmetry {
  enabled: boolean;
  color?: string;
}
interface PersistedAnalytics {
  lines: PersistedAnalyticsLine[];
  errorBars?: PersistedErrorBar[];
  forecast?: PersistedForecast;
  symmetry?: PersistedSymmetry;
}

/** A bare field reference (column or measure) — drillthrough / tooltip binding. */
interface PersistedFieldRef { table?: string; column?: string; measure?: string }

/** Per-page canvas config (mirror of the page-options + interactions panes). */
interface PersistedPageConfig {
  type?: CanvasType;
  size?: { width?: number; height?: number };
  background?: { color?: string; transparency?: number };
  hidden?: boolean;
  interactions?: Record<string, Record<string, InteractionMode>>;
  // ── wave-2 (additive) ──
  // A page declaring `drillthrough.fields` is a drillthrough TARGET: any visual
  // elsewhere carrying one of those fields exposes a right-click → Drillthrough
  // to it, opening this page filtered to the clicked value (+ an auto Back btn).
  drillthrough?: { fields: PersistedFieldRef[] };
  // A `tooltipPage.enabled` page (with canvasType 'tooltip') is shown in a
  // popover when hovering a mark whose category == `boundField`.
  tooltipPage?: { enabled: boolean; boundField?: PersistedFieldRef };
}

/** One captured bookmark (mirror of bookmarks-pane.tsx ReportBookmark). */
interface PersistedBookmark {
  id?: string;
  name: string;
  scope: BookmarkScope;
  apply: { data: boolean; display: boolean; currentPage: boolean };
  state: {
    activePageId?: string;
    pageFilters?: Record<string, PersistedFilter[]>;
    reportFilters?: PersistedFilter[];
    selection?: string[];
    visibility?: Record<string, boolean>;
    zOrder?: Record<string, number>;
  };
}

/** Report-level Filters-pane format — a faithful MIRROR of filters-pane.tsx's
 *  `FilterPaneFormat` (Loom swatch color tokens + the pane-title color/show), so
 *  the pane styling the designer authors round-trips through /definition intact
 *  (the read path re-hydrates it with the same `parseFilterPaneFormat`). */
interface PersistedFilterPaneFormat {
  background?: string;
  border?: string;
  title?: { color?: string; show?: boolean };
  headerColor?: string;
  inputColor?: string;
}

/**
 * Report-level THEME (wave-3) — a faithful, STRUCTURED mirror of the Loom theme
 * model (themes.ts) AND the import/export-compatible subset of a Power BI theme
 * JSON (grounded in Learn `report-themes-create-custom`): a name, the series
 * `dataColors` palette, the structural element colors (foreground / tableAccent
 * / first..fourth-level elements / backgrounds), a Loom accent, and a single
 * whitelisted `fontFamily` (the import maps `textClasses.*.fontFamily` → here).
 *
 * Persisted ADDITIVELY on `content.theme` exactly like `bookmarks` /
 * `filterPaneFormat`: the Loom-native renderer reads it to repaint the whole
 * palette + typography + background of every visual (LoomChart `palette` /
 * `fontFamily` / `foreground` props), while the read-only viewer and the PBIR
 * provisioner simply ignore an unknown `content.theme`.
 */
interface PersistedReportTheme {
  name: string;
  /** Built-in Loom theme id when a preset is selected (else a custom theme). */
  builtinId?: string;
  /** Series / data palette — hex or Loom color token, applied to ALL visuals. */
  dataColors?: string[];
  // ── structural / Power BI-compatible element colors (each clamped) ──
  background?: string;
  secondaryBackground?: string;
  foreground?: string;
  tableAccent?: string;
  firstLevelElements?: string;
  secondLevelElements?: string;
  thirdLevelElements?: string;
  fourthLevelElements?: string;
  /** Loom accent color (brand-foreground restyle). */
  accent?: string;
  /** Whitelisted typography family applied report-wide. */
  fontFamily?: string;
}

/**
 * Extended persisted content. ADDITIVE over {@link ReportContent}: pages gain an
 * optional `filters` + `config`, and the report gains a top-level `reportFilters`.
 * The visual `config` (typed `any` in ReportContent) carries `wells` / `layout` /
 * `format` / `analytics` / `filters`. Anything reading the base `ReportContent`
 * shape (read-only viewer, PBIR provisioner) simply ignores the extra keys.
 *
 * `reportFilters` is fully overridden (not narrowed) so the wave-1 `topN` /
 * `relativeDate` operators don't conflict with the base 9-operator type.
 */
type PersistedVisual = ReportContent['pages'][number]['visuals'][number];
interface PersistedPage {
  name: string;
  visuals: PersistedVisual[];
  filters?: PersistedFilter[];
  config?: PersistedPageConfig;
  // ── wave-7 free-form canvas elements (additive; viewer + PBIR provisioner
  // ignore `page.elements`, exactly like `page.config`). Each element's
  // `layout.z` shares the SAME integer z-space as a visual's `layout.z`, so
  // paint order interleaves elements and visuals (PBI parity). ──
  elements?: PersistedElement[];
}
interface ReportContentV2 extends Omit<ReportContent, 'pages' | 'reportFilters'> {
  pages: PersistedPage[];
  reportFilters?: PersistedFilter[];
  // ── wave-2 report-level state (additive; viewer + PBIR provisioner ignore) ──
  bookmarks?: PersistedBookmark[];
  filterPaneFormat?: PersistedFilterPaneFormat;
  // ── wave-3 report-level state (additive; viewer + PBIR provisioner ignore) ──
  theme?: PersistedReportTheme;
  // ── wave-8 report-level interactivity state (additive; ignored by viewer/PBIR) ──
  /** Sync-slicers groups (per-page Visible/Synced matrix). */
  syncSlicers?: PersistedSyncGroup[];
  /** Author-defined field parameters (switch-slicer field swaps). */
  fieldParameters?: PersistedFieldParameter[];
  /** Numeric-range what-if parameters (value bound into the visual SQL). */
  whatIfParams?: PersistedWhatIfParam[];
  /** WAVE-9 report settings (additive; viewer/PBIR ignore). */
  settings?: PersistedReportSettings;
}

// ── wave-8 report-level interactivity shapes (structured, whitelisted) ────────
interface PersistedSyncMember { pageId: string; visible?: boolean; synced?: boolean }
interface PersistedSyncGroup { id: string; fieldKey: string; members: PersistedSyncMember[] }
interface PersistedFieldParamField { label: string; table?: string; column?: string; measure?: string }
interface PersistedFieldParameter { id: string; name: string; fields: PersistedFieldParamField[]; activeIndex?: number }
interface PersistedWhatIfParam {
  id: string; name: string; min: number; max: number; increment: number; value: number;
  apply?: 'multiply' | 'add'; targetAlias?: string;
}

// ── wave-9 report-level settings shape (structured, whitelisted) ──────────────
interface PersistedReportSettings {
  refreshIntervalSec?: number;
  persistFilters?: boolean;
  allowExport?: boolean;
  visualHeaders?: boolean;
  crossReportDrillthrough?: boolean;
}

/**
 * WAVE-9: sanitize the report-settings bag. Clamp refreshIntervalSec to an
 * integer in [0, 86400]; coerce every other field to a strict boolean. Returns
 * undefined when nothing valid is present so the persisted content stays lean
 * and the read-only viewer / PBIR provisioner can keep ignoring it.
 */
function sanitizeReportSettings(raw: unknown): PersistedReportSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: PersistedReportSettings = {};
  if (r.refreshIntervalSec !== undefined && r.refreshIntervalSec !== null) {
    const n = Math.round(Number(r.refreshIntervalSec));
    if (Number.isFinite(n)) out.refreshIntervalSec = Math.min(86400, Math.max(0, n));
  }
  if (typeof r.persistFilters === 'boolean') out.persistFilters = r.persistFilters;
  if (typeof r.allowExport === 'boolean') out.allowExport = r.allowExport;
  if (typeof r.visualHeaders === 'boolean') out.visualHeaders = r.visualHeaders;
  if (typeof r.crossReportDrillthrough === 'boolean') out.crossReportDrillthrough = r.crossReportDrillthrough;
  return Object.keys(out).length ? out : undefined;
}

interface WellFieldIn {
  table?: unknown;
  column?: unknown;
  measure?: unknown;
  aggregation?: unknown;
}
interface VisualIn {
  visualType?: unknown;
  type?: unknown;
  title?: unknown;
  wells?: Record<string, unknown>;
  layout?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown; z?: unknown; unit?: unknown };
  format?: unknown;
  analytics?: unknown;
  filters?: unknown;
  // ── wave-2 Selection-pane / canvas flags (additive) ──
  hidden?: unknown;
  locked?: unknown;
  groupId?: unknown;
  // ── wave-4 script-visual config (additive; only set for type 'scriptVisual') ──
  language?: unknown;
  script?: unknown;
}
interface PageIn {
  name?: unknown;
  visuals?: unknown;
  filters?: unknown;
  config?: unknown;
  // ── wave-7 free-form canvas elements (additive; only set when authored) ──
  elements?: unknown;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampStr(v: unknown, max = MAX_STR): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

/** Clamp a finite number into [min,max] (or undefined when not a real number). */
function clampNum(v: unknown, min: number, max: number): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/** Clamp a 0–100 percentage to an integer (or undefined). */
function clampPct(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** Clamp a positive integer into [1,max] (or undefined). */
function clampPosInt(v: unknown, max: number): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const i = Math.floor(n);
  return i >= 1 ? Math.min(max, i) : undefined;
}

/** Clamp a data-color swatch / token to a non-empty, length-bounded string. */
function clampColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, MAX_COLOR_STR) : null;
}

function sanitizeWellField(raw: WellFieldIn): {
  table?: string; column?: string; measure?: string;
  aggregation?: 'Sum' | 'Avg' | 'Count' | 'Min' | 'Max' | 'None';
} | null {
  const table = typeof raw.table === 'string' ? raw.table.trim() : undefined;
  const column = typeof raw.column === 'string' ? raw.column.trim() : undefined;
  const measure = typeof raw.measure === 'string' ? raw.measure.trim() : undefined;
  if (!column && !measure) return null; // a well field must reference something
  const aggRaw = typeof raw.aggregation === 'string' ? raw.aggregation : undefined;
  const aggregation = aggRaw && AGGS.has(aggRaw) ? (aggRaw as any) : undefined;
  return {
    ...(table ? { table } : {}),
    ...(column ? { column } : {}),
    ...(measure ? { measure } : {}),
    ...(aggregation ? { aggregation } : {}),
  };
}

function sanitizeWellList(raw: unknown): Array<ReturnType<typeof sanitizeWellField>> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => sanitizeWellField((r || {}) as WellFieldIn))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .slice(0, MAX_WELL_FIELDS);
}

/**
 * Sanitize one structured filter. Drops the filter (returns null) unless it
 * references a column or measure AND carries a whitelisted operator — so no
 * free-form/unknown operator or fieldless filter is ever persisted. The wave-1
 * Top-N / relative-date / lock / hide fields are persisted additively (Top-N
 * fields only for `topN`, window fields only for `relativeDate`).
 */
function sanitizeFilter(raw: unknown): PersistedFilter | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const op = typeof o.op === 'string' ? o.op : '';
  if (!FILTER_OPS.has(op as FilterOp)) return null;
  const table = typeof o.table === 'string' ? o.table.trim() : undefined;
  const column = typeof o.column === 'string' ? o.column.trim() : undefined;
  const measure = typeof o.measure === 'string' ? o.measure.trim() : undefined;
  if (!column && !measure) return null; // a filter must reference a field
  const value = clampStr(o.value);
  const value2 = clampStr(o.value2);
  const values = Array.isArray(o.values)
    ? o.values
        .filter((v) => v !== null && v !== undefined)
        .map((v) => String(v).slice(0, MAX_STR))
        .slice(0, MAX_VALUES)
    : undefined;

  const out: PersistedFilter = {
    op: op as FilterOp,
    ...(table ? { table } : {}),
    ...(column ? { column } : {}),
    ...(measure ? { measure } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(value2 !== undefined ? { value2 } : {}),
    ...(values && values.length ? { values } : {}),
  };

  if (op === 'topN') {
    if (o.topNType === 'bottom') out.topNType = 'bottom';
    else if (o.topNType === 'top') out.topNType = 'top';
    const topN = clampPosInt(o.topN, 1_000_000);
    if (topN !== undefined) out.topN = topN;
    const byMeasure = typeof o.byMeasure === 'string' ? o.byMeasure.trim() : undefined;
    const byTable = typeof o.byTable === 'string' ? o.byTable.trim() : undefined;
    const byColumn = typeof o.byColumn === 'string' ? o.byColumn.trim() : undefined;
    if (byMeasure) out.byMeasure = byMeasure;
    if (byTable) out.byTable = byTable;
    if (byColumn) out.byColumn = byColumn;
  }
  if (op === 'relativeDate') {
    if (o.relDir === 'next') out.relDir = 'next';
    else if (o.relDir === 'last') out.relDir = 'last';
    const relN = clampPosInt(o.relN, 1_000_000);
    if (relN !== undefined) out.relN = relN;
    if (typeof o.relUnit === 'string' && REL_UNITS.has(o.relUnit as RelUnit)) out.relUnit = o.relUnit as RelUnit;
  }
  if (o.locked === true) out.locked = true;
  if (o.hidden === true) out.hidden = true;
  // Wave-8 (any op): per-card rename + exclude (invert predicate).
  const displayName = typeof o.displayName === 'string' ? o.displayName.slice(0, MAX_STR).trim() : undefined;
  if (displayName) out.displayName = displayName;
  if (o.exclude === true) out.exclude = true;

  return out;
}

function sanitizeFilterList(raw: unknown): PersistedFilter[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(sanitizeFilter)
    .filter((x): x is PersistedFilter => !!x)
    .slice(0, MAX_FILTERS);
}

// ── format-pane nested effect groups (sparse, whitelisted) ────────────────────

function sanitizeShow(raw: unknown): { show?: boolean } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  return typeof o.show === 'boolean' ? { show: o.show } : undefined;
}
function sanitizeDataLabels(raw: unknown): { show?: boolean; position?: DataLabelPosition } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: { show?: boolean; position?: DataLabelPosition } = {};
  if (typeof o.show === 'boolean') out.show = o.show;
  if (typeof o.position === 'string' && DATA_LABEL_POSITIONS.has(o.position as DataLabelPosition)) {
    out.position = o.position as DataLabelPosition;
  }
  return Object.keys(out).length ? out : undefined;
}
function sanitizeFill(raw: unknown): { color?: string; transparency?: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: { color?: string; transparency?: number } = {};
  const color = clampColor(o.color);
  if (color) out.color = color;
  const t = clampPct(o.transparency);
  if (t !== undefined) out.transparency = t;
  return Object.keys(out).length ? out : undefined;
}
function sanitizeTransparency(raw: unknown): { transparency?: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = clampPct((raw as Record<string, unknown>).transparency);
  return t !== undefined ? { transparency: t } : undefined;
}
function sanitizeBorder(raw: unknown): { show?: boolean; color?: string; radius?: number } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: { show?: boolean; color?: string; radius?: number } = {};
  if (typeof o.show === 'boolean') out.show = o.show;
  const color = clampColor(o.color);
  if (color) out.color = color;
  const radius = clampNum(o.radius, 0, 200);
  if (radius !== undefined) out.radius = Math.round(radius);
  return Object.keys(out).length ? out : undefined;
}
function sanitizeGeneral(raw: unknown): { width?: number; height?: number; lockAspect?: boolean; altText?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: { width?: number; height?: number; lockAspect?: boolean; altText?: string } = {};
  const w = clampNum(o.width, 1, 20_000);
  if (w !== undefined) out.width = Math.round(w);
  const h = clampNum(o.height, 1, 20_000);
  if (h !== undefined) out.height = Math.round(h);
  if (typeof o.lockAspect === 'boolean') out.lockAspect = o.lockAspect;
  const alt = clampStr(o.altText, 1000);
  if (alt !== undefined) out.altText = alt;
  return Object.keys(out).length ? out : undefined;
}

/**
 * Sanitize the structured conditional-formatting model (mode/op enums whitelisted,
 * colors clamped, numbers coerced). Mirrors conditional-format.tsx's
 * `parseConditionalFormat`; a rule without a bound field or a valid mode is
 * dropped. Returns undefined when nothing valid survives.
 */
function sanitizeConditionalFormat(raw: unknown): PersistedConditionalFormat | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rawRules = (raw as Record<string, unknown>).rules;
  if (!Array.isArray(rawRules)) return undefined;
  const rules: PersistedCondRule[] = [];
  for (const r of rawRules.slice(0, MAX_COND_RULES)) {
    const o = (r || {}) as Record<string, unknown>;
    const mode = o.mode;
    if (mode !== 'rules' && mode !== 'colorScale' && mode !== 'dataBars' && mode !== 'icons') continue;
    const f = (o.field || {}) as Record<string, unknown>;
    const table = typeof f.table === 'string' ? f.table.trim() : undefined;
    const column = typeof f.column === 'string' ? f.column.trim() : undefined;
    const measure = typeof f.measure === 'string' ? f.measure.trim() : undefined;
    if (!column && !measure) continue; // a rule must bind a field
    const rule: PersistedCondRule = {
      field: { ...(table ? { table } : {}), ...(column ? { column } : {}), ...(measure ? { measure } : {}) },
      mode: mode as CondMode,
      applyTo: o.applyTo === 'text' ? 'text' : 'background',
    };
    if (mode === 'rules') {
      rule.rules = Array.isArray(o.rules)
        ? o.rules
            .slice(0, MAX_COND_THRESH)
            .map((t): PersistedCondThreshold | null => {
              const to = (t || {}) as Record<string, unknown>;
              if (typeof to.op !== 'string' || !COND_OPS.has(to.op as CondOp)) return null;
              const th: PersistedCondThreshold = { op: to.op as CondOp, value: Number(to.value) || 0 };
              if (to.value2 != null && Number.isFinite(Number(to.value2))) th.value2 = Number(to.value2);
              const color = clampColor(to.color);
              if (color) th.color = color;
              return th;
            })
            .filter((x): x is PersistedCondThreshold => !!x)
        : [];
    } else if (mode === 'colorScale') {
      const cs = (o.colorScale || {}) as Record<string, unknown>;
      const out: { min?: string; mid?: string; max?: string } = {};
      const min = clampColor(cs.min);
      if (min) out.min = min;
      const mid = clampColor(cs.mid);
      if (mid) out.mid = mid;
      const max = clampColor(cs.max);
      if (max) out.max = max;
      rule.colorScale = out;
    } else if (mode === 'dataBars') {
      const db = (o.dataBars || {}) as Record<string, unknown>;
      const out: { positive?: string; negative?: string } = {};
      const positive = clampColor(db.positive);
      if (positive) out.positive = positive;
      const negative = clampColor(db.negative);
      if (negative) out.negative = negative;
      rule.dataBars = out;
    } else {
      rule.icons = typeof o.icons === 'string' && COND_ICON_SETS.has(o.icons as CondIconSet)
        ? (o.icons as CondIconSet)
        : 'arrows';
    }
    rules.push(rule);
  }
  return rules.length ? { rules } : undefined;
}

/**
 * Sanitize the per-visual FORMAT into a SPARSE, whitelisted shape — only keys the
 * author actually touched survive (so defaults stay implicit). Returns undefined
 * when nothing valid was supplied, so an empty format is never persisted.
 */
function sanitizeFormat(raw: unknown): PersistedFormat | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: PersistedFormat = {};

  const titleText = clampStr(o.titleText, 200);
  if (titleText !== undefined) out.titleText = titleText;
  if (typeof o.showTitle === 'boolean') out.showTitle = o.showTitle;
  if (Array.isArray(o.dataColors)) {
    const colors = o.dataColors
      .map(clampColor)
      .filter((c): c is string => !!c)
      .slice(0, MAX_COLORS);
    if (colors.length) out.dataColors = colors;
  }
  if (typeof o.showXAxis === 'boolean') out.showXAxis = o.showXAxis;
  if (typeof o.showYAxis === 'boolean') out.showYAxis = o.showYAxis;
  if (typeof o.showLegend === 'boolean') out.showLegend = o.showLegend;
  if (typeof o.legendPosition === 'string' && LEGEND_POSITIONS.has(o.legendPosition as LegendPosition)) {
    out.legendPosition = o.legendPosition as LegendPosition;
  }
  if (typeof o.numberFormat === 'string' && NUMBER_FORMATS.has(o.numberFormat as NumberFormatPreset)) {
    out.numberFormat = o.numberFormat as NumberFormatPreset;
  }

  // ── wave-1 nested effect groups (sparse) ──
  const dataLabels = sanitizeDataLabels(o.dataLabels);
  if (dataLabels) out.dataLabels = dataLabels;
  const totalLabels = sanitizeShow(o.totalLabels);
  if (totalLabels) out.totalLabels = totalLabels;
  const background = sanitizeFill(o.background);
  if (background) out.background = background;
  const border = sanitizeBorder(o.border);
  if (border) out.border = border;
  const shadow = sanitizeShow(o.shadow);
  if (shadow) out.shadow = shadow;
  const plotArea = sanitizeTransparency(o.plotArea);
  if (plotArea) out.plotArea = plotArea;
  const general = sanitizeGeneral(o.general);
  if (general) out.general = general;
  if (typeof o.stylePreset === 'string' && STYLE_PRESETS.has(o.stylePreset as StylePreset)) {
    out.stylePreset = o.stylePreset as StylePreset;
  }
  const cf = sanitizeConditionalFormat(o.conditionalFormat);
  if (cf) out.conditionalFormat = cf;

  return Object.keys(out).length ? out : undefined;
}

/**
 * Sanitize the per-visual ANALYTICS members. Reference LINES (kind/style enums
 * whitelisted, value/percentile clamped) mirror analytics-pane.tsx's
 * `parseAnalytics`; wave-2 adds ERROR BARS (mode enum, measure/fields + percent/
 * value clamped), a FORECAST (periods 1..60, seasonality 0..366, confidence %),
 * and SYMMETRY shading ({enabled,color}). Returns undefined only when nothing
 * valid survives across ALL members (so forecast-only / error-bar-only is kept).
 */
function sanitizeAnalytics(raw: unknown): PersistedAnalytics | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const root = raw as Record<string, unknown>;
  const lines: PersistedAnalyticsLine[] = [];
  if (Array.isArray(root.lines)) {
    for (const r of root.lines.slice(0, MAX_ANALYTICS_LINES)) {
      const o = (r || {}) as Record<string, unknown>;
      if (typeof o.kind !== 'string' || !ANALYTICS_KINDS.has(o.kind as AnalyticsLineKind)) continue;
      const line: PersistedAnalyticsLine = { kind: o.kind as AnalyticsLineKind };
      const id = clampStr(o.id, 64);
      if (id) line.id = id;
      const measure = typeof o.measure === 'string' && o.measure.trim() ? o.measure.trim() : undefined;
      if (measure) line.measure = measure;
      if (typeof o.value === 'number' && Number.isFinite(o.value)) line.value = o.value;
      const pct = clampPct(o.percentile);
      if (pct !== undefined) line.percentile = pct;
      const color = clampColor(o.color);
      if (color) line.color = color;
      if (typeof o.style === 'string' && ANALYTICS_STYLES.has(o.style as AnalyticsLineStyle)) {
        line.style = o.style as AnalyticsLineStyle;
      }
      const label = clampStr(o.label, 200);
      if (label !== undefined) line.label = label;
      if (typeof o.showLabel === 'boolean') line.showLabel = o.showLabel;
      lines.push(line);
    }
  }

  const errorBars = sanitizeErrorBars(root.errorBars);
  const forecast = sanitizeForecast(root.forecast);
  const symmetry = sanitizeSymmetry(root.symmetry);

  if (!lines.length && !errorBars && !forecast && !symmetry) return undefined;
  return {
    lines,
    ...(errorBars ? { errorBars } : {}),
    ...(forecast ? { forecast } : {}),
    ...(symmetry ? { symmetry } : {}),
  };
}

/** Sanitize wave-2 error bars (mode whitelisted; measure/fields + bounds clamped). */
function sanitizeErrorBars(raw: unknown): PersistedErrorBar[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PersistedErrorBar[] = [];
  for (const r of raw.slice(0, MAX_ANALYTICS_LINES)) {
    const o = (r || {}) as Record<string, unknown>;
    if (typeof o.mode !== 'string' || !ERROR_BAR_MODES.has(o.mode as ErrorBarMode)) continue;
    const bar: PersistedErrorBar = { mode: o.mode as ErrorBarMode };
    const id = clampStr(o.id, 64);
    if (id) bar.id = id;
    const measure = typeof o.measure === 'string' && o.measure.trim() ? o.measure.trim().slice(0, MAX_STR) : undefined;
    if (measure) bar.measure = measure;
    const upper = typeof o.upperField === 'string' && o.upperField.trim() ? o.upperField.trim().slice(0, MAX_STR) : undefined;
    if (upper) bar.upperField = upper;
    const lower = typeof o.lowerField === 'string' && o.lowerField.trim() ? o.lowerField.trim().slice(0, MAX_STR) : undefined;
    if (lower) bar.lowerField = lower;
    const percent = clampNum(o.percent, 0, 1_000_000);
    if (percent !== undefined) bar.percent = percent;
    const value = clampNum(o.value, -1_000_000_000, 1_000_000_000);
    if (value !== undefined) bar.value = value;
    const color = clampColor(o.color);
    if (color) bar.color = color;
    out.push(bar);
  }
  return out.length ? out : undefined;
}

/** Sanitize a wave-2 forecast block (periods 1..60, seasonality 0..366, conf %). */
function sanitizeForecast(raw: unknown): PersistedForecast | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: PersistedForecast = {};
  const periods = clampPosInt(o.periods, 60);
  if (periods !== undefined) out.periods = periods;
  const seasonality = clampNum(o.seasonality, 0, 366);
  if (seasonality !== undefined) out.seasonality = Math.round(seasonality);
  const confidence = clampPct(o.confidence);
  if (confidence !== undefined) out.confidence = confidence;
  return Object.keys(out).length ? out : undefined;
}

/** Sanitize a wave-2 symmetry-shading block ({enabled,color}). */
function sanitizeSymmetry(raw: unknown): PersistedSymmetry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean') return undefined;
  const out: PersistedSymmetry = { enabled: o.enabled };
  const color = clampColor(o.color);
  if (color) out.color = color;
  return out;
}

/**
 * Sanitize a bare field reference (drillthrough field / tooltip binding). Drops
 * it unless it references a column or measure — never a free-form/fieldless ref.
 */
function sanitizeFieldRef(raw: unknown): PersistedFieldRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const table = typeof o.table === 'string' ? o.table.trim() : undefined;
  const column = typeof o.column === 'string' ? o.column.trim() : undefined;
  const measure = typeof o.measure === 'string' ? o.measure.trim() : undefined;
  if (!column && !measure) return null;
  return {
    ...(table ? { table: table.slice(0, MAX_STR) } : {}),
    ...(column ? { column: column.slice(0, MAX_STR) } : {}),
    ...(measure ? { measure: measure.slice(0, MAX_STR) } : {}),
  };
}

/**
 * Sanitize the per-visual Selection-pane / canvas FLAGS (wave-2): `hidden` (eye
 * toggle), `locked` (lock), `groupId` (group/ungroup membership), and the
 * z-order index. Returned for folding into `config` (hidden/locked/groupId) and
 * `config.layout.z`. All structured + clamped; legacy visuals emit none.
 */
function sanitizeVisualFlags(v: VisualIn): { hidden?: boolean; locked?: boolean; groupId?: string; z?: number } {
  const out: { hidden?: boolean; locked?: boolean; groupId?: string; z?: number } = {};
  if (v.hidden === true) out.hidden = true;
  if (v.locked === true) out.locked = true;
  const groupId = clampStr(v.groupId, MAX_GROUP_STR);
  if (groupId) out.groupId = groupId;
  const z = clampNum(v.layout?.z, 0, 100_000);
  if (z !== undefined) out.z = Math.round(z);
  return out;
}

/** Sanitize a Record<string,boolean> (Selection-pane visibility), keys/size bounded. */
function sanitizeBoolMap(raw: unknown, cap = MAX_OBJECT_KEYS): Record<string, boolean> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, boolean> = {};
  let n = 0;
  for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= cap) break;
    if (!k || typeof val !== 'boolean') continue;
    out[k.slice(0, MAX_KEY_STR)] = val;
    n += 1;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Sanitize a Record<string,number> (z-order), values clamped + keys/size bounded. */
function sanitizeNumMap(raw: unknown, min: number, max: number, cap = MAX_OBJECT_KEYS): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, number> = {};
  let n = 0;
  for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= cap) break;
    if (!k) continue;
    const c = clampNum(val, min, max);
    if (c === undefined) continue;
    out[k.slice(0, MAX_KEY_STR)] = Math.round(c);
    n += 1;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Sanitize the per-page visual-INTERACTIONS matrix (`source → target → mode`).
 * Modes are whitelisted, self-edges dropped, keys length-bounded, entries capped.
 * Mirrors interactions.tsx's `parseInteractions`.
 */
function sanitizeInteractions(raw: unknown): Record<string, Record<string, InteractionMode>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, Record<string, InteractionMode>> = {};
  let sources = 0;
  for (const [src, targets] of Object.entries(raw as Record<string, unknown>)) {
    if (sources >= MAX_INTERACTION_KEYS) break;
    if (!src || !targets || typeof targets !== 'object') continue;
    const bucket: Record<string, InteractionMode> = {};
    let n = 0;
    for (const [tgt, mode] of Object.entries(targets as Record<string, unknown>)) {
      if (n >= MAX_INTERACTION_KEYS) break;
      if (!tgt || tgt === src) continue;
      if (typeof mode === 'string' && INTERACTION_MODES.has(mode as InteractionMode)) {
        bucket[tgt.slice(0, MAX_KEY_STR)] = mode as InteractionMode;
        n += 1;
      }
    }
    if (Object.keys(bucket).length) {
      out[src.slice(0, MAX_KEY_STR)] = bucket;
      sources += 1;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Sanitize the per-page canvas config (type/size/background/hidden/interactions).
 * Every field is structured + clamped. Returns undefined when nothing valid was
 * supplied, so an empty config is never persisted (legacy pages unaffected).
 */
function sanitizePageConfig(raw: unknown): PersistedPageConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: PersistedPageConfig = {};
  if (typeof o.type === 'string') {
    const t = o.type.trim().toLowerCase();
    if (CANVAS_TYPES.has(t as CanvasType)) out.type = t as CanvasType;
  }
  if (o.size && typeof o.size === 'object') {
    const s = o.size as Record<string, unknown>;
    const size: { width?: number; height?: number } = {};
    const w = clampNum(s.width, 1, 20_000);
    if (w !== undefined) size.width = Math.round(w);
    const h = clampNum(s.height, 1, 20_000);
    if (h !== undefined) size.height = Math.round(h);
    if (Object.keys(size).length) out.size = size;
  }
  const background = sanitizeFill(o.background);
  if (background) out.background = background;
  if (typeof o.hidden === 'boolean') out.hidden = o.hidden;
  const interactions = sanitizeInteractions(o.interactions);
  if (interactions) out.interactions = interactions;

  // ── wave-2: drillthrough TARGET well (each field must reference a col/measure) ──
  if (o.drillthrough && typeof o.drillthrough === 'object') {
    const rawFields = (o.drillthrough as Record<string, unknown>).fields;
    if (Array.isArray(rawFields)) {
      const fields = rawFields
        .map(sanitizeFieldRef)
        .filter((x): x is PersistedFieldRef => !!x)
        .slice(0, MAX_DRILLTHROUGH_FIELDS);
      if (fields.length) out.drillthrough = { fields };
    }
  }
  // ── wave-2: tooltip-page binding (only persisted when explicitly toggled) ──
  if (o.tooltipPage && typeof o.tooltipPage === 'object') {
    const tp = o.tooltipPage as Record<string, unknown>;
    if (typeof tp.enabled === 'boolean') {
      const boundField = sanitizeFieldRef(tp.boundField);
      out.tooltipPage = { enabled: tp.enabled, ...(boundField ? { boundField } : {}) };
    }
  }

  return Object.keys(out).length ? out : undefined;
}

/**
 * Sanitize ONE bookmark (mirror of bookmarks-pane.tsx). A bookmark MUST be
 * named; scope/apply flags are whitelisted/defaulted; the captured `state`
 * (active page, per-page + report structured filters, selected visuals, per-
 * object visibility + z-order) is sanitized through the SAME filter/bool/num
 * clamps so a bookmark can never smuggle a free-form value past the wave-0/1
 * gates. Returns null when unnamed.
 */
function sanitizeBookmark(raw: unknown): PersistedBookmark | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = clampStr(o.name, 200);
  if (name === undefined || !name.trim()) return null; // a bookmark must be named
  const scope: BookmarkScope =
    typeof o.scope === 'string' && BOOKMARK_SCOPES.has(o.scope as BookmarkScope)
      ? (o.scope as BookmarkScope)
      : 'allPages';
  const applyIn = (o.apply || {}) as Record<string, unknown>;
  // Power BI defaults: Data + Display ON, Current-page OFF.
  const apply = {
    data: applyIn.data !== false,
    display: applyIn.display !== false,
    currentPage: applyIn.currentPage === true,
  };

  const stIn = (o.state || {}) as Record<string, unknown>;
  const state: PersistedBookmark['state'] = {};
  const activePageId = clampStr(stIn.activePageId, MAX_KEY_STR);
  if (activePageId) state.activePageId = activePageId;

  if (stIn.pageFilters && typeof stIn.pageFilters === 'object') {
    const buckets: Record<string, PersistedFilter[]> = {};
    let n = 0;
    for (const [pid, fl] of Object.entries(stIn.pageFilters as Record<string, unknown>)) {
      if (n >= MAX_BOOKMARK_PAGES) break;
      if (!pid) continue;
      const filters = sanitizeFilterList(fl);
      if (filters.length) {
        buckets[pid.slice(0, MAX_KEY_STR)] = filters;
        n += 1;
      }
    }
    if (Object.keys(buckets).length) state.pageFilters = buckets;
  }

  const reportFilters = sanitizeFilterList(stIn.reportFilters);
  if (reportFilters.length) state.reportFilters = reportFilters;

  if (Array.isArray(stIn.selection)) {
    const sel = stIn.selection
      .filter((s): s is string => typeof s === 'string' && !!s)
      .map((s) => s.slice(0, MAX_KEY_STR))
      .slice(0, MAX_OBJECT_KEYS);
    if (sel.length) state.selection = sel;
  }

  const visibility = sanitizeBoolMap(stIn.visibility);
  if (visibility) state.visibility = visibility;
  const zOrder = sanitizeNumMap(stIn.zOrder, 0, 100_000);
  if (zOrder) state.zOrder = zOrder;

  const id = clampStr(o.id, 64);
  return {
    ...(id ? { id } : {}),
    name,
    scope,
    apply,
    state,
  };
}

function sanitizeBookmarks(raw: unknown): PersistedBookmark[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(sanitizeBookmark)
    .filter((x): x is PersistedBookmark => !!x)
    .slice(0, MAX_BOOKMARKS);
}

/**
 * Sanitize the report-level Filters-pane FORMAT (mirror of filters-pane.tsx).
 * `show` / `border` / `showSearch` are booleans; the color tokens are clamped
 * via clampColor; transparency is a 0–100 %. Returns undefined when empty.
 */
function sanitizeFilterPaneFormat(raw: unknown): PersistedFilterPaneFormat | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: PersistedFilterPaneFormat = {};
  const bg = clampColor(o.background);
  if (bg) out.background = bg;
  const bd = clampColor(o.border);
  if (bd) out.border = bd;
  const hc = clampColor(o.headerColor);
  if (hc) out.headerColor = hc;
  const ic = clampColor(o.inputColor);
  if (ic) out.inputColor = ic;
  if (o.title && typeof o.title === 'object') {
    const t = o.title as Record<string, unknown>;
    const titleOut: { color?: string; show?: boolean } = {};
    const tc = clampColor(t.color);
    if (tc) titleOut.color = tc;
    if (typeof t.show === 'boolean') titleOut.show = t.show;
    if (Object.keys(titleOut).length) out.title = titleOut;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Font-family WHITELIST (no-freeform-config.md) — the theme builder's font
 * dropdown + the Power BI-theme import both resolve through this map, so only a
 * recognized family is ever persisted (canonical casing returned). Mirrors the
 * Power BI theme `fontFamily` faces plus the Loom/Fluent defaults.
 */
const THEME_FONTS: Record<string, string> = {
  'segoe ui': 'Segoe UI',
  'inter': 'Inter',
  'roboto': 'Roboto',
  'arial': 'Arial',
  'calibri': 'Calibri',
  'cambria': 'Cambria',
  'candara': 'Candara',
  'consolas': 'Consolas',
  'constantia': 'Constantia',
  'corbel': 'Corbel',
  'courier new': 'Courier New',
  'georgia': 'Georgia',
  'tahoma': 'Tahoma',
  'times new roman': 'Times New Roman',
  'trebuchet ms': 'Trebuchet MS',
  'verdana': 'Verdana',
  'din': 'DIN',
  'lucida sans unicode': 'Lucida Sans Unicode',
};

/** Resolve a theme font through {@link THEME_FONTS} (case-insensitive) or drop it. */
function normalizeThemeFont(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  return THEME_FONTS[v.trim().toLowerCase()];
}

/**
 * Sanitize the report-level THEME (wave-3 — mirror of themes.ts + the Power BI
 * theme-JSON import). Defensive in the SAME style as sanitizeFilterPaneFormat:
 * the `name` is string-clamped; `dataColors` is a hex/token array capped at
 * MAX_COLORS via clampColor; every structural color (background / secondary /
 * foreground / tableAccent / first..fourth-level elements / accent) is clamped;
 * the `fontFamily` is whitelisted (also accepting a nested `textClasses.fontFamily`
 * from an imported PBI theme). Returns undefined when nothing valid survives, so
 * an empty theme is never persisted (legacy reports unaffected). No free-form /
 * unknown key is ever carried through — purely the structured fields above.
 */
// ── wave-8 report-level interactivity sanitizers (structured, whitelisted) ────
const MAX_SYNC_GROUPS = 64, MAX_SYNC_MEMBERS = 256;
const MAX_FIELD_PARAMS = 64, MAX_FIELD_PARAM_FIELDS = 64;
const MAX_WHATIF_PARAMS = 64;

function sanitizeSyncGroups(raw: unknown): PersistedSyncGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: PersistedSyncGroup[] = [];
  for (const r of raw.slice(0, MAX_SYNC_GROUPS)) {
    const o = (r || {}) as Record<string, unknown>;
    const id = clampStr(o.id, 64)?.trim();
    const fieldKey = clampStr(o.fieldKey, 256)?.trim();
    if (!id || !fieldKey) continue;
    const members: PersistedSyncMember[] = [];
    if (Array.isArray(o.members)) {
      for (const m of o.members.slice(0, MAX_SYNC_MEMBERS)) {
        const mo = (m || {}) as Record<string, unknown>;
        const pageId = clampStr(mo.pageId, 128)?.trim();
        if (!pageId) continue;
        members.push({
          pageId,
          ...(mo.visible === false ? { visible: false } : { visible: true }),
          ...(mo.synced === true ? { synced: true } : {}),
        });
      }
    }
    out.push({ id, fieldKey, members });
  }
  return out;
}

function sanitizeFieldParameters(raw: unknown): PersistedFieldParameter[] {
  if (!Array.isArray(raw)) return [];
  const out: PersistedFieldParameter[] = [];
  for (const r of raw.slice(0, MAX_FIELD_PARAMS)) {
    const o = (r || {}) as Record<string, unknown>;
    const id = clampStr(o.id, 64)?.trim();
    const name = clampStr(o.name, 128)?.trim();
    if (!id || !name) continue;
    const fields: PersistedFieldParamField[] = [];
    if (Array.isArray(o.fields)) {
      for (const f of o.fields.slice(0, MAX_FIELD_PARAM_FIELDS)) {
        const fo = (f || {}) as Record<string, unknown>;
        const label = clampStr(fo.label, 128)?.trim();
        const table = clampStr(fo.table, 256)?.trim();
        const column = clampStr(fo.column, 256)?.trim();
        const measure = clampStr(fo.measure, 256)?.trim();
        if (!label || (!column && !measure)) continue; // must bind a real field
        fields.push({ label, ...(table ? { table } : {}), ...(column ? { column } : {}), ...(measure ? { measure } : {}) });
      }
    }
    if (!fields.length) continue;
    const activeIndex = clampPosInt(typeof o.activeIndex === 'number' ? o.activeIndex + 1 : undefined, fields.length);
    out.push({ id, name, fields, ...(activeIndex !== undefined ? { activeIndex: activeIndex - 1 } : {}) });
  }
  return out;
}

function sanitizeWhatIfParams(raw: unknown): PersistedWhatIfParam[] {
  if (!Array.isArray(raw)) return [];
  const out: PersistedWhatIfParam[] = [];
  for (const r of raw.slice(0, MAX_WHATIF_PARAMS)) {
    const o = (r || {}) as Record<string, unknown>;
    const id = clampStr(o.id, 64)?.trim();
    const name = clampStr(o.name, 128)?.trim();
    if (!id || !name) continue;
    const fin = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
    const min = fin(o.min, 0);
    const max = fin(o.max, 100);
    const increment = Math.max(0, fin(o.increment, 1)) || 1;
    const value = Math.min(Math.max(fin(o.value, min), min), max);
    const apply = o.apply === 'add' ? 'add' : 'multiply';
    const targetAlias = clampStr(o.targetAlias, 256)?.trim();
    out.push({ id, name, min, max, increment, value, apply, ...(targetAlias ? { targetAlias } : {}) });
  }
  return out;
}

function sanitizeReportTheme(raw: unknown): PersistedReportTheme | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: Omit<PersistedReportTheme, 'name'> = {};

  const builtinId = clampStr(o.builtinId ?? o.id, 64);
  if (builtinId && builtinId.trim()) out.builtinId = builtinId.trim();

  if (Array.isArray(o.dataColors)) {
    const colors = o.dataColors
      .map(clampColor)
      .filter((c): c is string => !!c)
      .slice(0, MAX_COLORS);
    if (colors.length) out.dataColors = colors;
  }

  const background = clampColor(o.background);
  if (background) out.background = background;
  const secondaryBackground = clampColor(o.secondaryBackground);
  if (secondaryBackground) out.secondaryBackground = secondaryBackground;
  const foreground = clampColor(o.foreground);
  if (foreground) out.foreground = foreground;
  const tableAccent = clampColor(o.tableAccent);
  if (tableAccent) out.tableAccent = tableAccent;
  const firstLevelElements = clampColor(o.firstLevelElements);
  if (firstLevelElements) out.firstLevelElements = firstLevelElements;
  const secondLevelElements = clampColor(o.secondLevelElements);
  if (secondLevelElements) out.secondLevelElements = secondLevelElements;
  const thirdLevelElements = clampColor(o.thirdLevelElements);
  if (thirdLevelElements) out.thirdLevelElements = thirdLevelElements;
  const fourthLevelElements = clampColor(o.fourthLevelElements);
  if (fourthLevelElements) out.fourthLevelElements = fourthLevelElements;
  const accent = clampColor(o.accent);
  if (accent) out.accent = accent;

  // fontFamily: structured builder emits `fontFamily`; a PBI-theme import maps
  // its `textClasses.*.fontFamily` here. Either way it's whitelisted.
  const nestedFont =
    o.textClasses && typeof o.textClasses === 'object'
      ? (o.textClasses as Record<string, unknown>).fontFamily
      : undefined;
  const fontFamily = normalizeThemeFont(o.fontFamily ?? nestedFont);
  if (fontFamily) out.fontFamily = fontFamily;

  const named = clampStr(o.name, 200);
  const name = named && named.trim() ? named.trim() : undefined;
  // Persist only when the theme carries a name OR at least one styling field.
  if (!name && !Object.keys(out).length) return undefined;
  return { name: name ?? 'Custom theme', ...out };
}

// ── wave-7 canvas elements (free-form text / image / shape / button / page +
//    bookmark navigators) — STRUCTURED + whitelisted (no-freeform-config.md;
//    no-vaporware.md: every element really renders/drags/persists/navigates) ──

/** Element kinds — the free-form canvas node vocabulary (mirror of
 *  canvas-elements.tsx `ElementKind`). Anything else is dropped. */
type ElementKind =
  | 'textBox' | 'image' | 'shape' | 'button' | 'pageNavigator' | 'bookmarkNavigator';
const ELEMENT_KINDS = new Set<ElementKind>([
  'textBox', 'image', 'shape', 'button', 'pageNavigator', 'bookmarkNavigator',
]);

/** Shape geometry / image-fit / navigator-orientation / text-alignment enums. */
type ElementShapeKind = 'rectangle' | 'oval' | 'line' | 'arrow';
const SHAPE_KINDS = new Set<ElementShapeKind>(['rectangle', 'oval', 'line', 'arrow']);
type ImageFit = 'contain' | 'cover' | 'fill';
const FIT_MODES = new Set<ImageFit>(['contain', 'cover', 'fill']);
type NavOrientation = 'horizontal' | 'vertical';
const NAV_ORIENTATIONS = new Set<NavOrientation>(['horizontal', 'vertical']);
type TextAlign = 'left' | 'center' | 'right';
type TextVAlign = 'top' | 'middle' | 'bottom';
const TEXT_ALIGNS = new Set<TextAlign>(['left', 'center', 'right']);
const TEXT_VALIGNS = new Set<TextVAlign>(['top', 'middle', 'bottom']);

/** Button action discriminator + per-state style keys (mirror canvas-elements.tsx).
 *  Each action dispatches a REAL host action (back / applyBookmark / drillthrough
 *  / setActivePage / Q&A / open URL), so a saved button is never a dead control. */
type ButtonActionType =
  | 'back' | 'bookmark' | 'drillthrough' | 'pageNavigation' | 'qna' | 'webUrl';
const ELEMENT_BUTTON_ACTIONS = new Set<ButtonActionType>([
  'back', 'bookmark', 'drillthrough', 'pageNavigation', 'qna', 'webUrl',
]);
type ButtonState = 'default' | 'hover' | 'press' | 'disabled';
const BUTTON_STATES = new Set<ButtonState>(['default', 'hover', 'press', 'disabled']);

/**
 * Button ICON whitelist (no-freeform-config.md) — a bounded set of Fluent v9 icon
 * base names the elements gallery / properties picker emit. Only a recognized
 * name is ever persisted (the registry maps it to a `<…Icon/>`), so an arbitrary
 * string can never ride through as an icon. Covers the action-relevant glyphs
 * (back arrow / bookmark / drill / navigation / Q&A / link) plus common decor.
 */
const ELEMENT_ICON_NAMES = new Set<string>([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ArrowClockwise', 'ArrowReply',
  'ArrowDownload', 'ArrowUpload', 'ArrowExport', 'ArrowEnter',
  'Bookmark', 'BookmarkMultiple', 'Navigation', 'Home', 'Drill',
  'ChevronLeft', 'ChevronRight', 'ChevronUp', 'ChevronDown',
  'ChatBubblesQuestion', 'QuestionCircle', 'Lightbulb', 'Link', 'Open', 'Globe',
  'Add', 'Subtract', 'Delete', 'Edit', 'Save', 'Document', 'Share', 'Print',
  'Search', 'Filter', 'Settings', 'Info', 'Warning', 'ErrorCircle', 'Checkmark', 'Dismiss',
  'Play', 'Pause', 'Stop', 'Eye', 'EyeOff', 'Star', 'Heart', 'Flag', 'Pin', 'Tag',
  'Mail', 'Calendar', 'Clock', 'Person', 'People', 'Location',
  'Table', 'Grid', 'ChartMultiple', 'DataTrending', 'DataBarVertical',
  'ZoomIn', 'ZoomOut', 'MoreHorizontal', 'Apps', 'Board',
]);

// ── wave-7 clamps ─────────────────────────────────────────────────────────────
const MAX_ELEMENTS = 200;        // canvas elements per page
const MAX_RUNS = 200;            // rich-text runs per text-box / shape / button label
const MAX_RUN = 10_000;          // characters per literal text run
const MAX_URL = 5_000;           // https:/mailto: link length
const MAX_DATA_URL = 1_500_000;  // inline data:image/* (kept under the Cosmos 2 MB doc cap)

/**
 * Data-bound token — a measure (or column+agg) the renderer resolves to a REAL
 * aggregated value via the host's /query (no-vaporware). Same field-ref shape the
 * visual wells use; `aggregation`/`numberFormat` reuse the route's existing
 * AGGS / NUMBER_FORMATS whitelists.
 */
interface PersistedFieldToken {
  table?: string;
  column?: string;
  measure?: string;
  aggregation?: 'Sum' | 'Avg' | 'Count' | 'Min' | 'Max' | 'None';
  numberFormat?: NumberFormatPreset;
}

/**
 * One inline run of the structured rich-text model — EITHER literal text OR a
 * resolved data token, plus a FIXED formatting whitelist. NO raw HTML is ever
 * stored or rendered (the WYSIWYG serializes to this shape), so the text box is
 * XSS-safe while staying direct-manipulation (no-freeform-config.md).
 */
type PersistedRun =
  | { text: string; bold?: boolean; italic?: boolean; underline?: boolean; color?: string; size?: number; link?: string }
  | { token: PersistedFieldToken; bold?: boolean; italic?: boolean; underline?: boolean; color?: string; size?: number };

interface PersistedButtonStateStyle { fill?: string; textColor?: string; border?: string }
type PersistedButtonAction =
  | { type: 'back' }
  | { type: 'bookmark'; bookmarkId?: string }
  | { type: 'drillthrough'; pageId?: string }
  | { type: 'pageNavigation'; pageId?: string }
  | { type: 'qna' }
  | { type: 'webUrl'; url?: string };

/**
 * One persisted canvas element. Rides on the SAME absolute layout/z space as a
 * data visual (id is unique across visuals+elements, so the Selection pane /
 * z-order / align-distribute machinery works on elements for free). Built as a
 * wide optional shape and discriminated by `kind`; only the kind's own fields are
 * ever populated by {@link sanitizeElement}.
 */
interface PersistedElement {
  id: string;
  kind: ElementKind;
  layout: { x: number; y: number; w: number; h: number; z?: number; unit: 'px' };
  hidden?: boolean;
  locked?: boolean;
  groupId?: string;
  rotation?: number;
  // textBox
  runs?: PersistedRun[];
  align?: TextAlign;
  valign?: TextVAlign;
  // image
  src?: string;
  srcToken?: PersistedFieldToken;
  fit?: ImageFit;
  alt?: string;
  link?: string;
  // shape
  shape?: ElementShapeKind;
  fill?: string;
  fillTransparency?: number;
  stroke?: string;
  strokeWidth?: number;
  cornerRadius?: number;
  text?: PersistedRun[];
  // button
  icon?: string;
  action?: PersistedButtonAction;
  disabled?: boolean;
  states?: Partial<Record<ButtonState, PersistedButtonStateStyle>>;
  // pageNavigator / bookmarkNavigator
  orientation?: NavOrientation;
  showHiddenPages?: boolean;
}

/**
 * Strict URL gate (XSS): accept ONLY `https:`, `mailto:`, and `data:image/*`.
 * Whitelisting (not blacklisting) the scheme makes `javascript:` / `vbscript:` /
 * `file:` / `data:text/html` and whitespace/control-char obfuscations all fall
 * through to `undefined` — the only way past is a literal recognized prefix.
 */
function clampUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  const lower = s.toLowerCase();
  if (lower.startsWith('https://') || lower.startsWith('mailto:')) return s.slice(0, MAX_URL);
  if (lower.startsWith('data:image/')) return s.slice(0, MAX_DATA_URL);
  return undefined;
}

/**
 * Sanitize a data-bound field token (text/value token + measure-driven image src).
 * Drops it unless it references a column or measure; aggregation ∈ AGGS and
 * numberFormat ∈ NUMBER_FORMATS (the same whitelists the wells/format use).
 */
function sanitizeFieldToken(raw: unknown): PersistedFieldToken | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const table = typeof o.table === 'string' ? o.table.trim() : undefined;
  const column = typeof o.column === 'string' ? o.column.trim() : undefined;
  const measure = typeof o.measure === 'string' ? o.measure.trim() : undefined;
  if (!column && !measure) return undefined; // a token must reference a field
  const out: PersistedFieldToken = {
    ...(table ? { table: table.slice(0, MAX_STR) } : {}),
    ...(column ? { column: column.slice(0, MAX_STR) } : {}),
    ...(measure ? { measure: measure.slice(0, MAX_STR) } : {}),
  };
  const aggRaw = typeof o.aggregation === 'string' ? o.aggregation : undefined;
  if (aggRaw && AGGS.has(aggRaw)) out.aggregation = aggRaw as PersistedFieldToken['aggregation'];
  if (typeof o.numberFormat === 'string' && NUMBER_FORMATS.has(o.numberFormat as NumberFormatPreset)) {
    out.numberFormat = o.numberFormat as NumberFormatPreset;
  }
  return out;
}

/** Shared run-formatting whitelist (bold/italic/underline/color/size). */
function sanitizeRunFormat(o: Record<string, unknown>): {
  bold?: boolean; italic?: boolean; underline?: boolean; color?: string; size?: number;
} {
  const fmt: { bold?: boolean; italic?: boolean; underline?: boolean; color?: string; size?: number } = {};
  if (o.bold === true) fmt.bold = true;
  if (o.italic === true) fmt.italic = true;
  if (o.underline === true) fmt.underline = true;
  const color = clampColor(o.color);
  if (color) fmt.color = color;
  const size = clampNum(o.size, 4, 400);
  if (size !== undefined) fmt.size = Math.round(size);
  return fmt;
}

/**
 * Sanitize ONE rich-text run. A valid data token wins (→ token-run, no link); else
 * a string `text` (→ text-run, link via {@link clampUrl}). Returns null when the
 * run is neither, so an empty/garbage run is dropped.
 */
function sanitizeRun(raw: unknown): PersistedRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const fmt = sanitizeRunFormat(o);
  const token = sanitizeFieldToken(o.token);
  if (token) return { token, ...fmt };
  if (typeof o.text === 'string') {
    const link = clampUrl(o.link);
    return { text: o.text.slice(0, MAX_RUN), ...fmt, ...(link ? { link } : {}) };
  }
  return null;
}

function sanitizeRuns(raw: unknown): PersistedRun[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .map(sanitizeRun)
    .filter((x): x is PersistedRun => !!x)
    .slice(0, MAX_RUNS);
  return out.length ? out : undefined;
}

/**
 * Sanitize a button ACTION (discriminated by `type` ∈ ELEMENT_BUTTON_ACTIONS).
 * `webUrl.url` runs through clampUrl; bookmark/page ids are length-clamped. Returns
 * undefined for an unknown type so the caller can default to a real `back` action.
 */
function sanitizeButtonAction(raw: unknown): PersistedButtonAction | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const type = typeof o.type === 'string' ? o.type : '';
  if (!ELEMENT_BUTTON_ACTIONS.has(type as ButtonActionType)) return undefined;
  switch (type as ButtonActionType) {
    case 'bookmark': {
      const bookmarkId = clampStr(o.bookmarkId, MAX_KEY_STR);
      return { type: 'bookmark', ...(bookmarkId ? { bookmarkId } : {}) };
    }
    case 'drillthrough': {
      const pageId = clampStr(o.pageId, MAX_KEY_STR);
      return { type: 'drillthrough', ...(pageId ? { pageId } : {}) };
    }
    case 'pageNavigation': {
      const pageId = clampStr(o.pageId, MAX_KEY_STR);
      return { type: 'pageNavigation', ...(pageId ? { pageId } : {}) };
    }
    case 'webUrl': {
      const url = clampUrl(o.url);
      return { type: 'webUrl', ...(url ? { url } : {}) };
    }
    case 'qna':
      return { type: 'qna' };
    case 'back':
    default:
      return { type: 'back' };
  }
}

/** Sanitize the per-state button style map (keys ∈ BUTTON_STATES; colors clamped). */
function sanitizeButtonStates(raw: unknown): Partial<Record<ButtonState, PersistedButtonStateStyle>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Partial<Record<ButtonState, PersistedButtonStateStyle>> = {};
  for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!BUTTON_STATES.has(k as ButtonState) || !val || typeof val !== 'object') continue;
    const s = val as Record<string, unknown>;
    const style: PersistedButtonStateStyle = {};
    const fill = clampColor(s.fill);
    if (fill) style.fill = fill;
    const textColor = clampColor(s.textColor);
    if (textColor) style.textColor = textColor;
    const border = clampColor(s.border);
    if (border) style.border = border;
    if (Object.keys(style).length) out[k as ButtonState] = style;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Sanitize an element's absolute layout — the SAME x/y/w/h clamp as a visual,
 *  z clamped 0..100000, ALWAYS `unit:'px'` (elements are free-form positioned). */
function sanitizeElementLayout(raw: unknown): PersistedElement['layout'] {
  const o = (raw || {}) as Record<string, unknown>;
  const z = clampNum(o.z, 0, 100_000);
  return {
    x: num(o.x, 0),
    y: num(o.y, 0),
    w: Math.max(1, num(o.w, 6)),
    h: Math.max(1, num(o.h, 4)),
    ...(z !== undefined ? { z: Math.round(z) } : {}),
    unit: 'px',
  };
}

/**
 * Sanitize ONE canvas element — kind-gated, fully structured. Drops it unless it
 * has a whitelisted `kind` AND an `id` (the id is shared across visuals+elements
 * for selection/z, so an id-less node can't participate → not persisted). Only the
 * fields belonging to the element's kind are populated.
 */
function sanitizeElement(raw: unknown): PersistedElement | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = typeof o.kind === 'string' ? o.kind : '';
  if (!ELEMENT_KINDS.has(kind as ElementKind)) return null;
  const id = clampStr(o.id, MAX_KEY_STR);
  if (!id || !id.trim()) return null;

  const el: PersistedElement = {
    id: id.trim(),
    kind: kind as ElementKind,
    layout: sanitizeElementLayout(o.layout),
  };
  if (o.hidden === true) el.hidden = true;
  if (o.locked === true) el.locked = true;
  const groupId = clampStr(o.groupId, MAX_GROUP_STR);
  if (groupId) el.groupId = groupId;
  const rotation = clampNum(o.rotation, -360, 360);
  if (rotation !== undefined) el.rotation = rotation;

  switch (kind as ElementKind) {
    case 'textBox': {
      const runs = sanitizeRuns(o.runs);
      if (runs) el.runs = runs;
      if (typeof o.align === 'string' && TEXT_ALIGNS.has(o.align as TextAlign)) el.align = o.align as TextAlign;
      if (typeof o.valign === 'string' && TEXT_VALIGNS.has(o.valign as TextVAlign)) el.valign = o.valign as TextVAlign;
      break;
    }
    case 'image': {
      const src = clampUrl(o.src);
      if (src) el.src = src;
      const srcToken = sanitizeFieldToken(o.srcToken);
      if (srcToken) el.srcToken = srcToken;
      if (typeof o.fit === 'string' && FIT_MODES.has(o.fit as ImageFit)) el.fit = o.fit as ImageFit;
      const alt = clampStr(o.alt, MAX_STR);
      if (alt !== undefined) el.alt = alt;
      const link = clampUrl(o.link);
      if (link) el.link = link;
      break;
    }
    case 'shape': {
      el.shape = typeof o.shape === 'string' && SHAPE_KINDS.has(o.shape as ElementShapeKind)
        ? (o.shape as ElementShapeKind)
        : 'rectangle';
      const fill = clampColor(o.fill);
      if (fill) el.fill = fill;
      const fillTransparency = clampPct(o.fillTransparency);
      if (fillTransparency !== undefined) el.fillTransparency = fillTransparency;
      const stroke = clampColor(o.stroke);
      if (stroke) el.stroke = stroke;
      const strokeWidth = clampNum(o.strokeWidth, 0, 200);
      if (strokeWidth !== undefined) el.strokeWidth = Math.round(strokeWidth);
      const cornerRadius = clampNum(o.cornerRadius, 0, 1000);
      if (cornerRadius !== undefined) el.cornerRadius = Math.round(cornerRadius);
      const text = sanitizeRuns(o.text);
      if (text) el.text = text;
      const link = clampUrl(o.link);
      if (link) el.link = link;
      break;
    }
    case 'button': {
      const text = sanitizeRuns(o.text);
      if (text) el.text = text;
      if (typeof o.icon === 'string' && ELEMENT_ICON_NAMES.has(o.icon)) el.icon = o.icon;
      // A button always carries a REAL action (default 'back') — never a dead control.
      el.action = sanitizeButtonAction(o.action) ?? { type: 'back' };
      if (o.disabled === true) el.disabled = true;
      const states = sanitizeButtonStates(o.states);
      if (states) el.states = states;
      break;
    }
    case 'pageNavigator': {
      if (typeof o.orientation === 'string' && NAV_ORIENTATIONS.has(o.orientation as NavOrientation)) {
        el.orientation = o.orientation as NavOrientation;
      }
      if (o.showHiddenPages === true) el.showHiddenPages = true;
      break;
    }
    case 'bookmarkNavigator': {
      if (typeof o.orientation === 'string' && NAV_ORIENTATIONS.has(o.orientation as NavOrientation)) {
        el.orientation = o.orientation as NavOrientation;
      }
      break;
    }
  }
  return el;
}

function sanitizeElements(raw: unknown): PersistedElement[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(sanitizeElement)
    .filter((x): x is PersistedElement => !!x)
    .slice(0, MAX_ELEMENTS);
}

/** Derive the legacy single-`field` shortcut from the wells (first value, else
 *  first category) so the read-only viewer + /query single-field path render. */
function deriveField(values: any[], category: any[]): string | undefined {
  const first = values[0] || category[0];
  if (!first) return undefined;
  if (first.measure) return `[${first.measure}]`;
  if (first.column) {
    const tbl = first.table ? `'${escapeSqlLiteral(first.table)}'` : '';
    return `${tbl}[${first.column}]`;
  }
  return undefined;
}

// ── Public API consumed by app/api/items/report/[id]/definition/route.ts ──
export {
  num,
  VISUAL_TYPES,
  EXTRA_WELL_NAMES,
  MAX_SCRIPT,
  sanitizeWellList,
  sanitizeFormat,
  sanitizeAnalytics,
  sanitizeFilterList,
  sanitizeVisualFlags,
  deriveField,
  sanitizePageConfig,
  sanitizeElements,
  sanitizeBookmarks,
  sanitizeFilterPaneFormat,
  sanitizeReportTheme,
  sanitizeSyncGroups,
  sanitizeFieldParameters,
  sanitizeWhatIfParams,
  sanitizeReportSettings,
};
export type { PageIn, VisualIn, PersistedPage, ReportContentV2 };
