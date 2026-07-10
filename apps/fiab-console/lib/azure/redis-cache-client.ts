/**
 * redis-cache-client — a minimal, dependency-free Redis (RESP2) client used as
 * the OPTIONAL shared backing tier for the Loom result cache (PSR-5 / PSR-6).
 *
 * WHY hand-rolled: the console has no `redis` / `ioredis` package on its
 * dependency path and this tier is strictly opt-in, so we speak RESP2 over a
 * `tls`/`net` socket directly. We use exactly four verbs — AUTH, GET, SET…EX,
 * DEL — so the surface is tiny and auditable. Any error (no host, auth reject,
 * network, parse) degrades SILENTLY to null: the cache is a latency
 * optimization, never a correctness or availability dependency (the in-process
 * LRU + honest direct-query fallback always remain).
 *
 * ── Enablement ──────────────────────────────────────────────────────────────
 *   LOOM_RESULT_CACHE_REDIS            `<host>` or `<host>:<port>` of the shared
 *                                      Azure Cache for Redis (the hband-shared
 *                                      Premium cache; `<host>.redis.cache.
 *                                      windows.net:6380`). Unset ⇒ tier off.
 *   LOOM_RESULT_CACHE_REDIS_PASSWORD   access key (secretRef). When set, AUTHs
 *                                      with the key. Optional.
 *   LOOM_RESULT_CACHE_REDIS_TLS        `0` to disable TLS (dev only). Default on
 *                                      (Azure Cache for Redis requires TLS 6380).
 *   LOOM_RESULT_CACHE_REDIS_SCOPE      Entra token scope override for AAD auth
 *                                      (default `https://redis.azure.com/.default`;
 *                                      set the sovereign-cloud value in Gov).
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * Prefers Entra (matches the "Redis Data Contributor on the shared cache" grant
 * wired by hband-shared.bicep): acquires an AAD token for the redis scope and
 * sends `AUTH <oid> <token>` where <oid> is the principal's object id read from
 * the token's own `oid` claim. Falls back to `AUTH <password>` when a key is
 * provided. No secret is ever logged.
 *
 * NO Fabric / Power BI host — this only ever connects to the configured Azure
 * Cache for Redis host (no-fabric-dependency.md).
 */

import type { Socket } from 'net';
import { loomServerCredential } from '@/lib/azure/aca-managed-identity';

// ── Config ───────────────────────────────────────────────────────────────────

/** True when the shared Redis tier is configured (opt-in). */
export function redisCacheConfigured(): boolean {
  return !!(process.env.LOOM_RESULT_CACHE_REDIS ?? '').trim();
}

/** Parse `<host>[:<port>]` into `{host, port}`; default port 6380 (TLS). */
export function parseRedisEndpoint(raw: string | undefined): { host: string; port: number } | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  // Strip an accidental scheme (rediss://host:port) if present.
  const noScheme = v.replace(/^rediss?:\/\//i, '');
  const lastColon = noScheme.lastIndexOf(':');
  if (lastColon <= 0) return { host: noScheme, port: 6380 };
  const host = noScheme.slice(0, lastColon);
  const port = Number(noScheme.slice(lastColon + 1));
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

function tlsEnabled(): boolean {
  return (process.env.LOOM_RESULT_CACHE_REDIS_TLS ?? '1') !== '0';
}

function redisScope(): string {
  return (process.env.LOOM_RESULT_CACHE_REDIS_SCOPE ?? '').trim() || 'https://redis.azure.com/.default';
}

// ── RESP2 encoding (pure — unit-tested) ──────────────────────────────────────

/**
 * Encode a command as a RESP2 array of bulk strings. Every Redis command we
 * send (AUTH/GET/SET/DEL) is a flat array of string args.
 */
export function encodeCommand(args: string[]): string {
  let out = `*${args.length}\r\n`;
  for (const a of args) {
    out += `$${Buffer.byteLength(a)}\r\n${a}\r\n`;
  }
  return out;
}

/** A single parsed RESP2 reply. */
export type RespReply =
  | { type: 'status'; value: string }
  | { type: 'error'; value: string }
  | { type: 'integer'; value: number }
  | { type: 'bulk'; value: string | null };

/**
 * Parse ONE RESP2 reply from `buf` starting at `offset`. Returns the reply plus
 * the offset just past it, or null when more bytes are needed (incomplete).
 * Only the four reply kinds our four verbs produce are handled; a RESP array
 * reply (`*`) is rejected as unsupported (we never issue array-returning verbs).
 */
export function parseReply(buf: Buffer, offset: number): { reply: RespReply; next: number } | null {
  if (offset >= buf.length) return null;
  const marker = String.fromCharCode(buf[offset]);
  const lineEnd = buf.indexOf('\r\n', offset + 1, 'latin1');
  if (lineEnd < 0) return null; // need more bytes for the header line
  const header = buf.toString('utf8', offset + 1, lineEnd);
  const afterHeader = lineEnd + 2;
  switch (marker) {
    case '+':
      return { reply: { type: 'status', value: header }, next: afterHeader };
    case '-':
      return { reply: { type: 'error', value: header }, next: afterHeader };
    case ':':
      return { reply: { type: 'integer', value: Number(header) }, next: afterHeader };
    case '$': {
      const len = Number(header);
      if (len === -1) return { reply: { type: 'bulk', value: null }, next: afterHeader };
      const dataEnd = afterHeader + len;
      if (buf.length < dataEnd + 2) return null; // need the payload + trailing CRLF
      return {
        reply: { type: 'bulk', value: buf.toString('utf8', afterHeader, dataEnd) },
        next: dataEnd + 2,
      };
    }
    default:
      throw new Error(`unsupported RESP reply marker "${marker}"`);
  }
}

// ── AAD helpers ───────────────────────────────────────────────────────────────

/** Read the `oid` claim from a JWT without verifying it (it is our own token). */
export function oidFromToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { oid?: string; sub?: string };
    return payload.oid || payload.sub || null;
  } catch {
    return null;
  }
}

