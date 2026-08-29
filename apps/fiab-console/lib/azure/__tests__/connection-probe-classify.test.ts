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

  it('#4049 F4 — each anchor HALF is independently discriminated in THIS suite', () => {
    // `status-token.ts` claims each anchor half has a fixture the other half
    // alone would not block. That was true in `status-token.test.ts` and NOT
    // here: every numeric fixture in this suite (`st403data`, `kv-401-prod`,
    // `eh-403hub`, `st4031`) is blocked by BOTH anchors, so neither half was
    // discriminated. Measured — dropping either half left this suite at RC=0,
    // and MX13 (re-inlining a lookahead-only anchor in `connection-probe.ts`)
    // ESCAPED.
    //
    // Two shapes, each blocked by exactly ONE half. Both must produce NO
    // role-grant hint; drop the lookbehind and the first starts producing one,
    // drop the lookahead and the second does.
    //
    // NOTE the wording is deliberately transport-free: after #4048 F5 the
    // transport branches run first, so a message containing `getaddrinfo` would
    // be classified before REACH_DENIED is ever consulted and the anchor would
    // not be exercised at all. These reach REACH_DENIED.
    const trailing = classifyReachError(
      new Error('PUT to container loom403 returned an unexpected condition'),
      noRedact, 'storage account',
    );
    expect(trailing.hint, 'TRAILING token — only the LOOKBEHIND blocks this').toBeUndefined();

    const leading = classifyReachError(
      new Error('PUT to container 403abc returned an unexpected condition'),
      noRedact, 'storage account',
    );
    expect(leading.hint, 'LEADING token — only the LOOKAHEAD blocks this').toBeUndefined();
  });

  it('CONTROL: a REAL standalone status in the same sentence shape IS a refusal', () => {
    // Without this, the two `toBeUndefined()`s above are equally satisfied by a
    // classifier that stopped recognising numeric refusals at all.
    const r = classifyReachError(
      new Error('PUT to container loom failed 403: an unexpected condition'),
      noRedact, 'storage account',
    );
    expect(r.hint).toMatch(/not authorized/);
  });

  it('#4048 F5 — a transport failure on a host whose NAME contains an authz WORD', () => {
    // THE SAME R7 DEFECT, ONE DATATYPE OVER. The numeric half of REACH_DENIED was
    // anchored by `statusToken`; `forbidden` / `authorization` / `not authorized`
    // were left as BARE SUBSTRINGS, and REACH_DENIED was tested FIRST. Every one
    // of these produced "not authorized. Grant it the appropriate data-plane
    // role" for a DNS or connect failure that established nothing of the sort —
    // measured, then fixed by asking the transport branches first.
    //
    // These are exactly the five probes from #4048, kept as fixtures so the
    // ordering cannot silently revert.
    const cases: Array<[string, RegExp]> = [
      ['getaddrinfo ENOTFOUND authorization-api.contoso.com', /could not be resolved/],
      ['getaddrinfo ENOTFOUND kv-authorization-prod.vault.azure.net', /could not be resolved/],
      ['getaddrinfo ENOTFOUND stforbidden.dfs.core.windows.net', /could not be resolved/],
      ['connect ECONNREFUSED loom-forbidden-eh.servicebus.windows.net:443', /did not respond/],
      ['getaddrinfo ENOTFOUND stloom403.dfs.core.windows.net', /could not be resolved/],
    ];
    for (const [msg, expected] of cases) {
      const r = classifyReachError(new Error(msg), noRedact, 'storage account');
      expect(r.hint, `for ${JSON.stringify(msg)}`).toMatch(expected);
      expect(r.hint, `for ${JSON.stringify(msg)}`).not.toMatch(/not authorized/);
      expect(r.hint, `for ${JSON.stringify(msg)}`).not.toMatch(/data-plane role/);
    }
  });

  it('CONTROL: a REAL refusal that also mentions a host still gets the role hint', () => {
    // Without this, the reorder above is equally satisfied by a classifier that
    // stopped producing the authorization hint at all — which would be a
    // different R7 failure, not a fix. No transport token here, so REACH_DENIED
    // is reached and must fire.
    const r = classifyReachError(
      new Error('PUT https://stforbidden.dfs.core.windows.net/loom failed 403: AuthorizationPermissionMismatch'),
      noRedact,
      'storage account',
    );
    expect(r.hint).toMatch(/not authorized/);
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
