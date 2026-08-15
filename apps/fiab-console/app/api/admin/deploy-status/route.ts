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

/**
 * A git object id: 7–40 hex, nothing else (CodeQL js/file-access-to-http #776).
 *
 * WHY THIS EXISTS. `build.sha` is FILE data — `readBuildMarker()` pulls it out
 * of public/build-marker.txt with `/sha=([^\s]+)/`, which accepts every
 * non-whitespace byte, and it was then interpolated straight into a request
 * path. `..` segments are collapsed by the URL parser BEFORE the request goes
 * out, so the marker chose which api.github.com endpoint this route called.
 *
 * Measured, not reasoned about — a marker of `sha=../../../../user/repos?x=`
 * produces (node, WHATWG URL):
 *
 *     pathname  /user/repos
 *     search    ?x=...main
 *
 * `GET /user/repos` is a real endpoint (401 unauthenticated, verified), so with
 * LOOM_FEEDBACK_GITHUB_TOKEN configured the request lands there authenticated.
 *
 * WHAT IT IS, STATED EXACTLY. A BLIND, credential-attached GET to an
 * attacker-chosen path on ONE host — SSRF confined to api.github.com. It is NOT
 * information disclosure: `DeployStatusReport` carries only `estate` + `paths`,
 * `EstateDrift` has no field holding the compare payload, and
 * `classifyEstateDrift` reads only `status`, `ahead_by`, `behind_by` and
 * `commits[].commit.*.date` — all `undefined` for a diverted endpoint, so
 * `behindSince` lands null. Verified against the real response shape: NO BYTE
 * of the diverted body reaches the client.
 *
 * TRUST BOUNDARY, so the severity is not overread: the only writer of
 * build-marker.txt is apps/fiab-console/Dockerfile:152, the only writers of
 * LOOM_BUILD_SHA are six CI build-args (no bicep sets it at runtime), and this
 * route sits behind `withCapability('admin.env-config','Admin')`. Anyone who
 * can set the marker already owns the image. This is defence in depth at the
 * image-build boundary, not a runtime-reachable hole.
 *
 * The marker is written from the LOOM_BUILD_SHA build-arg, and all six
 * producers pass either `github.sha` (40 hex) or `git rev-parse --short=8 HEAD`
 * (8 hex) — build-fiab-images-acr-tasks, console-bluegreen-roll,
 * full-app-deploy-commercial, gov-build-images, gov-console-roll,
 * publish-ghcr-images — so this validates what the value already is and cannot
 * reject a legitimate build. The unset case is the Dockerfile default
 * `unknown`, which readBuildMarker already drops before it reaches here.
 *
 * It is ALSO the honest-error fix, and that is the stronger half
 * (deploy-integrity R7). Without it a malformed marker produced either
 * `GitHub API returned HTTP 404` — asserting a GitHub-side cause for a purely
 * local defect — or, when the diverted endpoint answered 200, a verdict
 * computed from a body that is not a comparison at all: measured,
 * `state:'behind'` / `severity:'error'` / "This estate is **undefined** commits
 * behind main". Loud and incoherent, naming no real cause.
 */
const GIT_OBJECT_ID = /^[0-9a-f]{7,40}$/i;

async function computeDeployStatus(): Promise<DeployStatusReport> {
  const build = readBuildMarker();
  const cloud = detectLoomCloud();

  // 1. How far behind the default branch is the image serving this request?
  //    The compare response's `commits[]` is load-bearing, not incidental: it
  //    carries the DATE of the oldest commit this estate is missing, which is
  //    what classifyEstateDrift tolerates a roll-in-flight against. There is no
  //    commit-count tolerance any more — being behind at all is the condition —
  //    so the only thing standing between "behind" and "error" is that date.
  //
  //    The sha is VALIDATED before it reaches the URL (see GIT_OBJECT_ID): it is
  //    file data, and a request path is not a place to interpolate file data
  //    unchecked. Each branch degrades to an honest reason, never a false green.
  const sha = build.sha;
  let compare: { data?: CompareResult; error?: string };
  if (!sha) {
    compare = { error: 'this image carries no build sha' };
  } else if (!GIT_OBJECT_ID.test(sha)) {
    // Deliberately does NOT echo the value: the fix is that this string never
    // leaves the process carrying marker bytes. The remediation is the marker,
    // and naming it is enough to act on.
    compare = {
      error:
        "this image's build marker does not carry a git object id (expected 7–40 hex " +
        'from the LOOM_BUILD_SHA build-arg), so it names no commit to compare — ' +
        'check /build-marker.txt on the running revision',
    };
  } else {
    compare = await ghJson<CompareResult>(`/repos/${REPO}/compare/${sha}...${BRANCH}`);
  }
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
