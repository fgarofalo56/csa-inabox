/**
 * The report-subscriptions copy of the same-origin resolver, tested against the
 * SAME hostile-candidate table the console's copy is tested against.
 *
 * WHY IT IS RE-RUN HERE RATHER THAN INHERITED. This runtime is a separate npm
 * package with its own tsconfig and its own image; the console's receipt says
 * nothing about the bytes that ship in this container. A copy whose only
 * evidence is "the original passed" is a copy nobody has measured.
 *
 * The assertion that matters is not "it threw" — it is WHERE A FETCH WOULD GO.
 * Every row below records the host `fetch()` would actually contact if the
 * resolver returned, which is the only question the advisory asks.
 */
import { describe, it, expect } from 'vitest';
import {
  OffOriginUrlError,
  isAbsoluteHttpUrl,
  isSameOrigin,
  resolveSameOriginUrl,
} from './same-origin-url';

const ARM = 'https://management.azure.com';

/** What host would a fetch reach, or why did the resolver refuse? */
function probe(candidate: string, base = ARM): string {
  let out: string;
  try {
    out = resolveSameOriginUrl(candidate, base, 'the ARM token');
  } catch (e) {
    return e instanceof OffOriginUrlError ? `THROW ${e.reason}` : `THROW other:${String(e)}`;
  }
  try {
    return `OK ${new URL(out).host}`;
  } catch {
    return `OK unparseable-result:${out}`;
  }
}

describe('report-subscriptions same-origin resolver — hostile candidates', () => {
  it.each([
    ['suffix impostor', 'https://management.azure.com.evil.test/x'],
    ['userinfo authority', 'https://management.azure.com@evil.test/x'],
    ['userinfo with password', 'https://management.azure.com:tok@evil.test/x'],
    ['trailing-dot host', 'https://management.azure.com./subscriptions'],
    ['off port', 'https://management.azure.com:8443/subscriptions'],
    ['scheme downgrade', 'http://management.azure.com/subscriptions'],
    ['punycode homograph', 'https://xn--mnagement-o4a.azure.com/x'],
    ['opaque origin', 'data:text/html,x'],
    ['tab in scheme', 'ht\ttps://evil.test/x'],
    ['bare foreign host', 'https://evil.test/subscriptions'],
    ['uppercase foreign host', 'HTTPS://EVIL.TEST/x'],
  ])('refuses %s', (_label, candidate) => {
    const r = probe(candidate);
    expect(r.startsWith('THROW')).toBe(true);
    expect(r).not.toContain('evil.test');
  });

  it('an explicit :443 is the same origin as the default port', () => {
    expect(probe('https://management.azure.com:443/subscriptions')).toBe('OK management.azure.com');
  });

  it('a legitimate absolute nextLink on the ARM origin is followed', () => {
    expect(probe(`${ARM}/subscriptions?$skiptoken=abc`)).toBe('OK management.azure.com');
  });

  it('a protocol-relative path stays on the base host (it is NOT absolute)', () => {
    // `//evil.test/x` is not `http(s)://…`, so it takes the RELATIVE branch and
    // is concatenated onto the base — the joined URL is re-parsed and its host
    // is still the base's. Recorded because the shape LOOKS like an escape.
    expect(probe('//evil.test/x')).toBe('OK management.azure.com');
  });

  it('a backslash authority stays on the base host', () => {
    expect(probe('\\\\evil.test/x')).toBe('OK management.azure.com');
  });

  it('an unparseable base admits nothing (fail closed)', () => {
    expect(probe('/subscriptions', '')).toBe('THROW unparseable');
    expect(probe('/subscriptions', 'not a url')).toBe('THROW unparseable');
    expect(probe(`${ARM}/subscriptions`, '')).toBe('THROW unparseable');
  });

  it('the sovereign base governs — a Commercial nextLink is refused in Gov', () => {
    const GOV = 'https://management.usgovcloudapi.net';
    expect(probe(`${GOV}/subscriptions`, GOV)).toBe('OK management.usgovcloudapi.net');
    expect(probe(`${ARM}/subscriptions`, GOV)).toBe('THROW off-origin');
  });

  it('the error never echoes the rejected value', () => {
    let msg = '';
    try {
      resolveSameOriginUrl('https://evil.test/steal', ARM, 'the ARM token');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('the ARM token');
    expect(msg).not.toContain('evil.test');
  });

  it('isAbsoluteHttpUrl / isSameOrigin agree with the resolver', () => {
    expect(isAbsoluteHttpUrl('https://x.test/a')).toBe(true);
    expect(isAbsoluteHttpUrl('/subscriptions')).toBe(false);
    expect(isAbsoluteHttpUrl(null)).toBe(false);
    expect(isSameOrigin(`${ARM}/a`, ARM)).toBe(true);
    expect(isSameOrigin('https://management.azure.com.evil.test/a', ARM)).toBe(false);
    expect(isSameOrigin('data:text/html,x', 'data:text/html,y')).toBe(false);
  });
});
