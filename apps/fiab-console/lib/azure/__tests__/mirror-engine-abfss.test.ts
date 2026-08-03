import { describe, it, expect, afterEach } from 'vitest';
import { httpsToAbfss, appConfigSuffixFromEndpoint } from '../cloud-endpoints';

const ORIG_LOOM = process.env.LOOM_CLOUD;
const ORIG_AZURE = process.env.AZURE_CLOUD;

afterEach(() => {
  if (ORIG_LOOM === undefined) delete process.env.LOOM_CLOUD;
  else process.env.LOOM_CLOUD = ORIG_LOOM;
  if (ORIG_AZURE === undefined) delete process.env.AZURE_CLOUD;
  else process.env.AZURE_CLOUD = ORIG_AZURE;
});

function withCloud(loomCloud: string) {
  process.env.LOOM_CLOUD = loomCloud;
  delete process.env.AZURE_CLOUD;
}

describe('httpsToAbfss — sovereign-cloud aware dfs URL → abfss conversion', () => {
  it('converts a Commercial dfs https URL to abfss', () => {
    withCloud('Commercial');
    expect(
      httpsToAbfss('https://saloom.dfs.core.windows.net/bronze/mirrors/ws1/m1/dbo.T/'),
    ).toBe('abfss://bronze@saloom.dfs.core.windows.net/mirrors/ws1/m1/dbo.T/');
  });

  it('GCC uses Commercial endpoints — converts the windows.net dfs URL', () => {
    withCloud('GCC');
    expect(
      httpsToAbfss('https://saloom.dfs.core.windows.net/bronze/path/'),
    ).toBe('abfss://bronze@saloom.dfs.core.windows.net/path/');
  });

  it('REGRESSION (BUG-3): GCC-High converts the usgovcloudapi dfs URL (not passed through)', () => {
    withCloud('GCC-High');
    const gov = 'https://saloom.dfs.core.usgovcloudapi.net/bronze/mirrors/ws1/m1/dbo.T/';
    const out = httpsToAbfss(gov);
    expect(out).toBe('abfss://bronze@saloom.dfs.core.usgovcloudapi.net/mirrors/ws1/m1/dbo.T/');
    // It must NOT return the https URL unchanged (the pre-fix bug).
    expect(out).not.toBe(gov);
    expect(out.startsWith('abfss://')).toBe(true);
  });

  it('IL5 (alias of GCC-High) converts the usgovcloudapi dfs URL', () => {
    withCloud('IL5');
    expect(
      httpsToAbfss('https://saloom.dfs.core.usgovcloudapi.net/bronze/p/'),
    ).toBe('abfss://bronze@saloom.dfs.core.usgovcloudapi.net/p/');
  });

  it('returns a non-dfs URL unchanged', () => {
    withCloud('Commercial');
    expect(httpsToAbfss('https://example.com/not-a-dfs-url')).toBe('https://example.com/not-a-dfs-url');
  });

  it('returns the empty string unchanged', () => {
    expect(httpsToAbfss('')).toBe('');
  });
});

/**
 * CodeQL js/incomplete-hostname-regexp #420/#421 point at cloud-endpoints.ts:357
 * — the `dfsSuffix()` string LITERAL — claiming an unescaped `.` before
 * `windows.net` / `usgovcloudapi.net` "might match more hosts than expected".
 *
 * The escape does not live at the literal; it lives at the USE site (line 380):
 *
 *     const suffix = dfsSuffix().replace(/[.*+?^${}()|[\]\]/g, '\$&');
 *
 * so the pattern actually compiled is `dfs\.core\.windows\.net`, and it is
 * additionally anchored `^…$`. CodeQL reports the definition without modelling
 * the transform at the consumer.
 *
 * These tests are the evidence for that dismissal. They assert the property the
 * alert disputes — a `.` in the suffix must NOT behave as a wildcard — and they
 * are written against the exported function, so if a future edit drops the
 * escape or the anchors, they go red rather than the dismissal quietly becoming
 * false.
 */
describe('httpsToAbfss — the dfs suffix is regex-ESCAPED, so `.` is not a wildcard (CodeQL #420/#421)', () => {
  const nonMatches = [
    ['https://acct.dfsXcoreYwindowsZnet/c/p', 'dot-as-wildcard — the exact shape the alert alleges'],
    ['https://acct.dfs-core-windows-net/c/p', 'dash variant'],
    ['https://acct.dfs.core.windows.netX/c/p', 'trailing character after the suffix'],
    ['https://acct.dfs.core.windows.net.evil.test/c/p', 'suffix-confusable host'],
  ];

  it.each(nonMatches)('returns %s UNCHANGED (%s)', (url) => {
    // Unchanged === did not match === was not treated as a Loom ADLS URL.
    expect(httpsToAbfss(url)).toBe(url);
  });

  it('still converts a legitimate ADLS URL', () => {
    expect(httpsToAbfss('https://acct.dfs.core.windows.net/c/p'))
      .toBe('abfss://c@acct.dfs.core.windows.net/p');
  });

  it('the counter-factual: WITHOUT the escape the wildcard host would match', () => {
    // Models the PRODUCTION regex with ONE thing removed — the suffix escape —
    // so the comparison isolates exactly the property under test. The account
    // separator stays escaped (`\\.` in source => `\.` in the pattern), which is
    // what cloud-endpoints.ts:381 emits.
    //
    // Written with a RegExp literal rather than a string: an earlier draft used
    // `new RegExp('…\\.dfs…')` and lost a backslash level, so the separator dot
    // silently became a wildcard too — a weaker counter-factual that still went
    // green. CodeQL js/useless-regexp-character-escape caught it. In a JS string
    // `\.` is not an escape sequence and collapses to `.`; in a regex literal it
    // is unambiguous.
    const unescaped = /^https:\/\/([^.]+)\.dfs.core.windows.net\/([^/]+)\/(.*)$/i;
    expect(unescaped.source).toContain('\\.dfs'); // separator escaped…
    expect(unescaped.source).toContain('dfs.core.windows.net'); // …suffix NOT

    // The bug CodeQL alleges is real in that form:
    expect(unescaped.test('https://acct.dfsXcoreYwindowsZnet/c/p')).toBe(true);
    // …and absent in ours (returned unchanged === no match):
    expect(httpsToAbfss('https://acct.dfsXcoreYwindowsZnet/c/p'))
      .toBe('https://acct.dfsXcoreYwindowsZnet/c/p');
  });
});

