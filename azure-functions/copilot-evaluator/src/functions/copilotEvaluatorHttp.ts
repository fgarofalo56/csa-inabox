/**
 * copilot-evaluator — HTTP trigger (E2).
 *
 * POST /api/copilotEvaluatorHttp
 *   body: { surfaces?: string[], trigger?: 'corpus'|'manual', mode?: 'copilot'|'search' }
 *
 * On-demand runs: the corpus-staging workflow (E4) fires it after a corpus
 * change, and the admin "Run now" button (E5) proxies to it. `mode:'search'`
 * (SRCH1) runs the federated-search relevance evals instead of the Copilot RAG
 * evals — `surfaces` are then the search domains (catalog/governance). authLevel
 * 'function' — the caller presents the function key (?code= / x-functions-key);
 * no anonymous surface (see the STRIDE row in
 * docs/fiab/runbooks/copilot-evaluator.md).
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { runEvals } from '../run-evals';
import { runSearchEvals } from '../run-search-evals';

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
  const mode: 'copilot' | 'search' = body?.mode === 'search' ? 'search' : 'copilot';

  const summary = mode === 'search'
    ? await runSearchEvals(trigger, surfaces, context)
    : await runEvals(trigger, surfaces, context);
  return {
    status: summary.ran ? 200 : 409,
    jsonBody: { ok: summary.ran, reason: summary.reason, trigger, mode, surfaces: summary.surfaces },
  };
}

app.http('copilotEvaluatorHttp', {
  methods: ['POST'],
  authLevel: 'function',
  handler: copilotEvaluatorHttp,
});
