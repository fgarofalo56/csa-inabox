/**
 * canvas-presence-model — the PURE (no-Cosmos, no-DOM) logic layer for W5
 * real-time co-authoring PRESENCE. It owns the heartbeat doc shape + every
 * decision the store, BFF route and client hook depend on, so they can be
 * unit-tested without a Cosmos account:
 *
 *   • the persisted {@link CanvasPresenceDoc} (PK /itemId, TTL-enabled — a
 *     crashed/departed peer's beacon self-evicts);
 *   • the presence TTL derivation ({@link presenceTtlSeconds}) shared by the
 *     store (Cosmos `ttl`) and the "is this peer still live" filter;
 *   • the active-peer filter ({@link activePeers}) — drop stale beacons + the
 *     reader's own row, de-dupe by oid (last-write-wins);
 *   • a stable avatar-colour KEY per oid ({@link presenceColorKey}) so a peer
 *     reads the same colour on every client (the kit maps the key → token).
 *
 * No Fluent / React import here on purpose (node-env unit tests, zero DOM cost).
 */

/** Presence avatar colour KEY. The kit (.tsx) maps each to a `--loom-accent-*`. */
export type PresenceColorKey = 'blue' | 'violet' | 'teal' | 'magenta' | 'amber' | 'green';

export const PRESENCE_COLOR_KEYS: readonly PresenceColorKey[] = [
  'blue', 'violet', 'teal', 'magenta', 'amber', 'green',
];

/**
 * Presence beacon TTL. A beacon older than this is considered departed. The
 * client heartbeats at ~1/3 of this so a live peer is always fresh. Overridable
 * via LOOM_CANVAS_PRESENCE_TTL_MS (auto-allowlisted `_TTL_MS` tuning knob);
 * unset = 45s. Kept ≥ 10s so a slow network can't flap a live peer.
 */
export const DEFAULT_PRESENCE_TTL_MS = 45_000;

export function presenceTtlMs(): number {
  const raw = Number(process.env.LOOM_CANVAS_PRESENCE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 10_000) return Math.floor(raw);
  return DEFAULT_PRESENCE_TTL_MS;
}

/** The Cosmos `ttl` (whole seconds) for a beacon doc. */
export function presenceTtlSeconds(): number {
  return Math.max(10, Math.ceil(presenceTtlMs() / 1000));
}

/**
 * A live cursor position (React Flow flow-coordinates) a peer is hovering at.
 * Optional — a peer with the canvas open but no recent pointer move has none.
 */
export interface PresenceCursor {
  x: number;
  y: number;
}

/**
 * A presence heartbeat. PK /itemId so every per-item presence read hits a single
 * physical partition. `id` is deterministic per (item, canvas, oid) so a peer
 * UPSERTs one row (not one-per-heartbeat). TTL-enabled: `ttl` seconds after the
 * last heartbeat the row self-evicts, so a peer that closed the tab (or crashed)
 * disappears without any explicit "leave" call.
 */
export interface CanvasPresenceDoc {
  id: string;                    // `pres:<itemId>:<canvasKey>:<oid>`
  docType: 'canvas-presence';
  itemId: string;                // partition key
  canvasKey: string;
  oid: string;                   // the peer's Entra oid
  name?: string;                 // display name / UPN
  cursor?: PresenceCursor;
  /** ISO timestamp of the last heartbeat. */
  lastSeen: string;
  /** Cosmos TTL in seconds — the row self-evicts this long after lastSeen. */
  ttl: number;
}

/** The client-facing projection of one live peer. */
export interface PresencePeer {
  oid: string;
  name?: string;
  cursor?: PresenceCursor;
  lastSeen: string;
  /** Stable colour key derived from the oid (same peer = same colour everywhere). */
  color: PresenceColorKey;
}

/** Build the deterministic id for a peer's beacon on one canvas. */
export function presenceDocId(itemId: string, canvasKey: string, oid: string): string {
  return `pres:${itemId}:${canvasKey}:${oid}`;
}

/**
 * Deterministic avatar colour for an oid — a stable hash into the palette so a
 * given peer reads the same colour on every client (no server round-trip to
 * agree). PURE + exported for unit testing.
 */
export function presenceColorKey(oid: string): PresenceColorKey {
  let h = 0;
  for (let i = 0; i < oid.length; i++) {
    h = (h * 31 + oid.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(h) % PRESENCE_COLOR_KEYS.length;
  return PRESENCE_COLOR_KEYS[idx];
}

/**
 * Normalize a raw cursor off the request body — finite coords only, else undefined.
 */
export function normalizeCursor(v: unknown): PresenceCursor | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const x = Number((v as any).x);
  const y = Number((v as any).y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const clamp = (n: number) => Math.round(Math.max(-1_000_000, Math.min(1_000_000, n)) * 100) / 100;
  return { x: clamp(x), y: clamp(y) };
}

/**
 * PURE active-peer filter: from all beacons on a canvas, drop (a) the reader's
 * OWN row, (b) any beacon whose lastSeen is older than the freshness window, and
 * de-dupe by oid keeping the most-recent lastSeen. Returns peers sorted by name
 * then oid for a stable avatar order. `now`/`ttlMs` are injected so the filter
 * is deterministic under test.
 */
export function activePeers(
  all: ReadonlyArray<CanvasPresenceDoc>,
  readerOid: string,
  now: number,
  ttlMs: number,
): PresencePeer[] {
  const freshest = new Map<string, CanvasPresenceDoc>();
  for (const d of all) {
    if (!d?.oid || d.oid === readerOid) continue;
    const seen = Date.parse(d.lastSeen);
    if (!Number.isFinite(seen)) continue;
    if (now - seen > ttlMs) continue; // stale beacon — treat as departed
    const cur = freshest.get(d.oid);
    if (!cur || Date.parse(d.lastSeen) > Date.parse(cur.lastSeen)) freshest.set(d.oid, d);
  }
  const peers = Array.from(freshest.values()).map<PresencePeer>((d) => ({
    oid: d.oid,
    name: d.name,
    cursor: d.cursor,
    lastSeen: d.lastSeen,
    color: presenceColorKey(d.oid),
  }));
  peers.sort((a, b) => {
    const an = (a.name || a.oid).toLowerCase();
    const bn = (b.name || b.oid).toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : a.oid < b.oid ? -1 : 1;
  });
  return peers;
}
