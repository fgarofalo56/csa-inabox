/**
 * GET    /api/items/[type]/[id]/comments — list comments
 * POST   /api/items/[type]/[id]/comments — add comment {body, mentions?, parentId?}
 * PATCH  /api/items/[type]/[id]/comments — edit body / resolve {commentId, body?, resolved?}
 * DELETE /api/items/[type]/[id]/comments?commentId=... — delete own comment
 *
 * BR-COMMENTS: the list/post/delete + mentions→notify + `parentId` threading
 * already shipped; PATCH adds the missing EDIT (author-only) + RESOLVE (open to
 * any item-accessor) so a review thread can be edited and closed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { commentsContainer, itemsContainer, workspacesContainer, notificationsContainer } from '@/lib/azure/cosmos-client';
import { normalizeItemCommentPatch, authorizeItemCommentPatch } from '@/lib/collab/item-comment-model';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function assertOwnedItem(itemId: string, itemType: string, tenantId: string) {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query({
      query: 'SELECT * FROM c WHERE c.id = @i AND c.itemType = @t',
      parameters: [{ name: '@i', value: itemId }, { name: '@t', value: itemType }],
    })
    .fetchAll();
  const item = resources[0] as any;
  if (!item) return null;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(item.workspaceId, tenantId).read<any>();
    return resource && resource.tenantId === tenantId ? item : null;
  } catch {
    return null;
  }
}

export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ type: string; id: string }> }
) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwnedItem(params.id, params.type, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const c = await commentsContainer();
  const { resources } = await c.items
    .query({
      query: 'SELECT * FROM c WHERE c.itemId = @i ORDER BY c._ts ASC',
      parameters: [{ name: '@i', value: params.id }],
    })
    .fetchAll();
  return NextResponse.json({ ok: true, comments: resources });
}

export async function POST(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const item = await assertOwnedItem(params.id, params.type, s.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  if (!body?.body) return NextResponse.json({ ok: false, error: 'body required' }, { status: 400 });
  const c = await commentsContainer();
  const doc = {
    id: crypto.randomUUID(),
    itemId: params.id,
    itemType: params.type,
    workspaceId: item.workspaceId,
    userId: s.claims.oid,
    upn: s.claims.upn,
    name: s.claims.name,
    body: body.body,
    mentions: Array.isArray(body.mentions) ? body.mentions : [],
    parentId: body.parentId || null,
    createdAt: new Date().toISOString(),
  };
  const { resource } = await c.items.create(doc);

  // Best-effort: notify mentioned users.
  if (doc.mentions.length) {
    const notif = await notificationsContainer();
    for (const oid of doc.mentions) {
      try {
        await notif.items.create({
          id: crypto.randomUUID(),
          userId: oid,
          title: `${s.claims.name} mentioned you`,
          body: body.body.slice(0, 240),
          severity: 'info',
          link: `/items/${params.type}/${params.id}`,
          read: false,
          createdAt: new Date().toISOString(),
        });
      } catch {}
    }
  }

  return NextResponse.json({ ok: true, comment: resource }, { status: 201 });
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwnedItem(params.id, params.type, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const commentId = typeof body?.commentId === 'string' ? body.commentId : '';
  if (!commentId) return NextResponse.json({ ok: false, error: 'commentId required' }, { status: 400 });

  const fields = normalizeItemCommentPatch(body);
  if (!fields) return NextResponse.json({ ok: false, error: 'nothing to update (body cannot be blank)' }, { status: 422 });

  const c = await commentsContainer();
  let existing: any;
  try {
    const read = await c.item(commentId, params.id).read<any>();
    existing = read.resource;
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: false, error: 'comment not found' }, { status: 404 });
    throw e;
  }
  if (!existing || existing.itemId !== params.id)
    return NextResponse.json({ ok: false, error: 'comment not found' }, { status: 404 });

  const allowed = authorizeItemCommentPatch(fields, existing.userId, s.claims.oid);
  if (!allowed) return NextResponse.json({ ok: false, error: 'only the author can edit this comment' }, { status: 403 });

  const updated = {
    ...existing,
    ...(allowed.body !== undefined ? { body: allowed.body, edited: true } : {}),
    ...(allowed.resolved !== undefined
      ? { resolved: allowed.resolved, resolvedBy: allowed.resolved ? s.claims.oid : null, resolvedAt: allowed.resolved ? new Date().toISOString() : null }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  const { resource } = await c.item(commentId, params.id).replace(updated);
  return NextResponse.json({ ok: true, comment: resource ?? updated });
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwnedItem(params.id, params.type, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const commentId = new URL(req.url).searchParams.get('commentId');
  if (!commentId) return NextResponse.json({ ok: false, error: 'commentId required' }, { status: 400 });
  const c = await commentsContainer();
  try {
    const { resource } = await c.item(commentId, params.id).read<any>();
    if (!resource || resource.userId !== s.claims.oid)
      return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
    await c.item(commentId, params.id).delete();
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return NextResponse.json({ ok: true });
}
