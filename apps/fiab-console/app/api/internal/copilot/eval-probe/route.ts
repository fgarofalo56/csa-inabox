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
import { searchDocs } from '@/lib/azure/loom-docs-index';
import { aoaiChat, NoAoaiDeploymentError, type AoaiChatMessage } from '@/lib/azure/aoai-chat-client';
import { resolveAoaiTarget } from '@/lib/azure/copilot-orchestrator';
import { routeTurnTier } from '@/lib/foundry/model-tier-router';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authed(req: NextRequest): boolean {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const header = req.headers.get(INTERNAL_TOKEN_HEADER);
  return isValidInternalToken(bearer || null) || isValidInternalToken(header);
}

/** Grounded single-turn messages — the docs-RAG shape the evaluator judges. */
function buildTurnMessages(question: string, excerpts: { path: string; heading?: string; content: string }[]): AoaiChatMessage[] {
  const context = excerpts.length
    ? excerpts
        .map((e, i) => `[${i + 1}] ${e.path}${e.heading ? ` — ${e.heading}` : ''}\n${e.content.slice(0, 1500)}`)
        .join('\n\n')
    : '(no documentation excerpts were retrieved)';
  return [
    {
      role: 'system',
      content:
        'You are the CSA Loom help Copilot. CSA Loom is an Azure-native analytics platform — NOT Microsoft Fabric; ' +
        'no feature requires a Fabric capacity or Power BI workspace (Fabric backends are strictly opt-in). ' +
        'Answer the question grounded ONLY in the documentation excerpts provided. ' +
        'If the excerpts do not cover the question, say so honestly instead of inventing an answer.\n\n' +
        `Documentation excerpts:\n${context}`,
    },
    { role: 'user', content: question },
  ];
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
  const top = Math.min(Math.max(Number(body?.top) || 5, 1), 10);

  try {
    const t0 = Date.now();
    // 1. REAL retrieval — the exact hybrid searchDocs (AI Search → Cosmos
    //    fallback) the docs Copilot rides; telemetry recorded as production.
    const { hits, backend } = await searchDocs(question, top);
    const retrievalMs = Date.now() - t0;

    // 2. REAL Copilot turn through the unified aoai-chat-client. The tier
    //    reported is the same routeTurnTier decision applyTierRouting makes
    //    inside the client for this turn (cfg-less default path).
    const messages = buildTurnMessages(question, hits.map((h) => ({ path: h.path, heading: h.heading, content: h.content })));
    const target = await resolveAoaiTarget(null); // honest 503 below when absent
    const sel = routeTurnTier({ cfg: null, messages, baseDeployment: target.deployment });
    const t1 = Date.now();
    const answer = await aoaiChat({ messages });
    const answerMs = Date.now() - t1;

    return apiOk({
      question,
      surface: body?.surface || null,
      retrievedChunks: hits.map((h) => ({
        id: `${h.path}${h.heading ? `#${h.heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : ''}`,
        path: h.path,
        heading: h.heading ?? null,
        kind: h.kind,
        preview: h.content.slice(0, 300),
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
    return apiServerError(e, 'eval probe failed', 'eval_probe_failed');
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
