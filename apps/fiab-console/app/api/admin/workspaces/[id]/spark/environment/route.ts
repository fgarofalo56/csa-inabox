/**
 * Spark / compute configuration — Environment tab (F13).
 *
 *   GET  /api/admin/workspaces/[id]/spark/environment[?clusterId=...]
 *          → { ok, clusters: {id,name,state}[], libraries: LibraryStatus[],
 *              config: WorkspaceSparkConfig['environment'] }
 *          libraries are the LIVE install state on the chosen cluster; when no
 *          clusterId is supplied the list is empty and the UI prompts for one.
 *   POST /api/admin/workspaces/[id]/spark/environment
 *          body { action: 'save', pypi?: string[], maven?: string[],
 *                 sessionLevelPackages?: boolean }
 *                 → persist the workspace library set to Cosmos
 *          body { action: 'install', clusterId, pypi?, maven? }
 *                 → real Databricks /api/2.0/libraries/install + persist
 *          body { action: 'uninstall', clusterId, pypi?, maven? }
 *                 → real Databricks /api/2.0/libraries/uninstall (applies on
 *                   next cluster restart) + persist remaining set
 *
 * Azure-native default (Databricks libraries); honest 503 gate when no host.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  sparkConfigGate,
  getSparkConfig,
  upsertSparkConfig,
  listWorkspaceClusters,
  listEnvironmentLibraries,
  installEnvironmentLibraries,
  uninstallEnvironmentLibraries,
  toLibrarySpecs,
} from '@/lib/clients/spark-config-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gateOr401() {
  const s = getSession();
  if (!s) return { resp: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  const g = sparkConfigGate();
  if (g) {
    return {
      resp: NextResponse.json(
        { ok: false, gated: true, code: g.code, error: g.message, missing: g.missing },
        { status: 503 },
      ),
    };
  }
  return { session: s };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = gateOr401();
  if (guard.resp) return guard.resp;
  const { id } = await ctx.params;
  const clusterId = req.nextUrl.searchParams.get('clusterId') || '';
  try {
    const [clusters, config] = await Promise.all([listWorkspaceClusters(), getSparkConfig(id)]);
    let libraries: any[] = [];
    if (clusterId) libraries = await listEnvironmentLibraries(clusterId);
    return NextResponse.json({
      ok: true,
      clusters: clusters.map((c) => ({
        id: c.cluster_id,
        name: c.cluster_name,
        state: c.state,
      })),
      libraries,
      clusterId,
      config: config.environment,
      note: clusterId ? undefined : 'Pick a cluster to view or install live libraries.',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = gateOr401();
  if (guard.resp) return guard.resp;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    action?: 'save' | 'install' | 'uninstall';
    clusterId?: string;
    pypi?: string[];
    maven?: string[];
    sessionLevelPackages?: boolean;
  };
  const oid = guard.session!.claims.oid;
  try {
    if (body.action === 'save') {
      const config = await upsertSparkConfig(
        id,
        {
          environment: {
            pypi: (body.pypi || []).map((p) => p.trim()).filter(Boolean),
            maven: (body.maven || []).map((m) => m.trim()).filter(Boolean),
            sessionLevelPackages: !!body.sessionLevelPackages,
          },
        },
        oid,
      );
      return NextResponse.json({ ok: true, config: config.environment });
    }
    if (body.action === 'install' || body.action === 'uninstall') {
      if (!body.clusterId) {
        return NextResponse.json(
          { ok: false, error: 'clusterId is required to install/uninstall live libraries' },
          { status: 400 },
        );
      }
      const specs = toLibrarySpecs({ pypi: body.pypi, maven: body.maven });
      if (specs.length === 0) {
        return NextResponse.json({ ok: false, error: 'no libraries supplied' }, { status: 400 });
      }
      if (body.action === 'install') {
        await installEnvironmentLibraries(body.clusterId, specs);
      } else {
        await uninstallEnvironmentLibraries(body.clusterId, specs);
      }
      // Reflect the change in the persisted workspace library set.
      const current = await getSparkConfig(id);
      const curPypi = new Set(current.environment.pypi || []);
      const curMaven = new Set(current.environment.maven || []);
      for (const p of (body.pypi || []).map((x) => x.trim()).filter(Boolean)) {
        if (body.action === 'install') curPypi.add(p);
        else curPypi.delete(p);
      }
      for (const m of (body.maven || []).map((x) => x.trim()).filter(Boolean)) {
        if (body.action === 'install') curMaven.add(m);
        else curMaven.delete(m);
      }
      const config = await upsertSparkConfig(
        id,
        { environment: { pypi: [...curPypi], maven: [...curMaven] } },
        oid,
      );
      // Return the refreshed live status for the cluster.
      const libraries = await listEnvironmentLibraries(body.clusterId);
      return NextResponse.json({ ok: true, config: config.environment, libraries });
    }
    return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
