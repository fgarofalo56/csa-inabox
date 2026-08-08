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
    // F1 — REQUIRED. Omitting it is answered 400 "Unsupported requested token
    // type: null", which is what the live catalog returned for months: the
    // client sent three params where the server requires four, and every test
    // here doubled the endpoint with a stub that accepted ANY body, so the
    // suite modelled the code rather than the server.
    expect(form.get('requested_token_type')).toBe('urn:ietf:params:oauth:token-type:access_token');
  });

  it('sends EXACTLY the four params the live authz harness sends — no more, no fewer', async () => {
    // Non-vacuity: this is the assertion whose ABSENCE let a three-param request
    // ship. It is pinned as a set, so dropping one or silently adding an
    // unsupported one both fail. The reference is
    // apps/loom-unity/tests/authz/authz-e2e.sh lines 136-139 / 154-157, which
    // runs against the real image.
    fetchMock.mockResolvedValue(ok({ access_token: 'internal-abc' }));
    await exchangeForInternalUcToken('entra-subject');
    const form = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect([...form.keys()].sort()).toEqual([
      'grant_type',
      'requested_token_type',
      'subject_token',
      'subject_token_type',
    ]);
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

/**
 * F1 — the exchange base is now caller-selectable, because the Iceberg REST
 * Catalog is a SEPARATE Container App from loom-unity, with its own database and
 * its own minted-token state. A token minted by one is not honoured by the
 * other, so exchanging at the wrong base fails closed upstream.
 *
 * The module header warned that the day this function accepts a caller-supplied
 * address it becomes a credential-exfiltration primitive (the subject token is a
 * REAL Entra credential). These tests pin the allow-list that answers that.
 */
describe('exchangeForInternalUcToken - explicit base (F1)', () => {
  const prevUnity = process.env.LOOM_UNITY_URL;
  const prevIceberg = process.env.LOOM_ICEBERG_CATALOG_URL;
  const ICEBERG = 'https://iceberg-catalog.internal.example';
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.LOOM_UNITY_URL = BASE;
    process.env.LOOM_ICEBERG_CATALOG_URL = ICEBERG;
    resetUcTokenExchangeCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevUnity === undefined) delete process.env.LOOM_UNITY_URL;
    else process.env.LOOM_UNITY_URL = prevUnity;
    if (prevIceberg === undefined) delete process.env.LOOM_ICEBERG_CATALOG_URL;
    else process.env.LOOM_ICEBERG_CATALOG_URL = prevIceberg;
  });

  it('exchanges at the CONFIGURED Iceberg base when one is passed', async () => {
    fetchMock.mockResolvedValue(ok({ access_token: 'iceberg-internal' }));
    await expect(exchangeForInternalUcToken('entra-subject', ICEBERG)).resolves.toBe('iceberg-internal');
    expect(fetchMock.mock.calls[0][0]).toBe(ICEBERG + '/api/1.0/unity-control/auth/tokens');
  });

  it('keys the cache by BASE, so the two servers never share a minted token', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: 'unity-internal' }))
      .mockResolvedValueOnce(ok({ access_token: 'iceberg-internal' }));
    // Same subject token, two different servers -> two exchanges, two tokens.
    await expect(exchangeForInternalUcToken('same-subject')).resolves.toBe('unity-internal');
    await expect(exchangeForInternalUcToken('same-subject', ICEBERG)).resolves.toBe('iceberg-internal');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('REFUSES a base this deployment did not configure - the credential never leaves', async () => {
    fetchMock.mockResolvedValue(ok({ access_token: 'should-never-be-reached' }));
    await expect(exchangeForInternalUcToken('entra-subject', 'https://attacker.example'))
      .rejects.toBeInstanceOf(UcTokenExchangeError);
    // The decisive assertion: no request was issued at all. A rejection that
    // still POSTed the token would have already leaked it.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('REFUSES an empty base rather than falling through to the default', async () => {
    fetchMock.mockResolvedValue(ok({ access_token: 'x' }));
    await expect(exchangeForInternalUcToken('entra-subject', '   '))
      .rejects.toBeInstanceOf(UcTokenExchangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tolerates a trailing slash on a configured base (normalized, not rejected)', async () => {
    fetchMock.mockResolvedValue(ok({ access_token: 'iceberg-internal' }));
    await expect(exchangeForInternalUcToken('entra-subject', ICEBERG + '///')).resolves.toBe('iceberg-internal');
    expect(fetchMock.mock.calls[0][0]).toBe(ICEBERG + '/api/1.0/unity-control/auth/tokens');
  });

  it('invalidate with a base drops only THAT server cached token', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ access_token: 'unity-1' }))
      .mockResolvedValueOnce(ok({ access_token: 'iceberg-1' }))
      .mockResolvedValueOnce(ok({ access_token: 'iceberg-2' }));
    await exchangeForInternalUcToken('subj');
    await exchangeForInternalUcToken('subj', ICEBERG);
    await invalidateUcInternalToken('subj', ICEBERG);
    // Iceberg re-exchanges...
    await expect(exchangeForInternalUcToken('subj', ICEBERG)).resolves.toBe('iceberg-2');
    // ...while the unity token is still cached (no 4th call).
    await expect(exchangeForInternalUcToken('subj')).resolves.toBe('unity-1');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('invalidate with an UNCONFIGURED base is a no-op, never a throw', async () => {
    await expect(invalidateUcInternalToken('subj', 'https://attacker.example')).resolves.toBeUndefined();
  });
});
