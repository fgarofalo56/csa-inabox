/**
 * POST /api/items/semantic-model/[id]/refresh
 *   - Power BI backend (?workspaceId=...): queues a PBI dataset refresh.
 *   - AAS backend (?dbName=... , defaults to [id]): POSTs the AAS async-refresh
 *     REST API and returns the REAL refresh id from the Location header.
 * GET  /api/items/semantic-model/[id]/refresh — refresh history (both backends).
 *
 * Backend selection: see _lib/bi-backend.ts. powerbi-client is used only when
 * LOOM_BI_BACKEND=powerbi (or the no-AAS legacy fallback); otherwise the
 * Azure-native AAS path is used (per no-fabric-dependency.md). When AAS is
 * selected but LOOM_AAS_SERVER_NAME is unset the route 503s with an honest gate.
 *
 * Receipt: the first 300 chars of each route body are logged server-side.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { refreshDataset, listRefreshHistory, PowerBiError } from '@/lib/azure/powerbi-client';
import {
  refresh as aasRefresh,
  getRefreshes as aasGetRefreshes,
  aasServerConfigGate,
  AasError,
  type AasRefreshRequest,
} from '@/lib/azure/aas-server-client';
import { usingAas } from '../../_lib/bi-backend';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function receipt(label: string, body: unknown): void {
  try { console.info(`[${label}] receipt: ${JSON.stringify(body).slice(0, 300)}`); } catch { /* noop */ }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;

  if (!usingAas()) {
    const workspaceId = req.nextUrl.searchParams.get('workspaceId');
    if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
    try {
      await refreshDataset(workspaceId, id);
      return NextResponse.json({ ok: true, queuedAt: new Date().toISOString() });
    } catch (e: any) {
      const status = e instanceof PowerBiError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
  }

  // ── AAS path ──────────────────────────────────────────────────────────
  const gate = aasServerConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, error: `Azure Analysis Services not configured: ${gate.missing} — ${gate.detail}`, gate },
      { status: 503 },
    );
  }
  const dbName = req.nextUrl.searchParams.get('dbName') || id;
  let body: AasRefreshRequest = {};
  try { body = (await req.json()) as AasRefreshRequest; } catch { /* empty body → automatic refresh */ }
  try {
    const result = await aasRefresh(dbName, body);
    const out = { ok: true as const, refreshId: result.refreshId, location: result.location, queuedAt: new Date().toISOString() };
    receipt('aas/refresh.POST', out);
    return NextResponse.json(out);
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

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
    const out = { ok: true as const, refreshes };
    receipt('aas/refresh.GET', out);
    return NextResponse.json(out);
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
