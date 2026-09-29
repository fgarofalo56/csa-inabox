/**
 * callerArmToken — resolves the CALLER's delegated ARM token (cache, then MSAL
 * silent refresh) and NEVER falls back to the platform identity.
 *
 * WHAT MAKES THESE FAIL (assertion-design.md):
 *   • cache hit → the cached token `CACHED-ARM-1` is returned; returning any
 *     other bearer (or refreshing needlessly) fails the exact-value assertion.
 *   • cache miss + refreshable → the MSAL-minted `REFRESHED-ARM-2` is returned
 *     and written back; a resolver that read the raw cache only (the round-2
 *     behaviour) returns null here and fails.
 *   • cache miss + NO refresh possible → `{ gate: true }`, AND the platform
 *     credential's `getToken` is never called and no fetch is made. A resolver
 *     that fell back to the platform identity would return a token (the
 *     `PLATFORM-TK` value) and trip all three assertions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const platformGetToken = vi.fn(async () => ({ token: 'PLATFORM-TK', expiresOnTimestamp: Date.now() + 3600_000 }));
vi.mock('@azure/identity', () => {
  class Cred { getToken = platformGetToken; }
  return { DefaultAzureCredential: Cred, ManagedIdentityCredential: Cred, ChainedTokenCredential: Cred };
});

const getUserArmToken = vi.fn(async (_oid: string) => null as string | null);
const saveUserToken = vi.fn(async () => true);
vi.mock('@/lib/azure/user-token-store', () => ({
  getUserArmToken: (oid: string) => getUserArmToken(oid),
  saveUserToken: (...a: any[]) => (saveUserToken as any)(...a),
}));

const accounts: any[] = [];
const acquireTokenSilent = vi.fn(async () => ({ accessToken: 'REFRESHED-ARM-2', expiresOn: new Date(Date.now() + 3600_000) }));
vi.mock('@/lib/auth/msal', () => ({
  getMsalClient: () => ({
    getTokenCache: () => ({ getAllAccounts: async () => accounts }),
    acquireTokenSilent: (...a: any[]) => (acquireTokenSilent as any)(...a),
  }),
}));

const fetchSpy = vi.fn();
beforeEach(() => {
  accounts.length = 0;
  getUserArmToken.mockReset().mockResolvedValue(null);
  saveUserToken.mockClear();
  acquireTokenSilent.mockClear();
  platformGetToken.mockClear();
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('callerArmToken', () => {
  it('returns the cached caller token without refreshing', async () => {
    getUserArmToken.mockResolvedValue('CACHED-ARM-1');
    const { callerArmToken } = await import('../caller-arm-token');
    expect(await callerArmToken('oid-1')).toEqual({ token: 'CACHED-ARM-1', gate: false });
    expect(acquireTokenSilent).not.toHaveBeenCalled();
  });

  it('silently refreshes an aged-out token via MSAL and writes it back', async () => {
    accounts.push({ homeAccountId: 'oid-1.tenant', localAccountId: 'oid-1' });
    const { callerArmToken } = await import('../caller-arm-token');
    expect(await callerArmToken('oid-1')).toEqual({ token: 'REFRESHED-ARM-2', gate: false });
    expect(saveUserToken).toHaveBeenCalledTimes(1);
  });

  it('gates — and NEVER uses the platform identity — when no caller token can be resolved', async () => {
    // No cache, and no MSAL account for this oid ⇒ refresh impossible.
    const { callerArmToken } = await import('../caller-arm-token');
    const r = await callerArmToken('oid-1');
    expect(r).toEqual({ gate: true });
    expect(platformGetToken).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('gates for a missing oid without any lookup', async () => {
    const { callerArmToken } = await import('../caller-arm-token');
    expect(await callerArmToken(undefined)).toEqual({ gate: true });
    expect(getUserArmToken).not.toHaveBeenCalled();
  });

  it('the gate body carries the registry code a client can branch on', async () => {
    const { userArmGateBody } = await import('../caller-arm-token');
    const b = userArmGateBody('wf');
    expect(b.code).toBe('NO_USER_ARM_TOKEN');
    expect(b.ok).toBe(false);
  });
});
