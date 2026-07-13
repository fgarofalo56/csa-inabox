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
import { getArmTokenPreferUser } from '@/lib/auth/obo';
import { readDlzDeploymentStatus } from '@/lib/setup/user-arm-deploy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function orchestratorUrl(): string {
  return (process.env.LOOM_SETUP_ORCHESTRATOR_URL || '').trim().replace(/\/+$/, '');
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const url = new URL(req.url);
  const id = (url.searchParams.get('id') || '').trim();
  if (!id) return NextResponse.json({ ok: false, error: 'missing deployment id' }, { status: 400 });

  // ── mode=user-arm: poll the subscription-scoped ARM deployment the deploy route
  // submitted under the SIGNED-IN USER's delegated token. Real ARM GET (no
  // orchestrator needed) so the wizard's "done" step streams live progress on the
  // day-one deploy path. ──────────────────────────────────────────────────────
  if (url.searchParams.get('mode') === 'user-arm') {
    const subscriptionId = (url.searchParams.get('subscriptionId') || '').trim();
    if (!GUID_RE.test(subscriptionId)) {
      return NextResponse.json(
        { ok: false, error: `mode=user-arm requires a valid subscriptionId GUID: ${subscriptionId || '(missing)'}` },
        { status: 400 },
      );
    }
    const arm = await getArmTokenPreferUser(session).catch(() => null);
    if (!arm?.token) {
      return NextResponse.json(
        { ok: false, error: 'Could not acquire an ARM token to read the deployment status.' },
        { status: 502 },
      );
    }
    const st = await readDlzDeploymentStatus({
      subscriptionId,
      deploymentName: id,
      getToken: async () => arm.token,
    });
    if (!st.ok) {
      // The deploy route now returns 202 the instant the ARM PUT is submitted
      // (it backgrounds ARM's long template-validation phase — see
      // user-arm-deploy.ts). During that brief window ARM has not yet REGISTERED
      // the deployment, so a status GET 404s. That is "still submitting", not a
      // failure — report Accepted so the wizard keeps polling instead of erroring.
      if (st.status === 404) {
        return NextResponse.json({
          ok: true,
          deploymentId: id,
          status: 'Accepted',
          provisioningState: 'Accepted',
          progress: 0.15,
          stage: 'Azure Resource Manager: submitting deployment…',
        });
      }
      return NextResponse.json({ ok: false, error: st.error, deploymentId: id }, { status: st.status ?? 502 });
    }
    const state = st.provisioningState || 'Running';
    return NextResponse.json({
      ok: true,
      deploymentId: id,
      status: state,
      provisioningState: state,
      progress: st.progress,
      stage: `Azure Resource Manager: ${state}`,
      ...(state.toLowerCase() === 'failed' || state.toLowerCase() === 'canceled'
        ? { error: `Deployment ${state}` }
        : {}),
    });
  }

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
