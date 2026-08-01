/**
 * host-match — the boundary rules that replaced substring URL validation.
 *
 * Every case below is a string some previous call site ACCEPTED. They are kept
 * as tests rather than as a comment because the failure mode of this class is
 * silent: a substring check reads correctly, passes review, and admits a host
 * the author never intended.
 */
import { describe, it, expect } from 'vitest';
import { hostOfUrl, hostHasSuffix, hostHasAnySuffix, urlHostHasSuffix } from '../host-match';

describe('hostOfUrl', () => {
  it('extracts and lowercases the hostname', () => {
    expect(hostOfUrl('https://Store.AZCONFIG.io/kv?x=1')).toBe('store.azconfig.io');
  });

  it('strips the root-label trailing dot', () => {
    // `contoso.com.` and `contoso.com` are the same host to DNS but not to
    // `===`, so a trailing dot would walk straight past an allowlist.
    expect(hostOfUrl('https://contoso.com./x')).toBe('contoso.com');
  });

  it('ignores userinfo (the host is what follows @)', () => {
    expect(hostOfUrl('https://learn.microsoft.com@evil.test/x')).toBe('evil.test');
  });

  it('returns null for non-URLs and empties', () => {
    expect(hostOfUrl('not a url')).toBeNull();
    expect(hostOfUrl('')).toBeNull();
    expect(hostOfUrl(null)).toBeNull();
    expect(hostOfUrl(undefined)).toBeNull();
  });
});

describe('hostHasSuffix — the DNS label boundary', () => {
  it('matches the apex and real subdomains', () => {
    expect(hostHasSuffix('azconfig.io', 'azconfig.io')).toBe(true);
    expect(hostHasSuffix('store.azconfig.io', 'azconfig.io')).toBe(true);
    expect(hostHasSuffix('a.b.c.azconfig.io', 'azconfig.io')).toBe(true);
  });

  it('REJECTS a different registrable domain that merely ends with the text', () => {
    // The CodeQL #540 case: `host.endsWith('azconfig.io')` accepts this.
    expect(hostHasSuffix('evilazconfig.io', 'azconfig.io')).toBe(false);
    expect(hostHasSuffix('notlearn.microsoft.com', 'learn.microsoft.com')).toBe(false);
  });

  it('REJECTS a host with the suffix appended on the right', () => {
    expect(hostHasSuffix('learn.microsoft.com.evil.test', 'learn.microsoft.com')).toBe(false);
  });

  it('accepts a suffix written with or without a leading dot', () => {
    // Both spellings are already in use across the codebase; a silent mismatch
    // here would fail OPEN.
    expect(hostHasSuffix('app.azurecontainerapps.io', '.azurecontainerapps.io')).toBe(true);
    expect(hostHasSuffix('app.azurecontainerapps.io', 'azurecontainerapps.io')).toBe(true);
  });

  it('is case- and trailing-dot-insensitive on both sides', () => {
    expect(hostHasSuffix('STORE.AzConfig.IO.', 'azconfig.io')).toBe(true);
  });

  it('rejects empty inputs rather than matching everything', () => {
    expect(hostHasSuffix('', 'azconfig.io')).toBe(false);
    expect(hostHasSuffix('store.azconfig.io', '')).toBe(false);
    expect(hostHasSuffix('store.azconfig.io', '.')).toBe(false);
    expect(hostHasSuffix(null, 'azconfig.io')).toBe(false);
  });
});

describe('hostHasAnySuffix', () => {
  it('is an allowlist, not a denylist', () => {
    const allow = ['.azurecontainerapps.io', '.azurecontainerapps.us'];
    expect(hostHasAnySuffix('a.azurecontainerapps.us', allow)).toBe(true);
    expect(hostHasAnySuffix('evil.test', allow)).toBe(false);
    expect(hostHasAnySuffix('a.azurecontainerapps.io.evil.test', allow)).toBe(false);
  });

  it('an empty allowlist matches nothing', () => {
    expect(hostHasAnySuffix('anything.test', [])).toBe(false);
  });
});

describe('urlHostHasSuffix — what the four broken call sites needed', () => {
  it('rejects the suffix hiding in the query string', () => {
    // `endpoint.includes('openai.azure.us')` accepted this.
    expect(urlHostHasSuffix('https://evil.test/?x=openai.azure.us', 'openai.azure.us')).toBe(false);
  });

  it('rejects the suffix hiding in the path', () => {
    expect(urlHostHasSuffix('https://evil.test/.usgovcloudapi.net/x', 'usgovcloudapi.net')).toBe(false);
  });

  it('rejects the suffix hiding in the fragment', () => {
    expect(urlHostHasSuffix('https://evil.test/#openai.azure.com', 'openai.azure.com')).toBe(false);
  });

  it('rejects the suffix hiding in userinfo', () => {
    expect(urlHostHasSuffix('https://openai.azure.us@evil.test/', 'openai.azure.us')).toBe(false);
  });

  it('still accepts the real thing', () => {
    expect(urlHostHasSuffix('https://myaoai.openai.azure.us/', 'openai.azure.us')).toBe(true);
    expect(urlHostHasSuffix('https://kv.vault.usgovcloudapi.net/secrets/x', 'usgovcloudapi.net')).toBe(true);
  });

  it('fails CLOSED on an unparseable URL', () => {
    // A string that is not a URL cannot be shown to be inside the boundary,
    // so it must be treated as outside it.
    expect(urlHostHasSuffix('openai.azure.us', 'openai.azure.us')).toBe(false);
    expect(urlHostHasSuffix('', 'openai.azure.us')).toBe(false);
  });
});
