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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const id = (await ctx.params).id;
    const [dataset, tables, relationships, schedule] = await Promise.all([
      getDataset(workspaceId, id),
      listDatasetTables(workspaceId, id).catch(() => []),
      listDatasetRelationships(workspaceId, id).catch(() => []),
      getRefreshSchedule(workspaceId, id).catch(() => null),
    ]);
    return NextResponse.json({ ok: true, workspaceId, dataset, tables, relationships, refreshSchedule: schedule });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
