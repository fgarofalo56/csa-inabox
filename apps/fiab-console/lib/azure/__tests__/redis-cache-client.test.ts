/**
 * Tests for redis-cache-client.
 *
 * Part 1 — pure helpers (no socket): RESP2 command encoding, reply parsing
 * (incl. incomplete/null/error), endpoint parsing, JWT oid read.
 *
 * Part 2 — fail-fast connection behaviour with a controllable fake socket:
 *   • the first request never awaits a cold connect (returns from lower tiers),
 *   • a hanging connect degrades within the connect budget,
 *   • a hanging op degrades within the per-op budget,
 *   • the circuit breaker OPENs after N failures (skipping Redis), then a
 *     half-open probe recovers and CLOSES it on success.
 *
 * The `tls`/`net` modules are mocked so no real network is touched, and the
 * shared credential is mocked so `@azure/identity` stays out of the graph.
 */
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shared, hoisted holder the module mocks read (vi.mock factories are hoisted
// above imports, so they cannot close over ordinary top-level test variables).
const mocks = vi.hoisted(() => ({
  socketCount: 0,
  makeSocket: null as null | (() => unknown),
}));

vi.mock('tls', () => ({
  connect: () => {
    mocks.socketCount++;
    return mocks.makeSocket!();
  },
}));
vi.mock('net', () => ({
  connect: () => {
    mocks.socketCount++;
    return mocks.makeSocket!();
  },
}));
// Keep @azure/identity out of the module graph; access-key auth is used below so
// getToken is never actually called, but the import must resolve.
vi.mock('@/lib/azure/aca-managed-identity', () => ({
  loomServerCredential: {
    getToken: async () => ({ token: 'h.e.s', expiresOnTimestamp: Date.now() + 3_600_000 }),
  },
}));

import {
  encodeCommand,
  parseReply,
  parseRedisEndpoint,
  oidFromToken,
  redisCacheConfigured,
  redisGet,
  _redisBreakerState,
  _redisReady,
  _redisResetForTest,
} from '../redis-cache-client';

// ── Part 1: pure helpers ──────────────────────────────────────────────────────

describe('encodeCommand', () => {
  it('encodes a flat array of bulk strings (RESP2)', () => {
    expect(encodeCommand(['GET', 'k'])).toBe('*2\r\n$3\r\nGET\r\n$1\r\nk\r\n');
  });
  it('uses byte length for multi-byte values', () => {
    const enc = encodeCommand(['SET', 'k', 'é']); // é = 2 bytes UTF-8
    expect(enc).toContain('$2\r\né\r\n');
  });
});

describe('parseReply', () => {
  it('parses a simple status', () => {
    const buf = Buffer.from('+OK\r\n', 'utf8');
    const r = parseReply(buf, 0);
    expect(r?.reply).toEqual({ type: 'status', value: 'OK' });
    expect(r?.next).toBe(buf.length);
  });
  it('parses an error', () => {
    const r = parseReply(Buffer.from('-WRONGPASS bad\r\n', 'utf8'), 0);
    expect(r?.reply).toEqual({ type: 'error', value: 'WRONGPASS bad' });
  });
  it('parses an integer', () => {
    const r = parseReply(Buffer.from(':3\r\n', 'utf8'), 0);
    expect(r?.reply).toEqual({ type: 'integer', value: 3 });
  });
  it('parses a bulk string', () => {
    const r = parseReply(Buffer.from('$5\r\nhello\r\n', 'utf8'), 0);
    expect(r?.reply).toEqual({ type: 'bulk', value: 'hello' });
  });
  it('parses a null bulk string', () => {
    const r = parseReply(Buffer.from('$-1\r\n', 'utf8'), 0);
    expect(r?.reply).toEqual({ type: 'bulk', value: null });
  });
  it('returns null when the header line is incomplete', () => {
    expect(parseReply(Buffer.from('$5\r\nhel', 'utf8'), 0)).toBeNull();
  });
  it('returns null when the bulk payload is incomplete', () => {
    expect(parseReply(Buffer.from('$5\r\nhell', 'utf8'), 0)).toBeNull();
  });
  it('throws on an unsupported array reply marker', () => {
    expect(() => parseReply(Buffer.from('*1\r\n', 'utf8'), 0)).toThrow(/unsupported RESP/);
  });
});

describe('parseRedisEndpoint', () => {
  it('parses host:port', () => {
    expect(parseRedisEndpoint('cache.redis.cache.windows.net:6380')).toEqual({
      host: 'cache.redis.cache.windows.net',
      port: 6380,
    });
  });
  it('defaults the port to 6380 when only a host is given', () => {
    expect(parseRedisEndpoint('myhost')).toEqual({ host: 'myhost', port: 6380 });
  });
  it('strips a rediss:// scheme', () => {
    expect(parseRedisEndpoint('rediss://h:6380')).toEqual({ host: 'h', port: 6380 });
  });
  it('rejects an invalid port', () => {
    expect(parseRedisEndpoint('h:notaport')).toBeNull();
  });
  it('returns null for empty/undefined', () => {
    expect(parseRedisEndpoint('')).toBeNull();
    expect(parseRedisEndpoint(undefined)).toBeNull();
  });
});

describe('oidFromToken', () => {
  it('reads the oid claim from a JWT payload', () => {
    const payload = Buffer.from(JSON.stringify({ oid: 'abc-123' })).toString('base64url');
    expect(oidFromToken(`h.${payload}.sig`)).toBe('abc-123');
  });
  it('falls back to sub when oid is absent', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'sub-1' })).toString('base64url');
    expect(oidFromToken(`h.${payload}.sig`)).toBe('sub-1');
  });
  it('returns null for a malformed token', () => {
    expect(oidFromToken('notajwt')).toBeNull();
  });
});

