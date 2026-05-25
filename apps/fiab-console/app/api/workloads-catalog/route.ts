/**
 * GET  /api/workloads-catalog — list workloads available for the tenant.
 * POST /api/workloads-catalog — admin add a custom workload to the org catalog.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workloadsCatalogContainer } from '@/lib/azure/cosmos-client';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const c = await workloadsCatalogContainer();
  const { resources } = await c.items
    .query({ query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.name', parameters: [{ name: '@t', value: s.claims.oid }] })
    .fetchAll();
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
