/**
 * POST /api/demo/deploy — one-click self-serve deploy of the WHOLE comprehensive
 * demo (the ~14 showcase apps + their `Demo —` workspaces). The in-console,
 * any-user equivalent of the operator-only scripts/csa-loom/demo-seed.mjs.
 *
 * Fires the orchestrator (lib/apps/demo-deploy.runDemoDeploy) in a floating
 * promise and returns 202 { jobId } immediately (a full deploy installs+provisions
 * 14 apps and runs for minutes — past the edge gateway window). The client polls
 * GET /api/demo/deploy/[jobId] for aggregate progress. Idempotent: re-running
 * reuses existing `Demo —` workspaces.
 *
 * GET /api/demo/deploy — report whether a demo already looks deployed for this
 * user (any `Demo —` workspace exists) so the UI can show "Open demo" vs "Deploy".
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { apiServerError } from '@/lib/api/respond';
import { createDemoJob, runDemoDeploy, SHOWCASE_APPS } from '@/lib/apps/demo-deploy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  // Rate-limit like any provisioning action (a demo deploy is 14 installs).
  const limited = await enforceRateLimit(s, 'provision');
  if (limited) return limited;

  const cookie = req.headers.get('cookie') || '';
  const origin = req.nextUrl.origin;
  const who = s.claims.upn || s.claims.email || s.claims.oid;

  try {
    const jobId = await createDemoJob(s.claims.oid, who);
    // Fire-and-forget; the Node process stays alive across the response so the
    // orchestrator's same-origin installs complete and the poll observes them.
    void runDemoDeploy({ jobId, tenantId: s.claims.oid, cookie, origin });
    return NextResponse.json({ ok: true, jobId, totalApps: SHOWCASE_APPS.length }, { status: 202 });
  } catch (e: any) {
    return apiServerError(e, 'Failed to start demo deploy');
  }
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  // Best-effort "is a demo already deployed?" — look for any Demo — workspace.
  try {
    const r = await fetch(`${req.nextUrl.origin}/api/workspaces`, { headers: { cookie: req.headers.get('cookie') || '' } });
    const j = await r.json().catch(() => ({}));
    const list = Array.isArray(j) ? j : (j.workspaces || j.items || []);
    const demoWs = list.filter((w: any) => /^Demo — /.test(w.name || w.displayName || ''));
    return NextResponse.json({
      ok: true,
      deployed: demoWs.length > 0,
      demoWorkspaceCount: demoWs.length,
      totalApps: SHOWCASE_APPS.length,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}
