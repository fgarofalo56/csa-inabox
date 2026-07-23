/**
 * E5 — GET /api/admin/copilot-quality
 *
 * Per-surface Copilot quality summaries for the admin scorecard: the latest
 * `eval-run` roll-up per surface (retrieval hit-rate/MRR, grounding, pass-rate),
 * the run-history trend, the composite grade, and the E3 floor status. Reads the
 * REAL Cosmos `loom-copilot-evals` docs the copilot-evaluator Function (E2)
 * writes + the staged eval-floors.json — no mocks, no Fabric dependency.
 *
 * Tenant-admin only (route-toolkit withTenantAdmin). Cached 5 min with a
 * wall-clock budget + serve-stale-on-error so a cold Cosmos scan never 504s the
 * admin page. `?refresh=1` bypasses the cache.
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiServerError } from '@/lib/api/respond';
import { getOrComputeCached } from '@/lib/azure/query-result-cache';
import { listEvalRuns, loadEvalFloors } from '@/lib/azure/copilot-quality-store';
import { buildSurfaceSummaries, buildOverview } from '@/lib/admin/copilot-quality';
import { evaluatorRunGate } from '@/lib/azure/copilot-evaluator-client';
import { runtimeFlag } from '@/lib/admin/runtime-flags';

export const dynamic = 'force-dynamic';

export const GET = withTenantAdmin(async (req: NextRequest) => {
  try {
    const bypass = new URL(req.url).searchParams.get('refresh') === '1';
    const flagEnabled = await runtimeFlag('e5-copilot-quality-page');

    const { value, meta } = await getOrComputeCached(
      'copilot-quality:summaries',
      'copilot-quality',
      async () => {
        const [runs, floorsFile] = await Promise.all([listEvalRuns(), Promise.resolve(loadEvalFloors())]);
        const summaries = buildSurfaceSummaries(runs, floorsFile.floors);
        return { summaries, overview: buildOverview(summaries), floorsMeta: floorsFile.meta ?? null };
      },
      { ttlMs: 5 * 60_000, budgetMs: 20_000, serveStaleOnError: true, counterBackend: 'result-cache' },
    );

    return apiOk({
      flagEnabled,
      surfaces: value.summaries,
      overview: value.overview,
      floorsMeta: value.floorsMeta,
      // Honest evaluator posture: the "Run now" button is live only when the
      // Function URL is wired; the page still renders historical scores either way.
      evaluatorConfigured: evaluatorRunGate() === null,
      cache: { stale: meta.stale, cachedAt: meta.cachedAt },
    });
  } catch (e) {
    return apiServerError(e, 'failed to load copilot quality summaries', 'copilot_quality_read_failed');
  }
});
