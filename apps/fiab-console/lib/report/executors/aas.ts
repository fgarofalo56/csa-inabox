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
import { type UserExecutionContext } from './loom-native';

/**
 * Run the Azure Analysis Services XMLA path.
 *
 * EH-P1-OBO (#1800): when `user` is supplied (the report's data-access mode is
 * 'user' and the caller resolved the signed-in user's delegated AAS token via
 * user-pool-registry), the DAX query runs under the USER's own Azure identity —
 * XMLA accepts an AAD user bearer token; the user must have at least Read on the
 * AAS tabular model. Absent (the default) ⇒ the service identity, unchanged.
 */
export async function executeAasQueryPath(
  resolved: Extract<ResolvedReportModel, { backend: 'aas' }>,
  rawQuery: string,
  visual: (DaxVisual & Record<string, unknown>) | undefined,
  filters: ReportFilterInput[] | undefined,
  user?: UserExecutionContext,
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
      user?.token,
    );
    const rows = flattenAasRows(result);
    return NextResponse.json({ ok: true, rows, daxQuery });
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