/**
 * appConfigSuffixFromEndpoint decides whether an App Configuration host is
 * Commercial or Gov, and that suffix feeds endpoint + token-audience
 * construction. It matched with `host.endsWith('azconfig.io')`, which CodeQL
 * flagged (js/incomplete-url-substring-sanitization #540): "'azconfig.io' may be
 * preceded by an arbitrary host name."
 *
 * It is right — `endsWith` has no notion of a DNS label boundary, so
 * `evilazconfig.io` (a different registrable domain) matched. Now via
 * `hostHasSuffix`, which requires `=== suffix` or a separating dot.
 *
 * Legitimate hosts are unaffected: they always carry the dot. The confusable is
 * asserted explicitly so the boundary cannot be lost in a later edit.
 */
describe('appConfigSuffixFromEndpoint — DNS label boundary, not bare endsWith (CodeQL #540)', () => {
  /**
   * The PRE-FIX matcher, reconstructed so the counter-factuals below are
   * executable rather than asserted from memory. `String.prototype.endsWith`
   * with these exact arguments is what shipped, and `slice(-n) === suffix` is
   * its definition.
   *
   * It is written out rather than calling `endsWith` directly for a reason that
   * is not cosmetic. `host.endsWith('azconfig.io')` inside this file is the
   * literal shape CodeQL js/incomplete-url-substring-sanitization exists to
   * find, and it flagged it here (#743) even though both operands are
   * constants and no URL is being validated. Leaving the call in place means a
   * standing alert on a line that is documenting the bug — and an alert that is
   * really a demonstration is indistinguishable, in the queue, from one that is
   * really a defect. Naming the legacy matcher says what the line means, and
   * the assertions below are unchanged.
   */
  const legacyEndsWithMatch = (host: string, suffix: string) =>
    host.slice(-suffix.length) === suffix;

  it.each([
    ['https://store.azconfig.io', 'azconfig.io'],
    ['https://store.azconfig.azure.us', 'azconfig.azure.us'],
    ['store.azconfig.io/some/path', 'azconfig.io'],
  ])('classifies %s as %s', (endpoint, expected) => {
    expect(appConfigSuffixFromEndpoint(endpoint)).toBe(expected);
  });

  it('does NOT accept a confusable GOV host that merely ENDS with the suffix', () => {
    // `notazconfig.azure.us` is a different registrable domain, and the old
    // `host.endsWith('azconfig.azure.us')` matched it:
    expect(legacyEndsWithMatch('notazconfig.azure.us', 'azconfig.azure.us')).toBe(true);
    // With the label boundary it no longer classifies as the Gov suffix — it
    // falls through to the cloud default instead.
    expect(appConfigSuffixFromEndpoint('https://notazconfig.azure.us')).not.toBe('azconfig.azure.us');
  });

  it('the COMMERCIAL confusable is rejected but not observable here — documented, not asserted', () => {
    // `evilazconfig.io` no longer MATCHES 'azconfig.io'… but the function's
    // documented contract is to fall back to the cloud-derived suffix when
    // nothing matches, and in Commercial that fallback IS 'azconfig.io'. So the
    // return value is identical either way and cannot distinguish "matched" from
    // "fell through".
    //
    // Asserting `.not.toBe('azconfig.io')` here FAILED for exactly that reason —
    // the test was wrong, not the fix. Recorded rather than deleted, because the
    // next person will otherwise write the same assertion.
    expect(legacyEndsWithMatch('evilazconfig.io', 'azconfig.io')).toBe(true);        // old form matched
    expect(appConfigSuffixFromEndpoint('https://evilazconfig.io')).toBe('azconfig.io'); // == fallback
    // The boundary itself is proven by the Gov case above, where the fallback
    // differs from the suffix under test.
  });

  it('legacyEndsWithMatch really is endsWith — the counter-factual is not weaker than the bug', () => {
    // If this ever diverges, the two assertions above stop modelling the pre-fix
    // behaviour and quietly become decorative.
    for (const [h, s] of [
      ['evilazconfig.io', 'azconfig.io'],
      ['notazconfig.azure.us', 'azconfig.azure.us'],
      ['store.azconfig.io', 'azconfig.io'],
      ['azconfig.io', 'azconfig.io'],
      ['io', 'azconfig.io'],
      ['unrelated.example', 'azconfig.io'],
    ] as const) {
      expect(legacyEndsWithMatch(h, s)).toBe(h.endsWith(s));
    }
  });
});
