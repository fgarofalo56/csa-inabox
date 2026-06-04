/**
 * GET  /api/loom/shir  → scaled self-hosted IR (SHIR) status: VMSS node count +
 *                        live node states + the registered IR's online nodes.
 * POST /api/loom/shir   body { capacity: 0..8 } → scale the VMSS (0 = stop).
 *
 * Powers the Manage-hub "Self-hosted IR" metrics tile + scale buttons, and is
 * the endpoint the pipeline start/stop automation calls to spin the cluster up
 * before a run and back to zero after.
 *
 * Honest gate (no-vaporware): when the SHIR VMSS env isn't configured (no SHIR
 * deployed in this environment) returns ok:false + code:'not_configured' naming
 * the env var so the UI renders a MessageBar, not a blank tile.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { shirVmssConfig, getVmssStatus, scaleVmss, VmssError } from '@/lib/azure/vmss-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gate() {
  return NextResponse.json(
    {
      ok: false,
      code: 'not_configured',
      missing: 'LOOM_SHIR_VMSS_NAME',
      error:
        'No scaled self-hosted IR is deployed in this environment. Deploy it by setting ' +
        'shirAdminPassword (Key Vault) on the DLZ deployment — the SHIR VMSS is created at ' +
        'scale-to-zero and LOOM_SHIR_VMSS_NAME is wired into the Console env.',
    },
    { status: 200 },
  );
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const cfg = shirVmssConfig();
  if (!cfg) return gate();
  try {
    const status = await getVmssStatus(cfg);
    const running = status.nodes.filter((n) => n.provisioningState === 'Succeeded').length;
    return NextResponse.json({
      ok: true,
      name: status.name,
      capacity: status.capacity,
      provisioningState: status.provisioningState,
      nodeCount: status.nodes.length,
      runningNodes: running,
      nodes: status.nodes,
      state: status.capacity === 0 ? 'Stopped (scale-to-zero)' : `${running}/${status.capacity} nodes`,
    });
  } catch (e: any) {
    const status = e instanceof VmssError ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), hint: 'The Console UAMI needs Virtual Machine Contributor on the SHIR VMSS.' },
      { status: status === 401 || status === 403 ? 200 : status },
    );
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const cfg = shirVmssConfig();
  if (!cfg) return gate();
  const body = (await req.json().catch(() => ({}))) as { capacity?: number };
  if (typeof body.capacity !== 'number') {
    return NextResponse.json({ ok: false, error: 'capacity (0-8) is required' }, { status: 400 });
  }
  try {
    await scaleVmss(cfg, body.capacity);
    return NextResponse.json({ ok: true, name: cfg.name, capacity: body.capacity, message: `Scaling ${cfg.name} to ${body.capacity} node(s).` });
  } catch (e: any) {
    const status = e instanceof VmssError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: status === 400 ? 400 : 502 });
  }
}
