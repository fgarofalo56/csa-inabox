/**
 * copilot-evaluator — the run orchestrator shared by the timer + HTTP triggers.
 *
 * For each requested surface it loads the E1 golden set, and per question:
 *   1. POSTs the console eval-probe (REAL searchDocs + one REAL Copilot turn —
 *      byte-identical retrieval + tier routing, wiring (a));
 *   2. scores retrieval (hit + MRR) deterministically;
 *   3. runs the deterministic mustMention/mustNotMention guards — a forbidden
 *      phrase auto-fails with ZERO judge spend;
 *   4. consults the daily judge cap (Cosmos ledger, cross-replica) and either
 *      judges via AOAI (grounding-fidelity rubric) or marks scores 'deferred';
 *   5. writes the per-question `eval-result` (ttl 180d) and the per-surface
 *      `eval-run` rollup to Cosmos `loom-copilot-evals`.
 *
 * Every external dependency is a REAL call under the Function's managed
 * identity; missing config → an honest early-exit log (no-vaporware).
 */
import type { InvocationContext } from '@azure/functions';
import {
  missingConfig,
  evalEnabled,
  resolveJudgeDeployment,
  judgeDailyCap,
  judgeDecision,
  judgeLedgerDay,
  loadEvalSets,
  loadSearchEvalSets,
  loadTierLabels,
  resolveEvalRoot,
  scoreRetrieval,
  scoreSearchRelevance,
  rollupSearchRun,
  routeTierForPrompt,
  scoreTierDecision,
  reduceTierConfusion,
  deterministicGuards,
  buildJudgeMessages,
  computePass,
  rollupRun,
  type EvalResult,
  type SearchResult,
  type TierDecisionScore,
} from './evaluator-core';
import {
  probeConsole,
  probeSearch,
  readCorpusManifest,
  judgeAnswer,
  writeRun,
  writeResults,
  writeSearchRun,
  writeSearchResults,
  writeTierRun,
  writeTierResults,
  readJudgedToday,
  writeJudgedToday,
  judgeModelHint,
  type TierResultRow,
} from './azure-clients';

/** Default top-K ranking window for search relevance when a row omits `k`. */
const DEFAULT_SEARCH_K = 5;

export interface RunSummary {
  ran: boolean;
  reason?: string;
  surfaces: { surface: string; questions: number; retrievalHitRate: number; groundingAvg: number | null; passRate: number }[];
}

