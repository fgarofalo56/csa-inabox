/**
 * E6 — GET /api/admin/copilot-quality/tier
 *
 * Tier-router decision quality for the E5 "Tier routing" tab: the latest
 * `tier-run` rollup (tierAccuracy + task-class accuracy + the tier confusion
 * matrix + per-class accuracy), the accuracy trend, the composite grade, the E3
 * `tierFloors` status, a per-tier cost-per-quality view (judged grounding per
 * estimated $ using the cost-estimate per-tier price coefficients), and the
 * misrouted-prompt drill-in. Reads the REAL Cosmos `loom-copilot-evals` docs the
 * copilot-evaluator tier mode writes — no mocks, no Fabric dependency.
 *
 * Tenant-admin only; cached 5 min with serve-stale-on-error. FLAG0
 * e6-tier-routing-tab gates the surface (default-ON; OFF hides the tab body).
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiServerError } from '@/lib/api/respond';
import { getOrComputeCached } from '@/lib/azure/query-result-cache';
import {
  listTierRuns, listEvalRuns, loadEvalFloors, tierRunResults,
} from '@/lib/azure/copilot-quality-store';
import {
  buildTierSummary, buildSurfaceSummaries, buildOverview, tierCostPerQuality,
} from '@/lib/admin/copilot-quality';
import { evaluatorRunGate } from '@/lib/azure/copilot-evaluator-client';
import { runtimeFlag } from '@/lib/admin/runtime-flags';

export const dynamic = 'force-dynamic';

export const GET = withTenantAdmin(async (req: NextRequest) => {
  try {
    const url = new URL(req.url);
    const bypass = url.searchParams.get('refresh') === '1';
    const wantDrill = url.searchParams.get('drill') === '1';
    const flagEnabled = await runtimeFlag('e6-tier-routing-tab');

    const { value } = await getOrComputeCached(
      'copilot-quality:tier-summary',
      'copilot-quality',
      async () => {
        const [tierRuns, evalRuns, floorsFile] = await Promise.all([
          listTierRuns(),
          listEvalRuns(),
          Promise.resolve(loadEvalFloors()),
        ]);
        const summary = buildTierSummary(tierRuns, floorsFile.tierFloors);
        // Cost-per-quality reuses the program-wide judged grounding from the
        // answer-quality runs (the tier eval itself is deterministic / unjudged).
        const overview = buildOverview(buildSurfaceSummaries(evalRuns, floorsFile.floors));
        return {
          summary,
          meanGrounding: overview.meanGrounding,
          costPerQuality: tierCostPerQuality(overview.meanGrounding),
        };
      },
      { ttlMs: 5 * 60_000, budgetMs: 20_000, serveStaleOnError: true, bypass, counterBackend: 'result-cache' },
    );

    // Misrouted-prompt drill-in (incorrect decisions first) for the latest run.
    let drill: {
      runId: string | null;
      decisions: Array<{ rowId: string; prompt: string; expectedTier: string; chosenTier: string; taskClass: string; chosenTaskClass: string; correct: boolean; deployment?: string }>;
    } | undefined;
    if (wantDrill) {
      const resolved = await tierRunResults();
      const decisions = [...resolved.results]
        .sort((a, b) => Number(a.correct) - Number(b.correct) || a.rowId.localeCompare(b.rowId))
        .map((r) => ({
          rowId: r.rowId, prompt: r.prompt, expectedTier: r.expectedTier, chosenTier: r.chosenTier,
          taskClass: r.taskClass, chosenTaskClass: r.chosenTaskClass, correct: r.correct, deployment: r.deployment,
        }));
      drill = { runId: resolved.runId, decisions };
    }

    return apiOk({
      flagEnabled,
      tier: value.summary,
      meanGrounding: value.meanGrounding,
      costPerQuality: value.costPerQuality,
      drill,
      evaluatorConfigured: evaluatorRunGate() === null,
    });
  } catch (e) {
    return apiServerError(e, 'failed to load tier routing summary', 'tier_quality_read_failed');
  }
});
