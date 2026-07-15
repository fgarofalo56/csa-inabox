import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { getSession } from '@/lib/auth/session';
import { auditLogContainer, itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code === undefined ? undefined : { code });
}

/**
 * Record an `open` event into the Cosmos `audit-log` container — the write half
 * of /api/items/recent (which joins audit events by `c.userId` back onto items).
 * Before this, NOTHING in the product recorded item opens, so "Recent" was
 * permanently empty. Throttled in-process per (user, item) so an editor that
 * re-fetches its item doc doesn't spam the log; best-effort (never blocks or
 * fails the GET).
 */
const OPEN_THROTTLE_MS = 5 * 60 * 1000;
const lastOpenWrite = new Map<string, number>();

async function recordItemOpen(
  s: NonNullable<ReturnType<typeof getSession>>,
  item: WorkspaceItem,
  itemType: string,
): Promise<void> {
  const throttleKey = `${s.claims.oid}:${item.id}`;
  const now = Date.now();
  const last = lastOpenWrite.get(throttleKey);
  if (last && now - last < OPEN_THROTTLE_MS) return;
  lastOpenWrite.set(throttleKey, now);
  // Cap the throttle map so a long-lived replica never grows unbounded.
  if (lastOpenWrite.size > 5000) {
    for (const [k, t] of lastOpenWrite) if (now - t > OPEN_THROTTLE_MS) lastOpenWrite.delete(k);
  }
  try {
    const audit = await auditLogContainer();
    await audit.items.create({
      id: crypto.randomUUID(),
      itemId: item.id,
      itemType,
      workspaceId: item.workspaceId,
      userId: s.claims.oid,
      upn: s.claims.upn,
      action: 'open',
      summary: '',
      diff: null,
      at: new Date().toISOString(),
    });
  } catch {
    // best-effort — an audit hiccup must never break the item read
    lastOpenWrite.delete(throttleKey);
  }
}

/** Find an item by id (cross-partition) + verify the caller's tenant owns its workspace. */
async function loadItem(itemId: string, type: string, tenantId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: itemId },
        { name: '@t', value: type },
      ],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return null;
  // Verify tenant ownership via parent workspace
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(item.workspaceId, tenantId).read<Workspace>();
    if (!resource || resource.tenantId !== tenantId) return null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
  return item;
}

export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ type: string; id: string }> }
) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  try {
    const item = await loadItem(params.id, params.type, session.claims.oid);
    if (!item) return err('Item not found', 404, 'not_found');
    // Feed "Recent": record the open (throttled, best-effort — never blocks).
    await recordItemOpen(session, item, params.type);
    return NextResponse.json(item);
  } catch (e: any) {
    return err(e?.message || 'Failed to fetch item', 500, 'cosmos_error');
  }
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  let body: any;
  try { body = await req.json(); } catch { return err('Invalid JSON', 400, 'bad_json'); }
  try {
    const item = await loadItem(params.id, params.type, session.claims.oid);
    if (!item) return err('Item not found', 404, 'not_found');
    const next: WorkspaceItem = {
      ...item,
      displayName: typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : item.displayName,
      description: 'description' in body ? (body.description?.trim() || undefined) : item.description,
      state: 'state' in body && body.state && typeof body.state === 'object' ? body.state : item.state,
      updatedAt: new Date().toISOString(),
    };
    const items = await itemsContainer();
    const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>(next);
    return NextResponse.json(resource);
  } catch (e: any) {
    return err(e?.message || 'Failed to update item', 500, 'cosmos_error');
  }
}

export async function DELETE(
  _req: NextRequest,
  props: { params: Promise<{ type: string; id: string }> }
) {
  const params = await props.params;
  const session = getSession();
  if (!session) return err('Unauthorized', 401, 'unauthorized');
  try {
    const item = await loadItem(params.id, params.type, session.claims.oid);
    if (!item) return err('Item not found', 404, 'not_found');
    const items = await itemsContainer();
    await items.item(item.id, item.workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return err(e?.message || 'Failed to delete item', 500, 'cosmos_error');
  }
}
