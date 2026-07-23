/**
 * GET /api/admin/copilot-quality/[surface]?runId=<id> (E5)
 *
 * Per-surface drill-in for /admin/copilot-quality: the surface's run history
 * (eval-run docs, newest-first) plus the per-question `eval-result` docs for a
 * selected run (default: the latest run) ranked worst-first for the "worst
 * questions" table + drill-in dialog (expected vs retrieved chunks + judge
 * rationale). Both reads are SINGLE-PARTITION point queries (PK /surface).
 *
 * Tenant-admin scoped. Real Cosmos reads only (no-vaporware.md).
 */
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { copilotEvalsContainer } from '@/lib/azure/cosmos-client';
import type { CopilotEvalRunDoc, CopilotEvalResultDoc } from '@/lib/azure/copilot-evals-model';
import { worstQuestions, type RunRef } from '@/lib/admin/copilot-quality';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RUNS_QUERY =
  'SELECT * FROM c WHERE c.surface = @s AND c.docType = "eval-run" ORDER BY c.finishedAt DESC';
const RESULTS_QUERY =
  'SELECT * FROM c WHERE c.surface = @s AND c.docType = "eval-result" AND c.runId = @r';

export const GET = withTenantAdmin<{ surface: string }>(async (req, { params }) => {
  const surface = (params.surface || '').trim();
  if (!surface || surface === '#ledger') return apiError('invalid surface', 400);
  const runId = new URL(req.url).searchParams.get('runId') || undefined;

  try {
    const c = await copilotEvalsContainer();

    const { resources: runDocs } = await c.items
      .query<CopilotEvalRunDoc>({ query: RUNS_QUERY, parameters: [{ name: '@s', value: surface }] }, { partitionKey: surface })
      .fetchAll();
    const runs: RunRef[] = (runDocs ?? []).map((r) => ({
      runId: r.runId,
      finishedAt: r.finishedAt,
      startedAt: r.startedAt,
      trigger: r.trigger,
      corpusCommit: r.corpusCommit,
      judgeModel: r.judgeModel,
      totals: r.totals,
    }));

    if (runs.length === 0) {
      return apiOk({ surface, runs: [], selectedRunId: null, results: [], worst: [] });
    }

    const selectedRunId = runId && runs.some((r) => r.runId === runId) ? runId : runs[0].runId;
    const { resources: resultDocs } = await c.items
      .query<CopilotEvalResultDoc>(
        { query: RESULTS_QUERY, parameters: [{ name: '@s', value: surface }, { name: '@r', value: selectedRunId }] },
        { partitionKey: surface },
      )
      .fetchAll();
    const results = resultDocs ?? [];

    return apiOk({
      surface,
      runs,
      selectedRunId,
      results,
      worst: worstQuestions(results, 15),
    });
  } catch (e) {
    return apiServerError(e);
  }
});
