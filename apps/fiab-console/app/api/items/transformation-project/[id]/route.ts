/**
 * GET    /api/items/transformation-project/[id]  → the persisted project.
 * PUT    /api/items/transformation-project/[id]  → body { displayName?, description?, state? }
 * DELETE /api/items/transformation-project/[id]  → Cosmos delete.
 *
 * There is no external job object to clean up on delete: the project files are
 * generated per run and the SQLMesh state lives in the target engine's own
 * `sqlmesh_state` schema (dropping an environment is an explicit engine action,
 * never an implicit side effect of deleting a Loom item).
 */

import { NextRequest } from 'next/server';
import { apiNotFound, apiOk, apiServerError } from '@/lib/api/respond';
import { withSession, withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { deleteOwnedItem, loadOwnedItem, updateOwnedItem } from '../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'transformation-project';

export const GET = withWorkspaceOwner(ITEM_TYPE, { allowReadRoles: true }, async (_req, { item }) =>
  apiOk({ item }));

export const PUT = withSession(async (req: NextRequest, { session, params }) => {
  const body = await req.json().catch(() => ({}));
  try {
    const updated = await updateOwnedItem(params.id, ITEM_TYPE, session.claims.oid, body);
    if (!updated) return apiNotFound();
    return apiOk({ item: updated });
  } catch (e) {
    return apiServerError(e);
  }
});

export const DELETE = withSession(async (_req, { session, params }) => {
  try {
    const current = await loadOwnedItem(params.id, ITEM_TYPE, session.claims.oid);
    if (!current) return apiNotFound();
    const ok = await deleteOwnedItem(params.id, ITEM_TYPE, session.claims.oid);
    if (!ok) return apiNotFound();
    return apiOk();
  } catch (e) {
    return apiServerError(e);
  }
});
