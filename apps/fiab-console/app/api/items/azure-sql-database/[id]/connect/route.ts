/**
 * POST /api/items/azure-sql-database/[id]/connect
 *   body { family, server, database }
 *   Binds the selected Azure database (SQL DB / MI / PostgreSQL flexible
 *   server) to the Loom item's persisted state in Cosmos, so the editor
 *   re-opens on the same connection. Mirrors the catalog item to AI Search.
 *
 * `id === 'new'` is rejected with a 400 — the editor must create the item
 * first (POST /api/items/azure-sql-database) before binding a connection.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { updateOwnedItem, jerr } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'azure-sql-database';
const FAMILIES = new Set(['azure-sql', 'managed-instance', 'postgres']);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const { id } = await ctx.params;
  if (!id || id === 'new') return jerr('save the item before binding a connection', 400);
  const body = await req.json().catch(() => ({}));
  const family = String(body?.family || '').trim();
  const server = String(body?.server || '').trim();
  const database = String(body?.database || '').trim();
  if (!FAMILIES.has(family)) return jerr('family must be one of azure-sql | managed-instance | postgres', 400);
  if (!server) return jerr('server is required', 400);

  const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
    state: { connection: { family, server, database: database || undefined, boundAt: new Date().toISOString() } },
  });
  if (!updated) return jerr('item not found or not owned by your tenant', 404);
  return NextResponse.json({ ok: true, item: updated });
}
