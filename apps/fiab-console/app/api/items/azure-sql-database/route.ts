/**
 * Azure SQL database CRUD + helpers.
 * GET  /api/items/azure-sql-database                       — list owned items
 * POST /api/items/azure-sql-database                       — persist db item
 *
 * The "id" route adds query, mirroring, replication, sql2025 helpers.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem, jerr, listOwnedItems } from '../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'azure-sql-database';

export async function GET() {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const items = await listOwnedItems(ITEM_TYPE, session.claims.oid).catch(() => []);
  return NextResponse.json({ ok: true, items });
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const body = await req.json().catch(() => ({}));
  const r = await createOwnedItem(session, ITEM_TYPE, body);
  if (!r.ok) return jerr(r.error, r.status);
  return NextResponse.json({ ok: true, item: r.item }, { status: 201 });
}
