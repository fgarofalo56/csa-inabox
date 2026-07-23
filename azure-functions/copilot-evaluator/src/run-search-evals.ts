/**
 * copilot-evaluator — SRCH1 federated-search relevance runner.
 *
 * The Copilot-RAG twin of run-evals, applied to the federated catalog search
 * users type into (`/catalog`). For each requested domain it loads the
 * content/evals/search/<domain>.jsonl golden set, and per query:
 *   1. POSTs the console search eval-probe (REAL searchCatalog ranking, run AS
 *      the seeded evaluator identity — ACL-scoped, byte-identical to `/catalog`);
 *   2. scores relevance deterministically (hit@k / MRR / NDCG@k);
 *   3. writes the per-query `eval-result` + the per-domain `eval-run` rollup to
 *      Cosmos `loom-copilot-evals` with surface 'search:<domain>' — the SAME
 *      docs E5's admin page + check-eval-regression consume, no judge spend.
 *
 * No LLM judge is involved (relevance is deterministic), so there is no token
 * cost — only the real search calls.
 */
import type { InvocationContext } from '@azure/functions';
import {
  evalEnabled,
  loadSearchSets,
  resolveEvalRoot,
  scoreSearch,
  rollupSearchRun,
  DEFAULT_SEARCH_K,
  type SearchEvalResult,
} from './evaluator-core';
import { probeSearch, writeSearchResults, writeRun, readCorpusManifest } from './azure-clients';
import type { RunSummary } from './run-evals';

export async function runSearchEvals(
  trigger: 'corpus' | 'nightly' | 'manual',
  domains: string[] | undefined,
  context: InvocationContext,
): Promise<RunSummary> {
  const env = process.env;
  if (!evalEnabled(env)) {
    context.log('[copilot-evaluator/search] disabled via LOOM_COPILOT_EVAL_ENABLED=false — no-op.');
    return { ran: false, reason: 'disabled', surfaces: [] };
  }
  const cosmosEndpoint = env.LOOM_COSMOS_ENDPOINT;
  const probeUrl = env.LOOM_EVAL_PROBE_URL;
  const internalToken = env.LOOM_INTERNAL_TOKEN;
  const missing: string[] = [];
  if (!cosmosEndpoint) missing.push('LOOM_COSMOS_ENDPOINT');
  if (!probeUrl) missing.push('LOOM_EVAL_PROBE_URL');
  if (!internalToken) missing.push('LOOM_INTERNAL_TOKEN');
  if (missing.length) {
    context.warn(`[copilot-evaluator/search] honest-gate: not configured — set ${missing.join(', ')}. No-op.`);
    return { ran: false, reason: `missing config: ${missing.join(', ')}`, surfaces: [] };
  }
  const cosmosDb = env.LOOM_COSMOS_DATABASE || 'loom';
  const probeOid = (env.LOOM_EVAL_PROBE_OID || '').trim() || undefined;

  const evalRoot = resolveEvalRoot(process.cwd());
  if (!evalRoot) {
    context.error('[copilot-evaluator/search] no eval root found (./evals, ./copilot-corpus/evals, <repo>/content/evals).');
    return { ran: false, reason: 'eval sets not found', surfaces: [] };
  }
  const sets = loadSearchSets(evalRoot, domains);
  if (sets.length === 0) {
    context.warn(`[copilot-evaluator/search] no matching search sets under ${evalRoot}/search for domains=${JSON.stringify(domains ?? 'all')}.`);
    return { ran: false, reason: 'no matching search domains', surfaces: [] };
  }

  const manifest = await readCorpusManifest(probeUrl!, internalToken!).catch(() => null);
  const corpusCommit = manifest?.corpusCommit || 'unknown';
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.slice(0, 19).replace(/[:T-]/g, '')}-search-${trigger}`;
  const summary: RunSummary = { ran: true, surfaces: [] };

  for (const set of sets) {
    const surface = `search:${set.domain}`;
    const results: SearchEvalResult[] = [];
    for (const row of set.rows) {
      const k = row.k || DEFAULT_SEARCH_K;
      try {
        const probe = await probeSearch(probeUrl!, internalToken!, { query: row.query, oid: probeOid, top: k });
        const { hit, mrr, ndcg } = scoreSearch(row.expectedResults, probe.results, k);
        results.push({
          queryId: row.id,
          domain: set.domain,
          query: row.query,
          expectedResults: row.expectedResults,
          retrievedResults: probe.results.map((h) => h.displayName || h.id).slice(0, k),
          hit,
          mrr,
          ndcg,
          backend: probe.backend,
          latencyMs: probe.latencyMs,
        });
      } catch (e: any) {
        context.error(`[copilot-evaluator/search] ${surface}/${row.id}: search eval-probe failed: ${e?.message || e}`);
      }
    }

    const totals = rollupSearchRun(results);
    try {
      await writeSearchResults(cosmosEndpoint!, cosmosDb, runId, surface, results);
      await writeRun(cosmosEndpoint!, cosmosDb, {
        id: `${runId}:${surface}`,
        surface,
        runId,
        docType: 'eval-run',
        schemaVersion: 1,
        corpusCommit,
        startedAt,
        finishedAt: new Date().toISOString(),
        judgeModel: 'none',
        trigger,
        totals,
      });
    } catch (e: any) {
      context.error(`[copilot-evaluator/search] ${surface}: Cosmos write failed: ${e?.message || e}`);
    }
    context.log(
      `[copilot-evaluator/search] run ${surface}: ${totals.questions} Q, hit-rate ${totals.retrievalHitRate}, ndcg ${totals.ndcgAvg}`,
    );
    summary.surfaces.push({
      surface,
      questions: totals.questions,
      retrievalHitRate: totals.retrievalHitRate,
      groundingAvg: totals.groundingAvg,
      passRate: totals.passRate,
    });
  }
  return summary;
}
