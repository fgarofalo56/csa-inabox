/**
 * Canvas presence — heartbeat + active-peer read (W5).
 *
 * The HONEST presence layer of real-time co-authoring: a lightweight polling
 * heartbeat backed by a TTL-enabled Cosmos container. A client on a canvas POSTs
 * a heartbeat (~every 15s, plus on cursor move) and GETs the currently-live peers
 * to render their avatars + live cursor beacons. There is NO full CRDT co-edit
 * here — the client surfaces a clear "Live co-edit (CRDT) — Preview" note; what
 * ships is REAL (heartbeat write + presence read against Cosmos, TTL self-evict),
 * not mock avatars.
 *
 * Contract:
 *   POST { canvasKey?, cursor? } → { ok, peers: PresencePeer[], ttlMs, canvasKey }
 *   GET  ?canvasKey=<k>          → { ok, peers: PresencePeer[], ttlMs, canvasKey }
 *   DELETE ?canvasKey=<k>        → { ok }   (explicit leave — TTL would evict anyway)
 *
 * Authorization (per route-guards): the caller is authorized against the ITEM's
 * workspace via `loadOwnedItem` (owner OR shared ACL member; read roles admitted
 * — a viewer is legitimately "present"). Peers are scoped to the item partition,
 * so no cross-tenant leakage is possible.
 *
 * Azure-native, no Fabric dependency.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { recordPresence, listPresence, clearPresence } from '@/lib/collab/canvas-presence-store';
import { activePeers, normalizeCursor, presenceTtlMs } from '@/lib/collab/canvas-presence-model';

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
  const ttlMs = presenceTtlMs();
  try {
    const docs = await listPresence(id, canvasKey);
    const peers = activePeers(docs, session.claims.oid, Date.now(), ttlMs);
    return apiOk({ peers, ttlMs, canvasKey });
  } catch (e) {
    return apiServerError(e, 'could not load canvas presence');
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
  const cursor = normalizeCursor((body as any)?.cursor);
  const ttlMs = presenceTtlMs();
  try {
    await recordPresence(id, canvasKey, {
      oid: session.claims.oid,
      name: session.claims.name || session.claims.upn,
      cursor,
    });
    const docs = await listPresence(id, canvasKey);
    const peers = activePeers(docs, session.claims.oid, Date.now(), ttlMs);
    return apiOk({ peers, ttlMs, canvasKey });
  } catch (e) {
    return apiServerError(e, 'could not record canvas presence');
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { type, id } = await ctx.params;

  const item = await loadOwnedItem(id, type, session.claims.oid, { allowReadRoles: true });
  if (!item) return apiNotFound('item not found');

  const canvasKey = canvasKeyOf(req.nextUrl.searchParams.get('canvasKey'));
  await clearPresence(id, canvasKey, session.claims.oid);
  return apiOk({});
}
