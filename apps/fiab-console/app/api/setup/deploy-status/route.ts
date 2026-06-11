/**
 * GET /api/setup/deploy-status?id=<deploymentId>
 *   Streams the live status of a deployment the Setup Orchestrator is running.
 *   Proxies the orchestrator's `GET {LOOM_SETUP_ORCHESTRATOR_URL}/api/setup/{id}`
 *   over the CAE-internal ingress (Bearer LOOM_INTERNAL_TOKEN), so the wizard's
 *   "done" step can poll real progress without exposing the orchestrator.
 *
 *   When the orchestrator isn't deployed (LOOM_SETUP_ORCHESTRATOR_URL unset) the
 *   route returns 503 with an honest hint — the wizard then relies on its GitHub
 *   Actions run-status stream or the copy-paste `az` fallback instead.
 *
 * Response shape (passthrough of the orchestrator's status document):
 *   { ok: true,  deploymentId, status, progress?, stage?, error? }
 *   { ok: false, error }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function orchestratorUrl(): string {
  return (process.env.LOOM_SETUP_ORCHESTRATOR_URL || '').trim().replace(/\/+$/, '');
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const id = (new URL(req.url).searchParams.get('id') || '').trim();
  if (!id) return NextResponse.json({ ok: false, error: 'missing deployment id' }, { status: 400 });

  const orchUrl = orchestratorUrl();
  if (!orchUrl) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Setup Orchestrator is not deployed here (LOOM_SETUP_ORCHESTRATOR_URL unset).',
        hint: 'Deploy platform/fiab/bicep/modules/admin-plane/setup-orchestrator.bicep, or track the deployment via GitHub Actions.',
      },
      { status: 503 },
    );
  }

  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    const internalToken = (process.env.LOOM_INTERNAL_TOKEN || '').trim();
    if (internalToken) headers.authorization = `Bearer ${internalToken}`;
    const res = await fetch(`${orchUrl}/api/setup/${encodeURIComponent(id)}`, { headers, cache: 'no-store' });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: j.error || j.message || j.detail || `Orchestrator status ${res.status}` },
        { status: 502 },
      );
    }
    // The orchestrator's DeploymentStatus is snake_case (deployment_id,
    // current_stage, started_at, …); pass it through verbatim alongside ok.
    return NextResponse.json({ ok: true, deploymentId: id, ...j });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Orchestrator status request failed: ${e?.message ?? String(e)}` },
      { status: 502 },
    );
  }
}
