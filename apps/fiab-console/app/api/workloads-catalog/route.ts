/**
 * GET    /api/workloads-catalog          — list workloads available for the tenant.
 * POST   /api/workloads-catalog          — admin add a custom workload to the org catalog.
 * PATCH  /api/workloads-catalog?id=…      — update an org catalog row (e.g. toggle `included`).
 * DELETE /api/workloads-catalog?id=…      — remove a custom workload from the org catalog.
 */
import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { workloadsCatalogContainer } from '@/lib/azure/cosmos-client';
import { WORKLOAD_SEEDS } from '@/lib/apps/workloads-catalog-seed';
import crypto from 'node:crypto';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Route-toolkit: withSession (R3). The hand-rolled prologue on all four verbs
// returned `NextResponse.json({ ok:false, error:'unauthenticated' }, { status:401 })`;
// withSession returns apiUnauthorized() === apiError('unauthenticated', 401) ===
// `NextResponse.json({ ok:false, error:'unauthenticated' }, { status:401 })` —
// same keys, same order, same status. Verified against lib/api/respond.ts:43,
// not assumed (the codemod could not run in a worktree: no `typescript` dep).
export const GET = withSession(async (_req, { session: s }) => {
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

  // Seed-derived backstop (#3375) — mirrors the registry backstop that
  // /api/apps-catalog has carried since the apps-catalog A+ cluster.
  //
  // Before this, a fresh subscription reached here with BOTH the tenant rows and
  // the GLOBAL rows empty (the Cosmos seed is VNet-only and the GLOBAL seed route
  // is a tenant-admin POST), so the workloads catalog rendered EMPTY and the
  // operator runbook told them to open the browser dev console and POST
  // /api/admin/bootstrap-catalogs by hand. Populating from the shared seed here
  // makes that operator step unnecessary: the platform does it on first read,
  // from inside the VNet where Cosmos is reachable
  // (.claude/rules/auto-bind-by-default.md §5, ux-baseline.md G2).
  //
  // Idempotent and non-destructive: only workloads MISSING for this tenant are
  // written, so an operator who removed or re-categorised a curated workload does
  // not get it silently resurrected on the next read.
  const present = new Set(resources.map((r: any) => r.id));
  const missing = WORKLOAD_SEEDS.filter((w) => !present.has(w.id));
  if (missing.length > 0) {
    const now = new Date().toISOString();
    for (const w of missing) {
      await c.items
        .upsert({
          ...w,
          tenantId: s.claims.oid,
          publisher: 'CSA',
          iconUrl: null,
          createdBy: 'workloads-catalog-backstop',
          createdAt: now,
          updatedAt: now,
          seededFromRegistryAt: now,
        })
        .catch(() => {});
    }
    const refetched = await c.items
      .query({ query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.name', parameters: [{ name: '@t', value: s.claims.oid }] })
      .fetchAll();
    resources = refetched.resources;
  }

  return NextResponse.json({ ok: true, workloads: resources });
});

export const POST = withSession(async (req, { session: s }) => {
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
});

/** Update an org catalog row this tenant owns — currently the `included` toggle. */
export const PATCH = withSession(async (req, { session: s }) => {
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
});

/** Remove a custom org catalog row this tenant owns. */
export const DELETE = withSession(async (req, { session: s }) => {
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
});
