/**
 * Eventstream — Spark structured-streaming binding (notebook-sink routing).
 *
 * Kills the day-one "Requires a Spark structured-streaming binding … set
 * LOOM_SYNAPSE_WORKSPACE or LOOM_DATABRICKS_WORKSPACE_URL" gate: the binding is
 * AUTO-DETECTED server-side (runtime admin setting > env), and when genuinely
 * unbound, an admin can discover REAL workspaces (ARM list) and persist a
 * binding without a redeploy.
 *
 *   GET  /api/items/eventstream/spark-binding
 *        → { ok, bound, kind?, synapseWorkspace?, databricksUrl?, source?, isAdmin }
 *        ?discover=1 (tenant admin) additionally returns
 *        { options: { synapseWorkspaces: [{name,id}], databricksWorkspaces: [{name,url}] } }
 *        via real ARM list calls (Microsoft.Synapse / Microsoft.Databricks).
 *
 *   PUT  /api/items/eventstream/spark-binding   (tenant admin)
 *        body { kind: 'synapse'|'databricks', synapseWorkspace?|databricksUrl? }
 *        Persists to the singleton platform-settings doc (real Cosmos upsert).
 *
 * Azure-native only — no Microsoft Fabric involved (no-fabric-dependency.md).
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiServerError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import {
  resolveSparkStreamingBinding,
  writeSparkStreamingBinding,
  type SparkStreamingBinding,
} from '@/lib/admin/platform-settings';
import { armGet } from '@/lib/azure/arm-client';
import { listDatabricksWorkspaces } from '@/lib/azure/databricks-discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SYNAPSE_API = '2021-06-01';

/** Real ARM list of Synapse workspaces in the deployment subscription. */
async function listSynapseWorkspaces(): Promise<Array<{ name: string; id: string }>> {
  const sub = (process.env.LOOM_SUBSCRIPTION_ID || '').trim();
  if (!sub) return [];
  const out: Array<{ name: string; id: string }> = [];
  let path: string | null = `/subscriptions/${sub}/providers/Microsoft.Synapse/workspaces?api-version=${SYNAPSE_API}`;
  let guard = 0;
  while (path && guard < 20) {
    guard += 1;
    const page: { value?: Array<{ name?: string; id?: string }>; nextLink?: string } = await armGet(path);
    for (const w of page.value || []) {
      if (w?.name && w?.id) out.push({ name: w.name, id: w.id });
    }
    path = page.nextLink ? page.nextLink.replace(/^https?:\/\/[^/]+/i, '') : null;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const admin = isTenantAdmin(session);
  try {
    const binding = await resolveSparkStreamingBinding();
    const base = {
      ok: true as const,
      bound: !!binding,
      kind: binding?.kind,
      synapseWorkspace: binding?.synapseWorkspace,
      databricksUrl: binding?.databricksUrl,
      source: binding?.source,
      isAdmin: admin,
    };
    if (req.nextUrl.searchParams.get('discover') !== '1') {
      return NextResponse.json(base);
    }
    if (!admin) {
      return NextResponse.json({ ok: false, error: 'forbidden — workspace discovery is admin-only' }, { status: 403 });
    }
    // Real ARM discovery; per-provider failures don't blank the other list.
    const [synapseWorkspaces, databricks] = await Promise.all([
      listSynapseWorkspaces().catch(() => [] as Array<{ name: string; id: string }>),
      listDatabricksWorkspaces().catch(() => []),
    ]);
    return NextResponse.json({
      ...base,
      options: {
        synapseWorkspaces,
        databricksWorkspaces: databricks.map((w) => ({ name: w.name, url: `https://${w.workspaceUrl}` })),
      },
    });
  } catch (e: unknown) {
    return apiServerError(e, 'failed to resolve the Spark streaming binding', 'spark_binding_resolve_failed');
  }
}

export async function PUT(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdmin(session)) {
    return NextResponse.json(
      { ok: false, error: 'forbidden — binding the Spark streaming workspace is admin-only' },
      { status: 403 },
    );
  }
  const body = await req.json().catch(() => ({} as any));
  const kind = body?.kind === 'databricks' ? 'databricks' : body?.kind === 'synapse' ? 'synapse' : null;
  if (!kind) return NextResponse.json({ ok: false, error: "kind must be 'synapse' or 'databricks'" }, { status: 400 });
  const synapseWorkspace = typeof body?.synapseWorkspace === 'string' ? body.synapseWorkspace.trim() : '';
  const databricksUrl = typeof body?.databricksUrl === 'string' ? body.databricksUrl.trim() : '';
  if (kind === 'synapse' && !synapseWorkspace) {
    return NextResponse.json({ ok: false, error: 'synapseWorkspace is required for kind synapse' }, { status: 400 });
  }
  if (kind === 'databricks' && !/^https:\/\/.+/i.test(databricksUrl)) {
    return NextResponse.json({ ok: false, error: 'databricksUrl (https://…) is required for kind databricks' }, { status: 400 });
  }
  const binding: SparkStreamingBinding =
    kind === 'synapse' ? { kind, synapseWorkspace } : { kind, databricksUrl };
  try {
    await writeSparkStreamingBinding(binding, session.claims.oid);
    return NextResponse.json({ ok: true, binding: { ...binding, source: 'runtime' } });
  } catch (e: unknown) {
    return apiServerError(e, 'failed to save the Spark streaming binding', 'spark_binding_save_failed');
  }
}
