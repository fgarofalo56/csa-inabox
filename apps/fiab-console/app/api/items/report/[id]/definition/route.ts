/**
 * PUT /api/items/report/[id]/definition
 *
 * Atomically persist the WHOLE Loom-native report definition authored in the
 * report DESIGNER — every page, every visual, every visual's field wells and
 * canvas layout, PLUS the report-designer-v2 structured extras: per-visual
 * FORMAT (title/colors/axis/legend/number-format), per-visual / per-page /
 * report-level structured FILTERS — into the report item's `state.content`
 * (Cosmos). This is the designer's "Save" path; the single-visual Copilot
 * append still uses POST …/visual.
 *
 * Azure-native default (no-fabric-dependency.md): the saved definition is what
 * the Loom-native renderer queries against the report's resolved data source
 * (semantic-model over Synapse/lakehouse via SQL, or the advanced AAS tabular
 * binding via DAX) in POST …/query. NO Power BI / Fabric workspace required.
 * We NEVER call api.powerbi.com on this path. The chosen `state.dataSource`
 * is owned by the sibling …/data-source route and is preserved untouched here.
 *
 * The persisted shape stays back-compatible with the read-only viewer and the
 * PBIR provisioner (`ReportContent.pages[].visuals[]` = { type, title, field?,
 * config? }):
 *   - `type`   — renderer vocabulary (table | matrix | card | bar | column |
 *                line | area | pie | donut | scatter | slicer)
 *   - `field`  — derived single-field shortcut (first value/category) so the
 *                legacy viewer + /query single-field path still render
 *   - `config` — { wells, layout, format?, filters? } the designer round-trips.
 *                `format` + `filters` are ADDITIVE — the read-only viewer and
 *                PBIR provisioner ignore unknown `config` keys.
 *
 * The v2 extras are all STRUCTURED + whitelisted server-side (no-freeform-
 * config.md): filter operators are checked against a fixed set, format presets
 * against fixed enums, and data colors are clamped to strings. The user never
 * types DAX / JSON — the designer emits these shapes from pickers + switches,
 * and the /query compiler turns filters into SQL `WHERE` / DAX `FILTER`.
 *
 * Body: {
 *   pages: DesignerPage[]                  // each: { name, filters?, visuals[] }
 *   reportFilters?: WireFilter[]           // report-scope structured filters
 *   dataSource?: ...                       // IGNORED here (owned by …/data-source)
 * }
 * 200 OK → { ok: true, pageCount, visualCount, reportFilterCount }
 * 4xx    → { ok: false, error }
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import { updateOwnedItem } from '../../../_lib/item-crud';
import type { ReportContent } from '@/lib/apps/content-bundles/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Visual types the renderer + DAX/SQL synthesizer support. */
const VISUAL_TYPES = new Set([
  'table', 'matrix', 'card', 'bar', 'column', 'line', 'area', 'pie', 'donut', 'scatter', 'slicer',
]);
const AGGS = new Set(['Sum', 'Avg', 'Count', 'Min', 'Max', 'None']);

// ── v2 structured-extras whitelists (no-freeform-config.md) ───────────────────

/** Structured filter operators — mirror `FilterOp` in the report designer. */
type FilterOp = 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'in' | 'contains' | 'between';
const FILTER_OPS = new Set<FilterOp>(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'in', 'contains', 'between']);

/** Format-pane enums — mirror `LegendPosition` / `NumberFormatPreset`. */
type LegendPosition = 'top' | 'bottom' | 'left' | 'right';
type NumberFormatPreset = 'general' | 'whole' | 'decimal' | 'percent' | 'currency' | 'thousands';
const LEGEND_POSITIONS = new Set<LegendPosition>(['top', 'bottom', 'left', 'right']);
const NUMBER_FORMATS = new Set<NumberFormatPreset>([
  'general', 'whole', 'decimal', 'percent', 'currency', 'thousands',
]);

// Light clamps so a hostile/oversized payload can't bloat the Cosmos item.
const MAX_STR = 2000;          // filter value / title text
const MAX_VALUES = 1000;       // `in` set size
const MAX_FILTERS = 200;       // filters per scope
const MAX_COLORS = 32;         // data-color swatches
const MAX_COLOR_STR = 64;      // single swatch string length

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
}

/** A single structured filter, post-`wireFilters` (no client-only id). */
interface PersistedFilter {
  table?: string;
  column?: string;
  measure?: string;
  op: FilterOp;
  value?: string;
  value2?: string;
  values?: string[];
}

/**
 * Extended persisted content. ADDITIVE over {@link ReportContent}: pages gain
 * an optional `filters`, and the report gains a top-level `reportFilters`. The
 * visual `config` (typed `any` in ReportContent) carries `format` + `filters`.
 * Anything reading the base `ReportContent` shape (read-only viewer, PBIR
 * provisioner) simply ignores the extra keys.
 */
