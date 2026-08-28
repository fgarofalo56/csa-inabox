/**
 * LOOM BRAIN W10 — WHICH IDENTITY DID THIS RUN AUTHENTICATE AS? (#3936,
 * review of #4014 B1)
 *
 * ── THE BUG THIS SUITE IS THE COUNTERFACTUAL FOR ───────────────────────────
 * The scan was going to authenticate as the deploy SERVICE PRINCIPAL on every
 * run, in both boundaries, and nothing anywhere would have said so. The workflow
 * set `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID` at JOB level;
 * `DefaultAzureCredential` evaluates `EnvironmentCredential` FIRST; nothing in
 * this repo sets `AZURE_TOKEN_CREDENTIALS`. So the managed-identity leg that
 * `managedIdentityClientId` parameterised was never reached, the SP holds no
 * Cosmos data-plane role, and `recordRun` fires on OK, PAUSED and UNREACHABLE
 * alike — the lane could not complete a single run in any verdict.
 *
 * Removing the env vars fixes today. The assertion below is what stops the class
 * returning through a different door: a re-added env var, a runner without the
 * UAMI attached, a chain reorder in a future SDK. Every one of those now fails
 * LOUDLY with the principal it actually got.
 *
 * ── THE TOKENS HERE ARE SYNTHETIC AND UNSIGNED ─────────────────────────────
 * Nothing in this lane verifies a signature — the token comes from the SDK, not
 * from a caller, and pretending otherwise would be theatre. So a fixture token
 * is a base64url header/payload/signature triple assembled here, and every GUID
 * in it is an obviously-fake placeholder (`../__tests__/no-real-ids.test.ts`
 * scans this directory and would fail on anything else).
 */

import { describe, expect, it, vi } from 'vitest';
import type { AccessToken, TokenCredential } from '@azure/identity';
import {
  assertTokenIdentity,
  decodeTokenIdentity,
  maskPrincipal,
} from '../token-identity';
import { IdentityAssertingCredential, ScanIdentityError } from '../azure/scan-credential';
import { ArmEstateProbe, type FetchLike } from '../azure/arm-probe';

/** The console UAMI, and the deploy SP. Both synthetic placeholders. */
const UAMI = ['11111111', '1111', '1111', '1111', '111111111111'].join('-');
const SP = ['00000000', '0000', '0000', '0000', '000000000000'].join('-');

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/** A syntactically real, cryptographically meaningless JWT. */
function jwt(claims: Record<string, unknown>): string {
  return [b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })), b64url(JSON.stringify(claims)), 'sig'].join('.');
}

const uamiToken = jwt({ appid: UAMI, oid: UAMI, tid: UAMI });
const spToken = jwt({ appid: SP, oid: SP, tid: UAMI });

describe('decodeTokenIdentity', () => {
  it('reads appid / oid / tid from a v1.0 token — the shape ARM and Cosmos issue', () => {
    expect(decodeTokenIdentity(uamiToken)).toEqual({
      appId: UAMI,
      objectId: UAMI,
      tenantId: UAMI,
    });
  });

  it('falls back to `azp` for a v2.0 token', () => {
    const t = jwt({ azp: UAMI, oid: UAMI, tid: UAMI });
    expect(decodeTokenIdentity(t)?.appId).toBe(UAMI);
  });

  it('prefers `appid` when both are present', () => {
    const t = jwt({ appid: UAMI, azp: SP, oid: UAMI, tid: UAMI });
    expect(decodeTokenIdentity(t)?.appId).toBe(UAMI);
  });

  it.each([
    ['not a jwt at all', 'opaque-token'],
    ['two segments', 'a.b'],
    ['four segments', 'a.b.c.d'],
    ['an unparseable payload', ['aGVhZGVy', 'not-base64-json!!', 'sig'].join('.')],
    ['a payload that is JSON but not an object', [b64url('{}'), b64url('[1,2]'), 'sig'].join('.')],
    ['an empty payload segment', 'a..c'],
  ])('returns null, never a guess, for %s', (_label, token) => {
    // R7: "if the code does not know, the message says it does not know". This
    // returns null rather than inventing an identity; the CALLER decides what an
    // unreadable token means, and it decides FAIL.
    expect(decodeTokenIdentity(token)).toBeNull();
  });

  it('reports a missing claim as null rather than empty string', () => {
    expect(decodeTokenIdentity(jwt({ tid: UAMI }))).toEqual({
      appId: null,
      objectId: null,
      tenantId: UAMI,
    });
  });

  it('treats a whitespace-only claim as absent', () => {
    expect(decodeTokenIdentity(jwt({ appid: '   ', oid: UAMI }))?.appId).toBeNull();
  });
});

