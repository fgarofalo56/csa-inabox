/**
 * canvas-comment-store (W4) — the Cosmos persistence layer for canvas comments /
 * sticky notes. Backs the BFF routes under
 * app/api/items/[type]/[id]/canvas-comments. All docs live in the dedicated
 * `canvas-comments` container (PK /itemId — one physical partition per item,
 * across all of the item's canvases), a per-item sidecar (like item-versions /
 * saved-queries) so comment docs never pollute the untyped `items` queries.
 *
 * Owner discipline: only the AUTHOR (Entra oid) may edit or delete their own
 * comment. Reads are per-item (any session that can open the item sees the
 * canvas's comments — the same visibility the editor already grants). The route
 * enforces the session; this store enforces the owner check on mutate/delete.
 *
 * No-vaporware: every method is a REAL single-partition Cosmos operation — no
 * mock arrays. The only non-functional state is the honest CosmosNotConfigured
 * gate the container accessor throws when LOOM_COSMOS_ENDPOINT is unset.
 */
import crypto from 'node:crypto';
import type { Container } from '@azure/cosmos';
import { canvasCommentsContainer } from '@/lib/azure/cosmos-client';
import {
  type CanvasCommentDoc,
  type CanvasCommentInput,
  type NormalizedCommentFields,
  canvasCommentCap,
  commentsToPrune,
  newCommentId,
} from './canvas-comment-model';

/** Actor attribution for a created / edited comment. */
export interface CommentActor {
  oid: string;
  name?: string;
}

/** Read every comment doc for an item (single-partition query, oldest first). */
async function readItemComments(container: Container, itemId: string): Promise<CanvasCommentDoc[]> {
  const { resources } = await container.items
    .query<CanvasCommentDoc>(
      {
        query:
          "SELECT * FROM c WHERE c.itemId = @i AND c.docType = 'canvas-comment' ORDER BY c.createdAt ASC",
        parameters: [{ name: '@i', value: itemId }],
      },
      { partitionKey: itemId },
    )
    .fetchAll();
  return resources;
}

/**
 * List all comments for one canvas within an item (filtered by canvasKey). The
 * item partition is read once; the canvas filter is applied in-process so a
 * multi-canvas item still costs a single partition read.
 */
export async function listCanvasComments(
  itemId: string,
  canvasKey: string,
): Promise<CanvasCommentDoc[]> {
  const container = await canvasCommentsContainer();
  const all = await readItemComments(container, itemId);
  return all.filter((c) => c.canvasKey === canvasKey);
}

/**
 * Create a comment / sticky note. Enforces the per-(item,canvas) retention cap
 * by evicting the oldest beyond it (best-effort prune — a stale delete never
 * fails the create). Returns the created doc.
 */
export async function createCanvasComment(
  itemId: string,
  itemType: string,
  canvasKey: string,
  fields: NormalizedCommentFields,
  actor: CommentActor,
): Promise<CanvasCommentDoc> {
  const container = await canvasCommentsContainer();
  const now = new Date().toISOString();
  const doc: CanvasCommentDoc = {
    id: newCommentId(itemId, canvasKey, crypto.randomUUID()),
    docType: 'canvas-comment',
    itemId,
    itemType,
    canvasKey,
    kind: fields.kind,
    text: fields.text,
    x: fields.x,
    y: fields.y,
    color: fields.color,
    resolved: fields.resolved,
    authorOid: actor.oid,
    authorName: actor.name,
    createdAt: now,
    updatedAt: now,
  };
  const { resource } = await container.items.create<CanvasCommentDoc>(doc);

  // Enforce the cap for THIS canvas only (each canvas retains its own newest N).
  try {
    const forCanvas = (await readItemComments(container, itemId)).filter(
      (c) => c.canvasKey === canvasKey,
    );
    const prune = commentsToPrune(
      forCanvas.map((c) => ({ id: c.id, createdAt: c.createdAt })),
      canvasCommentCap(),
    );
    for (const id of prune) {
      try {
        await container.item(id, itemId).delete();
      } catch {
        /* best-effort prune */
      }
    }
  } catch {
    /* cap enforcement is best-effort — never fail the create */
  }
  return resource ?? doc;
}

/** Point-read a single comment within an item's partition (null when absent). */
export async function getCanvasComment(
  itemId: string,
  commentId: string,
): Promise<CanvasCommentDoc | null> {
  const container = await canvasCommentsContainer();
  try {
    const { resource } = await container.item(commentId, itemId).read<CanvasCommentDoc>();
    if (!resource || resource.itemId !== itemId || resource.docType !== 'canvas-comment') return null;
    return resource;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** Result of an owner-guarded mutate/delete. */
export type OwnerGuardResult<T> =
  | { ok: true; doc: T }
  | { ok: false; reason: 'not_found' | 'forbidden' };

/**
 * Apply a validated patch to a comment — ONLY when `actorOid` is the author.
 * `patch` is the pre-normalized field subset from applyCommentPatch.
 */
export async function updateCanvasComment(
  itemId: string,
  commentId: string,
  patch: Partial<NormalizedCommentFields>,
  actorOid: string,
): Promise<OwnerGuardResult<CanvasCommentDoc>> {
  const existing = await getCanvasComment(itemId, commentId);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.authorOid !== actorOid) return { ok: false, reason: 'forbidden' };
  const container = await canvasCommentsContainer();
  const updated: CanvasCommentDoc = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const { resource } = await container.item(commentId, itemId).replace<CanvasCommentDoc>(updated);
  return { ok: true, doc: resource ?? updated };
}

/** Delete a comment — ONLY when `actorOid` is the author. */
export async function deleteCanvasComment(
  itemId: string,
  commentId: string,
  actorOid: string,
): Promise<OwnerGuardResult<{ id: string }>> {
  const existing = await getCanvasComment(itemId, commentId);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.authorOid !== actorOid) return { ok: false, reason: 'forbidden' };
  const container = await canvasCommentsContainer();
  await container.item(commentId, itemId).delete();
  return { ok: true, doc: { id: commentId } };
}
