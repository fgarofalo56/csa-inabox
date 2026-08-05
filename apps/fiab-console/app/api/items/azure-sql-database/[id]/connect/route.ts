/**
 * POST /api/items/azure-sql-database/[id]/connect
 *   body { family, server, database }
 *   Binds the selected Azure database (SQL DB / MI / PostgreSQL flexible
 *   server) to the Loom item's persisted state in Cosmos, so the editor
 *   re-opens on the same connection AND the /query + /copilot routes can derive
 *   their execution target from it (authority binding — #2723). Mirrors the
 *   catalog item to AI Search (via updateOwnedItem).
 *
 * `id === 'new'` is rejected — the editor must create the item first
 * (POST /api/items/azure-sql-database) before binding a connection.
 */

import { NextResponse } from 'next/server';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { updateOwnedItem, jerr } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'azure-sql-database';
const FAMILIES = new Set(['azure-sql', 'managed-instance', 'postgres']);

export const POST = withWorkspaceOwner(ITEM_TYPE, async (req, { session, params, item }) => {
  const { id } = params;
  const body = await req.json().catch(() => ({}));
  const family = String(body?.family || '').trim();
  const server = String(body?.server || '').trim();
  const database = String(body?.database || '').trim();
  if (!FAMILIES.has(family)) return jerr('family must be one of azure-sql | managed-instance | postgres', 400);
  if (!server) return jerr('server is required', 400);

  // MERGE the connection into the item's existing state (never replace it): the
  // /query + /copilot routes DERIVE their authority from state.connection
  // (#2723), and binding must not wipe sibling state (mirror status, sensitivity
  // label, …). `item` is the owner-scoped item withWorkspaceOwner already loaded.
  const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
    state: {
      ...(item.state ?? {}),
      connection: { family, server, database: database || undefined, boundAt: new Date().toISOString() },
    },
  });
  if (!updated) return jerr('item not found or not owned by your tenant', 404);
  return NextResponse.json({ ok: true, item: updated });
});
