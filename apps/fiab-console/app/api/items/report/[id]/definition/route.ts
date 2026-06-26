/**
 * PUT /api/items/report/[id]/definition
 *
 * Atomically persist the WHOLE Loom-native report definition authored in the
 * report DESIGNER — every page, every visual, every visual's field wells and
 * canvas layout — into the report item's `state.content` (Cosmos). This is the
 * designer's "Save" path; the single-visual Copilot append still uses
 * POST …/visual.
 *
 * Azure-native default (no-fabric-dependency.md): the saved definition is what
 * the Loom-native renderer queries against the bound AAS tabular model with DAX
 * (POST …/query). NO Power BI / Fabric workspace required. We NEVER call
 * api.powerbi.com on this path.
 *
 * The persisted shape stays back-compatible with the read-only viewer
 * (`ReportContent.pages[].visuals[]` = { type, title, field?, config? }):
 *   - `type`   — renderer vocabulary (table | matrix | card | bar | column |
 *                line | area | pie | donut | scatter | slicer)
 *   - `field`  — derived single-field shortcut (first value/category) so the
 *                legacy viewer + /query single-field path still render
 *   - `config` — { wells, layout } the designer round-trips for rich editing
 *
 * Body: { pages: DesignerPage[] }
 * 200 OK → { ok: true, pageCount, visualCount }
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

/** Visual types the renderer + DAX synthesizer support. */
const VISUAL_TYPES = new Set([
  'table', 'matrix', 'card', 'bar', 'column', 'line', 'area', 'pie', 'donut', 'scatter', 'slicer',
]);
const AGGS = new Set(['Sum', 'Avg', 'Count', 'Min', 'Max', 'None']);

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
}
interface PageIn {
  name?: unknown;
  visuals?: unknown;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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

  let body: { pages?: unknown } = {};
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
  const pages = pagesIn.map((p, pi) => {
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
      visualCount += 1;
      return {
        type,
        title,
        field: deriveField(values, category),
        config: { wells: { category, values, legend }, layout },
      };
    });
    return { name, visuals };
  });

  const state = (item.state || {}) as Record<string, unknown>;
  const content: ReportContent = { kind: 'report', pages };
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
  });
}
