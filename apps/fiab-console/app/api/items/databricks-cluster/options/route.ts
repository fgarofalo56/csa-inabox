/**
 * GET /api/items/databricks-cluster/options
 *   → { ok, nodeTypes, sparkVersions }
 *
 * Populates the cluster-create form dropdowns. Cached for 5 min
 * via Cache-Control to keep the form snappy.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listNodeTypes, listSparkVersions } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const [nodeTypes, sparkVersions] = await Promise.all([
      listNodeTypes(),
      listSparkVersions(),
    ]);
    return NextResponse.json(
      { ok: true, nodeTypes, sparkVersions },
      { headers: { 'cache-control': 'private, max-age=300' } },
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: e?.status === 403 ? 403 : 502 },
    );
  }
}