type PersistedVisual = ReportContent['pages'][number]['visuals'][number];
interface PersistedPage {
  name: string;
  visuals: PersistedVisual[];
  filters?: PersistedFilter[];
}
interface ReportContentV2 extends Omit<ReportContent, 'pages'> {
  pages: PersistedPage[];
  reportFilters?: PersistedFilter[];
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
  wells?: { category?: unknown; values?: unknown; legend?: unknown };
  layout?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
  format?: unknown;
  filters?: unknown;
}
interface PageIn {
  name?: unknown;
  visuals?: unknown;
  filters?: unknown;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampStr(v: unknown, max = MAX_STR): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
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
    .filter((x): x is NonNullable<typeof x> => !!x);
}

/**
 * Sanitize one structured filter. Drops the filter (returns null) unless it
 * references a column or measure AND carries a whitelisted operator — so no
 * free-form/unknown operator or fieldless filter is ever persisted.
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
  return {
    op: op as FilterOp,
    ...(table ? { table } : {}),
    ...(column ? { column } : {}),
    ...(measure ? { measure } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(value2 !== undefined ? { value2 } : {}),
    ...(values && values.length ? { values } : {}),
  };
}

function sanitizeFilterList(raw: unknown): PersistedFilter[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(sanitizeFilter)
    .filter((x): x is PersistedFilter => !!x)
    .slice(0, MAX_FILTERS);
}

/** Clamp a data-color swatch to a non-empty, length-bounded string. */
function clampColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, MAX_COLOR_STR) : null;
}

/**
 * Sanitize the per-visual FORMAT into a SPARSE, whitelisted shape — only keys
 * the author actually touched survive (so defaults stay implicit). Returns
 * undefined when nothing valid was supplied, so an empty format is never
 * persisted.
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
  return Object.keys(out).length ? out : undefined;
}

/** Derive the legacy single-`field` shortcut from the wells (first value, else
 *  first category) so the read-only viewer + /query single-field path render. */
function deriveField(values: any[], category: any[]): string | undefined {
  const first = values[0] || category[0];
  if (!first) return undefined;
  if (first.measure) return `[${first.measure}]`;
  if (first.column) {
    const tbl = first.table ? `'${first.table.replace(/'/g, "''")}'` : '';
    return `${tbl}[${first.column}]`;
  }
  return undefined;
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const rawId = (await ctx.params).id;
  const cosmosId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;

  let body: { pages?: unknown; reportFilters?: unknown } = {};
  try { body = await req.json(); } catch {}
  if (!Array.isArray(body.pages)) {
    return NextResponse.json({ ok: false, error: 'body.pages[] is required' }, { status: 400 });
  }

  const item = await loadContentBackedItem(cosmosId, 'report', session.claims.oid);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'report item not found or not owned by you' }, { status: 404 });
  }

  // Build the persisted ReportContent from the designer model. Always keep at
  // least one page so a saved report is never empty/broken.
  const pagesIn = (body.pages as PageIn[]).length ? (body.pages as PageIn[]) : [{ name: 'Page 1', visuals: [] }];
  let visualCount = 0;
  const pages: PersistedPage[] = pagesIn.map((p, pi) => {
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : `Page ${pi + 1}`;
    const visualsRaw = Array.isArray(p.visuals) ? (p.visuals as VisualIn[]) : [];
    const visuals = visualsRaw.map((v) => {
      const vt = String(v.visualType || v.type || 'table');
      const type = VISUAL_TYPES.has(vt) ? vt : 'table';
      const title = typeof v.title === 'string' ? v.title : '';
      const category = sanitizeWellList(v.wells?.category);
      const values = sanitizeWellList(v.wells?.values);
      const legend = sanitizeWellList(v.wells?.legend);
      const layout = {
        x: num(v.layout?.x, 0),
        y: num(v.layout?.y, 0),
        w: Math.max(1, num(v.layout?.w, 6)),
        h: Math.max(1, num(v.layout?.h, 4)),
      };
      // v2 additive extras — structured + whitelisted; omitted when empty so the
      // persisted `config` stays minimal and the legacy viewer is unaffected.
      const format = sanitizeFormat(v.format);
      const visualFilters = sanitizeFilterList(v.filters);
      visualCount += 1;
      return {
        type,
        title,
        field: deriveField(values, category),
        config: {
          wells: { category, values, legend },
          layout,
          ...(format ? { format } : {}),
          ...(visualFilters.length ? { filters: visualFilters } : {}),
        },
      };
    });
    const pageFilters = sanitizeFilterList(p.filters);
    return {
      name,
      visuals,
      ...(pageFilters.length ? { filters: pageFilters } : {}),
    };
  });

  const reportFilters = sanitizeFilterList(body.reportFilters);

  const state = (item.state || {}) as Record<string, unknown>;
  // ADDITIVE persist: keep every other state key (incl. `state.dataSource`,
  // owned by the …/data-source route, and the legacy AAS binding) untouched.
  const content: ReportContentV2 = {
    kind: 'report',
    pages,
    ...(reportFilters.length ? { reportFilters } : {}),
  };
  const newState = { ...state, content };

  const updated = await updateOwnedItem(cosmosId, 'report', session.claims.oid, { state: newState });
  if (!updated) {
    return NextResponse.json({ ok: false, error: 'failed to persist report definition' }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    backend: 'loom-native' as const,
    pageCount: pages.length,
    visualCount,
    reportFilterCount: reportFilters.length,
  });
}
