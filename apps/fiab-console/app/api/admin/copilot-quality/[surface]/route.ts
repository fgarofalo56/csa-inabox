/**
 * E5 — GET /api/admin/copilot-quality/[surface]
 *
 * Drill-in for one Copilot surface: the run history (newest first) + the
 * per-question `eval-result` docs of a chosen run (default: the latest), ranked
 * worst-first for the drill-in table (forbidden phrases, retrieval misses, low
 * grounding, missed mentions, judge errors). Single-partition Cosmos reads
 * (PK /surface). Real data only — the judge rationale shown is the LLM judge's
 * own text (E2). Tenant-admin only.
 *
 *   ?run=<runId>   pick a specific run (else the latest)
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiBadRequest, apiServerError } from '@/lib/api/respond';
import { surfaceRunHistory, surfaceResults } from '@/lib/azure/copilot-quality-store';
import { worstQuestions } from '@/lib/admin/copilot-quality';

export const dynamic = 'force-dynamic';

export const GET = withTenantAdmin(async (req: NextRequest, { params }) => {
  try {
    const surface = String((params as { surface?: string }).surface || '').trim();
    if (!surface || surface.startsWith('#')) return apiBadRequest('surface required');
    const runId = new URL(req.url).searchParams.get('run') || undefined;

    const [history, resolved] = await Promise.all([
      surfaceRunHistory(surface),
      surfaceResults(surface, runId),
    ]);

    return apiOk({
      surface,
      runId: resolved.runId,
      history: history.map((r) => ({
        runId: r.runId,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        trigger: r.trigger,
        judgeModel: r.judgeModel,
        corpusCommit: r.corpusCommit,
        totals: r.totals,
      })),
      worst: worstQuestions(resolved.results),
      resultCount: resolved.results.length,
    });
  } catch (e) {
    return apiServerError(e, 'failed to load surface drill-in', 'copilot_quality_surface_failed');
  }
});
