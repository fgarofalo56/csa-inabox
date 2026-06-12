/**
 * POST /api/items/tapestry/[id]/timeline
 *   body: { window?: 'hour'|'day'|'week', database?: string }
 *
 * Tapestry timeline-analysis — bins every Edge_* event over time so the
 * investigator can see how the relationships evolve. Runs a KQL
 * `summarize count() by bin(<ts>, <window>), edgeLabel` over the materialized
 * Edge_* ADX tables. Azure-native — no Microsoft Fabric dependency.
 *
 * Grounded in Microsoft Learn:
 *   https://learn.microsoft.com/azure/data-explorer/kusto/query/bin-function
 *   https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-semantics-overview
 *   (graph semantics overview lists time-based analysis as first-class).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeQuery, kustoConfigGate, defaultDatabase, KustoError } from '@/lib/azure/kusto-client';
import { discoverGraphTables, buildTimelineKql, TIMELINE_WINDOWS, type TimelineWindow } from '@/lib/azure/tapestry-graph';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const window: TimelineWindow = (Object.keys(TIMELINE_WINDOWS) as TimelineWindow[]).includes(body?.window)
    ? body.window : 'day';

  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false,
      code: 'not_configured',
      error: `Tapestry timeline analysis needs Azure Data Explorer. Set ${gate.missing} (the ADX cluster that backs Loom graphs) and grant the Console UAMI Database Viewer. No Microsoft Fabric required.`,
    }, { status: 503 });
  }

  const db = String(body?.database || defaultDatabase());
  try {
    const { nodeTables, edgeTables } = await discoverGraphTables(db);
    if (edgeTables.length === 0) {
      return NextResponse.json({
        ok: false,
        error: 'No materialized graph found. Run Load sample data (kind=investigation) or materialize a graph model first (creates Edge_* tables in ADX).',
      }, { status: 400 });
    }

    const kql = buildTimelineKql(edgeTables, window);
    const result = await executeQuery(db, kql);
    return NextResponse.json({
      ok: true, backend: 'adx', window, database: db,
      graph: { nodeTables, edgeTables }, ...result,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    const raw = (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return NextResponse.json({ ok: false, error: raw.slice(0, 600) }, { status: status === 401 || status === 403 ? 200 : 502 });
  }
}
