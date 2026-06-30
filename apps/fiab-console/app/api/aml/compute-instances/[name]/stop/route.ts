/**
 * POST /api/aml/compute-instances/[name]/stop
 *
 * Stops a running Azure ML Compute Instance (deallocates the VM so it stops
 * billing). Real ARM:
 *   POST .../workspaces/{ws}/computes/{name}/stop?api-version=2024-10-01  → 202
 * Then probes the CI once so the caller gets the post-stop state.
 *
 * Mirrors the sibling start route: session-gate, amlIsConfigured() honest-200
 * { ok:false, configured:false, hint }, and a 403 → "AzureML Compute Operator"
 * honest gate when the Console UAMI lacks the operator role. Azure-native — no
 * Fabric dependency.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { stopCI, getCI, amlIsConfigured, AmlNotConfiguredError, AmlError } from '@/lib/azure/aml-client';
import { computeRoleGate } from '@/lib/azure/foundry-compute-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const name = decodeURIComponent((await ctx.params).name);
  if (!name) return NextResponse.json({ ok: false, error: 'compute instance name required' }, { status: 400 });

  if (!amlIsConfigured()) {
    const err = new AmlNotConfiguredError(['LOOM_AML_WORKSPACE', 'LOOM_AML_REGION']);
    return NextResponse.json({ ok: false, configured: false, error: 'Azure ML workspace not configured', hint: err.hint }, { status: 200 });
  }

  try {
    await stopCI(name);
    // Best-effort state probe — stop is async (202), so this typically reports
    // 'Stopping'. The editor polls /compute-instances afterwards.
    let state: string | undefined;
    try { state = (await getCI(name))?.state; } catch { /* probe non-fatal */ }
    return NextResponse.json({ ok: true, name, state: state || 'Stopping' });
  } catch (e: any) {
    if (e instanceof AmlNotConfiguredError) {
      return NextResponse.json({ ok: false, configured: false, error: e.message, hint: e.hint }, { status: 200 });
    }
    if (e instanceof AmlError && e.status === 403) {
      return NextResponse.json(computeRoleGate('stop compute instances'), { status: 403 });
    }
    const status = e instanceof AmlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
