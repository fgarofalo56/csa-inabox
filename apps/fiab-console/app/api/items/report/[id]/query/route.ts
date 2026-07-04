/**
 * POST /api/items/report/[id]/query
 *
 * Executes a report visual against the data source that backs this report and
 * returns the result rows. Used by the Loom-native report renderer and the
 * Visual Designer in ReportLikeEditor / ReportEditor to populate every visual
 * — no Fabric capacity required (no-fabric-dependency.md).
 *
 * This route is a THIN DISPATCHER (rel-T64): it validates the session, resolves
 * the report's data source → backend (Azure-native default), and delegates to the
 * per-backend executor. The heavy lifting lives in reusable lib modules:
 *   • lib/report/query-projection.ts — resolved model → single-FROM wells→SQL
 *     projection (shared with the /script-visual route);
 *   • lib/report/transform-fold.ts   — Power Query "Transform data" fold + the
 *     per-table Import/Dual connection Delta-cache read;
 *   • lib/report/executors/{powerbi,loom-native,connection,aas}.ts — one executor
 *     per dispatch backend. The request/response contract, gating, and every real
 *     backend call are unchanged from the original monolithic route.
 *
 * FOUR execution backends are dispatched:
 *
 *   1. Power BI executeQueries (opt-in)
 *      Body: { workspaceId, datasetId, dax }
 *      Reached ONLY when a Power BI workspace + dataset are bound
 *      (`NEXT_PUBLIC_LOOM_BI_BACKEND=powerbi`), so it is never on the default
 *      no-Fabric path. → lib/report/executors/powerbi.ts
 *
 *   2. Azure Analysis Services (advanced / back-compat)
 *      Body: { query } | { visual } | { filters }
 *      DAX from `body.query` (raw) or `buildDaxFromVisual(body.visual)`; the
 *      structured Filters pane is appended via `wrapDaxWithFilters`
 *      (CALCULATETABLE) — the user never types DAX. → lib/report/executors/aas.ts
 *
 *   3. Loom-native SQL over Synapse (Azure-native DEFAULT — report-designer v2)
 *      Body: { visual, filters }
 *      The field wells compile into a parameterized `SELECT … GROUP BY` and the
 *      structured filters into a `WHERE`/`HAVING`; the query runs through the
 *      query-acceleration orchestrator (accel → cache → serverless Synapse). REAL
 *      aggregated rows, NO AAS / Power BI / Fabric, no mock (no-vaporware.md).
 *      Identifiers are whitelisted from the resolved model and bracket-quoted;
 *      values bind as TDS parameters (injection-safe).
 *      → lib/report/executors/loom-native.ts (projection + transform-fold libs)
 *
 *   4. Get Data (a connection / file-backed source)
 *      Body: { visual, filters }
 *      The resolver wired a REAL Azure data-plane `ConnectionExecutor`
 *      (azure-sql / synapse / databricks / postgres / cosmos / serverless
 *      OPENROWSET). → lib/report/executors/connection.ts
 *
 * When no data source is configured the resolver returns an honest 412 gate
 * naming the exact remediation ("pick a data source", or the precise AAS /
 * Synapse env var) — never a silent empty result.
 *
 * 200 OK → { ok: true, rows, sql | daxQuery }
 * 412    → { ok: false, code: 'unbound', error } (honest, actionable)
 * 4xx/5xx → { ok: false, error, status? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { AasError, type DaxVisual } from '@/lib/azure/aas-client';
import { loadModelItem } from '@/lib/azure/model-binding';
import {
  resolveReportModel,
  type ResolvedReportModel,
} from '@/lib/azure/report-model-resolver';
import {
  type ReportFilterInput,
  type DrillState,
  type ScalarParamBinding,
  type VisualCompileOptions,
} from '@/lib/azure/wells-to-sql';
import {
  isLoomContentId,
  cosmosIdFromLoomId,
  loadContentBackedItem,
} from '../../../_lib/pbi-content-fallback';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { executePowerBiQueryPath } from '@/lib/report/executors/powerbi';
import { executeAasQueryPath } from '@/lib/report/executors/aas';
import { executeLoomNativeQueryPath } from '@/lib/report/executors/loom-native';
import { executeConnectionQueryPath } from '@/lib/report/executors/connection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface QueryRequest {
  // Path 1 — Power BI Visual Designer path (opt-in)
  workspaceId?: string;
  datasetId?: string;
  dax?: string;
  // Path 2 — AAS (legacy single-field + rich field wells from the designer)
  query?: string;
  visual?: DaxVisual & Record<string, unknown>;
  // Paths 2 + 3 — structured Filters-pane predicates (report/page/visual scope,
  // already merged by the designer). Compiled to a DAX CALCULATETABLE (AAS) or a
  // SQL WHERE/HAVING (loom-native) server-side — the user never types DAX/SQL.
  filters?: ReportFilterInput[];
  // Wave-8 interactivity (additive; undefined ⇒ byte-identical compile):
  //   • `drill` — the in-visual drill state (active hierarchy level + ancestor
  //     path) so the loom-native compiler truncates the GROUP BY + adds the path
  //     WHERE, re-querying REAL Synapse rows for the sub-level.
  //   • `whatIf` — bound numeric what-if values flowed into the value aggregates.
  // Forwarded straight to `buildSqlFromVisual`'s 4th options arg.
  drill?: DrillState;
  whatIf?: ScalarParamBinding[];
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as QueryRequest;
  const filters = Array.isArray(body.filters) ? body.filters : undefined;
  // Wave-8 interactivity compile options (drill + what-if). Structured + bounded
  // by the wells-to-sql compiler; undefined ⇒ the pre-Wave-8 compile (no change).
  const compileOpts: VisualCompileOptions | undefined =
    body.drill || (Array.isArray(body.whatIf) && body.whatIf.length)
      ? { ...(body.drill ? { drill: body.drill } : {}), ...(Array.isArray(body.whatIf) ? { whatIf: body.whatIf } : {}) }
      : undefined;

  // ------------------------------------------------------------------
  // Path 1 — Power BI executeQueries (opt-in Visual Designer path)
  // ------------------------------------------------------------------
  const workspaceId = body.workspaceId?.trim();
  const datasetId = body.datasetId?.trim();
  const dax = body.dax?.trim();
  if (workspaceId && datasetId && dax) {
    return executePowerBiQueryPath(workspaceId, datasetId, dax, filters);
  }

  // ------------------------------------------------------------------
  // Load the report item (loom: content id OR plain Cosmos id), owner-checked.
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

  // ------------------------------------------------------------------
  // Resolve the report's DATA SOURCE → backend (Azure-native default). This is
  // the one place the sourcing logic lives; the route just dispatches.
  // ------------------------------------------------------------------
  let resolved: ResolvedReportModel;
  try {
    resolved = await resolveReportModel(item, session.claims.oid);
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
  }

  // Honest gate — name the exact remediation ("pick a data source", or the
  // precise AAS / Synapse env var), never a silent empty result.
  if (resolved.backend === 'unbound') {
    return NextResponse.json(
      { ok: false, code: 'unbound', error: resolved.gate.error },
      { status: 412 },
    );
  }

  // ------------------------------------------------------------------
  // Path 3 — Loom-native SQL over Synapse (Azure-native DEFAULT)
  // ------------------------------------------------------------------
  if (resolved.backend === 'loom-native') {
    return executeLoomNativeQueryPath(item, resolved, body.visual, filters, compileOpts);
  }

  // ------------------------------------------------------------------
  // Path 4 — Get Data (a connection / file-backed report source, Azure-native).
  // ------------------------------------------------------------------
  if (resolved.backend === 'connection') {
    return executeConnectionQueryPath(item, resolved, body.visual, filters);
  }

  // ------------------------------------------------------------------
  // Path 2 — Azure Analysis Services (advanced / back-compat)
  // ------------------------------------------------------------------
  return executeAasQueryPath(resolved, rawQuery, body.visual, filters);
}
