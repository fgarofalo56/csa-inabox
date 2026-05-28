/**
 * /api/admin/security/purview/sources
 *
 * GET    → list registered Purview data sources (real GET /scan/datasources)
 * POST   → register a new source { name, kind, properties }
 * DELETE → de-register by ?name=<sourceName>
 *
 * 503 → Purview not configured (LOOM_PURVIEW_ACCOUNT unset). Body carries
 * the structured hint payload from PurviewNotConfiguredError.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listDataSources,
  registerDataSource,
  deleteDataSource,
} from '@/lib/azure/purview-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const sources = await listDataSources();
    return NextResponse.json({ ok: true, sources, source: 'purview-scan-api' });
  } catch (e) { return handleSecurityError(e); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }
  if (!body?.name || !body?.kind || !body?.properties) {
    return NextResponse.json({ ok: false, error: 'name, kind, and properties are required' }, { status: 400 });
  }
  try {
    const ds = await registerDataSource({ name: body.name, kind: body.kind, properties: body.properties });
    return NextResponse.json({ ok: true, source: ds }, { status: 201 });
  } catch (e) { return handleSecurityError(e); }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const name = req.nextUrl.searchParams.get('name');
  if (!name) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });
  try {
    const deleted = await deleteDataSource(name);
    return NextResponse.json({ ok: true, deleted });
  } catch (e) { return handleSecurityError(e); }
}
