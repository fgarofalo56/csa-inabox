/**
 * /api/data-products/[id] — read / update / delete a single data product.
 *
 * PATCH merges marketplace metadata into item.state and re-saves through
 * updateOwnedItem, which re-mirrors the product into the loom-data-products
 * AI Search index. Flipping `publishStatus` Draft → Published is what makes a
 * product appear in consumer search; flipping it back (or to Deprecated)
 * removes it from consumer results on the next query (the doc stays in the
 * index but the consumer filter excludes it).
 *
 * DELETE removes the item and its index mirror.
 *
 * GET    /api/data-products/[id]
 * PATCH  /api/data-products/[id]   body: { displayName?, description?, state? | flat metadata }
 * DELETE /api/data-products/[id]
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem, deleteOwnedItem } from '@/app/api/items/_lib/item-crud';
import { PUBLISH_STATUSES, type PublishStatus } from '@/lib/azure/loom-data-products-search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

/** Normalize the subset of marketplace metadata keys present in the patch. */
function patchState(raw: any, current: Record<string, unknown>): Record<string, unknown> {
  const next = { ...current };
  const asArray = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (typeof v === 'string') return v.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
    return [];
  };
  if ('publishStatus' in raw) {
    const ps = String(raw.publishStatus) as PublishStatus;
    next.publishStatus = PUBLISH_STATUSES.includes(ps) ? ps : next.publishStatus || 'Draft';
  }
  if ('domain' in raw) next.domain = raw.domain ? String(raw.domain) : undefined;
  if ('productType' in raw) next.productType = raw.productType ? String(raw.productType) : undefined;
  if ('owner' in raw) next.owner = raw.owner ? String(raw.owner) : undefined;
  if ('sla' in raw) next.sla = raw.sla ? String(raw.sla) : undefined;
  if ('glossaryTerms' in raw) next.glossaryTerms = asArray(raw.glossaryTerms);
  if ('CDEs' in raw) next.CDEs = asArray(raw.CDEs);
  return next;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, product: item });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({} as any));
  try {
    const current = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
    if (!current) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    // Metadata may arrive nested under `state` or flat on the body.
    const meta = body?.state && typeof body.state === 'object' ? body.state : body;
    const nextState = patchState(meta, (current.state || {}) as Record<string, unknown>);
    const updated = await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, {
      displayName: body?.displayName ? String(body.displayName) : undefined,
      ...('description' in body ? { description: body.description ? String(body.description) : undefined } : {}),
      state: nextState,
    });
    if (!updated) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, product: updated });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const ok = await deleteOwnedItem(id, ITEM_TYPE, s.claims.oid);
    if (!ok) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
