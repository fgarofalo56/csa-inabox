/**
 * POST /api/items/report/[id]/query
 *
 * Executes a DAX query against the semantic-model that backs this report and
 * returns the result rows. Used by the Loom-native report renderer and the
 * Visual Designer in ReportLikeEditor / ReportEditor to populate every visual
 * — no Fabric capacity required (no-fabric-dependency.md).
 *
 * Two execution backends are dispatched based on the request body:
 *
 *   1. Power BI executeQueries (opt-in)
 *      Body: { workspaceId, datasetId, dax }
 *      Path: `executeDatasetQueries` against the Power BI REST `executeQueries`
 *      JSON endpoint. Works against ANY Power BI dataset regardless of its
 *      `loomSemanticBackend` (loom-native / powerbi / analysis-services) —
 *      dataset id is the only required reference. No Premium/Fabric capacity
 *      requirement. The Visual Designer surface only renders when a Power BI
 *      workspace + dataset are bound (an honest opt-in gate), so this route is
 *      never reached on the no-Fabric default path.
 *
 *   2. Azure Analysis Services (Azure-native default)
 *      Body: { query } | { visual: { type, field } }
 *      Path: `executeAasQuery` against the item's bound AAS server/database
 *      (state.aasServer / state.aasDatabase or LOOM_AAS_SERVER /
 *      LOOM_AAS_DATABASE). The Console UAMI must be a server admin on the AAS
 *      instance. When no binding exists the route returns 412 with the exact
 *      remediation env vars.
 *
 * Both backends generate a DAX EVALUATE statement (`buildDaxFromVisual` for
 * AAS, `dax-visual-compiler.ts` for the Visual Designer) — never hand-typed,
 * keeping the no-freeform-config promise of the editor.
 *
 * 200 OK → { ok: true, rows, dax | daxQuery }
 * 4xx/5xx → { ok: false, error, status? }
 *
 * Limits: executeQueries JSON caps at 100,000 rows / 1,000,000 values per
 * request. Visual queries are SUMMARIZECOLUMNS-aggregated; raw table visuals
 * are TOPN-capped by the compiler.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeDatasetQueries, PowerBiError } from '@/lib/azure/powerbi-client';
import {
  executeAasQuery,
  buildDaxFromVisual,
  flattenAasRows,
  resolveAasBinding,
  AasError,
} from '@/lib/azure/aas-client';
import { loadModelItem } from '@/lib/azure/model-binding';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface QueryRequest {
  // Power BI Visual Designer path
  workspaceId?: string;
  datasetId?: string;
  dax?: string;
  // AAS path (legacy / loom-native default)
  query?: string;
  visual?: { type: string; field?: string } & Record<string, unknown>;
}

function stateBinding(item: WorkspaceItem): { server?: string; database?: string } {
  const state = (item.state || {}) as Record<string, unknown>;
  return {
    server: typeof state.aasServer === 'string' ? state.aasServer : undefined,
    database: typeof state.aasDatabase === 'string' ? state.aasDatabase : undefined,
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as QueryRequest;

  // ------------------------------------------------------------------
  // Path 1 — Power BI executeQueries (Visual Designer)
  // ------------------------------------------------------------------
  const workspaceId = body.workspaceId?.trim();
  const datasetId = body.datasetId?.trim();
  const dax = body.dax?.trim();
  if (workspaceId && datasetId && dax) {
    const hasEvaluate = /\bEVALUATE\b/i.test(dax);
    if (!hasEvaluate) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'The visual has no fields yet — add a category/value field to generate a runnable query.',
        },
        { status: 400 },
      );
    }
    try {
      const result = await executeDatasetQueries(workspaceId, datasetId, dax);
      const table = result?.results?.[0]?.tables?.[0];
      return NextResponse.json({ ok: true, rows: table?.rows || [], dax });
    } catch (e: any) {
      const status = e instanceof PowerBiError ? e.status : 502;
      return NextResponse.json(
        { ok: false, error: e?.message || String(e), status },
        { status },
      );
    }
  }

  // ------------------------------------------------------------------
  // Path 2 — Azure Analysis Services (Azure-native default)
  // ------------------------------------------------------------------
  const id = (await ctx.params).id;
  const rawQuery: string = (body?.query || '').toString().trim();

  let item: WorkspaceItem | null;
  if (isLoomContentId(id)) {
    item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'report', session.claims.oid);
    if (!item) {
      return NextResponse.json({ ok: false, error: 'report template not found' }, { status: 404 });
    }
  } else {
    item = await loadModelItem(id, 'report', session.claims.oid);
    if (!item) {
      return NextResponse.json({ ok: false, error: 'report item not found' }, { status: 404 });
    }
  }

  const { server, database } = stateBinding(item);
  const binding = resolveAasBinding(server, database);
  if (!binding) {
    return NextResponse.json(
      {
        ok: false,
        code: 'unbound',
        error:
          'This report item has no Azure Analysis Services binding. Set state.aasServer ' +
          '(XMLA URI, e.g. asazure://eastus2.asazure.windows.net/my-server) + state.aasDatabase ' +
          'on the item, or configure LOOM_AAS_SERVER + LOOM_AAS_DATABASE environment variables. ' +
          'Or pass workspaceId+datasetId+dax to use the Power BI executeQueries path.',
      },
      { status: 412 },
    );
  }

  let daxQuery = rawQuery;
  if (!daxQuery && body?.visual) {
    daxQuery = buildDaxFromVisual(body.visual as { type: string; field?: string }) ?? '';
  }
  if (!daxQuery) {
    return NextResponse.json(
      { ok: false, error: 'query or visual.field required' },
      { status: 400 },
    );
  }

  try {
    const result = await executeAasQuery(binding.region, binding.serverName, binding.database, daxQuery);
    const rows = flattenAasRows(result);
    return NextResponse.json({ ok: true, rows, daxQuery });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
