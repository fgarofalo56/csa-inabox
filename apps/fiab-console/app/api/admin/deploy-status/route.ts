/**
 * GET /api/admin/deploy-status — "is what is running actually what was merged?"
 *
 * WHY (operator, 2026-08-05): "nothing surfaces 'the estate is N commits behind'
 * or 'the last infra deploy failed'". Both were measurable; neither was
 * measured anywhere a human looks, so an operator watched unchanged gates for
 * two weeks while PRs merged green over a dead deploy path.
 *
 * Real data only (no-vaporware.md). Three real sources, no synthesis:
 *   1. THIS image's own build fingerprint — public/build-marker.txt, written by
 *      the Dockerfile from the LOOM_BUILD_SHA build-arg. Read locally; it cannot
 *      be wrong about which image is serving, because it IS the image.
 *   2. GitHub's compare API for that sha against the default branch → the exact
 *      number of merged commits that have never reached this estate.
 *   3. GitHub's Actions API for the lanes that put code INTO the estate → their
 *      enabled/disabled state and recent run conclusions.
 *
 * The verdicts themselves are PURE and unit-tested in lib/admin/deploy-status.ts;
 * this route is only the I/O.
 *
 * HONEST DEGRADE, NEVER A FALSE GREEN. The repo is public, so (2) and (3) work
 * unauthenticated — but a boundary with no egress to api.github.com (Azure
 * Government) or an exhausted unauthenticated rate limit will fail them. Every
 * such failure produces `state:'unknown'` carrying the exact reason, which the
 * banner renders as a warning. "We could not check" is never rendered as "it is
 * fine": this repo has shipped that defect three times.
 *
 * Privacy: identical to /api/version — no tenant identity is sent upstream. The
 * optional LOOM_FEEDBACK_GITHUB_TOKEN is used only to raise the rate limit.
 */
import { NextResponse } from 'next/server';
import { withCapability } from '@/lib/api/route-toolkit';
import { readBuildMarker } from '@/lib/updates/current-version';
import { getOrComputeCached } from '@/lib/azure/query-result-cache';
import { detectLoomCloud } from '@/lib/azure/cloud-endpoints';
import {
  classifyDeployPath,
  classifyEstateDrift,
  deployPathsForCloud,
  summarizeDeployStatus,
  type CompareResult,
  type DeployStatusReport,
  type RunLite,
} from '@/lib/admin/deploy-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const OWNER = process.env.LOOM_FEEDBACK_REPO_OWNER || 'fgarofalo56';
const NAME = process.env.LOOM_FEEDBACK_REPO_NAME || 'csa-inabox';
const REPO = `${OWNER}/${NAME}`;
const BRANCH = process.env.LOOM_UPSTREAM_BRANCH || 'main';
const API = 'https://api.github.com';

/**
 * Per-call bound. The whole point of this surface is that an operator sees the
 * answer; a page that hangs on an unreachable GitHub is a page nobody reads, so
 * a stalled fetch becomes an honest "unknown" rather than a spinner.
 */
const FETCH_TIMEOUT_MS = 6_000;

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (process.env.LOOM_FEEDBACK_GITHUB_TOKEN) {
    h.Authorization = `Bearer ${process.env.LOOM_FEEDBACK_GITHUB_TOKEN}`;
  }
  return h;
}

