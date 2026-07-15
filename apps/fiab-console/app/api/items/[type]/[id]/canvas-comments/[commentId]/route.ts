/**
 * Canvas comment — edit + delete (W4).
 *
 * Per-comment mutations on the shared canvas-comment layer. Both handlers
 * authorize the caller against the ITEM's workspace (loadOwnedItem — owner OR
 * shared ACL member) AND enforce that only the comment's AUTHOR may edit/delete
 * their own note (the owner check lives in canvas-comment-store, which returns a
 * typed forbidden/not_found result).
 *
 * Contract:
 *   PATCH { text?, x?, y?, color?, kind?, resolved? } → { ok, comment: CanvasCommentView }
 *   DELETE                                            → { ok, id }
 *
 * Real backend (no-vaporware): real single-partition Cosmos read-then-write /
 * delete. Azure-native, no Fabric dependency.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiForbidden, apiServerError } from '@/lib/api/respond';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import {
  getCanvasComment,
  updateCanvasComment,
  deleteCanvasComment,
} from '@/lib/collab/canvas-comment-store';
import { applyCommentPatch, toCommentView } from '@/lib/collab/canvas-comment-model';

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ type: string; id: string; commentId: string }> },
) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { type, id, commentId } = await ctx.params;

  const item = await loadOwnedItem(id, type, session.claims.oid, { allowReadRoles: true });
  if (!item) return apiNotFound('item not found');

  const existing = await getCanvasComment(id, commentId).catch(() => null);
  if (!existing) return apiNotFound('comment not found');

  const body = await req.json().catch(() => ({}));
  const patch = applyCommentPatch(existing, body as any);
  if (patch === null) return apiError('text cannot be blanked', 422);

  try {
    const res = await updateCanvasComment(id, commentId, patch, session.claims.oid);
    if (!res.ok) {
      return res.reason === 'forbidden'
        ? apiForbidden('only the comment author can edit it')
        : apiNotFound('comment not found');
    }
    return apiOk({ comment: toCommentView(res.doc, session.claims.oid) });
  } catch (e) {
    return apiServerError(e, 'could not update canvas comment');
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ type: string; id: string; commentId: string }> },
) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { type, id, commentId } = await ctx.params;

  const item = await loadOwnedItem(id, type, session.claims.oid, { allowReadRoles: true });
  if (!item) return apiNotFound('item not found');

  try {
    const res = await deleteCanvasComment(id, commentId, session.claims.oid);
    if (!res.ok) {
      return res.reason === 'forbidden'
        ? apiForbidden('only the comment author can delete it')
        : apiNotFound('comment not found');
    }
    return apiOk({ id: commentId });
  } catch (e) {
    return apiServerError(e, 'could not delete canvas comment');
  }
}
