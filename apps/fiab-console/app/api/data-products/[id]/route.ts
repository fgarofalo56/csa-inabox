/**
 * Data Marketplace — single data-product BFF.
 *
 *   GET   /api/data-products/[id]  → load one product; exposes its Cosmos
 *                                    `_etag` as the HTTP `ETag` response header
 *                                    so the edit dialog can drive per-step
 *                                    optimistic-concurrency PATCHes.
 *   PATCH /api/data-products/[id]  → partial update of ONE step's fields.
 *                                    Requires an `If-Match` header carrying the
 *                                    `_etag` from the last read. A stale ETag
 *                                    (concurrent write) yields HTTP 409.
 *
 * Azure-native by default: backed by the Cosmos `dataproducts` container via
 * {@link getDataProductStore}. No Fabric/Purview dependency on this path.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getDataProductStore, ETagConflictError, type DataProductPatch } from '@/lib/dataproducts/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err(401, 'unauthenticated');
  const { id } = await ctx.params;
  try {
    const doc = await getDataProductStore().get(id);
    if (!doc) return err(404, `data product '${id}' not found`);
    return NextResponse.json({ ok: true, doc }, { headers: { ETag: doc._etag ?? '' } });
  } catch (e: any) {
    return err(500, e?.message || String(e));
  }
}

// Only these keys may be patched; anything else is dropped before the store
// sees it (defence-in-depth — the store also allow-lists).
const ALLOWED_PATCH_KEYS = new Set<keyof DataProductPatch>([
  'name', 'description', 'type', 'audience', 'owners', 'endorsed',
  'governanceDomainId', 'useCase', 'customAttributes',
]);

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err(401, 'unauthenticated');
  const { id } = await ctx.params;

  const ifMatch = req.headers.get('if-match') || '';
  if (!ifMatch) return err(400, 'If-Match header required (the ETag from the last GET)');

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return err(400, 'invalid JSON body');
  }
  if (!raw || typeof raw !== 'object') return err(400, 'body must be a JSON object');

  const patch: DataProductPatch = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (ALLOWED_PATCH_KEYS.has(k as keyof DataProductPatch)) {
      (patch as Record<string, unknown>)[k] = v;
    }
  }
  if (Object.keys(patch).length === 0) {
    return err(400, 'no patchable fields in body');
  }

  try {
    const updated = await getDataProductStore().patch(id, patch, ifMatch);
    return NextResponse.json(
      { ok: true, doc: updated, patched: Object.keys(patch) },
      { headers: { ETag: updated._etag ?? '' } },
    );
  } catch (e: any) {
    if (e instanceof ETagConflictError) return err(409, e.message);
    if (e?.status === 404) return err(404, e.message || `data product '${id}' not found`);
    return err(500, e?.message || String(e));
  }
}
