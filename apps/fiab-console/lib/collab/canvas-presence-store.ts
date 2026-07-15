/**
 * canvas-presence-store (W5) — the Cosmos persistence layer for real-time
 * co-authoring PRESENCE. Backs the BFF route
 * app/api/items/[type]/[id]/canvas-presence. Beacons live in the dedicated
 * TTL-enabled `canvas-presence` container (PK /itemId) so:
 *   • every per-item presence read is a single-partition query;
 *   • a peer that closed the tab or crashed self-evicts (Cosmos TTL) with no
 *     explicit "leave" call — the heartbeat is the only write path.
 *
 * This is the HONEST presence layer of W5. Full CRDT co-editing (yjs/Web PubSub)
 * is a larger infra lift tracked separately; the client surfaces a clear
 * "Live co-edit (CRDT) — Preview" note. What ships here is REAL: a heartbeat
 * UPSERT + an active-peer read against Cosmos — no mock avatars.
 */
import type { Container } from '@azure/cosmos';
import { canvasPresenceContainer } from '@/lib/azure/cosmos-client';
import {
  type CanvasPresenceDoc,
  type PresenceCursor,
  presenceDocId,
  presenceTtlSeconds,
} from './canvas-presence-model';

/** Identity + optional cursor carried by one heartbeat. */
export interface PresenceHeartbeat {
  oid: string;
  name?: string;
  cursor?: PresenceCursor;
}

/**
 * Record (UPSERT) a peer's heartbeat for one canvas. One deterministic doc per
 * (item, canvas, oid) — repeated heartbeats overwrite the same row and refresh
 * its TTL, so the container never accrues one-row-per-beat. Returns the doc
 * written.
 */
export async function recordPresence(
  itemId: string,
  canvasKey: string,
  hb: PresenceHeartbeat,
): Promise<CanvasPresenceDoc> {
  const container = await canvasPresenceContainer();
  const doc: CanvasPresenceDoc = {
    id: presenceDocId(itemId, canvasKey, hb.oid),
    docType: 'canvas-presence',
    itemId,
    canvasKey,
    oid: hb.oid,
    name: hb.name,
    ...(hb.cursor ? { cursor: hb.cursor } : {}),
    lastSeen: new Date().toISOString(),
    ttl: presenceTtlSeconds(),
  };
  const { resource } = await container.items.upsert<CanvasPresenceDoc>(doc);
  return resource ?? doc;
}

/**
 * Read all presence beacons for an item (single-partition query), filtered to
 * one canvas. Stale beacons (older than TTL but not yet evicted by Cosmos) are
 * left IN — the caller applies {@link activePeers} with a `now` so the freshness
 * filter is deterministic and testable. Cosmos TTL is the durable cleanup; this
 * read never returns docs Cosmos already evicted.
 */
export async function listPresence(
  itemId: string,
  canvasKey: string,
): Promise<CanvasPresenceDoc[]> {
  const container: Container = await canvasPresenceContainer();
  const { resources } = await container.items
    .query<CanvasPresenceDoc>(
      {
        query:
          "SELECT * FROM c WHERE c.itemId = @i AND c.canvasKey = @k AND c.docType = 'canvas-presence'",
        parameters: [
          { name: '@i', value: itemId },
          { name: '@k', value: canvasKey },
        ],
      },
      { partitionKey: itemId },
    )
    .fetchAll();
  return resources;
}

/**
 * Explicit leave — best-effort delete of a peer's own beacon on tab-close /
 * unmount. TTL would evict it anyway; this just makes the peer disappear faster.
 * Never throws (a 404 is a no-op — the beacon may have already TTL'd out).
 */
export async function clearPresence(
  itemId: string,
  canvasKey: string,
  oid: string,
): Promise<void> {
  try {
    const container = await canvasPresenceContainer();
    await container.item(presenceDocId(itemId, canvasKey, oid), itemId).delete();
  } catch {
    /* best-effort — TTL is the durable cleanup */
  }
}
