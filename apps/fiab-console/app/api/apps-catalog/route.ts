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

  // First-sign-in seed copy: if this tenant has nothing, copy from GLOBAL.
  if (resources.length === 0) {
    const { resources: global } = await c.items
      .query({ query: 'SELECT * FROM c WHERE c.tenantId = @t', parameters: [{ name: '@t', value: 'GLOBAL' }] })
      .fetchAll();
    if (global.length > 0) {
      const now = new Date().toISOString();
      for (const src of global) {
        const copy = { ...src, tenantId: s.claims.oid, copiedFromGlobalAt: now, _etag: undefined, _rid: undefined, _self: undefined, _ts: undefined, _attachments: undefined };
        delete (copy as any)._etag; delete (copy as any)._rid; delete (copy as any)._self; delete (copy as any)._ts; delete (copy as any)._attachments;
        await c.items.upsert(copy).catch(() => {});
      }
      const refetched = await c.items
        .query({ query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.name', parameters: [{ name: '@t', value: s.claims.oid }] })
        .fetchAll();
      resources = refetched.resources;
    }
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
