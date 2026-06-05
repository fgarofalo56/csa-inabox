/**
 * GET /api/items/semantic-model/[id]?workspaceId=...
 * Returns dataset metadata + tables + the model's table relationships.
 * The [id] segment is the Power BI dataset id.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getDataset, listDatasetTables, listDatasetRelationships, getRefreshSchedule, PowerBiError,
} from '@/lib/azure/powerbi-client';
import {
  isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem, semanticModelDetailFromContent,
} from '../../_lib/pbi-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Serve a bundle-installed semantic model's tables/measures/relationships
 * from state.content so the editor opens fully built out before the model is
 * pushed to Power BI. */
async function loomDetail(cosmosItemId: string, tenantId: string, workspaceId: string) {
  const item = await loadContentBackedItem(cosmosItemId, 'semantic-model', tenantId);
  if (!item) return null;
  const built = semanticModelDetailFromContent(item);
  if (!built) return null;
  return NextResponse.json({ ok: true, workspaceId, ...built });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const id = (await ctx.params).id;

  // Synthetic bundle-template id → serve from Cosmos state.content.
  if (isLoomContentId(id)) {
    const resp = await loomDetail(cosmosIdFromLoomId(id), session.claims.oid, workspaceId);
    if (resp) return resp;
    return NextResponse.json({ ok: false, error: 'semantic-model template not found' }, { status: 404 });
  }

  try {
    const [dataset, tables, relationships, schedule] = await Promise.all([
      getDataset(workspaceId, id),
      listDatasetTables(workspaceId, id).catch(() => []),
      listDatasetRelationships(workspaceId, id).catch(() => []),
      getRefreshSchedule(workspaceId, id).catch(() => null),
    ]);
    return NextResponse.json({ ok: true, workspaceId, dataset, tables, relationships, refreshSchedule: schedule });
  } catch (e: any) {
    // Live dataset absent — if a bundle item with this id exists, serve its
    // content so the editor renders the model instead of an error.
    if (e instanceof PowerBiError && e.status === 404) {
      const resp = await loomDetail(id, session.claims.oid, workspaceId);
      if (resp) return resp;
    }
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
