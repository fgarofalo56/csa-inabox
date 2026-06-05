/**
 * GET /api/setup/workflow-run-status?workflow={workflowFile}
 *
 * Polls GitHub Actions API for the latest run of a deployment workflow.
 * Used by Setup Wizard to show live deployment progress.
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

  try {
    const repoOwner = process.env.LOOM_GITHUB_REPO_OWNER || 'fgarofalo56';
    const repoName = process.env.LOOM_GITHUB_REPO_NAME || 'csa-inabox';
    const runUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/actions/workflows/${workflowFile}/runs?branch=main&per_page=1&status=in_progress,completed`;

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
    const runs = j.workflow_runs || [];
    if (runs.length === 0) {
      return NextResponse.json(
        { ok: true, status: 'not_found' },
        { status: 404 },
      );
    }

    const latestRun = runs[0];
    return NextResponse.json(
      {
        ok: true,
        status: latestRun.status,
        conclusion: latestRun.conclusion,
        runId: latestRun.id,
        runUrl: latestRun.html_url,
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
