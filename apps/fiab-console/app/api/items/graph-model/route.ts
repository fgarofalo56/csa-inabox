/**
 * GET  /api/items/graph-model — list graph-model items owned by caller's tenant
 * POST /api/items/graph-model — persist a new graph-model item; state is freeform
 *
 * Used by the Ontology editor's "Materialize as graph-model" action
 * (lib/editors/phase4-editors.tsx:945) which posts:
 *   {
 *     workspaceId: 'default',
 *     displayName: '<Ontology label> graph (from ontology <id>)',
 *     state: { nodes, edges, database, sourceOntologyId, sourceOntologyClasses },
 *   }
 *
 * Previously returned 404 HTML, so clicking Materialize gave
 * "Failed: HTTP 404" and no graph-model item was ever created. The
 * subsequent ADX-push action (/api/items/graph-model/[id]/materialize)
 * already exists and works once a graph-model row is present.
 *
 * Follows the same shape as /api/items/vector-store/route.ts:
 *   - returns 201 + { ok: true, item } on POST success
 *   - returns 401 + { ok: false, error } when unauthenticated
 *   - returns 400 + { ok: false, error } when workspaceId/displayName missing
 *   - mirrors the new item into AI Search (via createOwnedItem)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem, jerr, listOwnedItems } from '../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'graph-model';

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
  // Editor reads either `item` or `id` from the response, so include both.
  return NextResponse.json({ ok: true, item: r.item, id: r.item.id }, { status: 201 });
}
