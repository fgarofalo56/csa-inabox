/**
 * POST /api/items/data-product-template/[id]/instantiate
 *   body { workspaceId, displayName }
 *
 * Walks the template's `components[]` and creates each as a real item in
 * the caller's workspace (via the existing _lib/item-crud.createOwnedItem),
 * then persists a parent `data-product-instance` linking them all.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem } from '../../../_lib/item-crud';
import { CURATED_TEMPLATES } from '@/lib/catalog/data-product-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const workspaceId = String(body?.workspaceId || '').trim();
  const displayName = String(body?.displayName || '').trim();
  if (!workspaceId || !displayName) {
    return NextResponse.json({ ok: false, error: 'workspaceId and displayName are required' }, { status: 400 });
  }
  const { id: templateSlug } = await ctx.params;
  const template = CURATED_TEMPLATES.find((t) => t.slug === templateSlug);
  if (!template) return NextResponse.json({ ok: false, error: 'template not found' }, { status: 404 });

  // Materialize each component as a child item.
  const created: Array<{ slug: string; itemId: string; displayName: string }> = [];
  const errors: Array<{ slug: string; error: string }> = [];
  for (const comp of template.components) {
    const r = await createOwnedItem(session, comp.slug, {
      workspaceId,
      displayName: `${displayName} — ${comp.label}`,
      description: comp.description,
      state: { ...(comp.defaultState || {}), spawnedFromTemplate: template.slug },
    });
    if (r.ok) created.push({ slug: comp.slug, itemId: r.item.id, displayName: r.item.displayName });
    else errors.push({ slug: comp.slug, error: r.error });
  }

  // Persist the parent instance.
  const parent = await createOwnedItem(session, 'data-product-instance', {
    workspaceId,
    displayName,
    description: template.description,
    state: {
      template: template.slug,
      components: created,
      errors,
      instantiatedAt: new Date().toISOString(),
    },
  });

  if (!parent.ok) {
    return NextResponse.json({ ok: false, error: parent.error, created, errors }, { status: parent.status });
  }
  return NextResponse.json({ ok: true, instance: parent.item, created, errors }, { status: 201 });
}