// ── Connection (lazy singleton with an ordered reply queue) ───────────────────

interface PendingReply {
  resolve: (r: RespReply) => void;
  reject: (e: Error) => void;
}

let socket: Socket | null = null;
let connecting: Promise<Socket | null> | null = null;
let readBuf: Buffer = Buffer.alloc(0);
const pending: PendingReply[] = [];
let warned = false;

function warnOnce(msg: string, err?: unknown): void {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(`[redis-cache-client] shared Redis tier unavailable; using local tiers only: ${msg}`, err ? (err as Error)?.message || err : '');
}

function teardown(err?: Error): void {
  const s = socket;
  socket = null;
  readBuf = Buffer.alloc(0);
  const e = err || new Error('redis connection closed');
  while (pending.length) pending.shift()!.reject(e);
  if (s) {
    try { s.destroy(); } catch { /* ignore */ }
  }
}

function onData(chunk: Buffer): void {
  readBuf = readBuf.length ? Buffer.concat([readBuf, chunk]) : chunk;
  let offset = 0;
  // Drain as many complete replies as the buffer holds, in FIFO order.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let parsed: { reply: RespReply; next: number } | null;
    try {
      parsed = parseReply(readBuf, offset);
    } catch (e) {
      teardown(e as Error);
      return;
    }
    if (!parsed) break;
    offset = parsed.next;
    const waiter = pending.shift();
    if (waiter) waiter.resolve(parsed.reply);
  }
  readBuf = offset > 0 ? readBuf.subarray(offset) : readBuf;
}

/** Send one command and await its single reply. Rejects if not connected. */
function send(args: string[]): Promise<RespReply> {
  const s = socket;
  if (!s || s.destroyed) return Promise.reject(new Error('redis not connected'));
  return new Promise<RespReply>((resolve, reject) => {
    pending.push({ resolve, reject });
    s.write(encodeCommand(args), (err) => {
      if (err) {
        // Remove the just-queued waiter and reject it.
        const idx = pending.findIndex((p) => p.resolve === resolve);
        if (idx >= 0) pending.splice(idx, 1);
        reject(err);
      }
    });
  });
}

async function authenticate(): Promise<void> {
  const password = (process.env.LOOM_RESULT_CACHE_REDIS_PASSWORD ?? '').trim();
  if (password) {
    const reply = await send(['AUTH', password]);
    if (reply.type === 'error') throw new Error(`AUTH failed: ${reply.value}`);
    return;
  }
  // Entra auth: AUTH <oid> <aad-token>.
  const token = await loomServerCredential.getToken(redisScope());
  if (!token?.token) throw new Error('failed to acquire an Entra token for Redis');
  const oid = oidFromToken(token.token);
  if (!oid) throw new Error('Entra token has no oid claim for Redis AUTH');
  const reply = await send(['AUTH', oid, token.token]);
  if (reply.type === 'error') throw new Error(`AUTH (Entra) failed: ${reply.value}`);
}

async function connect(): Promise<Socket | null> {
  if (socket && !socket.destroyed) return socket;
  if (connecting) return connecting;
  const endpoint = parseRedisEndpoint(process.env.LOOM_RESULT_CACHE_REDIS);
  if (!endpoint) return null;
  connecting = (async () => {
    try {
      const { host, port } = endpoint;
      const s: Socket = tlsEnabled()
        ? (await import('tls')).connect({ host, port, servername: host })
        : (await import('net')).connect({ host, port });
      s.setNoDelay(true);
      await new Promise<void>((resolve, reject) => {
        const ev = tlsEnabled() ? 'secureConnect' : 'connect';
        const onErr = (e: Error) => reject(e);
        s.once(ev, () => { s.removeListener('error', onErr); resolve(); });
        s.once('error', onErr);
      });
      s.on('data', onData);
      s.on('error', (e) => teardown(e));
      s.on('close', () => teardown());
      socket = s;
      await authenticate();
      return socket;
    } catch (e) {
      warnOnce('connect/auth error', e);
      teardown(e as Error);
      return null;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

// ── Public API (all failures degrade to null / no-op) ─────────────────────────

/** GET a JSON string value by key. null on miss or any failure. */
export async function redisGet(key: string): Promise<string | null> {
  if (!redisCacheConfigured()) return null;
  try {
    const s = await connect();
    if (!s) return null;
    const reply = await send(['GET', key]);
    if (reply.type === 'bulk') return reply.value;
    return null;
  } catch (e) {
    warnOnce('GET error', e);
    return null;
  }
}

/** SET a value with a TTL (seconds). No-op on any failure. */
export async function redisSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  if (!redisCacheConfigured()) return;
  try {
    const s = await connect();
    if (!s) return;
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    await send(['SET', key, value, 'EX', String(ttl)]);
  } catch (e) {
    warnOnce('SET error', e);
  }
}

/** DEL one or more keys. No-op on any failure. */
export async function redisDel(keys: string[]): Promise<void> {
  if (!redisCacheConfigured() || keys.length === 0) return;
  try {
    const s = await connect();
    if (!s) return;
    await send(['DEL', ...keys]);
  } catch (e) {
    warnOnce('DEL error', e);
  }
}

/** Close the connection (tests + graceful shutdown). */
export function redisDisconnect(): void {
  teardown();
}