describe('maskPrincipal — this repo is public and a workflow log publishes', () => {
  it('prints a distinguishing prefix, never the value', () => {
    const masked = maskPrincipal(UAMI);
    expect(masked).not.toBe(UAMI);
    expect(masked.length).toBeLessThan(UAMI.length);
    expect(UAMI.startsWith(masked.replace('…', ''))).toBe(true);
  });

  it('still tells two DIFFERENT principals apart — the whole question', () => {
    expect(maskPrincipal(UAMI)).not.toBe(maskPrincipal(SP));
  });

  it('says <none> rather than printing nothing', () => {
    expect(maskPrincipal(null)).toBe('<none>');
    expect(maskPrincipal('  ')).toBe('<none>');
  });
});

describe('assertTokenIdentity — THE B1 COUNTERFACTUAL', () => {
  it('FAILS when the token is the service principal but the UAMI was declared', () => {
    // This is B1, exactly. Before this assertion existed the run continued here
    // and 403-ed three steps later inside Cosmos, with a message about Cosmos.
    const v = assertTokenIdentity({
      token: spToken,
      expectedClientId: UAMI,
      cloud: 'AzureCloud',
    });
    expect(v.ok).toBe(false);
    expect(v.message).toContain('THE WRONG PRINCIPAL');
  });

  it('the failure NAMES the chain-order mechanism, not just "wrong identity"', () => {
    // deploy-integrity R6: a specific, actionable remediation. Whoever reads
    // this at 04:11 UTC needs to be told that EnvironmentCredential outranks
    // ManagedIdentityCredential, because nothing about the symptom suggests it.
    const v = assertTokenIdentity({ token: spToken, expectedClientId: UAMI, cloud: 'AzureCloud' });
    expect(v.message).toContain('EnvironmentCredential');
    expect(v.message).toContain('AZURE_CLIENT_ID');
    expect(v.message).toContain('loom-brain-scan.yml');
  });

  it('the failure carries the exact grant command for a runner with no managed identity', () => {
    // The Gov half of B1: `ubuntu-latest` has NO managed identity at all, so the
    // chain CANNOT reach the UAMI there whatever its order. The remediation for
    // that boundary is a role assignment, and this hands over the command rather
    // than the role's name.
    const v = assertTokenIdentity({
      token: spToken,
      expectedClientId: UAMI,
      cloud: 'AzureUSGovernment',
    });
    expect(v.message).toContain('az cosmosdb sql role assignment create');
    expect(v.message).toContain('00000000-0000-0000-0000-000000000002');
  });

  it('the failure states that NOTHING was persisted', () => {
    const v = assertTokenIdentity({ token: spToken, expectedClientId: UAMI, cloud: 'AzureCloud' });
    expect(v.message).toContain('NOTHING has been persisted');
  });

  it('never prints either principal in full — masked on the failure path too', () => {
    const v = assertTokenIdentity({ token: spToken, expectedClientId: UAMI, cloud: 'AzureCloud' });
    expect(v.message).not.toContain(UAMI);
    expect(v.message).not.toContain(SP);
  });

  it('PASSES when the token really is the declared identity', () => {
    const v = assertTokenIdentity({ token: uamiToken, expectedClientId: UAMI, cloud: 'AzureCloud' });
    expect(v.ok).toBe(true);
    expect(v.message).toContain('authenticated as the declared identity');
  });

  it('compares case-insensitively — a GUID is a GUID', () => {
    const v = assertTokenIdentity({
      token: jwt({ appid: UAMI.toUpperCase(), oid: UAMI, tid: UAMI }),
      expectedClientId: UAMI,
      cloud: 'AzureCloud',
    });
    expect(v.ok).toBe(true);
  });

  it('FAILS on an UNREADABLE token when an identity was declared', () => {
    // A check that waves through what it could not parse is a check that can be
    // defeated by making it unparseable.
    const v = assertTokenIdentity({
      token: 'opaque',
      expectedClientId: UAMI,
      cloud: 'AzureCloud',
    });
    expect(v.ok).toBe(false);
    expect(v.message).toContain('could NOT be decoded');
  });

  it('FAILS when the token carries NO appid at all', () => {
    const v = assertTokenIdentity({
      token: jwt({ oid: SP, tid: UAMI }),
      expectedClientId: UAMI,
      cloud: 'AzureCloud',
    });
    expect(v.ok).toBe(false);
  });

  it('with NO declared identity it REPORTS rather than passing silently', () => {
    // There is nothing to assert against, but "who ran this?" must still have an
    // answer in the log — that question having no answer anywhere IS the finding.
    const v = assertTokenIdentity({ token: spToken, expectedClientId: '', cloud: 'AzureCloud' });
    expect(v.ok).toBe(true);
    expect(v.message).toContain('declared NO expected identity');
    expect(v.message).toContain(maskPrincipal(SP));
    expect(v.message).toContain('disableLocalAuth');
  });

  it('treats a whitespace-only expectation as no expectation, not as a match', () => {
    const v = assertTokenIdentity({ token: spToken, expectedClientId: '   ', cloud: 'AzureCloud' });
    expect(v.message).toContain('declared NO expected identity');
  });
});

