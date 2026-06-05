/**
 * GET /api/items/report/[id]?workspaceId=...
 * Returns report metadata + embed URL.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getReport, PowerBiError } from '@/lib/azure/powerbi-client';
import {
  isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem, reportDetailFromContent,
} from '../../_lib/pbi-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function loomReport(cosmosItemId: string, tenantId: string, workspaceId: string) {
  const item = await loadContentBackedItem(cosmosItemId, 'report', tenantId);
  if (!item) return null;
  const built = reportDetailFromContent(item);
  if (!built) return null;
  return NextResponse.json({ ok: true, workspaceId, ...built });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const id = (await ctx.params).id;

  if (isLoomContentId(id)) {
    const resp = await loomReport(cosmosIdFromLoomId(id), session.claims.oid, workspaceId);
    if (resp) return resp;
    return NextResponse.json({ ok: false, error: 'report template not found' }, { status: 404 });
  }

  try {
    const report = await getReport(workspaceId, id);
    return NextResponse.json({ ok: true, workspaceId, report });
  } catch (e: any) {
    if (e instanceof PowerBiError && e.status === 404) {
      const resp = await loomReport(id, session.claims.oid, workspaceId);
      if (resp) return resp;
    }
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
