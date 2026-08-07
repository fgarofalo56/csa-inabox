/**
 * POST /api/internal/copilot/eval-probe  (GET = corpus-manifest probe) — E2.
 *
 * The copilot-evaluator Function's window into the REAL Copilot path (wiring
 * (a) of the E2 spec): one call runs the exact `searchDocs()` retrieval the
 * docs Copilot uses AND one real Copilot turn through the unified
 * `aoai-chat-client` (tier routing included), returning
 * `{retrievedChunks, answer, tier, taskClass, backend, latencyMs}` — so the
 * evaluator scores byte-identical retrieval + routing, never a reimplementation.
 *
 * Auth: machine-to-machine — the shared VNet-internal trust token
 * (LOOM_INTERNAL_TOKEN; fail-closed when unset), the SAME proven pattern as
 * /api/internal/copilot/memory/consolidate. A signed-in admin session is NOT
 * accepted here: this is an internal probe surface, not a user API (the E5
 * "Run now" admin route proxies the Function, which holds the token).
 *
 * Real backend: AI Search / Cosmos docs index (searchDocs) + AOAI
 * (aoaiChat). Honest 503 NoAoaiDeploymentError gate when no deployment is
 * configured. No mock data (no-vaporware).
 */

import { NextRequest } from 'next/server';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { logSafe } from '@/lib/util/log-safe';
import { searchDocs, DEFAULT_DOC_RETRIEVAL_TOP } from '@/lib/azure/loom-docs-index';
import { aoaiChat, NoAoaiDeploymentError } from '@/lib/azure/aoai-chat-client';
import { classifyAoaiFailure, describeAoaiFailure } from '@/lib/azure/aoai-failure-class';
import { resolveAoaiTarget } from '@/lib/azure/copilot-orchestrator';
import { routeTurnTier } from '@/lib/foundry/model-tier-router';
import { buildGroundedDocsMessages, EVIDENCE_CHARS } from '@/lib/copilot/docs-grounding';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Re-exported so the existing probe tests (and any caller asserting the judge
 * sees the SAME slice the model answered from, #2585 P3) keep one import site.
 * The constant itself now lives in `lib/copilot/docs-grounding` alongside the
 * prompt that consumes it — see that module's header for why the whole grounded
 * prompt moved out of this route (#2929: it was a private copy, so improving the
 * eval's answers and improving the product's answers were separable).
 */
export { EVIDENCE_CHARS };

function authed(req: NextRequest): boolean {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const header = req.headers.get(INTERNAL_TOKEN_HEADER);
  return isValidInternalToken(bearer || null) || isValidInternalToken(header);
}

/** The staged corpus manifest (stage-copilot-corpus.sh) — image or repo checkout. */
function readCorpusManifest(): { corpusCommit: string; corpusTotal?: number } | null {
  const candidates = [
    path.join(process.cwd(), 'copilot-corpus', '.corpus-manifest.json'),
    path.join(process.cwd(), 'apps', 'fiab-console', 'copilot-corpus', '.corpus-manifest.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return { corpusCommit: String(j.commit || j.corpusCommit || ''), corpusTotal: Number(j.total ?? 0) || undefined };
    } catch {
      /* fall through */
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return apiError('invalid internal token', 401, { code: 'bad_internal_token' });
  let body: { question?: string; surface?: string; top?: number };
  try {
    body = await req.json();
  } catch {
    return apiError('invalid JSON body', 400);
  }
  const question = String(body?.question || '').trim();
  if (!question) return apiError('question is required', 400);
  const surface = String(body?.surface || '').trim() || null;
  const top = Math.min(Math.max(Number(body?.top) || DEFAULT_DOC_RETRIEVAL_TOP, 1), 10);

  try {
    const t0 = Date.now();
    // 1. REAL retrieval — the exact hybrid searchDocs (AI Search → Cosmos
    //    fallback) the docs Copilot rides; telemetry recorded as production.
    //    `surface` is now APPLIED (a topical boost), not merely echoed: before
    //    #2585 P1b it was accepted and dropped, so every surface competed
    //    against the whole 2,587-document corpus in a top-5 window.
    const { hits, backend } = await searchDocs(question, top, undefined, { surface });
    const retrievalMs = Date.now() - t0;

    // 2. REAL Copilot turn through the unified aoai-chat-client. The tier
    //    reported is the same routeTurnTier decision applyTierRouting makes
    //    inside the client for this turn (cfg-less default path).
    const messages = buildGroundedDocsMessages(
      question,
      hits.map((h) => ({ path: h.path, heading: h.heading, content: h.content })),
    );
    const target = await resolveAoaiTarget(null); // honest 503 below when absent
    const sel = routeTurnTier({ cfg: null, messages, baseDeployment: target.deployment });
    const t1 = Date.now();
    const answer = await aoaiChat({ messages });
    const answerMs = Date.now() - t1;

    return apiOk({
      question,
      surface,
      retrievedChunks: hits.map((h) => ({
        id: `${h.path}${h.heading ? `#${h.heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : ''}`,
        path: h.path,
        heading: h.heading ?? null,
        kind: h.kind,
        // Same slice the model answered from — see EVIDENCE_CHARS.
        preview: h.content.slice(0, EVIDENCE_CHARS),
      })),
      backend,
      answer,
      tier: sel.tier,
      taskClass: sel.taskClass,
      latencyMs: retrievalMs + answerMs,
      timing: { retrievalMs, answerMs },
    });
  } catch (e) {
    if (e instanceof NoAoaiDeploymentError) {
      return apiError(
        'No AOAI deployment configured — set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT (or a Foundry project endpoint) so the eval probe can run a real Copilot turn.',
        503,
        { code: 'no_aoai' },
      );
    }
    // #3083 / deploy-integrity R7 — an AOAI 429 used to become
    // `500 {"error":"eval probe failed","code":"eval_probe_failed"}`: a status
    // the evaluator does not retry, and a string that asserts nothing the code
    // established. A throttle, a missing deployment and a genuine bug were the
    // same response. The evaluator therefore DROPPED the row, and the gate
    // computed pass-rates over the survivors — measured 2026-08-07: 84 of 153
    // rows lost at peak, `rbac 0.38` was 3 of 8.
    //
    // Now: whatever the upstream actually said is surfaced with its own status
    // and a `code` that names the cause. A 429 stays a 429 (with Retry-After
    // when the server sent one) so the caller can honour it; a non-429 upstream
    // failure is a 502 that NAMES the upstream status rather than impersonating
    // it (a bare 401 here would be indistinguishable from a bad internal
    // token). Only a failure with no structured status reaches the 500 — and
    // that message SAYS the cause is not known.
    const cls = classifyAoaiFailure(e);
    if (cls.known) {
      const status = cls.code === 'aoai_throttled' ? 429 : 502;
      const res = apiError(describeAoaiFailure(cls, e), status, {
        code: cls.code,
        upstreamStatus: cls.status,
        retryable: cls.retryable,
        ...(cls.retryAfterSeconds !== null ? { retryAfterSeconds: cls.retryAfterSeconds } : {}),
      });
      // Honour the server's own guidance where it gave one — the evaluator's
      // probe retry reads this header before falling back to its own backoff.
      if (cls.retryAfterSeconds !== null) res.headers.set('retry-after', String(cls.retryAfterSeconds));
      // Not `apiServerError`: the raw error still belongs in the log, and this
      // path deliberately bypasses it (the public message here is honest and
      // safe — it carries only a status and the upstream's own text).
      // eslint-disable-next-line no-console
      console.error(
        '[eval-probe] upstream AOAI failure:',
        logSafe(`status=${cls.status} code=${cls.code} ${e instanceof Error ? e.stack || e.message : String(e)}`, 4000),
      );
      return res;
    }
    return apiServerError(
      e,
      'eval probe failed for a reason this route could NOT classify — the error carried no upstream status, so ' +
        'whether the cause was retrieval, the model, or this route is NOT established here. See the server log. ' +
        'This is not a quality result.',
      'eval_probe_unclassified',
    );
  }
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return apiError('invalid internal token', 401, { code: 'bad_internal_token' });
  const manifest = readCorpusManifest();
  return apiOk({
    ready: true,
    corpusCommit: manifest?.corpusCommit ?? '',
    corpusTotal: manifest?.corpusTotal ?? null,
  });
}
