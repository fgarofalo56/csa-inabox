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
 *
 * OWNERSHIP (round-3 remediation of the LU-8 review's S2 CLASS). `?runId=` is
 * caller-supplied and Synapse run ids are WORKSPACE-scoped, not item-scoped, so
 * without a check any authenticated owner of any Loom pipeline item could read
 * ANOTHER pipeline's per-activity `input`/`output` payloads — which carry the
 * source/sink connection details, storage paths and row counts of a run they
 * have no claim to. The sibling `data-pipeline/[id]/output` route grew this
 * gate; this route and `adf-pipeline/[id]/runs` had the identical shape and
 * were left open, which is precisely the "close the reported call site, leave
 * the sibling" pattern the review named. All three now prove
 * `run.pipelineName === <the item's bound pipeline>` BEFORE reading activities.
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryPipelineRuns, listActivityRuns, getPipelineRunOrNull } from '@/lib/azure/synapse-dev-client';
import { resolveBinding, UnboundPipelineError, ItemNotFoundError } from '@/lib/azure/pipeline-binding';
import { withSession } from '@/lib/api/route-toolkit';

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

export const GET = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const { id } = params;
  const after = req.nextUrl.searchParams.get('after') || undefined;
  const before = req.nextUrl.searchParams.get('before') || undefined;
  const status = req.nextUrl.searchParams.get('status') || undefined;
  // U13 — `?runId=` drills one run into its per-activity receipts
  // (queryActivityruns), feeding the in-canvas Debug/Output overlay.
  const runId = req.nextUrl.searchParams.get('runId') || undefined;

  // Resolve the bound Azure pipeline name. Unbound / unsaved items have no
  // runs yet — short-circuit with an empty list instead of querying Synapse
  // for a pipeline that doesn't exist (which surfaced as an opaque 502 in UAT).
  let pipelineName: string;
  try {
    ({ pipelineName } = await resolveBinding(id, ACCEPTED_TYPES, session.claims.oid));
  } catch (e) {
    if (e instanceof UnboundPipelineError || e instanceof ItemNotFoundError) {
      if (runId) return NextResponse.json({ ok: true, runId, activities: [] });
      return emptyRuns(after, before, status);
    }
    return NextResponse.json({ ok: false, error: (e as any)?.message || String(e) }, { status: 502 });
  }

  if (runId) {
    try {
      // OWNERSHIP FIRST — prove the run belongs to the BOUND pipeline before
      // any activity payload is read. A 404 (not 403) so the response cannot
      // be used to enumerate which run ids exist in the workspace.
      const run = await getPipelineRunOrNull(runId);
      if (!run || run.pipelineName !== pipelineName) {
        return NextResponse.json({ ok: false, error: 'run not found' }, { status: 404 });
      }
      const acts = await listActivityRuns(runId);
      return NextResponse.json({
        ok: true,
        runId,
        boundTo: pipelineName,
        activities: acts.map((a) => ({
          id: a.activityRunId,
          name: a.activityName,
          type: a.activityType,
          status: a.status,
          start: a.activityRunStart,
          end: a.activityRunEnd,
          durationMs: a.durationInMs,
          input: a.input,
          output: a.output,
          error: a.error?.message || null,
          errorCode: a.error?.errorCode || null,
        })),
      });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
    }
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
});
