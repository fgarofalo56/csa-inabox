/**
 * Unit tests for the shared same-origin resolver (advisory GHSA-4gvx-9p49-p43g).
 *
 * These are ATTACK tests. The confusable-host cases are the point: each one
 * DEFEATS a `startsWith` check, which is the construction every credentialed
 * client in this codebase used to resolve its request target.
 *
 * They deliberately re-state, against the shared helper, the properties
 * `lib/clients/__tests__/networking-arm-origin.test.ts` proved against the
 * per-function copy — because that copy is now a thin wrapper and a test that
 * only exercises the wrapper would go quiet if the wrapper were inlined again.
 */
import { describe, it, expect } from 'vitest';
import {
  OffOriginUrlError,
  assertSameOrigin,
  isAbsoluteHttpUrl,
  isSameOrigin,
  resolveSameOriginUrl,
  sameOriginUrlOrNull,
} from '../same-origin-url';

const ARM = 'https://management.azure.com';
const GOV = 'https://management.usgovcloudapi.net';
const GRAPH = 'https://graph.microsoft.com/v1.0';

describe('resolveSameOriginUrl — relative paths still work', () => {
  it('concatenates verbatim, with no re-encoding', () => {
    const p = '/subscriptions/abc/resourceGroups?api-version=2024-01-01&$filter=a eq \'b\'';
    expect(resolveSameOriginUrl(p, ARM)).toBe(`${ARM}${p}`);
  });

  it('joins a Graph base that carries a path segment', () => {
    expect(resolveSameOriginUrl('/groups/g1/members', GRAPH)).toBe(`${GRAPH}/groups/g1/members`);
  });
});

describe('resolveSameOriginUrl — absolute URLs (pagination must keep working)', () => {
  it('permits a same-origin nextLink', () => {
    const next = `${ARM}/subscriptions/abc/providers/Microsoft.Network/virtualNetworks?$skipToken=X`;
    expect(resolveSameOriginUrl(next, ARM)).toBe(new URL(next).toString());
  });

  it('permits a sovereign endpoint when that is the configured base (cloud-parity)', () => {
    const next = `${GOV}/subscriptions/abc/x?$skipToken=Y`;
    expect(resolveSameOriginUrl(next, GOV)).toBe(new URL(next).toString());
  });

  it('compares ORIGIN, so a Graph nextLink on /beta is still Graph', () => {
    const next = 'https://graph.microsoft.com/beta/groups?$skiptoken=Z';
    expect(resolveSameOriginUrl(next, GRAPH)).toBe(new URL(next).toString());
  });
});

describe('resolveSameOriginUrl — ATTACK cases', () => {
  it.each([
    ['https://evil.test/steal', 'a plainly foreign host'],
    // Both of the following PASS `startsWith('https://management.azure.com')`
    // and both actually resolve to evil.test. This is why the check is on the
    // parsed origin, not on a string prefix.
    ['https://management.azure.com.evil.test/steal', 'suffix-confusable host'],
    ['https://management.azure.com@evil.test/steal', 'userinfo-confusable host'],
    ['http://management.azure.com/x', 'downgraded scheme (different origin)'],
    ['https://management.azure.com:8443/x', 'different port'],
    [`${GOV}/x`, 'a DIFFERENT cloud than configured'],
  ])('REFUSES %j (%s)', (candidate) => {
    expect(() => resolveSameOriginUrl(candidate as string, ARM)).toThrow(OffOriginUrlError);
  });

  it('the confusable hosts really do resolve elsewhere (the bug was real)', () => {
    expect(new URL('https://management.azure.com.evil.test/x').host).toBe('management.azure.com.evil.test');
    expect(new URL('https://management.azure.com@evil.test/x').host).toBe('evil.test');
    // ...and both satisfy the prefix test the fix replaces.
    expect('https://management.azure.com@evil.test/x'.startsWith('http')).toBe(true);
    expect('https://management.azure.com.evil.test/x'.startsWith(ARM)).toBe(true);
  });

  it('FAILS CLOSED on an unparseable absolute URL rather than treating it as a path', () => {
    // Falling through to `${base}${path}` here would build a nonsense URL and
    // send the token to a wrong route instead of refusing.
    expect(() => resolveSameOriginUrl('https://', ARM)).toThrow(OffOriginUrlError);
    expect(() => resolveSameOriginUrl('http://[', ARM)).toThrow(OffOriginUrlError);
  });

  it('FAILS CLOSED when the BASE is unusable — a misconfigured endpoint admits nothing', () => {
    expect(() => resolveSameOriginUrl('/x', 'not-a-url')).toThrow(OffOriginUrlError);
    expect(() => resolveSameOriginUrl('/x', '')).toThrow(OffOriginUrlError);
    expect(isSameOrigin(`${ARM}/x`, 'not-a-url')).toBe(false);
  });

  it('refuses an opaque origin instead of letting two of them compare equal', () => {
    // `new URL('data:…').origin` is the STRING 'null', which would match another
    // opaque origin. Neither is ever a service endpoint.
    expect(isSameOrigin('data:text/plain,hi', 'data:text/plain,there')).toBe(false);
  });

  it('does not echo the rejected origin back to the caller', () => {
    // The rejected value is attacker-chosen; reflecting it puts it in logs and
    // in whatever response the caller builds from the error.
    const err = (() => {
      try { resolveSameOriginUrl('https://evil.test/steal', ARM); return null; }
      catch (e) { return e as OffOriginUrlError; }
    })();
    expect(err).toBeInstanceOf(OffOriginUrlError);
    expect(err!.message).not.toContain('evil.test');
    expect(err!.reason).toBe('off-origin');
    // It DOES name what was about to be sent, which is the actionable half.
    expect(new OffOriginUrlError('off-origin', 'the ARM token').message).toContain('the ARM token');
  });
});

