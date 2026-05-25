/**
 * GET  /api/items/data-product-template   — list curated templates (in-memory catalog)
 * POST /api/items/data-product-template   — admin-only: persist a new template into Cosmos
 *                                            (extends the curated catalog with workspace-scoped templates)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem, jerr, listOwnedItems } from '../_lib/item-crud';
import { CURATED_TEMPLATES } from '@/lib/catalog/data-product-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product-template';

export async function GET() {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const owned = await listOwnedItems(ITEM_TYPE, session.claims.oid).catch(() => []);
  // Surface both curated (read-only) + custom (workspace-scoped) templates.
  return NextResponse.json({
    ok: true,
    curated: CURATED_TEMPLATES,
    custom: owned,
  });
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const body = await req.json().catch(() => ({}));
  const r = await createOwnedItem(session, ITEM_TYPE, body);
  if (!r.ok) return jerr(r.error, r.status);
  return NextResponse.json({ ok: true, item: r.item }, { status: 201 });
}
