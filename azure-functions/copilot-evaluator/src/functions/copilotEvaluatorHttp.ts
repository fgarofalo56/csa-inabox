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
import { runEvals } from '../run-evals';

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
