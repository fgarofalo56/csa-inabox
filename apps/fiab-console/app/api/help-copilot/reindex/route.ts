/**
 * POST /api/help-copilot/reindex — rebuilds the docs+repo corpus.
 *
 * Walks docs/ + apps/fiab-console/lib/ + PRPs/ + ADRs and pushes chunks into
 * either AI Search (preferred) or the Cosmos fallback.
 *
 * GET /api/help-copilot/reindex — returns last reindex stats (lightweight
 * check that the corpus is populated).
 *
 * Auth — EITHER of:
 *   1. a signed-in admin session (the interactive "Reindex" button), OR
 *   2. the VNet-internal trust token (`LOOM_INTERNAL_TOKEN`, presented as a
 *      Bearer token or the `x-loom-internal-token` header) — the SAME
 *      machine-to-machine credential the copilot-evaluator uses on
 *      `/api/internal/copilot/eval-probe`, and that csa-loom-memory-consolidate
 *      / -spark-keepwarm / -skill-learner already POST with.
 *
 * The token path is what lets copilot-quality-evals.yml refresh the `loom-docs`
 * AI Search index BEFORE it measures retrieval (issue #2929, freshness half),
 * without minting an MSAL session. Fails CLOSED: with no session AND
 * LOOM_INTERNAL_TOKEN unset/mismatched, the request is rejected (401).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { reindex, isSearchConfigured } from '@/lib/azure/loom-docs-index';
import { apiServerError } from '@/lib/api/respond';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5min; corpus build can be slow on a cold replica

/**
 * Authorized when a signed-in admin session is present OR a valid internal
 * trust token is presented (Bearer or `x-loom-internal-token`). Mirrors the
 * eval-probe route's `authed()`; the shared token check fails closed when
 * LOOM_INTERNAL_TOKEN is unset.
 */
function authorized(req: NextRequest): boolean {
  if (getSession()) return true;
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const header = req.headers.get(INTERNAL_TOKEN_HEADER);
  return isValidInternalToken(bearer || null) || isValidInternalToken(header);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  return NextResponse.json({
    ok: true,
    backend: isSearchConfigured() ? 'ai-search' : 'cosmos',
    hint: isSearchConfigured()
      ? 'AI Search is configured. POST to /api/help-copilot/reindex to refresh.'
      : 'AI Search not configured; using Cosmos substring fallback. Set LOOM_AI_SEARCH_SERVICE for hybrid search.',
  });
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const result = await reindex();
    if (!result.ok) {
      return NextResponse.json({ ...result, ok: false }, { status: 502 });
    }
    return NextResponse.json({ ...result, ok: true });
  } catch (e: any) {
    return apiServerError(e);
  }
}
