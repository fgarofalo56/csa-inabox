/**
 * GET /api/items/automl/options
 *
 * Wizard dropdown source: the AutoML wizard's "compute" and "dataset" pickers.
 * Returns the workspace's AmlCompute *clusters* (AutoML sweeps run on a cluster,
 * not a single Compute Instance) and its datastores (each carrying the abfss://
 * path the wizard turns into an MLTable training-data URI) in one call.
 *
 * Real ARM (via aml-client.ts):
 *   GET .../workspaces/{ws}/computes?api-version=2024-10-01    (filter AmlCompute)
 *   GET .../workspaces/{ws}/datastores?api-version=2024-10-01
 *
 * Honest gate: 200 + { ok:false, configured:false, hint } when the AML workspace
 * env is unset, so the wizard shows a Fluent MessageBar naming the exact var.
 * Azure-native default — no Fabric dependency (works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listComputes,
  listAmlDatastores,
  amlIsConfigured,
  amlConfig,
  AmlNotConfiguredError,
  AmlError,
} from '@/lib/azure/aml-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  if (!amlIsConfigured()) {
    const err = new AmlNotConfiguredError(['LOOM_AML_WORKSPACE', 'LOOM_AML_REGION']);
    return NextResponse.json(
      {
        ok: false,
        configured: false,
        error: 'Azure ML workspace not configured',
        hint: err.hint,
        clusters: [],
        datastores: [],
      },
      { status: 200 },
    );
  }

  try {
    const cfg = amlConfig();
    const [computes, datastores] = await Promise.all([listComputes(), listAmlDatastores()]);
    const clusters = computes
      .filter((c) => (c.computeType || '') === 'AmlCompute')
      .map((c) => ({ name: c.name, vmSize: c.vmSize, state: c.state, provisioningState: c.provisioningState }));
    return NextResponse.json({
      ok: true,
      configured: true,
      workspace: cfg.workspace,
      clusters,
      // Honest signal for the wizard: AutoML sweeps REQUIRE an AmlCompute
      // cluster. When none exists the wizard shows a MessageBar instead of an
      // empty dropdown + a submit that can't succeed (no-vaporware.md).
      needsCompute: clusters.length === 0,
      ...(clusters.length === 0
        ? { computeHint: `No AmlCompute cluster exists in workspace '${cfg.workspace}'. Create an AmlCompute cluster (Azure ML Studio → Compute → Compute clusters, or the Compute item) before submitting an AutoML run.` }
        : {}),
      datastores: datastores.map((d) => ({
        name: d.name,
        datastoreType: d.datastoreType,
        isDefault: !!d.isDefault,
        // abfss:// path the wizard appends an MLTable folder onto.
        path: d.abfssPath || d.wasbsPath || null,
      })),
    });
  } catch (e: any) {
    if (e instanceof AmlNotConfiguredError) {
      return NextResponse.json(
        { ok: false, configured: false, error: e.message, hint: e.hint, clusters: [], datastores: [] },
        { status: 200 },
      );
    }
    const status = e instanceof AmlError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
