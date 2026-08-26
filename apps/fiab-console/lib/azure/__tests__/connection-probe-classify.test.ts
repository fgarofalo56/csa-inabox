/**
 * connection-probe — the two failure classifiers, tested directly.
 *
 * ## Why this file exists
 *
 * `probeConnection`'s hints were ALREADY conditional, which is the correct
 * shape — but `classifyReachError` matched a refusal with a bare `/403/`. That
 * is the same unanchored-numeric defect `scripts/ci/_az-failure-class.mjs`
 * shipped as `\b503\b` and had to fix: it fires inside a resource NAME. A
 * customer with a storage account called `st403data` would be told a DNS
 * failure was a missing role assignment — an R7 violation reached by precision
 * rather than by a hard-coded string.
 *
 * The classifiers are pure, but nothing exercised them: they were module-private
 * and only reachable through a live driver, so the "no branch matched ⇒ no
 * advice" property could be deleted with the whole suite green.
 *
 * The heavy clients are mocked because importing the module pulls @azure/identity
 * transitively; none of them is CALLED here — these tests are on the pure
 * classification, not on the probe round-trip.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../sql-objects-client', () => ({ listTablesWithAuth: vi.fn() }));
vi.mock('../kusto-client', () => ({
  executeQuery: vi.fn(), defaultDatabase: () => 'db', normalizeClusterUri: (u: string) => u,
}));
vi.mock('../adls-client', () => ({ getServiceClientFor: vi.fn() }));
vi.mock('../fetch-with-timeout', () => ({ fetchWithTimeout: vi.fn() }));

import { classifyReachError, classifySqlError } from '../connection-probe';

const noRedact = (m: string) => m;

describe('classifyReachError — a refusal is an ANCHORED status token', () => {
  it('attaches the role-grant hint on a real refusal', () => {
    for (const msg of [
      'PUT failed 403: AuthorizationPermissionMismatch',
      'the request was Forbidden',
      'ERROR (401) Unauthorized',
      'caller is not authorized to perform this action',
    ]) {
      const r = classifyReachError(new Error(msg), noRedact, 'storage account');
      expect(r.hint, `for ${JSON.stringify(msg)}`).toMatch(/not authorized/);
    }
  });

  it('does NOT read a status out of a resource NAME (the rg-loom-503 defect)', () => {
    // Before the anchor, every one of these produced "grant it the appropriate
    // data-plane role" for a failure that established nothing of the sort.
    const cases: Array<[string, RegExp | null]> = [
      ['getaddrinfo ENOTFOUND st403data.dfs.core.windows.net', /could not be resolved/],
      ['getaddrinfo ENOTFOUND kv-401-prod.vault.azure.net', /could not be resolved/],
      ['connection to eh-403hub timed out', /did not respond/],
      ['account st4031 returned an unexpected condition', null],
    ];
    for (const [msg, expected] of cases) {
      const r = classifyReachError(new Error(msg), noRedact, 'storage account');
      if (expected === null) {
        // Nothing matched ⇒ NO advice. This is the R7 property.
        expect(r.hint, `for ${JSON.stringify(msg)}`).toBeUndefined();
      } else {
        expect(r.hint, `for ${JSON.stringify(msg)}`).toMatch(expected);
        expect(r.hint).not.toMatch(/not authorized/);
      }
    }
  });

  it('attaches NO hint when nothing classified the failure', () => {
    const r = classifyReachError(new Error('an unexpected condition occurred'), noRedact, 'Key Vault');
    expect(r.hint).toBeUndefined();
    // …and still surfaces the backend's own words.
    expect(r.error).toContain('an unexpected condition occurred');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
  });

  it('redacts a supplied secret out of the surfaced error', () => {
    const redact = (m: string) => m.split('s3cr3t-placeholder').join('***');
    const r = classifyReachError(new Error('login failed for s3cr3t-placeholder'), redact, 'Key Vault');
    expect(r.error).not.toContain('s3cr3t-placeholder');
    expect(r.error).toContain('***');
  });
});

describe('classifySqlError', () => {
  it('names the credential for an auth failure and the firewall for a transport one', () => {
    expect(classifySqlError(new Error('Login failed for user'), noRedact).hint)
      .toMatch(/Verify the username, password/);
    expect(classifySqlError(new Error('getaddrinfo ENOTFOUND sql-x'), noRedact).hint)
      .toMatch(/firewall/);
  });

  it('attaches NO hint to an unrecognised driver failure', () => {
    const r = classifySqlError(new Error('driver reported an unexpected condition'), noRedact);
    expect(r.hint).toBeUndefined();
    expect(r.error).toContain('unexpected condition');
  });
});
