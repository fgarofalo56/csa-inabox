/**
 * POST /api/items/semantic-model/[id]/model?workspaceId=...
 *
 * Authoring surface for model edits that genuinely require the XMLA endpoint
 * (the Power BI REST push-dataset path can't express them). The first such
 * surface is **Automatic aggregations**: it writes a Tabular aggregation table
 * whose every column carries an `alternateOf` (BaseTable/BaseColumn +
 * Summarization) via a TMSL `createOrReplace` over XMLA, so the AS engine
 * automatically rewrites matching queries to the (small, Import) agg table and
 * falls through to the (large, DirectQuery) detail table otherwise.
 *
 * Body: {
 *   action?: 'aggregation',           // default — only mode today
 *   aggTableName: string,
 *   partitionExpression: string,      // M expression for the agg partition
 *   altMaps: AltMap[],                // per-column GroupBy/Sum/Count/Min/Max maps
 *   probeQuery?: string               // optional DAX run after apply to verify a hit
 * }
 *
 * 200 { ok: true, catalog, applied: true, probeResult?: { rows } }
 *   — TMSL applied; if probeQuery supplied, ran it to prove the agg answers.
 * 200 { ok: false, xmlaUnavailable: true, missing, detail }
 *   — honest infra-gate (no XMLA endpoint configured). NOT a 4xx so the UI can
 *     distinguish "not configured" from "error". Per no-vaporware.md.
 * 4xx/5xx { ok: false, error, status }
 *
 * No mocks — calls the real XMLA endpoint + Power BI executeQueries. The agg
 * table is written to whatever XMLA endpoint the operator configured (Azure
 * Analysis Services by default; a Premium/Fabric XMLA endpoint is opt-in by
 * URL), so there is no hard Fabric dependency. See no-fabric-dependency.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getDataset, executeDatasetQueries, PowerBiError } from '@/lib/azure/powerbi-client';
import {
  xmlaConfigGate, buildAggTableTmsl, executeTmsl, AasError,
  type AltMap, type AggSummarization,
} from '@/lib/azure/aas-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_SUMMARIZATIONS: AggSummarization[] = ['GroupBy', 'Sum', 'Count', 'Min', 'Max'];

interface ModelRequest {
  action?: string;
  aggTableName?: string;
  partitionExpression?: string;
  altMaps?: Array<{
    aggColumn?: string;
    dataType?: string;
    summarization?: string;
    detailTable?: string;
    detailColumn?: string;
  }>;
  probeQuery?: string;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => ({}))) as ModelRequest;
  const action = (body.action || 'aggregation').trim();
  if (action !== 'aggregation') {
    return NextResponse.json({ ok: false, error: `unsupported action "${action}"` }, { status: 400 });
  }

  const aggTableName = (body.aggTableName || '').trim();
  const partitionExpression = (body.partitionExpression || '').trim();
  if (!aggTableName) return NextResponse.json({ ok: false, error: 'aggTableName is required' }, { status: 400 });
  if (!partitionExpression) return NextResponse.json({ ok: false, error: 'partitionExpression (M) is required' }, { status: 400 });
  if (!Array.isArray(body.altMaps) || body.altMaps.length === 0) {
    return NextResponse.json({ ok: false, error: 'at least one altMap (aggregation mapping) is required' }, { status: 400 });
  }

  // Validate + normalize the per-column mappings before touching XMLA so a
  // bad shape returns a precise 400 rather than an opaque engine fault.
  const altMaps: AltMap[] = [];
  for (const m of body.altMaps) {
    const aggColumn = (m.aggColumn || '').trim();
    const detailTable = (m.detailTable || '').trim();
    const summarization = (m.summarization || '').trim() as AggSummarization;
    if (!aggColumn) return NextResponse.json({ ok: false, error: 'every mapping needs an aggregation column name' }, { status: 400 });
    if (!detailTable) return NextResponse.json({ ok: false, error: `mapping "${aggColumn}" needs a detail table` }, { status: 400 });
    if (!VALID_SUMMARIZATIONS.includes(summarization)) {
      return NextResponse.json({ ok: false, error: `mapping "${aggColumn}" has invalid summarization "${m.summarization}". Allowed: ${VALID_SUMMARIZATIONS.join(', ')}` }, { status: 400 });
    }
    const detailColumn = (m.detailColumn || '').trim();
    // Only Count may omit a detail column (counts detail-table rows). All other
    // summarizations need a base column to aggregate / group by.
    if (!detailColumn && summarization !== 'Count') {
      return NextResponse.json({ ok: false, error: `mapping "${aggColumn}" (${summarization}) needs a detail column` }, { status: 400 });
    }
    altMaps.push({
      aggColumn,
      dataType: (m.dataType || 'double').trim() || 'double',
      summarization,
      detailTable,
      detailColumn: detailColumn || undefined,
    });
  }

  // Honest infra-gate: no XMLA endpoint → 200 with xmlaUnavailable so the editor
  // renders the precise remediation MessageBar (not a raw error).
  const gate = xmlaConfigGate();
  if (gate) {
    return NextResponse.json({ ok: false, xmlaUnavailable: true, missing: gate.missing, detail: gate.detail });
  }

  // Resolve the model's name — that is the XMLA catalog the TMSL targets.
  let catalog: string;
  try {
    const ds = await getDataset(workspaceId, id);
    catalog = ds?.name;
    if (!catalog) return NextResponse.json({ ok: false, error: 'could not resolve the model name (XMLA catalog)' }, { status: 404 });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }

  const tmsl = buildAggTableTmsl({ database: catalog, aggTableName, partitionExpression, altMaps });

  try {
    await executeTmsl(catalog, tmsl);
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }

  // Optional probe: run a DAX query at the agg grain to prove the engine now
  // answers it (and, via the server query plan / "Aggregate Table Rewrite
  // Query" trace event, routes it to the agg table). Probe failure does NOT
  // fail the apply — the TMSL already succeeded.
  let probeResult: { rows: Array<Record<string, unknown>> } | undefined;
  let probeError: string | undefined;
  const probeQuery = (body.probeQuery || '').trim();
  if (probeQuery) {
    try {
      const j = await executeDatasetQueries(workspaceId, id, probeQuery);
      probeResult = { rows: j?.results?.[0]?.tables?.[0]?.rows || [] };
    } catch (e: any) {
      probeError = e?.message || String(e);
    }
  }

  return NextResponse.json({
    ok: true,
    applied: true,
    catalog,
    aggTableName,
    columns: altMaps.length,
    probeResult,
    probeError,
    verify:
      'Confirm the query-plan hit with SQL Profiler / SSMS XEvents: the "Aggregate Table Rewrite Query" ' +
      'event reports matchingResult=matchFound when a query is answered by the agg table; a query below ' +
      'the agg grain falls through to the DirectQuery detail table.',
  });
}