describe('redisCacheConfigured', () => {
  it('is false when LOOM_RESULT_CACHE_REDIS is unset', () => {
    const prev = process.env.LOOM_RESULT_CACHE_REDIS;
    delete process.env.LOOM_RESULT_CACHE_REDIS;
    expect(redisCacheConfigured()).toBe(false);
    if (prev !== undefined) process.env.LOOM_RESULT_CACHE_REDIS = prev;
  });
});

// ── Part 2: fail-fast connection behaviour (fake socket) ──────────────────────

/**
 * A controllable in-memory Socket stand-in. `connectMode` decides whether the
 * (TLS) connect resolves, errors, or HANGS forever; `getMode` decides whether a
 * GET is answered or HANGS. AUTH and SET/DEL always reply so a connection can
 * reach the "ready" state to exercise the op-level budget.
 */
class FakeSocket extends EventEmitter {
  destroyed = false;
  private readonly opts: { connectMode: 'success' | 'hang' | 'error'; getMode?: 'reply' | 'hang' };

  constructor(opts: { connectMode: 'success' | 'hang' | 'error'; getMode?: 'reply' | 'hang' }) {
    super();
    this.opts = opts;
    if (opts.connectMode === 'success') setTimeout(() => this.emit('secureConnect'), 0);
    else if (opts.connectMode === 'error') setTimeout(() => this.emit('error', new Error('ECONNREFUSED')), 0);
    // 'hang' → never emit secureConnect/error.
  }

  setNoDelay(): this {
    return this;
  }

  write(data: string | Buffer, cb?: (err?: Error) => void): boolean {
    const s = data.toString();
    if (s.includes('AUTH')) {
      setTimeout(() => this.feed('+OK\r\n'), 0);
    } else if (s.includes('GET')) {
      if (this.opts.getMode === 'reply') setTimeout(() => this.feed('$3\r\nabc\r\n'), 0);
      // 'hang' (default) → never reply.
    } else if (s.includes('SET') || s.includes('DEL')) {
      setTimeout(() => this.feed(':1\r\n'), 0);
    }
    cb?.();
    return true;
  }

  private feed(str: string): void {
    if (!this.destroyed) this.emit('data', Buffer.from(str, 'utf8'));
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close');
    }
    return this;
  }
}

/** Poll `pred` until true or `timeoutMs` elapses (real timers, tiny budgets). */
async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return pred();
}

const REDIS_ENV_KEYS = [
  'LOOM_RESULT_CACHE_REDIS',
  'LOOM_RESULT_CACHE_REDIS_PASSWORD',
  'LOOM_RESULT_CACHE_REDIS_TLS',
  'LOOM_RESULT_CACHE_REDIS_CONNECT_TIMEOUT_MS',
  'LOOM_RESULT_CACHE_REDIS_OP_TIMEOUT_MS',
  'LOOM_RESULT_CACHE_REDIS_BREAKER_THRESHOLD',
  'LOOM_RESULT_CACHE_REDIS_BREAKER_RESET_MS',
] as const;

