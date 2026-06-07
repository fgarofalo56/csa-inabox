/**
 * GET /api/aml/compute-instances
 *
 * Lists the Azure Machine Learning workspace's Compute Instances (CI) — the
 * compute a notebook runs on, on the AML path. Real ARM:
 *   GET .../workspaces/{ws}/computes?api-version=2024-10-01
 * filtered to computeType === 'ComputeInstance'.
 *
 * Honest gate: when the AML workspace env isn't configured we return 200 with
 * { ok: false, configured: false, hint } so the editor's CI picker shows a
 * Fluent MessageBar. Azure-native default — no Fabric dependency.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listCIs, ciIsRunning, ciIsStopped, amlIsConfigured, amlConfig, AmlNotConfiguredError, AmlError } from '@/lib/azure/aml-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  if (!amlIsConfigured()) {
    const err = new AmlNotConfiguredError(['LOOM_AML_WORKSPACE', 'LOOM_AML_REGION']);
    return NextResponse.json(
      { ok: false, configured: false, error: 'Azure ML workspace not configured', hint: err.hint, instances: [] },
      { status: 200 },
    );
  }

  try {
    const cfg = amlConfig();
    const cis = await listCIs();
    return NextResponse.json({
      ok: true,
      configured: true,
      workspace: cfg.workspace,
      instances: cis.map((c) => ({
        name: c.name,
        vmSize: c.vmSize,
        state: c.state,
        running: ciIsRunning(c.state),
        stopped: ciIsStopped(c.state),
      })),
    });
  } catch (e: any) {
    if (e instanceof AmlNotConfiguredError) {
      return NextResponse.json({ ok: false, configured: false, error: e.message, hint: e.hint, instances: [] }, { status: 200 });
    }
    const status = e instanceof AmlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
