/**
 * GET    /api/workloads-catalog          — list workloads available for the tenant.
 * POST   /api/workloads-catalog          — admin add a custom workload to the org catalog.
 * PATCH  /api/workloads-catalog?id=…      — update an org catalog row (e.g. toggle `included`).
 * DELETE /api/workloads-catalog?id=…      — remove a custom workload from the org catalog.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workloadsCatalogContainer } from '@/lib/azure/cosmos-client';
import crypto from 'node:crypto';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const c = await workloadsCatalogContainer();
  let { resources } = await c.items
    .query({ query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.name', parameters: [{ name: '@t', value: s.claims.oid }] })
    .fetchAll();

  if (resources.length === 0) {
    const { resources: global } = await c.items
      .query({ query: 'SELECT * FROM c WHERE c.tenantId = @t', parameters: [{ name: '@t', value: 'GLOBAL' }] })
      .fetchAll();
    if (global.length > 0) {
      const now = new Date().toISOString();
      for (const src of global) {
        const copy: any = { ...src, tenantId: s.claims.oid, copiedFromGlobalAt: now };
        delete copy._etag; delete copy._rid; delete copy._self; delete copy._ts; delete copy._attachments;
        await c.items.upsert(copy).catch(() => {});
      }
      const refetched = await c.items
        .query({ query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.name', parameters: [{ name: '@t', value: s.claims.oid }] })
        .fetchAll();
      resources = refetched.resources;
    }
  }
  return NextResponse.json({ ok: true, workloads: resources });
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  const c = await workloadsCatalogContainer();
  const now = new Date().toISOString();
  const doc = {
    id: crypto.randomUUID(),
    tenantId: s.claims.oid,
    name: body.name,
    description: body.description || '',
    publisher: body.publisher || s.claims.upn,
    category: body.category || 'Org',
    included: body.included ?? false,
    featureSlugs: body.featureSlugs || [],
    iconUrl: body.iconUrl || null,
    createdBy: s.claims.upn,
    createdAt: now,
    updatedAt: now,
  };
  const { resource } = await c.items.create(doc);
  return NextResponse.json({ ok: true, workload: resource }, { status: 201 });
}

/** Update an org catalog row this tenant owns — currently the `included` toggle. */
export async function PATCH(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  const body = await req.json().catch(() => ({}));
  const c = await workloadsCatalogContainer();
  const { resource: existing } = await c.item(id, s.claims.oid).read().catch(() => ({ resource: null as any }));
  if (!existing) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const updated: any = {
    ...existing,
    ...(typeof body.included === 'boolean' ? { included: body.included } : {}),
    ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim() } : {}),
    ...(typeof body.description === 'string' ? { description: body.description } : {}),
    ...(typeof body.category === 'string' && body.category.trim() ? { category: body.category.trim() } : {}),
    ...(Array.isArray(body.featureSlugs) ? { featureSlugs: body.featureSlugs } : {}),
    updatedAt: new Date().toISOString(),
    updatedBy: s.claims.upn,
  };
  const { resource } = await c.item(id, s.claims.oid).replace(updated);
  return NextResponse.json({ ok: true, workload: resource });
}

/** Remove a custom org catalog row this tenant owns. */
export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  const c = await workloadsCatalogContainer();
  try {
    await c.item(id, s.claims.oid).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true });
    return apiServerError(e);
  }
}
