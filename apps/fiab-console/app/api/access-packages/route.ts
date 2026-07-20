/**
 * Access packages (access-governance W2).
 *
 *   GET  /api/access-packages            → requestable packages (any auth user);
 *                                           ?scope=admin lists ALL (tenant-admin).
 *   POST /api/access-packages            → create a package (tenant-admin).
 *
 * A package bundles {resource, role} grants + an assignment policy. Backed by the
 * `access-packages` Cosmos container (PK /tenantId). No mock data.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin, isTenantAdmin } from '@/lib/auth/feature-gate';
import { accessPackagesContainer } from '@/lib/azure/cosmos-client';
import type { AccessPackage, PackageGrant } from '@/lib/types/access-package';
import crypto from 'node:crypto';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Sanitize a package body into a persistable shape (no freeform passthrough). */
export function sanitizePackage(body: any, base: Partial<AccessPackage> = {}): { pkg?: Omit<AccessPackage, 'id' | 'tenantId' | 'kind' | 'createdAt' | 'updatedAt'>; error?: string } {
  const name = String(body?.name || '').trim().slice(0, 120);
  if (!name) return { error: 'name is required' };
  const rawGrants = Array.isArray(body?.grants) ? body.grants : [];
  const grants: PackageGrant[] = rawGrants
    .map((g: any) => ({
      resourceType: String(g?.resourceType || '').trim(),
      resourceRef: String(g?.resourceRef || '').trim(),
      resourceName: g?.resourceName ? String(g.resourceName).trim().slice(0, 200) : undefined,
      role: String(g?.role || '').trim() || 'Viewer',
      permission: g?.permission ? String(g.permission).trim() : undefined,
    }))
    .filter((g: PackageGrant) => g.resourceType && g.resourceRef);
  if (grants.length === 0) return { error: 'at least one grant (resourceType + resourceRef) is required' };
  const sodConflictsWith = Array.isArray(body?.sodConflictsWith)
    ? [...new Set(body.sodConflictsWith.map((s: any) => String(s)).filter(Boolean))] as string[]
    : (base.sodConflictsWith || []);
  const lifetime = body?.defaultLifetimeDays;
  return {
    pkg: {
      name,
      description: body?.description ? String(body.description).trim().slice(0, 1000) : base.description,
      grants,
      requestable: body?.requestable !== undefined ? !!body.requestable : (base.requestable ?? true),
      approvalPolicyId: body?.approvalPolicyId ? String(body.approvalPolicyId).trim() : base.approvalPolicyId,
      defaultLifetimeDays: lifetime === null || lifetime === undefined ? (base.defaultLifetimeDays ?? null) : Number(lifetime) || null,
      sodConflictsWith,
      sodMode: body?.sodMode === 'warn' ? 'warn' : (body?.sodMode === 'block' ? 'block' : (base.sodMode || 'block')),
      enabled: body?.enabled !== undefined ? !!body.enabled : (base.enabled ?? true),
      createdBy: base.createdBy,
    },
  };
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const adminScope = req.nextUrl.searchParams.get('scope') === 'admin';
  if (adminScope) { const gate = requireTenantAdmin(s); if (gate) return gate; }
  try {
    const c = await accessPackagesContainer();
    const { resources } = await c.items
      .query<AccessPackage>({ query: 'SELECT * FROM c ORDER BY c.name' })
      .fetchAll();
    const all = resources || [];
    // Non-admin catalog view: only enabled + requestable packages.
    const packages = adminScope ? all : all.filter((p) => p.enabled && p.requestable);
    return NextResponse.json({ ok: true, packages, isAdmin: isTenantAdmin(s) });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;
  try {
    const body = await req.json().catch(() => ({}));
    const { pkg, error } = sanitizePackage(body, { createdBy: s!.claims.upn || s!.claims.oid });
    if (error) return NextResponse.json({ ok: false, error }, { status: 400 });
    const now = new Date().toISOString();
    const doc: AccessPackage = {
      id: crypto.randomUUID(),
      tenantId: s!.claims.oid,
      kind: 'access-package',
      ...pkg!,
      createdBy: s!.claims.upn || s!.claims.oid,
      createdAt: now,
      updatedAt: now,
    };
    const c = await accessPackagesContainer();
    const { resource } = await c.items.create(doc);
    return NextResponse.json({ ok: true, package: resource }, { status: 201 });
  } catch (e: any) {
    return apiServerError(e);
  }
}
