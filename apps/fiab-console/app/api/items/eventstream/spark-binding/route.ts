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
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import {
  resolveSparkStreamingBinding,
  writeSparkStreamingBinding,
  type SparkStreamingBinding,
} from '@/lib/admin/platform-settings';
import { armGet } from '@/lib/azure/arm-client';
import { walkPagedList } from '@/lib/azure/paging-budget';
import { listDatabricksWorkspaces } from '@/lib/azure/databricks-discovery';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SYNAPSE_API = '2021-06-01';

/**
 * Real ARM list of Synapse workspaces in the deployment subscription.
 *
 * BOUNDED by the shared paging budget (#2557/#2582): the old `guard < 20`
 * capped pages only, and 20 pages x the 30s per-request ceiling is 10 minutes
 * inside a route whose own `maxDuration` is far smaller. A deadline inside a
 * page fetch truncates (workspaces already collected are kept) instead of
 * throwing, so a slow ARM never renders as "no Synapse workspaces exist" — the
 * binding picker would then push the operator to provision a duplicate.
 */
async function listSynapseWorkspaces(): Promise<Array<{ name: string; id: string }>> {
  const sub = (process.env.LOOM_SUBSCRIPTION_ID || '').trim();
  if (!sub) return [];
  const first = `/subscriptions/${sub}/providers/Microsoft.Synapse/workspaces?api-version=${SYNAPSE_API}`;
  const rows = await walkPagedList<{ name?: string; id?: string }>(
    'spark-binding synapse workspaces',
    // nextLink is absolute; strip the host so armGet re-prefixes the ARM base.
    (next, timeoutMs) => armGet(next ? next.replace(/^https?:\/\/[^/]+/i, '') : first, timeoutMs),
    { maxPages: 20 },
  );
  const out = rows
    .filter((w): w is { name: string; id: string } => !!(w?.name && w?.id))
    .map((w) => ({ name: w.name, id: w.id }));
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export const GET = withSession(async (req: NextRequest, { session }) => {
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
});

export const PUT = withSession(async (req: NextRequest, { session }) => {
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
});
