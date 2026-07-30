/**
 * #2652 (js/request-forgery, alert #558) — the ARM token must never leave ARM.
 *
 * `armReq` resolved its target as:
 *
 *     const url = path.startsWith('http') ? path : `${ARM}${path}`;
 *
 * and fetches it with `authorization: Bearer <ARM access token>`. The
 * absolute-URL branch is needed for ARM pagination (`nextLink`), but it accepted
 * ANY host — so anything able to influence `path` could exfiltrate the Console's
 * ARM token.
 *
 * These are ATTACK tests. The confusable-host cases are the point: each one
 * defeats a `startsWith` check, which is why the fix compares parsed origins.
 */
import { describe, it, expect } from 'vitest';
import { resolveArmUrl, NetworkingArmError } from '../networking-client';
import { assertGitHubOrigin } from '../git-integration-client';

const ARM = 'https://management.azure.com';

describe('resolveArmUrl — relative paths', () => {
  it('prefixes the ARM base', () => {
    expect(resolveArmUrl('/subscriptions/abc/resourceGroups?api-version=2024-01-01', ARM))
      .toBe(`${ARM}/subscriptions/abc/resourceGroups?api-version=2024-01-01`);
  });
});

describe('resolveArmUrl — absolute ARM URLs (pagination must keep working)', () => {
  it('permits a same-origin nextLink', () => {
    const next = `${ARM}/subscriptions/abc/providers/Microsoft.Network/virtualNetworks?$skipToken=X`;
    expect(resolveArmUrl(next, ARM)).toBe(new URL(next).toString());
  });

  it('permits a sovereign ARM endpoint when that is the configured base', () => {
    const gov = 'https://management.usgovcloudapi.net';
    const next = `${gov}/subscriptions/abc/x?$skipToken=Y`;
    expect(resolveArmUrl(next, gov)).toBe(new URL(next).toString());
  });
});

describe('resolveArmUrl — ATTACK cases', () => {
  it.each([
    ['https://evil.test/steal', 'a plainly foreign host'],
    // Both of the following PASS a `startsWith('https://management.azure.com')`
    // test and both actually resolve to evil.test. This is why the check is on
    // parsed origin, not on a string prefix.
    ['https://management.azure.com.evil.test/steal', 'suffix-confusable host'],
    ['https://management.azure.com@evil.test/steal', 'userinfo-confusable host'],
    ['http://management.azure.com/x', 'downgraded scheme (different origin)'],
    ['https://management.azure.com:8443/x', 'different port'],
    ['https://management.usgovcloudapi.net/x', 'a DIFFERENT cloud than configured'],
  ])('REFUSES %j (%s)', (candidate) => {
    expect(() => resolveArmUrl(candidate, ARM)).toThrow(NetworkingArmError);
  });

  it('the confusable hosts really do resolve elsewhere (the bug was real)', () => {
    expect(new URL('https://management.azure.com.evil.test/x').host).toBe('management.azure.com.evil.test');
    expect(new URL('https://management.azure.com@evil.test/x').host).toBe('evil.test');
    // ...and both would have satisfied the prefix test the fix replaced.
    expect('https://management.azure.com@evil.test/x'.startsWith('http')).toBe(true);
  });

  it('FAILS CLOSED on an unparseable absolute URL rather than treating it as a path', () => {
    // Falling through to `${ARM}${path}` here would build a nonsense ARM URL and
    // send the token to a wrong route instead of refusing.
    expect(() => resolveArmUrl('https://', ARM)).toThrow(NetworkingArmError);
  });

  it('does not echo the rejected origin back to the caller', () => {
    // The rejected value is attacker-chosen; reflecting it puts it in logs and in
    // the client response.
    const err = (() => {
      try { resolveArmUrl('https://evil.test/steal', ARM); return null; }
      catch (e) { return e as Error; }
    })();
    expect(err).toBeInstanceOf(NetworkingArmError);
    expect(err!.message).not.toContain('evil.test');
  });
});

// ---------------------------------------------------------------------------
// Same class, the GitHub PAT sink (alert #520). ghFetch attaches the user's
// long-lived PAT, so its url argument decides where that credential goes.
// ---------------------------------------------------------------------------

describe('assertGitHubOrigin — the PAT must not leave GitHub', () => {
  it('permits api.github.com and GitHub Enterprise Cloud', () => {
    expect(() => assertGitHubOrigin('https://api.github.com/repos/o/r')).not.toThrow();
    expect(() => assertGitHubOrigin('https://api.octocorp.ghe.com/repos/o/r')).not.toThrow();
  });

  it.each([
    ['https://evil.test/x', 'foreign host'],
    ['https://api.github.com.evil.test/x', 'suffix-confusable'],
    ['https://api.github.com@evil.test/x', 'userinfo-confusable'],
    ['http://api.github.com/x', 'plaintext downgrade'],
    ['https://api.github.com.ghe.com.evil.test/x', 'double-confusable'],
    ['https://raw.githubusercontent.com/x', 'a real GitHub host that is NOT the API'],
  ])('REFUSES %j (%s)', (candidate) => {
    expect(() => assertGitHubOrigin(candidate)).toThrow(/non-GitHub origin/);
  });

  it('FAILS CLOSED on an unparseable URL', () => {
    expect(() => assertGitHubOrigin('https://')).toThrow(/unparseable/);
  });

  it('does not echo the rejected origin', () => {
    const err = (() => {
      try { assertGitHubOrigin('https://evil.test/x'); return null; }
      catch (e) { return e as Error; }
    })();
    expect(err!.message).not.toContain('evil.test');
  });
});
