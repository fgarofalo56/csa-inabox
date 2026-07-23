/**
 * copilot-evaluator — timer trigger (E2).
 *
 * On COPILOT_EVALUATOR_CRON (default nightly 07:00 UTC — off-peak so the
 * LLM-judge spend never competes with production Copilot AOAI TPM during
 * business hours; see the capacity note in ../../README.md) the Function runs
 * every E1 eval set against the real retrieval + AOAI path and writes scored
 * results to Cosmos `loom-copilot-evals`.
 */
import { app, InvocationContext, Timer } from '@azure/functions';
import { runEvals, runSearchEvals } from '../run-evals';

const CRON = process.env.COPILOT_EVALUATOR_CRON || '0 0 7 * * *';

export async function copilotEvaluatorTimer(_timer: Timer, context: InvocationContext): Promise<void> {
  const summary = await runEvals('nightly', undefined, context);
  context.log(
    `[copilot-evaluator] nightly tick complete — ran=${summary.ran}` +
      (summary.reason ? ` reason=${summary.reason}` : '') +
      ` surfaces=${summary.surfaces.length}`,
  );
  // SRCH1 — federated-search relevance (deterministic, no judge spend) rides the
  // same nightly tick. Honest no-op when unconfigured (missing sets / principal).
  const search = await runSearchEvals('nightly', undefined, context);
  context.log(
    `[copilot-evaluator/search] nightly tick complete — ran=${search.ran}` +
      (search.reason ? ` reason=${search.reason}` : '') +
      ` domains=${search.domains.length}`,
  );
}

app.timer('copilotEvaluatorTimer', {
  schedule: CRON,
  runOnStartup: false,
  handler: copilotEvaluatorTimer,
});
