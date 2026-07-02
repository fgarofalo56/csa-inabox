/**
 * GET    /api/items/databricks-cluster/[id]/libraries?clusterId=abc → { ok, libraries }
 * POST   /api/items/databricks-cluster/[id]/libraries  body { clusterId, libraries:[...] } → install
 * DELETE /api/items/databricks-cluster/[id]/libraries?clusterId=abc body { libraries:[...] } → uninstall
 *
 * Real Databricks Libraries REST (api 2.0): cluster-status / install / uninstall.
 * Install is async — the UI re-polls cluster-status to surface INSTALLING→INSTALLED.
 * Uninstall takes effect after the next cluster restart.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listClusterLibraries, installClusterLibraries, uninstallClusterLibraries, type LibrarySpec,
} from '@/lib/azure/databricks-client';

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

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const cid: string = body?.clusterId || req.nextUrl.searchParams.get('clusterId') || '';
  const libraries: LibrarySpec[] = Array.isArray(body?.libraries) ? body.libraries : [];
  if (!cid) return NextResponse.json({ ok: false, error: 'clusterId is required' }, { status: 400 });
  if (libraries.length === 0) return NextResponse.json({ ok: false, error: 'libraries[] is required' }, { status: 400 });
  try {
    await installClusterLibraries(cid, libraries);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const cid: string = body?.clusterId || req.nextUrl.searchParams.get('clusterId') || '';
  const libraries: LibrarySpec[] = Array.isArray(body?.libraries) ? body.libraries : [];
  if (!cid) return NextResponse.json({ ok: false, error: 'clusterId is required' }, { status: 400 });
  if (libraries.length === 0) return NextResponse.json({ ok: false, error: 'libraries[] is required' }, { status: 400 });
  try {
    await uninstallClusterLibraries(cid, libraries);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
