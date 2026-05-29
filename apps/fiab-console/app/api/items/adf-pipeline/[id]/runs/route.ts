/**
 * GET /api/items/adf-pipeline/[id]/runs?after=ISO&before=ISO&status=Succeeded|Failed|InProgress
 *
 *   — query pipeline runs filtered to the BOUND pipeline via ADF's
 *     queryPipelineRuns (POST factories/{f}/queryPipelineRuns). Default window:
 *     last 7 days; the optional status filter is applied client-side here since
 *     adf-client.listPipelineRuns already filters by PipelineName server-side.
 *
 * Root cause this route fixes: the ADF editor fetched `/runs` but NO route file
 * existed → Next returned a 404 *HTML* page, and `await r.json()` in the editor
 * threw on the HTML. This route now exists and returns structured JSON.
 *
 * `[id]` is the Loom item GUID; the real pipeline name comes from the item's
 * state.pipelineName binding. Unbound / not-found items return an empty run
 * list (the editor shows the bind picker) — run history is a passive panel.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listPipelineRuns } from '@/lib/azure/adf-client';
import { resolveBinding, UnboundPipelineError, ItemNotFoundError } from '@/lib/azure/pipeline-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_STATUS = new Set(['Queued', 'InProgress', 'Succeeded', 'Failed', 'Cancelled', 'Cancelling']);

function emptyRuns(after?: string, before?: string, status?: string) {
  return NextResponse.json({
    ok: true,
    runs: [],
    window: { after: after || null, before: before || null, status: status || null },
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const after = req.nextUrl.searchParams.get('after') || undefined;
  const before = req.nextUrl.searchParams.get('before') || undefined;
  const status = req.nextUrl.searchParams.get('status') || undefined;

  let pipelineName: string;
  try {
    ({ pipelineName } = await resolveBinding(id, 'adf-pipeline', session.claims.oid));
  } catch (e) {
    if (e instanceof UnboundPipelineError || e instanceof ItemNotFoundError) {
      return emptyRuns(after, before, status);
    }
    return NextResponse.json({ ok: false, error: (e as any)?.message || String(e) }, { status: 502 });
  }

  // Convert an `after` ISO override into a windowDays figure for the client
  // helper (which builds the lastUpdatedAfter/Before envelope). Default 7d.
  let windowDays = 7;
  if (after) {
    const ms = Date.now() - new Date(after).getTime();
    if (Number.isFinite(ms) && ms > 0) windowDays = Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  }

  try {
    let runs = await listPipelineRuns(pipelineName, windowDays);
    if (status && ALLOWED_STATUS.has(status)) {
      runs = runs.filter((r) => r.status === status);
    }
    return NextResponse.json({
      ok: true,
      runs,
      boundTo: pipelineName,
      window: { after: after || null, before: before || null, status: status || null },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
