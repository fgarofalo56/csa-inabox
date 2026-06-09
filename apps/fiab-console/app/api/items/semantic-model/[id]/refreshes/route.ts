/**
 * GET /api/items/semantic-model/[id]/refreshes
 *   - Power BI backend (?workspaceId=...&top=25): PBI refresh history.
 *   - AAS backend (?dbName=... , defaults to [id]): the AAS async-refresh
 *     history (last 30 days, newest first) from the data-plane REST API.
 *
 * Backend selection: see _lib/bi-backend.ts. Per no-fabric-dependency.md the
 * Azure-native AAS path is the default; Power BI is opt-in.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listRefreshHistory, PowerBiError } from '@/lib/azure/powerbi-client';
import { getRefreshes as aasGetRefreshes, aasServerConfigGate, AasError } from '@/lib/azure/aas-server-client';
import { usingAas } from '../../_lib/bi-backend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;

  if (!usingAas()) {
    const workspaceId = req.nextUrl.searchParams.get('workspaceId');
    if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
    const top = Math.min(100, parseInt(req.nextUrl.searchParams.get('top') || '25', 10) || 25);
    try {
      const refreshes = await listRefreshHistory(workspaceId, id, top);
      return NextResponse.json({ ok: true, refreshes });
    } catch (e: any) {
      const status = e instanceof PowerBiError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
  }

  const gate = aasServerConfigGate();
  if (gate) {
    return NextResponse.json({ ok: false, error: `Azure Analysis Services not configured: ${gate.missing}`, gate }, { status: 503 });
  }
  const dbName = req.nextUrl.searchParams.get('dbName') || id;
  try {
    const refreshes = await aasGetRefreshes(dbName);
    try { console.info(`[aas/refreshes.GET] receipt: ${JSON.stringify({ ok: true, refreshes }).slice(0, 300)}`); } catch { /* noop */ }
    return NextResponse.json({ ok: true, refreshes });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