describe('redis-cache-client fail-fast connection', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of REDIS_ENV_KEYS) saved[k] = process.env[k];
    mocks.socketCount = 0;
    mocks.makeSocket = null;
    // Access-key auth keeps AUTH a single round-trip and avoids the credential.
    process.env.LOOM_RESULT_CACHE_REDIS = 'testhost:6380';
    process.env.LOOM_RESULT_CACHE_REDIS_PASSWORD = 'secret-key';
    _redisResetForTest();
  });

  afterEach(() => {
    _redisResetForTest();
    for (const k of REDIS_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('never awaits a cold connect — the first request returns immediately from the lower tiers', async () => {
    process.env.LOOM_RESULT_CACHE_REDIS_CONNECT_TIMEOUT_MS = '5000'; // long connect budget
    mocks.makeSocket = () => new FakeSocket({ connectMode: 'hang' });

    const t0 = Date.now();
    const result = await redisGet('k');
    const elapsed = Date.now() - t0;

    expect(result).toBeNull(); // served from lower tiers, not from Redis
    expect(elapsed).toBeLessThan(200); // did NOT block on the (5s) cold connect
    expect(_redisReady()).toBe(false); // and did not become ready synchronously
    // It DID kick a background connect (the socket is created after the dynamic
    // import('tls') microtask, i.e. off the request path).
    expect(await waitFor(() => mocks.socketCount === 1, 500)).toBe(true);
  });

  it('degrades within the connect budget and OPENs the breaker after 3 connect timeouts', async () => {
    process.env.LOOM_RESULT_CACHE_REDIS_CONNECT_TIMEOUT_MS = '30';
    process.env.LOOM_RESULT_CACHE_REDIS_BREAKER_THRESHOLD = '3';
    process.env.LOOM_RESULT_CACHE_REDIS_BREAKER_RESET_MS = '10000';
    mocks.makeSocket = () => new FakeSocket({ connectMode: 'hang' });

    for (let i = 1; i <= 3; i++) {
      const t0 = Date.now();
      const r = await redisGet('k');
      expect(r).toBeNull();
      expect(Date.now() - t0).toBeLessThan(200); // request itself never blocks
      // Wait for the background connect to blow its 30ms budget and record a failure.
      await waitFor(() => _redisBreakerState().failures >= i, 1000);
      expect(_redisBreakerState().failures).toBe(i);
    }

    const state = _redisBreakerState();
    expect(state.open).toBe(true);
    expect(state.openUntil).toBeGreaterThan(Date.now());

    // While OPEN, further requests skip Redis entirely — no new connect storm.
    const before = mocks.socketCount;
    const r = await redisGet('k');
    expect(r).toBeNull();
    expect(mocks.socketCount).toBe(before);
  });

  it('degrades within the per-op budget when a GET reply never arrives', async () => {
    process.env.LOOM_RESULT_CACHE_REDIS_CONNECT_TIMEOUT_MS = '1000';
    process.env.LOOM_RESULT_CACHE_REDIS_OP_TIMEOUT_MS = '30';
    process.env.LOOM_RESULT_CACHE_REDIS_BREAKER_THRESHOLD = '100'; // don't trip mid-test
    mocks.makeSocket = () => new FakeSocket({ connectMode: 'success', getMode: 'hang' });

    // First call kicks the (successful) background connect; wait until ready.
    await redisGet('k');
    const becameReady = await waitFor(() => _redisReady(), 1000);
    expect(becameReady).toBe(true);

    // Now the connection is ready but the GET reply hangs → op budget fires.
    const t0 = Date.now();
    const r = await redisGet('k');
    const elapsed = Date.now() - t0;
    expect(r).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(400); // bounded by the 30ms op budget, not hung
    expect(_redisBreakerState().failures).toBeGreaterThanOrEqual(1);
    expect(_redisReady()).toBe(false); // the wedged socket was torn down
  });

  it('half-open probe recovers and CLOSES the breaker on the next success', async () => {
    process.env.LOOM_RESULT_CACHE_REDIS_CONNECT_TIMEOUT_MS = '30';
    process.env.LOOM_RESULT_CACHE_REDIS_BREAKER_THRESHOLD = '3';
    process.env.LOOM_RESULT_CACHE_REDIS_BREAKER_RESET_MS = '80';

    // Trip the breaker with three hanging connects.
    mocks.makeSocket = () => new FakeSocket({ connectMode: 'hang' });
    for (let i = 1; i <= 3; i++) {
      await redisGet('k');
      await waitFor(() => _redisBreakerState().failures >= i, 1000);
    }
    expect(_redisBreakerState().open).toBe(true);

    // Wait past the reset window → half-open. Swap in a HEALTHY socket.
    await waitFor(() => !_redisBreakerState().open, 1000);
    mocks.makeSocket = () => new FakeSocket({ connectMode: 'success', getMode: 'reply' });

    // Half-open probe: this call kicks a connect (allowed) then returns; wait ready.
    await redisGet('k');
    const becameReady = await waitFor(() => _redisReady(), 1000);
    expect(becameReady).toBe(true);

    // A real successful GET closes the breaker and returns the value.
    const r = await redisGet('k');
    expect(r).toBe('abc');
    const state = _redisBreakerState();
    expect(state.open).toBe(false);
    expect(state.failures).toBe(0);
    expect(state.openUntil).toBe(0);
  });
});
