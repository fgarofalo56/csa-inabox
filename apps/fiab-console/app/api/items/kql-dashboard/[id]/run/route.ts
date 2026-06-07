/**
 * POST /api/items/kql-dashboard/[id]/run
 *
 * Execute a *transient* dashboard model (the in-editor, possibly-unsaved
 * builder state) against the real Kusto cluster. The builder posts the live
 * tiles + data sources + parameters + time range; the route resolves each
 * tile's database, substitutes parameters + the global time range into the
 * KQL, and runs it via the same `executeQuery` path the KQL Database /
 * Queryset editors use (POST {cluster}/v2/rest/query under the hood). No
 * mock data — every tile is a real Kusto query.
 *
 * This mirrors the Fabric Real-Time Dashboard "Run" action inside the tile
 * editor / "Refresh all" on the canvas, where edits run live before save.
 *
 * Body: DashboardModel-ish { tiles, dataSources?, parameters?, timeRange? }
 * Auth: session-required.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadKustoItem, resolveDatabase, KustoError } from '@/lib/azure/kusto-client';
import { sanitizeModel } from '@/lib/azure/kql-dashboard-model';
import { runTiles } from '../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const model = sanitizeModel(body);
  if (model.tiles.length === 0) {
    return NextResponse.json({ ok: false, error: 'no tiles to run' }, { status: 400 });
  }

  try {
    // Resolve the dashboard's fallback database. For a saved item we read the
    // bound database; for an unsaved (/new) dashboard we fall back to the
    // cluster default so the builder can still run before the first save.
    const { id } = await ctx.params;
    let fallbackDb: string;
    if (id && id !== 'new') {
      const item = await loadKustoItem(id, 'kql-dashboard', session.claims.oid);
      fallbackDb = resolveDatabase(item);
    } else {
      fallbackDb = resolveDatabase(null);
    }

    const timeKey = model.timeRange || 'last-24h';
    const tiles = await runTiles(model.tiles, model.dataSources, model.parameters, timeKey, fallbackDb, model.baseQueries);

    return NextResponse.json({
      ok: true,
      tiles,
      database: fallbackDb,
      timeRange: timeKey,
      executedBy: session.claims.upn,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
