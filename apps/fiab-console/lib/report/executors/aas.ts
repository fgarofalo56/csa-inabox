/**
 * lib/report/executors/aas.ts — report /query dispatch Path 2.
 *
 * Azure Analysis Services (advanced / back-compat). Extracted verbatim from
 * app/api/items/report/[id]/query/route.ts (rel-T64) — behaviour-preserving. The
 * DAX comes from `rawQuery` (raw) or `buildDaxFromVisual(visual)` (never hand-
 * typed), and the structured Filters pane is appended via `wrapDaxWithFilters`
 * (CALCULATETABLE) — so the user never types DAX (no-freeform-config.md).
 */

import { NextResponse } from 'next/server';
import {
  executeAasQuery,
  buildDaxFromVisual,
  flattenAasRows,
  AasError,
  type DaxVisual,
} from '@/lib/azure/aas-client';
import { wrapDaxWithFilters, type ReportFilterInput } from '@/lib/azure/wells-to-sql';
import { type ResolvedReportModel } from '@/lib/azure/report-model-resolver';

/** Run the Azure Analysis Services XMLA path. */
export async function executeAasQueryPath(
  resolved: Extract<ResolvedReportModel, { backend: 'aas' }>,
  rawQuery: string,
  visual: (DaxVisual & Record<string, unknown>) | undefined,
  filters: ReportFilterInput[] | undefined,
): Promise<NextResponse> {
  let daxQuery = rawQuery;
  if (!daxQuery && visual) {
    daxQuery = buildDaxFromVisual(visual) ?? '';
  }
  if (!daxQuery) {
    return NextResponse.json(
      { ok: false, error: 'query or visual.field required' },
      { status: 400 },
    );
  }
  // Append the structured Filters pane as a CALCULATETABLE wrapper (no-op when
  // there are no applicable filters or the DAX isn't a wrappable EVALUATE).
  daxQuery = wrapDaxWithFilters(daxQuery, filters);

  try {
    const result = await executeAasQuery(
      resolved.binding.region,
      resolved.binding.serverName,
      resolved.binding.database,
      daxQuery,
    );
    const rows = flattenAasRows(result);
    return NextResponse.json({ ok: true, rows, daxQuery });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
