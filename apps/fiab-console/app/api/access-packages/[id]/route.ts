/**
 * A single access package (access-governance W2).
 *
 *   GET    /api/access-packages/[id]   → the package (auth; non-admins only see
 *                                        enabled+requestable ones)
 *   PUT    /api/access-packages/[id]   → update (tenant-admin)
 *   DELETE /api/access-packages/[id]   → delete (tenant-admin)
 *
 * PK is /tenantId, so mutations resolve the doc by id (cross-partition) first to
 * learn its partition key. Backed by `access-packages`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin, isTenantAdmin } from '@/lib/auth/feature-gate';
import { accessPackagesContainer } from '@/lib/azure/cosmos-client';
import type { AccessPackage } from '@/lib/types/access-package';
import { apiServerError } from '@/lib/api/respond';
import { sanitizePackage } from '../route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function readById(id: string): Promise<AccessPackage | null> {
  const c = await accessPackagesContainer();
  const { resources } = await c.items
    .query<AccessPackage>({ query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: id }] })
    .fetchAll();
  return resources[0] || null;
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const pkg = await readById(id);
    if (!pkg) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    if (!(pkg.enabled && pkg.requestable) && !isTenantAdmin(s)) {
      return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, package: pkg });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  try {
    const existing = await readById(id);
    if (!existing) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const { pkg, error } = sanitizePackage(body, existing);
    if (error) return NextResponse.json({ ok: false, error }, { status: 400 });
    const updated: AccessPackage = {
      ...existing,
      ...pkg!,
      id: existing.id,
      tenantId: existing.tenantId,
      kind: 'access-package',
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    const c = await accessPackagesContainer();
    const { resource } = await c.item(existing.id, existing.tenantId).replace(updated);
    return NextResponse.json({ ok: true, package: resource });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  try {
    const existing = await readById(id);
    if (!existing) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const c = await accessPackagesContainer();
    await c.item(existing.id, existing.tenantId).delete();
    return NextResponse.json({ ok: true, deleted: id });
  } catch (e: any) {
    return apiServerError(e);
  }
}
