/**
 * GET  /api/admin/domains — list tenant domains
 * POST /api/admin/domains   body: { id, name, description?, color? }
 * Per-domain delete lives at /api/admin/domains/[id]
 *
 * Backed by Cosmos tenant-settings container under id="domains:<tenantId>"
 * to avoid spinning up a new container for a low-cardinality list.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DomainsDoc {
  id: string;
  tenantId: string;
  kind: 'domains';
  items: Array<{ id: string; name: string; description?: string; color?: string; createdAt: string; createdBy: string }>;
  updatedAt: string;
}

async function loadOrSeed(tenantId: string, who: string): Promise<DomainsDoc> {
  const c = await tenantSettingsContainer();
  const docId = `domains:${tenantId}`;
  try {
    const { resource } = await c.item(docId, tenantId).read<DomainsDoc>();
    if (resource) return resource;
  } catch (e: any) { if (e?.code !== 404) throw e; }
  const seed: DomainsDoc = {
    id: docId, tenantId, kind: 'domains', items: [],
    updatedAt: new Date().toISOString(),
  } as any;
  await c.items.create(seed);
  return seed;
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  try {
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    return NextResponse.json({ ok: true, domains: doc.items, updatedAt: doc.updatedAt });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const body = await req.json().catch(() => ({}));
  const id = (body?.id || '').toString().trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const name = (body?.name || '').toString().trim();
  if (!id || !name) return NextResponse.json({ ok: false, error: 'id and name required' }, { status: 400 });
  try {
    const c = await tenantSettingsContainer();
    const docId = `domains:${tenantId}`;
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    if (doc.items.some((d) => d.id === id)) {
      return NextResponse.json({ ok: false, error: `domain '${id}' already exists` }, { status: 409 });
    }
    doc.items.push({
      id, name,
      description: body?.description || undefined,
      color: body?.color || undefined,
      createdAt: new Date().toISOString(),
      createdBy: s.claims.upn || tenantId,
    });
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);
    return NextResponse.json({ ok: true, domain: doc.items[doc.items.length - 1], domains: doc.items });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 });
  try {
    const c = await tenantSettingsContainer();
    const docId = `domains:${tenantId}`;
    const doc = await loadOrSeed(tenantId, s.claims.upn || tenantId);
    const before = doc.items.length;
    doc.items = doc.items.filter((d) => d.id !== id);
    if (doc.items.length === before) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    doc.updatedAt = new Date().toISOString();
    await c.item(docId, tenantId).replace(doc);
    return NextResponse.json({ ok: true, domains: doc.items });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
