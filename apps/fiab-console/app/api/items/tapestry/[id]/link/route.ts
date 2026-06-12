/**
 * POST /api/items/tapestry/[id]/link
 *   body: { analysis: 'pattern'|'shortest-path'|'components'|'neighbors',
 *           hops?: number, sourceId?: string, targetId?: string,
 *           nodeLabel?: string, limit?: number, database?: string }
 *
 * Tapestry link-analysis — the investigative graph pane. Azure-native: runs KQL
 * make-graph + graph-match / graph-shortest-paths / graph-mark-components over
 * the materialized Node_* / Edge_* ADX tables (the same tables the gql-graph
 * editor discovers). NO Microsoft Fabric dependency — ADX is the default and
 * only backend (per no-fabric-dependency.md). Returns rows shaped with
 * Source/Target columns so the client's extractGraph() renders the
 * force-directed canvas directly.
 *
 * Grounded in Microsoft Learn:
 *   https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-semantics-overview
 *   https://learn.microsoft.com/azure/data-explorer/kusto/query/graph-match-operator
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeQuery, kustoConfigGate, defaultDatabase, KustoError } from '@/lib/azure/kusto-client';
import {
  discoverGraphTables, buildGraphPrelude, buildLinkKql, isSafeId,
  type LinkAnalysis, type LinkParams,
} from '@/lib/azure/tapestry-graph';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ANALYSES: LinkAnalysis[] = ['pattern', 'shortest-path', 'components', 'neighbors'];

export async function POST(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const analysis: LinkAnalysis = ANALYSES.includes(body?.analysis) ? body.analysis : 'pattern';

  // Validate ids server-side (the editor uses typed controls — loom-no-freeform-config).
  for (const k of ['sourceId', 'targetId', 'nodeLabel'] as const) {
    const v = body?.[k];
    if (v != null && v !== '' && !isSafeId(String(v))) {
      return NextResponse.json({ ok: false, error: `${k} contains illegal characters` }, { status: 400 });
    }
  }
  if ((analysis === 'shortest-path') && (!body?.sourceId || !body?.targetId)) {
    return NextResponse.json({ ok: false, error: 'shortest-path requires both sourceId and targetId' }, { status: 400 });
  }
  if ((analysis === 'neighbors') && !body?.sourceId) {
    return NextResponse.json({ ok: false, error: 'neighbors requires a sourceId (the seed node)' }, { status: 400 });
  }

  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false,
      code: 'not_configured',
      error: `Tapestry link analysis needs Azure Data Explorer. Set ${gate.missing} (the ADX cluster that backs Loom graphs) and grant the Console UAMI Database Viewer. No Microsoft Fabric required.`,
    }, { status: 503 });
  }

  const db = String(body?.database || defaultDatabase());
  try {
    const { nodeTables, edgeTables } = await discoverGraphTables(db);
    if (nodeTables.length === 0 || edgeTables.length === 0) {
      return NextResponse.json({
        ok: false,
        error: 'No materialized graph found. Run Load sample data (kind=investigation) or materialize a graph model first (creates Node_*/Edge_* tables in ADX).',
      }, { status: 400 });
    }

    const prelude = buildGraphPrelude(nodeTables, edgeTables);
    const params: LinkParams = {
      analysis,
      hops: body?.hops,
      sourceId: body?.sourceId,
      targetId: body?.targetId,
      nodeLabel: body?.nodeLabel,
      limit: body?.limit,
    };
    const kql = buildLinkKql(prelude, params);
    const result = await executeQuery(db, kql);
    return NextResponse.json({
      ok: true, backend: 'adx', analysis, database: db,
      graph: { nodeTables, edgeTables }, ...result,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    const raw = (e?.message || String(e)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return NextResponse.json({ ok: false, error: raw.slice(0, 600) }, { status: status === 401 || status === 403 ? 200 : 502 });
  }
}
