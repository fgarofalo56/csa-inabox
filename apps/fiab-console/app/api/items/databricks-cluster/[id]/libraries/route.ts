/**
 * GET /api/items/databricks-cluster/[id]/libraries?clusterId=abc
 *   → { ok, libraries }
 *
 * Read-only listing of libraries attached to a Databricks cluster. The
 * Databricks `/api/2.0/libraries/cluster-status` REST returns per-library
 * install state (INSTALLED, PENDING, FAILED, RESOLVING, etc.) and any
 * messages from the install process. Install / uninstall lives in the
 * Databricks UI today because each non-public source (private PyPI, ADO
 * artifact feeds, JARs in protected blob containers) needs its own
 * credential dance — out of scope for Loom v3.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listClusterLibraries } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const cid = req.nextUrl.searchParams.get('clusterId');
  if (!cid) return NextResponse.json({ ok: false, error: 'clusterId is required' }, { status: 400 });
  try {
    const libraries = await listClusterLibraries(cid);
    return NextResponse.json({ ok: true, libraries });
  } catch (e: any) {
    const status = e?.status === 403 ? 403 : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