export async function runEvals(
  trigger: 'corpus' | 'nightly' | 'manual',
  surfaces: string[] | undefined,
  context: InvocationContext,
): Promise<RunSummary> {
  const env = process.env;
  if (!evalEnabled(env)) {
    context.log('[copilot-evaluator] disabled via LOOM_COPILOT_EVAL_ENABLED=false — no-op.');
    return { ran: false, reason: 'disabled', surfaces: [] };
  }
  const missing = missingConfig(env);
  if (missing.length) {
    context.warn(`[copilot-evaluator] honest-gate: not configured — set ${missing.join(', ')}. No-op.`);
    return { ran: false, reason: `missing config: ${missing.join(', ')}`, surfaces: [] };
  }

  const cosmosEndpoint = env.LOOM_COSMOS_ENDPOINT!;
  const cosmosDb = env.LOOM_COSMOS_DATABASE || 'loom';
  const probeUrl = env.LOOM_EVAL_PROBE_URL!;
  const internalToken = env.LOOM_INTERNAL_TOKEN!;
  const aoaiEndpoint = env.LOOM_AOAI_ENDPOINT || '';
  const judgeDeployment = aoaiEndpoint ? resolveJudgeDeployment(env) : undefined;
  const cap = judgeDailyCap(env);

  if (!judgeDeployment) {
    // Honest judge-less posture: retrieval scoring (deterministic) still runs;
    // the model hint comes from the per-cloud availability matrix — never a
    // hardcoded model name.
    context.warn(
      '[copilot-evaluator] no judge deployment resolves ' +
        '(LOOM_COPILOT_EVAL_JUDGE_DEPLOYMENT → LOOM_AOAI_STRONG_DEPLOYMENT → LOOM_AOAI_MINI_DEPLOYMENT → LOOM_AOAI_DEPLOYMENT all unset' +
        (aoaiEndpoint ? '' : '; LOOM_AOAI_ENDPOINT also unset') +
        `). Judge scores will be 'deferred'. Deploy a reasoning-capable model (e.g. ${judgeModelHint(aoaiEndpoint)}).`,
    );
  }

  const evalRoot = resolveEvalRoot(process.cwd());
  if (!evalRoot) {
    context.error('[copilot-evaluator] no eval sets found (looked for ./evals, ./copilot-corpus/evals, <repo>/content/evals). Deploy stages content/evals → ./evals.');
    return { ran: false, reason: 'eval sets not found', surfaces: [] };
  }
  const sets = loadEvalSets(evalRoot, surfaces);
  if (sets.length === 0) {
    context.warn(`[copilot-evaluator] no matching eval sets under ${evalRoot} for surfaces=${JSON.stringify(surfaces ?? 'all')}.`);
    return { ran: false, reason: 'no matching surfaces', surfaces: [] };
  }

  const manifest = await readCorpusManifest(probeUrl, internalToken).catch(() => null);
  const corpusCommit = manifest?.corpusCommit || 'unknown';
  const day = judgeLedgerDay();
  let judgedToday = await readJudgedToday(cosmosEndpoint, cosmosDb, day);
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.slice(0, 19).replace(/[:T-]/g, '')}-${trigger}`;
  const summary: RunSummary = { ran: true, surfaces: [] };

  for (const set of sets) {
    const results: (EvalResult & {
      question: string; expectedChunks: string[]; retrievedChunks: string[]; answer: string; tier: string;
    })[] = [];

    for (const row of set.rows) {
      let probe;
      try {
        probe = await probeConsole(probeUrl, internalToken, { question: row.question, surface: set.surface });
      } catch (e: any) {
        context.error(`[copilot-evaluator] ${set.surface}/${row.id}: eval-probe failed: ${e?.message || e}`);
        continue;
      }
      const { hit, mrr } = scoreRetrieval(row.expectedChunks, probe.probe.retrievedChunks);
      const guards = deterministicGuards(probe.probe.answer, row);
      const decision = judgeDecision({ forbiddenHit: guards.forbiddenHit, judgeDeployment, judgedToday, cap });

      let judgeStatus: EvalResult['judgeStatus'] =
        decision === 'auto-fail' ? 'auto-fail' : decision === 'deferred' ? 'deferred' : 'scored';
      let judge;
      if (decision === 'judge') {
        try {
          judge = await judgeAnswer(
            aoaiEndpoint,
            judgeDeployment!,
            buildJudgeMessages(row, probe.probe.answer, probe.excerpts),
          ) ?? undefined;
          judgedToday += 1;
          await writeJudgedToday(cosmosEndpoint, cosmosDb, day, judgedToday);
          if (!judge) judgeStatus = 'error';
        } catch (e: any) {
          context.error(`[copilot-evaluator] ${set.surface}/${row.id}: judge failed: ${e?.message || e}`);
          judgeStatus = 'error';
        }
      }

      const base = {
        questionId: row.id,
        surface: set.surface,
        retrievalHit: hit,
        mrr,
        mentionPass: guards.mentionPass,
        forbiddenHit: guards.forbiddenHit,
        judgeStatus,
        judge,
        latencyMs: probe.probe.latencyMs,
        backend: probe.probe.backend,
      };
      results.push({
        ...base,
        pass: computePass(base),
        question: row.question,
        expectedChunks: row.expectedChunks,
        retrievedChunks: probe.probe.retrievedChunks,
        answer: probe.probe.answer.slice(0, 4000),
        tier: probe.probe.tier,
      });
    }

    const totals = rollupRun(results);
    try {
      await writeResults(cosmosEndpoint, cosmosDb, runId, results);
      await writeRun(cosmosEndpoint, cosmosDb, {
        id: `${runId}:${set.surface}`,
        surface: set.surface,
        runId,
        docType: 'eval-run',
        schemaVersion: 1,
        corpusCommit,
        startedAt,
        finishedAt: new Date().toISOString(),
        judgeModel: judgeDeployment || 'none',
        trigger,
        totals,
      });
    } catch (e: any) {
      context.error(`[copilot-evaluator] ${set.surface}: Cosmos write failed: ${e?.message || e}`);
    }
    context.log(
      `[copilot-evaluator] run ${set.surface}: ${totals.questions} Q, hit-rate ${totals.retrievalHitRate}, ` +
        `grounding ${totals.groundingAvg ?? 'deferred'} (judged=${totals.judged} deferred=${totals.deferred} auto-fail=${totals.autoFailed})`,
    );
    summary.surfaces.push({
      surface: set.surface,
      questions: totals.questions,
      retrievalHitRate: totals.retrievalHitRate,
      groundingAvg: totals.groundingAvg,
      passRate: totals.passRate,
    });
  }
  return summary;
}

// ── SRCH1 — federated-search relevance run ───────────────────────────────────

export interface SearchRunSummary {
  ran: boolean;
  reason?: string;
  domains: { domain: string; queries: number; hitRate: number; ndcgAvg: number }[];
}

/**
 * Run the federated-search relevance evals: for each golden query, POST the
 * console search-probe (REAL searchCatalog top-K) and score hit-rate@k / MRR /
 * NDCG@k against the expected results. No LLM judge (deterministic — free).
 * Writes `search-run` / `search-result` docs to Cosmos `loom-copilot-evals`
 * (PK 'search:<domain>'). Honest early-exit on missing config / no sets.
 */
export async function runSearchEvals(
  trigger: 'corpus' | 'nightly' | 'manual',
  domains: string[] | undefined,
  context: InvocationContext,
): Promise<SearchRunSummary> {
  const env = process.env;
  if (!evalEnabled(env)) {
    context.log('[copilot-evaluator/search] disabled via LOOM_COPILOT_EVAL_ENABLED=false — no-op.');
    return { ran: false, reason: 'disabled', domains: [] };
  }
  const missing = missingConfig(env);
  if (missing.length) {
    context.warn(`[copilot-evaluator/search] honest-gate: not configured — set ${missing.join(', ')}. No-op.`);
    return { ran: false, reason: `missing config: ${missing.join(', ')}`, domains: [] };
  }

  const cosmosEndpoint = env.LOOM_COSMOS_ENDPOINT!;
  const cosmosDb = env.LOOM_COSMOS_DATABASE || 'loom';
  const probeUrl = env.LOOM_EVAL_PROBE_URL!;
  const internalToken = env.LOOM_INTERNAL_TOKEN!;

  const evalRoot = resolveEvalRoot(process.cwd());
  if (!evalRoot) {
    context.error('[copilot-evaluator/search] no eval root found — deploy stages content/evals → ./evals.');
    return { ran: false, reason: 'eval sets not found', domains: [] };
  }
  const sets = loadSearchEvalSets(evalRoot, domains);
  if (sets.length === 0) {
    context.warn(`[copilot-evaluator/search] no search sets under ${evalRoot}/search for domains=${JSON.stringify(domains ?? 'all')}.`);
    return { ran: false, reason: 'no matching search domains', domains: [] };
  }

  const startedAt = new Date().toISOString();
  const runId = `${startedAt.slice(0, 19).replace(/[:T-]/g, '')}-${trigger}-search`;
  const summary: SearchRunSummary = { ran: true, domains: [] };

  for (const set of sets) {
    const results: SearchResult[] = [];
    for (const row of set.rows) {
      const k = row.k && row.k > 0 ? row.k : DEFAULT_SEARCH_K;
      let probe;
      try {
        probe = await probeSearch(probeUrl, internalToken, { query: row.query, top: Math.max(k, 10) });
      } catch (e: any) {
        context.error(`[copilot-evaluator/search] ${set.domain}/${row.id}: search-probe failed: ${e?.message || e}`);
        continue;
      }
      const s = scoreSearchRelevance(row.expectedResults, probe.retrieved, k);
      results.push({
        queryId: row.id,
        domain: set.domain,
        query: row.query,
        expectedResults: row.expectedResults,
        retrieved: probe.retrieved.slice(0, k),
        hit: s.hit,
        mrr: s.mrr,
        ndcg: s.ndcg,
        matched: s.matched,
        k,
        backend: probe.backend,
        latencyMs: probe.latencyMs,
      });
    }

    const totals = rollupSearchRun(results);
    try {
      await writeSearchResults(cosmosEndpoint, cosmosDb, runId, set.domain, results);
      await writeSearchRun(cosmosEndpoint, cosmosDb, {
        id: `${runId}:search:${set.domain}`,
        surface: `search:${set.domain}`,
        domain: set.domain,
        runId,
        docType: 'search-run',
        schemaVersion: 1,
        startedAt,
        finishedAt: new Date().toISOString(),
        trigger,
        k: results[0]?.k ?? DEFAULT_SEARCH_K,
        totals,
      });
    } catch (e: any) {
      context.error(`[copilot-evaluator/search] ${set.domain}: Cosmos write failed: ${e?.message || e}`);
    }
    context.log(
      `[copilot-evaluator/search] run ${set.domain}: ${totals.queries} Q, hit-rate ${totals.hitRate}, ndcg ${totals.ndcgAvg}`,
    );
    summary.domains.push({ domain: set.domain, queries: totals.queries, hitRate: totals.hitRate, ndcgAvg: totals.ndcgAvg });
  }
  return summary;
}

// ── E6 — tier-router decision run (deterministic, no probe / no judge spend) ─

export interface TierRunSummary {
  ran: boolean;
  reason?: string;
  rows?: number;
  tierAccuracy?: number;
  taskClassAccuracy?: number;
}

/**
 * Run the tier-router decision evals: load the golden _tier-labels.jsonl set,
 * run the REAL router (routeTierForPrompt → routeTurnTier) over each labeled
 * prompt, score each decision against its expected tier, and write the
 * confusion-matrix + accuracy `tier-run` (+ per-row `tier-result`) docs to
 * Cosmos `loom-copilot-evals` (PK 'tier:router'). The router is pure, so this
 * needs NO console probe and NO AOAI judge — only Cosmos to persist results.
 * Honest early-exit on missing Cosmos config / no label set.
 */
export async function runTierEvals(
  trigger: 'corpus' | 'nightly' | 'manual',
  context: InvocationContext,
): Promise<TierRunSummary> {
  const env = process.env;
  if (!evalEnabled(env)) {
    context.log('[copilot-evaluator/tier] disabled via LOOM_COPILOT_EVAL_ENABLED=false — no-op.');
    return { ran: false, reason: 'disabled' };
  }
  // The tier eval only needs Cosmos to persist (the router is pure — no probe,
  // no judge), so it gates on Cosmos alone rather than the full probe config.
  const cosmosEndpoint = env.LOOM_COSMOS_ENDPOINT;
  if (!cosmosEndpoint) {
    context.warn('[copilot-evaluator/tier] honest-gate: not configured — set LOOM_COSMOS_ENDPOINT. No-op.');
    return { ran: false, reason: 'missing config: LOOM_COSMOS_ENDPOINT' };
  }
  const cosmosDb = env.LOOM_COSMOS_DATABASE || 'loom';

  const evalRoot = resolveEvalRoot(process.cwd());
  if (!evalRoot) {
    context.error('[copilot-evaluator/tier] no eval root found — deploy stages content/evals → ./evals.');
    return { ran: false, reason: 'eval sets not found' };
  }
  const labels = loadTierLabels(evalRoot);
  if (labels.rows.length === 0) {
    context.warn(`[copilot-evaluator/tier] no _tier-labels.jsonl under ${evalRoot}.`);
    return { ran: false, reason: 'no tier labels' };
  }

  const startedAt = new Date().toISOString();
  const runId = `${startedAt.slice(0, 19).replace(/[:T-]/g, '')}-${trigger}-tier`;
  const scores: TierDecisionScore[] = [];
  const results: TierResultRow[] = [];
  for (const row of labels.rows) {
    const selection = routeTierForPrompt(row.prompt);
    const score = scoreTierDecision(row, selection);
    scores.push(score);
    results.push({
      rowId: row.id,
      prompt: row.prompt,
      expectedTier: score.expectedTier,
      chosenTier: score.chosenTier,
      taskClass: score.taskClass,
      chosenTaskClass: score.chosenTaskClass,
      correct: score.correct,
      taskClassCorrect: score.taskClassCorrect,
      deployment: selection.deployment,
    });
  }
  const totals = reduceTierConfusion(scores);

  try {
    await writeTierResults(cosmosEndpoint, cosmosDb, runId, results);
    await writeTierRun(cosmosEndpoint, cosmosDb, {
      id: `${runId}:tier:router`,
      surface: 'tier:router',
      runId,
      docType: 'tier-run',
      schemaVersion: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      trigger,
      totals,
    });
  } catch (e: any) {
    context.error(`[copilot-evaluator/tier] Cosmos write failed: ${e?.message || e}`);
  }
  context.log(
    `[copilot-evaluator/tier] run: ${totals.rows} rows, tier-accuracy ${totals.tierAccuracy}, ` +
      `task-class-accuracy ${totals.taskClassAccuracy}`,
  );
  return { ran: true, rows: totals.rows, tierAccuracy: totals.tierAccuracy, taskClassAccuracy: totals.taskClassAccuracy };
}
