/**
 * POST /api/items/report/[id]/visual
 *
 * Apply an approved Report-Copilot visual suggestion to a real report item.
 *
 * DEFAULT (Azure-native, no Power BI / Fabric required — no-fabric-dependency.md):
 *   Appends the visual to the report item's `state.content.pages[pageIndex].visuals[]`
 *   in Cosmos. The Loom-native report viewer (reportPagesFromContent) renders it
 *   immediately — a real, rendering visual with NO Power BI dependency.
 *
 * `[id]` is the Loom Cosmos item id of the report (a `loom:` prefix is also
 * accepted). Ownership is verified via the parent workspace tenant.
 *
 * Body: { visual: ReportVisualSuggestion, pageIndex?: number, workspaceId?: string }
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import { updateOwnedItem } from '../../../_lib/item-crud';
import { coerceVisualSuggestion } from '@/lib/copilot/report-tools';
import type { ReportContent } from '@/lib/apps/content-bundles/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const rawId = (await ctx.params).id;
  const cosmosId = isLoomContentId(rawId) ? cosmosIdFromLoomId(rawId) : rawId;

  let body: { visual?: unknown; pageIndex?: number; workspaceId?: string } = {};
  try { body = await req.json(); } catch {}

  let visual;
  try {
    visual = coerceVisualSuggestion(body.visual);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 400 });
  }

  const item = await loadContentBackedItem(cosmosId, 'report', session.claims.oid);
  if (!item) {
    return NextResponse.json({ ok: false, error: 'report item not found or not owned by you' }, { status: 404 });
  }

  // Read the existing report content, or initialize a single-page report so a
  // brand-new (empty) report still accepts the visual.
  const state = (item.state || {}) as Record<string, unknown>;
  const existing = state.content as ReportContent | undefined;
  const content: ReportContent =
    existing && existing.kind === 'report' && Array.isArray(existing.pages) && existing.pages.length > 0
      ? { kind: 'report', pages: existing.pages.map((p) => ({ name: p.name, visuals: [...(p.visuals || [])] })) }
      : { kind: 'report', pages: [{ name: 'Page 1', visuals: [] }] };

  const pageIndex = Number.isInteger(body.pageIndex) && (body.pageIndex as number) >= 0 && (body.pageIndex as number) < content.pages.length
    ? (body.pageIndex as number)
    : 0;

  // The visual the Loom-native viewer renders. config carries the grounding SQL
  // + canvas position so the renderer can run the query and lay the tile out.
  const visualEntry = {
    type: visual.visualType,
    title: visual.title,
    field: visual.field,
    config: { sql: visual.sql, position: visual.position },
  };
  content.pages[pageIndex].visuals.push(visualEntry);

  const newState = { ...state, content };
  const updated = await updateOwnedItem(cosmosId, 'report', session.claims.oid, { state: newState });
  if (!updated) {
    return NextResponse.json({ ok: false, error: 'failed to persist visual' }, { status: 502 });
  }

  // Power BI is strictly opt-in. We NEVER call api.powerbi.com on this default
  // path; live PBI visual authoring happens in Power BI Desktop. Surface an
  // honest note when the report is also bound to a PBI workspace.
  const pbiOptIn =
    !!body.workspaceId &&
    (process.env.LOOM_REPORT_BACKEND === 'fabric' || process.env.LOOM_SEMANTIC_BACKEND === 'powerbi');

  return NextResponse.json({
    ok: true,
    backend: 'loom-native' as const,
    visual: visualEntry,
    pageIndex,
    pageName: content.pages[pageIndex].name,
    ...(pbiOptIn
      ? { note: 'Visual saved to the CSA Loom report. Live Power BI visual authoring is done in Power BI Desktop; use "Open in Power BI".' }
      : {}),
  });
}
