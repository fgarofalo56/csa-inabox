/**
 * PSR-6 — HTTP cache-header helpers: weak ETag, If-None-Match parsing, and the
 * jsonWithQueryCache 304 short-circuit.
 */
import { describe, expect, it } from 'vitest';
import {
  weakEtag, parseIfNoneMatch, etagMatches, jsonWithQueryCache, withQueryCacheHeaders,
} from '../query-cache-headers';
import { NextResponse } from 'next/server';

describe('weakEtag', () => {
  it('is a weak validator and stable for equal bodies', () => {
    const a = weakEtag({ ok: true, rows: [[1, 2]] });
    const b = weakEtag({ ok: true, rows: [[1, 2]] });
    expect(a).toBe(b);
    expect(a.startsWith('W/"')).toBe(true);
    expect(a.endsWith('"')).toBe(true);
  });
  it('differs when the body differs', () => {
    expect(weakEtag({ rows: [[1]] })).not.toBe(weakEtag({ rows: [[2]] }));
  });
});

describe('parseIfNoneMatch / etagMatches', () => {
  it('parses a bare tag, a list, and the weak prefix', () => {
    const set = parseIfNoneMatch('W/"abc", "def"');
    expect(set.has('abc')).toBe(true);
    expect(set.has('def')).toBe(true);
  });
  it('matches an ETag the client already holds (weak-compare)', () => {
    const etag = weakEtag({ rows: [[1]] });
    expect(etagMatches(etag, etag)).toBe(true);
    expect(etagMatches(etag, 'W/"nope"')).toBe(false);
    expect(etagMatches(etag, null)).toBe(false);
  });
});

describe('withQueryCacheHeaders', () => {
  it('sets ETag + private Cache-Control with a floored max-age', () => {
    const res = withQueryCacheHeaders(NextResponse.json({ ok: true }), 'W/"x"', 90.7);
    expect(res.headers.get('ETag')).toBe('W/"x"');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=90');
  });
});

describe('jsonWithQueryCache — 304 revalidation', () => {
  it('returns 200 + ETag on a fresh request', () => {
    const body = { ok: true, rows: [[1, 2, 3]] };
    const res = jsonWithQueryCache(body, { ifNoneMatch: null, maxAgeSec: 60 });
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBe(weakEtag(body));
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=60');
  });
  it('returns 304 (empty body) when the client already holds the ETag', () => {
    const body = { ok: true, rows: [[1, 2, 3]] };
    const etag = weakEtag(body);
    const res = jsonWithQueryCache(body, { ifNoneMatch: etag, maxAgeSec: 60 });
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(etag);
  });
});
