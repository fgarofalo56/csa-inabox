/**
 * GET  /api/apps-catalog                — list all apps for the tenant
 * POST /api/apps-catalog                — create a new app (workspace owners)
 *
 * Data: Cosmos `apps-catalog`, PK /tenantId. Each app is a JSON doc with
 * { id, tenantId, name, description, icon, category, publisher, items:[{type,template}], installedBy:[]  }.
 * Seeded by scripts/csa-loom/seed-catalogs.sh on deploy.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { appsCatalogContainer } from '@/lib/azure/cosmos-client';
import { listBundleIds, getBundle } from '@/lib/apps/content-bundles';
import { CATALOG_META } from '@/lib/apps/content-bundles/catalog-meta';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const c = await appsCatalogContainer();
  let { resources } = await c.items
    .query({ query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.name', parameters: [{ name: '@t', value: s.claims.oid }] })
    .fetchAll();

  // First-sign-in seed OR stale-tenant-copy auto-refresh.
  //
  // User-reported bug 2026-05-28: every app showed "Bundled items (0)"
  // because per-tenant copies were created before the GLOBAL seed gained
  // its items[] arrays. The original logic only copied from GLOBAL when
  // the tenant had ZERO docs — so existing tenants stayed stuck on the
  // pre-items[] copies forever.
  //
  // Fix: also detect tenant docs that are missing items[] (or any other
  // GLOBAL-only field) and re-merge those specific fields from GLOBAL,
  // keyed by id. Idempotent.
  const needsCopy = resources.length === 0;
  const needsMerge = resources.some(
    (r: any) => !Array.isArray(r.items) || r.items.length === 0,
  );

  if (needsCopy || needsMerge) {
    const { resources: global } = await c.items
      .query({ query: 'SELECT * FROM c WHERE c.tenantId = @t', parameters: [{ name: '@t', value: 'GLOBAL' }] })
      .fetchAll();
    if (global.length > 0) {
      const now = new Date().toISOString();
      const byId = new Map(resources.map((r: any) => [r.id, r]));
      for (const src of global) {
        const existing = byId.get(src.id);
        const STAMP = { tenantId: s.claims.oid, copiedFromGlobalAt: now };
        // Strip Cosmos-internal fields from the source.
        const { _etag, _rid, _self, _ts, _attachments, ...clean } = src as any;
        const merged = existing
          // Preserve existing tenant-specific fields (createdAt, installedBy)
          // and overlay GLOBAL bundle definition + items[] when missing.
          ? {
              ...clean,
              ...existing,
              ...STAMP,
              // Always refresh items[] / category / description / icon /
              // publisher from GLOBAL so apps stay in sync with the seed.
              items: src.items || existing.items || [],
              description: src.description || existing.description,
              category: src.category || existing.category,
              icon: src.icon || existing.icon,
              publisher: src.publisher || existing.publisher,
              name: src.name || existing.name,
            }
          : { ...clean, ...STAMP };
        await c.items.upsert(merged).catch(() => {});
      }
      const refetched = await c.items
        .query({ query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.name', parameters: [{ name: '@t', value: s.claims.oid }] })
        .fetchAll();
      resources = refetched.resources;
    }
  }

  // Registry-derived backstop: ensure EVERY registered content bundle is
  // discoverable as a tenant catalog doc, regardless of whether the Cosmos
  // GLOBAL seed has been (re-)run on the live account. id === bundle.appId so
  // install → getBundle(appId) always resolves. Idempotent; only upserts the
  // apps that are missing or stale (no items[]).
  const byId = new Map(resources.map((r: any) => [r.id, r]));
  const missing: any[] = [];
  for (const appId of listBundleIds()) {
    const meta = CATALOG_META[appId];
    if (!meta) continue; // bundle without catalog metadata — skip (still installable directly)
    const bundle = getBundle(appId);
    const items = (bundle?.items || []).map((i) => ({ type: i.itemType, template: appId }));
    const existing = byId.get(appId);
    if (existing && Array.isArray(existing.items) && existing.items.length > 0) continue;
    missing.push({
      id: appId,
      tenantId: s.claims.oid,
      name: meta.name,
      description: meta.description,
      icon: meta.icon,
      category: meta.category,
      publisher: meta.publisher,
      items,
      installedBy: existing?.installedBy || [],
      createdBy: existing?.createdBy || 'CSA',
      createdAt: existing?.createdAt || new Date().toISOString(),
      seededFromRegistryAt: new Date().toISOString(),
    });
  }
  if (missing.length > 0) {
    for (const doc of missing) await c.items.upsert(doc).catch(() => {});
    const refetched = await c.items
      .query({ query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.name', parameters: [{ name: '@t', value: s.claims.oid }] })
      .fetchAll();
    resources = refetched.resources;
  }

  return NextResponse.json({ ok: true, apps: resources });
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (!body?.name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });
  const c = await appsCatalogContainer();
  const now = new Date().toISOString();
  const doc = {
    id: crypto.randomUUID(),
    tenantId: s.claims.oid,
    name: body.name,
    description: body.description || '',
    icon: body.icon || 'AppGeneric20Regular',
    category: body.category || 'Custom',
    publisher: body.publisher || s.claims.upn,
    items: body.items || [],
    installedBy: [],
    createdBy: s.claims.upn,
    createdAt: now,
    updatedAt: now,
  };
  const { resource } = await c.items.create(doc);
  return NextResponse.json({ ok: true, app: resource }, { status: 201 });
}