describe('IdentityAssertingCredential — the wiring, not just the decision', () => {
  function inner(tokens: (AccessToken | null)[]): TokenCredential {
    let i = 0;
    return {
      async getToken() {
        const t = tokens[Math.min(i, tokens.length - 1)];
        i += 1;
        return t;
      },
    };
  }

  const ok = (token: string): AccessToken => ({ token, expiresOnTimestamp: 0 });

  it('hands back the token when the identity is the declared one', async () => {
    const c = new IdentityAssertingCredential(inner([ok(uamiToken)]), {
      expectedClientId: UAMI,
      cloud: 'AzureCloud',
    });
    expect((await c.getToken('https://management.azure.com/.default'))?.token).toBe(uamiToken);
  });

  it('THROWS ScanIdentityError when the wrong principal minted it', async () => {
    const c = new IdentityAssertingCredential(inner([ok(spToken)]), {
      expectedClientId: UAMI,
      cloud: 'AzureCloud',
    });
    await expect(c.getToken('https://management.azure.com/.default')).rejects.toThrow(
      ScanIdentityError,
    );
  });

  it('reports the identity EXACTLY ONCE across many getToken calls', async () => {
    // A run mints an ARM token, a Cosmos token, and more on refresh. Reporting
    // every time would put the same line in the log dozens of times.
    const onIdentity = vi.fn();
    const c = new IdentityAssertingCredential(inner([ok(uamiToken)]), {
      expectedClientId: UAMI,
      cloud: 'AzureCloud',
      onIdentity,
    });
    await c.getToken('a');
    await c.getToken('b');
    await c.getToken('c');
    expect(onIdentity).toHaveBeenCalledTimes(1);
    expect(onIdentity.mock.calls[0][0].ok).toBe(true);
  });

  it('CHECKS every token, not only the first — a refresh that changes principal fails', async () => {
    // The narrow evasion: mint one good token to satisfy the check, then hand
    // back the SP on refresh. Reporting once must not mean checking once.
    const c = new IdentityAssertingCredential(inner([ok(uamiToken), ok(spToken)]), {
      expectedClientId: UAMI,
      cloud: 'AzureCloud',
    });
    await expect(c.getToken('a')).resolves.not.toBeNull();
    await expect(c.getToken('b')).rejects.toThrow(ScanIdentityError);
  });

  it('reports the identity BEFORE it throws, so the log carries the reason', async () => {
    const onIdentity = vi.fn();
    const c = new IdentityAssertingCredential(inner([ok(spToken)]), {
      expectedClientId: UAMI,
      cloud: 'AzureCloud',
      onIdentity,
    });
    await expect(c.getToken('a')).rejects.toThrow(ScanIdentityError);
    expect(onIdentity).toHaveBeenCalledTimes(1);
    expect(onIdentity.mock.calls[0][0].ok).toBe(false);
  });

  it('passes a NULL token straight through — that is an auth failure, not an identity one', async () => {
    // `ports.ts` requires a reachability failure to be DATA the classifier can
    // name. Turning "no token at all" into an identity error would replace a
    // true reason with a wrong one.
    const c = new IdentityAssertingCredential(inner([null]), {
      expectedClientId: UAMI,
      cloud: 'AzureCloud',
    });
    await expect(c.getToken('a')).resolves.toBeNull();
  });

  it('the thrown error carries the verdict, not just a string', async () => {
    const c = new IdentityAssertingCredential(inner([ok(spToken)]), {
      expectedClientId: UAMI,
      cloud: 'AzureCloud',
    });
    await c.getToken('a').then(
      () => expect.unreachable('should have thrown'),
      (e: unknown) => {
        expect(e).toBeInstanceOf(ScanIdentityError);
        expect((e as ScanIdentityError).verdict.identity?.appId).toBe(SP);
      },
    );
  });
});