/** GET a GitHub JSON endpoint, or an { error } describing exactly what failed. */
async function ghJson<T>(pathname: string): Promise<{ data?: T; error?: string }> {
  try {
    const res = await fetch(`${API}${pathname}`, {
      headers: ghHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) {
      // 403 with a zero remaining budget is the unauthenticated rate limit, and
      // saying so is materially more useful than "HTTP 403" — it tells the
      // operator to set LOOM_FEEDBACK_GITHUB_TOKEN rather than chase a permission.
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (res.status === 403 && remaining === '0') {
        return { error: 'GitHub API rate limit exhausted for this egress IP (set LOOM_FEEDBACK_GITHUB_TOKEN to raise it)' };
      }
      return { error: `GitHub API returned HTTP ${res.status}` };
    }
    return { data: (await res.json()) as T };
  } catch (e: any) {
    const msg = e?.name === 'TimeoutError'
      ? `no response within ${FETCH_TIMEOUT_MS}ms`
      : String(e?.message || e).slice(0, 160);
    return { error: `could not reach api.github.com — ${msg}` };
  }
}

/**
 * Runs read per lane. A window, not the whole history — which is why
 * `historyComplete` below matters: deploy-fiab-commercial.yml currently has
 * 30+ consecutive failures, so a page of 30 contains no success at all, and
 * calling that "never succeeded" would be false (it last succeeded 2026-06-18).
 */
const RUNS_PER_PAGE = 30;

async function computeDeployStatus(): Promise<DeployStatusReport> {
  const build = readBuildMarker();
  const cloud = detectLoomCloud();

  // 1. How far behind the default branch is the image serving this request?
  //    The compare response's `commits[]` is load-bearing, not incidental: it
  //    carries the DATE of the oldest commit this estate is missing, which is
  //    what classifyEstateDrift tolerates a roll-in-flight against. There is no
  //    commit-count tolerance any more — being behind at all is the condition —
  //    so the only thing standing between "behind" and "error" is that date.
  const compare = build.sha
    ? await ghJson<CompareResult>(`/repos/${REPO}/compare/${build.sha}...${BRANCH}`)
    : { error: 'this image carries no build sha' };
  const estate = classifyEstateDrift({
    buildSha: build.sha ?? null,
    buildStamp: build.stamp ?? null,
    branch: BRANCH,
    repo: REPO,
    compare: compare.data ?? null,
    error: compare.error ?? null,
  });

  // 2. Are the lanes that put code INTO this estate actually working?
  const defs = deployPathsForCloud(cloud);
  const paths = await Promise.all(defs.map(async (def) => {
    const [wf, runs] = await Promise.all([
      ghJson<{ state: string }>(`/repos/${REPO}/actions/workflows/${def.workflow}`),
      ghJson<{ workflow_runs: RunLite[] }>(
        `/repos/${REPO}/actions/workflows/${def.workflow}/runs?per_page=${RUNS_PER_PAGE}`,
      ),
    ]);
    const rows = runs.data?.workflow_runs ?? null;
    return classifyDeployPath({
      def,
      repo: REPO,
      runs: rows,
      // Fewer rows than we asked for ⇒ that IS the entire history, and only
      // then may the verdict use the word "never".
      historyComplete: rows !== null && rows.length < RUNS_PER_PAGE,
      workflowState: wf.data?.state ?? null,
      error: runs.error || wf.error || null,
    });
  }));

  return summarizeDeployStatus(estate, paths, {
    generatedAt: new Date().toISOString(),
    repo: REPO,
  });
}

/**
 * ROUTE-TOOLKIT (R3). The session prologue is `withSession`, not a hand-rolled
 * `getSession()` — this route is net-new, so shipping it hand-rolled would have
 * ADDED to the ratchet baseline the toolkit migration exists to drain (and it
 * did: check-route-toolkit failed this file at 1 over a baseline of 0). The
 * capability gate runs INSIDE the wrapper, the same composition
 * /api/admin/gates/[id]/options uses: withSession answers "is there a session"
 * (401), enforceCapability answers "may this session do admin work" (403).
 * Byte-compatible 401 — `apiUnauthorized()` is `{ok:false,error:'unauthenticated'}`
 * at 401, exactly what `enforceCapability(null, …)` returned before.
 *
 * C22 (#3088) — now `withCapability`, which composes those two into ONE
 * non-discardable wrapper. Same 401, same 403 body (the wrapper returns
 * enforceCapability's response unchanged), same capability id and role. The
 * reason for the change is that the previous shape put the entire
 * authorization in a line the caller could delete —
 * `const capGate = await enforceCapability(…); if (capGate) return capGate;` —
 * and deleting it left every CI guard green. As an argument to the wrapper the
 * handler cannot run unless the gate allowed it.
 */
export const GET = withCapability('admin.env-config', 'Admin', async (_req, _ctx) => {
  // Up to 9 upstream calls; unauthenticated GitHub allows 60/hour per egress IP.
  // A 10-minute TTL keeps a busy readiness page well inside that budget while
  // still turning the banner red within one refresh of a lane breaking.
  // serve-stale means a transient GitHub blip shows a slightly-old verdict
  // rather than an "unknown" that would read as new information.
  const { value, meta } = await getOrComputeCached(
    'admin-deploy-status',
    'deploy-status-v1',
    computeDeployStatus,
    { ttlMs: 600_000, backend: 'result-cache', staleWhileRevalidate: true, serveStaleOnError: true },
  );

  return NextResponse.json({ ok: true, ...value, stale: meta.stale ?? false });
});
