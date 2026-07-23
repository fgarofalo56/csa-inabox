/**
 * SRCH1 — GET /api/admin/copilot-quality/search
 *
 * Per-domain federated-search relevance summaries for the E5 "Search relevance"
 * tab: the latest `search-run` rollup per domain (hit-rate@k / MRR / NDCG@k),
 * the trend, the composite grade, and the E3 searchFloors status. Reads the REAL
 * Cosmos `loom-copilot-evals` docs the copilot-evaluator Function's
 * searchRelevance mode writes. Tenant-admin only; cached 5 min.
 *
 *   ?domain=<d>  → also return that domain's per-query drill-in (worst first).
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiServerError } from '@/lib/api/respond';
import { getOrComputeCached } from '@/lib/azure/query-result-cache';
import { listSearchRuns, loadEvalFloors, searchDomainResults } from '@/lib/azure/copilot-quality-store';
import { buildSearchSummaries } from '@/lib/admin/copilot-quality';
import { evaluatorRunGate } from '@/lib/azure/copilot-evaluator-client';

export const dynamic = 'force-dynamic';

export const GET = withTenantAdmin(async (req: NextRequest) => {
  try {
    const url = new URL(req.url);
    const bypass = url.searchParams.get('refresh') === '1';
    const domain = url.searchParams.get('domain')?.trim() || null;

    const { value } = await getOrComputeCached(
      'copilot-quality:search-summaries',
      'copilot-quality',
      async () => {
        const [runs, floorsFile] = await Promise.all([listSearchRuns(), Promise.resolve(loadEvalFloors())]);
        return { summaries: buildSearchSummaries(runs, floorsFile.searchFloors) };
      },
      { ttlMs: 5 * 60_000, budgetMs: 20_000, serveStaleOnError: true, bypass, counterBackend: 'result-cache' },
    );

    // Optional single-domain drill-in (worst queries — lowest NDCG / misses first).
    let drill: { runId: string | null; queries: unknown[] } | undefined;
    if (domain) {
      const resolved = await searchDomainResults(domain);
      const ranked = [...resolved.results]
        .sort((a, b) => Number(a.hit) - Number(b.hit) || a.ndcg - b.ndcg || a.mrr - b.mrr)
        .map((r) => ({
          queryId: r.queryId, query: r.query, hit: r.hit, mrr: r.mrr, ndcg: r.ndcg,
          matched: r.matched, k: r.k, expectedResults: r.expectedResults,
          retrieved: r.retrieved.slice(0, r.k), backend: r.backend,
        }));
      drill = { runId: resolved.runId, queries: ranked };
    }

    return apiOk({
      domains: value.summaries,
      drill,
      evaluatorConfigured: evaluatorRunGate() === null,
    });
  } catch (e) {
    return apiServerError(e, 'failed to load search relevance summaries', 'search_quality_read_failed');
  }
});
