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
 *
 * OWNERSHIP (round-3 remediation of the LU-8 review's S2 CLASS). ADF run ids
 * are FACTORY-scoped, not item-scoped: `?runId=` used to go straight into
 * `listActivityRuns`, so an authenticated owner of any Loom pipeline item could
 * read another pipeline's per-activity `input`/`output` payloads — the source
 * and sink connection details, storage paths and row counts of a run they have
 * no claim to. `getPipelineRun` under the SAME factory override now proves
 * `run.pipelineName === pipelineName` first (the override matters: the oracle
 * must be evaluated in the factory the activities will be read from, or it
 * proves nothing about them).
 */

import { NextRequest, NextResponse } from 'next/server';
import { listPipelineRuns, listActivityRuns, getPipelineRun } from '@/lib/azure/adf-client';
import { withFactoryOverride } from '@/lib/azure/adf-factory-context';
import { resolveBinding, UnboundPipelineError, ItemNotFoundError, bindingFactoryOverride } from '@/lib/azure/pipeline-binding';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Accept the aliased persist form ('data-pipeline') alongside the native type —
// see pipeline-binding.ts loadPipelineItem for why.
const ACCEPTED_TYPES = ['adf-pipeline', 'data-pipeline'];

const ALLOWED_STATUS = new Set(['Queued', 'InProgress', 'Succeeded', 'Failed', 'Cancelled', 'Cancelling']);

function emptyRuns(after?: string, before?: string, status?: string) {
  return NextResponse.json({
    ok: true,
    runs: [],
    window: { after: after || null, before: before || null, status: status || null },
  });
}

export const GET = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const { id } = params;
  const after = req.nextUrl.searchParams.get('after') || undefined;
  const before = req.nextUrl.searchParams.get('before') || undefined;
  const status = req.nextUrl.searchParams.get('status') || undefined;
  // U13 — `?runId=` drills one run into its per-activity receipts
  // (queryActivityRuns), feeding the in-canvas Debug/Output overlay.
  const runId = req.nextUrl.searchParams.get('runId') || undefined;

  let binding: Awaited<ReturnType<typeof resolveBinding>>;
  try {
    binding = await resolveBinding(id, ACCEPTED_TYPES, session.claims.oid);
  } catch (e) {
    if (e instanceof UnboundPipelineError || e instanceof ItemNotFoundError) {
      if (runId) return NextResponse.json({ ok: true, runId, activities: [] });
      return emptyRuns(after, before, status);
    }
    return NextResponse.json({ ok: false, error: (e as any)?.message || String(e) }, { status: 502 });
  }
  const { pipelineName } = binding;

  if (runId) {
    try {
      // OWNERSHIP FIRST — inside the binding's factory override, so the run we
      // authorize is the run whose activities we then read. 404 (not 403) so
      // the response cannot enumerate run ids. `getPipelineRun` returns null
      // ONLY on a real ARM 404; a transient 429/5xx throws and surfaces as 502
      // rather than telling the owner their run vanished.
      const acts = await withFactoryOverride(bindingFactoryOverride(binding), async () => {
        const run = await getPipelineRun(runId);
        if (!run || run.pipelineName !== pipelineName) return null;
        return listActivityRuns(runId);
      });
      if (!acts) return NextResponse.json({ ok: false, error: 'run not found' }, { status: 404 });
      return NextResponse.json({
        ok: true,
        runId,
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

  // Convert an `after` ISO override into a windowDays figure for the client
  // helper (which builds the lastUpdatedAfter/Before envelope). Default 7d.
  let windowDays = 7;
  if (after) {
    const ms = Date.now() - new Date(after).getTime();
    if (Number.isFinite(ms) && ms > 0) windowDays = Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  }

  try {
    let runs = await withFactoryOverride(bindingFactoryOverride(binding), () => listPipelineRuns(pipelineName, windowDays));
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
});
