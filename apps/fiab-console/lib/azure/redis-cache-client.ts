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
 * ── Fail-fast (why every call is time-bounded) ───────────────────────────────
 * "Any error degrades silently" is only safe if a failure is FAST. A hanging
 * TCP connect or a stalled auth handshake is not an *error* to Node until the
 * OS socket timeout (minutes) — long enough that, in production, every route
 * wrapped in query-result-cache blocked on a cold connect to a private-endpoint
 * Redis until Front Door returned 504. Unsetting `LOOM_RESULT_CACHE_REDIS`
 * recovered instantly. The fix, implemented here:
 *   1. HARD BUDGETS — connect ≤ 2s, per-op (GET/SET/DEL) ≤ 500ms, via
 *      `Promise.race`. Budget expiry == a tier failure → the request proceeds on
 *      the lower tiers (in-process LRU + Cosmos + honest direct query).
 *   2. CIRCUIT BREAKER — after 3 consecutive failures/timeouts the breaker OPENs
 *      for 60s and Redis is skipped ENTIRELY (no per-request connect storms
 *      against an unreachable cache); a half-open probe re-tests after the window.
 *   3. NON-BLOCKING BACKGROUND CONNECT — the first request never awaits a cold
 *      connect. `ensureConnected()` kicks the connect in the background and
 *      returns null until the client is connected + authenticated; callers serve
 *      from the lower tiers meanwhile.
 * All budgets are env-tunable (see below).
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
 *   LOOM_RESULT_CACHE_REDIS_CONNECT_TIMEOUT_MS   connect+auth budget (default 2000).
 *   LOOM_RESULT_CACHE_REDIS_OP_TIMEOUT_MS        per-op GET/SET/DEL budget (default 500).
 *   LOOM_RESULT_CACHE_REDIS_BREAKER_THRESHOLD    consecutive failures to OPEN (default 3).
 *   LOOM_RESULT_CACHE_REDIS_BREAKER_RESET_MS     open duration before half-open (default 60000).
 *
 * ── Auth (authMode = BOTH: Entra preferred, access-key fallback) ─────────────
 * Prefers Entra (matches the "Redis Data Contributor on the shared cache" grant
 * wired by hband-shared.bicep for the Console UAMI): acquires an AAD token for
 * the redis scope via the shared `loomServerCredential` (the custom
 * `AcaManagedIdentityCredential` — @azure/identity's MSI path is broken on ACA)
 * and sends `AUTH <oid> <token>` where <oid> is the principal's object id read
 * from the token's own `oid` claim. When `LOOM_RESULT_CACHE_REDIS_PASSWORD` is
 * set it instead sends `AUTH <password>` (access-key). The Entra token expiry is
 * tracked and a background re-AUTH runs before it lapses (Azure disconnects a
 * connection whose token has expired), so a long-lived connection never dies on
 * token rollover. No secret or token is ever logged.
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

// ── Fail-fast budgets + circuit breaker ──────────────────────────────────────

/** Connect + initial-auth budget (ms). Default 2000, env-overridable. */
function connectTimeoutMs(): number {
  const n = Number(process.env.LOOM_RESULT_CACHE_REDIS_CONNECT_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 2_000;
}

/** Per-operation (GET/SET/DEL) budget (ms). Default 500, env-overridable. */
function opTimeoutMs(): number {
  const n = Number(process.env.LOOM_RESULT_CACHE_REDIS_OP_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 500;
}

/** Consecutive failures that OPEN the breaker. Default 3, env-overridable. */
function breakerThreshold(): number {
  const n = Number(process.env.LOOM_RESULT_CACHE_REDIS_BREAKER_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

/** How long the breaker stays OPEN before a half-open probe (ms). Default 60000. */
function breakerResetMs(): number {
  const n = Number(process.env.LOOM_RESULT_CACHE_REDIS_BREAKER_RESET_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/** Distinct error type so a budget expiry is legible in logs / test assertions. */
class RedisBudgetError extends Error {}

/**
 * Race a promise against a hard time budget. On expiry, run `onTimeout` (used to
 * tear down a wedged socket) and reject with a {@link RedisBudgetError}. The
 * timer is `unref`'d so the cache never keeps the event loop (or a test) alive.
 */
function withDeadline<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* ignore */
      }
      reject(new RedisBudgetError(`redis operation exceeded ${ms}ms budget`));
    }, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// Circuit-breaker state (module scope → per-ACA-replica, like the socket). We
// keep it here rather than in cache-counters.ts: that module's slot idiom is
// hit/miss attribution, not connection health, so breaker state lives with the
// connection it guards.
let consecutiveFailures = 0;
let breakerOpenUntil = 0; // epoch ms; 0 = closed

/**
 * True while the breaker is OPEN — skip Redis entirely (no connect, no op) so an
 * unreachable cache never triggers a per-request connect storm. Once the reset
 * window elapses this returns false again, letting exactly one probe (a
 * background connect or a single op) through in the half-open state; a success
 * closes the breaker, a failure re-opens it.
 */
function breakerBlocks(): boolean {
  if (breakerOpenUntil === 0) return false; // closed
  if (Date.now() < breakerOpenUntil) return true; // open → skip
  return false; // reset window elapsed → half-open probe allowed
}

function recordFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= breakerThreshold()) {
    breakerOpenUntil = Date.now() + breakerResetMs();
  }
}

function recordSuccess(): void {
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
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

// ── Connection (lazy, NON-BLOCKING background connect + auth) ──────────────────

interface PendingReply {
  resolve: (r: RespReply) => void;
  reject: (e: Error) => void;
}

let socket: Socket | null = null;
let ready = false; // true ONLY after connect + initial AUTH both succeed
let connecting = false; // a background connect is in flight
let authRefreshing = false; // a background Entra re-AUTH is in flight
let entraTokenExpiresAt = 0; // epoch ms of the current Entra token (0 = key auth / none)
let readBuf: Buffer = Buffer.alloc(0);
const pending: PendingReply[] = [];
let warned = false;

/** Skew before Entra token expiry at which we proactively re-AUTH (ms). */
const AUTH_REFRESH_SKEW_MS = 3 * 60_000;

function warnOnce(msg: string, err?: unknown): void {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(`[redis-cache-client] shared Redis tier unavailable; using local tiers only: ${msg}`, err ? (err as Error)?.message || err : '');
}

function teardown(err?: Error): void {
  const s = socket;
  socket = null;
  ready = false;
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

/**
 * Authenticate the current socket. Sends `AUTH <password>` when an access key is
 * configured, otherwise Entra `AUTH <oid> <token>`. Records the Entra token
 * expiry so {@link maybeRefreshAuth} can re-AUTH before it lapses. Assumes the
 * module `socket` is already set (openSocketAndAuth adopts it first).
 */
async function authenticate(): Promise<void> {
  const password = (process.env.LOOM_RESULT_CACHE_REDIS_PASSWORD ?? '').trim();
  if (password) {
    const reply = await send(['AUTH', password]);
    if (reply.type === 'error') throw new Error(`AUTH failed: ${reply.value}`);
    entraTokenExpiresAt = 0; // access-key auth never expires
    return;
  }
  // Entra auth: AUTH <oid> <aad-token>.
  const token = await loomServerCredential.getToken(redisScope());
  if (!token?.token) throw new Error('failed to acquire an Entra token for Redis');
  const oid = oidFromToken(token.token);
  if (!oid) throw new Error('Entra token has no oid claim for Redis AUTH');
  const reply = await send(['AUTH', oid, token.token]);
  if (reply.type === 'error') throw new Error(`AUTH (Entra) failed: ${reply.value}`);
  entraTokenExpiresAt = token.expiresOnTimestamp || 0;
}

/**
 * Open the socket and run the initial AUTH. The socket is ADOPTED into the
 * module `socket` immediately (before the connect handshake is awaited) so that
 * a connect-budget timeout can tear it down instead of leaking a wedged socket.
 * `ready` is NOT set here — the caller ({@link kickConnect}) sets it only after
 * this resolves.
 */
async function openSocketAndAuth(): Promise<void> {
  const endpoint = parseRedisEndpoint(process.env.LOOM_RESULT_CACHE_REDIS);
  if (!endpoint) throw new Error('no redis endpoint configured');
  const { host, port } = endpoint;
  const useTls = tlsEnabled();
  const s: Socket = useTls
    ? (await import('tls')).connect({ host, port, servername: host })
    : (await import('net')).connect({ host, port });
  socket = s; // adopt now so a connect-budget teardown can destroy it
  s.setNoDelay(true);
  s.on('data', onData);
  s.on('error', (e) => teardown(e));
  s.on('close', () => teardown());
  await new Promise<void>((resolve, reject) => {
    const ev = useTls ? 'secureConnect' : 'connect';
    s.once(ev, () => resolve());
    s.once('error', reject);
  });
  await authenticate();
}

/**
 * Kick a background connect if one is warranted. Never awaited by a request:
 * returns immediately, connecting the socket + authing off the request path.
 * The whole connect+auth is bounded by the connect budget; a failure/timeout is
 * counted against the breaker.
 */
function kickConnect(): void {
  if (connecting) return;
  if (socket && !socket.destroyed && ready) return;
  if (breakerBlocks()) return;
  connecting = true;
  void (async () => {
    try {
      await withDeadline(openSocketAndAuth(), connectTimeoutMs(), () =>
        teardown(new RedisBudgetError('redis connect+auth budget exceeded')),
      );
      ready = true;
      recordSuccess();
    } catch (e) {
      warnOnce('connect/auth error', e);
      teardown(e as Error);
      recordFailure();
    } finally {
      connecting = false;
    }
  })();
}

/**
 * Return a READY (connected + authenticated) socket, or null. When not ready, it
 * kicks a background connect and returns null so the caller serves from the
 * lower cache tiers — the first request NEVER awaits a cold connect.
 */
function ensureConnected(): Socket | null {
  if (socket && !socket.destroyed && ready) return socket;
  kickConnect();
  return null;
}

/**
 * Proactively refresh the Entra AUTH shortly before the token expires (Azure
 * Cache for Redis drops a connection whose token has lapsed). Runs in the
 * background off the request path; a failure tears down the socket (a fresh
 * background connect + AUTH re-establishes it) and counts against the breaker.
 */
function maybeRefreshAuth(): void {
  if (!ready || entraTokenExpiresAt === 0 || authRefreshing) return;
  if (Date.now() < entraTokenExpiresAt - AUTH_REFRESH_SKEW_MS) return;
  authRefreshing = true;
  void (async () => {
    try {
      await withDeadline(authenticate(), connectTimeoutMs(), () =>
        teardown(new RedisBudgetError('redis re-auth budget exceeded')),
      );
      recordSuccess();
    } catch (e) {
      warnOnce('Entra token refresh failed', e);
      teardown(e as Error);
      recordFailure();
    } finally {
      authRefreshing = false;
    }
  })();
}

// ── Public API (all failures degrade to null / no-op, all bounded) ────────────

/** GET a JSON string value by key. null on miss, breaker-open, or any failure. */
export async function redisGet(key: string): Promise<string | null> {
  if (!redisCacheConfigured() || breakerBlocks()) return null;
  const s = ensureConnected();
  if (!s) return null; // background connect in flight → serve lower tiers
  maybeRefreshAuth();
  try {
    const reply = await withDeadline(send(['GET', key]), opTimeoutMs(), () =>
      teardown(new RedisBudgetError('redis GET budget exceeded')),
    );
    recordSuccess();
    if (reply.type === 'bulk') return reply.value;
    return null;
  } catch (e) {
    warnOnce('GET error', e);
    recordFailure();
    return null;
  }
}

/** SET a value with a TTL (seconds). No-op on breaker-open or any failure. */
export async function redisSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  if (!redisCacheConfigured() || breakerBlocks()) return;
  const s = ensureConnected();
  if (!s) return;
  maybeRefreshAuth();
  try {
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    await withDeadline(send(['SET', key, value, 'EX', String(ttl)]), opTimeoutMs(), () =>
      teardown(new RedisBudgetError('redis SET budget exceeded')),
    );
    recordSuccess();
  } catch (e) {
    warnOnce('SET error', e);
    recordFailure();
  }
}

/** DEL one or more keys. No-op on breaker-open or any failure. */
export async function redisDel(keys: string[]): Promise<void> {
  if (!redisCacheConfigured() || breakerBlocks() || keys.length === 0) return;
  const s = ensureConnected();
  if (!s) return;
  maybeRefreshAuth();
  try {
    await withDeadline(send(['DEL', ...keys]), opTimeoutMs(), () =>
      teardown(new RedisBudgetError('redis DEL budget exceeded')),
    );
    recordSuccess();
  } catch (e) {
    warnOnce('DEL error', e);
    recordFailure();
  }
}

/** Close the connection (tests + graceful shutdown). */
export function redisDisconnect(): void {
  teardown();
}

// ── Test / diagnostics hooks (not part of the runtime contract) ───────────────

/** Circuit-breaker snapshot for tests + a health/diagnostics badge. */
export function _redisBreakerState(): { open: boolean; failures: number; openUntil: number } {
  return { open: breakerBlocks(), failures: consecutiveFailures, openUntil: breakerOpenUntil };
}

/** True when the client is connected + authenticated (ready to serve from Redis). */
export function _redisReady(): boolean {
  return ready && !!socket && !socket.destroyed;
}

/** Fully reset connection + breaker + warn state (unit tests only). */
export function _redisResetForTest(): void {
  teardown();
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
  connecting = false;
  authRefreshing = false;
  entraTokenExpiresAt = 0;
  warned = false;
}
