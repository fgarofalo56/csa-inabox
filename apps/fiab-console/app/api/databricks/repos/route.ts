/**
 * Git folders (Repos) on the deployment-default Databricks workspace (the
 * Workspace Resources navigator → Repos group). Lists/creates/deletes Git
 * folders via the real Databricks Repos REST (api 2.0).
 *
 *   GET    /api/databricks/repos              → { ok, repos: [{id, path, url, provider, branch}] }
 *   POST   /api/databricks/repos              body { url, provider, path? } → clone/link a remote repo
 *   DELETE /api/databricks/repos?id=N         → delete (unlink) the Git folder
 *
 * Honest 503 gate when LOOM_DATABRICKS_HOSTNAME is unset. Real REST. No mocks.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  databricksConfigGate, listRepos, createRepo, deleteRepo,
} from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  const g = databricksConfigGate();
  if (g) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: `Databricks workspace not configured: set ${g.missing}.`, missing: g.missing },
      { status: 503 },
    );
  }
  return null;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  try {
    const repos = (await listRepos()).map((r) => ({
      id: r.id,
      // leaf of the workspace path makes a friendly name
      name: (r.path || '').split('/').filter(Boolean).pop() || String(r.id),
      path: r.path,
      url: r.url,
      provider: r.provider,
      branch: r.branch,
    }));
    return NextResponse.json({ ok: true, repos });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const url: string = typeof body?.url === 'string' ? body.url.trim() : '';
  const provider: string = typeof body?.provider === 'string' ? body.provider.trim() : '';
  if (!url) return NextResponse.json({ ok: false, error: 'url is required (remote Git repo)' }, { status: 400 });
  if (!provider) return NextResponse.json({ ok: false, error: 'provider is required (gitHub|gitLab|azureDevOpsServices|…)' }, { status: 400 });
  try {
    const repo = await createRepo({
      url,
      provider,
      path: typeof body?.path === 'string' && body.path.trim() ? body.path.trim() : undefined,
    });
    return NextResponse.json({ ok: true, repo });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const g = gate(); if (g) return g;
  const id = Number(req.nextUrl.searchParams.get('id'));
  if (!Number.isFinite(id)) return NextResponse.json({ ok: false, error: 'id query param is required' }, { status: 400 });
  try {
    await deleteRepo(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
