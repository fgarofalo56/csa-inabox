/**
 * GET /api/aml/computes
 *
 * Lists ALL Azure Machine Learning computes in the workspace (clusters +
 * instances). AutoML trials run on an AmlCompute *cluster* (not a Compute
 * Instance), so the AutoML wizard's compute dropdown reads this route and
 * filters to computeType === 'AmlCompute'.
 *
 * Real ARM (lib/azure/aml-client.ts):
 *   GET .../workspaces/{ws}/computes?api-version=2024-10-01
 * https://learn.microsoft.com/rest/api/azureml/compute/list
 *
 * Honest gate: 200 with { ok: true, configured: false, missing, hint } when the
 * AML workspace env isn't set. Azure-native default — no Fabric dependency.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listComputes, amlConfigGate, AmlError } from '@/lib/azure/aml-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = amlConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: true,
      configured: false,
      computes: [],
      missing: gate.missing,
      hint:
        `Azure ML workspace not addressable (missing ${gate.missing}). ` +
        'Create an AmlCompute cluster (az ml compute create --type amlcompute) ' +
        'once the workspace env is set.',
    });
  }

  try {
    const computes = await listComputes();
    return NextResponse.json({
      ok: true,
      configured: true,
      computes: computes.map((c) => ({
        name: c.name,
        computeType: c.computeType,
        vmSize: c.vmSize,
        state: c.state,
        provisioningState: c.provisioningState,
      })),
    });
  } catch (e: any) {
    const status = e instanceof AmlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
