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
  resolveEvalRoot,
  scoreRetrieval,
  deterministicGuards,
  buildJudgeMessages,
  computePass,
  rollupRun,
  type EvalResult,
} from './evaluator-core';
import {
  probeConsole,
  readCorpusManifest,
  judgeAnswer,
  writeRun,
  writeResults,
  readJudgedToday,
  writeJudgedToday,
  judgeModelHint,
} from './azure-clients';

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
