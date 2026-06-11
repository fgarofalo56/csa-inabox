/**
 * /api/mdm/models — MDM match/survivorship model CRUD (Cosmos mdm-models:<tenantId>).
 * GET → list · POST → upsert (validated) · DELETE ?id → remove. Azure-native, no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listModels, upsertModel, deleteModel, normalizeModel } from '@/lib/azure/mdm-store';
import { SURVIVORSHIP_STRATEGIES, MATCH_TYPES } from '@/lib/azure/mdm-match-merge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const models = await listModels(s.claims.oid);
    return NextResponse.json({ ok: true, models, enums: { survivorship: SURVIVORSHIP_STRATEGIES, matchTypes: MATCH_TYPES } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const { model, errors } = normalizeModel(body, body?.id);
  if (errors.length || !model) return NextResponse.json({ ok: false, errors }, { status: 400 });
  try {
    const models = await upsertModel(s.claims.oid, model);
    return NextResponse.json({ ok: true, model, models });
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
    const models = await deleteModel(s.claims.oid, id);
    return NextResponse.json({ ok: true, models });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
