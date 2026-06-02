/**
 * GET /api/items/semantic-model?workspaceId=...
 * Lists datasets (semantic models) in a Power BI workspace.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listDatasets, PowerBiError } from '@/lib/azure/powerbi-client';
import { listContentBackedItems, semanticModelListEntry } from '../_lib/pbi-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  // Bundle-installed semantic models live in Cosmos with their tables/measures
  // in state.content but no live Power BI dataset yet. Surface them so the
  // editor opens FULLY BUILT-OUT (tables + measures + relationships) instead
  // of empty. These carry a `loom:` id; the detail route serves them from
  // state.content. Build model (push to PBI) makes them live.
  const loomEntries = (await listContentBackedItems('semantic-model', 'semantic-model', session.claims.oid))
    .map(semanticModelListEntry);
  try {
    const datasets = await listDatasets(workspaceId);
    return NextResponse.json({ ok: true, workspaceId, datasets: [...loomEntries, ...datasets] });
  } catch (e: any) {
    // Live PBI failed — still surface the bundle-backed templates so installed
    // apps render their content rather than just an error.
    if (loomEntries.length > 0) {
      return NextResponse.json({ ok: true, workspaceId, datasets: loomEntries });
    }
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
