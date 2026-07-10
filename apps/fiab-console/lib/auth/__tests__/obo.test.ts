/**
 * Power BI user-passthrough (OBO) token service — behavioral unit tests.
 *
 * Mocks the MSAL confidential client (acquireTokenSilent) + the session so we can
 * assert, without a network, that:
 *   - a signed-in user with a cached account gets a delegated token (success),
 *   - AADSTS65001 / interaction_required map to `consent_required`,
 *   - no session OR no cached account maps to `no_user_token` (the SP-fallback signal),
 *   - the in-memory cache serves a hit and re-mints after expiry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock seams -------------------------------------------------------------
let sessionOid: string | null = 'user-oid-1';
const acquireTokenSilent = vi.fn();
const getAllAccounts = vi.fn(async () => [
  { homeAccountId: 'user-oid-1.tenant-1', localAccountId: 'user-oid-1', username: 'u@x' },
]);

vi.mock('@/lib/auth/session', () => ({
  getSession: () => (sessionOid ? { claims: { oid: sessionOid }, exp: Date.now() / 1000 + 3600 } : null),
}));

vi.mock('@/lib/auth/msal', () => ({
  getMsalClient: () => ({
    getTokenCache: () => ({ getAllAccounts }),
    acquireTokenSilent,
  }),
  // getUserPbiToken re-exports pbiOboScopes; keep a trivial impl for import safety.
  pbiOboScopes: () => ['https://analysis.windows.net/powerbi/api/.default'],
}));

const SCOPE = 'https://analysis.windows.net/powerbi/api/.default';

async function load() {
  const mod = await import('../obo');
  mod.__clearOboCacheForTests();
  return mod;
}

beforeEach(() => {
  sessionOid = 'user-oid-1';
  acquireTokenSilent.mockReset();
  getAllAccounts.mockClear();
  getAllAccounts.mockResolvedValue([
    { homeAccountId: 'user-oid-1.tenant-1', localAccountId: 'user-oid-1', username: 'u@x' },
  ]);
});

describe('getUserPbiToken', () => {
  it('mints a delegated user token for a signed-in user with a cached account', async () => {
    const { getUserPbiToken } = await load();
    acquireTokenSilent.mockResolvedValue({ accessToken: 'USER_TOKEN', expiresOn: new Date(Date.now() + 3600_000) });
    const res = await getUserPbiToken(SCOPE);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.token).toBe('USER_TOKEN');
    // Silent-acquire ran against the requested resource scope, as the user.
    expect(acquireTokenSilent).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: [SCOPE], account: expect.objectContaining({ localAccountId: 'user-oid-1' }) }),
    );
  });

  it('maps AADSTS65001 (no admin consent) to consent_required', async () => {
    const { getUserPbiToken } = await load();
    acquireTokenSilent.mockRejectedValue(Object.assign(new Error('AADSTS65001: consent required'), { errorCode: 'interaction_required' }));
    const res = await getUserPbiToken(SCOPE);
    expect(res).toEqual({ ok: false, error: 'consent_required' });
  });

  it('maps a generic silent-acquire failure to exchange_failed', async () => {
    const { getUserPbiToken } = await load();
    acquireTokenSilent.mockRejectedValue(new Error('network glitch'));
    const res = await getUserPbiToken(SCOPE);
    expect(res).toEqual({ ok: false, error: 'exchange_failed' });
  });

  it('returns no_user_token when there is no session (background job)', async () => {
    sessionOid = null;
    const { getUserPbiToken } = await load();
    const res = await getUserPbiToken(SCOPE);
    expect(res).toEqual({ ok: false, error: 'no_user_token' });
    expect(acquireTokenSilent).not.toHaveBeenCalled();
  });

  it('returns no_user_token when the account is not in the MSAL cache', async () => {
    const { getUserPbiToken } = await load();
    getAllAccounts.mockResolvedValue([]); // cold replica, nothing persisted
    const res = await getUserPbiToken(SCOPE);
    expect(res).toEqual({ ok: false, error: 'no_user_token' });
    expect(acquireTokenSilent).not.toHaveBeenCalled();
  });

  it('serves a cache hit without re-acquiring, and re-mints after expiry', async () => {
    const { getUserPbiToken } = await load();
    acquireTokenSilent.mockResolvedValue({ accessToken: 'T1', expiresOn: new Date(Date.now() + 3600_000) });
    const first = await getUserPbiToken(SCOPE);
    expect(first.ok).toBe(true);
    // Second call within TTL → cache hit, no second silent-acquire.
    const second = await getUserPbiToken(SCOPE);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.token).toBe('T1');
    expect(acquireTokenSilent).toHaveBeenCalledTimes(1);

    // A token already inside the 60s safety margin is treated as expired → re-mint.
    acquireTokenSilent.mockResolvedValue({ accessToken: 'T2', expiresOn: new Date(Date.now() + 7200_000) });
    (await load()); // clears the in-memory cache
    acquireTokenSilent.mockClear();
    acquireTokenSilent.mockResolvedValue({ accessToken: 'T3', expiresOn: new Date(Date.now() + 30_000) }); // 30s < margin
    const near = await getUserPbiToken(SCOPE);
    expect(near.ok).toBe(true);
    const again = await getUserPbiToken(SCOPE);
    expect(again.ok).toBe(true);
    // The ~30s token is inside the safety margin, so the second call re-acquires.
    expect(acquireTokenSilent).toHaveBeenCalledTimes(2);
  });
});

describe('userPassthroughEnabled + oboRemediation', () => {
  it('is default-ON and reverts only when explicitly set to false', async () => {
    const { userPassthroughEnabled } = await load();
    delete process.env.LOOM_POWERBI_USER_PASSTHROUGH;
    expect(userPassthroughEnabled()).toBe(true);
    process.env.LOOM_POWERBI_USER_PASSTHROUGH = 'false';
    expect(userPassthroughEnabled()).toBe(false);
    process.env.LOOM_POWERBI_USER_PASSTHROUGH = 'true';
    expect(userPassthroughEnabled()).toBe(true);
    delete process.env.LOOM_POWERBI_USER_PASSTHROUGH;
  });

  it('names the delegated scopes + admin consent in the consent_required gate', async () => {
    const { oboRemediation, PBI_PASSTHROUGH_DELEGATED_SCOPES } = await load();
    const msg = oboRemediation('consent_required');
    for (const s of PBI_PASSTHROUGH_DELEGATED_SCOPES) expect(msg).toContain(s);
    expect(msg).toMatch(/admin consent/i);
  });
});
