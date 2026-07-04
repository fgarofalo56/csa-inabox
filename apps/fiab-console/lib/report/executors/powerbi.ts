/**
 * lib/report/executors/powerbi.ts — report /query dispatch Path 1.
 *
 * Power BI executeQueries (OPT-IN Visual Designer path). Extracted verbatim from
 * app/api/items/report/[id]/query/route.ts (rel-T64) — behaviour-preserving.
 * Reached ONLY when a Power BI workspace + dataset + DAX are bound, so it is never
 * on the default no-Fabric path (no-fabric-dependency.md).
 */

import { NextResponse } from 'next/server';
import { executeDatasetQueries, PowerBiError } from '@/lib/azure/powerbi-client';
import { wrapDaxWithFilters, type ReportFilterInput } from '@/lib/azure/wells-to-sql';

/**
 * Run the opt-in Power BI `executeQueries` path. The caller has already validated
 * that `workspaceId`, `datasetId`, and `dax` are all present. Filters are applied
 * via CALCULATETABLE when the dax is a wrappable EVALUATE.
 */
export async function executePowerBiQueryPath(
  workspaceId: string,
  datasetId: string,
  dax: string,
  filters: ReportFilterInput[] | undefined,
): Promise<NextResponse> {
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
  // Filters are applied via CALCULATETABLE when the dax is a wrappable EVALUATE.
  const wrapped = wrapDaxWithFilters(dax, filters);
  try {
    const result = await executeDatasetQueries(workspaceId, datasetId, wrapped);
    const table = result?.results?.[0]?.tables?.[0];
    return NextResponse.json({ ok: true, rows: table?.rows || [], dax: wrapped });
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), status },
      { status },
    );
  }
}
