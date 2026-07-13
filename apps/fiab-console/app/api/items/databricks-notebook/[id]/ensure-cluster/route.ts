/**
 * POST /api/items/databricks-notebook/[id]/ensure-cluster
 *   → { ok: true, clusterId, state, created, starting }
 *   → { ok: false, code?: 'not_configured', error, remediation? }
 *
 * Resolves — or auto-creates + starts — a runnable all-purpose Databricks
 * cluster so a user can open a notebook and Run without any manual cluster
 * setup. Shares `ensureRunnableCluster` with the install provisioners; autoStart
 * is true here because the editor's Command Execution path needs a RUNNING
 * cluster (unlike jobs/runs/submit, which auto-starts on submit).
 *
 * When Databricks isn't configured or the UAMI lacks list/create RBAC, returns
 * an honest gate (per no-vaporware) naming the exact env var / entitlement.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate, getCluster } from '@/lib/azure/databricks-client';
import { ensureRunnableCluster } from '@/lib/azure/databricks-default-cluster';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const cfg = databricksConfigGate();
  if (cfg) {
    return NextResponse.json(
      {
        ok: false,
        code: 'not_configured',
        error: `Databricks workspace is not configured for this deployment.`,
        remediation: `Set ${cfg.missing} (the Databricks workspace hostname) so notebooks can run.`,
      },
      { status: 503 },
    );
  }

  const res = await ensureRunnableCluster({ autoStart: true });
  if (res.gate || !res.clusterId) {
    return NextResponse.json(
      {
        ok: false,
        error: res.gate?.reason || 'No runnable Databricks cluster could be resolved.',
        remediation: res.gate?.remediation,
      },
      { status: 502 },
    );
  }

  // Report the live state so the editor can show "starting (2–5 min)" until the
  // freshly created/started cluster reaches RUNNING. Best-effort — a create
  // returns PENDING and getCluster confirms it.
  let state: string | undefined;
  try {
    const c = await getCluster(res.clusterId);
    state = c.state;
  } catch {
    state = res.starting ? 'PENDING' : undefined;
  }

  return NextResponse.json({
    ok: true,
    clusterId: res.clusterId,
    state,
    created: !!res.created,
    starting: !!res.starting,
  });
}