describe('sameOriginUrlOrNull — the walker form', () => {
  it('returns the resolved URL for a same-origin link', () => {
    expect(sameOriginUrlOrNull(`${ARM}/x?$skiptoken=1`, ARM)).toBe(`${ARM}/x?$skiptoken=1`);
  });

  it.each<[string | null | undefined, string]>([
    ['https://evil.test/x', 'foreign host'],
    ['https://management.azure.com.evil.test/x', 'suffix-confusable'],
    ['not-a-url-at-all', 'unparseable, and NOT to be re-rooted as a path'],
    ['https://', 'unparseable absolute'],
    ['', 'empty'],
    [null, 'null'],
    [undefined, 'undefined'],
  ])('returns null for %j (%s) — the walk stops, nothing is fetched', (candidate) => {
    expect(sameOriginUrlOrNull(candidate, ARM)).toBeNull();
  });

  it('never throws, so a walker cannot turn a refusal into "the resource is missing"', () => {
    expect(() => sameOriginUrlOrNull('https://evil.test/x', ARM)).not.toThrow();
    expect(() => sameOriginUrlOrNull('x', 'also-not-a-url')).not.toThrow();
  });
});

describe('assertSameOrigin / isAbsoluteHttpUrl', () => {
  it('assertSameOrigin returns the candidate unchanged when it is on-origin', () => {
    const u = `${GRAPH}/groups?$skiptoken=q`;
    expect(assertSameOrigin(u, GRAPH)).toBe(u);
  });

  it('assertSameOrigin throws with the right reason for each failure mode', () => {
    const off = (() => { try { assertSameOrigin('https://evil.test/x', ARM); return null; } catch (e) { return e as OffOriginUrlError; } })();
    const bad = (() => { try { assertSameOrigin('nope', ARM); return null; } catch (e) { return e as OffOriginUrlError; } })();
    expect(off!.reason).toBe('off-origin');
    expect(bad!.reason).toBe('unparseable');
  });

  it('isAbsoluteHttpUrl distinguishes a path from an absolute URL', () => {
    expect(isAbsoluteHttpUrl('/subscriptions/x')).toBe(false);
    expect(isAbsoluteHttpUrl('subscriptions/x')).toBe(false);
    // `startsWith('http')` — the construction being replaced — says TRUE here.
    expect(isAbsoluteHttpUrl('httpfoo/bar')).toBe(false);
    expect('httpfoo/bar'.startsWith('http')).toBe(true);
    expect(isAbsoluteHttpUrl('HTTPS://management.azure.com/x')).toBe(true);
  });
});