describe('R7 — an identity refusal must NOT be laundered into a reachability failure', () => {
  /**
   * MEASURED by running the compiled CLI against a real Azure token, not
   * reasoned about: `ArmEstateProbe` wraps ANY throw from `getToken` in
   * `networkFailure(...)`, so the first version of this fix produced
   *
   *     VERDICT: UNREACHABLE (network-failed)
   *     "could not reach Azure (Commercial) to scan estate …"
   *
   * for a run that had reached Azure perfectly well, minted a token, and REFUSED
   * IT because it belonged to the wrong principal. That is the exact conflation
   * `model.ts`'s header forbids — "could not reach" and "I reached it and X" are
   * different claims — and it would send an engineer to check DNS and firewalls
   * for what is an env-var placement in a workflow file.
   *
   * `ports.ts` draws the line: a probe MUST NOT throw for a REACHABILITY
   * failure, and "an unexpected defect may still throw, and should".
   */
  it('the probe RE-RAISES ScanIdentityError instead of classifying it', async () => {
    const probe = new ArmEstateProbe({
      armBase: 'https://management.azure.com',
      armScope: 'https://management.azure.com/.default',
      getToken: async () => {
        throw new ScanIdentityError({
          ok: false,
          identity: { appId: SP, objectId: SP, tenantId: UAMI },
          message: 'identity: THE WRONG PRINCIPAL.',
        });
      },
      fetchImpl: (async () => {
        throw new Error('fetch must never be reached — the identity failed first');
      }) as unknown as FetchLike,
      resourceGroups: ['rg-example'],
    });
    await expect(probe.probe()).rejects.toThrow(ScanIdentityError);
  });

  it('CONTROL: an ordinary token error is STILL classified, not thrown', async () => {
    // The re-raise must be keyed to the identity class specifically. If it were
    // broadened to "any throw", a genuine transport failure would stop being the
    // DATA that `ports.ts` requires the classifier to be able to name.
    const probe = new ArmEstateProbe({
      armBase: 'https://management.azure.com',
      armScope: 'https://management.azure.com/.default',
      getToken: async () => {
        throw new Error('getaddrinfo ENOTFOUND login.microsoftonline.com');
      },
      fetchImpl: (async () => {
        throw new Error('fetch must never be reached');
      }) as unknown as FetchLike,
      resourceGroups: ['rg-example'],
    });
    const result = await probe.probe();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].classification).toBe('network');
    expect(result.failures[0].target).toBe('token acquisition');
  });
});
