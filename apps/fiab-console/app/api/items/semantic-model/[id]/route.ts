/**
 * GET /api/items/semantic-model/[id]?workspaceId=...
 * Returns dataset metadata + tables + relationships (datasources fallback).
 * The [id] segment is the Power BI dataset id.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getDataset, listDatasetTables, listDatasetRelationships, getRefreshSchedule, PowerBiError,
} from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  try {
    const [dataset, tables, sources, schedule] = await Promise.all([
      getDataset(workspaceId, ctx.params.id),
      listDatasetTables(workspaceId, ctx.params.id).catch(() => []),
      listDatasetRelationships(workspaceId, ctx.params.id).catch(() => []),
      getRefreshSchedule(workspaceId, ctx.params.id).catch(() => null),
    ]);
    return NextResponse.json({ ok: true, workspaceId, dataset, tables, datasources: sources, refreshSchedule: schedule });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
