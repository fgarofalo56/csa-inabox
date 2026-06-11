/**
 * /api/mdm/reference-data — managed reference-data / code lists (RDM half of
 * MDM). Versioned per set (version bumps on each save). Cosmos mdm-refdata:<tenantId>.
 * GET → list · POST → upsert (validated, version++) · DELETE ?id → remove.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listReferenceData, upsertReferenceData, deleteReferenceData } from '@/lib/azure/mdm-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const sets = await listReferenceData(s.claims.oid);
    return NextResponse.json({ ok: true, sets });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  try {
    const { items, set, errors } = await upsertReferenceData(s.claims.oid, body);
    if (errors.length) return NextResponse.json({ ok: false, errors }, { status: 400 });
    return NextResponse.json({ ok: true, set, sets: items });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 });
  try {
    const sets = await deleteReferenceData(s.claims.oid, id);
    return NextResponse.json({ ok: true, sets });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
