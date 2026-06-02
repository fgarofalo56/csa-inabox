/**
 * GET  /api/items/scorecard?workspaceId=...      — list Fabric scorecards
 * POST /api/items/scorecard?workspaceId=...      — (reserved; not yet)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listScorecards, PowerBiError } from '@/lib/azure/powerbi-client';
import { listContentBackedItems, scorecardListEntry } from '../_lib/pbi-content-fallback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  // Bundle-installed scorecards carry their OKRs in state.content but have no
  // live Fabric scorecard yet. Surface them (`loom:` id) so the editor renders
  // the OKR goals instead of opening empty; the detail route serves the goals
  // from state.content.
  const loomEntries = (await listContentBackedItems('scorecard', 'scorecard', session.claims.oid))
    .map(scorecardListEntry);
  try {
    const scorecards = await listScorecards(workspaceId);
    return NextResponse.json({ ok: true, workspaceId, scorecards: [...loomEntries, ...scorecards] });
  } catch (e: any) {
    if (loomEntries.length > 0) {
      return NextResponse.json({ ok: true, workspaceId, scorecards: loomEntries });
    }
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
