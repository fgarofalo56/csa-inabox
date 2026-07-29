/**
 * trusted-egress — the destination of a credential-bearing server fetch must
 * come from configuration (issue #2652, CodeQL js/request-forgery).
 *
 * These are ADVERSARIAL cases, not happy-path echoes: every "reject" case is a
 * concrete way an attacker moves the host of an ARM/Graph call that carries the
 * Console's managed-identity token.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveSameOriginUrl,
  resolveConfiguredBase,
  parseBaseList,
  originOf,
  UntrustedEgressError,
} from '@/lib/azure/trusted-egress';

const ARM = 'https://management.azure.com';
const GOV_ARM = 'https://management.usgovcloudapi.net';

describe('resolveSameOriginUrl — keeps the capability the passthrough existed for', () => {
  it('joins a relative ARM path onto the configured base', () => {
    expect(resolveSameOriginUrl(ARM, '/subscriptions/abc/resourceGroups/rg?api-version=2024-05-01', 'arm'))
      .toBe('https://management.azure.com/subscriptions/abc/resourceGroups/rg?api-version=2024-05-01');
  });

  it('passes an absolute SAME-ORIGIN nextLink through verbatim (ARM paging)', () => {
    const next = `${ARM}/subscriptions/abc/resources?api-version=2024-05-01&$skiptoken=OPAQUE`;
    expect(resolveSameOriginUrl(ARM, next, 'arm')).toBe(next);
  });

  it('honours the sovereign base — a Gov nextLink resolves against the Gov base', () => {
    const next = `${GOV_ARM}/subscriptions/abc/resources?$skiptoken=X`;
    expect(resolveSameOriginUrl(GOV_ARM, next, 'arm')).toBe(next);
  });
});

describe('resolveSameOriginUrl — refuses every way to move the host', () => {
  const cases: Array<[string, string]> = [
    ['a plain off-origin absolute URL', 'https://attacker.example/subscriptions/abc'],
    ['userinfo smuggling', 'https://management.azure.com@attacker.example/subscriptions/abc'],
    ['a scheme-only prefix', 'https:/attacker.example/x'],
    ['an http downgrade of the ARM host', 'http://management.azure.com/subscriptions/abc'],
    ['a look-alike host', 'https://management.azure.com.attacker.example/subscriptions/abc'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['the instance metadata service', 'http://169.254.169.254/metadata/identity/oauth2/token'],
    ['a cross-cloud host (Gov nextLink against the Commercial base)', `${GOV_ARM}/subscriptions/abc`],
  ];
  for (const [label, attempt] of cases) {
    it(`rejects ${label}`, () => {
      expect(() => resolveSameOriginUrl(ARM, attempt, 'arm')).toThrow(UntrustedEgressError);
    });
  }

  it('names the attempted destination and the required origin in the error', () => {
    try {
      resolveSameOriginUrl(ARM, 'https://attacker.example/x', 'monitor ARM');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UntrustedEgressError);
      expect((e as UntrustedEgressError).attempted).toBe('https://attacker.example/x');
      expect((e as UntrustedEgressError).expected).toContain('management.azure.com');
      expect((e as Error).message).toContain('monitor ARM');
    }
  });

  it('fails closed when the configured base itself is not a usable https origin', () => {
    expect(() => resolveSameOriginUrl('', '/subscriptions/abc', 'arm')).toThrow(UntrustedEgressError);
    expect(() => resolveSameOriginUrl('not-a-url', '/subscriptions/abc', 'arm')).toThrow(UntrustedEgressError);
  });

  it('a protocol-relative path stays on the configured host (never becomes a new authority)', () => {
    // `${ARM}` + `//evil` is a PATH on management.azure.com, so it is allowed —
    // and this asserts it did not become https://evil/.
    const url = resolveSameOriginUrl(ARM, '//attacker.example/x', 'arm');
    expect(originOf(url)).toBe('https://management.azure.com');
  });
});

describe('resolveConfiguredBase — a request may SELECT a destination, never supply one', () => {
  const allowed = ['https://loom-udf.internal.azurecontainerapps.io', 'https://my-fn.azurewebsites.net'];
  const gate = { missing: 'LOOM_UDF_ALLOWED_FUNCTION_BASES', detail: 'not configured' };

  it('uses the first configured base when nothing is requested', () => {
    const r = resolveConfiguredBase('', allowed, gate);
    expect(r).toEqual({ base: 'https://loom-udf.internal.azurecontainerapps.io' });
  });

  it('accepts a requested base that IS configured', () => {
    const r = resolveConfiguredBase('https://my-fn.azurewebsites.net/', allowed, gate);
    expect(r).toEqual({ base: 'https://my-fn.azurewebsites.net' });
  });

  it('returns the CONFIG string, not the caller bytes, on a case-differing host', () => {
    const r = resolveConfiguredBase('https://MY-FN.azurewebsites.NET', allowed, gate);
    // Proves the fetched value is reconstructed from config.
    expect(r).toEqual({ base: 'https://my-fn.azurewebsites.net' });
  });

  it('gates an unconfigured host and names the env var to extend', () => {
    const r = resolveConfiguredBase('https://attacker.example', allowed, gate);
    expect('gate' in r).toBe(true);
    if ('gate' in r) {
      expect(r.gate.missing).toBe('LOOM_UDF_ALLOWED_FUNCTION_BASES');
      expect(r.gate.detail).toContain('attacker.example');
    }
  });

  it('gates a configured host reached over http, with userinfo, or as a subdomain', () => {
    for (const bad of [
      'http://my-fn.azurewebsites.net',
      'https://my-fn.azurewebsites.net@attacker.example',
      'https://my-fn.azurewebsites.net.attacker.example',
      'https://attacker.example/?x=https://my-fn.azurewebsites.net',
    ]) {
      expect('gate' in resolveConfiguredBase(bad, allowed, gate)).toBe(true);
    }
  });

  it('gates when nothing is configured at all', () => {
    expect('gate' in resolveConfiguredBase('', [], gate)).toBe(true);
    expect('gate' in resolveConfiguredBase('https://anything.example', [], gate)).toBe(true);
  });

  it('ignores non-URL junk in the configured list rather than trusting it', () => {
    const r = resolveConfiguredBase('nonsense', ['nonsense', 'https://ok.example'], gate);
    expect('gate' in r).toBe(true);
  });
});

describe('parseBaseList', () => {
  it('splits on commas and whitespace and drops empties', () => {
    expect(parseBaseList(' https://a.example, https://b.example ,, ')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(parseBaseList(undefined)).toEqual([]);
  });
});
