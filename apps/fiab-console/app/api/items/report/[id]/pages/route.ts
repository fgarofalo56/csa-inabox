/**
 * GET /api/items/report/[id]/pages?workspaceId=...
 *
 * Returns the report's pages so the editor can render a page-navigation list
 * and deep-link the embed via the powerbi-client setPage(name) API.
 *
 * Backs the report viewer "Pages" panel against the REAL Power BI REST:
 *   GET /groups/{ws}/reports/{id}/pages   (groupId-scoped)
 *
 * No mocks. Power BI errors (401/403, report not found) surface verbatim.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getReportPages, PowerBiError } from '@/lib/azure/powerbi-client';
import {
  isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem, reportPagesFromContent,
} from '../../../_lib/pbi-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function loomPages(cosmosItemId: string, tenantId: string) {
  const item = await loadContentBackedItem(cosmosItemId, 'report', tenantId);
  if (!item) return null;
  return reportPagesFromContent(item);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const id = (await ctx.params).id;

  // Bundle-installed report → pages/visuals come from state.content.
  if (isLoomContentId(id)) {
    const pages = await loomPages(cosmosIdFromLoomId(id), session.claims.oid);
    if (pages) return NextResponse.json({ ok: true, pages });
    return NextResponse.json({ ok: false, error: 'report template not found' }, { status: 404 });
  }

  try {
    const pages = await getReportPages(workspaceId, id);
    return NextResponse.json({ ok: true, pages });
  } catch (e: any) {
    if (e instanceof PowerBiError && e.status === 404) {
      const pages = await loomPages(id, session.claims.oid);
      if (pages) return NextResponse.json({ ok: true, pages });
    }
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
