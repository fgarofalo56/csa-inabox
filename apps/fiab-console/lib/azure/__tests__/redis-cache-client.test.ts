/**
 * Tests for redis-cache-client pure helpers: RESP2 command encoding, reply
 * parsing (incl. incomplete/null/error), endpoint parsing, and JWT oid read.
 * No socket/network — the connection path degrades silently and is exercised
 * only via `redisCacheConfigured()` being false in unit context.
 */
import { describe, expect, it } from 'vitest';
import {
  encodeCommand,
  parseReply,
  parseRedisEndpoint,
  oidFromToken,
  redisCacheConfigured,
} from '../redis-cache-client';

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
