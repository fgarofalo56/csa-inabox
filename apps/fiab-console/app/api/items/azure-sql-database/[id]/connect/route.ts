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
 *
 * ITEM TYPE IS RESOLVED, NOT ASSUMED (GHSA-v8r7-c2p5-mjf2, second pass).
 * `UnifiedSqlDatabaseEditor` is registered for THREE slugs — `azure-sql-database`,
 * `postgres-flexible-server` and `sql-database` (lib/editors/registry.ts) — and
 * it posts every bind here regardless of which one the item actually is. With
 * `ITEM_TYPE` hard-coded, a `postgres-flexible-server` item (a real creatable
 * slug: `searchOnly:true` hides it from browse, but the search branch of
 * `new-item-dialog.tsx` deliberately does not filter searchOnly) could NEVER
 * bind — and once the execution routes started deriving their target from the
 * binding, that turned into a 404 on every one of them. So this route resolves
 * the id across the editor's whole family and writes back against the type the
 * item actually has.
 */

import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiNotFound } from '@/lib/api/respond';
import { SQL_EDITOR_ITEM_TYPES, loadOwnedSqlItem } from '@/app/api/items/_lib/sql-server-scope';
import { updateOwnedItem, jerr } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FAMILIES = new Set(['azure-sql', 'managed-instance', 'postgres']);

export const POST = withSession<{ id: string }>(async (req, { session, params }) => {
  const { id } = params;
  if (!id) return apiNotFound();

  // Owner-scoped resolution across every slug this editor serves. Each candidate
  // runs the same `loadOwnedItem` owner / workspace-ACL check, so trying several
  // cannot widen access — a foreign item resolves for none of them.
  const item = await loadOwnedSqlItem(id, session, SQL_EDITOR_ITEM_TYPES);
  if (!item) return apiNotFound();

  const body = await req.json().catch(() => ({}));
  const family = String(body?.family || '').trim();
  const server = String(body?.server || '').trim();
  const database = String(body?.database || '').trim();
  if (!FAMILIES.has(family)) return jerr('family must be one of azure-sql | managed-instance | postgres', 400);
  if (!server) return jerr('server is required', 400);

  // MERGE the connection into the item's existing state (never replace it): the
  // /query + /copilot routes DERIVE their authority from state.connection
  // (#2723), and binding must not wipe sibling state (mirror status, sensitivity
  // label, …). `item` is the owner-scoped item resolved above; its OWN itemType
  // is what the write-back is keyed on.
  const updated = await updateOwnedItem(id, item.itemType, session.claims.oid, {
    state: {
      ...(item.state ?? {}),
      connection: { family, server, database: database || undefined, boundAt: new Date().toISOString() },
    },
  });
  if (!updated) return jerr('item not found or not owned by your tenant', 404);
  return NextResponse.json({ ok: true, item: updated });
});
