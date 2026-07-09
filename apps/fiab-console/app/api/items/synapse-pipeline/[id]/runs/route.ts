/**
 * GET /api/items/synapse-pipeline/[id]/runs?after=ISO&before=ISO&status=Succeeded|Failed|InProgress
 *
 *   — query pipeline runs filtered to the BOUND pipeline. Default window: last
 *     7 days. Optional date-range overrides via `after` (lastUpdatedAfter) and
 *     `before` (lastUpdatedBefore), both ISO-8601. Optional status filter adds
 *     a Status=Equals clause to the Synapse query.
 *
 * `[id]` is the Loom item GUID; the real pipeline name comes from the item's
 * state.pipelineName binding. Unbound items return an empty run list (the
 * editor shows the bind picker) rather than 412 — run history is a passive
 * panel and shouldn't hard-error before binding.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { queryPipelineRuns } from '@/lib/azure/synapse-dev-client';
import { resolveBinding, UnboundPipelineError, ItemNotFoundError } from '@/lib/azure/pipeline-binding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Accept the aliased persist form ('data-pipeline') alongside the native type —
// see pipeline-binding.ts loadPipelineItem for why.
const ACCEPTED_TYPES = ['synapse-pipeline', 'data-pipeline'];

const ALLOWED_STATUS = new Set(['Queued', 'InProgress', 'Succeeded', 'Failed', 'Cancelled', 'Cancelling']);

function emptyRuns(after?: string, before?: string, status?: string) {
  return NextResponse.json({
    ok: true,
    runs: [],
    continuationToken: undefined,
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

  // Resolve the bound Azure pipeline name. Unbound / unsaved items have no
  // runs yet — short-circuit with an empty list instead of querying Synapse
  // for a pipeline that doesn't exist (which surfaced as an opaque 502 in UAT).
  let pipelineName: string;
  try {
    ({ pipelineName } = await resolveBinding(id, ACCEPTED_TYPES, session.claims.oid));
  } catch (e) {
    if (e instanceof UnboundPipelineError || e instanceof ItemNotFoundError) {
      return emptyRuns(after, before, status);
    }
    return NextResponse.json({ ok: false, error: (e as any)?.message || String(e) }, { status: 502 });
  }

  const filters: Array<{ operand: string; operator: 'Equals' | 'NotEquals' | 'In' | 'NotIn'; values: string[] }> = [
    { operand: 'PipelineName', operator: 'Equals', values: [pipelineName] },
  ];
  if (status && ALLOWED_STATUS.has(status)) {
    filters.push({ operand: 'Status', operator: 'Equals', values: [status] });
  }
  try {
    const res = await queryPipelineRuns({
      filters,
      lastUpdatedAfter: after,
      lastUpdatedBefore: before,
    });
    return NextResponse.json({
      ok: true,
      runs: res.value || [],
      continuationToken: res.continuationToken,
      boundTo: pipelineName,
      window: { after: after || null, before: before || null, status: status || null },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
