/**
 * #2679 — the token exchange must be the ONLY thing that reaches the catalog API,
 * and it must fail closed.
 *
 * The defect being prevented: `ossUcAuthHeader()` used to send the raw Entra
 * access token, which upstream `AuthDecorator` answers 403 for because its `iss`
 * is not the server's own `internal` issuer. The dangerous variant is not the
 * 403 — it is a fallback that drops to an anonymous request, which SUCCEEDS
 * against a server running `server.authorization=disable` and so hides the
 * misconfiguration it should have surfaced.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  exchangeForInternalUcToken,
  invalidateUcInternalToken,
  resetUcTokenExchangeCache,
  UcTokenExchangeError,
} from '../uc-token-exchange';

const BASE = 'https://loom-unity.internal.example';

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('exchangeForInternalUcToken', () => {
  const prevUrl = process.env.LOOM_UNITY_URL;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.LOOM_UNITY_URL = BASE;
    resetUcTokenExchangeCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevUrl === undefined) delete process.env.LOOM_UNITY_URL;
    else process.env.LOOM_UNITY_URL = prevUrl;
  });

  it('posts an RFC-8693 exchange to unity-control and returns the internal token', async () => {
    fetchMock.mockResolvedValue(ok({ access_token: 'internal-abc' }));

    await expect(exchangeForInternalUcToken('entra-subject')).resolves.toBe('internal-abc');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    // unity-CONTROL, not unity-catalog — a very easy path to get wrong.
    expect(url).toBe(`${BASE}/api/1.0/unity-control/auth/tokens`);
    expect(init.method).toBe('POST');
    const form = new URLSearchParams(init.body as string);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(form.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:id_token');
    expect(form.get('subject_token')).toBe('entra-subject');
  });

  it('caches, so a second call does NOT re-exchange', async () => {
    fetchMock.mockResolvedValue(ok({ access_token: 'internal-abc' }));
    await exchangeForInternalUcToken('entra-subject');
    await exchangeForInternalUcToken('entra-subject');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent callers into ONE exchange', async () => {
    let release!: (v: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => { release = r; }));

    const a = exchangeForInternalUcToken('entra-subject');
    const b = exchangeForInternalUcToken('entra-subject');
    release(ok({ access_token: 'internal-abc' }));

    await expect(Promise.all([a, b])).resolves.toEqual(['internal-abc', 'internal-abc']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keys the cache on the subject token — a DIFFERENT subject re-exchanges', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: 'internal-1' }))
      .mockResolvedValueOnce(ok({ access_token: 'internal-2' }));
    await expect(exchangeForInternalUcToken('subject-1')).resolves.toBe('internal-1');
    await expect(exchangeForInternalUcToken('subject-2')).resolves.toBe('internal-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keys the cache on the SERVER — a reconfigured URL is not served a stale token', async () => {
    fetchMock.mockResolvedValueOnce(ok({ access_token: 'internal-old' }));
    await expect(exchangeForInternalUcToken('subject')).resolves.toBe('internal-old');

    process.env.LOOM_UNITY_URL = 'https://loom-unity-2.internal.example';
    fetchMock.mockResolvedValueOnce(ok({ access_token: 'internal-new' }));
    await expect(exchangeForInternalUcToken('subject')).resolves.toBe('internal-new');
  });

  it('invalidate drops the cached token so the next call re-exchanges', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: 'internal-1' }))
      .mockResolvedValueOnce(ok({ access_token: 'internal-2' }));
    await exchangeForInternalUcToken('subject');
    await invalidateUcInternalToken('subject');
    await expect(exchangeForInternalUcToken('subject')).resolves.toBe('internal-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ---- fail-closed cases: none of these may yield a usable header ----

  it('FAILS CLOSED on a non-2xx exchange (never returns the subject token)', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(exchangeForInternalUcToken('entra-subject')).rejects.toBeInstanceOf(UcTokenExchangeError);
  });

  it('FAILS CLOSED on a 200 that carries no access_token', async () => {
    // The dangerous shape: a truthy response whose token is missing. Returning
    // undefined here would send an ANONYMOUS request, which succeeds against a
    // server with authorization disabled.
    fetchMock.mockResolvedValue(ok({ token_type: 'Bearer' }));
    await expect(exchangeForInternalUcToken('entra-subject')).rejects.toThrow(/no access_token/i);
  });

  it('FAILS CLOSED on a non-JSON body', async () => {
    fetchMock.mockResolvedValue(new Response('<html>gateway</html>', { status: 200 }));
    await expect(exchangeForInternalUcToken('entra-subject')).rejects.toThrow(/non-JSON/i);
  });

  it('FAILS CLOSED on a network error / timeout', async () => {
    fetchMock.mockRejectedValue(new Error('ETIMEDOUT'));
    await expect(exchangeForInternalUcToken('entra-subject')).rejects.toBeInstanceOf(UcTokenExchangeError);
  });

  it('a failed exchange is NOT cached as a success', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 503 }));
    await expect(exchangeForInternalUcToken('subject')).rejects.toBeInstanceOf(UcTokenExchangeError);
    fetchMock.mockResolvedValueOnce(ok({ access_token: 'internal-recovered' }));
    await expect(exchangeForInternalUcToken('subject')).resolves.toBe('internal-recovered');
  });

  it('does not leak the subject token in the error message', async () => {
    const secret = 'eyJ-super-secret-entra-token';
    fetchMock.mockResolvedValue(new Response('upstream said no', { status: 403 }));
    const err = await exchangeForInternalUcToken(secret).catch((e) => e as Error);
    expect(err).toBeInstanceOf(UcTokenExchangeError);
    expect(err.message).not.toContain(secret);
  });

  it('refuses an empty subject token without calling the network', async () => {
    await expect(exchangeForInternalUcToken('')).rejects.toBeInstanceOf(UcTokenExchangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
