/**
 * GET/POST/DELETE /api/governance/policies — tenant governance policies
 * (DLP / masking / RLS rules). Stored as a single doc in the
 * tenant-settings container under `policies:<tenantId>`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Policy {
  id: string;
  name: string;
  kind: 'DLP' | 'Masking' | 'RLS' | 'Retention' | 'Access';
  scope: string;
  rule: string;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
}

interface PoliciesDoc {
  id: string; tenantId: string; kind: 'policies';
  items: Policy[];
  updatedAt: string;
}

async function loadOrSeed(tenantId: string): Promise<PoliciesDoc> {
  const c = await tenantSettingsContainer();
  const docId = `policies:${tenantId}`;
  try {
    const { resource } = await c.item(docId, tenantId).read<PoliciesDoc>();
    if (resource) return resource;
  } catch (e: any) { if (e?.code !== 404) throw e; }
  const seed: PoliciesDoc = {
    id: docId, tenantId, kind: 'policies', items: [], updatedAt: new Date().toISOString(),
  } as any;
  await c.items.create(seed);
  return seed;
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const doc = await loadOrSeed(s.claims.oid);
    return NextResponse.json({ ok: true, policies: doc.items, updatedAt: doc.updatedAt });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const name = (body?.name || '').toString().trim();
  const kind = (body?.kind || '').toString();
  if (!name || !['DLP', 'Masking', 'RLS', 'Retention', 'Access'].includes(kind)) {
    return NextResponse.json({ ok: false, error: 'name + valid kind required' }, { status: 400 });
  }
  try {
    const tenantId = s.claims.oid;
    const c = await tenantSettingsContainer();
    const doc = await loadOrSeed(tenantId);
    const policy: Policy = {
      id: crypto.randomUUID(),
      name, kind: kind as any,
      scope: body?.scope || 'tenant',
      rule: body?.rule || '',
      enabled: body?.enabled !== false,
      createdAt: new Date().toISOString(),
      createdBy: s.claims.upn || tenantId,
    };
    doc.items.push(policy);
    doc.updatedAt = new Date().toISOString();
    await c.item(doc.id, tenantId).replace(doc);
    return NextResponse.json({ ok: true, policy, policies: doc.items });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = (body?.id || '').toString();
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  try {
    const tenantId = s.claims.oid;
    const c = await tenantSettingsContainer();
    const doc = await loadOrSeed(tenantId);
    const ix = doc.items.findIndex((p) => p.id === id);
    if (ix < 0) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    doc.items[ix] = { ...doc.items[ix], ...body, id };
    doc.updatedAt = new Date().toISOString();
    await c.item(doc.id, tenantId).replace(doc);
    return NextResponse.json({ ok: true, policy: doc.items[ix], policies: doc.items });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  try {
    const tenantId = s.claims.oid;
    const c = await tenantSettingsContainer();
    const doc = await loadOrSeed(tenantId);
    const before = doc.items.length;
    doc.items = doc.items.filter((p) => p.id !== id);
    if (doc.items.length === before) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    doc.updatedAt = new Date().toISOString();
    await c.item(doc.id, tenantId).replace(doc);
    return NextResponse.json({ ok: true, policies: doc.items });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
