/**
 * copilot-evaluator — HTTP trigger (E2).
 *
 * POST /api/copilotEvaluatorHttp  body: { surfaces?: string[], trigger?: 'corpus'|'manual' }
 *
 * On-demand runs: the corpus-staging workflow (E4) fires it after a corpus
 * change, and the admin "Run now" button (E5) proxies to it. authLevel
 * 'function' — the caller presents the function key (?code= / x-functions-key);
 * no anonymous surface (see the STRIDE row in
 * docs/fiab/runbooks/copilot-evaluator.md).
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { runEvals, runSearchEvals, runTierEvals } from '../run-evals';

export async function copilotEvaluatorHttp(
  req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  let body: any = {};
  try {
    body = (await req.json()) as any;
  } catch {
    /* empty body = run everything */
  }
  const surfaces: string[] | undefined = Array.isArray(body?.surfaces)
    ? body.surfaces.map((s: unknown) => String(s)).filter(Boolean)
    : undefined;
  const trigger: 'corpus' | 'manual' = body?.trigger === 'corpus' ? 'corpus' : 'manual';

  // SRCH1: mode 'search' runs the federated-search relevance evals instead of
  // the Copilot answer evals (body.domains filters the search domains).
  if (body?.mode === 'search') {
    const domains: string[] | undefined = Array.isArray(body?.domains)
      ? body.domains.map((s: unknown) => String(s)).filter(Boolean)
      : undefined;
    const s = await runSearchEvals(trigger, domains, context);
    return {
      status: s.ran ? 200 : 409,
      jsonBody: { ok: s.ran, reason: s.reason, trigger, mode: 'search', domains: s.domains },
    };
  }

  // E6: mode 'tier' runs the tier-router decision evals (deterministic — the
  // REAL routeTurnTier over the golden _tier-labels.jsonl set, no probe/judge).
  if (body?.mode === 'tier') {
    const t = await runTierEvals(trigger, context);
    return {
      status: t.ran ? 200 : 409,
      jsonBody: {
        ok: t.ran, reason: t.reason, trigger, mode: 'tier',
        rows: t.rows, tierAccuracy: t.tierAccuracy, taskClassAccuracy: t.taskClassAccuracy,
      },
    };
  }

  const summary = await runEvals(trigger, surfaces, context);
  return {
    status: summary.ran ? 200 : 409,
    jsonBody: { ok: summary.ran, reason: summary.reason, trigger, surfaces: summary.surfaces },
  };
}

app.http('copilotEvaluatorHttp', {
  methods: ['POST'],
  authLevel: 'function',
  handler: copilotEvaluatorHttp,
});
