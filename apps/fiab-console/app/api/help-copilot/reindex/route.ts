/**
 * POST /api/help-copilot/reindex — kicks off a rebuild of the docs+repo corpus
 * and returns 202 Accepted immediately (async + pollable, #2929).
 *
 * Walks docs/ + apps/fiab-console/lib/ + PRPs/ + ADRs and pushes chunks into
 * either AI Search (preferred) or the Cosmos fallback.
 *
 * GET /api/help-copilot/reindex — index state: the backend, this replica's job
 * status, and the DURABLE cross-replica corpus freshness. Poll this to
 * completion after a POST.
 *
 * WHY ASYNC (the 2026-08-04 502)
 * ------------------------------
 * This route used to `await reindex()` inline. Two failure modes converged on
 * the same opaque "HTTP 502" at the caller:
 *
 *   1. REAL, IMMEDIATE failure — the walker found NO corpus at all and the
 *      route 502'd in ~160ms. That is what copilot-quality-evals run
 *      30937670794 actually hit: the routine console image builders never ran
 *      scripts/csa-loom/stage-copilot-corpus.sh, so the image shipped
 *      `copilot-corpus/` containing only `.gitkeep` and the walker enumerated
 *      zero files.
 *   2. LATENT timeout — a healthy full rebuild (~2.5k md → tens of thousands of
 *      AI Search docs) cannot finish inside Front Door's default 60s origin
 *      response timeout (front-door.bicep never overrides
 *      `originResponseTimeoutSeconds`), even though this route declares
 *      maxDuration = 300. The EDGE would 502 while the rebuild was fine.
 *
 * A caller cannot tell those apart, so it either fails on healthy runs or
 * tolerates broken ones. Now:
 *   - the empty-corpus case is a CHEAP PREFLIGHT (stat-only walk) and still
 *     fails fast + loud with the SAME 502 + message, no timeout involved;
 *   - the long rebuild goes to a background job and the POST answers 202, so no
 *     gateway timeout is on the critical path at all.
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
import {
  reindex,
  isSearchConfigured,
  corpusSourceCount,
  corpusFreshness,
} from '@/lib/azure/loom-docs-index';
import { apiServerError } from '@/lib/api/respond';
import { isValidInternalToken, INTERNAL_TOKEN_HEADER } from '@/lib/auth/internal-token';
import { startReindexJob, getReindexJobStatus } from '@/lib/azure/reindex-job';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5min; the background rebuild runs past the response

/** The exact empty-corpus message `reindex()` returns; kept identical so the
 *  CI classifier and the health probe keep recognising this failure. */
const NO_CORPUS_ERROR =
  'No corpus chunks discovered — check that docs/ and PRPs/ exist relative to cwd';

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
  const backend = isSearchConfigured() ? 'ai-search' : 'cosmos';
  const job = getReindexJobStatus();
  // Durable, cross-replica truth. `job` above is this REPLICA's view only — a
  // poll can land on a replica that never ran the job, where it reads `idle`
  // forever. Freshness comes from the persisted corpus manifest, so every
  // replica agrees; it is the completion signal callers must gate on.
  let freshness = null;
  let freshnessError: string | null = null;
  try {
    freshness = await corpusFreshness();
  } catch (e: unknown) {
    freshnessError = e instanceof Error ? e.message : String(e);
  }
  return NextResponse.json({
    ok: true,
    backend,
    job,
    freshness,
    freshnessError,
    sourceFiles: corpusSourceCount(),
    hint: isSearchConfigured()
      ? 'AI Search is configured. POST to /api/help-copilot/reindex to start a refresh (202), then poll this GET until freshness.state === "fresh".'
      : 'AI Search not configured; using Cosmos substring fallback. Set LOOM_AI_SEARCH_SERVICE for hybrid search.',
  });
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    // Preflight: a corpus the walker cannot see is a HARD failure, not a slow
    // one. Stat-only, so this stays a ~ms answer and the caller learns the real
    // reason immediately instead of polling a job that can only ever fail.
    if (corpusSourceCount() === 0) {
      return NextResponse.json(
        {
          ok: false,
          backend: 'none',
          totalChunks: 0,
          uploaded: 0,
          byKind: {},
          warnings: [],
          error: NO_CORPUS_ERROR,
          remediation:
            'The console image is missing its staged Copilot corpus. Every workflow that builds ' +
            'apps/fiab-console must run scripts/csa-loom/stage-copilot-corpus.sh before `az acr build` ' +
            '(enforced by scripts/ci/check-console-corpus-staged.mjs); rebuild + roll the console image.',
        },
        { status: 502 },
      );
    }

    const { jobId, startedAt, alreadyRunning } = startReindexJob(() => reindex());
    return NextResponse.json(
      {
        ok: true,
        accepted: true,
        state: 'running',
        jobId,
        startedAt,
        alreadyRunning,
        backend: isSearchConfigured() ? 'ai-search' : 'cosmos',
        poll: 'GET /api/help-copilot/reindex',
        hint: alreadyRunning
          ? 'A reindex was already in flight on this replica; poll GET /api/help-copilot/reindex until freshness.state === "fresh".'
          : 'Reindex started. Poll GET /api/help-copilot/reindex until freshness.state === "fresh" (job.state is this replica\'s view only).',
      },
      { status: 202 },
    );
  } catch (e: any) {
    return apiServerError(e);
  }
}
