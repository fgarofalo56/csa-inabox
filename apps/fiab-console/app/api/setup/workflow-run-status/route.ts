/**
 * GET /api/setup/workflow-run-status?workflow={workflowFile}&since={iso}
 *
 * Polls GitHub Actions API for the latest run of a deployment workflow.
 * Used by Setup Wizard to show live deployment progress.
 *
 * The optional `since` param (the ISO timestamp the wizard dispatched at,
 * returned by POST /api/setup/deploy) pins the result to the run THIS deploy
 * triggered: we list recent `workflow_dispatch` runs and pick the newest one
 * created at/after `since`. Without it the route would happily return a stale,
 * already-completed prior run and the wizard would flash "Succeeded" instantly.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  const workflowFile = req.nextUrl.searchParams.get('workflow');
  if (!workflowFile) {
    return NextResponse.json(
      { ok: false, error: 'workflow query param required' },
      { status: 400 },
    );
  }

  const token = process.env.LOOM_GITHUB_ACTIONS_TOKEN;
  if (!token) {
    return NextResponse.json(
      { ok: false, error: 'GitHub Actions token not configured' },
      { status: 503 },
    );
  }

  // The wizard passes the dispatch timestamp so we return the run THIS deploy
  // started, not an older completed run of the same workflow.
  const sinceParam = req.nextUrl.searchParams.get('since');
  const sinceMs = sinceParam ? Date.parse(sinceParam) : NaN;

  try {
    const repoOwner = process.env.LOOM_GITHUB_REPO_OWNER || 'fgarofalo56';
    const repoName = process.env.LOOM_GITHUB_REPO_NAME || 'csa-inabox';
    // `event=workflow_dispatch` scopes to wizard-triggered runs; we fetch a few
    // and choose the newest at/after `since` in code (GitHub's `status` filter
    // takes a single value, so the old comma-joined filter was silently ignored).
    const runUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/actions/workflows/${workflowFile}/runs?branch=main&event=workflow_dispatch&per_page=10`;

    const runRes = await fetch(runUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!runRes.ok) {
      return NextResponse.json(
        { ok: false, error: `GitHub API error (${runRes.status})` },
        { status: 502 },
      );
    }

    const j: any = await runRes.json();
    const runs: any[] = j.workflow_runs || [];
    // Newest run created at/after the dispatch timestamp (with a 60s grace for
    // clock skew). Falls back to the newest run when `since` is absent/unparseable.
    const candidates = Number.isFinite(sinceMs)
      ? runs.filter((r) => Date.parse(r.created_at) >= sinceMs - 60_000)
      : runs;
    const latestRun = candidates[0] ?? (Number.isFinite(sinceMs) ? undefined : runs[0]);
    if (!latestRun) {
      // Dispatch accepted but the run row hasn't materialized yet (a few seconds).
      return NextResponse.json(
        { ok: true, status: 'pending' },
        { status: 200 },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        status: latestRun.status,
        conclusion: latestRun.conclusion,
        runId: latestRun.id,
        runUrl: latestRun.html_url,
        createdAt: latestRun.created_at,
      },
      { status: 200 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'Workflow status polling failed' },
      { status: 500 },
    );
  }
}
