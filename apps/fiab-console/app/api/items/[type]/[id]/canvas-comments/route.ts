/**
 * Canvas comments / sticky notes — list + create (W4).
 *
 * A single SHARED BFF route (under the generic `[type]` item segment) that backs
 * the canvas-comment layer on EVERY Loom canvas (pipeline, eventstream, dataflow,
 * agent-flow, domain-designer, …). Comments are anchored at React Flow
 * flow-coordinates and keyed by (itemId, canvasKey) so one item can carry
 * comments on several canvases.
 *
 * Contract:
 *   GET  ?canvasKey=<k>                    → { ok, comments: CanvasCommentView[], canvasKey }
 *   POST { canvasKey?, kind, text, x, y, color?, resolved? }
 *                                          → 201 { ok, comment: CanvasCommentView }
 *
 * Authorization (per route-guards): the caller is authorized against the ITEM's
 * workspace via `loadOwnedItem` (owner OR shared ACL member) — NOT a bare
 * session check. Reads admit any workspace role; creating a comment admits any
 * member too (commenting is not an item mutation). Per-comment edit/delete owner
 * checks live in the `[commentId]` sub-route.
 *
 * Real backend (no-vaporware): every operation is a real single-partition Cosmos
 * read/write via canvas-comment-store — no mock arrays. Azure-native, no Fabric
 * dependency.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { listCanvasComments, createCanvasComment } from '@/lib/collab/canvas-comment-store';
import { normalizeCommentInput, toCommentView } from '@/lib/collab/canvas-comment-model';

/** Resolve the canvasKey from a query/body value (default 'default'). */
function canvasKeyOf(v: unknown): string {
  const k = typeof v === 'string' ? v.trim() : '';
  return k && k.length <= 120 ? k : 'default';
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { type, id } = await ctx.params;

  const item = await loadOwnedItem(id, type, session.claims.oid, { allowReadRoles: true });
  if (!item) return apiNotFound('item not found');

  const canvasKey = canvasKeyOf(req.nextUrl.searchParams.get('canvasKey'));
  try {
    const docs = await listCanvasComments(id, canvasKey);
    const comments = docs.map((d) => toCommentView(d, session.claims.oid));
    return apiOk({ comments, canvasKey });
  } catch (e) {
    return apiServerError(e, 'could not load canvas comments');
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { type, id } = await ctx.params;

  const item = await loadOwnedItem(id, type, session.claims.oid, { allowReadRoles: true });
  if (!item) return apiNotFound('item not found');

  const body = await req.json().catch(() => ({}));
  const canvasKey = canvasKeyOf((body as any)?.canvasKey);
  const fields = normalizeCommentInput(body as any);
  if (!fields) return apiError('text is required — an empty comment cannot be created', 422);

  try {
    const doc = await createCanvasComment(
      id,
      type,
      canvasKey,
      fields,
      { oid: session.claims.oid, name: session.claims.name || session.claims.upn },
    );
    return apiOk({ comment: toCommentView(doc, session.claims.oid) }, { status: 201 });
  } catch (e) {
    return apiServerError(e, 'could not create canvas comment');
  }
}
