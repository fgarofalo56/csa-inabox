/**
 * GET  /api/items/databricks-cluster                 → { ok, clusters }
 * POST /api/items/databricks-cluster body { spec }   → { ok, cluster_id }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listClusters, createCluster } from '@/lib/azure/databricks-client';
import { databricksClusterLogConf } from '@/lib/spark/config-presets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const clusters = await listClusters();
    return NextResponse.json({ ok: true, clusters });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: e?.status === 403 ? 403 : 502 },
    );
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const spec = body?.spec ?? body;
  if (!spec?.cluster_name || !spec?.node_type_id || !spec?.spark_version) {
    return NextResponse.json(
      { ok: false, error: 'spec.cluster_name, node_type_id, spark_version are required' },
      { status: 400 },
    );
  }
  // Stamp the Loom hygiene/cost tags (preserve any the client already set) and
  // inject honest log delivery when LOOM_DATABRICKS_CLUSTER_LOG_PATH is set —
  // so every editor-created cluster is Loom-managed + auditable, matching the
  // compute-targets create path.
  spec.custom_tags = { 'loom-managed': 'true', ...(spec.custom_tags || {}) };
  if (!spec.cluster_log_conf) {
    const logConf = databricksClusterLogConf();
    if (logConf) spec.cluster_log_conf = logConf;
  }
  try {
    const r = await createCluster(spec);
    return NextResponse.json({ ok: true, ...r });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: e?.status === 403 ? 403 : 502 },
    );
  }
}
