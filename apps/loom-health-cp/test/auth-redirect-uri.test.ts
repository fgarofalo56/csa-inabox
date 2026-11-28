// redirect/launch URI host grammar (#5514) against the picker's CSP serializer (#5513). The serializer's regex is
// LIFTED from picker-page.ts at test time, never transcribed, so the two cannot drift apart silently.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSafeRedirectUri, isSafeUriHost } from '../src/auth/redirect-uri.js';
import { formActionSource } from '../src/auth/picker-page.js';

const PICKER = readFileSync(resolve(__dirname, '../src/auth/picker-page.ts'), 'utf8');
const lifted = /^const CSP_HOST_SOURCE = \/(.+)\/([a-z]*);$/m.exec(PICKER);
const CSP_HOST_SOURCE = new RegExp(lifted?.[1] ?? '(?!)', lifted?.[2] ?? '');

// Crafted to exercise every rule on both sides. Every entry parses with new URL() unless noted.
const CORPUS = [
  'https://app.test/cb', 'https://APP.Test/cb', 'https://a-b.example.org:8443/cb', 'https://192.168.2.252/custom/smart_stu2_2/redirect',
  'http://localhost:3000/cb', 'http://127.0.0.1/cb', 'https://localhost/cb', 'https://xn--exmple-cua.com/cb', 'https://exämple.com/cb',
  'https://evil;script-src/cb', 'https://a,b.test/cb', "https://a'b.test/cb", 'https://a"b.test/cb', 'https://*.test/cb', 'https://a$b.test/cb',
  'https://my_host.example/cb', 'https://a.com./cb', 'https://-a.com/cb', 'https://a-.com/cb', 'https://a.-b.com/cb', 'https://intranet/cb',
  'https://[::1]/cb', 'https://[::1]:8443/cb', 'https://a%3Bb.test/cb', 'https://a b.test/cb', 'https://a..b/cb', `https://${'a'.repeat(64)}.test/cb`,
  'http://app.test/cb', 'https://u:p@app.test/cb', 'https://app.test/cb#f', 'not a url',
  // Non-canonical hosts the URL parser REWRITES (review of #5521): 017.1.1.1 -> 15.1.1.1, 0x7f.1 -> 127.0.0.1,
  // 1.2.3 -> 1.2.0.3. And port 0.
  'https://017.1.1.1/cb', 'https://0x7f.1/cb', 'https://1.2.3/cb', 'https://app.test:0/cb',
];

describe('redirect URI host grammar (#5514)', () => {
  it('the serializer regex was lifted from picker-page.ts', () => {
    expect(lifted, 'CSP_HOST_SOURCE moved or changed shape in picker-page.ts').not.toBeNull();
    expect(CSP_HOST_SOURCE.test('https://app.test')).toBe(true); // positive control for the lifted pattern
    expect(CSP_HOST_SOURCE.test('https://evil;script-src')).toBe(false);
  });

  it('every URI the validator accepts serializes as a CSP host-source (validator is a subset of the serializer)', () => {
    const accepted = CORPUS.filter(isSafeRedirectUri);
    // A LITERAL list (not derived from either rule), so a loosening or tightening on either side turns this red.
    expect(accepted).toEqual([
      'https://app.test/cb', 'https://APP.Test/cb', 'https://a-b.example.org:8443/cb', 'https://192.168.2.252/custom/smart_stu2_2/redirect',
      'http://localhost:3000/cb', 'http://127.0.0.1/cb', 'https://localhost/cb', 'https://xn--exmple-cua.com/cb',
    ]);
    for (const uri of accepted) {
      expect([uri, CSP_HOST_SOURCE.test(new URL(uri).origin)]).toEqual([uri, true]);
      expect([uri, 'source' in formActionSource(uri)]).toEqual([uri, true]);
    }
  });

  it('the only URIs the serializer takes and the validator refuses are the LDH and dot rules, and non-https', () => {
    const cspOnly = CORPUS.filter((u) => !isSafeRedirectUri(u) && 'source' in formActionSource(u));
    // -a.com / a-.com / a.-b.com: LDH forbids a hyphen at a label edge. intranet: no dot. A 64-char label: over 63.
    // http://app.test and the credential/fragment URIs: refused by the URL rules, whatever their host. exämple.com and
    // the non-canonical IPv4 forms: the host as written is not the host the parser produces. Port 0: refused.
    expect(cspOnly).toEqual([
      'https://exämple.com/cb',
      'https://-a.com/cb', 'https://a-.com/cb', 'https://a.-b.com/cb', 'https://intranet/cb', `https://${'a'.repeat(64)}.test/cb`,
      'http://app.test/cb', 'https://u:p@app.test/cb', 'https://app.test/cb#f',
      'https://017.1.1.1/cb', 'https://0x7f.1/cb', 'https://1.2.3/cb', 'https://app.test:0/cb',
    ]);
  });

  it('a host the URL parser rewrites is refused, naming the host it would really go to; canonical IPv4 is kept', () => {
    // Each pair: what was written, what the browser would actually visit. Breaks (true) without the raw-host check.
    for (const [uri, real] of [['https://017.1.1.1/cb', '15.1.1.1'], ['https://0x7f.1/cb', '127.0.0.1'], ['https://1.2.3/cb', '1.2.0.3']]) {
      expect([uri, new URL(uri as string).hostname, isSafeRedirectUri(uri as string)]).toEqual([uri, real, false]);
    }
    expect(isSafeRedirectUri('https://app.test:0/cb')).toBe(false); // breaks (true) without the port-0 check
    expect(isSafeRedirectUri('https://app.test:8443/cb')).toBe(true); // paired: a real port
    expect(isSafeRedirectUri('https://192.168.2.252/custom/smart_stu2_2/redirect')).toBe(true); // the Inferno redirect
    expect(isSafeRedirectUri('https://APP.test:443/cb')).toBe(true); // case and the default port are not "rewrites"
  });

  it('a bracketed IPv6 literal is refused: CSP host-source cannot carry it, so the picker could never redirect there', () => {
    expect(CSP_HOST_SOURCE.test(new URL('https://[::1]/cb').origin)).toBe(false); // the reason, measured
    expect(isSafeRedirectUri('https://[::1]/cb')).toBe(false);
    expect(isSafeUriHost('[::1]')).toBe(false);
  });

  it('host rules: case-insensitive, trailing dot, underscore, quotes, separators, 253-character cap', () => {
    expect(isSafeUriHost('App.Example.COM')).toBe(true);
    for (const h of ['a.com.', 'my_host.example', 'a;b.com', 'a,b.com', 'a b.com', "a'b.com", 'a"b.com', 'a*b.com', 'a$b.com', '-a.com', 'a-.com', 'intranet', '']) {
      expect([h, isSafeUriHost(h)]).toEqual([h, false]);
    }
    const long = `${Array(4).fill('a'.repeat(63)).join('.')}.com`; // 259 characters, every label legal
    expect([long.length > 253, isSafeUriHost(long)]).toEqual([true, false]);
    expect(isSafeUriHost(long.slice(64))).toBe(true); // paired: the same shape at 195 characters
    expect(isSafeRedirectUri('https://256.1.1.1/cb')).toBe(false); // the URL parser refuses an out-of-range IPv4
  });
});
