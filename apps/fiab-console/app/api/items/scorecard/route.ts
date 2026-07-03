/**
 * GET  /api/items/scorecard[?workspaceId=...]   — list scorecards
 *
 * Azure-native DEFAULT (no-fabric-dependency.md, rel-T03/B11): with NO
 * workspaceId, the route lists the tenant's Cosmos-backed scorecards
 * (`loom:` ids — bundle-installed or created in Loom) with zero Power BI
 * calls. Passing a Power BI groupId additionally lists the live Power BI
 * scorecards in that group (the opt-in Fabric-family leg).
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
  // Cosmos-backed scorecards carry their goals in state.content (bundle
  // installs) and their check-ins / rollup config in the scorecard containers.
  // They are the DEFAULT listing — no Power BI workspace required; the detail
  // route serves the goals from state.content + Cosmos.
  const loomEntries = (await listContentBackedItems('scorecard', 'scorecard', session.claims.oid))
    .map(scorecardListEntry);
  if (!workspaceId) {
    return NextResponse.json({ ok: true, scorecards: loomEntries });
  }
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
